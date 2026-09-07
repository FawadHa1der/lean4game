#!/bin/bash
# Build the app shell and deploy it to Cloudflare Workers (seconds). The
# multi-GB artifacts live in R2 and are uploaded separately and rarely
# (scripts/upload-artifacts.sh) — run that FIRST whenever the runtime,
# profile pack or snapshots changed, so the shell never points at objects
# that are not there yet.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d client/node_modules ] || npm ci
# The worker scripts are generated into client/public/workers (gitignored)
# from the vendored closure — a clean checkout (CI) has none, and a shell
# deployed without them hangs at "starting Lean".
scripts/stage-workers.sh
if [ "${SKIP_BUILD:-0}" != 1 ]; then npm run build:client; fi
# Workers assets cap files at 25 MiB: ship client/dist WITHOUT the artifact
# directories, in a separate tree so client/dist stays complete for the local
# server (scripts/serve-dist.mjs).
OUT=wasm/out/deploy
rm -rf "$OUT"; mkdir -p "$OUT"
rsync -a --delete --exclude '/runtime/' --exclude '/profiles/' --exclude '/snapshots/' client/dist/ "$OUT/"
big=$(find "$OUT" -type f -size +25M | head -3)
[ -z "$big" ] || { echo "files over the 25 MiB asset cap:" >&2; echo "$big" >&2; exit 3; }
for f in workers/lean.worker.js workers/lsp-frames.js workers/snapshot-prefetch.worker.js runtime/runtime-manifest.json snapshots/index.json profiles/index.json data/g/hhu-adam/NNG4/game.json; do
  case "$f" in runtime/*|snapshots/*|profiles/*) src="client/dist/$f" ;; *) src="$OUT/$f" ;; esac
  [ -f "$src" ] || { echo "deploy tree incomplete: $f missing — the shell would hang at start-up" >&2; exit 3; }
done
echo "shell: $(find "$OUT" -type f | wc -l | tr -d ' ') files, $(du -sh "$OUT" | cut -f1)"
npx wrangler deploy "$@"
