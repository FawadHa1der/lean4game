#!/usr/bin/env python3
"""Stage baked snapshots into client/public/snapshots and merge index.json.

Usage: scripts/stage-snapshots.py <staging-dir-with-index.json> [name ...]

Copies the named snapshots' .snapz files (default: every entry in the staging
index) into client/public/snapshots, replaces their entries in the public
index.json (entries for other names are kept), and removes the superseded
.snapz files. The client resolves snapshots by name → digest-named URL, so a
rebuild/restage of client/dist is needed afterwards.

The index.json it writes is the one the deploy serves (scripts/deploy-app.sh
ships it; wasm/DEPLOY.md). A bake also writes index.<buildId>.json beside its
own index: it is never staged. Per-runtime copies a tree staged before 2026-11
still holds are removed here, or scripts/pack-artifacts.sh would publish them.
"""
import json, shutil, sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
pub = root / "client/public/snapshots"

staging = Path(sys.argv[1]).resolve()
names = sys.argv[2:]
sidx = json.loads((staging / "index.json").read_text())
pidx = json.loads((pub / "index.json").read_text())
entries = [e for e in sidx["snapshots"] if not names or e["name"] in names]
if not entries:
    sys.exit(f"no snapshots {names or ''} in {staging}/index.json")
# One runtime per served index: a snapshot is a memory image of one runtime
# build and the page serves one runtime (client/public/runtime), so an index
# whose entries name two build ids leaves every game paired to the other one
# unbootable. Refused before anything is copied or removed — after a runtime
# bump, bake every game for the new runtime and stage them together.
merged = [o for o in pidx["snapshots"] if o["name"] not in {e["name"] for e in entries}] + entries
runtimes = sorted({o.get("runtime") or "(none)" for o in merged})
if len(runtimes) > 1:
    by = {r: sorted(o["name"] for o in merged if (o.get("runtime") or "(none)") == r) for r in runtimes}
    sys.exit("refusing an index that mixes runtimes: " + "; ".join(f"{r}: {', '.join(n)}" for r, n in by.items()))
for e in entries:
    src = staging / Path(e["url"]).name
    dst = pub / src.name
    old = [o for o in pidx["snapshots"] if o["name"] == e["name"]]
    if not dst.exists():
        print(f"copy {src.name} ({e['transfer']:,} B transfer, {e['bytes']:,} B raw)")
        shutil.copy2(src, dst)
    for o in old:
        oldfile = pub / Path(o["url"]).name
        if oldfile.exists() and oldfile != dst:
            print(f"remove superseded {oldfile.name}")
            oldfile.unlink()
    # Pairing fact: every entry records the runtime build id that baked it (the
    # worker refuses a mismatched snapshot instead of trapping). Older bakes
    # omit it; stamp from the served runtime manifest, which is the same build.
    if not e.get("runtime"):
        rm = root / "client/public/runtime/runtime-manifest.json"
        if rm.exists():
            e["runtime"] = json.loads(rm.read_text())["buildId"]
    pidx["snapshots"] = [o for o in pidx["snapshots"] if o["name"] != e["name"]] + [e]
    print(f"index: {e['name']} -> {e['digest'][:23]}…")
(pub / "index.json").write_text(json.dumps(pidx, indent=1) + "\n")
for old in sorted(pub.glob("*index.wasm64-*.json")):
    print(f"remove {old.name} (the per-runtime copies are retired)")
    old.unlink()
print("staged", [e["name"] for e in entries])
