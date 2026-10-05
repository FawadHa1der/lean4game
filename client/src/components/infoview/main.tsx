/* Partly copied from https://github.com/leanprover/vscode-lean4/blob/master/lean4-infoview/src/infoview/main.tsx */

import * as React from 'react';
import type { DidCloseTextDocumentParams, DocumentUri } from 'vscode-languageserver-protocol';

import 'tachyons/css/tachyons.css';
import '@vscode/codicons/dist/codicon.css';
import '../../../../node_modules/vscode-lean4/lean4-infoview/src/infoview/index.css';
import '../../css/infoview.css'
import "../../css/tab_bar.css"

import { LeanFileProgressParams, LeanFileProgressProcessingInfo, defaultInfoviewConfig } from '@leanprover/infoview-api';
import { useClientNotificationEffect, useEventResult, useServerNotificationEffect, useServerNotificationState } from '../../../../node_modules/vscode-lean4/lean4-infoview/src/infoview/util';
import { EditorContext, ConfigContext, ProgressContext, VersionContext } from '../../../../node_modules/vscode-lean4/lean4-infoview/src/infoview/contexts';
import { RpcContext, WithRpcSessions, useRpcSessionAtPos } from '../../../../node_modules/vscode-lean4/lean4-infoview/src/infoview/rpcSessions';
import { ServerVersion } from '../../../../node_modules/vscode-lean4/lean4-infoview/src/infoview/serverVersion';

import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faDeleteLeft, faHome, faArrowRight } from '@fortawesome/free-solid-svg-icons'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'

import { Markdown } from '../markdown';

import { Infos } from './infos';
import { Errors, WithLspDiagnosticsContext } from './messages';
import { Goal, isLastStepWithErrors, lastStepHasErrors, loadGoals, currentLevel, lastLoadError, proofLevel } from './goals';
import { MonacoEditorContext } from './context';
import { levelUri } from '../../wasm/level-uri';
import { Typewriter, getInteractiveDiagsAt, hasInteractiveErrors } from './typewriter';
import { Button } from '../button';
import { CircularProgress } from '@mui/material';
import { bootStatusAtom, checkerActivityAtom, documentProcessingAtom, formatProgress, networkHoldAtom } from '../../store/boot-atoms';
import { leanMonacoAtom } from '../../store/editor-atoms';
import { boundEnvironmentAtom, rearmCheckerIfHalted } from '../../wasm/game-boot';
import { useEta } from '../boot_banner';
import { selectAtom } from 'jotai/utils';
import '../../css/boot_banner.css';
import { GameHint, InteractiveGoalsWithHints, ProofState } from './rpc_api';
import { Hint, Hints, MoreHelpButton, filterHints } from '../hints';
import { DocumentPosition } from '../../../../node_modules/vscode-lean4/lean4-infoview/src/infoview/util';
import { DiagnosticSeverity } from 'vscode-languageclient';
import { useTranslation } from 'react-i18next';
import { useGameTranslation } from '../../utils/translation';
import { useAtom } from 'jotai';
import { gameIdAtom, levelIdAtom, worldIdAtom } from '../../store/location-atoms';
import { completedAtom } from '../../store/progress-atoms';
import { gameInfoAtom, levelInfoAtom } from '../../store/query-atoms';
import { crashedAtom, haltedStepAtom, interimDiagsAtom, lockEditorModeAtom, proofAtom, typewriterContentAtom, typewriterModeAtom } from '../../store/editor-atoms';
import { inventoryAtom } from '../../store/inventory-atoms';
import { mobileAtom } from '../../store/preferences-atoms';
import { deletedChatAtom, helpAtom, selectedStepAtom } from '../../store/chat-atoms';
import { BOOT_PARAM_REFUSED, SEC1_REFUSAL_RE, openWithoutOverrides } from '../../wasm/boot-params';
import { wholeMB } from '../../wasm/sizes';

/** Wrapper for the two editors. It is important that the `div` with `codeViewRef` is
 * always present, or the monaco editor cannot start.
 */
export function DualEditor({ codeviewRef } : { codeviewRef: any }) {
  const [typewriterMode] = useAtom(typewriterModeAtom)
  const ec = React.useContext(EditorContext)
  const showTypewriter = Boolean(ec) && typewriterMode
  return <>
    <div className={showTypewriter ? 'hidden' : ''}>
      <ExerciseStatement showLeanStatement={true} />
      <div ref={codeviewRef} className={'codeview'}></div>
    </div>
    {ec ?
      <DualEditorMain /> :
      // TODO: Style this if relevant.
      <></>
    }
  </>
}

/** The part of the two editors that needs the editor connection first */
function DualEditorMain() {
  const ec = React.useContext(EditorContext)
  const [gameId] = useAtom(gameIdAtom)
  const [worldId] = useAtom(worldIdAtom)
  const [levelId] = useAtom(levelIdAtom)
  const [{ data: gameInfo }] = useAtom(gameInfoAtom)
  const [{ data: levelInfo }] = useAtom(levelInfoAtom)

  const [, setCompleted] = useAtom(completedAtom)

  const [, addToInventory] = useAtom(inventoryAtom)
  const [typewriterMode, setTypewriterMode] = useAtom(typewriterModeAtom)

  const [proof] = useAtom(proofAtom)

  React.useEffect(() => {
    // L1: only a proof state computed for THIS level completes it (see
    // proofLevel in goals.tsx) — the previous level's completed proof is
    // still in the global atom when this effect first runs for a new level.
    if (proof?.completed && proofLevel.key === `${worldId}/${levelId}`) {
      setCompleted(true)

      // On completion, add the names of all new items to the local storage
      let newTiles = [
        ...levelInfo?.tactics ?? [],
        ...levelInfo?.lemmas ?? [],
        ...levelInfo?.definitions ?? []
      ].filter((tile) => tile.new).map((tile) => tile.name)

      // Add the proven statement to the local storage as well.
      if (levelInfo?.statementName != null) {
        newTiles.push(levelInfo?.statementName)
      }
      addToInventory(newTiles)
    }
  }, [proof, levelInfo])

  /* Set up updates to the global infoview state on editor events. */
  const config = useEventResult(ec.events.changedInfoviewConfig) ?? defaultInfoviewConfig;

  const [allProgress, _1] = useServerNotificationState(
    '$/lean/fileProgress',
    new Map<DocumentUri, LeanFileProgressProcessingInfo[]>(),
    async (params: LeanFileProgressParams) => (allProgress) => {
      const newProgress = new Map(allProgress);
      return newProgress.set(params.textDocument.uri, params.processing);
    }, [])
  const serverVersion = useEventResult(ec.events.serverRestarted, result => new ServerVersion(result.serverInfo?.version ?? ''))

  // Stamp the level for loadGoals' late-reply guard (see goals.tsx).
  currentLevel.key = worldId && levelId ? `${worldId}/${levelId}` : ''

  // WithRpcSessions binds its session manager to the editor connection it
  // first sees (a useState initializer). If the LeanMonaco instance is ever
  // recreated, every later rpc would still go to the disposed instance's
  // stopped client ("No connection to Lean" for good) — remount on a new
  // editor API. The API object is per LeanMonaco instance, not per level.
  const apiKey = React.useRef<{ api: unknown; n: number }>({ api: ec?.api, n: 0 })
  if (apiKey.current.api !== ec?.api) apiKey.current = { api: ec?.api, n: apiKey.current.n + 1 }

  return <>
    <ConfigContext.Provider value={config}>
      <VersionContext.Provider value={serverVersion}>
        <WithRpcSessions key={apiKey.current.n}>
          <WithLspDiagnosticsContext>
            <ProgressContext.Provider value={allProgress}>
              {(typewriterMode) ?
                <TypewriterInterfaceWrapper/>
                :
                <Main key={`${worldId}/${levelId}`} />
              }
            </ProgressContext.Provider>
          </WithLspDiagnosticsContext>
        </WithRpcSessions>
      </VersionContext.Provider>
    </ConfigContext.Provider>
  </>
}

