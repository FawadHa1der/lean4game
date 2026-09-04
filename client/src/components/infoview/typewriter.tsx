import * as React from 'react'
import { useRef, useState, useEffect } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faWandMagicSparkles } from '@fortawesome/free-solid-svg-icons'
import { CircularProgress } from '@mui/material'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { DiagnosticSeverity, PublishDiagnosticsParams, DocumentUri } from 'vscode-languageserver-protocol';
import { useServerNotificationEffect } from '../../../../node_modules/vscode-lean4/lean4-infoview/src/infoview/util';
import { InteractiveDiagnostic } from '@leanprover/infoview-api';
import { Diagnostic } from 'vscode-languageserver-types';
import { RpcContext } from '../../../../node_modules/vscode-lean4/lean4-infoview/src/infoview/rpcSessions';
import { MonacoEditorContext } from './context'
import { lastStepHasErrors, loadGoals } from './goals'
import { ProofState } from './rpc_api'
import { useTranslation } from 'react-i18next'
import { useAtom } from 'jotai'
import { levelIdAtom, worldIdAtom } from '../../store/location-atoms'
import { preferencesAtom } from '../../store/preferences-atoms'
import { crashedAtom, interimDiagsAtom, proofAtom, typewriterContentAtom } from '../../store/editor-atoms'
import { deletedChatAtom } from '../../store/chat-atoms'

export interface GameDiagnosticsParams {
  uri: DocumentUri;
  diagnostics: Diagnostic[];
}

