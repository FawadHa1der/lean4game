/* scripts/fetch-artifacts.mjs, the fetch from the live site (lean4game review UB):
 * `node --test scripts/fetch-artifacts.test.mjs`.
 *
 * The real script runs from a scratch copy of the repository layout under the OS
 * temp dir, so it reads that copy's manifest and index, against a local http
 * server that plays the origin. Nothing leaves the machine.
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const BUILD_ID = "wasm64-0123456789abcdef";

const CHUNKS = {
  "/runtime/chunks/lean.js.aa.part-000": Buffer.alloc(3000, "j"),
  "/runtime/chunks/lean.wasm.bb.part-000": Buffer.alloc(5000, "w"),
  "/runtime/chunks/lean.wasm.cc.part-001": Buffer.alloc(4000, "x"),
};
const SNAPZ = {
  "/snapshots/testgame.dd.snapz": Buffer.alloc(6000, "t"),
  "/snapshots/nng4.ee.snapz": Buffer.alloc(7000, "n"),
};
const OBJECTS = { ...CHUNKS, ...SNAPZ };
const TESTGAME = "/snapshots/testgame.dd.snapz", NNG4 = "/snapshots/nng4.ee.snapz";
const WASM0 = "/runtime/chunks/lean.wasm.bb.part-000";
const chunkEntry = (url) => ({ url, bytes: CHUNKS[url].length, sha256: sha256(CHUNKS[url]) });
const MANIFEST = {
  buildId: BUILD_ID,
  files: {
    "lean.js": { chunks: [chunkEntry("/runtime/chunks/lean.js.aa.part-000")] },
    "lean.wasm": { chunks: [chunkEntry(WASM0), chunkEntry("/runtime/chunks/lean.wasm.cc.part-001")] },
  },
};
// `bytes` is the inflated size, which the script must not read as the served one.
const snapEntry = (name, url) => ({ name, url, bytes: SNAPZ[url].length * 4, transfer: SNAPZ[url].length, digest: `sha256:${sha256(SNAPZ[url])}`, runtime: BUILD_ID });
const INDEX = { schema: "qed64.snapshot-index/v1", snapshots: [snapEntry("testgame", TESTGAME), snapEntry("nng4", NNG4)] };

let tmp, repo, server, origin;
let gets = []; // every request the origin saw, in order
let active = 0, peak = 0;
let fault = {}; // url -> (res, nth GET of that url) => true when it answered

/** The checkout's tracked manifest and index. */
const tracked = (manifest, index) => {
  for (const [rel, doc] of [["runtime/runtime-manifest.json", manifest], ["snapshots/index.json", index]]) {
    const f = path.join(repo, "client/public", rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(doc));
  }
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "l4g-fetch-artifacts-"));
  repo = path.join(tmp, "repo");
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(root, "scripts/fetch-artifacts.mjs"), path.join(repo, "scripts/fetch-artifacts.mjs"));
  tracked(MANIFEST, INDEX);
  server = http.createServer((req, res) => {
    gets.push({ url: req.url, method: req.method, encoding: req.headers["accept-encoding"] });
    active++; peak = Math.max(peak, active);
    res.on("close", () => { active--; });
    const nth = gets.filter((g) => g.url === req.url).length;
    // Long enough for a second download to start while this one is open.
    setTimeout(() => {
      if (fault[req.url]?.(res, nth)) return;
      const body = OBJECTS[req.url];
      if (!body) { res.writeHead(404).end("not found"); return; }
      res.writeHead(200, { "Content-Length": body.length }).end(body);
    }, 15);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  gets = []; peak = 0; fault = {};
  tracked(MANIFEST, INDEX);
  fs.rmSync(path.join(repo, "client/public/runtime/chunks"), { recursive: true, force: true });
  for (const f of fs.readdirSync(path.join(repo, "client/public/snapshots"))) if (f !== "index.json") fs.rmSync(path.join(repo, "client/public/snapshots", f));
});