/** The mathematical formulation of the statement, supporting e.g. Latex
 * It takes three forms, depending on the precence of name and description:
 * - Theorem xyz: description
 * - Theorem xyz
 * - Exercises: description
 *
 * If `showLeanStatement` is true, it will additionally display the lean code.
 */
function ExerciseStatement({ showLeanStatement = false }) {
  const { t : gT } = useGameTranslation()
  const { t } = useTranslation()
  const [{ data: levelInfo }] = useAtom(levelInfoAtom)

  if (!(levelInfo?.descrText || levelInfo?.descrFormat)) { return <></> }
  // The statement goes through the game translator like every other game
  // text: lean-i18n keys it with its `$…$` / code spans replaced by `§n`
  // placeholders, which the plain `t(text, {ns})` lookup never matched (the
  // statement stayed English while the rest of the level switched language).
  // gT falls back to the raw key for dictionaries that predate placeholders.
  return <>
    <div className="exercise-statement">
      {(levelInfo?.descrText || levelInfo?.displayName) &&
        <Markdown>
          {(levelInfo?.displayName ? `**${t("Theorem")}** \`${levelInfo?.displayName}\`: ` : '') + gT(levelInfo?.descrText ?? "")}
        </Markdown>
      }
      {levelInfo?.descrFormat && showLeanStatement &&
        <p><code className="lean-code">{levelInfo?.descrFormat}</code></p>
      }
    </div>
  </>
}

/** A boot failure's detail line, shared by the typewriter's card
 * (LevelLoadingIndicator, local to TypewriterInterface) and editor mode's
 * (EditorBootFailureCard). L10: neutral wording — the failure may be in the
 * middle of the checker download (then only its finished chunks are
 * cached), and an interrupted game download is fetched again (bytes the
 * browser already holds in its HTTP cache are reused: infra/worker.js
 * answers Range). SEC1: a refusal (wasm/boot-params.ts) — a dev override in
 * the address that is not one same-origin directory / build id, or an index
 * or manifest naming another site — fetched nothing from it, and a reload
 * refuses again: the card says what to change instead of "reloading
 * retries". */
function bootFailureDetail(reason: string, t: ReturnType<typeof useTranslation>['t']): React.ReactNode {
  const refusal = SEC1_REFUSAL_RE.exec(reason)?.[1]
  if (refusal === 'BOOT_PARAM_REFUSED') {
    return <>{reason}. {t("Boot param refused note", { defaultValue: "A development override in this page's address may only name a directory on this site; nothing was downloaded for it. Remove the parameter from the address to play." })}</>
  }
  if (refusal !== undefined) {
    return <>{reason}. {t("Foreign artifact refused note", { defaultValue: "This site's published files point to another site; nothing was downloaded from it. Reloading will not help until the published files are fixed." })}</>
  }
  return <>{reason}. Reloading the page retries: what finished downloading stays cached, an interrupted download is fetched again.</>
}

/** L4: the network hold's words, shared by the typewriter's card and editor
 * mode's (SEC1-R1). The network went away in the middle of a download; the
 * boot is held (or the halted relay is re-armed) until a connectivity probe
 * succeeds — no user action needed; Reload stays on offer. */
function networkHoldCopy(): { headline: React.ReactNode; detail: React.ReactNode } {
  return {
    headline: <>The download was interrupted — waiting for the connection</>,
    detail: <>Lean starts on its own when the connection returns (checked every few seconds). What finished downloading stays cached in your browser; an interrupted download is picked up again automatically. Reloading the page is safe, too.</>,
  }
}

/** QD-API-2: the site was updated under this page — a worker of the new
 * deploy refused to run beside a script of the old one (death-kind
 * isStalePageDeath), and the relay halted on it. Not a crash and not the
 * link: only a reload helps (it loads the new version), so the card offers
 * Reload and no "Restart the checker". Shared by the typewriter's card and
 * editor mode's. */
function stalePageCopy(t: ReturnType<typeof useTranslation>['t']): { headline: React.ReactNode; detail: React.ReactNode } {
  return {
    headline: <>{t("Site updated headline", { defaultValue: "This site was updated — reload to continue" })}</>,
    detail: <>{t("Site updated note", { defaultValue: "A new version of this site was published while this page was open, and the checker cannot mix the two versions. Reloading the page loads the new version; your progress is saved in this browser." })}</>,
  }
}

/** A boot failure card's action (typewriter and editor mode): Reload — but
 * SEC1-R2: for a refused address override a reload keeps the query and
 * refuses again, and no in-app link drops it, so the card opens the same
 * level without the overrides instead (boot-params openWithoutOverrides). */
function BootFailureAction({ reason }: { reason?: string }) {
  const { t } = useTranslation()
  if (reason !== undefined && SEC1_REFUSAL_RE.exec(reason)?.[1] === BOOT_PARAM_REFUSED) {
    return <Button className="btn" onClick={() => openWithoutOverrides()}>{t("Open without the override", { defaultValue: "Open without the override" })}</Button>
  }
  return <Button className="btn" onClick={() => window.location.reload()}>Reload</Button>
}

/** SEC1: editor mode's boot failure card — the same words and action as the
 * typewriter's, which editor mode never rendered. SEC1-R1: and, like the
 * typewriter's, the network hold before the failure — a first-visit
 * download that loses the network halts the relay before it ever served,
 * and classifyHalt publishes "Lean failed to start" AND schedules the
 * automatic re-arm: "could not start … Reload" read as final for the whole
 * offline window while recovery was already on its way. */
function EditorBootFailureCard({ reason, hold, stale = false }: { reason: string; hold: boolean; stale?: boolean }) {
  const { t } = useTranslation()
  const { headline, detail } = hold
    ? networkHoldCopy()
    : stale ? stalePageCopy(t)
    : { headline: <>Lean could not start in your browser</>, detail: bootFailureDetail(reason, t) }
  return <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem', padding: '1.5rem' }}>
    {hold && <CircularProgress size={40} style={{ position: 'static', margin: 0 }} />}
    <div style={{ color: '#333', fontSize: '0.95rem', textAlign: 'center', maxWidth: '30rem' }}>{headline}</div>
    <div style={{ color: '#666', fontSize: '0.85rem', textAlign: 'center', maxWidth: '30rem' }}>{detail}</div>
    <BootFailureAction reason={hold || stale ? undefined : reason} />
  </div>
}

