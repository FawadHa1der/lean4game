# wasm/compat — Mathlib modules the essential pack excludes

Lean sources compiled under their **real Mathlib module names** into the game
base tree (`wasm/out/trees/lib-tree-gamebase`) by the `compat` lane of
`wasm/build-from-source.sh`, so a game's unmodified `import Mathlib.Tactic.Have`
resolves without a source patch. The lane discovers every `.lean` file under
this directory as a root (`find`, `wasm/build-from-source.sh` ~421), checks
each against the pack (the shadow rule below) and compiles them all into the
game base tree against the fat `lib-tree`. Seven files today.

## The modules

| file under `wasm/compat/` | module | games that import it | provenance | form |
| --- | --- | --- | --- | --- |
| `Mathlib/Tactic/Have.lean` | `Mathlib.Tactic.Have` | STG4 (`Game/Metadata.lean`), KnightsAndKnaves (`Game/MathlibTheorems.lean`), Robo (`Game/Metadata/FromMathlib.lean`), LinearAlgebraGame (`Game/MyTactic.lean`); NumberTheoryGame, lean4game-logic and LAG's Tutorial levels through the umbrella | mathlib4 tag `v4.23.0`; Copyright (c) 2022 Arthur Paulino, Edward Ayers, Mario Carneiro; Apache-2.0 | classic; two edits (below) |
| `Mathlib/Tactic/Cases.lean` | `Mathlib.Tactic.Cases` | ReintroductionToProofs and Robo (`Game/Metadata/Tactic/Induction.lean`, `ElimApp.evalNames` only), RealAnalysisGame (`Game/Metadata.lean`; `cases'`/`induction'` taught), LinearAlgebraGame (`Game/MyTactic.lean`; `cases'` taught); NumberTheoryGame (`induction'` taught) and lean4game-logic through the umbrella | mathlib4 `de3a9cf` (the pack's revision), **complete**, verbatim after a 7-line provenance header; Copyright (c) 2022 Mario Carneiro; Apache-2.0 | `module` (`public meta import`, `import all Lean.Elab.Tactic.Induction`) |
| `Mathlib/Tactic/Generalize.lean` | `Mathlib.Tactic.Generalize` | Robo (`Game/Metadata/FromMathlib.lean`; the `generalize'` transparency shim) | `de3a9cf`, verbatim after a 4-line header; Copyright (c) 2024 Lean FRO, LLC; Apache-2.0 | `module` |
| `Mathlib/Algebra/Order/Ring/Star.lean` | `Mathlib.Algebra.Order.Ring.Star` | Robo (`StarOrderedRing.toIsOrderedRing`) | `de3a9cf`, verbatim after a 4-line header; Copyright (c) 2023 Jireh Loreaux; Apache-2.0 | `module` |
| `Mathlib/Data/Int/Star.lean` | `Mathlib.Data.Int.Star` | Robo (`Int.instStarOrderedRing`) | `de3a9cf`, verbatim after a 4-line header; Copyright (c) 2024 Yaël Dillies; Apache-2.0 | `module` |
| `Mathlib/Data/Rat/Star.lean` | `Mathlib.Data.Rat.Star` | Robo (`Rat`/`NNRat` `StarOrderedRing` instances) | `de3a9cf`; Copyright (c) 2023 Jireh Loreaux, Yaël Dillies; Apache-2.0 | **classic** — module-system keywords removed (below) |
| `Mathlib/Tactic.lean` | `Mathlib.Tactic` | NumberTheoryGame (`Game/Levels/Definitions.lean`, Problems levels), lean4game-logic (`Game/Metadata.lean`), LinearAlgebraGame (`Game/Metadata.lean`, the 10 Tutorial levels) | generated here from the pack module list; **no Mathlib code copied** (header defect, below) | classic; imports only |

NNG4 imports none of these: its patch vendors `Game/Tactic/MathlibHave.lean`
(same body as `Have.lean` here) and an `evalNames`-only
`Game/Tactic/MathlibCases.lean` from the pre-compat port; both keep working
until its next rebake, when the patch can shrink to the import drops.

### `Have.lean`

The `v4.23.0` file (the Mathlib NNG4, STG4, Reintro and NTG build against)
with exactly two edits: the `wasm/compat` provenance paragraph inside the
header comment, and `import Mathlib.Init` dropped (the remaining imports are
`Lean.Elab.Binders`, `Lean.Elab.SyntheticMVars`, `Lean.Meta.Tactic.Assert`,
all in the pack). Everything else — `optBinderIdent`, `haveIdLhs'`, the
`have`/`let`/`suffices` syntax and `elab_rules` — is byte-identical
(`diff` against `git show v4.23.0:Mathlib/Tactic/Have.lean`). It is *not*
the `de3a9cf` form of the file; nothing a game sees depends on that.

### `Cases.lean`

The full `de3a9cf` file: `ElimApp.evalNames` (what the game `cases`/
`induction` wrappers in NNG4-derived games call) **and** the `cases'` /
`induction'` elaborators (what RealAnalysisGame, NumberTheoryGame and
LinearAlgebraGame teach — players type them live). Its imports
(`Lean.Elab.Tactic.Induction`, `Batteries.Data.List.Basic`,
`Batteries.Lean.Expr`, `Mathlib.Init`) are all in the pack. History: until
2026-09-11 this was the `v4.23.0` `evalNames`-only subset (no `cases'`); the
RealAnalysisGame port replaced it. Reintro and Robo had compiled against the
old olean; both were re-verified against the full file (probes and the
wrapper modules recompiled with no messages), and the games lane rebuilt
their oleans against it.

### `Data/Rat/Star.lean` — classic form

With `module` / `public import` / `public section` the 4.33.0-pre IR
interpreter aborts while elaborating `Rat.addSubmonoid_closure_range_pow`
(`LEAN ASSERTION VIOLATION … ir_interpreter.cpp:928
fn_body_kind::Unreachable`; `wasm/out/port-robo/compat-log.txt` records the
FAIL). The same declarations in classic form compile unchanged, and a classic
module exports a superset of what the `module` form does, so nothing a game
sees differs. The other three Robo leaves compile in their upstream `module`
form.

### `Tactic.lean` — the umbrella

Upstream `de3a9cf` `Mathlib/Tactic.lean` is `module`, `-- shake: keep-all`,
and 356 `public import Mathlib.Tactic.*` lines — no code, and **no copyright
header**. The pack excludes the umbrella module itself and 112 of its 356
leaves, so `import Mathlib.Tactic` cannot resolve from the pack. This file is
an imports-only umbrella generated from the pack module list: the 244
`Mathlib.Tactic.*` modules the pack contains (every one imported by
upstream's umbrella; verified both ways) plus the compat `Mathlib.Tactic.Have`
and `Mathlib.Tactic.Cases` — 246 imports. It therefore compiles after those
two (the lane's single compile into one tree orders this). Of upstream's 356
leaves, 110 remain unavailable through the umbrella (`Polyrith`, `ModCases`,
`Ext`, `Change`, `Replace`, `Relation.Symm`, `NormNum.Prime`, `NormNum.ModEq`,
`CategoryTheory.*`, …; `Generalize` is not listed either — Robo imports it by
name). A player typing a tactic from one of them gets "unknown tactic" where
upstream would parse it; none of the three games teaches one.

Header defect (reported by two reviews, not yet fixed in the file): the first
three lines say "Copyright (c) 2017 Microsoft Corporation … Apache 2.0",
which is wrong — the upstream file has no copyright header and nothing was
copied from it. The paragraph that follows those lines (generated import
list, 244 + 2, no Mathlib code) is the accurate description. When the file
is next touched, replace the three lines with a plain provenance note.

## Why they exist

The Lean environment this build serves is the digest-pinned
`mathlib-essential` pack (Mathlib `de3a9cf`, an import closure of ~2,250
Mathlib modules chosen for the QED64 editor). `Mathlib.Tactic.Have`,
`Mathlib.Tactic.Cases`, `Mathlib.Tactic.Generalize`, the three `*.Star` files
and the `Mathlib.Tactic` umbrella are **excluded from that pack** — leaves no
module of the closure imports — while they remain present in mathlib4. Games
import them by name, so the game tree provides them from here. The pack is an
input we do not rebuild (wasm/KERNEL.md), so this is the narrowest way to
close the gap: seven files, compiled once, shared by every game.

Until the compat lane existed, each port vendored `Have`/`Cases` as
`Game/Tactic/MathlibHave.lean` / `MathlibCases.lean` behind a source patch
(wasm/patches/README.md). NNG4 still does.

## The shadow rule

A compat module may only exist while the pack does **not** provide it. The
compat lane checks every root: it refuses to run when
`wasm/out/trees/lib-tree/<module path>.olean` exists for any file here (a
future pack that ships the real modules must not be shadowed by an older
copy — the two would differ in exactly the ways a player's proof notices).
When that check fires, delete the corresponding file here (and its row
above); nothing else references it.

## How it is compiled

`lane_compat` (also run at the end of `lane_trees`):

```
roots = every wasm/compat/**/*.lean, as module names
compile-pkg.py wasm/compat wasm/out/trees/lib-tree-gamebase <roots>
  LEAN_PATH = wasm/out/trees/lib-tree-gamebase      # one entry: the (fat) game base tree, output written into it
```

- **Output goes into the game base tree, and that tree is the only
  `LEAN_PATH` entry.** Lean resolves a module in the *first* `LEAN_PATH`
  entry that contains its root directory (`Mathlib/`), so compat oleans must
  sit beside the pack's Mathlib oleans; a later entry is never consulted for
  `Mathlib.*`. The failure mode is on record in `wasm/out/logs/compat.log`:
  an earlier attempt that listed the pack's `lib-tree` first failed on the
  umbrella with "object file `lib-tree/Mathlib/Tactic/Have.olean` of module
  Mathlib.Tactic.Have does not exist" although `Have` had just compiled; the
  re-run against the game base tree alone succeeded. The port agents'
  private overlays (`wasm/out/port-<x>/gamebase`) were copies of the game
  base tree with the compat oleans rsynced in, for the same reason.
- **The game base tree is fat** (a hard-linked copy of `lib-tree` plus
  GameServer, every `*.olean.private` facet present): a compat source that
  uses `import all X` (`Cases.lean`) needs X's private facet at compile
  time. Per-game overlays are slim (`SLIM_TREES=1` drops the pack's private
  facets); that is fine for the compiled compat oleans because the importer
  tolerates missing private parts and play time never re-imports a module —
  a snapshot is a finished environment.
- The lane is cheap (seconds once the tree exists) and idempotent; include
  it in `--lanes` on any machine whose game base tree predates the current
  set of files here — the `games` lane only warns when
  `Mathlib/Tactic/Have.olean` is missing.

## Adding or upgrading a module

1. Take the file from the mathlib4 revision you want — normally the pack's
   own `de3a9cf` (`git -C <mathlib4> show de3a9cf:Mathlib/….lean`) — and put
   it at its real path under `wasm/compat/Mathlib/`. Check every import
   against the pack's module list (`wasm/out/trees/lib-tree`); anything
   absent must itself become a compat file or be replaced.
2. Add a short provenance comment on top (revision, licence, why a game
   needs it, any edit). Keep the upstream copyright header as is.
3. Keep the `module` form unless the fork rejects it (`module`/`public`/
   `import all` compile on 4.33.0-pre); when the IR interpreter aborts, drop
   the module-system keywords and say so in the header (`Data/Rat/Star.lean`).
4. Add the row above. If the module is a `Mathlib.Tactic.*` leaf, decide
   whether the umbrella should import it (only if upstream's does).
5. `wasm/build-from-source.sh --lanes compat` (seconds), then `--lanes
   games,bake --games <snapshot> --verify-snapshots` for a game that uses
   the module; the game's own probe (wasm/catalog.json) is the acceptance
   test.
