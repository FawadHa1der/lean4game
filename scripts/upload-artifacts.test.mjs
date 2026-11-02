/* scripts/upload-artifacts.sh, the upload before a deploy (QED64's architecture
 * review D2): `node --test scripts/upload-artifacts.test.mjs`.
 *
 * The script runs for real from a scratch copy of the repository layout under
 * the OS temp dir, on an explicit PATH whose `rclone` is a fake (R2 is a
 * directory; every argv and every object written is logged). Nothing is
 * inherited from the environment (no credentials), nothing leaves the machine.
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ID = "lean-v4.34.0-41ec565";
const NEW = "wasm64-57ae00dc5f6ce958"; // the release record's runtime (the local tree's)
const OLD = "wasm64-d77d34b97592d014"; // what R2's frozen indexes pair with
const SITE = "qed64-artifacts/lean4game"; // R2 keys as the fake logs them
const SNAPZ = ["nng4.0123456789abcdef.snapz", "rag.fedcba9876543210.snapz"];

// The fake rclone (see the header).
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
switch (verb) {
  case "cat": {
    const s = stat(fsPath(args[0]));
    if (!s || !s.isFile()) die(args[0] + ": object not found", 3);
    process.stdout.write(fs.readFileSync(fsPath(args[0])));
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
  default:
    die("fake rclone: unsupported " + verb, 1);
}
`;

let tmp, repo, r2, bin;

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

/** The local tree (paired with NEW) and R2 as it stands since the two-step upload: its indexes frozen on OLD. */
function layout() {
  fs.rmSync(path.join(repo, "client"), { recursive: true, force: true });
  fs.rmSync(r2, { recursive: true, force: true });
  write(repo, "wasm/lean4-wasm64-release.json", RECORD);
  const runtime = json({ buildId: NEW, files: { "lean.wasm": { chunks: [{ url: "/runtime/chunks/lean.wasm.0123456789abcdef.part-000" }] } } });
  write(repo, "client/public/runtime/runtime-manifest.json", runtime);
  write(repo, "client/public/runtime/chunks/lean.wasm.0123456789abcdef.part-000", "chunk");
  write(repo, "client/public/profiles/index.json", JSON.stringify({ schema: "qed64.profile-index/v1", runtime: { buildId: NEW, leanVersion: "4.34.0" }, profiles: [{ id: "core", manifest: "/profiles/lean-core.manifest.json" }] }, null, 1));
  write(repo, "client/public/profiles/lean-core.manifest.json", json({ content: { pack: { transport: { parts: [{ url: "/profiles/lean-core.pack.gzip.0123456789abcdef0123.part-000" }] } } } }));
  write(repo, "client/public/profiles/lean-core.pack.gzip.0123456789abcdef0123.part-000", "part");
  write(repo, "client/public/snapshots/index.json", json({ schema: "qed64.snapshot-index/v1", snapshots: SNAPZ.map((f) => ({ name: f.split(".")[0], url: `/snapshots/${f}`, runtime: NEW })) }));
  for (const f of SNAPZ) write(repo, `client/public/snapshots/${f}`, `snapz ${f}`);
  write(r2, `qed64-artifacts/lean4-wasm64/${ID}/release.json`, RECORD);
  write(r2, `${SITE}/snapshots/index.json`, R2_SNAPSHOT_INDEX);
  write(r2, `${SITE}/snapshots/index.${OLD}.json`, R2_SNAPSHOT_INDEX);
  write(r2, `${SITE}/snapshots/profiles-index.${OLD}.json`, R2_PROFILE_INDEX);
  write(r2, `${SITE}/snapshots/nng4.aaaaaaaaaaaaaaaa.snapz`, "old snapz");
  write(r2, `${SITE}/profiles/index.json`, R2_PROFILE_INDEX);
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "l4g-upload-artifacts-"));
  repo = path.join(tmp, "repo");
  r2 = path.join(tmp, "r2");
  bin = path.join(tmp, "bin");
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  for (const f of ["upload-artifacts.sh", "preflight-artifacts.mjs", "stage-snapshots.py"]) fs.copyFileSync(path.join(root, "scripts", f), path.join(repo, "scripts", f));
  fs.writeFileSync(path.join(bin, "rclone"), FAKE_RCLONE, { mode: 0o755 });
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
});
after(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => layout());

