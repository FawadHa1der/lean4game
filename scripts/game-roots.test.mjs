/* scripts/game-roots.mjs, the kernel-pack roots from the games' imports (lean4game
 * review K1): `node --test scripts/game-roots.test.mjs`.
 *
 * The real script runs from a scratch copy of the repository layout under the OS
 * temp dir, with a small fixture catalog and small Lean trees, so it reads that
 * copy's catalog through its own games-manifest.mjs. Nothing here compiles Lean.
 * One case runs in this tree, on the sources it holds.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "l4g-game-roots-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const row = (snapshot, src) => ({ owner: "t", game: snapshot, listed: true, snapshot, src, source: src.startsWith("games-src/") ? { url: "https://example.invalid/x", rev: "abc" } : null, probe: { world: "W", level: 1, proof: "rfl" } });
const CATALOG = { schema: "lean4game.catalog/v1", games: [row("alpha", "games-src/A"), row("beta", "cypress/B")] };

const TREES = {
  // comments before imports: block, nested block, line, trailing, abutting. The module
  // doc goes after them, where it ends the header, as it does in Lean.
  "games-src/A/Game.lean": `/- Copyright: import Comment.Block
   /- import Comment.Nested -/
   import Comment.AfterNested -/
-- import Comment.Line
import Game.Levels.One -- import Comment.Trailing
import Lean
import Std.Data.HashMap
import Init.Data.List
import Lake.Load.Manifest
import GameServer.Commands
import I18n
import Mathlib.Alpha/- abutting -/import Mathlib.Beta
import LeanSearchClient
/-! The module doc:
import Comment.ModuleDoc
-/
import Body.AfterModuleDoc

def x := 1
-- the body is not read
import Body.AfterDef
`,
  // the module system's forms, and a name in guillemets
  "games-src/A/Game/Levels/One.lean": `module

public import Game.Levels.Two
public meta import Mathlib.Gamma
meta import Mathlib.Delta
import all Mathlib.Epsilon
public meta import all Mathlib.Zeta
import «Mathlib».«Eta»

public section
import Body.AfterPublicSection
`,
  // an import two games share, and one a second file repeats
  "games-src/A/Game/Levels/Two.lean": "prelude\nimport Mathlib.Alpha\nimport Shared.Module\n",
  // nothing imports it, so nothing compiles it
  "games-src/A/Game/Orphan.lean": "import Mathlib.Unreached\n",
  "cypress/B/Game.lean": "import Shared.Module\nimport Game.Own\n",
  "cypress/B/Game/Own.lean": "-- no imports\n",
  "server/GameServer.lean": "import GameServer.Commands\nimport Batteries.Tactic.OpenPrivate\n",
  "server/GameServer/Commands.lean": "import I18n\nimport Lean\n",
  "server/Test/Unreached.lean": "import Mathlib.Unreached.Server\n",
  "vendor/i18n/I18n.lean": "module\n\npublic import I18n.Utils\n",
  "vendor/i18n/I18n/Utils.lean": "import Lake.Load.Manifest\n",
  "vendor/i18n/I18nCli/Main.lean": "import Cli.Basic\n",
};
const EXPECTED = [
  "Batteries.Tactic.OpenPrivate  # GameServer",
  "LeanSearchClient  # alpha",
  "Mathlib.Alpha  # alpha",
  "Mathlib.Beta  # alpha",
  "Mathlib.Delta  # alpha",
  "Mathlib.Epsilon  # alpha",
  "Mathlib.Eta  # alpha",
  "Mathlib.Gamma  # alpha",
  "Mathlib.Zeta  # alpha",
  "Shared.Module  # alpha, beta",
];
const MODULES = EXPECTED.map((l) => l.split(" ")[0]);

let serial = 0;
/** A fresh scratch copy of the layout, its catalog and trees as given. */
function fixture({ catalog = CATALOG, trees = TREES } = {}) {
  const dir = path.join(tmp, `repo-${serial++}`);
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  for (const f of ["game-roots.mjs", "games-manifest.mjs"]) write(`scripts/${f}`, fs.readFileSync(path.join(root, "scripts", f), "utf8"));
  write("wasm/catalog.json", JSON.stringify(catalog));
  for (const [rel, text] of Object.entries(trees)) write(rel, text);
  return {
    dir, write,
    run: (...args) => spawnSync(process.execPath, [path.join(dir, "scripts/game-roots.mjs"), ...args], { encoding: "utf8" }),
    roots: () => fs.readFileSync(path.join(dir, "wasm/mathlib-roots.txt"), "utf8"),
    lines: () => fs.readFileSync(path.join(dir, "wasm/mathlib-roots.txt"), "utf8").split("\n").filter((l) => l && !l.startsWith("#")),
  };
}

