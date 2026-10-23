# Game source patches

A patch is the `source.patch` of a game's row in `wasm/catalog.json`: the
games lane (`wasm/build-from-source.sh`) applies it with `git am` right after
cloning `source.url` at `source.rev` into the row's `src` (`games-src/` is
gitignored), so a clone of this repo alone can re-derive every game's sources.
What each patch changes for a player is recorded per game in
`wasm/PORTING.md` §8; this file is the per-patch inventory.

## Conventions

- One commit over the pinned upstream revision, source files only, no
  `.i18n/*/Game.pot` (the compile regenerates the template and the lane
  restores it; a patch carrying it would not apply twice). Author
  `wasm64 port <wasm64@localhost>` (NNG4's, the first port, is the
  exception on both counts).
- Regenerate from the checkout, with the template excluded:

  ```bash
  git -C games-src/<Game> checkout -- '.i18n/*/*.pot'      # after any compile
  git -C games-src/<Game> format-patch --stdout <source.rev> -- . ':!.i18n' \
    > wasm/patches/<snapshot>-wasm64-port.patch
  ```

  then prove it applies: `git clone <url> /tmp/x && git -C /tmp/x checkout
  <source.rev> && git -C /tmp/x am wasm/patches/<snapshot>-wasm64-port.patch`
  (clean status, then delete the clone). The five 2026-09-11 patches passed
  that check on that day; NNG4's is applied the same way by the lane's
  `ensure_source` when `games-src/NNG4` is absent.
- An existing checkout must BE the row's source: the games lane checks
  that `HEAD`'s tree is the tree `source.rev` + this patch gives (built in
  a throwaway index with `git apply --cached`) and refuses otherwise — after
  a patch is re-cut, every checkout made from the old one (other worktrees,
  other machines) is refused until it is deleted (the lane clones and
  patches it again) or re-applied by hand. Uncommitted `.lean` edits only
  warn (the porting loop compiles them before the patch is cut). The
  per-game tree's provenance stamp records `source.rev` and the patch's
  sha256, so the bake lane refuses a tree compiled from an older patch.
- No patch at all: ReintroductionToProofs and NumberTheoryGame compile
  unmodified: `Mathlib.Tactic.Have`, `Mathlib.Tactic.Cases` and the
  `Mathlib.Tactic` umbrella come from the toolchain release's
  `mathlib-game-extra` pack (until Lean 4.34: `wasm/compat`). A game whose
  only gap is a module of that pack needs no patch.
