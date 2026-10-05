// Run: node --import ./client/src/wasm/ts-resolve-hook.mjs client/src/wasm/boot-labels.test.ts
// The boot banner's words (boot-labels.ts stageLabel) for the calls qed64
// REALLY makes — its snapshot load (loadSnapshotByName: the raw prefetch,
// the wait for another tab's writer under the region's Web Lock, the load,
// a failure) and its session's worker progress (ResidentSession) — driven
// here over a fake prefetch Worker, a fake OPFS and a fake Web Lock manager.
// The banner never names the snapshot (a dotted name used to leak through
// the label rewrite) and never carries qed64's own size notes; every other
// step keeps qed64's words, read mid-sentence.
import assert from "node:assert/strict";

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  terminated = false;
  url: string;
  constructor(url: string) { this.url = url; FakeWorker.all.push(this); }
  private readonly listeners: ((e: { data: unknown }) => void)[] = [];
  postMessage(): void {}
  addEventListener(type: string, fn: (e: { data: unknown }) => void): void { if (type === "message") this.listeners.push(fn); }
  terminate(): void { this.terminated = true; }
  say(data: unknown): void {
    if (this.terminated) return;
    this.onmessage?.({ data });
    for (const fn of this.listeners) fn({ data });
  }
}
/** OPFS: the region file exists once `cached` holds its size. */
const cached = new Map<string, number>();
const dir = {
  getFileHandle: async (name: string) => {
    if (!cached.has(name)) throw new DOMException("missing", "NotFoundError");
    return { getFile: async () => ({ size: cached.get(name)! }) };
  },
  removeEntry: async () => {},
};
/** Web Locks: one holder per name; a waiter is granted when it is released. */
const held = new Map<string, () => void>();
const waiters = new Map<string, (() => void)[]>();
const locks = {
  request: async (name: string, opts: unknown, cb?: (lock: unknown) => Promise<unknown>) => {
    const fn = (typeof opts === "function" ? opts : cb) as (lock: unknown) => Promise<unknown>;
    const o = (typeof opts === "object" ? opts : {}) as { ifAvailable?: boolean; signal?: AbortSignal };
    if (held.has(name)) {
      if (o.ifAvailable) return fn(null);
      await new Promise<void>((resolve) => waiters.set(name, [...(waiters.get(name) ?? []), resolve]));
    }
    held.set(name, () => {});
    try { return await fn({ name }); } finally { held.delete(name); waiters.get(name)?.shift()?.(); }
  },
};
/** Another tab writes `name`'s region: it holds the lock until `release()`. */
function anotherTabHolds(name: string): () => void {
  held.set(name, () => {});
  return () => { held.delete(name); waiters.get(name)?.shift()?.(); };
}
Object.assign(globalThis, { Worker: FakeWorker, location: new URL("https://l4g.test/") });
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => dir }) }, locks },
});

const { ResidentSession, loadSnapshotByName, snapshotCacheKey } = await import("qed64/embed");
type Info = import("qed64/embed").ProgressInfo;
const { stageLabel } = await import("./boot-labels");
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r)); };

/** A StatusSink that records every call with the banner's words for it. */
function recorder() {
  const calls: { kind: string; raw: string; info?: Info; label: string }[] = [];
  const note = (kind: string) => (raw: string, info?: Info) => { calls.push({ kind, raw, info, label: stageLabel(raw, info) }); };
  return { calls, ui: { busy: note("busy"), progress: note("progress"), idle: note("idle") } };
}
const entryOf = (name: string) => ({ name, url: `/snapshots/${name}.abababababababab.snapz`, bytes: 569_269_949, transfer: 154_373_030, digest: "sha256:" + "ab".repeat(32), imports: ["Game"], runtime: "wasm64-d77d34b97592d014" });
const artifactsOf = (entry: ReturnType<typeof entryOf>) => ({
  runtime: { buildId: "wasm64-d77d34b97592d014", leanVersion: "4", files: {} } as never,
  index: { schema: "qed64.profile-index/v1", profiles: [] } as never,
  installed: new Map(),
  snapshots: { schema: "qed64.snapshot-index/v1", snapshots: [entry] },
});
const sessionOf = (load: () => Promise<{ success: boolean; elapsedMs: number }>) =>
  ({ session: { loadSnapshot: load } as never, loadedSnapshots: new Set<string>() });

let failures = 0;
async function test(name: string, body: () => Promise<void>): Promise<void> {
  FakeWorker.all.length = 0; cached.clear(); held.clear(); waiters.clear();
  try { await body(); console.log(`ok - ${name}`); } catch (e) { failures++; console.log(`not ok - ${name}\n  ${String((e as Error)?.stack ?? e).split("\n").slice(0, 4).join("\n  ")}`); }
}

