# Porting a game to the wasm64 build

How a game from adam.math.hhu.de's catalog becomes a row in
`wasm/catalog.json` that the lanes build, the staging script serves and the
browser boots. The catalog is the only place a game is named; everything
else reads it through `scripts/games-manifest.mjs` (`--check`, `--list`,
`--api`, `--probe <snapshot>`, `--required-files`, `--langs`). Deployment
steps live in `wasm/DEPLOY.md` ("Adding a game"); this file is the port
itself: the recipe (§1–§7, with the lessons of the nine ports folded in) and
one record per ported game (§8). Worked examples of each shape: STG4 (no
patch, one compat import), NumberTheoryGame (no patch, the compat umbrella),
KnightsAndKnaves (a small patch), RealAnalysisGame (the largest patch),
LinearAlgebraGame (import surgery plus proof drift).

What we cannot change: the Lean fork (4.33.0-pre, `wasm/KERNEL-PIN`) and the
Mathlib olean pack (`mathlib-essential`, an input from qed64 — Mathlib
`de3a9cf`, 2254 Mathlib modules, the import closure of a fixed root set; list
it with `ls -R wasm/out/trees/lib-tree/Mathlib` after the trees lane, or
from the pack manifest). Every game was written for its own toolchain
(v4.7 … v4.31) and a full Mathlib; the port is the distance between that and
our pin.

## 1. Survey before touching anything

One GitHub pass per candidate gives toolchain, Mathlib rev, GameServer rev,
size and level count (`gh api repos/<owner>/<repo>` + raw `lean-toolchain`
and `lake-manifest.json`). Then a sparse clone of `Game/` + `Game.lean` and
the reachability check that decides feasibility:

1. Walk imports from `Game.lean` (regex `^\s*import\s+([\w.']+)` after
   stripping `/- … -/`; note the `'` — RealAnalysisGame has modules named
   `L04_Cases'`), resolving `Game.*` modules to files; everything unresolved
   is external. Files on disk that nothing imports are not part of the game
   (every port found some: STG4 `DemoWorld`, Reintro
   `EquivalenceWorld/L08_UnusedBossLevel`, Knights
   `EquationalReasoning/L04_mul_left_cancel`, LAG `DemoWorld`,
   `InnerProductWorld/Code.lean`, `Game/MyTactic 2.lean`).
2. Split the external Mathlib modules into present-in-pack vs missing
   (compare against the pack module list).
3. Classify each missing module:
   - **pack-excluded leaf that exists upstream** (`Mathlib.Tactic.Have`,
     `.Cases`, `.Generalize`, `Algebra.Order.Ring.Star`, `Data.Int.Star`,
     `Data.Rat.Star` today): provided by `wasm/compat` — no game edit; a new
     leaf is added the same way (§4);
   - **the `Mathlib.Tactic` umbrella** (NumberTheoryGame, lean4game-logic,
     LinearAlgebraGame): provided by `wasm/compat/Mathlib/Tactic.lean`, an
     import list of the 244 `Mathlib.Tactic.*` leaves the pack has plus the
     compat `Have`/`Cases` — no game edit. The umbrella lacks 110 of
     upstream's 356 leaves (`Polyrith`, `ModCases`, `Ext`, `Change`,
     `Replace`, `NormNum.Prime`, …): a player typing one of those tactics
     gets "unknown tactic" where upstream would parse it. Check that no
     level, hint or doc teaches one (none of the three games does);
   - **a real Mathlib module absent from the pack**: first find out whether
     any level *uses* it. Three ports dropped such imports without loss
     because only comments or nothing referenced them: LAG's
     `Analysis.Complex.AbsMax` (245-module closure, `Complex.abs` only in
     comments), LAG's `Game/Data.lean` (22 unused `Data.*` imports), RAG's
     `Analysis.SpecialFunctions.Log.Base` (replaced by its two in-pack
     imports). Only when a lemma the levels use lives there is the game
     blocked until the pack's root set grows (a qed64 input, not ours).
     Vendoring the module into `wasm/compat` is an option only if it
     compiles on the fork — RAG's `Log.Base` and the `module`-form
     `Data.Rat.Star` hit an IR-interpreter assertion
     (`ir_interpreter.cpp:928 fn_body_kind::Unreachable`);
   - **renamed or shimmed modules**: follow the move (`Data.Matrix.* →
     LinearAlgebra.Matrix.*`, `Data.Real.{Cardinality,Sqrt} →
     Analysis.Real.*`; a `deprecated_module` shim such as `Data.Real.Sqrt`
     would warn in every level that imports it);
   - **custom tactic layers** (`elab`/`macro_rules`/`TacticM` in non-level
     files): compile and see; syntax drift since the game's toolchain is
     the usual failure (Knights' column-0 binder, RAG's `elabLinarithConfig`
     clash — §3).
4. Count non-level files, `set_option` lines, `Languages`, images size and
   the first world/level (for the probe).

A closure of hundreds of missing modules is a reason to read the import
lines, not to stop: `wasm/LINEAR-ALGEBRA-GAME.md` is the analysis that turned
LinearAlgebraGame's "297 missing" into 0 with a 40-line import patch.

## 2. The catalog row

```json
{ "owner": "djvelleman", "game": "STG4", "listed": true, "snapshot": "stg4",
  "src": "games-src/STG4",
  "source": { "url": "https://github.com/djvelleman/STG4", "rev": "<full sha>", "patch": null },
  "leanOptions": ["linter.all=false", "tactic.hygienic=false"],
  "probe": { "world": "Subset", "level": 1, "proof": "exact h" },
  "probe2": { "world": "…", "level": 5, "proof": "…", "teaches": "…" },
  "expectedRaw": null }
```

- `owner`/`game`: as served (`/#/g/<owner>/<game>`, case-sensitive static
  paths). `snapshot`: `^[a-z0-9_-]+$`, unique — it names
  `/snapshots/<snapshot>.<digest>.snapz` and the bake/probe/tree.
- `listed: false` keeps a game reachable by URL but off the landing page
  (TestGame).
