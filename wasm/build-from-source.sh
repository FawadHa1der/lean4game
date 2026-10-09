#!/usr/bin/env bash
# Build the lean4game wasm64 artifacts from the pinned toolchain release:
#
#   preflight → release (fetch + verify the pinned lean4-wasm64 release: the
#                        runtime, the library packs, the native compiler and
#                        the module lists)
#             → trees   (olean trees: the release's packs unpacked fat for
#                        compiling and slim for baking; lean-i18n and
#                        GameServer compiled with the release's native64)
#             → games   (each selected catalog game compiled → gamedata + a
#                        slim per-game olean tree)
#             → bake    (one environment snapshot per selected game, against
#                        the release's runtime)
#             → bundle  (stage into client/public, build the client, pack
#                        the artifact bundle for publishing)
#
# Which toolchain is data: the root package.json pins the release's tools
# (devDependency `lean4-wasm64`, the release's own tgz) and
# wasm/lean4-wasm64-release.json is a byte copy of that release's record
# (release.json, lean4-wasm64.release/v1) — its id and self-digest are the
# pin every fetch is checked against, and the lanes read the runtime build
# id, the Lean version and the native compiler from it
# (scripts/stage-workers.sh reads its kernel.patch for the workers' floor).
# This repository builds no compiler and no runtime: the kernel fork
# publishes them (github.com/FawadHa1der/lean4, wasm64-build/RELEASE.md).
#
# Which games exist is data: wasm/catalog.json, read only through
# scripts/games-manifest.mjs (--list: one TSV row per game with its snapshot
# name, source {url, rev, patch}, lean options, compactor reserve and
# expectedRaw; --probe: the game's Runner probe). This script names no game.
#
# Usage:
#   wasm/build-from-source.sh --plan                 # print every step, run nothing (no Docker, no network)
#   wasm/build-from-source.sh                        # everything (~4 h for the ten games, see below)
#   wasm/build-from-source.sh --lanes preflight,release,trees
#   wasm/build-from-source.sh --lanes games,bake --games stg4 --verify-snapshots
#                          # one game: compile, bake, probe — the other
#                          # games' staged snapshots are kept
#
# Options:
#   --plan                 print commands with cwd/env, execute nothing
#   --lanes a,b,c          subset of: preflight release trees games bake bundle
#   --games a,b            catalog snapshot names (default: every catalog game).
#                          A run WITHOUT --games is a FULL run: this runtime's
#                          snapshot staging dir is wiped and every game is
#                          rebaked (slim, see SLIM_TREES) — the release-bump path.
#   --tag <tag>            bundle tag (default artifacts-<runtime build id>)
#   --verify-snapshots     run each selected game's catalog probe (a Runner
#                          document, games-manifest.mjs --probe) through
#                          snapshot-probe.mjs --via-mem — the browser worker's
#                          load path — against its baked snapshot, and every
#                          catalog probe of the game (probe, probe2, …: --probes)
#                          through the native compiler against the same
#                          per-game tree, with a negative control (the wasm
#                          one-shot compile does not see the errors of a
#                          Runner proof; lane_bake)
#
# Inputs (environment, all optional):
#   RELEASE_FROM  where the release is fetched from. Default: the GitHub release
#                 download URL the lockfile's lean4-wasm64 tgz came from. Also:
#                 an R2 or site URL in the served layout, or a local release
#                 directory (a kernel fix under test, before its owner
#                 publishes it: copy its release.json over the tracked record
#                 and install its tools tgz first). The id and digest checks
#                 are the same for all.
#   QED64_DIR     pipeline scripts (bake-snapshot.mjs, snapshot-probe.mjs).
#                 Default: the installed qed64 package (the SHA pinned in
#                 client/package.json; `npm ci` installs it), run in place —
#                 every path they write is passed explicitly (--work, --out,
#                 --lib, --artifact) and lies under wasm/out, so nothing is
#                 written under node_modules. Set it to run a qed64 checkout.
#   SLIM_TREES    1 (default): the per-game olean trees are built on the
#                 release's packs unpacked with --slim (no *.olean.private
#                 facets — the importer tolerates missing private parts and
#                 play-time never re-imports), which makes the snapshot ~60 %
#                 smaller. 0: fat per-game trees. The compile trees (lib-tree,
#                 lib-tree-gamebase) are always fat.
#
# Requirements: Docker that runs the release's native compiler platform
# (release.json native64: linux/aarch64 — native on Apple silicon and arm64
# Linux; an x86_64 host needs qemu user emulation, which Docker Desktop
# ships and a Linux host gets once with
# `docker run --privileged --rm tonistiigi/binfmt --install arm64`; emulated
# compiles are several times slower). The lane builds its own small image
# from wasm/docker/Dockerfile on first use (Ubuntu 24.04 pinned by digest +
# python3 + libuv, ~40 MB; tag lean4game-native64:<Dockerfile sha256[:12]>)
# — not the release's ~3 GB emsdk build image, which only its builder needs.
# Preflight refuses to start a Docker lane (release, trees, games, and bake
# with --verify-snapshots) when Docker is unreachable or cannot run the
# platform. Also Node >= 24, python3, rsync, openssl, ~25 GB free disk
# (~12 GB before any bake), network for the first fetch (~2.3 GB). Compiles
# are sequential: each `lean` imports a game's whole closure (> 3 GB RSS for
# the largest) and two at once get OOM-killed silently in an 8 GiB Docker VM.
# Every lane writes wasm/out/logs/<lane>.log.
#
# Pairing rules this script enforces: the runtime build id is
# "wasm64-" + sha256(lean.wasm)[:16], recomputed from the fetched binary and
# compared with the record's runtime.buildId; every snapshot is baked against
# THAT runtime and never mixed with another build: snapshots are staged per
# runtime (wasm/out/staging/<build id>/snapshots), so a bake against another
# record (a kernel fix under test) never touches this runtime's staged
# snapshots, and the bundle lane refuses to serve an index that would mix two
# runtimes. A new release pin therefore means running everything: a full run
# is a full slim rebake.
#
# Provenance rules (wasm/scripts/tree-stamp.py): the trees lane stamps the
# base trees with the packs' rawSha256 and the native compiler's tarball
# sha256 from the record; the games lane stamps each per-game tree with
# those plus the game's source pin (catalog rev + the patch's sha256), after
# checking that an existing games-src checkout is exactly rev + patch. The
# games lane refuses base trees, and the bake lane per-game trees, whose
# stamp is not the one the pinned record (and catalog row) gives — a record
# whose packs and native64 are byte-identical (a runtime-only release) gives
# the same stamp, so its trees carry over.
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
set -euo pipefail

G="$(cd "$(dirname "$0")/.." && pwd)"
PLAN=0; LANES="preflight,release,trees,games,bake,bundle"; GAMES=""; TAG=""; VERIFY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --plan) PLAN=1; shift ;;
    --lanes) LANES="$2"; shift 2 ;;
    --games) GAMES="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --verify-snapshots) VERIFY=1; shift ;;
    -h|--help) awk 'NR > 1 { if (/^set -euo/) exit; print }' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