function run(args = []) {
  const log = path.join(tmp, "argv.log"), writes = path.join(tmp, "writes.log");
  fs.writeFileSync(log, "");
  fs.writeFileSync(writes, "");
  const r = spawnSync("/bin/bash", [path.join(repo, "scripts/upload-artifacts.sh"), ...args], {
    cwd: tmp,
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp, TMPDIR: tmp, FAKE_R2: r2, FAKE_RCLONE_LOG: log, FAKE_R2_WRITES: writes },
  });
  const lines = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, argv: lines(log), writes: lines(writes) };
}
const noWrite = (r) => {
  assert.deepEqual(r.writes, [], r.stderr);
  assert.deepEqual(r.argv.filter((a) => /^rclone copy(to)? /.test(a)), [], "no copy or copyto at all");
};
const WRITES = SNAPZ.map((f) => `PUT ${SITE}/snapshots/${f} <- client/public/snapshots/${f}`);
const r2Bytes = (key) => fs.readFileSync(r2key(`${SITE}/${key}`), "utf8");
const FROZEN = [["snapshots/index.json", R2_SNAPSHOT_INDEX], ["profiles/index.json", R2_PROFILE_INDEX], [`snapshots/index.${OLD}.json`, R2_SNAPSHOT_INDEX], [`snapshots/profiles-index.${OLD}.json`, R2_PROFILE_INDEX]];

test("the upload sends every .snapz and nothing else: one rclone copy, no index, R2's frozen indexes untouched", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.writes, WRITES);
  for (const [key, bytes] of FROZEN) assert.equal(r2Bytes(key), bytes, key);
  assert.ok(r.argv.includes(`rclone copy client/public/snapshots qed64-r2:${SITE}/snapshots --include *.snapz --checksum --transfers 4 --s3-chunk-size 64M --s3-upload-concurrency 4 --stats 10s --stats-one-line`), r.argv.join("\n"));
  assert.deepEqual(r.argv.filter((a) => /^rclone copy(to)? /.test(a)).length, 1, "the .snapz copy is the only write");
  assert.match(r.stdout, /^next: the push \(or scripts\/deploy-app\.sh\); its guard refuses/m);
});

test("a local tree's leftovers go nowhere: the bake's or an earlier staging's per-runtime copies neither refuse nor upload", () => {
  write(repo, `client/public/snapshots/index.${NEW}.json`, "{}");
  write(repo, `client/public/snapshots/profiles-index.${NEW}.json`, "{}");
  write(repo, `client/public/snapshots/index.${OLD}.json`, "local");
  write(repo, `client/public/runtime/runtime-manifest.${OLD}.json`, "{}");
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.writes, WRITES);
  assert.equal(r2Bytes(`snapshots/index.${OLD}.json`), R2_SNAPSHOT_INDEX, "the frozen copy, not the local file");
  assert.ok(!fs.existsSync(r2key(`${SITE}/snapshots/index.${NEW}.json`)));
});

test("stage-snapshots.py publishes no per-runtime copy: the bake's stays in staging, a leftover goes, and the upload sends the new .snapz alone", () => {
  const NEWER = "nng4.2222222222222222.snapz";
  const entry = { name: "nng4", url: `/snapshots/${NEWER}`, digest: `sha256:${"2".repeat(64)}`, bytes: 40, transfer: 10, runtime: NEW };
  const staging = path.join(tmp, "staging");
  write(staging, "index.json", json({ schema: "qed64.snapshot-index/v1", snapshots: [entry] }));
  write(staging, `index.${NEW}.json`, json({ schema: "qed64.snapshot-index/v1", snapshots: [entry] }));
  write(staging, NEWER, "newer snapz");
  write(repo, `client/public/snapshots/index.${OLD}.json`, "{}");
  write(repo, `client/public/snapshots/profiles-index.${OLD}.json`, "{}");
  const r = spawnSync("python3", [path.join(repo, "scripts/stage-snapshots.py"), staging], { cwd: tmp, encoding: "utf8", env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" } });
  fs.rmSync(staging, { recursive: true });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(pub("snapshots")).sort(), ["index.json", NEWER, SNAPZ[1]].sort());
  assert.deepEqual(JSON.parse(fs.readFileSync(pub("snapshots/index.json"), "utf8")).snapshots.map((e) => e.url).sort(), [`/snapshots/${NEWER}`, `/snapshots/${SNAPZ[1]}`]);
  const up = run();
  assert.equal(up.status, 0, up.stderr);
  assert.deepEqual(up.writes, [NEWER, SNAPZ[1]].map((f) => `PUT ${SITE}/snapshots/${f} <- client/public/snapshots/${f}`));
});

test("the upload is idempotent: a re-run writes nothing", () => {
  assert.equal(run().status, 0);
  const again = run();
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.writes, []);
});

