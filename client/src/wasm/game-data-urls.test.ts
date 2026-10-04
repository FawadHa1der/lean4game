// Run: node --import ./client/src/wasm/ts-resolve-hook.mjs client/src/wasm/game-data-urls.test.ts
// D6 (live 2026-10-03): the one list of a game's offline files — what a
// landing-page Prepare and the boot's warm-up send to the service worker —
// from a small game.json / inventory.json fixture; and D1's offline verdict
// (offlineReportFrom: every runtime chunk and the game's essential files in
// the runtime cache) plus D8's decimal sizes. Review round R3: the images
// game texts embed (`![alt](images/<file>)`) are listed — game.json's in the
// list itself, a level file's read back from the runtime cache. N2 (live run
// of f468f2c): a report without a cached game.json says its total is not the
// game's (`listed: false`).
import assert from "node:assert/strict";

const { gameDataUrls, levelUrls, inventoryDocUrls, i18nUrls, essentialDataUrls, fetchGameDataUrls, offlineReportFrom, runtimeChunkUrls, embeddedImageUrls, cachedLevelImageUrls } = await import("./game-data-urls");
const { wholeMB, tenthsGB } = await import("./sizes");

const id = "g/test/Tiny";
const game = { name: "Tiny", worldSize: { Intro: 2, Final: 1, Empty: 0 } };
const inventory = {
  tactics: [{ name: "rfl" }, { name: "rw" }],
  lemmas: [{ name: "MyNat.add_comm" }, { displayName: "no name" }],
  lemmaTab: null,
  definitions: [{ name: "Add" }],
};

let failures = 0;
async function test(name: string, body: () => void | Promise<void>): Promise<void> {
  try { await body(); console.log(`ok - ${name}`); } catch (e) { failures++; console.log(`not ok - ${name}\n  ${String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n  ")}`); }
}

await test("every level game.json's worldSize names, numbered from 1", () => {
  assert.deepEqual(levelUrls(id, game), [
    `/data/${id}/level__Intro__1.json`,
    `/data/${id}/level__Intro__2.json`,
    `/data/${id}/level__Final__1.json`,
  ]);
  assert.deepEqual(levelUrls(id, null), []);
  assert.deepEqual(levelUrls(id, { worldSize: { W: "3", V: -1, U: 1.5 } }), [], "non-integer sizes name nothing");
});

await test("one doc file per inventory item, the tab capitalised as the panel asks", () => {
  assert.deepEqual(inventoryDocUrls(id, inventory), [
    `/data/${id}/doc__Tactic__rfl.json`,
    `/data/${id}/doc__Tactic__rw.json`,
    `/data/${id}/doc__Theorem__MyNat.add_comm.json`,
    `/data/${id}/doc__Definition__Add.json`,
  ]);
  assert.deepEqual(inventoryDocUrls(id, null), []);
  assert.deepEqual(inventoryDocUrls(id, { tactics: "rfl" }), []);
});

await test("i18n: English always, the UI language once", () => {
  assert.deepEqual(i18nUrls(id, ["de"]), [`/i18n/${id}/en`, `/i18n/${id}/de`]);
  assert.deepEqual(i18nUrls(id, ["en"]), [`/i18n/${id}/en`]);
  assert.deepEqual(i18nUrls(id, [""]), [`/i18n/${id}/en`]);
});

await test("the full list: inventory and docs first (N5), then game.json, levels, i18n; no duplicates", () => {
  const urls = gameDataUrls(id, game, inventory, ["fr"]);
  assert.deepEqual(urls, [
    `/data/${id}/inventory.json`,
    `/data/${id}/doc__Tactic__rfl.json`,
    `/data/${id}/doc__Tactic__rw.json`,
    `/data/${id}/doc__Theorem__MyNat.add_comm.json`,
    `/data/${id}/doc__Definition__Add.json`,
    `/data/${id}/game.json`,
    `/data/${id}/level__Intro__1.json`,
    `/data/${id}/level__Intro__2.json`,
    `/data/${id}/level__Final__1.json`,
    `/i18n/${id}/en`,
    `/i18n/${id}/fr`,
  ]);
  assert.equal(new Set(urls).size, urls.length);
  // Unreadable game.json and inventory.json: what can be named still is.
  assert.deepEqual(gameDataUrls(id, null, null, []), [`/data/${id}/inventory.json`, `/data/${id}/game.json`, `/i18n/${id}/en`]);
});

