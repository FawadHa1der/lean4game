/* scripts/deploy-app.sh: `node --test scripts/deploy-app.test.mjs`.
 *
 * The script runs for real from a scratch copy of the repository layout under
 * the OS temp dir, on an explicit PATH whose `npx` is a fake that logs its
 * argv, with SKIP_BUILD=1 over a small built tree, and with the real
 * scripts/deploy-guard.mjs asking an HTTP server in this process. stage-workers
 * and games-manifest are stubs (their own tests cover them). Nothing is
 * inherited from the environment (no credentials), nothing leaves the machine.
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPZ = "nng4.0123456789abcdef.snapz";
const SIZE = 10; // the bytes of the fake .snapz

let tmp, repo, bin, server, origin;
/** What the live origin answers for the .snapz. */
let snapzStatus = 200;
const originRequests = [];

const write = (rel, data, mode) => {
  const f = path.join(repo, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data, mode ? { mode } : undefined);
};
const BUILD_ID = "wasm64-0123456789abcdef";
const OTHER_BUILD_ID = "wasm64-ffffffffffffffff";
const SNAPSHOT_INDEX = JSON.stringify({ schema: "qed64.snapshot-index/v1", snapshots: [{ name: "nng4", url: `/snapshots/${SNAPZ}`, transfer: SIZE, bytes: 40, runtime: BUILD_ID }] });
const PROFILE_INDEX = JSON.stringify({ schema: "qed64.profile-index/v1", runtime: { buildId: BUILD_ID }, profiles: [] });
const MANIFEST = JSON.stringify({ buildId: BUILD_ID });
const RECORD = JSON.stringify({ id: "lean-v1.0.0-abcdef0", runtime: { buildId: BUILD_ID } });

/** The tracked files and a complete build of them. */
function layout() {
  fs.rmSync(path.join(repo, "client"), { recursive: true, force: true });
  fs.rmSync(path.join(repo, "wasm"), { recursive: true, force: true });
  fs.mkdirSync(path.join(repo, "client/node_modules"), { recursive: true });
  for (const base of ["client/public", "client/dist"]) {
    write(`${base}/snapshots/index.json`, SNAPSHOT_INDEX);
    write(`${base}/profiles/index.json`, PROFILE_INDEX);
    write(`${base}/profiles/lean-core.manifest.json`, "{}");
    write(`${base}/runtime/runtime-manifest.json`, MANIFEST);
  }
  write("wasm/lean4-wasm64-release.json", RECORD);
  write(`client/dist/snapshots/${SNAPZ}`, "0123456789");
  write("client/dist/profiles/lean-core.pack.gzip.0123456789abcdef.part-000", "part");
  write("client/dist/runtime/chunks/lean.wasm.0123456789abcdef.part-000", "chunk");
  write("client/dist/index.html", "<!doctype html>");
  write("client/dist/workers/lean.worker.js", "//");
  write("client/dist/sw.js", 'const PRECACHE = ["/index.html","/runtime/runtime-manifest.json","/snapshots/index.json","/profiles/index.json"];\n');
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "l4g-deploy-app-"));
  repo = path.join(tmp, "repo");
  bin = path.join(tmp, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  for (const f of ["deploy-app.sh", "deploy-guard.mjs"]) fs.copyFileSync(path.join(root, "scripts", f), path.join(repo, "scripts", f));
  write("scripts/stage-workers.sh", '#!/bin/bash\n[ "${1:-}" != --list ] || echo workers/lean.worker.js\n', 0o755);
  write("scripts/games-manifest.mjs", "");
  fs.writeFileSync(path.join(bin, "npx"), '#!/bin/bash\necho "$@" >> "$FAKE_NPX_LOG"\n', { mode: 0o755 });
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  server = http.createServer((req, res) => {
    originRequests.push(`${req.method} ${req.url}`);
    res.writeHead(req.url === `/snapshots/${SNAPZ}` ? snapzStatus : 404, snapzStatus === 200 ? { "content-length": String(SIZE) } : {});
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  layout();
  snapzStatus = 200;
  originRequests.length = 0;
});

/** Runs the script (asynchronously: the origin is served from this process). */
function run(args = [], extra = {}) {
  const log = path.join(tmp, "npx.log");
  fs.writeFileSync(log, "");
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp, SKIP_BUILD: "1", FAKE_NPX_LOG: log, LEAN4GAME_DEPLOY_ORIGIN: origin, ...extra };
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", [path.join(repo, "scripts/deploy-app.sh"), ...args], { cwd: tmp, env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr, npx: fs.readFileSync(log, "utf8").split("\n").filter(Boolean) }));
  });
}

test("the guard asks the live origin, then wrangler deploys", async () => {
  const r = await run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(originRequests, [`HEAD /snapshots/${SNAPZ}`]);
  assert.deepEqual(r.npx, ["wrangler deploy"]);
  assert.match(r.stderr, new RegExp(`deploy-guard: OK 1 snapshot\\(s\\) live on ${origin}/`));
});

test("a .snapz not live yet: the guard refuses, exit 1, wrangler never runs", async () => {
  snapzStatus = 404;
  const r = await run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /deploy-guard: REFUSED: \/snapshots\/nng4\.0123456789abcdef\.snapz: HTTP 404 from [^\n]* upload it first/);
  assert.deepEqual(r.npx, []);
});