/** The input field */
export function Typewriter({disabled}: {disabled?: boolean}) {
  let { t } = useTranslation()

  /** Reference to the hidden multi-line editor */
  const editor = React.useContext(MonacoEditorContext)
  const model = editor?.getModel()
  const uri = model?.uri.toString() ?? ''
  const hasEditor = Boolean(editor && model)

  const [worldId] = useAtom(worldIdAtom)
  const [levelId] = useAtom(levelIdAtom)

  const [oneLineEditor, setOneLineEditor] = useState<monaco.editor.IStandaloneCodeEditor>()
  const oneLineEditorRef = useRef<monaco.editor.IStandaloneCodeEditor>(null)
  const [processing, setProcessing] = useState(false)
  /** The command whose verdict is pending — shown in the checking overlay. */
  const lastSubmitted = useRef<string>('')
  /** While set, only a proof state whose LAST step carries this command is
   * the verdict. Proof states from requests that were in flight before the
   * submit (the level's initial load, a session reconnect) come back with
   * the pre-edit document's steps and must not unlock the input. */
  const awaitedCommand = useRef<string | null>(null)
  /** Set at submit; the proof state is requested only once the server has
   * acknowledged the new document version (its first publishDiagnostics),
   * so the request cannot be answered from the pre-edit document. */
  const awaitingVerdict = useRef(false)

  const [typewriter, setTypewriter] = useAtom(typewriterContentAtom)

  const inputRef = useRef<HTMLDivElement>()

  const [proof, setProof] = useAtom(proofAtom)
  const [interimDiags, setInterimDiags] = useAtom(interimDiagsAtom)
  const [, setCrashed] = useAtom(crashedAtom)

  // state to store the last batch of deleted messages
  const [, setDeletedChat] = useAtom(deletedChatAtom)

  const rpcSess = React.useContext(RpcContext)

  // Run the command
  const runCommand = React.useCallback(() => {
    if (processing || !hasEditor) {return}

    // TODO: Desired logic is to only reset this after a new *error-free* command has been entered
    setDeletedChat([])

    const pos = editor.getPosition()
    if (typewriter) {
      lastSubmitted.current = typewriter.trim()
      awaitedCommand.current = typewriter.trim()
      setProcessing(true)
      editor.executeEdits("typewriter", [{
        range: monaco.Selection.fromPositions(
          pos,
          editor.getModel()?.getFullModelRange().getEndPosition()
        ),
        text: typewriter.trim() + "\n",
        forceMoveMarkers: false
      }])
      setTypewriter('')
      // The proof state is loaded from the publishDiagnostics handler below:
      // requesting it here, synchronously, let the request overtake the
      // didChange and come back with the PRE-edit state (traced under wasm).
      awaitingVerdict.current = true
    }

    editor.setPosition(pos)
  }, [typewriter, editor, processing])

  const [{ isSuggestionsMobileMode }] = useAtom(preferencesAtom)

  useEffect(() => {
    if (oneLineEditor && oneLineEditor.getValue() !== typewriter) {
      oneLineEditor.setValue(typewriter)
      oneLineEditor.setPosition({ column: typewriter.length + 1, lineNumber: 1 })
      isSuggestionsMobileMode || oneLineEditor.focus()
    }
  }, [typewriter])

  useEffect(() => {
    if (oneLineEditor && hasEditor) {
      oneLineEditor.setPosition({ column: editor.getValue().length + 1, lineNumber: 1 })
      isSuggestionsMobileMode || oneLineEditor.focus()
    }
  }, [oneLineEditor, hasEditor, isSuggestionsMobileMode, editor])

  /** If the last step has an error, add the command to the typewriter — and
   * park the editor cursor at the START of that failed line so the next
   * command REPLACES it (the "will be removed on the next try" contract).
   *
   * Placing the cursor here, from the authoritative proof state, rather than
   * only in the publishDiagnostics handler, makes the replacement robust to
   * the server's publish cadence: the wasm worker publishes an interim
   * error-free diagnostics set before the real one for the same version, and
   * the handler's "no errors → cursor to end" fired on the interim, so the
   * next tactic was appended after the failed one (level could never
   * complete). Native Lean happened to publish the errored set first. */
  useEffect(() => {
    if (!proof || !hasEditor) return
    // The proof state is the verdict on the submitted command: only now is
    // it safe to accept the next one (see the publishDiagnostics note) —
    // unless it answers a request that predates the edit (traced on NNG4:
    // the level's initial state at ~0.2 s, the real verdict at ~2 s).
    if (awaitedCommand.current !== null) {
      const lastCmd = proof.steps[proof.steps.length - 1]?.command ?? ''
      if (!lastCmd.includes(awaitedCommand.current)) return
      awaitedCommand.current = null
    }
    setProcessing(false)
    if (lastStepHasErrors(proof)) {
      const last = proof.steps.length - 1
      setTypewriter(proof.steps[last].command)
      editor.setPosition({ lineNumber: last, column: 1 })
    } else {
      editor.setPosition(editor.getModel().getFullModelRange().getEndPosition())
    }
  }, [proof])

  // React when answer from the server comes back
  useServerNotificationEffect('textDocument/publishDiagnostics', (params: PublishDiagnosticsParams) => {
    if (!hasEditor) {
      return
    }
    if (params.uri == uri) {
      if (awaitingVerdict.current) {
        // First diagnostics for the edited document: the server is on the
        // new version now, and getProofState waits for its elaboration.
        awaitingVerdict.current = false
        loadGoals(rpcSess, uri, worldId!, levelId!, setProof, setCrashed)
      }
      // NOTE: `processing` is NOT released here. The wasm worker publishes
      // an interim, error-free diagnostics set for a version before the
      // real one; releasing on it let a second Enter land (and the input
      // be edited, then clobbered by the failed-command refill) before the
      // verdict existed. The proof-state effect releases it instead.

      const seriousDiags = params.diagnostics.filter(diag =>
        diag.severity === DiagnosticSeverity.Error || diag.severity === DiagnosticSeverity.Warning
      )
      setInterimDiags(seriousDiags)
      // loadGoals(rpcSess, uri, worldId, levelId, setProof, setCrashed)

      // TODO: loadAllGoals()
      if (!hasErrors(params.diagnostics)) {
        //setTypewriterInput("")
        editor.setPosition(editor.getModel().getFullModelRange().getEndPosition())
      }
    } else {
      // console.debug(`expected uri: ${uri}, got: ${params.uri}`)
      // console.debug(params)
    }
    // TODO: This is the wrong place apparently. Where do wee need to load them?
    // TODO: instead of loading all goals every time, we could only load the last one
    // loadAllGoals()
  }, [uri, hasEditor, editor, rpcSess, worldId, levelId]);

  // // React when answer from the server comes back
  // useServerNotificationEffect('$/game/publishDiagnostics', (params: GameDiagnosticsParams) => {
  //   console.log('Received game diagnostics')
  //   console.log(`diag. uri : ${params.uri}`)
  //   console.log(params.diagnostics)

  // }, [uri]);


  useEffect(() => {
    if (oneLineEditorRef.current) {
      return
    }
    const myEditor = monaco.editor.create(inputRef.current!, {
      value: typewriter,
      language: "lean4",
      quickSuggestions: false,
      // lightbulb: {
      //   enabled: true
      // },
      unicodeHighlight: {
          ambiguousCharacters: false,
      },
      automaticLayout: true,
      minimap: {
        enabled: false
      },
      lineNumbers: 'off',
      tabSize: 2,
      wordWrap: 'on',
      glyphMargin: false,
      folding: false,
      lineDecorationsWidth: 0,
      lineNumbersMinChars: 0,
      'semanticHighlighting.enabled': true,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      padding: {
        top: 0,
        bottom: 0,
      },
      scrollbar: {
        verticalScrollbarSize: 3
      },
      scrollBeyondLastLine: false,
      overviewRulerBorder: false,
      theme: 'vs-code-theme-converted',
      contextmenu: false
    })

    const layoutInput = () => {
      const lineHeight = myEditor.getOption(monaco.editor.EditorOption.lineHeight)
      const height = Math.min(myEditor.getContentHeight(), lineHeight + 2, window.innerHeight / 3)
      inputRef.current.style.height = `${height}px`
      myEditor.layout({
        width: inputRef.current.clientWidth,
        height
      })
    }
    myEditor.onDidContentSizeChange(layoutInput)
    layoutInput()

    oneLineEditorRef.current = myEditor
    setOneLineEditor(myEditor)

    // const abbrevRewriter = new AbbreviationRewriter(new AbbreviationProvider(), myEditor.getModel(), myEditor)

    return () => {
      // abbrevRewriter.dispose()
      myEditor.dispose()
      oneLineEditorRef.current = null
      setOneLineEditor(undefined)
    }
  }, [])

  useEffect(() => {
    if (!oneLineEditor) return
    // Ensure that our one-line editor can only have a single line
    const l = oneLineEditor.getModel()?.onDidChangeContent((e) => {
      const value = oneLineEditor.getValue()
      setTypewriter(value)
      const newValue = value.replace(/[\n\r]/g, '')
      if (value != newValue) {
        oneLineEditor.setValue(newValue)
      }
    })
    return () => {
      if (typeof (l as any)?.dispose === 'function') {
        l.dispose()
      } else if (typeof l === 'function') {
        l()
      }
    }
  }, [oneLineEditor, setTypewriter])

  useEffect(() => {
    if (!oneLineEditor) return
    // Run command when pressing enter (and block newline insertion)
    const l = oneLineEditor.onKeyDown((ev) => {
      if (ev.code === "Enter" || ev.code === "NumpadEnter") {
        ev.preventDefault()
        runCommand()
      }
    })
    return () => {
      if (typeof (l as any)?.dispose === 'function') {
        l.dispose()
      } else if (typeof l === 'function') {
        l()
      }
    }
  }, [oneLineEditor, runCommand])

  // // BUG: Causes `file closed` error
  // //TODO: Intention is to run once when loading, does that work?
  // useEffect(() => {
  //   console.debug(`time to update: ${uri} \n ${rpcSess}`)
  //   console.debug(rpcSess)
  //   // console.debug('LOAD ALL GOALS')
  //   // TODO: loadAllGoals()
  // }, [rpcSess])

  // Lock the one-line editor while the checker works on the last command.
  // Under wasm a step takes 1–3 s (vs ~0.6 s server-side); text typed into
  // an editable input during that window was silently replaced by the
  // failed-command refill when the step failed.
  // Also locked until the level's first proof state exists: a tactic typed
  // into the input while the pane still waits for the checker's first answer
  // has nothing to attach to (and was silently lost on the live site).
  useEffect(() => {
    if (!oneLineEditor) return
    oneLineEditor.updateOptions({
      readOnly: processing || proof === undefined,
      readOnlyMessage: { value: proof === undefined ? t("The level is still loading…") : t("Lean is still checking your previous step…") },
    })
  }, [oneLineEditor, processing, proof === undefined])

  // Safety valves: a crash (no proof state will come) or a lost response
  // must not leave the input locked.
  useEffect(() => {
    if (!processing) return
    const timer = setTimeout(() => setProcessing(false), 60000)
    return () => clearTimeout(timer)
  }, [processing])
  const [crashed] = useAtom(crashedAtom)
  useEffect(() => {
    if (crashed) setProcessing(false)
  }, [crashed])

  /** Process the entered command */
  const handleSubmit : React.FormEventHandler<HTMLFormElement> = (ev) => {
    ev.preventDefault()
    runCommand()
  }

  // do not display if the proof is completed (with potential warnings still present)
  return <div className={`typewriter${proof?.completedWithWarnings && !lastStepHasErrors(proof) ? ' hidden' : ''}${disabled ? ' disabled' : ''}`}>
      <form onSubmit={handleSubmit}>
        <div className="typewriter-input-wrapper">
          <div ref={inputRef} className="typewriter-input" />
        </div>
        <button type="submit" disabled={processing} className="btn btn-inverted">
          {processing
            ? <><CircularProgress size={14} thickness={5} color="inherit" />&nbsp;{t("Checking…")}</>
            : <><FontAwesomeIcon icon={faWandMagicSparkles} />&nbsp;{t("Execute")}</>}
        </button>
      </form>
      {processing &&
        <div className="lean-checking-note" role="status" aria-live="polite">
          <CircularProgress size={12} thickness={5} color="inherit" />
          <span>{t("Checking")} <code>{lastSubmitted.current}</code> …</span>
        </div>
      }
    </div>
}

/** Checks whether the diagnostics contain any errors or warnings to check whether the level has
   been completed.*/
export function hasErrors(diags: Diagnostic[]) {
  return diags.some(
    (d) =>
      !d.message.startsWith("unsolved goals") &&
      (d.severity == DiagnosticSeverity.Error ) // || d.severity == DiagnosticSeverity.Warning
  )
}

// TODO: Didn't manage to unify this with the one above
export function hasInteractiveErrors (diags: InteractiveDiagnostic[]) {
  return (typeof diags !== 'undefined') && diags.some(
    (d) => (d.severity == DiagnosticSeverity.Error ) // || d.severity == DiagnosticSeverity.Warning
  )
}

export function getInteractiveDiagsAt (proof: ProofState, k : number) {
  if (k == 0) {
    return []
  } else if (k >= proof?.steps.length-1) {
    // TODO: Do we need that?
    return proof?.diagnostics.filter(msg => msg.range.start.line >= proof?.steps.length-1)
  } else {
    return proof?.diagnostics.filter(msg => msg.range.start.line == k-1)
  }
}
