# Kernel dependency

The wasm64 Lean kernel this game runs on lives at
**github.com/FawadHa1der/lean4, branch `qed64-wasm64`**
(local checkout: `~/code/wasm64-lean-kernel`). It builds with
`wasm64-build/build.sh` there; this repo consumes its OUTPUTS:

- runtime chunks in `client/public/runtime/` (chunked by qed64's
  `chunk-runtime.mjs` from the kernel's stage1),
- game environment snapshots in `client/public/snapshots/` (baked by qed64's
  `bake-snapshot.mjs` against the SAME stage1 — snapshots are binary-paired
  to the exact runtime; never mix builds),
- the fork's native `stage0/bin/{lean,lake}` (via Docker) to compile
  GameServer and game packages (`wasm/scripts/compile-pkg.py`).

Current pin: kernel commit `852d1b9c3a` (series HEAD 2d75ec1 + build layer),
runtime `wasm64-303e5c765fc415ed`. The qed64 repo's
`pipeline/toolchain/KERNEL-PIN` is the machine-readable pin, including the
paired snapshot identities.

## The qed64 dependency

The browser-side substrate — boot/artifacts (`qed64-boot.ts`), the session
adapter with its boot policy (`resident-session.ts`), the L3 relay
(`lsp-relay.ts`: crash recovery, replay, the crash-loop breaker), the
runtime client, snapshot loader and install profiles, and the four worker
scripts (`lean.worker.js` plus the `lsp-frames.js` decoder and the
`lsp-front-door.js` it `importScripts`, and the prefetch worker) — and the
pipeline scripts the from-source lane runs are the **`qed64` npm package**,
a git dependency of the client pinned to one commit by its full SHA:

```
client/package.json   "qed64": "github:FawadHa1der/QED64#<40-hex commit>"
```

`package-lock.json` records the same commit (`node_modules/qed64` →
`resolved: git+ssh://…#<sha>`). A git dependency has no integrity hash npm
checks, so **the SHA is the only pin** — always the full 40 hex: a short
one makes npm run `git ls-remote`, which needs git. `npm ci` fetches the
commit as GitHub's codeload tarball over https (no git, no SSH: verified
2026-10-04 with no git on `PATH` and an empty npm cache) and installs only
the package's `files` allowlist — 41 files, ~460 kB: `embedding/closure.json`,
the TypeScript closure of `qed64/embed`, the four workers, the pipeline
scripts and the data files they read, `docs/EMBEDDING.md`, LICENSE, README.
QED64's `package.json` has no script npm treats as "prepare me", so an
install builds nothing and installs none of QED64's devDependencies. **No
build, bake or test reads a qed64 checkout**: a clean clone builds with
`npm ci`, `scripts/stage-workers.sh` and the client build (see "Rebuilding
from a clone").

The contract is the package's `docs/EMBEDDING.md` (§6 the package, §7 the
library API, §10 lean4game's migration list) and `embedding/closure.json`
(schema `qed64.closure/v1`). What each part of the game reads:

- **code** imports only `qed64/embed`, the package's one library entry (its
  exports map; the files behind it may move). Vite resolves the exports map
  and transpiles the TypeScript; `client/tsconfig.json` names the entry in
  `paths` because its `moduleResolution: "node"` does not read exports maps
  (`"bundler"` would, but adds errors elsewhere); the Node unit tests load it
  through `client/src/wasm/ts-resolve-hook.mjs`, which transpiles the
  package's TypeScript (Node refuses to strip types under `node_modules`).
- **workers**: `scripts/stage-workers.sh` copies each `closure.json`
  `workers[]` entry's `path` to its `serveAs` under `client/public`, removes
  any other file there (a worker a bump dropped), and `deploy-app.sh` checks
  the deploy tree against the same list, so the bundled relay and the served
  worker come from one commit by construction. Before it stages, it refuses
  an install that is not the lockfile's pin (`node_modules` is not in git: a
  pulled bump over an older install would build and deploy the old package)
  and a `client/tsconfig.json` `paths` entry that is not the package's entry
  file.
- **pipeline**: `wasm/build-from-source.sh` copies the closure's `pipeline`
  and `pipelineData` files into `wasm/out/pipeline` and runs them there
  (below) — never inside `node_modules`.
- **kernel floor**: `closure.json` `runtime.minKernelPatch` is the oldest
  kernel patch level the workers drive. The game serves its OWN runtime
  (built from `wasm/KERNEL-PIN`, whose `patch` line names its level and the
  kernel commit that completed it), so `stage-workers.sh` — every build and
  deploy — and the from-source preflight refuse a qed64 whose workers need a
  newer kernel than ours; the preflight also refuses a pin whose history
  lacks that commit (a pin moved back past its patch number).

