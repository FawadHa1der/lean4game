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
/** What a boot reads before the worker controls a first visit. */
const MANIFESTS = ["/runtime/runtime-manifest.json", "/snapshots/index.json", "/profiles/index.json", "/profiles/lean-core.manifest.json"];
/** QED64 HARDENING #64's names, which a staged tree may still hold: no shell reads them (review D2). */
const RETIRED = [`/runtime/runtime-manifest.${BUILD}.json`, `/snapshots/index.${BUILD}.json`, `/snapshots/profiles-index.${BUILD}.json`];

function build({ leftovers = false, indexBytes = "{}" } = {}) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "build-sw-test-"));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dist, rel)), { recursive: true });
    fs.writeFileSync(path.join(dist, rel), text);
  };
  write("index.html", '<!doctype html><script type="module" src="/assets/index-AbCdEfGh.js"></script>');
  write("assets/index-AbCdEfGh.js", "export {};");
  write("runtime/runtime-manifest.json", JSON.stringify({ buildId: BUILD }));
  write("runtime/chunks/lean.wasm.0123456789abcdef.part-000", "x");
  write("snapshots/index.json", indexBytes);
  write("snapshots/nng4.0123456789abcdef.snapz", "x");
  write("profiles/index.json", "{}");
  write("profiles/lean-core.manifest.json", "{}");
  if (leftovers) for (const p of RETIRED) write(p.slice(1), "{}");
  const r = spawnSync(process.execPath, [path.join(root, "scripts/build-sw.mjs"), dist], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const sw = fs.readFileSync(path.join(dist, "sw.js"), "utf8");
  fs.rmSync(dist, { recursive: true, force: true });
  const list = (name) => JSON.parse(new RegExp(`^const ${name} = (\\[.*\\]);$`, "m").exec(sw)?.[1] ?? "null");
  return { precache: list("PRECACHE"), critical: list("CRITICAL"), version: /^const VERSION = "([0-9a-f]{12})";$/m.exec(sw)?.[1] };
}

test("the runtime manifest and the two indexes are precached by the install (CRITICAL), at their fixed names", () => {
  const { precache, critical, version } = build();
  assert.match(version ?? "", /^[0-9a-f]{12}$/);
  for (const p of MANIFESTS) {
    assert.ok(precache.includes(p), `${p} in PRECACHE`);
    assert.ok(critical.includes(p), `${p} in CRITICAL: a first visit's install caches it, so an offline revisit has it`);
  }
  // the artifacts themselves stay out (OPFS and the runtime cache own them)
  assert.ok(!precache.some((p) => /\.snapz$|\.part-\d+$/.test(p)), "no snapshot or chunk");
  assert.equal(new Set(precache).size, precache.length, "no duplicate");
});

test("D2: no per-build name is precached, whatever a staged tree holds", () => {
  for (const leftovers of [false, true]) {
    const { precache, critical } = build({ leftovers });
    for (const p of RETIRED) {
      assert.ok(!precache.includes(p), p);
      assert.ok(!critical.includes(p), p);
    }
  }
});

test("D2: the deployed index counts in the version, so a same-runtime rebake reaches returning users", () => {
  assert.notEqual(build({ indexBytes: "{}" }).version, build({ indexBytes: '{"snapshots":[]}' }).version);
});
