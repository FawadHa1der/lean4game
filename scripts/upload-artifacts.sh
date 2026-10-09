#!/bin/bash
# Upload this site's own artifacts into R2 under the lean4game/ prefix of the
# bucket shared with the QED64 editor: the game snapshots, the site's
# pointers /snapshots/index.json and /profiles/index.json (release.json
# hosting.siteOwned) and their per-runtime copies. The Lean runtime and the
# core pack are NOT ours: they are the lean4 fork's release
# (wasm/lean4-wasm64-release.json), uploaded once under
# lean4-wasm64/<release id>/ by the release owner (the fork's
# wasm64-build/stage-release.sh prints the commands) and proxied by
# infra/worker.js. This script refuses to run until that prefix holds the
# exact release the snapshots were baked against.
#
# TWO STEPS, AROUND THE DEPLOY (QED64 HARDENING #64). snapshots/index.json and
# profiles/index.json are MUTABLE pointers the deployed shell reads, and a
# shell refuses every snapshot entry baked for another runtime than its own
# ("not published for this build"). Replacing them while the deployed shell
# is still paired with the outgoing runtime breaks every game boot until the
# new shell is live: QED64's landing on 2026-10-08 did exactly that (upload,
# then the deploy; ~10 minutes of failed boots). So:
#
#   scripts/upload-artifacts.sh               BEFORE the deploy (the default)
#       preflight, the release check, then only objects no deployed shell
#       reads yet: the digest-named .snapz, then this runtime's per-runtime
#       copies snapshots/index.<buildId>.json and
#       snapshots/profiles-index.<buildId>.json (byte-identical to the two
#       mutable files; scripts/stage-snapshots.py writes them). Never the
#       mutable indexes.
#   scripts/deploy-app.sh                     the new shell and worker
#   scripts/upload-artifacts.sh --post-deploy IMMEDIATELY after the deploy
#       refuses (exit 3) unless $SITE_URL/runtime/runtime-manifest.json
#       already names the record's runtime (the old worker serves the old
#       runtime's manifest, the new one the release's) and R2 holds what the
#       first step uploads. Then it pins what R2 serves now: when R2's mutable
#       index pairs with a runtime whose copy R2 lacks, that index is copied
#       to the copy's name inside R2 (rclone copyto remote→remote; an
#       existing copy is never overwritten). The snapshot copy keeps a paired
#       snapshot index for a shell still paired with the outgoing runtime
#       that reads copies; the profile copy is for a rollback only (its
#       /profiles/ manifest path follows the deployed worker's release, so
#       under the new worker it names the new release's core pack). Then it
#       uploads snapshots/index.json, then profiles/index.json.
#
# The live pre-#64 shell (it reads only the mutable indexes) keeps working
# until --post-deploy. Between the deploy and --post-deploy the new shell
# finds the outgoing snapshots/index.json mispaired and reads its own copy,
# snapshots/index.<buildId>.json, which the first step uploaded (the client
# passes pairedBuildId to qed64's loadSnapshotIndex since the QED64 385a1ac
# pin; wasm/DEPLOY.md), so its game boots work through that window; run
# --post-deploy right after the deploy all the same. A snapshot-only change (same runtime) takes the same two steps,
# but --post-deploy's live check passes at once: it compares only the
# runtime build id, so it cannot tell an old shell from a new one of the
# same runtime. When such a change also ships a shell change (a new game
# list, changed level data), run --post-deploy only once that deploy is
# confirmed; it prints a note when R2's index already pairs with this
# runtime. Both steps are idempotent.
#
# Environment: R2_REMOTE (qed64-r2), R2_BUCKET (qed64-artifacts), R2_PREFIX
# (lean4game): where the site's objects go; SITE_URL
# (https://lean4game.fawadworkaddress.workers.dev): the site --post-deploy
# checks.
#
# S3-compatible API via rclone: wrangler's `r2 object put` caps single
# objects at ~300 MiB and a fat game snapshot is ~430 MB, so rclone does
# multipart uploads. Digest-named files make re-runs cheap: only changed
# files transfer.
#
# `rclone copy` (NOT sync): a promote must never delete the artifacts the
# currently-deployed shell still points at. Old digest-named files and other
# runtimes' copies are harmless; garbage-collect them deliberately, later.
# Rollback = re-publish the previous indexes (wasm/DEPLOY.md, "Rollback").
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
SITE_URL=${SITE_URL:-https://lean4game.fawadworkaddress.workers.dev}
PUB=client/public
REC=wasm/lean4-wasm64-release.json
USAGE="usage: scripts/upload-artifacts.sh [--post-deploy]"
POST_DEPLOY=0
for arg in "$@"; do
  case "$arg" in
    --post-deploy) POST_DEPLOY=1 ;;
    *) echo "upload-artifacts: unknown argument $arg" >&2; echo "$USAGE" >&2; exit 2 ;;
  esac
