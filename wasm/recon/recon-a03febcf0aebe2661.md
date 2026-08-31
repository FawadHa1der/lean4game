# lean4game CLIENT map (/Users/fawadhaider/code/wasm64-lean4game/client)

Repo layout note: node_modules is hoisted to the **repo root** (`/Users/fawadhaider/code/wasm64-lean4game/node_modules`); client code imports library *sources* via relative paths like `../../../node_modules/vscode-lean4/lean4-infoview/src/...`. All line refs below are exact.

## 1. Editor ↔ Lean server connection (transport + substitution seam)

**Transport: one raw WebSocket carrying an LSP jsonrpc stream** (vscode-ws-jsonrpc framing), NOT socket.io. Chain:

- URL is built in `client/src/store/editor-atoms.ts:11-24`:
```ts
export const leanMonacoOptionsAtom = atom<LeanMonacoOptions>(get => {
  const gameId = get(gameIdAtom)
  return {
  websocket: {
    url: ((window.location.protocol === "https:") ? "wss://" : "ws://") + window.location.host + '/websocket/' + gameId
  }, ...
```
  gameId is `g/{owner}/{repo}` so the endpoint is `ws(s)://host/websocket/g/{owner}/{repo}` (relay regex `/^\/websocket\/g\/([\w.-]+)\/([\w.-]+)$/` at `relay/src/serverProcess.ts:39`; one Lean process spawned per socket, `relay/src/websocket.ts:77-130`).
- The singleton `LeanMonaco` is started once in `client/src/app.tsx:30-45` (`new LeanMonaco(); _leanMonaco.setInfoviewElement(...); await _leanMonaco.start(leanMonacoOptions)`).
- Inside lean4monaco (`node_modules/lean4monaco/dist/leanmonaco.js:106-112`): `this.clientProvider = new LeanClientProvider({...}, {...}, setupMonacoClient(this.getWebSocketOptions(options), options.clientOptions))`. `getWebSocketOptions` (`leanmonaco.js:212-229`, **protected** per `dist/leanmonaco.d.ts:53`) returns `{ $type: 'WebSocketUrl', startOptions..., stopOptions..., ...options.websocket }`.
- `setupMonacoClient` (`node_modules/lean4monaco/dist/monacoleanclient.js:4-36`) feeds that into monaco-editor-wrapper's `LanguageClientWrapper.init({languageClientConfig: {languageId: 'lean4', options, clientOptions: merge(...) with a messageStrategy that pops a notification on message.error}})`, then `client._serverProcess = { stderr: { on: () => {} } }` (line 33 — stubbing out the assumption of a real server process).

**THE SEAM** is `monaco-editor-wrapper@5.3.1`'s `LanguageClientWrapper.startLanguageClientConnection` (`node_modules/monaco-editor-wrapper/dist/languageClientWrapper.js:94-147`):
```js
if (lcConfig?.$type === 'WebSocket' || lcConfig?.$type === 'WebSocketUrl') {
    const webSocket = new WebSocket(url);
    webSocket.onopen = async () => {
        const socket = toSocket(webSocket);   // vscode-ws-jsonrpc
        this.messageTransports = ... { reader: new WebSocketMessageReader(socket), writer: new WebSocketMessageWriter(socket) };
        ...
} else {   // 'WorkerConfig' | 'WorkerDirect'
    ... this.worker = workerDirectConfig.worker;
    if (lcConfig?.messagePort) { this.port = lcConfig.messagePort; }
    const startWorkerLS = async (port) => {
        this.messageTransports = ... { reader: new BrowserMessageReader(port), writer: new BrowserMessageWriter(port) };
```
i.e. the wrapper *already* supports an in-process transport: pass `{$type: 'WorkerDirect', worker}` or add `messagePort: MessagePort` and it builds `BrowserMessageReader/Writer` (`vscode-languageserver-protocol/browser.js`) MessageTransports — exactly what a QED64 in-tab wasm worker needs. It also accepts a fully custom `connectionProvider` (`languageClientWrapper.js:93,149-157`) returning arbitrary `MessageTransports`.

