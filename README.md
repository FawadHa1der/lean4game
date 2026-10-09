# Lean 4 Game

This is the source code for the Lean Game Server hosted at [adam.math.hhu.de](https://adam.math.hhu.de).

## The in-browser (wasm64) build

This fork runs the Lean server in the browser tab, on the QED64 wasm64 runtime.
Building it from a clean clone needs no QED64 checkout: the runtime's
browser-side code, worker scripts and pipeline scripts are the `qed64` npm
package, a git dependency pinned by commit in `client/package.json`
([wasm/KERNEL.md](wasm/KERNEL.md), "The qed64 dependency").

```bash
git clone -b wasm64-port https://github.com/FawadHa1der/lean4game && cd lean4game
npm ci                              # also fetches qed64 at its pinned commit (an https tarball: no git, no SSH)
scripts/stage-workers.sh            # the qed64 worker scripts -> client/public/workers
npm --workspace client run build    # -> client/dist
```

To play locally, fetch the runtime and the game snapshots first
(`scripts/fetch-artifacts.sh`, ~2.8 GB for the ten games; the bundle named in
`wasm/artifacts/BUNDLE.json` must have been published) and serve the build
with `node scripts/serve-dist.mjs` — [wasm/KERNEL.md](wasm/KERNEL.md),
"Rebuilding from a clone".

### Building the artifacts from source

The Lean toolchain is not built here: the game pins one **toolchain
release** of the kernel fork (github.com/FawadHa1der/lean4,
`lean-v4.34.0-41ec565`: Lean 4.34.0, runtime `wasm64-57ae00dc5f6ce958`) —
the root `package.json` devDependency `lean4-wasm64` (the release's tools
tgz) and `wasm/lean4-wasm64-release.json` (a byte copy of its
`release.json`: id, self-digest, runtime build id, kernel patch, packs,
native compiler). `wasm/build-from-source.sh` fetches and verifies that
release, compiles lean-i18n, GameServer and every game in
`wasm/catalog.json` with the release's native compiler, bakes one
environment snapshot per game with QED64's pipeline (from the `qed64`
package) and stages the client bundle:

```bash
npm ci
wasm/build-from-source.sh --plan                                  # every step, nothing runs
wasm/build-from-source.sh --verify-snapshots                      # everything (~4 h for ten games)
wasm/build-from-source.sh --lanes games,bake --games stg4 --verify-snapshots   # one game
```

It needs Docker that runs `linux/arm64` containers (native on Apple silicon;
an x86_64 host needs qemu emulation — Docker Desktop has it), Node ≥ 24,
python3, rsync, ~25 GB of disk and ~2.3 GB of downloads; the lane builds its
own ~40 MB image from `wasm/docker/Dockerfile`. Lanes, checks and the
release bump: [wasm/KERNEL.md](wasm/KERNEL.md) ("Toolchain dependency",
"Building the artifacts from the toolchain release"); porting a game:
[wasm/PORTING.md](wasm/PORTING.md).

## Creating a Game

Please follow the tutorial [Creating a Game](doc/create_game.md). In particular, the following steps may be of interest:

* Step 6: [How to Run Games Locally](doc/running_locally.md)
* Step 8: [How to Update an existing Game](doc/update_game.md)
* Step 10: [How to Publish a Game](doc/publish_game.md)
* [Troubleshooting](doc/troubleshoot.md)

## Documentation

The documentation is very much work in progress but the links below should be up-to-date:

### Game creation API

- [Creating a Game](doc/create_game.md): **the main document to consult**.
- [More about Hints](doc/hints.md): describes the `Hint` and `Branch` tactics.

### Frontend API

* [How to Run Games Locally](doc/running_locally.md): play a game on your computer
* [How to Update an existing Game](doc/update_game.md): update to a new lean version
* [How to Publish a Game](doc/publish_game.md): load your game to adam.math.hhu.de for others to play

### Backend

* [Server](doc/DOCUMENTATION.md): describes the server part (i.e. the content of `server/` and `relay/`).

### Hosting
* [How to host a lean4game instance yourself](doc/hosting.md): how to set up your own Lean Game Server

## Contributing

Contributions to `lean4game` are always welcome!

Check out the [Development Instructions](./doc/development.md)

### Translation

We welcome translations of the game interface and of the various games hosted on the [Lean Game Server](https://adam.math.hhu.de) into different languages!

* For translating the *interface*, please refer to [these instructions](doc/translation-interface.md).
* For translating *individual games*, please contact the maintainers (see [table below](#contact)) and consult any game specific translation guidelines.  Our [generic guidlines](doc/translation-guide-for-game-translators.md) may give a rough indication of the steps involved.
* We also have some [guidelines for game maintainers](doc/translation-guide-for-game-maintainers.md) regarding translations.

## Security

Providing the use access to a Lean instance running on the server is a severe security risk. That is why we start the Lean server with bubblewrap.

## Contact

In case of a server outage at `adam.math.hhu.de` please open an [issue](issues) and/or contact us by <a href="mailto:adam@math.hhu.de?subject=Server Outage">email</a>.  Bug reports and feature requests regarding the game interface should be filed on the [issues page](issues) of this repository.   For specific games on the [Lean Game Server](https://adam.math.hhu.de), please refer to the github repositories linked to below or contact the maintainers.

| Game/repository                                                                   | Maintainer                                              |
|-----------------------------------------------------------------------------------|---------------------------------------------------------|
| [Knights and Knaves](https://github.com/jadabouhawili/knightsandknaves-lean4game) | [Jad Abou Hawili](https://github.com/JadAbouHawili)     |
| [Linear Algebra Game](https://github.com/zrtmrh/linearalgebragame)                | [ZRTMRH](https://github.com/ZRTMRH)                     |
| [Logic Game](https://github.com/trequetrum/lean4game-logic)                       | [Trequetrum](https://github.com/Trequetrum)             |
| [Natural Number Game (NNG)](https://github.com/leanprover-community/nng4)         | [Kevin Buzzard](https://github.com/kbuzzard)            |
| [Real Analysis Game](https://github.com/alexkontorovich/realanalysisgame)         | [Alex Kontorovich](https://github.com/AlexKontorovich)  |
| [Reintroduction to Proofs](https://github.com/emilyriehl/reintroductiontoproofs)  | [Emily Riehl](https://github.com/emilyriehl)            |
| [Robo / Scribble](https://github.com/hhu-adam/robo)                               | [Marcus Zibrowius](https://github.com/TentativeConvert) |
| [Set Theory Game](https://github.com/djvelleman/stg4)                             | [Dan Velleman](https://github.com/djvelleman)


## Credits

The project has primarily been developed by Alexander Bentkamp and Jon Eugster.

It is based on ideas from the [Lean Game Maker](https://github.com/mpedramfar/Lean-game-maker) and the [Natural Number Game
(NNG)](https://www.ma.imperial.ac.uk/~buzzard/xena/natural_number_game/)
by Kevin Buzzard and Mohammad Pedramfar, and on Patrick Massot's prototype: [NNG4](https://github.com/PatrickMassot/NNG4).