- `src`: the checkout (`games-src/` is gitignored). `source.rev` is the
  full commit (NNG4's row still carries the short `360d797`);
  `source.patch` is the port patch or `null`.
- `leanOptions`: the game's `lakefile.lean` `package Game where leanOptions
  := #[…]` **plus `linter.all=false` whenever the lakefile lacks it**
  (LinearAlgebraGame: without it 625 warnings, among them 590 "tactic does
  nothing" notices on `Hint` lines, two deprecated lemma names players type
  and two `Try this` suggestions). They become `-D` flags when the game
  compiles, and `Statement` captures the level's scope (options included,
  `server/GameServer/Commands.lean` ~471/489) which `Runner` replays with
  `withScope` (`Runner.lean` ~113-117), so deprecation and other
  tactic-level linter warnings are suppressed at play time too. Two things
  `linter.all=false` does not cover: an unconditional `logWarning` (Mathlib
  `de3a9cf`'s `push_neg` deprecation — RAG wraps the tactic, §3) and
  command-level linters, which run with the play-time document's own scope
  — the wasm worker document (`client/src/wasm/game-translation.ts`
  ~243-245) carries no options, so LAG Tutorial 5 still shows `Try this:
  intro h1 h2 h3` (the level completes; a client-side fix would apply to
  every game). Ignore `moreLeanArgs`/`moreServerOptions` (`trace.debug`
  toggles; `linter.unusedVariables.funArgs` is inert under
  `linter.all=false` — lean4game-logic's row carries it, Robo's does not,
  neither matters).
- `expectedRaw`: `null` until the first bake, then `{runtime, bytes}` as
  printed; keyed to the runtime (a runtime bump clears it).
- `probe`: see §5. `probe2` (optional): a second, mid-game level whose proof
  exercises a tactic the game teaches, with `teaches` naming it and where it
  is introduced; the lanes run `probe` only, `probe2` is the reviewers'
  second `Runner` check and documents which taught machinery was exercised.

`node scripts/games-manifest.mjs --check` must exit 0 (it also warns about
non-ISO `Languages`, §6).

## 3. Source pin and patch shape

```bash
git clone <source.url> games-src/<Game>
git -C games-src/<Game> checkout <source.rev>
git -C games-src/<Game> am ../../wasm/patches/<snapshot>-wasm64-port.patch   # only if source.patch is set
```

The games lane does the same when `src` is absent. Rules for the patch:

- **One commit, source files only, no `.pot`.** The i18n template
  `.i18n/<source lang>/Game.pot` is rewritten on *every* compile
  (`potCreationDate` stamp, reordered msgids — measured on STG4: 3076+/3032−
  lines for one compile), so a patch carrying it never applies twice. The
  lane restores the template after compiling (`git checkout -- .i18n`),
  which is what keeps the tree clean for the next `git am`. Format it with
  `git -C games-src/<Game> format-patch --stdout <source.rev> -- . ':!.i18n'
  > wasm/patches/<snapshot>-wasm64-port.patch`; before reading `git status`
  after a compile, run `git checkout -- '.i18n/*/*.pot'`. (NNG4's patch
  predates this rule and carries the `.pot`; it applies to a fresh clone,
  which is all the lane needs.)
- **Never add an import to `Game.lean` or a world file.** The served game
  is exactly what `Game.lean` imports: `MakeGame` merges worlds from the
  imported level files (`server/GameServer/EnvExtensions.lean` ~447-449,
  `World.merge`/`Game.merge`), so a file that exists on disk but is not
  imported is not a level (STG4's `DemoWorld.lean`: on disk, not served —
  8 worlds / 51 levels, not the 9 / 52 a file count suggests). Adding an
  import would publish a world upstream chose not to; removing one would
  remove a world (never do that either).
- Prefer dropping an import over rewriting a level: NNG4's patch drops five
  vestigial imports and touches no proof; Knights drops `Polyrith`; Robo
  drops the `Batteries` umbrella; LAG drops 22 unused `Data.*` imports.
- Vendoring a tactic file into `Game/Tactic/` is the fallback when compat
  (§4) cannot host it; document the origin and licence in the commit.
- Record in `wasm/patches/README.md` what the patch does and why, and in §8
  here every player-visible consequence.

Drift you will meet between the games' toolchains and 4.33.0-pre, with the
port that hit it:

- **Column-0 `:= by` blocks** (RAG, 112 files). This Lean rejects a
  column-0 tactic block as soon as a term-ending tactic (`use 1`, `have h :=
  …`, `refine …`) is followed by another tactic ("expected command"). Indent
  the block by two spaces — whitespace only, verified line by line, and
  keep the sweep away from `/-- … -/` doc comments: RAG's first sweep
  indented 13 TheoremDoc/DefinitionDoc docstrings, which changed two emitted
  doc JSONs and their `.pot` msgids until they were de-indented.
- **A column-0 token ends the previous command** (Knights): a
  `[DecidableEq K]` binder on its own line after `variable {K : Type}` was
  silently orphaned ("unexpected token '['") and every `Finset` `∩`/`{A,B}`
  in the file lost its instance. Put the binder on the `variable` line.
- **Auto-bound implicits are no longer bound by `Statement`**
  (lean4game-logic): `Statement (O S : Prop)(s : S) : K ∨ S` worked under
  v4.7.0 with `K` auto-bound; now "Unknown identifier `K`". Bind it
  explicitly, first, so the player's object list is unchanged — the
  editor-mode `example …` header does change (it now shows the binder).
- **`Dependency A → B` needs world `A` in the file's environment** (LAG):
  `VectorSpaceWorld.lean` declared `Dependency TutorialWorld →
  VectorSpaceWorld` without importing `TutorialWorld`; the current GameServer
  `logErrorAt`s an unknown source world (`Commands.lean` ~538-540). Move the
  line to `Game.lean`, where every world is in scope; the edge graph is
  identical.
- **`Languages` must be ISO codes** (Knights, lean4game-logic, LAG all had
  `Languages "English"`): §6.
- **A deprecated tactic that logs unconditionally** (RAG's taught
  `push_neg`, `push Not` at `de3a9cf`): every use would finish the level
  "with warnings". Add the wrapper macro Mathlib's own message recommends
  (`macro (priority := high) "push_neg" cfg loc => push cfg Not loc`,
  `Game/CustomTactic/PushNeg.lean`); the inventory's locked-tactic check
  still works because it is atom-based.
- **A renamed or removed lemma that players type or that the inventory
  names** (LAG): keep the taught name as an `alias` of the identical
  statement (`alias _root_.sq_eq_sq := sq_eq_sq₀`,
  `alias _root_.Finset.sum_eq_sum_diff_singleton_add :=
  Finset.sum_eq_sum_sdiff_singleton_add`) and repoint inventory entries whose
  constant moved (`MulAction.mul_smul → SemigroupAction.mul_smul`; players
  still type `mul_smul`). A merely *deprecated* name players type
  (`Set.subset_diff_singleton`, LAG LIS 9) needs nothing beyond
  `linter.all=false`.
- **A name core Lean grew** (RAG's `elabLinarithConfig`, now also
  `Lean.Elab.Tactic.elabLinarithConfig` for grind): qualify it.
- **Proof drift** (`field_simp` was rewritten; `simp` sets moved): fix the
  model proof with the smallest extra step, add a visible and a hidden
  `Hint` for it, and record it as player-visible (LAG InnerProduct 6 needs
  an extra `ring`; Knights SetTheory 9 loses a `simp at diff` that now makes
  no progress). A `bound`/`norm_num` regression can be met with a local
  `@[simp]` lemma (RAG L4 L01), knowing later levels see it too.
- **`Statement` names that clash with Mathlib** (`Statement dvd_refl …`):
  GameServer warns "Environment already contains X" and the inventory shows
  Mathlib's statement from the next level on — identical upstream (NTG: 6,
  Robo: 16). Leave them.

## 4. The compat package