- Lean 4.34 (branch `lean-v4.34`, 2026-10-06): the knights, rag, robo, lag
  patches were re-cut and STG4 got its first one — `deprecated_module`
  shim imports replaced by the modules the shim imports (read from the
  release's pack manifests), Knights' `deriving Fintype` option; STG4's
  was re-cut on 2026-10-08 to add the `push_neg` wrapper RAG already had. Re-cut by
  applying the old patch to a clone at `source.rev`, editing, and writing
  the patch from `git diff <rev> -- . ':!.i18n'` with the commit message as
  its header (no commit made; the `From 0000…` line is the mbox separator
  only); each was then proven with a fresh clone + `git am` (clean, tree
  identical). The nng4 and logic patches did not change. RAG's was re-cut
  again on 2026-10-12 the same way (Lecture10 1's model solution without
  `bound`, plus a hint in its Introduction, below), from the checkout's working tree with
  `git diff <rev> -- . ':!.i18n'` (the script that rebuilt the old file
  byte-for-byte first), and proven with a fresh clone + `git am` (clean;
  tree identical to the checkout's working tree).
- Lean 4.35 (branch `lean-v4.35`, toolchain release `lean-v4.35.0-b081e7c`,
  2026-10-23): only the robo patch changed (three more `deprecated_module`
  shim imports, below), re-cut the same way from the checkout's working
  tree; the old checkout was deleted and the games lane cloned upstream,
  checked out `source.rev` and `git am`ed the new file — `git diff <rev>
  HEAD -- . ':!.i18n'` there is byte-identical to the ported working tree's
  diff. Knights' was re-cut the same day (the shared tactic syntax, below)
  and proven the same way. The nng4, stg4, rag, logic and lag patches did not change,
  and ReintroductionToProofs and NumberTheoryGame still need none. The one
  v4.35 gap three games hit — `import Batteries.Tactic.OpenPrivate`
  (NNG4's and ReintroductionToProofs' and Robo's `induction`/`cases`
  wrappers, which `open private` helpers of `Lean.Elab.Tactic.Induction`),
  a module the v4.35 packs no longer ship — is not patched per game: the
  trees lane compiles a vendored copy (`vendor/batteries/README.md`).

## nng4-wasm64-port.patch

- Upstream: `hhu-adam/NNG4` `main` @ `360d797` (Lean v4.23.0 / Mathlib
  v4.23.0). Commit `7f67c24`, 2026-09-01, also pushed as `FawadHa1der/NNG4`
  branch `wasm64-port`; this file is the copy the catalog row points at.
- Size: 266,898 bytes, 8,603 lines, 8 files — the regenerated
  `.i18n/en/Game.pot` hunk alone is 8,295 of those lines (7,396 changed
  lines); newer patches leave the template out.
- Summary: drops five vestigial imports and vendors two Mathlib v4.23.0
  tactic files, touching no proof.
  - `Game/Levels/Algorithm/L04add_algo3.lean`: `import ImportGraph` dropped;
    `Game/Levels/LessOrEqual/Level_3.lean`: `import Std.Tactic.RCases`
    dropped (`rcases` is core).
  - `Game/MyNat/PeanoAxioms.lean`: `import Mathlib.Tactic.Have` →
    `import Game.Tactic.MathlibHave`; `Game/Tactic/Cases.lean` and
    `Game/Tactic/Induction.lean`: `import Mathlib.Tactic.Cases` →
    `import Game.Tactic.MathlibCases`.
  - New `Game/Tactic/MathlibCases.lean` (`ElimApp.evalNames` and its
    `addLocalVarInfoForBinderIdent` helper, simplified to `TermElabM`; no
    `cases'`/`induction'`) and `Game/Tactic/MathlibHave.lean` (the
    goal-creating `have h : t` / `suffices` syntax the levels teach), both
    from mathlib4 v4.23.0 (Apache-2.0) — the same modules the release's
    `mathlib-game-extra` pack provides under their real names (until Lean
    4.34: `wasm/compat`); the vendored copies keep working, so the patch is
    unchanged at 4.34.
  - All 113 reachable modules compile; 9 worlds / 79 levels.
- Regenerate: `git -C games-src/NNG4 format-patch --stdout 360d797 -- .
  ':!.i18n'` — note this drops the `.pot` hunk, so the result differs from
  the shipped file (harmless: the lane regenerates the template). The
  compiled gamedata (`client/public/data/g/hhu-adam/NNG4`) is tracked in
  git, so the sources are only needed to change the game or to rebake its
  snapshot.

```bash
git clone https://github.com/hhu-adam/NNG4 games-src/NNG4
git -C games-src/NNG4 checkout 360d797
git -C games-src/NNG4 am ../../wasm/patches/nng4-wasm64-port.patch
```

## knights-wasm64-port.patch

- Upstream: `JadAbouHawili/KnightsAndKnaves-Lean4Game` `main` @
  `bd4ab6e6d00fbbfb95b17e66589c07e75bb9d56c` (Lean v4.29.1 / Mathlib
  v4.29.1). Commit `a1b6fba`, 2026-09-11.
- Size: 15,017 bytes, 348 lines, 9 files (+91/−42) (Lean 4.35 re-cut,
  2026-10-23, the shared tactic syntax below; Lean 4.34: 6,546 bytes, 143
  lines, 7 files (+12/−8); before: 4,157 bytes, 5 files).
- Summary: no level or world removed; the one thing a player can notice is
  toolchain drift, not the patch (`wasm/PORTING.md` §8) — and, since the
  Lean 4.35 re-cut, that the DSL world's own tactics work in the browser.
  - Lean 4.35 re-cut (2026-10-23): new
    `Game/LevelLemmas/knightsknaves_tactic_syntax.lean` declares the syntax
    of `knight_or_knave` (`A` / `A with h₁ h₂`), `knight_interp` and
    `knave_interp` (bare / `at h` / `at *`) once, with docstrings;
    `Game/LevelLemmas/dsl_KnightsAndKnaves.lean` and
    `settheory_knightsknavesfoundation.lean` import it and turn their
    `macro "…" … : tactic => …` declarations into `macro_rules` with the
    same expansions. Upstream each world declared the syntax with its own
    `macro`, harmless there because a level imports only its own world;
    the browser checks every level in the whole-`Game` environment, where
    the parser returned both syntaxes and Lean ran only the first (a
    choice falls through only on unsupported syntax): 13 DSL levels (1,
    3–14) failed with their model proofs, on the live 4.34 site too. With
    one syntax per tactic, Lean tries the expansions in turn and keeps the
    first that succeeds (as for both worlds' `contradiction` extensions).
    The compile's 8 "missing tactic documentation" warnings for these
    tactics are gone (the syntax has docstrings); the gamedata is
    byte-identical.
  - Lean 4.34: `Game/LevelLemmas/settheory_KnightsAndKnaves.lean` and
    `settheory_KnightsAndKnaves3.lean` put `set_option
    backward.isDefEq.respectTransparency false in` before their `inductive
    Inhabitant`/`Inhabitant' … deriving DecidableEq, Fintype` (the derived
    Fintype instance's `rewrite` fails under the stricter defeq check;
    Mathlib does the same at its call sites); `Game/MathlibTheorems.lean`
    imports `Mathlib.Basic.Real.Basic`, the module the
    `Mathlib.Data.Real.Basic` shim re-exports.
  - `Game.lean`: `Languages "English"` → `Languages "en"` (the client's
    language table has no "English" entry).
  - `Game/MathlibTheorems.lean`: `import Mathlib.Tactic.Polyrith` commented
    out — not in the essential pack, `polyrith` shells out to an external
    Sage oracle, and no level, hint or doc mentions it (at Lean 4.34 the
    extra pack has it; the drop stays). `Mathlib.Tactic.Have` comes from the
    `mathlib-game-extra` pack.
  - `Game/LevelLemmas/settheory.lean`,
    `settheory_knightsknavesfoundation.lean`: the `[DecidableEq _]` binder
    moved from its own column-0 line onto the `variable` line — the newer
    parser ends a command at a column-0 token, which orphaned the binder
    ("unexpected token '['") and made every `Finset` `∩` / `{A,B}` in those
    files fail to find its instance. Same declarations, same statements.
  - `Game/Levels/SetTheory_Knights_Knaves/L09_same.lean`: the model proof's
    `simp at diff` replaced by a comment — on this Mathlib `diff : ¬(A ∉
    Knave ↔ C ∉ Knave)` is already simp-normal ("simp made no progress");
    the following `rw [not_iff] at diff` and `knight_interp at diff` reach
    the same `diff : A ∈ Knight ↔ C ∉ Knight`. Hints and statement untouched.
- Regenerate: `git -C games-src/KnightsAndKnaves-Lean4Game format-patch
  --stdout bd4ab6e6d00fbbfb95b17e66589c07e75bb9d56c -- . ':!.i18n'`. (The
  Lean 4.35 re-cut was written without a commit: `git diff
  bd4ab6e6d00fbbfb95b17e66589c07e75bb9d56c -- . ':!.i18n'` of the working
  tree plus `git diff --no-index /dev/null` of the new file, under the old
  header with one more paragraph; the lane then cloned upstream and `git
  am`ed it — clean, and the clone's files equal the working tree's.)

```bash
git clone https://github.com/JadAbouHawili/KnightsAndKnaves-Lean4Game games-src/KnightsAndKnaves-Lean4Game
git -C games-src/KnightsAndKnaves-Lean4Game checkout bd4ab6e6d00fbbfb95b17e66589c07e75bb9d56c
git -C games-src/KnightsAndKnaves-Lean4Game am ../../wasm/patches/knights-wasm64-port.patch
```

## rag-wasm64-port.patch

- Upstream: `AlexKontorovich/RealAnalysisGame` `main` @
  `930c38333b2edcc3ad27c5f68b9f09210cfaaf62` (Lean v4.26.0 / Mathlib
  v4.26.0). Commit `65e8037`, 2026-09-11 (amended after review to
  de-indent 13 doc comments; the file was regenerated from the amended
  commit).
- Size: 222,135 bytes, 5,792 lines, 116 files — 110 of them are
  whitespace-only re-indentation; six files change content (2026-10-12
  re-cut; Lean 4.34 re-cut: 220,594 bytes; before: 219,562 bytes).
- Summary: no level or world removed; Lecture10 1's model solution and
  introduction change (below), otherwise nothing a player types or reads
  changes.
  - Lean 4.34: `Game/Metadata.lean` imports `Mathlib.Basic.Real.Basic`, the
    module the `Mathlib.Data.Real.Basic` shim re-exports.
  - `Game/Metadata.lean`: `import Mathlib.Analysis.SpecialFunctions.Log.Base`
    (absent from the essential pack, as is its dependency `Data.Int.Log`; no
    level uses `Real.logb`) replaced by that module's two in-pack imports
    (`Analysis.SpecialFunctions.Pow.Real`, `Algebra.BigOperators.Field`)
    plus `Mathlib.Tactic.Bound` (the taught `bound` tactic, previously
    reached transitively); imports the new `PushNeg` file. A vendored
    `Log.Base` was tried and dropped: compiling it on this fork hits an
    IR-interpreter assertion.
  - `Game/CustomTactic/Linarith.lean`: `elabLinarithConfig` is now ambiguous
    with core Lean's grind-based one; the game's wrapper names
    `Mathlib.Tactic.elabLinarithConfig`.
  - `Game/CustomTactic/PushNeg.lean` (new, imported by `Metadata`): Mathlib
    `de3a9cf` logs an unconditional deprecation warning on every `push_neg`
    (it is `push Not` now); the file is the macro Mathlib's own message
    recommends, at `priority := high`, so players using the taught
    `push_neg` do not finish levels "with warnings".
  - 112 level files: the tactic block of every column-0 `:= by` proof is
    indented by two spaces (2,088 lines; whitespace only — string literals
    and the `/-- … -/` doc comments that feed TheoremDoc/DefinitionDoc are
    untouched, verified line by line, so the emitted doc JSON and the `.pot`
    msgids match upstream). This Lean rejects a column-0 tactic block as
    soon as a term-ending tactic (`use 1`, `have h := …`, `refine …`) is
    followed by another tactic; upstream writes 81 Statement proofs that
    way.
  - `Game/Levels/L4Levels/L01_NonConverge.lean`: a local `@[simp]` lemma
    `(-1 : ℝ) ^ (2 * n + 1) = -1` so the level's own `bound` step (and the
    hint recommending `bound` for "exponent simplifications") still closes;
    `bound` on this Mathlib proves the even case but not the odd one.
  - `Game/Levels/L22Levels/L03.lean`: `attribute [grind]
    Mathlib.Tactic.Zify.natCast_le._simp_1` commented out — the constant no
    longer exists; no reachable level calls `grind`.
  - `Game/Levels/L10Levels/L06_Prod.lean` (Lecture10 1, "Big Boss : Product
    of Sequences", 2026-10-12): the model solution no longer calls `bound`.
    Mathlib's Aesop-based `bound` runs interpreted in the browser and needs
    ~520–620 KiB of engine stack on this level, more than a macOS Chrome
    Worker's ~500 KiB, so the level failed with "the WebAssembly runtime's
    stack is exhausted". The runtime is not changed (user decision,
    2026-10-12). The six `bound` steps are replaced with steps the level
    already unlocks:
    - `field_simp; linarith [hε]` for `0 < ε / (2 * K)` and
      `0 < ε / (2 * |L|)`, with `Kpos` moved up;
    - `linarith [hn]` for `N1 ≤ n` and `N2 ≤ n` (the game's `linarith`
      uses only the facts it is given);
    - a `by_cases h0 : a n - L = 0` block for
      `|a n - L| * |b n| ≤ |a n - L| * K`;
    - `field_simp at hN1 hN2`, so the final `linarith` needs no division.
      `f5`, `f6`, `f8`, `f9` and `bnBnd` are dropped.

    No new tactic or theorem is used. Players never see the model solution,
    and the level had no hint, so the Introduction gains one `**Hint:**`
    paragraph after its Strategy list: it names these steps (the `by_cases`
    inside one `have … := by …; …` line) and says why to avoid `bound` here.
    The statement and the inventory are unchanged, and `bound` stays
    unlocked (a `DisabledTactic bound` for this level would change the
    inventory; not done). The native `Runner` check (difficulty 0, 1 and 2,
    and the one-line `f4`) closes with no message. Under the browser-stack
    harness (0.68 MB pthread stack, fresh import), the new proof is clean
    where the old one fails its `bound` steps; the margin is about
    0.01–0.02 MB. Fresh clone at `930c383` + `git am`: tree `2d3feeef7a58`.
    The other levels that use `bound` are unchanged.
  - Needs the full `Mathlib.Tactic.Cases` (`cases'` / `induction'` are
    taught): in the `mathlib-game-extra` pack (until Lean 4.34:
    `wasm/compat`). The extra pack also has `Log.Base` now; the smaller
    closure above is kept. Upstream tracks an old `de` translation
    (`.i18n/de/Game.json`, 16 template strings) and no `en` template;
    `Languages "en"`.
- Regenerate: `git -C games-src/RealAnalysisGame format-patch --stdout
  930c38333b2edcc3ad27c5f68b9f09210cfaaf62 -- . ':!.i18n'`. Should the
  indentation ever be redone, keep the sweep out of doc comments (the
  first pass indented 13 of them, which changed two doc JSONs).

```bash
git clone https://github.com/AlexKontorovich/RealAnalysisGame games-src/RealAnalysisGame
git -C games-src/RealAnalysisGame checkout 930c38333b2edcc3ad27c5f68b9f09210cfaaf62
git -C games-src/RealAnalysisGame am ../../wasm/patches/rag-wasm64-port.patch
```

## robo-wasm64-port.patch

- Upstream: `hhu-adam/Robo` `main` @ `5d335ce54e9aec50f55ab7e1e24a7a1a79bee188`
  (Lean v4.31.0 / Mathlib v4.31.0; 18 worlds / 156 levels, key-style
  translations `de en es zh`). Commit `4d62ff2`, 2026-09-11.
- Size: 3,222 bytes, 68 lines, 2 files (+6/−5) (Lean 4.35 re-cut; Lean 4.34: 2,159
  bytes, 53 lines, +3/−2; before: 1,172 bytes, 1 file).
- Summary: five import lines in two files (one dropped, four replaced). `Game/Metadata.lean` drops `import Batteries`, the
  Batteries umbrella module the release's packs do not ship (the Batteries
  modules reach the game through `Mathlib.Tactic.Common`, imported by
  `Game/Metadata/FromMathlib.lean`); Lean 4.34: `Game/Metadata/FromMathlib.lean`
  imports `Mathlib.Basic.Real.Basic`, the module the `Mathlib.Data.Real.Basic`
  shim re-exports; Lean 4.35: the same file imports
  `Mathlib.Order.SuccPred.Int`, `Mathlib.Algebra.Order.Star.Int` and
  `Mathlib.Algebra.Order.Star.Rat` instead of the `Mathlib.Data.Int.SuccPred`,
  `Mathlib.Data.Int.Star` and `Mathlib.Data.Rat.Star` shims (each is exactly
  `public import` of its replacement; the compile printed one deprecation
  warning per shim, now none). No level, proof, doc or tactic file changes: every other
  gap (`Mathlib.Tactic.{Have,Cases,Generalize}`,
  `Mathlib.Algebra.Order.Ring.Star`, `Mathlib.Algebra.Order.Star.{Int,Rat}`) is a
  `mathlib-game-extra` module under its real name (until Lean 4.34: a
  `wasm/compat` module — the four Robo leaves were added for this port), so
  the game's custom tactic layer (`Game/Metadata/Tactic/*`) compiles from
  upstream source unchanged.
- Regenerate: `git -C games-src/Robo format-patch --stdout
  5d335ce54e9aec50f55ab7e1e24a7a1a79bee188 -- . ':!.i18n'`.

```bash
git clone https://github.com/hhu-adam/Robo games-src/Robo
git -C games-src/Robo checkout 5d335ce54e9aec50f55ab7e1e24a7a1a79bee188
git -C games-src/Robo am ../../wasm/patches/robo-wasm64-port.patch
```

## logic-wasm64-port.patch

- Upstream: `Trequetrum/lean4game-logic` `main` @
  `40ceec5f3ca5dce6cec2800b8f5e4927631ca2da` ("A Lean Intro to Logic", Lean
  v4.7.0 / Mathlib v4.7.0 — the oldest game in the catalog). Commit
  `2d147cd`, 2026-09-11.
- Size: 2,481 bytes, 61 lines, 2 files (+2/−2).
- Summary: two one-line source changes; no level or world removed; nothing a
  player types changes.
  - `Game.lean`: `Languages "English"` → `Languages "en"`.
  - `Game/Levels/OrIntro/L02.lean`: `Statement (O S : Prop)(s : S) : K ∨ S`
    → `Statement (K O S : Prop)(s : S) : K ∨ S`. Under v4.7.0 the `K` of the
    goal was an auto-bound implicit; this GameServer's `Statement` no longer
    auto-binds signature identifiers ("Unknown identifier `K`"). Auto-bound
    implicits were placed first, so the player's object list `K O S : Prop`
    is unchanged; the editor-mode `example …` header now shows the binder.
  - Everything else the v4.7.0-era game needs comes from the release's
    packs: `Game/Metadata.lean`'s `import Mathlib.Tactic` resolves to the
    `mathlib-game-extra` umbrella (until Lean 4.34: the `wasm/compat` one;
    the patch's own message still says so), so the import is untouched. The game's Doc/Metadata layer
    (custom `GameLogic` namespace, `TacticDoc` / `TheoremDoc` /
    `DefinitionDoc`) compiles unchanged. Upstream ships no translations.
- Regenerate: `git -C games-src/lean4game-logic format-patch --stdout
  40ceec5f3ca5dce6cec2800b8f5e4927631ca2da -- . ':!.i18n'` (byte-identical
  to the shipped file when last checked).

```bash
git clone https://github.com/Trequetrum/lean4game-logic games-src/lean4game-logic
git -C games-src/lean4game-logic checkout 40ceec5f3ca5dce6cec2800b8f5e4927631ca2da
git -C games-src/lean4game-logic am ../../wasm/patches/logic-wasm64-port.patch
```

## lag-wasm64-port.patch

- Upstream: `ZRTMRH/LinearAlgebraGame` `main` @
  `03b894b227cc969de55de2d155f7308d83b3c3f5` (Lean v4.21.0 / Mathlib
  v4.21.0; 5 worlds / 43 levels). Commit `ddb4b8f`, 2026-09-11. The
  analysis behind it: `wasm/LINEAR-ALGEBRA-GAME.md`.
- Size: 18,335 bytes, 367 lines, 9 files (+86/−42) (Lean 4.34 re-cut;
  before: 17,487 bytes).
- Summary: import surgery, three Mathlib renames, and one level whose
  required input grew by a `ring`; no level or world removed.
  - Lean 4.34: `Game/Data.lean` and `InnerProductWorld/LemmasAndDefs.lean`
    import `Mathlib.Basic.Real.Basic` / `Mathlib.Basic.Complex.Basic`, the
    modules the `Mathlib.Data.{Real,Complex}.Basic` shims re-export (the
    `Data.Complex.Basic` line in `Game/Data.lean` sits inside upstream's own
    block comment and is untouched). `import Mathlib.Tactic.NormNum.Prime`
    is back in the environment without a patch line: the Tutorial levels'
    `import Mathlib.Tactic` is now the real umbrella (`mathlib-game-extra`),
    which imports it (the compat umbrella lacked it; upstream's own
    `MyTactic.lean` keeps it inside a block comment). Of the 22 imports the
    patch comments out as "not in the essential pack", `Data.Opposite` and
    `Data.PNat.Prime` are real modules of the extra pack at 4.34 and
    `Data.Matrix.{DualNumber,Invertible}`, `Data.Real.Archimedean` are
    shims; none is restored (no level uses them).
  - Imports — `Game/Data.lean`: 22 `Mathlib.Data.*` imports not in the pack
    commented out (`Finmap`, nine `Matrix.*`, four `Num.*`, `Opposite`, five
    `PNat.*`, `Real.{Archimedean,Sign}`; none used by any level);
    `Data.Matrix.{Kronecker,Notation,RowCol}` → `LinearAlgebra.Matrix.*`,
    `Data.Real.{Cardinality,Sqrt}` → `Analysis.Real.*` (Mathlib moves);
    `Mathlib.LinearAlgebra.Basis.VectorSpace` added so the root `VectorSpace`
    namespace every level's `open VectorSpace` needs stays in the closure.
    `Game/Levels/InnerProductWorld/LemmasAndDefs.lean`: drop
    `Mathlib.Analysis.Complex.AbsMax` (245-module closure outside the pack;
    `Complex.abs` only in comments), `Data.Real.Sqrt` → `Analysis.Real.Sqrt`
    (the former is a `deprecated_module` shim).
  - `Game.lean`: `Languages "English"` → `Languages "en"`; `Dependency
    TutorialWorld → VectorSpaceWorld` moved here from
    `Game/Levels/VectorSpaceWorld.lean` (which never imports TutorialWorld;
    the current GameServer rejects a source world not in scope). Same graph.
  - Mathlib drift, taught names kept — `Game/Levels/VectorSpaceWorld/Level01.lean`:
    inventory entry `MulAction.mul_smul` → `SemigroupAction.mul_smul`
    (players type `mul_smul`, which still resolves);
    `LinearIndependenceSpanWorld/Level08.lean`: `alias
    _root_.Finset.sum_eq_sum_diff_singleton_add :=
    Finset.sum_eq_sum_sdiff_singleton_add` (the additive name was removed
    upstream); `InnerProductWorld/Level03.lean`: `alias _root_.sq_eq_sq :=
    sq_eq_sq₀`. Identical statements.
  - Proof drift (`field_simp` rewrite, unused simp args) —
    `InnerProductWorld/Level06.lean`: the taught `field_simp [h_nonzero]` now
    leaves `⟪u,v⟫ * (1 - 1) = 0`; the level closes with one more `ring`
    (visible and hidden hints added — the only player-input change);
    `Level07.lean`: helper `norm_sq_scaled_eq` loses a redundant `ring`, the
    Cauchy–Schwarz proof and its hidden hint use `simp [v_norm_zero] at
    h_mul` (the old form still completes); `LemmasAndDefs.lean`: `ring` after
    `field_simp` in `ortho_decom_parts`, two unused simp-argument lists
    trimmed in helper proofs.
  - Needs the `Mathlib.Tactic` umbrella (`Game/Metadata.lean`) and `Have` /
    `Cases` (`Game/MyTactic.lean`) from the `mathlib-game-extra` pack. The catalog row adds `linter.all=false`
    to the lakefile's options (`wasm/PORTING.md` §2).
- Regenerate: `git -C games-src/LinearAlgebraGame format-patch --stdout
  03b894b227cc969de55de2d155f7308d83b3c3f5 -- . ':!.i18n'` (byte-identical
  to the shipped file when last checked).

```bash
git clone https://github.com/ZRTMRH/LinearAlgebraGame games-src/LinearAlgebraGame
git -C games-src/LinearAlgebraGame checkout 03b894b227cc969de55de2d155f7308d83b3c3f5
git -C games-src/LinearAlgebraGame am ../../wasm/patches/lag-wasm64-port.patch
```

## stg4-wasm64-port.patch

- Upstream: `djvelleman/STG4` `main` @
  `b7296fcb2f06aa30d396422675c86a5b03b662f9` (Lean v4.23.0 / Mathlib
  v4.23.0). First patch: Lean 4.34, 2026-10-06 (the game compiled unpatched
  on 4.33.0-pre); re-cut 2026-10-08 with the `push_neg` wrapper.
- Size: 3,438 bytes, 77 lines, 2 files (+24/−1).
- Summary:
  - `Game/Metadata.lean`'s `import Mathlib.Data.Set.Lattice` — a
    `deprecated_module` shim at Mathlib `v4.34.0`, which warns when
    `Game/Metadata.lean` is compiled (Lean checks only the importing
    module's own header; the levels importing the metadata do not repeat
    it) — becomes the five modules the shim re-exports,
    `Mathlib.Data.Set.Lattice.{Bounded,Disjoint,Image,Indexed,Order}` (its
    imports in the essential pack's manifest). Same environment.
  - `Game/CustomTactic/PushNeg.lean` (new, imported by `Metadata`): RAG's
    wrapper, `macro (priority := high) "push_neg" cfg loc => push cfg Not
    loc`. Mathlib `v4.34.0`'s own `push_neg` logs "`push_neg` has been
    deprecated. Prefer using `push Not` instead." on every use, and any
    warning makes `completed` false (`server/GameServer/RpcHandlers.lean`),
    so every level solved with it — Complement 4 teaches it (`NewTactic
    apply push_neg`, its hint says `push_neg at h1`), Combo 1 and FamCombo
    1, 2, 5, 7 use it — finished "with warnings 🎭" and was never marked
    completed. Behaviour is identical; the inventory's locked-tactic check
    is atom-based and still sees `push_neg`. The catalog's `probe3`
    (Complement 4's own solution) must close with no message natively.
  - No level, proof or doc changes. `Mathlib.Tactic.Have` comes from the
    `mathlib-game-extra` pack.

```bash
git clone https://github.com/djvelleman/STG4 games-src/STG4
git -C games-src/STG4 checkout b7296fcb2f06aa30d396422675c86a5b03b662f9
git -C games-src/STG4 am ../../wasm/patches/stg4-wasm64-port.patch
```
