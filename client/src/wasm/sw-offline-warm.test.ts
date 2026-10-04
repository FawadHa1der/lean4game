// Run: node --import ./client/src/wasm/ts-resolve-hook.mjs client/src/wasm/sw-offline-warm.test.ts
// D7 (live 2026-10-03): an offline boot of a cached game fired ~800 failing
// service-worker GETs (RAG: 329 data files, named twice). Checked here:
//  - the worker's `warm` / `warm-data` start no fetch after the first one that
//    fails outright (a TypeError — not an abort, not an HTTP error); the rest
//    are looked up, so `cached` stays what the cache holds; the reply says
//    `linkDown` and `partial`, and prunes nothing; the next message tries the
//    network again;
//  - the "warm-shell" fill fails fast the same way;
//  - the page: a link-down round is not repeated unless it gained something
//    (warmRoundProgressed), and runWhenOnline defers a warm-up while
//    navigator.onLine is false, running it once at the `online` event;
//  - review round, R2: one transient fetch failure (a round cut short by the
//    fail-fast) earns one more round after LINK_RETRY_MS while the browser
//    says online — the page's real warm-up loop driving the real worker —
//    and the shell fill's step follows the same rule; R4: `revalidate:
//    false` fetches only what the cache lacks, and the page sends it from
//    the round after the first one that reached the host.
//  - N1 (live run of f468f2c): offline with every file held, a link-down round
//    ends the warm-up (no retry round, which could only revalidate);
//  - N3: after a network-first fetch fails outright, held copies answer
//    cache-first for LINK_MEMO_MS (not-held and no-store requests still go to
//    the network; any HTTP answer ends it) — R2-4: held game content only
//    (/data, /i18n); the unhashed shell files still ask the host.
// Loads the REAL client/src/sw/sw.template.js in a vm sandbox (a fresh one
// per precache list) with a fake Cache Storage and a scripted fetch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = "https://l4g.test";
const flush = async () => { for (let i = 0; i < 40; i++) await new Promise<void>((r) => setImmediate(r)); };

class FakeCache {
  store = new Map<string, ArrayBuffer>();
  async put(req: Request | string, res: Response): Promise<void> { this.store.set(new URL(typeof req === "string" ? req : req.url, ORIGIN).href, await res.arrayBuffer()); }
  async match(req: Request | string): Promise<Response | undefined> {
    const hit = this.store.get(new URL(typeof req === "string" ? req : req.url, ORIGIN).href);
    return hit ? new Response(hit.slice(0), { status: 200 }) : undefined;
  }
  async keys(): Promise<Request[]> { return [...this.store.keys()].map((u) => new Request(u)); }
  async delete(req: Request): Promise<boolean> { return this.store.delete(req.url); }
}

/** How the fake network answers one path: a body, an HTTP status, or a
 * rejection (`link`: TypeError "Failed to fetch"; `abort`: AbortError). */
type Answer = "ok" | "404" | "link" | "abort";

/** The worker's clock: real time plus `skew` (N3's memo window). */
let skew = 0;
class SkewedDate extends Date {
  static now(): number { return Date.now() + skew; }
}

