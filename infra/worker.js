/* lean4game (wasm64) edge worker: static app shell + R2-backed artifacts,
 * one origin — the same shape as QED64's infra/worker.js.
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
 * the release record the bake pins (one file names the toolchain). The
 * browser only ever sees this origin: the release prefix is proxied, never
 * linked. Cross-origin isolation headers go on every response (without
 * COOP/COEP the browser refuses SharedArrayBuffer and Memory64, and the
 * in-tab checker cannot start); digest-named files are immutable, indexes
 * and manifests revalidate, errors are never cached.
 *
 * Artifacts honour single-range GETs (206 + Content-Range, If-Range against
 * the object's etag, 416 when unsatisfiable): a browser that was cut off
 * mid-snapshot resumes its truncated HTTP-cache entry instead of pulling
 * the whole object again.
 */

import release from "../wasm/lean4-wasm64-release.json" with { type: "json" };

const ARTIFACT_PREFIXES = ["/runtime/", "/profiles/", "/snapshots/"];
/** The site's own prefix: snapshots and the site's pointers. */
export const SITE_PREFIX = "lean4game/";

/** Where each artifact path lives, from a lean4-wasm64.release/v1 record:
 * `{ releasePrefix, mount: [[urlPrefix, dir]], siteOwned: [path] }`. Throws
 * on a record this worker cannot route by — at module load, so a deploy
 * with a bad record fails instead of serving 404s. A release id carries a
 * 7-hex kernel commit, never 16+ hex: the cache rule (isImmutable) would
 * otherwise read a manifest under that prefix as digest-named (HOSTING.md
 * rule 8; the rule sees the URL path, but the record is checked anyway). */
export function releaseRoutes(record) {
  const fail = (why) => { throw new Error(`wasm/lean4-wasm64-release.json: ${why}`); };
  if (record?.schema !== "lean4-wasm64.release/v1") fail(`schema ${JSON.stringify(record?.schema)} is not lean4-wasm64.release/v1`);
  if (typeof record.id !== "string" || !/^lean-v\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)*-[0-9a-f]{7}$/.test(record.id) || /[0-9a-f]{16,}/.test(record.id)) {
    fail(`release id ${JSON.stringify(record.id)} is not lean-v<version>-<kernel7>`);
  }
  const h = record.hosting ?? {};
  if (h.layout !== "served") fail(`hosting.layout ${JSON.stringify(h.layout)} is not "served"`);
  const mount = Object.entries(h.mount ?? {});
  if (mount.length === 0) fail("hosting.mount is empty");
  for (const [url, dir] of mount) {
    if (!ARTIFACT_PREFIXES.includes(url)) fail(`hosting.mount ${url} is not one of ${ARTIFACT_PREFIXES.join(" ")}`);
    if (typeof dir !== "string" || !/^[a-z0-9-]+\/$/.test(dir)) fail(`hosting.mount ${url} → ${JSON.stringify(dir)} is not a top-level directory`);
  }
  const siteOwned = h.siteOwned ?? [];
  if (!Array.isArray(siteOwned) || siteOwned.some((p) => typeof p !== "string" || !ARTIFACT_PREFIXES.some((a) => p.startsWith(a)))) {
    fail("hosting.siteOwned must list artifact paths");
  }
  return { releasePrefix: `lean4-wasm64/${record.id}/`, mount, siteOwned: [...siteOwned] };
}

const ROUTES = releaseRoutes(release);

// A "." or ".." segment, also percent-encoded, a backslash or a control
// character never names a published artifact (as qed64/edge's artifactKey).
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;
const UNSAFE_CHAR = /[\\\u0000-\u001f\u007f]/;

/** The R2 key for an artifact path, or null when the path is unsafe (an
 * empty, "." or ".." segment, a backslash, a control character → 404, R2
 * never asked). A site-owned path (exactly `/profiles/index.json`, or under
 * `/snapshots/`) is the site's; a mounted one is the release's, with the
 * URL prefix replaced by the release directory; anything else is the
 * site's. */
