// Run: node --import ./client/src/wasm/ts-resolve-hook.mjs client/src/wasm/game-cache-crosstab.test.ts
// Live 2026-10-03, page side of the warm-up protocol and the L12 channel:
//  - D1: warmRoundProgressed — a round counts when a file completed OR new
//    chunk bytes arrived; a reply without `bytes` keeps the whole-file rule;
//  - D2: a running download heartbeats `prepare-progress` once a second and
//    answers `prepare-query` at once; a remote download not heard of for
//    REMOTE_DOWNLOAD_TTL_MS expires and the tiles re-probe;
//  - D3: every terminal outcome of a Prepare says `prepare-ended`, which drops
//    the other tabs' busy refusals; a look at the tab drops a busy refusal
//    whose holder runs nowhere;
//  - review round: R1 — progress is said from the progress path too, a
//    hidden sender's word is kept HIDDEN_DOWNLOAD_TTL_MS (its timers may wake
//    once a minute), visibility changes are said at once, pagehide ends the
//    downloads; R3 — one entry per sender tab, and one sender's end leaves
//    another's download; UX5 — a phase change is said at once;
//  - F1 (live run of f468f2c): after pagehide the closing tab says no more
//    progress (the visibilitychange that follows it brought the ended
//    download back as a hidden ghost for 75 s) until a persisted pageshow;
//    a receiver ignores progress of a (tab, id) it heard end, and shows a new
//    download (a new id) of the same tab.
//  - NEW-2 (live run of 4083fb4): every word of a download carries its
//    transfer size, so a tab whose own index has not arrived yet can show it.
// A fake clock (window and global timers + Date.now), a fake
// BroadcastChannel standing in for a second tab, a fake prefetch Worker and
// a fake fetch.
import assert from "node:assert/strict";

type Timer = { at: number; fn: () => void };
let now = 0;
let nextId = 1;
const timers = new Map<number, Timer>();
const winListeners = new Map<string, (() => void)[]>();
const fakeWindow = {
  setTimeout: (fn: () => void, ms: number): number => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
  clearTimeout: (id: number): void => { timers.delete(id); },
  addEventListener: (type: string, fn: () => void): void => { winListeners.set(type, [...(winListeners.get(type) ?? []), fn]); },
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
Date.now = () => now;

/** BroadcastChannel as browsers deliver it: to every OTHER instance of the
 * name, asynchronously, a structured clone. */
class FakeBroadcastChannel {
  static all: FakeBroadcastChannel[] = [];
  name: string;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  received: Record<string, unknown>[] = [];
  constructor(name: string) { this.name = name; FakeBroadcastChannel.all.push(this); }
  postMessage(data: unknown): void {
    const copy = structuredClone(data);
    for (const other of FakeBroadcastChannel.all) {
      if (other !== this && other.name === this.name) queueMicrotask(() => { other.received.push(copy as Record<string, unknown>); other.onmessage?.({ data: copy }); });
    }
  }
  close(): void { FakeBroadcastChannel.all = FakeBroadcastChannel.all.filter((c) => c !== this); }
}

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  terminated = false;
  constructor(public_url: string) { void public_url; FakeWorker.all.push(this); }
  postMessage(): void {}
  terminate(): void { this.terminated = true; }
  say(data: unknown): void { if (!this.terminated) this.onmessage?.({ data }); }
}

const fetched: string[] = [];
// runtime/v1: buildId is "wasm64-" + sha256(lean.wasm)[:16], which qed64's resolveRuntimeManifest checks (since qed64 80ddbf6).
const manifest = { buildId: `wasm64-${"b1".repeat(8)}`, leanVersion: "4", files: { "lean.js": { bytes: 1, sha256: "", chunks: [{ url: "/runtime/chunks/lean.js.aa.part-000", bytes: 1, sha256: "" }] }, "lean.wasm": { bytes: 1, sha256: "b1".repeat(32), chunks: [] } } };
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
Object.assign(globalThis, {
  window: fakeWindow,
  // qed64's prefetchRaw keeps its silence timer on the global clock.
  setTimeout: fakeWindow.setTimeout,
  clearTimeout: fakeWindow.clearTimeout,
  Worker: FakeWorker,
  BroadcastChannel: FakeBroadcastChannel,
  // The page's Location (SEC1: the same-origin checks resolve against it).
  location: new URL("https://l4g.test/"),
  fetch: async (url: string) => {
    fetched.push(url);
    if (url === "/runtime/runtime-manifest.json") return json(manifest);
    if (url.endsWith("/game.json")) return json({ worldSize: { W: 1 } });
    if (url.endsWith("/inventory.json")) return json({ tactics: [{ name: "rfl" }] });
    return new Response("", { status: 404 });
  },
});
// No service worker: a Prepare's warm-up answers "no worker" at once.
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => ({ removeEntry: async () => {} }) }) } },
});