// TODO: This is only used in `EditorInterface`
// while `TypewriterInterface` has this copy-pasted in.
export function Main() {
  let { t } = useTranslation()
  const { t: gT } = useGameTranslation()
  const [lockEditorMode] = useAtom(lockEditorModeAtom)
  const ec = React.useContext(EditorContext);
  const [gameId] = useAtom(gameIdAtom)
  const [worldId] = useAtom(worldIdAtom)
  const [levelId] = useAtom(levelIdAtom)
  const [{ data: gameInfo }] = useAtom(gameInfoAtom)
  const [{ data: levelInfo }] = useAtom(levelInfoAtom)
  const [help, setHelp] = useAtom(helpAtom)

  const [typewriterMode] = useAtom(typewriterModeAtom)

  const [proof, setProof] = useAtom(proofAtom)
  const [, setCrashed] = useAtom(crashedAtom)
  const [selectedStep, setSelectedStep] = useAtom(selectedStepAtom)
  const editor = React.useContext(MonacoEditorContext)
  const model = editor?.getModel()
  const uri = model?.uri.toString()
  const rpcSess = useRpcSessionAtPos({ uri: uri ?? '', line: 0, character: 0 })
  // Fresh-session retry while there is no state (see TypewriterInterface).
  const [retryTick, setRetryTick] = React.useState(0)
  const [activity] = useAtom(checkerActivityAtom)
  // SEC1: a failed boot (a refused override above all — the reason must be
  // seen) shows a failure card here too; editor mode showed "Loading goal…"
  // for ever, the infoview waiting on a checker that never started.
  const [bootStatus] = useAtom(bootStatusAtom)
  const bootFailure = bootStatus.state !== 'busy' ? /^Lean failed to start: ([\s\S]*)$/.exec(bootStatus.label)?.[1] : undefined
  // SEC1-R1: a failure under a network hold is the hold's card (the
  // typewriter's LevelLoadingIndicator checks the hold first, too).
  const [networkHold] = useAtom(networkHoldAtom)
  // QD-API-2: a relay halted on a stale page — the reload card, here too.
  const stalePage = activity.halted && activity.stalePage && !networkHold

  React.useEffect(() => {
    if (!uri || !worldId || !levelId) {
      return
    }
    loadGoals(rpcSess, uri, worldId, levelId, setProof, setCrashed)
  }, [rpcSess, uri, worldId, levelId, retryTick, setProof, setCrashed])
  React.useEffect(() => {
    if (proof !== undefined || activity.busy || activity.halted || !uri) return
    const id = setTimeout(() => { setCrashed(false); setRetryTick((t) => t + 1) }, 4000)
    return () => clearTimeout(id)
  }, [proof === undefined, activity.busy, activity.halted, uri, retryTick])

  function toggleSelection(line: number) {
    return (ev: any) => {
      console.debug('toggled selection')
      if (selectedStep == line) {
        setSelectedStep(undefined)
      } else {
        setSelectedStep(line)
      }
    }
  }
  //console.debug(`template: ${props.data?.template}`)

  // React.useEffect (() => {
  //   if (props.data.template) {
  //     let code: string = selectCode(gameId, worldId, levelId)(store.getState())
  //     if (!code.length) {
  //       //models.push(monaco.editor.createModel(code, 'lean4', uri))
  //     }
  //   }
  // }, [props.data.template])

  /* Set up updates to the global infoview state on editor events. */
  const config = useEventResult(ec.events.changedInfoviewConfig) ?? defaultInfoviewConfig;

  const [allProgress, _1] = useServerNotificationState(
    '$/lean/fileProgress',
    new Map<DocumentUri, LeanFileProgressProcessingInfo[]>(),
    async (params: LeanFileProgressParams) => (allProgress) => {
      const newProgress = new Map(allProgress);
      return newProgress.set(params.textDocument.uri, params.processing);
    },
    []
  );

  const curUri = useEventResult(ec.events.changedCursorLocation, loc => loc?.uri);

  const curPos: DocumentPosition | undefined =
    useEventResult(ec.events.changedCursorLocation, loc => loc ? { uri: loc.uri, ...loc.range.start } : undefined)

  React.useEffect(() => {
    if (typewriterMode) {
      return
    }
    if (!uri) {
      return
    }
    loadGoals(rpcSess, uri, worldId!, levelId!, setProof, setCrashed)
  }, [typewriterMode, lockEditorMode, uri, worldId, levelId, rpcSess, setProof, setCrashed])

  // Reload once the document settles: states fetched mid-elaboration are
  // provisional (settleProof); the settled one must replace them.
  const [docProcessing] = useAtom(documentProcessingAtom)
  React.useEffect(() => {
    if (typewriterMode || docProcessing || !uri) return
    loadGoals(rpcSess, uri, worldId!, levelId!, setProof, setCrashed)
  }, [docProcessing])

  useServerNotificationEffect('textDocument/publishDiagnostics', (params: any) => {
    if (typewriterMode) {
      return
    }
    if (!uri || params?.uri !== uri) {
      return
    }
    loadGoals(rpcSess, uri, worldId!, levelId!, setProof, setCrashed)
  }, [typewriterMode, lockEditorMode, uri, worldId, levelId, rpcSess, setProof, setCrashed])

  const hintLine = (() => {
    const isEditorMode = !(typewriterMode)
    const curLine = Number.isFinite(curPos?.line)
      ? curPos?.line
      : (Number.isFinite((curPos as any)?._line) ? (curPos as any)._line : undefined)
    const curChar = Number.isFinite(curPos?.character)
      ? curPos.character
      : (Number.isFinite((curPos as any)?._character) ? (curPos as any)._character : undefined)
    if (isEditorMode && Number.isFinite(curLine)) {
      const baseLine = curLine
      return (curChar === 0 && baseLine > 0) ? baseLine - 1 : baseLine
    }
    if (Number.isFinite(selectedStep)) {
      return selectedStep
    }
    if (!proof?.steps?.length) {
      return 0
    }
    const lastIndex = proof.steps.length - 1
    return lastStepHasErrors(proof) ? Math.max(0, lastIndex - 1) : lastIndex
  })()

  const clampedHintLine = Math.max(0, Math.min(Number.isFinite(hintLine) ? hintLine : 0, (proof?.steps?.length ?? 1) - 1))
  const hintStepIndex = (() => {
    if (Number.isFinite(selectedStep)) {
      return selectedStep
    }
    if (!proof?.steps?.length) {
      return 0
    }
    const maxIndex = proof.steps.length - 1
    return Math.min(clampedHintLine + 1, maxIndex)
  })()
  const hintsToShow = (() => {
    if (!proof?.steps?.length) {
      return undefined
    }
    return proof.steps[hintStepIndex]?.goals?.[0]?.hints
  })()

  // Effect when the cursor changes in the editor
  React.useEffect(() => {
    // TODO: this is a bit of a hack and will yield unexpected behaviour if lines
    // are indented.
    const newPos = curPos?.line + (curPos?.character == 0 ? 0 : 1)

    if (Number.isFinite(newPos)) {
      // scroll the chat along
      setSelectedStep(newPos)
    }
  }, [curPos])

  useClientNotificationEffect(
    'textDocument/didClose',
    (params: DidCloseTextDocumentParams) => {
      if (ec.events.changedCursorLocation.current &&
        ec.events.changedCursorLocation.current.uri === params.textDocument.uri) {
        ec.events.changedCursorLocation.fire(undefined)
      }
    },
    []
  );

  const serverVersion =
    useEventResult(ec.events.serverRestarted, result => new ServerVersion(result.serverInfo?.version ?? ''))
  const serverStoppedResult = useEventResult(ec.events.serverStopped);
  // NB: the cursor may temporarily become `undefined` when a file is closed. In this case
  // it's important not to reconstruct the `WithBlah` wrappers below since they contain state
  // that we want to persist.
  let ret
  if (serverStoppedResult) {
    ret = <div><p>{serverStoppedResult.message}</p><p className="error">{serverStoppedResult.reason}</p></div>
  } else {
    ret = <div className="infoview vscode-light">
      <div className="lean4game-infoview">
        {proof?.completedWithWarnings &&
          <div className="level-completed">
            {proof?.completed ? t("Level completed! 🎉") : t("Level completed with warnings 🎭")}
          </div>
        }
        {bootFailure !== undefined || stalePage ? <EditorBootFailureCard reason={bootFailure ?? ""} hold={networkHold !== null} stale={stalePage} /> : <Infos />}
      </div>
      {hintsToShow && (
        <Hints hints={hintsToShow}
          showHidden={help.has(hintStepIndex)} step={hintStepIndex}
          selected={selectedStep} toggleSelection={toggleSelection(hintStepIndex)}
          lastLevel={hintStepIndex == proof?.steps.length - 1}/>
      )}
      <MoreHelpButton selected={curPos?.line}/>
    </div>
  }

  return ret
}

