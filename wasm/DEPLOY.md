# Deploying the wasm64 game to Cloudflare

Same shape as the QED64 editor (`qed64/docs/DEPLOY.md`): the app shell is a
**Cloudflare Worker with static assets**, the multi-GB artifacts stream from
**R2**, one origin, cross-origin isolation headers on every response
(`infra/worker.js`; `client/public/_headers` is the defensive copy). Free
tier: R2 10 GB with zero egress, Workers 100 k requests/day.

| Piece | Where | Size |
|---|---|---|
| App shell (`client/dist` minus artifact dirs) | Workers static assets, `wasm/out/deploy` | ~40 MB, 450 files, largest 22.9 MiB (cap 25 MiB) |
| Runtime chunks, core profile pack, snapshots | R2 bucket `qed64-artifacts`, prefix `lean4game/` | runtime 154 MB, profiles 121 MB, ten slim game snapshots 2,142 MB on the wire (7.75 GB raw; each game is downloaded only when first played) |

The bucket is shared with the editor; the `lean4game/` prefix keeps the two
mutable manifest sets apart and lets the existing bucket-scoped upload token
serve both. Split into its own bucket later by changing `R2_PREFIX` in
`infra/worker.js`, `bucket_name` in `wrangler.toml` and `R2_BUCKET`/`R2_PREFIX`
for the upload script.

## Deploy, in order

1. `scripts/upload-artifacts.sh` — preflights `client/public`
   (`scripts/preflight-artifacts.mjs`: every chunk, profile part and
   snapshot present and paired to the manifest's build id), writes the
   immutable `runtime-manifest.<buildId>.json` copy, then `rclone copy`
   (never sync) into R2 in three phases per directory — the digest-named
   objects first, then the manifests that name them
   (`runtime-manifest*.json`, `lean-core.manifest.json`), then the
   `index.json` files that name the manifests — so a browser that
   revalidates an index mid-upload never learns a name whose object is not
   there yet (R2 has no multi-object atomic publish). Needs the `qed64-r2`
   rclone remote (R2 API token scoped to the bucket, see the QED64 doc).
   ~1.2 GB the first time; later runs transfer only changed digest-named
   files.
2. `scripts/deploy-app.sh` — stages the worker scripts from the vendored
   closure into `client/public/workers/` (gitignored, generated;
   `scripts/stage-workers.sh` — a clean checkout has none and a shell
   deployed without them hangs at "starting Lean"), builds the client (the vite `define` pins
   `__QED64_BUILD_ID__` to the shipped manifest's build id, so the shell asks
   R2 for the manifest of the exact runtime it was built against), copies
   `client/dist` without `runtime/ profiles/ snapshots/` into
   `wasm/out/deploy`, refuses files over 25 MiB, and runs `wrangler deploy`
   (wrangler 4.125.0 is a root dev dependency; `npx wrangler login` once).
   Live at `https://lean4game.<account>.workers.dev`.

Artifacts first, shell second: the shell only ever references objects that
already exist. Shell-only changes (this repo's client code) need step 2
alone; a runtime rebuild or snapshot rebake needs both.

`.github/workflows/deploy.yml` runs step 2 on every push to `wasm64-port`
when the fork has the `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit only)
and `CLOUDFLARE_ACCOUNT_ID` secrets; without them it logs a skip.

## Adding a game

The catalog (`wasm/catalog.json`) is the only place a game is named; the
port itself — survey, source pin and patch, compat, options, probe,
languages — is `wasm/PORTING.md`. The publish order for a finished port:

1. **Catalog row**, `node scripts/games-manifest.mjs --check` exits 0.
2. **Build lanes** (Docker, `wasm/build-from-source.sh`; flags per its
   header): `--lanes compat,games,bake --games <snapshot> --verify-snapshots`
   compiles the game, overlays its slim tree, bakes
   `<snapshot>.<digest>.snapz` into `wasm/out/staging` and probes it;
   record the printed raw size in the row's `expectedRaw`. `compat` is
   cheap and idempotent (two files, `wasm/compat`) and is required whenever
   `trees` did not run in the same invocation: the `games` lane only warns
   when the game base tree lacks the compat oleans, and a game importing
   `Mathlib.Tactic.Have`/`Cases` (STG4) then fails to compile.
3. **Stage**: `--lanes bundle`, i.e. `scripts/stage-snapshots.py
   wasm/out/staging/snapshots <snapshot>` (copies the `.snapz`, upserts
   `client/public/snapshots/index.json`), `scripts/stage-game-assets.sh`
   (`client/public/{data,i18n}/<id>` and `api/games` for every catalog
   row) and the client build. Smoke it locally with
   `node /Users/fawadhaider/code/wasm64-lean-fable/qed64/work/games-smoke.mjs http://localhost:3006`
   (the script lives in the QED64 checkout's `work/`, not in this repo)
   over `scripts/serve-dist.mjs`, commit locally, do not push.
4. **Upload**: `scripts/upload-artifacts.sh` — the new `.snapz` lands
   before the index that names it.
5. **Deploy**: `scripts/deploy-app.sh` — refuses a tree that lacks
   `api/games` or any listed game's `game.json`
   (`games-manifest.mjs --required-files`).
6. **Verify** with the smoke against the live URL (below).

## Rollback

R2 is copy-only (`rclone copy`, never `sync`), so every previously
published digest-named object — chunks, profile parts, `.snapz` — is still
there after a promote; rolling back is re-publishing the previous *names*.

- **A snapshot publish** (a game added or rebaked): take the previous
  tracked index from git and put it back with `rclone copyto`, then
  redeploy the previous shell:

  ```bash
  git show <previous-deploy-commit>:client/public/snapshots/index.json > /tmp/index.json
  rclone copyto /tmp/index.json qed64-r2:qed64-artifacts/lean4game/snapshots/index.json
  git worktree add ../lean4game-rollback <previous-deploy-commit>
  (cd ../lean4game-rollback && scripts/deploy-app.sh)
  ```

  `rclone copyto` on purpose, not `scripts/upload-artifacts.sh`: its
  preflight (`scripts/preflight-artifacts.mjs`) requires every `.snapz` the
  index names to exist locally, and `scripts/stage-snapshots.py` unlinks
  the superseded local `.snapz` when a rebake is staged (`*.snapz` is
  gitignored, so git holds no copy) — the local tree cannot preflight the
  old index, but R2 still has the objects. The shell must go back too:
  a newer shell lists (`api/games`) and boots games the old index no
  longer names.
- **A runtime publish**: the previous shell was built against its own
  `runtime-manifest.<buildId>.json`, which is immutable and still in R2, so
  redeploying that shell (worktree as above) is the whole rollback; also
  `rclone copyto` the previous `runtime/runtime-manifest.json`,
  `profiles/index.json` and `snapshots/index.json` from git so the mutable
  names agree with it.
- Roll forward the same way: a re-run of the two scripts from the fixed
  commit re-publishes only what changed.

## Verify a deploy

- `curl -sI https://lean4game.<account>.workers.dev/ | grep -i cross-origin`
  → COOP `same-origin`, COEP `require-corp`.
- `curl -sI …/runtime/runtime-manifest.json` → 200 from R2 with
  `cache-control: public, max-age=0, must-revalidate`; a chunk URL from the
  manifest → `immutable`.
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
vite's hashed `/assets/*` are `immutable`; `runtime-manifest*.json` and
every `index.json` revalidate. The chunks are `application/octet-stream`,
so the edge never recompresses them and the client's SHA-256 verification
sees the bytes as uploaded (the local `scripts/serve-dist.mjs` exists for
the same reason: vite's preview gzip broke the digests).
