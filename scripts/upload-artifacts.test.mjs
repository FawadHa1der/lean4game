/* scripts/upload-artifacts.sh, the two-step upload around the deploy (QED64
 * HARDENING #64): `node --test scripts/upload-artifacts.test.mjs`.
 *
 * The script runs for real from a scratch copy of the repository layout
 * under the OS temp dir, on an explicit PATH whose `rclone` is a fake (R2 is
 * a directory; every argv and every object written is logged) and with
 * SITE_URL pointing at an HTTP server in this process that answers
 * /runtime/runtime-manifest.json as the old or the new worker would. Nothing
 * is inherited from the environment (no credentials), nothing leaves the
 * machine.
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ID = "lean-v4.34.0-41ec565";
const NEW = "wasm64-57ae00dc5f6ce958"; // the release record's runtime (the local tree's)
const OLD = "wasm64-d77d34b97592d014"; // what R2's mutable indexes and the live shell pair with before the change
const SITE = "qed64-artifacts/lean4game"; // R2 keys as the fake logs them
const SNAPZ = ["nng4.0123456789abcdef.snapz", "rag.fedcba9876543210.snapz"];
const COPIES = [`snapshots/index.${NEW}.json`, `snapshots/profiles-index.${NEW}.json`];
const PINNED = `runtime/runtime-manifest.${NEW}.json`; // the release ships it beside runtime-manifest.json; never uploaded by this script

// The fake rclone (see the header). FAKE_RCLONE_FAIL: lines of "<verb> <substring> <exit code>".
const FAKE_RCLONE = String.raw`#!/usr/bin/env node
"use strict";
const fs = require("fs"), path = require("path");
const argv = process.argv.slice(2);
const R2 = process.env.FAKE_R2;
fs.appendFileSync(process.env.FAKE_RCLONE_LOG, "rclone " + argv.join(" ") + "\n");
const VALUED = new Set(["--include", "--exclude", "--filter", "--format", "--stats", "--transfers", "--s3-chunk-size", "--s3-upload-concurrency", "--header-upload", "--separator"]);
const pos = [], opt = { include: [], exclude: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUED.has(a)) { const v = argv[++i]; if (a === "--include") opt.include.push(v); else if (a === "--exclude") opt.exclude.push(v); else opt[a.slice(2)] = v; }
  else if (a.startsWith("--")) opt[a.slice(2)] = true;
  else pos.push(a);
}
const [verb, ...args] = pos;
const die = (msg, code) => { process.stderr.write("ERROR : " + msg + "\n"); process.exit(code); };
for (const rule of (process.env.FAKE_RCLONE_FAIL || "").split("\n").filter(Boolean)) {
  const [v, sub, code] = rule.split(" ");
  if (v === verb && args.some((x) => x.includes(sub))) die(args[0] + ": injected failure", Number(code));
}
const isRemote = (p) => /^[A-Za-z0-9_-]+:/.test(p);
const keyOf = (p) => p.slice(p.indexOf(":") + 1).replace(/\/+$/, "");
const fsPath = (p) => (isRemote(p) ? path.join(R2, keyOf(p)) : p);
const stat = (p) => { try { return fs.statSync(p); } catch { return null; } };
const walk = (d, rel = "") => fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name), rel + e.name + "/") : [rel + e.name]));
const glob = (pat) => new RegExp("^" + pat.replace(/[.+^$(){}|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$");
const matches = (pat, rel) => (pat.includes("/") ? glob(pat.replace(/^\//, "")).test(rel) : glob(pat).test(rel.split("/").pop()));
const wanted = (rel) => (opt.include.length ? opt.include.some((p) => matches(p, rel)) : !opt.exclude.some((p) => matches(p, rel)));
const put = (src, dst, label) => {
  const s = stat(fsPath(src));
  if (!s || !s.isFile()) die(src + ": object not found", 3);
  const out = fsPath(dst);
  if (opt.checksum && stat(out) && fs.readFileSync(fsPath(src)).equals(fs.readFileSync(out))) return;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(fsPath(src), out);
  fs.appendFileSync(process.env.FAKE_R2_WRITES, "PUT " + keyOf(dst) + " <- " + label + "\n");
};
const line = (name, size) => (opt.format === "sp" ? size + ";" + name : name);
switch (verb) {
  case "cat": {
    const s = stat(fsPath(args[0]));
    if (!s || !s.isFile()) die(args[0] + ": object not found", 3);
    process.stdout.write(fs.readFileSync(fsPath(args[0])));
    break;
  }
  case "lsf": {
    const p = fsPath(args[0]), s = stat(p);
    if (!s) die(args[0] + ": directory not found", 3);
    if (s.isFile()) { console.log(line(path.basename(p), s.size)); break; }
    for (const e of fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.isDirectory()) { if (!opt["files-only"]) console.log(e.name + "/"); continue; }
      console.log(line(e.name, fs.statSync(path.join(p, e.name)).size));
    }
    break;
  }
  case "ls": {
    const p = fsPath(args[0]), s = stat(p);
    if (!s) die(args[0] + ": directory not found", 3);
    for (const rel of s.isFile() ? [path.basename(p)] : walk(p)) console.log(String(fs.statSync(s.isFile() ? p : path.join(p, rel)).size).padStart(9) + " " + rel);
    break;
  }
  case "copy": {
    const [src, dst] = args, s = stat(fsPath(src));
    if (!s || !s.isDirectory()) die(src + ": directory not found", 3);
    for (const rel of walk(fsPath(src))) if (wanted(rel)) put(path.join(src, rel), dst.replace(/\/+$/, "") + "/" + rel, path.join(src, rel));
    break;
  }
  case "copyto":
    put(args[0], args[1], args[0]);
    break;
  default:
    die("fake rclone: unsupported " + verb, 1);
}
`;

let tmp, repo, r2, bin, server, siteUrl;
/** What the site's /runtime/runtime-manifest.json answers: a buildId, or null for a 404. */
let liveId = OLD;
const siteRequests = [];