// Asynchronous: the origin is this process, so a spawnSync would block it.
const run = (args = [], withOrigin = true) => new Promise((resolve) => {
  execFile(process.execPath, ["scripts/fetch-artifacts.mjs", ...(withOrigin ? ["--origin", origin] : []), ...args], { cwd: repo, encoding: "utf8" },
    (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr }));
});
const inPublic = (url) => path.join(repo, "client/public", url);
const urls = () => gets.map((g) => g.url);
const count = (url) => urls().filter((u) => u === url).length;
const partials = (dir = path.join(repo, "client/public")) =>
  fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".partial"));
const assertFetched = (list, base = path.join(repo, "client/public")) => {
  for (const url of list) assert.deepEqual(fs.readFileSync(path.join(base, url)), OBJECTS[url], url);
};

test("a good run writes every chunk and snapshot under client/public, verified", async () => {
  const r = await run();
  assert.equal(r.status, 0, r.stderr);
  assertFetched(Object.keys(OBJECTS));
  assert.deepEqual(partials(), []);
  assert.match(r.stdout, /5 files verified \(5 fetched, 0 already there\)/);
  assert.match(r.stdout, new RegExp(`runtime ${BUILD_ID}, snapshots testgame, nng4`));
  assert.deepEqual(urls().slice(0, 3).sort(), Object.keys(CHUNKS).sort(), "the chunks first");
  assert.equal(gets.length, 5);
  assert.ok(gets.every((g) => g.method === "GET" && g.encoding === "identity"), "the served bytes, never a re-encoding of them");
  assert.equal(peak, 2, "two downloads at once");
});

test("a wrong digest of the right size fails after three tries, and nothing stays under its name", async () => {
  fault[TESTGAME] = (res) => { res.writeHead(200, { "Content-Length": 6000 }).end(Buffer.alloc(6000, "?")); return true; };
  const r = await run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /testgame\.dd\.snapz: sha256 [0-9a-f]{64}, the tracked digest is /);
  assert.match(r.stderr, /fetch-artifacts: FAILED: testgame\.dd\.snapz/);
  assert.equal(count(TESTGAME), 3);
  assert.equal(fs.existsSync(inPublic(TESTGAME)), false);
  assert.deepEqual(partials(), []);
  assertFetched([...Object.keys(CHUNKS), NNG4]);
});

test("a wrong size, a 500 and a body cut midway each get another try", async () => {
  fault[TESTGAME] = (res, nth) => { if (nth > 1) return false; res.writeHead(200, { "Content-Length": 10 }).end(Buffer.alloc(10, "t")); return true; };
  fault[NNG4] = (res, nth) => { if (nth > 1) return false; res.writeHead(500).end("oops"); return true; };
  fault[WASM0] = (res, nth) => { if (nth > 1) return false; res.writeHead(200, { "Content-Length": 5000 }); res.write(Buffer.alloc(100, "w"), () => res.destroy()); return true; };
  const r = await run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /testgame\.dd\.snapz: 10 bytes, the tracked size is 6000; try 2 of 3/);
  assert.match(r.stderr, /nng4\.ee\.snapz: HTTP 500; try 2 of 3/);
  assert.match(r.stderr, /lean\.wasm\.bb\.part-000: .*; try 2 of 3/);
  assertFetched(Object.keys(OBJECTS));
  assert.deepEqual(partials(), []);
});

test("an origin that does not answer says why, and stops at the runtime", async () => {
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  const r = await run(["--origin", `http://127.0.0.1:${port}`], false);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /part-00\d: fetch failed: .*ECONNREFUSED/);
  assert.match(r.stderr, /fetch-artifacts: FAILED: /);
  assert.doesNotMatch(r.stderr, /snapz/, "no snapshot is tried without the runtime");
  assert.equal(fs.existsSync(inPublic("runtime/chunks/lean.js.aa.part-000")), false);
});

test("a 404 on a runtime chunk says the live site serves another runtime, and what to do", async () => {
  for (const url of Object.keys(CHUNKS)) fault[url] = (res) => { res.writeHead(404).end("not found"); return true; };
  const r = await run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`404: ${origin} serves another runtime than this checkout \\(${BUILD_ID}\\)`));
  assert.match(r.stderr, /it maps \/runtime\/\* into its own release/);
  assert.match(r.stderr, /a checkout of what is live: git pull/);
  assert.match(r.stderr, /build the artifacts from source/);
  assert.ok(urls().every((u) => u.startsWith("/runtime/chunks/")), `no snapshot is worth fetching without the runtime: ${urls()}`);
  assert.ok(urls().every((u) => count(u) === 1), "a 404 gets no second try");
  assert.equal(gets.length, 2, "a chunk's final failure ends the chunks: the third is never asked");
  assert.equal(fs.existsSync(inPublic("snapshots/testgame.dd.snapz")), false);
});

