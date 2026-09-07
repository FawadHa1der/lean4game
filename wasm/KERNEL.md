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

## Substrate pin (the qed64 closure, vendored)

The browser-side substrate — boot (`qed64-boot.ts`), watchdog shim, runtime
client, snapshot loader, install profiles, and the worker scripts
(`lean.worker.js` + the `lsp-frames.js` decoder it imports, the prefetch
worker, and the resident-only `lsp-front-door.js`) — is a **vendored copy of
the qed64 closure at one commit**, under `client/src/wasm/vendor/qed64/`
with the pin in `client/src/wasm/vendor/QED64-PIN`. The nine pipeline
scripts the from-source lane runs (chunk-runtime, artifact-paths,
bake-snapshot, node-runner, snapshot-probe, pack/unpack/inspect,
verify-release; no third-party imports) are vendored by the same script into
`wasm/vendor/qed64-pipeline/`. The `qed64/...` import specifiers resolve to
the closure (vite alias + tsconfig paths); `scripts/stage-game-assets.sh`
copies the worker scripts from the same directory, so shim and worker are
paired by construction. **No build, bake or test reads a qed64 checkout.**
Current pin: qed64 `f98e009` (2026-09-04; bumped from `e5df87a` on
2026-09-07). What the bump brought the game, all on the pump path it uses:
the shim no longer counts a kind-2 (fatal-error) `$/lean/fileProgress`
entry as work in flight (qed64 HARDENING #46 — such an entry never drains
and pinned "elaborating" for good; the game's translation layer applies the
same reading to its own processing flag), every published header failure
sets the sticky flag the progress drain reads and a tag-0 setup clears it
(#46's companion), and `lean.worker.js` keeps exactly two snapshot load
paths (raw OPFS sync-read into a wasm allocation, or fetch → gunzip → heap;
their "W5a": the compressed-snapshot OPFS cache, the download tee, the
MEMFS staging file and the path-loader branch are gone — the boot-time
transient copies behind the reload-then-storm renderer crash). The worker
now requires `_lean_wasm_load_snapshot_mem` in the runtime and raw `bytes`
in the snapshot index; the game's `wasm64-0becc706d2ef1964` runtime exports
it and the index carries them (checked before the bump). The umbrella
collision note / "Load exact imports" offer that also arrived is inert
here: game headers are covered by the game snapshot and cannot collide.
On the game's `852d1b9` runtime the worker's LSP decoder reports non-zero
`junkLines`: that runtime still prints library progress to stdout (moved to
stderr in kernel patch 0031), the decoder sheds it and resyncs — expected,
not a fault.

**The pump transport is scheduled for removal upstream.** qed64 made the
resident transport its default on 2026-09-04 and wrote a removal plan
(`docs/PUMP-REMOVAL-ASSESSMENT-2026-09-04.md` there): step 1 deletes the
shim page-side, step 3 deletes the kernel entry points at their next
pairing bump. `f98e009` is the last commit before step 1; once the shim is
gone, `scripts/sync-qed64.sh` refuses newer commits (a required path is
missing) and the game stays frozen here — frozen, not broken. Porting the
game to the resident transport is a campaign of its own: a kernel bump to
≥ 0032 (`852d1b9` lacks the ring exports and the in-kernel resolver, so
resident cannot boot on it), a rebake of the game snapshots against that
runtime (the from-source lane), the relay + front door in the sync list,
and a vendorable session adapter with the two policy hooks the game uses
(snapshots per header, memory cap) — which qed64 intends to extract as
`frontend/src/resident-session.ts` in its step 1. Wait for that extraction
before porting; the measured gain is the header switch (322 ms vs 2,571 ms
on their pairing, i.e. level switches) and the deletion of the shim's
session-replacement machinery that the game's recovery paths work around.

It used to be a live `file:` link into the qed64 checkout: every build
compiled whatever that checkout held at that second, uncommitted edits
included (a half-typed import broke the game build on 2026-09-02, and shim
behaviour changed under a running test day), and the worker copy could
silently drift from the shim.

Bump: `scripts/sync-qed64.sh <qed64-commit>` (extracts with `git archive`,
never from a working tree), rebuild, run cypress, commit the diff. The
closure has no third-party imports; the sync script fails if a relative
import does not resolve inside the vendored tree.

Bump only to a qed64 commit its owners have announced as having passed
their test pyramid (`e5df87a` and `f98e009` were: 23/23 e2e on both
transports; the pump path is reachable there behind `?resident=0`).
The game's boot registers `pagehide → shim.disposeForUnload()`; keep that
call working across bumps (qed64's own page relies on the same hook).

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

What a clone contains: the client and server sources, the vendored
substrate closure (pinned qed64 commit), the compiled gamedata for NNG4 and
TestGame (`client/public/data`, tracked), the digest manifests of every
served artifact, and the NNG4 port as a patch (`wasm/patches`). What it does
not contain: the ~1.2 GB of served binaries — the Lean runtime chunks, the
core library pack and the environment snapshots — which are published as the
artifact bundle named in `wasm/artifacts/BUNDLE.json`.

```bash
git clone -b wasm64-port https://github.com/FawadHa1der/lean4game
cd lean4game && npm ci
scripts/fetch-artifacts.sh            # downloads + sha256-verifies the bundle into client/public
scripts/stage-game-assets.sh          # worker scripts from the vendored closure (+ i18n/api staging)
npm --workspace client run build
node scripts/serve-dist.mjs           # http://localhost:3006 with the COOP/COEP headers the worker needs
```

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

The pipeline scripts are vendored (above), so the former `wasm/qed64`
submodule is gone. Check the kernel out explicitly when building from
source (~700 MB):

```bash
git submodule update --init --checkout wasm/kernel
```

Then `wasm/build-from-source.sh` drives the lanes end to end; `--plan`
prints every step with its cwd and environment without running anything,
`--lanes` selects a subset (e.g. `games,bake,bundle` after a game change):

| lane | does | needs |
| --- | --- | --- |
| preflight | pins, clean tree, Docker memory, Node ≥ 24, disk, inputs | — |
| runtime | kernel `wasm64-build/build.sh` in Docker → gate → chunk into a staging dir; build id = `wasm64-` + sha256(lean.wasm)[:16] | Docker ≥ 10 GiB, 1.5–3 h cold |
| core | Lean core library pack from stage1's `Init` facets (`pack.mjs`), or `--reuse-core-pack` | — |
| trees | unpack the core pack and the **Mathlib pack** into an olean tree; compile lean-i18n (`vendor/i18n`) and `server/GameServer` with the native stage0; overlay Lake | the Mathlib pack (below) |
| games | compile `cypress/TestGame` and `games-src/NNG4` (cloned + patched if absent) → gamedata + per-game trees | — |
| bake | `bake-snapshot.mjs` for init, testgame, nng4 against that stage1; `--verify-snapshots` runs a Runner document through `snapshot-probe.mjs` | ~40 GB scratch |
| bundle | stage into `client/public`, `stage-game-assets.sh`, client build, `pack-artifacts.sh` | — |

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
  on this machine; keep the requirement as the safe figure. Bumping the kernel pin (`wasm/KERNEL-PIN` + the submodule commit) implies a full rebake (snapshots pair to the runtime build id); bumping the qed64 pin is `scripts/sync-qed64.sh <commit>` (closure + pipeline together).

Rebuilding the binaries themselves (rather than fetching them) needs the
shared pipeline: the kernel repo's `wasm64-build/build.sh` (Docker,
1.5–3 h cold, ≥10 GB VM memory) for the runtime; qed64's `pack.mjs` for the
core pack; `compile-pkg.py` + `bake-snapshot.mjs` over the olean trees for
the snapshots (the rebake section above). Note the snapshots are paired to
the exact runtime build they were baked against: a rebuilt runtime is a
different `buildId` and needs a rebake.
