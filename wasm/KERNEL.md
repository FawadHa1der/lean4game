# Toolchain dependency

The wasm64 Lean toolchain this game runs on is built and published by the
kernel fork, **github.com/FawadHa1der/lean4, branch `qed64-wasm64`**, as a
versioned **release** (the fork's `wasm64-build/RELEASE.md`; formats in
`wasm64-build/js/formats/`). This repository builds no compiler and no
runtime; it pins one release and consumes it:

- the **runtime** (`lean.js` + `lean.wasm`, served as 16 MiB chunks with the
  release's runtime manifest from `client/public/runtime/`; the bake and the
  probes run the same binary under Node as `--artifact`),
- the **library packs**: `lean-core` (served from `client/public/profiles/`)
  and, for building, `mathlib-essential` and `mathlib-game-extra` (the
  game-only Mathlib leaves: the `Mathlib.Tactic` umbrella, `Tactic.Have`,
  `Tactic.Cases`, `Tactic.Generalize`, the `*.Star` instances,
  `NormNum.Prime`, `Log.Base`, …),
- the **native compiler** (`native64.tar.gz`, linux/aarch64, run in the
  lane's own small image, `wasm/docker/Dockerfile`) that compiles
  lean-i18n, GameServer and every game — the
  compiler that wrote the packs' Mathlib oleans,
- the **module lists** of the packs (a port checks a game's imports against
  them, `wasm/PORTING.md` §1).

Game environment snapshots (`client/public/snapshots/`) are the game's own:
baked with QED64's `bake-snapshot.mjs` against the release's runtime —
binary-paired to that exact build (`snapshots/index.json` `runtime`), never
mixed with another.

### The pin

| what | where |
| --- | --- |
| the release's tools (npm package `lean4-wasm64`: fetch, verify, unpack, id, the identity rules) | root `package.json` devDependency — the release's own tgz URL; `package-lock.json` holds its sha512 integrity |
| the release record (id, self-digest, runtime build id, kernel commit and patch id, packs, native compiler, module lists) | `wasm/lean4-wasm64-release.json`: a byte copy of the release's `release.json`; its id and `digest` are what every fetch is pinned to |

Current pin: release **`lean-v4.34.0-41ec565`** (digest
`sha256:f958ba7508317a4ceed42e1a13cbd78b716209e2e2a86fe1a7f6a93a607888ee`):
Lean 4.34.0 (upstream `v4.34.0`), kernel `41ec56530d`, patch `0036`,
runtime **`wasm64-57ae00dc5f6ce958`** — Mathlib `v4.34.0` (`5ed2965256`),
native compiler `857544b439`, tools `lean4-wasm64@4.34.0-41ec565`
(integrity
`sha512-/j63PQR6Komk8kDLP7ezP7bv+8URgmttbrC8h3Np9kNWJ6eU1K2v+bdnGaCYOaXoE4IxlebAC7SCzzCoTz5gDA==`).
Patch 0036 turns deep recursion into Lean's own error ("maximum recursion
depth has been reached: the WebAssembly runtime's stack is exhausted", or
"(kernel) the WebAssembly engine's stack is exhausted") where 0035b killed
the thread, and with it the checker (`by decide` over `Fin 40 × Fin 40` in
NNG4's editor mode). It is a runtime-only release: its packs, native
compiler and module lists are byte-identical to those of
`lean-v4.34.0-a8817d0` (patch `0035b`, runtime `wasm64-3ab1c6a9da03bc29`, the
first 4.34 pin), so the compiled trees carried over and only the bakes were
redone. Dedicated-thread parking is off by default in this runtime; the
game never sets `LEAN_WASM_PARKED_DEDICATED` (the rule at the end of "The
qed64 dependency").

The release is published (GitHub release `lean-v4.34.0-41ec565`); the
devDependency is its tgz,
`https://github.com/FawadHa1der/lean4/releases/download/lean-v4.34.0-41ec565/lean4-wasm64-4.34.0-41ec565.tgz`,
so the release lane's default `RELEASE_FROM` (that tgz's release directory)
applies. The bakes below fetched the same bytes from the staged copy before
it was published (`RELEASE_FROM=<staged release dir>/`; the id and digest
checks are the same for any source).

What the pin is checked against, and where:

- `wasm/build-from-source.sh` preflight: the record is a canonical
  `lean4-wasm64.release/v1` record whose `digest` recomputes, the installed
  `lean4-wasm64` is the version it names and the lockfile's tgz is the
  release's (`tools.tgz`, install == lockfile);
- its `release` lane: the fetched `release.json` is the tracked record byte
  for byte (fetch is run with `--id` and `--digest`), every fetched byte
  matches the record's sha256, the runtime build id recomputed from
  `bin/lean.wasm` is the record's, the release's tools tgz has the
  lockfile's sha512, and the native compiler reports the record's Lean
  version;
- `scripts/stage-workers.sh` (every build and deploy): the record's
  `kernel.patch` meets the qed64 workers' floor (`closure.json`
  `runtime.minKernelPatch`), compared with the tools' `comparePatchIds`
  (`0035b` > `0035` > `0034`);
