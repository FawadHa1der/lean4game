/**
 * D6 (live 2026-10-03): the files a game needs offline besides its region and the runtime —
 * one list for the landing page's Prepare and for the boot's warm-up.
 *
 * A Prepare used to cache the region and the runtime but none of the game's
 * own files (`/data/<id>/game.json`, the level files, `inventory.json`, the
 * inventory's documentation files, `/i18n/<id>/<lang>`): offline, the boot of
 * a game prepared only from the landing page failed "Failed to fetch" while
 * its tile said "Ready — plays offline". The boot's warm-up named only what
 * this visit had fetched. Both now derive the list from the game's
 * `game.json` (worldSize: every level file, 1..n per world) and
 * `inventory.json` (every documentation file it lists).
 *
 * Also the other half of "plays offline" (D1): whether the service worker's
 * runtime cache holds every runtime chunk and the game's own files —
 * `offlineCacheReport`, which the landing tile reads before it says "Ready".
 */
import type { RuntimeManifest } from "./vendor/qed64/src/runtime/client";

/** The service worker's runtime cache (client/src/sw/sw.template.js
 * `RUNTIME`): the runtime chunks, the manifests and every game file it warmed
 * or served network-first. Per-game data is never in the shell precache
 * (scripts/build-sw.mjs skips /data and /i18n except tile images). */
export const RUNTIME_CACHE = "l4g-runtime-v1";

/** The documentation files the inventory panel opens (store/inventory-atoms
 * docAtomFamily: `doc__${Type}__${name}.json`, Type = the capitalised tab),
 * from the game's inventory.json. Nothing for a malformed inventory: the
 * docs are a bonus, not the warm-up. Moved here from game-boot. */
export function inventoryDocUrls(gameId: string, inventory: unknown): string[] {
  const inv = (inventory && typeof inventory === "object" ? inventory : {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const [key, type] of [["tactics", "Tactic"], ["lemmas", "Theorem"], ["definitions", "Definition"]] as const) {
    const items = Array.isArray(inv[key]) ? (inv[key] as { name?: unknown }[]) : [];
    for (const it of items) if (typeof it?.name === "string" && it.name) out.push(`/data/${gameId}/doc__${type}__${it.name}.json`);
  }
  return out.slice(0, 400); // the largest game lists 188
}

/** Every level file game.json's worldSize names (a flat
 * `{ [worldId]: levelCount }` map; levels are numbered from 1 — level 0, the
 * world intro, has no file). The same files game-boot fetchGameData loads. */
export function levelUrls(gameId: string, game: unknown): string[] {
  const worldSize = (game as { worldSize?: unknown } | null)?.worldSize;
  if (!worldSize || typeof worldSize !== "object") return [];
  const out: string[] = [];
  for (const [w, n] of Object.entries(worldSize as Record<string, unknown>)) {
    const size = typeof n === "number" && Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : 0;
    for (let l = 1; l <= size; l++) out.push(`/data/${gameId}/level__${w}__${l}.json`);
  }
  return out;
}

/** The game's i18n namespaces as client/src/i18n.ts loads them
 * (`/i18n/g/<owner>/<game>/<lang>`): English (the fallback) and the UI
 * language. */
export const i18nUrls = (gameId: string, langs: readonly string[]): string[] =>
  [...new Set(["en", ...langs.filter((l) => typeof l === "string" && l)])].map((l) => `/i18n/${gameId}/${l}`);

/** components/markdown.tsx's image rewrite: `![alt](images/<file>)` in a
 * game text is shown from data/<id>/images/<file>. The URL ends at a space
 * (a title may follow) or the closing parenthesis. */
const EMBEDDED_IMAGE = /!\[[^\]]+\]\((images\/[^)\s]+)[^)]*\)/g;

/** R3 (review of D6): the images the texts of parsed game files embed
 * (game.json's world introductions, a level file's texts), as
 * `/data/<id>/images/<file>` pathnames. No list named them: offline, a game
 * prepared from the landing page showed them broken (RAG: 13 in its world
 * introductions, 1 in a level — 1.8 MB). Not essential: the game plays
 * without them. */
export function embeddedImageUrls(gameId: string, ...files: unknown[]): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (typeof v === "string") { for (const m of v.matchAll(EMBEDDED_IMAGE)) out.add(`/data/${gameId}/${m[1]}`); }
    else if (v && typeof v === "object" && depth < 16) for (const x of Object.values(v)) walk(x, depth + 1);
  };
  for (const f of files) walk(f, 0);
  return [...out].slice(0, 400);
}

/** The game's offline file list from its parsed game.json and
 * inventory.json (either may be null — unreadable: what can be derived is
 * still listed). N5 order: the inventory and its docs first (the worker
 * fetches in order, and they are what an offline inventory opens), then
 * game.json, the level files, the i18n namespaces, and last the images
 * game.json's texts embed (R3; a level file's are added by the caller that
 * has read it — cachedLevelImageUrls, game-boot). Pathnames, no duplicates. */
export function gameDataUrls(gameId: string, game: unknown, inventory: unknown, langs: readonly string[]): string[] {
  const urls = [
    `/data/${gameId}/inventory.json`,
    ...inventoryDocUrls(gameId, inventory),
    `/data/${gameId}/game.json`,
    ...levelUrls(gameId, game),
    ...i18nUrls(gameId, langs),
    ...embeddedImageUrls(gameId, game),
  ];
  return [...new Set(urls)];
}

