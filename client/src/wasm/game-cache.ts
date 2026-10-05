/**
 * The game environment cache as the page manages it: OPFS raw regions
 * (`qed64-snapshots/<cacheKey>.raw`, what the Lean worker sync-reads into
 * its heap), the service worker's runtime cache, and "Prepare" — filling
 * both from the landing page without booting Lean.
 *
 * Shared by the landing page (Prepare / Remove download / the storage
 * meter) and the boot (game-boot.ts: sweep stale regions, warm the runtime
 * cache once the checker is up). Only page-side composition of qed64's
 * pieces lives here: its raw region cache (`prefetchRaw` and the helpers of
 * docs/EMBEDDING.md §7.4: one prefetch worker per region in this page, the
 * Web Lock `qed64-raw:<key>` across tabs) and the service worker's `warm`
 * message (client/src/sw) are the contracts.
 */
import { atom, getDefaultStore } from "jotai";
import { PREFETCH_SILENCE_MS, SNAPSHOT_CACHE_DIR, isCacheKeyOf, prefetchRaw, removeRawRegion, runtimeUrls, snapshotCacheKey, type PrefetchRawResult, type SnapshotEntry, type SnapshotIndex } from "qed64/embed";
import type { RuntimeManifest } from "qed64/embed";
import { resolveRuntimeManifest } from "./games-api";
import { LINK_RETRY_MS, ensureServiceWorkerRegistration, ownServiceWorkerRegistration, pendingServiceWorkerRegistration, retryAfterLinkFailure, type RoundStep } from "./sw-client";
import { cachedLevelImageUrls, fetchGameDataUrls } from "./game-data-urls";
import { isSameOrigin } from "./boot-params";

/** qed64's snapshot cache directory in OPFS, or null where OPFS is
 * unavailable (Firefox private mode throws on getDirectory) or the directory
 * does not exist yet. */
async function snapshotCacheDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(SNAPSHOT_CACHE_DIR);
  } catch {
    return null;
  }
}

/* ---- L12: cross-tab cache state --------------------------------------------
 * The tiles and the storage meter are derived per tab and re-probed only on
 * this tab's own events; a region another tab prepared, removed or booted
 * stayed invisible until a reload ("Already being downloaded… Retry" next to
 * a finished download; "Remove download" for a region already removed).
 * Every tab posts on one BroadcastChannel when it changed the region cache
 * and re-probes when another did. Browsers without BroadcastChannel (or a
 * context that refuses it) simply post nothing — the landing page also
 * re-probes on focus / visibilitychange. */
const CACHE_CHANNEL = "l4g-cache";
let cacheChannel: BroadcastChannel | null | undefined;
const remoteListeners = new Set<() => void>();
function channel(): BroadcastChannel | null {
  if (cacheChannel !== undefined) return cacheChannel;
  try {
    cacheChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel(CACHE_CHANNEL) : null;
  } catch { cacheChannel = null; }
  if (cacheChannel) cacheChannel.onmessage = (e) => {
    const m = e.data as { type?: string; name?: unknown; tab?: unknown; id?: unknown; hidden?: unknown; phase?: unknown; bytes?: unknown; total?: unknown; transfer?: unknown; outcome?: unknown } | null;
    const tab = typeof m?.tab === "string" ? m.tab : "";
    switch (m?.type) {
      case "cache-changed":
        cacheChangedElsewhere();
        return;
      // D2/D3 (below): another tab's download.
      case "prepare-progress":
        // F1: a word of a download that tab already ended is a ghost.
        if (typeof m.name === "string" && !remoteDownloadEnded(tab, m.id)) noteRemoteDownload(m.name, tab, {
          phase: m.phase === "warming" ? "warming" : "running",
          bytes: typeof m.bytes === "number" ? m.bytes : 0,
          total: typeof m.total === "number" ? m.total : 0,
          ...(typeof m.transfer === "number" && m.transfer > 0 ? { transfer: m.transfer } : {}),
        }, m.hidden === true);
        return;
      case "prepare-ended":
        if (typeof m.name === "string") {
          noteRemoteDownloadEnded(tab, m.id);
          dropRemoteDownload(m.name, tab);
          console.info(`[game-cache] ${m.name}: the download in another tab ended (${typeof m.outcome === "string" ? m.outcome : "?"})`);
        }
        cacheChangedElsewhere();
        return;
      case "prepare-query":
        for (const name of localDownloads.keys()) sayProgress(name);
        return;
    }
  };
  return cacheChannel;
}

function post(message: Record<string, unknown>): void {
  try { channel()?.postMessage(message); } catch { /* closed or unsupported */ }
}

/** Another tab changed the cache, or ended a download: this tab's busy
 * refusals are over and every tile re-probes. */
function cacheChangedElsewhere(): void {
  clearFailedPrepares();
  for (const cb of remoteListeners) { try { cb(); } catch (err) { console.warn("[game-cache] cache-change listener failed:", err); } }
}

/** This tab changed the region cache (a prepare committed, a download was
 * removed, stale regions were swept, the bound game's boot landed its
 * region): tell the other tabs. A BroadcastChannel never delivers to its
 * own tab — the local callers re-probe themselves, as before. `alsoHere`:
 * a change no local caller re-probes for (the bound game's background
 * warm-up finished filling the service worker's cache — D1's tile reads it)
 * runs this tab's listeners too. */
export function notifyCacheChanged(alsoHere = false): void {
  post({ type: "cache-changed" });
  if (alsoHere) for (const cb of remoteListeners) { try { cb(); } catch (err) { console.warn("[game-cache] cache-change listener failed:", err); } }
}

/** Subscribe to cache changes made by OTHER tabs (and the background ones
 * `notifyCacheChanged(true)` reports here); returns the unsubscribe. */
export function onRemoteCacheChange(cb: () => void): () => void {
  channel();
  remoteListeners.add(cb);
  return () => { remoteListeners.delete(cb); };
}