const gc = await import("./game-cache");
const { PREFETCH_SILENCE_MS } = await import("qed64/embed");
const { getDefaultStore } = await import("jotai");
const store = getDefaultStore();
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r)); };

// The page's channel exists once something subscribes (the landing page does
// on mount); the second tab is a raw channel of the same name.
let reprobes = 0;
gc.onRemoteCacheChange(() => { reprobes++; });
const tab2 = new FakeBroadcastChannel("l4g-cache");
/** What this tab said since the last call, each word's tab id checked and
 * dropped (R3: every word carries its sender's id), and its download id
 * (F1) checked and dropped — kept in `saidIds`, in order. */
let ownTab: unknown;
const saidIds: unknown[] = [];
const sent = () => tab2.received.splice(0).map(({ tab, id, ...m }) => {
  if (!String(m.type).startsWith("prepare-")) return m;
  assert.equal(typeof tab, "string", "every download word names its tab");
  ownTab ??= tab;
  assert.equal(tab, ownTab, "one id per tab");
  if (m.type === "prepare-progress") assert.equal(typeof id, "number", "F1: every progress word names its download");
  saidIds.push(id);
  return m;
});
/** The page's document (R1/F1: its visibilitychange listener is registered
 * once, by the first download reported while a document exists). */
const docListeners = new Map<string, (() => void)[]>();
const doc = { visibilityState: "visible", addEventListener: (type: string, fn: () => void) => { docListeners.set(type, [...(docListeners.get(type) ?? []), fn]); } };
const fireDoc = (type: string) => { for (const fn of docListeners.get(type) ?? []) fn(); };
const fireWin = (type: string, ev: unknown = {}) => { for (const fn of winListeners.get(type) ?? []) (fn as (e: unknown) => void)(ev); };

let failures = 0;
async function test(name: string, body: () => Promise<void> | void): Promise<void> {
  // The module's sweep and heartbeat chains hold their timer ids: let them
  // run out (nothing left to expire or to say) rather than drop their timers.
  store.set(gc.remoteSendersAtom, {});
  advance(10_000);
  timers.clear(); now = 0; reprobes = 0; sent(); FakeWorker.all.length = 0;
  store.set(gc.prepareStatusesAtom, {});
  try { await body(); console.log(`ok - ${name}`); } catch (e) { failures++; console.log(`not ok - ${name}\n  ${String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n  ")}`); }
}

await test("D1: a round progressed when a file completed or new chunk bytes arrived", () => {
  const r = (cached: number, bytes?: number) => ({ cached, pruned: 0, total: 13, partial: true, ...(bytes === undefined ? {} : { bytes }) });
  assert.equal(gc.warmRoundProgressed(null, r(0, 0)), true, "the first round always counts");
  assert.equal(gc.warmRoundProgressed(r(5, 0), r(6, 0)), true, "a file completed");
  assert.equal(gc.warmRoundProgressed(r(7, 9_600_000), r(7, 9_600_000)), true, "a whole round inside one 16 MiB chunk");
  assert.equal(gc.warmRoundProgressed(r(7, 9_600_000), r(7, 0)), false, "nothing arrived: a dead link ends the warm-up");
  assert.equal(gc.warmRoundProgressed(r(7), r(7)), false, "a pre-D1 worker (no bytes): the whole-file rule");
  assert.equal(gc.warmRoundProgressed(r(7), r(8)), true);
});

