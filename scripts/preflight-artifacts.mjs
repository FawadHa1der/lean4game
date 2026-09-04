// Every file the manifests and indexes name must exist locally and be paired
// to the same runtime build — a partial or mixed tree would strand the site.
// Used by scripts/upload-artifacts.sh; run alone to check a staged tree:
//   node scripts/preflight-artifacts.mjs [client/public]
import { existsSync, readFileSync } from "node:fs";
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
if (bad) process.exit(3);
console.log(`preflight ok: runtime ${rt.buildId}: ${chunks} chunks, ${parts} profile parts, ${(sn.snapshots ?? []).length} snapshots (${files} files)`);
