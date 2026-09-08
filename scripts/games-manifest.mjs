#!/usr/bin/env node
// The games catalog (wasm/catalog.json) is the single source of truth for
// which games this deployment builds, stages, lists and boots. This script is
// its only reader; every other script (build lanes, staging, deploy checks,
// e2e) goes through it instead of naming games.
//
//   --check            validate the catalog (exit 1 with reasons)
//   --list             one TSV row per game for bash loops (see COLUMNS)
//   --api              write client/public/api/games from the staged game.json tiles
//   --probe <snapshot> print the bake/e2e probe file for one game
//   --required-files   print the files scripts/deploy-app.sh must find in dist
//   --langs            print the UI language codes (client/src/config.json)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(root, "wasm/catalog.json");
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const SCHEMA = "lean4game.catalog/v1";
export const COLUMNS = ["snapshot", "owner", "game", "id", "listed", "src", "reserveBytes", "sourceUrl", "sourceRev", "sourcePatch", "leanOptions", "expectedRuntime", "expectedBytes"];

const games = (catalog.games ?? []).map((g) => ({
  ...g,
  id: `g/${g.owner}/${g.game}`,
  reserveBytes: g.reserveBytes ?? catalog.defaults?.reserveBytes ?? 2147483648,
  leanOptions: g.leanOptions ?? [],
}));
const uiLanguages = () => JSON.parse(fs.readFileSync(path.join(root, "client/src/config.json"), "utf8")).languages.map((l) => l.iso);

/** The game's compiled game.json: the staged copy (client/public/data) wins,
 * then the source tree's .lake/gamedata (present after the games lane). */
function gameJson(g) {
  for (const p of [path.join(root, "client/public/data", g.id, "game.json"), path.join(root, g.src, ".lake/gamedata/game.json")]) {
    if (fs.existsSync(p)) return { path: p, json: JSON.parse(fs.readFileSync(p, "utf8")) };
  }
  return null;
}

function check() {
  const errors = [];
  if (catalog.schema !== SCHEMA) errors.push(`schema: expected ${SCHEMA}, got ${catalog.schema}`);
  const ids = new Set(), snaps = new Set();
  for (const g of games) {
    const where = `${g.id}:`;
    for (const k of ["owner", "game", "snapshot", "src"]) if (typeof g[k] !== "string" || !g[k]) errors.push(`${where} ${k} must be a non-empty string`);
    if (typeof g.listed !== "boolean") errors.push(`${where} listed must be true/false`);
    if (!/^[a-z0-9_-]+$/.test(g.snapshot ?? "")) errors.push(`${where} snapshot '${g.snapshot}' must match ^[a-z0-9_-]+$ (it names /snapshots/<name>.<digest>.snapz)`);
    if (ids.has(g.id)) errors.push(`${where} duplicate game id`); ids.add(g.id);
    if (snaps.has(g.snapshot)) errors.push(`${where} duplicate snapshot name '${g.snapshot}'`); snaps.add(g.snapshot);
    if (!g.probe || typeof g.probe.world !== "string" || !Number.isInteger(g.probe.level) || typeof g.probe.proof !== "string")
      errors.push(`${where} probe must be {world: string, level: integer, proof: string}`);
    if (!Array.isArray(g.leanOptions) || g.leanOptions.some((o) => typeof o !== "string" || !/^[A-Za-z0-9_.]+=[^\s]+$/.test(o)))
      errors.push(`${where} leanOptions must be an array of "option=value" strings`);
    if (g.source === null || g.source === undefined) {
      if (!fs.existsSync(path.join(root, g.src))) errors.push(`${where} src '${g.src}' is missing and no source {url, rev} is set`);
    } else {
      if (typeof g.source.url !== "string" || typeof g.source.rev !== "string") errors.push(`${where} source needs url and rev`);
      if (g.source.patch && !fs.existsSync(path.join(root, g.source.patch))) errors.push(`${where} patch '${g.source.patch}' does not exist`);
    }
    if (g.expectedRaw && (typeof g.expectedRaw.runtime !== "string" || !Number.isInteger(g.expectedRaw.bytes)))
      errors.push(`${where} expectedRaw must be null or {runtime: string, bytes: integer}`);
    const gj = gameJson(g);
    if (gj) {
      const bad = (gj.json.tile?.languages ?? []).filter((l) => !uiLanguages().includes(l));
      if (bad.length) console.warn(`warning: ${g.id} declares Languages ${JSON.stringify(bad)} that are not ISO codes in client/src/config.json (Game.lean 'Languages' must use codes like "en")`);
    }
  }
  const listed = games.filter((g) => g.listed);
  if (!listed.length) errors.push("no listed game — the landing page would be empty");
  return errors;
}

const probeText = (g) => {
  const gj = gameJson(g);
  if (!gj) throw new Error(`${g.id}: no game.json (run the games lane or stage the game first)`);
  return `import Game\nimport GameServer.Runner\nRunner "${gj.json.name}" "${g.probe.world}" ${g.probe.level} (difficulty := 1) (inventory := []) := by\n${g.probe.proof}\n`;
};

const mode = process.argv[2];
if (mode === "--check") {
  const errors = check();
  if (errors.length) { for (const e of errors) console.error(`catalog: ${e}`); process.exit(1); }
  console.log(`catalog ok: ${games.length} games (${games.filter((g) => g.listed).map((g) => g.id).join(", ")} listed)`);
} else if (mode === "--list") {
  for (const g of games) {
    const row = { ...g, sourceUrl: g.source?.url ?? "-", sourceRev: g.source?.rev ?? "-", sourcePatch: g.source?.patch ?? "-",
      leanOptions: g.leanOptions.join(",") || "-", expectedRuntime: g.expectedRaw?.runtime ?? "-", expectedBytes: g.expectedRaw?.bytes ?? "-" };
    console.log(COLUMNS.map((c) => String(row[c])).join("\t"));
  }
} else if (mode === "--api") {
  const out = [];
  for (const g of games) {
    const gj = gameJson(g);
    if (!gj) { console.warn(`api/games: ${g.id} has no game.json yet — skipped`); continue; }
    out.push({ owner: g.owner, game: g.game, listed: g.listed, snapshot: g.snapshot, tile: gj.json.tile, settings: gj.json.settings ?? undefined });
  }
  const dst = path.join(root, "client/public/api/games");
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, JSON.stringify(out));
  console.log(`wrote ${path.relative(root, dst)}: ${out.map((g) => `${g.owner}/${g.game}${g.listed ? "" : " (unlisted)"}`).join(", ")}`);
} else if (mode === "--probe") {
  const g = games.find((x) => x.snapshot === process.argv[3]);
  if (!g) { console.error(`no catalog game with snapshot '${process.argv[3]}'`); process.exit(1); }
  process.stdout.write(probeText(g));
} else if (mode === "--required-files") {
  console.log("api/games");
  for (const g of games.filter((x) => x.listed)) console.log(`data/${g.id}/game.json`);
} else if (mode === "--langs") {
  console.log(uiLanguages().join(" "));
} else {
  console.error("usage: games-manifest.mjs --check | --list | --api | --probe <snapshot> | --required-files | --langs");
  process.exit(2);
}