await test("D2: remote downloads expire their ttl after their sender's last word (pure; R1/R3: per sender)", () => {
  const ttl = gc.REMOTE_DOWNLOAD_TTL_MS;
  const cur = {
    a: { T1: { phase: "running" as const, bytes: 1, total: 2, at: 1000, ttl } },
    b: { T2: { phase: "warming" as const, bytes: 2, total: 2, at: 5000, ttl } },
    c: { T3: { phase: "running" as const, bytes: 1, total: 2, at: 1000, ttl }, T4: { phase: "running" as const, bytes: 1, total: 2, at: 0, ttl: gc.HIDDEN_DOWNLOAD_TTL_MS } },
  };
  assert.deepEqual(gc.expireRemoteDownloads(cur, 6999), { kept: cur, expired: [] });
  const r = gc.expireRemoteDownloads(cur, 7000);
  assert.deepEqual(r.expired, ["a"], "c keeps its hidden sender");
  assert.deepEqual(Object.keys(r.kept), ["b", "c"]);
  assert.deepEqual(Object.keys(r.kept.c!), ["T4"]);
  assert.deepEqual(gc.expireRemoteDownloads(cur, 75_000).expired, ["a", "b", "c"]);
  assert.equal(gc.REMOTE_DOWNLOAD_TTL_MS, 6000);
});

await test("D2: another tab's heartbeat shows; silence for 6 s drops it and re-probes", async () => {
  tab2.postMessage({ type: "prepare-progress", name: "rag", tab: "B", hidden: false, phase: "running", bytes: 10, total: 100 });
  await flush();
  assert.deepEqual(store.get(gc.remoteDownloadsAtom).rag, { phase: "running", bytes: 10, total: 100, at: 0, ttl: 6000 });
  advance(3000);
  tab2.postMessage({ type: "prepare-progress", name: "rag", tab: "B", hidden: false, phase: "running", bytes: 30, total: 100 });
  await flush();
  advance(5000); // 5 s after the last beat: still alive
  assert.equal(store.get(gc.remoteDownloadsAtom).rag?.bytes, 30);
  assert.equal(reprobes, 0);
  advance(1000); // 6 s: the tab closed or crashed
  assert.equal(store.get(gc.remoteDownloadsAtom).rag, undefined);
  assert.equal(reprobes, 1, "the tiles re-probe");
  advance(10_000);
  assert.equal(timers.size, 0, "the sweep stops with nothing left to expire");
});

await test("D3: prepare-ended drops this tab's busy refusals (only those) and re-probes", async () => {
  store.set(gc.prepareStatusesAtom, {
    nng4: { phase: "failed", bytes: 0, total: 1, result: "busy" },
    stg4: { phase: "failed", bytes: 0, total: 1, result: "error", error: "HTTP 500" },
  });
  tab2.postMessage({ type: "prepare-progress", name: "nng4", tab: "B", phase: "running", bytes: 1, total: 2 });
  await flush();
  tab2.postMessage({ type: "prepare-ended", name: "nng4", tab: "B", outcome: "failed" });
  await flush();
  assert.deepEqual(Object.keys(store.get(gc.prepareStatusesAtom)), ["stg4"], "a genuine local failure stays");
  assert.equal(store.get(gc.remoteDownloadsAtom).nng4, undefined);
  assert.equal(reprobes, 1);
});

await test("D2: a local download is said at once, then once a second (also without new bytes), and answers a query at once", async () => {
  gc.reportDownload("lag", { phase: "running", bytes: 0, total: 50 });
  await flush();
  assert.deepEqual(sent(), [{ type: "prepare-progress", name: "lag", hidden: false, phase: "running", bytes: 0, total: 50 }]);
  gc.reportDownload("lag", { phase: "running", bytes: 5, total: 50 });
  gc.reportDownload("lag", { phase: "running", bytes: 7, total: 50 });
  await flush();
  assert.deepEqual(sent(), [], "updates ride the heartbeat, not one message each");
  advance(1000); await flush();
  assert.deepEqual(sent(), [{ type: "prepare-progress", name: "lag", hidden: false, phase: "running", bytes: 7, total: 50 }]);
  advance(1000); await flush();
  assert.equal(sent().length, 1, "a beat with no new bytes still goes out");
  advance(400);
  tab2.postMessage({ type: "prepare-query" });
  await flush();
  assert.deepEqual(sent(), [{ type: "prepare-progress", name: "lag", hidden: false, phase: "running", bytes: 7, total: 50 }], "answered at once");
  gc.endDownload("lag", "done");
  await flush();
  assert.deepEqual(sent(), [{ type: "prepare-ended", name: "lag", outcome: "done" }]);
  advance(5000); await flush();
  assert.deepEqual(sent(), [], "no beat after the end");
  assert.equal(timers.size, 0);
});