/* ---- D2/D3 (live 2026-10-03): downloads running in another tab -----------
 * The channel above only said "the cache changed" on commit / remove / sweep.
 * A second landing tab therefore showed "Download ≈N MB" and an active
 * "Prepare offline" for the whole of another tab's Prepare (D2), and after
 * that Prepare FAILED its "Already being downloaded… Retry" stayed for good:
 * a failure changes nothing in the cache, so nothing was said (D3). Now:
 *  - a tab with a running download (a Prepare; a game tab whose boot streams
 *    its region) heartbeats `prepare-progress {name, tab, hidden, phase,
 *    bytes, total}` once a second — also while no byte arrives — and says
 *    `prepare-ended {name, tab, outcome}` when it stops, whatever the outcome
 *    (done, partial, failed, busy, unavailable);
 *  - a tab that opens or is looked at again asks (`prepare-query`) and every
 *    running tab answers at once;
 *  - a remote download not heard of for REMOTE_DOWNLOAD_TTL_MS (its tab
 *    closed, crashed or froze) is dropped and the tiles re-probe;
 *  - an ended download drops this tab's busy refusals and re-probes, as
 *    `cache-changed` does; and a look at the tab (queryRemoteDownloads) drops
 *    a busy refusal whose holder runs nowhere any more.
 * Review round:
 *  - R1: a hidden tab's chained timers wake once a minute after 5 minutes
 *    (Chrome's intensive wake-up throttling), so a Prepare left running in a
 *    background tab — D2's own slow-link case — went silent for ~54 s of
 *    every minute and the other tabs dropped it after 6 s: its tile flipped
 *    back to "Download ≈N MB" + Prepare. Now progress is said from the
 *    progress path too (the prefetch worker's messages are not throttled),
 *    each word says whether its tab is `hidden` (the receivers then wait
 *    HIDDEN_DOWNLOAD_TTL_MS, not 6 s — the warm-up phase has only the
 *    timer), a visibility change is said at once, and a tab that closes says
 *    `prepare-ended` on pagehide, so the long wait only covers a crash;
 *  - R3: every word carries its tab's id and the tabs keep one entry per
 *    sender: two tabs reporting the same snapshot (a Prepare, and a game tab
 *    whose boot met its busy file and streams the region itself) used to
 *    overwrite each other, and the first one's `prepare-ended` dropped the
 *    other's live download;
 *  - UX5: a phase change is said at once ("Finish offline download" moves
 *    from `running` to `warming` within milliseconds; the other tabs showed
 *    "Being downloaded… 0 / N MB" until the next beat).
 * F1 (live run of f468f2c): closing or reloading a VISIBLE tab mid-Prepare
 * left "Being downloaded in another tab… N / M MB" in the other tabs for
 * ~75 s: its pagehide said `prepare-ended`, but the visibilitychange
 * (hidden) that follows pagehide said the download again — with
 * `hidden: true`, so the receivers kept the ghost for the hidden ttl (a game
 * tab closed while its boot streamed the region did the same, and a reloaded
 * tab whose new Prepare started within 75 s showed under its own ghost's
 * counts). Both ends now: after pagehide this tab says no progress until a
 * persisted pageshow (a page restored from the back/forward cache, whose
 * downloads then take new ids); and every download carries an `id`, one per
 * download of its tab, and a receiver ignores progress of a (tab, id) it
 * heard end — a new download of the same tab has a new id and shows. */

/** One running download as the tiles show it: `bytes`/`total` are the
 * prefetch worker's INFLATED offsets (the tile scales them to the transfer
 * size), `warming` — the region is committed, the runtime warm-up runs.
 * `transfer` (NEW-2, live run of 4083fb4): the bytes the download moves on
 * the wire (the index entry's transfer size), said with every word — a tab
 * opened while another one downloads has the word 0.2 s after it opens, but
 * its own index (the tile's transfer size) only after its manifest and index
 * fetches, which run behind the download (~4 s at 1.5 MB/s); the tile showed
 * nothing until then. A sender of a build before NEW-2 says none. */
export interface DownloadProgress { phase: "running" | "warming"; bytes: number; total: number; transfer?: number }
/** A download another tab reported: when it was last heard of, and how long
 * its silence is borne (`ttl`: R1 — longer for a sender in a hidden tab). */
export interface RemoteDownload extends DownloadProgress { at: number; ttl: number }

/** Heartbeat period of a running download. */
export const DOWNLOAD_HEARTBEAT_MS = 1000;
/** A remote download not heard of for this long is over (six missed beats). */
export const REMOTE_DOWNLOAD_TTL_MS = 6000;
/** R1: the same for a sender whose tab is hidden — its timers may wake only
 * once a minute; 15 s of slack. */
export const HIDDEN_DOWNLOAD_TTL_MS = 75_000;
/** How long queryRemoteDownloads waits for the running tabs' answers before
 * it treats a busy refusal as stale. */
export const QUERY_ANSWER_MS = 1500;

/** R3: this tab's id on the channel. */
const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const pageHidden = (): boolean => typeof document !== "undefined" && document.visibilityState === "hidden";

/** Every download other tabs reported, by snapshot name, then by sender tab
 * (R3) — in the order the senders were first heard of. */
export const remoteSendersAtom = atom<Record<string, Record<string, RemoteDownload>>>({});
/** Downloads running in OTHER tabs, by snapshot name (the landing tiles):
 * the first sender of each still heard of — the same one while it lasts, so
 * two senders do not make the tile flicker between their counts. */
export const remoteDownloadsAtom = atom((get): Record<string, RemoteDownload> => {
  const view: Record<string, RemoteDownload> = {};
  for (const [name, by] of Object.entries(get(remoteSendersAtom))) {
    const first = Object.values(by)[0];
    if (first) view[name] = first;
  }
  return view;
});
/** This tab's running downloads: the latest progress, when it was last said
 * to the other tabs, and its id (F1: one per download of this tab). */
const localDownloads = new Map<string, { progress: DownloadProgress; saidAt: number; id: number }>();
let downloadSeq = 0;
/** F1: this page went away (pagehide) and has not come back from the
 * back/forward cache: it says no progress. */
let pageGone = false;
let heartbeatTimer = 0;
let expiryTimer = 0;
let pageEventsWatched = false;

function sayProgress(name: string): void {
  const d = localDownloads.get(name);
  if (!d || pageGone) return;
  d.saidAt = Date.now();
  post({ type: "prepare-progress", name, tab: TAB_ID, id: d.id, hidden: pageHidden(), ...d.progress });
}

/** R1: say every running download at once when this tab is hidden or shown
 * (the receivers switch to the matching ttl before this tab's timers are
 * throttled), and end them when the tab goes away (pagehide — a reload or a
 * close kills the downloads). F1: from pagehide on nothing more is said —
 * the visibilitychange that follows it would bring the ended downloads back
 * as hidden ghosts — until a persisted pageshow: a page restored from the
 * back/forward cache says its downloads at once, under new ids (the other
 * tabs heard the old ones end). */
function watchPageEvents(): void {
  if (pageEventsWatched || typeof document === "undefined") return;
  pageEventsWatched = true;
  document.addEventListener("visibilitychange", () => { for (const name of localDownloads.keys()) sayProgress(name); });
  window.addEventListener("pagehide", () => {
    pageGone = true;
    for (const [name, d] of localDownloads) post({ type: "prepare-ended", name, tab: TAB_ID, id: d.id, outcome: "closed" });
  });
  window.addEventListener("pageshow", (e) => {
    if (!(e as PageTransitionEvent).persisted || !pageGone) return;
    pageGone = false;
    for (const [name, d] of localDownloads) { d.id = ++downloadSeq; sayProgress(name); }
  });
}