export function artifactKey(pathname, routes = ROUTES) {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return null;
  const rel = pathname.slice(1);
  if (UNSAFE_CHAR.test(rel) || rel.split("/").some((s) => s === "" || DOT_SEGMENT.test(s))) return null;
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

export function isImmutable(pathname) {
  // Manifests and indexes revalidate, INCLUDING runtime-manifest.<buildId>.json
  // (the buildId is sha256(lean.wasm) alone; a relink of lean.js keeps the
  // name and rewrites the chunk digests inside) and the per-runtime index
  // copies /snapshots/index.<buildId>.json and
  // /snapshots/profiles-index.<buildId>.json (QED64 HARDENING #64; the same
  // rule as qed64's infra/edge-worker.js): their 16-hex build id would make
  // them immutable for a year below, but a rebake for the same runtime
  // rewrites them under the same name.
  if (/\/runtime-manifest(\.[^/]*)?\.json$/.test(pathname) || /\/(?:profiles-)?index(\.[^/]*)?\.json$/.test(pathname)) return false;
  // Digest-named artifact files and vite's content-hashed bundles never
  // change under the same name.
  return /(\.part-\d+|\.snapz|\.chunk\.|[0-9a-f]{16,})/.test(pathname) || /^\/assets\/[^/]+[-.][A-Za-z0-9_-]{8}\.[a-z0-9]+$/.test(pathname);
}

function withHeaders(response, pathname) {
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  // Errors are never cached: a 404 under a digest-named URL (an artifact
  // requested before its upload landed) would otherwise stick for a year.
  headers.set(
    "Cache-Control",
    response.status >= 400 ? "no-store"
      : isImmutable(pathname) ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
  );
  return new Response(response.body, { status: response.status, headers });
}

/** A `Range` header this worker serves: exactly one `bytes` range
 * (RFC 9110 §14.1.2). Anything else — another unit, several ranges, a
 * malformed or inverted spec — returns null and the request is answered as
 * if it carried no Range (a full 200, which the RFC allows), so R2 only
 * ever sees a header this worker has understood. */
export function parseRange(header) {
  if (header === null || header === undefined) return null;
  // Canonical spelling only (what browsers send), positions within the safe
  // integers: the raw header goes to R2, whose parser is not ours to guess.
  const match = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim());
  if (match === null) return null;
  const [, first, last] = match;
  if (first === "") return last === "" ? null : { suffix: Number(last) };
  if (last === "") return { first: Number(first) };
  return Number(last) < Number(first) ? null : { first: Number(first), last: Number(last) };
}

/** `{offset, length}` of a parsed range within an object of `size` bytes,
 * or null when no byte of the object is selected (→ 416). */
export function resolveRange(spec, size) {
  if (spec.suffix !== undefined) {
    const length = Math.min(spec.suffix, size);
    return length > 0 ? { offset: size - length, length } : null;
  }
  if (spec.first >= size) return null;
  const end = spec.last === undefined ? size - 1 : Math.min(spec.last, size - 1);
  return { offset: spec.first, length: end - spec.first + 1 };
}

/** The range R2 reports having returned. The binding types it as any of
 * `{offset, length?}`, `{offset?, length}` or `{suffix}`; normalise all
 * three to `{offset, length}`. */
function returnedRange(range, size) {
  if (range.suffix !== undefined) {
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  const offset = range.offset ?? 0;
  return { offset, length: range.length ?? size - offset };
}

function notFound(pathname) {
  return withHeaders(new Response("not found", { status: 404 }), pathname);
}

async function serveArtifact(request, env, pathname) {
  const key = artifactKey(pathname);
  if (key === null) return notFound(pathname);
  // Range is defined for GET only (HEAD ignores it and answers from head()).
  let spec = request.method === "GET" ? parseRange(request.headers.get("range")) : null;
  if (spec !== null) {
    // Validators and size first: whether the range applies (If-Range) and
    // whether it is satisfiable are decided here, not inferred from how R2
    // reacts to a range it cannot serve.
    const meta = await env.ARTIFACTS.head(key);
    if (meta === null) return notFound(pathname);
    const ifRange = request.headers.get("if-range");
    if (ifRange !== null && ifRange.trim() !== meta.httpEtag) {
      // The client's partial copy is of another version (or the validator is
      // a date or a weak etag, which can never strongly match): full 200.
      spec = null;
    } else if (resolveRange(spec, meta.size) === null) {
      const headers = new Headers();
      headers.set("accept-ranges", "bytes");
      headers.set("content-range", `bytes */${meta.size}`);
      const response = withHeaders(new Response("range not satisfiable", { status: 416, headers }), pathname);
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
  }
  if (request.method === "HEAD") {
    // Metadata only: R2's head() answers in tens of milliseconds, while a
    // get() opens the object's body (hundreds of MB for a snapshot) only for
    // the runtime to discard it — HEAD took 3–8 s and sat on the first-visit
    // "checking this game's environment" path (live campaign 2026-10-01).
    const meta = await env.ARTIFACTS.head(key);
    if (meta === null) return notFound(pathname);
    const headers = new Headers();
    meta.writeHttpMetadata(headers);
    headers.set("etag", meta.httpEtag);
    headers.set("accept-ranges", "bytes");
    headers.set("content-length", String(meta.size));
    return withHeaders(new Response(null, { headers }), pathname);
  }
  const object = await env.ARTIFACTS.get(key, spec !== null ? { range: request.headers } : undefined);
  if (object === null) return notFound(pathname);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  if (spec !== null && object.range !== undefined && object.range !== null) {
    const { offset, length } = returnedRange(object.range, object.size);
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("content-length", String(length));
    return withHeaders(new Response(object.body, { status: 206, headers }), pathname);
  }
  return withHeaders(new Response(object.body, { headers }), pathname);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (ARTIFACT_PREFIXES.some((p) => url.pathname.startsWith(p))) {
      return serveArtifact(request, env, url.pathname);
    }
    const asset = await env.ASSETS.fetch(request);
    return withHeaders(asset, url.pathname);
  },
};