done
command -v rclone >/dev/null || { echo "rclone required: brew install rclone" >&2; exit 2; }
SITE="$REMOTE:$BUCKET/$PREFIX"

node scripts/preflight-artifacts.mjs "$PUB"

# The shared release must be in R2, byte for byte the record we baked
# against, and its runtime must be the one the snapshots pair with: the
# worker serves /runtime/* and /profiles/* from it, so a snapshot index
# published before it would point every visitor at 404s.
RELEASE_ID=$(node -p 'require(process.argv[1]).id' "$PWD/$REC")
RUNTIME_ID=$(node -p 'require(process.argv[1]).runtime.buildId' "$PWD/$REC")
RELEASE_R2="$REMOTE:$BUCKET/lean4-wasm64/$RELEASE_ID"
SERVED_ID=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1] + "/runtime/runtime-manifest.json","utf8")).buildId' "$PUB")
# (preflight-artifacts.mjs has already checked every snapshot and both index copies pair with the served runtime)
[ "$SERVED_ID" = "$RUNTIME_ID" ] || { echo "client/public/runtime is $SERVED_ID but $REC is $RELEASE_ID ($RUNTIME_ID): rerun wasm/build-from-source.sh --lanes release,bundle" >&2; exit 3; }
TMP_REC=$(mktemp); TMP_BODY=$(mktemp); ERR=$(mktemp); trap 'rm -f "$TMP_REC" "$TMP_BODY" "$ERR"' EXIT
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
# Single files: --s3-no-check-bucket because an object-scoped R2 token may not
# create buckets, and a single-file copyto otherwise tries to (QED64 saw 403
# AccessDenied on CreateBucket).
ONE=(--checksum --s3-no-check-bucket)
# This runtime's per-runtime copies: the same path locally and under $SITE
# (preflight-artifacts.mjs checked both are byte-identical to their index).
COPIES=("snapshots/index.$RUNTIME_ID.json" "snapshots/profiles-index.$RUNTIME_ID.json")

if [ "$POST_DEPLOY" = 0 ]; then
  # ---- pre-deploy (the default): nothing a deployed shell reads changes.
  # Phased so a reader never sees a name whose object is not there yet (R2
  # has no multi-object atomic publish): first the digest-named snapshots,
  # then the copies that name them. rclone filter semantics (verified with
  # `rclone copy --dry-run` on 1.75): `--include` implies "exclude everything
  # else", so the .snapz phase sends no index and no copy.
  echo "== snapshots ($(du -sh "$PUB/snapshots" | cut -f1), $(find "$PUB/snapshots" -type f -name '*.snapz' | wc -l | tr -d ' ') .snapz) → $SITE/snapshots"
  rclone copy "$PUB/snapshots" "$SITE/snapshots" --include '*.snapz' "${COMMON[@]}"
  echo "== the per-runtime index copies of $RUNTIME_ID (no deployed shell reads them yet) → $SITE/snapshots"
  for c in "${COPIES[@]}"; do rclone copyto "$PUB/$c" "$SITE/$c" "${ONE[@]}" "${STATS[@]}"; done
  echo "pre-deploy upload complete; R2's snapshots/index.json and profiles/index.json are untouched — R2 view:"
  # (|| true: head closing the pipe early must not fail a finished upload)
  rclone ls "$SITE/snapshots" | sort -k2 | head -40 || true
  echo "next, in this order:"
  echo "  1. scripts/deploy-app.sh   (or the push that runs it in CI)"
  echo "  2. as soon as it is live:  scripts/upload-artifacts.sh --post-deploy"
  echo "     (replaces snapshots/index.json and profiles/index.json; until then the new shell reads the outgoing ones)"
  exit 0
