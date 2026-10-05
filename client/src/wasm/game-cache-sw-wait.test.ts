// Run: node --import ./client/src/wasm/ts-resolve-hook.mjs client/src/wasm/game-cache-sw-wait.test.ts
// S1 (live run of f468f2c, 150 kB/s first visit): a Prepare clicked while the
// first service worker was still installing its critical shell raced `ready`
// against 30 s, got no worker, and ended "region done; runtime not warmed"
// after its region had downloaded for 19 more minutes. Checked here, through
// prepareGame itself:
//  - a Prepare whose worker activates 2 minutes after the click still warms
//    (one `warm`, the game's files named), and its status says what it waits
//    for meanwhile (`awaitingWorker`);
//  - a lost registration where nothing can register again ends the wait (the
//    Prepare finishes `partial`, it does not hang);
//  - no service worker in the browser, and no registration at all (the vite
//    dev server), still finish within seconds, `partial`;
//  - R2-1 (review of S1): a Retry that joins the first Prepare's wait says the
//    wait on its tile too;
//  - R2-2 / R2-3: a game page whose registration is deferred (its boot still
//    downloads) waits for that registration instead of giving up 3 s in, and
//    never registers on its own when another tab's registration is lost — the
//    deferral's busy rule decides, and a Prepare waiting for a worker is not
//    busy;
//  - R2-5: sw-client's once-per-page re-registration — a first loss
//    registers again (once) and the wait goes on to the warm-up; a second
//    loss is final.
// A fake clock (window timers + Date.now), a fake prefetch Worker, a fake
// service-worker container and a fake fetch; no BroadcastChannel.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// R2-5: sw-client's supported() reads vite's import.meta.env.PROD —
// undefined under node, so it threw and every sw-client path (the deferral,
// the re-registration) went untested. For this test only it reads a switch
// (`swClientProd`), off for the tests of a page where nothing registers.
registerHooks({
  load(url, context, next) {
    const r = next(url, context);
    return url.endsWith("/sw-client.ts") ? { ...r, source: String(r.source).replace("import.meta.env.PROD", "(globalThis.swClientProd === true)") } : r;
  },
});
const prod = (on: boolean) => { (globalThis as { swClientProd?: boolean }).swClientProd = on; };

type Timer = { at: number; fn: () => void };
let now = 0;
let nextId = 1;
const timers = new Map<number, Timer>();
const setTimer = (fn: () => void, ms: number): number => { const id = nextId++; timers.set(id, { at: now + (ms || 0), fn }); return id; };
const clearTimer = (id: number): void => { timers.delete(id); };
Object.assign(globalThis, {
  window: { setTimeout: setTimer, clearTimeout: clearTimer, addEventListener: (): void => {} },
  // qed64's prefetchRaw keeps its silence timer on the global clock.
  setTimeout: setTimer,
  clearTimeout: clearTimer,
});
Date.now = () => now;
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r)); };
/** Advance the fake clock a second at a time, letting promise chains run in
 * between (a patient wait re-arms its timer only after its await resolved). */
async function run(ms: number, each?: (t: number) => void): Promise<void> {
  for (const end = now + ms; now < end; ) {
    const step = Math.min(1000, end - now);
    const to = now + step;
    for (;;) {
      let due: [number, Timer] | null = null;
      for (const e of timers) if (e[1].at <= to && (due === null || e[1].at < due[1].at)) due = e;
      if (due === null) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await flush();
    }
    now = to;
    each?.(now);
    await flush();
  }
}

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  terminated = false;
  constructor(url: string) { void url; FakeWorker.all.push(this); }
  postMessage(): void {}
  terminate(): void { this.terminated = true; }
  say(data: unknown): void { if (!this.terminated) this.onmessage?.({ data }); }
}

const manifest = { buildId: "b1", leanVersion: "4", files: { "lean.wasm": { bytes: 2, sha256: "", chunks: [{ url: "/runtime/chunks/lean.wasm.aa.part-000", bytes: 1, sha256: "" }, { url: "/runtime/chunks/lean.wasm.aa.part-001", bytes: 1, sha256: "" }] } } };
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
Object.assign(globalThis, {
  Worker: FakeWorker,
  BroadcastChannel: undefined, // no other tab: the words go nowhere
  // The page's Location (SEC1: the same-origin checks resolve against it).
  location: new URL("https://l4g.test/"),
  document: { readyState: "complete", visibilityState: "visible", addEventListener: (): void => {}, querySelector: (): null => null },
  fetch: async (url: string) => {
    if (url === "/runtime/runtime-manifest.json") return json(manifest);
    if (url.endsWith("/game.json")) return json({ worldSize: { W: 2 } });
    if (url.endsWith("/inventory.json")) return json({ tactics: [{ name: "rfl" }] });
    return new Response("", { status: 404 });
  },
  // The reply port, as the page uses it.
  MessageChannel: class {
    port1: { onmessage: ((e: { data: unknown }) => void) | null } = { onmessage: null };
    port2 = { postMessage: (m: unknown) => queueMicrotask(() => this.port1.onmessage?.({ data: m })) };
  },
});

