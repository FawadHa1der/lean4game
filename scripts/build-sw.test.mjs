/* scripts/build-sw.mjs, the service worker's precache lists:
 * `node --test scripts/build-sw.test.mjs`.
 *
 * The script runs for real on a small built tree under the OS temp dir (its
 * one argument), and the PRECACHE / CRITICAL lists are read back from the
 * sw.js it writes there.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = "wasm64-57ae00dc5f6ce958";
/** QED64 HARDENING #64: the pinned runtime manifest and the per-build index
 * copies the page reads in a pairing window (games-api fetchSnapshotIndexOnce,
 * qed64's installArtifacts). */
const PINNED = [`/runtime/runtime-manifest.${BUILD}.json`, `/snapshots/index.${BUILD}.json`, `/snapshots/profiles-index.${BUILD}.json`];

function build({ copies }) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "build-sw-test-"));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dist, rel)), { recursive: true });
    fs.writeFileSync(path.join(dist, rel), text);
  };
  write("index.html", '<!doctype html><script type="module" src="/assets/index-AbCdEfGh.js"></script>');
  write("assets/index-AbCdEfGh.js", "export {};");
  write("runtime/runtime-manifest.json", JSON.stringify({ buildId: BUILD }));
  write("runtime/chunks/lean.wasm.0123456789abcdef.part-000", "x");
  write("snapshots/index.json", "{}");
  write("snapshots/nng4.0123456789abcdef.snapz", "x");
  write("profiles/index.json", "{}");
  if (copies) for (const p of PINNED) write(p.slice(1), "{}");
  const r = spawnSync(process.execPath, [path.join(root, "scripts/build-sw.mjs"), dist], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const sw = fs.readFileSync(path.join(dist, "sw.js"), "utf8");
  fs.rmSync(dist, { recursive: true, force: true });
  const list = (name) => JSON.parse(new RegExp(`^const ${name} = (\\[.*\\]);$`, "m").exec(sw)?.[1] ?? "null");
  return { precache: list("PRECACHE"), critical: list("CRITICAL"), version: /^const VERSION = "([0-9a-f]{12})";$/m.exec(sw)?.[1] };
}

test("#64: the pinned runtime manifest and both per-build index copies are precached by the install (CRITICAL)", () => {
  const { precache, critical, version } = build({ copies: true });
  assert.match(version ?? "", /^[0-9a-f]{12}$/);
  for (const p of PINNED) {
    assert.ok(precache.includes(p), `${p} in PRECACHE`);
    assert.ok(critical.includes(p), `${p} in CRITICAL: a first visit's install caches it, so an offline revisit in a pairing window has it`);
  }
  for (const p of ["/runtime/runtime-manifest.json", "/snapshots/index.json", "/profiles/index.json"]) assert.ok(critical.includes(p), p);
  // the artifacts themselves stay out (OPFS and the runtime cache own them)
  assert.ok(!precache.some((p) => /\.snapz$|\.part-\d+$/.test(p)), "no snapshot or chunk");
  assert.equal(new Set(precache).size, precache.length, "no duplicate");
});

test("#64: a tree without the copies (a bare checkout; R2 serves them) still lists them", () => {
  const { precache, critical } = build({ copies: false });
  for (const p of PINNED) {
    assert.ok(precache.includes(p), p);
    assert.ok(critical.includes(p), p);
  }
});