Current pin: qed64 `90aef68` (2026-10-04, branch `feature/embedding-api`,
EMBEDDING contract v1, `EMBED_API_REVISION` `1.0.0-pre.2`; the package's
LICENSE is MIT — its confirmation is pending on the QED64 side). The first
pin as a package (before it: a vendored copy, below). The runtime and the
snapshots did NOT change: the game still serves `wasm64-d77d34b97592d014`
(kernel `992dc94`, patch 0032 — the closure's floor is exactly 0032), and
QED64 tested this commit on its own runtime `wasm64-3ab1c6a9da03bc29`. What
comes with it, and what the game now takes from it instead of its own copies:
- **HARDENING #55 runtime lifetime locks**: the session holds the Web Lock
  `qed64-wanted:<id>` while it wants its runtime and every Worker of that
  runtime holds `qed64-alive:<id>`; a booting runtime waits (at most 6 s)
  while runtimes alive but no longer wanted keep more than 12 Workers alive
  — the renderer-OOM on reload with a runtime caught mid-boot.
- **HARDENING #57 same-origin refusals** in the snapshot-index loader, the
  profile loaders, the prefetch and Lean workers (`SNAPSHOT_URL_REFUSED`),
  redirects included, and the boot-parameter rule (`validateBootOverrides`).
  `boot-params.ts` judges `?snapshots=`/`?profiles=`/`?runtime=` with that
  rule and keeps what the page adds: an empty or doubled value is refused
  too, each refusal is named on the card and the landing notice, and
  "Open without the override" is the way out. `games-api.ts` maps the
  index loader's refusal to SEC1's coded one (`refusedSnapshotIndex`;
  the package's `fetchSnapshotIndex` answers it with the `null` of a
  missing index) and still refuses a runtime manifest naming a foreign
  chunk, which the package's resolver does not look at.
- the raw region cache (`prefetchRaw`, `isRawCached`, `removeRawRegion`,
  `isCacheKeyOf`, `SNAPSHOT_CACHE_DIR`): single-flight per page and the Web
  Lock `qed64-raw:<cacheKey>` across tabs. The boot's session and a
  landing-page Prepare share one prefetch worker (the boot no longer waits
  for a Prepare, and a Prepare is no longer refused for the bound game's
  region); the stale-region sweep removes every file no served entry names.
- `installArtifacts(ui, {overrides, profiles: "none", runtime, snapshots})`
  and the exported resolvers (`resolveRuntimeManifest`,
  `fetchSnapshotIndexFor`) behind the game's per-page memo; `runtimeUrls`
  for the offline warm-up's chunk list (which no longer names the
  manifests or indexes: the shell precache owns them) and `WORKER_URLS`
  for the worker-script preflight.
- `ResidentHost.files`: the gamedata JSON, written by the session on every
  boot before the relay arms the loop (the game's `GameSession` subclass is
  gone); `LspRelay.rearm()` for a halted relay (no synthetic didChange);
  `error.data.qed64.kind` for the errors the relay invents.
- structured progress (`stage`/`subject`/`step`/`error`; the banner's
  words, `client/src/wasm/boot-labels.ts`) and the relay's `Death`
  (`cause` — null: no evidence —, `exitCode`, `seq`; `death-kind.ts`,
  where the label text and the boot's reported snapshot failure used to be
  read).
- a worker-set revision (`WORKER_DEP_MISMATCH` for mixed siblings), a
  recoverable `UNSUPPORTED_REQUEST`, `capabilities().requests`; the
  initial memory commit clamped to the largest reservation rung.

Pin `76be299` (2026-10-03, the last vendored pin): `3e182ff` (below) plus the two
**HARDENING #54 follow-ups**, again with no runtime change. `lean.worker.js`
(`fetchChunk`) streams each 16 MiB runtime chunk and reports every 500 ms
inside it. Before, at 300 kB/s the boot banner's runtime count stood still
for ~56 s per chunk (live run of 22eda45, D5). Length, SHA-256 and the
force-cache → reload retry are unchanged; after a failed first attempt the
count can step back once. `src/install/profiles.ts` (`inflateTransport`)
does the same for the core pack's parts, which game sessions skip.

Pin `3e182ff` (2026-10-03): `3b42714` (below) plus
**HARDENING #54**, which touches two closure files and no runtime. The
prefetch worker (`snapshot-prefetch.worker.js`) reports raw-region progress
every 500 ms while bytes arrive, where it used to report once per 64 MiB of
inflated output. The boot (`qed64-boot.ts` `ensureRawSnapshotCached`) gives
up on the worker after `PREFETCH_SILENCE_MS` (3 min) without a message,
re-armed by each message, where it used to give up a fixed 15 min after the
start. That deadline cut the largest game regions (~280 MB gzip) short below
~2.5 Mbit/s, and the Lean worker then downloaded them again from zero. The
game's own Prepare (then `client/src/wasm/game-cache.ts`
`prefetchRawSnapshot`, qed64's `prefetchRaw` since `90aef68`) uses the same
3-minute silence rule.