for l in ${LANES//,/ }; do
  case "$l" in preflight|release|trees|games|bake|bundle) ;; *) echo "unknown lane: $l (lanes: preflight release trees games bake bundle)" >&2; exit 2 ;; esac
done

# The toolchain release: the tracked record (its id and digest are the pin)
# and the tools package that reads it, resolved from the repo root.
REC="$G/wasm/lean4-wasm64-release.json"
L4W="$(node -p "require('path').dirname(require.resolve('lean4-wasm64/package.json', { paths: [process.argv[1]] }))" "$G" 2>/dev/null || true)"
[ -n "$L4W" ] || { echo "the lean4-wasm64 tools are not installed — run npm ci in $G" >&2; exit 2; }
[ -f "$REC" ] || { echo "no toolchain release record at $REC" >&2; exit 2; }
# The record's fields the lanes read, as KEY=value lines (every value a plain
# token: ids, hex digests, versions, release paths).
RECORD_VARS="$(node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const v = { RID: r.id, RDIGEST: r.digest, BUILD_ID: r.runtime.buildId, LEAN_VERSION: r.lean.version,
    KPATCH: r.kernel.patch, KCOMMIT: r.kernel.commit, TOOLS_VERSION: r.tools.version, TOOLS_TGZ: r.tools.tgz,
    NATIVE_TAR: r.native64.tar, NATIVE_COMMIT: r.native64.commit, NATIVE_OS: r.native64.os,
    NATIVE_ARCH: r.native64.arch, LIST_ESSENTIAL: r.modules.essential,
    LIST_EXTRA: r.modules.extra, RUNTIME_MANIFEST: r.runtime.manifest };
  for (const [k, x] of Object.entries(v)) {
    if (!/^[A-Za-z0-9._:+\/-]+$/.test(String(x))) throw new Error(`${k}: unexpected value ${JSON.stringify(x)}`);
    console.log(`${k}=${x}`);
  }
' "$REC")" || { echo "$REC is not a readable lean4-wasm64 release record" >&2; exit 2; }
eval "$RECORD_VARS"
# The release's own source: the directory of the tgz the lockfile pins (the
# GitHub release download URL), unless RELEASE_FROM names another copy.
L4W_URL="$(node -p 'require(process.argv[1]).packages?.["node_modules/lean4-wasm64"]?.resolved ?? ""' "$G/package-lock.json" 2>/dev/null || true)"
[ -n "${RELEASE_FROM:-}" ] || [ -n "$L4W_URL" ] || { echo "package-lock.json pins no lean4-wasm64 tgz — run npm install (or set RELEASE_FROM)" >&2; exit 2; }
RELEASE_FROM="${RELEASE_FROM:-${L4W_URL%/*}/}"
# The packs a game environment is built from: the browser core (Init), the
# Mathlib closure QED64 serves (Lean, Std, Mathlib and its dependencies) and
# the game-only Mathlib leaves (the Mathlib.Tactic umbrella, Have, Cases,
# Generalize, the *.Star instances, NormNum.Prime, …: release lists/extra-*).
PACKS="lean-core mathlib-essential mathlib-game-extra"
# Pipeline scripts: the qed64 package's, resolved the way the bundler resolves
# `qed64/embed` (from client/, wherever npm put it), run in place.
QED64_PKG="$(node -p "require('path').dirname(require.resolve('qed64/package.json', { paths: [process.argv[1]] }))" "$G/client" 2>/dev/null || true)"
QED64_DIR="${QED64_DIR:-$QED64_PKG}"
[ -n "$QED64_DIR" ] || { echo "the qed64 package is not installed — run npm ci in $G (or set QED64_DIR to a qed64 checkout)" >&2; exit 2; }
OUT="$G/wasm/out"; TREES="$OUT/trees"; LOGS="$OUT/logs"; PKGS="$OUT/pkgs"
# Snapshot staging, per runtime: an index pairs to one build id, so a bake
# against another record (a kernel fix under test) stages beside this one
# instead of replacing it.
STG="$OUT/staging/$BUILD_ID"
REL="$OUT/release/$RID"; MIRROR="$REL/mirror"; ART="$REL/artifact"; NATIVE="$REL/native64"
BAKE_WORK="$OUT/bake-work"   # raw <name>.snap + probe.lean (bake-snapshot.mjs --work); the verify probes load the .snap from here
SLIM_TREES="${SLIM_TREES:-1}"
case "$SLIM_TREES" in 0|1) ;; *) echo "SLIM_TREES must be 0 or 1 (got '$SLIM_TREES')" >&2; exit 2 ;; esac
# The compiler that writes the GameServer / lean-i18n / game oleans: the
# release's native compiler (native64.tar.gz — the one that wrote the Mathlib
# packs' oleans), a linux binary run in the lane's own image: the userland it
# needs (glibc >= 2.38, libstdc++, libuv) and python3 for compile-pkg.py,
# built from wasm/docker/Dockerfile and tagged by that file's hash, for the
# platform the record names (ensure_image).
LEAN_BIN="$NATIVE/bin/lean"
IMAGE="lean4game-native64:$(shasum -a 256 "$G/wasm/docker/Dockerfile" 2>/dev/null | cut -c1-12)"
[ "$IMAGE" != "lean4game-native64:" ] || { echo "missing $G/wasm/docker/Dockerfile (the native compiler's image)" >&2; exit 2; }
case "$NATIVE_OS/$NATIVE_ARCH" in
  linux/aarch64|linux/arm64) PLATFORM="linux/arm64" ;;
  linux/x86_64|linux/amd64)  PLATFORM="linux/amd64" ;;
  *) echo "the record's native compiler is $NATIVE_OS/$NATIVE_ARCH — no Docker platform for it" >&2; exit 2 ;;
