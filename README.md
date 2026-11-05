# Lean 4 Game, in your browser

A fork of [lean4game](https://github.com/leanprover-community/lean4game) whose
games run entirely in the browser tab. There is no Lean server behind it.

**Play:** <https://lean4game.fawadworkaddress.workers.dev>

This fork is not run by the lean4game team. Upstream's server-hosted version is
at [adam.math.hhu.de](https://adam.math.hhu.de). This branch,
[`wasm64-port`](https://github.com/FawadHa1der/lean4game/tree/wasm64-port), is
the one that deploys.

## What "no server" means

- **Lean runs in the tab.** Lean 4.35.0, compiled to 64-bit WebAssembly
  (Memory64), checks your proof in Web Workers inside the page, against the game's
  environment (the game, GameServer and Mathlib), which is downloaded as data. What
  you type stays on your computer, and your progress is saved in your browser's
  storage.
- **The host only serves files.** A Cloudflare Worker and R2 serve the page and
  its downloads and answer only `GET` and `HEAD`. No Lean process runs there.
- **The first visit downloads, later visits start in seconds.** The checker is
  106 MB, once. Each game's environment is a further 154-362 MB, which unpacks to
  0.6-1.3 GB and stays in browser storage. A level you have played reloads with
  the network off.
- **What you need.** A recent desktop Chrome or Edge and a few GB of free memory.
  Firefox has the WebAssembly features this needs, and QED64 runs in it, but this
  site has not been tested there yet. Safari does not ship Memory64 yet.

## Known limits

- A browser gives Lean far less stack than a native process. Some deeply recursive
  steps fail here although native Lean accepts them: Lean reports "the WebAssembly
  runtime's stack is exhausted" on the line, or checking pauses with "Lean ran out
  of the browser's stack". This includes the reference proofs of RAG Lecture15/1
  and Lecture24/3 and Robo Euklid/4; [wasm/UX-PARITY.md](wasm/UX-PARITY.md) lists
  the cases found.
- Logic IffTactic/5, played step by step to the end, runs the checker out of
  memory near step 80, and the checker restarts
  ([wasm/UX-PARITY.md](wasm/UX-PARITY.md)).
- Games are compiled and packed ahead of time, so this site cannot load a game
  from a URL the way upstream's server can.
  [wasm/PORTING.md](wasm/PORTING.md) describes how a game is ported.

## How it fits together

| Repository | Role |
| --- | --- |
| [lean4game, `wasm64-port`](https://github.com/FawadHa1der/lean4game/tree/wasm64-port) (this one) | The game interface, the catalog of nine games (plus a test game) with their ports, the build and the site |
| [QED64](https://github.com/FawadHa1der/QED64) | The library that runs Lean in a web page: workers, the language-server relay, environment snapshots. A git dependency, pinned by commit in `client/package.json` |
| [lean4, wasm64 fork](https://github.com/FawadHa1der/lean4/tree/qed64-wasm64) | Lean built for wasm64 on branch `qed64-wasm64`: the runtime and library packs, published as toolchain releases (today [`lean-v4.35.0-b081e7c`](https://github.com/FawadHa1der/lean4/releases/tag/lean-v4.35.0-b081e7c)) |
| [lean4game, upstream](https://github.com/leanprover-community/lean4game) | The original game engine and interface |

`server/` (GameServer) is compiled into each game's environment, so it runs in
the tab too. `relay/` is upstream's Node server, which connects the browser to
`lake serve` over a websocket; this build does not use it. (The relay in QED64's
row is a different thing: a class inside the page, between the editor and the
Lean worker.)

## Building it

Building from a clean clone needs no QED64 checkout: the runtime's
browser-side code, worker scripts and pipeline scripts are the `qed64` npm
package, a git dependency pinned by commit in `client/package.json`
([wasm/KERNEL.md](wasm/KERNEL.md), "The qed64 dependency").

```bash
git clone -b wasm64-port https://github.com/FawadHa1der/lean4game && cd lean4game
npm ci                              # also fetches qed64 at its pinned commit (an https tarball: no git, no SSH)
scripts/stage-workers.sh            # the qed64 worker scripts -> client/public/workers
npm --workspace client run build    # -> client/dist
```

To play locally, fetch the runtime and the game snapshots from the live site
before that build, then serve it:

```bash
node scripts/fetch-artifacts.mjs     # the runtime and all ten games, 2.6 GB (--only nng4 for one game: 260 MB)
npm --workspace client run build     # copies them into client/dist
node scripts/serve-dist.mjs          # http://localhost:3006 with the COOP/COEP headers the worker needs
```

This works for a checkout of what is live: the live site serves one runtime, and
a checkout that names another gets a 404 and a message saying what to do
([wasm/KERNEL.md](wasm/KERNEL.md), "Rebuilding from a clone"). Games not fetched
stay listed, and opening one shows a card saying its environment is "not published
for this build"; rerunning the fetch and the build adds them.

### Building the artifacts from source

The Lean toolchain is not built here: the game pins one **toolchain
release** of the kernel fork (github.com/FawadHa1der/lean4,
`lean-v4.35.0-b081e7c`: Lean 4.35.0, runtime `wasm64-36d7f415704473d9`) —
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

### Deploying

A push to `wasm64-port` runs the tests and deploys the site:
[wasm/DEPLOY.md](wasm/DEPLOY.md).

## Upstream's documentation

Everything from here on is upstream lean4game's documentation, with notes for this
build under Security, Contact and Credits. Its documents describe the
server-hosted version, including hosting and publishing to `adam.math.hhu.de`. For
this build, see [wasm/KERNEL.md](wasm/KERNEL.md),
[wasm/DEPLOY.md](wasm/DEPLOY.md), [wasm/PORTING.md](wasm/PORTING.md) and
[wasm/UX-PARITY.md](wasm/UX-PARITY.md).

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

Upstream gives users access to a Lean instance on its server, which is a severe security risk, so it starts the Lean server with bubblewrap. In this build Lean runs inside the visitor's own browser sandbox, so there is no server-side Lean to protect.

## Contact

These are upstream's contacts. In case of a server outage at `adam.math.hhu.de` please open an [issue](https://github.com/leanprover-community/lean4game/issues) and/or contact them by <a href="mailto:adam@math.hhu.de?subject=Server Outage">email</a>.  Bug reports and feature requests regarding upstream's game interface should be filed on [its issues page](https://github.com/leanprover-community/lean4game/issues).   For specific games on the [Lean Game Server](https://adam.math.hhu.de), please refer to the github repositories linked to below or contact the maintainers.

| Game/repository                                                                   | Maintainer                                              |
|-----------------------------------------------------------------------------------|---------------------------------------------------------|
| [Knights and Knaves](https://github.com/jadabouhawili/knightsandknaves-lean4game) | [Jad Abou Hawili](https://github.com/JadAbouHawili)     |
| [Linear Algebra Game](https://github.com/zrtmrh/linearalgebragame)                | [ZRTMRH](https://github.com/ZRTMRH)                     |
| [Logic Game](https://github.com/trequetrum/lean4game-logic)                       | [Trequetrum](https://github.com/Trequetrum)             |
| [Natural Number Game (NNG)](https://github.com/leanprover-community/nng4)         | [Kevin Buzzard](https://github.com/kbuzzard)            |
| [Real Analysis Game](https://github.com/alexkontorovich/realanalysisgame)         | [Alex Kontorovich](https://github.com/AlexKontorovich)  |
| [Reintroduction to Proofs](https://github.com/emilyriehl/reintroductiontoproofs)  | [Emily Riehl](https://github.com/emilyriehl)            |
| [Robo / Scribble](https://github.com/hhu-adam/robo)                               | [Marcus Zibrowius](https://github.com/TentativeConvert) |
| [Set Theory Game](https://github.com/djvelleman/stg4)                             | [Dan Velleman](https://github.com/djvelleman)           |
| [Number Theory Game](https://github.com/k88-b/NumberTheoryGame)                   | [k88-b](https://github.com/k88-b)                       |


## Credits

lean4game has primarily been developed by Alexander Bentkamp and Jon Eugster. The in-browser build is by [FawadHa1der](https://github.com/FawadHa1der).

It is based on ideas from the [Lean Game Maker](https://github.com/mpedramfar/Lean-game-maker) and the [Natural Number Game
(NNG)](https://www.ma.imperial.ac.uk/~buzzard/xena/natural_number_game/)
by Kevin Buzzard and Mohammad Pedramfar, and on Patrick Massot's prototype: [NNG4](https://github.com/PatrickMassot/NNG4).
