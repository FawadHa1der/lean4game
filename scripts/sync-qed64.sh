#!/usr/bin/env bash
# Vendor the qed64 substrate the game runs on, pinned to one qed64 commit.
#
# Usage: scripts/sync-qed64.sh <qed64-commit> [path-to-qed64-checkout]
#
# The game consumes exactly this closure from qed64 (no third-party imports):
#   frontend/src/{qed64-boot,resident-session,lsp-relay}.ts,
#   src/install/profiles.ts, src/runtime/{client,snapshots}.ts,
#   public/workers/{lean.worker,lsp-frames,lsp-front-door,snapshot-prefetch.worker}.js
# plus the worker scripts the page spawns:
#   public/workers/lean.worker.js, public/workers/snapshot-prefetch.worker.js
# and, from the byte-channel rewrite on, the decoder lean.worker.js loads
# with importScripts and therefore MUST be served beside it:
#   public/workers/lsp-frames.js
# It is extracted with `git archive` at the given commit (never from the
# working tree, so uncommitted edits in a shared checkout cannot leak in),
# into client/src/wasm/vendor/qed64/, and the pin is recorded in
# client/src/wasm/vendor/QED64-PIN. Bump = rerun with a newer commit, rebuild,
# run cypress, commit the diff.
set -euo pipefail
SHA="${1:?qed64 commit}"
QED64="${2:-$(cd "$(dirname "$0")/../../wasm64-lean-fable/qed64" && pwd)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/client/src/wasm/vendor/qed64"
# The resident closure (qed64 ≥ 32e5e62, pump transport removed): the session
# adapter with its boot policy, the L3 relay, boot/artifacts, runtime client,
# snapshot loader, install profiles; the worker plus the two scripts it
# importScripts (the LSP frame decoder and the resident front door, loaded at
# arm) and the prefetch worker. watchdog-shim.ts / umbrella.ts are gone.
PATHS=(frontend/src/qed64-boot.ts frontend/src/resident-session.ts frontend/src/lsp-relay.ts
       src/install/profiles.ts src/runtime/client.ts src/runtime/snapshots.ts
       public/workers/lean.worker.js public/workers/lsp-frames.js public/workers/lsp-front-door.js
       public/workers/snapshot-prefetch.worker.js)
OPTIONAL=()
# The pipeline scripts the from-source lane runs (wasm/build-from-source.sh):
# no third-party imports, vendored into a SEPARATE root so their work/ scratch
# dirs (work/snapshot, work/staging) never land under client/src.
PIPELINE=(pipeline/toolchain/chunk-runtime.mjs pipeline/toolchain/artifact-paths.mjs pipeline/toolchain/gen-exports.py pipeline/toolchain/gate.mjs pipeline/snapshot/persistent-probe.mjs
          pipeline/snapshot/bake-snapshot.mjs pipeline/snapshot/node-runner.mjs pipeline/snapshot/snapshot-probe.mjs
          pipeline/artifacts/pack.mjs pipeline/artifacts/unpack.mjs pipeline/artifacts/inspect.mjs
          pipeline/release/verify-release.mjs)
PIPELINE_OPTIONAL=(pipeline/toolchain/artifact-paths.d.mts)
PIPE_DEST="$ROOT/wasm/vendor/qed64-pipeline"
FULL="$(git -C "$QED64" rev-parse --verify "$SHA^{commit}")"
# Validate everything BEFORE touching the tree: a commit lacking a file must
# fail without leaving a half-vendored closure or an empty pipeline dir.
for pf in "${PATHS[@]}" "${PIPELINE[@]}"; do
  git -C "$QED64" cat-file -e "$FULL:$pf" 2>/dev/null || { echo "missing at ${FULL:0:12}: $pf (this commit predates a file the game needs; pick a newer one)" >&2; exit 1; }
done
# The two scripts lean.worker.js importScripts (the frame decoder and the
# front door) are in PATHS: a commit that lacks either fails validation above
# — the failure mode otherwise is a worker that never boots (every game
# session hangs), found only in the browser.
rm -rf "$DEST"; mkdir -p "$DEST"
git -C "$QED64" archive "$FULL" "${PATHS[@]}" | tar -x -C "$DEST"
for opt in ${OPTIONAL[@]+"${OPTIONAL[@]}"}; do
  if git -C "$QED64" cat-file -e "$FULL:$opt" 2>/dev/null; then git -C "$QED64" archive "$FULL" "$opt" | tar -x -C "$DEST"; PATHS+=("$opt"); fi
done
rm -rf "$PIPE_DEST"; mkdir -p "$PIPE_DEST"
git -C "$QED64" archive "$FULL" "${PIPELINE[@]}" | tar -x -C "$PIPE_DEST"
for opt in "${PIPELINE_OPTIONAL[@]}"; do
  if git -C "$QED64" cat-file -e "$FULL:$opt" 2>/dev/null; then git -C "$QED64" archive "$FULL" "$opt" | tar -x -C "$PIPE_DEST"; fi
done
# Sanity: the closure must be self-contained (every relative import resolves inside DEST).
python3 - "$DEST" <<'PY'
import os, re, sys
dest = sys.argv[1]; bad = []
for dp, _, fs in os.walk(dest):
    for f in fs:
        if not f.endswith('.ts'): continue
        p = os.path.join(dp, f)
        for m in re.finditer(r'from\s+["\'](\.[^"\']+)["\']', open(p).read()):
            t = os.path.normpath(os.path.join(dp, m.group(1)))
            if not any(os.path.isfile(c) for c in (t, t + '.ts', t + '.js', os.path.join(t, 'index.ts'))):
                bad.append((os.path.relpath(p, dest), m.group(1)))
if bad:
    print('unresolved imports inside the vendored closure:', bad); sys.exit(1)
PY
{
  echo "qed64 commit: $FULL"
  echo "date: $(git -C "$QED64" show -s --format=%ci "$FULL")"
  echo "subject: $(git -C "$QED64" show -s --format=%s "$FULL")"
  echo "files:"; for p in "${PATHS[@]}"; do printf '  %s  %s\n' "$(shasum -a 256 "$DEST/$p" | cut -c1-16)" "$p"; done
  echo "pipeline (wasm/vendor/qed64-pipeline):"; for p in "${PIPELINE[@]}"; do printf '  %s  %s\n' "$(shasum -a 256 "$PIPE_DEST/$p" | cut -c1-16)" "$p"; done
} > "$ROOT/client/src/wasm/vendor/QED64-PIN"
echo "vendored qed64 @ ${FULL:0:12}: closure → client/src/wasm/vendor/qed64, pipeline → wasm/vendor/qed64-pipeline (pin: client/src/wasm/vendor/QED64-PIN)"
