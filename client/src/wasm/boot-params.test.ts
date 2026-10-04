// Run: node --import ./client/src/wasm/ts-resolve-hook.mjs client/src/wasm/boot-params.test.ts
// SEC1 (review of 4083fb4): the dev overrides `?snapshots=` / `?profiles=`
// / `?runtime=` are judged by ONE rule (boot-params.ts, QED64's draft §4)
// before anything fetches with them, and an index or manifest naming
// another origin is refused whole. The vectors are the review's: every
// spelling a browser resolves to https://evil.example/…/index.json once the
// index fetch splices the value into `/${dir}/index.json` — raw, percent-
// encoded (URLSearchParams decodes), backslash (a slash in special schemes),
// a tab (the URL parser strips it) — plus the path traversals, the length
// bound, an empty and a doubled value; and the legitimate dev uses that must
// keep working (`staging`, `snapshots-0031`, `snapshots/widgets8`). The
// integration half runs the REAL games-api.ts against a fake fetch that
// records every URL: a refused value fetches NOTHING (no fallback to the
// served index), an accepted one fetches exactly its same-origin index.
import assert from "node:assert/strict";

const SITE = "https://lean4game.example";
const PAGE = `${SITE}/#/g/hhu-adam/NNG4/world/Tutorial/level/1`;
const bp = await import("./boot-params");
const { parseBootParams, isSameOrigin, isSec1Refusal, refuseForeignSnapshotUrls, refuseForeignManifestUrls, SEC1_REFUSAL_RE, DIR_OVERRIDE } = bp;

let failures = 0;
async function test(name: string, body: () => void | Promise<void>): Promise<void> {
  try { await body(); console.log(`ok - ${name}`); } catch (e) { failures++; console.log(`not ok - ${name}\n  ${String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n  ")}`); }
}

/** [query value as it appears in the address, decoded value, the hole:
 * does `/${decoded}/index.json` — the pre-SEC1 splice — resolve to another
 * origin?] */
const REFUSED: [string, string, boolean][] = [
  ["/evil.example/x", "/evil.example/x", true],
  ["//evil.example/x", "//evil.example/x", true],
  ["%2Fevil.example%2Fx", "/evil.example/x", true],
  ["%2F%2Fevil.example", "//evil.example", true],
  ["\\evil.example/x", "\\evil.example/x", true],
  ["%5Cevil.example", "\\evil.example", true],
  ["%5C%5Cevil.example", "\\\\evil.example", true],
  ["\\/evil.example", "\\/evil.example", true],
  ["/%5Cevil.example", "/\\evil.example", true],
  ["%09/evil.example", "\t/evil.example", true],
  ["https://evil.example/x", "https://evil.example/x", false],
  ["https:evil.example", "https:evil.example", false],
  ["..", "..", false],
  ["a/../../x", "a/../../x", false],
  ["snapshots/..", "snapshots/..", false],
  ["snapshots/snapshots/x", "snapshots/snapshots/x", false],
  [".hidden", ".hidden", false],
  ["-x", "-x", false],
  ["a+b", "a b", false],
  ["staging%3Fx", "staging?x", false],
  ["stag%C3%ADng", "stagíng", false],
  ["a".repeat(65), "a".repeat(65), false],
  // Empty: the old code read it as "no override" (a silent fallback);
  // spliced it would be `//index.json` — a host named index.json.
  ["", "", true],
];
const ACCEPTED = ["snapshots/widgets8", "snapshots-0031", "staging", "a".repeat(64), "snapshots/" + "b".repeat(64), "nng4.dev_2-x"];

await test("the review's vectors: each decoded the way the browser does, and each refused for ?snapshots and ?profiles", () => {
  for (const [raw, decoded, hole] of REFUSED) {
    assert.equal(new URLSearchParams(`snapshots=${raw}`).get("snapshots"), decoded, `decoding ${JSON.stringify(raw)}`);
    const crossOriginBefore = new URL(`/${decoded}/index.json`, PAGE).origin !== SITE;
    assert.equal(crossOriginBefore, hole, `${JSON.stringify(raw)} ${hole ? "splices" : "does not splice"} into a cross-origin index URL`);
    for (const name of ["snapshots", "profiles"] as const) {
      const p = parseBootParams(`?${name}=${raw}`, PAGE);
      assert.equal(p[name], null, `?${name}=${raw} is not used`);
      assert.deepEqual(p.refusedNames, [name], `?${name}=${raw} is refused`);
      assert.equal(p.refused[0]!.code, "BOOT_PARAM_REFUSED");
      assert.match(p.refused[0]!.message, new RegExp(`^refused \\?${name}=`));
      assert.match(p.refused[0]!.message, /\(BOOT_PARAM_REFUSED\) — only a same-origin/);
    }
  }
});