function loadWorker(precache: string[] = []) {
  const cacheStorage = new Map<string, FakeCache>();
  const caches = {
    open: async (name: string) => { if (!cacheStorage.has(name)) cacheStorage.set(name, new FakeCache()); return cacheStorage.get(name)!; },
    keys: async () => [...cacheStorage.keys()],
    delete: async (name: string) => cacheStorage.delete(name),
    match: async (req: Request) => { for (const c of cacheStorage.values()) { const h = await c.match(req); if (h) return h; } return undefined; },
  };
  const fetched: string[] = [];
  let answer: (p: string) => Answer = () => "ok";
  const fetch = async (req: Request | string): Promise<Response> => {
    const p = new URL(typeof req === "string" ? req : req.url, ORIGIN).pathname;
    fetched.push(p);
    await new Promise<void>((r) => setImmediate(r)); // a network round trip: other lanes start meanwhile
    const a = answer(p);
    if (a === "link") throw new TypeError("Failed to fetch");
    if (a === "abort") throw new DOMException("The operation was aborted.", "AbortError");
    if (a === "404") return new Response("nope", { status: 404, headers: { "content-type": "text/plain" } });
    return new Response(`body of ${p}`, { status: 200, headers: { "content-type": "application/octet-stream" } });
  };
  class SWRequest extends Request {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(typeof input === "string" ? new URL(input, ORIGIN).href : input, init); }
  }
  const listeners = new Map<string, (e: unknown) => void>();
  const sandbox: Record<string, unknown> = {
    console, URL, Response, Headers, ReadableStream, TransformStream, AbortController, DOMException, Promise, Map, Set, Array, JSON, Math, Error, TypeError, Date: SkewedDate,
    Request: SWRequest, setTimeout, clearTimeout, caches, fetch,
  };
  sandbox.self = Object.assign(sandbox, {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (e: unknown) => void) => { listeners.set(type, fn); },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  });
  vm.createContext(sandbox);
  const source = readFileSync(path.join(here, "../sw/sw.template.js"), "utf8")
    .replace("__VERSION__", "test").replace("__PRECACHE__", JSON.stringify(precache)).replace("__CRITICAL__", "[]");
  vm.runInContext(source, sandbox, { filename: "sw.template.js" });
  /** Post one message; resolves with its reply once its event settled. */
  async function post(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const replies: Record<string, unknown>[] = [];
    const waits: Promise<unknown>[] = [];
    listeners.get("message")!({ data, ports: [{ postMessage: (m: Record<string, unknown>) => replies.push(m) }], waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await flush();
    await Promise.all(waits);
    assert.equal(replies.length, 1, "one reply per message");
    return replies[0]!;
  }
  /** Deliver one message without awaiting it (the page's own loop awaits
   * the reply on its port). */
  const dispatch = (data: Record<string, unknown>, port: { postMessage(m: unknown): void }) =>
    listeners.get("message")!({ data, ports: [port], waitUntil: () => {} });
  /** One page request through the worker's fetch handler (N3); resolves
   * with its answer, rejects as the page's fetch would. */
  const request = (p: string, init?: RequestInit): Promise<Response> => {
    let answered: Promise<Response> | null = null;
    listeners.get("fetch")!({ request: new SWRequest(p, init), respondWith: (r: Promise<Response>) => { answered = r; } });
    assert.ok(answered, `the worker answers ${p}`);
    return answered!;
  };
  return { caches, cacheStorage, fetched, post, dispatch, request, setAnswer: (fn: (p: string) => Answer) => { answer = fn; } };
}

let failures = 0;
async function test(name: string, body: () => Promise<void> | void): Promise<void> {
  try { await body(); console.log(`ok - ${name}`); } catch (e) { failures++; console.log(`not ok - ${name}\n  ${String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n  ")}`); }
}

const DATA = Array.from({ length: 329 }, (_, i) => `/data/g/o/RAG/level__W__${i + 1}.json`);
const CHUNKS = ["/runtime/chunks/lean.wasm.aa.part-000", "/runtime/chunks/lean.wasm.aa.part-001"];
const seed = async (sw: ReturnType<typeof loadWorker>, cacheName: string, paths: string[]) => {
  const c = await sw.caches.open(cacheName);
  for (const p of paths) await c.put(p, new Response(`held ${p}`));
};

await test("offline `warm`: no fetch after the first link failure; held copies still count; nothing pruned", async () => {
  const sw = loadWorker();
  // A cached game: every chunk and 300 of the 329 data files are held, plus a
  // superseded chunk a complete pass would prune.
  await seed(sw, "l4g-runtime-v1", [...CHUNKS, ...DATA.slice(0, 300), "/runtime/chunks/old.part-000"]);
  sw.setAnswer(() => "link");
  const r = await sw.post({ type: "warm", urls: [...DATA, ...CHUNKS], pageFillsShell: true });
  assert.ok(sw.fetched.length <= 6, `at most the first lane-full of fetches failed (${sw.fetched.length})`);
  assert.ok(sw.fetched.length >= 1);
  assert.equal(r.cached, 302, "every held file counts: 300 data + 2 chunks");
  assert.equal(r.total, 331);
  assert.equal(r.linkDown, true);
  assert.equal(r.partial, true, "nothing was verified against the host");
  assert.equal(r.bytes, 0);
  assert.equal(r.pruned, 0, "a link-down pass never prunes");
  assert.ok(await (await sw.caches.open("l4g-runtime-v1")).match("/runtime/chunks/old.part-000"));
});

await test("offline `warm-data` fails fast too; the next message tries the network again", async () => {
  const sw = loadWorker();
  await seed(sw, "l4g-runtime-v1", DATA.slice(0, 10));
  sw.setAnswer(() => "link");
  const r1 = await sw.post({ type: "warm-data", urls: DATA });
  assert.ok(sw.fetched.length <= 6, `${sw.fetched.length} fetches`);
  assert.deepEqual([r1.cached, r1.linkDown, r1.partial], [10, true, true]);
  // The link is back: a later message fetches everything (the flag is per message).
  sw.fetched.length = 0;
  sw.setAnswer(() => "ok");
  const r2 = await sw.post({ type: "warm-data", urls: DATA });
  assert.equal(sw.fetched.length, DATA.length);
  assert.deepEqual([r2.cached, r2.linkDown, r2.partial], [DATA.length, false, false]);
});

await test("an HTTP error or an abort is not a link failure: the rest is still fetched", async () => {
  const sw = loadWorker();
  sw.setAnswer((p) => (p.endsWith("__1.json") ? "abort" : p.endsWith("__2.json") ? "404" : "ok"));
  const r = await sw.post({ type: "warm", urls: DATA.slice(0, 40), pageFillsShell: true });
  assert.equal(sw.fetched.length, 40);
  assert.equal(r.linkDown, false);
  assert.equal(r.cached, 38);
});

await test("a link that drops mid-pass: the files fetched before it are kept and counted", async () => {
  const sw = loadWorker();
  let n = 0;
  sw.setAnswer(() => (++n > 20 ? "link" : "ok"));
  const r = await sw.post({ type: "warm", urls: DATA, pageFillsShell: true });
  assert.ok(sw.fetched.length <= 20 + 6, `${sw.fetched.length} fetches`);
  assert.equal(r.cached, 20);
  assert.equal(r.linkDown, true);
});

await test("the warm-shell fill fails fast on a dead link (an incomplete shell offline)", async () => {
  const precache = ["/", "/index.html", ...Array.from({ length: 200 }, (_, i) => `/fonts/f${i}.woff2`)];
  const sw = loadWorker(precache);
  await seed(sw, "l4g-shell-test", ["/", "/index.html", "/fonts/f0.woff2"]);
  sw.setAnswer(() => "link");
  const r = await sw.post({ type: "warm-shell" });
  assert.ok(sw.fetched.length <= 6, `${sw.fetched.length} fetches`);
  assert.equal(r.present, 3);
  assert.equal(r.complete, false);
  assert.equal(r.linkDown, true);
  // Online: the fill completes, and says the link was fine.
  sw.fetched.length = 0;
  sw.setAnswer(() => "ok");
  const r2 = await sw.post({ type: "warm-shell" });
  assert.equal(sw.fetched.length, 199);
  assert.deepEqual([r2.present, r2.complete, r2.linkDown], [202, true, false]);
});

await test("N3: offline, after the first network-first fetch fails outright, held copies answer cache-first for a few seconds; what is not held and no-store requests still try the network; any HTTP answer ends it", async () => {
  skew = 0;
  const sw = loadWorker();
  await seed(sw, "l4g-runtime-v1", DATA.slice(0, 80));
  sw.setAnswer(() => "link");
  // A boot's reads after game.json: one at a time here (the worst case for
  // the old path — each tried the network first).
  for (const p of DATA.slice(0, 80)) assert.equal(await (await sw.request(p)).text(), `held ${p}`);
  assert.deepEqual(sw.fetched, [DATA[0]], "only the first read tried the network");
  // A file not held still goes to the network (and fails as before).
  await assert.rejects(sw.request(DATA[200]!), TypeError);
  // The L4 probe (no-store) is never answered from the cache.
  await assert.rejects(sw.request(DATA[1]!, { cache: "no-store" }), TypeError);
  assert.deepEqual(sw.fetched, [DATA[0], DATA[200], DATA[1]]);
  // The window lapses: the network is tried again (and the memo renewed).
  skew += 5001;
  sw.fetched.length = 0;
  await sw.request(DATA[2]!);
  await sw.request(DATA[3]!);
  assert.deepEqual(sw.fetched, [DATA[2]]);
  // An HTTP answer (the link is back) ends the memo at once: network-first again.
  sw.setAnswer(() => "ok");
  sw.fetched.length = 0;
  await sw.request(DATA[300]!); // not held: fetched, answered
  assert.equal(await (await sw.request(DATA[4]!)).text(), `body of ${DATA[4]}`, "a fresh copy, not the held one");
  assert.deepEqual(sw.fetched, [DATA[300], DATA[4]]);
  // An HTTP error is no link failure: no memo.
  sw.setAnswer(() => "404");
  sw.fetched.length = 0;
  await sw.request(DATA[5]!);
  await sw.request(DATA[6]!);
  assert.deepEqual(sw.fetched, [DATA[5], DATA[6]]);
  skew = 0;
});

await test("R2-4 (review of N3): the memo covers game content only — inside it, held shell files (worker scripts, the snapshot index, /api/games, a locale) still ask the host", async () => {
  skew = 0;
  const shell = ["/workers/lean.worker.js", "/snapshots/index.json", "/api/games", "/locales/en/translation.json"];
  const sw = loadWorker(shell);
  await seed(sw, "l4g-shell-test", shell); // the previous deploy's copies
  await seed(sw, "l4g-runtime-v1", [...DATA.slice(0, 3), "/i18n/g/o/RAG/en.json"]);
  // One blip on a /data read (ERR_NETWORK_CHANGED) while a deploy has just
  // landed: the host serves the new build again at once.
  sw.setAnswer((p) => (p === DATA[0] ? "link" : "ok"));
  assert.equal(await (await sw.request(DATA[0]!)).text(), `held ${DATA[0]}`);
  assert.equal(await (await sw.request(DATA[1]!)).text(), `held ${DATA[1]}`, "game data: held, cache-first inside the memo");
  assert.equal(await (await sw.request("/i18n/g/o/RAG/en.json")).text(), "held /i18n/g/o/RAG/en.json", "a game's i18n namespace too");
  assert.deepEqual(sw.fetched, [DATA[0]]);
  for (const p of shell) assert.equal(await (await sw.request(p)).text(), `body of ${p}`, `${p}: the new deploy's copy, not the held one`);
  assert.deepEqual(sw.fetched, [DATA[0], ...shell], "every shell file asked the host");
  // ...and their HTTP answers ended the memo: game data is network-first again.
  assert.equal(await (await sw.request(DATA[2]!)).text(), `body of ${DATA[2]}`);
  // Offline, a held shell file still answers from the cache after its fetch fails (as before N3).
  sw.setAnswer(() => "link");
  sw.fetched.length = 0;
  await sw.request(DATA[0]!);
  assert.equal(await (await sw.request("/workers/lean.worker.js")).text(), "body of /workers/lean.worker.js", "the copy the online request stored");
  assert.deepEqual(sw.fetched, [DATA[0], "/workers/lean.worker.js"], "tried the network first even inside the memo");
});

// ---- the page's side ----
type Listener = () => void;
const winListeners = new Map<string, Listener[]>();
let onLine = true;
let serviceWorker: unknown = null;
Object.assign(globalThis, {
  window: {
    // The page's timers run 1000× faster (LINK_RETRY_MS: 10 ms; a round's
    // reply window: seconds; warmTarget's 30 s wait: 30 ms).
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms / 1000),
    clearTimeout,
    addEventListener: (type: string, fn: Listener) => { winListeners.set(type, [...(winListeners.get(type) ?? []), fn]); },
    removeEventListener: () => {},
  },
  // The page's Location (SEC1: the same-origin checks resolve against it).
  location: new URL(`${ORIGIN}/`),
  // The reply port, as the page uses it (no real MessagePort to close).
  MessageChannel: class {
    port1: { onmessage: ((e: { data: unknown }) => void) | null } = { onmessage: null };
    port2 = { postMessage: (m: unknown) => queueMicrotask(() => this.port1.onmessage?.({ data: m })) };
  },
});
Object.defineProperty(globalThis, "navigator", { configurable: true, get: () => (serviceWorker ? { onLine, serviceWorker } : { onLine }) });
/** An active, controlling service worker that hands every message to
 * `deliver`; records the messages. */