/** A first visit's service-worker container. `install()`: a registration
 * (another tab's) whose worker installs until `activate()`; `register()` (this
 * page's, sw-client) makes one too and is counted; `lose()` deletes the
 * registration (an install that failed — Chromium stops one at 300 s and a
 * first version takes its registration with it). The active worker answers
 * every `warm` complete (recorded) and a `warm-shell` complete. */
function serviceWorkers(installing = true) {
  const messages: Record<string, unknown>[] = [];
  const active = {
    state: "activated",
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    postMessage: (data: Record<string, unknown>, transfer: { postMessage(m: unknown): void }[]) => {
      if (data.type === "warm-shell") { transfer[0]!.postMessage({ type: "shell-filled", present: 1, total: 1, fetched: 0, failed: 0, complete: true, pruned: 0 }); return; }
      messages.push(data);
      const urls = data.urls as string[];
      transfer[0]!.postMessage({ cached: urls.length, pruned: 0, total: urls.length, partial: false, bytes: 0 });
    },
  };
  type Reg = { active: typeof active | null; installing: object | null; waiting: null; update(): Promise<void> };
  const fresh = (): Reg => ({ active: null, installing: { state: "installing" }, waiting: null, update: async () => {} });
  let reg: Reg | undefined = installing ? fresh() : undefined;
  let registers = 0;
  let resolveReady!: (r: unknown) => void;
  const container = {
    controller: null,
    ready: new Promise((r) => { resolveReady = r; }),
    getRegistration: async () => reg,
    register: async () => { registers++; reg ??= fresh(); return reg; },
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  };
  return {
    container, messages,
    registers: () => registers,
    install: () => { reg = fresh(); },
    activate: () => { reg!.installing = null; reg!.active = active; resolveReady(reg); },
    lose: () => { reg = undefined; },
  };
}
let nav: Record<string, unknown> = {};
Object.defineProperty(globalThis, "navigator", { configurable: true, get: () => nav });
const opfs = { getDirectory: async () => ({ getDirectoryHandle: async () => ({ removeEntry: async () => {} }) }) };

prod(false);
const gc = await import("./game-cache");
const swc = await import("./sw-client");
const { getDefaultStore } = await import("jotai");
const store = getDefaultStore();
const entryOf = (name: string) => ({ name, url: `/snapshots/${name}.x.snapz`, bytes: 1000, digest: "sha256:" + "ab".repeat(32) }) as Parameters<typeof gc.prepareGame>[0];
type Settled = Awaited<ReturnType<typeof gc.prepareGame>>;
const statusOf = (name: string) => store.get(gc.prepareStatusesAtom)[name];

let failures = 0;
async function test(name: string, body: () => Promise<void>): Promise<void> {
  timers.clear(); FakeWorker.all.length = 0;
  try { await body(); console.log(`ok - ${name}`); } catch (e) { failures++; console.log(`not ok - ${name}\n  ${String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n  ")}`); }
}

// ---- a page where sw-client registers nothing (swClientProd off) ----

await test("S1: a Prepare whose service worker activates 2 minutes after the click still warms the runtime and the game's files; the tile hears what it waits for", async () => {
  const sw = serviceWorkers();
  nav = { onLine: true, storage: opfs, serviceWorker: sw.container };
  const seen: (boolean | undefined)[] = [];
  const unsub = store.sub(gc.prepareStatusesAtom, () => { seen.push(statusOf("nng4")?.awaitingWorker); });
  let settled: Settled | null = null;
  void gc.prepareGame(entryOf("nng4"), { gameId: "g/x/NNG", langs: [] }).then((st) => { settled = st; });
  await flush();
  const w = FakeWorker.all[0]!;
  // The region streams at 150 kB/s: a progress report every 30 s.
  await run(119_000, (t) => { if (t % 30_000 === 0) w.say({ status: "progress", bytes: t / 1000, total: 1000 }); });
  assert.equal(sw.messages.length, 0, "no worker yet: nothing posted");
  assert.equal(statusOf("nng4")?.awaitingWorker, true, "the tile says the Prepare waits for the offline cache");
  assert.equal(statusOf("nng4")?.phase, "running");
  sw.activate(); // +2 min: the install finished
  await run(1000);
  assert.equal(sw.messages.length, 1, "warmed once the worker is active");
  assert.equal(sw.messages[0]!.type, "warm");
  const urls = sw.messages[0]!.urls as string[];
  assert.ok(urls.includes("/data/g/x/NNG/game.json") && urls.includes("/data/g/x/NNG/level__W__2.json") && urls.includes("/runtime/chunks/lean.wasm.aa.part-001"), urls.join(" "));
  assert.equal(statusOf("nng4")?.awaitingWorker, false, "no longer waiting");
  assert.equal(settled, null, "the region still runs");
  w.say({ status: "done" });
  await run(1000);
  unsub();
  assert.ok(settled, "the Prepare settled");
  const st = settled as unknown as Settled;
  assert.equal(st.phase, "done");
  assert.ok(st.runtime && !st.runtime.partial, "runtime warmed — not \"runtime not warmed\"");
  assert.ok(seen.includes(true) && seen[seen.length - 1] === false, `awaitingWorker went true, then false (${seen.join(",")})`);
});

