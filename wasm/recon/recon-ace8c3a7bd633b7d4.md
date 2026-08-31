# lean4game relay/node server — recon report

Repo: `/Users/fawadhaider/code/wasm64-lean4game` (lean4game @ Lean v4.31.0 era, per `server/lean-toolchain` = `leanprover/lean4:v4.31.0`). All server-side node code lives under `relay/`; there is no other node server code (client is pure Vite/React; `server/` is the Lean GameServer package). Entry: `relay/dist/src/index.js` compiled from `relay/src/index.ts` (tsconfig `outDir: ./dist/`, so `__dirname` at runtime = `relay/dist/src/`). pm2 config `ecosystem.config.cjs` runs it with env `PORT=8002`, `API_PORT=8010`, `NODE_ENV=production`, plus `LEAN4GAME_GITHUB_USER/TOKEN`, `RESERVED_DISC_SPACE_MB`, `ISSUE_CONTACT`, `CPU_SCRIPT`. Root `package.json` scripts: `start:relay` = `npm --workspace relay run dev` (`tsc -b` + nodemon, `NODE_ENV=development`), `prod` = `node ./dist/src/index.js`.

## 1. Process spawning / pooling (`relay/src/serverProcess.ts`)

`GameManager` (constructed in `index.ts:18` with `__dirname`) — key methods:

- `getGameDir(owner, repo)` (serverProcess.ts:301-337): owner lowercased. Layouts:
  - `local/<repo>` (dev only): `<this.dir>/../../../../<repo>` = **sibling directory of the lean4game checkout** (one level above repo root).
  - `test/<repo>`: `<repoRoot>/cypress/<repo>` (TestGame).
  - otherwise: `<repoRoot>/games/<owner>/<repo-lowercased>`.
  - Validates existence of `<gameDir>/.lake/gamedata/game.json`; returns `""` otherwise.

- Spawn (`createGameProcess`, serverProcess.ts:83-119). Three code paths:
  1. **Dev / `NO_BWRAP=true`, modern game**: `cp.spawn("lake", ["serve", "--"], { cwd: game_dir })` (line 98). That is the *stock Lean watchdog* of the game's own toolchain — no custom binary.
  2. **Dev, legacy game** (custom server detected): binary at `<gameDir>/.lake/packages/GameServer/server/.lake/build/bin/gameserver` (`getCustomLeanServer`, lines 73-81). Spawned as `./gameserver --server <game_dir>` with `cwd` = the `bin` dir (comment: watchdog re-execs `./gameserver` for workers) (lines 92-96).
  3. **Production (Linux)**: `cp.spawn("../../scripts/bubblewrap.sh", [game_dir, "true"|"false", extraBindOpts], { cwd: this.dir })` (lines 101-110; `this.dir` = `relay/dist/src`, so script = `relay/scripts/bubblewrap.sh`). For `owner == "test"` it appends `--bind <repoRoot>/server /server`.

- **bubblewrap.sh** (`relay/scripts/bubblewrap.sh`): `ulimit -t 3600` (1h CPU cap = the only TTL; no wall-clock TTL, no idle kill). Computes `LEAN_ROOT=$(cd $1 && lean --print-prefix)` and `LEAN_SRC_PATH=$(lake env printenv LEAN_SRC_PATH)`. Then `exec bwrap` with: `--ro-bind $gameDir /game`, `--ro-bind $LEAN_ROOT /lean`, `--ro-bind /usr /usr`, `--dev /dev --tmpfs /tmp --proc /proc`, `--clearenv`, `--setenv PATH /bin:/usr/bin:/lean/bin`, `--setenv LEAN_SRC_PATH`, `--unshare-user/pid/net/uts/cgroup`, `--die-with-parent`, `--chdir /game` (or the gameserver bin dir for legacy), running `lake serve --` (or `./gameserver --server /game`). No docker.

