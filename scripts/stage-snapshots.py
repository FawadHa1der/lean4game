#!/usr/bin/env python3
"""Stage baked snapshots into client/public/snapshots and merge index.json.

Usage: scripts/stage-snapshots.py <staging-dir-with-index.json> [name ...]
       scripts/stage-snapshots.py --copies

Copies the named snapshots' .snapz files (default: every entry in the staging
index) into client/public/snapshots, replaces their entries in the public
index.json (entries for other names are kept), and removes the superseded
.snapz files. The client resolves snapshots by name → digest-named URL, so a
rebuild/restage of client/dist is needed afterwards.

Per-runtime copy (QED64 HARDENING #64): after writing the merged index.json
it also writes snapshots/index.<buildId>.json with exactly its bytes, where
<buildId> is the one runtime its entries name, and removes the copies of
other runtimes (R2 keeps those; locally they would name .snapz that are
gone). A shell paired with <buildId> reads that copy when the mutable
index.json names another runtime, so scripts/upload-artifacts.sh can publish
it before the deploy and index.json only after it.

--copies stages nothing: it (re)derives the per-runtime copies from the
tree as it is, index.<buildId>.json from snapshots/index.json,
snapshots/profiles-index.<buildId>.json from profiles/index.json (the bundle
lane of wasm/build-from-source.sh writes that one next to profiles/index.json)
and the pinned runtime manifest runtime/runtime-manifest.<buildId>.json from
runtime/runtime-manifest.json (the release ships both, the same bytes; the
bundle lane copies the release's; a QED64 boot fetches the pinned one first
and the service worker precaches it, so without it an offline boot fails)
— for a tree staged before the copies existed, one scripts/fetch-artifacts.sh
restored, or an index edited by hand. scripts/preflight-artifacts.mjs refuses
an upload whose copies are missing or differ from their source.
"""
import json, re, shutil, sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
pub = root / "client/public/snapshots"
BUILD_ID = re.compile(r"wasm64-[0-9a-f]{16}")


def snapshot_runtime(index):
    """The one runtime build id a snapshot index's entries name, or None."""
    ids = {e.get("runtime") for e in index.get("snapshots", [])}
    rid = ids.pop() if len(ids) == 1 else None
    return rid if BUILD_ID.fullmatch(str(rid)) else None


def pin_copy(index_file, prefix, runtime, where=pub, keeps="R2 keeps its own"):
    """Write <where>/<prefix>.<runtime>.json with exactly index_file's bytes
    (temp + rename: a reader never sees half a copy) and remove the
    <prefix>.<other build id>.json copies of other runtimes."""
    if runtime is None:
        sys.exit(f"{index_file.relative_to(root)} names no single runtime build id: no per-runtime copy "
                 "(scripts/preflight-artifacts.mjs will refuse this tree)")
    dst = where / f"{prefix}.{runtime}.json"
    for old in sorted(where.glob(f"{prefix}.*.json")):
        if old != dst and BUILD_ID.fullmatch(old.name[len(prefix) + 1:-len(".json")]):
            print(f"remove {old.name} (another runtime's copy; {keeps})")
            old.unlink()
    tmp = dst.with_name(dst.name + ".tmp")
    tmp.write_bytes(index_file.read_bytes())
    tmp.replace(dst)
    print(f"copy {dst.name} (the bytes of {index_file.relative_to(root)})")


if sys.argv[1:] == ["--copies"]:
    sidx_file, pidx_file = pub / "index.json", root / "client/public/profiles/index.json"
    pin_copy(sidx_file, "index", snapshot_runtime(json.loads(sidx_file.read_text())))
    pid = (json.loads(pidx_file.read_text()).get("runtime") or {}).get("buildId")
    pin_copy(pidx_file, "profiles-index", pid if BUILD_ID.fullmatch(str(pid)) else None)
    rt_file = root / "client/public/runtime/runtime-manifest.json"
    rid = json.loads(rt_file.read_text()).get("buildId")
    pin_copy(rt_file, "runtime-manifest", rid if BUILD_ID.fullmatch(str(rid)) else None,
             rt_file.parent, "its release keeps its own")
    sys.exit(0)

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
# The copy comes from the MERGED index (every game the site serves), never
# from the staging dir's own index.<buildId>.json, which a bake may write but
# which names only the games baked into that staging dir.
pin_copy(pub / "index.json", "index", snapshot_runtime(pidx))
print("staged", [e["name"] for e in entries])