Two concrete substitution points:
1. Subclass `LeanMonaco` and override protected `getWebSocketOptions(options)` to return a `WorkerDirect` config (typed as `WebSocketConfigOptionsUrl` in `.d.ts` but only consumed via the `$type` switch above — a cast suffices).
2. The client already contains a (currently **dead/unused**) reconfiguration helper showing the intended hook: `client/src/components/level.tsx:40-64` `reconfigureLeanMonacoClient` sets `leanMonaco.clientProvider.setupClient = setupMonacoClient(leanMonaco.getWebSocketOptions(options))` and stops existing clients (imports `setupMonacoClient` from `lean4monaco/dist/monacoleanclient` at `level.tsx:9`). Nothing calls it — grep confirms only the definition.

Infoview wiring (important, non-iframe): lean4game does NOT use lean4monaco's iframe infoview. In `client/src/components/level.tsx:255-306` it grabs `leanMonaco.infoProvider.editorApi`, fabricates its own `InfoviewApi` + `EditorEvents`, injects `infoProvider.webviewPanel = { api: infoviewApi, visible: true }`, then builds `new EditorConnection(infoProvider.editorApi, editorEvents)` (imported from `../../../node_modules/vscode-lean4/lean4-infoview/src/infoview/editorConnection`, `level.tsx:12`) and provides it via `EditorContext.Provider` (`level.tsx:514`). Cursor moves are fired manually (`level.tsx:309-351`), then `infoProvider.sendConfig?.() / sendPosition?.()` (`level.tsx:353-354`).

## 2. Level document lifecycle

- **URI scheme**: `file:///${worldId}/${levelId}.lean` — `client/src/level.tsx:246` (`const uriStr = \`file:///${worldId}/${levelId}.lean\``), fallback duplicate at `client/src/components/infoview/main.tsx:453`. One doc per level; editor recreated per level via `key={worldId/levelId}` (`level.tsx:87`) and `useEffect` deps `[leanMonaco, worldId, levelId]` (`level.tsx:362`), disposing the old editor (didClose) each time.
- **didOpen text**: only the user's tactic script. `leanMonacoEditor.start(codeviewRef.current, uriStr, code ?? "")` (`level.tsx:251`) where `code` is the saved proof from localStorage (`codeAtom`, `editor-atoms.ts:29-39`). lean4monaco `dist/editor.js` writes an empty file into **memfs** and does `createModelReference(Uri.parse(fileName), code)`; the LeanClientProvider/languageclient then didOpens the model.
- **Template**: `levelInfo.template` is inserted client-side *after* start, only if the model is empty, via `executeEdits("template-writer", ...)` in `level.tsx:412-444` — arrives at the server as a normal didChange.
- **The wrapping into a real Lean file happens in the RELAY, not the client** (`relay/src/serverProcess.ts:191-253`): on `textDocument/didOpen` it parses world/level from the URI path (`:216-219`), rewrites every uri to `file://{gameDir}/Game/Metadata.lean` (`:221`), and replaces the text with:
```
import {levelData.module} import GameServer.Runner \nRunner "{gameName}" "{worldId}" {levelId} (difficulty := d) (inventory := [...]) := by\n{content}\n
```
  (`:236-242`), shifting all client→server lines by `PROOF_START_LINE = 2` (`:185, :247`) and unshifting server→client (`:268`), mapping uris back to `file:///{worldId}/{levelId}.lean` (`:269`), disabling range semanticTokens and re-shifting full semanticTokens data (`:272-295`). **A QED64 in-browser worker must reproduce this translation layer** (or the GameServer.Runner elaboration) since the client never sees it.
