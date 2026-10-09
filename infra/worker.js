/* lean4game (wasm64) edge worker: static app shell + R2-backed artifacts,
 * one origin — QED64's edge-worker library (`qed64/edge`, from the qed64
 * package client/package.json pins; docs/DEPLOY.md "Using qed64/edge in
 * your own Worker") configured for this site.
 *
 * The built client (client/dist minus the artifact directories) ships as
 * Workers static assets; the multi-hundred-MB artifacts stream from the
 * shared R2 bucket. Two owners, two prefixes (the toolchain release's
 * hosting rules, wasm64-build/js/formats/HOSTING.md in the lean4 fork):
 *   - the Lean runtime and the Lean core pack are the lean4 fork's release,
 *     uploaded once under `lean4-wasm64/<release id>/` and shared by every
 *     site; `/runtime/*` and `/profiles/*` map onto its `runtime/` and
 *     `profiles/` (release.json hosting.mount), no manifest rewritten;
 *   - the site's own mutable pointers and products (hosting.siteOwned:
 *     `/profiles/index.json`, `/snapshots/*`) stay under `lean4game/`, so
 *     the editor's and the game's manifests never collide.
 * The release id and the mapping come from wasm/lean4-wasm64-release.json,
 * the release record the bake pins (one file names the toolchain), handed
 * to the library as its `release`. The browser only ever sees this origin:
 * the release prefix is proxied, never linked.
 *
 * What the library does with its hardened defaults (each one a switch of
 * createWorker, all on here): cross-origin isolation headers on every
 * response (without COOP/COEP the browser refuses SharedArrayBuffer and
 * Memory64, and the in-tab checker cannot start); digest-named files
 * immutable, indexes and manifests revalidating; every error (>= 400)
 * Cache-Control: no-store; single-range GETs on artifacts (206 +
 * Content-Range, If-Range against the object's etag, 416 when
 * unsatisfiable: a browser that was cut off mid-snapshot resumes its
 * truncated HTTP-cache entry instead of pulling the whole object again);
 * artifact HEAD from R2's head() (metadata only, no body opened); unsafe
 * artifact paths 404 without asking R2; GET and HEAD only on artifacts
 * (405 otherwise); a thrown binding answered 500 no-store with the headers.
 *
 * What this site adds: the SEC1 Content-Security-Policy on every response
 * (`decorate`), and vite's content-hashed bundles under /assets/ as
 * immutable (`isImmutable`).
 */

import release from "../wasm/lean4-wasm64-release.json" with { type: "json" };
import {
  artifactKey as safeArtifactKey,
  createWorker,
  isImmutable as edgeIsImmutable,
  parseRange,
  releaseRoutes as edgeReleaseRoutes,
  resolveRange,
} from "qed64/edge";

// The library's own Range helpers (verbatim lean4game's before it moved to
// the library), exported for worker.test.mjs.
export { parseRange, resolveRange };

/** The site's own prefix: snapshots and the site's pointers. */
export const SITE_PREFIX = "lean4game/";

/** Where each artifact path lives, from a lean4-wasm64.release/v1 record:
 * qed64/edge's releaseRoutes (`{id, prefix, mount: [[urlPrefix, dir]]
 * (longest first), siteOwned: [path]}`) plus `releasePrefix` (= prefix,
 * `lean4-wasm64/<id>/`). Throws, naming wasm/lean4-wasm64-release.json, on a
 * record the worker cannot route by — at module load, so a deploy with a
 * bad record fails instead of serving 404s (createWorker checks it again
 * with the same rules). The rules are the library's: the schema; the id
 * lean-v<version>[-<suffix>]-<kernel7>[-r<N>] and never a run of 16+ hex
 * (the cache rule would read a manifest under that prefix as digest-named:
 * HOSTING.md rule 8); hosting.layout "served"; every mount key an artifact
 * prefix and every value one top-level directory; every siteOwned entry a
 * path under an artifact prefix. */
export function releaseRoutes(record) {
  let routes;
  try {
    routes = edgeReleaseRoutes(record);
  } catch (err) {
    throw new Error(`wasm/lean4-wasm64-release.json: ${String(err?.message ?? err).replace(/^edge-worker: release: /, "")}`, { cause: err });
  }
  return { ...routes, releasePrefix: routes.prefix };
}

