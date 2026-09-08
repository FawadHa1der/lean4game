#!/usr/bin/env python3
"""Compile a Lean package's modules in dependency order with raw `lean`.
Usage: compile-pkg.py <pkg-src-dir> <out-dir> <root-module> [more roots...]
LEAN must be set (path to lean). LEAN_PATH must include <out-dir> and deps.
LEAN_OPTS (optional): whitespace-separated flags appended to every lean
invocation, e.g. "-Dlinter.all=false -Dtactic.hygienic=false" — a game's
lakefile `leanOptions`, which the catalog row carries (wasm/catalog.json
leanOptions → build-from-source.sh); compile-time options are captured in
each level's scope, so nothing else has to replay them at play time.
Stops at the first module that fails; prints its full stderr."""
import os, re, subprocess, sys
src, out = sys.argv[1], sys.argv[2]
roots = sys.argv[3:]
opts = os.environ.get("LEAN_OPTS", "").split()
IMP = re.compile(r"^\s*(?:public\s+|private\s+)?(?:meta\s+)?import\s+([A-Za-z0-9_.\u00AB\u00BB]+)", re.M)

def path_of(mod):
    p = os.path.join(src, mod.replace(".", "/") + ".lean")
    return p if os.path.exists(p) else None

order, seen = [], set()
def visit(mod, stack=()):
    if mod in seen: return
    p = path_of(mod)
    if p is None: return  # external: resolved via LEAN_PATH
    if mod in stack: raise SystemExit(f"import cycle at {mod}")
    for dep in IMP.findall(open(p).read()):
        visit(dep, stack + (mod,))
    seen.add(mod); order.append(mod)

for r in roots: visit(r)
print(f"{len(order)} modules to compile", flush=True)
for i, mod in enumerate(order):
    dst = os.path.join(out, mod.replace(".", "/") + ".olean")
    srcf = path_of(mod)
    if os.path.exists(dst) and os.path.getmtime(dst) > os.path.getmtime(srcf):
        continue
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    r = subprocess.run([os.environ["LEAN"], srcf, "-o", dst, "--root", src, *opts],
                       capture_output=True, text=True)
    status = "ok" if r.returncode == 0 else "FAIL"
    print(f"[{i+1}/{len(order)}] {status} {mod}", flush=True)
    if r.returncode != 0:
        print(r.stdout[-3000:]); print(r.stderr[-3000:])
        sys.exit(1)
print("package complete")