esac
# The lanes that run it: the release lane's version check, the trees and games
# compiles, and the bake lane's native probes (--verify-snapshots).
DOCKER_LANES="release trees games"; [ "$VERIFY" = 0 ] || DOCKER_LANES="$DOCKER_LANES bake"
# The provenance stamps of the olean trees (header, "Provenance rules").
STAMP_TOOL="$G/wasm/scripts/tree-stamp.py"
BASE_STAMP="$TREES/gamebase.stamp"   # lib-tree{,-slim}, lib-tree-gamebase{,-slim}, pkgs/{i18n,gameserver}
# The modules every game environment is baked with: the bake probe's header,
# and so the index entry's `imports`, and its `roots` (the module roots the
# entry serves).
GAME_IMPORTS="Game GameServer.Runner"
# The qed64 commit the lockfile pins (a git dependency's only pin; its
# `resolved` ends in #<sha>), wherever npm placed the package.
QPIN="$(node -p 'Object.entries(require(process.argv[1]).packages ?? {}).find(([k]) => k.endsWith("node_modules/qed64"))?.[1].resolved?.split("#")[1] ?? ""' "$G/package-lock.json" 2>/dev/null || true)"
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
# check <description> <shell test...>  — asserts are skipped under --plan
check() { local d="$1"; shift; if [ "$PLAN" = 1 ]; then note "check: $d"; return 0; fi; "$@" || die "check failed: $d"; }
l4w() { local log="$1"; shift; run "$log" "$G" -- node "$L4W/cli.mjs" "$@"; }   # l4w <log> <lean4-wasm64 command + args>
docker_run() { # docker_run <log> <workdir> <ENV...> -- <cmd...>  inside the native compiler's image with the repo mounted
  local log="$1" wd="$2"; shift 2; local envs=()
  while [ "$1" != "--" ]; do envs+=(-e "$1"); shift; done; shift
  run "$log" "$G" -- docker run --rm --platform "$PLATFORM" -v "$G:$G" -w "$wd" ${envs[@]+"${envs[@]}"} "$IMAGE" "$@"
}
IMAGE_OK=0
ensure_image() { # the native compiler's image on this host (built from wasm/docker/Dockerfile when missing), and proof the host runs $PLATFORM
  [ "$IMAGE_OK" = 0 ] || return 0
  IMAGE_OK=1
  if [ "$PLAN" = 1 ]; then
    run docker "$G" -- docker build --platform "$PLATFORM" -t "$IMAGE" "$G/wasm/docker"
    note "check: $IMAGE is $PLATFORM and this Docker runs it (built only when missing)"; return 0
  fi
  docker info >/dev/null 2>&1 || die "Docker is not reachable — the $DOCKER_LANES lanes run the release's native compiler ($PLATFORM) in a container"
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    note "building $IMAGE for $PLATFORM from wasm/docker/Dockerfile (Ubuntu 24.04 by digest + python3, libuv; ~40 MB)"
    run docker "$G" -- docker build --platform "$PLATFORM" -t "$IMAGE" "$G/wasm/docker"
  fi
  local p; p="$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$IMAGE" 2>/dev/null || true)"
  [ "$p" = "$PLATFORM" ] || die "$IMAGE is ${p:-unreadable}, the release's native compiler needs $PLATFORM — docker image rm $IMAGE and rerun"
  local out rc=0
  out="$(docker run --rm --platform "$PLATFORM" "$IMAGE" python3 -c 'import platform; print(platform.machine())' 2>&1)" || rc=$?
  [ "$rc" = 0 ] || die "this Docker cannot run $PLATFORM containers (exit $rc: ${out:0:300}) — on an x86_64 host install qemu user emulation once: docker run --privileged --rm tonistiigi/binfmt --install arm64 (Docker Desktop ships it)"
  note "native compiler image: $IMAGE ($PLATFORM: the container reports $out; this host is $(uname -m))"
}
# Provenance stamps (wasm/scripts/tree-stamp.py): what the base trees and a
# per-game tree must have been built from, by the pinned record (and the
# catalog row in R_*).
base_stamp() { python3 "$STAMP_TOOL" "$REC" $PACKS; }
game_stamp() { python3 "$STAMP_TOOL" "$REC" $PACKS --source "$R_REV" "$([ "$R_PATCH" = "-" ] && echo - || echo "$G/$R_PATCH")"; }
stamp_state() { # stamp_state <stamp file> <expected stamp> → ok | stale | missing
  if [ ! -f "$1" ]; then echo missing; elif [ "$(cat "$1")" = "$2" ]; then echo ok; else echo stale; fi
}
check_stamp() { # check_stamp <stamp file> <expected stamp> <what> <remedy>
  if [ "$PLAN" = 1 ]; then note "check: the provenance stamp of $3 is the pinned record's ($(basename "$1"))"; return 0; fi
  case "$(stamp_state "$1" "$2")" in
    ok) return 0 ;;
    missing) die "$3 has no provenance stamp ($1): it predates the stamps or its lane did not finish — $4" ;;
    stale) die "$3 was built from other inputs than the pinned record names (stamp $1; < built, > wanted: $(diff "$1" <(printf '%s\n' "$2") | grep '^[<>]' | tr '\n' ' ')) — $4" ;;
  esac
}
check_lineage() { # the record's Mathlib packs were compiled by the record's native compiler (the one that compiles the games against them)
  if [ "$PLAN" = 1 ]; then note "check: packs.lean.compiler == native64.commit for every pack the lane compiles against except lean-core"; return 0; fi
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const bad = process.argv.slice(2).filter((id) => id !== "lean-core").map((id) => r.packs.find((p) => p.id === id))
      .filter((p) => !p || p.lean?.compiler !== r.native64.commit);
    if (bad.length) { console.error(`packs not compiled by native64 ${r.native64.commit}: ${bad.map((p) => p ? `${p.id} (${p.lean?.compiler})` : "missing").join(", ")}`); process.exit(1); }
  ' "$REC" $PACKS || die "the release's packs and its native compiler are not one lineage (above): game oleans compiled by native64 would import Mathlib oleans another compiler wrote"
}
compile_pkg() { # compile_pkg <log> <src-dir> <out-dir> <root(s), space-separated> <LEAN_PATH> [LEAN_OPTS: "-Dk=v ..."]
  local log="$1" src="$2" out="$3" roots="$4" lp="$5" opts="${6:-}"
  [ "$PLAN" = 1 ] || mkdir -p "$out"
  # shellcheck disable=SC2086  # roots is a word list on purpose
  docker_run "$log" "$src" "LEAN=$LEAN_BIN" "LEAN_PATH=$lp" ${opts:+"LEAN_OPTS=$opts"} -- python3 "$G/wasm/scripts/compile-pkg.py" "$src" "$out" $roots
}
overlay() { # overlay <log> <base-tree> <new-tree> <drop private facets 0|1> <extra dirs...>   (hard-linked copy of base + extras on top)
  local log="$1" base="$2" new="$3" slim="$4"; shift 4; local -a ex=()
  [ "$slim" = 0 ] || ex=(--exclude='*.olean.private')
  run "$log" "$G" -- rsync -a --link-dest="$base" ${ex[@]+"${ex[@]}"} "$base/" "$new/"
  local x; for x in "$@"; do run "$log" "$G" -- rsync -a ${ex[@]+"${ex[@]}"} "$x/" "$new/"; done
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
FULL_RUN=1; [ -z "$GAMES" ] || FULL_RUN=0                 # full run = no --games: wipe staging, rebake every game

# -------------------------------------------------------------- preflight --
lane_preflight() {
  say "preflight"
  note "repo $G"; note "release $RID ($RDIGEST) from $RELEASE_FROM"; note "qed64 $QED64_DIR"
  # The record is a release record (canonical form, id rule, self-digest), and
  # the tools npm installed are the ones it ships: the record names them
  # (tools.version, tools.tgz), the lockfile pins that tgz, the install is the
  # lockfile's (the release lane also matches the tgz's bytes to the lockfile).
  ( cd "$G" && node --input-type=module -e '
    import fs from "node:fs";
    import { checkReleaseRecord, releaseDigest } from "lean4-wasm64";
    const [rec, pkgDir, lockFile, installedLock] = process.argv.slice(1);
    const r = JSON.parse(fs.readFileSync(rec, "utf8"));
    const fail = (why) => { console.error(`preflight: ${why}`); process.exit(1); };
    const problems = checkReleaseRecord(r);
    if (problems.length) fail(`${rec}: ${problems.join("; ")}`);
    if (releaseDigest(r) !== r.digest) fail(`${rec}: its digest field does not match its content`);
    const version = JSON.parse(fs.readFileSync(`${pkgDir}/package.json`, "utf8")).version;
    if (version !== r.tools.version) fail(`node_modules/lean4-wasm64 is ${version}, the release record names ${r.tools.version} — bump the devDependency with the record (or run npm ci)`);
    const lock = (f) => JSON.parse(fs.readFileSync(f, "utf8")).packages?.["node_modules/lean4-wasm64"] ?? {};
    const pinned = lock(lockFile), installed = lock(installedLock);
    const tgz = r.tools.tgz.split("/").pop();
    if (!pinned.resolved?.endsWith(`/${tgz}`)) fail(`package-lock.json pins lean4-wasm64 at ${pinned.resolved ?? "nothing"}, not the tools of release ${r.id} (${tgz})`);
    if (!pinned.integrity || installed.integrity !== pinned.integrity) fail("the installed lean4-wasm64 is not the lockfile\u2019s (node_modules/.package-lock.json differs) — run npm ci");
  ' "$REC" "$L4W" "$G/package-lock.json" "$G/node_modules/.package-lock.json" ) || die "the toolchain pin is inconsistent (above)"
  check_lineage
  note "toolchain: $RID — Lean $LEAN_VERSION, runtime $BUILD_ID, kernel ${KCOMMIT:0:10} (patch $KPATCH), native compiler ${NATIVE_COMMIT:0:10} ($NATIVE_OS/$NATIVE_ARCH); tools lean4-wasm64 $TOOLS_VERSION"
  # A clone gets only what git tracks: the record (read at module load by
  # infra/worker.js and by stage-workers.sh in every client build), the lane's
  # own inputs and every catalog patch. Named, so a commit by path that
  # leaves one out shows up here; and the deleted kernel submodule's gitlink.
  if [ "$PLAN" = 0 ] && git -C "$G" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    local f untracked=""
    for f in wasm/lean4-wasm64-release.json wasm/docker/Dockerfile wasm/scripts/tree-stamp.py $(node "$G/scripts/games-manifest.mjs" --list | cut -f10 | grep -v '^-$'); do
      git -C "$G" ls-files --error-unmatch -- "$f" >/dev/null 2>&1 || untracked="$untracked $f"
    done
    [ -z "$untracked" ] || warn "not tracked by git — a clone would not have them (git add them with the change that needs them):$untracked"
    [ -z "$(git -C "$G" ls-files -s -- wasm/kernel .gitmodules 2>/dev/null)" ] || [ -e "$G/.gitmodules" ] || warn "the index still holds the removed kernel submodule (git rm --cached wasm/kernel .gitmodules)"
  fi
  [ -f "$QED64_DIR/pipeline/snapshot/bake-snapshot.mjs" ] || die "pipeline scripts missing at $QED64_DIR — run npm ci (or set QED64_DIR to a qed64 checkout)"
  [[ "$QPIN" =~ ^[0-9a-f]{40}$ ]] || die "package-lock.json pins no qed64 commit — run npm install"
  # The workers the bundle lane stages must drive the release's runtime.
  "$G/scripts/stage-workers.sh" --check || die "the qed64 workers do not fit the release's runtime (scripts/stage-workers.sh --check says why)"
  if [ -d "$QED64_DIR/.git" ]; then local qhead; qhead="$(git -C "$QED64_DIR" rev-parse HEAD)"; [ "$qhead" = "$QPIN" ] || warn "qed64 checkout is at ${qhead:0:12}, package-lock.json pins ${QPIN:0:12}"; fi
  note "qed64 ${QPIN:0:12} (package-lock.json)"
  node "$G/scripts/games-manifest.mjs" --check || die "wasm/catalog.json failed its check"
  local scope=""
  if lane_on bake; then
    if [ "$FULL_RUN" = 1 ]; then scope="   (full run: this runtime's staging wiped, every game rebaked)"; else scope="   (--games: the other games' staged snapshots are kept)"; fi
  fi
  note "games: $SELECTED_NAMES$scope   slim trees: $SLIM_TREES"
  note "staging: ${STG#"$G/"}/snapshots$([ -f "$STG/snapshots/index.json" ] && echo " ($(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))['snapshots']))" "$STG/snapshots/index.json" 2>/dev/null || echo '?') staged)")"
  [ ! -d "$OUT/staging/snapshots" ] || warn "wasm/out/staging/snapshots is an older lane's flat staging dir (runtime $(index_runtime "$OUT/staging/snapshots/index.json")); this lane stages under wasm/out/staging/<build id>/ — move it to wasm/out/staging/<its runtime>/snapshots or delete it"
  # Which olean trees the pinned record (and the catalog rows) still accept:
  # the games lane refuses stale base trees, the bake lane stale per-game trees.
  if [ "$PLAN" = 0 ]; then
    local want; want="$(base_stamp)" || die "cannot compute the trees' provenance stamp from $REC"
    local row st ok="" stale="" missing=""
    for row in "${ROWS[@]}"; do
      row_vars "$row"; st="$(stamp_state "$TREES/lib-tree-$R_SNAP.stamp" "$(game_stamp)")"
      case "$st" in ok) ok="$ok $R_SNAP" ;; stale) stale="$stale $R_SNAP" ;; *) missing="$missing $R_SNAP" ;; esac
    done
    note "olean trees vs the pinned record: base $(stamp_state "$BASE_STAMP" "$want"); per-game ok:${ok:- none}${stale:+; stale:$stale}${missing:+; none yet:$missing}"
  fi
  local nv; nv="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1 || echo 0)"; [ "${nv:-0}" -ge 24 ] || die "Node >= 24 required (Memory64), found $(node -v 2>/dev/null || echo none)"
  local c; for c in python3 rsync openssl; do command -v "$c" >/dev/null || die "$c required"; done
  # Docker: a hard requirement of the lanes that run the native compiler —
  # refuse here, before a 2.3 GB fetch, rather than in the middle of a lane.
  local l docker_needed=""
  for l in $DOCKER_LANES; do ! lane_on "$l" || docker_needed="$docker_needed $l"; done
  if [ -n "$docker_needed" ]; then
    ensure_image
    if [ "$PLAN" = 0 ]; then local mem; mem="$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)"; note "docker: $((mem / 1073741824)) GiB VM memory (compiles run one at a time)"; fi
  else
    note "docker: not needed by these lanes"
  fi
  local free; free="$(df -g "$G" 2>/dev/null | awk 'NR==2{print $4}' || echo '?')"; note "free disk: ${free} GB (need ~25)"
  note "lanes: $LANES$([ "$PLAN" = 1 ] && echo '   (PLAN — nothing runs)')"
}

