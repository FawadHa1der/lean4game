/** The editor-side uri of a level document.
 *
 * Upstream lean4game opens `file:///{world}/{level}.lean`. lean4monaco derives
 * one LeanClient per PARENT FOLDER of the open document (its browser
 * `findLeanProjectRootInfo` is `uri.join('..')`), so that scheme spawns a
 * fresh language client on every world switch. Upstream can afford that —
 * each client opens its own relay websocket — but here every client shares
 * the single in-tab MessagePort: the newcomer's reader takes the port over,
 * the rpc connect the infoview already issued through the previous client is
 * answered to the new one (which drops the unknown id), and the level's rpc
 * session promise hangs for good — the "stuck at Loading the level…" report.
 *
 * Every level therefore lives in ONE folder, so exactly one client (and one
 * document, the in-tab checker's model) serves the whole game. The uri is
 * synthetic on both sides — the translation layer maps it to the worker's
 * document and back — so nothing but these two functions depends on its shape.
 */
export const LEVEL_FOLDER = "file:///levels";

export function levelUri(worldId: string, levelId: string | number): string {
  return `${LEVEL_FOLDER}/${worldId}__${levelId}.lean`;
}

/** Inverse of {@link levelUri}; also accepts the legacy nested shape. */
export function parseLevelUri(uri: string): { worldId: string; levelId: string } {
  const path = decodeURIComponent(new URL(uri).pathname);
  const parts = path.split("/").filter(Boolean);
  const file = (parts[parts.length - 1] ?? "").replace(/\.lean$/, "");
  const sep = file.lastIndexOf("__");
  if (parts.length >= 2 && parts[0] === "levels" && sep > 0) {
    return { worldId: file.slice(0, sep), levelId: file.slice(sep + 2) };
  }
  return { worldId: parts[parts.length - 2] ?? "", levelId: file };
}