`wasm/compat/**/*.lean` are Mathlib modules the essential pack excludes,
compiled once under their **real module names** into the game base tree
(`wasm/out/trees/lib-tree-gamebase`) by the `compat` lane of
`wasm/build-from-source.sh` (also run at the end of `trees`), so a game's
unmodified `import Mathlib.Tactic.Have` resolves. Seven modules today
(`wasm/compat/README.md` has the table): `Mathlib.Tactic.Have` (v4.23.0
file), `Mathlib.Tactic.Cases` (the **full** `de3a9cf` file, `cases'` and
`induction'` included — RAG, NTG and LAG teach them), `Mathlib.Tactic.
Generalize` and the three `*.Star` leaves (Robo), and the `Mathlib.Tactic`
umbrella (NTG, lean4game-logic, LAG).

Rules the ports established:

- **Search path.** Lean resolves a module in the *first* `LEAN_PATH` entry
  that contains its root directory (`Mathlib/`). The compat oleans must
  therefore sit beside the pack's Mathlib oleans inside
  `lib-tree-gamebase`, never in a later `LEAN_PATH` entry: an earlier lane
  attempt that listed the pack's `lib-tree` first failed on the umbrella
  with "object file `lib-tree/Mathlib/Tactic/Have.olean` of module
  Mathlib.Tactic.Have does not exist" (`wasm/out/logs/compat.log`); the lane
  now compiles with the game base tree as the single `LEAN_PATH` entry and
  writes into it. Per-game overlays built by the port agents
  (`wasm/out/port-<x>/gamebase`) are copies of the game base tree with the
  compat oleans rsynced in.
- **The umbrella pattern.** `import Mathlib.Tactic` cannot be satisfied by
  the pack (it lacks the umbrella and 112 of its 356 leaves). Instead of
  patching three games to enumerate their tactic imports,
  `wasm/compat/Mathlib/Tactic.lean` is an imports-only file listing the 244
  in-pack `Mathlib.Tactic.*` leaves plus compat `Have` and `Cases`, so it
  must compile *after* those two (the lane compiles all compat roots into
  the same tree, which orders them). Every level of a game that imports the
  umbrella loads all 244 modules: NTG's per-module compile needs > 3 GB RSS.
- **Fat tree.** The compat lane compiles against the fat `lib-tree` (every
  `*.olean.private` present): the `module`-form `Cases.lean` has `import all
  Lean.Elab.Tactic.Induction`. Slim per-game trees are fine afterwards —
  play time never re-imports.
- **Classic form when the fork rejects the module form.** `Data.Rat.Star`
  keeps its declarations but drops `module`/`public import`/`public section`
  (the module form aborts the IR interpreter); a classic module exports a
  superset, nothing a game sees differs.
- **Shadow rule.** A compat module may exist only while the pack does not
  provide it; the lane checks every root against `lib-tree` and refuses to
  run otherwise. The lane auto-discovers every `.lean` under `wasm/compat`
  (`find`), so adding a leaf is: copy the pinned source, add the provenance
  comment, run `--lanes compat`, update the README table.

## 5. Choosing the probe

The probe is one level and one proof, used twice: the bake lane's
`snapshot-probe` (`--probe <snapshot>` prints
`import Game\nimport GameServer.Runner\nRunner "<game.json name>" "<world>" <level> (difficulty := 1) (inventory := []) := by\n<proof>`)
and the browser smoke (`qed64/work/games-smoke.mjs`), which clears the
level's stored progress, opens
`/#/g/<owner>/<game>/world/<world>/level/<level>`, types the proof and
expects the game's own verdict — the level's `completed` flag in
`game_progress`, which `DualEditorMain` sets in both editor modes only when
the proof closed without warnings (the `.level-completed` "🎉" text exists
only in editor mode; the typewriter shows the Next button instead).

- `world` must be one `Game.lean` imports and `level` must exist
  (`Runner` errors with `Level not found` otherwise, `Runner.lean` ~109).
- The level must be solvable with an empty inventory: the probe passes
  `inventory := []` (at difficulty 1 the Runner only warns about locked
  tactics, but the smoke plays the level as a first visitor), so pick a
  level whose proof uses tactics introduced by that level or available from
  the start — level 1 of the first world is the natural choice
  (NNG4 Tutorial 1 `rfl`, STG4 Subset 1 `exact h`, TestGame TestWorld 1
  `rw [h]\nrw [g]`). For `probe2` use the level's own solution and check the
  level JSON that every tactic and lemma it uses is `locked: false` there.
- The proof must close the level *without warnings*: the smoke fails on
  "Level completed with warnings 🎭", which is what unsuppressed linters
  produce — the reason `leanOptions` carries `linter.all=false`. `sorry`
  is not a probe. Pair each probe with a negative control (a wrong step must
  fail) so a silent harness is not mistaken for a pass.
- The first `worldSize` key in `game.json` is not the first world
  (STG4: `Union`); read `Game.lean`'s import order.
- Running a probe natively: `lean` on the `Runner` document with
  `LEAN_PATH=<game base tree>:<game oleans>`, the row's `-D` options, and
  **cwd = the game directory** (`Runner` loads `./.lake/gamedata/…`). Every
  catalog game's id is the GameServer default `"MyGame"` (none uses the
  `Game` command).

## 6. Languages and i18n

- `Languages` in `Game.lean` must be ISO codes: `Languages "en" "es"`.
  `Languages "English"` (TestGame still; Knights, lean4game-logic and LAG
  had it and their patches fix it) is accepted by the `Languages` command
  but matches no entry of `client/src/config.json`; `--check` warns.
- The client asks `/i18n/<id>/<lang>` for every language in
  `client/src/config.json` (nine today: en de zh es ko uk it fr ru).
  `scripts/stage-game-assets.sh` copies every `<src>/.i18n/<lang>/Game.json`
  the game ships and writes `{}` for the rest (a missing file would answer
  the SPA HTML and throw in i18next). The source language has only a `.pot`
  and gets `{}`: its strings are the ones in the `.lean` files.
- Expected fallbacks: a UI language the game does not ship shows the game
  in its source language; a shipped translation covers only the msgids
  present when it was made — the rest fall back to the source. Measure and
  report the coverage against the template regenerated at this pin: STG4
  `es` 352 of 357 (the "contradict…" hints and two long Subset/Combo hints);
  NTG `ru` 304 of 305 present, two of them empty (the `ring`/`have` tactic
  docs) → 302 translated, all three gaps upstream state; Robo `de en es zh`
  829 of 829 each. NNG4's `fr it uk zh` coverage was not measured.
- Robo's translations are key-style (source language `template`, an `en`
  file that maps keys to English), so its `en` is a real file, not a stub.
- An `.i18n/<lang>` directory is not necessarily a translation: Knights'
  and RAG's `de` hold 16 lean4game template strings; both games advertise
  `en` only, correctly.

## 7. Bake, verify, stage, upload, deploy

1. `node scripts/games-manifest.mjs --check`.
2. `wasm/build-from-source.sh --lanes compat,games,bake --games <snapshot> --verify-snapshots`
   (Docker; flags per the script header; `compat` is cheap and idempotent
   and is required whenever `trees` did not run in the same invocation —
   §4): compiles the game against `lib-tree-gamebase` with the row's
   `leanOptions`, writes `<src>/.lake/gamedata` + `.i18n`, overlays the slim
   per-game tree, bakes `<snapshot>.<digest>.snapz` into `wasm/out/staging`
   and runs the probe (`SNAPSHOT PROBE PASS`). Paste the printed raw size
   into `expectedRaw`.
