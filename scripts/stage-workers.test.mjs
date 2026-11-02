/* scripts/stage-workers.sh, the runtime-schema check (QED64's review, M3):
 * `node --test scripts/stage-workers.test.mjs`.
 *
 * The real script runs in this tree, so it needs the install (npm ci) and the
 * earlier checks must pass. STAGE_WORKERS_RECORD and STAGE_WORKERS_CLOSURE
 * point its floor and schema checks at temp copies of the pinned record and
 * closure, with the two keys under test set per case, so the cases do not
 * depend on what the current pin lists. Refusals exit before staging; every
 * accepting case runs with --check, which writes nothing.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V1 = "org.lean-browser64.runtime/v1", V2 = "org.lean-browser64.runtime/v2", V9 = "org.lean-browser64.runtime/v9";
let tmp, RECORD, CLOSURE;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "l4g-stage-workers-"));
  RECORD = JSON.parse(fs.readFileSync(path.join(root, "wasm/lean4-wasm64-release.json"), "utf8"));
  const pkg = path.dirname(createRequire(path.join(root, "client/package.json")).resolve("qed64/package.json"));
  CLOSURE = JSON.parse(fs.readFileSync(path.join(pkg, "embedding/closure.json"), "utf8"));
});
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

const script = (args, env = {}) => spawnSync("bash", ["scripts/stage-workers.sh", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });

/** The script on copies with these runtime keys set (undefined: absent). */
function check({ schema, manifestSchemas, minKernelPatch }, args = ["--check"]) {
  const rec = structuredClone(RECORD), clo = structuredClone(CLOSURE);
  delete rec.runtime.schema;
  delete clo.runtime.manifestSchemas;
  if (schema !== undefined) rec.runtime.schema = schema;
  if (manifestSchemas !== undefined) clo.runtime.manifestSchemas = manifestSchemas;
  if (minKernelPatch !== undefined) clo.runtime.minKernelPatch = minKernelPatch;
  const STAGE_WORKERS_RECORD = path.join(tmp, "release.json"), STAGE_WORKERS_CLOSURE = path.join(tmp, "closure.json");
  fs.writeFileSync(STAGE_WORKERS_RECORD, JSON.stringify(rec));
  fs.writeFileSync(STAGE_WORKERS_CLOSURE, JSON.stringify(clo));
  return script(args, { STAGE_WORKERS_RECORD, STAGE_WORKERS_CLOSURE });
}

test("the pin as installed passes --check, floor and schema", () => {
  const r = script(["--check"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /meets their floor/);
  assert.match(r.stdout, /they read runtime schema org\.lean-browser64\.runtime\/v/);
});

for (const [name, keys, served] of [
  ["no schema in the record, no list in the closure (v1 on both sides)", {}, V1],
  ["a v1 record, no list", { schema: V1 }, V1],
  ["no schema in the record, a v1 list", { manifestSchemas: [V1] }, V1],
  ["no schema in the record, a list of v1 and v2", { manifestSchemas: [V1, V2] }, V1],
  ["a v1 record, a list of v1 and v2", { schema: V1, manifestSchemas: [V1, V2] }, V1],
  ["a v2 record, a list of v1 and v2", { schema: V2, manifestSchemas: [V1, V2] }, V2],
]) {
  test(`accepted: ${name}`, () => {
    const r = check(keys);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`they read runtime schema ${served} `), r.stdout);
  });
}

for (const [name, keys, schema] of [
  ["a v2 record, no list (an old worker reads v1 only)", { schema: V2 }, V2],
  ["a v2 record, a v1 list", { schema: V2, manifestSchemas: [V1] }, V2],
  ["a schema nobody reads", { schema: V9, manifestSchemas: [V1, V2] }, V9],
  ["a v1 record, a v2-only list", { schema: V1, manifestSchemas: [V2] }, V1],
  ["no schema in the record (v1), a v2-only list", { manifestSchemas: [V2] }, V1],
  ["an empty list", { schema: V1, manifestSchemas: [] }, V1],
  ["a list that is not a list", { schema: V1, manifestSchemas: V1 }, V1],
]) {
  test(`refused, exit 2: ${name}`, () => {
    const r = check(keys);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /^stage-workers: the qed64 workers read runtime manifest schemas /);
    assert.ok(r.stderr.includes(`schema ${JSON.stringify(schema)} `), r.stderr);
    assert.match(r.stderr, /closure\.json runtime\.manifestSchemas/);
  });
}

test("a build refuses too, before it stages anything", () => {
  const r = check({ schema: V2 }, []);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /read runtime manifest schemas/);
  assert.doesNotMatch(r.stdout, /staged workers/);
});

test("the floor still reads the same closure, and refuses first", () => {
  const r = check({ schema: V2, minKernelPatch: "9999" });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /need kernel patch 9999 or newer/);
});