Pin `3b42714` (2026-10-02): the resident transport plus the
**HARDENING #52 worker layers** (bumped from `32e5e62`, below). The runtime
and the snapshots did NOT change with this bump: the game still serves
`wasm64-d77d34b97592d014` (kernel `992dc94`, series through 0032) and the
snapshots baked for it. qed64's own commit `3b42714` also promotes a new
runtime for qed64's site (kernel 0035b, `wasm64-3ab1c6a9da03bc29`); none of
that reaches the game — the closure takes no runtime, manifest or snapshot.

What #52 adds (all inside `lean.worker.js`; `lsp-relay.ts`,
`client.ts` carry the new fields):
- **message-mode runtime mailbox** — at preRun the worker sets the glue's
  `waitAsyncPolyfilled` and wraps `checkMailbox`, so pthreads notify the
  runtime thread by `postMessage`, never `Atomics.waitAsync` (a lost
  waitAsync resolution also left no waiter armed: every later wakeup was
  lost too); proxied calls are counted through the glue's
  `proxiedFunctionTable`;
- **1 s mailbox kick** — every tick while the loop is open the worker
  serves the runtime thread's mailbox (`_emscripten_check_mailbox`), which
  heals a lost wakeup; a mailbox word still PENDING 250 ms later with no
  delivery is counted as a rescue (`status().liveness.rescues`);
- **Lean-side liveness** — while work is owed (elaborating, the document
  open and not yet answered, a forwarded request unanswered) and no server
  frame has arrived for 6 s, the worker writes a `$/qed64/liveness` request
  the FileWorker answers whatever it elaborates; no frame for 12 s after it
  is a stall, still nothing 4 s later the session dies with reason
  **"wedged"** and the relay reboots and replays (its reboot reason is
  `"wedged"`, `RelayStatus.rebootReason`); an idle session is never probed;
- **proxied-exit hook** — a FileWorker exit (proxied `_proc_exit` /
  `exitOnMainThread`, which the glue would swallow under the keepalive) is
  reported as reason **"exit"**, message `lean --worker exited with code N`;
- `WorkerStatus` gains `liveness {probes, answered, stalls, resumed,
  rescues}` and `pool.parked` (-1 on our runtime: it has no
  `lean_wasm_task_manager_parked_threads` export).

The glue facts the layers rely on were checked on our runtime's `lean.js`
(sha256 `451d063d…`, emsdk 6.0.5): `proxiedFunctionTable=[_proc_exit,
exitOnMainThread, …]`, `waitAsyncPolyfilled`, `checkMailbox`, the
`__emscripten_check_mailbox` export and `waitingAsync=pthread_ptr+204` are
all present; the browser drills confirm the worker boots in message mode
with the exit hook and the mailbox word located (wasm/UX-PARITY.md,
"Freeze fix (HARDENING #52) 2026-10-02"). The game side
(`client/src/wasm/death-kind.ts`, `game-boot.ts`): "wedged" and "exit" are
runtime verdicts — never held for the network and never probed as a link
problem; a "wedged" reboot shows "the checker stalled and is restarting —
your proof is kept" for the whole reboot; an "exit" is a crash: the replay
dies again, the breaker halts, and the card names the exit code.

**Runtime rule for a future pairing bump.** The qed64 0035 kernel family
adds dedicated-thread parking; 0035 itself broke qed64's page reloads
(HARDENING #53: a reload kept the old page's parked pthreads alive beside
the new runtime → renderer OOM), and 0035b ships parking OFF by default. A
0035-family runtime served by the game must NOT set
`LEAN_WASM_PARKED_DEDICATED` unless our own reload storm
(`qed64/work/lv-ff-reload-storm.mjs`: a ready NNG4 page reloaded 5× while
its runtime is live, plus relay restarts, 5 fresh-browser runs) shows 0
renderer crashes on that runtime.