await test("R3: the images game texts embed, as markdown.tsx rewrites them; game.json's last in the list", () => {
  const story = {
    worlds: { nodes: { Story: { introduction: "![Newton](images/Deriv.jpg) and ![Leibniz](images/Integral.jpg)\n\n![Again](images/Deriv.jpg)" } } },
    introduction: "![Pi](images/PiOver4.jpg \"π over 4\")", // a title after the URL
    other: ["[a link, not an image](images/No.png)", "![](images/NoAlt.png)", "![x](http://elsewhere/images/Abs.png)"],
  };
  assert.deepEqual(embeddedImageUrls(id, story), [`/data/${id}/images/Deriv.jpg`, `/data/${id}/images/Integral.jpg`, `/data/${id}/images/PiOver4.jpg`]);
  assert.deepEqual(embeddedImageUrls(id, null, 3, "![a](images/A.png)"), [`/data/${id}/images/A.png`]);
  const urls = gameDataUrls(id, { ...game, ...story }, null, []);
  assert.deepEqual(urls.slice(-3), embeddedImageUrls(id, story), "after the levels and i18n (N5: the small files first)");
  assert.ok(!essentialDataUrls(id, { ...game, ...story }).some((u) => u.includes("/images/")), "not essential: the game plays without them");
});

await test("R3: a level file's images, read back from the runtime cache (only those not listed already)", async () => {
  const levels: Record<string, unknown> = {
    [`/data/${id}/level__Intro__1.json`]: { introduction: "![SeqLim](images/SeqLim.jpg)" },
    [`/data/${id}/level__Intro__2.json`]: { conclusion: "![Newton](images/Deriv.jpg)" },
  };
  const opened: string[] = [];
  (globalThis as { caches?: unknown }).caches = {
    has: async (name: string) => name === "l4g-runtime-v1",
    open: async (name: string) => { opened.push(name); return { match: async (u: string) => (u in levels ? new Response(JSON.stringify(levels[u])) : undefined) }; },
  };
  const listed = [...gameDataUrls(id, game, null, []), `/data/${id}/images/Deriv.jpg`];
  assert.deepEqual(await cachedLevelImageUrls(id, listed), [`/data/${id}/images/SeqLim.jpg`], "level__Final__1 is not cached: nothing from it");
  assert.deepEqual(opened, ["l4g-runtime-v1"]);
  (globalThis as { caches?: unknown }).caches = { has: async () => false, open: async () => { throw new Error("must not create the cache"); } };
  assert.deepEqual(await cachedLevelImageUrls(id, listed), []);
  delete (globalThis as { caches?: unknown }).caches;
  assert.deepEqual(await cachedLevelImageUrls(id, listed), [], "no Cache API");
});

await test("fetchGameDataUrls reads both files; a failed fetch contributes what it can", async () => {
  const served: Record<string, unknown> = { [`/data/${id}/game.json`]: game, [`/data/${id}/inventory.json`]: inventory };
  const asked: string[] = [];
  (globalThis as { fetch: unknown }).fetch = async (url: string) => {
    asked.push(url);
    if (!(url in served)) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(served[url]), { status: 200, headers: { "content-type": "application/json" } });
  };
  assert.deepEqual(await fetchGameDataUrls(id, ["fr"]), gameDataUrls(id, game, inventory, ["fr"]));
  assert.deepEqual(asked.sort(), [`/data/${id}/game.json`, `/data/${id}/inventory.json`]);
  delete served[`/data/${id}/inventory.json`];
  assert.deepEqual(await fetchGameDataUrls(id, []), gameDataUrls(id, game, null, []));
  (globalThis as { fetch: unknown }).fetch = async () => { throw new TypeError("Failed to fetch"); };
  assert.deepEqual(await fetchGameDataUrls(id, []), gameDataUrls(id, null, null, []));
});