/** The heartbeat: every running download once per DOWNLOAD_HEARTBEAT_MS
 * (but one the progress path said in the last half beat), also while no byte
 * arrives. */
function armHeartbeat(): void {
  if (heartbeatTimer || !localDownloads.size) return;
  heartbeatTimer = window.setTimeout(() => {
    heartbeatTimer = 0;
    for (const [name, d] of localDownloads) if (Date.now() - d.saidAt >= DOWNLOAD_HEARTBEAT_MS / 2) sayProgress(name);
    armHeartbeat();
  }, DOWNLOAD_HEARTBEAT_MS);
}

/** Report (or update) one of this tab's running downloads. Said at once:
 * the first report, a phase change (UX5), and progress a heartbeat period
 * after the last word (R1: the progress path is not throttled in a hidden
 * tab); the heartbeat says the latest state in between, so progress
 * callbacks may call this at any rate. */
export function reportDownload(name: string, progress: DownloadProgress): void {
  const prev = localDownloads.get(name);
  localDownloads.set(name, { progress, saidAt: prev?.saidAt ?? 0, id: prev?.id ?? ++downloadSeq });
  if (!prev || prev.progress.phase !== progress.phase || Date.now() - prev.saidAt >= DOWNLOAD_HEARTBEAT_MS) sayProgress(name);
  watchPageEvents();
  armHeartbeat();
}

/** One of this tab's downloads reached a terminal outcome — said for EVERY
 * outcome (D3), also for a Prepare that never reported progress (a refusal):
 * the other tabs drop their stale busy status and re-probe. `outcome` is
 * logged by the receivers (done, partial, failed, busy, unavailable; a boot's
 * region `ended`; a tab that went away `closed`). */
export function endDownload(name: string, outcome: string): void {
  const id = localDownloads.get(name)?.id; // none for a Prepare refused before any progress
  localDownloads.delete(name);
  if (!localDownloads.size && heartbeatTimer) { window.clearTimeout(heartbeatTimer); heartbeatTimer = 0; }
  post({ type: "prepare-ended", name, tab: TAB_ID, id, outcome });
}

/** F1: the downloads other tabs said ended, `<tab> <id>` → until when a
 * late word of one is ignored. HIDDEN_DOWNLOAD_TTL_MS: no ghost could have
 * lasted longer (a closed tab's late word is posted within its unload). An
 * end without an id (a tab of a build before F1) is not remembered — that
 * tab's words carry no id to tell its next download apart. */
const endedRemote = new Map<string, number>();

function noteRemoteDownloadEnded(tab: string, id: unknown): void {
  if (typeof id !== "number") return;
  const now = Date.now();
  for (const [key, until] of endedRemote) if (until <= now) endedRemote.delete(key);
  endedRemote.set(`${tab} ${id}`, now + HIDDEN_DOWNLOAD_TTL_MS);
}

function remoteDownloadEnded(tab: string, id: unknown): boolean {
  if (typeof id !== "number") return false;
  const until = endedRemote.get(`${tab} ${id}`);
  return until !== undefined && until > Date.now();
}

/** The senders still heard of at `now` (each by its own ttl), and the
 * snapshot names no sender is heard of any more (pure; the sweep below
 * applies it). */
export function expireRemoteDownloads(cur: Readonly<Record<string, Record<string, RemoteDownload>>>, now: number): { kept: Record<string, Record<string, RemoteDownload>>; expired: string[] } {
  const kept: Record<string, Record<string, RemoteDownload>> = {};
  const expired: string[] = [];
  for (const [name, by] of Object.entries(cur)) {
    const alive = Object.entries(by).filter(([, d]) => now - d.at < d.ttl);
    if (alive.length) kept[name] = Object.fromEntries(alive);
    else expired.push(name);
  }
  return { kept, expired };
}

const senderCount = (s: Record<string, Record<string, RemoteDownload>>): number =>
  Object.values(s).reduce((n, by) => n + Object.keys(by).length, 0);

function noteRemoteDownload(name: string, tab: string, progress: DownloadProgress, hidden: boolean): void {
  const store = getDefaultStore();
  const cur = store.get(remoteSendersAtom);
  const ttl = hidden ? HIDDEN_DOWNLOAD_TTL_MS : REMOTE_DOWNLOAD_TTL_MS;
  store.set(remoteSendersAtom, { ...cur, [name]: { ...cur[name], [tab]: { ...progress, at: Date.now(), ttl } } });
  if (expiryTimer) return;
  const sweep = () => {
    expiryTimer = 0;
    const heard = store.get(remoteSendersAtom);
    const { kept, expired } = expireRemoteDownloads(heard, Date.now());
    if (senderCount(kept) !== senderCount(heard)) store.set(remoteSendersAtom, kept);
    if (expired.length) {
      console.info(`[game-cache] no word from the tab downloading ${expired.join(", ")} — re-probing`);
      cacheChangedElsewhere();
    }
    if (Object.keys(kept).length) expiryTimer = window.setTimeout(sweep, DOWNLOAD_HEARTBEAT_MS);
  };
  expiryTimer = window.setTimeout(sweep, DOWNLOAD_HEARTBEAT_MS);
}

/** One sender's download ended (R3: another tab's download of the same
 * snapshot stays). */
function dropRemoteDownload(name: string, tab: string): void {
  const store = getDefaultStore();
  const cur = store.get(remoteSendersAtom);
  if (!cur[name] || !(tab in cur[name])) return;
  const { [tab]: _gone, ...rest } = cur[name];
  const next = { ...cur };
  if (Object.keys(rest).length) next[name] = rest;
  else delete next[name];
  store.set(remoteSendersAtom, next);
}

/** This tab opened or is looked at again: ask the other tabs what they are
 * downloading (they answer at once), then drop every busy refusal whose
 * holder runs nowhere — neither a Prepare of this tab nor a download another
 * tab reported. Without a channel nobody answers, and a busy refusal is
 * dropped on the next look (the tile then offers Prepare again, which
 * re-checks the file). */
export function queryRemoteDownloads(): void {
  post({ type: "prepare-query" });
  window.setTimeout(() => {
    const remote = getDefaultStore().get(remoteDownloadsAtom);
    clearFailedPrepares((name) => !inFlight.has(name) && !(name in remote));
  }, QUERY_ANSWER_MS);
}

