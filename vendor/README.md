# Vendored dependencies

- `i18n/` — hhu-adam/lean-i18n at tag `v4.33.0` (commit f788a30), vendored
  without history. Compiled against the QED64 Lean fork (4.33.0-pre) by
  `wasm/scripts/compile-pkg.py`; 16/16 modules build with zero source changes.

# Game sources (not vendored)

- `games-src/NNG4` — local clone of hhu-adam/NNG4, branch `wasm64-port`
  (fork-port commits live in that repo's own history; latest: 7f67c24).
  Ignored here to avoid an embedded gitlink; push it as your own fork and
  convert to a submodule when ready.
