/* lean4game service worker — offline reloads.
 *
 * Everything heavy already survives offline in the browser's own stores
 * (snapshots as raw regions in OPFS, the core library pack, the game data
 * cache); what died at the first byte was the page itself. This worker:
 *  - precaches the app shell at install (index, bundles, worker scripts,
 *    small fonts, icons, game data, i18n, api, the artifact manifests) —
 *    through the HTTP cache, so a page that just downloaded them pays no
 *    second download; the shell document is stored as a fresh, redirect-
 *    free copy of "/" (a host that answers /index.html with a redirect to /
 *    would otherwise leave a redirected response, which browsers refuse for
 *    a navigation);
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
 *    old build can lazy-load their chunks after a deploy.
 * Snapshots and library pack parts are never cached here (OPFS owns them).
 * Generated from client/src/sw/sw.template.js by scripts/build-sw.mjs after
 * every build; the precache list and version are substituted there.
 */
const VERSION = "__VERSION__";
const PRECACHE = __PRECACHE__;
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

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    const results = await Promise.allSettled(PRECACHE.map(async (p) => {
      if (p === DOC) return;
      const res = await fetch(new Request(p));
      if (!storable(p, res)) throw new Error(`${p}: ${res.status} ${res.headers.get("content-type") || ""}`);
      await cache.put(p, res);
    }));
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length) console.warn(`[sw] precache: ${failed.length} of ${PRECACHE.length} files not cached`, failed.slice(0, 3).map((r) => String(r.reason)));
    // The shell document, redirect-free, under both names it is asked for.
    const doc = await fetch(new Request("/", { cache: "no-cache" }));
    if (doc.ok) { const copy = await freshCopy(doc); await cache.put(DOC, copy.clone()); await cache.put("/", copy); }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Keep the current and the previous shell cache: a tab still on the
    // previous build lazy-loads its own hashed chunks from it after a deploy.
    const shells = (await caches.keys()).filter((n) => n.startsWith("l4g-shell-") && n !== SHELL);
    for (const name of shells.slice(0, Math.max(0, shells.length - 1))) await caches.delete(name);
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
// yet and download the runtime again.
const warmFetches = new Map();
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "warm" || !Array.isArray(data.urls)) return;
  const reply = (m) => { try { event.ports?.[0]?.postMessage(m); } catch { /* no port */ } };
  event.waitUntil((async () => {
    const cache = await caches.open(RUNTIME);
    let cached = 0, pruned = 0;
    for (const u of data.urls) {
      try {
        const req = new Request(u);
        if (await cache.match(req)) { cached += 1; continue; }
        let job = warmFetches.get(req.url);
        if (!job) {
          job = (async () => {
            const res = await fetch(req);
            if (!storable(new URL(req.url).pathname, res)) return false;
            await cache.put(req, res);
            return true;
          })().finally(() => warmFetches.delete(req.url));
          warmFetches.set(req.url, job);
        }
        if (await job) cached += 1;
      } catch { /* offline or quota: the next warm-up retries */ }
    }
    const keep = new Set(data.urls.map((u) => new URL(u, self.location.origin).pathname));
    for (const req of await cache.keys()) {
      const p = new URL(req.url).pathname;
      if (isRuntimeChunk(p) && !keep.has(p)) { await cache.delete(req); pruned += 1; }
    }
    reply({ type: "warmed", cached, pruned, total: data.urls.length });
  })());
});
