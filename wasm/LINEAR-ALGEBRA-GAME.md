# LinearAlgebraGame on the wasm64 fork — engineering report (2026-09-11)

Analyst: LAG port analysis. Inputs: `ports-facts.md`; clone of
github.com/ZRTMRH/LinearAlgebraGame `main` @ **03b894b2** (2026-05-17, "fix: merge duplicate
NewTheorem blocks in 3 levels (#26)") at
`/Users/fawadhaider/code/wasm64-lean4game/wasm/out/lag-analysis/LinearAlgebraGame`;
game toolchain `leanprover/lean4:v4.21.0`, Mathlib `308445d7` (tag v4.21.0, 2025-06-30),
GameServer `274cc77e` (lean4game v4.21.0), plus `checkdecls` 3d42585 (unused by any level).
Our pin: Lean `4.33.0-pre` (fork 5732b84+browser64.1), Mathlib **de3a9cf3** (2026-07-07), pack
`mathlib-essential-de3a9cf-wasm64-02e0ac24cced25d8` (2,254 Mathlib modules of 4,192).

Reference checkouts used for the computations (all local, no HEAD requests were needed):
- `wasm/out/lag-analysis/mathlib4-de3a9cf` — shallow fetch of the exact pin (8,245 Mathlib files);
- `wasm/out/lag-analysis/mathlib4-308445d` — `git archive` of the game's pin from
  `/Users/fawadhaider/code/mathlib4` (6,554 files);
- `/Users/fawadhaider/code/mathlib4` @ 292c9b2 (2026-08-18) for `git log` rename lookups;
- `wasm/out/mathlib-pack/mathlib-essential.manifest.json` + `wasm/out/staging/profiles/lean-core.manifest.json`
  for the exact pack import graph and per-facet byte sizes.
Scripts and raw outputs: `scratchpad/lag/{graph.py,graph.json,scen.json,closure_counts.json,snapshot_est.json,closure421_*.json,lemma_drift*.json,bytes.json}`.

## TL;DR (the headline contradicts the September survey)

The survey's "297 missing modules, out of scope" number is real but almost entirely
**self-inflicted by two files that no level uses**:

| cause | missing Mathlib modules at de3a9cf (transitive) | used by any level? |
| --- | --- | --- |
| `import Mathlib.Analysis.Complex.AbsMax` (one line in `Game/Levels/InnerProductWorld/LemmasAndDefs.lean:7`, comment "For Complex absolute value") | **245** (drags in MeasureTheory, BoxIntegral, Calculus…) | no — `Complex.abs` occurs only in comments; the lemmas actually used (`Complex.normSq_eq_norm_sq`, `abs_re_le_norm`, `norm_real`, `norm_div`) live in `Mathlib.Analysis.Complex.Norm`, which IS in the pack |
| `Game/Data.lean` (604 lines, 593 of them commented-out imports, 34 active, zero declarations) | **32** (Matrix/PNat/Num/Finmap/Opposite/Real.Sign/Archimedean leaves) | no — no reachable level references `Matrix`, `PNat`/`ℕ+` (prose only, LIS Level05:49), `Num`, `Finmap`, `Opposite`, `Real.sign` |
| `Mathlib.Tactic.Have` / `.Cases` (via `Game/MyTactic.lean`) | 2 | yes (`have h : t` form, `cases'` taught: 31 uses) — already provided by `wasm/compat` |
| `Mathlib.Tactic` umbrella (via `Game/Metadata.lean`, Tutorial levels only) | umbrella + 112 leaves | tutorial tactics only — already provided by `wasm/compat/Mathlib/Tactic.lean` |

With a ~40-line import patch the game's whole reachable closure is **inside today's pack: 0
missing modules** (verified by walking the exact de3a9cf sources; 1,674 Mathlib modules).
**No pack growth, no qed64 substrate change, no reduced game is needed.** The port is a normal
"patched" catalog row like NNG4, with a bigger snapshot (est. ~950 MB raw slim / ~260 MB gz,
between STG4 and NNG4) and a compile-and-fix pass over 43 levels.

## 1. Exact reachable import set and its Mathlib closure at our pin

### 1.1 The game's own module graph (from `Game.lean`, transitive)

- 55 reachable game modules (of 59 `.lean` files under `Game/`). Not reachable, therefore not
  part of the served game: `Game/Levels/DemoWorld.lean`, `Game/Levels/DemoWorld/L01_HelloWorld.lean`,
  `Game/Levels/InnerProductWorld/Code.lean`, `Game/Levels/LinearMapsWorld/Level01_backup.lean`,
  `Game/MyTactic 2.lean`.
- Structure: `Game` → 5 world files → levels; each world's Level01 imports the previous world file
  (VectorSpace ← Tutorial? no: VectorSpaceWorld/Level01 imports `Game.Metadata.Metadata`;
  LinearIndependenceSpanWorld/Lemmas imports `Game.Metadata.Metadata`; LIS/Level01 imports
  `Game.Levels.VectorSpaceWorld`; LinearMaps/Level01 imports `Game.Levels.LinearIndependenceSpanWorld`;
  InnerProduct/LemmasAndDefs imports both LIS and VectorSpace worlds).
- Two metadata layers: `Game/Metadata.lean` = `GameServer.Commands` + `Mathlib.Tactic` (imported by
  the 10 Tutorial levels only); `Game/Metadata/Metadata.lean` = `GameServer.Commands` + `Game.Data`
  + `Game.MyTactic` (everything else).
- Worlds/levels (from `World`/`Level` commands): TutorialWorld 10, VectorSpaceWorld 5,
  LinearIndependenceSpanWorld 9, LinearMapsWorld 11, InnerProductWorld 8 = **5 worlds / 43 levels**;
  `Dependency` ×3; 585 `Hint` tactic lines (325 `(hidden := true)`, 1 `(strict := true)`), 1 `Branch`,
  0 `Hole`/`Template`; 115 `TheoremDoc`, 40 `TacticDoc`, 15 `DefinitionDoc`, 8 `TheoremTab`,
  20 `NewTactic`, 22 `NewTheorem`, 13 `NewDefinition`, 2 `NewHiddenTactic`, 5 `DisabledTactic simp linarith`.

### 1.2 Direct external imports: 69 = `GameServer.Commands` + 68 Mathlib modules

Status against the pack (`pack-modules.txt`) and against de3a9cf sources:

**37 in the pack** — `Mathlib.Analysis.Complex.Basic`, `Analysis.Normed.Group.Basic`, `Data.Complex.Basic`,
`Data.Matrix.{Basic,Basis,Block,Reflection}`, `Data.PNat.{Basic,Defs}`, `Data.Real.Basic`, and 26
`Mathlib.Tactic.*` from `MyTactic.lean` (`ApplyAt ApplyCongr ApplyWith Basic ByContra CasesM Check
Constructor HaveI Lemma Linarith Linarith.{Datatypes,Frontend,Lemmas,Parsing,Preprocessing,Verification}
LinearCombination NthRewrite Set SimpIntro SimpRw Simps.Basic Simps.NotationClass Tauto Use Variable`).

**7 no longer exist under that name at de3a9cf** (all from `Game/Data.lean`):

| old name | what happened | new name | at de3a9cf | in pack |
| --- | --- | --- | --- | --- |
| `Mathlib.Data.Matrix.CharP` | moved, mathlib4 `1cd593f1f0` 2025-08-27 "chore: move most of Data/Matrix to LinearAlgebra (#28966)" | `Mathlib.LinearAlgebra.Matrix.CharP` | exists | no |
| `Mathlib.Data.Matrix.Hadamard` | same commit | `Mathlib.LinearAlgebra.Matrix.Hadamard` | exists | no |
| `Mathlib.Data.Matrix.Kronecker` | same | `Mathlib.LinearAlgebra.Matrix.Kronecker` | exists | **yes** |
| `Mathlib.Data.Matrix.Notation` | same | `Mathlib.LinearAlgebra.Matrix.Notation` | exists | **yes** |
| `Mathlib.Data.Matrix.Rank` | same | `Mathlib.LinearAlgebra.Matrix.Rank` | exists | no |
| `Mathlib.Data.Matrix.RowCol` | same | `Mathlib.LinearAlgebra.Matrix.RowCol` | exists | **yes** |
| `Mathlib.Data.Real.Cardinality` | became a `deprecated_module (since := "2025-08-26")` shim, deleted in `46b9dfd49a` 2026-03-02 "(#35873)" | content in `Mathlib.Analysis.Real.Cardinality` | exists | **yes** |

**24 exist at de3a9cf but are not in the pack** (count of *additional* missing modules each one's
closure needs, from `scen.json`): `Mathlib.Analysis.Complex.AbsMax` (245), `Data.Num.Prime` (9),
`Data.Num.Lemmas` (7), `Data.Finmap` (4), `Data.Matrix.DualNumber` (4), `Data.Matrix.PEquiv` (2),
`Data.Num.Bitwise` (2), `Data.PNat.Factors` (2), `Data.PNat.Xgcd` (2), `Data.Matrix.Auto` (1),
`Data.Matrix.ColumnRowPartitioned` (1), `Data.Matrix.DMatrix` (1), `Data.Matrix.Invertible` (1),
`Data.Num.Basic` (1), `Data.Opposite` (1), `Data.PNat.Find` (1), `Data.PNat.Interval` (1),
`Data.PNat.Prime` (1), `Data.Real.Archimedean` (1), `Data.Real.Sign` (1), `Data.Real.Sqrt` (1 — at
de3a9cf this file is a `deprecated_module (since := "2026-05-28")` shim whose only content is
`public import Mathlib.Analysis.Real.Sqrt`, and `Analysis.Real.Sqrt` IS in the pack), `Mathlib.Tactic`
(umbrella), `Mathlib.Tactic.Cases` (1), `Mathlib.Tactic.Have` (1).

So 31 direct imports are not in the pack (7 renamed + 24 missing); the pack-excluded ones are
all leaves or near-leaves except `AbsMax`.

### 1.3 Closures (Mathlib modules, walked over the de3a9cf sources; `graph.json`, `scen.json`)

| scenario | closure | in pack | **missing** |
| --- | --- | --- | --- |
| game as-is, `Mathlib.Tactic` umbrella taken literally (de3a9cf umbrella = 356 leaves) | 3,122 | 2,200 | **922** |
| game as-is, umbrella replaced by the compat umbrella (pack's 244 `Mathlib.Tactic.*` + Have/Cases) | 2,479 | 2,200 | **279** (the survey's 297, minus modules the pack gained since) |
| + the 7 renames applied (faithful port of every import) | 2,483 | 2,200 | 283 |
| drop only `AbsMax` | 1,630 | 1,596 | **34** (list in §2.1) |
| drop `AbsMax` + trim `Game/Data.lean` to its pack-present modules, `Data.Real.Sqrt` → `Analysis.Real.Sqrt` ("minimal patch") | 1,674 | 1,672 | **2** = `Tactic.Have`, `Tactic.Cases` (compat) → **0** |

Per-world missing count (each world's own reachable closure, compat umbrella assumed):

| world | levels | game files | closure (Mathlib) | missing as-is | missing after the minimal patch |
| --- | --- | --- | --- | --- | --- |
| TutorialWorld | 10 | 12 | 1,619 (umbrella only) | 0 | 0 |
| VectorSpaceWorld | 5 | 9 | 1,397 | 34 (all from `Data.lean`) | 0 |
| LinearIndependenceSpanWorld | 9 | 20 | 1,397 | 34 | 0 |
| LinearMapsWorld | 11 | 32 | 1,397 | 34 | 0 |
| InnerProductWorld | 8 | 30 | 2,479 | 279 (245 from `AbsMax`) | 0 |

### 1.4 Is dropping those imports semantics-preserving? (static evidence)

- `Complex.abs` (the stated reason for `AbsMax`) appears 3× in the game, all in comments
  (`InnerProductWorld/Level07.lean:223-224`, `LemmasAndDefs.lean:175`); it no longer exists as a
  declaration at de3a9cf anyway (norm `‖·‖` replaced it), so the import could not help.
- Every Mathlib identifier used in proofs/hints (77 distinct after filtering local hypotheses;
  `lemma_drift2.json`) resolves at de3a9cf, and the module that defines it is inside the minimal
  closure. Three resolve through `to_additive` twins (`Finset.sum_eq_sum_diff_singleton_add` — an
  `alias` of `prod_eq_prod_sdiff_singleton_mul` at de3a9cf, so possibly a deprecation warning;
  `Finset.sum_sub_distrib`, `Finset.sum_subset`), `le_abs_self` via `le_mabs_self`, `subset_trans`
  is auto-generated by `Mathlib.Tactic.SetNotationForOrder`. Real/Complex lemmas used
  (`Real.sqrt_nonneg/sqrt_pos/sqrt_eq_zero/sq_sqrt`, `abs_le_of_sq_le_sq`, `abs_sq`,
  `Complex.normSq_eq_norm_sq/abs_re_le_norm/norm_real/norm_div/re_ofReal_mul/mul_conj/conj_conj/
  conj_re/conj_im/ext/add_re/mul_re/mul_im`) are defined in `Analysis.Real.Sqrt`,
  `Algebra.Order.Ring.Abs`, `Analysis.Complex.Norm`, `Data.Complex.Basic`, `Algebra.Star.Basic` — all
  in the pack and in the minimal closure.
- Taught tactics vs modules (all in the minimal closure): `linarith`, `ring`, `ring_nf`, `field_simp`,
  `tauto`, `apply_fun`, `use`, `nth_rw`, `by_contra`, `norm_cast`, `set`, `choose`, `simp_rw`,
  `apply_at`, `constructor` (pack); `cases'`, goal-form `have`/`suffices` (compat); the rest are core.
- Cross-check against the game's own pin: the same direct imports close to 2,203 modules at 308445d.
  678 of those are absent from the minimal de3a9cf closure (Calculus/MeasureTheory/Polynomial…), 58
  no longer exist — none defines anything the levels reference (the identifier check above).
  Signature/`simp`-normal-form drift is NOT detectable statically: budget for it in §4.

## 2. Pack growth — what it would cost if the imports were kept faithfully (not recommended)

Per-module byte averages from the pack manifest (Mathlib modules, n = 2,254): olean 254.7 KB mean
(median 142 KB), olean+ir+ir.sig ("slim" facets) 301.8 KB, all five facets ("fat", incl.
`.olean.private`/`.olean.server`) 752.7 KB. Pack raw total 3,492,342,248 B, gzip transport
992,947,966 B (ratio 0.284).

### 2.1 Growth by scenario (Mathlib modules to add to the pack; bytes = count × mean, estimates)

| scenario | +modules | +olean | +slim | +fat (pack raw) | +pack gz (×0.284) |
| --- | --- | --- | --- | --- | --- |
| minimal patch | 0 | 0 | 0 | 0 | 0 |
| keep `Data.lean` faithfully (renamed), drop `AbsMax` | 34 (≈38 with `LinearAlgebra.Matrix.{CharP,Hadamard,Rank}`, est.) | 8.7 MB | 10.3 MB | 25.6 MB | ~7 MB |
| keep everything incl. `AbsMax` | 279 (283 renamed) | 71 MB | 84 MB | 210 MB | ~60 MB |
| keep everything AND the real `Mathlib.Tactic` umbrella | 922 | 235 MB | 278 MB | 694 MB | ~197 MB |

The 34: `Algebra.DualNumber`, `Algebra.TrivSqZeroExt.Basic`, `Data.Finmap`, `Data.List.{AList,GetD,
Lookmap,Sigma}`, `Data.Matrix.{Auto,ColumnRowPartitioned,DMatrix,DualNumber,Invertible,PEquiv}`,
`Data.Nat.{Bitwise,PSub,Size}`, `Data.Num.{Basic,Bitwise,Lemmas,Prime,ZNum}`, `Data.Opposite`,
`Data.PEquiv`, `Data.PNat.{Factors,Find,Interval,Prime,Xgcd}`, `Data.Real.{Archimedean,Sign,Sqrt}`,
`LinearAlgebra.Matrix.DualNumber`, `Tactic.Cases`, `Tactic.Have`. The 245 from `AbsMax` are
`MeasureTheory.*` (≈140), `Analysis.BoxIntegral/Calculus/Normed/SpecialFunctions/Convex/…` (≈45),
`Topology.*` (≈30), `Order.Filter` (7), `Probability/Dynamics` (4) — the Cauchy-integral machinery
behind the maximum-modulus principle, nothing a linear-algebra game touches.

### 2.2 What a bigger pack means for qed64 (substrate change, owned by qed64)

The pack is produced by the peer's pipeline, not ours: qed64 `docs/REBUILD.md` §2 "Full rebuild"
(build the fork natively, `lake build` Mathlib at the `docs/PROVENANCE.md` pin, collect the
`.olean`/`.ir` facets, then `pipeline/artifacts/pack.mjs --lib <olean tree> --id mathlib-essential
--out <dir> [--lean-version 4.33.0-pre] [--revision <hash>] --roots Mod1,Mod2`). The module set is the
import closure of the **3 root modules** recorded in the manifest `content.roots`:
`Mathlib.Analysis.SpecialFunctions.Complex.Circle`, `Mathlib.Geometry.Manifold.Instances.Sphere`,
`Mathlib.Geometry.Manifold.IsManifold.Basic`. Growing the pack for LAG means adding
`Mathlib.Analysis.Complex.AbsMax` (+ the `Data.*` leaves) as roots, a native Mathlib build
(several hours, ~40 GB per REBUILD.md), a new pack digest/manifest (`public/profiles/*.manifest.json`
is the trust anchor), an R2 upload of the new parts (+60–200 MB gz), then on our side a full
`wasm/build-from-source.sh` run (`trees` lane unpacks the new pack into `lib-tree`/`lib-tree-gamebase`,
`compat` recompiles Have/Cases/umbrella against it) and a rebake of **every** catalog game's
snapshot (the compat shadow rule in `wasm/compat/README.md` also fires if the new pack ships
`Tactic.Have`/`Cases`). PORTING.md §1 already names this class "blocked until the pack's root set
grows (a qed64 input, not ours)". For LAG it is avoidable entirely.

### 2.3 Snapshot size (estimates, calibrated on measured bakes)

Method: walk each game's closure over the exact pack+core manifest import graph and sum the slim
facet bytes; calibrate raw snapshot / slim-bytes on STG4 (measured 665,285,845 B raw, 180,977,642 B
gz, `+slim`): ratio **0.78**; NNG4 fat gives raw/fat-bytes 0.76 (consistent). gz ratio ≈ 0.27
(stg4 0.272, nng4 0.292).

| snapshot | closure (all roots) | Mathlib modules | slim facet bytes | raw (est.) | gz (est.) |
| --- | --- | --- | --- | --- | --- |
| stg4 (measured) | 2,515 | 317 | 850 MB | 665 MB | 181 MB |
| nng4 (measured, fat) | 2,041 | 53 | (fat 1,929 MB) | 1,466 MB | 428 MB |
| **LAG minimal patch + compat umbrella, slim** | 3,824 | 1,619 | 1,214 MB | **≈950 MB** | **≈260 MB** |
| LAG fat (if `SLIM_TREES` were off) | 3,824 | 1,619 | (fat 3,204 MB) | ≈2.4 GB | ≈0.7 GB |
| LAG with `AbsMax` kept (needs the bigger pack) | +≈850 Mathlib modules | 2,479 | +≈256 MB | ≈1.15 GB | ≈0.31 GB |

Each extra Mathlib module costs ≈236 KB raw in a slim snapshot (302 KB × 0.78).

### 2.4 Browser side

- Memory policy (`client/src/wasm/games-api.ts:187-191`): initial = max(1 GiB, ⌈1.1×region/256 MiB⌉×256 MiB),
  cap = max(3 GiB, initial+1 GiB). For a 950 MB region: 1.1× = 1,045 MB < 4×256 MiB → **initial 1,024 MiB,
  cap 3 GiB**; at 1,045–1,220 MB raw it becomes 1,280 MiB / 3 GiB. Same class as today's games.
- First-visit renderer peak (UX-PARITY.md l.347-372, measured with nng4's 1.47 GB region): 7.4 GB at
  "Initializing the Lean runtime" before any snapshot, 8.3 GB at ready; the floor is V8 machine code
  for the 106 MB module, so LAG's smaller-than-nng4 region adds nothing beyond that curve
  (est. ≈8.0–8.3 GB peak). The two-of-four click-path deaths at the snapshot handover are the same
  exposure as nng4. Wire cost of a first visit: runtime 154 MB + core pack 120 MB + ≈260 MB snapshot
  ≈ 535 MB (nng4: 702 MB; stg4: ≈455 MB). A bigger Mathlib pack would NOT change the wire cost
  for a game (the game downloads only its snapshot) — only the bake inputs.

## 3. Game-side port

### 3.1 Lean/GameServer drift v4.21.0 → 4.33-pre

- Custom code: none. `grep` over reachable files finds 0 `elab`/`macro`/`syntax`/`macro_rules`;
  2 `notation`s (`⟪x, y⟫` and a user-level `notation "‖" x "‖" => norm_v x` in
  `InnerProductWorld/LemmasAndDefs.lean:170`, which overloads Mathlib's norm notation — it worked at
  v4.21 with `Analysis.Normed.Group.Basic` already imported; overload resolution is the same at
  4.33, but this is the first thing to check in InnerProductWorld's compile); 4 `class`, 1 `instance`,
  21 `def`, 49 `theorem`/`lemma`. The game defines its own `VectorSpace` (abbrev), `span`,
  `linear_independent_v`, `is_linear_map_v`, `norm_v`, `InnerProductSpace_v` etc., so Mathlib API
  exposure is thin (Set/Finset sums, ℝ/ℂ lemmas, `Module` axioms).
- `Game/MyTactic.lean` (203 lines): a pure import list; 29 active `Mathlib.Tactic.*` imports (27 in
  pack, `Have`/`Cases` compat), the rest inside `/- … -/`. **`Game/MyTactic 2.lean`** is a macOS
  duplicate (file name with a space, not a valid module name, imported by nothing): identical except
  it un-comments `Mathlib.Tactic.Congr!`, `.Congrm`, `.Linarith.Elimination`, `.Rewrites`. Harmless
  for `compile-pkg.py` (walks from `Game`); delete it in the patch for hygiene.
- `Game/Data.lean`: 604 lines, 34 active imports, 0 declarations. Replace with the pack-present
  subset (`Data.Matrix.{Basic,Basis,Block,Reflection}`, `Data.PNat.{Basic,Defs}`, `Data.Real.Basic`,
  `Data.Complex.Basic`, `LinearAlgebra.Matrix.{Kronecker,Notation,RowCol}`, `Analysis.Real.Cardinality`,
  `Analysis.Real.Sqrt`) — or empty it; nothing references any of it. Keeping the pack-present ones
  costs nothing (they are in the closure anyway) and keeps the file's intent.
- `Game/Levels/InnerProductWorld/LemmasAndDefs.lean:5-10`: drop `Analysis.Complex.AbsMax`, replace
  `Data.Real.Sqrt` by `Analysis.Real.Sqrt` (the shim would otherwise emit a deprecated-module warning
  in every InnerProduct level).
- `Game.lean:54`: `Languages "English"` → `Languages "en"` (PORTING.md §6; `.i18n/config.json` already
  says `sourceLang: "en"`; `.i18n/en/Game.pot` has 323 msgids; no translations shipped).
- GameServer: the command surface LAG uses is unchanged between 274cc77 and our fork's
  `server/GameServer/Commands.lean` — diff of the `elab`/`syntax` lines for `Statement`, `Level`, `World`,
  `NewTactic`, `NewTheorem`, `NewHiddenTactic`, `DisabledTactic`, `Dependency`, `Languages`,
  `CoverImage` is empty; `TheoremDoc … as … in …` still parses (the `in` clause became optional);
  `Hint (hidden := true)`/`(strict := true)` are accepted by `server/GameServer/Tactic/Hint.lean:12-35`;
  `Branch` exists (`Tactic/Branch.lean:10`). `Hole`/`Template`/`Settings` unused. 585 hints
  re-elaborate at compile time (MakeGame cost, not a port risk).
- Lakefile → catalog `leanOptions`: `moreLeanArgs` = `tactic.hygienic=false`,
  `linter.unusedVariables.funArgs=false`, `trace.debug=false`. Note the lakefile does NOT set
  `linter.all=false` (NNG4/STG4 rows do); expect linter warnings in levels and decide per PORTING.md §5
  (the probe must close without warnings).
- checkdecls: required by the lakefile, referenced by no `.lean` file — ignore.

### 3.2 Estimated patch

Import layer: ~45 changed lines across 4 files (`Data.lean`, `LemmasAndDefs.lean`, `Game.lean`,
delete `MyTactic 2.lean`). Proof layer (**estimate**, unknowable before compiling): the 4.21→4.33 /
308445d→de3a9cf gap is 14 months of Mathlib; expect breakage in `field_simp` proofs (11 uses —
`field_simp` was rewritten in late 2025), `ring_nf` normal forms (16), `simp` closings under changed
simp sets, and deprecated aliases (`Finset.sum_eq_sum_diff_singleton_add`). Budget 5–25 proof/hint
edits, ≈30–100 lines, concentrated in InnerProductWorld (Cauchy–Schwarz, L07) and
LinearIndependenceSpanWorld. Total patch est. 80–150 lines, one commit, `git am`-clean.

### 3.3 Unportable levels

None identified statically: every taught tactic, every referenced Mathlib lemma and every
GameServer command exists at our pin, and the game's mathematical objects are its own definitions.
The only structural hazard is the `‖ ‖` notation overload in InnerProductWorld (8 levels); if it
ambiguates at 4.33 the fix is local (`notation:max "‖" x "‖ᵥ"` is NOT allowed — players type `‖v‖` —
so the fix would be `open scoped` hygiene or a `macro_rules` priority, still no level removed).

## 4. Work plan (ordered; hours are estimates)

| # | step | hours | acceptance test |
| --- | --- | --- | --- |
| 0 | Compile the compat layer into the game base: `wasm/build-from-source.sh --lanes compat` (or, per ports-facts, into a private overlay `wasm/out/port-lag/gamebase`). Today `lib-tree-gamebase/Mathlib/Tactic.olean` does not exist and `Tactic/Cases.olean` is the Sep-8 evalNames-only build; `wasm/compat/Mathlib/Tactic.lean` (umbrella, 246 imports) and the upgraded `Cases.lean` (de3a9cf version with `cases'`/`induction'`, `import all Lean.Elab.Tactic.Induction`) were written today and are uncompiled | 0.5 | `Mathlib/Tactic.olean`, `Tactic/Cases.olean` newer than their sources in the overlay; `strings Cases.olean | grep -c "induction'"` > 0 |
| 1 | Clone `ZRTMRH/LinearAlgebraGame` @ 03b894b into `games-src/LinearAlgebraGame`; apply the import patch (§3.1/§3.2) | 1 | `compile-pkg.py` resolves every import (no `unknown module`), `git am` of the draft patch applies to a fresh clone |
| 2 | Compile: `compile-pkg.py … Game` with `-Dtactic.hygienic=false -Dlinter.unusedVariables.funArgs=false -Dtrace.debug=false` (+ `-Dlinter.all=false` if the row adopts it) against the overlay | 0.5 machine (est. 10–20 min for 55 modules + 585 hints) | `[55/55]`, `package complete` |
| 3 | Fix what breaks, level by level, semantics-preserving (no taught syntax changes; compat modules for any tactic gap); re-run incrementally | 4–12 | zero `error`, `warning:` lines listed and each one either fixed or justified; `.i18n/en/Game.pot` restored |
| 4 | Gamedata check: `.lake/gamedata/game.json` = 5 worlds / 43 levels, `worldSize` per world 10/5/9/11/8, 3 dependencies, `inventory.json`, `images/cover.png` (180 KB) | 0.5 | counts match; `node scripts/games-manifest.mjs --check` exit 0 with the new row |
| 5 | Catalog row (owner `ZRTMRH`, game `LinearAlgebraGame`, snapshot `linearalgebragame`, patch `wasm/patches/linearalgebragame-wasm64-port.patch`, leanOptions above, `Languages` en); bake slim via `--lanes games,bake --games linearalgebragame --verify-snapshots` | 1 + bake time (est. 20–40 min; ~40 GB scratch) | `SNAPSHOT PROBE PASS`; raw within ±5 % of est. 950 MB (else paste the printed value), gz ≈ 260 MB |
| 6 | Probes: (a) `TutorialWorld` level 1, `rfl` (Statement `(x : ℝ) : x = x`); (b) mid-game `LinearMapsWorld` level 1, `unfold is_linear_map_v\nrfl` (exercises the taught `unfold`), or `LinearIndependenceSpanWorld` level 1 `unfold is_linear_combination\nuse {v}\nuse (fun w => 1)\nsimp\nexact hv` (use/simp) | 0.5 | both complete without warnings in `snapshot-probe --via-mem` and in `qed64/work/games-smoke.mjs` |
| 7 | Stage + browser smoke (`scripts/stage-game-assets.sh`, i18n stubs for 9 UI languages, landing tile "Download ≈260 MB"), cypress unchanged, hand-off (user uploads/pushes) | 2 | smoke passes on the staged build; first-visit memory curve within the nng4 envelope |
| | **total** | **≈10–18 h** + ≈1 h machine | |

### 4.1 Reduced-game option (not needed, recorded for completeness)

With `Game/Data.lean` trimmed but `AbsMax` kept, the four non-inner-product worlds
(Tutorial, VectorSpace, LinearIndependenceSpan, LinearMaps: 35 of 43 levels) need 0 missing modules
and InnerProductWorld needs 245. A reduced game would drop the `import Game.Levels.InnerProductWorld`
line from `Game.lean` — which the porting rules forbid ("never remove a level or a world") and which
is pointless since dropping one unused import line serves all 43 levels on today's pack.

## 5. Risks

1. **Proof drift found only at compile time (medium, bounded).** `field_simp`/`ring_nf`/`simp`
   normal-form changes and deprecated aliases over 14 months of Mathlib; mitigated by the thin
   Mathlib surface (own definitions) and the identifier audit (77/77 resolve). Worst case is a
   handful of levels needing alternative proof scripts — hints (585) must stay truthful to the
   new scripts, so every edited level's hidden hints need a re-read.
2. **Warnings render to players.** No `linter.all=false` in the lakefile; the `Data.Real.Sqrt`
   shim and `Finset.sum_eq_sum_diff_singleton_add` alias may warn; a probe "completed with warnings"
   fails the smoke. Decide the linter flag in the catalog row and fix deprecations in the patch.
3. **`‖x‖` notation overload** in InnerProductWorld against Mathlib's norm notation (8 levels).
4. **Snapshot size ≈950 MB slim (est.)**: a first visit is ≈535 MB on the wire and sits on the
   same ≈8 GB renderer curve as nng4; the ±5 % `expectedRaw` gate will need the measured number.
5. **Compat dependencies not yet compiled** (umbrella, full `Cases`): step 0 is a prerequisite and
   the full `Cases.lean` must compile against the fat `lib-tree` (`import all`); its `.olean.private`
   for `Lean.Elab.Tactic.Induction` is present (`wasm/out/trees/lib-tree/Lean/Elab/Tactic/Induction.olean.private`).
6. **The pack-growth path** (only if someone insists on keeping `AbsMax`/`Data.lean` verbatim):
   +279 modules / +210 MB fat pack raw, a qed64 native Mathlib rebuild (hours, ~40 GB), new manifests,
   a rebake of every game, and ≈+200 MB on the LAG snapshot — all for imports no level uses. Reject.
7. **Upstream churn**: the game repo is actively edited (last commit 2026-05-17; many session/backup
   files in the tree). Pin 03b894b in the catalog row; a later rebase is an import-layer re-check
   only (`scratchpad/lag/graph.py` re-runs in seconds).
8. **Estimates marked (est.)** rest on one slim calibration point (STG4); the fat NNG4 point agrees
   within 3 %, but the raw size must still be measured at bake.
