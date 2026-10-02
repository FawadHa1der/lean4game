/**
 * The page's side of the service worker (client/src/sw/sw.template.js):
 * when it registers, and the post-activation fill of the app shell.
 *
 * N2: the worker used to precache the whole shell (235 files, ~30 MB) in its
 * install event. On a slow first visit (300 kB/s shared with the 147 MB
 * runtime and the game snapshot) that install outlasted Chromium's 300 s
 * install-event timeout: the version went redundant, the registration was
 * deleted, `navigator.serviceWorker.ready` never settled, the offline warm-up
 * never ran and the game was not offline-playable after the visit. Now:
 *  1. the install caches only the CRITICAL shell (what a level page needs to
 *     render offline: document, every /assets script/wasm/JSON/CSS, the
 *     infoview, the English locale, worker scripts, manifests, /api/games —
 *     ~18 MB, mostly answered by the HTTP cache); the rest (fonts, KaTeX,
 *     other locales, icons, tile images) is filled after activation on the
 *     page's `warm-shell` message (requestShellFill), posted only while no
 *     Lean download runs in this page, to THIS build's worker;
 *  2. a page that boots a game defers the registration until the game is
 *     served (releaseServiceWorkerRegistration, from game-boot's markServed)
 *     or — after 60 s — until no Lean download runs (at most BUSY_CAP_MS from
 *     load), so even the small install never competes with the
 *     runtime/snapshot download; the landing page registers on load;
 *  3. a registration that vanished (an install that timed out anyway) is
 *     re-registered once when the offline warm-up needs a worker
 *     (ensureServiceWorkerRegistration).
 * Production only: the dev server serves no sw.js.
 */

const SW_URL = "/sw.js";
/** (2) the longest a game page holds the registration back. */
const DEFER_MS = 60_000;

const supported = (): boolean => import.meta.env.PROD && typeof navigator !== "undefined" && "serviceWorker" in navigator;

let registration: Promise<ServiceWorkerRegistration | null> | null = null;
let reRegistered = false;
/** The game was served before the window's load event (a fast returning boot). */
let served = false;

function register(why: string): Promise<ServiceWorkerRegistration | null> {
  registration ??= navigator.serviceWorker.register(SW_URL).then(
    (reg) => { console.info(`[sw] registered (${why})`); return reg; },
    (e) => { console.warn("[sw] registration failed:", e); return null; },
  );
  return registration;
}

/** index.tsx, on the window's `load`: register now (the landing page), or —
 * when this page boots a game — once it is served, or after DEFER_MS once no
 * Lean download is in flight. */
export function scheduleServiceWorkerRegistration(opts: { deferForBoot: boolean; busy: () => boolean }): void {
  if (!supported() || registration) return;
  if (!opts.deferForBoot || served) {
    void register(served ? "game served before load" : "page loaded");
    // The landing page fills the shell now (between Prepares); a game page
    // asks from markServed.
    if (!opts.deferForBoot) void requestShellFill(opts.busy);
    return;
  }
  console.info(`[sw] registration deferred until the game is served (or, after ${DEFER_MS / 1000} s, until no Lean download is in flight)`);
  // The fallback is for a game page that is never served (an unknown game, a
  // failed or halted boot). It must not start the install while the runtime
  // or the game snapshot is still downloading: on one shared HTTP/2
  // connection the install's critical set (≈17 MB) then crawls at a fraction
  // of the link and came within 20 s of Chromium's 300 s install-event limit
  // at 300 kB/s (live, 2026-10-02: 279.8 s). Waiting for the download makes
  // the install run on an idle link (≈1 min at 300 kB/s). Capped at
  // BUSY_CAP_MS like the shell fill, so a stuck download cannot block it.
  const fallbackFrom = Date.now();
  const fallback = () => {
    if (registration) return;
    const busyNow = opts.busy();
    if (busyNow && Date.now() - fallbackFrom < BUSY_CAP_MS) { window.setTimeout(fallback, 5000); return; }
    const after = `${Math.round((Date.now() - fallbackFrom) / 1000)} s after load`;
    void register(busyNow ? `${after}, a Lean download still in flight after the ${BUSY_CAP_MS / 60_000} min cap` : `${after}, no Lean download in flight`);
    void requestShellFill(opts.busy);
  };
  window.setTimeout(fallback, DEFER_MS);
}

/** game-boot's markServed: the Lean download is over — register now. */
export function releaseServiceWorkerRegistration(): void {
  served = true;
  if (!supported() || registration) return;
  // Before the window's load event, index.tsx's own load handler decides.
  if (document.readyState !== "complete") return;
  void register("game served");
}