fi

# ---- --post-deploy, right after the deploy.
# Every R2 read here fails CLOSED (as QED64's upload does): only what rclone
# answers as not there (nothing listed, or its not-found exits 3/4) is
# absent; any other failure (no remote, credentials, network, a 5xx) is no
# answer and refuses, exit 3, before the first write.
r2_fail() {
  local first
  first=$(grep -m1 . "$ERR" | tr -d '\r' || true)
  echo "upload-artifacts: REFUSED: cannot read R2 ($1 exit $2): ${first:-no error output}" >&2
  exit 3
}
# r2_lsf <key>: LISTED = "size;name" lines of $SITE/<key> (empty: absent).
r2_lsf() {
  local rc=0
  LISTED=$(rclone lsf "$SITE/$1" --files-only --format sp 2>"$ERR") || rc=$?
  case "$rc" in 0) ;; 3|4) LISTED="" ;; *) r2_fail "rclone lsf $1" "$rc" ;; esac
}
# r2_cat <key> <file>: $SITE/<key>'s bytes into <file>.
r2_cat() {
  local rc=0
  rclone cat "$SITE/$1" >"$2" 2>"$ERR" || rc=$?
  [ "$rc" = 0 ] || r2_fail "rclone cat $1" "$rc"
}
# listed <name>: whether the snapshots/ listing ($SNAPS) holds that file.
listed() { awk -F';' -v n="$1" '$2 == n { f = 1 } END { exit !f }' <<<"$SNAPS"; }
# The one runtime the index JSON on stdin pairs with (a snapshot index's
# entries, or a profile index's runtime.buildId), or nothing (unparseable,
# mixed, none).
index_runtime() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const j = JSON.parse(s);
        const ids = new Set(Array.isArray(j.snapshots) ? j.snapshots.map((e) => e && e.runtime) : [j.runtime && j.runtime.buildId]);
        const [id] = ids;
        if (ids.size === 1 && /^wasm64-[0-9a-f]{16}$/.test(String(id))) console.log(id);
      } catch {}
    });'
}

# 1. The new shell must be live. /runtime/* is the release's under the new
# worker and lean4game/runtime/ under the pre-shared-release one, so the live
# manifest's buildId says which worker answers.
live_rc=0
curl -fsS --max-time 30 -H 'Cache-Control: no-cache' -o "$TMP_BODY" "$SITE_URL/runtime/runtime-manifest.json" 2>"$ERR" || live_rc=$?
if [ "$live_rc" != 0 ]; then
  echo "upload-artifacts: REFUSED: cannot read $SITE_URL/runtime/runtime-manifest.json (curl exit $live_rc: $(grep -m1 . "$ERR" | tr -d '\r' || true)); nothing written" >&2
  exit 3
fi
LIVE_ID=$(node -e 'try { console.log(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).buildId ?? "")); } catch { console.log(""); }' "$TMP_BODY")
if [ "$LIVE_ID" != "$RUNTIME_ID" ]; then
  echo "upload-artifacts: REFUSED: $SITE_URL serves runtime ${LIVE_ID:-(no buildId)}, the release record is $RUNTIME_ID: the new shell is not live yet." >&2
  echo "  Deploy it first (scripts/deploy-app.sh, or the push that runs it), then rerun scripts/upload-artifacts.sh --post-deploy." >&2
  echo "  Replacing the mutable indexes now would point the deployed shell at snapshots it refuses (HARDENING #64); nothing written." >&2
  exit 3
fi
echo "live: $SITE_URL serves runtime $LIVE_ID"