/** The files without which the game does not play offline at all — what the
 * landing tile checks before "Ready — plays offline": game.json, every level
 * file (the boot reads them all into the worker FS) and inventory.json (the
 * inventory panel). Docs and i18n degrade gracefully when missing. */
export const essentialDataUrls = (gameId: string, game: unknown): string[] =>
  [`/data/${gameId}/game.json`, `/data/${gameId}/inventory.json`, ...levelUrls(gameId, game)];

/** gameDataUrls from the network (through the HTTP cache — a boot or the
 * landing page has usually just read both files). A file that cannot be read
 * contributes what it can: without game.json no level is named (the warm-up
 * still caches the runtime; the tile then says the game data is missing). */
export async function fetchGameDataUrls(gameId: string, langs: readonly string[]): Promise<string[]> {
  const json = async (url: string): Promise<unknown> => {
    try {
      const r = await fetch(url);
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };
  const [game, inventory] = await Promise.all([json(`/data/${gameId}/game.json`), json(`/data/${gameId}/inventory.json`)]);
  return gameDataUrls(gameId, game, inventory, langs);
}

/** R3: the images the level files among `urls` embed, read from the runtime
 * cache (no download: a Prepare's warm-up has just stored them; the page
 * never parsed them) — those not already in `urls`. Nothing without a Cache
 * API; a level file not cached contributes nothing. */
export async function cachedLevelImageUrls(gameId: string, urls: readonly string[]): Promise<string[]> {
  try {
    if (typeof caches === "undefined" || !(await caches.has(RUNTIME_CACHE))) return [];
    const cache = await caches.open(RUNTIME_CACHE);
    const levels = await Promise.all(urls.filter((u) => u.startsWith(`/data/${gameId}/level__`)).map(async (u) => {
      try { return await (await cache.match(u))?.json(); } catch { return null; }
    }));
    const listed = new Set(urls);
    return embeddedImageUrls(gameId, ...levels).filter((u) => !listed.has(u));
  } catch { return []; }
}

/** The runtime chunks a runtime manifest names (what the warm-up caches and
 * the tile checks). */
export const runtimeChunkUrls = (runtime: RuntimeManifest): string[] =>
  [...new Set(Object.values(runtime.files).flatMap((f) => f.chunks.map((c) => c.url)))];

/** What the service worker's runtime cache holds for one game: the current
 * runtime's chunks and the game's essential files (`essentialDataUrls`). */
export interface OfflineCacheReport {
  chunks: { have: number; total: number };
  data: { have: number; total: number };
  /** Every chunk and every essential file is cached. */
  complete: boolean;
}

/** The pathnames the runtime cache holds, or null where there is no Cache
 * API (an insecure context, some private modes) — nothing can be offline
 * there. One `keys()` per landing-page probe, shared by every tile. */
export async function runtimeCachePaths(): Promise<Set<string> | null> {
  try {
    if (typeof caches === "undefined") return null;
    // `has` first: `open` would create the cache on a first visit.
    if (!(await caches.has(RUNTIME_CACHE))) return new Set();
    const cache = await caches.open(RUNTIME_CACHE);
    return new Set((await cache.keys()).map((r) => new URL(r.url).pathname));
  } catch {
    return null;
  }
}

/** The pure part of offlineCacheReport: `held` — the runtime cache's
 * pathnames; `game` — the cached game.json (null when it is not cached). */
export function offlineReportFrom(held: ReadonlySet<string>, chunkUrls: readonly string[], gameId: string, game: unknown): OfflineCacheReport {
  const chunkPaths = chunkUrls.map((u) => { try { return new URL(u, "http://x").pathname; } catch { return u; } });
  const chunksHave = chunkPaths.filter((p) => held.has(p)).length;
  // Without a cached game.json the level files cannot be listed: game.json
  // itself is then the missing essential file.
  const data = essentialDataUrls(gameId, game);
  const dataHave = data.filter((p) => held.has(p)).length;
  const complete = chunkPaths.length > 0 && chunksHave === chunkPaths.length && game !== null && dataHave === data.length;
  return { chunks: { have: chunksHave, total: chunkPaths.length }, data: { have: dataHave, total: data.length }, complete };
}

/** Does this game play offline from the service worker's cache? Reads the
 * cache directly (the page needs no controlling worker for it): every chunk
 * of the CURRENT runtime manifest, and the game's game.json, inventory.json
 * and every level file game.json lists. Null without a Cache API (the tile
 * then never says "plays offline"). `held`: a runtimeCachePaths() result to
 * share across tiles. */
export async function offlineCacheReport(gameId: string, runtime: RuntimeManifest, held?: Set<string> | null): Promise<OfflineCacheReport | null> {
  const paths = held === undefined ? await runtimeCachePaths() : held;
  if (!paths) return null;
  let game: unknown = null;
  if (paths.has(`/data/${gameId}/game.json`)) {
    try {
      const hit = await (await caches.open(RUNTIME_CACHE)).match(`/data/${gameId}/game.json`);
      game = hit ? await hit.json() : null;
    } catch { game = null; }
  }
  return offlineReportFrom(paths, runtimeChunkUrls(runtime), gameId, game);
}
