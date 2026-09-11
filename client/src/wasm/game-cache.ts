/**
 * The game environment cache as the page manages it: OPFS raw regions
 * (`qed64-snapshots/<cacheKey>.raw`, what the Lean worker sync-reads into
 * its heap), the service worker's runtime cache, and "Prepare" — filling
 * both from the landing page without booting Lean.
 *
 * Shared by the landing page (Prepare / Remove download / the storage
 * meter) and the boot (game-boot.ts: await an in-flight prepare, sweep stale
 * regions, warm the runtime cache once the checker is up). Only page-side
 * composition of vendored pieces lives here: the prefetch worker
 * (public/workers/snapshot-prefetch.worker.js) and the service worker's
 * `warm` message (client/src/sw) are the contracts.
 */
import { atom, getDefaultStore } from "jotai";
import { snapshotCacheKey, type SnapshotEntry, type SnapshotIndex } from "./vendor/qed64/src/runtime/snapshots";
import type { RuntimeManifest } from "./vendor/qed64/src/runtime/client";
import { resolveRuntimeManifest } from "./games-api";

const SNAPSHOT_DIR = "qed64-snapshots";
const PREFETCH_WORKER = "/workers/snapshot-prefetch.worker.js";

/** The OPFS snapshot directory, or null where OPFS is unavailable (Firefox
 * private mode throws on getDirectory) or the directory does not exist yet. */
async function snapshotsDir(create = false): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(SNAPSHOT_DIR, { create });
  } catch {
    return null;
  }
}

/** The raw-region file name of an index entry (`<cacheKey>.raw`). */
export const rawFileName = (entry: SnapshotEntry): string => `${snapshotCacheKey(entry)}.raw`;

/** "Remove download": delete this game's inflated region — that one file,
 * nothing else (the Lean worker's compressed entry, if any, the packs and
 * the runtime cache are untouched). True when a file was removed. */
export async function removeRawSnapshot(entry: SnapshotEntry): Promise<boolean> {
  const dir = await snapshotsDir();
  if (!dir) return false;
  try {
    await dir.removeEntry(rawFileName(entry));
    return true;
  } catch {
    return false; // absent, or OPFS refused — the tile re-probes either way
  }
}

/** Sweep stale raw regions: `qed64-snapshots/<name>.<key>.snapz.raw` files
 * of a name the served index knows whose key is not that name's live key (a
 * rebake changed the digest; the old 1.4 GB region would otherwise sit in
 * every returning user's OPFS for ever), and the `.partial` staging files of
 * such stale keys (a reload, a crash or the prefetch bail strands one; the
 * worker only ever discards the partial of the key it is asked for, so
 * nothing else would). The match is the exact key shape snapshotCacheKey
 * produces after the listed name (`.<16 hex>` or `.<bytes>.<transfer>`), so
 * an unlisted name that merely starts with a listed one ("nng4.dev" next to
 * "nng4") is left alone, as is the live key's own partial (an in-flight
 * prepare or the session's own prefetch holds it) and everything outside
 * this directory. Never call it against an unpromoted (`?snapshots=<dir>`)
 * index: its keys differ from the served ones by design (game-boot skips
 * the sweep then). Returns the removed file names. */
export async function sweepStaleSnapshots(index: SnapshotIndex): Promise<string[]> {
  const dir = await snapshotsDir();
  if (!dir) return [];
  const live = new Set(index.snapshots.map(rawFileName));
  // The same sanitisation snapshotCacheKey applies to a name.
  const listed = index.snapshots.map((e) => e.name.replace(/[^A-Za-z0-9._-]/g, "_"));
  const KEY_TAIL = /^(?:[0-9a-f]{16}|\d+\.\d+)\.snapz\.raw$/;
  const ofListedName = (base: string) => listed.some((n) => base.startsWith(`${n}.`) && KEY_TAIL.test(base.slice(n.length + 1)));
  const removed: string[] = [];
  // FileSystemDirectoryHandle's async iterator is not in this tsconfig's lib.
  const names = (dir as unknown as { keys(): AsyncIterable<string> }).keys();
  for await (const name of names) {
    const base = name.endsWith(".partial") ? name.slice(0, -".partial".length) : name;
    if (!base.endsWith(".snapz.raw") || live.has(base) || !ofListedName(base)) continue;
    try {
      await dir.removeEntry(name);
      removed.push(name);
    } catch (e) {
      console.warn(`[game-cache] could not remove stale region ${name}:`, e);
    }
  }
  return removed;
}