await test("S1: a lost registration where nothing can register again ends the wait — the Prepare finishes partial, no hang", async () => {
  const sw = serviceWorkers();
  nav = { onLine: true, storage: opfs, serviceWorker: sw.container };
  let settled: Settled | null = null;
  void gc.prepareGame(entryOf("logic"), { gameId: "g/x/Logic", langs: [] }).then((st) => { settled = st; });
  await flush();
  const w = FakeWorker.all[0]!;
  await run(60_000);
  assert.equal(statusOf("logic")?.awaitingWorker, true);
  w.say({ status: "done" });
  await run(1000);
  assert.equal(settled, null, "the region is done; the warm-up still waits for the installing worker");
  assert.equal(statusOf("logic")?.phase, "warming");
  assert.equal(gc.preparesDownloading(), false, "R2-2: a Prepare waiting for a worker downloads nothing");
  sw.lose();
  await run(20_000);
  assert.ok(settled, "the Prepare settled");
  const st = settled as unknown as Settled;
  assert.equal(st.phase, "done");
  assert.equal(st.runtime, null, "honest: not warmed (the tile reads partial)");
  assert.equal(st.awaitingWorker, false);
  assert.equal(sw.messages.length, 0);
});

await test("S1: no service worker in this browser, or no registration at all (the dev server) — the Prepare still finishes within seconds, partial", async () => {
  for (const [name, serviceWorker] of [["robo", undefined], ["ntg", { controller: null, ready: new Promise(() => {}), getRegistration: async () => undefined }]] as const) {
    nav = serviceWorker ? { onLine: true, storage: opfs, serviceWorker } : { onLine: true, storage: opfs };
    let settled: Settled | null = null;
    void gc.prepareGame(entryOf(name), { gameId: `g/x/${name}`, langs: [] }).then((st) => { settled = st; });
    await flush();
    FakeWorker.all[FakeWorker.all.length - 1]!.say({ status: "already-cached" });
    await run(5000);
    assert.ok(settled, `${name}: settled within 5 s`);
    const st = settled as unknown as Settled;
    assert.deepEqual([st.phase, st.runtime, st.awaitingWorker], ["done", null, undefined], name);
  }
});

await test("R2-1: a Retry after the region failed joins the first Prepare's wait — its tile says the wait while the region runs and after it, and one `warm` goes out at activation", async () => {
  const sw = serviceWorkers();
  nav = { onLine: true, storage: opfs, serviceWorker: sw.container };
  void gc.prepareGame(entryOf("hhg"), { gameId: "g/x/HHG", langs: [] });
  await flush();
  await run(30_000);
  assert.equal(statusOf("hhg")?.awaitingWorker, true);
  FakeWorker.all[0]!.say({ status: "error", error: "the network connection was lost" }); // a dropped link
  await run(1000);
  assert.equal(statusOf("hhg")?.phase, "failed");
  assert.equal(gc.prepareRunning("hhg"), false, "the failed Prepare is over; its warm-up waits on");
  let settled: Settled | null = null;
  void gc.prepareGame(entryOf("hhg"), { gameId: "g/x/HHG", langs: [] }).then((st) => { settled = st; }); // Retry
  await flush();
  assert.deepEqual([statusOf("hhg")?.phase, statusOf("hhg")?.awaitingWorker], ["running", true], "the Retry's tile: the S1 note at once");
  const w = FakeWorker.all[1]!;
  await run(60_000);
  w.say({ status: "done" });
  await run(1000);
  assert.deepEqual([statusOf("hhg")?.phase, statusOf("hhg")?.awaitingWorker], ["warming", true], "\"waiting for the browser to finish installing…\", not \"caching the checker\"");
  assert.equal(sw.messages.length, 0);
  sw.activate();
  await run(1000);
  assert.equal(sw.messages.length, 1, "the Retry joined the first warm-up: one `warm`");
  assert.ok(settled, "the Retry settled");
  const st = settled as unknown as Settled;
  assert.equal(st.phase, "done");
  assert.ok(st.runtime && !st.runtime.partial);
  assert.equal(st.awaitingWorker, false);
});

