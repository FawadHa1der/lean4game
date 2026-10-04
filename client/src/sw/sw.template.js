/* lean4game service worker — offline reloads.
 *
 * Everything heavy already survives offline in the browser's own stores
 * (snapshots as raw regions in OPFS, the core library pack, the game data
 * cache); what died at the first byte was the page itself. This worker:
 *  - precaches the app shell in two steps (N2): the install caches only the
 *    CRITICAL shell — everything a level page needs to render offline (the
 *    document, every /assets script, wasm, grammar/theme JSON, stylesheet,
 *    the infoview, the English locale, the worker scripts, the artifact
 *    manifests, /api/games — ~18 MB, mostly answered by the HTTP cache);
 *    an install that cannot fetch one of them FAILS (the previous worker
 *    stays). The rest of the precache list (fonts, KaTeX, other locales,
 *    icons, tile images) is filled after activation on the page's
 *    "warm-shell" message, which the page posts only while no Lean download
 *    runs (and by this worker itself after a `warm` from a page that
 *    predates that message). A whole-shell install (235 files) competing with the 147 MB
 *    runtime and the snapshot on a 300 kB/s first visit outlasted
 *    Chromium's 300 s install-event timeout: the version went redundant and
 *    the registration was deleted. Both steps go through the HTTP cache, so
 *    a page that just downloaded a file pays no second download, and skip
 *    what the shell cache already holds; the shell document is stored as a
 *    fresh, redirect-free copy of "/" (a host that answers /index.html with
 *    a redirect to / would otherwise leave a redirected response, which
 *    browsers refuse for a navigation);
 *  - serves navigations network-first, falling back to the cached document;
 *  - serves content-addressed files cache-first (vite's hashed /assets,
 *    the digest-named runtime chunks) and everything else network-first
 *    with the cache as the offline fallback — so a new release's unhashed
 *    worker scripts are never served stale by an old worker;
 *  - honours cache: "reload" / "no-store" (the substrate's poison recovery
 *    refetches a chunk that failed verification) and never stores an HTML
 *    body under a non-HTML name (a single-page fallback page is not a chunk);
 *  - warms and prunes the runtime cache on a "warm" message from the page
 *    (the first visit's boot fetched the chunks before this worker
 *    controlled anything), keeping exactly the chunks of the current manifest;
 *  - keeps the previous shell cache one generation so tabs still on the
 *    old build can lazy-load their chunks after a deploy; while the current
 *    shell is incomplete it keeps two (an offline lookup may still need an
 *    unchanged file from them), never more.
 * Snapshots and library pack parts are never cached here (OPFS owns them).
 * Generated from client/src/sw/sw.template.js by scripts/build-sw.mjs after
 * every build; the precache list and version are substituted there.
 */
const VERSION = "__VERSION__";
const PRECACHE = __PRECACHE__;
/** The install-time subset of PRECACHE (scripts/build-sw.mjs). */
const CRITICAL = __CRITICAL__;
const SHELL = `l4g-shell-${VERSION}`;
const RUNTIME = "l4g-runtime-v1";
const DOC = "/index.html";

const isHashedAsset = (p) => /^\/assets\/[^/]+[-.][A-Za-z0-9_-]{8}\.[a-z0-9]+$/.test(p);
const isRuntimeChunk = (p) => /^\/runtime\/chunks\//.test(p);
const isBigFont = (p) => /NotoColorEmoji-Regular/.test(p);
const isNetworkOnly = (p) => /\.snapz$/.test(p) || /^\/profiles\/.*\.part-\d+$/.test(p);
const wantsHtml = (p) => p === "/" || /\.html?$/.test(p);
const storable = (p, res) => res.ok && (wantsHtml(p) || !/text\/html/i.test(res.headers.get("content-type") || ""));