const ROUTES = releaseRoutes(release);

/** The R2 key the worker reads for an artifact path, or null when the path
 * is unsafe (an empty, "." or ".." segment, also as %2e, a backslash, a
 * control character → 404, R2 never asked: the library's artifactKey). A
 * site-owned path (exactly `/profiles/index.json`, or under `/snapshots/`)
 * is the site's; a mounted one is the release's, with the URL prefix
 * replaced by the release directory; anything else is the site's — the
 * order createWorker's `release` routes by (edge-worker.d.ts, `release`
 * rules 1-3). For tests and scripts; the worker itself routes inside the
 * library (worker.test.mjs checks the keys it asks R2 for are these, for the
 * committed record and a re-cut `-r<N>` one). */
export function artifactKey(pathname, routes = ROUTES) {
  const rel = safeArtifactKey(pathname);
  if (rel === null) return null;
  if (routes.siteOwned.some((p) => (p.endsWith("/") ? pathname.startsWith(p) : pathname === p))) return SITE_PREFIX + rel;
  for (const [url, dir] of routes.mount) {
    if (pathname.startsWith(url)) return routes.releasePrefix + dir + pathname.slice(url.length);
  }
  return SITE_PREFIX + rel;
}

/** SEC1: what the page and its workers may connect to — fetch, XHR,
 * WebSocket, EventSource, sendBeacon — on every response (the document's
 * policy governs the page; each worker script's own response carries it
 * for that worker, the service worker included). `'self'`: the app, the
 * artifacts, the game data, i18n — one origin. `blob:`: the Lean worker's
 * reconstructed lean.js / lean.wasm (Emscripten fetches the wasm from its
 * object URL). `data:`: lean4monaco's and the VS Code theme extension's
 * small files, which vite inlines as data: URLs and the file service
 * fetches (dark_plus.json, language-configuration.json, …) — no network,
 * so no channel off the device. Nothing else: an index or a widget can name
 * another site, and the browser refuses to connect there whatever the code
 * says. ONLY connect-src — a script-src/default-src would have to allow the
 * blob: widget modules and workers the infoview and monaco load, and is not
 * this fix. client/public/_headers and scripts/serve-dist.mjs send the same
 * value (worker.test.mjs pins all three). */
export const CONTENT_SECURITY_POLICY = "connect-src 'self' blob: data:";

/** Vite's content-hashed bundles: /assets/<name>-<8 chars>.<ext>. */
const VITE_HASHED = /^\/assets\/[^/]+[-.][A-Za-z0-9_-]{8}\.[a-z0-9]+$/;

/** qed64/edge's cache rule, imported, never copied (QED64 EMBEDDING's
 * advice: a copy goes stale when the library's rule changes), plus vite's
 * hashed bundles. The library's rule: manifests and indexes revalidate,
 * INCLUDING runtime-manifest.<buildId>.json (the buildId is sha256(lean.wasm)
 * alone; a relink of lean.js keeps the name and rewrites the chunk digests
 * inside) and the per-runtime index copies /snapshots/index.<buildId>.json
 * and /snapshots/profiles-index.<buildId>.json (QED64 HARDENING #64: their
 * 16-hex build id would make them immutable for a year, but a rebake for the
 * same runtime rewrites them under the same name); digest-named artifact
 * files are immutable. The vite rule adds only /assets/ paths, whose names
 * (`<name>-<hash>.<ext>`) are never a manifest or index name, so on every
 * other path this IS the library's rule (worker.test.mjs checks both). */
export function isImmutable(pathname) {
  return edgeIsImmutable(pathname) || VITE_HASHED.test(pathname);
}

/** This site's worker for a release record: what the default export is for
 * wasm/lean4-wasm64-release.json, built the same way for another record
 * (worker.test.mjs routes a re-cut `-r<N>` release through it). */
export function siteWorker(record = release) {
  return createWorker({
    r2Prefix: SITE_PREFIX,
    release: record,
    isImmutable,
    decorate: (headers) => headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY),
  });
}

export default siteWorker();