// ---- a production page (swClientProd on): sw-client's deferral and re-registration ----

await test("R2-2 / R2-3: a game page whose registration is deferred — the Prepare waits for it (no 3 s give-up), never registers itself when another tab's registration is lost, and warms once the deferral registers", async () => {
  prod(true);
  const sw = serviceWorkers(false); // nothing registered for this origin yet
  nav = { onLine: true, storage: opfs, serviceWorker: sw.container };
  let bootBusy = true; // the game's boot still streams the runtime and its snapshot
  swc.scheduleServiceWorkerRegistration({ deferForBoot: true, busy: () => bootBusy || gc.preparesDownloading() }); // index.tsx at load
  // In-app to the landing page; Prepare another game.
  let settled: Settled | null = null;
  void gc.prepareGame(entryOf("rag"), { gameId: "g/x/RAG", langs: [] }).then((st) => { settled = st; });
  await flush();
  const w = FakeWorker.all[0]!;
  await run(10_000);
  assert.equal(settled, null, "R2-2: no give-up 3 s in");
  assert.equal(statusOf("rag")?.awaitingWorker, true);
  await run(20_000);
  sw.install(); // +30 s: another tab registers; its worker installs
  await run(70_000);
  sw.lose(); // +100 s: that install fails; its registration is gone
  await run(50_000);
  w.say({ status: "done" }); // +150 s: the region is in
  await run(50_000);
  assert.equal(sw.registers(), 0, "R2-3: never registered while the boot downloads");
  assert.deepEqual([statusOf("rag")?.phase, statusOf("rag")?.awaitingWorker], ["warming", true]);
  assert.equal(gc.preparesDownloading(), false, "a Prepare waiting for a worker is not busy — the deferral must not wait for it");
  bootBusy = false; // +200 s: the boot halted (never served)
  await run(10_000);
  assert.equal(sw.registers(), 1, "the deferral's fallback registered once nothing was busy");
  assert.equal(settled, null);
  await run(50_000);
  sw.activate(); // +260 s
  await Promise.resolve(); // the reactions to `ready` only — the shell fill, woken by it too, asks busy() hops later
  assert.equal(gc.preparesDownloading(), true, "busy again from `ready` itself: the shell fill waits for the warm-up");
  await run(1000);
  assert.equal(sw.messages.length, 1, "warmed once");
  assert.ok(settled, "the Prepare settled");
  const st = settled as unknown as Settled;
  assert.ok(st.runtime && !st.runtime.partial, "runtime warmed");
  assert.equal(st.awaitingWorker, false);
  assert.equal(sw.registers(), 1);
});

await test("R2-5: a first lost registration of this page is registered again once — the wait goes on, and the warm-up runs at activation", async () => {
  prod(true);
  const sw = serviceWorkers(); // this page's registration (the previous test registered it): a new install
  nav = { onLine: true, storage: opfs, serviceWorker: sw.container };
  let settled: Settled | null = null;
  void gc.prepareGame(entryOf("ttg"), { gameId: "g/x/TTG", langs: [] }).then((st) => { settled = st; });
  await flush();
  FakeWorker.all[0]!.say({ status: "already-cached" });
  await run(30_000);
  sw.lose(); // Chromium stopped the install at 300 s
  await run(20_000);
  assert.equal(sw.registers(), 1, "registered again, once");
  assert.equal(settled, null, "still waiting — for the new registration's install");
  assert.equal(statusOf("ttg")?.awaitingWorker, true);
  await run(60_000);
  sw.activate();
  await run(1000);
  assert.ok(settled, "the Prepare settled");
  const st = settled as unknown as Settled;
  assert.ok(st.runtime && !st.runtime.partial, "runtime warmed");
  assert.equal(sw.messages.length, 1);
  assert.equal(sw.registers(), 1);
});

await test("R2-5: a second loss is final — the Prepare finishes partial, no hang, nothing registered again", async () => {
  prod(true);
  const sw = serviceWorkers();
  nav = { onLine: true, storage: opfs, serviceWorker: sw.container };
  let settled: Settled | null = null;
  void gc.prepareGame(entryOf("lag"), { gameId: "g/x/LAG", langs: [] }).then((st) => { settled = st; });
  await flush();
  FakeWorker.all[0]!.say({ status: "already-cached" });
  await run(30_000);
  sw.lose();
  await run(30_000);
  assert.ok(settled, "the Prepare settled");
  const st = settled as unknown as Settled;
  assert.deepEqual([st.phase, st.runtime, st.awaitingWorker], ["done", null, false]);
  assert.equal(sw.registers(), 0, "the page's one re-registration was used");
  assert.equal(sw.messages.length, 0);
});

if (failures) { console.log(`game-cache-sw-wait: ${failures} FAILED`); process.exit(1); }
console.log("game-cache-sw-wait: ALL TESTS PASS");
