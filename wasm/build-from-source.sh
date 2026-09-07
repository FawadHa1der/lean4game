#!/usr/bin/env bash
# Build the lean4game wasm64 artifacts from source, end to end:
#
#   preflight → runtime (kernel → Docker → stage0/stage1 → gate → chunks)
#             → core   (Lean core library pack from stage1's Init facets)
#             → trees  (olean trees: core + Mathlib pack unpacked, lean-i18n
#                       and GameServer compiled with the native stage0)
#             → games  (TestGame + NNG4 compiled → gamedata + per-game trees)
#             → bake   (init / testgame / nng4 environment snapshots)
#             → bundle (stage into client/public, build the client, pack
#                       the artifact bundle for publishing)
#
# Usage:
#   wasm/build-from-source.sh --plan                 # print every step, run nothing
#   wasm/build-from-source.sh                        # everything (hours, see below)
#   wasm/build-from-source.sh --lanes preflight,runtime
#   wasm/build-from-source.sh --lanes games,bake,bundle   # after a game change
#
# Options:
#   --plan                 print commands with cwd/env, execute nothing
#   --lanes a,b,c          subset of: preflight runtime core trees games bake bundle
#   --tag <tag>            bundle tag (default artifacts-<runtime build id>)
#   --reuse-core-pack      keep the tracked lean-core pack (parts must be in
#                          client/public/profiles, e.g. via fetch-artifacts.sh)
#                          instead of repacking from stage1
#   --verify-snapshots     run snapshot-probe against each baked game snapshot
#   --strict               stop when stage1's Init facets differ from the pack
#                          the Mathlib oleans were compiled against (see CORE)
#
# Inputs (environment, all optional):
#   KERNEL_DIR   kernel source at the pin      (default wasm/kernel submodule)
#   QED64_DIR    pipeline scripts               (default wasm/vendor/qed64-pipeline, vendored by scripts/sync-qed64.sh)
#   BUILD_DIR    kernel build tree + ccache    (default wasm/out/kernel-build)
#   MATHLIB_PACK_DIR  directory holding mathlib-essential.manifest.json + its
#                     .pack.gzip.*.part-NNN files (default wasm/out/mathlib-pack,
#                     filled by `scripts/fetch-artifacts.sh --mathlib`; ~1 GB;
#                     an INPUT of this script, not produced by it)
#   MATHLIB_MANIFEST  override the manifest path (default: in MATHLIB_PACK_DIR)
#   JOBS         parallelism hint for the kernel build (its script uses 12)
#
# Requirements: Docker (daemon with >= 10 GiB memory: the wasm link step is
# OOM-killed below ~7 GiB free), Node >= 24, python3, rsync, ~40 GB free
# disk. Wall-clock: kernel build 1.5–3 h cold / ~15 min with a warm ccache,
# the rest ~30–60 min. Every lane writes wasm/out/logs/<lane>.log.
#
# Pairing rules this script enforces: the runtime build id is
# "wasm64-" + sha256(lean.wasm)[:16]; the chunk manifest must carry it; every
# snapshot is baked against THAT stage1 and never mixed with another build;
# the core pack and the olean trees come from the same stage1. A new kernel
# pin therefore means running everything.
#
# Known limits (documented in wasm/KERNEL.md): the Mathlib oleans are an
# INPUT (the digest-pinned mathlib-essential pack), not rebuilt here — they
# were compiled against the served Lean core, so CORE compares stage1's Init
# facets with the tracked lean-core manifest and warns (or stops with
# --strict) when they differ; bit-reproducibility of the runtime at the pin
# has not been demonstrated (a rebuild is treated as a NEW build id).
set -euo pipefail

G="$(cd "$(dirname "$0")/.." && pwd)"
PLAN=0; LANES="preflight,runtime,core,trees,games,bake,bundle"; TAG=""; REUSE_CORE=0; VERIFY=0; STRICT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --plan) PLAN=1; shift ;;
    --lanes) LANES="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --reuse-core-pack) REUSE_CORE=1; shift ;;
    --verify-snapshots) VERIFY=1; shift ;;
    --strict) STRICT=1; shift ;;
    -h|--help) sed -n '2,52p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