3. `wasm/build-from-source.sh --lanes bundle` (or by hand:
   `scripts/stage-snapshots.py wasm/out/staging/snapshots <snapshot>`,
   `scripts/stage-game-assets.sh`, `npm --workspace client run build`).
4. Local smoke: `node scripts/serve-dist.mjs` and
   `node /Users/fawadhaider/code/wasm64-lean-fable/qed64/work/games-smoke.mjs http://localhost:3006`
   (a fresh profile = the cold first visit; pass a profile dir to measure
   the warm path), then play a few levels by hand, including one hint/doc
   in a translated UI language.
5. Review and commit locally (never push): `wasm/catalog.json`,
   `client/public/{api/games,data/<id>,i18n/<id>,snapshots/index.json}`,
   `wasm/artifacts/BUNDLE.json`, the patch. `scripts/deploy-app.sh`
   refuses a tree missing any listed game's `game.json` or `api/games`.
6. Publish: `wasm/DEPLOY.md` ("Adding a game" for the order, "Rollback" for
   undoing it).

Machine lessons from the 2026-09-11 batch (seven ports compiled on one
Mac's Docker VM):

- **The Docker VM has 7.6 GiB; compile one game at a time.** Each module is
  one `lean` process importing the game's whole closure (NTG's umbrella
  levels: > 3 GB RSS; Robo's `Analysis.InnerProductSpace` closure similar).
  Two or more concurrent compiles get `lean` OOM-killed: exit 137 / rc −9,
  **no message, no olean**, a bare `[n/N] FAIL <module>` line. Robo saw 69
  such kills, Knights 10, and the shared lane log
  (`wasm/out/logs/games.log`) shows the same signature on NNG4
  `Multiplication.L05one_mul` and Robo `Quantus.L07_Forall`. The kill is
  always on a re-runnable module: re-run `compile-pkg.py` (it is
  incremental) until `package complete`. Wall-clock times in §8 measured
  under contention are not compile times (only Reintro's 1495 s was
  measured before the other loads started).
- **`wasm/scripts/compile-pkg.py` prints a module's messages only when it
  FAILs.** A successful log therefore has no `warning:` lines by design; to
  count warnings (or find deprecations) run a message-capturing pass, and
  remember `-Dlinter.all=false` hides deprecations in that pass too.
- **Module names may contain `'`.** `compile-pkg.py`'s import regex accepts
  it (RAG); an older copy silently skips such modules and their importers
  then fail with "object file does not exist".
- **Verify against the tree the lane will use.** Several ports compiled
  against a private overlay holding an older compat `Cases.olean`; the
  reviewers re-ran the affected modules and probes against the current
  `lib-tree-gamebase`. Run `--lanes compat` first and point `LEAN_PATH` at
  the shared tree.

## 8. Ported games

Nine catalog rows (TestGame aside). "Probes" are the row's `probe` and
`probe2`, both verified by native `Runner` elaboration (exit 0, no messages,
negative control rejected) unless stated otherwise; "bake" is the raw
snapshot size the bake lane printed (`expectedRaw`), or "not yet baked".
Warning counts are build-time `warning:` lines from a message-capturing
compile; none of them renders in a player's info view unless said so.
Items the reports did not establish are marked UNVERIFIED.

### NNG4 — hhu-adam/NNG4

- Upstream: <https://github.com/hhu-adam/NNG4> @ `360d797` (the row keeps
  the short hash); Lean `v4.23.0`, Mathlib `v4.23.0` (`37df177`), GameServer
  `v4.23.0`.
- Patch: `wasm/patches/nng4-wasm64-port.patch` (266,898 bytes, 8,603 lines,
  ported 2026-09-01, before `wasm/compat` existed):
  - `Game/Levels/Algorithm/L04add_algo3.lean`: drop `import ImportGraph`;
    `Game/Levels/LessOrEqual/Level_3.lean`: drop `import Std.Tactic.RCases`
    (`rcases` is core) — vestigial imports;
  - `Game/MyNat/PeanoAxioms.lean`: `import Mathlib.Tactic.Have` →
    `import Game.Tactic.MathlibHave`; `Game/Tactic/{Cases,Induction}.lean`:
    `import Mathlib.Tactic.Cases` → `import Game.Tactic.MathlibCases`;
  - new `Game/Tactic/MathlibCases.lean` (`ElimApp.evalNames` and its helper
    from Mathlib v4.23.0, without `cases'`/`induction'`) and
    `Game/Tactic/MathlibHave.lean` (the v4.23.0 `Have` file);
  - `.i18n/en/Game.pot` regenerated (the one patch that carries the
    template; see §3).
- Compat modules: none — the vendored copies above; the next rebake can drop
  them and import `Mathlib.Tactic.{Have,Cases}` from compat.
- `leanOptions`: `linter.all=false`, `tactic.hygienic=false` (lakefile).
- Languages: `en zh uk it fr`, translations shipped for `fr it uk zh`
  (coverage against the regenerated template UNVERIFIED).
- Served: 9 worlds / 79 levels. `Game/Levels/OldProposition/FuncProgram.lean`
  (`import Mathlib.Tactic`) is on disk but not reachable from `Game.lean`.
- Player-visible differences: none reported; the commit message records
  browser play of the Tutorial and Addition worlds (hints, goal states,
  inventory unlocks, sound completion); the other worlds are verified by the
  compile of their in-file solutions only.
- Inherited upstream defects: none reported.
- Probes: Tutorial 1 `rfl` (`SNAPSHOT PROBE PASS`); no `probe2`. Bake:
  569,269,949 B raw slim.

### STG4 — djvelleman/STG4

- Upstream: <https://github.com/djvelleman/STG4> @
  `b7296fcb2f06aa30d396422675c86a5b03b662f9`; Lean `v4.23.0`, Mathlib
  `v4.23.0`, GameServer `v4.23.0`.
- Patch: none.
- Compat modules: `Mathlib.Tactic.Have` (`Game/Metadata.lean:3`; the
  goal-creating `have h : t` the game teaches).
- `leanOptions`: `linter.all=false`, `tactic.hygienic=false` (lakefile).
- Languages: `en es`; `es` covers 352 of the 357 msgids regenerated at this
  pin (§6).
- Served: 8 worlds / 51 levels (`Game/Levels/DemoWorld.lean` on disk, not
  imported — as upstream).
- Player-visible differences: none reported.
- Inherited upstream defects: none reported.
- Probes: Subset 1 `exact h` (`SNAPSHOT PROBE PASS`); no `probe2`. Bake:
  665,285,845 B raw slim.

### ReintroductionToProofs — emilyriehl/ReintroductionToProofs

- Upstream: <https://github.com/emilyriehl/ReintroductionToProofs> @
  `c4b1c3d0076e0c4a22dc11b7518fe6dbdb9e5de2`; Lean `v4.23.0`, Mathlib
  `v4.23.0`, GameServer `v4.23.0`.