function activeWorker(deliver: (data: Record<string, unknown>, port: { postMessage(m: unknown): void }) => void): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  const active = { postMessage: (data: Record<string, unknown>, transfer: { postMessage(m: unknown): void }[]) => { messages.push(data); deliver(data, transfer[0]!); } };
  const reg = { active };
  serviceWorker = { controller: active, ready: Promise.resolve(reg), getRegistration: async () => reg };
  return messages;
}
const manifest = (buildId: string, chunks: string[]) => ({ buildId, leanVersion: "4", files: { "lean.wasm": { bytes: 1, sha256: "", chunks: chunks.map((url) => ({ url, bytes: 1, sha256: "" })) } } });
const CHUNKS10 = Array.from({ length: 10 }, (_, i) => `/runtime/chunks/lean.wasm.cc.part-${String(i).padStart(3, "0")}`);
const DATA300 = DATA.slice(0, 300);
const fire = (type: string) => { const fns = winListeners.get(type) ?? []; winListeners.delete(type); for (const f of fns) f(); };
const gc = await import("./game-cache");

await test("page: a link-down round counts only on what it gained (one `warm`, not two, offline)", () => {
  const r = (cached: number, bytes?: number, linkDown?: boolean) => ({ cached, pruned: 0, total: 331, partial: true, bytes, linkDown });
  assert.equal(gc.warmRoundProgressed(null, r(302, 0, true)), false, "offline first round: stop");
  assert.equal(gc.warmRoundProgressed(null, r(302, 0)), true, "the first round still counts without linkDown");
  assert.equal(gc.warmRoundProgressed(null, r(120, 4_000_000, true)), true, "chunk bytes arrived before the link dropped");
  assert.equal(gc.warmRoundProgressed(r(100, 0), r(120, 0, true)), true, "files were added before it dropped");
  assert.equal(gc.warmRoundProgressed(r(120, 0), r(120, 0, true)), false);
});

