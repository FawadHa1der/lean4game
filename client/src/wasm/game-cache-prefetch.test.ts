// Run: node --import ./client/src/wasm/ts-resolve-hook.mjs client/src/wasm/game-cache-prefetch.test.ts
// A landing-page Prepare's region on qed64's raw region cache (prefetchRaw,
// docs/EMBEDDING.md §7.4), with a fake clock, a fake prefetch Worker, a fake
// OPFS and a fake Web Lock manager:
//  - single flight in the page: the boot's session (qed64's snapshot load,
//    `onBusy: "wait"`) and a Prepare of the same region share ONE prefetch
//    worker, whichever started first — a Prepare after the boot's claim used
//    to be refused `busy`;
//  - PAR-2 (review of phase 2): the boot of a game whose Prepare runs waits
//    for the Prepare's region (inFlightPrepare) before its session starts; a
//    Prepare whose download failed leaves the session's own prefetch to start
//    a fresh worker — joined, every caller got the one failure and the Lean
//    worker streamed the region itself;
//  - across tabs: another tab's writer holds the region's lock — the Prepare
//    is `busy` at once (the tile says so) and spawns nothing;
//  - HARDENING #54: a prefetch silent for PREFETCH_SILENCE_MS after its last
//    message fails `silent` with the stall in words, its partial removed;
//  - a region already in OPFS is `cached` at once; no OPFS is `unavailable`;
//  - SEC1: an entry url on another origin never reaches a prefetch worker;
//  - the stale-region sweep (PAR-3: only the names the page's index lists)
//    and "Remove download", on qed64's cache helpers.
import assert from "node:assert/strict";

type Timer = { at: number; fn: () => void };
let now = 0;
let nextId = 1;
const timers = new Map<number, Timer>();
const setTimer = (fn: () => void, ms: number): number => { const id = nextId++; timers.set(id, { at: now + (ms || 0), fn }); return id; };
const clearTimer = (id: number): void => { timers.delete(id); };
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r)); };
/** Advance the fake clock, firing due timers in order (promise chains run between). */
async function advance(ms: number): Promise<void> {
  const end = now + ms;
  for (;;) {
    let due: [number, Timer] | null = null;
    for (const e of timers) if (e[1].at <= end && (due === null || e[1].at < due[1].at)) due = e;
    if (due === null) break;
    timers.delete(due[0]);
    now = due[1].at;
    due[1].fn();
    await flush();
  }
  now = end;
}
Date.now = () => now;

class FakeWorker {
  static all: FakeWorker[] = [];
  posted: unknown[] = [];
  terminated = false;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  url: string;
  constructor(url: string) { this.url = url; FakeWorker.all.push(this); }
  postMessage(m: unknown): void { this.posted.push(m); }
  terminate(): void { this.terminated = true; }
  say(data: unknown): void { if (!this.terminated) this.onmessage?.({ data }); }
}

/** OPFS: a region file exists once `cached` holds its size; removals recorded. */
const cached = new Map<string, number>();
const removed: string[] = [];
const dir = {
  getFileHandle: async (name: string) => {
    if (!cached.has(name)) throw new DOMException("missing", "NotFoundError");
    return { getFile: async () => ({ size: cached.get(name)! }) };
  },
  removeEntry: async (name: string) => { removed.push(name); },
};
/** Web Locks held by another tab. */
const heldElsewhere = new Set<string>();
const locks = {
  request: async (name: string, opts: { ifAvailable?: boolean }, cb: (lock: unknown) => Promise<unknown>) => {
    if (heldElsewhere.has(name)) {
      if (opts.ifAvailable) return cb(null);
      throw new DOMException("aborted", "AbortError"); // these tests never let a waiter through
    }
    return cb({ name });
  },
};
let opfs = true;
Object.assign(globalThis, {
  window: { setTimeout: setTimer, clearTimeout: clearTimer, addEventListener: () => {} },
  setTimeout: setTimer, // qed64's prefetchRaw keeps its silence timer on the global clock
  clearTimeout: clearTimer,
  Worker: FakeWorker,
  BroadcastChannel: undefined,
  location: new URL("https://l4g.test/"),
  // The warm-up's manifest (no service worker here: the warm-up ends at once).
  // runtime/v1: buildId is "wasm64-" + sha256(lean.wasm)[:16], which qed64's resolveRuntimeManifest checks (since qed64 80ddbf6).
  fetch: async () => new Response(JSON.stringify({ buildId: `wasm64-${"b1".repeat(8)}`, leanVersion: "4", files: { "lean.wasm": { bytes: 1, sha256: "b1".repeat(32), chunks: [] } } }), { status: 200, headers: { "content-type": "application/json" } }),
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  get: () => ({ locks, storage: { getDirectory: async () => { if (!opfs) throw new DOMException("no OPFS", "SecurityError"); return { getDirectoryHandle: async () => dir }; } } }),
});