test("no snapshot starts until every chunk is verified, whichever chunk fails", async () => {
  fault["/runtime/chunks/lean.wasm.cc.part-001"] = (res) => { res.writeHead(404).end("not found"); return true; };
  const r = await run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /lean\.wasm\.cc\.part-001: 404: .* serves another runtime/);
  assert.deepEqual(urls().sort(), Object.keys(CHUNKS).sort());
});

test("a 404 on a snapshot fails that file, says so and lets the others finish", async () => {
  fault[TESTGAME] = (res) => { res.writeHead(404).end("not found"); return true; };
  const r = await run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /testgame\.dd\.snapz: 404: .* does not hold this checkout's snapshot\. .*git pull/);
  assert.doesNotMatch(r.stderr, /another runtime/);
  assert.equal(count(TESTGAME), 1);
  assertFetched([...Object.keys(CHUNKS), NNG4]);
});

test("a rerun skips what is verified and redoes only what is missing or wrong", async () => {
  assert.equal((await run()).status, 0);
  gets = [];
  const again = await run();
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(gets, [], "nothing fetched");
  assert.match(again.stdout, /5 files verified \(0 fetched, 5 already there\)/);
  // One file gone, one of the right size with other bytes, one a killed run left as .partial.
  fs.rmSync(inPublic(WASM0));
  fs.writeFileSync(inPublic(NNG4), Buffer.alloc(7000, "?"));
  fs.renameSync(inPublic(TESTGAME), `${inPublic(TESTGAME)}.partial`);
  fs.truncateSync(`${inPublic(TESTGAME)}.partial`, 100);
  gets = [];
  const redo = await run();
  assert.equal(redo.status, 0, redo.stderr);
  assert.deepEqual(urls().sort(), [NNG4, TESTGAME, WASM0].sort());
  assertFetched(Object.keys(OBJECTS));
  assert.deepEqual(partials(), []);
  assert.match(redo.stdout, /5 files verified \(3 fetched, 2 already there\)/);
});

test("a file that is wrong on disk is gone even when its fetch fails", async () => {
  assert.equal((await run()).status, 0);
  fs.writeFileSync(inPublic(TESTGAME), Buffer.alloc(6000, "?"));
  fault[TESTGAME] = (res) => { res.writeHead(404).end("not found"); return true; };
  assert.equal((await run()).status, 1);
  assert.equal(fs.existsSync(inPublic(TESTGAME)), false);
});

test("--only takes the runtime and the named snapshots", async () => {
  const one = await run(["--only", "testgame"]);
  assert.equal(one.status, 0, one.stderr);
  assert.deepEqual(urls().sort(), [...Object.keys(CHUNKS), TESTGAME].sort());
  assert.match(one.stdout, /4 files verified .*snapshots testgame$/m);
  assert.equal(fs.existsSync(inPublic(NNG4)), false);
  gets = [];
  const two = await run(["--only", "testgame", "nng4"]);
  assert.equal(two.status, 0, two.stderr);
  assert.deepEqual(urls(), [NNG4], "what the first run fetched is skipped");
  assert.match(two.stdout, /snapshots testgame, nng4$/m);
});

