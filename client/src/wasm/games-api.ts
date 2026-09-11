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
 * the index says so; the raw size otherwise), in whole MB. */
export const snapshotTransferMB = (entry: SnapshotEntry): number => Math.round((entry.transfer ?? entry.bytes) / MiB);

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

/** ready: plays offline from OPFS; download: published for this build, not
 * yet cached; unavailable: not in the index, or baked for another runtime
 * (snapshots are binary-paired to one build — loading one against another
 * traps in the worker). */
export type SnapshotState = "ready" | "download" | "unavailable";

export async function snapshotStateFor(entry: SnapshotEntry | undefined, buildId: string): Promise<SnapshotState> {
  if (!entry || entry.runtime !== buildId) return "unavailable";
  return (await rawSnapshotCached(entry)) ? "ready" : "download";
}

/** One landing-page tile's truth. */
export interface TileSnapshotState {
  state: SnapshotState;
  /** Whole MB the first play transfers (`download` and `ready` states). */
  transferMB?: number;
  /** The served index entry (`download` and `ready` states): what Prepare
   * downloads and what Remove download deletes (its cache key). */
  entry?: SnapshotEntry;
}

/** The tile states for a set of snapshot names, from one index fetch, one
 * manifest fetch and one OPFS probe per name. */
export async function tileSnapshotStates(names: readonly string[]): Promise<Map<string, TileSnapshotState>> {
  const [buildId, index] = await Promise.all([resolveRuntimeBuildId(), fetchSnapshotIndexOnce()]);
  // An unreadable index is "unknown", not "not available on this build":
  // the landing page then leaves every tile clickable with no availability
  // row, and the boot's pairing check (which re-fetches) reports the reason.
  if (!index) throw new Error("the snapshot index could not be read");
  const out = new Map<string, TileSnapshotState>();
  await Promise.all(names.map(async (name) => {
    const entry = findSnapshotEntry(index, name);
    const state = await snapshotStateFor(entry, buildId);
    out.set(name, entry && state !== "unavailable" ? { state, transferMB: snapshotTransferMB(entry), entry } : { state });
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