- **initialize**: relay expects `params.initializationOptions.difficulty` / `.inventory` and abuses `rootUri` for the game name (`serverProcess.ts:202-207`). The client currently sends neither — lean4monaco's copied leanclient only sends `{editDelay, hasWidgets}` (`node_modules/lean4monaco/dist/vscode-lean4/vscode-lean4/src/leanclient.js:454-457`) and `leanMonacoOptionsAtom` passes no `clientOptions` — so the relay logs "Did not receive difficulty/inventory from client!" and defaults to `difficulty=1, inventory=[]` (`serverProcess.ts:230-234`). (The plumbing exists: `LeanMonacoOptions.clientOptions` is lodash-merged into the client options in `monacoleanclient.js:12`.)
- **typewriter vs editor mode — identical at the LSP level; same doc, same URI.** `typewriterModeAtom` (`editor-atoms.ts:62-78`, default true, stored per game in progress); `lockEditorModeAtom` forces editor mode whenever the level has a template (`editor-atoms.ts:56-59`).
  - Typewriter: the visible one-line input is a *separate plain monaco editor* not attached to the LSP (`client/src/components/infoview/typewriter.tsx:147-182`); the real LSP-connected editor stays hidden (`DualEditor`, `main.tsx:50-65`: hidden div class). On Enter, `runCommand` (`typewriter.tsx:57-80`) appends `typewriter.trim() + "\n"` to the hidden model via `executeEdits("typewriter", ...)` → normal didChange → then `loadGoals(...)` (Game.getProofState). "Retry"/delete removes lines from the model (`main.tsx:486-514` `deleteProof`).
  - Editor mode: `Main` (`main.tsx:167-348`) re-requests `loadGoals` on every `textDocument/publishDiagnostics` for the uri (`main.tsx:245-253`).
  - Mode-switch cleanup effects: `level.tsx:454-466` (leaving typewriter) and `level.tsx:485-510` (entering typewriter squeezes blank lines).

## 3. Custom LSP/RPC surface used by the client