Previous pin: qed64 `32e5e62` (2026-09-07), the **resident transport**.
qed64 removed its pump transport that day (the `WatchdogShim` the game had
built on; their `docs/PUMP-REMOVAL-ASSESSMENT-2026-09-04.md`): the worker
now owns the document, the queue and every header verdict, a level switch
is a full-text document change the kernel's resolver serves from the game
snapshot in-process (qed64 measured 323 ms for a header switch against
2,571 ms for the pump's in-place session replacement), and the relay only
remembers what re-establishes the document on a fresh session, fails the
requests a death orphaned, and breaks crash loops (three deaths in two
minutes → halted). What the game wires (`client/src/wasm/game-boot.ts`):
`GameSession extends ResidentSession` (writes the gamedata JSON into the
worker FS inside `start()`, so it is there on every boot and reboot before
the relay arms the loop; since `90aef68` the session's own `files`), a policy of `[<game snapshot>]` (the init region left the game session on 2026-09-08: no level header can be served by it) with a
2 GiB initial commit under a 3 GiB cap, `translation.attachServer(relay.clientPort)`,
`pagehide → relay.unload()` (dispose + the synchronous kill), and the
relay's status as the only source of ready / elaborating / halted for the
page. The translation layer wraps every full-text `didChange` like the
`didOpen` (the front door syncs whole documents).

This pin needs the **0032 kernel** (`wasm/KERNEL-PIN` → `992dc94`: the
resident ring exports and the in-kernel header resolver; the worker
refuses to open its loop on an older runtime) and game snapshots baked
against it — the from-source lane below does all of it. Two lane changes
came with the pin: kernels from 0032 on generate `src/emscripten-exports.txt`
at build time (gitignored; `gen-exports.py` between the stage-1 libraries
and the final link, which the kernel's own `wasm64-build/build.sh` does not
run — the lane lets it fail its link, generates, and finishes the link),
and the gate is advisory on such pins (under the proxied main the process
never exits in Node, so the smoke times out on a good build; the bake
lane's `--verify-snapshots` probe, a real elaboration on every baked
snapshot, is the acceptance test).

It used to be a live `file:` link into the qed64 checkout: every build
compiled whatever that checkout held at that second, uncommitted edits
included (a half-typed import broke the game build on 2026-09-02, and shim
behaviour changed under a running test day), and the worker copy could
silently drift from the shim. From 2026-09-02 to 2026-10-04 it was a
vendored copy (`client/src/wasm/vendor/qed64`, `wasm/vendor/qed64-pipeline`,
pinned in `client/src/wasm/vendor/QED64-PIN` by `scripts/sync-qed64.sh`) —
pinned, but a second copy of QED64's files in this repository; the package
replaced it with no copy at all.

Bump (one commit for `client/package.json` + `package-lock.json`):

1. Pick the commit (below), and read its `docs/EMBEDDING.md` §12 and
   `embedding/closure.json`: `runtime.minKernelPatch` against the `patch`
   line of `wasm/KERNEL-PIN`, and `workerProtocol.deprecated` (a request
   listed there leaves the worker one release later — move off it first).
2. Edit the SHA in `client/package.json` (full 40 hex), then `npm install`
   at the repo root: it rewrites `package-lock.json` and `node_modules/qed64`.
   Check that the package holds only its `files` list and that npm ran no
   QED64 script.
3. `scripts/stage-workers.sh` and `npm --workspace client run build`. The
   script refuses, before it stages anything: an install that is not the
   lockfile's pin (npm's record in `node_modules/.package-lock.json`: a
   pulled bump over an older install would otherwise build and deploy the
   old package — run `npm ci`), a `client/tsconfig.json` `paths` entry for
   `qed64/embed` that is not the package's `closure.json` `entry` (tsc
   reads that file; Vite reads the exports map — if the entry moved, update
   the `paths` entry), and a kernel floor above ours. It also removes a
   staged worker the closure no longer names.
4. The unit tests — `for t in client/src/wasm/*.test.ts
   client/src/components/infoview/*.test.ts; do node --import
   ./client/src/wasm/ts-resolve-hook.mjs "$t"; done` and `node --test
   infra/worker.test.mjs` (`worker-liveness.test.ts` runs the new
   `lean.worker.js`; `death-kind.test.ts` runs the new worker scripts'
   deaths through the real relay) — then the browser smoke (a Mathlib game
   and NNG4) and cypress.

A bump whose workers need a newer kernel (a higher `minKernelPatch`) is a
pairing bump: kernel pin + from-source lane + release, never the dependency
alone.

Bump only to a qed64 commit its owners have announced as having passed
their test pyramid (`32e5e62` was: e2e 23/23, 323 ms switch, gauntlets
clean; `3b42714` was: e2e 23/23, liveness drills 6/6, battery 54/54, reload
storm 0/5 on its new runtime; the #52 worker layers verified by qed64 on
0034 (`wasm64-4b025db7729c5f89`) and 0035b; on our 0032 runtime
(`wasm64-d77d34b97592d014`) the glue facts were checked statically and the
game drills (UX-PARITY "Freeze fix") passed). Keep `relay.unload()` on `pagehide` working across bumps (qed64's
own page relies on the same hook).

