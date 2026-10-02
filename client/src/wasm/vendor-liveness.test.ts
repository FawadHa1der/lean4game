// Run: node --import ./client/src/wasm/ts-resolve-hook.mjs client/src/wasm/vendor-liveness.test.ts
// HARDENING #52 as VENDORED (client/src/wasm/vendor/qed64 @ 3b42714): a port
// of qed64's tests/unit/liveness.test.ts (vitest) to node:assert, loading the
// REAL vendored lean.worker.js in vm sandboxes. It pins what the game relies
// on: an idle session is never probed; a frozen Lean side dies "wedged" within
// probeAfter + wedgeAfter + grace (≤ 30 s); a busy one that answers is never
// declared dead; a FileWorker exit (proxied `_proc_exit` / `exitOnMainThread`,
// or an ExitStatus through the mailbox kick) is a death "exit" with its code;
// rescues are counted only for a confirmed lost wakeup.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

type Msg = { jsonrpc?: string; id?: number | string; method?: string; params?: unknown; error?: unknown; result?: unknown };
type Posted = { type?: string; kind?: string; reason?: string; code?: number | null; message?: string };

const here = path.dirname(fileURLToPath(import.meta.url));
const workers = path.join(here, "vendor/qed64/public/workers");

function loadWorker() {
  const posted: Posted[] = [];
  const sandbox: Record<string, any> = {
    crypto, performance, Blob, URL, WebAssembly, SharedArrayBuffer, Atomics, TextEncoder, TextDecoder, BigInt, console,
    setTimeout, clearTimeout, clearInterval,
    setInterval: (fn: () => void, ms: number) => { const t = setInterval(fn, ms); t.unref(); return t; },
    fetch: () => Promise.reject(new Error("no network in unit tests")),
  };
  sandbox.self = sandbox;
  sandbox.postMessage = (m: unknown) => posted.push(m as Posted);
  sandbox.addEventListener = () => {};
  sandbox.crossOriginIsolated = true;
  sandbox.importScripts = (name: string) => vm.runInContext(readFileSync(path.join(workers, name), "utf8"), sandbox, { filename: name });
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(workers, "lean.worker.js"), "utf8"), sandbox, { filename: "lean.worker.js" });
  const x = sandbox.__qed64TestExports;
  return { sandbox, posted, hooks: x.liveness, resident: x.resident };
}
const deaths = (posted: Posted[]) => posted.filter((m) => m.kind === "died");
const goResident = (resident: any) => resident.attachRing({ buffer: new SharedArrayBuffer(1 << 16) }, 0);

const { hooks } = loadWorker();
const cfg = hooks.LIVENESS;
function run(L: any, from: number, to: number, phase: string, docOpen = true) {
  const out: { at: number; action: any }[] = [];
  for (let t = from; t <= to; t += cfg.tickMs) {
    const a = hooks.livenessTick(L, t, phase, docOpen);
    if (a) out.push({ at: t, action: a });
  }
  return out;
}
let n = 0;
const it = (name: string, fn: () => void) => { fn(); n += 1; console.log(`ok - ${name}`); };