- **Pooling**: `queueLength` map (serverProcess.ts:31-36) declares pre-warm pools for nng4(5), robo(2), stg4(2), lean4game-logic(2); `queue = {}`. But `startGame` (lines 43-71) only takes from `this.queue[tag]` when it's non-empty, and `fillQueue` (lines 124-138) is called *only after* a successful `shift()` (line 60). Since `queue[tag]` starts undefined, the pool never gets seeded — **the pre-warm queue is dead code in this clone**; every WebSocket connection gets a freshly spawned process, 1 process per connection, killed implicitly when the socket closes (via connection disposal + `--die-with-parent`; there is no explicit `ps.kill()` in the relay — process death relies on stdin/stdout closing / bwrap).

## 2. Client↔relay wire protocol (`relay/src/websocket.ts`, `index.ts:167-171`)

- **Plain WebSocket, NOT socket.io.** `new WebSocketServer({ server })` (`ws` package) attached to the main express HTTP server (index.ts:167). Every upgrade hits `GameSessionsObserver.startObservedGame(ws, req)` (websocket.ts:77-130).
- URL: `wss://<host>/websocket/g/<owner>/<repo>` — regex `^\/websocket\/g\/([\w.-]+)\/([\w.-]+)$` (serverProcess.ts:39). Client side builds it in `client/src/store/editor-atoms.ts:15` (`'/websocket/' + gameId`, gameId = `g/<owner>/<repo>` from `location-atoms.ts:31-40`) and hands it to `lean4monaco`'s `LeanMonacoOptions.websocket.url`. Vite dev proxy: `client/vite.config.ts:61-78` proxies `/websocket` (ws), `/import`, `/data`, `/api`, `/i18n` to the relay.
- **Framing**: `vscode-ws-jsonrpc` — one JSON-RPC 2.0 message per WS text frame (`WebSocketMessageReader/Writer` wrapping the raw `ws` socket, websocket.ts:95-107); `jsonrpcserver.createConnection` + `createProcessStreamConnection(process)` (stdio, standard `Content-Length` LSP framing on the Lean side). So the relay is an LSP<->WS bridge with a rewriting layer.
- **Lifecycle**: on connect, spawn/fetch process, register `Player {id: randomUUID, currentGame, anonIP, lang (from Accept-Language), process}`; on either side closing, dispose the other (websocket.ts:114-119); on `ws close` remove player (124-129). No reconnect/resume support — a new WS = a new Lean process.
- **Message rewriting** (`GameManager.messageTranslation`, serverProcess.ts:140-299) — this is the real "protocol" and must be re-implemented client-side for a browser worker (unless the worker keeps a shim). Skipped entirely if `usesCustomLeanServer` (legacy ≤ v4.7.0). Constant `PROOF_START_LINE = 2`.
  - client→server: on `initialize`, reads `params.initializationOptions.difficulty` and `.inventory`, and overwrites `params.rootUri = gameData.name` (game name smuggled via rootUri; gameData read from `<gameDir>/.lake/gamedata/game.json`, lines 187-188, 202-207). NOTE: in this clone the client never actually sets those initializationOptions (lean4monaco `leanclient.js:454` only sends `editDelay`/`hasWidgets`), so the relay's fallback `difficulty=1, inventory=[]` (lines 230-234) fires.
  - on `textDocument/didOpen`: parses the client URI `file:///<worldId>/<levelId>.lean` (set in `client/src/components/level.tsx:246`), rewrites all `uri` fields to `file://<gameDir>/Game/Metadata.lean`, and **wraps the user text** into: `import <levelData.module> import GameServer.Runner \nRunner "<gameName>" "<worldId>" <levelId> (difficulty := N) (inventory := [...]) := by\n<content>\n` (lines 213-242), with `levelData.module` read from `<gameDir>/.lake/gamedata/level__<worldId>__<levelId>.json`.
  - all other client messages: `replaceUri` → `file://<gameDir>/Game/Metadata.lean`, and `shiftLines(+2)` on every `line`/`lineRange` field recursively (lines 147-163, 244-247).
  - `textDocument/semanticTokens/full` request ids remembered (lines 209-211).
  - server→client: `shiftLines(-2)`, `replaceUri` back to `file:///<worldId>/<levelId>.lean`, disables `capabilities.semanticTokensProvider.range` in the initialize result, and rewrites semanticTokens response `result.data` to drop tokens before line 2 and rebase the first delta (lines 257-298).
