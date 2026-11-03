/* scripts/deploy-guard.mjs (QED64's architecture review R19a): before every
 * deploy, the record, the runtime manifest and both indexes must pair, and every
 * .snapz the tracked snapshot index names must answer on the live origin.
 * `node --test scripts/deploy-guard.test.mjs`.
 *
 * Against an HTTP server in this process with a per-path answer table that
 * records every method and path; the index files live in an OS temp dir; the
 * retry wait is stubbed (it records the waits it was asked for). Nothing leaves
 * the machine.
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_INDEX, DEFAULT_ORIGIN, Refusal, USAGE, checkLiveSnapshots, checkPairing, entriesOf, main } from "./deploy-guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(root, "scripts/deploy-guard.mjs");
const NNG4 = "/snapshots/nng4.0123456789abcdef.snapz";
const RAG = "/snapshots/rag.fedcba9876543210.snapz";
/** main() checks the pairing against the tracked files: an index of the tracked runtime passes it. */
const RECORD = JSON.parse(fs.readFileSync(path.join(root, "wasm/lean4-wasm64-release.json"), "utf8"));
const BUILD_ID = RECORD.runtime.buildId;
const PAIRED_LINE = (n) => `deploy-guard: paired ${n} snapshot(s), the manifest and the profile index with ${RECORD.id} (${BUILD_ID})`;