/** A body-owning copy: `redirected` false, headers kept (COOP/COEP too). */
async function freshCopy(res) {
  return new Response(await res.arrayBuffer(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** Run `fn` over `items` in order with at most `n` in flight, starting no
 * new item after `deadline` or once `stop()` says so; true when every item
 * was run. */
async function pool(items, n, fn, deadline = Infinity, stop = () => false) {
  let next = 0;
  const lane = async () => {
    while (next < items.length && Date.now() < deadline && !stop()) {
      const k = next++;
      try { await fn(items[k], k); } catch { /* fn reports its own failures */ }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, lane));
  return next >= items.length;
}

/** The paths the shell cache holds (pathnames). */
async function shellHas() {
  const cache = await caches.open(SHELL);
  return new Set((await cache.keys()).map((r) => new URL(r.url).pathname));
}

/** D7: a fetch() that rejected with no answer and no abort — the link is
 * down (offline, a refused tunnel, DNS), not the host's word on one file.
 * An abort rejects with an AbortError, an HTTP error resolves. */
const isLinkFailure = (e, signal) => !!e && e.name === "TypeError" && !signal?.aborted;

/** Fetch `paths` into the shell cache (skipping what it holds); the shell
 * document always as a fresh, redirect-free copy of "/" under both names.
 * Returns {fetched, refused, errors, done, linkDown}: `refused` = the host
 * answered, but not with a storable copy (404, an HTML fallback for a
 * non-HTML name). `failFast` (D7, the "warm-shell" fill): no fetch is
 * started after the first link failure (`linkDown`) — offline, an
 * incomplete shell's every missing file failed one by one, round after
 * round. Not for the install's first pass: one dropped connection must not
 * leave the rest to its single retry pass. */
async function fillShell(paths, { concurrency = 6, deadline = Infinity, freshDoc = false, signal = undefined, failFast = false } = {}) {
  const cache = await caches.open(SHELL);
  const have = await shellHas();
  let fetched = 0, refused = 0, errors = 0, linkDown = false;
  const todo = paths.filter((p) => p !== DOC && !have.has(p));
  const done = await pool(todo, concurrency, async (p) => {
    let res;
    try { res = await fetch(new Request(p), { signal }); } catch (e) { errors += 1; if (isLinkFailure(e, signal)) linkDown = true; throw e; }
    if (!storable(p, res)) { refused += 1; throw new Error(`${p}: ${res.status} ${res.headers.get("content-type") || ""}`); }
    try { await cache.put(p, res); fetched += 1; } catch (e) { errors += 1; throw e; }
  }, deadline, () => failFast && linkDown);
  if ((freshDoc || !have.has(DOC) || !have.has("/")) && !(failFast && linkDown)) {
    try {
      const doc = await fetch(new Request("/", { cache: "no-cache" }), { signal });
      if (doc.ok) { const copy = await freshCopy(doc); await cache.put(DOC, copy.clone()); await cache.put("/", copy); fetched += 1; }
      else refused += 1;
    } catch (e) { errors += 1; if (isLinkFailure(e, signal)) linkDown = true; }
  }
  return { fetched, refused, errors, done, linkDown };
}

/** Delete superseded shell caches, keeping the newest `keep` previous ones
 * (a tab still on the previous build lazy-loads its hashed chunks from the
 * newest). `keep` is 1 once the current shell is complete; 2 while it is
 * not (an offline lookup may still need an unchanged file from the newest
 * previous shell, and one generation more covers a fill interrupted across
 * a deploy) — never more, so a fill that keeps failing (a quota error, a
 * path that never fetches) does not grow storage by a shell per deploy. */
async function pruneShells(keep = 1) {
  const shells = (await caches.keys()).filter((n) => n.startsWith("l4g-shell-") && n !== SHELL);
  const doomed = shells.slice(0, Math.max(0, shells.length - keep));
  for (const name of doomed) await caches.delete(name);
  return doomed.length;
}

/** Every precache path is in the shell cache (or the host refused it in the
 * last fill — `refusedPaths`: a 404 for a file this host does not serve
 * must not keep superseded shells alive for good). */
let refusedPaths = new Set();
async function shellComplete() {
  const have = await shellHas();
  return PRECACHE.every((p) => have.has(p) || refusedPaths.has(p)) && have.has("/");
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    // N2: the critical shell only — small, and mostly answered by the HTTP
    // cache (the page just loaded its document, entry chunks and workers).
    let r = await fillShell(CRITICAL, { concurrency: 6, freshDoc: true });
    // One more pass for what a transient error cut (a dropped connection on
    // a slow link): fillShell skips what the first pass stored.
    if (r.errors) r = await fillShell(CRITICAL, { concurrency: 6 });
    if (r.refused || r.errors) console.warn(`[sw] install: ${r.refused + r.errors} of ${CRITICAL.length} critical shell files not cached`);
    // A network failure (or a cache.put failure) on a critical file, or no
    // shell document, fails the install: the previous worker (whose shell is
    // complete) stays in control and the browser retries at its next update
    // check. Activating would leave a shell without its document or entry
    // chunks — offline, lookup's global fallback then mixes the previous
    // build's document with this build's workers and manifests. A refusal
    // (404: a path this host does not serve) is tolerated.
    const have = await shellHas();
    if (r.errors > 0 || !have.has(DOC) || !have.has("/")) throw new Error(`[sw] install: the critical shell is incomplete (${r.errors} network/storage errors${have.has(DOC) ? "" : ", no shell document"})`);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Superseded shells: all but the newest previous one once this shell is
    // complete, all but the newest two while it is not (a fill that
    // completes later prunes down to one then).
    await pruneShells((await shellComplete()) ? 1 : 2);
    await self.clients.claim();
  })());
});