test("--only with a name the index does not have fetches nothing", async () => {
  const r = await run(["--only", "testgame", "no-such-game"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no snapshot named no-such-game; the index has testgame, nng4/);
  assert.deepEqual(gets, []);
});

for (const [what, url] of [
  ["a traversal", "/runtime/chunks/../../../../outside.part-000"],
  ["a name of dots", "/runtime/chunks/.."],
  ["another host", "http://elsewhere.invalid/runtime/chunks/off.part-000"],
  ["another host, protocol-relative", "//elsewhere.invalid/runtime/chunks/off.part-000"],
  ["another directory", "/elsewhere/off.part-000"],
  ["the snapshots' directory", "/snapshots/off.part-000"],
  ["a directory below", "/runtime/chunks/sub/off.part-000"],
  ["an unsafe name", "/runtime/chunks/off part-000"],
  ["a query", "/runtime/chunks/off.part-000?x=1"],
  ["no url", undefined],
]) {
  test(`a chunk whose tracked url is ${what}: exit 2, nothing fetched`, async () => {
    tracked({ ...MANIFEST, files: { ...MANIFEST.files, "lean.js": { chunks: [{ url, bytes: 3000, sha256: "0".repeat(64) }] } } }, INDEX);
    const before = fs.readdirSync(tmp, { recursive: true }).sort();
    const r = await run();
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /the tracked url .* is not a plain file under \/runtime\/chunks\/: nothing fetched/);
    assert.deepEqual(gets, []);
    assert.deepEqual(fs.readdirSync(tmp, { recursive: true }).sort(), before, "no file written or removed");
  });
}

for (const [what, url] of [
  ["another directory, which once deleted the tracked index", "/elsewhere/index.json"],
  ["the tracked index itself", "/snapshots/index.json"],
  ["a traversal", "/snapshots/../runtime/runtime-manifest.json"],
]) {
  test(`a snapshot whose tracked url is ${what}: exit 2, nothing fetched, the tracked files stay`, async () => {
    tracked(MANIFEST, { ...INDEX, snapshots: [snapEntry("testgame", TESTGAME), { ...snapEntry("nng4", NNG4), url }] });
    const r = await run();
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /the tracked url .* is not a plain file under \/snapshots\/: nothing fetched/);
    assert.deepEqual(gets, []);
    assert.ok(fs.existsSync(inPublic("/snapshots/index.json")) && fs.existsSync(inPublic("/runtime/runtime-manifest.json")));
  });
}

for (const [what, manifest, index, message] of [
  ["no files in the manifest", { buildId: BUILD_ID, files: {} }, INDEX, /the runtime manifest lists no chunks/],
  ["files with no chunks", { buildId: BUILD_ID, files: { "lean.js": { chunks: [] }, "lean.wasm": {} } }, INDEX, /the runtime manifest lists no chunks/],
  ["no manifest files key", { buildId: BUILD_ID }, INDEX, /the runtime manifest lists no chunks/],
  ["an empty index", MANIFEST, { snapshots: [] }, /the snapshot index lists no snapshots/],
  ["no index key", MANIFEST, {}, /the snapshot index lists no snapshots/],
  ["both empty", { buildId: BUILD_ID, files: {} }, { snapshots: [] }, /the runtime manifest lists no chunks/],
]) {
  test(`nothing to verify is not a success, exit 2 before any fetch: ${what}`, async () => {
    tracked(manifest, index);
    const r = await run();
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, message);
    assert.doesNotMatch(r.stdout, /verified/);
    assert.deepEqual(gets, []);
  });
}

test("--out writes there, and the manifests still come from the checkout", async () => {
  const out = path.join(tmp, "elsewhere");
  const r = await run(["--out", out, "--only", "nng4"]);
  assert.equal(r.status, 0, r.stderr);
  assertFetched([...Object.keys(CHUNKS), NNG4], out);
  assert.equal(fs.existsSync(inPublic("runtime/chunks")), false);
  fs.rmSync(out, { recursive: true, force: true });
});

test("--origin with a trailing slash asks the same paths; the default is the live site", async () => {
  const r = await run(["--origin", `${origin}/`, "--only", "nng4"], false);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(urls().includes(NNG4));
  assert.match(fs.readFileSync(path.join(root, "scripts/fetch-artifacts.mjs"), "utf8"), /origin = "https:\/\/lean4game\.fawadworkaddress\.workers\.dev"/);
});

for (const args of [["--nope"], ["--only"], ["--only", "--out", "x"], ["--out"], ["--origin"], ["--origin", "not a url"]]) {
  test(`a bad argument fetches nothing, exit 2: ${args.join(" ")}`, async () => {
    const r = await run(args, false);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage: node scripts\/fetch-artifacts\.mjs/);
    assert.deepEqual(gets, []);
  });
}