/** How the server answers a path: `statuses`, one per request (the last repeats), and a Content-Length or none. */
const answers = new Map();
const seen = [];
const allSeen = [];
let tmp, server, origin;
let waits = [];
const sleep = async (ms) => { waits.push(ms); };

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "l4g-deploy-guard-"));
  server = http.createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    seen.push({ method: req.method, path: p });
    allSeen.push({ method: req.method, path: p });
    const a = answers.get(p);
    if (!a) { res.writeHead(404); res.end(); return; }
    const n = seen.filter((s) => s.path === p).length;
    const status = a.statuses[Math.min(n, a.statuses.length) - 1];
    const headers = {};
    if (status === 200 && a.length != null) headers["content-length"] = String(a.length);
    if (a.location) headers.location = a.location;
    res.writeHead(status, headers);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}/`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  answers.clear();
  seen.length = 0;
  waits = [];
});

let n = 0;
/** An index file in the temp dir: a value (written as JSON), or raw text. */
function indexFile(content) {
  const file = path.join(tmp, `index-${n++}.json`);
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}
const entry = (name, url, transfer, bytes = transfer * 4) => ({ name, url, digest: `sha256:${"0".repeat(64)}`, bytes, transfer, imports: [], runtime: BUILD_ID });
const schema = "qed64.snapshot-index/v1";
const twoEntries = () => indexFile({ schema, snapshots: [entry("nng4", NNG4, 1000), entry("rag", RAG, 5000)] });
const check = (index, o = origin) => checkLiveSnapshots({ index, origin: o, sleep });

test("every entry 200 with the index's length: ok, one live line each and the OK line, HEADs only", async () => {
  answers.set(NNG4, { statuses: [200], length: 1000 });
  answers.set(RAG, { statuses: [200], length: 5000 });
  const r = await check(twoEntries());
  assert.deepEqual(r, {
    ok: true,
    lines: [
      `deploy-guard: live ${NNG4} (1000 bytes)`,
      `deploy-guard: live ${RAG} (5000 bytes)`,
      `deploy-guard: OK 2 snapshot(s) live on ${origin}`,
    ],
  });
  assert.deepEqual(seen, [{ method: "HEAD", path: NNG4 }, { method: "HEAD", path: RAG }]);
});

test("a 200 without Content-Length passes on the status alone", async () => {
  answers.set(NNG4, { statuses: [200], length: null });
  answers.set(RAG, { statuses: [200], length: null });
  const r = await check(twoEntries());
  assert.ok(r.ok, r.lines.join("\n"));
  assert.equal(r.lines[0], `deploy-guard: live ${NNG4} (no length sent)`);
});

test("the size is transfer, else bytes", async () => {
  answers.set(NNG4, { statuses: [200], length: 777 });
  const r = await check(indexFile({ schema, snapshots: [{ ...entry("nng4", NNG4, 1000), transfer: undefined, bytes: 777 }] }));
  assert.deepEqual(r.lines, [`deploy-guard: live ${NNG4} (777 bytes)`, `deploy-guard: OK 1 snapshot(s) live on ${origin}`]);
});

test("a 404 refuses, naming the url and the upload; the next entry is never asked, nothing retried", async () => {
  answers.set(RAG, { statuses: [200], length: 5000 });
  const r = await check(twoEntries());
  assert.equal(r.ok, false);
  assert.deepEqual(r.lines, [`deploy-guard: REFUSED: ${NNG4}: HTTP 404 from ${origin}${NNG4.slice(1)} — upload it first (scripts/upload-artifacts.sh), then re-run the deploy`]);
  assert.deepEqual(seen, [{ method: "HEAD", path: NNG4 }]);
  assert.deepEqual(waits, []);
});

test("a 403 refuses without asking for an upload, nothing retried", async () => {
  answers.set(NNG4, { statuses: [403] });
  const r = await check(twoEntries());
  assert.equal(r.ok, false);
  assert.deepEqual(r.lines, [`deploy-guard: REFUSED: ${NNG4}: HTTP 403 from ${origin}${NNG4.slice(1)} — not a missing upload: look at what the origin answers (curl -I), then re-run the deploy`]);
  assert.deepEqual(waits, []);
});

test("a redirect is not followed: a 301 refuses", async () => {
  answers.set(NNG4, { statuses: [301], location: `${origin}elsewhere.snapz` });
  const r = await check(twoEntries());
  assert.equal(r.ok, false);
  assert.match(r.lines.at(-1), /^deploy-guard: REFUSED: \/snapshots\/nng4\.0123456789abcdef\.snapz: HTTP 301 from /);
  assert.deepEqual(seen.map((s) => s.path), [NNG4]);
});

test("a length other than the index's refuses (R2 holds other bytes under the name)", async () => {
  answers.set(NNG4, { statuses: [200], length: 1000 });
  answers.set(RAG, { statuses: [200], length: 4999 });
  const r = await check(twoEntries());
  assert.equal(r.ok, false);
  assert.deepEqual(r.lines, [
    `deploy-guard: live ${NNG4} (1000 bytes)`,
    `deploy-guard: REFUSED: ${RAG}: ${origin}${RAG.slice(1)} answers 4999 bytes, the index says 5000 — R2 holds other bytes under this name`,
  ]);
});

test("a 503 then a 200 passes after one retry (2 s)", async () => {
  answers.set(NNG4, { statuses: [503, 200], length: 1000 });
  answers.set(RAG, { statuses: [200], length: 5000 });
  const r = await check(twoEntries());
  assert.ok(r.ok, r.lines.join("\n"));
  assert.equal(seen.filter((s) => s.path === NNG4).length, 2);
  assert.deepEqual(waits, [2000]);
  assert.equal(r.lines[0], `deploy-guard: retry ${origin}${NNG4.slice(1)}: HTTP 503; try 2 of 3 in 2 s`);
});

test("three 5xx answers are no pass: refused after three tries (waits 2 s, then 4 s)", async () => {
  answers.set(NNG4, { statuses: [502, 503, 500] });
  const r = await check(twoEntries());
  assert.equal(r.ok, false);
  assert.equal(r.lines.at(-1), `deploy-guard: REFUSED: ${NNG4}: ${origin}${NNG4.slice(1)} could not be reached (HTTP 500, 3 tries)`);
  assert.equal(seen.length, 3);
  assert.deepEqual(waits, [2000, 4000]);
});

test("a network error is no pass: a closed port refuses after three tries", async () => {
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  const r = await check(twoEntries(), `http://127.0.0.1:${port}/`);
  assert.equal(r.ok, false);
  assert.match(r.lines.at(-1), new RegExp(`^deploy-guard: REFUSED: /snapshots/nng4\\.0123456789abcdef\\.snapz: http://127\\.0\\.0\\.1:${port}/snapshots/nng4\\.0123456789abcdef\\.snapz could not be reached \\(.+, 3 tries\\)$`));
  assert.deepEqual(waits, [2000, 4000]);
});

test("an entry url that is not a .snapz directly under /snapshots/ refuses before any request (never a release-mapped path)", async () => {
  for (const url of ["/runtime/x.snapz", "/profiles/x.snapz", "https://e.example/snapshots/x.snapz", "/snapshots/a/b.snapz", "/snapshots/x.json", "/snapshots/.x.snapz", 42]) {
    const r = await check(indexFile({ schema, snapshots: [entry("nng4", NNG4, 1000), { ...entry("bad", "", 10), url }] }));
    assert.equal(r.ok, false, String(url));
    assert.deepEqual(r.lines, [`deploy-guard: REFUSED: snapshot bad names ${JSON.stringify(url)}, not a .snapz directly under /snapshots/`]);
  }
  assert.deepEqual(seen, []);
});

