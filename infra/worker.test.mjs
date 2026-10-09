/* infra/worker.js against a fake R2 binding: `node --test infra/worker.test.mjs`.
 *
 * The fake models what the worker relies on from R2 — get(key, {range:
 * Headers}) returns the selected bytes plus `range: {offset, length}`,
 * head(key) returns size and httpEtag — and is stricter than R2 where the
 * worker must not lean on it: an unsatisfiable or unparsable range THROWS,
 * so a test passes only if the worker settled 416 / full-200 itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { CONTENT_SECURITY_POLICY, SITE_PREFIX, artifactKey, isImmutable, parseRange, releaseRoutes, resolveRange } from "./worker.js";

const RELEASE = JSON.parse(readFileSync(new URL("../wasm/lean4-wasm64-release.json", import.meta.url), "utf8"));
const REL = `lean4-wasm64/${RELEASE.id}/`;

const ORIGIN = "https://lean4game.example";
const SNAPZ = "/snapshots/nng4.db264c5f3eb7c69c.snapz";
const INDEX = "/snapshots/index.json";
const ETAG = '"a3a855ce33ae66e6177c0a9380dde0df"';
const BYTES = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7 + 3) % 256);

function fakeBucket(objects) {
  const calls = [];
  const meta = (key, entry) => ({
    key,
    size: entry.bytes.length,
    httpEtag: entry.etag,
    writeHttpMetadata(headers) {
      headers.set("content-type", entry.contentType);
    },
  });
  return {
    calls,
    async head(key) {
      calls.push({ op: "head", key });
      const entry = objects[key];
      return entry === undefined ? null : meta(key, entry);
    },
    async get(key, options) {
      const rangeHeader = options?.range instanceof Headers ? options.range.get("range") : null;
      calls.push({ op: "get", key, range: rangeHeader });
      const entry = objects[key];
      if (entry === undefined) return null;
      const size = entry.bytes.length;
      let offset = 0;
      let length = size;
      if (options?.range !== undefined) {
        assert.ok(options.range instanceof Headers, "the worker passes the request's Headers as the range");
        const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader ?? "");
        if (match === null || (match[1] === "" && match[2] === "")) throw new Error("get: invalid range (fake R2)");
        if (match[1] === "") {
          length = Math.min(Number(match[2]), size);
          offset = size - length;
        } else {
          offset = Number(match[1]);
          const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
          length = end - offset + 1;
        }
        if (length <= 0 || offset >= size) throw new Error("get: The requested range is not satisfiable (10039)");
      }
      return {
        ...meta(key, entry),
        range: { offset, length },
        body: new Blob([entry.bytes.slice(offset, offset + length)]).stream(),
      };
    },
  };
}

function makeEnv() {
  const ARTIFACTS = fakeBucket({
    ["lean4game" + SNAPZ]: { bytes: BYTES, etag: ETAG, contentType: "application/octet-stream" },
    ["lean4game" + INDEX]: { bytes: new TextEncoder().encode('{"snapshots":[]}'), etag: '"idx"', contentType: "application/json" },
  });
  const assetRequests = [];
  const ASSETS = {
    async fetch(request) {
      assetRequests.push(new URL(request.url).pathname);
      return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
    },
  };
  return { ARTIFACTS, ASSETS, assetRequests };
}

function call(env, pathname, { method = "GET", headers = {} } = {}) {
  return worker.fetch(new Request(ORIGIN + pathname, { method, headers }), env);
}

async function bodyBytes(response) {
  return new Uint8Array(await response.arrayBuffer());
}

/** SEC1: the exact connect-src policy (no script-src / default-src: the
 * infoview's blob: widget modules and monaco's workers must keep loading). */
const CSP = "connect-src 'self' blob: data:";

function assertIsolated(response) {
  assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(response.headers.get("cross-origin-embedder-policy"), "require-corp");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(response.headers.get("content-security-policy"), CSP);
}

