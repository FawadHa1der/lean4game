# Porting a game to the wasm64 build

How a game from adam.math.hhu.de's catalog becomes a row in
`wasm/catalog.json` that the lanes build, the staging script serves and the
browser boots. The catalog is the only place a game is named; everything
else reads it through `scripts/games-manifest.mjs` (`--check`, `--list`,
`--api`, `--probe <snapshot>`, `--required-files`, `--langs`). Deployment
steps live in `wasm/DEPLOY.md` ("Adding a game"); this file is the port
itself. Worked examples: NNG4 (`wasm/patches/nng4-wasm64-port.patch`, the
patched case) and STG4 (no patch, the compat case).

What we cannot change: the Lean fork (4.33.0-pre, `wasm/KERNEL-PIN`) and the
Mathlib olean pack (`mathlib-essential`, an input from qed64 — 2254 Mathlib
modules, the import closure of a fixed root set; list it with
`ls -R wasm/out/trees/lib-tree/Mathlib` after the trees lane, or from the
pack manifest). Every game was written for its own toolchain (v4.7 … v4.31)
and a full Mathlib; the port is the distance between that and our pin.

## 1. Survey before touching anything

One GitHub pass per candidate gives toolchain, Mathlib rev, GameServer rev,
size and level count (`gh api repos/<owner>/<repo>` + raw `lean-toolchain`
and `lake-manifest.json`; the 2026-09 survey table is in the multi-game
review). Then a sparse clone of `Game/` + `Game.lean` and the reachability
check that decides feasibility:

1. Walk imports from `Game.lean` (regex `^\s*import\s+([\w.]+)` after
   stripping `/- … -/`), resolving `Game.*` modules to files; everything
   unresolved is external.
2. Split the external Mathlib modules into present-in-pack vs missing
   (compare against the pack module list).
3. Classify each missing module:
   - **pack-excluded leaf that exists upstream** (`Mathlib.Tactic.Have`,
     `Mathlib.Tactic.Cases`, `.Generalize`, `.Polyrith`): provided by
     `wasm/compat` (Have, Cases today) or a new compat leaf — no game edit;
   - **the `Mathlib.Tactic` umbrella** (NumberTheoryGame, lean4game-logic):
     not in the pack; the patch must replace it with the explicit subset the
     levels use, found by compiling and reading the errors;
   - **a real Mathlib module absent from the pack**
     (`Analysis.SpecialFunctions.Log.Base`, `Algebra.Order.Ring.Star`,
     `Data.Int.Star`, `Data.Rat.Star`): blocked until the pack's root set
     grows (a qed64 input, not ours) — drop the import if only a lemma or two
     are used and they can be restated locally, else stop;
   - **custom tactic layers** (`elab`/`macro_rules`/`TacticM` in non-level
     files): compile and see; syntax drift since the game's toolchain is
     the usual failure.
4. Count non-level files, `set_option` lines, `Languages`, images size and
   the first world/level (for the probe).

Games whose reachable closure needs hundreds of missing modules
(LinearAlgebraGame: 297) are out of scope for this pack.

## 2. The catalog row

```json
{ "owner": "djvelleman", "game": "STG4", "listed": true, "snapshot": "stg4",
  "src": "games-src/STG4",
  "source": { "url": "https://github.com/djvelleman/STG4", "rev": "<full sha>", "patch": null },
  "leanOptions": ["linter.all=false", "tactic.hygienic=false"],
  "probe": { "world": "Subset", "level": 1, "proof": "exact h" },
  "expectedRaw": null }
```

- `owner`/`game`: as served (`/#/g/<owner>/<game>`, case-sensitive static
  paths). `snapshot`: `^[a-z0-9_-]+$`, unique — it names
  `/snapshots/<snapshot>.<digest>.snapz` and the bake/probe/tree.
- `listed: false` keeps a game reachable by URL but off the landing page
  (TestGame).
- `src`: the checkout (`games-src/` is gitignored). `source.rev` is the
  full commit; `source.patch` is the port patch or `null`.
- `leanOptions`: from the game's `lakefile.lean` `package Game where
  leanOptions := #[…]` (STG4/NNG4: `linter.all=false`,
  `tactic.hygienic=false`; Reintro/NTG add `pp.showLetValues`; Robo
  `autoImplicit=false`). They become `-D` flags when the game compiles.
  Nothing else is needed at play time: `Statement` captures the level's
  scope (options included, `server/GameServer/Commands.lean` ~471/489) and
  `Runner` replays it with `withScope` (`Runner.lean` ~113-117), so the
  compile-time options reach the checker through the snapshot. Ignore
  `moreLeanArgs`/`moreServerOptions` (`trace.debug` toggles).
- `expectedRaw`: `null` until the first bake, then `{runtime, bytes}` as
  printed; keyed to the runtime (a runtime bump clears it).
- `probe`: see §5.

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
  `git format-patch -1 --stdout -- . ':!.i18n' > wasm/patches/<snapshot>-wasm64-port.patch`.
- **Never add an import to `Game.lean` or a world file.** The served game
  is exactly what `Game.lean` imports: `MakeGame` merges worlds from the
  imported level files (`server/GameServer/EnvExtensions.lean` ~447-449,
  `World.merge`/`Game.merge`), so a file that exists on disk but is not
  imported is not a level (STG4's `DemoWorld.lean`: on disk, not served —
  8 worlds / 51 levels, not the 9 / 52 a file count suggests). Adding an
  import would publish a world upstream chose not to.
