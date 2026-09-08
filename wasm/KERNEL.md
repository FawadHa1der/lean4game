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

The browser-side substrate — boot/artifacts (`qed64-boot.ts`), the session
adapter with its boot policy (`resident-session.ts`), the L3 relay
(`lsp-relay.ts`: crash recovery, replay, the crash-loop breaker), the
runtime client, snapshot loader and install profiles, and the four worker
scripts (`lean.worker.js` plus the `lsp-frames.js` decoder and the
`lsp-front-door.js` it `importScripts`, and the prefetch worker) — is a
**vendored copy of the qed64 closure at one commit**, under
`client/src/wasm/vendor/qed64/` with the pin in
`client/src/wasm/vendor/QED64-PIN`. The pipeline scripts the from-source
lane runs (chunk-runtime, artifact-paths, gen-exports, gate,
bake-snapshot, node-runner, snapshot-probe, persistent-probe,
pack/unpack/inspect, verify-release; no third-party imports) are vendored
by the same script into `wasm/vendor/qed64-pipeline/`. The `qed64/...`
import specifiers resolve to the closure (vite alias + tsconfig paths);
`scripts/stage-workers.sh` copies the worker scripts from the same
directory, so relay and worker are paired by construction. **No build,
bake or test reads a qed64 checkout.**

Current pin: qed64 `32e5e62` (2026-09-07), the **resident transport**.
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
the relay arms the loop), a policy of `["init", <game snapshot>]` with a
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
silently drift from the shim.

Bump: `scripts/sync-qed64.sh <qed64-commit>` (extracts with `git archive`,
never from a working tree), `scripts/stage-workers.sh`, rebuild, run
cypress, commit the diff. The closure has no third-party imports; the sync
script fails if a relative import does not resolve inside the vendored
tree. A closure bump that changes the worker's runtime requirements (a
kernel patch level) is a pairing bump: kernel pin + from-source lane +
release, never the closure alone.

Bump only to a qed64 commit its owners have announced as having passed
their test pyramid (`32e5e62` was: e2e 23/23, 323 ms switch, gauntlets
clean). Keep `relay.unload()` on `pagehide` working across bumps (qed64's
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
`992dc94` (patch series through 0032) with the vendored qed64 `32e5e62`
pipeline, for the resident-transport port of the closure (see the pin
section above). Bundle tag `artifacts-wasm64-d77d34b97592d014`
(`wasm/artifacts/BUNDLE.json`; tarballs in
`wasm/out/artifacts/artifacts-wasm64-d77d34b97592d014/`, uploaded by the
operator as the GitHub release of that name and into R2 with
`scripts/upload-artifacts.sh`).

| artifact | digest / build id | transfer bytes | raw bytes |
| --- | --- | --- | --- |
| runtime | `wasm64-d77d34b97592d014` (source `qed64-wasm64@992dc94b2`) | 153,673,728 (tar) | — |
| init | `sha256:da2ed4de9dabfb73…` | 107,410,385 | 342,124,389 |
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
(docs/SERVER-SLIM-REBAKE.md). The served init/nng4/testgame stay fat until
the next full run (a full run is a full slim rebake; `SLIM_TREES=0` is the
fat escape hatch). `expectedRaw` for stg4 is keyed
`wasm64-d77d34b97592d014+slim` in `wasm/catalog.json`.

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
prints every step with its cwd and environment without running anything
(no Docker needed), `--lanes` selects a subset, and `--games a,b` (catalog
snapshot names) restricts the games, bake and bundle lanes to those games —
`--lanes games,bake,bundle --games stg4 --verify-snapshots` adds or rebakes
one game while the other games' staged snapshots are kept. Which games exist
is `wasm/catalog.json`, read only through `scripts/games-manifest.mjs`; the
script names no game. A run **without** `--games` is a full run: the
snapshot staging dir is wiped and init + every game is rebaked slim (the
runtime-bump path).

| lane | does | needs |
| --- | --- | --- |
| preflight | pins, clean tree, `games-manifest.mjs --check`, Docker memory, Node ≥ 24, disk, inputs | — |
| runtime | kernel `wasm64-build/build.sh` in Docker → gate → chunk into a staging dir; build id = `wasm64-` + sha256(lean.wasm)[:16] | Docker ≥ 10 GiB, 1.5–3 h cold |
| core | Lean core library pack from stage1's `Init` facets (`pack.mjs`), or `--reuse-core-pack` | — |
| trees | unpack the core pack and the **Mathlib pack** into an olean tree; compile lean-i18n (`vendor/i18n`) and `server/GameServer` with the native stage0; overlay Lake; then runs `compat` | the Mathlib pack (below) |
| compat | compile `wasm/compat` (`Mathlib.Tactic.Have`, `Mathlib.Tactic.Cases` — leaves the essential pack excludes) against the fat tree into the game base tree; refuses if the pack itself provides them (`wasm/compat/README.md`) | — |
| games | per selected catalog row: clone `source.url` @ `rev` + `git am` the patch when `src` is absent; compile with the row's `leanOptions` (`-D` flags) → gamedata; restore the regenerated `.i18n/*/*.pot` templates (only those — translations beside them are left alone); overlay a per-game tree — **slim** by default (`SLIM_TREES=1` drops the pack's `*.olean.private` facets; `SLIM_TREES=0` = fat) | — |
| bake | `bake-snapshot.mjs` per selected game (reserve = the row's `reserveBytes`), plus init on a full run; raw size checked against the row's `expectedRaw` when its `runtime` equals this run's pairing key — the build id, plus `+slim` when the per-game trees are slim (`SLIM_TREES=1`; a slim bake is ~60 % smaller, so a fat record is never asserted against it) — ±5 % stops the run, otherwise the value to paste is printed; raw > reserve only warns; superseded `.snapz` pruned; `--verify-snapshots` runs each game's catalog probe (`games-manifest.mjs --probe`) through `snapshot-probe.mjs --via-mem` | ~40 GB scratch |
| bundle | stage into `client/public` (`stage-game-assets.sh`, `stage-snapshots.py` for the selected names), client build, `pack-artifacts.sh` | — |

The pipeline scripts run from a copy of the vendored `wasm/vendor/qed64-pipeline`
made at `wasm/out/pipeline` on every run (rsync; its `work/` — the bake
workspace holding the raw `.snap` files a re-probe needs — is kept), because
`bake-snapshot.mjs` hardcodes that workspace under its own root and nothing
may be written under `wasm/vendor`. Setting `QED64_DIR` explicitly runs a
qed64 checkout in place instead.

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