- Patch: none — the game compiles unmodified (a fresh clone is
  byte-identical to `games-src/ReintroductionToProofs`).
- Compat modules: `Mathlib.Tactic.Cases`
  (`Game/Metadata/Tactic/Induction.lean:6`, uses only
  `Mathlib.Tactic.ElimApp.evalNames`; the port compiled against the old
  `evalNames`-only subset, the shipped oleans were rebuilt by the games lane
  against the full `de3a9cf` file and re-verified by the reviewer).
- `leanOptions`: `linter.all=false`, `pp.showLetValues=true`,
  `tactic.hygienic=false` (lakefile).
- Languages: `en` only; no translations (`.i18n/en/Game.pot` only, so every
  other UI language shows the source strings).
- Served: 17 worlds / 158 levels (TypeWorld 7, FunctionWorld 10,
  ImplicationWorld 10, ProductWorld 10, ConjunctionWorld 10, CoproductWorld
  8, DisjunctionWorld 9, EmptyWorld 7, NegationWorld 11, ClassicalWorld 6,
  EqualityWorld 11, BooleanWorld 9, QuantifierWorld 10, AdvancedFunctionWorld
  16, EquivalenceWorld 7, NaturalNumbersWorld 11, DependentWorld 6).
  `Game/Levels/EquivalenceWorld/L08_UnusedBossLevel.lean` is on disk but
  not imported upstream either.
- Player-visible differences: none. The custom wrappers — `Game.constructor`
  (`fconstructor` macro), the modified `induction` (`rec'`, base case shown
  as `0`), `MyNat.rewriteSeq` `rw` (= `rewrite`, no `rfl`), the `use`
  without discharger, `xyzzy` — elaborate with unchanged player syntax
  (checked through `Runner` on NaturalNumbersWorld 7).
- Inherited upstream defects: DisjunctionWorld 3's `Statement` has no
  docstring (empty `descrText`); `game.json` has 23 world edges for 21
  `Dependency` lines (two inferred by `MakeGame` from inventory use —
  upstream behaviour); the committed `.pot` is stale (920 vs 926 msgids),
  irrelevant with no translations. 0 warnings.
- Probes: TypeWorld 1 `assumption` (`SNAPSHOT PROBE PASS`);
  ConjunctionWorld 1 `constructor / exact p / exact q` — `constructor` is
  taught in ProductWorld 1, `exact` in TypeWorld 3, both unlocked there
  (the row's first `teaches` text got this wrong; fixed). Bake: 562,887,317
  B raw slim; 185 modules, 1495 s uncontended.
- UNVERIFIED: browser smoke (`games-smoke.mjs`) was not run by the port or
  review.

### KnightsAndKnaves — JadAbouHawili/KnightsAndKnaves-Lean4Game

- Upstream: <https://github.com/JadAbouHawili/KnightsAndKnaves-Lean4Game> @
  `bd4ab6e6d00fbbfb95b17e66589c07e75bb9d56c`; Lean `v4.29.1`, Mathlib
  `v4.29.1` (`5e932f97`), GameServer `v4.29.1`.
- Patch: `wasm/patches/knights-wasm64-port.patch` (4,157 bytes, 5 files):
  - `Game.lean`: `Languages "English"` → `Languages "en"`;
  - `Game/MathlibTheorems.lean`: `import Mathlib.Tactic.Polyrith` commented
    out (not in the pack; `polyrith` needs an external Sage oracle; no
    level, hint or doc mentions it or `linear_combination`);
  - `Game/LevelLemmas/settheory.lean`,
    `settheory_knightsknavesfoundation.lean`: the `[DecidableEq _]` binder
    moved from its own column-0 line onto the `variable` line (§3; the
    unpatched file gives "unexpected token '['" and 23 instance errors);
  - `Game/Levels/SetTheory_Knights_Knaves/L09_same.lean`: the model proof's
    `simp at diff` replaced by a comment — on this Mathlib `diff : ¬(A ∉
    Knave ↔ C ∉ Knave)` is already simp-normal ("simp made no progress");
    the following `rw [not_iff] at diff` and `knight_interp at diff` reach
    `diff : A ∈ Knight ↔ C ∉ Knight` as before.
- Compat modules: `Mathlib.Tactic.Have` (`Game/MathlibTheorems.lean:4`).
- `leanOptions`: `linter.all=false`, `tactic.hygienic=false` (lakefile).
- Languages: `en` only (`.i18n/de` holds 16 lean4game template strings, not
  a translation; not advertised).
- Served: 6 worlds / 59 levels (EquationalReasoning 3, Logic 11, Simp_World
  9, DSL_Knights_Knaves 14, KnightsAndKnaves2 8, SetTheory_Knights_Knaves
  14). `EquationalReasoning/L04_mul_left_cancel.lean` is on disk but not
  imported upstream either.
- Player-visible differences: in SetTheory_Knights_Knaves 9, typing `simp at
  diff` at the point where upstream's model proof had it now errors "simp
  made no progress" (toolchain, not the patch; the hints say "Use
  not_iff"). `cases'` is unavailable in this game (only `Have` is imported;
  nothing teaches it). `polyrith` is unavailable (never mentioned).
- Inherited upstream defects: four dead `TheoremDoc` entries in
  `Game/Doc/doc.lean` (`false_or_iff`, `iff_true_iff`, `or_false_iff`,
  `true_or_iff` — unresolvable names, no `NewTheorem` references them, no
  doc file emitted, same upstream); the SetTheory 9 model proof uses
  `rcases`, which no world introduces (`MakeGame` warns; a player typing it
  at difficulty 1 is told the tactic is not available — the hints steer to
  `knight_or_knave`). 101 build warnings, all upstream authoring: 32 i18n
  "comment line ends in a backslash", 29 + 10 + 4 missing
  Theorem/Definition/Tactic documentation, 4 "could not find a docstring
  for tactic", 21 "No world introducing X", 1 `declaration uses sorry` on
  an `example` in `Game/LevelLemmas/settheory_KnightsAndKnaves.lean:33`.
  Deprecations could not have shown in the log (`linter.all=false`).
- Probes: EquationalReasoning 1 `rfl` (`SNAPSHOT PROBE PASS`); Logic 7
  `cases h / exact hPR h_1 / exact hQR h_1` (`cases`, new in that level; the
  `h_1` names rely on `tactic.hygienic=false` exactly as the level's own
  proof). Bake: 728,516,269 B raw slim; 75 modules, 1017 s including 10 OOM
  retries.
- UNVERIFIED: browser smoke; what upstream's `simp at diff` rewrote under
  v4.29.1 (no Mathlib build for that toolchain was available); the 101
  warnings were attributed to upstream by reading the sources, not by an
  upstream build.

### NumberTheoryGame — k88-b/NumberTheoryGame

- Upstream: <https://github.com/k88-b/NumberTheoryGame> @
  `08073bc5f2c6f983a79abe250b0e2640cb096131`; Lean `v4.23.0`, Mathlib
  `v4.23.0`, GameServer `v4.23.0`.