# ---------------------------------------------------------------- release --
lane_release() {
  say "release: fetch + verify $RID (runtime $BUILD_ID, packs $PACKS, native64, module lists)"
  ensure_image
  check_lineage
  # The served layout (runtime manifest + chunks, packs, native64, lists,
  # tools): every byte streamed through SHA-256 against the pinned record; a
  # rerun keeps what is already verified.
  l4w release fetch --from "$RELEASE_FROM" --id "$RID" --digest "$RDIGEST" --out "$MIRROR" \
    --only "runtime-chunks,${PACKS// /,},native64,lists,tools"
  check "the fetched release.json is the tracked record, byte for byte" cmp -s "$MIRROR/release.json" "$REC"
  # The artifact layout every Node-side tool takes as --artifact (bin/lean.js,
  # lean.wasm, leanmake), rebuilt from the verified chunks — kept apart from
  # the served copy; the build id is recomputed from bin/lean.wasm.
  l4w release fetch --from "$MIRROR" --id "$RID" --digest "$RDIGEST" --out "$ART" --only runtime
  if [ "$PLAN" = 1 ]; then note "check: lean4-wasm64 id $ART == $BUILD_ID"; else
    local got; got="$(node "$L4W/cli.mjs" id "$ART" 2>/dev/null | grep -Eo 'wasm64-[0-9a-f]{16}' | head -1 || true)"
    [ "$got" = "$BUILD_ID" ] || die "the runtime build id recomputed from $ART/bin/lean.wasm is '${got:-none}', the record says $BUILD_ID"
    note "runtime $got (recomputed from bin/lean.wasm)"
  fi
  # The tools npm installed are this release's tgz: the lockfile's sha512
  # integrity, computed over the fetched (sha256-verified) file.
  if [ "$PLAN" = 1 ]; then note "check: sha512 of $MIRROR/$TOOLS_TGZ == the package-lock.json integrity of lean4-wasm64"; else
    local want have
    want="$(node -p 'require(process.argv[1]).packages["node_modules/lean4-wasm64"].integrity' "$G/package-lock.json")"
    have="sha512-$(openssl dgst -sha512 -binary "$MIRROR/$TOOLS_TGZ" | base64 | tr -d '\n')"
    [ "$have" = "$want" ] || die "the release's tools tgz ($have) is not the one package-lock.json pins ($want)"
    note "tools: the lockfile's integrity is the release's $(basename "$TOOLS_TGZ")"
  fi
  # The native compiler, unpacked once per release (bin/, and lib/lean: its
  # own Init/Std/Lean/Lake oleans and the shared libraries `lean` loads).
  if [ "$PLAN" = 1 ] || [ ! -f "$NATIVE/.unpacked" ] || [ "$MIRROR/$NATIVE_TAR" -nt "$NATIVE/.unpacked" ]; then
    run release "$G" -- rm -rf "$NATIVE"
    run release "$G" -- mkdir -p "$NATIVE"
    run release "$G" -- tar -xzf "$MIRROR/$NATIVE_TAR" -C "$NATIVE"
    [ "$PLAN" = 1 ] || touch "$NATIVE/.unpacked"
  fi
  check "native64 holds bin/lean and lib/lean/Lake" bash -c "test -x '$LEAN_BIN' && test -d '$NATIVE/lib/lean/Lake'"
  if [ "$PLAN" = 1 ]; then note "check: the native lean --version names Lean $LEAN_VERSION (in $IMAGE, $PLATFORM)"; else
    # Captured whole (a failing docker run must reach the message below, not
    # end the script silently under errexit).
    local v rc=0; v="$(docker run --rm --platform "$PLATFORM" -v "$G:$G" "$IMAGE" "$LEAN_BIN" --version 2>&1)" || rc=$?
    case "$rc:$v" in 0:*"version $LEAN_VERSION"*) note "native compiler: ${v%%$'\n'*}" ;; *) die "native64 lean --version in $IMAGE (exit $rc): '${v:0:400}' — the release is Lean $LEAN_VERSION" ;; esac
  fi
  check "module lists present" bash -c "test -s '$MIRROR/$LIST_ESSENTIAL' && test -s '$MIRROR/$LIST_EXTRA'"
}