# 2. R2 must hold what the pre-deploy step uploads — every .snapz the index
# names (by size) and this runtime's copies (byte for byte) — or the index
# would name objects that are not there.
r2_lsf snapshots
SNAPS=$LISTED
# shellcheck disable=SC2016  # ${…} below is a JavaScript template literal
lacking=$(node -e '
  const fs = require("fs"), path = require("path");
  const [pub, listing, ...copies] = process.argv.slice(1);
  const have = new Map(listing.split("\n").filter(Boolean).map((l) => [l.slice(l.indexOf(";") + 1), Number(l.slice(0, l.indexOf(";")))]));
  const names = JSON.parse(fs.readFileSync(pub + "/snapshots/index.json", "utf8")).snapshots.map((s) => path.basename(s.url));
  for (const n of [...names, ...copies.map((c) => path.basename(c))]) {
    const size = fs.statSync(pub + "/snapshots/" + n).size;
    if (have.get(n) !== size) console.log(n + (have.has(n) ? ` (R2 ${have.get(n)} B, local ${size} B)` : ""));
  }' "$PUB" "$SNAPS" "${COPIES[@]}")
if [ -z "$lacking" ]; then
  for c in "${COPIES[@]}"; do r2_cat "$c" "$TMP_BODY"; cmp -s "$TMP_BODY" "$PUB/$c" || lacking+="${c#snapshots/} (differs from the local copy)"$'\n'; done
fi
if [ -n "$lacking" ]; then
  echo "upload-artifacts: REFUSED: R2's $PREFIX/snapshots/ lacks what scripts/upload-artifacts.sh (the pre-deploy step) uploads:" >&2
  printf '%s\n' "$lacking" | sed '/^$/d; s/^/  /' >&2
  echo "  Run scripts/upload-artifacts.sh first (it sends only what is missing), then --post-deploy; nothing written." >&2
  exit 3
fi

# 3. Pin what R2 serves now, before replacing it: every read comes before
# the first copy, so a refusal writes nothing.
pins=()
same_runtime=0
for pair in snapshots/index.json:snapshots/index profiles/index.json:snapshots/profiles-index; do
  src=${pair%%:*}
  if [ "$src" = snapshots/index.json ]; then listed index.json || continue; else r2_lsf "$src"; [ -n "$LISTED" ] || continue; fi
  r2_cat "$src" "$TMP_BODY"
  live=$(index_runtime <"$TMP_BODY")
  # R2's snapshot index already pairs with this runtime: a same-runtime
  # change, for which the live check of 1. passed before the deploy too.
  if [ "$src" = snapshots/index.json ] && [ "$live" = "$RUNTIME_ID" ]; then same_runtime=1; fi
  # An index that names no single runtime has nothing to pin; one of this
  # runtime has its copy from the pre-deploy step.
  [ -n "$live" ] && [ "$live" != "$RUNTIME_ID" ] || continue
  dst="${pair#*:}.$live.json"
  listed "${dst#snapshots/}" && continue
  echo "R2's $src pairs with $live, which has no $dst yet: copying it there first (HARDENING #64)"
  pins+=("$src:$dst")
done
for pin in ${pins[@]+"${pins[@]}"}; do
  rclone copyto "$SITE/${pin%%:*}" "$SITE/${pin#*:}" --s3-no-check-bucket
done

# 4. The mutable indexes, the snapshot index first (the profile index stays
# the last word, as before). A same-runtime change gets a note, not a
# refusal: nothing here identifies the shell build, and with no shell change
# at all this step may follow the pre-deploy step directly.
if [ "$same_runtime" = 1 ]; then
  echo "note: R2's snapshots/index.json already pairs with $RUNTIME_ID (a same-runtime change), so the live check above passes with the old shell too and cannot tell whether this change's deploy has landed."
  echo "      If this change ships a shell change (a new game list, changed level data), that deploy must be confirmed live before this step (wasm/DEPLOY.md, \"Deploy, in order\")."
fi
echo "== the mutable indexes (the shell of $RUNTIME_ID is live) → $SITE"
rclone copyto "$PUB/snapshots/index.json" "$SITE/snapshots/index.json" "${ONE[@]}" "${STATS[@]}"
rclone copyto "$PUB/profiles/index.json" "$SITE/profiles/index.json" "${ONE[@]}" "${STATS[@]}"
echo "post-deploy upload complete — R2 view:"
rclone ls "$SITE/snapshots" | sort -k2 | head -40 || true
rclone ls "$SITE/profiles/index.json" || true
