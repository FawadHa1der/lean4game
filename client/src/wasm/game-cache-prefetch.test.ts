// Run: node --import ./client/src/wasm/ts-resolve-hook.mjs client/src/wasm/game-cache-prefetch.test.ts
// QED64 HARDENING #54, page side: prefetchRawSnapshot abandons the prefetch
// worker after PREFETCH_SILENCE_MS WITHOUT A MESSAGE, not a fixed time after
// the start (a 15-minute deadline cut the largest regions short below
// ~2.5 Mbit/s). A fake clock, a fake Worker and a fake OPFS directory.
import assert from "node:assert/strict";

type Timer = { at: number; fn: () => void };
let now = 0;
let nextId = 1;
const timers = new Map<number, Timer>();
const fakeWindow = {
  setTimeout: (fn: () => void, ms: number): number => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
  clearTimeout: (id: number): void => { timers.delete(id); },
};
/** Advance the fake clock, firing due timers in order. */
function advance(ms: number): void {
  const end = now + ms;
  for (;;) {
    let due: [number, Timer] | null = null;
    for (const e of timers) if (e[1].at <= end && (due === null || e[1].at < due[1].at)) due = e;
    if (due === null) break;
    timers.delete(due[0]);
    now = due[1].at;
    due[1].fn();
  }
  now = end;
}

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
  /** A message from the worker (dropped once terminated, as a real one is). */
  say(data: unknown): void { if (!this.terminated) this.onmessage?.({ data }); }
}

const removed: string[] = [];
const dir = { removeEntry: async (name: string) => { removed.push(name); } };
// The page's Location: SEC1's same-origin check resolves entry urls against it.
Object.assign(globalThis, { window: fakeWindow, Worker: FakeWorker, location: new URL("https://l4g.test/") });
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => dir }) } },
});

const { prefetchRawSnapshot, rawFileName, PREFETCH_SILENCE_MS } = await import("./game-cache");
const entry = { name: "nng4", url: "/snapshots/nng4.db264c5f3eb7c69c.snapz", bytes: 569269949, digest: "sha256:" + "ab".repeat(32) } as Parameters<typeof prefetchRawSnapshot>[0];
const flush = () => new Promise<void>((r) => setImmediate(r));
type Outcome = Awaited<ReturnType<typeof prefetchRawSnapshot>>;
const track = (p: Promise<Outcome>) => { const s: { v?: Outcome } = {}; void p.then((v) => { s.v = v; }); return s; };
let failures = 0;
async function test(name: string, body: () => Promise<void>): Promise<void> {
  timers.clear(); removed.length = 0; FakeWorker.all.length = 0; now = 0;
  try { await body(); console.log(`ok - ${name}`); } catch (e) { failures++; console.log(`not ok - ${name}\n  ${String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n  ")}`); }
}

assert.equal(PREFETCH_SILENCE_MS, 3 * 60 * 1000);

await test("a slow download that keeps reporting outlives the old 15-minute deadline", async () => {
  const seen: number[] = [];
  const s = track(prefetchRawSnapshot(entry, (bytes) => seen.push(bytes)));
  const w = FakeWorker.all[0]!;
  assert.deepEqual(w.posted[0], { url: entry.url, cacheKey: "nng4.abababababababab.snapz", rawBytes: entry.bytes });
  // One message every 170 s (just inside the window) for 57 minutes.
  for (let i = 1; i <= 20; i++) { advance(170_000); w.say({ status: "progress", bytes: i * 64 * 1048576, total: entry.bytes }); }
  await flush();
  assert.equal(s.v, undefined, "still running");
  assert.equal(w.terminated, false);
  assert.equal(seen.length, 20);
  w.say({ status: "done" });
  await flush();
  assert.deepEqual(s.v, { result: "done", error: undefined });
  assert.equal(w.terminated, true);
  assert.equal(timers.size, 0, "no timer left armed");
  assert.deepEqual(removed, []);
});

await test("silence after progress: abandoned PREFETCH_SILENCE_MS after the LAST message, partial removed", async () => {
  const s = track(prefetchRawSnapshot(entry));
  const w = FakeWorker.all[0]!;
  advance(100_000); w.say({ status: "progress", bytes: 1, total: entry.bytes });
  advance(PREFETCH_SILENCE_MS - 1);
  await flush();
  assert.equal(s.v, undefined, "one millisecond short of the window");
  advance(1);
  await flush(); await flush();
  assert.equal(s.v?.result, "error");
  assert.match(s.v?.error ?? "", /stalled \(no data for 3 minutes\)/);
  assert.equal(w.terminated, true);
  assert.deepEqual(removed, [`${rawFileName(entry)}.partial`]);
});

await test("no message at all: abandoned PREFETCH_SILENCE_MS after the start", async () => {
  const s = track(prefetchRawSnapshot(entry));
  advance(PREFETCH_SILENCE_MS);
  await flush(); await flush();
  assert.equal(s.v?.result, "error");
  assert.equal(FakeWorker.all[0]!.terminated, true);
});

await test("a message after the outcome re-arms nothing and removes nothing", async () => {
  const s = track(prefetchRawSnapshot(entry));
  const w = FakeWorker.all[0]!;
  w.say({ status: "busy", error: "held by the Lean worker" });
  await flush();
  assert.deepEqual(s.v, { result: "busy", error: "held by the Lean worker" });
  // A real worker's queued message can still be dispatched once; deliver it
  // past the terminated guard.
  w.onmessage?.({ data: { status: "progress", bytes: 5, total: entry.bytes } });
  assert.equal(timers.size, 0);
  advance(60 * 60 * 1000);
  await flush();
  assert.deepEqual(removed, []);
});

await test("worker error and terminal statuses settle once", async () => {
  const s = track(prefetchRawSnapshot(entry));
  const w = FakeWorker.all[0]!;
  w.onerror?.({ message: "boom" });
  w.onmessage?.({ data: { status: "done" } });
  await flush();
  assert.deepEqual(s.v, { result: "error", error: "boom" });
  assert.equal(timers.size, 0);
});

await test("SEC1: an entry url on another origin never reaches a prefetch worker (nothing is fetched, nothing committed under its key)", async () => {
  for (const url of ["https://cdn.attacker.example/r.snapz", "//cdn.attacker.example/r.snapz", "\\\\cdn.attacker.example/r.snapz", "data:application/octet-stream;base64,AA=="]) {
    const s = track(prefetchRawSnapshot({ ...entry, url }));
    await flush();
    assert.equal(FakeWorker.all.length, 0, `${url}: no worker spawned`);
    assert.equal(s.v?.result, "error", url);
    assert.match(s.v?.error ?? "", /SNAPSHOT_INDEX_FOREIGN_URL/);
    assert.equal(timers.size, 0);
  }
});

if (failures) { console.log(`game-cache-prefetch: ${failures} FAILED`); process.exit(1); }
console.log("game-cache-prefetch: ALL TESTS PASS");
