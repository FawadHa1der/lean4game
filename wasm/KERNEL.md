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