- preflight and the release lane: the record's Mathlib packs
  (`mathlib-essential`, `mathlib-game-extra`) name `native64.commit` as their
  `lean.compiler` — the compiler that compiles the games against them
  (`lean-core`'s compiler is the runtime line's, by design); the trees lane:
  every Lake facet a pack ships too (`Lake.Util.Casing`) is byte-identical
  to native64's before the merge replaces it;
- the olean trees' provenance stamps (`wasm/scripts/tree-stamp.py`): the
  trees lane stamps the base trees with the packs' `rawSha256` and the
  native64 tarball's sha256, the games lane stamps each per-game tree with
  those plus the game's source pin (catalog `rev` + the patch's sha256,
  after checking an existing `games-src` checkout IS `rev` + patch); the
  games lane refuses stale base trees and the bake lane stale per-game
  trees. The record id and runtime are not in the stamp, so a runtime-only
  release (this one) keeps its trees, while a release whose packs or
  native64 changed cannot be baked on the old trees.

**Bumping the release** (e.g. the kernel-only fix release that carries patch
0036): change the devDependency URL to the new release's tgz, `npm install`
at the root, replace `wasm/lean4-wasm64-release.json` with the new
`release.json` (fetch it with `lean4-wasm64 fetch --id <id> --digest
<digest> --only lists`, which writes and checks it), then run the whole lane
(`wasm/build-from-source.sh --verify-snapshots`, a full slim rebake) and
re-record every catalog row's `expectedRaw`. A runtime bump is always a full
rebake: snapshots pair to the build id. Its bakes stage under
`wasm/out/staging/<new build id>/`, beside the current runtime's (a kernel
fix under test — its `release.json` copied over the record with
`RELEASE_FROM` — never touches the served runtime's staged snapshots).
Whether the compiled trees carry over is the stamps' call (above): the
preflight prints which trees the pinned record still accepts.

