#!/bin/bash
# Stage everything the wasm build serves statically into client/public/.
# Sources: the game's compiled gamedata + translations (in-repo), and the
# QED64 sibling checkout for the substrate artifacts (worker, runtime
# chunks, core profile). Snapshots are baked by the qed64 pipeline
# (bake-snapshot.mjs --out client/public/snapshots) and land here directly.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
QED64="${QED64:-$HERE/../wasm64-lean-fable/qed64}"
PUB="$HERE/client/public"
GAME="$HERE/cypress/TestGame"

mkdir -p "$PUB"/{workers,profiles,runtime,snapshots} "$PUB/data/g/test/TestGame" "$PUB/i18n/g/test/TestGame"

# game data + translations + serverless stats
cp "$GAME"/.lake/gamedata/*.json "$PUB/data/g/test/TestGame/"
cp "$GAME"/.i18n/de/Game.json "$PUB/i18n/g/test/TestGame/de"
printf 'CPU, MEM\n0, 0\n' > "$PUB/data/stats"

# substrate: worker + core profile from qed64; runtime via chunk-runtime.mjs
cp "$QED64/public/workers/lean.worker.js" "$PUB/workers/"
cp "$QED64"/public/profiles/index.json "$QED64"/public/profiles/lean-core.manifest.json \
   "$QED64"/public/profiles/lean-core.pack.gzip.* "$PUB/profiles/"

echo "staged. Runtime chunks: node $QED64/pipeline/toolchain/chunk-runtime.mjs --bin <stage1/bin> --out $PUB/runtime"
echo "Snapshots: bake with --out $PUB/snapshots (init + testgame), see wasm/README notes."
