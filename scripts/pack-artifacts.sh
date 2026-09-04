#!/usr/bin/env bash
# Pack the served wasm64 artifacts that live outside git into per-class
# tarballs for publishing (GitHub release assets or the R2 bucket), and
# record their digests in wasm/artifacts/BUNDLE.json (tracked) so
# scripts/fetch-artifacts.sh can verify any downloaded copy.
#
# Usage: scripts/pack-artifacts.sh <tag> [--mathlib <dir>]
#   <tag>            e.g. artifacts-2026-09-02
#   --mathlib <dir>  also pack the Mathlib olean pack (mathlib-essential
#                    manifest + parts in <dir>, ~1 GB) as mathlib-pack.tar —
#                    only needed for from-source builds (build-from-source.sh),
#                    fetched with fetch-artifacts.sh --mathlib
# Output: wasm/out/artifacts/<tag>/{runtime,profiles,snapshots}.tar + SHA256SUMS
#
# Classes (all under client/public/): runtime/ (Lean runtime chunks +
# manifest), profiles/ (core library pack), snapshots/ (environment
# snapshots + index). Gamedata (data/) and the worker scripts are in git /
# vendored and are NOT part of the bundle. Tarballs are plain (the members
# are already compressed) and built from a sorted file list.
set -euo pipefail
TAG="${1:?tag, e.g. artifacts-2026-09-02}"; shift
MATHLIB=""
while [ $# -gt 0 ]; do case "$1" in --mathlib) MATHLIB="$(cd "${2:?dir}" && pwd)"; shift 2 ;; *) echo "unknown option $1" >&2; exit 2 ;; esac; done
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUB="$ROOT/client/public"
OUT="$ROOT/wasm/out/artifacts/$TAG"
mkdir -p "$OUT" "$ROOT/wasm/artifacts"
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
entries=()
for cls in runtime profiles snapshots; do
  [ -d "$PUB/$cls" ] || { echo "missing $PUB/$cls" >&2; exit 1; }
  tarball="$OUT/$cls.tar"
  ( cd "$PUB" && find "$cls" -type f | LC_ALL=C sort | tar -cf "$tarball" --no-recursion -T - )
  bytes=$(stat -f %z "$tarball" 2>/dev/null || stat -c %s "$tarball")
  digest=$(sha "$tarball")
  files=$(cd "$PUB" && find "$cls" -type f | wc -l | tr -d ' ')
  entries+=("{\"class\":\"$cls\",\"file\":\"$cls.tar\",\"bytes\":$bytes,\"sha256\":\"$digest\",\"files\":$files}")
  echo "$cls.tar  $bytes B  sha256 $digest  ($files files)"
done
if [ -n "$MATHLIB" ]; then
  [ -f "$MATHLIB/mathlib-essential.manifest.json" ] || { echo "no mathlib-essential.manifest.json in $MATHLIB" >&2; exit 1; }
  tarball="$OUT/mathlib-pack.tar"
  ( cd "$MATHLIB" && { echo mathlib-essential.manifest.json; ls mathlib-essential.pack.gzip.*.part-*; } | LC_ALL=C sort | tar -cf "$tarball" --no-recursion -T - )
  bytes=$(stat -f %z "$tarball" 2>/dev/null || stat -c %s "$tarball"); digest=$(sha "$tarball")
  files=$(( 1 + $(ls "$MATHLIB"/mathlib-essential.pack.gzip.*.part-* | wc -l) ))
  entries+=("{\"class\":\"mathlib\",\"file\":\"mathlib-pack.tar\",\"bytes\":$bytes,\"sha256\":\"$digest\",\"files\":$files,\"optional\":true,\"extract_into\":\"wasm/out/mathlib-pack\"}")
  echo "mathlib-pack.tar  $bytes B  sha256 $digest  ($files files, optional: from-source builds only)"
fi
( cd "$OUT" && shasum -a 256 *.tar > SHA256SUMS )
runtime_id=$(python3 -c "import json;print(json.load(open('$PUB/runtime/runtime-manifest.json'))['buildId'])")
snaps=$(python3 -c "import json;print(','.join(sorted(s['name']+'='+s['digest'][7:23] for s in json.load(open('$PUB/snapshots/index.json'))['snapshots'])))")
python3 - "$ROOT/wasm/artifacts/BUNDLE.json" "$TAG" "$runtime_id" "$snaps" "${entries[@]}" <<'PY'
import json, sys
out, tag, runtime, snaps, *entries = sys.argv[1:]
doc = {
  "schema": "lean4game.artifact-bundle/v1",
  "tag": tag,
  "runtime": runtime,
  "snapshots": snaps,
  "extract_into": "client/public",
  "tarballs": [json.loads(e) for e in entries],
  "note": "Tarballs are plain tar of client/public/<class>/ (paths relative to client/public). Per-file digests live in the tracked manifests (runtime/runtime-manifest.json, snapshots/index.json, profiles/lean-core.manifest.json).",
}
json.dump(doc, open(out, "w"), indent=1); open(out, "a").write("\n")
print("wrote", out)
PY
echo "publish e.g.:  gh release create $TAG $OUT/*.tar $OUT/SHA256SUMS --repo FawadHa1der/lean4game --title '$TAG' --notes 'wasm64 artifacts (runtime $runtime_id)'"
