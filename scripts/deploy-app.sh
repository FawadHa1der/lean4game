#!/bin/bash
# Build the app shell and deploy it to Cloudflare Workers (seconds). One deploy
# carries the shell, the Worker (which bundles the release record) and the
# site's two indexes, so they switch together (wasm/DEPLOY.md, "Deploy, in
# order"). The multi-GB artifacts live in R2 and are uploaded separately and
# rarely (scripts/upload-artifacts.sh) — run that FIRST whenever the runtime or
# the snapshots changed, so the shell never points at objects that are not
# there yet; the guard below refuses the deploy otherwise. Not run from here: CI
# has no R2 credentials, and a shell-only deploy needs nothing.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d client/node_modules ] || npm ci
# The worker scripts are generated into client/public/workers (gitignored)
# from the qed64 package's closure.json — a clean checkout (CI) has none, and
# a shell deployed without them hangs at "starting Lean".
scripts/stage-workers.sh
if [ "${SKIP_BUILD:-0}" != 1 ]; then npm run build:client; fi
# Workers assets cap files at 25 MiB: ship client/dist WITHOUT the artifact
# directories, in a separate tree so client/dist stays complete for the local
# server (scripts/serve-dist.mjs). Of those directories the deploy keeps exactly
# the site's two indexes (infra/worker.js serves them from this deploy).
OUT=wasm/out/deploy
rm -rf "$OUT"; mkdir -p "$OUT"
rsync -a --delete --exclude '/runtime/' \
  --include '/profiles/' --include '/profiles/index.json' --exclude '/profiles/*' \
  --include '/snapshots/' --include '/snapshots/index.json' --exclude '/snapshots/*' \
  client/dist/ "$OUT/"
# Another index than the tracked one would serve another pairing, or none.
for idx in snapshots/index.json profiles/index.json; do
  [ -f "$OUT/$idx" ] || { echo "deploy tree incomplete: $idx missing — the build must copy the tracked client/public/$idx" >&2; exit 3; }
  cmp -s "$OUT/$idx" "client/public/$idx" || { echo "deploy tree refused: $idx is not byte-identical to the tracked client/public/$idx (a stale build?)" >&2; exit 3; }
done
big=$(find "$OUT" -type f -size +25M | head -3)
[ -z "$big" ] || { echo "files over the 25 MiB asset cap:" >&2; echo "$big" >&2; exit 3; }
# The game files come from the catalog (api/games + every listed game's
# game.json) so a new game cannot be deployed half-staged.
REQUIRED_GAME_FILES=$(node scripts/games-manifest.mjs --required-files)
# The worker names are the closure's (stage-workers.sh --list), not a copy here.
REQUIRED_WORKERS=$(scripts/stage-workers.sh --list)
for f in sw.js $REQUIRED_WORKERS runtime/runtime-manifest.json $REQUIRED_GAME_FILES; do
  case "$f" in runtime/*) src="client/dist/$f" ;; *) src="$OUT/$f" ;; esac
  [ -f "$src" ] || { echo "deploy tree incomplete: $f missing — the shell would hang at start-up" >&2; exit 3; }
done
# The service worker's precache list must describe THIS tree (a stale
# sw.js from an earlier build would precache names that no longer exist).
node -e '
  const fs = require("fs"); const out = process.argv[1];
  const s = fs.readFileSync(out + "/sw.js", "utf8"); const l = JSON.parse(s.match(/const PRECACHE = (\[.*?\]);/s)[1]);
  const miss = l.filter((p) => !/^\/(runtime|profiles|snapshots)\//.test(p) && !fs.existsSync(out + p));
  if (miss.length) { console.error("sw.js precache lists files missing from the deploy tree:", miss.slice(0, 5)); process.exit(3); }
  console.log("sw.js precache: " + l.length + " entries, all present");
' "$OUT"
echo "shell: $(find "$OUT" -type f | wc -l | tr -d ' ') files, $(du -sh "$OUT" | cut -f1)"
# Every .snapz the tracked index names must already answer on the live origin,
# or nothing deploys (QED64's review R19a; CI deploys through this script too).
# It only reads, so a --dry-run runs it as well. LEAN4GAME_DEPLOY_ORIGIN
# overrides the origin (none: skip, for a first deploy to a new origin).
# Release-mapped files are never checked through the live origin: its Worker
# maps them into ITS release; scripts/upload-artifacts.sh checks the release.
node scripts/deploy-guard.mjs
npx wrangler deploy "$@"