await test("page: runWhenOnline runs now online, and once at `online` while offline", () => {
  let ran = 0;
  onLine = true;
  assert.equal(gc.runWhenOnline(() => { ran++; }), true);
  assert.equal(ran, 1);
  onLine = false;
  assert.equal(gc.runWhenOnline(() => { ran++; }), false);
  assert.equal(ran, 1, "deferred while offline");
  onLine = true;
  fire("online");
  assert.equal(ran, 2);
  fire("online");
  assert.equal(ran, 2, "once");
});

await test("R2: one transient fetch failure (runtime held, 300 game files, online) — one more round after LINK_RETRY_MS, and the warm-up completes", async () => {
  onLine = true;
  const sw = loadWorker();
  await seed(sw, "l4g-runtime-v1", CHUNKS10); // the runtime came with an earlier game
  let n = 0;
  sw.setAnswer(() => (++n === 3 ? "link" : "ok")); // ERR_NETWORK_CHANGED on the 3rd fetch, fine after
  const messages = activeWorker((data, port) => sw.dispatch(data, port));
  const r = await gc.warmRuntimeCacheOutcome(manifest("r2a", CHUNKS10) as never, DATA300, 30 * 60_000);
  assert.ok(typeof r !== "string");
  assert.equal(messages.length, 2, "the cut-short round, then one more");
  assert.deepEqual([r.partial, r.linkDown, r.cached, r.total], [false, false, 313, 313]);
  const held = await (await sw.caches.open("l4g-runtime-v1")).keys();
  assert.equal(held.filter((q) => q.url.includes("/data/")).length, 300, "every game file cached");
});

