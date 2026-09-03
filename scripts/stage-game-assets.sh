#!/bin/bash
# Stage everything the wasm build serves statically into client/public/.
# Sources: the game's compiled gamedata + translations (in-repo) and the
# worker scripts from the vendored, commit-pinned qed64 closure
# (client/src/wasm/vendor, scripts/sync-qed64.sh). The qed64 sibling
# checkout is only an OPTIONAL import path for digest-pinned build artifacts
# (core profile pack, runtime chunks) when the runtime pin changes; snapshots
# are staged with scripts/stage-snapshots.py. See wasm/KERNEL.md.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
QED64="${QED64:-$HERE/../wasm64-lean-fable/qed64}"
PUB="$HERE/client/public"
GAME="$HERE/cypress/TestGame"

mkdir -p "$PUB"/{workers,profiles,runtime,snapshots} "$PUB/data/g/test/TestGame" "$PUB/i18n/g/test/TestGame"

# game data + translations + serverless stats
# TestGame gamedata/i18n are compiled outputs (cypress/TestGame/.lake, gitignored);
# the results are tracked under client/public, so a clone without a Lean
# toolchain keeps the committed copies.
if [ -d "$GAME/.lake/gamedata" ]; then
  cp "$GAME"/.lake/gamedata/*.json "$PUB/data/g/test/TestGame/"
  cp "$GAME"/.i18n/de/Game.json "$PUB/i18n/g/test/TestGame/de"
else
  echo "note: $GAME/.lake/gamedata not found — keeping the tracked TestGame gamedata/i18n"
fi
printf 'CPU, MEM\n0, 0\n' > "$PUB/data/stats"

# NNG4 — local clone at games-src/NNG4 (branch wasm64-port; see wasm/KERNEL.md)
NNG="$HERE/games-src/NNG4"
if [ -d "$NNG/.lake/gamedata" ]; then
  mkdir -p "$PUB/data/g/hhu-adam/NNG4" "$PUB/i18n/g/hhu-adam/NNG4"
  cp "$NNG"/.lake/gamedata/*.json "$PUB/data/g/hhu-adam/NNG4/"
  [ -d "$NNG/.lake/gamedata/images" ] && cp -r "$NNG/.lake/gamedata/images" "$PUB/data/g/hhu-adam/NNG4/"
  for L in fr it uk zh de; do
    [ -f "$NNG/.i18n/$L/Game.json" ] && cp "$NNG/.i18n/$L/Game.json" "$PUB/i18n/g/hhu-adam/NNG4/$L"
  done
fi

# landing-page tile list: {owner, game, tile-from-game.json} per staged game
node -e '
const fs = require("fs"), path = require("path");
const here = process.argv[1];
// TestGame stays reachable at /#/g/test/TestGame for the cypress suite but
// is not advertised on the landing page.
const games = [["hhu-adam","NNG4", path.join(here, "games-src/NNG4/.lake/gamedata/game.json")]].filter(([,,p]) => fs.existsSync(p));
if (!games.length) { console.log("note: no game sources present — keeping the tracked client/public/api/games"); process.exit(0); }
const out = [];
for (const [owner, game, p] of games) {
  try { out.push({ owner, game, tile: JSON.parse(fs.readFileSync(p, "utf8")).tile }); } catch {}
}
fs.mkdirSync(path.join(here, "client/public/api"), { recursive: true });
fs.writeFileSync(path.join(here, "client/public/api/games"), JSON.stringify(out));
' "$HERE"

# substrate: worker + core profile from qed64; runtime via chunk-runtime.mjs
# Worker scripts come from the vendored, commit-pinned qed64 closure (scripts/sync-qed64.sh),
# never from a live qed64 checkout — they must pair with the vendored watchdog shim.
VENDOR="$HERE/client/src/wasm/vendor/qed64"
cp "$VENDOR/public/workers/lean.worker.js" "$PUB/workers/"
# the disposable-prefetch boot (qed64 b00cba3) spawns a second worker
cp "$VENDOR/public/workers/snapshot-prefetch.worker.js" "$PUB/workers/"
# the LSP frame decoder lean.worker.js loads with importScripts (qed64
# byte-channel rewrite): without it the worker throws at script load, never
# posts {type:"boot"}, and every session hangs. Fail here, not in the browser.
if [ -f "$VENDOR/public/workers/lsp-frames.js" ]; then
  cp "$VENDOR/public/workers/lsp-frames.js" "$PUB/workers/"
elif grep -q 'importScripts("lsp-frames.js")' "$VENDOR/public/workers/lean.worker.js"; then
  echo "vendored lean.worker.js imports lsp-frames.js but the vendor closure lacks it; rerun scripts/sync-qed64.sh" >&2
  exit 1
fi
# i18next probes every configured language; a missing file must yield JSON,
# not the SPA-fallback HTML (the uncaught SyntaxError wedged cypress runs)
for G in "g/test/TestGame" "g/hhu-adam/NNG4"; do
  mkdir -p "$PUB/i18n/$G"
  for L in en de fr it uk zh; do
    if [ ! -f "$PUB/i18n/$G/$L" ]; then printf '{}' > "$PUB/i18n/$G/$L"; fi
  done
done
# Artifact import (optional): the core profile pack is a digest-pinned build
# OUTPUT of the shared kernel pipeline (wasm/KERNEL.md), not source; it only
# needs re-copying when the runtime pin changes, so a missing checkout is fine.
if [ -d "$QED64/public/profiles" ]; then
  cp "$QED64"/public/profiles/index.json "$QED64"/public/profiles/lean-core.manifest.json \
     "$QED64"/public/profiles/lean-core.pack.gzip.* "$PUB/profiles/"
else
  echo "note: $QED64/public/profiles not found — keeping the already-staged core profile pack"
fi

echo "staged. Runtime chunks: node $QED64/pipeline/toolchain/chunk-runtime.mjs --bin <stage1/bin> --out $PUB/runtime"
echo "Snapshots: bake with --out $PUB/snapshots (init + testgame), see wasm/KERNEL.md."