/** What the prefetch worker reports on exit. */
export type PrefetchResult = "done" | "already-cached" | "error" | "unavailable" | "busy";

/** Fill the raw region cache for one snapshot in the disposable prefetch
 * worker (download + gunzip on a heap that dies on completion — a Lean
 * worker doing this itself stays ~4.6 GB heavier for its whole life),
 * exactly as the vendored boot does before it loads a snapshot. Resolves
 * with the worker's terminal status; `busy` means another writer (the Lean
 * worker of a session in this page) holds the file. */
export function prefetchRawSnapshot(entry: SnapshotEntry, onProgress?: (bytes: number, total: number) => void): Promise<{ result: PrefetchResult; error?: string }> {
  return new Promise((resolve) => {
    const w = new Worker(PREFETCH_WORKER);
    const finish = (result: PrefetchResult, error?: string) => { window.clearTimeout(bail); w.terminate(); resolve({ result, error }); };
    const bail = window.setTimeout(() => {
      finish("error", "timed out after 15 minutes");
      // terminate() skips the worker's own cleanup: the partial (up to the
      // region's full size) would sit in OPFS until a retry of this key.
      void snapshotsDir().then((d) => d?.removeEntry(`${rawFileName(entry)}.partial`)).catch(() => {});
    }, 15 * 60 * 1000);
    w.postMessage({ url: entry.url, cacheKey: snapshotCacheKey(entry), rawBytes: entry.bytes });
    w.onmessage = (e) => {
      const m = e.data as { status?: string; bytes?: number; total?: number; error?: string };
      if (m.status === "progress") { onProgress?.(m.bytes ?? 0, m.total ?? entry.bytes); return; }
      const status = m.status as PrefetchResult | undefined;
      finish(status === "done" || status === "already-cached" || status === "busy" || status === "unavailable" ? status : "error", m.error);
    };
    w.onerror = (e) => finish("error", e.message);
  });
}

export interface WarmReply { cached: number; pruned: number; total: number }

/** The active service worker a `warm` can be posted to, or null: none in
 * this browser, none registered, or none active within 30 s. The page
 * registers its worker on the window's `load` event (index.tsx, production
 * only) — so "no registration" is only conclusive once the page has loaded
 * and a short grace has passed; before that the `ready` wait runs. Without
 * this, `serviceWorker.ready` — which never settles when nothing registers
 * (the vite dev server, a failed production registration) — idled every
 * Prepare, and a boot awaiting it, for the full 30 s. */
async function warmTarget(): Promise<ServiceWorker | null> {
  if (!("serviceWorker" in navigator)) return null;
  const sw = navigator.serviceWorker;
  const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
  if (!sw.controller && !(await sw.getRegistration())) {
    const loaded = document.readyState === "complete" ? Promise.resolve() : new Promise<void>((r) => window.addEventListener("load", () => r(), { once: true }));
    await Promise.race([loaded, wait(30000)]);
    for (let i = 0; i < 12 && !(await sw.getRegistration()); i++) await wait(250);
    if (!(await sw.getRegistration())) return null;
  }
  const reg = await Promise.race([sw.ready, wait(30000).then(() => null)]);
  return reg?.active ?? null;
}

/** One warm-up in flight per runtime build: two Prepares clicked together
 * (and the boot's own warm-up after them) share one `warm` message. The
 * service worker's handler fetches every URL its cache lacks, and a second
 * loop started while the first's fetches were in flight missed each
 * cache.match and downloaded the 154 MB runtime a second time. */
let warmInFlight: { buildId: string; p: Promise<WarmReply | null> } | null = null;

/** Ask the service worker to cache the runtime's chunks and the manifests
 * (its `warm` message: through the HTTP cache, so bytes a boot just
 * downloaded are not downloaded twice; prunes chunks of superseded
 * runtimes). Needs no page control, so it works on the very first visit —
 * but a worker must have registered and activated (warmTarget). Null when
 * there is no service worker, or no reply in time. */
