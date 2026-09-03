# Game source patches

## nng4-wasm64-port.patch

The Natural Number Game port to this build's Lean fork (4.33.0-pre): one
commit over `hhu-adam/NNG4` `main` @ 360d797 (drops five vestigial imports,
vendors `Game/Tactic/MathlibCases.lean` and `Game/Tactic/MathlibHave.lean`
from Mathlib v4.23.0, regenerates the `.pot` template). The same commit is
pushed as `FawadHa1der/NNG4` branch `wasm64-port` (7f67c24); this file is the
belt-and-braces copy so a clone of this repo alone can re-derive the game
sources:

```bash
git clone https://github.com/hhu-adam/NNG4 games-src/NNG4
git -C games-src/NNG4 checkout 360d797
git -C games-src/NNG4 am ../../wasm/patches/nng4-wasm64-port.patch
```

The compiled gamedata these sources produce (`client/public/data/g/hhu-adam/NNG4`)
is tracked in git, so the sources are only needed to change the game or to
rebake its environment snapshot (wasm/KERNEL.md).
