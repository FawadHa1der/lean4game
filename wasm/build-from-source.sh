#!/usr/bin/env bash
# Build the lean4game wasm64 artifacts from source, end to end:
#
#   preflight → runtime (kernel → Docker → stage0/stage1 → gate → chunks)
#             → core   (Lean core library pack from stage1's Init facets)
#             → trees  (olean trees: core + Mathlib pack unpacked, lean-i18n
#                       and GameServer compiled with the native stage0)
#             → compat (wasm/compat: Mathlib leaves the essential pack
#                       excludes, compiled into the game base tree)
#             → games  (each selected catalog game compiled → gamedata +
#                       a slim per-game olean tree)
#             → bake   (one environment snapshot per selected game, plus
#                       init on a full run)
#             → bundle (stage into client/public, build the client, pack
#                       the artifact bundle for publishing)
#
# Which games exist is data: wasm/catalog.json, read only through
# scripts/games-manifest.mjs (--list: one TSV row per game with its snapshot
# name, source {url, rev, patch}, lean options, compactor reserve and
# expectedRaw; --probe: the game's Runner probe). This script names no game.
#
# Usage:
#   wasm/build-from-source.sh --plan                 # print every step, run nothing (no Docker needed)
#   wasm/build-from-source.sh                        # everything (hours, see below)
#   wasm/build-from-source.sh --lanes preflight,runtime
#   wasm/build-from-source.sh --lanes games,bake,bundle --games stg4 --verify-snapshots
#                          # one game: compile, bake, probe, stage — the other
#                          # games' staged snapshots are kept
#
# Options:
#   --plan                 print commands with cwd/env, execute nothing
#   --lanes a,b,c          subset of: preflight runtime core trees compat games bake bundle
#   --games a,b            catalog snapshot names (default: every catalog game).
#                          A run WITHOUT --games is a FULL run: the snapshot
#                          staging dir is wiped and init + every game is rebaked
#                          (slim, see SLIM_TREES) — the runtime-bump path.
#   --tag <tag>            bundle tag (default artifacts-<runtime build id>)
#   --reuse-core-pack      keep the tracked lean-core pack (parts must be in
#                          client/public/profiles, e.g. via fetch-artifacts.sh)
#                          instead of repacking from stage1
#   --verify-snapshots     run each selected game's catalog probe (a Runner
#                          document, games-manifest.mjs --probe) through
#                          snapshot-probe.mjs --via-mem — the browser worker's
#                          load path — against its baked snapshot
#   --strict               stop when stage1's Init facets differ from the pack
#                          the Mathlib oleans were compiled against (see CORE)
#
# Inputs (environment, all optional):
#   KERNEL_DIR   kernel source at the pin      (default wasm/kernel submodule)
#   QED64_DIR    pipeline scripts. Unset (default): the vendored
#                wasm/vendor/qed64-pipeline (scripts/sync-qed64.sh) is rsynced
#                to wasm/out/pipeline on every run and run from THERE, so the
#                bake workspace bake-snapshot.mjs hardcodes under its own root
#                (work/snapshot/<name>.snap — the re-probe material) lands in
#                the gitignored wasm/out and never under wasm/vendor. Set it
#                to run a qed64 checkout (or any pipeline dir) in place.
#   SLIM_TREES   1 (default): per-game olean trees omit the Mathlib pack's
#                *.olean.private facets — the importer tolerates missing
#                private parts and play-time never re-imports — which makes
#                the snapshot ~60 % smaller. 0: fat per-game trees. The
#                compile trees (lib-tree, lib-tree-gamebase) are always fat.
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
# the rest ~30–60 min (each bake ≥ 5 min of it is the reaper's idle wait).
# Every lane writes wasm/out/logs/<lane>.log.
#
# Pairing rules this script enforces: the runtime build id is
# "wasm64-" + sha256(lean.wasm)[:16]; the chunk manifest must carry it; every
# snapshot is baked against THAT stage1 and never mixed with another build
# (a --games run whose staging index pairs to another build id starts from
# an empty staging dir — bake-snapshot.mjs refuses a mixed index); the core
# pack and the olean trees come from the same stage1. A new kernel pin
# therefore means running everything: a full run is a full slim rebake.
#
# Snapshot size rule: after each game bake the raw region size is compared
# with the catalog row's expectedRaw when one is recorded for THIS pairing
# key — expectedRaw.runtime = the runtime build id, plus "+slim" when the
# per-game tree was slim (SLIM_TREES=1): a slim bake of the same environment
# is ~60 % smaller than a fat one, so a record made under one tree mode is
# never asserted against the other. More than ±5 % off stops the run (an
# environment change nobody recorded); otherwise the line to paste into
# wasm/catalog.json is printed. Raw bytes above the row's reserveBytes only
# warn (the compactor grows its buffer at host-RAM cost; the output is
# unaffected).
#
# Known limits (documented in wasm/KERNEL.md): the Mathlib oleans are an
# INPUT (the digest-pinned mathlib-essential pack), not rebuilt here — they
# were compiled against the served Lean core, so CORE compares stage1's Init
# facets with the tracked lean-core manifest and warns (or stops with
# --strict) when they differ; bit-reproducibility of the runtime at the pin
# has not been demonstrated (a rebuild is treated as a NEW build id).
set -euo pipefail

