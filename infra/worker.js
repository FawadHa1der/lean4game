/* lean4game (wasm64) edge worker: static app shell + R2-backed artifacts,
 * one origin — the same shape as QED64's infra/worker.js.
 *
 * The built client (client/dist minus the artifact directories) ships as
 * Workers static assets; the multi-hundred-MB artifacts (runtime chunks,
 * the Lean core profile pack, game snapshots) stream from the shared R2
 * bucket under the `lean4game/` prefix, so the editor's and the game's
 * mutable manifests never collide. Cross-origin isolation headers go on
 * every response (without COOP/COEP the browser refuses SharedArrayBuffer
 * and Memory64, and the in-tab checker cannot start); digest-named files
 * are immutable, indexes and manifests revalidate.
 *
 * Artifacts honour single-range GETs (206 + Content-Range, If-Range against
 * the object's etag, 416 when unsatisfiable): a browser that was cut off
 * mid-snapshot resumes its truncated HTTP-cache entry instead of pulling
 * the whole object again.
 */

const ARTIFACT_PREFIXES = ["/runtime/", "/profiles/", "/snapshots/"];
const R2_PREFIX = "lean4game/";

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
  // name and rewrites the chunk digests inside).
  if (/\/runtime-manifest(\.[^/]*)?\.json$/.test(pathname) || /\/index\.json$/.test(pathname)) return false;
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
  headers.set(
    "Cache-Control",
    isImmutable(pathname) ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
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
  const key = R2_PREFIX + pathname.slice(1);
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