test("an entry without a positive integer size refuses before any request", async () => {
  for (const size of [0, -1, 1.5, "100", null]) {
    const r = await check(indexFile({ schema, snapshots: [{ ...entry("nng4", NNG4, 1000), transfer: size, bytes: size }] }));
    assert.equal(r.ok, false, String(size));
    assert.match(r.lines.at(-1), /^deploy-guard: REFUSED: snapshot nng4 \(\/snapshots\/nng4\.0123456789abcdef\.snapz\) gives .* as its size/);
  }
  assert.deepEqual(seen, []);
});

test("a missing index, one that is not JSON, or one of another schema refuses", async () => {
  for (const [file, re] of [
    [path.join(tmp, "absent.json"), /cannot be read \(ENOENT\)$/],
    [indexFile("{ not json"), /is not JSON \(/],
    [indexFile({ schema: "qed64.profile-index/v1", profiles: [] }), /is not a qed64\.snapshot-index\/v1 index with a snapshots array$/],
    [indexFile({ schema }), /is not a qed64\.snapshot-index\/v1 index with a snapshots array$/],
    [indexFile("null"), /is not a qed64\.snapshot-index\/v1 index with a snapshots array$/],
  ]) {
    const r = await check(file);
    assert.equal(r.ok, false, file);
    assert.equal(r.lines.length, 1);
    assert.match(r.lines[0], /^deploy-guard: REFUSED: index /);
    assert.match(r.lines[0], re);
  }
  assert.deepEqual(seen, []);
});

test("an origin that is not http(s) refuses before any request", async () => {
  for (const o of ["file:///tmp/", "ftp://127.0.0.1/", "", "lean4game"]) {
    const r = await check(twoEntries(), o);
    assert.equal(r.ok, false, o);
    assert.deepEqual(r.lines, [`deploy-guard: REFUSED: origin ${JSON.stringify(o)} is not an http(s) URL`]);
  }
  assert.deepEqual(seen, []);
});

test("entriesOf: an index's entries or a Refusal; the tracked index names only .snapz directly under /snapshots/", () => {
  assert.deepEqual(entriesOf(twoEntries()), [{ name: "nng4", url: NNG4, size: 1000, runtime: BUILD_ID }, { name: "rag", url: RAG, size: 5000, runtime: BUILD_ID }]);
  assert.throws(() => entriesOf(path.join(tmp, "absent.json")), Refusal);
  assert.equal(DEFAULT_INDEX, path.join(root, "client/public/snapshots/index.json"));
  const tracked = entriesOf(DEFAULT_INDEX);
  assert.ok(tracked.length > 0);
  for (const e of tracked) assert.match(e.url, /^\/snapshots\/[^/]+\.snapz$/);
});

/* The pairing: what one deploy carries names one runtime. */
const ID = "wasm64-0123456789abcdef";
const OTHER = "wasm64-ffffffffffffffff";
/** A scratch tree of the four files (each a value, written as JSON, or absent as undefined). */
function tree(files = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, "tree-"));
  const all = {
    "wasm/lean4-wasm64-release.json": { id: "lean-v1.0.0-abcdef0", runtime: { buildId: ID } },
    "client/public/runtime/runtime-manifest.json": { buildId: ID },
    "client/public/profiles/index.json": { schema: "qed64.profile-index/v1", runtime: { buildId: ID }, profiles: [] },
    "client/public/snapshots/index.json": { schema, snapshots: [{ ...entry("nng4", NNG4, 1000), runtime: ID }, { ...entry("rag", RAG, 5000), runtime: ID }] },
    ...files,
  };
  for (const [rel, value] of Object.entries(all)) {
    if (value === undefined) continue;
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof value === "string" ? value : JSON.stringify(value));
  }
  return { root: dir, index: path.join(dir, "client/public/snapshots/index.json") };
}

test("pairing: one runtime everywhere passes, with one line naming it", () => {
  assert.deepEqual(checkPairing(tree()), { ok: true, lines: [`deploy-guard: paired 2 snapshot(s), the manifest and the profile index with lean-v1.0.0-abcdef0 (${ID})`] });
});

test("pairing: the tracked record, runtime manifest and both indexes pair (CI's test job runs this before the deploy job)", () => {
  assert.deepEqual(checkPairing(), { ok: true, lines: [PAIRED_LINE(entriesOf(DEFAULT_INDEX).length)] });
});