await test("D3: a look at the tab drops a busy refusal whose holder runs nowhere", async () => {
  store.set(gc.prepareStatusesAtom, {
    robo: { phase: "failed", bytes: 0, total: 1, result: "busy" },
    ntg: { phase: "failed", bytes: 0, total: 1, result: "busy" },
  });
  tab2.onmessage = (e) => {
    // The second tab runs robo's Prepare and answers the query.
    if ((e.data as { type?: string }).type === "prepare-query") tab2.postMessage({ type: "prepare-progress", name: "robo", tab: "B", phase: "running", bytes: 3, total: 9 });
  };
  gc.queryRemoteDownloads();
  await flush();
  assert.deepEqual(tab2.received.splice(0), [{ type: "prepare-query" }]);
  assert.equal(store.get(gc.remoteDownloadsAtom).robo?.bytes, 3);
  advance(gc.QUERY_ANSWER_MS - 1);
  assert.equal(Object.keys(store.get(gc.prepareStatusesAtom)).length, 2, "not before the answers had their time");
  advance(1);
  assert.deepEqual(Object.keys(store.get(gc.prepareStatusesAtom)), ["robo"], "ntg's holder runs nowhere; robo's still runs");
  tab2.onmessage = null;
});

await test("D2/D3: a Prepare heartbeats while it runs and says how it ended — failed", async () => {
  const entry = { name: "knights", url: "/snapshots/knights.x.snapz", bytes: 1000, digest: "sha256:" + "cd".repeat(32) } as Parameters<typeof gc.prepareGame>[0];
  const all = gc.prepareGame(entry, { gameId: "g/x/Knights", langs: ["de"] });
  await flush();
  assert.deepEqual(sent(), [{ type: "prepare-progress", name: "knights", hidden: false, phase: "running", bytes: 0, total: 1000, transfer: 1000 }]);
  const w = FakeWorker.all[0]!;
  w.say({ status: "progress", bytes: 400, total: 1000 });
  advance(1000); await flush();
  assert.deepEqual(sent(), [{ type: "prepare-progress", name: "knights", hidden: false, phase: "running", bytes: 400, total: 1000, transfer: 1000 }]);
  w.say({ status: "error", error: "HTTP 503" });
  const st = await all;
  await flush();
  assert.equal(st.phase, "failed");
  assert.deepEqual(sent(), [{ type: "prepare-ended", name: "knights", outcome: "failed" }]);
  advance(5000); await flush();
  assert.deepEqual(sent(), [], "no heartbeat after the end");
});

await test("D3: a stalled Prepare says `failed` (CQ1: from the status, not its wording); a busy one `busy`", async () => {
  const entry = { name: "logic", url: "/snapshots/logic.x.snapz", bytes: 1000, digest: "sha256:" + "ef".repeat(32) } as Parameters<typeof gc.prepareGame>[0];
  const all = gc.prepareGame(entry);
  await flush(); sent();
  advance(PREFETCH_SILENCE_MS);
  assert.match((await all).error ?? "", /stalled/);
  await flush();
  assert.deepEqual(sent().filter((m) => m.type === "prepare-ended"), [{ type: "prepare-ended", name: "logic", outcome: "failed" }]);
  const busy = gc.prepareGame({ ...entry, name: "reintro" });
  await flush(); sent();
  FakeWorker.all[FakeWorker.all.length - 1]!.say({ status: "busy", error: "held" });
  assert.equal((await busy).result, "busy");
  await flush();
  assert.deepEqual(sent(), [{ type: "prepare-ended", name: "reintro", outcome: "busy" }]);
});