const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "public, max-age=0, must-revalidate";

test("full GET: 200, whole body, Accept-Ranges, one R2 get and no head", async () => {
  const env = makeEnv();
  const response = await call(env, SNAPZ);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("etag"), ETAG);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(response.headers.get("content-range"), null);
  assert.equal(response.headers.get("cache-control"), IMMUTABLE);
  assertIsolated(response);
  assert.deepEqual(await bodyBytes(response), BYTES);
  assert.deepEqual(env.ARTIFACTS.calls, [{ op: "get", key: "lean4game" + SNAPZ, range: null }]);
});

test("mutable index: 200, must-revalidate, Accept-Ranges", async () => {
  const env = makeEnv();
  const response = await call(env, INDEX);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), REVALIDATE);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(await response.text(), '{"snapshots":[]}');
});

test("HEAD: metadata from head() only (no body is opened), 200 with size, etag, Accept-Ranges", async () => {
  const env = makeEnv();
  const response = await call(env, SNAPZ, { method: "HEAD" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("etag"), ETAG);
  assert.equal(response.headers.get("content-length"), "1000");
  assert.equal(response.headers.get("cache-control"), IMMUTABLE);
  assertIsolated(response);
  assert.equal(response.body, null);
  assert.deepEqual(env.ARTIFACTS.calls, [{ op: "head", key: "lean4game" + SNAPZ }]);
});

test("HEAD of a missing artifact: 404 without a get()", async () => {
  const env = makeEnv();
  const response = await call(env, "/snapshots/nope.0000000000000000.snapz", { method: "HEAD" });
  assert.equal(response.status, 404);
  assert.deepEqual(env.ARTIFACTS.calls.map((c) => c.op), ["head"]);
});

test("HEAD ignores Range (range handling is defined for GET only)", async () => {
  const env = makeEnv();
  const response = await call(env, SNAPZ, { method: "HEAD", headers: { range: "bytes=0-99" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-range"), null);
  assert.equal(response.headers.get("content-length"), "1000");
  assert.deepEqual(env.ARTIFACTS.calls, [{ op: "head", key: "lean4game" + SNAPZ }]);
});

test("bytes=0-99: 206, Content-Range, partial Content-Length, the first 100 bytes", async () => {
  const env = makeEnv();
  const response = await call(env, SNAPZ, { headers: { range: "bytes=0-99" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-99/1000");
  assert.equal(response.headers.get("content-length"), "100");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("etag"), ETAG);
  assert.equal(response.headers.get("cache-control"), IMMUTABLE);
  assertIsolated(response);
  assert.deepEqual(await bodyBytes(response), BYTES.slice(0, 100));
  assert.deepEqual(env.ARTIFACTS.calls, [
    { op: "head", key: "lean4game" + SNAPZ },
    { op: "get", key: "lean4game" + SNAPZ, range: "bytes=0-99" },
  ]);
});

test("suffix bytes=-100: 206 with the last 100 bytes", async () => {
  const env = makeEnv();
  const response = await call(env, SNAPZ, { headers: { range: "bytes=-100" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 900-999/1000");
  assert.equal(response.headers.get("content-length"), "100");
  assert.deepEqual(await bodyBytes(response), BYTES.slice(900));
});

test("suffix longer than the object: 206 with the whole object", async () => {
  const env = makeEnv();
  const response = await call(env, SNAPZ, { headers: { range: "bytes=-5000" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-999/1000");
  assert.equal(response.headers.get("content-length"), "1000");
  assert.deepEqual(await bodyBytes(response), BYTES);
});

test("open-ended bytes=100-: 206 from byte 100 to the end", async () => {
  const env = makeEnv();
  const response = await call(env, SNAPZ, { headers: { range: "bytes=100-" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 100-999/1000");
  assert.equal(response.headers.get("content-length"), "900");
  assert.deepEqual(await bodyBytes(response), BYTES.slice(100));
});

test("last-byte-pos past the end is clamped", async () => {
  const env = makeEnv();
  const response = await call(env, SNAPZ, { headers: { range: "bytes=990-4999" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 990-999/1000");
  assert.equal(response.headers.get("content-length"), "10");
  assert.deepEqual(await bodyBytes(response), BYTES.slice(990));
});

test("If-Range matching the etag: the range is served (Chrome's resume)", async () => {
  const env = makeEnv();
  const response = await call(env, SNAPZ, { headers: { range: "bytes=500-", "if-range": ETAG } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 500-999/1000");
  assert.equal(response.headers.get("content-length"), "500");
  assert.deepEqual(await bodyBytes(response), BYTES.slice(500));
});

test("If-Range mismatch: full 200, R2 is never asked for a range", async () => {
  const env = makeEnv();
  const response = await call(env, SNAPZ, { headers: { range: "bytes=500-", "if-range": '"some-older-version"' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-range"), null);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("etag"), ETAG);
  assert.deepEqual(await bodyBytes(response), BYTES);
  assert.deepEqual(env.ARTIFACTS.calls, [
    { op: "head", key: "lean4game" + SNAPZ },
    { op: "get", key: "lean4game" + SNAPZ, range: null },
  ]);
});

test("If-Range with a weak etag or a date never matches: full 200", async () => {
  for (const validator of ["W/" + ETAG, "Mon, 21 Sep 2026 10:00:00 GMT"]) {
    const env = makeEnv();
    const response = await call(env, SNAPZ, { headers: { range: "bytes=0-9", "if-range": validator } });
    assert.equal(response.status, 200, validator);
    assert.deepEqual(await bodyBytes(response), BYTES);
  }
});

test("If-Range mismatch wins over an unsatisfiable range: full 200, not 416", async () => {
  const env = makeEnv();
  const response = await call(env, SNAPZ, { headers: { range: "bytes=1000-", "if-range": '"older"' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyBytes(response), BYTES);
});

test("unsatisfiable range: 416 with Content-Range */size, not cacheable, R2 get never called", async () => {
  for (const range of ["bytes=1000-", "bytes=1000-1001", "bytes=5000-6000", "bytes=-0"]) {
    const env = makeEnv();
    const response = await call(env, SNAPZ, { headers: { range } });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get("content-range"), "bytes */1000", range);
    assert.equal(response.headers.get("accept-ranges"), "bytes", range);
    assert.equal(response.headers.get("cache-control"), "no-store", range);
    assertIsolated(response);
    assert.deepEqual(env.ARTIFACTS.calls, [{ op: "head", key: "lean4game" + SNAPZ }], range);
  }
});

test("a Range the worker does not serve (multi-range, other unit, malformed, inverted) is ignored: full 200", async () => {
  for (const range of ["bytes=0-9,20-29", "items=0-9", "bytes=abc", "bytes=-", "bytes=9-0", "0-9", "BYTES=0-9", "bytes= 0-9", "bytes=0-99999999999999999999"]) {
    const env = makeEnv();
    const response = await call(env, SNAPZ, { headers: { range } });
    assert.equal(response.status, 200, range);
    assert.equal(response.headers.get("content-range"), null, range);
    assert.deepEqual(await bodyBytes(response), BYTES, range);
    assert.deepEqual(env.ARTIFACTS.calls, [{ op: "get", key: "lean4game" + SNAPZ, range: null }], range);
  }
});

test("missing artifact: 404 with and without Range", async () => {
  for (const headers of [{}, { range: "bytes=0-99" }]) {
    const env = makeEnv();
    const response = await call(env, "/snapshots/absent.0123456789abcdef.snapz", { headers });
    assert.equal(response.status, 404);
    assertIsolated(response);
    assert.equal(env.assetRequests.length, 0);
  }
});

test("a non-artifact path falls through to the static assets, untouched by Range handling", async () => {
  const env = makeEnv();
  const response = await call(env, "/index.html", { headers: { range: "bytes=0-3" } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "<!doctype html>");
  assert.equal(response.headers.get("accept-ranges"), null);
  assert.equal(response.headers.get("cache-control"), REVALIDATE);
  assertIsolated(response);
  assert.deepEqual(env.assetRequests, ["/index.html"]);
  assert.deepEqual(env.ARTIFACTS.calls, []);
});

test("parseRange / resolveRange", () => {
  assert.deepEqual(parseRange("bytes=0-99"), { first: 0, last: 99 });
  assert.deepEqual(parseRange(" bytes=100- "), { first: 100 });
  assert.equal(parseRange("Bytes = 100 - "), null);
  assert.equal(parseRange("bytes=0-99999999999999999999"), null);
  assert.deepEqual(parseRange("bytes=-100"), { suffix: 100 });
  assert.equal(parseRange(null), null);
  assert.equal(parseRange("bytes=0-1,3-4"), null);
  assert.deepEqual(resolveRange({ first: 0, last: 99 }, 1000), { offset: 0, length: 100 });
  assert.deepEqual(resolveRange({ first: 82182072, last: 82182072 }, 154373030), { offset: 82182072, length: 1 });
  assert.deepEqual(resolveRange({ suffix: 100 }, 1000), { offset: 900, length: 100 });
  assert.equal(resolveRange({ first: 1000 }, 1000), null);
  assert.equal(resolveRange({ suffix: 0 }, 1000), null);
  assert.equal(resolveRange({ suffix: 10 }, 0), null);
});

test("isImmutable is unchanged", () => {
  assert.equal(isImmutable(SNAPZ), true);
  assert.equal(isImmutable("/runtime/lean.wasm.part-003"), true);
  assert.equal(isImmutable("/runtime/runtime-manifest.0123456789abcdef0123.json"), false);
  assert.equal(isImmutable(INDEX), false);
  assert.equal(isImmutable("/assets/index-SkPbkzVH.js"), true);
  assert.equal(isImmutable("/sw.js"), false);
});

/** QED64 HARDENING #64: the per-runtime index copies scripts/upload-artifacts.sh
 * publishes before the deploy. A 16-hex build id is in their names, but a
 * rebake for the same runtime rewrites them, so they revalidate. */
const BUILD = "wasm64-57ae00dc5f6ce958";
const COPIES = [`/snapshots/index.${BUILD}.json`, `/snapshots/profiles-index.${BUILD}.json`];

test("#64: the per-runtime index copies revalidate; .snapz, runtime chunks and pack parts stay immutable", () => {
  for (const p of COPIES) assert.equal(isImmutable(p), false, p);
  assert.equal(isImmutable("/snapshots/profiles-index.json"), false);
  assert.equal(isImmutable(SNAPZ), true);
  assert.equal(isImmutable("/runtime/chunks/lean.wasm.0123456789abcdef.part-000"), true);
  assert.equal(isImmutable("/profiles/lean-core.pack.gzip.1016929d99bb0ba0e148.part-007"), true);
  assert.equal(isImmutable(`/runtime/runtime-manifest.${BUILD}.json`), false);
  assert.equal(isImmutable("/assets/index-SkPbkzVH.js"), true, "vite's hashed index bundle is not an index");
});

test("#64: the copies are the site's (lean4game/), served must-revalidate; a missing copy is a 404 with no-store", async () => {
  const objects = {};
  for (const p of COPIES) {
    assert.equal(artifactKey(p), "lean4game" + p, p);
    objects["lean4game" + p] = { bytes: new TextEncoder().encode(`{"copy":"${p}"}`), etag: '"c"', contentType: "application/json" };
  }
  const env = { ...makeEnv(), ARTIFACTS: fakeBucket(objects) };
  for (const p of COPIES) {
    for (const method of ["GET", "HEAD"]) {
      const response = await call(env, p, { method });
      assert.equal(response.status, 200, `${method} ${p}`);
      assert.equal(response.headers.get("cache-control"), REVALIDATE, `${method} ${p}`);
      assertIsolated(response);
      if (method === "GET") assert.equal(await response.text(), `{"copy":"${p}"}`);
    }
  }
  // Before its upload (or for a runtime the site never published): never cached, so it is found once it lands.
  for (const p of [`/snapshots/index.wasm64-0123456789abcdef.json`, `/snapshots/profiles-index.wasm64-0123456789abcdef.json`]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await call(makeEnv(), p, { method });
      assert.equal(response.status, 404, `${method} ${p}`);
      assert.equal(response.headers.get("cache-control"), "no-store", `${method} ${p}`);
    }
  }
});

test("SEC1: every response carries the connect-src policy — artifact GET, 206, HEAD, 404, 416, asset", async () => {
  assert.equal(CONTENT_SECURITY_POLICY, CSP);
  const cases = [
    [SNAPZ, {}],
    [SNAPZ, { headers: { range: "bytes=0-9" } }],
    [SNAPZ, { method: "HEAD" }],
    [INDEX, {}],
    ["/snapshots/absent.0123456789abcdef.snapz", {}],
    [SNAPZ, { headers: { range: "bytes=5000-" } }],
    ["/index.html", {}],
    ["/sw.js", {}],
    ["/workers/lean.worker.js", {}],
  ];
  for (const [pathname, opts] of cases) {
    const response = await call(makeEnv(), pathname, opts);
    assert.equal(response.headers.get("content-security-policy"), CSP, `${opts.method ?? "GET"} ${pathname} ${JSON.stringify(opts.headers ?? {})} → ${response.status}`);
  }
});

test("SEC1: client/public/_headers and scripts/serve-dist.mjs send the same policy as the worker", () => {
  const headers = readFileSync(new URL("../client/public/_headers", import.meta.url), "utf8");
  const lines = headers.split("\n").filter((l) => /^\s+Content-Security-Policy:/i.test(l));
  assert.deepEqual(lines.map((l) => l.trim()), [`Content-Security-Policy: ${CSP}`]);
  const serveDist = readFileSync(new URL("../scripts/serve-dist.mjs", import.meta.url), "utf8");
  assert.ok(serveDist.includes(`const CONTENT_SECURITY_POLICY = ${JSON.stringify(CSP)};`), "serve-dist.mjs defines the same policy");
  assert.equal((serveDist.match(/"Content-Security-Policy": CONTENT_SECURITY_POLICY/g) ?? []).length, 2, "serve-dist.mjs sends it on the 200 and the 404");
  assert.ok(!/script-src|default-src/.test(headers + serveDist + CONTENT_SECURITY_POLICY), "no script-src / default-src");
});

test("release routing: /runtime/* and /profiles/* are the shared release's, /profiles/index.json and /snapshots/* the site's", () => {
  assert.equal(SITE_PREFIX, "lean4game/");
  assert.match(RELEASE.id, /^lean-v\d+\.\d+\.\d+.*-[0-9a-f]{7}$/);
  const runtimeManifest = `runtime-manifest.${RELEASE.runtime.buildId}.json`;
  const cases = [
    [`/runtime/${runtimeManifest}`, `${REL}runtime/${runtimeManifest}`],
    ["/runtime/runtime-manifest.json", `${REL}runtime/runtime-manifest.json`],
    ["/runtime/chunks/lean.wasm.0123456789abcdef.part-000", `${REL}runtime/chunks/lean.wasm.0123456789abcdef.part-000`],
    ["/profiles/lean-core.manifest.json", `${REL}profiles/lean-core.manifest.json`],
    ["/profiles/lean-core.pack.gzip.0123456789abcdef.part-000", `${REL}profiles/lean-core.pack.gzip.0123456789abcdef.part-000`],
    ["/profiles/index.json", "lean4game/profiles/index.json"],
    ["/snapshots/index.json", "lean4game/snapshots/index.json"],
    [SNAPZ, "lean4game" + SNAPZ],
  ];
  for (const [pathname, key] of cases) assert.equal(artifactKey(pathname), key, pathname);
  // every file the release publishes under a mount is reachable at its served URL
  const mounted = RELEASE.files.map((f) => f.path).filter((p) => p.startsWith("runtime/") || p.startsWith("profiles/"));
  assert.ok(mounted.length > 10, "the release lists its runtime and pack files");
  for (const p of mounted) assert.equal(artifactKey("/" + p), REL + p, p);
});

test("release routing: the worker fetches the release's bytes from R2 under the release prefix", async () => {
  const chunk = "/runtime/chunks/lean.wasm.0123456789abcdef.part-000";
  const env = makeEnv();
  const ARTIFACTS = fakeBucket({ [REL + chunk.slice(1)]: { bytes: BYTES, etag: ETAG, contentType: "application/octet-stream" } });
  const response = await worker.fetch(new Request(ORIGIN + chunk), { ...env, ARTIFACTS });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), IMMUTABLE);
  assertIsolated(response);
  assert.deepEqual(await bodyBytes(response), BYTES);
  assert.deepEqual(ARTIFACTS.calls, [{ op: "get", key: REL + chunk.slice(1), range: null }]);
  // the old site copy is not consulted
  const missing = await worker.fetch(new Request(ORIGIN + "/runtime/chunks/other.0123456789abcdef.part-000"), { ...env, ARTIFACTS });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");
});

test("unsafe artifact paths: 404 without asking R2", async () => {
  for (const pathname of ["/runtime//x.part-000", "/snapshots/a\\b.snapz", "/profiles/%2e%2e/x", "/runtime/chunks/"]) {
    assert.equal(artifactKey(pathname), null, pathname);
  }
  // URL parsing folds dot segments and backslashes before the worker sees them; what is left still never leaves the routes
  const env = makeEnv();
  const response = await call(env, "/runtime//lean.wasm.part-000");
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(env.ARTIFACTS.calls, []);
});

test("errors are never cached: 404 under a digest-named artifact URL, an asset 404", async () => {
  const env = makeEnv();
  for (const method of ["GET", "HEAD"]) {
    const response = await call(env, "/snapshots/absent.0123456789abcdef.snapz", { method });
    assert.equal(response.status, 404, method);
    assert.equal(response.headers.get("cache-control"), "no-store", method);
  }
  const assets404 = { ...makeEnv(), ASSETS: { fetch: async () => new Response("nope", { status: 404 }) } };
  const asset = await call(assets404, "/assets/index-SkPbkzVH.js");
  assert.equal(asset.status, 404);
  assert.equal(asset.headers.get("cache-control"), "no-store");
});

test("releaseRoutes refuses a record it cannot route by", () => {
  const ok = releaseRoutes(RELEASE);
  assert.equal(ok.releasePrefix, REL);
  const bad = (patch) => assert.throws(() => releaseRoutes({ ...RELEASE, ...patch }), /lean4-wasm64-release\.json/);
  bad({ schema: "other/v1" });
  bad({ id: "lean-v4.34.0-0123456789abcdef0123" });
  bad({ id: "../x" });
  bad({ hosting: { ...RELEASE.hosting, layout: "flat" } });
  bad({ hosting: { ...RELEASE.hosting, mount: {} } });
  bad({ hosting: { ...RELEASE.hosting, mount: { "/runtime/": "../runtime/" } } });
  bad({ hosting: { ...RELEASE.hosting, mount: { "/assets/": "runtime/" } } });
  bad({ hosting: { ...RELEASE.hosting, siteOwned: ["/index.html"] } });
});
