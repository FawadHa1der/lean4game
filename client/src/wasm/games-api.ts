/**
 * The game catalog as the client sees it.
 *
 * `/api/games` (generated from wasm/catalog.json by
 * `scripts/games-manifest.mjs --api`) names each game's snapshot; the served
 * `/snapshots/index.json` says what that snapshot costs and which runtime
 * build baked it; the runtime manifest says which build this shell boots.
 * Joining the three is what the boot needs to bind a game and fail fast on
 * an unpaired or unpublished environment (game-boot.ts), and what the
 * landing page needs to tell the truth per tile before the click
 * (ready / download size / not available).
 *
 * Plain memoised fetch promises, deliberately NOT jotai query atoms: an
 * atomWithQuery only fetches while a hook has it mounted, and the boot runs
 * outside React (getDefaultStore). The landing page's tile atom wraps
 * `fetchGamesCatalog` so both share one request.
 */
// Relative path rather than the `qed64/*` alias so Node's type-stripping
// runner (ts-resolve-hook.mjs) can import this module for the unit checks;
// tsc and vite resolve both spellings to the same vendored file.
import { fetchSnapshotIndex, snapshotCacheKey, type SnapshotEntry, type SnapshotIndex } from "./vendor/qed64/src/runtime/snapshots";
import type { RuntimeManifest } from "./vendor/qed64/src/runtime/client";
import type { GameInfo, GameTileWithName } from "../store/api";
import { offlineCacheReport, runtimeCachePaths, type OfflineCacheReport } from "./game-data-urls";
import { wholeMB } from "./sizes";

export const MiB = 1048576;
export const GiB = 1073741824;

/** One `/api/games` row. `listed: false` rows (TestGame) stay reachable by
 * URL only; `snapshot` is the `/snapshots/index.json` entry name. */
export interface ApiGame extends GameTileWithName {
  listed: boolean;
  snapshot: string;
  settings?: GameInfo["settings"];
}

export const gameIdOf = (row: Pick<ApiGame, "owner" | "game">): string => `g/${row.owner}/${row.game}`;

/** The snapshot name a game id falls back to when the catalog does not name
 * one (an un-catalogued dev game, or /api/games unreachable): the lowercased
 * last segment — the convention every bake so far followed. */
export const fallbackSnapshotName = (gameId: string): string => (gameId.split("/")[2] ?? gameId).toLowerCase();

let catalogPromise: Promise<ApiGame[]> | null = null;
/** The `/api/games` rows, fetched once per page. A failed fetch is not
 * memoised, so a later caller (the boot after the landing page, say) retries. */
export function fetchGamesCatalog(): Promise<ApiGame[]> {
  catalogPromise ??= (async () => {
    const r = await fetch("/api/games");
    if (!r.ok) throw new Error(`/api/games: HTTP ${r.status}`);
    const rows = (await r.json()) as unknown;
    if (!Array.isArray(rows)) throw new Error("/api/games: not a list");
    return rows as ApiGame[];
  })();
  catalogPromise.catch(() => { catalogPromise = null; });
  return catalogPromise;
}

/** Exact match on `g/<owner>/<game>` (static paths are case-sensitive). */
export async function findApiGame(gameId: string): Promise<ApiGame | null> {
  const rows = await fetchGamesCatalog();
  return rows.find((row) => gameIdOf(row) === gameId) ?? null;
}

/** L11: is `g/<owner>/<game>` a game this site serves? UNKNOWN only on
 * positive evidence — the catalog was read and has no row, AND game.json
 * was answered with a refusal (404, or a single-page fallback's HTML). A
 * network failure of either is no evidence (offline play of a cached game
 * must keep working), so it counts as known — and so is any other status
 * (403/429/5xx: a transient edge refusal is not "this game does not exist";
 * the same rule as checkSnapshotPairing). The ROUTE's wait is bounded: after
 * GAME_KNOWN_WAIT_MS without an answer (a stalled link: fetch hangs instead
 * of failing) the router gets "known" WITHOUT memoising it, so the page
 * renders and the settled check still decides later calls. The BOOT never
 * takes the bounded answer (gameKnownCheck): on a slow link the catalog
 * answered after the old 4 s bound, the boot had started on "known", and an
 * unknown game's level URL showed the boot banner and a "Lean failed to
 * start" card before the not-found page (D4, live 2026-09-22). Memoised per
 * id; the router renders the not-found page and the boot does not start for
 * an unknown id (it used to render an empty game shell and log a boot
 * failure twice). */
const knownGames = new Map<string, Promise<boolean>>();
const GAME_KNOWN_WAIT_MS = 20000;
export function gameKnown(gameId: string): Promise<boolean> {
  return Promise.race([gameKnownCheck(gameId), new Promise<boolean>((r) => setTimeout(() => r(true), GAME_KNOWN_WAIT_MS))]);
}
/** The unbounded check: what the boot binds on (no boot, no failure card
 * for an unknown game — the placeholder shows until it answers), and what
 * the router follows after a timed-out gameKnown, so a late "unknown" still
 * reaches the not-found page. */