/** The registration started by this page, if any (warmTarget awaits it
 * instead of polling getRegistration while a deferred register settles). */
export function pendingServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> | null {
  return registration;
}

/** (3) The offline warm-up found no worker to post to. Start the deferred
 * registration if it has not happened yet; if it happened and the
 * registration is gone (its install timed out → redundant → deleted),
 * register again — once per page. True when a registration is (again)
 * under way, so `serviceWorker.ready` can be awaited. */
export async function ensureServiceWorkerRegistration(): Promise<boolean> {
  if (!supported()) return false;
  if (!registration) return (await register("warm-up needs a worker")) !== null;
  const had = await registration;
  const now = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  if (now) return true;
  // Already registered again (possibly by another waiter, still settling):
  // that registration decides — its promise is the current `registration`.
  if (reRegistered) return registration !== null && (await registration) !== null;
  reRegistered = true;
  console.warn(`[sw] the registration is gone${had ? " (the install did not complete)" : ""} — registering again`);
  registration = null;
  return (await register("re-register after a lost registration")) !== null;
}

/** (3) Resolve once a service worker is active — like
 * `navigator.serviceWorker.ready`, which never settles when the registration
 * is deleted under it (an install that hit Chromium's 300 s install-event
 * timeout: the version went redundant and, as the first version, took the
 * registration with it). While waiting, the registration is looked up every
 * 10 s; when it is gone it is registered again (once per page —
 * ensureServiceWorkerRegistration). False after `capMs`, or when no
 * registration can be had. */
let readyWatch: Promise<boolean> | null = null;
export function whenServiceWorkerReady(capMs = 30 * 60_000): Promise<boolean> {
  // One watcher per page: the warm-up and the shell fill both wait here, and
  // two watchers raced each other's re-registration (one saw the
  // registration missing while the other's register() was still settling,
  // gave up, and the offline warm-up never ran).
  readyWatch ??= watchServiceWorkerReady(capMs).then((ok) => { if (!ok) readyWatch = null; return ok; });
  return readyWatch;
}

async function watchServiceWorkerReady(capMs: number): Promise<boolean> {
  if (!supported()) return false;
  const sw = navigator.serviceWorker;
  let settled = false;
  const ready = sw.ready.then(() => true);
  const watch = (async () => {
    const until = Date.now() + capMs;
    while (!settled && Date.now() < until) {
      await new Promise<void>((r) => window.setTimeout(r, 10_000));
      if (settled) break;
      const reg = await sw.getRegistration().catch(() => undefined);
      if (reg?.active) return true;
      if (!reg && !(await ensureServiceWorkerRegistration())) return false;
    }
    return false;
  })();
  const ok = await Promise.race([ready, watch]);
  settled = true;
  return ok;
}

export interface ShellFillReply { type: "shell-filled"; version?: string; current?: boolean; present: number; total: number; fetched: number; failed: number; complete: boolean; pruned: number }

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/** This page's entry script (/assets/index-<hash>.js), which names its
 * build: the worker answers `current: false` to a page whose entry is not in
 * its precache list (a worker of another deploy). */
function entryScript(): string | undefined {
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute("src");
  if (!src) return undefined;
  try { return new URL(src, window.location.href).pathname; } catch { return undefined; }
}

/** Resolve once `reg` has no installing or waiting worker (each settles at
 * activated or redundant), at most `capMs`. */
async function settled(reg: ServiceWorkerRegistration, capMs = 60_000): Promise<void> {
  const until = Date.now() + capMs;
  for (let pending = reg.installing ?? reg.waiting; pending && Date.now() < until; pending = reg.installing ?? reg.waiting) {
    const w = pending;
    await new Promise<void>((resolve) => {
      const t = window.setTimeout(done, Math.max(0, until - Date.now()));
      function done() { window.clearTimeout(t); w.removeEventListener("statechange", on); resolve(); }
      function on() { if (w.state === "activated" || w.state === "redundant") done(); }
      w.addEventListener("statechange", on);
      on();
    });
    // A worker that turned activated is reg.active now; a waiting worker
    // that never activates (another tab holds the old one) ends at the cap.
    if (reg.installing === w || reg.waiting === w) { if (Date.now() >= until) break; await wait(100); }
  }
}

/** Post `warm-shell` to `target`; null when it does not answer within
 * `ms` (a previous deploy's worker ignores the message), or when it goes
 * redundant (replaced by an update) or another worker takes control first. */