/** "Remove download": delete this game's inflated region (and a partial of
 * it) — qed64's removeRawRegion, nothing else (the Lean worker's compressed
 * copy, if any, and the runtime cache are untouched) — and tell the other
 * tabs (L12). True when a file was removed. */
export async function removeDownload(entry: SnapshotEntry): Promise<boolean> {
  const removed = await removeRawRegion(entry);
  if (removed) notifyCacheChanged(); // L12
  return removed; // absent, or OPFS refused — the tile re-probes either way
}

/** A cache key's tail after the snapshot's (sanitised) name: qed64's
 * snapshotCacheKey is `<name>.<16 hex of the digest>.snapz`, or
 * `<name>.<bytes>.<transfer>.snapz` for an entry without a digest; the files
 * are the key itself (the Lean worker's compressed copy), `<key>.raw`, and
 * either one's `.partial`. */
const KEY_TAIL = /^(?:[0-9a-f]{16}|\d+\.\d+)\.snapz(?:\.raw)?(?:\.partial)?$/;
const KEY_SUFFIX = /\.(?:[0-9a-f]{16}|\d+\.\d+)\.snapz$/;

/** Sweep the stale bakes from qed64's snapshot cache: every file of a name
 * the served index LISTS whose key is not that entry's live one (qed64's
 * isCacheKeyOf: the entry's compressed copy, its raw region, or either one's
 * partial) — a rebake changed the digest and the old 1.4 GB region would
 * otherwise sit in every returning user's OPFS for ever; a reload, a crash or
 * a prefetch bail strands a `.partial` of a key that is not live any more
 * (the workers only ever discard the partial of the key they are asked for).
 * A live key's files are kept, its partial too (an in-flight prepare or the
 * session's own prefetch holds it).
 * A name the index does not list is never touched (PAR-3, review of phase 2):
 * the index is this PAGE's — a tab that outlives a deploy (the service worker
 * keeps the previous shell for exactly that) sweeps against the old one, and
 * a game the new deploy added, Prepared in a newer tab, is unlisted there; so
 * is a developer's unpromoted bake under another name (`nng4.dev.*` next to
 * `nng4`). The listed names come from the live keys themselves (the key with
 * its tail cut off), so the sanitisation is qed64's; a key shape this does
 * not know names nothing, and nothing of that name is removed. Never call it
 * against an unpromoted (`?snapshots=<dir>`) index: its keys differ from the
 * served ones by design (game-boot skips the sweep then). Returns the
 * removed file names. */
export async function sweepStaleSnapshots(index: SnapshotIndex): Promise<string[]> {
  const dir = await snapshotCacheDir();
  if (!dir) return [];
  const listed = index.snapshots.flatMap((e) => {
    const key = snapshotCacheKey(e);
    return KEY_SUFFIX.test(key) ? [key.replace(KEY_SUFFIX, "")] : [];
  });
  const ofListedName = (name: string) => listed.some((n) => name.startsWith(`${n}.`) && KEY_TAIL.test(name.slice(n.length + 1)));
  const removed: string[] = [];
  // FileSystemDirectoryHandle's async iterator is not in this tsconfig's lib.
  const names = (dir as unknown as { keys(): AsyncIterable<string> }).keys();
  for await (const name of names) {
    if (isCacheKeyOf(name, index) || !ofListedName(name)) continue;
    try {
      await dir.removeEntry(name);
      removed.push(name);
    } catch (e) {
      console.warn(`[game-cache] could not remove stale region ${name}:`, e);
    }
  }
  if (removed.length) notifyCacheChanged(); // L12
  return removed;
}

/** `partial`: the worker stopped at its per-message budget (a message event
 * must end inside Chromium's 5-minute limit) — warmRuntimeCacheOutcome sends
 * the warm-up again while rounds make progress; a `partial` it returns means
 * the rounds ran out (or stopped progressing) with the list incomplete.
 * `bytes` (D1): runtime-chunk body bytes this round received beyond what an
 * earlier round already had of that chunk — a chunk cut at the round's hard
 * abort is progress the HTTP cache resumes. Absent from a worker deployed
 * before D1. `linkDown` (D7): a fetch of this round failed outright
 * (offline, a refused connection), after which the worker started no more
 * fetches and only looked the rest up — `cached` is still what the cache
 * holds. Absent from a worker deployed before D7. */
export interface WarmReply { cached: number; pruned: number; total: number; partial?: boolean; bytes?: number; linkDown?: boolean }

/** The active service worker a `warm` can be posted to, or null: none in
 * this browser, none registered, or none active within 30 s. The page
 * registers its worker on the window's `load` event (index.tsx, production
 * only) — so "no registration" is only conclusive once the page has loaded
 * and a short grace has passed; before that the `ready` wait runs. Without
 * this, `serviceWorker.ready` — which never settles when nothing registers
 * (the vite dev server, a failed production registration) — idled every
 * Prepare, and a boot awaiting it, for the full 30 s. `how.patient` (S1, a
 * Prepare): the worker is waited for without a fixed cap
 * (activeWorkerWhenInstalled) — a registration still installing, or this
 * page's own registration still deferred; where nothing will register (no
 * service worker, the dev server) it still answers null at once. */
async function warmTarget(how: WarmWait = {}): Promise<ServiceWorker | null> {
  if (!("serviceWorker" in navigator)) return null;
  const sw = navigator.serviceWorker;
  if (how.patient) return activeWorkerWhenInstalled(sw, how.onWait);
  const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
  // N2: a registration this page started (possibly deferred until the game
  // was served) is awaited rather than polled for.
  const pending = pendingServiceWorkerRegistration();
  if (pending) await Promise.race([pending, wait(30000)]);
  if (!sw.controller && !(await sw.getRegistration())) {
    const loaded = document.readyState === "complete" ? Promise.resolve() : new Promise<void>((r) => window.addEventListener("load", () => r(), { once: true }));
    await Promise.race([loaded, wait(30000)]);
    for (let i = 0; i < 12 && !(await sw.getRegistration()); i++) await wait(250);
    if (!(await sw.getRegistration())) return null;
  }
  const reg = await Promise.race([sw.ready, wait(30000).then(() => null)]);
  return reg?.active ?? null;
}

/** S1 (live run of f468f2c): how a warm-up waits for its service worker.
 * `patient` — a Prepare: no fixed cap (activeWorkerWhenInstalled);
 * `onWait(true)` when it starts waiting for a worker to activate (its
 * install, or R2-2 this page's deferred registration first),
 * `onWait(false)` when that wait ends, either way (the tile says what the
 * Prepare waits for). */
export interface WarmWait { patient?: boolean; onWait?: (waiting: boolean) => void }

/** How often a patient wait looks at the registration besides `ready`. */
const WORKER_LOOK_MS = 10_000;