G="$(cd "$(dirname "$0")/.." && pwd)"
PLAN=0; LANES="preflight,runtime,core,trees,compat,games,bake,bundle"; GAMES=""; TAG=""; REUSE_CORE=0; VERIFY=0; STRICT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --plan) PLAN=1; shift ;;
    --lanes) LANES="$2"; shift 2 ;;
    --games) GAMES="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --reuse-core-pack) REUSE_CORE=1; shift ;;
    --verify-snapshots) VERIFY=1; shift ;;
    --strict) STRICT=1; shift ;;
    -h|--help) awk 'NR > 1 { if (/^set -euo/) exit; print }' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

KERNEL_DIR="${KERNEL_DIR:-$G/wasm/kernel}"
# Pipeline scripts: the vendored copy is never run in place (bake-snapshot.mjs
# hardcodes its workspace under its own root), so main syncs it to
# wasm/out/pipeline and every lane runs from there. An explicit QED64_DIR (a
# qed64 checkout, or any pipeline dir) is used as is.
QED64_SRC=""
if [ -z "${QED64_DIR:-}" ]; then QED64_SRC="$G/wasm/vendor/qed64-pipeline"; QED64_DIR="$G/wasm/out/pipeline"; fi
case "$QED64_DIR/" in "$G/wasm/vendor/"*) echo "QED64_DIR=$QED64_DIR is inside wasm/vendor — the bake workspace must not land there; unset it (a copy is made under wasm/out/pipeline) or point it at a qed64 checkout" >&2; exit 2 ;; esac
BUILD_DIR="${BUILD_DIR:-$G/wasm/out/kernel-build}"
S1="$BUILD_DIR/build/stage1"; S0="$BUILD_DIR/build/stage0/bin"
OUT="$G/wasm/out"; TREES="$OUT/trees"; LOGS="$OUT/logs"; PKGS="$OUT/pkgs"
# The Mathlib olean pack: fetched into wasm/out/mathlib-pack by `scripts/fetch-artifacts.sh --mathlib`
# (the bundle's optional mathlib-pack.tar), or any directory holding the manifest + parts.
MATHLIB_PACK_DIR="${MATHLIB_PACK_DIR:-$OUT/mathlib-pack}"
MATHLIB_MANIFEST="${MATHLIB_MANIFEST:-$MATHLIB_PACK_DIR/mathlib-essential.manifest.json}"
SLIM_TREES="${SLIM_TREES:-1}"
case "$SLIM_TREES" in 0|1) ;; *) echo "SLIM_TREES must be 0 or 1 (got '$SLIM_TREES')" >&2; exit 2 ;; esac
IMAGE="qed64-toolchain:emsdk-6.0.5"; LEAN_VERSION="4.33.0-pre"
PIN="$(grep -Eo '^[0-9a-f]{40}' "$G/wasm/KERNEL-PIN" 2>/dev/null | head -1 || true)"   # the game's own kernel pin (= wasm/kernel submodule commit)
QPIN="$(grep -Eo '[0-9a-f]{40}' "$G/client/src/wasm/vendor/QED64-PIN" 2>/dev/null | head -1 || true)"
PUB="$G/client/public"
mkdir -p "$LOGS" "$OUT"

