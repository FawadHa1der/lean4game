# Game source patches

A patch is the `source.patch` of a game's row in `wasm/catalog.json`: the
games lane (`wasm/build-from-source.sh`) applies it with `git am` right after
cloning `source.url` at `source.rev` into the row's `src` (`games-src/` is
gitignored), so a clone of this repo alone can re-derive every game's sources.
A patch carries source changes only — never the `.i18n/*/Game.pot` template
(the compile regenerates it and the lane restores it).

## What needs no patch: `Mathlib.Tactic.Have` / `Mathlib.Tactic.Cases`

Both modules are **excluded from the essential Mathlib pack** this build ships
(they remain in mathlib4 upstream). Since the `compat` lane, `wasm/compat`
compiles them under their real module names into the game base tree
(`wasm/compat/README.md`), so a game whose only gap is one of those two
imports — STG4, for instance — needs **no patch at all**. NNG4's in-tree
copies (`Game/Tactic/MathlibHave.lean`, `MathlibCases.lean`, different module
names) keep working exactly as baked until its next rebake; at that point
its patch can shrink to the import drops below.

## nng4-wasm64-port.patch

The Natural Number Game port to this build's Lean fork (4.33.0-pre): one
commit over `hhu-adam/NNG4` `main` @ 360d797 (drops five vestigial imports,
vendors `Game/Tactic/MathlibCases.lean` and `Game/Tactic/MathlibHave.lean`
from Mathlib v4.23.0 — now also provided by `wasm/compat` — and regenerates
the `.pot` template, which newer patches must leave out). The same commit is
pushed as `FawadHa1der/NNG4` branch `wasm64-port` (7f67c24); this file is the
belt-and-braces copy the catalog row points at:

```bash
git clone https://github.com/hhu-adam/NNG4 games-src/NNG4
git -C games-src/NNG4 checkout 360d797
git -C games-src/NNG4 am ../../wasm/patches/nng4-wasm64-port.patch
```

(what `wasm/build-from-source.sh --lanes games --games nng4` does when
`games-src/NNG4` is absent.) The compiled gamedata these sources produce
(`client/public/data/g/hhu-adam/NNG4`) is tracked in git, so the sources are
only needed to change the game or to rebake its environment snapshot
(wasm/KERNEL.md).