const json = (v) => JSON.stringify(v, null, 1) + "\n";
const write = (base, rel, data) => {
  const f = path.join(base, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
};
const pub = (rel) => path.join(repo, "client/public", rel);
const r2key = (key) => path.join(r2, key);
const R2_SNAPSHOT_INDEX = json({ schema: "qed64.snapshot-index/v1", snapshots: [{ name: "nng4", url: "/snapshots/nng4.aaaaaaaaaaaaaaaa.snapz", runtime: OLD }] });
const R2_PROFILE_INDEX = json({ schema: "qed64.profile-index/v1", runtime: { buildId: OLD }, profiles: [] });
const RECORD = json({ schema: "lean4-wasm64.release/v1", id: ID, runtime: { buildId: NEW } });

/** The local tree (paired with NEW, its copies byte-identical) and R2 as the live site has it before the change. */
function layout() {
  fs.rmSync(path.join(repo, "client"), { recursive: true, force: true });
  fs.rmSync(r2, { recursive: true, force: true });
  write(repo, "wasm/lean4-wasm64-release.json", RECORD);
  const runtime = json({ buildId: NEW, files: { "lean.wasm": { chunks: [{ url: "/runtime/chunks/lean.wasm.0123456789abcdef.part-000" }] } } });
  write(repo, "client/public/runtime/runtime-manifest.json", runtime);
  write(repo, `client/public/${PINNED}`, runtime);
  write(repo, "client/public/runtime/chunks/lean.wasm.0123456789abcdef.part-000", "chunk");
  const profiles = JSON.stringify({ schema: "qed64.profile-index/v1", runtime: { buildId: NEW, leanVersion: "4.34.0" }, profiles: [{ id: "core", manifest: "/profiles/lean-core.manifest.json" }] }, null, 1);
  write(repo, "client/public/profiles/index.json", profiles);
  write(repo, "client/public/profiles/lean-core.manifest.json", json({ content: { pack: { transport: { parts: [{ url: "/profiles/lean-core.pack.gzip.0123456789abcdef0123.part-000" }] } } } }));
  write(repo, "client/public/profiles/lean-core.pack.gzip.0123456789abcdef0123.part-000", "part");
  const snapshots = json({ schema: "qed64.snapshot-index/v1", snapshots: SNAPZ.map((f) => ({ name: f.split(".")[0], url: `/snapshots/${f}`, runtime: NEW })) });
  write(repo, "client/public/snapshots/index.json", snapshots);
  for (const f of SNAPZ) write(repo, `client/public/snapshots/${f}`, `snapz ${f}`);
  write(repo, `client/public/snapshots/index.${NEW}.json`, snapshots);
  write(repo, `client/public/snapshots/profiles-index.${NEW}.json`, profiles);
  write(r2, `qed64-artifacts/lean4-wasm64/${ID}/release.json`, RECORD);
  write(r2, `${SITE}/snapshots/index.json`, R2_SNAPSHOT_INDEX);
  write(r2, `${SITE}/snapshots/nng4.aaaaaaaaaaaaaaaa.snapz`, "old snapz");
  write(r2, `${SITE}/profiles/index.json`, R2_PROFILE_INDEX);
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "l4g-upload-artifacts-"));
  repo = path.join(tmp, "repo");
  r2 = path.join(tmp, "r2");
  bin = path.join(tmp, "bin");
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  for (const f of ["upload-artifacts.sh", "preflight-artifacts.mjs", "stage-snapshots.py"]) fs.copyFileSync(path.join(root, "scripts", f), path.join(repo, "scripts", f));
  fs.writeFileSync(path.join(bin, "rclone"), FAKE_RCLONE, { mode: 0o755 });
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  server = http.createServer((req, res) => {
    siteRequests.push(req.url);
    if (req.url !== "/runtime/runtime-manifest.json" || liveId === null) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ schema: "org.lean-browser64.runtime/v1", buildId: liveId }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  siteUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  layout();
  liveId = OLD;
  siteRequests.length = 0;
});

