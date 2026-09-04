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
 */

const ARTIFACT_PREFIXES = ["/runtime/", "/profiles/", "/snapshots/"];
const R2_PREFIX = "lean4game/";

export function isImmutable(pathname) {
  // Manifests and indexes revalidate, INCLUDING runtime-manifest.<buildId>.json
  // (the buildId is sha256(lean.wasm) alone; a relink of lean.js keeps the
  // name and rewrites the chunk digests inside).
  if (/\/runtime-manifest(\.[^/]*)?\.json$/.test(pathname) || /\/index\.json$/.test(pathname)) return false;
  // Digest-named artifact files and vite's content-hashed bundles never
  // change under the same name.
  return /(\.part-\d+|\.snapz|\.chunk\.|[0-9a-f]{16,})/.test(pathname) || /^\/assets\/[^/]+\.[A-Za-z0-9_-]{8}\.[a-z]+$/.test(pathname);
}

function withHeaders(response, pathname) {
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set(
    "Cache-Control",
    isImmutable(pathname) ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
  );
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (ARTIFACT_PREFIXES.some((p) => url.pathname.startsWith(p))) {
      const key = R2_PREFIX + url.pathname.slice(1);
      const object = await env.ARTIFACTS.get(key);
      if (object === null) return withHeaders(new Response("not found", { status: 404 }), url.pathname);
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      return withHeaders(new Response(object.body, { headers }), url.pathname);
    }
    const asset = await env.ASSETS.fetch(request);
    return withHeaders(asset, url.pathname);
  },
};