/** S1 (live run of f468f2c, 150 kB/s first visit): a Prepare clicked while
 * the first service worker was still installing its 17 MB critical shell
 * (~2 min there) raced `ready` against 30 s, got no worker, and ended
 * "region done; runtime not warmed" after its region had downloaded for 19
 * more minutes — no runtime chunk, no game file cached. A Prepare now waits
 * for the registration's worker to activate, with no clock: the wait ends
 * when a worker is active, or when no registration can be had any more — an
 * install that fails (Chromium stops one at 300 s) takes a first version's
 * registration with it; sw-client registers again once per page
 * (ensureServiceWorkerRegistration), and a second loss is final. `ready`
 * settles at activation; the registration is also looked at every
 * WORKER_LOOK_MS (`ready` never settles for a registration deleted under
 * it). R2-2 / R2-3 (review of S1): with no registration to look at and none
 * started by this page — a game page holds its registration back while its
 * boot downloads (sw-client (2)), and the Prepare may run on the landing
 * page it navigated to in-app — the page's own registration is waited for
 * (ownServiceWorkerRegistration), never forced: the Prepare used to give up
 * 3 s in, and registering on its own (when another tab's registration was
 * lost) started the 17 MB install beside the boot's download. Only a
 * registration this page made is registered again. Null: no worker will
 * come (none can be registered here, or the second install failed too) —
 * the Prepare ends `partial`. */
async function activeWorkerWhenInstalled(sw: ServiceWorkerContainer, onWait?: (waiting: boolean) => void): Promise<ServiceWorker | null> {
  const since = Date.now();
  let waitingFor: "" | "install" | "registration" = "";
  const waitFor = (what: "install" | "registration") => {
    if (waitingFor === what) return;
    if (!waitingFor) onWait?.(true);
    waitingFor = what;
    console.info(what === "install" ? "[game-cache] runtime warm-up: waiting for the service worker to finish installing"
      : "[game-cache] runtime warm-up: waiting for this page's service-worker registration (held back while a Lean download runs)");
  };
  let waited = false;
  // `ready` settles once a worker is active: the wait is over from that very
  // reaction (R2-2) — the Prepare reads as downloading again
  // (preparesDownloading) before the shell fill, woken by the same `ready`
  // a few hops later, asks whether a Lean download runs.
  const endWait = () => { if (waitingFor) { waitingFor = ""; waited = true; onWait?.(false); } };
  let readySettled = false;
  const ready = sw.ready.then(() => { readySettled = true; endWait(); });
  try {
    for (;;) {
      const reg = await sw.getRegistration().catch(() => undefined);
      if (reg?.active) {
        if (waitingFor || waited) console.info(`[game-cache] runtime warm-up: the service worker is active after ${Math.round((Date.now() - since) / 1000)} s — warming`);
        return reg.active;
      }
      let own: Promise<unknown> | null = null;
      if (reg) waitFor("install");
      else if (pendingServiceWorkerRegistration()) {
        waitFor("install");
        if (!(await ensureServiceWorkerRegistration().catch(() => false))) {
          console.warn("[game-cache] runtime warm-up: the service worker's install failed and no registration can be had — not warmed");
          return null;
        }
      } else {
        own = ownServiceWorkerRegistration();
        if (!own) {
          if (waitingFor || waited) console.warn("[game-cache] runtime warm-up: the registration is gone and none can be made here — not warmed");
          return null;
        }
        waitFor("registration");
      }
      await new Promise<void>((resolve) => {
        const t = window.setTimeout(done, WORKER_LOOK_MS);
        function done() { window.clearTimeout(t); resolve(); }
        if (!readySettled) void ready.then(done);
        void own?.then(done, done);
      });
    }
  } finally {
    endWait();
  }
}

/** One warm-up in flight per (runtime build, extra URLs) set: two Prepares
 * clicked together share one `warm` message. The boot's own warm-up names
 * the bound game's data too, so it is a SEPARATE message even while a
 * Prepare's warm-up runs — the worker dedupes the fetches per URL (a second
 * loop started while the first's fetches were in flight used to miss each
 * cache.match and download the 154 MB runtime a second time), and the boot
 * gives its message the Prepare's 10-minute window: chunks a Prepare is
 * still fetching are awaited, not fetched twice. `wait` (R2-1, review of
 * S1): whether its patient wait waits for a service worker now, and the
 * onWait of every Prepare that started or JOINED it — a Retry after its
 * region failed (the first Prepare's warm-up waits on for the install) gets
 * the same build id and this same warm-up, and its tile must say the wait
 * too: a joiner hears it at once while it runs, and every listener hears it
 * end. */
interface WarmWaiters { waiting: boolean; listeners: Set<(waiting: boolean) => void> }
let warmInFlight: { buildId: string; p: Promise<WarmOutcome>; wait: WarmWaiters } | null = null;
/** Every warm-up's WarmWaiters until it settles (one no longer in flight —
 * another set's warm-up started since — still runs and still says its wait). */
const warmWaits = new Set<WarmWaiters>();

/** R2-1: a Prepare that settled stops hearing the wait it started or joined. */
function stopHearingWarmWait(onWait: (waiting: boolean) => void): void {
  for (const w of warmWaits) w.listeners.delete(onWait);
}
/** At most this many `warm` messages per warm-up, each bounded by the worker
 * to ~4 min (it starts no fetch after 3 min, aborts at 4). D1 (live
 * 2026-10-03): sized for the runtime (154 MB, 16 MiB chunks one at a time)
 * on a ~40 kB/s share of a slow link — a Prepare's region and the runtime
 * split a 300 kB/s line — which moves ~7–10 MB per round: ~16–19 rounds; 24
 * cover ~27 kB/s. Safe because a round counts as progress only when a file
 * was completed or new chunk bytes arrived (warmRoundProgressed): a dead link
 * ends the warm-up after one empty round (two while the browser still says
 * online — warmRoundStep's one retry, R2), not after 24. (8 rounds covered
 * ~80 kB/s, and the old whole-file rule quit at a round spent inside one
 * chunk: 7/13 live.) */
const WARM_ROUNDS = 24;

/** D1 (live 2026-10-03): did this warm round make progress? A round that completed a file
 * (cached grew) did; so did one that received new runtime-chunk bytes — a
 * 16 MiB chunk can take a whole round on a slow link, cut by the worker's
 * hard abort and resumed by the HTTP cache next round; the old rule (whole
 * files only) quit "stopped making progress" there with the runtime partly
 * cached. A reply without `bytes` (a worker deployed before D1) keeps the
 * whole-file rule. The first round always counts — unless (D7) the link
 * failed in it: such a round counts only on chunk bytes it received or files
 * it added since the previous round, so an offline page sends one `warm`,
 * not two. */