/** Runs the script (asynchronously: the site is served from this process). */
function run(args = [], extra = {}) {
  const log = path.join(tmp, "argv.log"), writes = path.join(tmp, "writes.log");
  fs.writeFileSync(log, "");
  fs.writeFileSync(writes, "");
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp, TMPDIR: tmp, FAKE_R2: r2, FAKE_RCLONE_LOG: log, FAKE_R2_WRITES: writes, SITE_URL: siteUrl, ...extra };
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", [path.join(repo, "scripts/upload-artifacts.sh"), ...args], { cwd: tmp, env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => {
      const lines = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
      resolve({ status, stdout, stderr, argv: lines(log), writes: lines(writes) });
    });
  });
}
const noWrite = (r) => {
  assert.deepEqual(r.writes, [], r.stderr);
  assert.deepEqual(r.argv.filter((a) => /^rclone copy(to)? /.test(a)), [], "no copy or copyto at all");
};
const PRE_WRITES = [
  ...SNAPZ.map((f) => `PUT ${SITE}/snapshots/${f} <- client/public/snapshots/${f}`),
  ...COPIES.map((c) => `PUT ${SITE}/${c} <- client/public/${c}`),
];
const PINS = [
  `PUT ${SITE}/snapshots/index.${OLD}.json <- qed64-r2:${SITE}/snapshots/index.json`,
  `PUT ${SITE}/snapshots/profiles-index.${OLD}.json <- qed64-r2:${SITE}/profiles/index.json`,
];
const MUTABLE = [
  `PUT ${SITE}/snapshots/index.json <- client/public/snapshots/index.json`,
  `PUT ${SITE}/profiles/index.json <- client/public/profiles/index.json`,
];
const r2Bytes = (key) => fs.readFileSync(r2key(`${SITE}/${key}`), "utf8");

test("pre-deploy: the .snapz, then this runtime's two copies — never a mutable index, never the site", async () => {
  const r = await run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.writes, PRE_WRITES);
  assert.equal(r2Bytes("snapshots/index.json"), R2_SNAPSHOT_INDEX);
  assert.equal(r2Bytes("profiles/index.json"), R2_PROFILE_INDEX);
  for (const c of COPIES) assert.equal(r2Bytes(c), fs.readFileSync(pub(c), "utf8"), c);
  assert.ok(r.argv.includes(`rclone copy client/public/snapshots qed64-r2:${SITE}/snapshots --include *.snapz --checksum --transfers 4 --s3-chunk-size 64M --s3-upload-concurrency 4 --stats 10s --stats-one-line`), r.argv.join("\n"));
  assert.match(r.stdout, /1\. scripts\/deploy-app\.sh[^\n]*\n[^\n]*2\.[^\n]*scripts\/upload-artifacts\.sh --post-deploy/);
  assert.deepEqual(siteRequests, []);
});

