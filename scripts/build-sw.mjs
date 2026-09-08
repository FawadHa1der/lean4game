#!/usr/bin/env node
// Generate client/dist/sw.js from client/src/sw/sw.template.js: the precache
// list is every shell file in client/dist except the R2-served artifact
// directories (runtime/, profiles/, snapshots/ — cached on demand or owned
// by OPFS) and files over the size cap (the 23 MB emoji font is cached on
// first use instead). Run after `vite build` (client/package.json build).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "client/dist");
const SKIP_DIRS = new Set(["runtime", "profiles", "snapshots"]);
const SIZE_CAP = 8 * 1024 * 1024;
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    const rel = "/" + relative(dist, full).split("\\").join("/");
    if (e.isDirectory()) { if (dir === dist && SKIP_DIRS.has(e.name)) continue; walk(full); continue; }
    if (e.name === "sw.js" || e.name === "_headers") continue;
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
// The version hashes CONTENT (a same-size edit to an unhashed shell file
// must still reach returning users); the R2-only pinned manifest, absent
// on this host, contributes its name.
const h = createHash("sha256");
for (const f of files) { h.update(f.path); try { h.update(readFileSync(join(dist, f.path))); } catch { h.update(""); } }
const version = h.digest("hex").slice(0, 12);
const template = readFileSync(join(root, "client/src/sw/sw.template.js"), "utf8");
const out = template.replace("__VERSION__", version).replace("__PRECACHE__", JSON.stringify(files.map((f) => f.path)));
writeFileSync(join(dist, "sw.js"), out);
const bytes = files.reduce((n, f) => n + f.size, 0);
console.log(`sw.js: version ${version}, ${files.length} precached files, ${(bytes / 1048576).toFixed(1)} MB`);
