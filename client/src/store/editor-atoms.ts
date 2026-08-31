import { atom } from "jotai";
import { LeanMonaco, LeanMonacoOptions } from 'lean4monaco'
import { gameIdAtom } from "./location-atoms";
import { levelProgressAtom, progressAtom } from "./progress-atoms";
import { gameLspPort } from "../wasm/game-boot";
import { Selection } from "./progress-types";
import { levelInfoAtom } from "./query-atoms";
import { ProofState } from "../components/infoview/rpc_api";
import { Diagnostic } from 'vscode-languageserver-types'

/** Options for the LeanMonaco instance */
export const leanMonacoOptionsAtom = atom<LeanMonacoOptions>(get => {
  // CAUTION: this atom must stay stable across gameplay — app.tsx restarts
  // the whole LeanMonaco instance whenever it changes identity. difficulty
  // and inventory are therefore NOT read here; the wasm translation layer
  // reads them live at didOpen time (see game-boot's providers).
  const gameId = get(gameIdAtom)
  return {
  // wasm64 build: the Lean server runs in-tab (QED64 worker); the LSP client
  // attaches to a MessagePort instead of the relay websocket. The port exists
  // synchronously — traffic buffers until the wasm runtime finishes booting.
  // monaco-editor-wrapper only consumes `$type`/`worker`/`messagePort` from
  // this config, so the extra fields are harmless (upstream types predate it).
  websocket: {
    $type: "WorkerDirect",
    worker: { postMessage() {/* replaced by messagePort */} },
    messagePort: gameLspPort(),
  } as any,

  htmlElement: undefined, // The wrapper div for monaco
  vscode: {
    // The default options are defined in `LeanMonaco.start` and can be overwritten here.
    // See docstring of `LeanMonacoOptions`!
    // For example:
    "editor.wordWrap": true,
    // lean4game replaces the iframe infoview with its own EditorConnection
    // (level.tsx fabricates the webview panel); the built-in auto-open only
    // crashes into elements that are never rendered.
    "lean4.infoview.autoOpen": false,
  }
}})

/** The unique leanMonaco instance for the entire application */
export const leanMonacoAtom = atom<LeanMonaco | null>(null)

export const codeAtom = atom(
  get => {
    const levelProgress = get(levelProgressAtom)
    return levelProgress?.code
  },
  (get, set, val: string) => {
    const levelProgress = get(levelProgressAtom)
    if (levelProgress == null) return
    set(levelProgressAtom, { ...levelProgress, code: val })
  }
)

export const typewriterContentAtom = atom<string>("")

export const selectionsAtom = atom(
  get => {
    const levelProgress = get(levelProgressAtom)
    return levelProgress?.selections ?? []
  },
  (get, set, val: Selection[]) => {
    const levelProgress = get(levelProgressAtom)
    if (levelProgress == null) return
    set(levelProgressAtom, { ...levelProgress, selections: val })
  }
)

/** If a level has a template, the user is forced to use editor mode */
export const lockEditorModeAtom = atom(get => {
  const { data: levelInfo } = get(levelInfoAtom)
  return levelInfo?.template != null
})

/** Whether the current game is in typewriter mode */
export const typewriterModeAtom = atom(
  get => {
    // force editor mode
    const lockEditorMode = get(lockEditorModeAtom)
    if (lockEditorMode) return false

    // read setting from local storage
    const progress = get(progressAtom)
    return progress?.typewriterMode ?? true
  },
  (get, set, val: boolean | null) => {
    const progress = get(progressAtom)
    if (!progress) return
    const valMod = (val === null) ? undefined : val
    set(progressAtom, { ...progress, typewriterMode: valMod })
  }
)

/** The proof consists of multiple steps that are processed one after the other.
 * In particular multi-line terms like `match`-statements will not be supported.
 *
 * Note that the first step will always have "" as command
 */
export const proofAtom = atom<ProofState>()

/** TODO: Workaround to capture a crash of the gameserver. */
export const interimDiagsAtom = atom<Array<Diagnostic>>([])

/** TODO: Workaround to capture a crash of the gameserver. */
export const crashedAtom = atom<boolean>(false)
