// Run: node --import ./client/src/wasm/ts-resolve-hook.mjs client/src/wasm/sw-warm.test.ts
// D1 (live 2026-10-03), the service worker's side of the warm-up protocol:
// the `warm` reply's `bytes` — runtime-chunk body bytes received beyond what
// an earlier round of the worker already had of that chunk, a fetch cut at
// the round's hard abort included (the HTTP cache resumes it next round and
// replays the prefix first, which must not count again). Loads the REAL
// client/src/sw/sw.template.js in a vm sandbox with a fake clock, a fake
// Cache Storage and a fake fetch whose chunk body streams, stalls until the
// abort, and replays its prefix the way a resumed HTTP-cache entry does.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = "https://l4g.test";

type Timer = { at: number; fn: () => void };
let now = 0;
let nextId = 1;
const timers = new Map<number, Timer>();
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
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r)); };

class FakeCache {
  store = new Map<string, { body: ArrayBuffer; headers: Headers }>();
  async put(req: Request, res: Response): Promise<void> {
    const body = await res.arrayBuffer(); // consumes the (counted) body; rejects when it errors
    this.store.set(req.url, { body, headers: new Headers(res.headers) });
  }
  async match(req: Request | string): Promise<Response | undefined> {
    const url = typeof req === "string" ? new URL(req, ORIGIN).href : req.url;
    const hit = this.store.get(url);
    return hit ? new Response(hit.body.slice(0), { status: 200, headers: hit.headers }) : undefined;
  }
  async keys(): Promise<Request[]> { return [...this.store.keys()].map((u) => new Request(u)); }
  async delete(req: Request): Promise<boolean> { return this.store.delete(req.url); }
}
const cacheStorage = new Map<string, FakeCache>();
const caches = {
  open: async (name: string) => { if (!cacheStorage.has(name)) cacheStorage.set(name, new FakeCache()); return cacheStorage.get(name)!; },
  keys: async () => [...cacheStorage.keys()],
  delete: async (name: string) => cacheStorage.delete(name),
  match: async (req: Request) => { for (const c of cacheStorage.values()) { const h = await c.match(req); if (h) return h; } return undefined; },
};

/** The chunk as the network + HTTP cache deliver it: `replay` bytes at once
 * (the truncated entry's prefix), then `fresh` new bytes, then either the end
 * (`complete`) or a stall until the fetch is aborted. */
const CHUNK = "/runtime/chunks/lean.wasm.bb.part-000";
const DATA = "/data/g/test/T/game.json";
let chunkPlan: { replay: number; fresh: number; complete: boolean } = { replay: 0, fresh: 0, complete: false };
let chunkFetches = 0;
function fakeFetch(req: Request, init?: { signal?: AbortSignal }): Promise<Response> {
  const p = new URL(req.url).pathname;
  if (p === DATA) return Promise.resolve(new Response(JSON.stringify({ worldSize: {} }), { status: 200, headers: { "content-type": "application/json" } }));
  if (p !== CHUNK) return Promise.resolve(new Response("nope", { status: 404 }));
  chunkFetches += 1;
  const plan = { ...chunkPlan };
  const signal = init?.signal;
  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      if (plan.replay) ctl.enqueue(new Uint8Array(plan.replay));
      if (plan.fresh) ctl.enqueue(new Uint8Array(plan.fresh));
      if (plan.complete) { ctl.close(); return; }
      const abort = () => ctl.error(new DOMException("The operation was aborted.", "AbortError"));
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    },
  });
  return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/octet-stream" } }));
}

class SWRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) { super(typeof input === "string" ? new URL(input, ORIGIN).href : input, init); }
}
class FakeDate extends Date { static now(): number { return now; } }

const listeners = new Map<string, (e: unknown) => void>();
const sandbox: Record<string, unknown> = {
  console, URL, Response, Headers, ReadableStream, TransformStream, AbortController, DOMException, Promise, Map, Set, Array, JSON, Math, Error, TypeError,
  Request: SWRequest,
  Date: FakeDate,
  setTimeout: (fn: () => void, ms: number) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
  clearTimeout: (id: number) => { timers.delete(id); },
  caches,
  fetch: fakeFetch,
};
sandbox.self = Object.assign(sandbox, {
  location: { origin: ORIGIN },
  addEventListener: (type: string, fn: (e: unknown) => void) => { listeners.set(type, fn); },
  skipWaiting: async () => {},
  clients: { claim: async () => {} },
});
vm.createContext(sandbox);
const source = readFileSync(path.join(here, "../sw/sw.template.js"), "utf8")
  .replace("__VERSION__", "test").replace("__PRECACHE__", "[]").replace("__CRITICAL__", "[]");
vm.runInContext(source, sandbox, { filename: "sw.template.js" });

type Reply = { type: string; cached: number; total: number; partial: boolean; bytes?: number; pruned: number };
/** Post one `warm`; resolves with its reply (the clock is advanced to the
 * hard abort when the round has not finished by then). */