export function gameKnownCheck(gameId: string): Promise<boolean> {
  let p = knownGames.get(gameId);
  if (!p) {
    p = (async () => {
      try {
        if (await findApiGame(gameId)) return true;
      } catch { return true; }
      try {
        const r = await fetch(`/data/${gameId}/game.json`, { method: "HEAD" });
        const html = /text\/html/i.test(r.headers.get("content-type") ?? "");
        return !(html || r.status === 404 || r.status === 410);
      } catch { return true; }
    })();
    knownGames.set(gameId, p);
  }
  return p;
}

declare const __QED64_BUILD_ID__: string;

let manifestPromise: Promise<RuntimeManifest> | null = null;
/** The manifest of the runtime this shell boots — the ONE resolver (the
 * pairing check, the landing tiles, the boot's artifact install and the
 * Prepare warm-up all read it), making the SAME choice the vendored
 * installArtifacts (qed64-boot.ts) makes: the immutable copy pinned to the
 * build the shell was built against, else the `?runtime=` dev override,
 * else the mutable manifest. Kept identical so the pairing check and the
 * boot can never disagree about which runtime runs. A failure is not
 * memoised, so a later caller retries. */
export function resolveRuntimeManifest(): Promise<RuntimeManifest> {
  manifestPromise ??= (async () => {
    let manifestResponse: Response | null = null;
    if (typeof __QED64_BUILD_ID__ === "string") {
      const pinned = await fetch(`/runtime/runtime-manifest.${__QED64_BUILD_ID__}.json`);
      if (pinned.ok && (pinned.headers.get("content-type") ?? "").includes("json")) manifestResponse = pinned;
    }
    const devRuntime = new URLSearchParams(location.search).get("runtime");
    if (devRuntime) manifestResponse = await fetch(`/runtime/runtime-manifest.${devRuntime}.json`, { cache: "no-cache" });
    if (!manifestResponse) manifestResponse = await fetch("/runtime/runtime-manifest.json", { cache: "no-cache" });
    if (!manifestResponse.ok) throw new Error(`runtime manifest: HTTP ${manifestResponse.status}`);
    const manifest = (await manifestResponse.json()) as RuntimeManifest;
    if (typeof manifest.buildId !== "string" || !manifest.buildId) throw new Error("runtime manifest: no buildId");
    return manifest;
  })();
  manifestPromise.catch(() => { manifestPromise = null; });
  return manifestPromise;
}

/** The build id of the runtime this shell boots (see resolveRuntimeManifest). */
export const resolveRuntimeBuildId = (): Promise<string> => resolveRuntimeManifest().then((m) => m.buildId);

/** The `?snapshots=<dir>` dev re-rooting, if active: an unpromoted bake
 * served from public/<dir> whose index the page reads instead of the
 * promoted one. Its keys differ from the served bake's by design (content-
 * addressed), so anything that treats the index's keys as "the live ones"
 * (the stale-region sweep) must stand down while it is active. */
export const devSnapshotsDir = (): string | null => new URLSearchParams(location.search).get("snapshots") || null;
/** The dev-only `?profiles=<dir>` override (qed64-boot.ts installArtifacts,
 * 3b42714): an unpromoted profile set served from public/<dir>; null in
 * production. Read by installGameArtifacts for the profile index. */
export const devProfilesDir = (): string | null => new URLSearchParams(location.search).get("profiles") || null;

let indexPromise: Promise<SnapshotIndex | null> | null = null;
/** The served snapshot index, fetched once per page, honouring the
 * `?snapshots=<dir>` dev re-rooting exactly as the vendored boot does (an
 * unpromoted bake served from public/<dir>; the index's urls name the
 * promoted dir). `null` (unreadable) is not memoised. */