**What the release replaced (2026-10-06, branch `lean-v4.34`).** The
`wasm/kernel` submodule (the fork's source at the pin, `update = none`,
~700 MB when checked out) and its `.gitmodules` entry; `wasm/KERNEL-PIN`
(kernel SHA + the hand-kept `patch NNNN <sha>` line, now the record's
`kernel.patch`); `wasm/compat/` (seven Mathlib modules, 805 Lean lines,
compiled into the game base tree because the essential pack excluded them —
all seven are in `mathlib-game-extra`, checked against the release's
`lists/extra-modules.txt`); and the from-source lane's `runtime` (kernel
`build.sh` in Docker, the exports-list link repair, the advisory-gate skip,
`chunk-runtime.mjs`), `core` (the core pack from stage1's `Init` facets)
and `compat` lanes with their kernel, generated-exports and
Docker-memory preflights. The lane no longer copies QED64's pipeline into
`wasm/out/pipeline` either: `bake-snapshot.mjs` takes `--work`/`--out`/
`--lib`/`--artifact` explicitly and runs in place in `node_modules/qed64`.

### The Lean 4.34 port (branch `lean-v4.34`, 2026-10-06)

Adopting the release IS the 4.34 port: the game moves from its own
4.33.0-pre runtime (`wasm64-d77d34b97592d014`, kernel `992dc94`, patch
0032) to the release's `wasm64-3ab1c6a9da03bc29` (Lean 4.34.0, patch 0035b)
— the runtime QED64 serves. lean-i18n (16 modules) and GameServer (22)
compile unchanged with the release's native compiler; the per-game source
edits are `wasm/PORTING.md` §8 and `wasm/patches/README.md`. Every snapshot
is rebaked (4.34 changed the snapshot layout; the build id changed anyway).

Lane proof (`v434-lane-runner.sh` in the QED64 checkout's
`work/lean4game-workflows/`; one browser-lock hold per bake):

| step | result |
| --- | --- |
| release lane (first fetch) | 103 files, 2.3 GB, verified against the pinned record in 427 s; `--only runtime` rebuilt `bin/` and recomputed `wasm64-3ab1c6a9da03bc29`; tools tgz sha512 == lockfile; native compiler `Lean (version 4.34.0, wasm64-unknown-emscripten, Release)` |
| trees lane | 3 packs unpacked fat (4.6 GB) and slim (1.8 GB), 0 listed modules without an olean; lean-i18n 16/16, GameServer 22/22; 202 s with the release lane |
| testgame | compile 6/6 in 25 s; bake 616 s (incl. the reaper's idle wait); raw 553,457,285 B (4.33 slim: 546,755,869, +1.2 %), transfer 149,933,588 B, `sha256:b847b1135ff5639c…`; `SNAPSHOT PROBE PASS` (load 452 ms, compile 871 ms); rebaked later with the final lane: byte-identical (same digest), native probe clean, negative control rejected |
| nng4 | clone + patch + compile 113/113 in 258 s; bake 370 s; raw 574,944,789 B (4.33 slim: 569,269,949, +1.0 %), transfer 155,458,147 B, `sha256:8f6d8ecbaac49e61…`; `SNAPSHOT PROBE PASS` (load 774 ms, compile 1,278 ms), native probe clean, negative control rejected |
| the other eight (games lane only, sequential) | 0 failures: stg4 61 (254 s), knights 75 (250 s), lag 55 (330 s), rag 187 (1,415 s), robo 189 (1,146 s), logic 103 (688 s), reintro 185 (818 s), ntg 66 (1,022 s) modules; per-game slim trees in place for their bakes |

Both index entries carried `runtime: wasm64-3ab1c6a9da03bc29`, `imports` and
`roots` = `[Game, GameServer.Runner]`. The bakes ran without
`QED64_ALLOW_LEGACY_IMPORTS`: the 4.34 runtime admits legacy (non-`module`)
oleans under the wasm target unconditionally (patch 0030 in
`Lean/Environment.lean` `importModulesCore`).

The ten bakes on the current pin (`lean-v4.34.0-41ec565`, runtime
`wasm64-57ae00dc5f6ce958`; 2026-10-06/07, the compiled trees reused, one
browser-lock hold per game; "hold" is that hold: bake, the wasm probe and
the native probe with its negative control). Every entry pairs to
`wasm64-57ae00dc5f6ce958` with `imports` = `roots` =
`[Game, GameServer.Runner]`; every game passed all three probes; the
catalog's `expectedRaw` rows are these raw sizes (key
`wasm64-57ae00dc5f6ce958+slim`).

| game | hold | raw slim (vs 4.33 slim) | transfer | wasm probe load / compile |
| --- | --- | --- | --- | --- |
| testgame | 363 s | 553,457,285 B (+1.2 %) | 149,933,562 B | 417 / 805 ms |
| nng4 | 371 s | 574,944,789 B (+1.0 %) | 155,458,190 B | 746 / 1,279 ms |
| stg4 | 375 s | 669,489,829 B (+0.6 %) | 181,572,714 B | 956 / 1,341 ms |
| stg4, rebaked 2026-10-08 (`push_neg` wrapper, below) | 394 s | 669,599,797 B (+0.6 %) | 181,606,426 B | 1,090 / 1,395 ms |
| reintro | 365 s | 569,043,773 B (+1.1 %) | 153,935,953 B | 689 / 1,124 ms |
| knights | 377 s | 731,165,541 B (+0.4 %) | 199,307,181 B | 975 / 1,246 ms |
| ntg | 409 s | 1,277,174,557 B (+52.8 %) | 364,475,324 B | 1,207 / 1,667 ms |
| logic | 395 s | 1,276,723,429 B (+52.8 %) | 364,270,851 B | 1,230 / 1,296 ms |
| lag | 401 s | 1,279,213,317 B (+28.1 %) | 364,958,176 B | 1,244 / 1,401 ms |
| rag | 391 s | 1,014,571,789 B (+1.0 %) | 283,590,594 B | 1,093 / 1,466 ms |
| robo | 383 s | 1,012,231,501 B (+1.0 %) | 283,000,792 B | 1,099 / 1,846 ms |

STG4 was rebaked on 2026-10-08 after its patch gained RAG's `push_neg`
wrapper (Mathlib `v4.34.0`'s `push_neg` logs a deprecation warning, which
kept every level solved with it from completing; `wasm/PORTING.md` §8
STG4): 62 modules recompiled in the lane's own image, the bake's native
probes now include the catalog's `probe2` and `probe3` (Complement 4, the
`push_neg` level) — all clean; the other nine games' seventeen native probes
(`probe`, `probe2`) were rerun on their unchanged trees the same day, all
clean. The served index's stg4 entry is `sha256:6a37164df3414c9c…`.

