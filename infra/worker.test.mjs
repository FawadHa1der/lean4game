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
import worker, { isImmutable, parseRange, resolveRange } from "./worker.js";

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

function assertIsolated(response) {
  assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(response.headers.get("cross-origin-embedder-policy"), "require-corp");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
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

test("HEAD: same path as before (one un-ranged get), 200 with Accept-Ranges", async () => {
  const env = makeEnv();
  const response = await call(env, SNAPZ, { method: "HEAD" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("etag"), ETAG);
  assert.equal(response.headers.get("cache-control"), IMMUTABLE);
  assertIsolated(response);
  assert.deepEqual(env.ARTIFACTS.calls, [{ op: "get", key: "lean4game" + SNAPZ, range: null }]);
});

test("HEAD ignores Range (range handling is defined for GET only)", async () => {
  const env = makeEnv();
  const response = await call(env, SNAPZ, { method: "HEAD", headers: { range: "bytes=0-99" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-range"), null);
  assert.deepEqual(env.ARTIFACTS.calls, [{ op: "get", key: "lean4game" + SNAPZ, range: null }]);
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
