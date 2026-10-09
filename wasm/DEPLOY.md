# Deploying the wasm64 game to Cloudflare

Same shape as the QED64 editor (`qed64/docs/DEPLOY.md`): the app shell is a
**Cloudflare Worker with static assets**, the multi-GB artifacts stream from
**R2**, one origin, cross-origin isolation headers on every response
(`infra/worker.js`; `client/public/_headers` is the defensive copy). Free
tier: R2 10 GB with zero egress, Workers 100 k requests/day.

| Piece | Where | Size |
|---|---|---|
| App shell (`client/dist` minus artifact dirs) | Workers static assets, `wasm/out/deploy` | ~40 MB, 450 files, largest 22.9 MiB (cap 25 MiB) |
| Lean runtime chunks, Lean core pack (`/runtime/*`, `/profiles/*`) | R2 bucket `qed64-artifacts`, prefix `lean4-wasm64/<release id>/`: the lean4 fork's toolchain release, shared with the QED64 editor and the widgets showcase, uploaded once by the release owner | runtime 159 MB, core pack ~121 MB |
| Game snapshots, the site's pack list (`/snapshots/*`, `/profiles/index.json`) | R2 bucket `qed64-artifacts`, prefix `lean4game/` | ten slim game snapshots ~2.1 GB on the wire (each game is downloaded only when first played) |

Two owners, two prefixes (the release's hosting rules,
`wasm64-build/js/formats/HOSTING.md` in the lean4 fork). The release id and
the mapping come from `wasm/lean4-wasm64-release.json`, the release record
the bake pins: `infra/worker.js` imports it, maps `/runtime/*` and
`/profiles/*` onto the release's `runtime/` and `profiles/`
(`hosting.mount`) and keeps `hosting.siteOwned` (`/profiles/index.json`,
`/snapshots/*`) under `lean4game/`. The browser only sees this origin; the
release prefix is proxied, never linked. A toolchain bump is therefore one
file (the record) plus a rebake; the worker follows it on the next deploy.
The bucket is shared with the editor; the `lean4game/` prefix keeps the two
sites' mutable pointers apart and lets the existing bucket-scoped upload
token serve both.

## Deploy, in order