# ------------------------------------------------------------------ trees --
lane_trees() {
  say "trees: unpack $PACKS (fat + slim), compile lean-i18n + GameServer with native64, assemble the game base trees"
  local p
  for p in $PACKS; do check "$p manifest fetched (release lane)" test -f "$MIRROR/profiles/$p.manifest.json"; done
  check "native compiler unpacked (release lane)" test -x "$LEAN_BIN"
  ensure_image
  # The stamp goes last: a trees run that stops half-way leaves none.
  [ "$PLAN" = 1 ] || { rm -f "$BASE_STAMP"; rm -rf "$TREES/lib-tree" "$TREES/lib-tree-slim"; mkdir -p "$TREES/lib-tree" "$TREES/lib-tree-slim"; }
  # Fat: what the native compiler reads (a legacy importer loads every facet).
  # Slim: what the bakes mount — the tree QED64 bakes on.
  for p in $PACKS; do
    l4w trees unpack --manifest "$MIRROR/profiles/$p.manifest.json" --out "$TREES/lib-tree"
    l4w trees unpack --manifest "$MIRROR/profiles/$p.manifest.json" --out "$TREES/lib-tree-slim" --slim
  done
  check "every module of the release's two module lists has an olean" python3 -c "
import os, sys
missing = [m for f in sys.argv[2:] for m in open(f).read().split() if not os.path.isfile(os.path.join(sys.argv[1], m.replace('.', '/') + '.olean'))]
print(f'{len(missing)} listed modules without an olean', missing[:5]); sys.exit(1 if missing else 0)" "$TREES/lib-tree" "$MIRROR/$LIST_ESSENTIAL" "$MIRROR/$LIST_EXTRA"
  check "no private facet in the slim tree" bash -c "[ -z \"\$(find '$TREES/lib-tree-slim' -name '*.olean.private' -print -quit)\" ]"
  # Lake (lean-i18n imports Lake.Load.Manifest): the native compiler's own
  # facets, merged INTO the trees — Lean resolves a module in the first
  # LEAN_PATH entry holding its root directory, and mathlib-game-extra already
  # ships one Lake module (Lake.Util.Casing), so a separate entry would hide
  # the rest of Lake. The merge overwrites the pack's copy, so the two must be
  # the same bytes: Mathlib oleans in the pack were compiled against the
  # pack's Lake.Util.Casing, and a differing native64 copy would replace it
  # under them.
  local lakedir="$OUT/lake-facets"; [ "$PLAN" = 1 ] || { rm -rf "$lakedir"; mkdir -p "$lakedir"; }
  run trees "$G" -- bash -c "cp -R '$NATIVE'/lib/lean/Lake '$lakedir'/ && cp '$NATIVE'/lib/lean/Lake.* '$lakedir'/"
  check "every Lake facet a pack ships too is byte-identical to native64's (the merge replaces the pack's)" python3 -c "
import filecmp, os, sys
lake, tree = sys.argv[1:]; same, bad = 0, []
for d, _, fs in os.walk(lake):
    for f in fs:
        p = os.path.join(d, f); q = os.path.join(tree, os.path.relpath(p, lake))
        if os.path.exists(q):
            if filecmp.cmp(p, q, shallow=False): same += 1
            else: bad.append(os.path.relpath(p, lake))
print(f'{same} Lake facets in both, identical; {len(bad)} differ', bad[:5]); sys.exit(1 if bad else 0)" "$lakedir" "$TREES/lib-tree"
  [ "$PLAN" = 1 ] || rm -rf "$TREES/lib-tree-gamebase" "$TREES/lib-tree-gamebase-slim" "$PKGS/i18n" "$PKGS/gameserver"
  overlay trees "$TREES/lib-tree" "$TREES/lib-tree-gamebase" 0 "$lakedir"
  compile_pkg trees "$G/vendor/i18n" "$PKGS/i18n" I18n "$TREES/lib-tree-gamebase:$PKGS/i18n"
  compile_pkg trees "$G/server" "$PKGS/gameserver" GameServer "$TREES/lib-tree-gamebase:$PKGS/i18n:$PKGS/gameserver"
  check "GameServer.Runner compiled" test -f "$PKGS/gameserver/GameServer/Runner.olean"
  run trees "$G" -- rsync -a "$PKGS/i18n/" "$PKGS/gameserver/" "$TREES/lib-tree-gamebase/"
  # The slim game base: the slim packs plus the same Lake / i18n / GameServer
  # oleans without their private facets.
  overlay trees "$TREES/lib-tree-slim" "$TREES/lib-tree-gamebase-slim" 1 "$lakedir" "$PKGS/i18n" "$PKGS/gameserver"
  if [ "$PLAN" = 1 ]; then note "write $BASE_STAMP: python3 wasm/scripts/tree-stamp.py <record> $PACKS"
  else base_stamp > "$BASE_STAMP" || die "cannot write $BASE_STAMP"; note "base trees stamped ($BASE_STAMP)"; fi
}

