#!/usr/bin/env python3
"""Stage baked snapshots into client/public/snapshots and merge index.json.

Usage: scripts/stage-snapshots.py <staging-dir-with-index.json> [name ...]

Copies the named snapshots' .snapz files (default: every entry in the staging
index) into client/public/snapshots, replaces their entries in the public
index.json (entries for other names are kept), and removes the superseded
.snapz files. The client resolves snapshots by name → digest-named URL, so a
rebuild/restage of client/dist is needed afterwards.
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
print("staged", [e["name"] for e in entries])