# ---------------------------------------------------------------- helpers --
say()  { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
warn() { printf '\033[1;33m   warning: %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31merror: %s\033[0m\n' "$*" >&2; exit 1; }
lane_on() { case ",$LANES," in *,"$1",*) return 0 ;; *) return 1 ;; esac; }
has_word() { case " $2 " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }   # has_word <word> <space-separated list>
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
compile_pkg() { # compile_pkg <log> <src-dir> <out-dir> <root(s), space-separated> <LEAN_PATH> [LEAN_OPTS: "-Dk=v ..."]
  local log="$1" src="$2" out="$3" roots="$4" lp="$5" opts="${6:-}"
  [ "$PLAN" = 1 ] || mkdir -p "$out"
  # shellcheck disable=SC2086  # roots is a word list on purpose
  docker_run "$log" "$src" "LEAN=$S0/lean" "LEAN_PATH=$lp" ${opts:+"LEAN_OPTS=$opts"} -- python3 "$G/wasm/scripts/compile-pkg.py" "$src" "$out" $roots
}
overlay() { # overlay <base-tree> <new-tree> <extra dirs...>   (hard-linked copy of base + extras on top; fat)
  local base="$1" new="$2"; shift 2
  run trees "$G" -- rsync -a --link-dest="$base" "$base/" "$new/"
  for x in "$@"; do run trees "$G" -- rsync -a "$x/" "$new/"; done
}
overlay_game() { # overlay_game <base-tree> <new-tree> <game pkg dir>   (as overlay; SLIM_TREES=1 drops the base's *.olean.private facets)
  local base="$1" new="$2" pkg="$3"; local -a ex=()
  [ "$SLIM_TREES" = 0 ] || ex=(--exclude='*.olean.private')
  run games "$G" -- rsync -a --link-dest="$base" ${ex[@]+"${ex[@]}"} "$base/" "$new/"
  run games "$G" -- rsync -a "$pkg/" "$new/"
}