# ------------------------------------------------------------------ games --
ensure_source() { # ensure_source <src> <url|-> <rev> <patch|->   (clone + checkout + git am when the tree is absent; games-src/ is gitignored)
  local src="$1" url="$2" rev="$3" patch="$4"
  if [ ! -d "$G/$src" ]; then
    [ "$url" != "-" ] || die "game source $src is missing and its catalog row has no source {url, rev} to clone from"
    run games "$G" -- git clone "$url" "$G/$src"
    run games "$G/$src" -- git checkout "$rev"
    [ "$patch" = "-" ] || run games "$G/$src" -- git am "$G/$patch"
  fi
  verify_source "$src" "$rev" "$patch"
}
verify_source() { # verify_source <src> <rev|-> <patch|->   an existing checkout must be exactly the catalog's rev + patch
  local src="$1" rev="$2" patch="$3"
  [ "$rev" != "-" ] || return 0                       # in-repo source (catalog source: null)
  if [ "$PLAN" = 1 ]; then note "check: $src HEAD's tree == $rev$([ "$patch" = "-" ] || echo " + $patch") (else refuse: a stale checkout)"; return 0; fi
  local d="$G/$src" want have tmp
  git -C "$d" rev-parse -q --verify "$rev^{commit}" >/dev/null 2>&1 || die "$src has no commit $rev (the catalog's source.rev) — delete $d and rerun: the lane clones it"
  # The tree rev + patch gives, built in a throwaway index (git am would
  # give the same tree: the lane's patches are one commit each).
  if [ "$patch" = "-" ]; then want="$(git -C "$d" rev-parse "$rev^{tree}")"
  else
    tmp="$(mktemp -d)"
    want="$(GIT_INDEX_FILE="$tmp/index" git -C "$d" read-tree "$rev" && GIT_INDEX_FILE="$tmp/index" git -C "$d" apply --cached "$G/$patch" && GIT_INDEX_FILE="$tmp/index" git -C "$d" write-tree)" || { rm -rf "$tmp"; die "$G/$patch does not apply to $rev"; }
    rm -rf "$tmp"
  fi
  have="$(git -C "$d" rev-parse 'HEAD^{tree}')"
  [ "$want" = "$have" ] || die "$src is not the catalog's source: HEAD $(git -C "$d" rev-parse --short HEAD) has tree ${have:0:12}, $rev$([ "$patch" = "-" ] || echo " + $(basename "$patch")") gives ${want:0:12} — an older port or a re-cut patch. Delete $d (the lane clones and patches it again), or git checkout $rev && git am $G/$patch there"
  local dirty; dirty="$(git -C "$d" status --porcelain --untracked-files=no -- '*.lean' 2>/dev/null)"
  [ -z "$dirty" ] || warn "$src has uncommitted Lean edits the compile will use (the per-game stamp records rev + patch only): $(printf '%s' "$dirty" | head -3 | tr '\n' ' ')"
}
lane_games() {
  say "games: compile $SELECTED_NAMES with native64 (gamedata + per-game trees; SLIM_TREES=$SLIM_TREES)"
  check "game base tree present (trees lane)" test -f "$TREES/lib-tree-gamebase/GameServer/Runner.olean"
  local base="$TREES/lib-tree-gamebase-slim"; [ "$SLIM_TREES" = 1 ] || base="$TREES/lib-tree-gamebase"
  check "per-game base tree present (trees lane)" test -f "$base/GameServer/Runner.olean"
  check_stamp "$BASE_STAMP" "$(base_stamp)" "the base olean trees (wasm/out/trees)" "run the trees lane (--lanes trees, after the release lane)"
  ensure_image
  local row
  for row in "${ROWS[@]}"; do
    row_vars "$row"
    ensure_source "$R_SRC" "$R_URL" "$R_REV" "$R_PATCH"
    [ "$PLAN" = 1 ] || { rm -f "$TREES/lib-tree-$R_SNAP.stamp"; rm -rf "$PKGS/$R_SNAP"; mkdir -p "$G/$R_SRC/.lake/gamedata"; }
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
    overlay games "$base" "$TREES/lib-tree-$R_SNAP" "$SLIM_TREES" "$PKGS/$R_SNAP"
    if [ "$PLAN" = 1 ]; then note "write $TREES/lib-tree-$R_SNAP.stamp: the base stamp + source $R_REV <sha256 of $R_PATCH>"
    else game_stamp > "$TREES/lib-tree-$R_SNAP.stamp" || die "cannot write $TREES/lib-tree-$R_SNAP.stamp"; fi
  done
}