- Custom in-file RPC (rides on standard `$/lean/rpc/*`): `Game.getInteractiveGoals` and `Game.getProofState`, `@[server_rpc_method]`s at `server/GameServer/RpcHandlers.lean:359-364`; called from `client/src/components/infoview/info.tsx:317,323` and `goals.tsx:372`.

## 3. HTTP endpoints (`relay/src/index.ts`)

Main server (PORT, default 8080; pm2 8002):
- `express.static(<repoRoot>/client/dist)` — built client (index.ts:16,30).
- `GET /i18n/g/:owner/:repo/:lang` (index.ts:31-68): serves `<gameDir>/.i18n/<lang>/Game.json` (rewrites `req.url` to `Game.json`); on miss returns `{}` with 200. Also appends to `<cwd>/logs/game-access.log` (`date;anon-ip;game;lang`). Client consumes via i18next `loadPath` `/i18n/${ns}/${lng}` (`client/src/i18n.ts:17`).
- `GET /data/g/:owner/:repo/*path` (index.ts:69-85): static from `<gameDir>/.lake/gamedata/`, `{}` on miss. Client fetches: `game.json` (`client/src/store/query-atoms.ts:13`), `level__<world>__<level>.json` (query-atoms.ts:34), `inventory.json` (`inventory-atoms.ts:21`), `doc__<Type>__<name>.json` (inventory-atoms.ts:34,49; legacy casing fallback), and images (copied into gamedata, see below).
- `GET /data/stats` (index.ts:86-106): spawns `/bin/bash relay/scripts/stats.sh <pid>`; stats.sh runs `cpu_usage.py` (or `$CPU_SCRIPT`) + `free`/awk → returns `CPU, MEM\n<f>, <f>` (Linux-only).
- `GET /api/games` (index.ts:108-163): landing-page tiles. Featured list **hard-coded in source** (lines 113-122: leanprover-community/nng4, hhu-adam/robo, alexkontorovich/realanalysisgame, djvelleman/stg4, trequetrum/lean4game-logic, emilyriehl/reintroductiontoproofs, jadabouhawili/knightsandknaves-lean4game, zrtmrh/linearalgebragame); reads each `<repoRoot>/games/<owner>/<game>/.lake/gamedata/game.json` and returns `{owner, game, tile}`. In dev also scans **every sibling directory of the repo root** for `.lake/gamedata/game.json` and adds them as `owner:"local"` (lines 138-156).
- `GET /import/trigger/:owner/:repo` and `GET /import/status/:owner/:repo` (router, index.ts:26-27; `relay/src/import.ts`): GitHub-artifact game import. `doImport` (import.ts:81-147): picks the newest Actions artifact via octokit, downloads zip to `<repoRoot>/games/tmp/<owner>_<repo>_<artifactId>.zip`, runs `relay/scripts/unpack.sh` (unzip outer zip, then unzip inner zip into `games/<owner>/<repo>`, deleting any old version) and `relay/scripts/install_toolchain.sh` (`elan toolchain install $(head games/<owner>/<repo>/lean-toolchain)`). Disk guard in `relay/src/middleware.ts` (`safeImport`, `df -BM`, `RESERVED_DISC_SPACE_MB`).

Second express instance on `API_PORT` (index.ts:169-180): `GET /api/game-sessions` → `GameSessionsObserver.getAllConnectedPlayers()` (websocket.ts:41-68): arrays of `{date, anon_Ip, game, lang}` per open socket.

**Installed-game directory layout expected** (per above + `server/GameServer/SaveData.lean:27-33`):
```
games/<owner>/<repo>/
  lean-toolchain                  (drives elan install)
  lakefile / .lake/build/...      (game + deps oleans incl. mathlib; `lake serve` runs here)
  .lake/packages/GameServer/...   (GameServer dep; legacy also .../server/.lake/build/bin/gameserver)
  .lake/gamedata/game.json, level__<World>__<n>.json, doc__<Type>__<name>.json, inventory.json, images/**
  .i18n/<lang>/Game.json          (translations, produced by I18n.createTemplate)
  Game/Metadata.lean              (the file URI all LSP traffic is rewritten to)
```

## 4. Gameserver startup / environment loading