# ---------------------------------------------------------------- catalog --
# One TSV row per game from scripts/games-manifest.mjs --list (its COLUMNS:
# snapshot owner game id listed src reserveBytes sourceUrl sourceRev
# sourcePatch leanOptions expectedRuntime expectedBytes; '-' = empty).
# row_vars <row> loads a row into the R_* variables the lanes read.
row_vars() { IFS=$'\t' read -r R_SNAP R_OWNER R_GAME R_ID R_LISTED R_SRC R_RESERVE R_URL R_REV R_PATCH R_OPTS R_ERT R_EBYTES <<<"$1"; }
lean_flags() { # lean_flags <k=v,k=v | -> → "-Dk=v -Dk=v" (compile-pkg.py LEAN_OPTS)
  local out="" o; if [ "$1" != "-" ]; then for o in ${1//,/ }; do out="${out:+$out }-D$o"; done; fi; echo "$out"
}
CATALOG_ROWS=(); ROWS=(); ALL_NAMES=""; SELECTED_NAMES=""
while IFS= read -r line; do
  [ -n "$line" ] || continue
  CATALOG_ROWS+=("$line"); row_vars "$line"; ALL_NAMES="${ALL_NAMES:+$ALL_NAMES }$R_SNAP"
  if [ -z "$GAMES" ] || has_word "$R_SNAP" "${GAMES//,/ }"; then ROWS+=("$line"); SELECTED_NAMES="${SELECTED_NAMES:+$SELECTED_NAMES }$R_SNAP"; fi
done < <(node "$G/scripts/games-manifest.mjs" --list)
[ ${#CATALOG_ROWS[@]} -gt 0 ] || die "no games in wasm/catalog.json (node scripts/games-manifest.mjs --check)"
for g in ${GAMES//,/ }; do has_word "$g" "$ALL_NAMES" || die "--games $g: no catalog game has that snapshot name (catalog: $ALL_NAMES)"; done
FULL_RUN=1; [ -z "$GAMES" ] || FULL_RUN=0                 # full run = no --games: wipe staging, rebake init + every game
FIRST_SNAP="${SELECTED_NAMES%% *}"                        # its tree also bakes init (any game tree does: init imports nothing)
BAKE_NAMES="$SELECTED_NAMES"; [ "$FULL_RUN" = 0 ] || BAKE_NAMES="init $SELECTED_NAMES"

# -------------------------------------------------------------- preflight --
lane_preflight() {
  say "preflight"
  note "repo $G"; note "kernel $KERNEL_DIR"; note "qed64 $QED64_DIR${QED64_SRC:+ (copy of $QED64_SRC)}"; note "build $BUILD_DIR"
  [ -f "$KERNEL_DIR/wasm64-build/build.sh" ] || die "kernel source missing — run: git submodule update --init --checkout wasm/kernel   (or set KERNEL_DIR)"
  local qsrc="${QED64_SRC:-$QED64_DIR}"
  [ -f "$qsrc/pipeline/snapshot/bake-snapshot.mjs" ] || die "pipeline scripts missing at $qsrc — run scripts/sync-qed64.sh <qed64-commit> (or set QED64_DIR to a qed64 checkout)"
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
  node "$G/scripts/games-manifest.mjs" --check || die "wasm/catalog.json failed its check"
  note "games: $SELECTED_NAMES$([ "$FULL_RUN" = 1 ] && echo '   (full run: staging wiped, init + every game rebaked)' || echo "   (--games: the other games' staged snapshots are kept)")   slim trees: $SLIM_TREES"
  local nv; nv="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1 || echo 0)"; [ "${nv:-0}" -ge 24 ] || die "Node >= 24 required (Memory64), found $(node -v 2>/dev/null || echo none)"
  command -v python3 >/dev/null || die "python3 required"; command -v rsync >/dev/null || die "rsync required"
  if docker info >/dev/null 2>&1; then
    local mem; mem="$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)"
    note "docker: $((mem / 1073741824)) GiB VM memory$([ "$mem" -ge 10737418240 ] || echo '  — WARNING: < 10 GiB, the wasm link step needs ~7 GiB free')"
  else
    warn "docker daemon not reachable — the runtime, trees, compat and games lanes need it"
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
  # a fresh game base tree needs the compat modules again (they are compiled against the fat tree just unpacked)
  lane_compat
}

# ----------------------------------------------------------------- compat --
# wasm/compat: Mathlib modules games import that the essential pack EXCLUDES
# (Mathlib.Tactic.Have, Mathlib.Tactic.Cases — leaves no analysis module
# imports; wasm/compat/README.md), compiled once under their real module
# names into the game base tree so a game's unmodified imports resolve.
COMPAT_DONE=0
lane_compat() {
  [ "$COMPAT_DONE" = 0 ] || return 0
  say "compat: wasm/compat (Mathlib.Tactic.Have + Mathlib.Tactic.Cases) → game base tree"
  check "fat olean tree present (trees lane)" test -d "$TREES/lib-tree/Mathlib/Tactic"
  check "game base tree present (trees lane)" test -f "$TREES/lib-tree-gamebase/GameServer/Runner.olean"
  # A pack that ships the real modules must not be shadowed by these copies: delete the compat file instead.
  check "the Mathlib pack does not itself provide Mathlib.Tactic.Have / Cases (else drop the wasm/compat copy)" bash -c "! test -e '$TREES/lib-tree/Mathlib/Tactic/Have.olean' && ! test -e '$TREES/lib-tree/Mathlib/Tactic/Cases.olean'"
  # compile-pkg.py skips oleans newer than their source: after a trees run they are stale, not fresh
  [ "$PLAN" = 1 ] || rm -rf "$PKGS/compat"
  compile_pkg compat "$G/wasm/compat" "$PKGS/compat" "Mathlib.Tactic.Have Mathlib.Tactic.Cases" "$TREES/lib-tree:$PKGS/compat"
  check "compat oleans compiled" bash -c "test -f '$PKGS/compat/Mathlib/Tactic/Have.olean' && test -f '$PKGS/compat/Mathlib/Tactic/Cases.olean'"
  run compat "$G" -- rsync -a "$PKGS/compat/" "$TREES/lib-tree-gamebase/"
  COMPAT_DONE=1
}

# ------------------------------------------------------------------ games --
ensure_source() { # ensure_source <src> <url|-> <rev> <patch|->   (clone + checkout + git am when the tree is absent; games-src/ is gitignored)
  local src="$1" url="$2" rev="$3" patch="$4"
  [ ! -d "$G/$src" ] || return 0
  [ "$url" != "-" ] || die "game source $src is missing and its catalog row has no source {url, rev} to clone from"
  run games "$G" -- git clone "$url" "$G/$src"
  run games "$G/$src" -- git checkout "$rev"
  [ "$patch" = "-" ] || run games "$G/$src" -- git am "$G/$patch"
}
lane_games() {
  say "games: compile $SELECTED_NAMES (gamedata + per-game trees; SLIM_TREES=$SLIM_TREES)"
  check "game base tree present (trees lane)" test -f "$TREES/lib-tree-gamebase/GameServer/Runner.olean"
  [ "$PLAN" = 1 ] || [ -f "$TREES/lib-tree-gamebase/Mathlib/Tactic/Have.olean" ] || warn "no compat oleans in the game base tree (compat lane not run): a game importing Mathlib.Tactic.Have/Cases will fail to compile"
  local row
  for row in "${ROWS[@]}"; do
    row_vars "$row"
    ensure_source "$R_SRC" "$R_URL" "$R_REV" "$R_PATCH"
    [ "$PLAN" = 1 ] || { rm -rf "$PKGS/$R_SNAP"; mkdir -p "$G/$R_SRC/.lake/gamedata"; }
    compile_pkg games "$G/$R_SRC" "$PKGS/$R_SNAP" Game "$TREES/lib-tree-gamebase:$PKGS/$R_SNAP" "$(lean_flags "$R_OPTS")"
    check "$R_ID gamedata written" test -f "$G/$R_SRC/.lake/gamedata/game.json"
    # The compile rewrites the .pot translation template (creation date, msgid
    # order); restore it so the tree stays clean for the next checkout / git am.
    # Only the templates: the translations tracked beside them
    # (.i18n/<lang>/Game.{po,json}) may hold uncommitted work. (A game whose
    # .i18n/config.json sets useJson=true writes .i18n/<sourceLang>/Game.json
    # as its template instead — none in the catalog does.)
    if [ -d "$G/$R_SRC/.git" ] || { [ "$PLAN" = 1 ] && [ "$R_URL" != "-" ]; }; then run games "$G" -- bash -c "git -C '$G/$R_SRC' checkout -- '.i18n/*/*.pot' 2>/dev/null || true"
    else run games "$G" -- bash -c "git -C '$G' checkout -- '$R_SRC/.i18n/*/*.pot' 2>/dev/null || true"; fi
    [ "$PLAN" = 1 ] || rm -rf "$TREES/lib-tree-$R_SNAP"
    overlay_game "$TREES/lib-tree-gamebase" "$TREES/lib-tree-$R_SNAP" "$PKGS/$R_SNAP"
  done
}

# ------------------------------------------------------------------- bake --
bake_one() { # bake_one <name> <lib-tree> <reserve> [probe]   (the bake probe is a #check: no gamedata needed — only the verify probe reads it, via --workspace)
  local name="$1" lib="$2" reserve="$3" probe="${4:-}"
  local -a args=(--name "$name" --artifact "$S1" --lib "$lib" --reserve "$reserve" --out "$STG/snapshots")
  [ -z "$probe" ] || args+=(--probe "$probe")
  run bake "$QED64_DIR" "QED64_ALLOW_LEGACY_IMPORTS=1" -- node --stack-size=8192 "$QED64_DIR/pipeline/snapshot/bake-snapshot.mjs" "${args[@]}"
}
index_field() { # index_field <index.json> <name> <field>  → the entry's field, or empty
  python3 -c "import json,sys; e=[e for e in json.load(open(sys.argv[1]))['snapshots'] if e['name']==sys.argv[2]]; print(e[0].get(sys.argv[3],'') if e else '')" "$1" "$2" "$3" 2>/dev/null || true
}
index_runtime() { # index_runtime <index.json> → the first entry's runtime, or empty
  python3 -c "import json,sys; s=json.load(open(sys.argv[1]))['snapshots']; print(s[0].get('runtime','') if s else '')" "$1" 2>/dev/null || true
}
bake_size_check() { # bake_size_check <pairing key> <index.json>   for the catalog row in R_*, just baked
  # The key is the runtime build id plus "+slim" for a slim per-game tree
  # (lane_bake): the catalog's expectedRaw.runtime must match it exactly, so
  # a fat record (~2.5x the slim size) is never asserted against a slim bake.
  local key="$1" idx="$2"
  if [ "$PLAN" = 1 ]; then
    if [ "$R_ERT" = "$key" ] && [ "$R_EBYTES" != "-" ]; then note "check: $R_SNAP raw bytes within 5% of expectedRaw $R_EBYTES (wasm/catalog.json, runtime $key)"
    else note "print: record in wasm/catalog.json ($R_ID): \"expectedRaw\": {\"runtime\": \"$key\", \"bytes\": <raw>}   (none recorded for $key)"; fi
    note "check: $R_SNAP raw bytes <= reserveBytes $R_RESERVE (warning only)"; return 0
  fi
  local bytes; bytes="$(index_field "$idx" "$R_SNAP" bytes)"
  [ -n "$bytes" ] || die "no '$R_SNAP' entry in $idx after the bake"
  if [ "$R_ERT" = "$key" ] && [ "$R_EBYTES" != "-" ]; then
    local tol=$((R_EBYTES / 20)) d=$((bytes - R_EBYTES)); [ "$d" -ge 0 ] || d=$((-d))
    [ "$d" -le "$tol" ] || die "$R_SNAP raw size $bytes differs from the catalog's expectedRaw $R_EBYTES by $d bytes (> 5% = $tol): the environment changed in a way nobody recorded — if intended, set $R_ID in wasm/catalog.json to \"expectedRaw\": {\"runtime\": \"$key\", \"bytes\": $bytes}"
    note "$R_SNAP raw $bytes bytes (expectedRaw $R_EBYTES, within 5%)"
  else
    note "record in wasm/catalog.json ($R_ID): \"expectedRaw\": {\"runtime\": \"$key\", \"bytes\": $bytes}"
  fi
  [ "$bytes" -le "$R_RESERVE" ] || warn "$R_SNAP raw $bytes bytes > reserveBytes $R_RESERVE: the compactor grew its buffer (host RAM only, output unaffected) — raise reserveBytes in wasm/catalog.json"
}
lane_bake() {
  local rid; rid="$(runtime_id)"; local idx="$STG/snapshots/index.json"
  # expectedRaw pairing key (bake_size_check): the build id, "+slim" when the
  # per-game trees omit the private facets — the two sizes differ by ~60 %.
  local key="$rid"; [ "$SLIM_TREES" = 0 ] || key="$rid+slim"
  say "bake: $BAKE_NAMES against stage1 $rid (sequential — one shared bake workspace, $QED64_DIR/work/snapshot; expectedRaw key $key)"
  local row
  for row in "${ROWS[@]}"; do row_vars "$row"; check "lib-tree-$R_SNAP present (games lane)" test -d "$TREES/lib-tree-$R_SNAP"; done
  # Staging survives a --games run (the other games' .snapz + index entries
  # stay for the bundle lane). It is wiped on a full run — a full run is a
  # full rebake by design — and whenever its entries pair to another runtime
  # (bake-snapshot.mjs refuses to upsert into a mixed index).
  if [ "$FULL_RUN" = 1 ]; then
    run bake "$G" -- rm -rf "$STG/snapshots"
  elif [ -f "$idx" ] && [ "$rid" != "wasm64-unknown" ]; then
    local srt; srt="$(index_runtime "$idx")"
    if [ -n "$srt" ] && [ "$srt" != "$rid" ]; then
      warn "staging index pairs to runtime $srt, stage1 is $rid — wiping $STG/snapshots (the other games need a rebake against this runtime too)"
      run bake "$G" -- rm -rf "$STG/snapshots"
    fi
  fi
  [ "$PLAN" = 1 ] || mkdir -p "$STG/snapshots"
  local gprobe; gprobe="$(printf 'import Game\nimport GameServer.Runner\n#check (2 + 2 : Nat)')"
  # init (the core-only environment) imports nothing: any game tree bakes it
  if [ "$FULL_RUN" = 1 ]; then bake_one init "$TREES/lib-tree-$FIRST_SNAP" 1073741824; fi
  for row in "${ROWS[@]}"; do
    row_vars "$row"
    bake_one "$R_SNAP" "$TREES/lib-tree-$R_SNAP" "$R_RESERVE" "$gprobe"
    bake_size_check "$key" "$idx"
  done
  check "every baked name in the staging index ($BAKE_NAMES)" bash -c "python3 -c \"import json,sys; s={e['name'] for e in json.load(open('$idx'))['snapshots']}; sys.exit(1 if [n for n in sys.argv[1:] if n not in s] else 0)\" $BAKE_NAMES"
  # bake-snapshot.mjs never unlinks older content-addressed .snapz files (additive
  # by design); with staging kept across --games runs, prune what the index no longer names.
  run bake "$G" -- python3 - "$STG/snapshots" <<'PY'
import json, os, sys
d = sys.argv[1]
keep = {os.path.basename(e["url"]) for e in json.load(open(os.path.join(d, "index.json")))["snapshots"]}
for f in sorted(os.listdir(d)):
    if f.endswith(".snapz") and f not in keep:
        os.unlink(os.path.join(d, f)); print("pruned superseded", f)
PY
  if [ "$VERIFY" = 1 ]; then
    for row in "${ROWS[@]}"; do
      row_vars "$row"
      local pf="$OUT/verify-$R_SNAP.lean"
      # header == the baked import list (anything else is a cache miss, over
      # budget by design); the Runner document is the catalog row's probe.
      if [ "$PLAN" = 1 ]; then note "write $pf from: node scripts/games-manifest.mjs --probe $R_SNAP"
      else node "$G/scripts/games-manifest.mjs" --probe "$R_SNAP" > "$pf" || die "no probe for $R_SNAP (no game.json yet — games lane not run?)"; fi
      run bake "$QED64_DIR" "QED64_ALLOW_LEGACY_IMPORTS=1" -- node --stack-size=8192 "$QED64_DIR/pipeline/snapshot/snapshot-probe.mjs" --via-mem --artifact "$S1" --snap "$QED64_DIR/work/snapshot/$R_SNAP.snap" --lib "$TREES/lib-tree-$R_SNAP" --workspace "$G/$R_SRC" --probe-file "$pf" --budget-ms 600000
    done
  fi
}

# ----------------------------------------------------------------- bundle --
lane_bundle() {
  say "bundle: stage into client/public, build the client, pack the artifact bundle"
  local rid; rid="$(runtime_id)"; [ -n "$TAG" ] || TAG="artifacts-$rid"
  check "client dependencies installed (npm ci)" test -d "$G/node_modules"
  # workers / gamedata / i18n / api/games first (catalog-driven, scripts/stage-game-assets.sh)
  run bundle "$G" -- bash "$G/scripts/stage-game-assets.sh"
  if [ "$PLAN" = 1 ] || [ -d "$STG/runtime" ]; then run bundle "$G" -- bash -c "rm -rf '$PUB/runtime/chunks' && mkdir -p '$PUB/runtime' && cp -R '$STG/runtime/.' '$PUB/runtime/'"; fi
  if [ "$PLAN" = 1 ] || [ -d "$STG/profiles" ]; then run bundle "$G" -- bash -c "rm -f '$PUB'/profiles/lean-core.pack.gzip.* && mkdir -p '$PUB/profiles' && cp '$STG'/profiles/* '$PUB/profiles/'"; fi
  # shellcheck disable=SC2086  # BAKE_NAMES is a word list
  if [ "$PLAN" = 1 ] || [ -f "$STG/snapshots/index.json" ]; then run bundle "$G" -- python3 "$G/scripts/stage-snapshots.py" "$STG/snapshots" $BAKE_NAMES; fi
  check "served runtime id == $rid" bash -c "python3 -c \"import json,sys; sys.exit(0 if json.load(open('$PUB/runtime/runtime-manifest.json'))['buildId']=='$rid' else 1)\""
  run bundle "$G" -- npm --workspace client run build
  run bundle "$G" -- bash "$G/scripts/pack-artifacts.sh" "$TAG"
  note "tracked files to review + commit: client/public/runtime/runtime-manifest.json, profiles/{index,lean-core.manifest}.json, snapshots/index.json, api/games, data/, i18n/, wasm/artifacts/BUNDLE.json, wasm/catalog.json (expectedRaw lines printed by the bake lane)"
  note "then upload wasm/out/artifacts/$TAG/*.tar + SHA256SUMS as release '$TAG' (the pack script printed the gh line)"
}

# ------------------------------------------------------------------- main --
STG="$OUT/staging"
[ "$PLAN" = 1 ] && say "PLAN MODE — printing steps only (cwd shown per command)"
# The pipeline runs from a copy under wasm/out (gitignored): its work/ — the
# bake workspace with the raw .snap files a re-probe needs — is kept across
# runs and never lands under wasm/vendor (scripts/sync-qed64.sh replaces that tree).
if [ -n "$QED64_SRC" ]; then run pipeline "$G" -- rsync -a --delete --exclude=/work/ "$QED64_SRC/" "$QED64_DIR/"; fi
for lane in preflight runtime core trees compat games bake bundle; do
  lane_on "$lane" || continue
  "lane_$lane"
done
say "done ($LANES)$([ "$PLAN" = 1 ] && echo ' — plan only')"
