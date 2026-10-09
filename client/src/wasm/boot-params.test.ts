// Run: node --import ./client/src/wasm/ts-resolve-hook.mjs client/src/wasm/boot-params.test.ts
// SEC1 (review of 4083fb4): the dev overrides `?snapshots=` / `?profiles=`
// / `?runtime=` are judged by ONE rule (qed64's validateBootOverrides,
// docs/EMBEDDING.md §4, with this page's stricter empty and doubled cases —
// boot-params.ts) before anything fetches with them, and an index or
// manifest naming another origin is refused whole. The vectors are the review's: every
// spelling a browser resolves to https://evil.example/…/index.json once the
// index fetch splices the value into `/${dir}/index.json` — raw, percent-
// encoded (URLSearchParams decodes), backslash (a slash in special schemes),
// a tab (the URL parser strips it) — plus the path traversals, the length
// bound, an empty and a doubled value; and the legitimate dev uses that must
// keep working (`staging`, `snapshots-0031`, `snapshots/widgets8`;
// `profiles/<dir>` for profiles — qed64's rule). The integration half runs
// the REAL games-api.ts (over qed64's loaders) against a fake fetch that
// records every URL: a refused value fetches NOTHING (no fallback to the
// served index), an accepted one fetches exactly its same-origin index, an
// index naming another origin is refused with SEC1's code, and a dev index
// that cannot be read is a named failure.
import assert from "node:assert/strict";

const SITE = "https://lean4game.example";
const PAGE = `${SITE}/#/g/hhu-adam/NNG4/world/Tutorial/level/1`;
const bp = await import("./boot-params");
const { parseBootParams, isSameOrigin, isSec1Refusal, refuseForeignManifestUrls, SEC1_REFUSAL_RE } = bp;

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
/** ?profiles=: the same, under the promoted profiles directory's own name. */
const ACCEPTED_PROFILES = ACCEPTED.map((v) => v.replace(/^snapshots\//, "profiles/"));

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
  ACCEPTED.forEach((v, i) => {
    const pv = ACCEPTED_PROFILES[i]!;
    const p = parseBootParams(`?snapshots=${v}&profiles=${pv}`, PAGE);
    assert.deepEqual([p.snapshots, p.profiles, p.refused.length], [v, pv, 0], v);
    assert.equal(new URL(`/${v}/index.json`, PAGE).origin, SITE);
  });
  // qed64's rule: a profile directory nests under `profiles/`, not `snapshots/`.
  assert.deepEqual(parseBootParams("?profiles=snapshots/widgets8", PAGE).refusedNames, ["profiles"]);
  assert.deepEqual(parseBootParams("?snapshots=profiles/widgets8", PAGE).refusedNames, ["snapshots"]);
  assert.deepEqual(parseBootParams("", PAGE), { snapshots: null, profiles: null, runtime: null, refused: [], refusedNames: [] }, "no override: nothing set, nothing refused");
  assert.deepEqual(parseBootParams("?other=1&snapshot=x", PAGE).refused, [], "other parameters are not this rule's business");
});