await test("the legitimate dev uses are accepted (staging, snapshots-0031, snapshots/widgets8, the 64-character bound)", () => {
  for (const v of ACCEPTED) {
    const p = parseBootParams(`?snapshots=${v}&profiles=${v}`, PAGE);
    assert.deepEqual([p.snapshots, p.profiles, p.refused.length], [v, v, 0], v);
    assert.equal(new URL(`/${v}/index.json`, PAGE).origin, SITE);
  }
  assert.deepEqual(parseBootParams("", PAGE), { snapshots: null, profiles: null, runtime: null, refused: [], refusedNames: [] }, "no override: nothing set, nothing refused");
  assert.deepEqual(parseBootParams("?other=1&snapshot=x", PAGE).refused, [], "other parameters are not this rule's business");
});

await test("the rule's second half: a value the pattern admits must still resolve to the page's origin", () => {
  // No ASCII value the pattern admits leaves the origin; the check stands
  // behind it (a widened pattern, a page on an opaque origin).
  assert.equal(DIR_OVERRIDE.test("staging"), true);
  assert.equal(parseBootParams("?snapshots=staging", "file:///Users/x/index.html").refusedNames[0], "snapshots", "an opaque page origin admits nothing");
  assert.equal(parseBootParams("?snapshots=staging", "not a url").refusedNames[0], "snapshots", "an unparsable page URL admits nothing");
  assert.equal(isSameOrigin("/staging/index.json", PAGE), true);
  for (const u of ["//evil.example/x", "\\\\evil.example/x", "/\\evil.example", "\t//evil.example", "https://evil.example/", "http://lean4game.example/x", "https://lean4game.example:444/x", "data:application/json,{}", "javascript:alert(1)"]) {
    assert.equal(isSameOrigin(u, PAGE), false, JSON.stringify(u));
  }
  for (const u of ["/snapshots/nng4.db264c5f3eb7c69c.snapz", "snapshots/x", `${SITE}/runtime/chunks/lean.js.aa.part-000`, "blob:https://lean4game.example/0b9f"]) {
    assert.equal(isSameOrigin(u, PAGE), true, JSON.stringify(u));
  }
  assert.equal(isSameOrigin(undefined, PAGE), false);
  assert.equal(isSameOrigin(42, PAGE), false);
});

await test("?runtime= is a build id or refused (no path traversal, no other origin, no empty value)", () => {
  assert.equal(parseBootParams("?runtime=wasm64-d77d34b97592d014", PAGE).runtime, "wasm64-d77d34b97592d014");
  for (const v of ["/../../evil", "//evil.example/x", "..%2F..%2Fapi%2Fgames%3F", "wasm64-D77D34B97592D014", "wasm64-0123", "wasm64-d77d34b97592d0145", "d77d34b97592d014", "", "wasm64-d77d34b97592d014%0A"]) {
    const p = parseBootParams(`?runtime=${v}`, PAGE);
    assert.deepEqual([p.runtime, p.refusedNames], [null, ["runtime"]], v);
    assert.match(p.refused[0]!.message, /^refused \?runtime=.* \(BOOT_PARAM_REFUSED\) — only a runtime build id/);
  }
});

await test("a parameter given twice is refused (no first-one-wins ambiguity), and every refusal is reported", () => {
  const p = parseBootParams("?snapshots=staging&snapshots=//evil.example&runtime=x&profiles=staging", PAGE);
  assert.deepEqual(p.refusedNames, ["snapshots", "runtime"]);
  assert.equal(p.snapshots, null);
  assert.equal(p.profiles, "staging");
  assert.match(p.refused[0]!.message, /given 2 times/);
});

