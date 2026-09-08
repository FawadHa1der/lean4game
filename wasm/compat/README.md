# wasm/compat — Mathlib leaves the essential pack excludes

Lean sources compiled under their **real Mathlib module names** into the game
base tree (`wasm/out/trees/lib-tree-gamebase`) by the `compat` lane of
`wasm/build-from-source.sh`, so a game's unmodified `import Mathlib.Tactic.Have`
resolves without a source patch.

| module | why a game needs it | what is here |
| --- | --- | --- |
| `Mathlib.Tactic.Have` | the goal-creating `have h : t` / `suffices h : t` syntax that NNG4, STG4, KnightsAndKnaves, Robo … teach and players type live | the complete file at mathlib4 tag v4.23.0 |
| `Mathlib.Tactic.Cases` | `ElimApp.evalNames`, which game `cases`/`induction` wrappers are built on (NNG4, ReintroductionToProofs, RealAnalysisGame, Robo) | the v4.23.0 `evalNames` + its helper only; **no `cases'` / `induction'`** (a game using those fails with an unknown-tactic error until the upgrade below) |

## Why they exist

The Lean environment this build serves is the digest-pinned
`mathlib-essential` pack (Mathlib `de3a9cf`, an import closure of ~2,250
Mathlib modules chosen for the QED64 editor). `Mathlib.Tactic.Have` and
`Mathlib.Tactic.Cases` are **excluded from that pack** — they are leaves no
analysis module imports — while they remain present in mathlib4 (both files
exist on master as of 2026-09; `Cases.lean` there uses the module system and
`import all`). Games import them by name, so the game tree provides them from
here. The pack is an input we do not rebuild (wasm/KERNEL.md), so this is the
narrowest way to close the gap: two files, compiled once, shared by every game.

Until the compat lane existed, each port vendored the same two files as
`Game/Tactic/MathlibHave.lean` / `MathlibCases.lean` behind a source patch
(wasm/patches/README.md). Those in-tree copies keep working — different module
names, no clash — until the game's next rebake, when its patch can shrink to
the import drops only.

## Attribution

Both files are Mathlib code, Copyright (c) 2022 Arthur Paulino, Edward Ayers,
Mario Carneiro (Have) and Mario Carneiro (Cases), released under the Apache
License 2.0 (mathlib4 `LICENSE`), taken from mathlib4 tag `v4.23.0` (the
Mathlib revision NNG4 and STG4 build against). The only edits are the header
comments, the omitted `cases'`/`induction'` elaborators, and — in `Cases.lean`
— `import Batteries.Lean.Expr` for `Lean.Expr.addLocalVarInfoForBinderIdent`
(present in the pack's `Batteries/Lean/Expr.olean`; upstream moved the
definition there from `Mathlib.Lean.Expr.Basic`, which the pack's copy no
longer defines) in place of the private re-implementation the game copies
carry. The Batteries definition is `MetaM Unit`; the one call site runs in
`TermElabM`, where it lifts.

## The shadow rule

A compat module may only exist while the pack does **not** provide it. The
compat lane refuses to run when `wasm/out/trees/lib-tree/Mathlib/Tactic/Have.olean`
or `Cases.olean` exists (a future pack that ships the real modules must not be
shadowed by an older copy — the two would differ in exactly the ways a
player's proof notices). When that check fires, delete the corresponding file
here (and its row above); nothing else references it.

## How it is compiled

`lane_compat` (also run at the end of `lane_trees`):

```
compile-pkg.py wasm/compat wasm/out/pkgs/compat Mathlib.Tactic.Have Mathlib.Tactic.Cases
  LEAN_PATH = wasm/out/trees/lib-tree : wasm/out/pkgs/compat      # the FAT tree
rsync wasm/out/pkgs/compat/ → wasm/out/trees/lib-tree-gamebase/    # no wipe
```

against the **fat** `lib-tree` (every `*.olean.private` facet present): a
compat source that ever uses `import all X` needs X's private facet at
compile time. Per-game overlays are slim (`SLIM_TREES=1` drops the pack's
private facets); that is fine for the compiled compat oleans because the
importer tolerates missing private parts and play-time never re-imports a
module — a snapshot is a finished environment.

## Upgrade recipe (the full `Mathlib.Tactic.Cases`, or a newer `Have`)

1. Take the file from the mathlib4 revision you want
   (`git -C <mathlib4> show <rev>:Mathlib/Tactic/Cases.lean`). The current
   upstream `Cases.lean` is a `module` file with
   `public meta import Lean.Elab.Tactic.Induction` / `import all
   Lean.Elab.Tactic.Induction` (for `getElimNameInfo`) and imports
   `Mathlib.Init`; check every import against the pack's module list
   (`wasm/out/trees/lib-tree`) — anything absent must itself become a compat
   file or be replaced.
2. Drop the module-system keywords only if the pinned kernel rejects them
   (the fork is 4.33.0-pre; `module`/`public`/`import all` compile there);
   the `import all` form is exactly why the compat compile uses the fat tree.
3. Keep the header comments' attribution and tag; update the table above.
4. `wasm/build-from-source.sh --lanes compat` (seconds), then `--lanes
   games,bake --games <snapshot> --verify-snapshots` for a game that uses the
   module; the game's own probe (wasm/catalog.json) is the acceptance test.