## Snapshot rebake 2026-09-02 (GameServer `Runner` hoist, runtime unchanged)

`server/GameServer/Runner.lean` now loads the level's JSON once per
elaboration instead of once per syntax node (`findForbiddenTactics` took
`loadLevelData` — ~46 ms of JSON parsing under wasm64 — on every node, so a
proof's check cost ≈ 0.3 s + 46 ms × nodes: 8 s for an 8-step proof).
Measured on the headless probe: 8-step proof 8.1 s → 0.73 s; flat in proof
length. Only `GameServer/Runner.olean` changed (21 other modules rebuilt
byte-identical); no game package references it, so no game olean moved.

Rebake lane (no stage1 involvement — qed64's `work/build/stage1` currently
holds the unpaired 0031 experiment): reassemble the pinned runtime from
`client/public/runtime/chunks` (sha256-verified, `wasm64-303e5c765fc415ed`)
into an artifact dir with `bin/lean.{js,wasm}`, then
`bake-snapshot.mjs --artifact <that dir> --lib work/lib-tree-{nng4,testgame}`
with the usual probe (`import Game`, `import GameServer.Runner`, `#check`).
Stage with `scripts/stage-snapshots.py <staging dir> nng4 testgame` (copies
the digest-named `.snapz`, merges `index.json`, removes the superseded
files), then rebuild the client.

| snapshot | digest | transfer | raw |
| --- | --- | --- | --- |
| nng4 | `sha256:79468e1d630aaa72…` | 428,342,216 | 1,466,401,477 |
| testgame | `sha256:e0ca4af0c94f38f1…` | 413,600,695 | 1,412,288,317 |
| init | unchanged `sha256:c70b5081d84df6d3…` | 107,410,668 | 342,124,389 |

## Served bundle since 2026-09-07: the resident pairing (kernel 0032)

Built by `wasm/build-from-source.sh --verify-snapshots` from kernel pin
`992dc94` (patch series through 0032) with the qed64 `32e5e62` pipeline
(then vendored), for the resident-transport port of the closure (see the pin
section above). Bundle tag `artifacts-wasm64-d77d34b97592d014`
(`wasm/artifacts/BUNDLE.json`; tarballs in
`wasm/out/artifacts/artifacts-wasm64-d77d34b97592d014/`, uploaded by the
operator as the GitHub release of that name and into R2 with
`scripts/upload-artifacts.sh`).

| artifact | digest / build id | transfer bytes | raw bytes |
| --- | --- | --- | --- |
| runtime | `wasm64-d77d34b97592d014` (source `qed64-wasm64@992dc94b2`) | 153,673,728 (tar) | — |
| init (retired 2026-09-11: no game session loads it; dropped from the served index, the object stays in R2) | `sha256:da2ed4de9dabfb73…` | 107,410,385 | 342,124,389 |
| nng4 | `sha256:3613d20f2f3545d1…` | 428,354,712 | 1,466,403,813 |
| testgame | `sha256:aee31c25b23c454c…` | 413,599,933 | 1,412,288,317 |
| stg4 (added 2026-09-08, slim) | `sha256:5dbab231c29a9c13…` | 180,977,642 | 665,285,845 |
| core profile pack | unchanged (Init facets 3145/3145 identical to the served pack) | 120,705,024 (tar) | — |

The build id differs from qed64's own build of the same pin
(`wasm64-5dcdda005a7c5ae0`): the served qed64 binary embeds the githash of
its work tree, the submodule build embeds none — a provenance detail, not
a behaviour difference (`lean.wasm` sha is the pairing key either way).
Run notes: the kernel's own `wasm64-build/build.sh` fails its final link on
this pin (the exports list is generated; the lane regenerates it from this
build's compiled C on every run and finishes the link); the gate is
skipped (advisory on 0032+: the proxied main never exits in Node) and the
bake lane's `snapshot-probe` on the nng4 and testgame snapshots is the
acceptance test (`SNAPSHOT PROBE PASS`). Wall-clock with a warm ccache:
runtime ~12 min, core/trees/games ~8 min, bakes ~10 min, bundle ~2 min.

**stg4 (2026-09-08, same runtime).** The first catalog-driven game:
`--lanes preflight,compat,games,bake,bundle --games stg4 --verify-snapshots`
(19 min wall: compat 1 min, compile 3 min, bake ~10 min, probe 1 s, bundle
+ client build 4 min). The game compiles UNPATCHED from djvelleman/STG4
`b7296fcb` because the compat lane provides `Mathlib.Tactic.Have`/`Cases`
(pack-excluded leaves, `wasm/compat/`) inside the game base tree, and its
per-game tree is SLIM (`*.olean.private` dropped from the base overlay):
665 MB raw / 181 MB on the wire against nng4's fat 1,466 MB / 428 MB with a
larger Mathlib closure — the ~55 % saving qed64 measured for its umbrella
(docs/SERVER-SLIM-REBAKE.md). The served nng4/testgame stay fat until
the next full run (a full run is a full slim rebake; `SLIM_TREES=0` is the
fat escape hatch). `expectedRaw` for stg4 is keyed
`wasm64-d77d34b97592d014+slim` in `wasm/catalog.json`.

**Ten-game bundle (2026-09-11, same runtime).** Every catalog game is baked
slim from its own overlay (`--games …`, sequential bakes); init retired.
Served index (`client/public/snapshots/index.json`):

| snapshot | digest | transfer bytes | raw bytes |
| --- | --- | --- | --- |
| stg4 (djvelleman/STG4, slim) | `sha256:5dbab231c29a9c13…` | 180,977,642 | 665,285,845 |
| testgame (test/TestGame, slim) | `sha256:d5c4280126015f3a…` | 148,560,924 | 546,755,869 |
| nng4 (hhu-adam/NNG4, slim) | `sha256:db264c5f3eb7c69c…` | 154,373,030 | 569,269,949 |
| reintro (emilyriehl/ReintroductionToProofs, slim) | `sha256:eccae8a265ecef22…` | 152,685,936 | 562,887,317 |
| knights (JadAbouHawili/KnightsAndKnaves-Lean4Game, slim) | `sha256:0894a607d8c019d1…` | 199,226,176 | 728,516,269 |
| ntg (k88-b/NumberTheoryGame, slim) | `sha256:dfa69f626e1cf8e8…` | 231,509,452 | 835,759,917 |
| rag (AlexKontorovich/RealAnalysisGame, slim) | `sha256:a7a0c2f7f57b3ce2…` | 281,959,968 | 1,004,806,229 |
| robo (hhu-adam/Robo, slim) | `sha256:5e905b3459712762…` | 281,145,882 | 1,002,146,453 |
| logic (Trequetrum/lean4game-logic, slim) | `sha256:72eeb282456209b3…` | 231,335,507 | 835,310,405 |
| lag (ZRTMRH/LinearAlgebraGame, slim) | `sha256:f84d616679d0ceb0…` | 280,060,218 | 998,558,821 |
| **total** | | **2,141,834,735** | **7,749,297,074** |

Compat modules compiled into the game base tree by the `compat` lane
(`wasm/compat/`): Mathlib.Tactic (umbrella of the pack's 244 tactic
leaves), .Have, .Cases (full de3a9cf), .Generalize, Algebra.Order.Ring.Star,
Data.Int.Star, Data.Rat.Star. Bundle tarballs repacked
(`snapshots.tar` 2,141,870,080 B, 11 files); the release and R2 uploads are the
operator's. Lane economics on this Mac: compiles 3–30 min per game (Robo
189 modules ≈ 30 min uncontended; the 7.6 GiB Docker VM OOM-kills `lean`
silently when several compiles share it — the games lane is sequential by
design, port agents must not run in parallel), bakes 8–15 min each, probes
≈ 1.3 s of elaboration.

## Served bundle since 2026-09-03: built from source

The repo now serves the artifacts produced by `wasm/build-from-source.sh`
from the pinned kernel (`852d1b9`) and pipeline (`8e708dc`) submodules, bundle
tag **`artifacts-from-source-2026-09-03`** (`wasm/artifacts/BUNDLE.json`):

| artifact | digest / build id | transfer bytes | raw bytes |
| --- | --- | --- | --- |
| runtime | `wasm64-0becc706d2ef1964` (source `qed64-wasm64@852d1b9c3`) | 154,176,512 (tar) | — |
| init | `sha256:b07859007e814af2…` | 107,410,678 | 342,124,389 |
| nng4 | `sha256:96d03497e700a738…` | 428,355,085 | 1,466,403,813 |
| testgame | `sha256:98e8ba5e91fcdc73…` | 413,600,402 | 1,412,288,317 |

| tarball | bytes | sha256 |
| --- | --- | --- |
| runtime.tar | 154,176,512 | `813f05681d760a69…` |
| profiles.tar | 120,705,024 | `c0ea28cba4acd3ae…` |
| snapshots.tar | 949,379,584 | `84f2e6a67ccd9000…` |

The core library pack was repacked from this build's stage1 (facets
byte-identical to the previous pack); the profile index now lists only the
`core` profile. The previous bundle (`artifacts-2026-09-02`, runtime
`wasm64-303e5c765fc415ed`) remains valid for the commit that referenced it.

