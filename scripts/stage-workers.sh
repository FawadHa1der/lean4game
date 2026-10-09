#!/bin/bash
# Copy the worker scripts of the qed64 package into client/public/workers/
# (gitignored: generated, paired with the bundled `qed64/embed` by
# construction — both come from the one SHA pinned in client/package.json).
# Every build that ships must run this first — a clean checkout has no
# client/public/workers, and a shell deployed without them hangs at
# "starting Lean" (the first CI-built deploy, 2026-09-07).
#
# What to copy is the package's embedding/closure.json, not a list kept here:
# each `workers[]` entry is {path (in the package), serveAs (on the site)}.
# lean.worker.js importScripts lsp-frames.js, memory64-probe.js and
# lsp-front-door.js from its own directory, so the closure ships them
# together, and a bump that adds a worker (qed64 A3c's memory64-probe.js)
# needs no change here.
#
# Staging makes client/public/workers exactly the closure's set: a worker a
# bump dropped or renamed is removed, not left to ship and be precached.
#
# Checked first, on every build and deploy (and by the from-source preflight):
#  - the installed package IS the lockfile's pin. node_modules is not in git:
#    a pull of a qed64 bump into a checkout with an older install (deploy-app.sh
#    skips `npm ci` when client/node_modules exists) would stage, bundle and
#    deploy the old embed and workers under a commit that names the new pin.
#    npm's own record of what it installed (node_modules/.package-lock.json)
#    must name the commit package-lock.json pins (`npm ls` is no check here:
#    it stops trusting that record when the tree's mtimes move, and then
#    reports the root lockfile's commit as installed);
#  - client/tsconfig.json's `paths` entry for `qed64/embed` is the installed
#    package's entry file (closure.json `entry`): tsc cannot read the exports
#    map under moduleResolution "node", so the file is spelled out there, and
#    a bump that moves it (or an install that nests the package) would leave
#    tsc checking a stale or missing file while Vite bundles the new one;
#  - the kernel floor: the workers state the oldest kernel patch level they
#    drive (closure.json runtime.minKernelPatch); this site serves the runtime
#    of the toolchain release it pins (wasm/lean4-wasm64-release.json, whose
#    kernel.patch is that runtime's patch id), so a qed64 bump whose workers
#    need a newer kernel is refused here — before a deploy ships workers the
#    served runtime cannot run. Patch ids are NNNN plus an optional lowercase
#    letter (0035b), ordered by the release tools' comparePatchIds.
#
#   scripts/stage-workers.sh           check, then stage them
#   scripts/stage-workers.sh --check   check only (the from-source preflight)
#   scripts/stage-workers.sh --list    print their served paths (relative to the
#                                      site root) — deploy-app.sh's completeness check
set -euo pipefail
cd "$(dirname "$0")/.."
# Resolved the way the bundler resolves `qed64/embed` (npm may hoist the
# workspace's dependency) — never a qed64 checkout.
PKG="$(node -p "require('path').dirname(require.resolve('qed64/package.json', { paths: [process.argv[1]] }))" "$PWD/client" 2>/dev/null)" \
  || { echo "stage-workers: the qed64 package is not installed — run npm ci" >&2; exit 2; }