NTG, lean4game-logic and LAG grew because `import Mathlib.Tactic` is now
upstream's umbrella (388 imports) instead of the 246-import compat one
(`wasm/PORTING.md` §4 and §8): ~364 MB to download each instead of
231–280 MB. The bundle lane then staged the ten snapshots, the release's
runtime chunks and `lean-core` into `client/public` and built the client
(35 s with the preflight). On that build (`scripts/serve-dist.mjs`), NNG4
Multiplication/1 in editor mode under the relaxed rules (difficulty 1; at
difficulty 2 the Runner cuts the proof before the locked `have`):
`have h : ∀ n : Fin 40, ∀ m : Fin 40, n * m = m * n := by decide` settles in
0.5 s with "maximum recursion depth has been reached: the WebAssembly
runtime's stack is exhausted …" on its line, the level's proof after it
still closes the goal, and the checker stays up (one session, no death, no
reboot). Typing a line above it at 150 ms/char (`rw [add_zero]`; and a
comment, which keeps the proof parseable so 16 of the 38 versions
re-elaborated the `decide`) kept the pthread pool at 24 and the page alive
(before patch 0036, typing over that line grew the pool 26 → 77 workers
and crashed the tab, `wasm/UX-PARITY.md`).

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
- **pipeline**: `wasm/build-from-source.sh` runs `bake-snapshot.mjs` and
  `snapshot-probe.mjs` in place in the installed package with every path
  explicit (`--artifact`, `--lib`, `--work`, `--out` — all under the
  gitignored `wasm/out`), so nothing is ever written under `node_modules`.