## Rebuilding from a clone

What a clone contains: the client and server sources, the qed64 pin
(`client/package.json` + `package-lock.json`; `npm ci` fetches the package —
no QED64 checkout, no git or SSH for it), the compiled gamedata for NNG4 and
TestGame (`client/public/data`, tracked), the digest manifests of every
served artifact, and the NNG4 port as a patch (`wasm/patches`). What it does
not contain: the ~1.2 GB of served binaries — the Lean runtime chunks, the
core library pack and the environment snapshots — which are published as the
artifact bundle named in `wasm/artifacts/BUNDLE.json`.

```bash
git clone -b wasm64-port https://github.com/FawadHa1der/lean4game
cd lean4game && npm ci
scripts/fetch-artifacts.sh            # downloads + sha256-verifies the bundle into client/public
scripts/stage-game-assets.sh          # worker scripts from the qed64 package (+ i18n/api staging)
npm --workspace client run build
node scripts/serve-dist.mjs           # http://localhost:3006 with the COOP/COEP headers the worker needs
```

The shell alone — what CI builds and deploys, the artifacts living in R2 —
is `npm ci`, `scripts/stage-workers.sh`, `npm --workspace client run build`:
nothing outside this repository and its lockfile.

`fetch-artifacts.sh --from-dir <dir>` takes local tarballs instead (what
`scripts/pack-artifacts.sh <tag>` produces under `wasm/out/artifacts/<tag>`);
`--base <url>` takes any HTTP host serving `<url>/<class>.tar`. The script
refuses a tarball whose digest differs from `BUNDLE.json` and cross-checks
the extracted runtime chunks against `runtime/runtime-manifest.json`.