- **Nothing is sent to the Lean process before the client attaches.** The relay spawns `lake serve --` and simply pipes; the client's own `initialize`/`initialized`/`didOpen` (from lean4monaco/vscode-lean4 LeanClient) are the first messages. The (dormant) queue was meant only to pre-pay `lake serve` startup cost (lake env resolution), not to pre-initialize LSP.
- Environment loading happens per `didOpen`: the injected header `import <levelModule> import GameServer.Runner` makes the file worker load the level's compiled olean closure (game modules + GameServer + Mathlib) from `.lake/build` / `.lake/packages/*/.lake/build` inside the game dir. Every didOpen (i.e. every level entry, and every editor restart) pays a full import-from-olean load in a fresh file worker. No mathlib server-side cache beyond the oleans shipped in the game artifact; toolchain binaries come from elan (`~/.elan`), ro-bound as `/lean` in bwrap.
- The `Runner` command (`server/GameServer/Runner.lean:99-162`) then: looks up the level from env extensions (`getLevel?`, `server/GameServer/EnvExtensions.lean:491` — populated by the imported level module), replays the level's scope (namespaces/opens/options), checks forbidden tactics/theorems against `loadLevelData "." world level` (reads `.lake/gamedata/level__*.json` **relative to cwd**, hence `--chdir /game`; Runner.lean:19), appends invisible `skip` and final `done`, and elaborates `theorem the_theorem <goal> := by let_intros; <preamble>; <user tactics>`.
- Goals/proof state are then pulled by the client over `$/lean/rpc` (`Game.getProofState`, `Game.getInteractiveGoals`).
- Legacy path (games built against lean4game ≤ v4.7.0): custom `gameserver` binary (its own watchdog re-exec'ing `./gameserver`), spoken to with a bespoke protocol; relay passes traffic through untranslated (`usesCustomLeanServer` early-returns at serverProcess.ts:197-200, 266).

## 5. Moot vs must-reimplement for a QED64 browser worker

**Made moot by in-browser wasm worker:** all of bubblewrap sandboxing + ulimits; process spawn/queue/TTL; elan toolchain install; GitHub artifact import pipeline (import.ts, unpack.sh, install_toolchain.sh, disk guard); `/data/stats`, `/api/game-sessions`, access/game logs, ip-anonymize; the whole ws↔stdio bridge (`vscode-ws-jsonrpc`); pm2/ecosystem.config.cjs; legacy custom-gameserver support (can be dropped — new games don't use it).

**Must be reimplemented (client-side or at pack-build time):**
1. The **messageTranslation shim** (serverProcess.ts:140-299): didOpen wrapping into the `Runner` command, ±2 line shifting, URI rewriting, semanticTokens rebasing, rootUri=gameName on initialize. Natural home: between lean4monaco's WS transport and the QED64 in-tab worker (QED64's watchdog-shim is the obvious splice point), or alternatively teach `GameServer.Runner` a browser-side setup so the wrapping happens in the worker.
2. **Game data serving**: `/data/g/...` → `.lake/gamedata/*.json` + images, and `/i18n/g/...` → `.i18n/<lang>/Game.json`. These are plain static files — can ship inside the QED64 library pack or as static hosting; the `{}`-on-404 fallback behavior is relied upon by the client (empty translation/level).
3. **Game manifest aggregation** (`/api/games`): hard-coded featured list + per-game `game.json.tile`; becomes a static JSON manifest.
4. **Olean/environment**: the game's compiled modules + GameServer + Mathlib oleans must be baked into the wasm64 snapshot/library pack per game (the server today gets them for free from the unpacked artifact); `loadLevelData "."` means the worker's virtual FS must expose `.lake/gamedata/` at its cwd for `findForbiddenTactics`.
5. Note two latent quirks to preserve or fix consciously: (a) the client currently never sends `initializationOptions.difficulty/inventory`, so server-side forbidden-tactic checking effectively runs at difficulty 1 with empty inventory; (b) the pre-warm queue is dead code — no behavior to replicate.

Version-specifics: GameServer package pins `lean-toolchain` v4.31.0 and requires batteries/i18n `v4.31.0` tags (`server/lakefile.lean:6-7`) — QED64's Lean 4.33.0-pre fork will need GameServer + i18n ported to that toolchain, which is a Lean-side port, not a relay concern.