#!/usr/bin/env node
// The deploy guard (QED64's architecture review, R19a). scripts/deploy-app.sh
// runs it right before wrangler, also with --dry-run (it only reads), and CI
// deploys through that script.
//
// First, with no network, the pairing: the record's runtime.buildId
// (wasm/lean4-wasm64-release.json, the runtime the new Worker will serve), the
// buildId of client/public/runtime/runtime-manifest.json, the runtime.buildId
// of client/public/profiles/index.json and the runtime of every snapshot-index
// entry (there must be one) are one id. They all ride in one deploy, so a
// mispaired commit (a partial revert, a record bump pushed without its rebake)
// would otherwise go live through a push alone, and every boot would refuse
// every game ("baked for X, this shell runs Y") with no upload to end it.
// scripts/deploy-guard.test.mjs runs this on the tracked files too, so CI's test
// job catches it before the deploy job starts.
//
// Then, before every deploy, every .snapz that the tracked snapshot index
// (client/public/snapshots/index.json) names must already answer on the live
// origin. scripts/upload-artifacts.sh uploads them before the push; a push that
// comes before its upload deploys nothing (this site's 90 s window on
// 2026-10-09, the class of QED64's 2026-10-08 outage, its HARDENING #64).
//
// It checks only site-owned files. Every Worker of this site, old or new,
// serves /snapshots/*.snapz from the same key under lean4game/, so the live
// Worker answers for exactly the bytes the new deploy will read.
//
// It never checks release-mapped paths (/runtime/*, /profiles/<not index.json>)
// through the origin. The live Worker maps them into ITS release, so a new
// release's chunk names would 404 and its fixed-name manifests would give a
// false pass. That check lives in scripts/upload-artifacts.sh, which refuses
// to run until R2's lean4-wasm64/<id>/release.json equals
// wasm/lean4-wasm64-release.json. A release adopted with a rebake has new .snapz
// names, so this guard also refuses it when pushed before its upload. One with
// no rebake (the same runtime under a new id, a tools re-cut <id>-r2) names the
// same .snapz, and this guard passes it whether R2 holds that release or not: any
// change to the record needs the upload's check before the push
// (wasm/DEPLOY.md, "Deploy, in order").
//
// One HEAD per entry (redirects not followed, 20 s each); a 5xx, a network
// error or a timeout is retried after 2 s and again after 4 s (three tries),
// and is never a pass. It reads no body. A 200 with a Content-Length must carry
// the index's size (transfer, else bytes). The first refusal stops the check.
//
// Usage: [LEAN4GAME_DEPLOY_ORIGIN=<url>|none] node scripts/deploy-guard.mjs [--index <file>] [--origin <url>|none]
//   --index   the snapshot index (default <repo>/client/public/snapshots/index.json)
//   --origin  the live origin (default $LEAN4GAME_DEPLOY_ORIGIN, else the live site)
//   none      skips the live check (a first deploy to a new origin: nothing live
//             to ask); the pairing still runs
// Every line goes to stderr, each starting `deploy-guard: `: a `paired …` line,
// one `live …` line per snapshot, then `OK …`, or a last `deploy-guard: REFUSED: …`
// line. Exit 0 paired and every snapshot live (or skipped), 1 refused, 2 a bad
// argument (with the usage line). --help prints the usage on stdout and exits 0.
// Read-only; Node built-ins only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ORIGIN = "https://lean4game.fawadworkaddress.workers.dev";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_INDEX = path.join(ROOT, "client", "public", "snapshots", "index.json");
const RECORD = "wasm/lean4-wasm64-release.json";
const MANIFEST = "client/public/runtime/runtime-manifest.json";
const PROFILES = "client/public/profiles/index.json";
export const USAGE = "usage: [LEAN4GAME_DEPLOY_ORIGIN=<url>|none] node scripts/deploy-guard.mjs [--index <file>] [--origin <url>|none]";
const PREFIX = "deploy-guard: ";
const INDEX_SCHEMA = "qed64.snapshot-index/v1";
const SNAPZ_URL = /^\/snapshots\/[A-Za-z0-9][A-Za-z0-9._-]*\.snapz$/;
const TRIES = 3;
const RETRY_MS = [2000, 4000];
const HEAD_TIMEOUT_MS = 20_000;