Publishing a new bundle (after a rebake or a runtime pin change):
`scripts/pack-artifacts.sh <tag>` → upload the tarballs + `SHA256SUMS` as a
GitHub release with that tag (the script prints the `gh release create`
line) → commit the updated `BUNDLE.json` and manifests.

## Building the artifacts from source (optional submodules)

One submodule pins the kernel source; it is marked `update = none`, so a
plain `git clone` / `git submodule update --init` leaves it empty and
running the game from the bundle never needs it:

| path | repo | pinned at | what it is |
| --- | --- | --- | --- |
| `wasm/kernel` | FawadHa1der/lean4, branch `qed64-wasm64` | `852d1b9` (= `wasm/KERNEL-PIN`, the game's own pin) | the patched Lean fork + `wasm64-build/` (Docker toolchain, build.sh, gate) |

The pipeline scripts come with the qed64 package (above), so the former
`wasm/qed64` submodule is gone. Check the kernel out explicitly when building from
source (~700 MB):

```bash
git submodule update --init --checkout wasm/kernel
```

Then `wasm/build-from-source.sh` drives the lanes end to end; `--plan`
prints every step with its cwd and environment without running anything
(no Docker needed), `--lanes` selects a subset, and `--games a,b` (catalog
snapshot names) restricts the games, bake and bundle lanes to those games —
`--lanes games,bake,bundle --games stg4 --verify-snapshots` adds or rebakes
one game while the other games' staged snapshots are kept. Which games exist
is `wasm/catalog.json`, read only through `scripts/games-manifest.mjs`; the
script names no game. A run **without** `--games` is a full run: the
snapshot staging dir is wiped and every game is rebaked slim (the
runtime-bump path).

| lane | does | needs |
| --- | --- | --- |
| preflight | pins, clean tree, `games-manifest.mjs --check`, Docker memory, Node ≥ 24, disk, inputs | — |
| runtime | kernel `wasm64-build/build.sh` in Docker → gate → chunk into a staging dir; build id = `wasm64-` + sha256(lean.wasm)[:16] | Docker ≥ 10 GiB, 1.5–3 h cold |
| core | Lean core library pack from stage1's `Init` facets (`pack.mjs`), or `--reuse-core-pack` | — |
| trees | unpack the core pack and the **Mathlib pack** into an olean tree; compile lean-i18n (`vendor/i18n`) and `server/GameServer` with the native stage0; overlay Lake; then runs `compat` | the Mathlib pack (below) |
| compat | compile `wasm/compat` (`Mathlib.Tactic.Have`, `Mathlib.Tactic.Cases` — leaves the essential pack excludes) against the fat tree into the game base tree; refuses if the pack itself provides them (`wasm/compat/README.md`) | — |
| games | per selected catalog row: clone `source.url` @ `rev` + `git am` the patch when `src` is absent; compile with the row's `leanOptions` (`-D` flags) → gamedata; restore the regenerated `.i18n/*/*.pot` templates (only those — translations beside them are left alone); overlay a per-game tree — **slim** by default (`SLIM_TREES=1` drops the pack's `*.olean.private` facets; `SLIM_TREES=0` = fat) | — |
| bake | `bake-snapshot.mjs` per selected game (reserve = the row's `reserveBytes`; no init snapshot — a game session loads its own region only); raw size checked against the row's `expectedRaw` when its `runtime` equals this run's pairing key — the build id, plus `+slim` when the per-game trees are slim (`SLIM_TREES=1`; a slim bake is ~60 % smaller, so a fat record is never asserted against it) — ±5 % stops the run, otherwise the value to paste is printed; raw > reserve only warns; superseded `.snapz` pruned; `--verify-snapshots` runs each game's catalog probe (`games-manifest.mjs --probe`) through `snapshot-probe.mjs --via-mem` | ~40 GB scratch |
| bundle | stage into `client/public` (`stage-game-assets.sh`, `stage-snapshots.py` for the selected names), client build, `pack-artifacts.sh` | — |

The pipeline scripts run from a copy made at `wasm/out/pipeline` on every
run: exactly the `pipeline` and `pipelineData` files the installed qed64
package's `closure.json` lists (the trees they name are replaced; `work/` —
the bake workspace holding the raw `.snap` files a re-probe needs — is
kept), because `bake-snapshot.mjs` hardcodes that workspace under its own
root, and the package's root is inside `node_modules` (which `npm ci`
replaces wholesale; the package's relative `--work`/`--out` resolve there
too). The preflight dies "run npm ci" when the package is missing, takes the
qed64 commit from `package-lock.json`, and checks the kernel floor
(`stage-workers.sh --check`). Setting `QED64_DIR` explicitly runs a qed64
checkout in place instead.