RPC calls (over Lean's `$/lean/rpc/call` session mechanism, via `rpcSess.call`):
- `Game.getProofState` — `client/src/components/infoview/goals.tsx:372-377` in `loadGoals()` (params = `TextDocumentPositionParams` (`DocumentPosition.toTdpp({line:0,character:0,uri})`) **plus `worldId`, `levelId`**; result `ProofState` typed in `client/src/components/infoview/rpc_api.ts:70-83`); also `client/src/components/infoview/info.tsx:317-322` (at cursor pos).
- `Game.getInteractiveGoals` — `info.tsx:323` (plain `Lsp.PlainGoalParams`).
- Server-side registrations: `server/GameServer/RpcHandlers.lean:360` and `:364` (`@[server_rpc_method]`), params `GameServer.ProofStateParams extends Lsp.PlainGoalParams` (`RpcHandlers.lean:200`).
- Standard Lean widget RPCs also used from `info.tsx:324-329`: `getInteractiveTermGoal`, `Widget_getWidgets`, `getInteractiveDiagnostics`.

Notifications listened for (via `useServerNotificationEffect`/`useServerNotificationState` from vscode-lean4 infoview util):
- `$/game/loading` — `main.tsx:556-564`; params `{kind: "loadConstants"|"finalizeExtensions", counter: number}` driving a progress bar. (No emitter exists in the current stock-server relay path — legacy of the custom gameserver watchdog.)
- `$/lean/fileProgress` — `main.tsx:105-111` and `main.tsx:220-228`.
- `textDocument/publishDiagnostics` — `typewriter.tsx:107-132` (clears `processing`, fills `interimDiagsAtom`), `main.tsx:245-253` (reload proof), `messages.tsx:227-233` (`WithLspDiagnosticsContext`).
- Client-notification observers: `textDocument/didChange` (`infos.tsx:19`), `textDocument/didClose` (`infos.tsx:84`, `main.tsx:307-316`, `main.tsx:410-418`).
- Commented-out legacy: `$/game/publishDiagnostics` (`typewriter.tsx:135-140`, interface `GameDiagnosticsParams` at `typewriter.tsx:21-24`).
- RPC session plumbing (must be answered by any replacement server): `$/lean/rpc/connect` and `$/lean/rpc/keepAlive` **every 10 s** — `node_modules/lean4monaco/dist/vscode-lean4/vscode-lean4/src/infoview.js:10-39` (`keepAlivePeriodMs = 10000`); sessions created per-uri through `EditorConnection.api.createRpcSession/closeRpcSession` (`node_modules/vscode-lean4/lean4-infoview/src/infoview/rpcSessions.tsx:13-14`, consumed via `useRpcSessionAtPos` at `:43`).

## 4. REST/HTTP endpoints fetched by the client (all response types in `client/src/store/api.ts`)

| Endpoint | Where fetched | Expected shape (type, `api.ts` lines) |
|---|---|---|
| `GET /data/{gameId}/game.json` | `store/query-atoms.ts:9-18` (`gameInfoAtomFamily`) | `GameInfo` (`api.ts:25-38`: title, introduction, worlds `{nodes:{id,title,introduction,image}, edges:string[][]}`, worldSize, authors, conclusion, tile, image, settings.unbundleHyps) |
| `GET /data/{gameId}/level__{worldId}__{levelId}.json` | `store/query-atoms.ts:27-38` (`levelInfoAtom`) | `LevelInfo` (`api.ts:54-69`: title, introduction, conclusion, index, tactics/lemmas/definitions `InventoryTile[]`, descrText, descrFormat, lemmaTab, statementName, displayName, template, image) |
| `GET /data/{gameId}/inventory.json` | `store/inventory-atoms.ts:16-25` | `InventoryOverview` (`api.ts:72-77`) |
| `GET /data/{gameId}/doc__{Tactic\|Theorem\|Definition}__{name}.json` | `store/inventory-atoms.ts:27-38`; legacy `doc__Lemma__` fallback `:40-53` | `Doc` (`api.ts:79-86`) |
| `GET /api/games` | `store/tiles-atoms.ts:6-14` | `GameTileWithName[]` (`api.ts:8-23`); served by `relay/src/index.ts:108-163` |
| `GET /data/stats` | `components/landing_page.tsx:212-235`, polled every **2 s** (`:91-96`) | CSV `CPU,MEM\n0.42,0.13` |
| `GET /locales/{lng}/{ns}.json` and `GET /i18n/{gameId}/{lng}` | `src/i18n.ts:10-22` (i18next-http-backend loadPath) | i18next JSON; relay serves game translations from `{gameDir}/.i18n/{lang}/Game.json`, empty `{}` fallback (`relay/src/index.ts:31-68`) |
| images | `path.join("data", gameId, image)` — `level.tsx:614`, `landing_page.tsx:38`, `main.tsx:573` | static file |

`/data/g/:owner/:repo/*` is served from `{gameDir}/.lake/gamedata` with `{}` fallback for missing JSON (`relay/src/index.ts:69-85`). `/import/status|trigger/:owner/:repo` exists in the relay (`index.ts:26-27`) and vite proxy, but the client never calls it. Fetching all of these can be satisfied by static files — nothing needs a live server except `/api/games` and `/data/stats`.

## 5. State management + server-process assumptions

**All live state is jotai; redux is vestigial**: `index.tsx:4` imports `Provider` from react-redux but never uses it; `store/api.ts:4` imports `createApi/fetchBaseQuery` but exports only interfaces. No redux slices remain (older lean4game used RTK slices; this fork migrated to atoms in `client/src/store/*-atoms.ts`).

Atoms of note:
- `store/editor-atoms.ts`: `leanMonacoOptionsAtom` (:11), `leanMonacoAtom` (:27), `codeAtom` (:29, backed by progress), `typewriterContentAtom` (:41), `lockEditorModeAtom` (:56), `typewriterModeAtom` (:62), `proofAtom` (:85, the `ProofState`), `interimDiagsAtom` (:88) + `crashedAtom` (:91) — both flagged "Workaround to capture a crash of the gameserver".
- `store/progress-atoms.ts`: all progress persisted to localStorage key `game_progress` (`:29-39` `atomWithStorage`), per game→world→level (`code`, `selections`, `completed`, `help`); `difficultyAtom` (:110), `completedAtom` (:133). Progress export/import UI: `components/popup/upload.tsx` (local JSON file, no server).
- `store/inventory-atoms.ts`: unlocked-item names appended on level completion (`inventoryAtom` :64-76; writer at `main.tsx:83-100`).
- `store/location-atoms.ts`: routing from URL hash `#/g/{owner}/{repo}/world/{w}/level/{n}` (`gameIdAtom` :31, `worldIdAtom` :46, `levelIdAtom` :62); router in `index.tsx:14-48` (also `VITE_LEAN4GAME_SINGLE` single-game mode :24-29).
- `store/preferences-atoms.ts`: localStorage `preferences` (:45), `mobileAtom` (:63).
- `store/world-tree-atoms.ts`, `store/chat-atoms.ts` (helpAtom/deletedChatAtom/selectedStepAtom).

Server-process assumptions to neutralize for in-browser operation:
- `$/lean/rpc/keepAlive` 10 s interval (infoview.js:25-35) — worker must accept it (or the session dies).
- Crash handling: `loadGoals` catch sets `crashedAtom` unless error string is exactly `'No connection to Lean'` (`goals.tsx:389-396`); TypewriterInterface renders "Crashed! Go to editor mode…" from `interimDiagsAtom` (`main.tsx:584-603`).
- `serverStopped`/`serverRestarted` EditorEvents rendered in `main.tsx:318-326` and `main.tsx:420-432`; `serverRestarted` also feeds `ServerVersion`.
- No client reconnect: `connectionOptions.maxRestartCount: 0` (`lean4monaco leanclient.js` obtainClientOptions), and wrapper stops the languageclient on reader close (`languageClientWrapper.js:173-182`).
- `client._serverProcess = {stderr:{on:()=>{}}}` stub (`monacoleanclient.js:33`).
- Landing page polls `/data/stats` every 2 s for server CPU/MEM (`landing_page.tsx:91-96`) — logs-and-ignores failures.

## 6. Build system & version pins

- **Vite 7** (`client/vite.config.ts`; installed vite 7.3.2), `@vitejs/plugin-react-swc`, `vite-plugin-svgr`, `vite-plugin-static-copy` (copies `lean4monaco/node_modules/@leanprover/infoview/dist/*` + `lean4monaco/dist/webview/webview.js` → `dist/infoview`, codicon.ttf → assets; `vite.config.ts:28-44`), `vite-plugin-node-polyfills` with **`fs: 'memfs'` override** (`:45-49`) — required because lean4monaco's editor writes level files into memfs. `optimizeDeps.esbuildOptions.plugins: [importMetaUrlPlugin]` (`@codingame/esbuild-import-meta-url-plugin`, `:53-58`), alias `path → path-browserify` (`:80-84`). Dev proxies to backend :8080: `/websocket` (ws:true), `/import`, `/data`, `/api`, `/i18n` (`:59-78`).
- **Pins that matter** (installed at repo-root node_modules):
  - `lean4monaco` **1.1.9** (client/package.json `^1.1.9`); nests `@leanprover/infoview 0.8.5`, `@leanprover/infoview-api 0.7.0`.
  - `monaco-editor-wrapper` **5.3.1** → deps `monaco-languageclient 8.6.0`, `vscode-languageclient 9.0.1`, `vscode-languageserver-protocol 3.17.5`, `vscode-ws-jsonrpc 3.3.2`, `@codingame/monaco-vscode-* ~6.0.3` (monaco-editor is `npm:@codingame/monaco-vscode-editor-api@~6.0.3`).
  - `vscode-lean4` pinned `github:leanprover/vscode-lean4#de0062c` (client/package.json:38) — the client deep-imports its **lean4-infoview TypeScript source** (contexts, editorConnection, event, rpcSessions, util, goalLocation, interactiveCode, tooltips, serverVersion, index.css) via `../../../node_modules/vscode-lean4/lean4-infoview/src/...` (`level.tsx:11-13`, `main.tsx:8,13-16`, `goals.tsx:8-15`, `typewriter.tsx:7,10`, `messages.tsx`), so the hoisted node_modules layout is load-bearing.
  - Top-level `@leanprover/infoview` **0.4.4** / `@leanprover/infoview-api 0.2.1` (client-side types only; the real infoview components come from the vscode-lean4 source imports).
  - jotai 2.13.1 + jotai-tanstack-query, `@reduxjs/toolkit 1.9.7`/`react-redux 8.1.3` (vestigial), `memfs 4.51.1`.
- Monaco workers registered in `lean4monaco/dist/leanmonaco.js:46-60` (editorWorkerService + textMateWorker); the extension manifest/theme/grammars come from the bundled vscode-lean4 package.json (`leanmonaco.js:186-211`).

## Architecture takeaway for the QED64 swap

The single choke point is `setupMonacoClient(getWebSocketOptions(options))` (`lean4monaco/dist/leanmonaco.js:112`). Replacing the transport = handing monaco-editor-wrapper a `{$type:'WorkerDirect', worker}` (or `messagePort`) config — no changes needed in the infoview, RPC, or state layers, which all speak plain LSP over whatever MessageTransports the wrapper builds. But the **relay's message-translation layer** (`relay/src/serverProcess.ts:191-298`: didOpen wrapping into `Runner`, ±2 line shifting, uri rewriting, semanticToken shifting, initializationOptions difficulty/inventory, rootUri=game name) currently lives server-side and must be re-implemented either inside the wasm worker's watchdog shim or as a MessagePort-interposing translator in the page.