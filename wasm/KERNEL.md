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
