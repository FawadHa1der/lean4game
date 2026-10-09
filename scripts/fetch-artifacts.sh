#!/usr/bin/env bash
# Fetch the served wasm64 artifacts (runtime chunks, core library pack,
# environment snapshots) into client/public/ and verify them against the
# tracked digests in wasm/artifacts/BUNDLE.json.
#
# Usage:
#   scripts/fetch-artifacts.sh                       # from the GitHub release named in BUNDLE.json
#   scripts/fetch-artifacts.sh --base <url-prefix>   # any HTTP host serving <prefix>/<class>.tar
#   scripts/fetch-artifacts.sh --from-dir <dir>      # local tarballs (e.g. wasm/out/artifacts/<tag>)
#   scripts/fetch-artifacts.sh --mathlib             # also the optional Mathlib olean pack (from-source builds)
#
# Downloads go to wasm/out/fetch/<tag>/ and are reused when their digest
# already matches. Extraction refuses a tarball whose sha256 differs from
# BUNDLE.json. A tarball BUNDLE.json lists with `parts` (one over GitHub's
# 2 GiB asset limit, scripts/pack-artifacts.sh) is fetched as those pieces,
# each checked, then joined and checked whole. The tag is published by hand
# after the bundle lane (wasm/KERNEL.md, "Rebuilding from a clone"); until
# then the release download
# answers 404 — use --from-dir wasm/out/artifacts/<tag> on the machine that
# packed it. After this, `scripts/stage-game-assets.sh` (workers from the
# qed64 package) and `npm --workspace client run build` give a runnable
# client/dist; `node scripts/serve-dist.mjs` serves it with the COOP/COEP
# headers the wasm worker needs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE="$ROOT/wasm/artifacts/BUNDLE.json"
PUB="$ROOT/client/public"
MODE=release; SRC=""; WANT_MATHLIB=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) MODE=base; SRC="${2:?url}"; shift 2 ;;
    --from-dir) MODE=dir; SRC="$(cd "${2:?dir}" && pwd)"; shift 2 ;;
    --mathlib) WANT_MATHLIB=1; shift ;;
    -h|--help) sed -n 2,23p "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ -f "$BUNDLE" ] || { echo "missing $BUNDLE" >&2; exit 1; }
TAG=$(python3 -c "import json;print(json.load(open('$BUNDLE'))['tag'])")
[ "$MODE" = release ] && SRC="https://github.com/FawadHa1der/lean4game/releases/download/$TAG"
CACHE="$ROOT/wasm/out/fetch/$TAG"; mkdir -p "$CACHE" "$PUB"
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
# fetch_one <file> <sha256> <bytes>: one published file into the cache, verified
fetch_one() {
  local f="$1" want="$2" n="$3" got
  case "$MODE" in
    dir) cp "$SRC/$f" "$CACHE/$f" ;;
    *) echo "downloading $SRC/$f ($n B)"
       curl -fL --retry 3 -o "$CACHE/$f" "$SRC/$f" || {
         rm -f "$CACHE/$f"
         echo "could not download $SRC/$f — if this is the GitHub release of $TAG, it may not be published yet (wasm/KERNEL.md, \"Rebuilding from a clone\"); the machine that packed it can use --from-dir wasm/out/artifacts/$TAG" >&2; exit 1; } ;;
  esac
  got=$(sha "$CACHE/$f")
  if [ "$got" != "$want" ]; then
    echo "DIGEST MISMATCH for $f: expected $want got $got — refusing to extract" >&2; rm -f "$CACHE/$f"; exit 1
  fi
}
python3 -c "import json;[print(t['file'],t['sha256'],t['bytes'],t['class'],t.get('extract_into','client/public'),int(bool(t.get('optional'))),' '.join(p['file']+':'+p['sha256']+':'+str(p['bytes']) for p in t.get('parts',[])) or '-') for t in json.load(open('$BUNDLE'))['tarballs']]" | while read -r file digest bytes cls into optional parts; do
  if [ "$optional" = 1 ] && [ "$WANT_MATHLIB" = 0 ]; then echo "$file: optional (from-source builds only), skipped — pass --mathlib to fetch it"; continue; fi
  DEST="$ROOT/$into"; mkdir -p "$DEST"
  local_tar="$CACHE/$file"
  if [ -f "$local_tar" ] && [ "$(sha "$local_tar")" = "$digest" ]; then
    echo "$file: cached copy verified"
  elif [ "$parts" = "-" ]; then
    fetch_one "$file" "$digest" "$bytes"
    echo "$file: sha256 verified"
  else
    # Published in pieces: each one checked, then the joined whole.
    : > "$local_tar"
    for p in $parts; do
      pf="${p%%:*}"; rest="${p#*:}"; fetch_one "$pf" "${rest%%:*}" "${rest#*:}"
      cat "$CACHE/$pf" >> "$local_tar"; rm -f "$CACHE/$pf"
    done
    got=$(sha "$local_tar")
    if [ "$got" != "$digest" ]; then
      echo "DIGEST MISMATCH for $file joined from its parts: expected $digest got $got — refusing to extract" >&2; rm -f "$local_tar"; exit 1
    fi
    echo "$file: joined from $(wc -w <<<"$parts" | tr -d ' ') parts, sha256 verified"
  fi
  if [ "$into" = "client/public" ]; then rm -rf "$PUB/$cls"; tar -xf "$local_tar" -C "$PUB"; echo "  extracted into client/public/$cls ($(find "$PUB/$cls" -type f | wc -l | tr -d ' ') files)"
  else rm -rf "$DEST"; mkdir -p "$DEST"; tar -xf "$local_tar" -C "$DEST"; echo "  extracted into $into ($(find "$DEST" -type f | wc -l | tr -d ' ') files)"; fi