test("pre-deploy is idempotent: a re-run writes nothing", async () => {
  assert.equal((await run()).status, 0);
  const again = await run();
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.writes, []);
});

test("the release missing from R2 (or another record): both steps refuse, exit 3, nothing written", async () => {
  fs.rmSync(r2key(`qed64-artifacts/lean4-wasm64/${ID}/release.json`));
  for (const args of [[], ["--post-deploy"]]) {
    const r = await run(args);
    assert.equal(r.status, 3, args.join(" "));
    assert.match(r.stderr, new RegExp(`R2 has no lean4-wasm64/${ID}/release\\.json equal to wasm/lean4-wasm64-release\\.json`));
    noWrite(r);
  }
  write(r2, `qed64-artifacts/lean4-wasm64/${ID}/release.json`, RECORD.replace(NEW, OLD));
  const r = await run();
  assert.equal(r.status, 3);
  noWrite(r);
});

test("preflight: a missing, stale or stray per-runtime copy refuses before any rclone call", async () => {
  const cases = [
    ["missing", () => fs.rmSync(pub(COPIES[0])), /MISSING: client\/public\/snapshots\/index\.wasm64-57ae00dc5f6ce958\.json/],
    ["stale", () => fs.writeFileSync(pub(COPIES[1]), "{}"), /STALE: client\/public\/snapshots\/profiles-index\.wasm64-57ae00dc5f6ce958\.json is not byte-identical to client\/public\/profiles\/index\.json/],
    ["stray", () => fs.writeFileSync(pub(`snapshots/index.${OLD}.json`), "{}"), /STRAY: client\/public\/snapshots\/index\.wasm64-d77d34b97592d014\.json is a copy for wasm64-d77d34b97592d014/],
    // the pinned runtime manifest (the 4.34 bundle lane once staged none: offline boots failed on the local build)
    ["pinned missing", () => fs.rmSync(pub(PINNED)), /MISSING: client\/public\/runtime\/runtime-manifest\.wasm64-57ae00dc5f6ce958\.json\n[^]*\(the pinned runtime manifest and the per-runtime index copies: python3 scripts\/stage-snapshots\.py --copies\)/],
    ["pinned stale", () => fs.appendFileSync(pub(PINNED), " "), /STALE: client\/public\/runtime\/runtime-manifest\.wasm64-57ae00dc5f6ce958\.json is not byte-identical to client\/public\/runtime\/runtime-manifest\.json/],
    ["pinned stray", () => fs.copyFileSync(pub(PINNED), pub(`runtime/runtime-manifest.${OLD}.json`)), /STRAY: client\/public\/runtime\/runtime-manifest\.wasm64-d77d34b97592d014\.json is a copy for wasm64-d77d34b97592d014, manifest is wasm64-57ae00dc5f6ce958 — remove it \(its release keeps its own\)/],
  ];
  for (const [name, mutate, message] of cases) {
    layout();
    mutate();
    for (const args of [[], ["--post-deploy"]]) {
      const r = await run(args);
      assert.equal(r.status, 3, `${name} ${args}`);
      assert.match(r.stderr, message, name);
      assert.deepEqual(r.argv, [], `${name}: no rclone call`);
    }
  }
});

test("preflight passes the full layout, and stage-snapshots.py --copies restores all three copies (another runtime's go)", () => {
  const preflight = () => spawnSync(process.execPath, [path.join(repo, "scripts/preflight-artifacts.mjs"), "client/public"], { cwd: repo, encoding: "utf8" });
  const ok = preflight();
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^preflight ok: runtime wasm64-57ae00dc5f6ce958: 1 chunks, 1 profile parts, 2 snapshots, the pinned runtime manifest \+ 2 per-runtime index copies \(8 files\)$/m);
  // a tree as scripts/fetch-artifacts.sh extracts a bundle packed before the pinned copy existed, with leftovers of another runtime
  for (const c of [PINNED, ...COPIES]) fs.rmSync(pub(c));
  for (const c of [`runtime/runtime-manifest.${OLD}.json`, `snapshots/index.${OLD}.json`, `snapshots/profiles-index.${OLD}.json`]) write(repo, `client/public/${c}`, "{}");
  assert.equal(preflight().status, 3);
  const r = spawnSync("python3", [path.join(repo, "scripts/stage-snapshots.py"), "--copies"], { cwd: tmp, encoding: "utf8", env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`remove runtime-manifest\\.${OLD}\\.json \\(another runtime's copy; its release keeps its own\\)\ncopy runtime-manifest\\.${NEW}\\.json \\(the bytes of client/public/runtime/runtime-manifest\\.json\\)`));
  assert.ok(fs.readFileSync(pub(PINNED)).equals(fs.readFileSync(pub("runtime/runtime-manifest.json"))));
  for (const d of ["runtime", "snapshots"]) assert.ok(!fs.readdirSync(pub(d)).some((f) => f.includes(OLD)), d);
  const again = preflight();
  assert.equal(again.status, 0, again.stderr);
});