# ------------------------------------------------------------------- bake --
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
  local idx="$STG/snapshots/index.json"
  # expectedRaw pairing key (bake_size_check): the build id, "+slim" when the
  # per-game trees omit the private facets — the two sizes differ by ~60 %.
  local key="$BUILD_ID"; [ "$SLIM_TREES" = 0 ] || key="$BUILD_ID+slim"
  say "bake: $SELECTED_NAMES against runtime $BUILD_ID (sequential — one shared bake workspace, $BAKE_WORK; expectedRaw key $key)"
  check "release runtime present (release lane)" test -s "$ART/bin/lean.wasm"
  local row
  for row in "${ROWS[@]}"; do
    row_vars "$row"
    check "lib-tree-$R_SNAP present (games lane)" test -d "$TREES/lib-tree-$R_SNAP"
    check_stamp "$TREES/lib-tree-$R_SNAP.stamp" "$(game_stamp)" "the per-game olean tree lib-tree-$R_SNAP" "run --lanes games --games $R_SNAP first (and the trees lane before it when the base trees are stale too)"
  done
  [ "$VERIFY" = 0 ] || ensure_image
  # Staging is this runtime's own directory (STG): it survives a --games run
  # (the other games' .snapz + index entries stay for the bundle lane) and a
  # bake against another record (that stages under its own build id). Only a
  # full run wipes it — a full run is a full rebake by design.
  if [ "$FULL_RUN" = 1 ]; then
    run bake "$G" -- rm -rf "$STG/snapshots"
  elif [ -f "$idx" ] && [ "$PLAN" = 0 ]; then
    local srt; srt="$(index_runtime "$idx")"
    [ -z "$srt" ] || [ "$srt" = "$BUILD_ID" ] || die "$idx pairs to runtime $srt, not $BUILD_ID: it was put there by hand — move it to $OUT/staging/$srt/"
  fi
  [ "$PLAN" = 1 ] || mkdir -p "$STG/snapshots" "$BAKE_WORK"
  local gprobe roots i
  gprobe="$(for i in $GAME_IMPORTS; do printf 'import %s\n' "$i"; done; printf '#check (2 + 2 : Nat)')"
  roots="$(printf '%s\n' $GAME_IMPORTS | paste -sd, -)"
  for row in "${ROWS[@]}"; do
    row_vars "$row"
    # The bake probe is a #check: no gamedata needed (only the verify probe
    # reads it, via --workspace). The release's runtime admits the games'
    # legacy (non-`module`) oleans by itself under the wasm target (patch
    # 0030, Lean/Environment.lean importModulesCore): no environment flag.
    run bake "$QED64_DIR" -- node --stack-size=8192 "$QED64_DIR/pipeline/snapshot/bake-snapshot.mjs" \
      --name "$R_SNAP" --probe "$gprobe" --roots "$roots" --artifact "$ART" --lib "$TREES/lib-tree-$R_SNAP" \
      --reserve "$R_RESERVE" --work "$BAKE_WORK" --out "$STG/snapshots"
    check "$R_SNAP entry pairs with runtime $BUILD_ID" test "$(index_field "$idx" "$R_SNAP" runtime)" = "$BUILD_ID"
    bake_size_check "$key" "$idx"
  done
  check "every baked name in the staging index ($SELECTED_NAMES)" bash -c "python3 -c \"import json,sys; s={e['name'] for e in json.load(open('$idx'))['snapshots']}; sys.exit(1 if [n for n in sys.argv[1:] if n not in s] else 0)\" $SELECTED_NAMES"
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
      run bake "$QED64_DIR" -- node --stack-size=8192 "$QED64_DIR/pipeline/snapshot/snapshot-probe.mjs" --via-mem --artifact "$ART" --snap "$BAKE_WORK/$R_SNAP.snap" --lib "$TREES/lib-tree-$R_SNAP" --workspace "$G/$R_SRC" --probe-file "$pf" --budget-ms 600000
      # That probe proves the snapshot loads and seeds the environment cache
      # (the compile stays within budget); it cannot judge the proof. Its
      # one-shot compile (the runtime's lean_wasm_compile) collects each
      # command's own messages, and under Lean 4.34 the errors of the theorem
      # `Runner` elaborates never reach them: a wrong proof compiles with
      # errors=0 there. The release's native compiler runs the same Runner
      # document against the same per-game tree (cwd = the game, for its
      # gamedata): the catalog proof must close with no message at all, and
      # the negative control (the proof replaced by an unknown identifier)
      # must fail with an error — a silent harness is not a pass. The row's
      # further probes (probe2, … : a mid-game level's own solution, e.g. the
      # level that teaches a wrapped tactic) run natively too: a warning there
      # is a level a player finishes "with warnings", never completed.
      native_probe "$R_SNAP" "$R_SRC" "$pf" pass
      local nf="$OUT/verify-$R_SNAP.negative.lean"
      if [ "$PLAN" = 1 ]; then note "write $nf: $pf with its proof replaced by 'exact this_is_not_a_proof_of_the_goal'"
      else awk '/:= by$/ { print; print "exact this_is_not_a_proof_of_the_goal"; exit } { print }' "$pf" > "$nf"; fi
      native_probe "$R_SNAP" "$R_SRC" "$nf" fail
      local k kf
      for k in $(node "$G/scripts/games-manifest.mjs" --probes "$R_SNAP"); do
        [ "$k" != probe ] || continue
        kf="$OUT/verify-$R_SNAP.$k.lean"
        if [ "$PLAN" = 1 ]; then note "write $kf from: node scripts/games-manifest.mjs --probe $R_SNAP $k"
        else node "$G/scripts/games-manifest.mjs" --probe "$R_SNAP" "$k" > "$kf" || die "no $k for $R_SNAP"; fi
        native_probe "$R_SNAP" "$R_SRC" "$kf" pass
      done
    done
  fi
}
native_probe() { # native_probe <snapshot> <src> <probe file under wasm/out> <pass|fail>
  local name="$1" src="$2" pf="$3" want="$4"
  if [ "$PLAN" = 1 ]; then
    run bake "$G" -- docker run --rm --platform "$PLATFORM" -v "$G:$G" -w "$G/$src" -e "LEAN_PATH=$TREES/lib-tree-$name" "$IMAGE" "$LEAN_BIN" "$pf"
    note "check: native Runner probe $(basename "$pf") $([ "$want" = pass ] && echo 'exits 0 with no message' || echo 'fails with an error')"; return 0
  fi
  local out rc=0
  out="$(docker run --rm --platform "$PLATFORM" -v "$G:$G" -w "$G/$src" -e "LEAN_PATH=$TREES/lib-tree-$name" "$IMAGE" "$LEAN_BIN" "$pf" 2>&1)" || rc=$?
  printf '%s\n' "$out" >> "$LOGS/bake.log"
  if [ "$want" = pass ]; then
    [ "$rc" = 0 ] && [ -z "$out" ] || die "native Runner probe $(basename "$pf") of $name failed (exit $rc): ${out:0:600}"
    note "native Runner probe $(basename "$pf") of $name: proof closes, no message"
  else
    [ "$rc" != 0 ] && grep -q "error" <<<"$out" || die "native negative control of $name did not fail (exit $rc): ${out:0:600}"
    note "native negative control of $name: rejected ($(grep -m1 -o 'error[^:]*: [^`]*' <<<"$out" | head -1))"
  fi
}