const gc = await import("./game-cache");
const { PREFETCH_SILENCE_MS, prefetchRaw, snapshotCacheKey } = await import("qed64/embed");
const { getDefaultStore } = await import("jotai");
const store = getDefaultStore();
const entryOf = (name: string, url = `/snapshots/${name}.abababababababab.snapz`) =>
  ({ name, url, bytes: 569_269_949, transfer: 154_373_030, digest: "sha256:" + "ab".repeat(32), imports: [] as string[] });
const statusOf = (name: string) => store.get(gc.prepareStatusesAtom)[name];

let failures = 0;
async function test(name: string, body: () => Promise<void>): Promise<void> {
  timers.clear(); FakeWorker.all.length = 0; cached.clear(); removed.length = 0; heldElsewhere.clear(); opfs = true; now = 0;
  try { await body(); console.log(`ok - ${name}`); } catch (e) { failures++; console.log(`not ok - ${name}\n  ${String((e as Error)?.stack ?? e).split("\n").slice(0, 4).join("\n  ")}`); }
}

assert.equal(PREFETCH_SILENCE_MS, 3 * 60 * 1000);

await test("single flight: a second caller of the region a Prepare streams (qed64's snapshot load, `wait`) joins its prefetch worker — one download, both see its bytes", async () => {
  const entry = entryOf("nng4");
  const all = gc.prepareGame(entry);
  await flush();
  assert.equal(FakeWorker.all.length, 1);
  // transferBytes: the index's compressed size, for the worker's short-transfer check (qed64 HARDENING #63 follow-up).
  assert.deepEqual(FakeWorker.all[0]!.posted[0], { url: entry.url, cacheKey: snapshotCacheKey(entry), rawBytes: entry.bytes, transferBytes: entry.transfer });
  // qed64's snapshot load (loadSnapshotByName → prefetchRaw "wait"); the
  // game's boot waits for the Prepare's region before its session gets here
  // (PAR-2, below), but the registry is what keeps any second caller to one download.
  const seenByBoot: number[] = [];
  const boot = prefetchRaw(entry, { onBusy: "wait", onProgress: (p) => seenByBoot.push(p.loaded) });
  await flush();
  assert.equal(FakeWorker.all.length, 1, "no second prefetch worker");
  FakeWorker.all[0]!.say({ status: "progress", bytes: 200_000_000, total: entry.bytes });
  assert.deepEqual(seenByBoot, [200_000_000], "the boot's banner shows the Prepare's bytes");
  assert.deepEqual([statusOf("nng4")?.phase, statusOf("nng4")?.bytes], ["running", 200_000_000]);
  FakeWorker.all[0]!.say({ status: "done", bytes: entry.bytes });
  assert.equal((await boot).status, "done");
  const st = await all;
  assert.deepEqual([st.phase, st.result], ["done", "done"]);
});

await test("single flight, the other way round: a Prepare while the boot's session prefetches joins it — never refused `busy`", async () => {
  const entry = entryOf("rag");
  const boot = prefetchRaw(entry, { onBusy: "wait" });
  await flush();
  assert.equal(FakeWorker.all.length, 1);
  const all = gc.prepareGame(entry);
  await flush();
  assert.equal(FakeWorker.all.length, 1, "joined, not a second worker");
  assert.equal(statusOf("rag")?.phase, "running");
  FakeWorker.all[0]!.say({ status: "progress", bytes: 5, total: entry.bytes });
  assert.equal(statusOf("rag")?.bytes, 5);
  FakeWorker.all[0]!.say({ status: "done", bytes: entry.bytes });
  assert.equal((await boot).status, "done");
  const st = await all;
  assert.deepEqual([st.phase, st.result], ["done", "done"]);
});