test("--dry-run runs the guard too and reaches wrangler as --dry-run", async () => {
  const ok = await run(["--dry-run"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(originRequests, [`HEAD /snapshots/${SNAPZ}`]);
  assert.deepEqual(ok.npx, ["wrangler deploy --dry-run"]);
  snapzStatus = 404;
  const refused = await run(["--dry-run"]);
  assert.equal(refused.status, 1);
  assert.deepEqual(refused.npx, []);
});

test("LEAN4GAME_DEPLOY_ORIGIN=none skips the live check (a first deploy to a new origin); the pairing still runs", async () => {
  snapzStatus = 404;
  const r = await run([], { LEAN4GAME_DEPLOY_ORIGIN: "none" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /deploy-guard: paired 1 snapshot\(s\)/);
  assert.match(r.stderr, /deploy-guard: SKIPPED: /);
  assert.deepEqual(originRequests, []);
  assert.deepEqual(r.npx, ["wrangler deploy"]);
});

test("a mispaired tree with every .snapz live: the guard refuses before any HEAD, exit 1, wrangler never runs, also with the origin none", async () => {
  // Each of the tracked files, as a partial revert or a record pushed without its rebake leaves them.
  const other = (json) => json.replaceAll(BUILD_ID, OTHER_BUILD_ID);
  for (const [files, who] of [
    [["wasm/lean4-wasm64-release.json"], "client/public/runtime/runtime-manifest.json"],
    [["client/public/runtime/runtime-manifest.json"], "client/public/runtime/runtime-manifest.json"],
    [["client/public/profiles/index.json", "client/dist/profiles/index.json"], "client/public/profiles/index.json"],
    [["client/public/snapshots/index.json", "client/dist/snapshots/index.json"], "snapshot nng4"],
  ]) {
    for (const extra of [{}, { LEAN4GAME_DEPLOY_ORIGIN: "none" }]) {
      layout();
      for (const f of files) write(f, other(fs.readFileSync(path.join(repo, f), "utf8")));
      originRequests.length = 0;
      const r = await run([], extra);
      assert.equal(r.status, 1, `${files[0]}: ${r.stderr}`);
      assert.ok(r.stderr.includes(`deploy-guard: REFUSED: ${who}`), r.stderr);
      assert.deepEqual(originRequests, [], files[0]);
      assert.deepEqual(r.npx, [], files[0]);
    }
  }
});

/* QED64's architecture review D2: the deploy carries the site's two indexes. */
const treeOf = (dir) => fs.readdirSync(path.join(repo, "wasm/out/deploy", dir), { recursive: true }).sort();

test("D2: the deploy tree keeps exactly the two indexes of the artifact directories, with the tracked bytes", async () => {
  // Leftovers a staged local tree may hold: the bake's and earlier stagings' per-runtime copies.
  write("client/dist/snapshots/index.wasm64-0123456789abcdef.json", "{}");
  write("client/dist/snapshots/profiles-index.wasm64-0123456789abcdef.json", "{}");
  write("client/dist/runtime/runtime-manifest.wasm64-0123456789abcdef.json", "{}");
  const r = await run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(treeOf("snapshots"), ["index.json"]);
  assert.deepEqual(treeOf("profiles"), ["index.json"]);
  assert.ok(!fs.existsSync(path.join(repo, "wasm/out/deploy/runtime")), "no runtime/");
  assert.equal(fs.readFileSync(path.join(repo, "wasm/out/deploy/snapshots/index.json"), "utf8"), SNAPSHOT_INDEX);
  assert.equal(fs.readFileSync(path.join(repo, "wasm/out/deploy/profiles/index.json"), "utf8"), PROFILE_INDEX);
  assert.ok(fs.existsSync(path.join(repo, "wasm/out/deploy/index.html")), "the shell");
  assert.ok(fs.statSync(path.join(repo, `client/dist/snapshots/${SNAPZ}`)).isFile(), "client/dist stays complete for the local server");
  assert.deepEqual(r.npx, ["wrangler deploy"]);
});

test("D2: a build without an index refuses, exit 3, before the guard and wrangler", async () => {
  for (const idx of ["snapshots/index.json", "profiles/index.json"]) {
    layout();
    fs.rmSync(path.join(repo, "client/dist", idx));
    originRequests.length = 0;
    const r = await run();
    assert.equal(r.status, 3, idx);
    assert.match(r.stderr, new RegExp(`deploy tree incomplete: ${idx} missing`));
    assert.deepEqual(originRequests, [], idx);
    assert.deepEqual(r.npx, [], idx);
  }
});

test("D2: a build holding other bytes than a tracked index refuses, exit 3, before the guard and wrangler (a stale SKIP_BUILD tree)", async () => {
  for (const idx of ["snapshots/index.json", "profiles/index.json"]) {
    layout();
    write(`client/dist/${idx}`, "{}");
    originRequests.length = 0;
    const r = await run();
    assert.equal(r.status, 3, idx);
    assert.match(r.stderr, new RegExp(`deploy tree refused: ${idx} is not byte-identical to the tracked client/public/${idx}`));
    assert.deepEqual(originRequests, [], idx);
    assert.deepEqual(r.npx, [], idx);
  }
});

test("the header and the tail: no post-deploy step, no reminder, and the upload is never run from here", () => {
  const deploy = fs.readFileSync(path.join(root, "scripts/deploy-app.sh"), "utf8");
  assert.doesNotMatch(deploy, /--post-deploy/);
  assert.ok(deploy.trimEnd().endsWith('npx wrangler deploy "$@"'), "wrangler is the last step");
  assert.ok(!/^\s*(bash |\.\/)?scripts\/upload-artifacts\.sh/m.test(deploy), "not invoked");
});