const runtime = {
  buildId: "b", leanVersion: "4",
  files: {
    "lean.js": { bytes: 2, sha256: "", chunks: [{ url: "/runtime/chunks/lean.js.aa.part-000", bytes: 1, sha256: "" }] },
    "lean.wasm": { bytes: 2, sha256: "", chunks: [{ url: "/runtime/chunks/lean.wasm.bb.part-000", bytes: 1, sha256: "" }, { url: "/runtime/chunks/lean.wasm.bb.part-001", bytes: 1, sha256: "" }] },
  },
} as Parameters<typeof runtimeChunkUrls>[0];

await test("D1 offline verdict: every chunk and every essential file, or not ready", () => {
  const chunks = runtimeChunkUrls(runtime);
  assert.equal(chunks.length, 3);
  const all = new Set([...chunks, ...essentialDataUrls(id, game)]);
  const full = offlineReportFrom(all, chunks, id, game);
  assert.deepEqual(full, { chunks: { have: 3, total: 3 }, data: { have: 5, total: 5, listed: true }, complete: true });
  // A Prepare from before D6: region + runtime, no game file.
  const noData = offlineReportFrom(new Set(chunks), chunks, id, null);
  assert.equal(noData.complete, false);
  // N2 (live run of f468f2c): without a cached game.json the level files are
  // unknown — the total is not the game's ("this game's files 0 of 2"), and
  // the report says so (the tile then says the files are not cached yet).
  assert.deepEqual(noData.data, { have: 0, total: 2, listed: false }, "game.json + inventory.json missing (levels unknown without game.json)");
  const inventoryOnly = offlineReportFrom(new Set([...chunks, `/data/${id}/inventory.json`]), chunks, id, null);
  assert.deepEqual([inventoryOnly.data.listed, inventoryOnly.complete], [false, false], "\"1 of 2\" was the live misreading");
  assert.equal(offlineReportFrom(new Set(chunks), chunks, id, game).data.listed, true, "a cached game.json lists the levels, cached or not");
  // A warm-up that stopped short: one chunk missing.
  const short = new Set(all); short.delete(chunks[2]!);
  assert.deepEqual(offlineReportFrom(short, chunks, id, game).chunks, { have: 2, total: 3 });
  assert.equal(offlineReportFrom(short, chunks, id, game).complete, false);
  // One level file missing.
  const lvl = new Set(all); lvl.delete(`/data/${id}/level__Final__1.json`);
  assert.equal(offlineReportFrom(lvl, chunks, id, game).complete, false);
  // A manifest with no chunks can never read as complete.
  assert.equal(offlineReportFrom(all, [], id, game).complete, false);
});

await test("D8: decimal MB / GB", () => {
  // The live tiles (D8 evidence): RAG 281,959,968 bytes read "≈269 MB" (MiB).
  assert.equal(wholeMB(281959968), 282);
  assert.equal(wholeMB(154373030), 154);
  assert.equal(wholeMB(0), 0);
  assert.equal(wholeMB(499999), 0);
  assert.equal(wholeMB(500000), 1);
  assert.equal(tenthsGB(1_420_000_000), "1.4");
  assert.equal(tenthsGB(569269949), "0.6");
  assert.equal(tenthsGB(0), "0.0");
});

if (failures) { console.log(`game-data-urls: ${failures} FAILED`); process.exit(1); }
console.log("game-data-urls: ALL TESTS PASS");
