/**
 * In-memory copy of every game-data JSON the boot fetched (game.json and all
 * level__*.json — game-boot downloads them all to place them in the worker
 * FS). The UI's per-level queries consult it when the network is gone: the
 * checker itself runs in-tab, so once loaded the game is playable offline —
 * but a reload clears the query cache and the level texts would 404.
 * Keyed by URL pathname.
 */
const cache = new Map<string, unknown>();

export function rememberGamedata(url: string, json: unknown): void {
  try {
    cache.set(new URL(url, window.location.origin).pathname, json);
  } catch {
    cache.set(url, json);
  }
}

export function cachedGamedata<T = unknown>(url: string): T | undefined {
  try {
    return cache.get(new URL(url, window.location.origin).pathname) as T | undefined;
  } catch {
    return cache.get(url) as T | undefined;
  }
}

/** fetch + JSON with the cache as the offline fallback (network first: the
 * boot's copy and the server's file are the same bytes). */
export async function fetchGamedataJson<T = unknown>(url: string): Promise<T> {
  try {
    const res = await fetch(url);
    if (res.ok) {
      const json = (await res.json()) as T;
      rememberGamedata(url, json);
      return json;
    }
  } catch {
    /* offline or blocked: fall through */
  }
  const hit = cachedGamedata<T>(url);
  if (hit !== undefined) return hit;
  throw new Error(`gamedata unavailable: ${url}`);
}