export function warmRuntimeCache(runtime: RuntimeManifest, timeoutMs = 120000): Promise<WarmReply | null> {
  if (warmInFlight?.buildId === runtime.buildId) return warmInFlight.p;
  const p = (async (): Promise<WarmReply | null> => {
    const urls: string[] = ["/runtime/runtime-manifest.json", "/snapshots/index.json", "/profiles/index.json"];
    for (const f of Object.values(runtime.files)) for (const c of f.chunks) urls.push(c.url);
    const target = await warmTarget();
    if (!target) return null;
    return new Promise<WarmReply | null>((resolve) => {
      const ch = new MessageChannel();
      const t = window.setTimeout(() => resolve(null), timeoutMs);
      ch.port1.onmessage = (e) => { window.clearTimeout(t); resolve(e.data as WarmReply); };
      target.postMessage({ type: "warm", urls }, [ch.port2]);
    });
  })();
  warmInFlight = { buildId: runtime.buildId, p };
  p.finally(() => { if (warmInFlight?.p === p) warmInFlight = null; }).catch(() => {});
  return p;
}

/** One game's Prepare, as the tile and the boot banner show it. `running`:
 * the region is streaming into OPFS (bytes/total are the worker's INFLATED
 * offsets — the tile scales them to the transfer size it promised);
 * `warming`: the region is complete and cached (the tile may flip to ready,
 * the boot may load it) while the runtime warm-up still runs; `done`: both
 * settled. */
export interface PrepareStatus {
  phase: "running" | "warming" | "done" | "failed";
  bytes: number;
  total: number;
  /** The prefetch worker's exit status once it exited. */
  result?: PrefetchResult;
  error?: string;
  /** Runtime files the service worker holds after the warm-up (null: no
   * service worker answered — the boot's own warm-up retries). */
  runtime?: WarmReply | null;
  /** Show the small-device memory heads-up on this tile (once per page). */
  memoryNote?: boolean;
}

/** Prepare statuses by snapshot name (jotai default store: the landing page
 * renders them, the boot reads them while it waits). */
export const prepareStatusesAtom = atom<Record<string, PrepareStatus>>({});

const publish = (name: string, status: PrepareStatus): void => {
  const store = getDefaultStore();
  store.set(prepareStatusesAtom, { ...store.get(prepareStatusesAtom), [name]: status });
};

/** A prepare in flight: `region` settles when the raw region is committed
 * to OPFS (or failed) — what a boot must wait for; `all` when the runtime
 * warm-up has settled too — what the tile shows as done. */
interface InFlightPrepare { region: Promise<PrepareStatus>; all: Promise<PrepareStatus> }
const inFlight = new Map<string, InFlightPrepare>();
let memoryNoteShown = false;
/** Snapshots a boot in this page has claimed (see claimSnapshotForBoot). */
const claimedByBoot = new Set<string>();

/** The region promise of this snapshot's running prepare, if any: the boot
 * awaits it before installing artifacts (a second prefetch worker would
 * report `busy` and the Lean worker would stream the region itself — the
 * heavy path). The runtime warm-up is not waited for: the service worker
 * finishes it on its own, and the boot's own warm-up joins it. */
export const inFlightPrepare = (name: string): Promise<PrepareStatus> | undefined => inFlight.get(name)?.region;

/** Every running prepare's region promise (the game-switch reload waits for
 * all of them: a reload kills the workers and discards their partials). */
export const inFlightRegions = (): { name: string; region: Promise<PrepareStatus> }[] =>
  [...inFlight].map(([name, f]) => ({ name, region: f.region }));

/** The boot has passed the point where it waits for a prepare of this
 * snapshot: from here the game session's own prefetch worker owns the
 * region file, and a Prepare started later would only collide with it
 * (`busy`, and the Lean worker streaming the region itself). prepareGame
 * refuses such a snapshot; the tile hides the button for the bound game. */
export const claimSnapshotForBoot = (name: string): void => { claimedByBoot.add(name); };

/** "Prepare offline": the raw region into OPFS (prefetch worker) and the
 * runtime chunks into the service worker's cache, concurrently, without
 * booting Lean. Idempotent per snapshot while running. The worker lives in
 * this document, so navigating within the app keeps it going; a full page
 * reload kills it (the prefetch worker discards the partial on its next
 * run). `sessionBound`: a game session is loaded in this page — allowed
 * (the inflate runs in its own worker), but a small device is told once. */