export function warmRoundProgressed(last: WarmReply | null, reply: WarmReply): boolean {
  const gotBytes = typeof reply.bytes === "number" && reply.bytes > 0;
  if (reply.linkDown) return gotBytes || (!!last && reply.cached > last.cached);
  if (!last || reply.cached > last.cached) return true;
  return gotBytes;
}

/** N1 (live run of f468f2c): the link failed in this round, but the cache
 * holds every file the round named — nothing is missing; only the
 * revalidation of the data files could not be done. */
export const heldButNotRevalidated = (reply: WarmReply): boolean => !!reply.linkDown && reply.total > 0 && reply.cached >= reply.total;

/** The warm-up loop's step after `reply` (pure): done once a round is not
 * `partial`; on while rounds progress; a link-down round that gained nothing
 * is retried once after LINK_RETRY_MS (R2, sw-client) — one transient fetch
 * failure ended a Prepare's warm-up at 5 of 300 game files. N1: not when
 * every file is held (heldButNotRevalidated) — the retry could only
 * revalidate, and offline it cost ~120 failing service-worker GETs and the
 * log line "the connection failed at 192/192 files". */
export function warmRoundStep(last: WarmReply | null, reply: WarmReply, linkRetried: boolean): RoundStep {
  if (!reply.partial || heldButNotRevalidated(reply)) return "stop";
  if (warmRoundProgressed(last, reply)) return "continue";
  return reply.linkDown && retryAfterLinkFailure(linkRetried) ? "retry" : "stop";
}

/** D7 (live 2026-10-03): run `fn` now unless the browser says it is offline
 * (navigator.onLine === false — reliable in that direction only), else once,
 * at the next `online` event. For the page's offline-cache warm-ups: an
 * offline boot of a cached game sent the service worker every data file to
 * re-fetch, and each failed. True when `fn` ran now. */
export function runWhenOnline(fn: () => void): boolean {
  if (typeof navigator === "undefined" || navigator.onLine !== false) { fn(); return true; }
  window.addEventListener("online", () => fn(), { once: true });
  return false;
}

/** Why a warm-up produced no reply: `no-worker` — no active service worker
 * to post to (none registered, or none active within warmTarget's wait);
 * `timeout` — an active worker got the message but did not answer in time. */
export type WarmOutcome = WarmReply | "no-worker" | "timeout";

/** Ask the service worker to cache the runtime's chunks and the manifests
 * (its `warm` message: through the HTTP cache, so bytes a boot just
 * downloaded are not downloaded twice; prunes chunks of superseded
 * runtimes). Needs no page control, so it works on the very first visit —
 * but a worker must have registered and activated (warmTarget). Null when
 * there is no service worker, or no reply in time. */
export function warmRuntimeCache(runtime: RuntimeManifest, extraUrls: readonly string[] = [], timeoutMs = 120000, how: WarmWait = {}): Promise<WarmReply | null> {
  return warmRuntimeCacheOutcome(runtime, extraUrls, timeoutMs, how).then((o) => (typeof o === "string" ? null : o));
}

/** warmRuntimeCache, telling a missing worker from a silent one (game-boot
 * re-warms on `serviceWorker.ready` only for the former: `ready` has
 * already resolved for an active worker, so a re-warm armed on a timeout
 * fired at once and repeated every timeout without limit). `revalidated`:
 * this page has just revalidated the data files among `extraUrls` (the
 * boot's early `warm-data`) — even the first round only fetches what the
 * cache lacks (R4). `opts.patient` / `opts.onWait`: S1 (WarmWait) — every
 * round's worker is waited for without a fixed cap; a caller that joins the
 * warm-up in flight hears its wait too (R2-1). */
export function warmRuntimeCacheOutcome(runtime: RuntimeManifest, extraUrls: readonly string[] = [], timeoutMs = 120000, opts: { revalidated?: boolean } & WarmWait = {}): Promise<WarmOutcome> {
  // D2: `extraUrls` — the bound game's data and i18n files (game-boot
  // offlineDataUrls) — ride in the SAME message as the runtime list: the
  // worker's prune keeps exactly the chunks the message names, so a
  // data-only message would prune the runtime. One warm-up in flight per
  // (build, extras) set; a Prepare's plain warm-up and the boot's warm-up
  // with extras may overlap — the worker dedupes the fetches per URL. S1: a
  // patient warm-up never joins one that gives up on a missing worker.
  const buildId = `${runtime.buildId}|${opts.patient ? "patient|" : ""}${[...extraUrls].sort().join(" ")}`;
  if (warmInFlight?.buildId === buildId) {
    // R2-1: a joiner hears the wait in flight (WarmWaiters).
    const { wait } = warmInFlight;
    if (opts.onWait) { wait.listeners.add(opts.onWait); if (wait.waiting) opts.onWait(true); }
    return warmInFlight.p;
  }
  const wait: WarmWaiters = { waiting: false, listeners: new Set(opts.onWait ? [opts.onWait] : []) };
  const how: WarmWait = { patient: opts.patient, onWait: (waiting) => { wait.waiting = waiting; for (const l of wait.listeners) l(waiting); } };
  const p = (async (): Promise<WarmOutcome> => {
    // N5: the game data first — the worker works through the list in order
    // (bounded concurrency): the small files an offline inventory opens are
    // cached in seconds, not after 147 MB of runtime chunks.
    // B4: the runtime's chunks (qed64's runtimeUrls), NOT its manifests nor
    // the snapshot and profile indexes: those are in the shell precache
    // (scripts/build-sw.mjs) — a copy warmed into the RUNTIME cache went
    // stale behind the shell's own and outlived the shell's pruning.
    const urls: string[] = [...new Set([...extraUrls, ...runtimeUrls(runtime).chunks])];
    // SEC1: the service worker fetches and caches exactly what it is sent —
    // same-origin urls only (resolveRuntimeManifest refused a manifest with
    // a foreign chunk already; the worker filters again on its side).
    const foreign = urls.filter((u) => !isSameOrigin(u));
    if (foreign.length) {
      console.warn(`[game-cache] runtime warm-up: ${foreign.length} url(s) on another origin left out (first: ${foreign[0]})`);
      for (const u of foreign) urls.splice(urls.indexOf(u), 1);
    }
    // On a slow link one message cannot cover the 154 MB runtime (the
    // worker answers `partial`): send it again while a round makes progress
    // (warmRoundProgressed) — every caller (the boot's warm-up, a
    // landing-page Prepare) gets the continuation; each round has `timeoutMs`.
    let last: WarmReply | null = null;
    let linkRetried = false;
    // R4: the data files are revalidated by the first round that reaches the
    // host; from then on a round fetches only what the cache lacks (each
    // round used to re-fetch every one of them — `max-age=0,
    // must-revalidate`: thousands of revalidations over a slow-link
    // Prepare's rounds). A data file a cut-short first round did not reach
    // keeps its held copy until the next visit; the pages the game opens
    // refresh theirs network-first anyway.
    let revalidate = !opts.revalidated;
    for (let round = 0; round < WARM_ROUNDS; round++) {
      const target = await warmTarget(how);
      if (!target) return last ?? "no-worker";
      const reply = await new Promise<WarmReply | "timeout">((resolve) => {
        const ch = new MessageChannel();
        const t = window.setTimeout(() => resolve("timeout"), timeoutMs);
        ch.port1.onmessage = (e) => { window.clearTimeout(t); resolve(e.data as WarmReply); };
        // pageFillsShell: this page asks for the shell itself (sw-client
        // requestShellFill) when no download runs — the worker must not
        // start its own fill behind a warm-up a Prepare's region competes with.
        target.postMessage({ type: "warm", urls, pageFillsShell: true, revalidate }, [ch.port2]);
      });
      if (reply === "timeout") return last ?? "timeout";
      const step = warmRoundStep(last, reply, linkRetried);
      last = reply;
      if (!reply.linkDown) revalidate = false;
      if (step === "stop" && heldButNotRevalidated(reply)) console.info(`[game-cache] runtime warm-up: all ${reply.total} files are held — the connection failed, so they were not revalidated`);
      if (step === "stop") return reply;
      linkRetried = step === "retry";
      if (linkRetried) {
        console.info(`[game-cache] runtime warm-up: the connection failed at ${reply.cached}/${reply.total} files — one more round in ${LINK_RETRY_MS / 1000} s`);
        await new Promise<void>((r) => window.setTimeout(r, LINK_RETRY_MS));
        continue;
      }
      const got = typeof reply.bytes === "number" && reply.bytes > 0 ? ` (+${(reply.bytes / 1e6).toFixed(1)} MB of chunks this round)` : "";
      console.info(`[game-cache] runtime warm-up: ${reply.cached}/${reply.total} files so far${got} — continuing (round ${round + 2})`);
    }
    return last ?? "timeout";
  })();
  warmInFlight = { buildId, p, wait };
  warmWaits.add(wait);
  p.finally(() => { warmWaits.delete(wait); if (warmInFlight?.p === p) warmInFlight = null; }).catch(() => {});
  return p;
}