await test("R2: a dead link the browser does not report — two fail-fast rounds, then the warm-up ends; offline — one", async () => {
  onLine = true;
  const sw = loadWorker();
  await seed(sw, "l4g-runtime-v1", [...CHUNKS10, ...DATA300.slice(0, 100)]);
  sw.setAnswer(() => "link");
  const messages = activeWorker((data, port) => sw.dispatch(data, port));
  const r = await gc.warmRuntimeCacheOutcome(manifest("r2b", CHUNKS10) as never, DATA300, 30 * 60_000);
  assert.ok(typeof r !== "string");
  assert.equal(messages.length, 2);
  assert.ok(sw.fetched.length <= 12, `at most a lane-full of failing fetches per round (${sw.fetched.length})`);
  assert.deepEqual([r.partial, r.linkDown, r.cached], [true, true, 110], "what is held still counts");
  onLine = false;
  const messages2 = activeWorker((data, port) => sw.dispatch(data, port));
  await gc.warmRuntimeCacheOutcome(manifest("r2c", CHUNKS10) as never, DATA300, 30 * 60_000);
  assert.equal(messages2.length, 1, "the browser says offline: no retry");
  onLine = true;
});

await test("R2: the shell fill's step — a link-down round that fetched nothing is retried once (online only); one that fetched some goes on", async () => {
  const sc = await import("./sw-client");
  const r = (present: number, o: { fetched?: number; linkDown?: boolean; complete?: boolean } = {}) =>
    ({ type: "shell-filled" as const, present, total: 203, fetched: o.fetched ?? 0, failed: 0, complete: !!o.complete, pruned: 0, linkDown: o.linkDown });
  onLine = true;
  assert.equal(sc.shellRoundStep(null, r(17, { linkDown: true }), false), "retry", "a transient failure before the first file");
  assert.equal(sc.shellRoundStep(r(17, { linkDown: true }), r(17, { linkDown: true }), true), "stop", "twice in a row: the link is down");
  assert.equal(sc.shellRoundStep(null, r(17, { linkDown: true, fetched: 14 }), false), "continue", "it fetched some before the link failed");
  assert.equal(sc.shellRoundStep(r(17), r(203, { complete: true }), false), "stop");
  assert.equal(sc.shellRoundStep(r(17), r(60), false), "continue");
  assert.equal(sc.shellRoundStep(r(60), r(60), false), "stop", "no progress");
  onLine = false;
  assert.equal(sc.shellRoundStep(null, r(17, { linkDown: true }), false), "stop", "the browser says offline");
  onLine = true;
});