const headOf = (res) => new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
const bypass = (req) => req.cache === "reload" || req.cache === "no-store";

/** A cached answer, this build's shell first. The previous shell cache is
 * kept one generation (its tabs lazy-load their chunks from it) and was
 * created earlier, so a global caches.match would find ITS copy of every
 * unhashed name first — offline after a deploy, the old build's document,
 * worker scripts and snapshot index were served for the new one. */
async function lookup(req, opts) {
  for (const name of [SHELL, RUNTIME]) {
    const hit = await (await caches.open(name)).match(req, opts);
    if (hit) return hit;
  }
  return caches.match(req, opts);
}

async function putIfStorable(cacheName, req, res) {
  const p = new URL(req.url).pathname;
  if (req.method !== "GET" || !storable(p, res)) return;
  try { await (await caches.open(cacheName)).put(req, res.clone()); } catch { /* quota */ }
}

async function cacheFirst(req, cacheName) {
  if (!bypass(req)) {
    const hit = await lookup(req, { ignoreMethod: req.method === "HEAD" });
    if (hit) return req.method === "HEAD" ? headOf(hit) : hit;
  }
  const res = await fetch(req);
  await putIfStorable(cacheName, req, res);
  return res;
}

async function networkFirst(req, cacheName) {
  const p = new URL(req.url).pathname;
  let res = null;
  try { res = await fetch(req); } catch { /* offline */ }
  if (res && res.ok) { await putIfStorable(cacheName, req, res); return res; }
  // Offline, or a 404/5xx for something we hold (a redeployed shell no
  // longer serving an old hashed name): the cache is the answer.
  if (!bypass(req)) {
    const hit = await lookup(req, { ignoreMethod: req.method === "HEAD" });
    if (hit) return req.method === "HEAD" ? headOf(hit) : hit;
  }
  if (res) return res;
  // An offline miss on a game's i18n namespace: an empty dictionary (not
  // stored) — i18next then falls back to the keys, instead of retrying the
  // fetch six times with a console error each (the landing page asks for
  // every game's namespace; a first-visit page fetched them before this
  // worker controlled it, so they may be missing).
  if (/^\/i18n\//.test(p)) return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  throw new TypeError(`offline: ${p}`);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.method !== "GET" && req.method !== "HEAD") return;
  const p = url.pathname;
  if (isNetworkOnly(p)) return;
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try { return await fetch(req); } catch (err) {
        return (await lookup(p)) ?? (await lookup(DOC)) ?? Promise.reject(err);
      }
    })());
    return;
  }
  if (isHashedAsset(p) || isRuntimeChunk(p) || isBigFont(p)) { event.respondWith(cacheFirst(req, isHashedAsset(p) ? SHELL : RUNTIME)); return; }
  event.respondWith(networkFirst(req, PRECACHE.includes(p) ? SHELL : RUNTIME));
});