/** A refusal: the index or the origin cannot be checked as given. */
export class Refusal extends Error {}

const show = (v) => JSON.stringify(v) ?? String(v);

/** A JSON file's value. `what` names it in the Refusal it throws. */
function readJson(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new Refusal(`${what} ${file} cannot be read (${e?.code ?? e?.message ?? e})`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Refusal(`${what} ${file} is not JSON (${e?.message ?? e})`);
  }
}

/** The .snapz entries of a snapshot index, `{ name, url, size, runtime }` (size = transfer ?? bytes). Throws a Refusal. */
export function entriesOf(indexFile) {
  const index = readJson(indexFile, "index");
  if (index === null || typeof index !== "object" || index.schema !== INDEX_SCHEMA || !Array.isArray(index.snapshots)) {
    throw new Refusal(`index ${indexFile} is not a ${INDEX_SCHEMA} index with a snapshots array`);
  }
  return index.snapshots.map((entry, i) => {
    if (entry === null || typeof entry !== "object") throw new Refusal(`index ${indexFile}: snapshots[${i}] is not an object`);
    const name = typeof entry.name === "string" && entry.name ? entry.name : `#${i}`;
    if (typeof entry.url !== "string" || !SNAPZ_URL.test(entry.url)) {
      throw new Refusal(`snapshot ${name} names ${show(entry.url)}, not a .snapz directly under /snapshots/`);
    }
    const size = entry.transfer ?? entry.bytes;
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new Refusal(`snapshot ${name} (${entry.url}) gives ${show(size)} as its size (transfer ?? bytes), not a positive integer`);
    }
    return { name, url: entry.url, size, runtime: entry.runtime };
  });
}

/** The pairing of the files one deploy carries: the record, the runtime manifest,
 * the profile index and the snapshot index all name one runtime, and the snapshot
 * index names at least one snapshot. Reads files under `root` only. Returns
 * `{ ok, lines }` (each line starts `deploy-guard: `); never throws. */
export function checkPairing({ index = DEFAULT_INDEX, root = ROOT } = {}) {
  try {
    const record = readJson(path.join(root, RECORD), "release record");
    const buildId = record?.runtime?.buildId;
    if (typeof buildId !== "string" || !buildId) throw new Refusal(`${RECORD} names ${show(buildId)} as runtime.buildId, not a build id`);
    const unpaired = (who, id) => new Refusal(`${who} names runtime ${show(id)}, but ${RECORD} (${record.id}) names ${buildId}: every boot would refuse every game. They belong in one commit (wasm/DEPLOY.md, "The guard")`);
    const manifestId = readJson(path.join(root, MANIFEST), "runtime manifest")?.buildId;
    if (manifestId !== buildId) throw unpaired(MANIFEST, manifestId);
    const profilesId = readJson(path.join(root, PROFILES), "profile index")?.runtime?.buildId;
    if (profilesId !== buildId) throw unpaired(PROFILES, profilesId);
    const entries = entriesOf(index);
    if (entries.length === 0) throw new Refusal(`index ${index} names no snapshot: every game would be unavailable`);
    for (const e of entries) if (e.runtime !== buildId) throw unpaired(`snapshot ${e.name} (${e.url})`, e.runtime);
    return { ok: true, lines: [`${PREFIX}paired ${entries.length} snapshot(s), the manifest and the profile index with ${record.id} (${buildId})`] };
  } catch (e) {
    return { ok: false, lines: [`${PREFIX}REFUSED: ${e instanceof Refusal ? e.message : `unexpected error: ${e?.stack ?? e}`}`] };
  }
}

const why = (e) => {
  if (e?.name === "TimeoutError") return `no answer in ${HEAD_TIMEOUT_MS / 1000} s`;
  const cause = e?.cause;
  return String(cause?.code ?? cause?.message ?? e?.message ?? e);
};