# One "path<TAB>serveAs" line per worker. A served name must stay a plain file
# under /workers/ — the page and the service worker load them from there — so
# a closure entry elsewhere is refused, never copied.
WORKERS="$(node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1] + "/embedding/closure.json", "utf8"));
  if (c.schema !== "qed64.closure/v1") throw new Error(`closure schema ${c.schema}; this script reads qed64.closure/v1`);
  for (const w of c.workers) {
    if (!/^\/workers\/[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(w.serveAs)) throw new Error(`refusing to serve ${w.path} as ${w.serveAs}`);
    console.log(`${w.path}\t${w.serveAs}`);
  }
' "$PKG")"
if [ "${1:-}" = --list ]; then cut -f2 <<<"$WORKERS" | sed 's|^/||'; exit 0; fi
# The install is the pin, and tsc reads the file Vite bundles (see the top).
node -e '
  const fs = require("fs"), path = require("path");
  const [pkg, clientDir] = process.argv.slice(1);
  const fail = (why) => { process.stderr.write(`stage-workers: ${why}\n`); process.exit(2); };
  const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  const packages = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")).packages ?? {}; } catch { return null; } };
  // The lockfile entry of the package resolved above (npm may hoist it, or
  // nest it under client/; node_modules may be a link).
  const rel = Object.keys(packages("package-lock.json") ?? {}).find((k) => /(?:^|\/)node_modules\/qed64$/.test(k) && real(k) === real(pkg));
  const resolved = (file) => { const p = packages(file); return p === null ? null : p[rel]?.resolved ?? ""; };
  const commit = (r) => /#([0-9a-f]{40})$/.exec(r ?? "")?.[1] ?? "";
  const pinned = rel ? commit(resolved("package-lock.json")) : "";
  if (!pinned) fail(`package-lock.json pins no qed64 commit for ${path.relative(process.cwd(), pkg)} — run npm install`);
  const record = resolved("node_modules/.package-lock.json");
  if (record === null) fail("node_modules/.package-lock.json (npm\u2019s record of the install) is missing, so the installed qed64 cannot be checked against its pin — run npm ci");
  const installed = commit(record);
  if (installed !== pinned) fail(`node_modules/qed64 is ${installed || "not a pinned git install"}, package-lock.json pins ${pinned} — run npm ci`);
  const closure = JSON.parse(fs.readFileSync(path.join(pkg, "embedding/closure.json"), "utf8"));
  const ts = require(require.resolve("typescript", { paths: [clientDir] }));
  const { config, error } = ts.parseConfigFileTextToJson("tsconfig.json", fs.readFileSync(path.join(clientDir, "tsconfig.json"), "utf8"));
  if (error) fail(`client/tsconfig.json does not parse: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`);
  const mapped = config.compilerOptions?.paths?.["qed64/embed"]?.[0];
  const entry = path.join(pkg, closure.entry);
  const target = mapped === undefined ? null : real(path.resolve(clientDir, config.compilerOptions?.baseUrl ?? ".", mapped));
  if (!target || target !== real(entry)) fail(`client/tsconfig.json maps qed64/embed to ${mapped ?? "nothing"}, but the installed package\u2019s entry is ${path.relative(clientDir, entry)} (closure.json entry) — update the paths entry`);
' "$PKG" "$PWD/client"
# The floor, compared by the release tools (the root devDependency
# lean4-wasm64; resolved from the repo root, this script's cwd).
FLOOR="$(node --input-type=module -e '
  import fs from "node:fs";
  import { comparePatchIds, parsePatchId } from "lean4-wasm64";
  const [pkg, rec] = process.argv.slice(1);
  const fail = (why) => { process.stderr.write(`stage-workers: ${why}\n`); process.exit(2); };
  const min = JSON.parse(fs.readFileSync(`${pkg}/embedding/closure.json`, "utf8")).runtime?.minKernelPatch ?? "";
  let r; try { r = JSON.parse(fs.readFileSync(rec, "utf8")); } catch { fail(`${rec} (the pinned toolchain release record) is missing or unreadable`); }
  const have = r.kernel?.patch ?? "";
  try { parsePatchId(min); } catch { fail(`the qed64 closure states no valid runtime.minKernelPatch (${JSON.stringify(min)})`); }
  try { parsePatchId(have); } catch { fail(`${rec} names no valid kernel.patch (${JSON.stringify(have)})`); }
  if (comparePatchIds(have, min) < 0) fail(`the qed64 workers need kernel patch ${min} or newer (closure.json runtime.minKernelPatch), this site serves the runtime of ${r.id}, patch ${have} (wasm/lean4-wasm64-release.json) — pin a newer toolchain release (a full rebake) or an older qed64`);
  console.log(`qed64 workers: kernel patch ${have} (${r.id}, runtime ${r.runtime?.buildId}) meets their floor ${min}`);
' "$PKG" wasm/lean4-wasm64-release.json)" || exit 2
if [ "${1:-}" = --check ]; then echo "$FLOOR"; exit 0; fi
PUB=client/public
# Generated and gitignored: whatever the closure does not name goes (every
# serveAs is a plain /workers/*.js, checked above).
STALE=()
if [ -d "$PUB/workers" ]; then
  while IFS= read -r -d '' f; do
    grep -qxF "/workers/$(basename "$f")" <<<"$(cut -f2 <<<"$WORKERS")" || STALE+=("$f")
  done < <(find "$PUB/workers" -mindepth 1 -maxdepth 1 -print0)
fi
if [ "${#STALE[@]}" -gt 0 ]; then
  rm -rf "${STALE[@]}"
  echo "removed workers the qed64 closure no longer names: $(for f in "${STALE[@]}"; do printf '%s ' "${f#"$PUB"}"; done)"
fi
while IFS=$'\t' read -r path serveAs; do
  [ -f "$PKG/$path" ] || { echo "stage-workers: $PKG/$path missing — the installed qed64 does not match its closure.json; rerun npm ci" >&2; exit 2; }
  mkdir -p "$PUB$(dirname "$serveAs")"
  cp "$PKG/$path" "$PUB$serveAs"
done <<<"$WORKERS"
echo "staged workers: $(cut -f2 <<<"$WORKERS" | tr '\n' ' ')"