// Warm + prune the runtime cache on the page's request (it knows the
// manifest): fetch each URL through the HTTP cache (the boot just
// downloaded them), keep exactly the chunks of the current manifest. One
// fetch per URL at a time across concurrent warms (two tabs preparing at
// once): a second loop would miss every cache.match the first has not put
// yet and download the runtime again. The list is worked IN ORDER — the
// data files with at most WARM_CONCURRENCY fetches in flight (N5: the page
// names the game data first, so the inventory docs are cached in seconds,
// not after the runtime), the runtime chunks (16 MB each) CHUNK_CONCURRENCY
// at a time beside them. A message event that outlasts Chromium's 5-minute
// event limit gets the worker stopped, and six 16 MB chunks started at once
// on a slow link were all still in flight at 5 minutes — 98 MB transferred,
// nothing stored. So each message stops STARTING fetches after
// WARM_BUDGET_MS and ABORTS every fetch still running at WARM_HARD_MS (one
// AbortController per message): the event always settles inside the limit,
// every completed chunk is kept, and the reply says `partial: true` (the
// page sends the message again — game-cache warmRuntimeCacheOutcome; the
// HTTP cache can resume a cut chunk through the host's ETag + ranges).
// The page also names the bound game's data (/data/<id>/*.json — game,
// levels, inventory, docs — and /i18n/<id>/<lang>) in the same message: a
// first visit fetched them before this worker controlled the page, and an
// offline reload of that game then 404'd on them. They land in the runtime
// cache too, where the network-first path's offline fallback (lookup) finds
// them. Only content-addressed chunks are skipped when already cached; every
// other URL is fetched (through the HTTP cache — the page just loaded them)
// and REPLACES the stored copy on a storable answer, so a load this worker
// did not control (a Shift+Reload after a redeploy) still refreshes the
// previous deploy's level files; offline or a refused fetch keeps the old
// copy. A network-first hit through this worker also replaces the runtime
// copy of a path outside the precache list (a precached path's network-first
// write goes to the shell cache, which lookup reads first — so the page never
// names a precached path such as /api/games here). `prune: false` skips the
// chunk prune for a message that names no chunks; a partial pass never
// prunes. A `warm` without `pageFillsShell: true` (a page of a build that
// predates "warm-shell", controlled by this worker after a deploy) is
// followed by this worker's own shell fill, inside the same event's limit.
// "warm-data" (N5): the same for the game data alone, as soon as a page
// that found this worker already active knows the URLs — no chunk, no
// prune (its own type: a previous deploy's worker ignores it, where a
// data-only "warm" would have pruned its runtime cache).
// "warm-shell" (N2): fill the rest of the precache list into the current
// shell cache (idempotent: what the cache holds is skipped); prunes the
// superseded shells (down to one once the shell is complete, two before).
// Bounded per message like "warm" (start budget + hard abort); concurrent
// messages share one fill. The page names its entry script (`entry`): a
// worker of another build (a page that loaded while the previous deploy's
// worker was still active) answers `current: false` without filling, and the
// page waits for the update and asks the new worker.
// D1 (live 2026-10-03): the reply's `bytes` — runtime-chunk body bytes the
// message's fetches received beyond what an earlier round of this worker
// already had of that chunk (chunkHighWater), counted as they stream into
// cache.put, a fetch cut by the hard abort included: on a slow link a 16 MB
// chunk can take a whole round, and the page counted such a round as "no
// progress" (no whole file) and gave up with the runtime partly cached,
// although the HTTP cache resumes the chunk next round. The high-water mark
// keeps the prefix the HTTP cache replays before the resumed range from
// counting again (a link that stalls right after it is no progress). Data
// files are not counted: small, fetched whole (a completed one counts in
// `cached`).
// D7 (live 2026-10-03): fail fast on a dead link. Every non-chunk URL is
// fetched every round, and the loop went on after network errors: an offline
// boot of a cached game (RAG: 329 data files, named by the early `warm-data`
// and again by the boot's `warm`) fired ~800 failing GETs. After the first
// fetch of a message that rejects outright (isLinkFailure — not an abort,
// not an HTTP error) the message starts no more fetches: the rest are only
// looked up (cache.match), so `cached` still reports what an offline reload
// finds; the reply says `linkDown: true` and `partial: true` (nothing was
// verified against the host, nothing is pruned), and the page does not send
// another round for it unless that round gained something
// (warmRoundProgressed). Fetches already in flight run out (at most
// WARM_CONCURRENCY + CHUNK_CONCURRENCY). Per message: a later message tries
// the network again.
// R4 (review of D1/D6): `revalidate: false` — a held copy of ANY file
// answers for itself, as a chunk's always does; only what the cache lacks is
// fetched. The page sends it from the second round of one warm-up on (the
// first round revalidated the data files; game-cache warmRuntimeCacheOutcome)
// and for a boot whose early `warm-data` just did: every data file is served
// `max-age=0, must-revalidate`, and re-fetching all of them every round made
// a slow-link Prepare (RAG: 330 data files, up to WARM_ROUNDS rounds) send
// thousands of revalidations to the edge. Absent (a page of an older build):
// every data file is fetched, as before.
const WARM_CONCURRENCY = 6;
const CHUNK_CONCURRENCY = 1;
const WARM_BUDGET_MS = 3 * 60 * 1000;
const WARM_HARD_MS = 4 * 60 * 1000;
const SHELL_BUDGET_MS = 45 * 1000;
const SHELL_HARD_MS = 2 * 60 * 1000;
/** Chromium stops a worker whose event runs longer than this. */
const EVENT_LIMIT_MS = 5 * 60 * 1000;
/** url → { done: Promise<boolean>, gained: number } — one fetch per URL
 * across concurrent warms; `gained` is the job's D1 byte count. */