test("pairing: a record, manifest, profile index or snapshot on another runtime refuses, naming both ids", () => {
  const bump = (runtime) => ({ schema, snapshots: [{ ...entry("nng4", NNG4, 1000), runtime: ID }, { ...entry("rag", RAG, 5000), runtime }] });
  for (const [files, who, names] of [
    [{ "wasm/lean4-wasm64-release.json": { id: "lean-v1.0.0-abcdef0", runtime: { buildId: OTHER } } }, "client/public/runtime/runtime-manifest.json", ID],
    [{ "client/public/runtime/runtime-manifest.json": { buildId: OTHER } }, "client/public/runtime/runtime-manifest.json", OTHER],
    [{ "client/public/profiles/index.json": { schema: "qed64.profile-index/v1", runtime: { buildId: OTHER }, profiles: [] } }, "client/public/profiles/index.json", OTHER],
    [{ "client/public/snapshots/index.json": bump(OTHER) }, `snapshot rag (${RAG})`, OTHER],
  ]) {
    const r = checkPairing(tree(files));
    assert.equal(r.ok, false, who);
    assert.equal(r.lines.length, 1);
    assert.match(r.lines[0], /^deploy-guard: REFUSED: /);
    assert.ok(r.lines[0].includes(`${who} names runtime ${JSON.stringify(names)}, but wasm/lean4-wasm64-release.json (lean-v1.0.0-abcdef0) names `), r.lines[0]);
    assert.match(r.lines[0], /every boot would refuse every game/);
  }
});

test("pairing: an absent id is no pass (no id in the manifest, the profile index or an entry)", () => {
  for (const [files, re] of [
    [{ "client/public/runtime/runtime-manifest.json": {} }, /runtime-manifest\.json names runtime undefined,/],
    [{ "client/public/profiles/index.json": { schema: "qed64.profile-index/v1", profiles: [] } }, /profiles\/index\.json names runtime undefined,/],
    [{ "client/public/snapshots/index.json": { schema, snapshots: [{ ...entry("nng4", NNG4, 1000), runtime: undefined }] } }, /snapshot nng4 .* names runtime undefined,/],
    [{ "wasm/lean4-wasm64-release.json": { id: "x" } }, /lean4-wasm64-release\.json names undefined as runtime\.buildId/],
  ]) {
    const r = checkPairing(tree(files));
    assert.equal(r.ok, false, String(re));
    assert.match(r.lines[0], re);
  }
});

test("pairing: an index with no snapshot refuses", () => {
  const t = tree({ "client/public/snapshots/index.json": { schema, snapshots: [] } });
  assert.deepEqual(checkPairing(t), { ok: false, lines: [`deploy-guard: REFUSED: index ${t.index} names no snapshot: every game would be unavailable`] });
});

