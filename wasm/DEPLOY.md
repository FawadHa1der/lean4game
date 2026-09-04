# Deploying the wasm64 game to Cloudflare

Same shape as the QED64 editor (`qed64/docs/DEPLOY.md`): the app shell is a
**Cloudflare Worker with static assets**, the multi-GB artifacts stream from
**R2**, one origin, cross-origin isolation headers on every response
(`infra/worker.js`; `client/public/_headers` is the defensive copy). Free
tier: R2 10 GB with zero egress, Workers 100 k requests/day.

| Piece | Where | Size |
|---|---|---|
| App shell (`client/dist` minus artifact dirs) | Workers static assets, `wasm/out/deploy` | ~40 MB, 450 files, largest 22.9 MiB (cap 25 MiB) |
| Runtime chunks, core profile pack, snapshots | R2 bucket `qed64-artifacts`, prefix `lean4game/` | 1.2 GB (runtime 147 MB, profiles 115 MB, snapshots 905 MB) |

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
   (never sync) into R2. Needs the `qed64-r2` rclone remote (R2 API token
   scoped to the bucket, see the QED64 doc). ~1.2 GB the first time; later
   runs transfer only changed digest-named files.
2. `scripts/deploy-app.sh` — builds the client (the vite `define` pins
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

## Verify a deploy

- `curl -sI https://lean4game.<account>.workers.dev/ | grep -i cross-origin`
  → COOP `same-origin`, COEP `require-corp`.
- `curl -sI …/runtime/runtime-manifest.json` → 200 from R2 with
  `cache-control: public, max-age=0, must-revalidate`; a chunk URL from the
  manifest → `immutable`.
- Open `/#/g/hhu-adam/NNG4/world/Tutorial/level/1`: first visit downloads
  ~1.2 GB (the loading pane shows the phases), later visits boot in ~20 s.
  The headless check is `qed64/work/stall-verify.mjs` with its URL pointed
  at the site.

## Caching and compression

Digest-named files (`*.part-NNN`, `*.snapz`, 16+ hex in the name) and
vite's hashed `/assets/*` are `immutable`; `runtime-manifest*.json` and
every `index.json` revalidate. The chunks are `application/octet-stream`,
so the edge never recompresses them and the client's SHA-256 verification
sees the bytes as uploaded (the local `scripts/serve-dist.mjs` exists for
the same reason: vite's preview gzip broke the digests).