await test("the card's text: the value quoted with escapes and bounded (attacker-chosen), the code matched by SEC1_REFUSAL_RE", () => {
  const tab = parseBootParams("?snapshots=%09/evil.example", PAGE).refused[0]!;
  assert.match(tab.message, /refused \?snapshots="\\t\/evil\.example"/);
  const long = parseBootParams(`?snapshots=${"z".repeat(500)}`, PAGE).refused[0]!;
  assert.ok(long.message.length < 400, "a long value is cut");
  assert.ok(long.message.includes(`${"z".repeat(80)}…`));
  assert.equal(SEC1_REFUSAL_RE.exec(`Lean failed to start: ${tab.message}`)?.[1], "BOOT_PARAM_REFUSED");
  assert.equal(isSec1Refusal(tab), true);
  assert.equal(isSec1Refusal(new Error(tab.message)), true, "recognised by its code after crossing a label");
  assert.equal(isSec1Refusal(new Error("Failed to fetch")), false);
});

await test("overrideOf / assertBootParams read the page once per document and THROW a refusal (never null for a refused value)", () => {
  (globalThis as { location?: unknown }).location = new URL(`${SITE}/?snapshots=//evil.example/x&runtime=wasm64-d77d34b97592d014#/g/a/b`);
  assert.throws(() => bp.overrideOf("snapshots"), (e: unknown) => isSec1Refusal(e) && (e as { code: string }).code === "BOOT_PARAM_REFUSED");
  assert.equal(bp.overrideOf("runtime"), "wasm64-d77d34b97592d014");
  assert.equal(bp.overrideOf("profiles"), null);
  assert.throws(() => bp.assertBootParams(), /refused \?snapshots=/);
  // A replaceState on the same document changes `search`, not the verdict.
  const sameDoc = (globalThis as unknown as { location: URL }).location;
  sameDoc.search = "";
  assert.throws(() => bp.overrideOf("snapshots"), /refused/, "the first reading holds for the document");
  (globalThis as { location?: unknown }).location = new URL(`${SITE}/?snapshots=staging`);
  assert.equal(bp.overrideOf("snapshots"), "staging", "a new document reads again");
  bp.assertBootParams();
});

await test("SEC1-R2: the card's way out — the same address without the overrides (a reload refuses again), the level and other parameters kept", () => {
  const level = "#/g/hhu-adam/NNG4/world/Tutorial/level/1";
  assert.equal(bp.addressWithoutOverrides(`${SITE}/?snapshots=//evil.example/x${level}`), `${SITE}/${level}`);
  assert.equal(bp.addressWithoutOverrides(`${SITE}/?lang=de&%73napshots=%2F%2Fevil.example&profiles=p&runtime=r&runtime=s&x=1${level}`), `${SITE}/?lang=de&x=1${level}`, "encoded and doubled names go too");
  const plain = `${SITE}/?lang=de${level}`;
  assert.equal(bp.addressWithoutOverrides(plain), plain, "nothing to remove: the address itself");
  for (const [raw] of REFUSED) {
    for (const name of ["snapshots", "profiles", "runtime"]) {
      const before = `${SITE}/?${name}=${raw}${level}`;
      assert.ok(parseBootParams(new URL(before).search, before).refused.length > 0, before);
      const after = bp.addressWithoutOverrides(before);
      assert.deepEqual(parseBootParams(new URL(after).search, after).refused, [], `${before} → ${after}`);
      assert.equal(new URL(after).hash, level);
    }
  }
  const calls: string[] = [];
  const loc = (href: string) => ({ href, assign: (u: string | URL) => { calls.push(`assign ${u}`); }, reload: () => { calls.push("reload"); } });
  bp.openWithoutOverrides(loc(`${SITE}/?snapshots=%5C%5Cevil.example${level}`));
  bp.openWithoutOverrides(loc(plain));
  assert.deepEqual(calls, [`assign ${SITE}/${level}`, "reload"], "a search change loads a new document; with nothing to drop, a reload does");
});

const LIVE_DIGEST = "sha256:" + "ab".repeat(32);
const entry = (name: string, url: string) => ({ name, url, digest: LIVE_DIGEST, bytes: 10, imports: [], runtime: "wasm64-d77d34b97592d014" });
const index = (...snapshots: ReturnType<typeof entry>[]) => ({ schema: "qed64.snapshot-index/v1", snapshots });