0. **The toolchain release in R2** (once per release, by its owner): the
   staged release directory under `lean4-wasm64/<release id>/`, with the
   three `rclone copy` commands the lean4 fork's
   `wasm64-build/stage-release.sh` prints (HOSTING.md, "Where a release
   lives"; immutable, digest-named objects first, `release.json` last).
   Step 1 refuses to run until it is there.
1. `scripts/upload-artifacts.sh` — **before the deploy**. Preflights
   `client/public` (`scripts/preflight-artifacts.mjs`: every chunk, profile
   part and snapshot present and paired to the manifest's build id, and the
   two per-runtime index copies present, byte-identical to their indexes and
   none for another runtime; see "Per-runtime index copies" below), checks
   that the served runtime is the release record's and that R2's
   `lean4-wasm64/<release id>/release.json` is byte-identical to
   `wasm/lean4-wasm64-release.json` (else it prints the release upload and
   stops), then `rclone copy` (never sync) into `lean4game/` of only what
   no deployed shell reads yet: the digest-named `.snapz` first, then this
   runtime's copies `snapshots/index.<buildId>.json` and
   `snapshots/profiles-index.<buildId>.json` — so a browser never learns a
   name whose object is not there yet (R2 has no multi-object atomic
   publish). It never writes `snapshots/index.json` or
   `profiles/index.json`, and ends by printing steps 2 and 3. Needs the
   `qed64-r2` rclone remote (R2 API token scoped to the bucket, see the
   QED64 doc). Later runs transfer only changed snapshots.
2. `scripts/deploy-app.sh` — stages the worker scripts the qed64 package's
   `embedding/closure.json` names into `client/public/workers/` (gitignored, generated;
   `scripts/stage-workers.sh` — a clean checkout has none and a shell
   deployed without them hangs at "starting Lean"), builds the client (the vite `define` pins
   `__QED64_BUILD_ID__` to the shipped manifest's build id, so the shell asks
   R2 for the manifest of the exact runtime it was built against), copies
   `client/dist` without `runtime/ profiles/ snapshots/` into
   `wasm/out/deploy`, refuses files over 25 MiB, and runs `wrangler deploy`
   (wrangler 4.125.0 is a root dev dependency; `npx wrangler login` once),
   then prints the reminder for step 3 (it never runs it: CI has no R2
   credentials). Live at `https://lean4game.<account>.workers.dev`.
3. `scripts/upload-artifacts.sh --post-deploy` — **immediately after the
   deploy**. Refuses (exit 3, nothing written) unless
   `$SITE_URL/runtime/runtime-manifest.json` (default
   `https://lean4game.fawadworkaddress.workers.dev`) already names the
   record's runtime — the old worker answers its own runtime's manifest, the
   new one the release's — and R2 already holds every `.snapz` the local
   index names (by name and size, from an `rclone lsf` listing; each name
   carries its digest) and both copies of step 1 (byte for byte). That live
   check compares only the runtime build id, so it proves the deploy only
   for a runtime change (see below for a same-runtime change). Then it pins
   what R2 serves now: when R2's `snapshots/index.json` or
   `profiles/index.json` pairs with a runtime that has no copy in R2 yet,
   that object is copied to `snapshots/index.<its id>.json` /
   `snapshots/profiles-index.<its id>.json` inside R2 (`rclone copyto`
   remote to remote; an existing copy is never overwritten). The snapshot
   copy keeps a paired snapshot index for shells still paired with the
   outgoing runtime (once they read copies); the profile copy is for a
   rollback, not for those shells (see "Per-runtime index copies"). Then
   it uploads `snapshots/index.json`, then `profiles/index.json`. Every R2
   read fails closed: a failure that is not rclone's "not found" refuses
   before the first write. Re-runs write nothing.

Release first, then what no shell reads yet, then the shell, then the
pointers: a shell only ever references objects that already exist, and the
mutable indexes never change ahead of the shell that pairs with them. Both
shells read `/snapshots/index.json` at every game boot and refuse an entry
baked for another runtime than their own ("the environment … is not
published for this build", the failure card; it does not reload into a new
shell). So publishing a new runtime's `snapshots/index.json` before the
deploy breaks every game boot on the live shell until the deploy lands.
QED64 did exactly
that on 2026-10-08 (its `docs/HARDENING.md` #64: upload, then the push;
about ten minutes of failed boots), and this page used to say the opposite.
With the two upload steps:

- the live shell keeps working through step 1 and up to the deploy (the
  live one on `wasm64-port` predates #64 and reads only the mutable
  indexes);
- the remaining gap is the seconds between the deploy and step 3: a game
  boot on the new shell in that window reads the outgoing index and fails
  the same way (a reload after step 3 boots). Run step 3 the moment the
  deploy is live; with a CI deploy (a push to `wasm64-port`), the moment
  the workflow's deploy step has finished. For a RUNTIME change step 3
  refuses (exit 3, nothing written) until the new worker answers, so a run
  that comes too early is safe and is simply rerun. For a same-runtime
  change it cannot tell (below);
- a tab still open on the outgoing shell after the deploy talks to the new
  worker (its `/runtime/*` maps to the new release) and, after step 3,
  reads the new indexes; it needs a reload. Once the client reads the
  copies (below), such a tab at least keeps a paired snapshot index through
  step 3.

Shell-only changes (this repo's client code) need step 2 alone. A snapshot
rebake or a new game for the SAME runtime takes the same three steps: step 1
uploads the new `.snapz` and rewrites this runtime's copies (no shell reads
them while its mutable index is paired), step 3's live check passes at once
(the live manifest is already this runtime) and it pins nothing (R2's index
already pairs with it). Because the check passes before the deploy too, it
does not tell whether step 2 has landed (step 3 prints a note saying so):
when the change also ships a shell change, run step 3 only once the deploy
is confirmed by hand (`deploy-app.sh` printed `deployed.`, or the
workflow's deploy step finished). An early step 3 for a new game is
harmless (the old shell's `api/games` does not list it), but for a rebake
whose level data changed in the shell it makes the old shell boot the new
snapshot with its old level data. With no shell change at all, step 3 may
follow step 1 directly. A runtime rebuild needs all of 0–3.

`.github/workflows/deploy.yml` runs step 2 on every push to `wasm64-port`
when the fork has the `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit only)
and `CLOUDFLARE_ACCOUNT_ID` secrets; without them it logs a skip. It has no
R2 credentials, so it can neither run nor check steps 1 and 3: for a
runtime or snapshot change, finish step 1 BEFORE the push and run step 3
once the workflow's deploy step has finished (the job logs the reminder
and annotates the run with it). For a runtime change, a push before step 1
has finished puts the new shell live against R2's outgoing index (every
game boot fails, and step 3 refuses until R2 holds step 1's objects) for as
long as the multi-GB upload takes, not seconds.

### Per-runtime index copies (QED64 HARDENING #64)

| Copy | Bytes of | Written by |
|---|---|---|
| `/snapshots/index.<buildId>.json` | `/snapshots/index.json` | `scripts/stage-snapshots.py` after every merge (from the MERGED index, never a staging dir's own copy) |
| `/snapshots/profiles-index.<buildId>.json` | `/profiles/index.json` | the bundle lane of `wasm/build-from-source.sh`, next to `profiles/index.json` |

- `<buildId>` is the runtime the index pairs with (its snapshot entries'
  `runtime`, the profile index's `runtime.buildId`). Both live under
  `/snapshots/`, which `hosting.siteOwned` leaves to the site under every
  worker; `/profiles/index.<id>.json` would be routed to the release prefix,
  which does not carry it.
- Locally they are derived and gitignored, like
  `runtime-manifest.<buildId>.json`: `scripts/stage-snapshots.py` removes
  another runtime's local copies (R2 keeps its own; locally they would name
  `.snapz` that are gone), `scripts/stage-snapshots.py --copies` rewrites
  all three (the two index copies and the pinned runtime manifest) from the
  tree as it is, `scripts/fetch-artifacts.sh` runs that after
  an extract, and the upload's preflight refuses copies that are missing,
  stale or another runtime's.
- In R2: step 1 writes this runtime's; step 3 writes the outgoing runtime's
  when R2 has none yet, from the live objects, server side. Nothing deletes
  them. The two pinned copies are not equally useful. The snapshot copy
  names digest-named `.snapz` under `/snapshots/`, which every worker
  routes to `lean4game/`, so it stays a paired snapshot index under the new
  worker. The profile copy names `/profiles/lean-core.manifest.json`, and
  every `/profiles/*` path but `index.json` follows the deployed worker's
  release: under the new worker it resolves to the NEW release's core
  pack. So the outgoing runtime's profile copy is a usable profile index
  only beside its own worker, that is, for a rollback ("Rollback" below),
  not for an outgoing shell's open tabs.
- Caching: `infra/worker.js` serves both `must-revalidate` with QED64's rule
  (`/\/(?:profiles-)?index(\.[^/]*)?\.json$/` is never immutable): the
  16-hex build id in the name would otherwise make them `immutable` for a
  year, and a rebake for the same runtime rewrites them. A 404 is `no-store`,
  as every error. The service worker fetches them network-first, like the
  indexes. The live pre-#64 worker on `wasm64-port` would still serve them
  `immutable` (and its 404s too): no deployed shell asks for them, so do not
  open their URLs on the live site before the deploy.
- The reader (QED64's `loadSnapshotIndex(url, { pairedBuildId })`): read
  `index.json` first; only when an entry names a runtime other than the
  paired build id, read `index.<pairedBuildId>.json` with the same HTML,
  schema and origin checks and use it when every one of its entries pairs
  with that id. A 404, HTML, a network error, an empty, mixed or mispaired
  copy keeps `index.json`, and the pairing check refuses as before; a paired
  index costs no extra request. Active once this client passes
  `pairedBuildId` in `fetchSnapshotIndexOnce` (`client/src/wasm/games-api.ts`)
  at the next QED64 pin bump. Until then the copies are published but read
  by no shell, and the gap above is the seconds between the deploy and step
  3; from then on, the index side of that gap closes for shells that read
  them: the new shell reads its copy (step 1) until step 3, and an
  outgoing shell's open tabs read their snapshot copy (step 3's pin; their
  `/runtime/*` still follows the new worker's release, so they may still
  need a reload). The game boot asks for no profile index
  (`installArtifacts` with `profiles: "none"`); the profile copies are
  published for the shared format (QED64's `installArtifacts` reads them)
  and, for the outgoing runtime, for a rollback (see "In R2" above).

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
   `wasm/out/staging/<runtime build id>/snapshots` and probes it (the
   snapshot through the wasm runtime, the level proofs natively with a
   negative control); record the
   printed raw size in the row's `expectedRaw`. Run each bake under the
   host's browser lock (`with-browser-lock.sh lean4game …`), one game per
   hold.
3. **Stage**: `--lanes bundle`, i.e. `scripts/stage-snapshots.py
   wasm/out/staging/<build id>/snapshots <snapshot>` (copies the `.snapz`, upserts
   `client/public/snapshots/index.json` and rewrites its copy
   `index.<build id>.json`), `scripts/stage-game-assets.sh`
   (`client/public/{data,i18n}/<id>` and `api/games` for every catalog
   row) and the client build. Smoke it locally with
   `node /Users/fawadhaider/code/wasm64-lean-fable/qed64/work/games-smoke.mjs http://localhost:3006`
   (the script lives in the QED64 checkout's `work/`, not in this repo)
   over `scripts/serve-dist.mjs`, commit locally, do not push.
4. **Upload, before the deploy**: `scripts/upload-artifacts.sh` — the new
   `.snapz` and this runtime's index copies; the live index is untouched.
5. **Deploy**: `scripts/deploy-app.sh` — refuses a tree that lacks
   `api/games` or any listed game's `game.json`
   (`games-manifest.mjs --required-files`).
6. **Upload, right after the deploy**: `scripts/upload-artifacts.sh
   --post-deploy` — the index that names the new `.snapz` (until then the
   new shell lists the game but the live index has no entry for it). For
   the same runtime its live check passes before the deploy too, so run it
   once step 5 is confirmed (see "Deploy, in order"); in a step that also
   rebakes an existing game whose level data changed, an early run makes
   the old shell boot the new snapshot with its old level data.
7. **Verify** with the smoke against the live URL (below).

## Rollback

R2 is copy-only (`rclone copy`, never `sync`), so every previously
published digest-named object — chunks, profile parts, `.snapz` — is still
there after a promote; rolling back is re-publishing the previous *names*.

A rollback follows the same order as a promote: copies, shell, pointers.

- **A snapshot publish** (a game added or rebaked, same runtime): take the
  previous tracked index from git, put it back as this runtime's copy,
  redeploy the previous shell, then put it back as the pointer:

  ```bash
  R2=qed64-r2:qed64-artifacts/lean4game
  git show <previous-deploy-commit>:client/public/snapshots/index.json > /tmp/index.json
  RT=$(node -p 'require("/tmp/index.json").snapshots[0].runtime')
  rclone copyto /tmp/index.json $R2/snapshots/index.$RT.json --s3-no-check-bucket
  git worktree add ../lean4game-rollback <previous-deploy-commit>
  (cd ../lean4game-rollback && scripts/deploy-app.sh)
  rclone copyto /tmp/index.json $R2/snapshots/index.json --s3-no-check-bucket
  ```

  `rclone copyto` on purpose, not `scripts/upload-artifacts.sh`: its
  preflight (`scripts/preflight-artifacts.mjs`) requires every `.snapz` the
  index names to exist locally, and `scripts/stage-snapshots.py` unlinks
  the superseded local `.snapz` when a rebake is staged (`*.snapz` is
  gitignored, so git holds no copy) — the local tree cannot preflight the
  old index, but R2 still has the objects. The shell must go back too:
  a newer shell lists (`api/games`) and boots games the old index no
  longer names.
- **A toolchain release bump**: the previous shell's worker names its own
  release (its `wasm/lean4-wasm64-release.json`), whose prefix is immutable
  and still in R2, so redeploying that shell (worktree as above) is the
  runtime half of the rollback. Right after it, put the site's pointers
  back. R2 keeps the previous runtime's copies (step 3 of the promote pinned
  them from the live objects, or an earlier step 1 wrote them), so this is
  two copies inside R2:

  ```bash
  R2=qed64-r2:qed64-artifacts/lean4game; PREV=<previous runtime build id>
  (cd ../lean4game-rollback && scripts/deploy-app.sh)
  rclone copyto $R2/snapshots/index.$PREV.json $R2/snapshots/index.json --s3-no-check-bucket
  rclone copyto $R2/snapshots/profiles-index.$PREV.json $R2/profiles/index.json --s3-no-check-bucket
  ```

  (`rclone lsf $R2/snapshots | grep index` lists the copies there; without
  one, `rclone copyto` the file from git instead, as above.) Not that
  commit's `scripts/upload-artifacts.sh`: before the two steps it replaced
  the pointers BEFORE its deploy. The gap is the same seconds as a
  promote's; the rolled-back-from runtime's copies stay in R2 for the roll
  forward. (Shells from before the shared release read the runtime from
  `lean4game/runtime/`, which is still there.)
- Roll forward the same way: the two upload steps around the deploy, from
  the fixed commit, re-publish only what changed.

## Verify a deploy

- `curl -sI https://lean4game.<account>.workers.dev/ | grep -i cross-origin`
  → COOP `same-origin`, COEP `require-corp`.
- `curl -sI …/runtime/runtime-manifest.json` → 200 (served from the
  release prefix) with `cache-control: public, max-age=0, must-revalidate`;
  a chunk URL from the manifest → `immutable`; `curl -s
  …/runtime/runtime-manifest.json | grep buildId` → the record's
  `runtime.buildId`. A missing object is `404` with `no-store` (errors are
  never cached, so a URL requested before its upload landed recovers).
- After step 3: `curl -s …/snapshots/index.json | cmp - <(curl -s
  …/snapshots/index.<buildId>.json)` → no output (the pointer and this
  runtime's copy are the same bytes), and `curl -sI` of the copy →
  `must-revalidate`.
- Open `/#/g/hhu-adam/NNG4/world/Tutorial/level/1`: first visit downloads
  the runtime plus the game's snapshot (the loading pane shows the phases),
  later visits boot in ~10–20 s. The headless check for every listed game
  is `node /Users/fawadhaider/code/wasm64-lean-fable/qed64/work/games-smoke.mjs https://lean4game.<account>.workers.dev`
  (each catalog row's probe level and proof; a fresh profile is the cold
  first visit, a reused profile dir the return visit; exit 1 on any FAIL).

## The service worker

`client/dist/sw.js` (generated by `scripts/build-sw.mjs` after `vite build`;
the deploy script refuses a tree without it) precaches the app shell and
caches the runtime chunks and manifests on first use, so a reload with the
network off still boots (the snapshots and library pack live in OPFS).
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
every `index.json` and the per-runtime index copies (`index.<buildId>.json`,
`profiles-index.<buildId>.json`, despite the hex in their names) revalidate.
The chunks are `application/octet-stream`,
so the edge never recompresses them and the client's SHA-256 verification
sees the bytes as uploaded (the local `scripts/serve-dist.mjs` exists for
the same reason: vite's preview gzip broke the digests).

## Range requests

`infra/worker.js` honours single-range GETs on the R2-served paths
(`/runtime/`, `/profiles/`, `/snapshots/`): every artifact response carries
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
