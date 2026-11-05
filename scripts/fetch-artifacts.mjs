#!/usr/bin/env node
// The files a local game needs and git does not hold, from the live site: the
// runtime chunks and the game snapshots (wasm/KERNEL.md, "Rebuilding from a
// clone"). The tracked runtime manifest and snapshot index say what to fetch and
// what each file must be (a chunk: bytes and sha256, as served; a .snapz: transfer
// and digest, which covers the served gzip bytes). A file takes its name from
// <name>.partial only when it matches; one already there and matching is skipped.
// Two at a time, three tries each. No snapshot starts until every chunk is verified.
//
// It works for a checkout of what is live: the live Worker maps /runtime/* into
// its own release, so a chunk of another runtime answers 404.
//
// Usage: node scripts/fetch-artifacts.mjs [--origin <url>] [--out <dir>] [--only <snapshot name>...]
//   --origin  where to fetch from (default the live site)
//   --out     where to write (default <repo>/client/public)
//   --only    only these snapshots, by their name in snapshots/index.json (the runtime always)
// Exit 0 every file verified, 1 a file failed, 2 a bad argument or tracked files it
// will not use: a url that is not a plain file under its directory, or empty lists.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const PUB = fileURLToPath(new URL("../client/public", import.meta.url));
const TRIES = 3;
const die = (message, code) => { console.error(`fetch-artifacts: ${message}`); process.exit(code); };

let origin = "https://lean4game.fawadworkaddress.workers.dev", out = PUB, only = null;
const args = process.argv.slice(2);
const isValue = (a) => a !== undefined && !a.startsWith("--");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--origin" && URL.canParse(args[i + 1])) origin = args[++i];
  else if (args[i] === "--out" && isValue(args[i + 1])) out = path.resolve(args[++i]);
  else if (args[i] === "--only" && isValue(args[i + 1])) { only ??= []; while (isValue(args[i + 1])) only.push(args[++i]); }
  else die("usage: node scripts/fetch-artifacts.mjs [--origin <url>] [--out <dir>] [--only <snapshot name>...]", 2);
}

const [runtime, index] = ["runtime/runtime-manifest.json", "snapshots/index.json"].map((rel) => JSON.parse(fs.readFileSync(path.join(PUB, rel), "utf8")));
const names = (index.snapshots ?? []).map((s) => s.name);
const unknown = (only ?? []).filter((n) => !names.includes(n));
if (unknown.length) die(`--only: no snapshot named ${unknown.join(", ")}; the index has ${names.join(", ")}`, 2);

// A tracked url is one plain file directly under its directory: it cannot reach another
// host or path, or write outside --out, and a snapshot cannot be the tracked index.
const TRACKED = { "runtime/chunks": /^\/runtime\/chunks\/([A-Za-z0-9][A-Za-z0-9._-]*)$/, snapshots: /^\/snapshots\/([A-Za-z0-9][A-Za-z0-9._-]*\.snapz)$/ };
const entry = (dir, url, bytes, sha256) => {
  const name = TRACKED[dir].exec(url)?.[1];
  if (!name) die(`the tracked url ${url} is not a plain file under /${dir}/: nothing fetched`, 2);
  return { url, bytes, sha256, isChunk: dir !== "snapshots", name, dest: path.join(out, dir, name) };
};
const chunks = Object.values(runtime.files ?? {}).flatMap((f) => f.chunks ?? []).map((c) => entry("runtime/chunks", c.url, c.bytes, c.sha256));
const snapshots = (index.snapshots ?? []).filter((s) => !only || only.includes(s.name)).map((s) => entry("snapshots", s.url, s.transfer, s.digest.replace(/^sha256:/, "")));
if (!chunks.length) die("the runtime manifest lists no chunks: nothing fetched", 2);
if (!snapshots.length) die("the snapshot index lists no snapshots: nothing fetched", 2);
const total = chunks.length + snapshots.length;
const IF_404 = `This works for a checkout of what is live: git pull to get there, or build the artifacts from source (README.md, "Building the artifacts from source").`;

/** Why this file is not the tracked one, or null when it is. */
async function mismatch(file, e) {
  const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  if (size !== e.bytes) return `${size} bytes, the tracked size is ${e.bytes}`;
  const hash = createHash("sha256");
  for await (const b of fs.createReadStream(file)) hash.update(b);
  const got = hash.digest("hex");
  return got === e.sha256 ? null : `sha256 ${got}, the tracked digest is ${e.sha256}`;
}

/** One GET; throws unless it brought the tracked bytes. An error marked `final` is not worth another try. */
async function download(e) {
  const res = await fetch(new URL(e.url, origin), { headers: { "Accept-Encoding": "identity", "User-Agent": "lean4game-fetch-artifacts" } });
  if (!res.ok) {
    await res.body?.cancel();
    if (res.status !== 404) throw new Error(`HTTP ${res.status}`);
    const what = e.isChunk ? `serves another runtime than this checkout (${runtime.buildId}): it maps /runtime/* into its own release` : "does not hold this checkout's snapshot";
    throw Object.assign(new Error(`404: ${origin} ${what}. ${IF_404}`), { final: true });
  }
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(`${e.dest}.partial`));
  const wrong = await mismatch(`${e.dest}.partial`, e);
  if (wrong) throw new Error(wrong);
  fs.renameSync(`${e.dest}.partial`, e.dest);
}

const failed = [];
let skipped = 0;
async function worker(queue) {
  for (let e = queue.shift(); e; e = queue.shift()) {
    fs.mkdirSync(path.dirname(e.dest), { recursive: true });
    if (!(await mismatch(e.dest, e))) { skipped++; continue; }
    fs.rmSync(e.dest, { force: true }); // a bad file never stays under its name
    for (let attempt = 1; ; attempt++) {
      try {
        await download(e);
        console.log(`${e.name}: ${(e.bytes / 1e6).toFixed(1)} MB verified`);
        break;
      } catch (err) {
        fs.rmSync(`${e.dest}.partial`, { force: true });
        const last = err.final || attempt === TRIES;
        const why = [err.message, err.cause?.message || err.cause?.code].filter(Boolean).join(": "); // fetch's own says only "fetch failed"
        console.error(`${e.name}: ${why}${last ? "" : `; try ${attempt + 1} of ${TRIES}`}`);
        if (last) { failed.push(e.name); if (e.isChunk) queue.length = 0; break; }
        await sleep(2000 * attempt);
      }
    }
  }
}
await Promise.all([worker(chunks), worker(chunks)]);
if (!failed.length) await Promise.all([worker(snapshots), worker(snapshots)]); // no game runs without the runtime
if (failed.length) die(`FAILED: ${failed.join(", ")}; a rerun redoes only what is missing`, 1);
console.log(`fetch-artifacts: ${total} files verified (${total - skipped} fetched, ${skipped} already there) in ${out}: runtime ${runtime.buildId}, snapshots ${(only ?? names).join(", ")}`);