- Patch: none — a fresh clone is byte-identical to
  `games-src/NumberTheoryGame` and its gamedata byte-identical to ours.
- Compat modules: the `Mathlib.Tactic` umbrella (`import Mathlib.Tactic` in
  `Game/Levels/Definitions.lean` and the Problems levels) and, through it,
  the full `Mathlib.Tactic.Cases` (`induction'` is taught) and
  `Mathlib.Tactic.Have` (the game's `gameHave` macro in `Game/Metadata.lean`
  rejects `have h : t := proof` and forces the goal-creating form; verified
  live on Congruence 2).
- `leanOptions`: `linter.all=false`, `pp.showLetValues=true`,
  `tactic.hygienic=false` (lakefile).
- Languages: `en ru`; `ru` has 304 of the 305 regenerated msgids, two of
  them with empty translations (the `ring` and `have` tactic docs), so 302
  strings are translated; the missing msgid is the Divisibility 5 `Branch`
  hint, absent from upstream's own `.pot` as well.
- Served: 6 worlds / 50 levels (Divisibility 5, Congruence 11, GCD 10,
  LinCong 11, DivRules 7, Problems 6); edges = the 5 `Dependency` lines.
- Player-visible differences:
  - umbrella subset: a tactic from one of the 110 upstream umbrella leaves
    the pack lacks (`mod_cases`, `polyrith`, `ext`, …) is "unknown tactic"
    here where upstream would parse it (the game teaches only `use intro
    ring obtain rw unfold have exact induction' constructor`; the Runner
    flags any non-game tactic anyway);
  - six `Statement` names clash with Mathlib (Divisibility 2 `one_dvd`, 3
    `dvd_refl`, 4 `dvd_zero`, 5 `dvd_trans`; GCD 1 `dvd_mul_of_dvd_left`;
    LinCong 3 `inv_unique`): from the next level on the inventory card
    shows Mathlib's general statement under the game's doc text — identical
    upstream (Mathlib `v4.23.0` has all six); no later level or hint uses
    the names.
- Inherited upstream defects: the six clashes (the build's only 6
  warnings); `descrText` empty for LinCong 1–11 and Problems 1–6 (no
  `Statement` docstrings); 17 levels without any `Hint`. Deprecations: the
  lemmas the game teaches (`pow_succ`, `mul_left_cancel₀`,
  `Int.dvd_antisymm`) are undeprecated at `de3a9cf` (reviewer); a
  deprecation would not have shown in the log anyway.
- Probes: Divisibility 1 `use 4` (`SNAPSHOT PROBE PASS`; `use 5` fails);
  Congruence 8 `induction' n with d ih / unfold ModEq / use 0 / ring / rw
  [pow_succ, pow_succ] / exact mod_mul (a^d) (b^d) a b m ih h` (the full
  compat `Cases` elaborator plus the `NewTheorem pow_succ`; passes at
  difficulty 1 and 2). Bake: 835,759,917 B raw slim; 66 modules, 2217 s
  wall across 14 OOM-interrupted passes (reviewer's clean compile 1063 s
  under similar contention).
- UNVERIFIED: browser smoke; the play-time memory footprint of the umbrella
  closure (every level's environment holds all 244 tactic modules — larger
  than NNG4/STG4).

### RealAnalysisGame — AlexKontorovich/RealAnalysisGame

- Upstream: <https://github.com/AlexKontorovich/RealAnalysisGame> @
  `930c38333b2edcc3ad27c5f68b9f09210cfaaf62`; Lean `v4.26.0`, Mathlib
  `v4.26.0` (`2df2f015`), GameServer `chore/bump-v4.26.0` (`2ab29266`).
- Patch: `wasm/patches/rag-wasm64-port.patch` (219,562 bytes, 5,762 lines,
  116 files; only five files change outside whitespace):
  - `Game/Metadata.lean`: `import Mathlib.Analysis.SpecialFunctions.Log.Base`
    (absent from the pack, as is its dependency `Data.Int.Log`) replaced by
    its two in-pack imports `Analysis.SpecialFunctions.Pow.Real` and
    `Algebra.BigOperators.Field` plus `Mathlib.Tactic.Bound` (the taught
    `bound` tactic, previously reached transitively); imports the new
    `PushNeg` file. A vendored `Log.Base` was tried and withdrawn (IR
    interpreter assertion on this fork);
  - `Game/CustomTactic/Linarith.lean`: `elabLinarithConfig` qualified as
    `Mathlib.Tactic.elabLinarithConfig` (core now defines a grind-based one);
  - `Game/CustomTactic/PushNeg.lean` (new): `macro (priority := high)
    "push_neg" cfg loc => push cfg Not loc`, so the taught `push_neg`
    (Lecture 12, 8 level files) does not log Mathlib's unconditional
    deprecation warning;
  - 112 level files: every column-0 `:= by` block indented by two spaces
    (2,088 lines; whitespace only, none inside string literals or doc
    comments — the 13 doc comments the first sweep touched were de-indented
    after review, so doc JSON and `.pot` msgids match upstream);
  - `Game/Levels/L4Levels/L01_NonConverge.lean`: local `@[simp] theorem
    neg_one_pow_two_mul_add_one_real : (-1 : ℝ) ^ (2 * n + 1) = -1` so the
    model solution's `bound` step (and the hint recommending `bound` for
    "exponent simplifications") still closes;
  - `Game/Levels/L22Levels/L03.lean`: `attribute [grind]
    Mathlib.Tactic.Zify.natCast_le._simp_1` commented out (constant gone at
    `de3a9cf`; no reachable level calls `grind`).
- Compat modules: the full `Mathlib.Tactic.Cases` (`Game/Metadata.lean:18`;
  `cases'`/`induction'` are taught in 31 level files) — this port is why
  the compat file was upgraded from the v4.23.0 subset.
- `leanOptions`: `linter.all=false`, `tactic.hygienic=false` (lakefile).
- Languages: `en` only (`Game.lean:167`); upstream tracks an old `.i18n/de`
  (16 template strings) that is not advertised, and no `en` template.
- Served: 44 worlds / 139 levels; first world `RealAnalysisStory`.
- Player-visible differences: `push_neg` goes through the wrapper macro
  (behaviour identical: `push_neg`, `push_neg at h` verified; the locked-
  tactic check still fires because it is atom-based); `Real.logb` and its
  lemmas are not in any level's environment (no level, hint or doc uses
  them); `simp`/`norm_num`/`bound` in every level after L4 L01 also know
  the added simp lemma (strictly stronger; harmless). Players never see the
  solution indentation.
- Inherited upstream defects: L24Pset 2 ("Open Balls are Open") defines
  `lemma IsOpen_of_Ball … := by …` instead of a `Statement`, so it is a
  level with no goal (`statementName "[anonymous]"`) — left as is (a content
  change); 119 of 139 levels have no `Hint`; 36 `Statement`s have no
  docstring. 26 build warnings: 24 `declaration uses sorry` — upstream's
  own sorried model solutions and lemmas (L19Levels/L04, L22Pset/L03,
  L23–L25, `theorem`s in L18Levels/L02; players still have to prove the
  levels) — and 2 i18n backslash warnings (`L18Lecture.lean`).
