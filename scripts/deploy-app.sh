#!/bin/bash
# Build the app shell and deploy it to Cloudflare Workers (seconds). The
# multi-GB artifacts live in R2 and are uploaded separately and rarely
# (scripts/upload-artifacts.sh) — run that FIRST whenever the runtime,
# profile pack or snapshots changed, so the shell never points at objects
# that are not there yet, and `scripts/upload-artifacts.sh --post-deploy`
# right AFTER this deploy: it replaces the mutable snapshot and profile
# indexes, which must not change before the shell that pairs with them is
# live (QED64 HARDENING #64; wasm/DEPLOY.md). Not run from here: CI has no R2
# credentials, and a shell-only deploy needs nothing.
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
# server (scripts/serve-dist.mjs).
OUT=wasm/out/deploy
rm -rf "$OUT"; mkdir -p "$OUT"
rsync -a --delete --exclude '/runtime/' --exclude '/profiles/' --exclude '/snapshots/' client/dist/ "$OUT/"
big=$(find "$OUT" -type f -size +25M | head -3)
[ -z "$big" ] || { echo "files over the 25 MiB asset cap:" >&2; echo "$big" >&2; exit 3; }
# The game files come from the catalog (api/games + every listed game's
# game.json) so a new game cannot be deployed half-staged.
REQUIRED_GAME_FILES=$(node scripts/games-manifest.mjs --required-files)
# The worker names are the closure's (stage-workers.sh --list), not a copy here.
REQUIRED_WORKERS=$(scripts/stage-workers.sh --list)
for f in sw.js $REQUIRED_WORKERS runtime/runtime-manifest.json snapshots/index.json profiles/index.json $REQUIRED_GAME_FILES; do
  case "$f" in runtime/*|snapshots/*|profiles/*) src="client/dist/$f" ;; *) src="$OUT/$f" ;; esac
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
npx wrangler deploy "$@"
echo "deployed. If scripts/upload-artifacts.sh ran for this deploy (a runtime or snapshot change), run NOW:"
echo "  scripts/upload-artifacts.sh --post-deploy"
echo "(it replaces snapshots/index.json and profiles/index.json in R2; until then this shell reads the outgoing ones)"
# In CI the log above is easy to miss: also annotate the run, which shows on
# its summary page (a GitHub Actions workflow command; nothing elsewhere).
# The title is a property: no ':' or ',' in it unescaped.
if [ "${GITHUB_ACTIONS:-}" = true ]; then
  echo "::notice title=Shell deployed - run the post-deploy upload::If scripts/upload-artifacts.sh ran before this deploy (a runtime or snapshot change), run scripts/upload-artifacts.sh --post-deploy now (wasm/DEPLOY.md, Deploy in order)."
fi