await test("D6: a Prepare with a game id reads its game.json and inventory.json for the warm-up; done without a worker is `partial`", async () => {
  fetched.length = 0;
  const entry = { name: "tg", url: "/snapshots/tg.x.snapz", bytes: 1000, digest: "sha256:" + "01".repeat(32) } as Parameters<typeof gc.prepareGame>[0];
  const all = gc.prepareGame(entry, { gameId: "g/test/TG", langs: ["fr"] });
  await flush(); sent();
  FakeWorker.all[FakeWorker.all.length - 1]!.say({ status: "already-cached" });
  const st = await all;
  await flush();
  assert.equal(st.phase, "done");
  assert.equal(st.runtime, null, "no service worker answered");
  assert.ok(fetched.includes("/data/g/test/TG/game.json") && fetched.includes("/data/g/test/TG/inventory.json"), fetched.join(" "));
  const msgs = sent();
  assert.deepEqual(msgs[msgs.length - 1], { type: "prepare-ended", name: "tg", outcome: "partial" });
});

await test("R1: a hidden sender's download survives a minute between its words (its throttled timers); silence past its ttl still ends it", async () => {
  const say = (hidden: boolean) => tab2.postMessage({ type: "prepare-progress", name: "rag", tab: "B", hidden, phase: "warming", bytes: 100, total: 100 });
  say(true);
  await flush();
  for (let minute = 0; minute < 3; minute++) {
    advance(59_000);
    assert.ok(store.get(gc.remoteDownloadsAtom).rag, `shown through minute ${minute}`);
    advance(1000);
    say(true); // the once-a-minute wake-up of the hidden tab's heartbeat
    await flush();
  }
  assert.equal(reprobes, 0, "the tile never fell back to Prepare");
  advance(gc.HIDDEN_DOWNLOAD_TTL_MS - 1);
  assert.ok(store.get(gc.remoteDownloadsAtom).rag);
  advance(1000);
  assert.equal(store.get(gc.remoteDownloadsAtom).rag, undefined, "a crashed hidden tab is dropped after its ttl");
  assert.equal(reprobes, 1);
  // Shown again, the sender beats each second: the 6 s ttl applies.
  say(true); await flush();
  say(false); await flush();
  advance(gc.REMOTE_DOWNLOAD_TTL_MS);
  assert.equal(store.get(gc.remoteDownloadsAtom).rag, undefined);
});

await test("R1/UX5: a hidden tab's progress path says progress once a beat with its timers starved; visibility and phase changes are said at once; pagehide ends the downloads", async () => {
  Object.assign(globalThis, { document: doc });
  doc.visibilityState = "visible";
  try {
    gc.reportDownload("rag", { phase: "running", bytes: 0, total: 100 });
    await flush();
    assert.deepEqual(sent(), [{ type: "prepare-progress", name: "rag", hidden: false, phase: "running", bytes: 0, total: 100 }]);
    doc.visibilityState = "hidden";
    fireDoc("visibilitychange");
    await flush();
    assert.deepEqual(sent(), [{ type: "prepare-progress", name: "rag", hidden: true, phase: "running", bytes: 0, total: 100 }], "said at once on hiding");
    // Throttled: no timer fires; the prefetch worker's progress (every 500 ms,
    // a worker message — not throttled) keeps arriving.
    for (let i = 1; i <= 10; i++) { now += 500; gc.reportDownload("rag", { phase: "running", bytes: i * 10, total: 100 }); }
    await flush();
    assert.deepEqual(sent().map((m) => [m.bytes, m.hidden]), [[20, true], [40, true], [60, true], [80, true], [100, true]], "one word per beat period, from the progress path");
    now += 200;
    gc.reportDownload("rag", { phase: "warming", bytes: 100, total: 100 });
    await flush();
    assert.deepEqual(sent().map((m) => m.phase), ["warming"], "UX5: a phase change is said at once, not at the next beat");
    fireWin("pagehide", { persisted: false });
    await flush();
    assert.deepEqual(sent(), [{ type: "prepare-ended", name: "rag", outcome: "closed" }], "a tab that goes away ends its downloads");
    fireWin("pageshow", { persisted: true }); // back from the back/forward cache (F1: says again)
    gc.endDownload("rag", "done");
    await flush();
    sent();
  } finally {
    doc.visibilityState = "visible";
    delete (globalThis as { document?: unknown }).document;
  }
});