async function warmRound(urls: string[], { runToAbort = true } = {}): Promise<Reply> {
  const replies: Reply[] = [];
  const waits: Promise<unknown>[] = [];
  listeners.get("message")!({ data: { type: "warm", urls, pageFillsShell: true }, ports: [{ postMessage: (m: Reply) => replies.push(m) }], waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await flush();
  if (!replies.length && runToAbort) { advance(4 * 60 * 1000); await flush(); }
  await Promise.all(waits);
  assert.equal(replies.length, 1, "one reply per message");
  return replies[0]!;
}

let failures = 0;
async function test(name: string, body: () => Promise<void>): Promise<void> {
  try { await body(); console.log(`ok - ${name}`); } catch (e) { failures++; console.log(`not ok - ${name}\n  ${String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n  ")}`); }
}

const runtime = () => cacheStorage.get("l4g-runtime-v1")!;
const MB = 1_000_000;

await test("a round spent inside one chunk reports its bytes; the resumed prefix is not counted again", async () => {
  // Round 1: 9.6 MB of the chunk arrive, then the 4-minute abort cuts it.
  chunkPlan = { replay: 0, fresh: 9.6 * MB, complete: false };
  const r1 = await warmRound([DATA, CHUNK]);
  assert.equal(r1.partial, true);
  assert.equal(r1.cached, 1, "the data file; the cut chunk is not stored");
  assert.equal(r1.bytes, 9.6 * MB, "the cut chunk's bytes are progress");
  assert.equal(runtime().store.has(`${ORIGIN}${CHUNK}`), false);
  // Round 2: the HTTP cache replays 9.6 MB, 3 MB more arrive, cut again.
  chunkPlan = { replay: 9.6 * MB, fresh: 3 * MB, complete: false };
  const r2 = await warmRound([DATA, CHUNK]);
  assert.equal(r2.bytes, 3 * MB, "only the bytes past the previous high-water mark");
  // Round 3: the prefix is replayed, then the link stalls: no progress.
  chunkPlan = { replay: 12.6 * MB, fresh: 0, complete: false };
  const r3 = await warmRound([DATA, CHUNK]);
  assert.equal(r3.bytes, 0, "a replayed prefix alone is not progress");
  assert.equal(r3.partial, true);
  // Round 4: the rest arrives and the chunk is stored whole.
  chunkPlan = { replay: 12.6 * MB, fresh: 4_177_216, complete: true };
  const r4 = await warmRound([DATA, CHUNK], { runToAbort: false });
  assert.equal(r4.partial, false);
  assert.equal(r4.cached, 2);
  assert.equal(r4.bytes, 4_177_216);
  assert.equal((await runtime().match(CHUNK))!.headers.get("content-type"), "application/octet-stream");
  assert.equal((await (await runtime().match(CHUNK))!.arrayBuffer()).byteLength, 16_777_216, "the stored chunk is the whole body");
  // Round 5: the chunk is cached — skipped, nothing fetched, no bytes.
  const before = chunkFetches;
  const r5 = await warmRound([DATA, CHUNK], { runToAbort: false });
  assert.equal(chunkFetches, before);
  assert.deepEqual([r5.cached, r5.bytes, r5.partial], [2, 0, false]);
});

await test("data files never count as bytes (they are fetched in full every round)", async () => {
  const r = await warmRound([DATA], { runToAbort: false });
  assert.deepEqual([r.cached, r.bytes, r.partial], [1, 0, false]);
});

await test("a second message that joins an in-flight chunk fetch reports its bytes too", async () => {
  const CHUNK2 = "/runtime/chunks/lean.wasm.bb.part-001";
  // Reuse the chunk plan for the second path.
  const realFetch = sandbox.fetch as typeof fakeFetch;
  sandbox.fetch = (req: Request, init?: { signal?: AbortSignal }) => realFetch(new SWRequest(new URL(req.url).pathname === CHUNK2 ? CHUNK : req.url), init);
  chunkPlan = { replay: 0, fresh: 2 * MB, complete: false };
  const repliesA: Reply[] = [];
  const repliesB: Reply[] = [];
  const waits: Promise<unknown>[] = [];
  const post = (sink: Reply[]) => listeners.get("message")!({ data: { type: "warm", urls: [CHUNK2], pageFillsShell: true }, ports: [{ postMessage: (m: Reply) => sink.push(m) }], waitUntil: (p: Promise<unknown>) => waits.push(p) });
  post(repliesA);
  await flush();
  post(repliesB);
  await flush();
  advance(4 * 60 * 1000);
  await flush();
  await Promise.all(waits);
  sandbox.fetch = realFetch;
  assert.equal(repliesA[0]?.bytes, 2 * MB);
  assert.equal(repliesB[0]?.bytes, 2 * MB, "the joiner's round made the same progress");
});

await test("SEC1: a `warm` / `warm-data` naming another origin's urls fetches and caches only this origin's", async () => {
  const realFetch = sandbox.fetch as typeof fakeFetch;
  const fetched: string[] = [];
  sandbox.fetch = (req: Request, init?: { signal?: AbortSignal }) => { fetched.push(req.url); return realFetch(req, init); };
  const foreign = ["https://evil.example/runtime/chunks/lean.wasm.ee.part-000", "//evil.example/data/g/x/y/game.json", "\\\\evil.example/data/z.json", "data:application/json,{}"];
  try {
    for (const type of ["warm", "warm-data"]) {
      fetched.length = 0;
      const replies: Reply[] = [];
      const waits: Promise<unknown>[] = [];
      listeners.get("message")!({ data: { type, urls: [...foreign, DATA, 42], pageFillsShell: true }, ports: [{ postMessage: (m: Reply) => replies.push(m) }], waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await flush();
      await Promise.all(waits);
      assert.deepEqual(fetched, [`${ORIGIN}${DATA}`], `${type}: only the same-origin file is fetched`);
      assert.equal(replies[0]?.total, 1, `${type}: the foreign urls are not part of the warm-up`);
      assert.ok([...runtime().store.keys()].every((k) => k.startsWith(`${ORIGIN}/`)), `${type}: nothing foreign cached`);
    }
  } finally { sandbox.fetch = realFetch; }
});

if (failures) { console.log(`sw-warm: ${failures} FAILED`); process.exit(1); }
console.log("sw-warm: ALL TESTS PASS");