await test("PAR-2: the boot waits for a running Prepare's region; when that download fails, the session's prefetch starts afresh — no shared failure, no Lean-worker stream", async () => {
  const entry = entryOf("nng4");
  assert.equal(gc.inFlightPrepare("nng4"), null, "no Prepare: nothing to wait for");
  const all = gc.prepareGame(entry);
  await flush();
  const pending = gc.inFlightPrepare("nng4");
  assert.ok(pending, "the boot finds the running Prepare");
  assert.equal(FakeWorker.all.length, 1);
  // One transient failure mid-download (ERR_NETWORK_CHANGED, a proxy reset).
  FakeWorker.all[0]!.say({ status: "error", error: "network error" });
  const region = await pending;
  assert.deepEqual([region.phase, region.result], ["failed", "error"]);
  await all;
  await flush();
  assert.equal(gc.inFlightPrepare("nng4"), null, "the Prepare is over");
  // The session's snapshot load (qed64 loadSnapshotByName → prefetchRaw "wait"), after the wait.
  const boot = prefetchRaw(entry, { onBusy: "wait" });
  await flush();
  assert.equal(FakeWorker.all.length, 2, "a fresh prefetch worker — the failed flight is closed");
  FakeWorker.all[1]!.say({ status: "done", bytes: entry.bytes });
  assert.equal((await boot).status, "done", "the region lands in OPFS; the Lean worker reads it");
});

await test("PAR-2: the wait is for the region only — a Prepare whose region is committed (its warm-up still running) is no wait", async () => {
  const entry = entryOf("rag");
  const all = gc.prepareGame(entry);
  await flush();
  FakeWorker.all[0]!.say({ status: "done", bytes: entry.bytes });
  const region = await gc.inFlightPrepare("rag");
  assert.deepEqual([region?.phase, region?.result], ["warming", "done"]);
  await all;
});

await test("another tab writes the region (its lock): the Prepare is `busy` at once and spawns nothing", async () => {
  const entry = entryOf("knights");
  heldElsewhere.add(`qed64-raw:${snapshotCacheKey(entry)}`);
  const st = await gc.prepareGame(entry);
  assert.deepEqual([st.phase, st.result], ["failed", "busy"]);
  assert.equal(FakeWorker.all.length, 0);
});

await test("HARDENING #54: silent PREFETCH_SILENCE_MS after the LAST message — failed `silent`, the stall in words, the partial removed", async () => {
  const entry = entryOf("logic");
  const all = gc.prepareGame(entry);
  await flush();
  const w = FakeWorker.all[0]!;
  // A slow download that keeps reporting outlives any fixed deadline.
  for (let i = 1; i <= 20; i++) { await advance(170_000); w.say({ status: "progress", bytes: i * 64 * 1048576, total: entry.bytes }); }
  assert.equal(statusOf("logic")?.phase, "running", "57 minutes in, still running");
  await advance(PREFETCH_SILENCE_MS - 1);
  assert.equal(statusOf("logic")?.phase, "running", "one millisecond short of the window");
  await advance(1);
  const st = await all;
  assert.deepEqual([st.phase, st.result, st.error], ["failed", "silent", "the download stalled (no data for 3 minutes)"]);
  assert.equal(w.terminated, true);
  assert.deepEqual(removed, [`${snapshotCacheKey(entry)}.raw.partial`]);
});

await test("a region already in OPFS: `cached` at once, no worker; no OPFS: `unavailable`", async () => {
  const entry = entryOf("ntg");
  cached.set(`${snapshotCacheKey(entry)}.raw`, entry.bytes);
  const st = await gc.prepareGame(entry);
  assert.deepEqual([st.phase, st.result], ["done", "cached"]);
  assert.equal(FakeWorker.all.length, 0);
  opfs = false;
  const none = await gc.prepareGame(entryOf("robo"));
  assert.deepEqual([none.phase, none.result], ["failed", "unavailable"]);
});