await test("R3: two tabs reporting one snapshot — one's end leaves the other's download; the tile follows the first sender", async () => {
  const say = (tab: string, bytes: number) => tab2.postMessage({ type: "prepare-progress", name: "nng4", tab, phase: "running", bytes, total: 100 });
  say("A", 10); say("G", 70);
  await flush();
  assert.equal(store.get(gc.remoteDownloadsAtom).nng4?.bytes, 10, "A, heard of first");
  say("G", 80); say("A", 20);
  await flush();
  assert.equal(store.get(gc.remoteDownloadsAtom).nng4?.bytes, 20, "A's count, not G's: no flicker between the two");
  tab2.postMessage({ type: "prepare-ended", name: "nng4", tab: "G", outcome: "ended" });
  await flush();
  assert.equal(store.get(gc.remoteDownloadsAtom).nng4?.bytes, 20, "A's download stays");
  assert.deepEqual(Object.keys(store.get(gc.remoteSendersAtom).nng4 ?? {}), ["A"]);
  tab2.postMessage({ type: "prepare-ended", name: "nng4", tab: "A", outcome: "done" });
  await flush();
  assert.equal(store.get(gc.remoteDownloadsAtom).nng4, undefined);
  assert.equal(reprobes, 2, "each end re-probes");
  advance(10_000);
});

await test("F1: a closing tab's pagehide, then its visibilitychange (hidden) — the ended download is not said again; nor by a late progress report or the heartbeat; a persisted pageshow says it again under a new id", async () => {
  Object.assign(globalThis, { document: doc });
  doc.visibilityState = "visible";
  try {
    gc.reportDownload("nng4", { phase: "running", bytes: 10, total: 100 });
    await flush();
    assert.deepEqual(sent(), [{ type: "prepare-progress", name: "nng4", hidden: false, phase: "running", bytes: 10, total: 100 }]);
    const first = saidIds[saidIds.length - 1];
    fireWin("pagehide", { persisted: false });
    doc.visibilityState = "hidden"; // the unload order: pagehide, then visibilitychange
    fireDoc("visibilitychange");
    await flush();
    assert.deepEqual(sent(), [{ type: "prepare-ended", name: "nng4", outcome: "closed" }], "the end only — no hidden ghost after it");
    assert.equal(saidIds[saidIds.length - 1], first, "the end names the download it ends");
    now += 2000;
    gc.reportDownload("nng4", { phase: "running", bytes: 20, total: 100 }); // the prefetch worker reports until the page dies
    tab2.postMessage({ type: "prepare-query" });
    advance(5000);
    await flush();
    assert.deepEqual(sent(), [], "nothing after pagehide: progress path, query answer and heartbeat stay silent");
    // Restored from the back/forward cache: its downloads run again.
    doc.visibilityState = "visible";
    fireWin("pageshow", { persisted: true });
    await flush();
    assert.deepEqual(sent(), [{ type: "prepare-progress", name: "nng4", hidden: false, phase: "running", bytes: 20, total: 100 }]);
    assert.notEqual(saidIds[saidIds.length - 1], first, "a new id: the other tabs heard the old one end");
    gc.endDownload("nng4", "done");
    await flush();
    sent();
  } finally {
    doc.visibilityState = "visible";
    delete (globalThis as { document?: unknown }).document;
  }
});