test("the release missing from R2 (or another record): refused, exit 3, nothing written", () => {
  fs.rmSync(r2key(`qed64-artifacts/lean4-wasm64/${ID}/release.json`));
  const missing = run();
  assert.equal(missing.status, 3);
  assert.match(missing.stderr, new RegExp(`R2 has no lean4-wasm64/${ID}/release\\.json equal to wasm/lean4-wasm64-release\\.json`));
  noWrite(missing);
  write(r2, `qed64-artifacts/lean4-wasm64/${ID}/release.json`, RECORD.replace(NEW, OLD));
  const other = run();
  assert.equal(other.status, 3);
  noWrite(other);
});

test("preflight: a partial or mixed tree refuses before any rclone call", () => {
  const index = () => JSON.parse(fs.readFileSync(pub("snapshots/index.json"), "utf8"));
  const cases = [
    ["a .snapz missing", () => fs.rmSync(pub(`snapshots/${SNAPZ[0]}`)), /MISSING: client\/public\/snapshots\/nng4\.0123456789abcdef\.snapz/],
    ["a chunk missing", () => fs.rmSync(pub("runtime/chunks/lean.wasm.0123456789abcdef.part-000")), /MISSING: client\/public\/runtime\/chunks\//],
    ["a pack part missing", () => fs.rmSync(pub("profiles/lean-core.pack.gzip.0123456789abcdef0123.part-000")), /MISSING: client\/public\/profiles\/lean-core\.pack/],
    ["a snapshot of another runtime", () => { const i = index(); i.snapshots[1].runtime = OLD; fs.writeFileSync(pub("snapshots/index.json"), json(i)); }, /snapshot \/snapshots\/rag\.fedcba9876543210\.snapz paired to wasm64-d77d34b97592d014, manifest is wasm64-57ae00dc5f6ce958/],
    ["a profile index of another runtime", () => fs.writeFileSync(pub("profiles/index.json"), R2_PROFILE_INDEX), /profile index runtime wasm64-d77d34b97592d014 != manifest wasm64-57ae00dc5f6ce958/],
  ];
  for (const [name, mutate, message] of cases) {
    layout();
    mutate();
    const r = run();
    assert.equal(r.status, 3, name);
    assert.match(r.stderr, message, name);
    assert.deepEqual(r.argv, [], `${name}: no rclone call`);
  }
});

test("preflight passes the full layout", () => {
  const ok = spawnSync(process.execPath, [path.join(repo, "scripts/preflight-artifacts.mjs"), "client/public"], { cwd: repo, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^preflight ok: runtime wasm64-57ae00dc5f6ce958: 1 chunks, 1 profile parts, 2 snapshots \(5 files\)$/m);
});

test("any argument, the old --post-deploy too: usage, exit 2, nothing run (R2's indexes stay frozen)", () => {
  for (const arg of ["--post-deploy", "--post"]) {
    const r = run([arg]);
    assert.equal(r.status, 2, arg);
    assert.match(r.stderr, new RegExp(`unknown argument ${arg}\\nusage: scripts/upload-artifacts\\.sh\\n`));
    assert.deepEqual(r.argv, [], arg);
  }
});

test(".github/workflows/deploy.yml: its header gives the order around the push it deploys, and the job runs no upload", () => {
  const wf = fs.readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8");
  const header = wf.slice(0, wf.indexOf("\nname:"));
  assert.match(header, /scripts\/upload-artifacts\.sh BEFORE pushing/);
  assert.match(header, /scripts\/deploy-guard\.mjs/);
  assert.doesNotMatch(wf, /--post-deploy/);
  assert.match(wf, /branches: \[wasm64-port\]/);
  assert.match(wf, /run: SKIP_BUILD=0 scripts\/deploy-app\.sh/);
  assert.ok(!/upload-artifacts\.sh/.test(wf.slice(wf.indexOf("\nname:"))), "the job runs no upload");
});