await test("a worker error fails the Prepare with its words", async () => {
  const all = gc.prepareGame(entryOf("hhg"));
  await flush();
  FakeWorker.all[0]!.say({ status: "error", error: "HTTP 503" });
  const st = await all;
  assert.deepEqual([st.phase, st.result, st.error], ["failed", "error", "HTTP 503"]);
});

await test("SEC1: an entry url on another origin never reaches a prefetch worker (nothing is fetched, nothing committed under its key)", async () => {
  let n = 0;
  for (const url of ["https://cdn.attacker.example/r.snapz", "//cdn.attacker.example/r.snapz", "\\\\cdn.attacker.example/r.snapz", "data:application/octet-stream;base64,AA=="]) {
    const st = await gc.prepareGame(entryOf(`evil${n++}`, url));
    assert.equal(FakeWorker.all.length, 0, `${url}: no worker spawned`);
    assert.deepEqual([st.phase, st.result], ["failed", "error"], url);
    assert.match(st.error ?? "", /is not this site/, url);
  }
});

await test("the stale-region sweep removes the stale keys of the names the page's index lists (qed64 isCacheKeyOf), nothing of an unlisted name; Remove download takes the region and its partial", async () => {
  const live = entryOf("nng4");
  const rebaked = { ...entryOf("rag"), digest: "sha256:" + "cd".repeat(32) };
  const sized = { ...entryOf("logic"), digest: undefined }; // keyed by its sizes
  const index = { schema: "qed64.snapshot-index/v1", snapshots: [live, rebaked, sized] };
  const key = snapshotCacheKey(live), ragKey = snapshotCacheKey(rebaked);
  assert.equal(snapshotCacheKey(sized), "logic.569269949.154373030.snapz");
  const files = [
    `${key}.raw`, `${key}.raw.partial`, key, // the live region, a prefetch's partial of it, the Lean worker's compressed copy
    `${ragKey}.raw`,                          // rag's live region
    "rag.abababababababab.snapz.raw", "rag.abababababababab.snapz.raw.partial", "rag.abababababababab.snapz", // rag before its rebake
    "logic.569269949.154373030.snapz.raw",    // logic's live (size-keyed) region
    "logic.1.2.snapz.raw",                    // logic at other sizes
    // PAR-3 — names this page's index does not list are never touched:
    "lag.f84d616679d0ceb0.snapz.raw",         // a game a NEWER deploy added, Prepared in a newer tab
    "nng4.dev.0123456789abcdef.snapz.raw",    // a developer's unpromoted bake next to nng4
    "knights.1234.5678.snapz.raw",            // a game the catalog no longer serves (size-keyed)
    "notes.txt",                              // not a cache file at all
  ];
  const sweepDir = { ...dir, keys: async function* () { yield* files; } };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks, storage: { getDirectory: async () => ({ getDirectoryHandle: async () => sweepDir }) } } });
  try {
    const gone = await gc.sweepStaleSnapshots(index);
    assert.deepEqual(gone.sort(), ["logic.1.2.snapz.raw", "rag.abababababababab.snapz", "rag.abababababababab.snapz.raw", "rag.abababababababab.snapz.raw.partial"]);
    assert.deepEqual(removed.sort(), gone);
    removed.length = 0;
    assert.equal(await gc.removeDownload(live), true);
    assert.deepEqual(removed, [`${key}.raw`, `${key}.raw.partial`], "the region and its partial — not the compressed copy");
  } finally {
    Object.defineProperty(globalThis, "navigator", { configurable: true, get: () => ({ locks, storage: { getDirectory: async () => { if (!opfs) throw new DOMException("no OPFS", "SecurityError"); return { getDirectoryHandle: async () => dir }; } } }) });
  }
});

if (failures) { console.log(`game-cache-prefetch: ${failures} FAILED`); process.exit(1); }
console.log("game-cache-prefetch: ALL TESTS PASS");