test("--post-deploy while the old shell is live: refused, exit 3, nothing written", async () => {
  assert.equal((await run()).status, 0);
  const r = await run(["--post-deploy"]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, new RegExp(`REFUSED: ${siteUrl} serves runtime ${OLD}, the release record is ${NEW}: the new shell is not live yet`));
  assert.match(r.stderr, /Deploy it first \(scripts\/deploy-app\.sh/);
  noWrite(r);
  assert.equal(r2Bytes("snapshots/index.json"), R2_SNAPSHOT_INDEX);
  assert.deepEqual(siteRequests, ["/runtime/runtime-manifest.json"]);
  // the site answering no manifest (or not at all) is no answer either
  liveId = null;
  const missing = await run(["--post-deploy"]);
  assert.equal(missing.status, 3);
  assert.match(missing.stderr, /REFUSED: cannot read http:\/\/127\.0\.0\.1:\d+\/runtime\/runtime-manifest\.json \(curl exit 22/);
  noWrite(missing);
  const down = await run(["--post-deploy"], { SITE_URL: "http://127.0.0.1:9" });
  assert.equal(down.status, 3);
  assert.match(down.stderr, /REFUSED: cannot read http:\/\/127\.0\.0\.1:9\/runtime\/runtime-manifest\.json \(curl exit 7/);
  noWrite(down);
});

test("--post-deploy once the new shell is live: pins R2's outgoing indexes to their missing copy names, then uploads the mutable indexes", async () => {
  assert.equal((await run()).status, 0);
  liveId = NEW;
  const r = await run(["--post-deploy"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.writes, [...PINS, ...MUTABLE]);
  assert.ok(r.argv.includes(`rclone copyto qed64-r2:${SITE}/snapshots/index.json qed64-r2:${SITE}/snapshots/index.${OLD}.json --s3-no-check-bucket`), "server-side copy");
  assert.equal(r2Bytes(`snapshots/index.${OLD}.json`), R2_SNAPSHOT_INDEX);
  assert.equal(r2Bytes(`snapshots/profiles-index.${OLD}.json`), R2_PROFILE_INDEX);
  assert.equal(r2Bytes("snapshots/index.json"), fs.readFileSync(pub("snapshots/index.json"), "utf8"));
  assert.equal(r2Bytes("profiles/index.json"), fs.readFileSync(pub("profiles/index.json"), "utf8"));
  assert.match(r.stdout, /post-deploy upload complete — R2 view:/);
  assert.doesNotMatch(r.stdout, /same-runtime change/, "a runtime change gets no same-runtime note");
  // idempotent: a re-run (and the pre-deploy step after it) writes nothing
  const again = await run(["--post-deploy"]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.writes, []);
  assert.deepEqual((await run()).writes, []);
});

test("--post-deploy never overwrites a copy R2 already has", async () => {
  assert.equal((await run()).status, 0);
  write(r2, `${SITE}/snapshots/index.${OLD}.json`, "an earlier pin");
  liveId = NEW;
  const r = await run(["--post-deploy"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.writes, [PINS[1], ...MUTABLE]);
  assert.equal(r2Bytes(`snapshots/index.${OLD}.json`), "an earlier pin");
});

test("--post-deploy pins nothing when R2 has no mutable index yet, or one that names no single runtime, or this runtime (a snapshot-only change)", async () => {
  const setups = {
    "fresh prefix": () => { fs.rmSync(r2key(`${SITE}/snapshots/index.json`)); fs.rmSync(r2key(`${SITE}/profiles/index.json`)); },
    "mixed / none": () => {
      write(r2, `${SITE}/snapshots/index.json`, json({ snapshots: [{ name: "a", runtime: OLD }, { name: "b", runtime: NEW }] }));
      write(r2, `${SITE}/profiles/index.json`, json({ profiles: [] }));
    },
    "mixed snapshot index, this runtime's profile index": () => {
      write(r2, `${SITE}/snapshots/index.json`, json({ snapshots: [{ name: "a", runtime: OLD }, { name: "b", runtime: NEW }] }));
      write(r2, `${SITE}/profiles/index.json`, json({ runtime: { buildId: NEW }, profiles: [] }));
    },
    "same runtime": () => {
      write(r2, `${SITE}/snapshots/index.json`, json({ snapshots: [{ name: "nng4", url: "/snapshots/nng4.aaaaaaaaaaaaaaaa.snapz", runtime: NEW }] }));
      write(r2, `${SITE}/profiles/index.json`, json({ runtime: { buildId: NEW }, profiles: [] }));
    },
  };
  for (const [name, setup] of Object.entries(setups)) {
    layout();
    setup();
    assert.equal((await run()).status, 0, name);
    liveId = NEW;
    const r = await run(["--post-deploy"]);
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.deepEqual(r.writes, MUTABLE, name);
    assert.ok(!fs.readdirSync(r2key(`${SITE}/snapshots`)).some((f) => f.includes(OLD)), name);
    // only a same-runtime change is noted: its live check passes before the deploy too
    if (name === "same runtime") assert.match(r.stdout, new RegExp(`note: R2's snapshots/index\\.json already pairs with ${NEW} \\(a same-runtime change\\), so the live check above passes with the old shell too[^\\n]*\\n[^\\n]*deploy must be confirmed live before this step`), name);
    else assert.doesNotMatch(r.stdout, /same-runtime change/, name);
    liveId = OLD;
  }
});

test("--post-deploy for the same runtime cannot tell the old shell from the new one: it writes, with the note before the write", async () => {
  // A rebake for the live runtime, its shell NOT deployed yet: the live
  // manifest already names the record's runtime, so the check passes (the
  // limitation wasm/DEPLOY.md documents); the note comes before the mutable writes.
  write(r2, `${SITE}/snapshots/index.json`, json({ snapshots: [{ name: "nng4", url: "/snapshots/nng4.aaaaaaaaaaaaaaaa.snapz", runtime: NEW }] }));
  write(r2, `${SITE}/profiles/index.json`, json({ runtime: { buildId: NEW }, profiles: [] }));
  assert.equal((await run()).status, 0);
  liveId = NEW;
  const r = await run(["--post-deploy"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.writes, MUTABLE);
  assert.deepEqual(siteRequests, ["/runtime/runtime-manifest.json"]);
  const note = r.stdout.indexOf("same-runtime change"), write0 = r.stdout.indexOf("== the mutable indexes");
  assert.ok(note >= 0 && write0 > note, r.stdout);
});

test("--post-deploy refuses when R2 lacks what the pre-deploy step uploads (a .snapz, a copy, or a copy that differs)", async () => {
  liveId = NEW;
  const fresh = await run(["--post-deploy"]);
  assert.equal(fresh.status, 3);
  assert.match(fresh.stderr, /lacks what scripts\/upload-artifacts\.sh \(the pre-deploy step\) uploads:\n  nng4\.0123456789abcdef\.snapz\n  rag\.fedcba9876543210\.snapz\n  index\.wasm64-57ae00dc5f6ce958\.json\n  profiles-index\.wasm64-57ae00dc5f6ce958\.json\n/);
  noWrite(fresh);
  assert.equal((await run()).status, 0);
  write(r2, `${SITE}/${COPIES[1]}`, fs.readFileSync(pub(COPIES[1]), "utf8").replace(NEW, "wasm64-0000000000000000"));
  const differs = await run(["--post-deploy"]);
  assert.equal(differs.status, 3);
  assert.match(differs.stderr, /profiles-index\.wasm64-57ae00dc5f6ce958\.json \(differs from the local copy\)/);
  noWrite(differs);
});

test("--post-deploy fails closed: an R2 read that errors (not a not-found) refuses before any write", async () => {
  assert.equal((await run()).status, 0);
  liveId = NEW;
  for (const [rule, message] of [
    [`cat ${SITE}/profiles/index.json 5`, /cannot read R2 \(rclone cat profiles\/index\.json exit 5\): ERROR : /],
    [`cat ${SITE}/snapshots/index.json 1`, /cannot read R2 \(rclone cat snapshots\/index\.json exit 1\)/],
    [`lsf ${SITE}/snapshots 7`, /cannot read R2 \(rclone lsf snapshots exit 7\)/],
    [`lsf ${SITE}/profiles/index.json 5`, /cannot read R2 \(rclone lsf profiles\/index\.json exit 5\)/],
  ]) {
    const r = await run(["--post-deploy"], { FAKE_RCLONE_FAIL: rule });
    assert.equal(r.status, 3, rule);
    assert.match(r.stderr, message, rule);
    noWrite(r);
  }
  // rclone's not-found exits mean R2 answered: no profile index there yet, so nothing to pin for it
  fs.rmSync(r2key(`${SITE}/profiles/index.json`));
  const r = await run(["--post-deploy"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.writes, [PINS[0], ...MUTABLE]);
});

test("an unknown argument: usage, exit 2, nothing run", async () => {
  const r = await run(["--post"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown argument --post\nusage: scripts\/upload-artifacts\.sh \[--post-deploy\]/);
  assert.deepEqual(r.argv, []);
});

test("scripts/deploy-app.sh reminds, right after wrangler deploy, to run --post-deploy (it never runs it)", () => {
  const deploy = fs.readFileSync(path.join(root, "scripts/deploy-app.sh"), "utf8");
  const tail = deploy.slice(deploy.indexOf("npx wrangler deploy"));
  assert.match(tail, /^npx wrangler deploy "\$@"\necho [^\n]*\necho "  scripts\/upload-artifacts\.sh --post-deploy"/);
  assert.ok(!/^\s*(bash |\.\/)?scripts\/upload-artifacts\.sh/m.test(deploy), "not invoked");
});

test("scripts/deploy-app.sh's reminder also annotates a GitHub Actions run (the CI log is easy to miss)", () => {
  const deploy = fs.readFileSync(path.join(root, "scripts/deploy-app.sh"), "utf8");
  const marker = 'npx wrangler deploy "$@"\n';
  assert.ok(deploy.includes(marker));
  // what runs after wrangler, run for real (wrangler itself is not)
  const tail = "set -euo pipefail\n" + deploy.slice(deploy.indexOf(marker) + marker.length);
  const runTail = (env) => spawnSync("/bin/bash", ["-c", tail], { env: { PATH: "/usr/bin:/bin", ...env }, encoding: "utf8" });
  const ci = runTail({ GITHUB_ACTIONS: "true" });
  assert.equal(ci.status, 0, ci.stderr);
  assert.match(ci.stdout, /^  scripts\/upload-artifacts\.sh --post-deploy$/m);
  assert.match(ci.stdout, /^::notice title=[^:\n]+::[^\n%]*scripts\/upload-artifacts\.sh --post-deploy now[^\n%]*$/m);
  const local = runTail({});
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /^  scripts\/upload-artifacts\.sh --post-deploy$/m);
  assert.doesNotMatch(local.stdout, /::notice/);
});

test(".github/workflows/deploy.yml: its header gives the two-step order around the push it deploys", () => {
  const wf = fs.readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8");
  const header = wf.slice(0, wf.indexOf("\nname:"));
  assert.match(header, /scripts\/upload-artifacts\.sh BEFORE pushing/);
  assert.match(header, /scripts\/upload-artifacts\.sh --post-deploy as soon as this workflow's\n#\s+deploy step has finished/);
  assert.doesNotMatch(header, /uploaded\n# manually via scripts\/upload-artifacts\.sh when/, "the one-shot wording is gone");
  assert.match(wf, /branches: \[wasm64-port\]/);
  assert.match(wf, /run: SKIP_BUILD=0 scripts\/deploy-app\.sh/);
  assert.ok(!/upload-artifacts\.sh/.test(wf.slice(wf.indexOf("\nname:"))), "the job runs no upload");
});