# ----------------------------------------------------------------- bundle --
lane_bundle() {
  say "bundle: stage into client/public, build the client, pack the artifact bundle"
  [ -n "$TAG" ] || TAG="artifacts-$BUILD_ID"
  check "client dependencies installed (npm ci)" test -d "$G/node_modules"
  check "staged snapshots present (bake lane)" test -f "$STG/snapshots/index.json"
  check "release runtime + core pack fetched (release lane)" test -f "$MIRROR/profiles/lean-core.manifest.json"
  # The pinned runtime manifest, runtime/runtime-manifest.<build id>.json: the
  # release ships it beside runtime-manifest.json (the same bytes), a QED64
  # boot fetches it first and the service worker precaches it. Refused before
  # anything is copied when the mirror lacks it, names another runtime or
  # differs from the release's runtime-manifest.json.
  check "the release's pinned runtime/runtime-manifest.$BUILD_ID.json names $BUILD_ID, the bytes of $RUNTIME_MANIFEST" python3 -c "
import json, sys
pin, plain, rid = sys.argv[1:]
try: got = json.load(open(pin)).get('buildId')
except (OSError, ValueError) as e: sys.exit(f'no pinned runtime manifest: {e}')
if got != rid: sys.exit(f'{pin} names {got}, the record {rid}')
if open(pin, 'rb').read() != open(plain, 'rb').read(): sys.exit(f'{pin} differs from {plain}')" "$MIRROR/runtime/runtime-manifest.$BUILD_ID.json" "$MIRROR/$RUNTIME_MANIFEST" "$BUILD_ID"
  # The served index must pair with ONE runtime, the release's: refuse before
  # anything is copied when a snapshot it would keep (a game not restaged
  # now) was baked against another one — after a release bump that is every
  # game not baked in this run, so bake them all (a full run) first.
  # shellcheck disable=SC2086  # SELECTED_NAMES is a word list
  check "every snapshot the served index will hold pairs with $BUILD_ID" python3 -c "
import json, sys
pub, stg, rid, names = sys.argv[1], sys.argv[2], sys.argv[3], set(sys.argv[4:])
staged = {e['name']: e for e in json.load(open(stg))['snapshots'] if e['name'] in names}
kept = [e for e in json.load(open(pub))['snapshots'] if e['name'] not in staged]
bad = [e['name'] + ' (' + str(e.get('runtime')) + ')' for e in kept if e.get('runtime') != rid]
bad += [n + ' (staging: ' + str(e.get('runtime')) + ')' for n, e in staged.items() if e.get('runtime') != rid]
missing = sorted(names - set(staged))
if bad or missing: print('unpaired:', ', '.join(sorted(bad)) or '-', '| not in staging:', ', '.join(missing) or '-'); sys.exit(1)" "$PUB/snapshots/index.json" "$STG/snapshots/index.json" "$BUILD_ID" $SELECTED_NAMES
  # workers / gamedata / i18n / api/games first (catalog-driven, scripts/stage-game-assets.sh)
  run bundle "$G" -- bash "$G/scripts/stage-game-assets.sh"
  # The runtime and the core pack: the release's bytes as published (served
  # layout; chunk and part URLs are already /runtime/chunks/… and /profiles/…).
  run bundle "$G" -- bash -c "rm -rf '$PUB/runtime/chunks' && mkdir -p '$PUB/runtime' && cp '$MIRROR/$RUNTIME_MANIFEST' '$PUB/runtime/runtime-manifest.json' && cp -R '$MIRROR/runtime/chunks' '$PUB/runtime/'"
  # The pinned manifest too (gitignored, like the index copies below): without
  # it serve-dist answers /runtime/runtime-manifest.<id>.json with index.html,
  # the service worker's install leaves one critical shell file uncached and
  # an offline boot fails with "Failed to fetch". Other runtimes' pinned
  # copies go (their releases keep their own); scripts/preflight-artifacts.mjs
  # checks it.
  run bundle "$G" -- bash -c "find '$PUB/runtime' -maxdepth 1 -name 'runtime-manifest.wasm64-*.json' ! -name 'runtime-manifest.$BUILD_ID.json' -print -delete && cp '$MIRROR/runtime/runtime-manifest.$BUILD_ID.json' '$PUB/runtime/'"
  run bundle "$G" -- bash -c "rm -f '$PUB'/profiles/lean-core.pack.gzip.* && mkdir -p '$PUB/profiles' && cp '$MIRROR'/profiles/lean-core.manifest.json '$MIRROR'/profiles/lean-core.pack.gzip.* '$PUB/profiles/'"
  # /profiles/index.json is the site's own (release.json hosting.siteOwned).
  # Its per-runtime copy, snapshots/profiles-index.<build id>.json, gets the
  # same bytes (QED64 HARDENING #64: a shell paired with this runtime reads it
  # while R2's mutable index still names another one; under /snapshots/
  # because every Worker leaves that prefix to the site, while
  # /profiles/index.<id>.json would be routed to the release). Other runtimes'
  # copies go (R2 keeps its own); scripts/preflight-artifacts.mjs checks both.
  run bundle "$G" -- python3 - "$PUB/profiles" "$BUILD_ID" "$LEAN_VERSION" "$PUB/snapshots" <<'PY'
import json, os, re, sys
d, rid, lv, snap = sys.argv[1:]
c = json.load(open(os.path.join(d, "lean-core.manifest.json"))).get("content") or {}
bad = [p.get("url", "") for p in ((c.get("pack") or {}).get("transport") or {}).get("parts", []) if not p.get("url", "").startswith("/profiles/")]
if bad: sys.exit(f"lean-core part urls outside /profiles/: {bad[:3]}")
idx = {"schema": "qed64.profile-index/v1", "runtime": {"buildId": rid, "leanVersion": lv},
       "profiles": [{"id": "core", "manifest": "/profiles/lean-core.manifest.json", "release": c.get("release") or "lean-core", "modules": len(c.get("modules") or {})}]}
text = json.dumps(idx, indent=1)
open(os.path.join(d, "index.json"), "w").write(text)
print("profiles/index.json written for", rid)
os.makedirs(snap, exist_ok=True)
for f in sorted(os.listdir(snap)):
    m = re.fullmatch(r"profiles-index\.(wasm64-[0-9a-f]{16})\.json", f)
    if m and m.group(1) != rid:
        os.unlink(os.path.join(snap, f)); print("removed", f, "(another runtime's copy; R2 keeps its own)")
open(os.path.join(snap, f"profiles-index.{rid}.json"), "w").write(text)
print(f"snapshots/profiles-index.{rid}.json written (the bytes of profiles/index.json)")
PY
  # shellcheck disable=SC2086  # SELECTED_NAMES is a word list
  run bundle "$G" -- python3 "$G/scripts/stage-snapshots.py" "$STG/snapshots" $SELECTED_NAMES
  check "served runtime id == $BUILD_ID" bash -c "python3 -c \"import json,sys; sys.exit(0 if json.load(open('$PUB/runtime/runtime-manifest.json'))['buildId']=='$BUILD_ID' else 1)\""
  check "served pinned runtime-manifest.$BUILD_ID.json == runtime-manifest.json" cmp -s "$PUB/runtime/runtime-manifest.$BUILD_ID.json" "$PUB/runtime/runtime-manifest.json"
  run bundle "$G" -- npm --workspace client run build
  run bundle "$G" -- bash "$G/scripts/pack-artifacts.sh" "$TAG"
  note "tracked files to review + commit: client/public/runtime/runtime-manifest.json, profiles/{index,lean-core.manifest}.json, snapshots/index.json, api/games, data/, i18n/, wasm/artifacts/BUNDLE.json, wasm/catalog.json (expectedRaw lines printed by the bake lane)"
  note "then upload every wasm/out/artifacts/$TAG/*.tar and *.tar.part-NNN + SHA256SUMS as release '$TAG' (the pack script printed the gh line; wasm/KERNEL.md \"Rebuilding from a clone\")"
}

# ------------------------------------------------------------------- main --
[ "$PLAN" = 1 ] && say "PLAN MODE — printing steps only (cwd shown per command)"
for lane in preflight release trees games bake bundle; do
  lane_on "$lane" || continue
  "lane_$lane"
done
say "done ($LANES)$([ "$PLAN" = 1 ] && echo ' — plan only')"