export function fetchSnapshotIndexOnce(): Promise<SnapshotIndex | null> {
  indexPromise ??= (async () => {
    const devSnapshots = devSnapshotsDir();
    if (!devSnapshots) return fetchSnapshotIndex();
    const idx = await fetchSnapshotIndex(`/${devSnapshots}/index.json`);
    return idx && {
      ...idx,
      snapshots: idx.snapshots.map((e) => ({ ...e, url: e.url.replace(/^\/snapshots\//, `/${devSnapshots}/`) })),
    };
  })();
  indexPromise.then((idx) => { if (!idx) indexPromise = null; }, () => { indexPromise = null; });
  return indexPromise;
}

export const findSnapshotEntry = (index: SnapshotIndex | null, name: string): SnapshotEntry | undefined =>
  index?.snapshots.find((s) => s.name === name);

/** What the first play of this snapshot transfers (gzip on the wire when
 * the index says so; the raw size otherwise), in whole decimal MB (D8: the
 * tile said "≈269 MB" for RAG's 282.0 MB, MiB labelled MB). */
export const snapshotTransferMB = (entry: SnapshotEntry): number => wholeMB(entry.transfer ?? entry.bytes);

/** Is the inflated region already in OPFS? The same check the vendored boot
 * makes before spawning the prefetch worker (`qed64-snapshots/<key>.raw`
 * with exactly the index's raw size). No OPFS, a private window that throws
 * on `getDirectory`, or no such file all read as "not cached". */
export async function rawSnapshotCached(entry: SnapshotEntry): Promise<boolean> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("qed64-snapshots");
    const f = await (await dir.getFileHandle(`${snapshotCacheKey(entry)}.raw`)).getFile();
    return f.size === entry.bytes;
  } catch {
    return false;
  }
}

/** ready: plays offline — the region is in OPFS AND the service worker
 * holds the runtime and the game's files (D1); partial: the region is in
 * OPFS but the rest is not (yet) cached — the game boots online only;
 * download: published for this build, not yet cached; unavailable: not in
 * the index, or baked for another runtime (snapshots are binary-paired to
 * one build — loading one against another traps in the worker). */
export type SnapshotState = "ready" | "partial" | "download" | "unavailable";

/** The region-only verdict (no `partial`: that needs the runtime cache —
 * tileSnapshotStates). */
export async function snapshotStateFor(entry: SnapshotEntry | undefined, buildId: string): Promise<SnapshotState> {
  if (!entry || entry.runtime !== buildId) return "unavailable";
  return (await rawSnapshotCached(entry)) ? "ready" : "download";
}

/** One landing-page tile's truth. */
export interface TileSnapshotState {
  state: SnapshotState;
  /** Whole decimal MB the first play transfers (every state but
   * `unavailable`). */
  transferMB?: number;
  /** The served index entry (every state but `unavailable`): what Prepare
   * downloads and what Remove download deletes (its cache key). */
  entry?: SnapshotEntry;
  /** `ready` / `partial`: what the service worker's runtime cache holds for
   * this game (null: no Cache API — never `ready`). */
  offline?: OfflineCacheReport | null;
}

/** The tile states for a set of games (keyed by snapshot name), from one
 * index fetch, one manifest fetch, one OPFS probe per game and one read of
 * the service worker's runtime cache. D1 (live 2026-10-03): a region in OPFS
 * alone used to read "Ready — plays offline" after a reload although runtime
 * chunks or the game's files were missing (a Prepare's warm-up that stopped
 * short; a Prepare from before D6, which cached no game file) — the offline
 * boot then failed "Failed to fetch". `ready` now also needs every chunk of
 * the current runtime and the game's game.json, inventory.json and level
 * files in the runtime cache (game-data-urls offlineCacheReport); a region
 * without them is `partial`. */
export async function tileSnapshotStates(games: readonly { snapshot: string; gameId: string }[]): Promise<Map<string, TileSnapshotState>> {
  const [runtime, index] = await Promise.all([resolveRuntimeManifest(), fetchSnapshotIndexOnce()]);
  // An unreadable index is "unknown", not "not available on this build":
  // the landing page then leaves every tile clickable with no availability
  // row, and the boot's pairing check (which re-fetches) reports the reason.
  if (!index) throw new Error("the snapshot index could not be read");
  const held = await runtimeCachePaths();
  const out = new Map<string, TileSnapshotState>();
  await Promise.all(games.map(async ({ snapshot: name, gameId }) => {
    const entry = findSnapshotEntry(index, name);
    let state = await snapshotStateFor(entry, runtime.buildId);
    if (!entry || state === "unavailable") { out.set(name, { state }); return; }
    let offline: OfflineCacheReport | null | undefined;
    if (state === "ready") {
      offline = await offlineCacheReport(gameId, runtime, held);
      if (!offline?.complete) state = "partial";
    }
    out.set(name, { state, transferMB: snapshotTransferMB(entry), entry, offline });
  }));
  return out;
}

/** The game session's memory policy from the bytes of the regions it will
 * load (pure; game-boot.ts wires it into the ResidentPolicy). Initial commit:
 * the regions plus 10 %, rounded up to 256 MiB, never below 1 GiB (one large
 * commit up front — growing a shared Memory64 by gigabytes in many steps
 * while a snapshot streams in is where nondeterministic renderer crashes
 * were observed). Cap: at least 1 GiB of growth room over the commit and
 * never below 3 GiB. resident-session filters the cap against the device's
 * reservation rungs (client.ts memoryCandidates: 16/12/8/6/4/3 GiB on a
 * ≥8 GB device, 8/6/4/3/2 on ≥4 GB, 4/3/2 below), so the effective cap is
 * the largest rung ≤ the requested cap — a 3328 MiB request lands on the
 * 3 GiB rung — and a cap under every rung becomes the sole candidate. */
export function gameMemoryPolicy(regionBytes: number): { initialBytes: number; maximumBytes: number } {
  const step = 256 * MiB;
  const initialBytes = Math.max(1024 * MiB, Math.ceil((1.1 * regionBytes) / step) * step);
  const maximumBytes = Math.max(3 * GiB, initialBytes + GiB);
  return { initialBytes, maximumBytes };
}