KERNEL_DIR="${KERNEL_DIR:-$G/wasm/kernel}"
QED64_DIR="${QED64_DIR:-$G/wasm/vendor/qed64-pipeline}"   # vendored pipeline scripts (scripts/sync-qed64.sh); a qed64 checkout also works
BUILD_DIR="${BUILD_DIR:-$G/wasm/out/kernel-build}"
S1="$BUILD_DIR/build/stage1"; S0="$BUILD_DIR/build/stage0/bin"
OUT="$G/wasm/out"; TREES="$OUT/trees"; LOGS="$OUT/logs"; PKGS="$OUT/pkgs"
# The Mathlib olean pack: fetched into wasm/out/mathlib-pack by `scripts/fetch-artifacts.sh --mathlib`
# (the bundle's optional mathlib-pack.tar), or any directory holding the manifest + parts.
MATHLIB_PACK_DIR="${MATHLIB_PACK_DIR:-$OUT/mathlib-pack}"
MATHLIB_MANIFEST="${MATHLIB_MANIFEST:-$MATHLIB_PACK_DIR/mathlib-essential.manifest.json}"
IMAGE="qed64-toolchain:emsdk-6.0.5"; LEAN_VERSION="4.33.0-pre"
PIN="$(grep -Eo '^[0-9a-f]{40}' "$G/wasm/KERNEL-PIN" 2>/dev/null | head -1 || true)"   # the game's own kernel pin (= wasm/kernel submodule commit)
QPIN="$(grep -Eo '[0-9a-f]{40}' "$G/client/src/wasm/vendor/QED64-PIN" 2>/dev/null | head -1 || true)"
PUB="$G/client/public"
mkdir -p "$LOGS" "$OUT"
NNG4_UPSTREAM="360d797"