const goalFilter = {
  reverse: false,
  showType: true,
  showInstance: true,
  showHiddenAssumption: true,
  showLetValue: true
}

/** The display of a single entered lean command */
function Command({ proof, i, deleteProof }: { proof: ProofState, i: number, deleteProof: any }) {
  let {t} = useTranslation()

  // The first step will always have an empty command
  if (!proof?.steps[i]?.command) { return <></> }

  if (isLastStepWithErrors(proof, i)) {
    // If the last step has errors, we display the command in a different style
    // indicating that it will be removed on the next try.
    return <div className="failed-command">
      <i>{t("Failed command")}</i>: {proof?.steps[i].command}
    </div>
  } else {
    return <div className="command">
      <div className="command-text">{proof?.steps[i].command}</div>
      <Button  className="undo-button btn btn-inverted" title={t("Retry proof from here")} onClick={deleteProof}>
        <FontAwesomeIcon icon={faDeleteLeft} />&nbsp;{t("Retry")}
      </Button>
    </div>
  }
}

/** The tabs of goals that lean ahs after the command of this step has been processed */
function GoalsTabs({ proofStep, last, onClick, onGoalChange=(n)=>{}}: { proofStep: InteractiveGoalsWithHints, last : boolean, onClick? : any, onGoalChange?: (n?: number) => void }) {
  let { t } = useTranslation()
  const [mobile] = useAtom(mobileAtom)
  const [selectedGoal, setSelectedGoal] = React.useState<number>(0)

  if (proofStep.goals.length == 0) {
    return <></>
  }

  return <div className="goal-tabs" onClick={onClick}>
    <div className={`tab-bar ${last ? 'current' : ''}`}>
      {proofStep.goals.map((goal, i) => (
        // TODO: Should not use index as key.
        <div key={`proof-goal-${i}`} className={`tab ${i == (selectedGoal) ? "active" : ""}`} onClick={(ev) => { onGoalChange(i); setSelectedGoal(i); ev.stopPropagation() }}>
          {i ? t("Goal") + ` ${i + 1}` : t("Active Goal")}
        </div>
      ))}
    </div>
    <div className="goal-tab vscode-light" style={{flexDirection: mobile ? "column" : "row"}}>
      <Goal typewriter={false} filter={goalFilter} goal={proofStep.goals[selectedGoal]?.goal} />
    </div>
  </div>
}

// Splitting up Typewriter into two parts is a HACK
export function TypewriterInterfaceWrapper() {
  const ec = React.useContext(EditorContext)

  useClientNotificationEffect(
    'textDocument/didClose',
    (params: DidCloseTextDocumentParams) => {
      if (ec.events.changedCursorLocation.current &&
        ec.events.changedCursorLocation.current.uri === params.textDocument.uri) {
        ec.events.changedCursorLocation.fire(undefined)
      }
    }, []
  )

  const serverVersion =
    useEventResult(ec.events.serverRestarted, result => new ServerVersion(result.serverInfo?.version ?? ''))
  const serverStoppedResult = useEventResult(ec.events.serverStopped);
  // NB: the cursor may temporarily become `undefined` when a file is closed. In this case
  // it's important not to reconstruct the `WithBlah` wrappers below since they contain state
  // that we want to persist.

  if (serverStoppedResult) {
    return <div>
      <p>{serverStoppedResult.message}</p>
      <p className="error">{serverStoppedResult.reason}</p>
    </div>
  }

  return <TypewriterInterface />
}

