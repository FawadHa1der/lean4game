#!/usr/bin/env python3
"""Print the provenance stamp of the lane's olean trees (wasm/build-from-source.sh).

Usage: tree-stamp.py <release.json> <pack id>... [--source <rev|-> <patch path|->]

The stamp names what a tree is built from, by the pinned toolchain release
record (wasm/lean4-wasm64-release.json): the rawSha256 of every pack it is
unpacked from, and the sha256 of the native compiler's tarball (the compiler
that writes the lean-i18n, GameServer and game oleans). With --source it adds
the game's source pin: the catalog's source.rev and the sha256 of its port
patch ('-' for none). The trees lane writes the base stamp beside the base
trees (wasm/out/trees/gamebase.stamp), the games lane the per-game stamp
beside each per-game tree (lib-tree-<snapshot>.stamp); the games and bake
lanes refuse a tree whose stamp is not the one this prints for the pinned
record and catalog row. The record's id, digest and runtime are left out on
purpose: a release whose packs and native64 are byte-identical to the last
one (a runtime-only release) gives the same stamp, so its trees carry over.
"""
import hashlib, json, sys

args = sys.argv[1:]
source = None
if "--source" in args:
    i = args.index("--source")
    source, args = args[i + 1:i + 3], args[:i]
    if len(source) != 2:
        sys.exit("--source needs <rev|-> <patch path|->")
if len(args) < 2:
    sys.exit(__doc__.strip().splitlines()[2])
record, packs = args[0], args[1:]
r = json.load(open(record, encoding="utf8"))
lines = ["lean4game.tree-stamp/v1"]
for pid in packs:
    p = next((p for p in r.get("packs", []) if p.get("id") == pid), None)
    if not p or not p.get("rawSha256"):
        sys.exit(f"{record}: no pack '{pid}' with a rawSha256")
    lines.append(f"pack {pid} {p['rawSha256']}")
n = r.get("native64") or {}
tar = next((f for f in r.get("files", []) if f.get("path") == n.get("tar")), None)
if not tar or not tar.get("sha256"):
    sys.exit(f"{record}: no files[] entry with the sha256 of native64.tar ({n.get('tar')})")
lines.append(f"native64 {n.get('os')}/{n.get('arch')} {tar['sha256']}")
if source:
    rev, patch = source
    digest = "-" if patch == "-" else hashlib.sha256(open(patch, "rb").read()).hexdigest()
    lines.append(f"source {rev} {digest}")
print("\n".join(lines))