# ---------------------------------------------------------------- helpers --
say()  { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
warn() { printf '\033[1;33m   warning: %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31merror: %s\033[0m\n' "$*" >&2; exit 1; }
lane_on() { case ",$LANES," in *,"$1",*) return 0 ;; *) return 1 ;; esac; }
# run <log> <cwd> <ENV...> -- <cmd...>   (prints in --plan mode; logs otherwise)
run() {
  local log="$1" cwd="$2"; shift 2; local envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  local envstr=""; [ ${#envs[@]} -eq 0 ] || envstr="${envs[*]} "
  if [ "$PLAN" = 1 ]; then printf '   $ (cd %s && %s%s)\n' "$cwd" "$envstr" "$*"; return 0; fi
  printf '   $ %s\n' "$*"
  ( cd "$cwd" && env ${envs[@]+"${envs[@]}"} "$@" ) 2>&1 | tee -a "$LOGS/$log.log" || die "step failed, see $LOGS/$log.log: $*"
}
# run_soft: like run, but returns the command's status instead of dying
# (for a step whose failure a later step can repair).
run_soft() {
  local log="$1" cwd="$2"; shift 2; local envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  local envstr=""; [ ${#envs[@]} -eq 0 ] || envstr="${envs[*]} "
  if [ "$PLAN" = 1 ]; then printf '   $ (cd %s && %s%s)   [failure tolerated]\n' "$cwd" "$envstr" "$*"; return 0; fi
  printf '   $ %s\n' "$*"
  ( cd "$cwd" && env ${envs[@]+"${envs[@]}"} "$@" ) 2>&1 | tee -a "$LOGS/$log.log"
  return "${PIPESTATUS[0]}"
}
# check <description> <shell test...>  — asserts are skipped under --plan
check() { local d="$1"; shift; if [ "$PLAN" = 1 ]; then note "check: $d"; return 0; fi; "$@" || die "check failed: $d"; }
sha16() { shasum -a 256 "$1" | cut -c1-16; }
docker_run() { # docker_run <log> <workdir> <ENV...> -- <cmd...>  inside the toolchain image with the repo + build dir mounted
  local log="$1" wd="$2"; shift 2; local envs=()
  while [ "$1" != "--" ]; do envs+=(-e "$1"); shift; done; shift
  run "$log" "$G" -- docker run --rm -v "$G:$G" -v "$BUILD_DIR:$BUILD_DIR" -w "$wd" ${envs[@]+"${envs[@]}"} "$IMAGE" "$@"
}
compile_pkg() { # compile_pkg <log> <src-dir> <out-dir> <root> <LEAN_PATH>
  local log="$1" src="$2" out="$3" root="$4" lp="$5"
  [ "$PLAN" = 1 ] || mkdir -p "$out"
  docker_run "$log" "$src" "LEAN=$S0/lean" "LEAN_PATH=$lp" -- python3 "$G/wasm/scripts/compile-pkg.py" "$src" "$out" "$root"
}
overlay() { # overlay <base-tree> <new-tree> <extra dirs...>   (hard-linked copy of base + extras on top)
  local base="$1" new="$2"; shift 2
  run trees "$G" -- rsync -a --link-dest="$base" "$base/" "$new/"
  for x in "$@"; do run trees "$G" -- rsync -a "$x/" "$new/"; done
}

# -------------------------------------------------------------- preflight --
lane_preflight() {
  say "preflight"
  note "repo $G"; note "kernel $KERNEL_DIR"; note "qed64 $QED64_DIR"; note "build $BUILD_DIR"
  [ -f "$KERNEL_DIR/wasm64-build/build.sh" ] || die "kernel source missing — run: git submodule update --init --checkout wasm/kernel   (or set KERNEL_DIR)"
  [ -f "$QED64_DIR/pipeline/snapshot/bake-snapshot.mjs" ] || die "pipeline scripts missing at $QED64_DIR — run scripts/sync-qed64.sh <qed64-commit> (or set QED64_DIR to a qed64 checkout)"
  [ -n "$PIN" ] || die "no kernel pin in $G/wasm/KERNEL-PIN"
  local khead; khead="$(git -C "$KERNEL_DIR" rev-parse HEAD)"
  [ "$khead" = "$PIN" ] || die "kernel checkout is $khead but KERNEL-PIN is $PIN — checkout the pin (git -C $KERNEL_DIR checkout $PIN)"
  [ -z "$(git -C "$KERNEL_DIR" status --porcelain)" ] || die "kernel tree is dirty — the recorded source revision would lie"
  if [ -z "$(git -C "$KERNEL_DIR" ls-files src/emscripten-exports.txt)" ]; then
    # Generated-exports pin (0032+): the gate is advisory, so the bake lane's
    # snapshot probes must run — learn that before the kernel build, not after.
    if { [ "$VERIFY" = 1 ] && lane_on bake; }; then note "generated-exports pin: gate advisory, bake probes required (--verify-snapshots): on"
    elif [ "$PLAN" = 1 ]; then note "generated-exports pin: a real run needs --verify-snapshots AND the bake lane (the snapshot probes are its acceptance test)"
    else die "this pin generates its exports list (0032+): run with --verify-snapshots AND the bake lane, the snapshot probes are its acceptance test"; fi
  fi
  if [ -d "$QED64_DIR/.git" ]; then local qhead; qhead="$(git -C "$QED64_DIR" rev-parse HEAD)"; [ "$qhead" = "$QPIN" ] || warn "qed64 checkout is at ${qhead:0:12}, the vendored pin is ${QPIN:0:12}"; fi
  note "kernel pin $PIN (clean)"
  local nv; nv="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1 || echo 0)"; [ "${nv:-0}" -ge 24 ] || die "Node >= 24 required (Memory64), found $(node -v 2>/dev/null || echo none)"
  command -v python3 >/dev/null || die "python3 required"; command -v rsync >/dev/null || die "rsync required"
  if docker info >/dev/null 2>&1; then
    local mem; mem="$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)"
    note "docker: $((mem / 1073741824)) GiB VM memory$([ "$mem" -ge 10737418240 ] || echo '  — WARNING: < 10 GiB, the wasm link step needs ~7 GiB free')"
  else
    warn "docker daemon not reachable — the runtime, trees and games lanes need it"
  fi
  local free; free="$(df -g "$G" 2>/dev/null | awk 'NR==2{print $4}' || echo '?')"; note "free disk: ${free} GB (need ~40)"
  if [ -f "$MATHLIB_MANIFEST" ]; then
    local parts; parts="$(find "$MATHLIB_PACK_DIR" -maxdepth 1 -name 'mathlib-essential.pack.gzip.*.part-*' 2>/dev/null | wc -l | tr -d ' ' || true)"
    note "mathlib pack: manifest $MATHLIB_MANIFEST, $parts part files in $MATHLIB_PACK_DIR$([ "$parts" -gt 0 ] || echo '  — WARNING: parts missing (fetch them from the qed64 artifact host); the trees lane needs them')"
  else
    warn "mathlib-essential manifest not found at $MATHLIB_MANIFEST — run scripts/fetch-artifacts.sh --mathlib (or set MATHLIB_PACK_DIR)"
  fi
  note "lanes: $LANES$([ "$PLAN" = 1 ] && echo '   (PLAN — nothing runs)')"
}

# ---------------------------------------------------------------- runtime --
lane_runtime() {
  say "runtime: kernel $PIN → Docker toolchain → stage0/stage1 → gate → chunks"
  # A reused build tree keeps the previous pin's link outputs; the checks
  # below must see THIS build's, so the old binaries go first.
  run runtime "$G" -- rm -f "$S1/bin/lean.js" "$S1/bin/lean.wasm"
  # Kernel pins from patch 0032 on generate src/emscripten-exports.txt at
  # build time (gitignored; qed64 pipeline/toolchain/gen-exports.py: seed +
  # (wanted ∩ the names stage1's compiled C defines)), a host-side step
  # between the stage-1 libraries and the final link that the kernel's own
  # wasm64-build/build.sh does not run — its [5/5] link fails on the missing
  # file. Let it run through stage 4, then generate and finish the link the
  # way qed64's toolchain build.sh does. A pin that still tracks the file
  # links in one go and skips the repair.
  # A generated list must be recomputed from THIS build's compiled C: a
  # reused tree keeps the previous run's (gitignored) file, and the kernel's
  # link rule has no dependency on it — it would silently link against the
  # previous build's symbol universe.
  local generated_exports=0
  [ -n "$(git -C "$KERNEL_DIR" ls-files src/emscripten-exports.txt)" ] || generated_exports=1
  [ "$PLAN" = 1 ] || [ "$generated_exports" = 0 ] || rm -f "$KERNEL_DIR/src/emscripten-exports.txt"
  local log_before=0; [ "$PLAN" = 1 ] || log_before=$(stat -f%z "$LOGS/runtime.log" 2>/dev/null || echo 0)
  if [ "$PLAN" = 1 ] || ! run_soft runtime "$KERNEL_DIR" "QED64_BUILD_DIR=$BUILD_DIR" -- bash "$KERNEL_DIR/wasm64-build/build.sh"; then
    [ "$PLAN" = 1 ] || [ "$generated_exports" = 1 ] || die "kernel build failed — see $LOGS/runtime.log"
    # Repair only a link failure of THIS run (the stage-1 libraries built):
    # anything earlier is a real failure, and a stale lib/temp from a
    # previous build must not be linked.
    [ "$PLAN" = 1 ] || tail -c +$((log_before + 1)) "$LOGS/runtime.log" | grep -q "=== \[5/5\] final lean link ===" || die "kernel build failed before the final link — see $LOGS/runtime.log"
    say "runtime: exports list is generated at this pin (patch 0032) — generating it from this build's compiled C and finishing the link"
    run runtime "$G" -- python3 "$QED64_DIR/pipeline/toolchain/gen-exports.py" "$S1/lib/temp" "$KERNEL_DIR/src"
    run runtime "$KERNEL_DIR" -- docker run --rm -v "$KERNEL_DIR":/lean4 -v "$BUILD_DIR/build":/build -v "$BUILD_DIR/ccache":/root/.ccache \
      -e EM_COMPILER_WRAPPER=ccache "$IMAGE" bash -lc "git config --global --add safe.directory /lean4 && make -C /build/stage1 leaninitialize lean -j12"
  fi
  check "stage1 produced bin/lean.js + lean.wasm" bash -c "test -s '$S1/bin/lean.wasm' && test -s '$S1/bin/lean.js'"
  # Node treats lean.js as ESM under a package.json with "type":"module"; a CJS marker beside the binary keeps the pthread workers alive.
  run runtime "$G" -- bash -c "test -f '$S1/bin/package.json' || printf '{ \"type\": \"commonjs\" }\n' > '$S1/bin/package.json'"
  # The gate runs qed64's pipeline copy (its node-runner carries the mirror
  # mount the 0031+ runtime needs to find its own binary; the kernel's sibling
  # runner does not). On pins that generate the exports list (0032+) the
  # gate is ADVISORY: under the proxied main (patch 0031) the process does
  # not exit after `main` returns, so the smoke times out even on a good
  # build — the bake lane's --verify-snapshots probe (a real elaboration on
  # every baked snapshot) is the acceptance test there.
  local gate="$QED64_DIR/pipeline/toolchain/gate.mjs"; [ -f "$gate" ] || gate="$KERNEL_DIR/wasm64-build/gate.mjs"
  if [ "$generated_exports" = 1 ]; then
    # Not run on these pins: it cannot pass (the proxied main never exits in
    # Node, so its smokes time out after ~30 min of wall-clock) and the bake
    # lane's --verify-snapshots probes are the acceptance test (preflight
    # requires both on such a pin).
    note "gate skipped: advisory on generated-exports pins — the bake lane's snapshot probes (--verify-snapshots) are the acceptance test"
  elif [ "$PLAN" = 1 ]; then
    run runtime "$QED64_DIR" -- node --stack-size=8192 "$gate" --artifact "$S1"; note "check: gate passed"
  else
    run_soft runtime "$QED64_DIR" -- node --stack-size=8192 "$gate" --artifact "$S1" || true
    tail -c +$((log_before + 1)) "$LOGS/runtime.log" | grep -q "GATE PASSED" || die "gate failed — see $LOGS/runtime.log"
    note "gate passed"
  fi
  local rid="wasm64-unknown"; [ "$PLAN" = 1 ] || rid="wasm64-$(sha16 "$S1/bin/lean.wasm")"
  note "runtime build id: $rid"
  [ "$PLAN" = 1 ] || { rm -rf "$STG/runtime"; mkdir -p "$STG"; }
  run runtime "$QED64_DIR" -- node "$QED64_DIR/pipeline/toolchain/chunk-runtime.mjs" --bin "$S1/bin" --lean-version "$LEAN_VERSION" --revision "qed64-wasm64@${PIN:0:9}" --out "$STG/runtime"
  check "chunk manifest carries build id $rid" bash -c "python3 -c \"import json,sys; sys.exit(0 if json.load(open('$STG/runtime/runtime-manifest.json'))['buildId']=='$rid' else 1)\""
  [ "$PLAN" = 1 ] || echo "$rid" > "$STG/RUNTIME_ID"
}
runtime_id() { [ -f "$STG/RUNTIME_ID" ] && cat "$STG/RUNTIME_ID" || { [ -s "$S1/bin/lean.wasm" ] && echo "wasm64-$(sha16 "$S1/bin/lean.wasm")" || echo "wasm64-unknown"; }; }

# ------------------------------------------------------------------- core --
lane_core() {
  say "core: Lean core library pack from stage1's Init facets"
  check "stage1 present (runtime lane)" test -d "$S1/lib/lean/Init"
  # Do stage1's Init facets match the pack the Mathlib oleans were compiled against?
  if [ "$PLAN" = 1 ]; then note "compare sha256 of $S1/lib/lean/Init/** with $PUB/profiles/lean-core.manifest.json"; else
    python3 - "$S1/lib/lean" "$PUB/profiles/lean-core.manifest.json" > "$LOGS/core-facets.txt" <<'PY' || die "facet comparison failed (see above)"
import hashlib, json, os, sys
lib, mf = sys.argv[1], sys.argv[2]
m = json.load(open(mf)); mods = (m.get("content") or {}).get("modules") or {}
same = diff = missing = 0
for name, mod in (mods.items() if isinstance(mods, dict) else ((x.get("name"), x) for x in mods)):
    arts = mod.get("artifacts") or {}
    for art in (arts.values() if isinstance(arts, dict) else arts):
        p = os.path.join(lib, art.get("filename") or art.get("path") or "")
        d = (art.get("digest") or art.get("sha256") or "").split(":")[-1]
        if not os.path.isfile(p): missing += 1; continue
        if hashlib.sha256(open(p, "rb").read()).hexdigest() == d: same += 1
        else: diff += 1
print(f"same={same} differ={diff} missing={missing}")
PY
    [ -s "$LOGS/core-facets.txt" ] || die "facet comparison produced no result"
    note "Init facets vs tracked core manifest: $(cat "$LOGS/core-facets.txt")"
    if grep -qE "differ=[1-9]|missing=[1-9]" "$LOGS/core-facets.txt"; then
      warn "stage1's Lean core differs from the pack the Mathlib oleans were compiled against; snapshots may fail to import Mathlib (a Mathlib rebuild is out of scope here)"
      [ "$STRICT" = 0 ] || die "--strict: core facets differ"
    fi
  fi
  if [ "$REUSE_CORE" = 1 ]; then
    check "tracked core pack parts present (fetch-artifacts.sh)" bash -c "ls '$PUB'/profiles/lean-core.pack.gzip.*.part-* >/dev/null 2>&1"
    [ "$PLAN" = 1 ] || { mkdir -p "$STG/profiles"; cp "$PUB"/profiles/index.json "$PUB"/profiles/lean-core.manifest.json "$PUB"/profiles/lean-core.pack.gzip.* "$STG/profiles/"; }
    note "reusing the tracked lean-core pack"; return 0
  fi
  local corelib="$OUT/core-lib"
  [ "$PLAN" = 1 ] || { rm -rf "$corelib"; mkdir -p "$corelib"; }
  run core "$G" -- bash -c "cp -R '$S1/lib/lean/Init' '$corelib/' && cp '$S1'/lib/lean/Init.olean* '$S1'/lib/lean/Init.ir* '$corelib/'"
  check "Init tree has > 600 oleans" bash -c "[ \$(find '$corelib' -name '*.olean' | wc -l) -gt 600 ]"
  [ "$PLAN" = 1 ] || { rm -rf "$STG/profiles"; mkdir -p "$STG/profiles"; }
  run core "$QED64_DIR" -- node "$QED64_DIR/pipeline/artifacts/pack.mjs" --lib "$corelib" --id lean-core --out "$STG/profiles" --mount /lib/lean/library --lean-version "$LEAN_VERSION" --revision "$PIN" --roots Init
  run core "$G" -- rm -f "$STG/profiles/lean-core.pack"   # the raw 388 MB pack is only an intermediate; the parts are what ships
  # the packer writes bare part names; the installer fetches part.url, and the game serves /profiles/...
  run core "$G" -- python3 - "$STG/profiles" "$(runtime_id)" "$LEAN_VERSION" <<'PY'
import json, os, sys
d, rid, lv = sys.argv[1:]
mf = os.path.join(d, "lean-core.manifest.json"); m = json.load(open(mf))
pack = (m.get("content") or {}).get("pack") or {}
def fix(u): return u if u.startswith("/profiles/") else "/profiles/" + os.path.basename(u)
if "url" in pack: pack["url"] = fix(pack["url"])
for p in (pack.get("transport") or {}).get("parts", []):
    if "url" in p: p["url"] = fix(p["url"])
json.dump(m, open(mf, "w"), indent=1)
idx = {"schema": "qed64.profile-index/v1", "runtime": {"buildId": rid, "leanVersion": lv},
       "profiles": [{"id": "core", "manifest": "/profiles/lean-core.manifest.json", "release": (m.get("content") or {}).get("release") or "lean-core", "modules": len(((m.get("content") or {}).get("modules") or {}))}]}
json.dump(idx, open(os.path.join(d, "index.json"), "w"), indent=1)
print("index.json + manifest urls written for", rid)
PY
  run core "$QED64_DIR" -- node "$QED64_DIR/pipeline/artifacts/inspect.mjs" "$STG/profiles/lean-core.manifest.json" --deep
}

# ------------------------------------------------------------------ trees --
lane_trees() {
  say "trees: unpack core + Mathlib packs, compile lean-i18n + GameServer, assemble the game base tree"
  local coremf="$STG/profiles/lean-core.manifest.json"; [ -f "$coremf" ] || coremf="$PUB/profiles/lean-core.manifest.json"
  check "core manifest with its parts beside it" test -f "$coremf"
  check "mathlib manifest present" test -f "$MATHLIB_MANIFEST"
  local mlmf="$MATHLIB_MANIFEST"
  if [ "$(dirname "$MATHLIB_MANIFEST")" != "$MATHLIB_PACK_DIR" ]; then mlmf="$MATHLIB_PACK_DIR/$(basename "$MATHLIB_MANIFEST")"; run trees "$G" -- cp "$MATHLIB_MANIFEST" "$mlmf"; fi
  [ "$PLAN" = 1 ] || { rm -rf "$TREES/lib-tree"; mkdir -p "$TREES/lib-tree"; }
  run trees "$QED64_DIR" -- node "$QED64_DIR/pipeline/artifacts/unpack.mjs" --manifest "$coremf" --out "$TREES/lib-tree"
  run trees "$QED64_DIR" -- node "$QED64_DIR/pipeline/artifacts/unpack.mjs" --manifest "$mlmf" --out "$TREES/lib-tree"
  check "Mathlib oleans unpacked (> 2000)" bash -c "[ \$(find '$TREES/lib-tree/Mathlib' -name '*.olean' 2>/dev/null | wc -l) -gt 2000 ]"
  [ "$PLAN" = 1 ] || rm -rf "$PKGS/i18n" "$PKGS/gameserver"
  compile_pkg trees "$G/vendor/i18n" "$PKGS/i18n" I18n "$TREES/lib-tree:$PKGS/i18n"
  compile_pkg trees "$G/server" "$PKGS/gameserver" GameServer "$TREES/lib-tree:$PKGS/i18n:$PKGS/gameserver"
  check "GameServer.Runner compiled" test -f "$PKGS/gameserver/GameServer/Runner.olean"
  [ "$PLAN" = 1 ] || rm -rf "$TREES/lib-tree-gamebase"
  local lakedir="$OUT/lake-facets"; [ "$PLAN" = 1 ] || { rm -rf "$lakedir"; mkdir -p "$lakedir"; }
  run trees "$G" -- bash -c "cp -R '$S1'/lib/lean/Lake '$lakedir'/ 2>/dev/null; cp '$S1'/lib/lean/Lake.* '$lakedir'/"
  overlay "$TREES/lib-tree" "$TREES/lib-tree-gamebase" "$lakedir" "$PKGS/i18n" "$PKGS/gameserver"
}

# ------------------------------------------------------------------ games --
lane_games() {
  say "games: compile TestGame + NNG4 (gamedata + per-game trees)"
  check "game base tree present (trees lane)" test -f "$TREES/lib-tree-gamebase/GameServer/Runner.olean"
  # TestGame (tracked sources)
  [ "$PLAN" = 1 ] || { rm -rf "$PKGS/testgame"; mkdir -p "$G/cypress/TestGame/.lake/gamedata"; }
  compile_pkg games "$G/cypress/TestGame" "$PKGS/testgame" Game "$TREES/lib-tree-gamebase:$PKGS/testgame"
  check "TestGame gamedata written" test -f "$G/cypress/TestGame/.lake/gamedata/game.json"
  # the compile regenerates the tracked translation template (timestamps only); keep the tree clean
  run games "$G" -- bash -c "git -C '$G' checkout -- cypress/TestGame/.i18n/en/project.pot 2>/dev/null || true"
  # NNG4 (fork branch, or upstream + the tracked patch)
  if [ ! -d "$G/games-src/NNG4" ]; then
    run games "$G" -- git clone https://github.com/hhu-adam/NNG4 "$G/games-src/NNG4"
    run games "$G/games-src/NNG4" -- git checkout "$NNG4_UPSTREAM"
    run games "$G/games-src/NNG4" -- git am "$G/wasm/patches/nng4-wasm64-port.patch"
  fi
  [ "$PLAN" = 1 ] || { rm -rf "$PKGS/nng4"; mkdir -p "$G/games-src/NNG4/.lake/gamedata"; }
  compile_pkg games "$G/games-src/NNG4" "$PKGS/nng4" Game "$TREES/lib-tree-gamebase:$PKGS/nng4"
  check "NNG4 gamedata written" test -f "$G/games-src/NNG4/.lake/gamedata/game.json"
  [ "$PLAN" = 1 ] || rm -rf "$TREES/lib-tree-nng4" "$TREES/lib-tree-testgame"
  overlay "$TREES/lib-tree-gamebase" "$TREES/lib-tree-nng4" "$PKGS/nng4"
  overlay "$TREES/lib-tree-gamebase" "$TREES/lib-tree-testgame" "$PKGS/testgame"
}

# ------------------------------------------------------------------- bake --
bake_one() { # bake_one <name> <lib-tree> <gamedata-dir|-> <reserve> [probe]
  local name="$1" lib="$2" gd="$3" reserve="$4" probe="${5:-}"
  local work="$QED64_DIR/work/snapshot"
  [ "$PLAN" = 1 ] || mkdir -p "$work/.lake"
  if [ "$gd" != "-" ]; then run bake "$G" -- bash -c "rm -rf '$work/.lake/gamedata' && rsync -a '$gd/' '$work/.lake/gamedata/'"; fi
  local -a args=(--name "$name" --artifact "$S1" --lib "$lib" --reserve "$reserve" --out "$STG/snapshots")
  [ -z "$probe" ] || args+=(--probe "$probe")
  run bake "$QED64_DIR" "QED64_ALLOW_LEGACY_IMPORTS=1" -- node --stack-size=8192 "$QED64_DIR/pipeline/snapshot/bake-snapshot.mjs" "${args[@]}"
}
lane_bake() {
  say "bake: environment snapshots against stage1 $(runtime_id) (sequential — one shared bake workspace)"
  check "per-game trees present (games lane)" test -d "$TREES/lib-tree-nng4"
  [ "$PLAN" = 1 ] || { rm -rf "$STG/snapshots"; mkdir -p "$STG/snapshots"; }
  local gprobe; gprobe="$(printf 'import Game\nimport GameServer.Runner\n#check (2 + 2 : Nat)')"
  bake_one init     "$TREES/lib-tree-testgame" - 1073741824
  bake_one testgame "$TREES/lib-tree-testgame" "$G/cypress/TestGame/.lake/gamedata" 1610612736 "$gprobe"
  bake_one nng4     "$TREES/lib-tree-nng4"     "$G/games-src/NNG4/.lake/gamedata"    2147483648 "$gprobe"
  check "three snapshots in the staging index" bash -c "python3 -c \"import json,sys; s={e['name'] for e in json.load(open('$STG/snapshots/index.json'))['snapshots']}; sys.exit(0 if s=={'init','testgame','nng4'} else 1)\""
  if [ "$VERIFY" = 1 ]; then
    local pf="$OUT/verify-probe.lean"
    # header == the baked import list (anything else is a cache miss, over budget by design)
    [ "$PLAN" = 1 ] || printf 'import Game\nimport GameServer.Runner\nRunner "MyGame" "Tutorial" 1 (difficulty := 1) (inventory := ["rfl"]) := by\nrfl\n' > "$pf"
    run bake "$QED64_DIR" "QED64_ALLOW_LEGACY_IMPORTS=1" -- node --stack-size=8192 "$QED64_DIR/pipeline/snapshot/snapshot-probe.mjs" --artifact "$S1" --snap "$QED64_DIR/work/snapshot/nng4.snap" --lib "$TREES/lib-tree-nng4" --workspace "$G/games-src/NNG4" --probe-file "$pf" --budget-ms 600000
    run bake "$QED64_DIR" "QED64_ALLOW_LEGACY_IMPORTS=1" -- node --stack-size=8192 "$QED64_DIR/pipeline/snapshot/snapshot-probe.mjs" --artifact "$S1" --snap "$QED64_DIR/work/snapshot/testgame.snap" --lib "$TREES/lib-tree-testgame" --workspace "$G/cypress/TestGame" --probe-file "$pf" --budget-ms 600000
  fi
}

# ----------------------------------------------------------------- bundle --
lane_bundle() {
  say "bundle: stage into client/public, build the client, pack the artifact bundle"
  local rid; rid="$(runtime_id)"; [ -n "$TAG" ] || TAG="artifacts-$rid"
  check "client dependencies installed (npm ci)" test -d "$G/node_modules"
  # workers / gamedata / i18n first, with the optional qed64 artifact import OFF (it would copy an old core pack over the new one)
  run bundle "$G" "QED64=/nonexistent" -- bash "$G/scripts/stage-game-assets.sh"
  if [ "$PLAN" = 1 ] || [ -d "$STG/runtime" ]; then run bundle "$G" -- bash -c "rm -rf '$PUB/runtime/chunks' && mkdir -p '$PUB/runtime' && cp -R '$STG/runtime/.' '$PUB/runtime/'"; fi
  if [ "$PLAN" = 1 ] || [ -d "$STG/profiles" ]; then run bundle "$G" -- bash -c "rm -f '$PUB'/profiles/lean-core.pack.gzip.* && mkdir -p '$PUB/profiles' && cp '$STG'/profiles/* '$PUB/profiles/'"; fi
  if [ "$PLAN" = 1 ] || [ -f "$STG/snapshots/index.json" ]; then run bundle "$G" -- python3 "$G/scripts/stage-snapshots.py" "$STG/snapshots" init nng4 testgame; fi
  check "served runtime id == $rid" bash -c "python3 -c \"import json,sys; sys.exit(0 if json.load(open('$PUB/runtime/runtime-manifest.json'))['buildId']=='$rid' else 1)\""
  run bundle "$G" -- npm --workspace client run build
  run bundle "$G" -- bash "$G/scripts/pack-artifacts.sh" "$TAG"
  note "tracked files to review + commit: client/public/runtime/runtime-manifest.json, profiles/{index,lean-core.manifest}.json, snapshots/index.json, data/, wasm/artifacts/BUNDLE.json"
  note "then upload wasm/out/artifacts/$TAG/*.tar + SHA256SUMS as release '$TAG' (the pack script printed the gh line)"
}

# ------------------------------------------------------------------- main --
STG="$OUT/staging"
[ "$PLAN" = 1 ] && say "PLAN MODE — printing steps only (cwd shown per command)"
for lane in preflight runtime core trees games bake bundle; do
  lane_on "$lane" || continue
  "lane_$lane"
done
say "done ($LANES)$([ "$PLAN" = 1 ] && echo ' — plan only')"