export function prepareGame(entry: SnapshotEntry, opts: { sessionBound?: boolean } = {}): Promise<PrepareStatus> {
  const existing = inFlight.get(entry.name);
  if (existing) return existing.all;
  if (claimedByBoot.has(entry.name)) {
    const refused: PrepareStatus = { phase: "failed", bytes: 0, total: entry.bytes, result: "busy" };
    publish(entry.name, refused);
    console.warn(`[game-cache] prepare ${entry.name}: refused — the game loaded in this page owns its region`);
    return Promise.resolve(refused);
  }
  const deviceGb = (navigator as { deviceMemory?: number }).deviceMemory;
  const memoryNote = !!opts.sessionBound && typeof deviceGb === "number" && deviceGb < 8 && !memoryNoteShown;
  if (memoryNote) memoryNoteShown = true;
  let status: PrepareStatus = { phase: "running", bytes: 0, total: entry.bytes, memoryNote };
  publish(entry.name, status);
  const warm = resolveRuntimeManifest().then((m) => warmRuntimeCache(m, 10 * 60 * 1000)).catch((e) => {
    console.warn("[game-cache] runtime warm-up skipped:", e);
    return null;
  });
  const region = (async (): Promise<PrepareStatus> => {
    const { result, error } = await prefetchRawSnapshot(entry, (bytes, total) => {
      status = { ...status, bytes, total };
      publish(entry.name, status);
    });
    const ok = result === "done" || result === "already-cached";
    status = ok ? { ...status, phase: "warming", bytes: entry.bytes, result } : { ...status, phase: "failed", result, error };
    publish(entry.name, status);
    return status;
  })();
  const all = (async (): Promise<PrepareStatus> => {
    const afterRegion = await region;
    // A failed region is final at once (a Retry must not queue behind the
    // warm-up, which the service worker finishes on its own either way).
    if (afterRegion.phase === "failed") {
      console.info(`[game-cache] prepare ${entry.name}: region ${afterRegion.result}${afterRegion.error ? ` (${afterRegion.error})` : ""}`);
      return afterRegion;
    }
    const runtime = await warm;
    status = { ...status, phase: "done", runtime };
    publish(entry.name, status);
    console.info(`[game-cache] prepare ${entry.name}: region ${status.result}; runtime ${runtime ? `${runtime.cached}/${runtime.total} files cached` : "not warmed"}`);
    return status;
  })();
  inFlight.set(entry.name, { region, all });
  all.finally(() => inFlight.delete(entry.name)).catch(() => {});
  return all;
}

/** The landing page's storage meter: what this origin uses and may use, in
 * bytes. Null where the estimate is unavailable (the meter hides).
 *
 * Chromium's estimate() serves the OPFS share from an on-disk usage cache
 * that never learns bytes written through a sync access handle — the way the
 * regions are written — so after a browser restart it reported a few hundred
 * bytes for gigabytes of regions ("3 (0.2 GB …)"). The region files are
 * summed here and replace the estimate's file-system share when they exceed
 * it (a browser that counts them itself is left alone). */
export async function storageSummary(): Promise<{ usage: number; quota: number } | null> {
  let estimate: StorageEstimate & { usageDetails?: Record<string, number> };
  try {
    estimate = await navigator.storage.estimate();
  } catch {
    return null;
  }
  const usage = estimate.usage ?? 0;
  const quota = estimate.quota ?? 0;
  let regions = 0;
  const dir = await snapshotsDir();
  if (dir) {
    try {
      // FileSystemDirectoryHandle's async iterator is not in this tsconfig's lib.
      for await (const handle of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
        if (handle.kind === "file") regions += (await (handle as FileSystemFileHandle).getFile()).size;
      }
    } catch { /* a file mid-write or gone: the estimate stands */ }
  }
  const fileSystem = estimate.usageDetails?.fileSystem;
  const corrected = typeof fileSystem === "number" ? usage - fileSystem + Math.max(fileSystem, regions) : Math.max(usage, regions);
  return { usage: corrected, quota };
}