test("keeps what a tree imports from outside: comments, the module system's forms, local and core left out", () => {
  const f = fixture();
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wrote wasm\/mathlib-roots\.txt: 10 modules from 2 games, GameServer, lean-i18n/);
  assert.deepEqual(f.lines(), EXPECTED);
});

test("the header ends where Lean's does (stock v4.35.0's parseImports read no import after any of these)", () => {
  const STOPS = ["/-! doc -/\n", "/-- doc -/\n", "-- a\n/- b -/ /-- c -/ ", "/--/ ", "private ", "public private ", "meta public ", "prelude\nmodule\n", "open Foo\n"];
  const f = fixture({ trees: {
    ...TREES,
    "cypress/B/Game.lean": `import Game.Kept\nimport Game.NoName\nimport Game.NoNameAfterAll\n${STOPS.map((_, i) => `import Game.S${i}`).join("\n")}\n`,
    "cypress/B/Game/Kept.lean": "import Mathlib.Kept/-! doc -/\nimport Body.AfterAbuttingDoc\n",
    "cypress/B/Game/NoName.lean": "import",
    "cypress/B/Game/NoNameAfterAll.lean": "import all",
    ...Object.fromEntries(STOPS.map((stop, i) => [`cypress/B/Game/S${i}.lean`, `${stop}import Body.After${i}\n`])),
  } });
  assert.equal(f.run().status, 0);
  assert.doesNotMatch(f.roots(), /Body\./);
  assert.ok(f.lines().includes("Mathlib.Kept  # beta"), "the import before a doc comment still counts");
  assert.ok(f.lines().every((l) => /^[A-Z]/.test(l)), `an import with no name lists nothing: ${f.lines()}`);
});

test("what nothing imports does not count: an orphan level, server/Test, lean-i18n's CLI", () => {
  const f = fixture();
  f.run();
  for (const mod of ["Mathlib.Unreached", "Mathlib.Unreached.Server", "Cli.Basic"]) assert.ok(!f.roots().includes(mod), mod);
});

test("the kernel's reader gets the modules and nothing else (mathlib-tree.sh's sed and tr)", () => {
  const f = fixture();
  f.run();
  const reader = "sed -e 's/#.*//' \"$1\" | tr -s '[:space:]' ' ' | sed -e 's/^ //' -e 's/ $//'";
  const r = spawnSync("bash", ["-c", reader, "_", path.join(f.dir, "wasm/mathlib-roots.txt")], { encoding: "utf8" });
  assert.equal(r.stdout.trim(), MODULES.join(" "));
});

test("deterministic: two runs, and another catalog order and file order, write the same bytes", () => {
  const a = fixture();
  a.run();
  const first = a.roots();
  a.run();
  assert.equal(a.roots(), first);
  const b = fixture({ catalog: { ...CATALOG, games: [...CATALOG.games].reverse() }, trees: Object.fromEntries(Object.entries(TREES).reverse()) });
  b.run();
  assert.equal(b.roots(), first);
});

test("--check: agrees with what the generator wrote, and writes nothing", () => {
  const f = fixture();
  f.run();
  const before = fs.statSync(path.join(f.dir, "wasm/mathlib-roots.txt")).mtimeMs;
  const r = f.run("--check");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /agrees with 2 games, GameServer, lean-i18n \(10 modules\)/);
  assert.equal(fs.statSync(path.join(f.dir, "wasm/mathlib-roots.txt")).mtimeMs, before);
});