await test("a snapshot index with ANY entry on another origin is refused whole, with a coded error", () => {
  refuseForeignSnapshotUrls(index(entry("nng4", "/snapshots/nng4.db264c5f3eb7c69c.snapz"), entry("rag", `${SITE}/snapshots/rag.a7a0c2f7f57b3ce2.snapz`)), PAGE);
  for (const bad of ["https://cdn.attacker.example/r.snapz", "//cdn.attacker.example/r.snapz", "\\\\cdn.attacker.example/r.snapz", "data:application/octet-stream;base64,AA==", "http://lean4game.example/snapshots/x.snapz"]) {
    assert.throws(() => refuseForeignSnapshotUrls(index(entry("nng4", "/snapshots/nng4.db264c5f3eb7c69c.snapz"), entry("rag", bad)), PAGE),
      (e: unknown) => isSec1Refusal(e) && (e as { code: string }).code === "SNAPSHOT_INDEX_FOREIGN_URL" && /entry "rag" points to/.test((e as Error).message), bad);
  }
});

await test("a runtime manifest with a chunk on another origin is refused, with a coded error", () => {
  const m = (url: unknown) => ({ buildId: "b", leanVersion: "4", files: { "lean.js": { bytes: 1, sha256: "", chunks: [{ url: "/runtime/chunks/lean.js.aa.part-000", bytes: 1, sha256: "" }] }, "lean.wasm": { bytes: 1, sha256: "", chunks: [{ url, bytes: 1, sha256: "" }] } } });
  refuseForeignManifestUrls(m("/runtime/chunks/lean.wasm.bb.part-000") as never, PAGE);
  for (const bad of ["https://evil.example/c", "//evil.example/c", undefined]) {
    assert.throws(() => refuseForeignManifestUrls(m(bad) as never, PAGE), (e: unknown) => isSec1Refusal(e) && (e as { code: string }).code === "RUNTIME_MANIFEST_FOREIGN_URL" && /lean\.wasm chunk 0/.test((e as Error).message), String(bad));
  }
});

/* ---- the real games-api.ts against a recording fetch ------------------- */
let seen: string[] = [];
let served: { index?: unknown; manifest?: unknown } = {};
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
(globalThis as { fetch: unknown }).fetch = async (input: string) => {
  const u = new URL(String(input), (globalThis as unknown as { location: URL }).location.href);
  seen.push(u.origin === SITE ? u.pathname : `${u.href} [CROSS-ORIGIN]`);
  if (u.origin !== SITE) return json(index(entry("nng4", "https://cdn.attacker.example/r.snapz")));
  if (u.pathname.startsWith("/runtime/runtime-manifest")) return json(served.manifest ?? { buildId: "wasm64-d77d34b97592d014", leanVersion: "4", files: { "lean.js": { bytes: 1, sha256: "", chunks: [] }, "lean.wasm": { bytes: 1, sha256: "", chunks: [] } } });
  if (u.pathname.endsWith("/index.json")) return json(served.index ?? index(entry("nng4", "/snapshots/nng4.db264c5f3eb7c69c.snapz")));
  return new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
};
let n = 0;
async function api(query: string) {
  (globalThis as { location?: unknown }).location = new URL(`${SITE}/${query}#/g/hhu-adam/NNG4/world/Tutorial/level/1`);
  seen = [];
  return await import(`./games-api.ts?case=${n++}`) as typeof import("./games-api");
}

await test("games-api: a refused ?snapshots= fetches NOTHING — no attacker index, and no served index in its place", async () => {
  for (const [raw] of REFUSED) {
    const g = await api(`?snapshots=${raw}`);
    await assert.rejects(g.fetchSnapshotIndexOnce(), (e: unknown) => isSec1Refusal(e), raw);
    assert.throws(() => g.devSnapshotsDir(), /refused \?snapshots=/, raw);
    assert.deepEqual(seen, [], `?snapshots=${raw} fetched ${seen.join(", ")}`);
  }
});

