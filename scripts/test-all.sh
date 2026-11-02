#!/bin/bash
# Run every unit test file: each *.test.ts and *.test.mjs under client/src,
# infra and scripts, found here so that a new file needs no list kept anywhere.
# Prints one line per file (a failing file's output after its line) and the
# count; exits 1 if any file fails, 2 if none is found. CI's test job runs this
# (.github/workflows/deploy.yml). It needs an installed tree (npm ci) and no
# secrets: nothing here leaves the machine.
set -euo pipefail
cd "$(dirname "$0")/.."
FILES="$(find client/src infra scripts -type f \( -name '*.test.ts' -o -name '*.test.mjs' \) -not -path '*/node_modules/*' | LC_ALL=C sort)"
[ -n "$FILES" ] || { echo "test-all: no test files found" >&2; exit 2; }
total=0
FAILED=()
while IFS= read -r f; do
  case "$f" in
    *.ts) cmd=(node --import ./client/src/wasm/ts-resolve-hook.mjs "$f") ;;
    *) cmd=(node "$f") ;;
  esac
  total=$((total + 1))
  start=$SECONDS
  # stdin is this loop's file list: no test may read it.
  if out="$("${cmd[@]}" 2>&1 </dev/null)"; then
    echo "ok   $f ($((SECONDS - start)) s)"
  else
    rc=$?
    echo "FAIL $f (exit $rc, $((SECONDS - start)) s)"
    sed 's/^/     /' <<<"$out"
    FAILED+=("$f")
  fi
done <<<"$FILES"
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "test-all: ${#FAILED[@]} of $total files FAILED: ${FAILED[*]}"
  exit 1
fi
echo "test-all: $total/$total files passed"