test("--check names a new import, a dropped one and a changed importer, and leaves the file alone", () => {
  const f = fixture();
  f.run();
  const before = f.roots();
  f.write("games-src/A/Game/Levels/Two.lean", "import Mathlib.New\nimport Shared.Module\n"); // Mathlib.Alpha stays, in Game.lean
  f.write("cypress/B/Game.lean", "import Game.Own\n"); // beta stops importing Shared.Module
  f.write("server/GameServer.lean", "import GameServer.Commands\n"); // OpenPrivate gone
  const r = f.run("--check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^\+ Mathlib\.New \(imported by alpha\): a new import, not listed; rerun node scripts\/game-roots\.mjs and commit wasm\/mathlib-roots\.txt\. A module no pack holds also needs the kernel's next pack build/m);
  assert.match(r.stderr, /^- Batteries\.Tactic\.OpenPrivate: listed, nothing imports it any more/m);
  assert.match(r.stderr, /^~ Shared\.Module: the file says "Shared\.Module {2}# alpha, beta", the sources say "Shared\.Module {2}# alpha"/m);
  assert.match(r.stderr, /3 differences for 2 games/);
  assert.equal(f.roots(), before);
});

test("--check names a file edited by hand, even when every module agrees", () => {
  const f = fixture();
  f.run();
  f.write("wasm/mathlib-roots.txt", f.roots().split("\n").reverse().join("\n"));
  const r = f.run("--check");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the file's text is not what the generator writes/);
});

test("--check without the file, and a missing game source: exit 2, named", () => {
  const f = fixture();
  let r = f.run("--check");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /wasm\/mathlib-roots\.txt does not exist/);
  f.run();
  fs.rmSync(path.join(f.dir, "games-src/A"), { recursive: true });
  r = f.run("--check");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no Game\.lean in .*games-src\/A \(alpha\)/);
});

test("--games: a subset needs only its own sources, and only its imports are asked about", () => {
  const f = fixture();
  f.run();
  fs.rmSync(path.join(f.dir, "games-src/A"), { recursive: true });
  let r = f.run("--check", "--games", "beta");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /agrees with beta, GameServer, lean-i18n \(2 modules\)/);
  f.write("cypress/B/Game.lean", "import Shared.Module\nimport Mathlib.New\nimport Game.Own\n");
  r = f.run("--check", "--games", "beta");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^\+ Mathlib\.New \(imported by beta\)/m);
});

test("--have: a module in no pack says it needs the kernel's next pack build; a vendored one resolves", () => {
  const f = fixture();
  f.run();
  const list = path.join(f.dir, "essential-modules.txt");
  f.write("essential-modules.txt", `${MODULES.filter((m) => !m.startsWith("Batteries") && m !== "Mathlib.Zeta").join("\n")}\n`);
  f.write("vendored/Batteries/Tactic/OpenPrivate.lean", "-- a vendored copy\n");
  let r = f.run("--check", "--have", list);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^! Batteries\.Tactic\.OpenPrivate \(imported by GameServer\): in no pack of the pinned release/m);
  assert.match(r.stderr, /^! Mathlib\.Zeta \(imported by alpha\): .*It needs the kernel's next pack build/m);
  r = f.run("--check", "--have", list, "--have", path.join(f.dir, "vendored"));
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stderr, /OpenPrivate/);
  f.write("essential-modules.txt", `${MODULES.join(" ")}\n`);
  r = f.run("--check", "--have", list);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /every one resolves in the pinned release/);
});

test("--games-src: the catalog's games-src/ checkouts from another directory", () => {
  const f = fixture();
  fs.renameSync(path.join(f.dir, "games-src"), path.join(f.dir, "elsewhere"));
  assert.equal(f.run().status, 2);
  const r = f.run("--games-src", path.join(f.dir, "elsewhere"));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.lines(), EXPECTED);
});

test("bad arguments: exit 2", () => {
  const f = fixture();
  f.run();
  for (const args of [["--check", "--games", "nope"], ["--games", "beta"], ["--have", "x"], ["--check", "--have", "/no/such/list"], ["--check", "--games"], ["--nope"]]) {
    const r = f.run(...args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
  }
});

test("this tree: the tracked file lists what its in-repo sources import (TestGame, GameServer, lean-i18n)", () => {
  const r = spawnSync(process.execPath, [path.join(root, "scripts/game-roots.mjs"), "--check", "--games", "testgame"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