Inputs the script does not produce:

- **The Mathlib olean pack** (`mathlib-essential`, 4,192 modules, ~1 GB
  transfer / 3.5 GB raw): manifest plus part files, shipped as the bundle's
  optional `mathlib-pack.tar` — `scripts/fetch-artifacts.sh --mathlib`
  puts it in `wasm/out/mathlib-pack`, the script's default
  `MATHLIB_PACK_DIR`. Compiling Mathlib for this fork natively is hours of
  work and its compatibility patch lives outside any repository, so the
  pack is an input, not rebuilt.
- Docker, and the network for the first `docker build` (base image
  `emscripten/emsdk:6.0.5`, pinned by tag only).

Known limits, on purpose visible in the script's output:

- The Mathlib oleans were compiled against the *served* Lean core. The
  core lane compares stage1's `Init` facets with the tracked core manifest
  and warns when they differ (`--strict` stops); a difference means the
  baked snapshots may not import Mathlib and the pack would need
  regenerating. Measured 2026-09-03 against a kernel build several commits
  newer than the pin: 3,145 facets identical, 0 different — the core
  facets are stable across kernel rebuilds in practice; the check is the
  guard for the day that stops being true.
- Bit-reproducibility of the runtime at the pin has not been demonstrated
  (the served build even records a source revision older than the pin). A
  rebuild is therefore treated as a **new build id**: every snapshot is
  rebaked against it and the whole bundle is republished; nothing is mixed
  with the shipped chunks.
- First full run, 2026-09-03 (Docker 7.65 GiB VM, ccache seeded from an
  earlier kernel build): **24 min end to end** — runtime 11 min, core 1.5,
  trees 1.5, games 5.5, bake 4.7, bundle 0.3. Gate passed; build id
  `wasm64-0becc706d2ef1964` (the served `303e5c…` was not reproduced
  bit-for-bit, as expected); Lean core facets identical to the shipped pack
  (3,145/3,145); init and testgame snapshots at exactly the served raw
  sizes, nng4 within 2.3 KB; the Runner probe elaborated a level through
  the fresh nng4 snapshot; the resulting client booted in a browser
  (ready in 31 s cold, `rfl` completes level 1 in 0.8 s) and passed cypress
  24/24. A run at a lower Docker memory than the documented 10 GiB worked
  on this machine; keep the requirement as the safe figure. Bumping the kernel pin (`wasm/KERNEL-PIN` + the submodule commit) implies a full rebake (snapshots pair to the runtime build id); bumping the qed64 pin is the SHA in `client/package.json` + `npm install` (closure, workers and pipeline together; "The qed64 dependency").

Rebuilding the binaries themselves (rather than fetching them) needs the
shared pipeline: the kernel repo's `wasm64-build/build.sh` (Docker,
1.5–3 h cold, ≥10 GB VM memory) for the runtime; qed64's `pack.mjs` for the
core pack; `compile-pkg.py` + `bake-snapshot.mjs` over the olean trees for
the snapshots (the rebake section above). Note the snapshots are paired to
the exact runtime build they were baked against: a rebuilt runtime is a
different `buildId` and needs a rebake.