it("timing contract: a verdict within 30 s of silence, never inside a normal quiet stretch", () => {
  assert.equal(cfg.tickMs, 1000);
  assert.ok(cfg.probeAfterMs + cfg.wedgeAfterMs + cfg.graceMs <= 30_000);
  assert.ok(cfg.probeAfterMs >= 5000);
});
it("an idle/ready session is never probed (30 min), nor 'starting' before the didOpen", () => {
  const L = hooks.createLiveness(0);
  assert.deepEqual(run(L, 0, 30 * 60_000, "ready"), []);
  assert.deepEqual(run(L, 0, 60_000, "headerRefused"), []);
  assert.deepEqual(run(L, 0, 120_000, "starting", false), []);
  assert.deepEqual({ ...L.counters }, { probes: 0, answered: 0, stalls: 0, resumed: 0, rescues: 0 });
});
it("a silent elaboration is probed once after probeAfterMs: private id, unknown method, with params", () => {
  const L = hooks.createLiveness(0);
  const acts = run(L, 0, cfg.probeAfterMs, "elaborating");
  assert.equal(acts.length, 1);
  const msg: Msg = acts[0].action.msg;
  assert.ok(String(msg.id).startsWith(hooks.LIVENESS_PROBE_PREFIX));
  assert.equal(msg.method, "$/qed64/liveness");
  assert.deepEqual({ ...(msg.params as object) }, {});
});
it("a non-terminating elaboration that answers every probe is never declared dead (10 min)", () => {
  const L = hooks.createLiveness(0);
  let probes = 0;
  for (let now = 0; now < 10 * 60_000; now += cfg.tickMs) {
    const a = hooks.livenessTick(L, now, "elaborating", true);
    if (a?.kind === "probe") {
      probes += 1;
      assert.deepEqual({ ...hooks.livenessServerFrame(L, { jsonrpc: "2.0", id: a.msg.id, error: { code: -32601, message: "unknown" } }, now + 50) }, { probe: true, resumedAfterMs: null });
    }
    assert.ok(!(a?.kind === "stall" || a?.kind === "dead"));
  }
  assert.ok(probes > 50);
  assert.equal(L.counters.answered, probes);
  assert.equal(L.counters.stalls, 0);
});
it("a frozen Lean side: probe → stall at probeAfter+wedgeAfter → dead at +grace", () => {
  const L = hooks.createLiveness(0);
  const end = cfg.probeAfterMs + cfg.wedgeAfterMs + cfg.graceMs;
  const acts = run(L, 0, end, "elaborating");
  assert.deepEqual(acts.map((x) => x.action.kind), ["probe", "stall", "dead"]);
  assert.equal(acts[1].at, cfg.probeAfterMs + cfg.wedgeAfterMs);
  assert.equal(acts[2].at, end);
});
it("output resuming in the grace window ends the stall", () => {
  const L = hooks.createLiveness(0);
  const acts = run(L, 0, cfg.probeAfterMs + cfg.wedgeAfterMs, "elaborating");
  assert.deepEqual(acts.map((x) => x.action.kind), ["probe", "stall"]);
  assert.deepEqual({ ...hooks.livenessServerFrame(L, { jsonrpc: "2.0", method: "$/lean/fileProgress", params: { processing: [] } }, acts[1].at + 1500) }, { probe: false, resumedAfterMs: 1500 });
  assert.equal(L.stalledAt, 0);
});
it("rescues: only a PENDING word that stays PENDING with no delivery, on time, is counted", () => {
  const PENDING = 2, NONE = 0;
  const L = hooks.createLiveness(0);
  assert.equal(hooks.mailboxTick(L, NONE, 3, 0), "kick");
  assert.equal(hooks.mailboxTick(L, PENDING, 3, 1000), "watch");
  assert.equal(hooks.mailboxConfirm(L, PENDING, 3, 1000 + cfg.confirmMs + 5), "rescue");
  hooks.mailboxTick(L, PENDING, 3, 2000);
  assert.equal(hooks.mailboxConfirm(L, NONE, 4, 2000 + cfg.confirmMs), "delivered");
  assert.equal(L.counters.rescues, 1);
});
it("a FileWorker exit through the proxied-function table is died 'exit' with its code (resident only)", () => {
  for (const index of [0, 1]) {
    const { sandbox, hooks: h, posted, resident } = loadWorker();
    const procExit = () => { throw Object.assign(new Error("exit"), { name: "ExitStatus" }); };
    const exitOnMainThread = () => { throw Object.assign(new Error("exit"), { name: "ExitStatus" }); };
    sandbox._proc_exit = procExit;
    sandbox.exitOnMainThread = exitOnMainThread;
    const table: any[] = [procExit, exitOnMainThread, () => 0];
    sandbox.proxiedFunctionTable = table;
    assert.equal(h.instrumentRuntimeMailbox().exitHooked, true);
    assert.throws(() => table[index](5));
    assert.deepEqual(deaths(posted), []);
    goResident(resident);
    assert.throws(() => table[index](5));
    const d = deaths(posted);
    assert.deepEqual(d.map((x) => [x.reason, x.code]), [["exit", 5]]);
    assert.equal(d[0].message, "lean --worker exited with code 5"); // the text death-kind.ts exitCodeOf parses
  }
});
it("an ExitStatus thrown through the mailbox kick is died 'exit'; an unwind is benign; anything else is a crash", () => {
  {
    const { sandbox, hooks: h, posted, resident } = loadWorker();
    goResident(resident);
    sandbox.__emscripten_check_mailbox = () => { throw Object.assign(new Error("exit"), { name: "ExitStatus", status: 3 }); };
    h.kickMailbox();
    assert.deepEqual(deaths(posted).map((d) => [d.reason, d.code]), [["exit", 3]]);
  }
  {
    const { sandbox, hooks: h, posted } = loadWorker();
    sandbox.__emscripten_check_mailbox = () => { throw "unwind"; };
    assert.equal(h.kickMailbox().kicked, true);
    assert.deepEqual(deaths(posted), []);
  }
  {
    const { sandbox, hooks: h, posted, resident } = loadWorker();
    goResident(resident);
    sandbox.__emscripten_check_mailbox = () => { throw new Error("boom"); };
    h.kickMailbox();
    assert.deepEqual(deaths(posted).map((d) => d.reason), ["crash"]);
  }
});
it("boot instrumentation: message-mode mailbox, counted notifications and served proxied calls", () => {
  const { sandbox, hooks: h } = loadWorker();
  const table: any[] = [() => 0];
  sandbox.proxiedFunctionTable = table;
  sandbox.waitAsyncPolyfilled = false;
  let queued = 0;
  sandbox.checkMailbox = () => { while (queued > 0) { queued -= 1; table[0](); } };
  const m = h.instrumentRuntimeMailbox();
  assert.equal(m.mode, "message");
  assert.equal(sandbox.waitAsyncPolyfilled, true);
  queued = 1;
  sandbox.checkMailbox();
  sandbox.checkMailbox();
  assert.equal(m.notified, 2);
  assert.equal(m.served, 1);
});
it("locates the mailbox word through the glue's own waiting_async offset (204 on runtime wasm64-d77d34b97592d014)", () => {
  const { sandbox, hooks: h } = loadWorker();
  const buf = new SharedArrayBuffer(1 << 16);
  new BigInt64Array(buf, 4096 + 192, 1)[0] = BigInt(8192);
  new BigInt64Array(buf, 8192 + 48, 1)[0] = BigInt(4096);
  new Int32Array(buf, 8192, 1)[0] = 2;
  sandbox.wasmMemory = { buffer: buf };
  sandbox._pthread_self = () => BigInt(4096);
  sandbox.__emscripten_thread_mailbox_await = new Function("pthread_ptr", "var waitingAsync=pthread_ptr+204;return waitingAsync");
  assert.equal(h.locateRuntimeMailbox(), 8192);
});
console.log(`vendor-liveness: ${n}/${n} passed`);
