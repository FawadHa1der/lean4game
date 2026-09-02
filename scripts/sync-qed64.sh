#!/usr/bin/env bash
# Vendor the qed64 substrate the game runs on, pinned to one qed64 commit.
#
# Usage: scripts/sync-qed64.sh <qed64-commit> [path-to-qed64-checkout]
#
# The game consumes exactly this closure from qed64 (no third-party imports):
#   frontend/src/qed64-boot.ts, frontend/src/watchdog-shim.ts,
#   src/install/profiles.ts, src/runtime/{client,snapshots,umbrella}.ts
# plus the two worker scripts the page spawns:
#   public/workers/lean.worker.js, public/workers/snapshot-prefetch.worker.js
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
PATHS=(frontend/src/qed64-boot.ts frontend/src/watchdog-shim.ts
       src/install/profiles.ts src/runtime/client.ts src/runtime/snapshots.ts src/runtime/umbrella.ts
       public/workers/lean.worker.js public/workers/snapshot-prefetch.worker.js)
FULL="$(git -C "$QED64" rev-parse --verify "$SHA^{commit}")"
rm -rf "$DEST"; mkdir -p "$DEST"
git -C "$QED64" archive "$FULL" "${PATHS[@]}" | tar -x -C "$DEST"
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
} > "$ROOT/client/src/wasm/vendor/QED64-PIN"
echo "vendored qed64 @ ${FULL:0:12} into client/src/wasm/vendor/qed64 (pin: client/src/wasm/vendor/QED64-PIN)"