const warmFetches = new Map();
/** D1: per runtime chunk URL, the most body bytes any warm fetch of this
 * worker has received (cleared once the chunk is stored). Lost when the
 * browser stops the idle worker — the next round then counts the replayed
 * prefix once, which costs at most one extra round. */
const chunkHighWater = new Map();

/** `res` with its body counted into `job.gained` (bytes past the URL's
 * high-water mark) as cache.put consumes it. */
function countedChunk(res, url, job) {
  if (!res.body || typeof TransformStream !== "function") return res;
  let n = 0;
  const body = res.body.pipeThrough(new TransformStream({
    transform(piece, ctl) {
      n += piece.byteLength;
      const high = chunkHighWater.get(url) ?? 0;
      if (n > high) { job.gained += n - high; chunkHighWater.set(url, n); }
      ctl.enqueue(piece);
    },
  }));
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function warmUrls(urls, { prune, revalidate = true }) {
  const cache = await caches.open(RUNTIME);
  const ac = new AbortController();
  const hard = setTimeout(() => ac.abort(), WARM_HARD_MS);
  let cached = 0, pruned = 0;
  /** The fetch jobs this message started or joined (their D1 bytes). */
  const touched = new Set();
  /** D7: a fetch this message started or joined failed outright. */
  let linkDown = false;
  const one = async (u) => {
    let req = null, job = null;
    try {
      req = new Request(u);
      const p = new URL(req.url).pathname;
      if (isNetworkOnly(p)) return;
      if ((isRuntimeChunk(p) || !revalidate) && await cache.match(req)) { cached += 1; return; } // R4
      // D7: the link is down — no new fetch, only what is held counts. A
      // fetch another message has in flight is still joined (it costs
      // nothing more and may yet land).
      job = warmFetches.get(req.url) ?? null;
      if (!job && linkDown) { if (await cache.match(req)) cached += 1; return; }
      if (!job) {
        const r = req;
        const chunk = isRuntimeChunk(p);
        const fresh = { gained: 0, done: null, linkDown: false };
        fresh.done = (async () => {
          let res;
          try { res = await fetch(r, { signal: ac.signal }); } catch (e) { if (isLinkFailure(e, ac.signal)) fresh.linkDown = true; throw e; }
          if (!storable(new URL(r.url).pathname, res)) return false;
          await cache.put(r, chunk ? countedChunk(res, r.url, fresh) : res);
          if (chunk) chunkHighWater.delete(r.url);
          return true;
        })().finally(() => warmFetches.delete(r.url));
        job = fresh;
        warmFetches.set(req.url, job);
      }
      touched.add(job);
      if (await job.done) { cached += 1; return; }
      // Refused (404 / an HTML fallback): a copy already held still counts.
      if (await cache.match(req)) cached += 1;
    } catch {
      // Offline, quota, or aborted at the hard deadline: the next warm-up
      // retries; a copy already held stays (and counts — the reply reports
      // what an offline reload finds).
      if (job?.linkDown) linkDown = true;
      try { if (req && await cache.match(req)) cached += 1; } catch { /* storage gone */ }
    }
  };
  const chunks = [], data = [];
  for (const u of urls) {
    let p = "";
    try { p = new URL(u, self.location.origin).pathname; } catch { /* counted as data; fails in `one` */ }
    (isRuntimeChunk(p) ? chunks : data).push(u);
  }
  const deadline = Date.now() + WARM_BUDGET_MS;
  const [dataDone, chunksDone] = await Promise.all([
    pool(data, WARM_CONCURRENCY, one, deadline),
    pool(chunks, CHUNK_CONCURRENCY, one, deadline),
  ]);
  clearTimeout(hard);
  const partial = !dataDone || !chunksDone || ac.signal.aborted || linkDown;
  const keep = new Set(urls.map((u) => new URL(u, self.location.origin).pathname));
  if (!partial && prune && [...keep].some(isRuntimeChunk)) {
    for (const req of await cache.keys()) {
      const p = new URL(req.url).pathname;
      if (isRuntimeChunk(p) && !keep.has(p)) { await cache.delete(req); pruned += 1; }
    }
  }
  let bytes = 0;
  for (const job of touched) bytes += job.gained;
  return { cached, pruned, total: urls.length, partial, bytes, linkDown };
}

let shellFill = null;
/** The rest of the precache list into this shell (start budget
 * SHELL_BUDGET_MS, every fetch aborted at `hardMs`). */
async function warmShell(hardMs = SHELL_HARD_MS) {
  const ac = new AbortController();
  const hard = setTimeout(() => ac.abort(), hardMs);
  let r;
  try {
    // D7: fail fast — offline, an incomplete shell's missing files (up to
    // the whole non-critical list) each failed, in every round the page sent.
    r = await fillShell(PRECACHE, { concurrency: WARM_CONCURRENCY, deadline: Date.now() + Math.min(SHELL_BUDGET_MS, hardMs), signal: ac.signal, failFast: true });
  } finally { clearTimeout(hard); }
  // Which of the still-missing paths the host refused outright (recorded by
  // fillShell's errors only as counts): re-derive from a cheap pass — a
  // missing path after a FULL pass with no network errors was refused.
  const have = await shellHas();
  const missing = PRECACHE.filter((p) => !have.has(p));
  if (r.done && r.errors === 0) refusedPaths = new Set(missing);
  const complete = await shellComplete();
  const pruned = await pruneShells(complete ? 1 : 2);
  return { type: "shell-filled", version: VERSION, current: true, present: PRECACHE.length - missing.length, total: PRECACHE.length, fetched: r.fetched, failed: r.refused + r.errors, complete, pruned, linkDown: r.linkDown };
}

/** One shell fill at a time, shared by concurrent messages. */
function sharedShellFill(hardMs) {
  shellFill ??= warmShell(hardMs).finally(() => { shellFill = null; });
  return shellFill;
}

self.addEventListener("message", (event) => {
  const t0 = Date.now();
  const data = event.data;
  const reply = (m) => { try { event.ports?.[0]?.postMessage(m); } catch { /* no port */ } };
  if (data && data.type === "warm-shell") {
    event.waitUntil((async () => {
      // A page of another build (its entry script is not in this worker's
      // list): this worker's shell is not that page's — no fill; the page
      // waits for its own build's worker.
      if (typeof data.entry === "string" && !PRECACHE.includes(data.entry)) {
        const have = await shellHas().catch(() => new Set());
        reply({ type: "shell-filled", version: VERSION, current: false, present: PRECACHE.filter((p) => have.has(p)).length, total: PRECACHE.length, fetched: 0, failed: 0, complete: false, pruned: 0 });
        return;
      }
      try { reply(await sharedShellFill(SHELL_HARD_MS)); } catch (e) { reply({ type: "shell-filled", version: VERSION, current: true, present: 0, total: PRECACHE.length, fetched: 0, failed: 0, complete: false, pruned: 0, error: String(e) }); }
    })());
    return;
  }
  if (!data || (data.type !== "warm" && data.type !== "warm-data") || !Array.isArray(data.urls)) return;
  const urls = data.type === "warm-data" ? data.urls.filter((u) => { try { return !isRuntimeChunk(new URL(u, self.location.origin).pathname); } catch { return false; } }) : data.urls;
  event.waitUntil((async () => {
    const r = await warmUrls(urls, { prune: data.type === "warm" && data.prune !== false, revalidate: data.revalidate !== false });
    reply({ type: "warmed", ...r });
    // A page that predates "warm-shell" (an old-build tab this worker claimed
    // after a deploy) never asks for the shell: fill it here, inside what is
    // left of this event's limit — never while the warm-up itself is partial
    // (a slow link: the next round's message tries again).
    if (data.type !== "warm" || data.pageFillsShell === true || r.partial) return;
    const left = EVENT_LIMIT_MS - (Date.now() - t0) - 30_000;
    if (left < 30_000 || await shellComplete()) return;
    try { await sharedShellFill(Math.min(SHELL_HARD_MS, left)); } catch { /* the next warm retries */ }
  })());
});