/** The interface in command line mode */
export function TypewriterInterface() {
  let { t } = useTranslation()
  const { t: gT } = useGameTranslation()
  const ec = React.useContext(EditorContext)
  const [gameId, navigateToGame] = useAtom(gameIdAtom)
  const [worldId] = useAtom(worldIdAtom)
  const [levelId, navigateToLevel] = useAtom(levelIdAtom)
  const [{ data: gameInfo }] = useAtom(gameInfoAtom)
  const [help, setHelp] = useAtom(helpAtom)

  const editor = React.useContext(MonacoEditorContext)
  const model = editor?.getModel()
  const uri = model?.uri.toString() ?? ''

  const worldSize = gameInfo?.worldSize?.[worldId ?? ""] ?? 0

  const fallbackUri = levelUri(worldId!, levelId!)
  const effectiveUri = uri || fallbackUri
  let image: string | undefined = gameInfo?.worlds?.nodes[worldId!]?.image


  const [disableInput, setDisableInput] = React.useState<boolean>(false)
  const [loadingProgress, setLoadingProgress] = React.useState<number>(0)
  const [, setDeletedChat] = useAtom(deletedChatAtom)
  const [mobile] = useAtom(mobileAtom)
  const [proof, setProof ] = useAtom(proofAtom)
  const [crashed, setCrashed ] = useAtom(crashedAtom)
  const [interimDiags ] = useAtom(interimDiagsAtom)

  const [, setTypewriter] = useAtom(typewriterContentAtom)
  const [selectedStep, setSelectedStep] = useAtom(selectedStepAtom)

  const proofPanelRef = React.useRef<HTMLDivElement>(null)
  // const config = useEventResult(ec.events.changedInfoviewConfig) ?? defaultInfoviewConfig;
  // const curUri = useEventResult(ec.events.changedCursorLocation, loc => loc?.uri);

  // A failed rpc session is dropped by the infoview's session manager, and the
  // next RENDER creates a fresh one — so every retry below is a state bump
  // that re-renders, and the load effect (keyed on the session and the tick)
  // issues the request with the session of THAT render. Calling loadGoals
  // from a timer closure reused the session captured at effect time: on a
  // first visit the level's first session was created a few ms before the
  // freshly started Lean client reported itself running, failed with
  // "No connection to Lean", and every 4 s auto-retry re-asked that dead
  // session forever ("Waiting for the checker's first answer…" on the live
  // site until a reload). Locally an incidental re-render hid it.
  const rpcSess = useRpcSessionAtPos({uri: effectiveUri, line: 0, character: 0})
  const [retryTick, setRetryTick] = React.useState(0)
  const retry = React.useCallback(() => { setCrashed(false); setRetryTick((t) => t + 1) }, [setCrashed])

  React.useEffect(() => {
    if (!effectiveUri) {
      return
    }
    setCrashed(false)
    loadGoals(rpcSess, effectiveUri, worldId!, levelId!, setProof, setCrashed)
  }, [rpcSess, effectiveUri, worldId, levelId, retryTick, setProof, setCrashed])

  // Clear the previous level's steps while the new one is prepared —
  // otherwise they sit under the new statement for the whole switch. Keyed
  // on the level only: the rpc session also changes after every edit, and a
  // reset there blanked the pane mid-proof. The loading timer starts here.
  const loadingSince = React.useRef(Date.now())
  React.useEffect(() => {
    loadingSince.current = Date.now()
    setProof(undefined)
  }, [worldId, levelId, setProof])

  // Recovery: during a navigation storm the checker replaces its session
  // repeatedly and rejects every in-flight request ("switched documents");
  // once loadGoals' retries are spent, nothing reloads the pane and it sits
  // on "Loading the level…" for good (seen after editor-mode toggle + rapid
  // hash navigation). Reload whenever the checker settles with no state.
  const [activity] = useAtom(checkerActivityAtom)
  React.useEffect(() => {
    if (activity.busy || !effectiveUri) return
    if (proof === undefined || crashed) retry()
  }, [activity.busy])
  // A failed boot (the failure card) leaves the input dead but enabled —
  // its Monaco line is read-only while there is no proof state, so Execute
  // was a clickable no-op. The failure is published as a status label
  // (game-boot's ui.idle('Lean failed to start: …')), not as a crash.
  const [bootStatus] = useAtom(bootStatusAtom)
  const bootFailed = bootStatus.state !== 'busy' && /^Lean failed to start: /.test(bootStatus.label)
  // No state, checker idle, nothing in flight that would deliver one: retry
  // the first request every few seconds (a request lost to a session switch,
  // answered before the level existed, or asked of a dead session otherwise
  // waits forever).
  React.useEffect(() => {
    if (proof !== undefined || activity.busy || activity.halted || !effectiveUri) return
    const id = setTimeout(retry, 4000)
    return () => clearTimeout(id)
  }, [proof === undefined, activity.busy, activity.halted, effectiveUri, retryTick])

  // Document settled (fileProgress empty): replace any provisional state.
  const [docProcessingTw] = useAtom(documentProcessingAtom)
  React.useEffect(() => {
    if (docProcessingTw || !effectiveUri || proof === undefined) return
    loadGoals(rpcSess, effectiveUri, worldId!, levelId!, setProof, setCrashed)
  }, [docProcessingTw])

  /** Delete all proof lines starting from a given line.
  * Note that the first line (i.e. deleting everything) is `1`!
  */
  function deleteProof(line: number) {
    return (ev: any) => {
      let deletedChat: Array<GameHint> = []
      proof?.steps.slice(line).map((step, i) => {
        let filteredHints = filterHints(step.goals[0]?.hints, proof?.steps[i-1]?.goals[0]?.hints)

        // Only add these hidden hints to the deletion stack which were visible
        deletedChat = [...deletedChat, ...filteredHints.filter(hint => (!hint.hidden || help.has(line + i)))]
      })
      setDeletedChat(deletedChat)

      // delete showHelp for deleted steps
      setHelp(new Set(Array.from(help).filter(i => i < line - 1)))

      editor.executeEdits("typewriter", [{
        range: monaco.Selection.fromPositions(
          { lineNumber: line, column: 1 },
          editor.getModel()?.getFullModelRange().getEndPosition()
        ),
        text: '',
        forceMoveMarkers: false
      }])
      setSelectedStep(undefined)
      setTypewriter(proof?.steps[line].command ?? "")
      // Reload proof on deleting
      loadGoals(rpcSess, uri, worldId!, levelId!, setProof, setCrashed)
      ev.stopPropagation()
    }
  }

  /** HARDENING #52 exit card: remove the last non-empty line of the level's
   * text (and any blank lines after it). The edit is a full-text didChange,
   * which re-arms the halted relay with the shortened text; the pane's
   * activity effect then reloads the proof state. Offered while the checker
   * is halted on an exit: the input is read-only without a proof state (a
   * reload with the exiting text saved), so this is the typewriter-mode way
   * out — "Restart" and "Reload" replay the same text and die again. */
  function lastLineAction(): RemoveLastLine | null {
    const m = editor?.getModel()
    if (!m) return null
    const n = m.getLineCount()
    let end = n
    while (end >= 1 && m.getLineContent(end).trim() === '') end--
    if (end < 1) return null
    return {
      text: m.getLineContent(end).trim(),
      remove: () => {
        const mm = editor.getModel()
        if (!mm) return
        const last = mm.getLineCount()
        let e = last
        while (e >= 1 && mm.getLineContent(e).trim() === '') e--
        if (e < 1) return
        editor.executeEdits("typewriter", [{
          range: new monaco.Range(e, 1, last, mm.getLineMaxColumn(last)),
          text: '',
          forceMoveMarkers: false
        }])
        editor.setPosition(mm.getFullModelRange().getEndPosition())
        setSelectedStep(undefined)
      },
    }
  }

  function toggleSelectStep(line: number) {
    return (ev: any) => {
      if (mobile) {return}
      if (selectedStep == line) {
        setSelectedStep(undefined)
        console.debug(`unselected step`)
      } else {
        setSelectedStep(line)
        console.debug(`step ${line} selected`)
      }
    }
  }

   // Scroll to the end of the proof if it is updated.
   React.useEffect(() => {
    if (proof?.steps?.length && proof?.steps?.length > 1) {
      proofPanelRef.current?.lastElementChild?.scrollIntoView() //scrollTo(0,0)
    } else {
      proofPanelRef.current?.scrollTo(0,0)
    }
    // also reenable the commandline when the proof changes

    // BUG: If selecting 2nd goal on a intermediate proofstep and then delete proof to there,
    // the commandline is not displaying disabled even though it should.
    setDisableInput(false)
  }, [proof])

  // Scroll to element if selection changes
  React.useEffect(() => {
    if (typeof selectedStep !== 'undefined') {
      Array.from(proofPanelRef.current?.getElementsByClassName(`step-${selectedStep}`)).map((elem) => {
        elem.scrollIntoView({ block: "center" })
      })
    }
  }, [selectedStep])

  // TODO: superfluous, can be replaced with `withErr` from above
  /** switching-only view of checker activity: flips twice per boot/switch,
 * never per progress tick — anything gating the input must subscribe to
 * THIS, not the raw activity atom (per-tick re-renders above the monaco
 * input ate keystrokes; cypress caught it as 8 failing typing tests). */
const checkerSwitchingAtom = selectAtom(checkerActivityAtom, (a) => a.switching)

/** Gate v4, after three failed wrapper designs: the upstream Typewriter is
 * rendered byte-identically (any wrapper/memo/prop composition around it
 * ate keystrokes — 8 cypress typing tests each time), and the gate is a
 * SIBLING overlay that physically covers the input area while the checker
 * boots or replaces sessions. It blocks pointer interaction and explains
 * the wait; it cannot perturb the input's React subtree because it is not
 * part of it. */
function LeanGateOverlay() {
  const [switching] = useAtom(checkerSwitchingAtom)
  const [activity] = useAtom(checkerActivityAtom)
  if (!switching) return null
  return <div className="lean-gate-overlay">
    Lean is {/download|unpack|install/i.test(activity.label) ? 'downloading' : 'loading'} —
    the input unlocks when it&apos;s ready{activity.label ? ` (${activity.label})` : ''}
  </div>
}

/** The level pane's waiting state: a labeled, determinate-when-possible
 * loader driven by the wasm boot status — a bare spinner reads as "hung"
 * during the first-visit kernel download. */
/** The level pane while there is no proof state yet. Every phase says what
 * is happening, how long it has been going, and what to expect — a bare
 * "Loading…" read as hung to first-time visitors (the first visit downloads
 * the checker plus this game's environment — hundreds of MB, the exact figure
 * comes from the bound snapshot's index entry — and the first level after
 * start-up is elaborated cold). The last
 * phase, "checker idle but no answer yet", is retried automatically and
 * offers a manual retry, because a first request lost to a session switch
 * used to leave the pane waiting forever. */
/** The offending text's way out on an exit card (HARDENING #52): the last
 * non-empty line of the level's text, and the action that removes it. */
type RemoveLastLine = { text: string; remove: () => void }

function LevelLoadingIndicator({ onRetry, since, removeLastLine }: { onRetry?: () => void; since: number; removeLastLine?: RemoveLastLine | null }) {
  const { t } = useTranslation()
  const [status] = useAtom(bootStatusAtom)
  const [haltedStep] = useAtom(haltedStepAtom)
  const [activity] = useAtom(checkerActivityAtom)
  const [leanMonaco] = useAtom(leanMonacoAtom)
  const [boundEnv] = useAtom(boundEnvironmentAtom)
  const [networkHold] = useAtom(networkHoldAtom)
  const progress = formatProgress(status)
  const eta = useEta(status)
  // `since` is owned by the level (the pane re-renders its branch several
  // times during a cold start; a mount-local timer showed "0 s" repeatedly).
  const [elapsed, setElapsed] = React.useState(() => Math.max(0, Math.round((Date.now() - since) / 1000)))
  // A boot failure is terminal: the clock stops and the spinner goes (a live
  // timer and a spinning arc on "Lean could not start" read as still trying).
  const bootFailure = status.state !== 'busy' ? /^Lean failed to start: (.*)$/s.exec(status.label)?.[1] : undefined
  // HARDENING #52: a relay halted by FileWorker exits (the card names the
  // exit code) or by repeated liveness stalls is terminal like a boot
  // failure until the player restarts it — no spinner, no running clock.
  // The halt's facts, not its label (death-kind haltFacts).
  const haltedHere = activity.halted && !networkHold
  const exitCode = haltedHere && activity.exitCode !== null ? activity.exitCode : undefined
  const stalledRepeatedly = haltedHere && activity.stalled
  // QD-API-2: a halt on a stale page is terminal too — until the reload.
  const stalePage = haltedHere && activity.stalePage
  const runtimeHalt = exitCode !== undefined || stalledRepeatedly || stalePage
  React.useEffect(() => {
    if (bootFailure !== undefined || runtimeHalt) return
    const id = setInterval(() => setElapsed(Math.max(0, Math.round((Date.now() - since) / 1000))), 1000)
    return () => clearInterval(id)
  }, [since, bootFailure !== undefined, runtimeHalt])
  const secs = (n: number) => n < 60 ? `${n} s` : `${Math.floor(n / 60)} min ${n % 60} s`
  const downloading = status.unit === 'bytes' || /download|unpack|install|preparing the .* environment/i.test(status.label)
  // The "no answer yet" thresholds count from the moment the checker went
  // idle, not from the level's load: after a four-minute first download the
  // first idle second must not read "still no answer after 4 min — reload".
  const idle = status.state !== 'busy' && !activity.busy
  const waitingSince = React.useRef<number | null>(null)
  if (!idle) waitingSince.current = null
  else waitingSince.current ??= Date.now()
  const waited = idle ? Math.max(0, Math.round((Date.now() - waitingSince.current!) / 1000)) : 0
  // The language client's own view (lean4monaco LeanClient): "running" is
  // the only state in which rpc can flow; "starting" = waiting for its
  // initialize round trip; "stopped" = never started or torn down.
  const clients = (leanMonaco?.clientProvider?.getClients?.() ?? []) as Array<{ isRunning?: () => boolean; isStarted?: () => boolean; restart?: () => Promise<void> }>
  const clientState = clients.length === 0 ? 'no client'
    : clients.map((c) => c.isRunning?.() ? 'running' : c.isStarted?.() ? 'starting' : 'stopped').join(', ')
  const noConnection = /No connection to Lean/i.test(lastLoadError.message)
  // Self-heal: a client that is still not running 20 s after the checker
  // went idle has lost its start (its initialize answer, typically); restart
  // it — the same action as the editor's "Restart Lean" — at most every 30 s.
  const lastRestart = React.useRef(0)
  React.useEffect(() => {
    if (!idle || !noConnection || waited < 20 || clients.length === 0) return
    if (Date.now() - lastRestart.current < 30000) return
    lastRestart.current = Date.now()
    console.warn(`[lean4game] Lean client ${clientState} ${waited}s after the checker went idle — restarting it`)
    void clients[0].restart?.()
  }, [idle, noConnection, waited >= 20, clients.length])
  let headline: React.ReactNode, detail: React.ReactNode
  if (networkHold) {
    // L4 (networkHoldCopy): automatic recovery, Reload stays on offer.
    ({ headline, detail } = networkHoldCopy())
  } else if (bootFailure !== undefined) {
    headline = <>Lean could not start in your browser</>
    // L10 neutral wording; SEC1 refusals say what to change (bootFailureDetail).
    detail = bootFailureDetail(bootFailure, t)
  } else if (stalePage) {
    ({ headline, detail } = stalePageCopy(t))
  } else if (activity.halted && exitCode !== undefined) {
    // HARDENING #52 "exit": the FileWorker exited on every replay of this
    // level's text — a crash the content causes (the breaker's faithful
    // verdict), never a connection problem. Named by its exit code.
    // The way out is an EDIT (a halted relay re-arms on a document change):
    // a restart or a reload replays the same text and dies again. With a
    // step pending (finding: the step is not shown — the pane keeps the
    // last state the checker gave), the Typewriter has put that step back
    // into the input, cursor on its line: the next Execute replaces it.
    // Without one (a reload with the text saved: no proof state, the input
    // is read-only), the card removes the last line itself.
    headline = <>The checker stopped: Lean exited with code {exitCode}</>
    detail = haltedStep !== null
      ? <>The step you just entered (<code>{haltedStep}</code>) made Lean exit with code {exitCode}, so the checker stopped retrying. This is a crash caused by the proof text, not a connection problem: change the step in the input below and press Execute (that restarts the checker), or restart it here.</>
      : <>{activity.label}. This is a crash caused by the proof text, not a connection problem; restarting or reloading replays the same text. {removeLastLine
          ? <>Remove the last line of your proof below (the checker restarts on the change), or switch to editor mode (<code>&lt;/&gt;</code>) and change the text there.</>
          : <>Switch to editor mode (<code>&lt;/&gt;</code>) and delete or change the line that exits (the checker restarts on the change).</>}</>
  } else if (activity.halted && stalledRepeatedly) {
    headline = <>The checker stopped: Lean stopped answering</>
    detail = <>{activity.label}. Your proof is kept. Restarting replays this level into a fresh checker; if it stalls again, reloading the page is safe.</>
  } else if (activity.halted) {
    // The relay's crash-loop breaker: three deaths in two minutes. It only
    // re-arms on a document change, which the typewriter cannot produce
    // while it waits for a proof state — so offer the re-arm here.
    headline = <>The checker stopped after repeated crashes</>
    detail = <>{activity.label}. Restarting replays this level into a fresh checker; if it crashes again, reloading the page is safe.</>
  } else if (status.state !== 'busy' && status.label === '') {
    // The boot status atom starts inert (the landing page binds no game);
    // no stage has been published yet — the checker has not started.
    headline = <>Starting the checker in your browser…</>
    detail = <>The Lean runtime is being launched for this game (language client: {clientState}).</>
  } else if (status.state === 'busy') {
    headline = <>Lean is starting in your browser — {status.label}{progress ? ` · ${progress}` : ''}{eta ? ` · ${eta}` : ''}</>
    // Chrome reports navigator.deviceMemory in {0.25 … 8}: below 8 the
    // device really is small; 8 means "8 or more". Starting the full Lean
    // compiler in a tab takes about 8 GB of renderer memory (measured:
    // 3.6 GB at runtime start, 7.4 GB at runtime init, 8.3 GB at ready)
    // and a small machine loses the tab without a word — say so before the
    // download, not after (the landing page says it too, but deep links
    // never render the landing page).
    const deviceGb = (navigator as { deviceMemory?: number }).deviceMemory
    const smallDevice = typeof deviceGb === 'number' && deviceGb < 8
      ? <> This device reports about {deviceGb} GB of memory; the checker needs roughly 8 GB free while it starts and may not start here.</>
      : null
    // The environment's size is the bound snapshot's index entry, published
    // by game-boot once the pairing check passed: the transfer bytes (what
    // the download costs) and the raw bytes (what the banner's byte count
    // above runs up to — the prefetch reports the inflated region).
    // D8: decimal MB, as the tiles and the banner count.
    const envSize = boundEnv ? ` (about ${wholeMB(boundEnv.transfer)} MB to download, ${wholeMB(boundEnv.bytes)} MB once unpacked)` : ''
    detail = downloading
      ? <>The first visit downloads the Lean checker (about 150 MB, once) and this game&apos;s mathematics{envSize} and keeps it in your browser, so later visits start in seconds. Nothing is sent anywhere.{smallDevice}</>
      : <>Starting the checker inside this tab: unpacking and loading the mathematics environment. On a laptop this takes about 10–30 seconds after the download.{smallDevice}</>
  } else if (activity.busy) {
    headline = <>Preparing this level — {activity.label}…</>
    detail = <>The checker is elaborating the level&apos;s statement. The first level after start-up can take up to a minute while everything warms up; later levels switch in a second or two.</>
  } else {
    headline = noConnection
      ? <>Connecting to the checker…{waited >= 15 ? ' (retrying every few seconds)' : ''}</>
      : <>Waiting for the checker&apos;s first answer…{waited >= 15 ? ' (retrying every few seconds)' : ''}</>
    const attempt = lastLoadError.message ? <> (last attempt: {lastLoadError.message}; language client: {clientState})</> : null
    detail = waited < 15
      ? (noConnection
          ? <>The checker is up; the editor&apos;s connection to it is being (re)established, which takes a moment (language client: {clientState}).</>
          : <>The level is loaded and the checker is idle; its answer usually arrives within a second.</>)
      : waited < 90
        ? <>This is taking longer than usual{attempt}. The request is retried automatically{noConnection && waited >= 20 ? ', and the language client is restarted' : ''}; you can also retry now.</>
        : <>Still no answer after {secs(waited)}{attempt}. Reloading the page is safe: your progress is saved in this browser, and what finished downloading stays cached (an interrupted download is fetched again).</>
  }
  return <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem', padding: '1.5rem' }}>
    {/* explicit size + static position: the pane's spinner rule shifts it
        off-centre and it collapsed to a dot in the level-switch state */}
    {((bootFailure === undefined && !runtimeHalt) || networkHold) && <CircularProgress size={40} style={{ position: 'static', margin: 0 }} />}
    <div style={{ color: '#333', fontSize: '0.95rem', textAlign: 'center', maxWidth: '30rem' }}>{headline}</div>
    <div style={{ color: '#666', fontSize: '0.85rem', textAlign: 'center', maxWidth: '30rem' }}>{detail}</div>
    {bootFailure === undefined && !runtimeHalt && <div style={{ color: '#888', fontSize: '0.8rem' }}>{secs(elapsed)} elapsed</div>}
    {idle && waited >= 15 && onRetry &&
      <Button className="btn" onClick={onRetry}>Retry now</Button>}
    {(bootFailure !== undefined || networkHold || stalePage) &&
      <BootFailureAction reason={networkHold || stalePage ? undefined : bootFailure} />}
    {activity.halted && !networkHold && exitCode !== undefined && haltedStep === null && removeLastLine &&
      <Button className="btn" onClick={removeLastLine.remove}>Remove the last line (<code>{removeLastLine.text.length > 40 ? `${removeLastLine.text.slice(0, 40)}…` : removeLastLine.text}</code>)</Button>}
    {activity.halted && !networkHold && !stalePage &&
      <Button className="btn" onClick={() => { if (!rearmCheckerIfHalted()) window.location.reload(); else onRetry?.() }}>Restart the checker</Button>}
  </div>
}

let lastStepErrors = proof?.steps.length ? hasInteractiveErrors(getInteractiveDiagsAt(proof, proof?.steps.length)) : false


  useServerNotificationEffect("$/game/loading", (params : any) => {
    if (params.kind == "loadConstants") {
      setLoadingProgress(params.counter/100*50)
    } else if (params.kind == "finalizeExtensions") {
      setLoadingProgress(50 + params.counter/150*50)
    } else {
      console.error(`Unknown loading kind: ${params.kind}`)
    }
  })

  let introText: Array<string> = gT(gameInfo?.introduction ?? "").split(/\n(\s*\n)+/)

  return <div className="typewriter-interface">
    <RpcContext.Provider value={rpcSess}>
    <div className="content">
      <div className='world-image-container empty'>
        {image &&
          <img className="contain" src={`/data/${gameId!}/${image}`} alt="" />
        }

      </div>
      <div className="tmp-pusher">
        {/* <div className="world-image-container empty">

        </div> */}
      </div>
      <div className='proof' ref={proofPanelRef}>
        <ExerciseStatement showLeanStatement={true} />
        {/* L5: the editor-mode wrapper never outranks a boot failure or a
            halted relay — those are not the player's proof crashing, and the
            card below is what offers Reload / Restart. */}
        {((crashed && !bootFailed && !activity.halted && (interimDiags.length > 0 || proof?.steps.length > 0))) ? <div>
          <p className="crashed_message">{t("Crashed! Go to editor mode and fix your proof! Last server response:")}</p>
          {interimDiags.map((diag, index) => {
            const severityClass = diag.severity ? {
              [DiagnosticSeverity.Error]: 'error',
              [DiagnosticSeverity.Warning]: 'warning',
              [DiagnosticSeverity.Information]: 'information',
              [DiagnosticSeverity.Hint]: 'hint',
            }[diag.severity] : '';

            return <div key={`interim-diag-${index}`}>
              <div className={`${severityClass} ml1 message`}>
                <p className="mv2">{t("Line")}&nbsp;{diag.range.start.line}, {t("Character")}&nbsp;{diag.range.start.character}</p>
                <pre className="font-code pre-wrap">
                  {diag.message}
                </pre>
                </div>
            </div>
          })}

        </div> : proof?.steps.length ?
          <>
            {proof?.steps.map((step, i) => {
              let filteredHints = filterHints(step.goals[0]?.hints, proof?.steps[i-1]?.goals[0]?.hints)

              // if (i == proof?.steps.length - 1 && hasInteractiveErrors(step.diags)) {
              //   // if the last command contains an error, we only display the errors but not the
              //   // entered command as it is still present in the command line.
              //   // TODO: Should not use index as key.
              //   return <div key={`proof-step-${i}`} className={`step step-${i}`}>
              //     <Errors errors={step.diags} typewriterMode={true} />
              //   </div>
              // } else {
                return <div key={`proof-step-${i}`} className={`step step-${i}` + (selectedStep == i ? ' selected' : '')}>
                  <Command proof={proof} i={i} deleteProof={deleteProof(i)} />
                  <Errors errors={step.diags} typewriterMode={true} />
                  {mobile && i == 0 && gameInfo?.introduction &&
                    introText?.filter(it => it.trim()).map(((it, i) =>
                      // Show the level's intro text as hints, too
                      <Hint key={`intro-p-${i}`}
                        hint={{text: it, hidden: false, rawText: it, varNames: []}} step={0} selected={selectedStep} toggleSelection={toggleSelectStep(0)} />
                    ))
                  }
                  {mobile &&
                    <Hints key={`hints-${i}`}
                      hints={filteredHints} showHidden={help.has(i)} step={i}
                      selected={selectedStep} toggleSelection={toggleSelectStep(i)}/>
                  }
                  {/* <GoalsTabs proofStep={step} last={i == proof?.steps.length - (lastStepErrors ? 2 : 1)} onClick={toggleSelectStep(i)} onGoalChange={i == proof?.steps.length - 1 - withErr ? (n) => setDisableInput(n > 0) : (n) => {}}/> */}
                  {!(isLastStepWithErrors(proof, i)) &&
                    <GoalsTabs proofStep={step} last={i == proof?.steps.length - (lastStepHasErrors(proof) ? 2 : 1)} onClick={toggleSelectStep(i)} onGoalChange={i == proof?.steps.length - (lastStepHasErrors(proof) ? 2 : 1) ? (n) => setDisableInput(n > 0) : (n) => {}}/>
                  }
                  {mobile && i == proof?.steps.length - 1 &&
                    <MoreHelpButton selected={null} />
                  }

                  {/* Show a message that there are no goals left */}
                  {/* {!step.goals.length && (
                    <div className="message information">
                      {proof?.completed ?
                        <p>Level completed! 🎉</p> :
                        <p>
                          <b>no goals left</b><br />
                          <i>This probably means you solved the level with warnings or Lean encountered a parsing error.</i>
                        </p>
                      }
                    </div>
                  )} */}
                </div>
              }
            //}
            )}
            {/* A relay halted while the level already has a proof state
                (HARDENING #52: an "exit" on every replay of the player's
                text; any breaker trip mid-proof alike): the steps above
                are the last state the checker gave, and without this card
                nothing said the checker had stopped. Same card, same
                Restart, as the pane shows without a state. */}
            {activity.halted && !bootFailed &&
              <LevelLoadingIndicator since={loadingSince.current} onRetry={retry} removeLastLine={activity.halted ? lastLineAction() : null} />}
            {proof?.diagnostics.length > 0 &&
              <div key={`proof-step-remaining`} className="step step-remaining">
                <Errors errors={proof?.diagnostics} typewriterMode={true} />
              </div>
            }
            {mobile && proof?.completed &&
              <div className="button-row mobile">
                {levelId! >= worldSize ?
                  <Button onClick={() => navigateToGame(gameId!)} >
                    <FontAwesomeIcon icon={faHome} />&nbsp;{t("Home")}
                  </Button>
                :
                  <Button onClick={() => navigateToLevel(levelId! + 1)} >
                    Next&nbsp;<FontAwesomeIcon icon={faArrowRight} />
                  </Button>
                }
              </div>
            }
          </> :
          <LevelLoadingIndicator since={loadingSince.current} onRetry={retry} removeLastLine={activity.halted ? lastLineAction() : null} />
          // <CircularProgress variant="determinate" value={100*(1 - 1.024 ** (- Math.max(loadingProgress, 1)))} />
        // note: since we don't know the total number of files,
        // we use a function which strictly monotonely increases towards `100` as `x → ∞`
        // The base is chosen at random s.t. we get roughly 91% for `x = 100`.
        }
      </div>
    </div>
    <Typewriter disabled={disableInput || crashed || bootFailed}/>
    <LeanGateOverlay />
    </RpcContext.Provider>
  </div>
}
