#!/bin/bash
# Upload this site's own artifacts into R2 under the lean4game/ prefix of the
# bucket shared with the QED64 editor: the game snapshots, every .snapz under
# client/public/snapshots, all digest-named. The Lean runtime and the core
# pack are NOT ours: they are the lean4 fork's release
# (wasm/lean4-wasm64-release.json), uploaded once under
# lean4-wasm64/<release id>/ by the release owner (the fork's
# wasm64-build/stage-release.sh prints the commands) and proxied by
# infra/worker.js. This script refuses to run until that prefix holds the
# exact release the snapshots were baked against.
#
# NO INDEX GOES UP. /snapshots/index.json and /profiles/index.json ship in the
# deploy (the tracked client/public files, served from the Worker's static
# assets: QED64's architecture review D2, wasm/DEPLOY.md "Deploy, in order"),
# so this upload changes nothing a deployed shell reads: a new .snapz is inert
# in R2 until the deploy of the index that names it. Run it BEFORE the push: the
# deploy's guard (scripts/deploy-guard.mjs) refuses until every .snapz the
# tracked index names answers on the live origin.
#
# R2's own lean4game/snapshots/index.json, lean4game/profiles/index.json and
# their per-runtime copies (snapshots/index.<buildId>.json,
# snapshots/profiles-index.<buildId>.json) date from the two-step upload this
# replaces (until 2026-11). They are never written again, and stay frozen while
# a Worker version from before the change, which reads them, is a rollback
# target: never run an upload-artifacts.sh from before the change, which would
# rewrite them.
#
# Environment: R2_REMOTE (qed64-r2), R2_BUCKET (qed64-artifacts), R2_PREFIX
# (lean4game): where the site's objects go.
#
# S3-compatible API via rclone: wrangler's `r2 object put` caps single
# objects at ~300 MiB and a fat game snapshot is ~430 MB, so rclone does
# multipart uploads. Digest-named files make re-runs cheap: only changed
# files transfer.
#
# `rclone copy` (NOT sync): an upload must never delete the artifacts the
# deployed shell, open tabs and every rollback target still point at. Old
# digest-named files are harmless; garbage-collect them deliberately, later
# (wasm/DEPLOY.md, "R2 clean-up"). Rollback = revert and push (wasm/DEPLOY.md,
# "Rollback").
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
REC=wasm/lean4-wasm64-release.json
for arg in "$@"; do
  echo "upload-artifacts: unknown argument $arg" >&2; echo "usage: scripts/upload-artifacts.sh" >&2; exit 2
done
command -v rclone >/dev/null || { echo "rclone required: brew install rclone" >&2; exit 2; }
SITE="$REMOTE:$BUCKET/$PREFIX"

node scripts/preflight-artifacts.mjs "$PUB"

# The shared release must be in R2, byte for byte the record we baked
# against, and its runtime must be the one the snapshots pair with: the
# worker serves /runtime/* and /profiles/* from it, so a deployed index naming
# these snapshots before it would point every visitor at 404s. The deploy's
# guard asks the live origin only about .snapz (scripts/deploy-guard.mjs says
# why): this is the check of the release-mapped files.
RELEASE_ID=$(node -p 'require(process.argv[1]).id' "$PWD/$REC")
RUNTIME_ID=$(node -p 'require(process.argv[1]).runtime.buildId' "$PWD/$REC")
RELEASE_R2="$REMOTE:$BUCKET/lean4-wasm64/$RELEASE_ID"
SERVED_ID=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1] + "/runtime/runtime-manifest.json","utf8")).buildId' "$PUB")
# (preflight-artifacts.mjs has already checked every snapshot and the profile index pair with the served runtime)
[ "$SERVED_ID" = "$RUNTIME_ID" ] || { echo "client/public/runtime is $SERVED_ID but $REC is $RELEASE_ID ($RUNTIME_ID): rerun wasm/build-from-source.sh --lanes release,bundle" >&2; exit 3; }
TMP_REC=$(mktemp); trap 'rm -f "$TMP_REC"' EXIT
if ! rclone cat "$RELEASE_R2/release.json" > "$TMP_REC" 2>/dev/null || ! cmp -s "$TMP_REC" "$REC"; then
  echo "R2 has no lean4-wasm64/$RELEASE_ID/release.json equal to $REC." >&2
  echo "Upload the release first (from the lean4 fork's staged release dir; HOSTING.md, \"Where a release lives\"):" >&2
  echo "  R2=$REMOTE:$BUCKET/lean4-wasm64/$RELEASE_ID/" >&2
  echo "  rclone copy <release dir> \$R2 --immutable --s3-no-check-bucket --checksum --filter '- *.json' --filter '- SHA256SUMS' --header-upload 'Content-Type: application/octet-stream' --transfers 4 --s3-chunk-size 64M" >&2
  echo "  rclone copy <release dir> \$R2 --immutable --s3-no-check-bucket --checksum --filter '- /release.json' --filter '+ *.json' --filter '+ /SHA256SUMS' --filter '- *' --header-upload 'Content-Type: application/json'" >&2
  echo "  rclone copyto <release dir>/release.json \${R2}release.json --immutable --s3-no-check-bucket --header-upload 'Content-Type: application/json'" >&2
  exit 3
fi
echo "release $RELEASE_ID present in R2 (release.json matches $REC; runtime $RUNTIME_ID)"

# Live progress in a terminal; periodic one-line stats when logged to a file.
# Snapshots are one .snapz per catalog game (100–430 MB each, multipart) —
# without --progress a big file shows nothing for minutes and looks stuck.
# Already-uploaded digest-named files are skipped.
if [ -t 1 ]; then STATS=(--progress); else STATS=(--stats 10s --stats-one-line); fi
COMMON=(--checksum --transfers 4 --s3-chunk-size 64M --s3-upload-concurrency 4 "${STATS[@]}")
# rclone filter semantics (verified with `rclone copy --dry-run` on 1.75):
# `--include` implies "exclude everything else", so this sends no index and no
# copy, whatever the local tree holds (QED64's bake writes index.<buildId>.json
# beside its index; leftovers of the per-runtime copies stay local).
echo "== snapshots ($(du -sh "$PUB/snapshots" | cut -f1), $(find "$PUB/snapshots" -type f -name '*.snapz' | wc -l | tr -d ' ') .snapz) → $SITE/snapshots"
rclone copy "$PUB/snapshots" "$SITE/snapshots" --include '*.snapz' "${COMMON[@]}"
echo "upload complete; nothing a deployed shell reads has changed — R2 view:"
rclone ls "$SITE/snapshots" | sort -k2 || true
echo "next: the push (or scripts/deploy-app.sh); its guard refuses until every .snapz the tracked index names answers on the live origin"