await test("the rule's second half: a value the pattern admits must still resolve to the page's origin", () => {
  // No ASCII value the pattern admits leaves the origin; the check stands
  // behind it (a widened pattern, a page on an opaque origin).
  assert.equal(parseBootParams("?snapshots=staging", PAGE).snapshots, "staging");
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

await test("bootOverrides / assertBootParams read the page once per document and THROW a refusal (never null for a refused value)", () => {
  (globalThis as { location?: unknown }).location = new URL(`${SITE}/?snapshots=//evil.example/x&runtime=wasm64-d77d34b97592d014#/g/a/b`);
  assert.throws(() => bp.bootOverrides(), (e: unknown) => isSec1Refusal(e) && (e as { code: string }).code === "BOOT_PARAM_REFUSED" && /\?snapshots=/.test((e as Error).message));
  assert.throws(() => bp.assertBootParams(), /refused \?snapshots=/);
  assert.deepEqual(bp.bootParams().runtime, "wasm64-d77d34b97592d014", "the accepted one is still read (and reported)");
  // A replaceState on the same document changes `search`, not the verdict.
  const sameDoc = (globalThis as unknown as { location: URL }).location;
  sameDoc.search = "";
  assert.throws(() => bp.bootOverrides(), /refused/, "the first reading holds for the document");
  (globalThis as { location?: unknown }).location = new URL(`${SITE}/?snapshots=staging&runtime=wasm64-d77d34b97592d014`);
  assert.deepEqual(bp.bootOverrides(), { snapshots: "staging", profiles: null, runtime: "wasm64-d77d34b97592d014" }, "a new document reads again, in qed64's shape");
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

await test("a runtime manifest with a chunk on another origin is refused, with a coded error", () => {
  const m = (url: unknown) => ({ buildId: "b", leanVersion: "4", files: { "lean.js": { bytes: 1, sha256: "", chunks: [{ url: "/runtime/chunks/lean.js.aa.part-000", bytes: 1, sha256: "" }] }, "lean.wasm": { bytes: 1, sha256: "", chunks: [{ url, bytes: 1, sha256: "" }] } } });
  refuseForeignManifestUrls(m("/runtime/chunks/lean.wasm.bb.part-000") as never, PAGE);
  for (const bad of ["https://evil.example/c", "//evil.example/c", undefined]) {
    assert.throws(() => refuseForeignManifestUrls(m(bad) as never, PAGE), (e: unknown) => isSec1Refusal(e) && (e as { code: string }).code === "RUNTIME_MANIFEST_FOREIGN_URL" && /lean\.wasm chunk 0/.test((e as Error).message), String(bad));
  }
});

/* ---- the real games-api.ts against a recording fetch ------------------- */
let seen: string[] = [];
let served: { index?: unknown; manifest?: unknown; status?: number; copies?: Record<string, unknown> } = {};
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
// runtime/v1: buildId is "wasm64-" + sha256(lean.wasm)[:16], which qed64's resolveRuntimeManifest checks (since qed64 80ddbf6).
const WASM_SHA256 = "d77d34b97592d014" + "0".repeat(48);
/** A valid runtime/v1 manifest of `buildId` (its lean.wasm sha256 starts with the id's 16 hex). */
const manifestOf = (buildId: string) => ({ buildId, leanVersion: "4", files: { "lean.js": { bytes: 1, sha256: "", chunks: [] }, "lean.wasm": { bytes: 1, sha256: buildId.slice("wasm64-".length) + "0".repeat(48), chunks: [] } } });
(globalThis as { fetch: unknown }).fetch = async (input: string) => {
  const u = new URL(String(input), (globalThis as unknown as { location: URL }).location.href);
  seen.push(u.origin === SITE ? u.pathname : `${u.href} [CROSS-ORIGIN]`);
  if (u.origin !== SITE) return json(index(entry("nng4", "https://cdn.attacker.example/r.snapz")));
  // runtime-manifest.<id>.json is that build's manifest; the mutable one is wasm64-d77d34b97592d014's.
  if (u.pathname.startsWith("/runtime/runtime-manifest")) return json(served.manifest ?? manifestOf(/^\/runtime\/runtime-manifest\.(wasm64-[0-9a-f]{16})\.json$/.exec(u.pathname)?.[1] ?? "wasm64-d77d34b97592d014"));
  if (u.pathname.endsWith("/index.json")) return served.status ? new Response("", { status: served.status }) : json(served.index ?? index(entry("nng4", "/snapshots/nng4.db264c5f3eb7c69c.snapz")));
  // HARDENING #64's per-runtime copies (what scripts/stage-snapshots.py --copies publishes): a 404 unless the case serves one.
  const copy = /^\/snapshots\/index\.(wasm64-[0-9a-f]{16})\.json$/.exec(u.pathname)?.[1];
  if (copy !== undefined) return served.copies?.[copy] !== undefined ? json(served.copies[copy]) : new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
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
    await assert.rejects(g.resolveRuntimeManifest(), /refused \?snapshots=/, `${raw}: no artifact at all for a page carrying a refusal`);
    assert.deepEqual(seen, [], `?snapshots=${raw} fetched ${seen.join(", ")}`);
  }
});

await test("games-api: an accepted ?snapshots=staging reads /staging/index.json and re-roots its urls there (UX-PARITY's dev index)", async () => {
  const g = await api("?snapshots=staging");
  const idx = await g.fetchSnapshotIndexOnce();
  assert.deepEqual(seen, ["/staging/index.json"]);
  assert.equal(idx!.snapshots[0]!.url, "/staging/nng4.db264c5f3eb7c69c.snapz");
  assert.equal(bp.bootOverrides().snapshots, "staging", "the sweep stands down");
  const plain = await api("");
  await plain.fetchSnapshotIndexOnce();
  assert.deepEqual(seen, ["/snapshots/index.json"]);
  assert.equal(bp.bootOverrides().snapshots, null);
});

await test("games-api: a dev index that cannot be read is a named failure (qed64 §4), the served one unreadable is null and asked again", async () => {
  try {
    served.status = 404;
    await assert.rejects((await api("?snapshots=staging")).fetchSnapshotIndexOnce(), /\?snapshots=staging: \/staging\/index\.json: HTTP 404/);
    const plain = await api("");
    assert.equal(await plain.fetchSnapshotIndexOnce(), null);
    served.status = undefined;
    assert.ok(await plain.fetchSnapshotIndexOnce(), "not memoised: the next call reads it");
    assert.deepEqual(seen, ["/snapshots/index.json", "/snapshots/index.json"]);
  } finally { served = {}; }
});

await test("games-api: an index (default or dev) naming another origin is refused whole — the re-root does not launder an absolute url", async () => {
  try {
    // qed64's loader refuses it (HARDENING #57); the page reports SEC1's coded refusal, not "unreadable".
    for (const bad of ["https://cdn.attacker.example/r.snapz", "//cdn.attacker.example/r.snapz", "\\\\cdn.attacker.example/r.snapz", "data:application/octet-stream;base64,AA==", "http://lean4game.example/snapshots/x.snapz"]) {
      served.index = index(entry("nng4", "/snapshots/nng4.db264c5f3eb7c69c.snapz"), entry("rag", bad));
      await assert.rejects((await api("")).fetchSnapshotIndexOnce(), (e: unknown) => isSec1Refusal(e) && (e as { code: string }).code === "SNAPSHOT_INDEX_FOREIGN_URL" && /entry "rag" points off this site/.test((e as Error).message), bad);
    }
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
    served.manifest = { buildId: "wasm64-d77d34b97592d014", leanVersion: "4", files: { "lean.js": { bytes: 1, sha256: "", chunks: [{ url: "https://evil.example/lean.js.part-000", bytes: 1, sha256: "" }] }, "lean.wasm": { bytes: 1, sha256: WASM_SHA256, chunks: [] } } };
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
  await api("?profiles=staging");
  assert.equal(bp.bootOverrides().profiles, "staging");
  const g = await api("?profiles=/evil.example/p");
  assert.throws(() => bp.bootOverrides(), /refused \?profiles="\/evil\.example\/p" \(BOOT_PARAM_REFUSED\)/);
  await assert.rejects(g.resolveRuntimeManifest(), /refused \?profiles=/);
  assert.deepEqual(seen, []);
});

/* ---- HARDENING #64: the served index paired with the shell's pinned build --
 * An upload of the next pairing replaces /snapshots/index.json before this
 * shell's deploy; the shell (vite's __QED64_BUILD_ID__, here a global) then
 * reads its own build's copy /snapshots/index.<buildId>.json through qed64's
 * loadSnapshotIndex `pairedBuildId`, and keeps the mutable index whenever the
 * copy is not an index paired with that build. */
const PINNED = "wasm64-d77d34b97592d014";
const NEXT = "wasm64-0123456789abcdef";
const runtimeEntry = (name: string, url: string, runtime: string) => ({ ...entry(name, url), runtime });
const NNG4_PINNED = "/snapshots/nng4.db264c5f3eb7c69c.snapz";
const NNG4_NEXT = "/snapshots/nng4.1111111111111111.snapz";
const TILE = [{ snapshot: "nng4", gameId: "g/hhu-adam/NNG4" }];
async function pinned(body: () => Promise<void>): Promise<void> {
  const g = globalThis as { __QED64_BUILD_ID__?: string };
  g.__QED64_BUILD_ID__ = PINNED;
  try { await body(); } finally { delete g.__QED64_BUILD_ID__; served = {}; }
}

await test("games-api #64: an index.json naming another runtime is replaced by the pinned build's index.<buildId>.json", () => pinned(async () => {
  served.index = index(runtimeEntry("nng4", NNG4_NEXT, NEXT));
  served.copies = { [PINNED]: index(runtimeEntry("nng4", NNG4_PINNED, PINNED)) };
  const g = await api("");
  const idx = await g.fetchSnapshotIndexOnce();
  assert.deepEqual(seen, ["/snapshots/index.json", `/snapshots/index.${PINNED}.json`], "the mutable index first, then the pinned build's copy");
  assert.deepEqual(idx!.snapshots.map((e) => [e.url, e.runtime]), [[NNG4_PINNED, PINNED]], "the copy is used");
  const tiles = await g.tileSnapshotStates(TILE);
  assert.equal(tiles.get("nng4")?.state, "download", "the tile offers this build's snapshot, not 'unavailable'");
}));

await test("games-api #64: the copy missing (404) — the mutable index is kept, and its unpaired entry stays unavailable", () => pinned(async () => {
  served.index = index(runtimeEntry("nng4", NNG4_NEXT, NEXT));
  const g = await api("");
  const idx = await g.fetchSnapshotIndexOnce();
  assert.deepEqual(seen, ["/snapshots/index.json", `/snapshots/index.${PINNED}.json`]);
  assert.deepEqual(idx!.snapshots.map((e) => [e.url, e.runtime]), [[NNG4_NEXT, NEXT]], "the mutable index, as read");
  assert.equal((await g.tileSnapshotStates(TILE)).get("nng4")?.state, "unavailable", "refused as before #64");
  // a copy that is mixed, of another runtime, or empty is no better than none
  for (const bad of [index(runtimeEntry("nng4", NNG4_PINNED, PINNED), runtimeEntry("rag", "/snapshots/rag.2222222222222222.snapz", NEXT)), index(runtimeEntry("nng4", NNG4_NEXT, NEXT)), index()]) {
    served.copies = { [PINNED]: bad };
    const again = await (await api("")).fetchSnapshotIndexOnce();
    assert.deepEqual(again!.snapshots.map((e) => e.runtime), [NEXT], JSON.stringify(bad));
  }
}));

await test("games-api #64: a paired index costs no copy request; no pinned build (no define) never asks for one", async () => {
  await pinned(async () => {
    served.index = index(runtimeEntry("nng4", NNG4_PINNED, PINNED));
    await (await api("")).fetchSnapshotIndexOnce();
    assert.deepEqual(seen, ["/snapshots/index.json"]);
  });
  try {
    served.index = index(runtimeEntry("nng4", NNG4_NEXT, NEXT));
    served.copies = { [PINNED]: index(runtimeEntry("nng4", NNG4_PINNED, PINNED)) };
    const idx = await (await api("")).fetchSnapshotIndexOnce();
    assert.deepEqual(seen, ["/snapshots/index.json"], "no __QED64_BUILD_ID__: exactly as before #64");
    assert.equal(idx!.snapshots[0]!.runtime, NEXT);
  } finally { served = {}; }
});

await test("games-api #64: SEC1 holds — a foreign mutable index is refused before any copy; a foreign copy is never used; ?snapshots= reads only its own", () => pinned(async () => {
  served.index = index(runtimeEntry("nng4", NNG4_NEXT, NEXT), runtimeEntry("rag", "https://cdn.attacker.example/snapshots/rag.snapz", NEXT));
  served.copies = { [PINNED]: index(runtimeEntry("nng4", NNG4_PINNED, PINNED)) };
  await assert.rejects((await api("")).fetchSnapshotIndexOnce(), (e: unknown) => isSec1Refusal(e) && (e as { code: string }).code === "SNAPSHOT_INDEX_FOREIGN_URL");
  assert.deepEqual(seen, ["/snapshots/index.json"], "refused whole, no copy asked for");
  served.index = index(runtimeEntry("nng4", NNG4_NEXT, NEXT));
  served.copies = { [PINNED]: index(runtimeEntry("nng4", "https://cdn.attacker.example/snapshots/nng4.snapz", PINNED)) };
  const idx = await (await api("")).fetchSnapshotIndexOnce();
  assert.deepEqual(seen, ["/snapshots/index.json", `/snapshots/index.${PINNED}.json`]);
  assert.deepEqual(idx!.snapshots.map((e) => e.url), [NNG4_NEXT], "the off-site copy is refused by the loader, the mutable index kept");
  served.index = index(runtimeEntry("nng4", NNG4_NEXT, NEXT));
  await (await api("?snapshots=staging")).fetchSnapshotIndexOnce();
  assert.deepEqual(seen, ["/staging/index.json"], "an overlay is read as it is, never paired");
}));

/* `?runtime=X` boots X, not the pin (qed64's resolver: the override wins),
 * and the tiles and the pairing check compare entries with the resolved
 * manifest's buildId, so the index is paired with X (qed64 EMBEDDING §7.0:
 * "the buildId of the runtime it boots"). Paired with the pin, an index.json
 * already on X was replaced by the pin's copy and every X entry refused. */
await test("games-api #64: ?runtime= pairs the index with the runtime it boots, not the shell's pin", () => pinned(async () => {
  // index.json already on X, the pin's copy present: no copy is read, X's entry is offered.
  served.index = index(runtimeEntry("nng4", NNG4_NEXT, NEXT));
  served.copies = { [PINNED]: index(runtimeEntry("nng4", NNG4_PINNED, PINNED)) };
  let g = await api(`?runtime=${NEXT}`);
  let idx = await g.fetchSnapshotIndexOnce();
  assert.deepEqual(seen, ["/snapshots/index.json"], "paired with X: no copy request");
  assert.deepEqual(idx!.snapshots.map((e) => [e.url, e.runtime]), [[NNG4_NEXT, NEXT]], "the index as served");
  assert.equal((await g.resolveRuntimeManifest()).buildId, NEXT, "the page boots X");
  assert.equal((await g.tileSnapshotStates(TILE)).get("nng4")?.state, "download", "X's snapshot is offered, not 'unavailable'");
  // index.json still on the pin (X uploaded ahead of its deploy): X's own copy is read and used.
  served.index = index(runtimeEntry("nng4", NNG4_PINNED, PINNED));
  served.copies = { [NEXT]: index(runtimeEntry("nng4", NNG4_NEXT, NEXT)) };
  g = await api(`?runtime=${NEXT}`);
  idx = await g.fetchSnapshotIndexOnce();
  assert.deepEqual(seen, ["/snapshots/index.json", `/snapshots/index.${NEXT}.json`], "X's copy, never the pin's");
  assert.deepEqual(idx!.snapshots.map((e) => [e.url, e.runtime]), [[NNG4_NEXT, NEXT]]);
  assert.equal((await g.tileSnapshotStates(TILE)).get("nng4")?.state, "download");
  // X has no copy: the mutable index is kept and its pin entry refused for X, as before #64.
  served.copies = {};
  g = await api(`?runtime=${NEXT}`);
  idx = await g.fetchSnapshotIndexOnce();
  assert.deepEqual(seen, ["/snapshots/index.json", `/snapshots/index.${NEXT}.json`]);
  assert.deepEqual(idx!.snapshots.map((e) => e.runtime), [PINNED]);
  assert.equal((await g.tileSnapshotStates(TILE)).get("nng4")?.state, "unavailable");
  // ?runtime= equal to the pin changes nothing.
  served.index = index(runtimeEntry("nng4", NNG4_NEXT, NEXT));
  served.copies = { [PINNED]: index(runtimeEntry("nng4", NNG4_PINNED, PINNED)) };
  idx = await (await api(`?runtime=${PINNED}`)).fetchSnapshotIndexOnce();
  assert.deepEqual(seen, ["/snapshots/index.json", `/snapshots/index.${PINNED}.json`]);
  assert.equal(idx!.snapshots[0]!.runtime, PINNED);
}));

if (failures) { console.log(`boot-params: ${failures} FAILED`); process.exit(1); }
console.log("boot-params: ALL TESTS PASS");
