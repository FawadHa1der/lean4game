# Deploying the wasm64 game to Cloudflare

Same shape as the QED64 editor (`qed64/docs/DEPLOY.md`): the app shell is a
**Cloudflare Worker with static assets**, the multi-GB artifacts stream from
**R2**, one origin, cross-origin isolation headers on every response
(`infra/worker.js`; `client/public/_headers` is the defensive copy). Free
tier: R2 10 GB with zero egress, Workers 100 k requests/day.

`infra/worker.js` is QED64's edge-worker library, `qed64/edge` from the
pinned `qed64` package (QED64 `docs/DEPLOY.md`, "Using qed64/edge in your
own Worker", since the QED64 `385a1ac` pin): `createWorker({ r2Prefix:
"lean4game/", release, isImmutable, decorate, extraRoutes })` with the
hardened defaults on (`siteWorker(record)` builds it; the default export is
`siteWorker()` for `wasm/lean4-wasm64-release.json`). The site adds the
SEC1 `Content-Security-Policy` (`decorate`), vite's hashed `/assets/`
bundles as immutable (`isImmutable` is the library's own `isImmutable`,
imported, plus that one rule) and its two indexes from the deploy's assets
(`extraRoutes`, "Deploy, in order" below); everything else below (routing,
caching, ranges, HEAD) is the library's. Wrangler bundles it from the workspace's hoisted
`node_modules/qed64` (`infra/worker.test.mjs` checks it is the client's
install). Next to the pre-library worker it is stricter or adds in four
places: GET and HEAD only on artifacts (anything else 405 with `Allow: GET,
HEAD`, no-store); a binding that throws or is missing answers 500
"internal error" with the isolation headers, the CSP and no-store instead
of Cloudflare's error page; a full artifact GET states its
`Content-Length`, and an asset HEAD gets the length a GET would (one extra
GET to the assets binding); the release record is checked by the
library's rules (a re-cut `-r<N>` id is accepted).

| Piece | Where | Size |
|---|---|---|
| App shell (`client/dist` minus artifact dirs) and the site's two indexes (`/snapshots/index.json`, `/profiles/index.json`) | Workers static assets, `wasm/out/deploy` | ~127 MB, ~2,200 files, largest 22.9 MiB (cap 25 MiB) |
| Lean runtime chunks, Lean core pack (`/runtime/*`, `/profiles/*`) | R2 bucket `qed64-artifacts`, prefix `lean4-wasm64/<release id>/`: the lean4 fork's toolchain release, shared with the QED64 editor and the widgets showcase, uploaded once by the release owner | runtime 106 MB, core pack 119 MB |
| Game snapshots (`/snapshots/*.snapz`, digest-named) | R2 bucket `qed64-artifacts`, prefix `lean4game/` | ten slim game snapshots ~2.5 GB on the wire (each game is downloaded only when first played) |

Two owners, two prefixes (the release's hosting rules,
`wasm64-build/js/formats/HOSTING.md` in the lean4 fork). The release id and
the mapping come from `wasm/lean4-wasm64-release.json`, the release record
the bake pins: `infra/worker.js` imports it, maps `/runtime/*` and
`/profiles/*` onto the release's `runtime/` and `profiles/`
(`hosting.mount`), keeps `hosting.siteOwned` (`/profiles/index.json`,
`/snapshots/*`) off the release, and reads site-owned objects under
`lean4game/`. The browser only sees this origin; the release prefix is proxied,
never linked. A toolchain bump is therefore one file (the record) plus a
rebake, or the record alone for a tools re-cut of the same runtime and packs
(`<id>-r<N>`); the worker follows it on the next deploy. The bucket is shared with the
editor; the `lean4game/` prefix keeps the two sites' objects apart and lets the
existing bucket-scoped upload token serve both.

A clone reads this origin too: `scripts/fetch-artifacts.mjs` GETs the runtime
chunks and `.snapz` a checkout's tracked manifest and index name, for local play
(`wasm/KERNEL.md`, "Rebuilding from a clone"). No other copy is published. It
works for a checkout of what is live: once a deploy moves the Worker to another
release, an older checkout's chunk names answer 404, and the script tells that
person to `git pull`.

## Deploy, in order

One `wrangler deploy` carries everything a boot reads that is not
digest-named: the shell (`client/dist`), the Worker with the release record it
bundles (`wasm/lean4-wasm64-release.json`), and the site's two indexes,
`/snapshots/index.json` and `/profiles/index.json`. Workers static assets are
versioned with the Worker, so a deploy switches the three together (QED64's
architecture review D2; its `docs/DEPLOY.md` "Atomic deploys" is the model).
This replaced the two-step upload of 2026-10-08 (`wasm/UX-PARITY.md`, "Atomic
deploys"). An upload changes nothing a deployed shell reads: a new `.snapz` is
inert in R2 until the deploy of the index that names it.

0. **The toolchain release in R2** (once per release, by its owner): the
   staged release directory under `lean4-wasm64/<release id>/`, with the
   three `rclone copy` commands the lean4 fork's
   `wasm64-build/stage-release.sh` prints (HOSTING.md, "Where a release
   lives"; immutable, digest-named objects first, `release.json` last).
   Step 1 refuses to run until it is there. The release must also be
   **published on GitHub** before the branch that pins it reaches
   `wasm64-port`: the root devDependency `lean4-wasm64` is the release's
   GitHub tgz, and `.github/workflows/deploy.yml` runs `npm ci` on every
   push there (`wasm/KERNEL.md`, "The pin" — the Lean 4.35 pin
   `lean-v4.35.0-b081e7c` was staged, not published, when this branch was
   built).
1. `scripts/upload-artifacts.sh` — **before the push**. Preflights
   `client/public` (`scripts/preflight-artifacts.mjs`: every chunk, profile
   part and snapshot present and paired to the manifest's build id), checks
   that the served runtime is the release record's and that R2's
   `lean4-wasm64/<release id>/release.json` is byte-identical to
   `wasm/lean4-wasm64-release.json` (else it prints the release upload and
   stops), then `rclone copy` (never sync) of every `.snapz` into
   `lean4game/snapshots/`, and nothing else: no index, no copy. Needs the
   `qed64-r2` rclone remote (R2 API token scoped to the bucket, see the
   QED64 doc). Later runs transfer only changed snapshots.
2. `scripts/deploy-app.sh`, which is what a push to `wasm64-port` runs in CI —
   stages the worker scripts the qed64 package's
   `embedding/closure.json` names into `client/public/workers/` (gitignored, generated;
   `scripts/stage-workers.sh` — a clean checkout has none and a shell
   deployed without them hangs at "starting Lean"), builds the client, copies
   `client/dist` into `wasm/out/deploy` without `runtime/ profiles/ snapshots/`
   but for exactly `snapshots/index.json` and `profiles/index.json`, refuses
   (exit 3) a tree that lacks one of the two or holds other bytes than the
   tracked `client/public` file (a stale `SKIP_BUILD=1` tree) and files over 25
   MiB, runs the guard (`scripts/deploy-guard.mjs`, below) and runs `wrangler
   deploy` (wrangler 4.125.0 is a root dev dependency; `npx wrangler login`
   once). Live at `https://lean4game.<account>.workers.dev`.

Release first, then the `.snapz`, then the one deploy: a shell only ever
references objects that already exist, and the indexes never change ahead of
the shell that pairs with them. `infra/worker.js` answers a GET or HEAD of
exactly those two index paths from `ASSETS` (one `extraRoutes` entry); any
other method, an overlay's own `/snapshots/<dir>/index.json` and R2's frozen
files stay on the artifact route. The boot reads the fixed names:
`/runtime/runtime-manifest.json`, which the Worker reads from the release it
bundles, and `/snapshots/index.json`. No pinned manifest and no per-build copy:
the build defines no `__QED64_BUILD_ID__`, the option-less `qed64` loaders then
read only those names (QED64 EMBEDDING §6.1), and `client/src/wasm/boot-params.test.ts`
pins it. The service worker precaches the two indexes and the runtime manifest
at install, so the offline path finds them (`scripts/build-sw.mjs`).

A tab left open across a runtime deploy mostly plays on, and where it cannot, a
reload is the cure. Seen in a browser on the real Worker under local workerd with
a simulated second runtime (2026-11-02). Both sides had the same bundle and worker
scripts, so a lazy chunk gone from the new deploy and QED64's worker revision check
(the stale-page card) did not come into it; those are still read from the code.

- A tab already playing goes on. A restart after a stack pause reads the outgoing
  chunks from the service worker or the browser's HTTP cache, and the new Worker is
  not asked.
- A tab that resolved its manifest and index (memoised per page; the landing page
  does it) boots the outgoing runtime and plays, if this browser holds its chunks.
  If nothing does (a first visit still on the landing page), the new Worker's release
  answers 404: three tries in about 3 s, nothing on the world map, then on a level
  "Lean could not start in your browser: lean.js chunk 0: HTTP 404" with Reload,
  which boots the new runtime.
- A tab that resolved neither reads the new manifest and the new index, which pair,
  and boots the new runtime on its old page code.

A tab of a shell from before this scheme, across a later runtime deploy: from the
code, not seen, it reads R2's frozen per-runtime copy and refuses "not published for
this build" with its Reload button.

Shell-only changes (this repo's client code) need step 2 alone. A snapshot
rebake or a new game for the SAME runtime takes steps 1 and 2, and is visible
at the deploy. A runtime rebuild needs all of 0-2, and so does **any other change
to the release record**, even one with the same runtime and no rebake (a tools
re-cut, `<id>-r<N>`). The Worker maps `/runtime/*` and `/profiles/*` by the
record's id, so a push before that release is in R2 answers 404 to every runtime
manifest fetch and takes down every boot. With no new `.snapz` the guard passes
it: step 1 is the only check that R2 holds the release, and nothing on the push
path repeats it.

`.github/workflows/deploy.yml` runs step 2 on every push to `wasm64-port`
when the fork has the `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit only)
and `CLOUDFLARE_ACCOUNT_ID` secrets; without them it logs a skip. A fork with
its own Worker also sets the repository variable `LEAN4GAME_DEPLOY_ORIGIN` to
its origin, or the guard asks this site's. The workflow has no R2 credentials,
so it can neither run step 1 nor check the release in R2: finish step 1 BEFORE the push. A push that names a `.snapz` before step 1 has
sent it deploys nothing (the guard refuses; after the upload, 'Re-run failed
jobs' on the refused run, or a new push).

**The guard** (`scripts/deploy-guard.mjs`, QED64's review R19a; also under
`--dry-run`, and in CI, which deploys through `deploy-app.sh`). First, with no
network, the pairing: `wasm/lean4-wasm64-release.json`'s `runtime.buildId`,
`client/public/runtime/runtime-manifest.json`'s `buildId`,
`client/public/profiles/index.json`'s `runtime.buildId` and every entry's
`runtime` in `client/public/snapshots/index.json` must be one id, and that index
must name a snapshot; otherwise exit 1 and nothing deploys. These files ride in
one deploy, so a mispaired commit (a partial revert, a record bump pushed without
its rebake) would make every boot refuse every game. Keep them in one commit.
`scripts/deploy-guard.test.mjs` runs the same check on the tracked files, so the
test job catches it first.

Then, before the deploy, one HEAD on the live origin for every `.snapz` that the
tracked index names. A 404, a size other than the index's, or a 5xx or network
error after three tries (2 s, then 4 s) refuses, exit 1, and nothing deploys:
upload, then re-run the deploy ('Re-run failed jobs' in CI: the refused run's
commit is still the head). `LEAN4GAME_DEPLOY_ORIGIN=<url>` or `--origin <url>`
asks another origin, and `none` skips this live check, never the pairing (a first
deploy to a new origin). It checks only site-owned files, which every Worker of this site serves from
the same key under `lean4game/`. Release-mapped files (`/runtime/*`,
`/profiles/<not index.json>`) are never checked through the live origin: the
live Worker maps them into its own release, so a new release's chunks would 404
and its fixed-name manifests would give a false pass. That check is step 1's
(R2's `release.json` against the record). A release adopted with a rebake has new
`.snapz` names, so the guard also refuses it when pushed before its upload; with
no rebake (see above) the guard passes it, in R2 or not.
Tests: `scripts/deploy-guard.test.mjs`, `scripts/deploy-app.test.mjs`.

The workflow's test job runs first and needs no secrets: `npm ci` and
`scripts/test-all.sh`, every `*.test.ts` and `*.test.mjs` under `client/src`,
`infra` and `scripts` (found there, so a new file needs no list). The deploy
job `needs:` it, so a failing test deploys nothing. Deploys go one at a time,
in push order: the runs of `wasm64-port` share one concurrency group
(`lean4game-deploy-<ref>`, `cancel-in-progress: false`), so a run waits for the
deploy before it, a newer push replaces a run still waiting, and a running deploy
is never cancelled midway. A run on another branch sits in its own group and
deploys nothing. GitHub offers 'Run workflow' only for a workflow on the default
branch, and `main` has `test.yml` but not `deploy.yml`, so re-run a refused deploy
with 'Re-run failed jobs' or a new push. Should the file reach `main`, a manual
run still deploys only on `wasm64-port`. Just before
`scripts/deploy-app.sh` a one-line `git ls-remote` check refuses unless the
run's commit is still that branch's head. So a 'Re-run jobs' of an older run
never deploys over a newer commit, and it is no way to roll back ("Rollback"
below). It does join the group and can replace the head's waiting run: if the
head's run shows cancelled, re-run it. With the indexes inside the
deploy, an older commit deployed over a newer one would serve the older index,
which is why this matters.

### R2's frozen indexes and the per-runtime copies

From the two-step upload (2026-10-08 to 2026-11), R2 still holds, under
`lean4game/`:

| Key | What it was |
|---|---|
| `snapshots/index.json`, `profiles/index.json` | the mutable pointers |
| `snapshots/index.<buildId>.json`, `snapshots/profiles-index.<buildId>.json` | the per-runtime copies (QED64 HARDENING #64) |

- Only a Worker version from before the change reads the two pointers, and only
  a shell from before it reads the copies. Nothing writes them any more
  (`scripts/upload-artifacts.sh` sends `.snapz` alone and takes no arguments), and
  they stay **frozen** while such a version is a rollback target. Never run an
  `upload-artifacts.sh` from before the change: it would rewrite them.
- Locally nothing writes the copies either: `scripts/stage-snapshots.py` and
  the bundle lane stopped, and the next staging removes leftovers. QED64's bake
  still writes `index.<buildId>.json` beside its index in the staging dir; it
  is never staged or uploaded. `.gitignore` keeps the names for such leftovers.
  `runtime/runtime-manifest.<buildId>.json` is the release's own file: it stays
  in the release, and a `?runtime=<id>` override reads it, but this site neither
  copies it nor reads it otherwise.
- Caching: `qed64/edge`'s rule keeps revalidating the frozen copies despite the
  hex in their names, and QED64 keeps `resolveRuntimeManifest`'s
  `pinnedBuildId`, `loadSnapshotIndex`'s `pairedBuildId` and that rule until this
  site and the showcase have retired their copies.

### R2 clean-up

Nothing in this repo deletes from R2; a delete is the user's, by exact keys only
(`rclone delete --files-from-raw <list> --dry-run` first), and only of keys no
rollback-target version names. A version from this change on names its `.snapz`
in `git show <commit>:client/public/snapshots/index.json`; a version from before
names them through R2's frozen `snapshots/index.json`.

The Worker version that was live when this change was first pushed stays a
rollback target until the next runtime adoption after it is live and stable
(QED64's default, chosen 2026-11-01). Then the four kinds of key in the table
above can go, which leaves only digest-named `.snapz` under `lean4game/`.
Superseded `.snapz` are garbage-collected the same way, deliberately, once no
rollback needs them.

### The first deploy of this scheme

The live Worker is the pre-change one (`wasm64-port` `1771ed3`, or whatever is
live by then).

1. Before pushing, both commands must print nothing:

   ```bash
   curl -s https://lean4game.fawadworkaddress.workers.dev/snapshots/index.json | cmp - client/public/snapshots/index.json
   curl -s https://lean4game.fawadworkaddress.workers.dev/profiles/index.json | cmp - client/public/profiles/index.json
   ```

   If one differs, R2 serves an uncommitted pairing: resolve it before pushing.
   (Checked by HEAD on 2026-11-02: both ETags are the tracked files' MD5.) Note
   the live commit and its Worker version (`npx wrangler deployments list`, or the
   "Current Version ID" line in that commit's deploy run): it is the pre-change
   rollback target. `wrangler rollback` takes a version id. With none it picks the
   deployment before the current one, which stops being this one at the next deploy.
2. No upload is needed (the same pairing).
3. Push the guard, `deploy.yml`'s fixes and this change in one push. The guard
   checks the ten `.snapz` through the old Worker; the key is the same under both
   Workers (run on 2026-11-02: 10 of 10 live, sizes equal).
4. Run the live checks below.
5. From then on, upload only with an `upload-artifacts.sh` from this change on.

Seen in a local simulation (2026-11-02): 1771ed3's own Worker and shell over a local
R2 holding its pointers, copies and pinned manifest, then this Worker and deploy tree
over the same R2, with no upload at any switch. Tabs of the old shell left open keep
playing, boot another game, and one that had read nothing boots. A reload gets the
new shell, which asks for no copy, and plays, offline too. The old Worker back, as
`wrangler rollback` would restore it, serves R2's frozen index and the old shell and
plays; forward again plays.

**Live checks** (`…` is `https://lean4game.fawadworkaddress.workers.dev`,
`<snapz>` the file name in an entry's `url` in `client/public/snapshots/index.json`,
such as `testgame.8c34115c6d4b983f.snapz`):

- `curl -sI …/snapshots/index.json`, `curl -sI …/profiles/index.json`: 200,
  `public, max-age=0, must-revalidate`, `application/json`, COOP, COEP, CORP
  and the CSP. `curl -s` of each, `cmp` with the tracked file: no output.
- `curl -sI "…/snapshots/index.json?probe=1"`: 200 (the page's network probe).
- `curl -s -o /dev/null -w '%{http_code}\n' -X POST …/snapshots/index.json`: 405.
- `curl -sI …/snapshots/<snapz>`: 200, immutable, `content-length` the entry's
  `transfer`; `curl -s -o /dev/null -w '%{http_code}\n' -r 0-9 …/snapshots/<snapz>`: 206.
- `curl -sI …/snapshots/x.0123456789abcdef.snapz`: 404, `no-store`.
- `curl -sI …/runtime/chunks/x.part-000`: 404, `no-store`.
- Open a level on a fresh profile, then reload it offline ("The service worker").

## Adding a game

The catalog (`wasm/catalog.json`) is the only place a game is named; the
port itself — survey, source pin and patch, options, probe, languages — is
`wasm/PORTING.md`. The publish order for a finished port:

1. **Catalog row**, `node scripts/games-manifest.mjs --check` exits 0.
2. **Build lanes** (Docker, `wasm/build-from-source.sh`; flags per its
   header): once per toolchain release `--lanes preflight,release,trees`
   (fetch and verify the pinned release, unpack its packs, compile
   lean-i18n and GameServer), then `--lanes games,bake --games <snapshot>
   --verify-snapshots`: compiles the game with the release's native
   compiler, overlays its slim tree, bakes `<snapshot>.<digest>.snapz` into
   `wasm/out/staging/<runtime build id>/snapshots` and probes it (every
   catalog probe of the row — the document the browser sends,
   `games-manifest.mjs --probe` — through the wasm runtime on the snapshot
   and natively on the same tree, each closing with no message, plus a
   negative control that must fail on both); record the
   printed raw size in the row's `expectedRaw`. Run each bake under the
   host's browser lock (`with-browser-lock.sh lean4game …`), one game per
   hold.
3. **Stage**: `--lanes bundle`, i.e. `scripts/stage-snapshots.py
   wasm/out/staging/<build id>/snapshots <snapshot>` (copies the `.snapz` and
   upserts `client/public/snapshots/index.json`), `scripts/stage-game-assets.sh`
   (`client/public/{data,i18n}/<id>` and `api/games` for every catalog
   row) and the client build. Smoke it locally with
   `node /Users/fawadhaider/code/wasm64-lean-fable/qed64/work/games-smoke.mjs http://localhost:3006`
   (the script lives in the QED64 checkout's `work/`, not in this repo)
   over `scripts/serve-dist.mjs`, commit locally, do not push.
4. **Upload, before the deploy**: `scripts/upload-artifacts.sh` — the new
   `.snapz`; nothing a visitor reads changes.
5. **Deploy**: `scripts/deploy-app.sh` (or the push) — refuses a tree that lacks
   `api/games` or any listed game's `game.json`
   (`games-manifest.mjs --required-files`), and, through the guard, an index
   naming a `.snapz` that is not live yet. The game list, its level data and the
   index that names its snapshot switch together.
6. **Verify** with the smoke against the live URL (below).

## Rollback

**Revert and push.** One deploy restores an earlier commit's shell, release
record and indexes together. Nothing is uploaded: R2 is copy-only (`rclone copy`,
never `sync`), so every previously published digest-named object is still
there, the guard finds the old `.snapz` live, and the release's owner keeps its
immutable prefix.

- **In an emergency**, `npx wrangler rollback [<version-id>]` restores a Worker
  version's own assets, record and indexes in seconds (no id: the deployment before
  the current one). Follow it with a revert and push, so
  `wasm64-port` is what is live and the next push does not undo the rollback.
- **If the live Worker is what broke** (`/snapshots/*` answers 404 or 5xx), the
  guard asks that same Worker and refuses the revert, and a 404 says "upload it
  first", which is not the fault here. Run `npx wrangler rollback` first (the
  guard then passes), or deploy the revert from a checkout with
  `LEAN4GAME_DEPLOY_ORIGIN=none scripts/deploy-app.sh` (the pairing check still
  runs).
- **A version from before this scheme** (see "The first deploy of this scheme")
  serves R2's frozen indexes, which still name its pairing.
- **Revert this scheme's commits together** (the deploy change and the clean-ups
  after it). Reverting the Worker change alone, after a later pairing was
  deployed, would put the old route in front of R2's indexes frozen at the
  old pairing.
- **Roll forward** the same way: from the fixed commit, the upload if a
  `.snapz` changed, then the push.

## Verify a deploy

- `curl -sI https://lean4game.<account>.workers.dev/ | grep -i cross-origin`
  → COOP `same-origin`, COEP `require-corp`.
- `curl -sI …/runtime/runtime-manifest.json` → 200 (served from the
  release prefix) with `cache-control: public, max-age=0, must-revalidate`;
  a chunk URL from the manifest → `immutable`; `curl -s
  …/runtime/runtime-manifest.json | grep buildId` → the record's
  `runtime.buildId`. A missing object is `404` with `no-store` (errors are
  never cached, so a URL requested before its upload landed recovers).
- `curl -s …/snapshots/index.json | cmp - client/public/snapshots/index.json`
  from the deployed commit → no output (the deploy's index, not R2's), and
  `curl -sI` of it → `must-revalidate`.
- Open `/#/g/hhu-adam/NNG4/world/Tutorial/level/1`: first visit downloads
  the runtime plus the game's snapshot (the loading pane shows the phases),
  later visits boot in ~10–20 s. The headless check for every listed game
  is `node /Users/fawadhaider/code/wasm64-lean-fable/qed64/work/games-smoke.mjs https://lean4game.<account>.workers.dev`
  (each catalog row's probe level and proof; a fresh profile is the cold
  first visit, a reused profile dir the return visit; exit 1 on any FAIL).

## The service worker

`client/dist/sw.js` (generated by `scripts/build-sw.mjs` after `vite build`;
the deploy script refuses a tree without it) precaches the app shell, the
runtime manifest and the two indexes, and caches the runtime chunks on first
use, so a reload with the network off still boots (the snapshots and library
pack live in OPFS). The indexes count in its version, so a deploy that changes
one reaches returning visitors.
It must be served `must-revalidate`, which `infra/worker.js` does for
every non-digest path, so a new build's worker (new version hash) replaces
the old one on the next online load; the old shell cache is deleted on
activation.
The `warm` message contract (`{type: "warm", urls}` on a MessageChannel,
reply `{cached, pruned, total}`) is unchanged; since 2026-09-11 the landing
page's "Prepare offline" sends it too (`client/src/wasm/game-cache.ts`),
so a prepared game's runtime is cached before any boot.

## Caching and compression

Digest-named files (`*.part-NNN`, `*.snapz`, 16+ hex in the name) and
vite's hashed `/assets/*` are `immutable`; `runtime-manifest*.json`,
every `index.json` and R2's frozen per-runtime copies (`index.<buildId>.json`,
`profiles-index.<buildId>.json`, despite the hex in their names) revalidate.
The chunks are `application/octet-stream`,
so the edge never recompresses them and the client's SHA-256 verification
sees the bytes as uploaded (the local `scripts/serve-dist.mjs` exists for
the same reason: vite's preview gzip broke the digests).

## Range requests

`infra/worker.js` honours single-range GETs on the R2-served paths
(`/runtime/`, `/profiles/`, `/snapshots/`; `qed64/edge`'s `ranges`
default, the same rules as this site's pre-library worker): every artifact response carries
`Accept-Ranges: bytes`; a `Range: bytes=…` request (`a-b`, `a-`, `-n`) is
handed to R2 as `get(key, { range: request.headers })` and answered `206`
with `Content-Range` and the partial `Content-Length`; `If-Range` is
compared with the object's etag and a mismatch (or a date / weak validator)
gets the full `200`; a range past the end gets `416` with
`Content-Range: bytes */<size>` (`no-store`); multi-range and malformed
headers are ignored (full `200`), and HEAD is answered as before. What this
enables today is the browser's own resume: a snapshot download cut by a
reload, a closed tab or an outage leaves a truncated entry in Chrome's HTTP
cache (`.snapz` requests bypass the service worker), and the next fetch
sends `Range` + `If-Range` for the missing tail only — before this the
origin answered `200` and the whole 150–280 MB crossed the network again.
The client does **not** resume yet: `snapshot-prefetch.worker.js` still
discards its `.raw.partial` and re-inflates from byte 0 (the partial is the
inflated stream, so a byte-range resume of it would need saved inflater
state); only the compressed bytes already fetched now come from disk. It
ships with the shell (`scripts/deploy-app.sh`), nothing is re-uploaded to
R2. Tests: `node --test infra/worker.test.mjs`; after a deploy,
`curl -s -o /dev/null -D - -H 'Range: bytes=1000000-1000099' <a .snapz URL>`
→ `206`, `content-range: bytes 1000000-1000099/<size>`, `content-length: 100`.
