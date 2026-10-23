# Batteries.Tactic.OpenPrivate (vendored)

`Batteries/Tactic/OpenPrivate.lean` is a byte copy of
[leanprover-community/batteries](https://github.com/leanprover-community/batteries)
at `66e469188fe07963e5cf666c7d4433f45b8131c5` (the revision Mathlib `v4.35.0`
pins), under the Apache License 2.0 (`LICENSE`, Batteries' own).

Why: the `open private` command. GameServer
(`server/GameServer/Helpers/PrettyPrinter.lean`) and three games' tactic
wrappers (NNG4, ReintroductionToProofs, Robo: their `induction`/`cases`
reach the private helpers of `Lean.Elab.Tactic.Induction`) import it. Up to
Lean 4.34 the toolchain release's Mathlib packs shipped it, because Mathlib's
import closure contained it; Mathlib `v4.35.0`'s closure no longer does, so
the `lean-v4.35.0-b081e7c` packs have no `Batteries.Tactic.OpenPrivate`.

The trees lane (`wasm/build-from-source.sh`) compiles it with the release's
native compiler and merges it into the game base trees, beside lean-i18n and
GameServer, under its real module name, so every `import
Batteries.Tactic.OpenPrivate` resolves unchanged. It does so only when the
unpacked packs lack the module: once a release ships it again (for example in
`mathlib-game-extra`), the lane uses the release's copy, and this directory
can be deleted.