await test("F1: a receiver ignores progress of a download it heard end (the closing tab's hidden ghost); a new download of the same tab shows", async () => {
  tab2.postMessage({ type: "prepare-progress", name: "rag", tab: "C", id: 1, hidden: false, phase: "running", bytes: 40, total: 100 });
  await flush();
  assert.equal(store.get(gc.remoteDownloadsAtom).rag?.bytes, 40);
  tab2.postMessage({ type: "prepare-ended", name: "rag", tab: "C", id: 1, outcome: "closed" });
  tab2.postMessage({ type: "prepare-progress", name: "rag", tab: "C", id: 1, hidden: true, phase: "running", bytes: 40, total: 100 });
  await flush();
  assert.equal(store.get(gc.remoteDownloadsAtom).rag, undefined, "no ghost after the end");
  assert.deepEqual(store.get(gc.remoteSendersAtom), {});
  assert.equal(reprobes, 1, "the end re-probes once");
  advance(gc.REMOTE_DOWNLOAD_TTL_MS + 1000);
  assert.equal(reprobes, 1, "no expiry of a ghost later either");
  // The same tab retries (or a reloaded tab's other download): a new id shows.
  tab2.postMessage({ type: "prepare-progress", name: "rag", tab: "C", id: 2, hidden: false, phase: "running", bytes: 5, total: 100 });
  await flush();
  assert.equal(store.get(gc.remoteDownloadsAtom).rag?.bytes, 5, "a new download of the same tab is shown");
  tab2.postMessage({ type: "prepare-ended", name: "rag", tab: "C", id: 2, outcome: "done" });
  // A tab of a build before F1 (no ids): its words are taken as before.
  tab2.postMessage({ type: "prepare-ended", name: "lag", tab: "O", outcome: "failed" });
  tab2.postMessage({ type: "prepare-progress", name: "lag", tab: "O", hidden: false, phase: "running", bytes: 1, total: 9 });
  await flush();
  assert.equal(store.get(gc.remoteDownloadsAtom).lag?.bytes, 1);
  tab2.postMessage({ type: "prepare-ended", name: "lag", tab: "O", outcome: "done" });
  await flush();
  advance(10_000);
});

await test("F1: this tab's downloads carry one id each — a retry after an end is a new download", async () => {
  gc.reportDownload("logic", { phase: "running", bytes: 0, total: 10 });
  gc.reportDownload("logic", { phase: "warming", bytes: 10, total: 10 });
  gc.endDownload("logic", "partial");
  gc.reportDownload("logic", { phase: "running", bytes: 0, total: 10 });
  gc.endDownload("logic", "done");
  await flush();
  const words = sent();
  assert.deepEqual(words.map((m) => m.type), ["prepare-progress", "prepare-progress", "prepare-ended", "prepare-progress", "prepare-ended"]);
  const ids = saidIds.slice(-5);
  assert.equal(ids[0], ids[1]);
  assert.equal(ids[1], ids[2], "the end names the download it ends");
  assert.notEqual(ids[3], ids[2], "the retry is a new download");
  assert.equal(ids[3], ids[4]);
});

await test("NEW-2: a Prepare's words carry the transfer size; a receiver keeps it (its tile needs no index of its own to show the download)", async () => {
  const entry = { name: "rag", url: "/snapshots/rag.x.snapz", bytes: 1_400_000_000, transfer: 282_000_000, digest: "sha256:" + "12".repeat(32) } as Parameters<typeof gc.prepareGame>[0];
  const all = gc.prepareGame(entry);
  await flush();
  assert.deepEqual(sent().map((m) => m.transfer), [282_000_000], "the sender says the size the tile promises");
  FakeWorker.all[FakeWorker.all.length - 1]!.say({ status: "error", error: "HTTP 500" });
  await all;
  await flush(); sent();
  tab2.postMessage({ type: "prepare-progress", name: "rag", tab: "N", id: 1, hidden: false, phase: "running", bytes: 700_000_000, total: 1_400_000_000, transfer: 282_000_000 });
  await flush();
  assert.equal(store.get(gc.remoteDownloadsAtom).rag?.transfer, 282_000_000);
  // A sender of an older build says none; a malformed size is not kept.
  tab2.postMessage({ type: "prepare-progress", name: "lag", tab: "O", id: 1, hidden: false, phase: "running", bytes: 1, total: 9 });
  tab2.postMessage({ type: "prepare-progress", name: "ntg", tab: "O", id: 2, hidden: false, phase: "running", bytes: 1, total: 9, transfer: "lots" });
  await flush();
  assert.equal("transfer" in store.get(gc.remoteDownloadsAtom).lag!, false);
  assert.equal("transfer" in store.get(gc.remoteDownloadsAtom).ntg!, false);
  for (const [name, tab, id] of [["rag", "N", 1], ["lag", "O", 1], ["ntg", "O", 2]] as const) tab2.postMessage({ type: "prepare-ended", name, tab, id, outcome: "done" });
  await flush();
  advance(10_000);
});

for (const c of FakeBroadcastChannel.all) c.close();
if (failures) { console.log(`game-cache-crosstab: ${failures} FAILED`); process.exit(1); }
console.log("game-cache-crosstab: ALL TESTS PASS");
