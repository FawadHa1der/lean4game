#!/usr/bin/env node
// Generate client/dist/sw.js from client/src/sw/sw.template.js: the precache
// list is every shell file in client/dist except the R2-served artifact
// directories (runtime/, profiles/, snapshots/ — cached on demand or owned
// by OPFS), the per-game data/ and i18n/ trees (cached on use; only cover
// images from api/games are precached) and files over the size cap (the 23 MB emoji font is cached on
// first use instead). Run after `vite build` (client/package.json build).
// N2: the list is split — CRITICAL (cached by the install event) and the
// rest, which the worker fills after activation on the page's "warm-shell"
// message. A whole-shell install outlasted Chromium's 300 s install-event
// timeout on a slow first visit. CRITICAL is the closure a LEVEL page needs
// to render offline, not just the entry: with only the entry chunks an
// origin whose post-activation fill never ran (the fill went to the outgoing
// worker after a deploy, an old-build tab, a tab closed mid-fill) reloaded a
// level offline as a blank page — the editor's lazy chunks (extension host,
// LeanMonaco's theme defaults, onig wasm, the grammars) and the infoview
// were missing. So: the shell document, every /assets script, wasm, JSON,
// stylesheet and HTML file (lazy chunks change hash on every deploy, so the
// previous shell cannot stand in for them), the infoview, the English
// locale, the worker scripts, the artifact manifests, /api/games and the
// small root files next to sw.js. Fonts, KaTeX, the other locales, the
// large icons and the tile images stay in the post-activation fill.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "client/dist");
const SKIP_DIRS = new Set(["runtime", "profiles", "snapshots"]);
const SIZE_CAP = 8 * 1024 * 1024;
// The landing tiles' cover images (each game's `tile.image`, relative to its
// data dir) are the one piece of per-game content precached, so the landing
// page renders offline.
const TILE_IMAGES = new Set();
try {
  for (const g of JSON.parse(readFileSync(join(dist, "api/games"), "utf8"))) {
    if (g.tile?.image) TILE_IMAGES.add(`/data/g/${g.owner}/${g.game}/${g.tile.image}`);
  }
} catch { /* no api/games in this dist: nothing to add */ }
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    const rel = "/" + relative(dist, full).split("\\").join("/");
    if (e.isDirectory()) { if (dir === dist && SKIP_DIRS.has(e.name)) continue; walk(full); continue; }
    if (e.name === "sw.js" || e.name === "_headers") continue;
    // Per-game content (data/<id>/level__*.json, docs, images; i18n/<id>/<lang>)
    // is fetched when a level is opened and cached by the network-first path
    // on use — with ten games it is ~75 MB / ~1,200 files, far more than the
    // shell, and most visitors play one game. Only the landing page's cover
    // images are precached so the tiles render offline.
    if (/^\/(data|i18n)\//.test(rel) && !TILE_IMAGES.has(rel)) continue;
    const size = statSync(full).size;
    // Only fonts are optional enough to skip for size (the 23 MB emoji font
    // is cached on first use); the bundles and worker scripts are the shell.
    if (size > SIZE_CAP && /\.(ttf|otf|woff2?)$/i.test(rel)) continue;
    files.push({ path: rel, size });
  }
})(dist);
// The artifact manifests: the boot fetches them before the worker controls
// the page on a first visit, so they must be precached, not learned on use.
// The pinned manifest name comes from the shipped manifest's build id.
const rt = JSON.parse(readFileSync(join(dist, "runtime/runtime-manifest.json"), "utf8"));
for (const p of ["/runtime/runtime-manifest.json", `/runtime/runtime-manifest.${rt.buildId}.json`, "/snapshots/index.json", "/profiles/index.json", "/profiles/lean-core.manifest.json"]) {
  let size = 0; try { size = statSync(join(dist, p)).size; } catch { /* the pinned copy exists only on the host */ }
  files.push({ path: p, size });
}
files.sort((a, b) => a.path.localeCompare(b.path));
// The critical subset (see the header). The entry chunks are whatever the
// built document references under /assets (script src, stylesheet and
// modulepreload hrefs).
const indexHtml = readFileSync(join(dist, "index.html"), "utf8");
const entry = new Set([...indexHtml.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map((m) => m[1]));
const ROOT_SMALL = 64 * 1024;
const critical = files.filter((f) =>
  f.path === "/index.html" || entry.has(f.path) || f.path.startsWith("/workers/") || f.path === "/api/games"
  || /^\/(runtime|snapshots|profiles)\//.test(f.path)
  || /^\/assets\/[^/]+\.(m?js|wasm|json|css|html)$/.test(f.path)
  || f.path.startsWith("/infoview/") || f.path.startsWith("/locales/en/")
  || (f.path.lastIndexOf("/") === 0 && f.size <= ROOT_SMALL));
for (const p of entry) if (!files.some((f) => f.path === p)) throw new Error(`build-sw: index.html references ${p}, which is not in the precache list`);
if (!critical.some((f) => /^\/assets\/.*\.js$/.test(f.path))) throw new Error("build-sw: no entry script found in index.html");
// The version hashes CONTENT (a same-size edit to an unhashed shell file
// must still reach returning users); the R2-only pinned manifest, absent
// on this host, contributes its name.
const h = createHash("sha256");
for (const f of files) { h.update(f.path); try { h.update(readFileSync(join(dist, f.path))); } catch { h.update(""); } }
const version = h.digest("hex").slice(0, 12);
const template = readFileSync(join(root, "client/src/sw/sw.template.js"), "utf8");
const out = template.replace("__VERSION__", version).replace("__PRECACHE__", JSON.stringify(files.map((f) => f.path))).replace("__CRITICAL__", JSON.stringify(critical.map((f) => f.path)));
writeFileSync(join(dist, "sw.js"), out);
const bytes = files.reduce((n, f) => n + f.size, 0);
const critBytes = critical.reduce((n, f) => n + f.size, 0);
console.log(`sw.js: version ${version}, ${files.length} precached files, ${(bytes / 1048576).toFixed(1)} MB; install-time critical shell ${critical.length} files, ${(critBytes / 1048576).toFixed(1)} MB (rest filled after activation)`);