test("pairing: a file missing or not JSON refuses, naming it", () => {
  for (const [files, re] of [
    [{ "wasm/lean4-wasm64-release.json": undefined }, /^deploy-guard: REFUSED: release record .* cannot be read \(ENOENT\)$/],
    [{ "client/public/runtime/runtime-manifest.json": "{ not json" }, /^deploy-guard: REFUSED: runtime manifest .* is not JSON \(/],
    [{ "client/public/profiles/index.json": undefined }, /^deploy-guard: REFUSED: profile index .* cannot be read \(ENOENT\)$/],
    [{ "client/public/snapshots/index.json": undefined }, /^deploy-guard: REFUSED: index .* cannot be read \(ENOENT\)$/],
  ]) {
    const r = checkPairing(tree(files));
    assert.equal(r.ok, false, String(re));
    assert.match(r.lines[0], re);
  }
});

const io = (extra = {}) => {
  const out = [], err = [];
  return { out, err, io: { out: (l) => out.push(l), err: (l) => err.push(l), sleep, ...extra } };
};

test("main: none skips the live check with exit 0 and asks nothing, from the variable or the flag", async () => {
  let fetched = 0;
  const fetchImpl = async () => { fetched++; return new Response(null); };
  for (const [argv, env] of [[[], { LEAN4GAME_DEPLOY_ORIGIN: "none" }], [["--origin", "none"], {}]]) {
    const t = io({ fetchImpl });
    assert.equal(await main(argv, env, t.io), 0);
    assert.deepEqual(t.err, [PAIRED_LINE(entriesOf(DEFAULT_INDEX).length), "deploy-guard: SKIPPED: the origin is none (a first deploy: no live origin to ask yet)"]);
    assert.deepEqual(t.out, []);
  }
  assert.equal(fetched, 0);
  assert.deepEqual(seen, []);
});

test("main: a mispaired index refuses with exit 1 before any HEAD, also with the origin none", async () => {
  answers.set(NNG4, { statuses: [200], length: 1000 });
  const index = indexFile({ schema, snapshots: [{ ...entry("nng4", NNG4, 1000), runtime: OTHER }] });
  for (const argv of [["--index", index, "--origin", origin], ["--index", index, "--origin", "none"]]) {
    const t = io();
    assert.equal(await main(argv, {}, t.io), 1, argv.join(" "));
    assert.equal(t.err.length, 1);
    assert.match(t.err[0], /^deploy-guard: REFUSED: snapshot nng4 .* names runtime "wasm64-ffffffffffffffff", but /);
  }
  assert.deepEqual(seen, []);
});

test("main: an index with no snapshot refuses with exit 1, also with the origin none", async () => {
  const index = indexFile({ schema, snapshots: [] });
  for (const argv of [["--index", index, "--origin", origin], ["--index", index, "--origin", "none"]]) {
    const t = io();
    assert.equal(await main(argv, {}, t.io), 1, argv.join(" "));
    assert.match(t.err.at(-1), /names no snapshot/);
  }
  assert.deepEqual(seen, []);
});

test("main: an unknown argument, a flag without a value or given twice exits 2 with the usage line", async () => {
  for (const argv of [["--bogus"], ["--index"], ["--origin="], ["--index", "a", "--index=b"], ["stray"]]) {
    const t = io();
    assert.equal(await main(argv, {}, t.io), 2, argv.join(" "));
    assert.equal(t.err.length, 2);
    assert.match(t.err[0], /^deploy-guard: /);
    assert.equal(t.err[1], USAGE);
  }
  assert.deepEqual(seen, []);
});

test("main: --help prints the usage on stdout and exits 0", async () => {
  const t = io();
  assert.equal(await main(["--help"], {}, t.io), 0);
  assert.deepEqual(t.out, [USAGE]);
});

test("main: --index and --origin (or the variable): 0 when live, 1 refused; the flag wins over the variable, also over none", async () => {
  answers.set(NNG4, { statuses: [200], length: 1000 });
  answers.set(RAG, { statuses: [200], length: 5000 });
  const index = twoEntries();
  let t = io();
  assert.equal(await main(["--index", index, `--origin=${origin}`], {}, t.io), 0);
  assert.equal(t.err.at(-1), `deploy-guard: OK 2 snapshot(s) live on ${origin}`);
  assert.deepEqual(t.out, []);
  t = io();
  assert.equal(await main([`--index=${index}`], { LEAN4GAME_DEPLOY_ORIGIN: origin }, t.io), 0);
  t = io();
  assert.equal(await main(["--index", index, "--origin", origin], { LEAN4GAME_DEPLOY_ORIGIN: "none" }, t.io), 0);
  assert.match(t.err.at(-1), /^deploy-guard: OK /);
  answers.delete(RAG);
  t = io();
  assert.equal(await main(["--index", index, "--origin", origin], {}, t.io), 1);
  assert.match(t.err.at(-1), /^deploy-guard: REFUSED: \/snapshots\/rag\.fedcba9876543210\.snapz: HTTP 404 /);
});

test("the default origin is this site's live one", () => {
  assert.equal(DEFAULT_ORIGIN, "https://lean4game.fawadworkaddress.workers.dev");
});

test("as a CLI: the exit code is main's, every line on stderr", async () => {
  answers.set(NNG4, { statuses: [200], length: 1000 });
  answers.set(RAG, { statuses: [200], length: 5000 });
  const index = twoEntries();
  const run = (args, env = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  let r = await run(["--index", index, "--origin", origin]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "");
  assert.deepEqual(r.stderr.trimEnd().split("\n"), [
    PAIRED_LINE(2),
    `deploy-guard: live ${NNG4} (1000 bytes)`,
    `deploy-guard: live ${RAG} (5000 bytes)`,
    `deploy-guard: OK 2 snapshot(s) live on ${origin}`,
  ]);
  answers.set(RAG, { statuses: [200], length: 1 });
  r = await run(["--index", index], { LEAN4GAME_DEPLOY_ORIGIN: origin });
  assert.equal(r.code, 1);
  assert.match(r.stderr.trimEnd().split("\n").at(-1), /^deploy-guard: REFUSED: .* answers 1 bytes, the index says 5000/);
  r = await run([], { LEAN4GAME_DEPLOY_ORIGIN: "none" });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /^deploy-guard: paired .*\ndeploy-guard: SKIPPED: /);
  r = await run(["--nope"]);
  assert.equal(r.code, 2);
});

test("every request any test above made was a HEAD", () => {
  assert.ok(allSeen.length > 0);
  assert.deepEqual(allSeen.filter((s) => s.method !== "HEAD"), []);
});