await test("games-api: an accepted ?snapshots=staging reads /staging/index.json and re-roots its urls there (UX-PARITY's dev index)", async () => {
  const g = await api("?snapshots=staging");
  const idx = await g.fetchSnapshotIndexOnce();
  assert.deepEqual(seen, ["/staging/index.json"]);
  assert.equal(idx!.snapshots[0]!.url, "/staging/nng4.db264c5f3eb7c69c.snapz");
  assert.equal(g.devSnapshotsDir(), "staging", "the sweep stands down");
  const plain = await api("");
  await plain.fetchSnapshotIndexOnce();
  assert.deepEqual(seen, ["/snapshots/index.json"]);
  assert.equal(plain.devSnapshotsDir(), null);
});

await test("games-api: an index (default or dev) naming another origin is refused whole — the re-root does not launder an absolute url", async () => {
  try {
    served.index = index(entry("nng4", "/snapshots/nng4.db264c5f3eb7c69c.snapz"), entry("rag", "https://cdn.attacker.example/snapshots/rag.snapz"));
    const g = await api("");
    await assert.rejects(g.fetchSnapshotIndexOnce(), (e: unknown) => isSec1Refusal(e) && (e as { code: string }).code === "SNAPSHOT_INDEX_FOREIGN_URL");
    await assert.rejects(g.tileSnapshotStates([{ snapshot: "nng4", gameId: "g/hhu-adam/NNG4" }]), (e: unknown) => isSec1Refusal(e), "the landing tiles get the refusal, not the index");
    const dev = await api("?snapshots=staging");
    await assert.rejects(dev.fetchSnapshotIndexOnce(), /SNAPSHOT_INDEX_FOREIGN_URL/);
    served.index = index(entry("nng4", "//cdn.attacker.example/snapshots/nng4.snapz"));
    await assert.rejects((await api("?snapshots=staging")).fetchSnapshotIndexOnce(), /SNAPSHOT_INDEX_FOREIGN_URL/);
  } finally { served = {}; }
});

await test("games-api: ?runtime= — a build id picks its manifest; a refused value fetches nothing; a foreign chunk refuses the manifest", async () => {
  const ok = await api("?runtime=wasm64-d77d34b97592d014");
  await ok.resolveRuntimeManifest();
  assert.deepEqual(seen, ["/runtime/runtime-manifest.wasm64-d77d34b97592d014.json"]);
  for (const v of ["/../../evil", "//evil.example/x", "%2F..%2F..%2Fapi%2Fgames%3F"]) {
    const g = await api(`?runtime=${v}`);
    await assert.rejects(g.resolveRuntimeManifest(), /refused \?runtime=/, v);
    assert.deepEqual(seen, [], `?runtime=${v} fetched ${seen.join(", ")}`);
  }
  try {
    served.manifest = { buildId: "wasm64-d77d34b97592d014", leanVersion: "4", files: { "lean.js": { bytes: 1, sha256: "", chunks: [{ url: "https://evil.example/lean.js.part-000", bytes: 1, sha256: "" }] }, "lean.wasm": { bytes: 1, sha256: "", chunks: [] } } };
    await assert.rejects((await api("")).resolveRuntimeManifest(), /RUNTIME_MANIFEST_FOREIGN_URL/);
  } finally { served = {}; }
});

await test("games-api: the landing tiles of a page with ANY refused override fetch nothing (the boot's gate)", async () => {
  for (const q of ["?snapshots=//evil.example/x", "?profiles=%5C%5Cevil.example", "?runtime=..%2Fx"]) {
    const g = await api(q);
    await assert.rejects(g.tileSnapshotStates([{ snapshot: "nng4", gameId: "g/hhu-adam/NNG4" }]), /\(BOOT_PARAM_REFUSED\)/, q);
    assert.deepEqual(seen, [], `${q} fetched ${seen.join(", ")}`);
  }
});

await test("games-api: ?profiles= goes through the same rule", async () => {
  assert.equal((await api("?profiles=staging")).devProfilesDir(), "staging");
  const g = await api("?profiles=/evil.example/p");
  assert.throws(() => g.devProfilesDir(), /refused \?profiles="\/evil\.example\/p" \(BOOT_PARAM_REFUSED\)/);
});

if (failures) { console.log(`boot-params: ${failures} FAILED`); process.exit(1); }
console.log("boot-params: ALL TESTS PASS");