/** N5: cache the bound game's data (inventory docs first) as soon as its
 * URLs are known — when a service worker is ALREADY active (a returning
 * visit); null otherwise (a first visit's worker registers at markServed,
 * whose warm-up names the data first). Its own message type (`warm-data`):
 * a previous deploy's worker ignores it, where a data-only `warm` would
 * have pruned its whole runtime cache. Data only — never a chunk, never a
 * prune. */
export async function warmDataEarly(urls: readonly string[], timeoutMs = 60000): Promise<WarmReply | null> {
  urls = urls.filter((u) => isSameOrigin(u)); // SEC1: as warmRuntimeCacheOutcome
  if (!urls.length || !("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  const target = reg?.active;
  if (!target) return null;
  return new Promise<WarmReply | null>((resolve) => {
    const ch = new MessageChannel();
    const t = window.setTimeout(() => resolve(null), timeoutMs);
    ch.port1.onmessage = (e) => { window.clearTimeout(t); resolve(e.data as WarmReply); };
    target.postMessage({ type: "warm-data", urls: [...urls] }, [ch.port2]);
  });
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
  /** The region's outcome once it settled (qed64's prefetchRaw status). */
  result?: PrefetchRawResult["status"];
  /** Why it failed, in words (the tile shows it). */
  error?: string;
  /** Runtime files the service worker holds after the warm-up (null: no
   * service worker answered — the boot's own warm-up retries). */
  runtime?: WarmReply | null;
  /** S1: the warm-up waits for this site's service worker to finish
   * installing (a first visit) — the tile says so. */
  awaitingWorker?: boolean;
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

/** L12: another tab changed the cache — this tab's BUSY refusals (the
 * "Already being downloaded…" of a file the other tab held) describe a state
 * that is over; dropped, the tile shows what the re-probe finds. Only those:
 * a genuine local failure ("Preparation failed: …" + Retry, or `unavailable`
 * whose tile deliberately hides the button) is this tab's own fact and stays.
 * `stale` narrows it to some names (D3: queryRemoteDownloads). */
function clearFailedPrepares(stale: (name: string) => boolean = () => true): void {
  const store = getDefaultStore();
  const cur = store.get(prepareStatusesAtom);
  const kept = Object.fromEntries(Object.entries(cur).filter(([name, st]) => !(st.phase === "failed" && st.result === "busy" && stale(name))));
  if (Object.keys(kept).length !== Object.keys(cur).length) store.set(prepareStatusesAtom, kept);
}

/** A prepare in flight: `region` settles when the raw region is committed
 * to OPFS (or failed) — what a game switch waits for before its reload;
 * `all` when the runtime warm-up has settled too — what the tile shows as
 * done. */
interface InFlightPrepare { region: Promise<PrepareStatus>; all: Promise<PrepareStatus>; downloading: () => boolean }
const inFlight = new Map<string, InFlightPrepare>();
let memoryNoteShown = false;

/** A Prepare of this snapshot runs in this page (its region or its
 * warm-up): its words to the other tabs (D2) are the Prepare's. */
export const prepareRunning = (name: string): boolean => inFlight.has(name);

/** The region of this snapshot's running Prepare (settles once it is
 * committed, or failed), or null: what the boot of the same game waits for
 * before its session starts (game-boot PAR-2). */
export const inFlightPrepare = (name: string): Promise<PrepareStatus> | null => inFlight.get(name)?.region ?? null;

/** Every running prepare's region promise (the game-switch reload waits for
 * all of them: a reload kills the workers and discards their partials). */
export const inFlightRegions = (): { name: string; region: Promise<PrepareStatus> }[] =>
  [...inFlight].map(([name, f]) => ({ name, region: f.region }));

/** R2-2 (review of S1): a Prepare of this page downloads — its region
 * streams, or its warm-up runs rounds. One whose region is in and whose
 * warm-up waits for a service worker downloads nothing: a game page's
 * deferred registration (sw-client, busy = game-boot leanDownloadInFlight)
 * is what it waits for, and must not wait for it in turn — that held the
 * registration to its 30-minute cap when the boot was never served. */
export const preparesDownloading = (): boolean => [...inFlight.values()].some((f) => f.downloading());

/** The terminal outcome a Prepare reports to the other tabs (D3), from the
 * structured status only (CQ1: "stalled" was read off the error's wording). */
function prepareOutcome(st: PrepareStatus): string {
  if (st.phase === "failed") return st.result === "busy" || st.result === "unavailable" ? st.result : "failed";
  return st.runtime && (!st.runtime.partial || heldButNotRevalidated(st.runtime)) ? "done" : "partial"; // N1: all held is done
}

/** "Prepare offline": the raw region into OPFS (qed64's prefetchRaw) and
 * the runtime chunks plus the game's own files (D6: `gameId` — game.json,
 * every level file, inventory.json and its docs, the i18n namespaces of
 * `langs` and English) into the service worker's cache, concurrently,
 * without booting Lean. Idempotent per snapshot while running. The region's
 * prefetch is single-flight in this page: a boot of this game while the
 * Prepare runs (the player opens the tile's game) waits for the Prepare's
 * region before its session starts (inFlightPrepare) — a region that failed
 * is then fetched afresh by the session's own prefetch, not streamed by the
 * Lean worker — and a Prepare started while the boot's session prefetches
 * joins that prefetch worker (it used to be refused `busy`). Across tabs the
 * writer holds the region's Web Lock; another tab's writer makes the region
 * `busy` here at once (the tile then says so). The worker lives in this
 * document, so navigating within the app keeps it going; a full page reload
 * kills it (the partial is discarded on the next run). `sessionBound`: a game
 * session is loaded in this page — allowed (the inflate runs in its own
 * worker), but a small device is told once. A region already in OPFS settles
 * at once (`cached`): the landing tile's "Finish offline download" is this
 * call. */
export function prepareGame(entry: SnapshotEntry, opts: { sessionBound?: boolean; gameId?: string; langs?: readonly string[] } = {}): Promise<PrepareStatus> {
  const existing = inFlight.get(entry.name);
  if (existing) return existing.all;
  const deviceGb = (navigator as { deviceMemory?: number }).deviceMemory;
  const memoryNote = !!opts.sessionBound && typeof deviceGb === "number" && deviceGb < 8 && !memoryNoteShown;
  if (memoryNote) memoryNoteShown = true;
  let status: PrepareStatus = { phase: "running", bytes: 0, total: entry.bytes, memoryNote };
  // D2: every state change is this tab's word to the others (the heartbeat
  // sends the latest once a second).
  const transfer = entry.transfer ?? entry.bytes;
  const show = (st: PrepareStatus) => {
    publish(entry.name, st);
    if (st.phase === "running" || st.phase === "warming") reportDownload(entry.name, { phase: st.phase, bytes: st.bytes, total: st.total, transfer });
  };
  show(status);
  // D6: the game's files ride in the SAME message as the runtime list (the
  // worker's prune keeps exactly the chunks a message names — a data-only
  // `warm` would prune the runtime), listed from its game.json and
  // inventory.json. Without a gameId (a caller that predates D6) the runtime
  // alone, as before — the tile then reads the game's files as missing.
  // S1: a first visit's service worker may still be installing (or, R2-2,
  // this page's registration is still deferred) — waited for (no fixed
  // cap), and said on the tile while the Prepare runs; R2-1: also when this
  // Prepare joined the wait of an earlier one (a Retry).
  const onWait = (waiting: boolean) => {
    status = { ...status, awaitingWorker: waiting };
    if (status.phase === "running" || status.phase === "warming") show(status);
  };
  const warm = resolveRuntimeManifest().then(async (m) => {
    const data = opts.gameId ? await fetchGameDataUrls(opts.gameId, opts.langs ?? []) : [];
    const reply = await warmRuntimeCache(m, data, 10 * 60 * 1000, { patient: true, onWait });
    // R3: the images the level texts embed are known only from the level
    // files — read from the cache the warm-up just filled (no download), and
    // cached by one data-only `warm-data` (never a chunk, never a prune).
    // Not essential: the outcome is the warm-up's.
    if (reply && !reply.linkDown && opts.gameId) {
      const images = await cachedLevelImageUrls(opts.gameId, data);
      const r = images.length ? await warmDataEarly(images) : null;
      if (r) console.info(`[game-cache] prepare ${entry.name}: ${r.cached}/${r.total} images of the level texts cached`);
    }
    return reply;
  }).catch((e) => {
    console.warn("[game-cache] runtime warm-up skipped:", e);
    return null;
  });
  const region = (async (): Promise<PrepareStatus> => {
    const r = await prefetchRaw(entry, {
      onProgress: ({ loaded, total }) => {
        status = { ...status, bytes: loaded, total };
        show(status);
      },
    });
    const ok = r.status === "done" || r.status === "cached";
    // HARDENING #54: `silent` — the prefetch reported nothing for
    // PREFETCH_SILENCE_MS (it reports every 500 ms while bytes arrive), so
    // only a dead connection or a wedged worker; its partial is gone.
    const error = r.status === "silent" ? `the download stalled (no data for ${PREFETCH_SILENCE_MS / 60_000} minutes)` : r.error?.message;
    status = ok ? { ...status, phase: "warming", bytes: entry.bytes, result: r.status } : { ...status, phase: "failed", result: r.status, error };
    show(status);
    if (ok) notifyCacheChanged(); // L12: the region is committed — other tabs re-probe
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
    // The phase stays 'warming' (the tile: "caching the checker…") through
    // every round of the runtime warm-up; what is still missing after them
    // is the tile's to say (it reads the service worker's cache: `partial`).
    const runtime = await warm;
    status = { ...status, phase: "done", runtime };
    publish(entry.name, status);
    const short = !runtime?.partial ? "" : heldButNotRevalidated(runtime) ? " — all held, not revalidated (the connection failed)" // N1
      : runtime.linkDown ? " — INCOMPLETE (the connection failed)" : " — INCOMPLETE (the warm-up stopped making progress)";
    console.info(`[game-cache] prepare ${entry.name}: region ${status.result}; runtime ${runtime ? `${runtime.cached}/${runtime.total} files cached${short}` : "not warmed"}`);
    return status;
  })();
  inFlight.set(entry.name, { region, all, downloading: () => status.phase === "running" || !status.awaitingWorker });
  // D3: every terminal outcome is said to the other tabs (a failure used to
  // say nothing, and their "Already being downloaded…" stayed for good).
  all.then((st) => endDownload(entry.name, prepareOutcome(st)), () => endDownload(entry.name, "failed"))
    .finally(() => { inFlight.delete(entry.name); stopHearingWarmWait(onWait); }).catch(() => {});
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
  const dir = await snapshotCacheDir();
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