function askShellFill(target: ServiceWorker, ms: number): Promise<ShellFillReply | null> {
  const sw = navigator.serviceWorker;
  return new Promise<ShellFillReply | null>((resolve) => {
    const ch = new MessageChannel();
    const finish = (r: ShellFillReply | null) => {
      window.clearTimeout(t);
      target.removeEventListener("statechange", onState);
      sw.removeEventListener("controllerchange", onControl);
      ch.port1.onmessage = null;
      resolve(r);
    };
    const t = window.setTimeout(() => finish(null), ms);
    const onState = () => { if (target.state === "redundant") finish(null); };
    const onControl = () => { if (sw.controller && sw.controller !== target) finish(null); };
    target.addEventListener("statechange", onState);
    sw.addEventListener("controllerchange", onControl);
    ch.port1.onmessage = (e) => finish(e.data as ShellFillReply);
    target.postMessage({ type: "warm-shell", entry: entryScript() }, [ch.port2]);
  });
}

let shellFill: Promise<ShellFillReply | null> | null = null;
/** The longest the shell fill, and the deferred registration's fallback,
 * wait for this page's Lean download to end. */
const BUSY_CAP_MS = 30 * 60_000;
/** Rounds that made progress, and worker switches, are each bounded. */
const MAX_ROUNDS = 20;
const MAX_SWITCHES = 4;

/** (1) Ask THIS build's active worker to fill the rest of its precache list
 * into its shell cache: repeated rounds (the worker bounds each to well
 * under the 5-minute event limit) while the shell is incomplete and the
 * last round made progress; before each round it waits while `busy()` (a
 * Lean download in this page) holds — at most BUSY_CAP_MS in all.
 * A deploy: the page loads while the PREVIOUS deploy's worker is still
 * active and the update installs a few seconds later. Before each round
 * the registration's installing/waiting worker is awaited (an update check
 * is asked for first), and a round whose target goes redundant, loses
 * control, answers `current: false` (a worker of another build) or never
 * answers (the deployed previous worker ignores `warm-shell`) is re-posted
 * to the then-active worker. A complete fill is kept for the page; any
 * other outcome is forgotten, so a later call (markServed after the landing
 * page's) tries again. */
export function requestShellFill(busy: () => boolean = () => false): Promise<ShellFillReply | null> {
  if (!supported()) return Promise.resolve(null);
  if (shellFill) return shellFill;
  const p = runShellFill(busy).catch((e) => { console.warn("[sw] shell fill skipped:", e); return null; });
  shellFill = p;
  void p.then((r) => { if (!r?.complete && shellFill === p) shellFill = null; });
  return p;
}

async function runShellFill(busy: () => boolean): Promise<ShellFillReply | null> {
  const sw = navigator.serviceWorker;
  if (!(await whenServiceWorkerReady())) return null; // no registration to be had: nothing runs
  const reg = await sw.ready;
  const busyUntil = Date.now() + BUSY_CAP_MS;
  let last: ShellFillReply | null = null;
  let checkedUpdate = false;
  for (let round = 0, switches = 0; round < MAX_ROUNDS; ) {
    while (busy() && Date.now() < busyUntil) await wait(5000);
    // The page may have loaded under the previous deploy's worker: let the
    // update check (the browser's own after the navigation, or this one)
    // install and activate this build's worker before posting.
    if (!checkedUpdate) { checkedUpdate = true; await reg.update().catch(() => undefined); }
    await settled(reg);
    const target = reg.active ?? (await sw.ready).active;
    if (!target) return last;
    const reply = await askShellFill(target, 150_000); // the worker aborts its fill at 2 min
    const switched = reg.active !== null && reg.active !== target;
    if (!reply || reply.type !== "shell-filled" || reply.current === false) {
      // Not this build's answer. Another worker is active now (or an update
      // is still to come): ask again, without counting a round.
      if (++switches > MAX_SWITCHES) { console.warn("[sw] shell fill: this build's service worker never answered"); return last; }
      if (!switched) {
        if (reply?.current === false) { await reg.update().catch(() => undefined); await settled(reg); }
        if (reg.active === target) { console.warn(`[sw] shell fill: ${reply ? `the active service worker is another build's (${reply.version ?? "unknown"})` : "no answer from the service worker"}`); return last; }
      }
      continue;
    }
    const progressed = !last || reply.present > last.present;
    last = reply;
    round += 1;
    console.info(`[sw] shell fill: ${reply.present}/${reply.total} shell files cached${reply.complete ? " — complete" : ""}${reply.failed ? `, ${reply.failed} failed` : ""}${reply.pruned ? `, ${reply.pruned} superseded shell cache(s) pruned` : ""}${reply.version ? ` (worker ${reply.version})` : ""}`);
    if (switched) { last = null; continue; } // answered for the outgoing build's shell: start over on the new worker
    if (reply.complete || !progressed) return reply;
  }
  return last;
}