done
# Pairing stamps: every snapshot entry should name the runtime build id that
# baked it (the worker refuses a mismatched snapshot instead of trapping).
# Bundles packed before the stamp existed carry none; add them from the
# runtime manifest of the same bundle (idempotent).
python3 - "$PUB" <<'PY'
import json, os, sys
pub = sys.argv[1]; ip = os.path.join(pub, "snapshots/index.json"); rp = os.path.join(pub, "runtime/runtime-manifest.json")
if os.path.exists(ip) and os.path.exists(rp):
    idx = json.load(open(ip)); rid = json.load(open(rp))["buildId"]; changed = 0
    for e in idx.get("snapshots", []):
        if not e.get("runtime"): e["runtime"] = rid; changed += 1
    if changed:
        json.dump(idx, open(ip, "w"), indent=1); open(ip, "a").write("\n"); print(f"snapshot index: stamped runtime {rid} on {changed} entries")
PY
# The per-runtime index copies (QED64 HARDENING #64) and the pinned runtime
# manifest runtime/runtime-manifest.<buildId>.json are derived, gitignored
# files: a bundle packed before them has none, and a stamp above rewrites
# index.json under them, so all three are (re)written from the tree as it now
# is. Not fatal here (a local tree still serves online without them — offline
# boots need the pinned manifest); the upload's preflight refuses a tree
# whose copies are missing or stale.
if [ -f "$PUB/snapshots/index.json" ] && [ -f "$PUB/profiles/index.json" ]; then
  python3 "$ROOT/scripts/stage-snapshots.py" --copies || echo "warning: no per-runtime copies written (scripts/preflight-artifacts.mjs will refuse to upload this tree)" >&2
fi
# Cross-check the extracted runtime against its tracked manifest (the loader
# verifies every chunk again at boot; this fails early instead).
python3 - "$PUB" <<'PY'
import hashlib, json, os, sys
pub = sys.argv[1]
m = json.load(open(os.path.join(pub, "runtime/runtime-manifest.json")))
bad = 0
for f in m["files"].values():
    for part in f.get("parts", f.get("chunks", [])):
        name = os.path.basename(part.get("url") or part.get("name") or part.get("file") or "")
        d = part.get("sha256") or part.get("digest", "")
        d = d.split(":")[-1]
        p = os.path.join(pub, "runtime", "chunks", name)
        if not os.path.isfile(p): print("missing chunk", name); bad += 1; continue
        if d and hashlib.sha256(open(p, "rb").read()).hexdigest() != d: print("chunk digest mismatch", name); bad += 1
print("runtime chunks:", "all verified" if not bad else f"{bad} problems")
sys.exit(1 if bad else 0)
PY
echo "done: runtime $(python3 -c "import json;print(json.load(open('$PUB/runtime/runtime-manifest.json'))['buildId'])"), snapshots $(python3 -c "import json;print(', '.join(s['name'] for s in json.load(open('$PUB/snapshots/index.json'))['snapshots']))")"