- Prefer dropping an import over rewriting a level: NNG4's patch drops five
  vestigial imports (`ImportGraph`, `Std.Tactic.RCases`, …) and touches no
  proof.
- Vendoring a tactic file into `Game/Tactic/` is the fallback when compat
  (§4) cannot host it; document the origin and licence in the commit.
- Record in `wasm/patches/README.md` what the patch does and why.

## 4. The compat package (Have / Cases need no patch)

`wasm/compat/Mathlib/Tactic/{Have,Cases}.lean` compile once into the game
base tree under their real module names, so `import Mathlib.Tactic.Have`
and `import Mathlib.Tactic.Cases` in an unmodified game resolve. They are
compiled by the `compat` lane of `wasm/build-from-source.sh` (also run at
the end of `trees`); include it in `--lanes` on any machine whose game
base tree predates `wasm/compat` — the `games` lane only warns when the
oleans are missing (recipe: `wasm/compat/README.md`). Both are
the Mathlib v4.23.0 files (Apache-2.0); they are *pack-excluded*, not
removed upstream. `Cases` is the v4.23 subset (`cases'`/`induction'` are
not provided): a game that uses those (RealAnalysisGame, NumberTheoryGame)
needs the real `Cases.lean`, which must be compiled against the fat tree
(`import all Lean.Elab.Tactic.Induction` needs `.olean.private`; play time
never re-imports, so slim per-game trees stay fine). Other leaves
(`Generalize`, `Polyrith`, the `*.Star` modules, `Log.Base`) are added the
same way when a game needs them — or the import is dropped when the game
only mentions it.

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
  `rw [h]\nrw [g]`).
- The proof must close the level *without warnings*: the smoke fails on
  "Level completed with warnings 🎭", which is what unsuppressed linters
  produce — the reason `leanOptions` carries `linter.all=false`. `sorry`
  is not a probe.
- The first `worldSize` key in `game.json` is not the first world
  (STG4: `Union`); read `Game.lean`'s import order.

## 6. Languages and i18n

- `Languages` in `Game.lean` must be ISO codes: `Languages "en" "es"`.
  `Languages "English"` (TestGame, KnightsAndKnaves, LinearAlgebraGame,
  lean4game-logic) is accepted by the `Languages` command but matches no
  entry of `client/src/config.json`; `--check` warns, the port patch fixes
  it.
- The client asks `/i18n/<id>/<lang>` for every language in
  `client/src/config.json` (nine today). `scripts/stage-game-assets.sh`
  copies every `<src>/.i18n/<lang>/Game.json` the game ships and writes
  `{}` for the rest (a missing file would answer the SPA HTML and throw in
  i18next). The source language has only a `.pot` and gets `{}`: its
  strings are the ones in the `.lean` files.
- Expected fallbacks: a UI language the game does not ship shows the game
  in its source language; a shipped translation covers only the msgids
  present when it was made — the rest fall back to the source. STG4 `es`
  covers 352 of the 357 msgids the template regenerates at this pin (the
  five fallbacks: the "contradict…" hints and two long Subset/Combo hints).
  Report the count when a translation is older than the game.
- Robo's translations are key-style (an `en` file that maps keys to
  English), so its `en` is a real file, not a stub.

## 7. Bake, verify, stage, upload, deploy

1. `node scripts/games-manifest.mjs --check`.
2. `wasm/build-from-source.sh --lanes compat,games,bake --games <snapshot> --verify-snapshots`
   (Docker; flags per the script header; `compat` is cheap and idempotent
   and is required whenever `trees` did not run in the same invocation —
   §4): compiles the game against
   `lib-tree-gamebase` with the row's `leanOptions`, writes
   `<src>/.lake/gamedata` + `.i18n`, overlays the slim per-game tree,
   bakes `<snapshot>.<digest>.snapz` into `wasm/out/staging` and runs the
   probe (`SNAPSHOT PROBE PASS`). Paste the printed raw size into
   `expectedRaw`.
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

## 8. Remaining games, ranked (2026-09 survey; blockers per game)

| # | game | reachable modules / levels | blockers |
|---|---|---|---|
| 1 | ReintroductionToProofs (emilyriehl) | 185 / 158 | `Mathlib.Tactic.Cases` (compat subset suffices), `pp.showLetValues` via `leanOptions`, 9 non-level tactic wrappers |
| 2 | KnightsAndKnaves (JadAbouHawili) | 75 / 59 | drop `Mathlib.Tactic.Polyrith`; `Languages "English"` → `"en"`; 4 stale TheoremDocs; v4.29 syntax drift |
| 3 | NumberTheoryGame (k88-b) | 66 / 50 | `Mathlib.Tactic` umbrella → explicit subset; `gameHave` custom tactic; full `Cases` (`induction'`) |
| 4 | RealAnalysisGame (AlexKontorovich) | 183 / 136 | full `Cases`; `Analysis.SpecialFunctions.Log.Base` absent from the pack (drop or restate); custom Linarith/Rw wrappers unverified on this pin |
| 5 | Robo (hhu-adam) | 189 / 156 | seven compat leaves (`Cases`, `Generalize`, `Have`, `*.Star` ×3 absent from the pack); large custom simp/tactic layer; four-language key-style i18n; 248 MB of images (service-worker precache must stop precaching `/data`); the largest region |
| 6 | lean4game-logic (Trequetrum) | 103 / 88 | `Mathlib.Tactic` umbrella; v4.7.0-era syntax (largest drift); `Languages "English"` |
| — | LinearAlgebraGame (ZRTMRH) | 551 Mathlib imports, 297 missing | blocked on pack scope |