- Probes: RealAnalysisStory 1 `apply h` (`SNAPSHOT PROBE PASS`); Lecture6 5
  `cases' h with h1 h2 / rewrite [h1] / ring_nf / rewrite [h2] / ring_nf`
  (`cases'`, new in Lecture6 4). Bake: 1,004,806,293 B raw slim; 187
  modules, 1016 s for the last clean build.
- UNVERIFIED (the report's status is "partial"): the port's own
  recompile after the doc-comment de-indent never reached `package
  complete` in its logs (`scratchpad/rag/build10.log` stops at [146/187],
  0 errors); `games-src/RealAnalysisGame/.lake/gamedata` on disk (regenerated
  2026-09-11 15:52) does show 44/139 and the two doc JSONs without the
  indented continuation, but whether the shipped `rag` snapshot (baked
  earlier that afternoon) was baked from the de-indented oleans is not
  established — the difference is at most two leading spaces in two doc
  strings, which Markdown renders identically. Also: browser smoke; the
  `push_neg +distrib` path; `de` coverage; the `Log.Base` assertion was not
  root-caused; the 26-warning count predates the de-indent (whitespace
  cannot add warnings).

### Robo — hhu-adam/Robo

- Upstream: <https://github.com/hhu-adam/Robo> @
  `5d335ce54e9aec50f55ab7e1e24a7a1a79bee188`; Lean `v4.31.0`, Mathlib
  `v4.31.0` (`fabf563a`), GameServer `v4.31.0`.
- Patch: `wasm/patches/robo-wasm64-port.patch` (1,172 bytes, 1 file):
  - `Game/Metadata.lean`: `import Batteries` dropped — the pack ships no
    `Batteries.olean` umbrella; its 75 Batteries modules reach the game
    through `Mathlib.Tactic.Common` (imported by
    `Game/Metadata/FromMathlib.lean`).
- Compat modules: `Mathlib.Tactic.Have`, `Mathlib.Tactic.Generalize`,
  `Mathlib.Algebra.Order.Ring.Star`, `Mathlib.Data.Int.Star`,
  `Mathlib.Data.Rat.Star` (all `Game/Metadata/FromMathlib.lean`) and
  `Mathlib.Tactic.Cases` (`Game/Metadata/Tactic/Induction.lean:6`,
  `ElimApp.evalNames`). The four Robo leaves were added for this port;
  `Data.Rat.Star` is compiled in classic form (§4). The port compiled
  against the old `Cases` olean; the reviewer recompiled `Induction.lean`,
  Babylon 6, both probe levels and `Game` against the current tree with no
  messages.
- `leanOptions`: `autoImplicit=false`, `pp.unicode.fun=true`,
  `pp.funBinderTypes=true`, `pp.showLetValues=true`, `linter.all=false`,
  `tactic.hygienic=false` (lakefile `leanOptions`; its
  `moreLeanArgs`/`moreServerOptions` deliberately omitted — inert here).
- Languages: `de en es zh`, key-style (source language `template`); each
  `.po` covers 829 of 829 msgids; `en` is a real file (§6). Game name and
  captions are i18n keys (`en` title "Scribble", `de` "Robo").
- Served: 18 worlds / 156 levels (Logo 14, Implis 14, Piazza 13, Robotswana
  11, Cantor 11, Mono 11, Vieta 10, Quantus 10, Prado 10, Luna 10, Babylon
  9, Samarkand 8, Epo 7, Spinoza 6, Saturn 5, Euklid 4, Iso 2, Ciao 1);
  images 21,914,202 bytes (33 files).
- Player-visible differences: none observed — all 156 in-file solutions
  elaborate and the 35 taught tactics are core/Mathlib (the negation tactic
  taught is `push` = Mathlib `push Not`, not `push_neg`, so no deprecation
  arises). A Batteries-only tactic that `Mathlib.Tactic.Common` does not
  reach would be unknown here; none is taught or documented.
- Inherited upstream defects: 31 build warnings — 12 `i18n: duplicate
  msgid`, 1 "No world introducing Finset.univ, but required by Robotswana",
  16 "Environment already contains …" (redeclared Mathlib lemmas such as
  `lt_trichotomy`, `Nat.prime_two`, `Set.subset_iff`), 2 missing
  TheoremDocs (`Function.injective_iff_hasLeftInverse`,
  `surjective_iff_hasRightInverse`). The 16 clashes are the same class as
  NTG's; whether their inventory cards show Mathlib's statement was not
  checked (UNVERIFIED).
- Probes: Logo 1 `tauto`; Implis 1 `intro hA / constructor / assumption /
  assumption` (`intro`, new there; the level's own proof); both re-run by
  the reviewer against the current tree. Bake: not yet baked (`expectedRaw`
  null). 189 modules; 5470 s wall with 69 OOM kills — pure compile time
  unknown.
- UNVERIFIED: browser smoke; the 154 non-probe levels are verified by
  compiling their solutions only.

### lean4game-logic — Trequetrum/lean4game-logic

- Upstream: <https://github.com/Trequetrum/lean4game-logic> @
  `40ceec5f3ca5dce6cec2800b8f5e4927631ca2da`; Lean `v4.7.0`, Mathlib
  `v4.7.0` (`a45ae637`), Std `v4.7.0`, GameServer `v4.7.0` — the oldest
  game in the catalog.
- Patch: `wasm/patches/logic-wasm64-port.patch` (2,481 bytes, 2 files):
  - `Game.lean`: `Languages "English"` → `Languages "en"`;
  - `Game/Levels/OrIntro/L02.lean`: `Statement (O S : Prop)(s : S) : K ∨ S`
    → `Statement (K O S : Prop)(s : S) : K ∨ S` (auto-bound implicit, §3).
- Compat modules: the `Mathlib.Tactic` umbrella (`Game/Metadata.lean:7`),
  and through it `Have`/`Cases`.
- `leanOptions`: `linter.all=false`, `tactic.hygienic=false`,
  `linter.unusedVariables.funArgs=true` (the lakefile's server-side value;
  inert under `linter.all=false`).
- Languages: `en` only; no translations.
- Served: 10 worlds / 88 levels (AndIntro 8, AndTactic 8, OrIntro 8,
  OrTactic 8, ImpIntro 9, ImpTactic 9, IffIntro 7, IffTactic 7, NotIntro
  12, NotTactic 12).
- Player-visible differences: OrIntro 2's editor-mode header now reads
  `example (K O S : Prop)(s : S) : K ∨ S := by` (upstream: `(O S : Prop)`);
  the object list `K O S : Prop` and the goal are unchanged, the level has no
  hints and the Statement is anonymous. Umbrella subset: 110 upstream leaves
  are unavailable, but every level restricts tactics with `OnlyTactic` to
  `exact have assumption constructor cases intro apply repeat rw
  contradiction exfalso left right`, none from an excluded leaf.
- Inherited upstream defects: 2 build warnings, both i18n "comment line
  ends in a backslash" (`ImpIntro/L05.lean:14`, `ImpTactic/L05.lean:14`).
- Probes: AndIntro 1 `exact todo_list`; ImpTactic 1 `apply h / assumption`
  (`apply`, new there; `assumption` from AndTactic 1); both elaborated
  through `Runner` after the review's first attempt was OOM-killed, with
  two negative controls (unknown identifier; disabled `exact`). Bake: not
  yet baked (`expectedRaw` null). 103 modules, 753 s (692 s by the
  reviewer's mtime measure).
- UNVERIFIED: browser smoke.

### LinearAlgebraGame — ZRTMRH/LinearAlgebraGame

- Upstream: <https://github.com/ZRTMRH/LinearAlgebraGame> @
  `03b894b227cc969de55de2d155f7308d83b3c3f5`; Lean `v4.21.0`, Mathlib
  `v4.21.0` (`308445d7`), GameServer `v4.21.0` (`checkdecls` required by the
  lakefile, used by nothing). Analysis: `wasm/LINEAR-ALGEBRA-GAME.md`.
- Patch: `wasm/patches/lag-wasm64-port.patch` (17,487 bytes, 9 files):
  - imports — `Game/Data.lean`: 22 `Mathlib.Data.*` imports not in the pack
    commented out (`Finmap`, `Matrix.{Auto,CharP,ColumnRowPartitioned,
    DMatrix,DualNumber,Hadamard,Invertible,PEquiv,Rank}`, `Num.*`,
    `Opposite`, `PNat.{Factors,Find,Interval,Prime,Xgcd}`,
    `Real.{Archimedean,Sign}`; none used by any level),
    `Data.Matrix.{Kronecker,Notation,RowCol}` → `LinearAlgebra.Matrix.*`,
    `Data.Real.{Cardinality,Sqrt}` → `Analysis.Real.*`, plus
    `Mathlib.LinearAlgebra.Basis.VectorSpace` so the root `VectorSpace`
    namespace that every level's `open VectorSpace` needs stays in the
    closure; `InnerProductWorld/LemmasAndDefs.lean`: drop
    `Analysis.Complex.AbsMax` (245-module closure; `Complex.abs` only in
    comments), `Data.Real.Sqrt` → `Analysis.Real.Sqrt`;
  - `Game.lean`: `Languages "English"` → `"en"`; `Dependency TutorialWorld →
    VectorSpaceWorld` moved here from `Game/Levels/VectorSpaceWorld.lean`
    (§3; edges identical);
  - Mathlib drift — `VectorSpaceWorld/Level01.lean`: `TheoremDoc`/`NewTheorem`
    `MulAction.mul_smul` → `SemigroupAction.mul_smul`;
    `LinearIndependenceSpanWorld/Level08.lean`: `alias
    _root_.Finset.sum_eq_sum_diff_singleton_add :=
    Finset.sum_eq_sum_sdiff_singleton_add`; `InnerProductWorld/Level03.lean`:
    `alias _root_.sq_eq_sq := sq_eq_sq₀`;
  - proof drift — `InnerProductWorld/Level06.lean`: `ring` after `field_simp
    [h_nonzero]` with a visible and a hidden hint; `Level07.lean`: helper
    `norm_sq_scaled_eq` loses a redundant `ring`, the Cauchy–Schwarz proof
    and its hidden hint use `simp [v_norm_zero] at h_mul` (the
    `div_mul_cancel` argument was unused); `LemmasAndDefs.lean`: `ring`
    after `field_simp` in `ortho_decom_parts`, two unused simp-argument
    lists trimmed (`conj_zero`, `ortho_decom_parts`).
- Compat modules: the `Mathlib.Tactic` umbrella (`Game/Metadata.lean:2`,
  imported by the 10 Tutorial levels), `Mathlib.Tactic.Have` and
  `Mathlib.Tactic.Cases` (`Game/MyTactic.lean:83,14`; goal-form `have` and
  `cases'` are taught, 31 uses).
- `leanOptions`: `tactic.hygienic=false`,
  `linter.unusedVariables.funArgs=false`, `trace.debug=false` (lakefile
  `moreLeanArgs`) plus `linter.all=false` added by the port (§2).
- Languages: `en` only; no translations (`.i18n/config.json` already said
  `sourceLang: en`).
- Served: 5 worlds / 43 levels (TutorialWorld 10, VectorSpaceWorld 5,
  LinearIndependenceSpanWorld 9, LinearMapsWorld 11, InnerProductWorld 8);
  edges Tutorial→VectorSpace→LIS→{InnerProduct, LinearMaps}. Unreachable
  files left untouched: `DemoWorld`, `InnerProductWorld/Code.lean`,
  `LinearMapsWorld/Level01_backup.lean`, `Game/MyTactic 2.lean`.
- Player-visible differences:
  - InnerProductWorld 6 (`ortho_decom`): the taught `field_simp [h_nonzero]`
    now leaves `⟪u,v⟫ * (1 - 1) = 0`; the level needs one more `ring`
    (taught in InnerProduct 3, in the inventory), announced by the added
    hints — the only level whose required input changed;
  - InnerProductWorld 7: the hidden hint now says `simp [v_norm_zero] at
    h_mul`; the old form still completes;
  - TutorialWorld 5: the command-level `Try this: intro h1 h2 h3` suggestion
    still renders at play time although the catalog carries
    `linter.all=false` (§2); the level completes;
  - LinearIndependenceSpanWorld 9 has players type `Set.subset_diff_singleton`
    and `Set.diff_subset`, deprecated at `de3a9cf`; the warnings are
    suppressed at play time by `linter.all=false` (verified against the
    four-option rebuild);
  - the environment is slightly smaller (no Matrix/PNat/Num extras); `mul_smul`
    still resolves; the two aliases keep the taught names.
- Inherited upstream defects: InnerProductWorld 3, 5, 6, 7 and 8 hint at
  lemmas no world introduces (`InnerProductSpace_v.inner_smul_left`,
  `inner_smul_right_v`, `inner_add_right_v`, `left_smul_ortho`,
  `ortho_swap` — the `MakeGame` "No world introducing" items), so at the
  client's default difficulty 2 the hinted proofs error "is not available in
  this game"; at difficulty ≤ 1 they complete with warnings. Same check
  upstream; keep smoke tests off those levels at difficulty 2. 24 build
  warnings: 16 "No world introducing", 3 missing Theorem Documentation, 4
  "Add a text to this command", 2 legacy `TacticDoc simp "…"` string
  syntax in `VectorSpaceWorld/Level01.lean`.
- Probes: TutorialWorld 1 `rfl`; LinearMapsWorld 1 `unfold is_linear_map_v /
  rfl` (`unfold`, taught in Tutorial 5, on the game's own definition; the
  level's solution verbatim); both pass with no messages at difficulty 2
  against the four-option rebuild. Bake: not yet baked (`expectedRaw` null;
  estimate ≈ 950 MB raw slim / ≈ 260 MB gz). 55 modules, 433 s under
  contention.
- UNVERIFIED: bake and browser play; the InnerProductWorld `‖x‖` notation
  overload (over Mathlib's norm notation) compiled without ambiguity in all
  8 levels but was not exercised interactively.