- **kernel floor**: `closure.json` `runtime.minKernelPatch` is the oldest
  kernel patch level the workers drive. The game serves the runtime of the
  toolchain release it pins (`wasm/lean4-wasm64-release.json`, whose
  `kernel.patch` is that runtime's patch id), so `stage-workers.sh` — every
  build and deploy — and the from-source preflight refuse a qed64 whose
  workers need a newer kernel than ours (patch ids ordered by the release
  tools' `comparePatchIds`: `0035b` > `0035`).

Current pin: qed64 **`385a1ac`** (`385a1ac5f3bc33cd607c1cc2d03f4d8979ef4684`,
QED64 `main`, committed 2026-10-08, pinned here 2026-10-09;
`EMBED_API_REVISION` `1.0.0-pre.7`, the closure's kernel floor still 0032,
the game's release runtime `wasm64-57ae00dc5f6ce958` patch 0036). What it
brought, and what this side changed for it:

- **A7, the library in `lib/`**: `qed64/embed` is `lib/index.ts` (the old
  `frontend/src/embed/*` paths are one-cycle `export *` shims).
  `client/tsconfig.json`'s `paths` names it, `stage-workers.sh` checks that
  against `closure.json` `entry` (exit 2 otherwise), and the one test that
  imports a library file by path (`game-translation-guard.test.ts`) reads
  `lib/edit-coalescer.ts`.
- **A3c**: the closure gains a fifth worker, `memory64-probe.js`
  (`lean.worker.js` imports it), staged and precached like the rest with no
  script change.
- **runtime/v1 check**: a runtime manifest whose `buildId` is not
  `wasm64-` + its `lean.wasm` sha256[:16] is refused by the page (the unit
  fixtures now carry valid ones). **#65**: a pinned runtime-manifest fetch
  that rejects (a refusing proxy, a dead link while `navigator.onLine` is
  true) is a miss, and the mutable manifest decides.
- **A2b**: a stale page's death is `FailureKind` `stale` (this page keys on
  its `WORKER_DEP_MISMATCH` code, unchanged). **#63 follow-up**: the
  prefetch request carries the index's `transfer` size.
- **#64, the per-build index copies**: `fetchSnapshotIndexOnce`
  (`games-api.ts`) reads the snapshot index with `loadSnapshotIndex(undefined,
  { pairedBuildId })`, the throwing loader, so SEC1's off-site refusal
  stays. `pairedBuildId` is the runtime the page boots: the `?runtime=`
  override when set (it wins over the pin in qed64's resolver, and the
  pairing check compares with the resolved manifest), else the shell's pin
  `__QED64_BUILD_ID__`. A `/snapshots/index.json` naming another runtime is
  replaced by `/snapshots/index.<buildId>.json` when that copy is paired with
  it; `?snapshots=` reads only its own index. The service worker's install
  precaches the pin's two copies beside the pinned runtime manifest
  (`scripts/build-sw.mjs`), so an offline revisit inside a pairing window
  has them. The site already published the copies from its merged index
  (`scripts/stage-snapshots.py`, the preflight, the two-step upload).
- **`qed64/edge`**: `infra/worker.js` is the library's `createWorker`
  (`siteWorker(record)`), with the site's CSP as `decorate` and the
  library's own `isImmutable` (imported) plus vite's hashed bundles
  (wasm/DEPLOY.md lists where it is stricter than the pre-library worker).
- **#66** (the from-source pipeline): `snapshot-probe` sets the runtime's
  environment at `preRun`, where `getenv` reads it.

Pin `bf9d947` (`bf9d94788100235fe9c64f653a11d98a915d2a16`,
2026-10-06, branch `feature/embedding-api`; `EMBED_API_REVISION` still `1.0.0-pre.2`,
the closure's kernel floor still 0032 — the game's release runtime
`wasm64-57ae00dc5f6ce958` is patch 0036). One commit over `5c327c2`: a
`$/lean/rpc/keepAlive` no longer waits for a request slot of the edit
back-pressure (`docs/EMBEDDING.md`, "Requests in flight": Lean expires an
RPC session 30 s after its last keep-alive, so one held behind requests
waiting out a long check cost the InfoView its session). Measured with
QED64's `work/qk-keepalive.mjs` on the game: 22 "Outdated RPC session"
lines on `5c327c2` against 0 on `bf9d947` (wasm/UX-PARITY.md "Lean 4.34 on
the toolchain release").

Pin `5c327c2` (2026-10-06): QED64 `e4cffcc`'s edit back-pressure — the
coalescer holds full-text changes while the runtime has few free
preallocated Workers and caps requests in flight (HARDENING #59 addendum,
`ResidentHost.editBackPressure`), the slow-typing crash's fix; and the
client's `prebuild` runs `scripts/stage-workers.sh`, so a plain client build
never keeps the previous pin's workers (wasm/UX-PARITY.md "Bump to QED64
`5c327c2`").

Pin `84d594e` (2026-10-05, branch `feature/embedding-api`;
`EMBED_API_REVISION` still `1.0.0-pre.2`): the branch review after
`90aef68` (36 findings), the items lean4game's adoption reported upstream,
and HARDENING #59 (QED64's `docs/EMBEDDING.md` §12 lists every change). No
runtime, manifest or snapshot change: the closure's kernel floor was still
0032 and the game served `wasm64-d77d34b97592d014` as before. What the bump
changed for the game (wasm/UX-PARITY.md "Bump to QED64 `84d594e`"):
- **edit coalescing in `ResidentSession`** (§7.8, `ResidentHost.editCoalesceMs`,
  default 300 ms): full-text didChanges reach the worker at most once per
  window, the newest last, other frames queued behind a held change, a held
  change never crossing a document — the editor-mode crash's fix (HARDENING
  #59), for every embedder. The game's own throttle
  (`client/src/wasm/change-throttle.ts`, its measured prototype) is deleted.
  Two things the throttle did that the coalescer does not: a didOpen or a
  ranged change flushes a held change but opens no window (the first
  full-text change after a level's open goes at once), and a queued
  semantic-tokens or completion request a newer change supersedes is
  answered `ContentModified` (-32801) — UX-PARITY says what the game does
  with that answer (R3-1: a completion's becomes `result: null`).
- **the raw cache**: `busy` is the Web Lock's own answer (asked with
  `ifAvailable` first), `onBusy`/`busyWaitMs`/`onBusyWait` are per caller,
  the lock request is withdrawn when the last waiting caller leaves, and no
  worker is spawned after a last abort. The game's Prepare keeps the
  default `"return"` (the tile's busy message), the session's load `"wait"`.
- **causes on every boot failure**: a pack install (`profile`), the host's
  `files()`, `beforeArm` and a refused arm (`files`) carry a `FailureCause`
  classified at the step; `status().memory.initialBytes` is the commit
  actually made; `ResidentSession`'s v1 members are ECMAScript-private.
- **workers**: a lazily loaded `lsp-front-door.js` that fails to load is
  `WORKER_DEP_MISSING` (classified `WORKER_SCRIPT_LOAD_FAILED`; later frames
  dropped, never an uncaught throw) — the game's PAR-4 message rule is
  gone; the prefetch worker refuses a message without a positive `rawBytes`
  (its compressed-only mode is removed; the game always passes the index
  entry's `bytes`).
- **the relay**: each orphaned request is answered once, and a `restart()`
  issued while those answers go out is refused (the game calls `rearm()`,
  not `restart()`).
- tsc under `client/tsconfig.json` (`target: es5`) reports the package's
  `#` members as `TS18028` (10, in `resident-session.ts`); the Vite build
  does not run tsc and bundles them.

Pin `90aef68` (2026-10-04, branch `feature/embedding-api`,
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

*History (2026-09-07 to 2026-10-06; none of this exists any more).* That
pin needed the **0032 kernel** (then `wasm/KERNEL-PIN` → `992dc94`: the
resident ring exports and the in-kernel header resolver; the worker
refuses to open its loop on an older runtime) and game snapshots baked
against it, which the from-source lane of the time built from the
`wasm/kernel` submodule. Two lane changes came with it: kernels from 0032
on generate `src/emscripten-exports.txt` at build time (`gen-exports.py`
between the stage-1 libraries and the final link, which the kernel's own
`wasm64-build/build.sh` did not run — that lane let it fail its link,
generated, and finished the link), and the gate was advisory on such pins
(under the proxied main the process never exits in Node). Since the
toolchain release (2026-10-06) the kernel floor is the record's
`kernel.patch` (`0036` today, "Toolchain dependency"), the runtime is the
release's, and the lane builds no kernel; the bake lane's
`--verify-snapshots` probes remain the acceptance test.

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
   `embedding/closure.json`: `runtime.minKernelPatch` against the
   `kernel.patch` of `wasm/lean4-wasm64-release.json`, and
   `workerProtocol.deprecated` (a request
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
pairing bump: a newer toolchain release (both pins, "Toolchain dependency")
+ the from-source lane's full rebake, never the dependency alone.

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
served artifact, and every game's port as a patch (`wasm/patches`). What it
does not contain: the ~2.8 GB of served binaries (Lean 4.34, ten games) —
the Lean runtime chunks, the core library pack and the environment
snapshots — which are published as the artifact bundle named in
`wasm/artifacts/BUNDLE.json` (or rebuilt with `wasm/build-from-source.sh`,
below).

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
`scripts/pack-artifacts.sh <tag>` (the bundle lane runs it) → upload the
tarballs, any `<class>.tar.part-NNN` pieces and `SHA256SUMS` as a GitHub
release with that tag (the script prints the `gh release create` line) →
commit the updated `BUNDLE.json` and manifests. A tarball over
2,000,000,000 B is packed as pieces (`PART_BYTES`), because a GitHub release
asset must stay under 2 GiB; `BUNDLE.json` lists each piece's size and
sha256 under the tarball's `parts`, and `fetch-artifacts.sh` checks each,
joins them and checks the whole. Until the tag is published, a clone's
`fetch-artifacts.sh` gets a 404 (it says so); the packing machine uses
`--from-dir wasm/out/artifacts/<tag>`.

**The 4.34 bundle (branch `lean-v4.34`): packed, not published.**
`BUNDLE.json` names `artifacts-wasm64-57ae00dc5f6ce958` (runtime
`wasm64-57ae00dc5f6ce958`, the ten 4.34 snapshots): `runtime.tar`
158,883,328 B, `profiles.tar` 121,501,184 B, `snapshots.tar` 2,500,572,160 B
as two pieces (2,000,000,000 + 500,572,160 B) — in
`wasm/out/artifacts/artifacts-wasm64-57ae00dc5f6ce958/` only; uploads wait
for the hosting decision (`wasm/DEPLOY.md`). Checked locally:
`fetch-artifacts.sh --from-dir` on a fresh tree joins and verifies the
pieces and extracts snapshots byte-identical to `client/public`; the
default download answers 404 with the hint. The last published tag,
`artifacts-wasm64-d77d34b97592d014`, has `runtime.tar` and `profiles.tar`
but no `snapshots.tar` (checked 2026-10-08: no such asset, a HEAD request
answers 404), so the clone-and-play path was already incomplete before this
branch. Follow-up
with the hosting decision: `runtime.tar` and `profiles.tar` repack bytes the
toolchain release already serves (all eleven runtime files match its
assets) — `fetch-artifacts.sh` could take them from the release with
`lean4-wasm64 fetch --only runtime-chunks,lean-core`, leaving the bundle
only the snapshots. The tarballs carry file mtimes, so a re-run of the
bundle lane changes their digests even when no byte they hold changed.

## Building the artifacts from the toolchain release

`wasm/build-from-source.sh` drives the lanes end to end; `--plan` prints
every step with its cwd and environment without running anything (no
Docker, no network), `--lanes` selects a subset, and `--games a,b` (catalog
snapshot names) restricts the games, bake and bundle lanes to those games —
`--lanes games,bake --games stg4 --verify-snapshots` adds or rebakes one game
while the other games' staged snapshots are kept. Which games exist is
`wasm/catalog.json`, read only through `scripts/games-manifest.mjs`; the
script names no game. A run **without** `--games` is a full run: the
runtime's snapshot staging dir (`wasm/out/staging/<build id>/snapshots`) is
wiped and every game is rebaked slim (the release-bump path); another
runtime's staging dir is never touched. No kernel checkout, no submodule,
no kernel build, no emsdk image: the native compiler runs in the lane's own
image, built on first use from `wasm/docker/Dockerfile` (Ubuntu 24.04
pinned by digest + python3 and libuv, ~40 MB; tag
`lean4game-native64:<sha256 of the Dockerfile, 12 hex>`) for the record's
`native64` platform, `linux/arm64` — native on Apple silicon and arm64
Linux; an x86_64 host needs qemu user emulation (Docker Desktop ships it;
on Linux `docker run --privileged --rm tonistiigi/binfmt --install arm64`)
and compiles several times slower. The lanes do not use the release's own
build image (`release.json` `docker.*`, the ~3 GB emsdk image its builder
used): the native compiler needs only glibc ≥ 2.38, libstdc++ and libuv, and
`compile-pkg.py` python3. GameServer recompiled in the new image is
byte-identical (22/22 oleans) to the build in the emsdk image.

| lane | does | needs |
| --- | --- | --- |
| preflight | the release record (canonical, self-digest), installed tools == record == lockfile, the Mathlib packs' compiler == `native64.commit`, the files a clone needs are tracked by git (the record, `wasm/docker/Dockerfile`, `wasm/scripts/tree-stamp.py`, every catalog patch; warns), qed64 pin, the workers' kernel floor (`stage-workers.sh --check`), `games-manifest.mjs --check`, which olean trees the record still accepts (stamps), Node ≥ 24, python3/rsync/openssl, disk; when a Docker lane is selected (release, trees, games, bake with `--verify-snapshots`): Docker reachable, the native image present (built when missing) and runnable for the record's platform — a hard failure, before any fetch | — |
| release | `lean4-wasm64 fetch --id --digest` into `wasm/out/release/<id>/mirror` (runtime manifest + chunks, `lean-core`, `mathlib-essential`, `mathlib-game-extra`, `native64`, module lists, tools; every byte sha256-checked, a rerun keeps what is verified); the fetched `release.json` must be the tracked record byte for byte; `fetch --only runtime` from the mirror into `…/artifact` (`bin/lean.js`, `lean.wasm`, `leanmake`) and the build id recomputed from `bin/lean.wasm`; the tools tgz's sha512 == the lockfile's integrity; `native64.tar.gz` unpacked once per release and its `lean --version` checked (a failing `docker run` is reported, not a silent exit) | network once (~2.3 GB), 7 min at ~5 MB/s |
| trees | `unpack` the three packs fat into `lib-tree` and `unpack --slim` into `lib-tree-slim`; every module of the release's two lists must have an olean; Lake facets from the native compiler's `lib/lean` merged into the trees (`mathlib-game-extra` ships `Lake.Util.Casing` itself, so a separate `LEAN_PATH` entry would hide the rest of Lake); the Lake facets a pack ships too must be byte-identical to native64's; lean-i18n (`vendor/i18n`) and `server/GameServer` compiled with the native compiler → `lib-tree-gamebase` (fat, compiles) and `lib-tree-gamebase-slim` (bakes); last, the base stamp `wasm/out/trees/gamebase.stamp` | Docker; 3.5 min |
| games | refuses base trees whose stamp is not the record's; per selected catalog row: clone `source.url` @ `rev` + `git am` the patch when `src` is absent, and refuse an existing checkout whose `HEAD` tree is not `rev` + the patch (delete it: the lane clones it again); compile with the native compiler and the row's `leanOptions` (`-D` flags) → gamedata; restore the regenerated `.i18n/*/*.pot` templates (only those — translations beside them are left alone); overlay a per-game tree — **slim** by default (on `lib-tree-gamebase-slim`; `SLIM_TREES=0` = fat) — and stamp it (`lib-tree-<snapshot>.stamp`: the base stamp + `source <rev> <patch sha256>`) | Docker, one compile at a time |
| bake | refuses a per-game tree whose stamp is not the record's and the row's; `bake-snapshot.mjs` per selected game, in place in `node_modules/qed64`, against the release's runtime (`--artifact`), the per-game tree (`--lib`), `--work wasm/out/bake-work`, `--out wasm/out/staging/<build id>/snapshots`, `--roots Game,GameServer.Runner` (the entry's `roots` = its `imports`), reserve = the row's `reserveBytes`; no environment flag (the 4.34 runtime admits the games' legacy oleans under the wasm target by itself); raw size checked against the row's `expectedRaw` when its `runtime` equals this run's pairing key — the build id, plus `+slim` for slim trees — ±5 % stops the run, otherwise the value to paste is printed; raw > reserve only warns; superseded `.snapz` pruned; `--verify-snapshots`: the catalog probe through `snapshot-probe.mjs --via-mem` (load path + env-cache hit), then natively against the same per-game tree (the proof must close with no message) and its negative control (must fail), and every further catalog probe of the row (`probe2`, `probe3`, …: `games-manifest.mjs --probes`) natively, each closing with no message | the browser lock on a shared host; ~10 min per game |
| bundle | refuses unless every snapshot the served index will hold pairs with the release's runtime; stages `stage-game-assets.sh`, the release's runtime manifest + chunks and `lean-core` pack into `client/public`, writes the site-owned `profiles/index.json`, `stage-snapshots.py` for the selected names from `wasm/out/staging/<build id>/snapshots` (which refuses an index mixing runtimes), client build, `pack-artifacts.sh` (a tarball over 2,000,000,000 B is written as `.part-NNN` pieces: GitHub's asset limit is 2 GiB) | — |

Why the native probe: `snapshot-probe.mjs` compiles through the runtime's
one-shot `lean_wasm_compile` (kernel `Lean/Shell.lean` `wasmCompile`), which
collects each command's own message log. On the 4.34 runtime the errors of
the theorem a `Runner` command elaborates never reach that log: a wrong or
incomplete level proof "passes" there with `errors=0` (measured on testgame:
`exact <unknown identifier>` and an unsolved goal both report no error,
while a plain `theorem` in the same file reports its error, and the native
compiler reports both). The wasm probe therefore proves the snapshot (it
loads through the browser's `_mem` path and seeds the environment cache —
the compile stays within budget); the native pair proves the level.

The trees are the browser's: the bake mounts `unpack --slim` of the very
packs whose fat copies the games were compiled against (Init from
`lean-core`, compiled by the runtime line's wasm compiler; Lean, Std,
Mathlib and the game leaves from the native compiler that the games use
too). Disk: ~12 GB under `wasm/out` (`release/<id>` 5.6 GB: mirror 2.2,
unpacked native64 3.3; `trees` 6.3 GB with hard links), plus the raw `.snap`
(0.5–1 GB) and `.snapz` of every baked game.