await test("R4: `revalidate: false` fetches only what the cache lacks; held copies still count", async () => {
  const sw = loadWorker();
  await seed(sw, "l4g-runtime-v1", DATA.slice(0, 30));
  const r = await sw.post({ type: "warm", urls: DATA.slice(0, 40), pageFillsShell: true, revalidate: false, prune: false });
  assert.deepEqual(sw.fetched, DATA.slice(30, 40));
  assert.deepEqual([r.cached, r.partial], [40, false]);
  sw.fetched.length = 0;
  await sw.post({ type: "warm", urls: DATA.slice(0, 40), pageFillsShell: true, prune: false });
  assert.equal(sw.fetched.length, 40, "a page that says nothing (an older build): every data file revalidated, as before");
});

await test("R4: the page revalidates in the first round that reaches the host only; a boot whose early warm-data did, not at all", async () => {
  const run = async (replies: Record<string, unknown>[], opts?: { revalidated?: boolean }) => {
    const left = [...replies];
    const messages = activeWorker((_data, port) => port.postMessage(left.shift()));
    await gc.warmRuntimeCacheOutcome(manifest(`r4-${Math.random()}`, CHUNKS10) as never, DATA300, 30 * 60_000, opts);
    return messages.map((m) => m.revalidate);
  };
  const slow = (cached: number) => ({ cached, pruned: 0, total: 313, partial: true, bytes: 8_000_000 });
  const done = { cached: 313, pruned: 0, total: 313, partial: false, bytes: 0 };
  assert.deepEqual(await run([slow(100), slow(101), slow(102), done]), [true, false, false, false]);
  assert.deepEqual(await run([slow(100), done], { revalidated: true }), [false, false]);
  const cut = { cached: 100, pruned: 0, total: 313, partial: true, bytes: 0, linkDown: true };
  assert.deepEqual(await run([cut, slow(120), done]), [true, true, false], "a round the link cut off did not revalidate");
});

