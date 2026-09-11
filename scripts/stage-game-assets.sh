#!/bin/bash
# Stage everything the wasm build serves statically into client/public/:
# every catalog game's compiled gamedata + translations (wasm/catalog.json,
# read through scripts/games-manifest.mjs — never name a game here) and the
# worker scripts from the vendored, commit-pinned qed64 closure
# (client/src/wasm/vendor, scripts/sync-qed64.sh). Snapshots are staged with
# scripts/stage-snapshots.py; the runtime chunks and the core profile pack are
# digest-pinned build outputs the bundle lane copies (wasm/build-from-source.sh).
# See wasm/KERNEL.md and wasm/PORTING.md.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PUB="$HERE/client/public"
MANIFEST="$HERE/scripts/games-manifest.mjs"

mkdir -p "$PUB"/{workers,profiles,runtime,snapshots}

# Game data + translations: one loop over the catalog rows (TSV, see the
# COLUMNS list in games-manifest.mjs). Gamedata/i18n are compiled outputs
# (<src>/.lake and <src>/.i18n, gitignored); the staged copies are tracked
# under client/public, so a clone without a Lean toolchain keeps the
# committed copies of any game whose sources are absent.
node "$MANIFEST" --check >/dev/null
LANGS="$(node "$MANIFEST" --langs)"
while IFS=$'\t' read -r _snapshot _owner _game id _listed src _rest; do
  SRC="$HERE/$src"
  if [ -f "$SRC/.lake/gamedata/game.json" ]; then
    mkdir -p "$PUB/data/$id" "$PUB/i18n/$id"
    cp "$SRC"/.lake/gamedata/*.json "$PUB/data/$id/"
    # images/ as the game ships it, minus source files that are not web content
    # (Keynote decks, licences, fetch scripts — MakeGame copies the whole dir).
    if [ -d "$SRC/.lake/gamedata/images" ]; then
      rm -rf "$PUB/data/$id/images"
      rsync -a --include='*/' --include='*.png' --include='*.jpg' --include='*.jpeg' --include='*.gif' --include='*.svg' --include='*.webp' --exclude='*' "$SRC/.lake/gamedata/images/" "$PUB/data/$id/images/"
    fi
    # every translation the game ships (the source language has only a .pot)
    for f in "$SRC"/.i18n/*/Game.json; do
      [ -f "$f" ] || continue
      cp "$f" "$PUB/i18n/$id/$(basename "$(dirname "$f")")"
    done
    echo "staged $id from $src"
  else
    echo "note: $src/.lake/gamedata not found — keeping the tracked $id gamedata/i18n"
  fi
  # i18next probes every configured language (client/src/config.json); a
  # missing file must yield JSON, not the SPA-fallback HTML (the uncaught
  # SyntaxError wedged cypress runs).
  mkdir -p "$PUB/i18n/$id"
  for L in $LANGS; do
    [ -f "$PUB/i18n/$id/$L" ] || printf '{}' > "$PUB/i18n/$id/$L"
  done
done < <(node "$MANIFEST" --list)

# landing-page tile list from the staged game.json files ({owner, game,
# listed, snapshot, tile, settings}; unlisted games stay reachable by URL)
node "$MANIFEST" --api

# Worker scripts come from the vendored, commit-pinned qed64 closure
# (scripts/sync-qed64.sh), never from a live qed64 checkout — they must pair
# with the vendored watchdog shim.
"$HERE/scripts/stage-workers.sh"
