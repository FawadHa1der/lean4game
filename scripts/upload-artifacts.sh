#!/bin/bash
# Upload the served artifacts (runtime chunks, the Lean core profile pack,
# game snapshots) into R2 under the lean4game/ prefix of the bucket shared
# with the QED64 editor, via the S3-compatible API: wrangler's `r2 object put`
# caps single objects at ~300 MiB and nng4.snapz is 428 MB, so rclone does
# multipart uploads. Digest-named files make re-runs cheap: only changed
# files transfer.
#
# `rclone copy` (NOT sync): a promote must never delete the artifacts the
# currently-deployed shell still points at. Old digest-named files are
# harmless; garbage-collect them deliberately, later.
#
# One-time rclone remote setup (an R2 API token scoped to the bucket; see
# QED64's docs/DEPLOY.md — never commit it):
#   rclone config create qed64-r2 s3 provider=Cloudflare \
#     access_key_id=$R2_ACCESS_KEY_ID secret_access_key=$R2_SECRET_ACCESS_KEY \
#     endpoint=https://$CF_ACCOUNT_ID.r2.cloudflarestorage.com acl=private
set -euo pipefail
cd "$(dirname "$0")/.."
REMOTE=${R2_REMOTE:-qed64-r2}
BUCKET=${R2_BUCKET:-qed64-artifacts}
PREFIX=${R2_PREFIX:-lean4game}
PUB=client/public
command -v rclone >/dev/null || { echo "rclone required: brew install rclone" >&2; exit 2; }

node scripts/preflight-artifacts.mjs "$PUB"

# Immutable, per-build copy of the manifest (atomic promotes: the deployed
# shell asks for the manifest of the exact runtime it was built against).
# Gitignored; regenerated on every upload.
BUILD_ID=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1] + "/runtime/runtime-manifest.json","utf8")).buildId' "$PUB")
cp "$PUB/runtime/runtime-manifest.json" "$PUB/runtime/runtime-manifest.$BUILD_ID.json"

# Live progress in a terminal; periodic one-line stats when logged to a file.
# The snapshots are three single files (905 MB; nng4.snapz alone is 428 MB)
# uploaded multipart — without --progress a big file shows nothing for
# minutes and looks stuck. Already-uploaded digest-named files are skipped.
if [ -t 1 ]; then STATS=(--progress); else STATS=(--stats 10s --stats-one-line); fi
for dir in runtime profiles snapshots; do
  echo "== $dir ($(du -sh "$PUB/$dir" | cut -f1), $(find "$PUB/$dir" -type f | wc -l | tr -d ' ') files) → $REMOTE:$BUCKET/$PREFIX/$dir"
  rclone copy "$PUB/$dir" "$REMOTE:$BUCKET/$PREFIX/$dir" --checksum --transfers 4 --s3-chunk-size 64M --s3-upload-concurrency 4 "${STATS[@]}"
done
echo "artifact upload complete — R2 view:"
rclone ls "$REMOTE:$BUCKET/$PREFIX" | sort -k2 | head -30