await test("N1: a link-down round with every file held ends the warm-up (pure step); one with files missing still earns R2's retry", () => {
  const r = (cached: number) => ({ cached, pruned: 0, total: 192, partial: true, bytes: 0, linkDown: true });
  onLine = true;
  assert.equal(gc.heldButNotRevalidated(r(192)), true);
  assert.equal(gc.warmRoundStep(null, r(192), false), "stop", "all held: a retry could only revalidate");
  assert.equal(gc.warmRoundStep(null, r(191), false), "retry", "R2 unchanged while something is missing");
  assert.equal(gc.heldButNotRevalidated({ cached: 192, pruned: 0, total: 192, partial: false, bytes: 0 }), false, "a complete round is no link failure");
  assert.equal(gc.heldButNotRevalidated({ cached: 0, pruned: 0, total: 0, partial: true, bytes: 0, linkDown: true }), false, "nothing named: nothing held");
});

await test("N1: offline with every file held while the browser says online — one `warm`, no retry round", async () => {
  onLine = true;
  const sw = loadWorker();
  await seed(sw, "l4g-runtime-v1", [...CHUNKS10, ...DATA300, "/runtime/runtime-manifest.json", "/snapshots/index.json", "/profiles/index.json"]);
  sw.setAnswer(() => "link");
  const messages = activeWorker((data, port) => sw.dispatch(data, port));
  const r = await gc.warmRuntimeCacheOutcome(manifest("n1", CHUNKS10) as never, DATA300, 30 * 60_000);
  assert.ok(typeof r !== "string");
  assert.equal(messages.length, 1, "no second round of failing fetches");
  assert.deepEqual([r.cached, r.total, r.linkDown, r.partial], [313, 313, true, true]);
  assert.ok(sw.fetched.length <= 7, `one lane-full of failing fetches at most (${sw.fetched.length})`);
});

await test("SEC1 page: the warm-up and the early data warm-up send the service worker this origin's urls only", async () => {
  onLine = true;
  const messages = activeWorker((data, port) => {
    const urls = data.urls as string[];
    port.postMessage({ type: "warmed", cached: urls.length, pruned: 0, total: urls.length, partial: false, bytes: 0, linkDown: false });
  });
  const foreignChunk = "https://evil.example/runtime/chunks/lean.wasm.ee.part-000";
  const r = await gc.warmRuntimeCacheOutcome(manifest("sec1", [CHUNKS10[0]!, foreignChunk]) as never, [DATA[0]!, "//evil.example/data/x.json"], 60_000);
  assert.ok(typeof r !== "string");
  assert.equal(messages.length, 1);
  const sent = messages[0]!.urls as string[];
  assert.ok(sent.includes(CHUNKS10[0]!) && sent.includes(DATA[0]!), "this origin's chunk and data file are sent");
  assert.deepEqual(sent.filter((u) => u.includes("evil.example")), [], "no foreign url is sent");
  messages.length = 0;
  await gc.warmDataEarly(["https://evil.example/a.json", "\\\\evil.example/b.json", DATA[1]!]);
  assert.deepEqual(messages.map((m) => [m.type, m.urls]), [["warm-data", [DATA[1]!]]]);
});

if (failures) { console.log(`sw-offline-warm: ${failures} FAILED`); process.exit(1); }
console.log("sw-offline-warm: ALL TESTS PASS");
