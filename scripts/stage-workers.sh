#!/bin/bash
# Copy the worker scripts from the vendored qed64 closure into client/public/
# workers/ (gitignored: generated, paired with the vendored shim by
# construction). Every build that ships must run this first — a clean
# checkout has no client/public/workers, and a shell deployed without them
# hangs at "starting Lean" (the first CI-built deploy, 2026-09-07).
set -euo pipefail
cd "$(dirname "$0")/.."
VENDOR=client/src/wasm/vendor/qed64/public/workers
PUB=client/public/workers
mkdir -p "$PUB"
for f in lean.worker.js snapshot-prefetch.worker.js; do
  [ -f "$VENDOR/$f" ] || { echo "stage-workers: $VENDOR/$f missing — run scripts/sync-qed64.sh" >&2; exit 2; }
  cp "$VENDOR/$f" "$PUB/"
done
# lean.worker.js imports lsp-frames.js (required beside it); the front door
# is resident-only and optional.
if grep -q 'importScripts("lsp-frames.js")' "$VENDOR/lean.worker.js"; then
  [ -f "$VENDOR/lsp-frames.js" ] || { echo "stage-workers: lean.worker.js imports lsp-frames.js but the closure lacks it — rerun scripts/sync-qed64.sh" >&2; exit 2; }
fi
[ -f "$VENDOR/lsp-frames.js" ] && cp "$VENDOR/lsp-frames.js" "$PUB/"
[ -f "$VENDOR/lsp-front-door.js" ] && cp "$VENDOR/lsp-front-door.js" "$PUB/"
echo "staged workers: $(ls "$PUB" | tr '\n' ' ')"