/** One HEAD with retries: `{ status, length }` for any status below 500, else `{ status: null, error }` after three tries. */
async function head(href, fetchImpl, sleep, note) {
  let error = "";
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    try {
      const res = await fetchImpl(href, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(HEAD_TIMEOUT_MS) });
      try { await res.body?.cancel(); } catch { /* a HEAD has no body to cancel */ }
      if (res.status < 500) {
        const header = res.headers.get("content-length");
        return { status: res.status, length: header === null ? null : Number(header) };
      }
      error = `HTTP ${res.status}`;
    } catch (e) {
      error = why(e);
    }
    if (attempt < TRIES) {
      const ms = RETRY_MS[attempt - 1];
      note(`${href}: ${error}; try ${attempt + 1} of ${TRIES} in ${ms / 1000} s`);
      await sleep(ms);
    }
  }
  return { status: null, error };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** HEAD every .snapz of `index` on `origin`, in index order, stopping at the
 * first refusal. Resolves `{ ok, lines }` (each line starts `deploy-guard: `; a
 * refusal is the last line); never rejects. */
export async function checkLiveSnapshots({ index = DEFAULT_INDEX, origin = DEFAULT_ORIGIN, fetchImpl = fetch, sleep = defaultSleep } = {}) {
  const lines = [];
  const say = (line) => lines.push(PREFIX + line);
  const refuse = (line) => {
    say(`REFUSED: ${line}`);
    return { ok: false, lines };
  };
  try {
    let base;
    try {
      base = new URL(origin);
    } catch {
      throw new Refusal(`origin ${show(origin)} is not an http(s) URL`);
    }
    if (base.protocol !== "http:" && base.protocol !== "https:") throw new Refusal(`origin ${show(origin)} is not an http(s) URL`);
    const entries = entriesOf(index);
    for (const { url, size } of entries) {
      const href = new URL(url, base).href;
      const r = await head(href, fetchImpl, sleep, (line) => say(`retry ${line}`));
      if (r.status === null) return refuse(`${url}: ${href} could not be reached (${r.error}, ${TRIES} tries)`);
      if (r.status === 404) return refuse(`${url}: HTTP 404 from ${href} — upload it first (scripts/upload-artifacts.sh), then re-run the deploy`);
      if (r.status !== 200) return refuse(`${url}: HTTP ${r.status} from ${href} — not a missing upload: look at what the origin answers (curl -I), then re-run the deploy`);
      if (r.length !== null && r.length !== size) {
        return refuse(`${url}: ${href} answers ${r.length} bytes, the index says ${size} — R2 holds other bytes under this name`);
      }
      say(`live ${url} (${r.length === null ? "no length sent" : `${r.length} bytes`})`);
    }
    say(`OK ${entries.length} snapshot(s) live on ${base.href}`);
    return { ok: true, lines };
  } catch (e) {
    return refuse(e instanceof Refusal ? e.message : `unexpected error: ${e?.stack ?? e}`);
  }
}

const defaultIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

/** The CLI: 0 paired and every snapshot live (or skipped), 1 refused, 2 a bad argument.
 * Lines go to io.err, the usage of --help to io.out. io.fetchImpl and io.sleep
 * replace fetch and the retry wait (tests). */
export async function main(argv = process.argv.slice(2), env = process.env, io = defaultIo) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      io.out(USAGE);
      return 0;
    }
    const m = /^--(index|origin)(?:=(.*))?$/s.exec(arg);
    const value = m ? (m[2] ?? argv[++i]) : undefined;
    if (!m || value === undefined || value === "" || Object.hasOwn(flags, m[1])) {
      io.err(`${PREFIX}${!m ? `unknown argument: ${arg}` : Object.hasOwn(flags, m[1]) ? `--${m[1]} given twice` : `--${m[1]} needs a value`}`);
      io.err(USAGE);
      return 2;
    }
    flags[m[1]] = value;
  }
  const origin = flags.origin ?? (env.LEAN4GAME_DEPLOY_ORIGIN || DEFAULT_ORIGIN);
  const index = flags.index === undefined ? DEFAULT_INDEX : path.resolve(flags.index);
  const paired = checkPairing({ index });
  for (const line of paired.lines) io.err(line);
  if (!paired.ok) return 1;
  if (origin === "none") {
    io.err(`${PREFIX}SKIPPED: the origin is none (a first deploy: no live origin to ask yet)`);
    return 0;
  }
  const result = await checkLiveSnapshots({
    index,
    origin,
    ...(io.fetchImpl ? { fetchImpl: io.fetchImpl } : {}),
    ...(io.sleep ? { sleep: io.sleep } : {}),
  });
  for (const line of result.lines) io.err(line);
  return result.ok ? 0 : 1;
}

// Run as a CLI only when this file is the main module, not when a test imports it.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main();