await test("a first visit: the prefetch's bytes, then the load — \"the game environment\", never its name or qed64's size notes", async () => {
  for (const name of ["nng4", "nng4.dev", "Robo_2"]) {
    FakeWorker.all.length = 0;
    const entry = entryOf(name);
    const { calls, ui } = recorder();
    const done = loadSnapshotByName(artifactsOf(entry), sessionOf(async () => ({ success: true, elapsedMs: 1 })), name, ui);
    await flush();
    const w = FakeWorker.all[0]!;
    assert.equal(w.url, "/workers/snapshot-prefetch.worker.js");
    w.say({ status: "progress", bytes: 100_000_000, total: entry.bytes });
    w.say({ status: "done", bytes: entry.bytes });
    assert.equal(await done, true);
    const progress = calls.find((c) => c.kind === "progress")!;
    assert.match(progress.raw, new RegExp(`preparing the ${name.replace(".", "\\.")} environment \\(0\\.5 GiB`), "qed64's own words name the snapshot");
    assert.equal(progress.label, "preparing the game environment");
    assert.deepEqual([progress.info?.loaded, progress.info?.total], [100_000_000, entry.bytes]);
    const load = calls.find((c) => c.kind === "busy")!;
    assert.match(load.raw, /unpacked — cached in your browser/);
    assert.equal(load.label, "loading the game environment");
    for (const c of calls) assert.ok(!c.label.includes(name) && !/GiB|MiB/.test(c.label), `${name}: "${c.label}"`);
  }
});

await test("another tab writes the region: the wait under its lock says so, then the load", async () => {
  const entry = entryOf("rag");
  const key = snapshotCacheKey(entry);
  const release = anotherTabHolds(`qed64-raw:${key}`);
  const { calls, ui } = recorder();
  const done = loadSnapshotByName(artifactsOf(entry), sessionOf(async () => ({ success: true, elapsedMs: 1 })), "rag", ui);
  await flush();
  assert.equal(FakeWorker.all.length, 0, "no second writer");
  assert.deepEqual(calls.map((c) => c.label), ["waiting for another tab to finish preparing the game environment"]);
  cached.set(`${key}.raw`, entry.bytes); // the other tab committed it
  release();
  assert.equal(await done, true);
  assert.equal(FakeWorker.all.length, 0, "found done: nothing downloaded here");
  assert.deepEqual(calls.map((c) => c.label), ["waiting for another tab to finish preparing the game environment", "loading the game environment"]);
});

await test("a cached region loads at once; a failed load says \"game snapshot failed\" with the cause's words", async () => {
  const entry = entryOf("ntg");
  cached.set(`${snapshotCacheKey(entry)}.raw`, entry.bytes);
  const ok = recorder();
  assert.equal(await loadSnapshotByName(artifactsOf(entry), sessionOf(async () => ({ success: true, elapsedMs: 1 })), "ntg", ok.ui), true);
  assert.deepEqual(ok.calls.map((c) => c.label), ["loading the game environment"]);
  const bad = recorder();
  const err = Object.assign(new Error("Failed to fetch"), { code: "SNAPSHOT_FAILED" });
  assert.equal(await loadSnapshotByName(artifactsOf(entry), sessionOf(async () => { throw err; }), "ntg", bad.ui), false);
  const failed = bad.calls[bad.calls.length - 1]!;
  assert.equal(failed.raw, "ntg snapshot failed: Failed to fetch");
  assert.equal(failed.info?.error?.kind, "network");
  assert.equal(failed.label, "game snapshot failed: Failed to fetch");
});

await test("the session's worker progress: the runtime's own steps keep their words (mid-sentence); module names are one step", async () => {
  const { calls, ui } = recorder();
  const rs = new ResidentSession({ artifacts: artifactsOf(entryOf("nng4")) as never, ui, headerText: "" });
  const worker = FakeWorker.all.find((w) => w.url === "/workers/lean.worker.js")!;
  const say = (phase: string, label: string, loaded?: number, total?: number) => worker.say({ protocol: 1, type: "event", kind: "progress", phase, label, loaded, total, unit: loaded === undefined ? "" : "bytes" });
  say("runtime", "Verifying lean.js", 3_000_000, 154_000_000);
  say("runtime", "Starting the Emscripten runtime");
  say("memory", "Shared Memory64 heap: 1024 MiB → 3 GiB max");
  say("filesystem", "Mounting verified library packs");
  say("initialize", "Initializing the Lean runtime");
  say("snapshot-cache", "Loading environment snapshot", 1, 2);
  say("snapshot-load", "Loading the environment into Lean");
  say("snapshot-init", "Mathlib.Tactic.Attr.Register", 37, 2568);
  assert.deepEqual(calls.map((c) => c.label), [
    "verifying lean.js",
    "starting the Emscripten runtime",
    "shared Memory64 heap: 1024 MiB → 3 GiB max",
    "mounting verified library packs",
    "initializing the Lean runtime",
    "loading the game environment",
    "loading the game environment",
    "loading the game's modules",
  ]);
  assert.equal(calls[0]!.info?.subject, "lean.js");
  rs.terminate();
});

await test("labels without structure are the game's own (and qed64's plain ones read mid-sentence)", async () => {
  assert.equal(stageLabel("checking this game's environment"), "checking this game's environment");
  assert.equal(stageLabel("fetching manifests", { stage: "manifests" }), "fetching manifests");
  assert.equal(stageLabel("starting Lean", { stage: "runtime" }), "starting Lean");
  assert.equal(stageLabel("preparing 81 session files", { stage: "files", step: "write" }), "preparing 81 session files");
  assert.equal(stageLabel("Lean ready"), "Lean ready");
  assert.equal(stageLabel("Mathlib needs no rewrite"), "Mathlib needs no rewrite");
});

if (failures) { console.log(`boot-labels: ${failures} FAILED`); process.exit(1); }
console.log("boot-labels: ALL TESTS PASS");
