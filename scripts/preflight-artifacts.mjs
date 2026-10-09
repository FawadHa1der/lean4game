// Every file the manifests and indexes name must exist locally and be paired
// to the same runtime build — a partial or mixed tree would strand the site.
// Used by scripts/upload-artifacts.sh; run alone to check a staged tree:
//   node scripts/preflight-artifacts.mjs [client/public]
// The per-runtime index copies (QED64 HARDENING #64) are part of the tree:
// snapshots/index.<buildId>.json and snapshots/profiles-index.<buildId>.json
// for the runtime the manifest names, each byte-identical to its mutable
// index (the upload publishes them before the deploy, the mutable indexes
// after it), and no copy for another runtime (R2 keeps its own; a local one
// names files that are gone). So is the pinned runtime manifest,
// runtime/runtime-manifest.<buildId>.json, byte-identical to
// runtime-manifest.json (the release ships both): the first file a QED64 boot
// fetches and one the service worker precaches; R2 serves the release's, and
// a local tree without it boots offline into "Failed to fetch" (serve-dist
// answers the path with index.html). No pinned manifest for another runtime
// either. scripts/stage-snapshots.py --copies writes all three.
import { existsSync, readFileSync, readdirSync } from "node:fs";
const pub = process.argv[2] ?? "client/public";
const read = (p) => JSON.parse(readFileSync(pub + p, "utf8"));
let bad = false, files = 0;
const need = (url) => { files++; if (!existsSync(pub + url)) { console.error("MISSING: " + pub + url); bad = true; } };
const rt = read("/runtime/runtime-manifest.json");
let chunks = 0;
for (const f of Object.values(rt.files ?? {})) for (const c of f.chunks ?? []) { chunks++; need(c.url); }
if (chunks === 0) { console.error("runtime manifest lists no chunks — refusing"); bad = true; }
const pi = read("/profiles/index.json");
if (pi.runtime?.buildId && pi.runtime.buildId !== rt.buildId) { console.error(`profile index runtime ${pi.runtime.buildId} != manifest ${rt.buildId}`); bad = true; }
let parts = 0;
for (const p of pi.profiles ?? []) {
  need(p.manifest);
  if (!existsSync(pub + p.manifest)) continue;
  for (const part of read(p.manifest).content?.pack?.transport?.parts ?? []) { parts++; need(part.url); }
}
const sn = read("/snapshots/index.json");
for (const s of sn.snapshots ?? []) {
  need(s.url);
  if (s.runtime && s.runtime !== rt.buildId) { console.error(`snapshot ${s.url} paired to ${s.runtime}, manifest is ${rt.buildId}`); bad = true; }
}
const COPIES = [[`/runtime/runtime-manifest.${rt.buildId}.json`, "/runtime/runtime-manifest.json"], [`/snapshots/index.${rt.buildId}.json`, "/snapshots/index.json"], [`/snapshots/profiles-index.${rt.buildId}.json`, "/profiles/index.json"]];
for (const [copy, of] of COPIES) {
  need(copy);
  if (existsSync(pub + copy) && !readFileSync(pub + copy).equals(readFileSync(pub + of))) {
    console.error(`STALE: ${pub + copy} is not byte-identical to ${pub + of} — python3 scripts/stage-snapshots.py --copies`); bad = true;
  }
}
const STRAYS = [["/runtime", /^runtime-manifest\.(.+)\.json$/, "its release keeps its own"], ["/snapshots", /^(?:profiles-)?index\.(.+)\.json$/, "R2 keeps its own"]];
for (const [dir, copyName, keeps] of STRAYS) for (const f of readdirSync(pub + dir)) {
  const other = copyName.exec(f)?.[1];
  if (other !== undefined && other !== rt.buildId) { console.error(`STRAY: ${pub}${dir}/${f} is a copy for ${other}, manifest is ${rt.buildId} — remove it (${keeps})`); bad = true; }
}
if (bad) { if (COPIES.some(([c]) => !existsSync(pub + c))) console.error("(the pinned runtime manifest and the per-runtime index copies: python3 scripts/stage-snapshots.py --copies)"); process.exit(3); }
console.log(`preflight ok: runtime ${rt.buildId}: ${chunks} chunks, ${parts} profile parts, ${(sn.snapshots ?? []).length} snapshots, the pinned runtime manifest + ${COPIES.length - 1} per-runtime index copies (${files} files)`);
