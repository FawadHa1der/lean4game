// Run: node client/src/wasm/game-translation.test.ts  (Node ≥22 type stripping)
import { GameTranslation, shiftLines, rebaseSemanticTokens, PROOF_START_LINE, RUNNER_PRELUDE, runnerOptionCommands } from "./game-translation.ts";
import assert from "node:assert";
import { levelUri, parseLevelUri } from "./level-uri";

/** A MessageChannel delivers when it delivers (about 100 ms for a first message
 * on an emulated or loaded host): wait for the messages a step needs, never for a
 * fixed time. Throws after 30 s; the test job has its own timeout. */
async function until(what: string, ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`game-translation test: 30 s waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

// level-uri: flat scheme round-trips; the legacy nested shape still parses.
assert.equal(levelUri("Tutorial", 3), "file:///levels/Tutorial__3.lean");
assert.deepEqual(parseLevelUri("file:///levels/Tutorial__3.lean"), { worldId: "Tutorial", levelId: "3" });
assert.deepEqual(parseLevelUri("file:///levels/Adv__Add__12.lean"), { worldId: "Adv__Add", levelId: "12" });
assert.deepEqual(parseLevelUri("file:///Tutorial/3.lean"), { worldId: "Tutorial", levelId: "3" });

// shiftLines: nested positions, lineRange, floors at 0
{
  const m = shiftLines({ params: { position: { line: 3, character: 1 }, range: { start: { line: 0, character: 0 }, end: { line: 1, character: 2 } } } }, 2);
  assert.equal(m.params.position.line, 5);
  assert.equal(m.params.range.start.line, 2);
  const down = shiftLines({ line: 1, lineRange: { start: 0, end: 4 } }, -2);
  assert.equal(down.line, 0);
  assert.equal(down.lineRange.start, 0);
  assert.equal(down.lineRange.end, 2);
}

// rebaseSemanticTokens: drops pre-proof tokens, rebases the first delta
{
  // tokens at lines 0,1 (header) then 2,3 → keep from line 2 rebased to 0
  const data = [0,0,6,1,0,  1,0,6,1,0,  1,0,3,2,0,  1,0,3,2,0];
  const out = rebaseSemanticTokens(data);
  assert.equal(out[0], 0);          // line 2 - PROOF_START_LINE
  assert.equal(out.length, 10);     // two tokens survive
  assert.deepEqual(rebaseSemanticTokens([0,0,6,1,0]), []); // all header
}

// runnerOptionCommands: catalog `option=value` → one `set_option` command
// each, in order; anything else is skipped (it could break the Runner's line,
// or comment out / swallow the Runner: the value is pasted unescaped).
{
  assert.equal(runnerOptionCommands(undefined), "");
  assert.equal(runnerOptionCommands([]), "");
  assert.equal(runnerOptionCommands(["linter.tacticAnalysis.introMerge=false"]), "set_option linter.tacticAnalysis.introMerge false ");
  assert.equal(runnerOptionCommands(["a.b=1", "c=true"]), "set_option a.b 1 set_option c true ");
  const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
  try {
    const bad = ["x=1\nRunner", "y = 2", "=3", "z=", "x=--1", "x=/-1", 'x="1', "x=«1", "x=1--", "1x=true", "a..b=1", "x.=1", 5, null];
    assert.equal(runnerOptionCommands([...bad, "linter.all=false"] as unknown[]), "set_option linter.all false ");
    assert.equal(warned, bad.length);
    // Not a list (a hand-edited or foreign /api/games row): nothing, no throw.
    for (const v of [5, { a: 1 }, "x=1"]) assert.equal(runnerOptionCommands(v as unknown as string[]), "");
    assert.equal(runnerOptionCommands(null as unknown as string[]), "");
  } finally { console.warn = warn; }
}

// A game with runnerOptions (the Mathlib games: intro-merge off): the
// commands follow RUNNER_PRELUDE on the Runner's own line; the proof stays at
// PROOF_START_LINE.
{
  const upstream = new MessageChannel();
  const gt = new GameTranslation({ gameName: "MyGame", levelData: (w, l) => ({ module: `Game.Levels.${w}.L0${l}_X` }) });
  gt.configure({ runnerOptions: ["linter.tacticAnalysis.introMerge=false"] });
  gt.attachServer(upstream.port1);
  const toWorker: any[] = [];
  upstream.port2.onmessage = (e) => toWorker.push(e.data);
  upstream.port2.start?.();
  gt.clientPort.start?.();
  (gt.clientPort as any).postMessage({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: "file:///levels/QuantifierWorld__7.lean", languageId: "lean4", version: 1, text: "intro h\nintro a" } } });
  await until("didOpen", () => toWorker.length >= 1);
  const lines: string[] = toWorker[0].params.textDocument.text.split("\n");
  assert.equal(lines[0], "import Game.Levels.QuantifierWorld.L07_X import GameServer.Runner ");
  assert.equal(lines[1], 'set_option Elab.async true set_option linter.tacticAnalysis.introMerge false Runner "MyGame" "QuantifierWorld" 7 (difficulty := 1) (inventory := []) := by');
  assert.equal(lines[PROOF_START_LINE], "intro h");
  upstream.port1.close(); upstream.port2.close(); gt.clientPort.close();
}

// Full round trip through the ports
{
  const upstream = new MessageChannel(); // pretend shim
  const gt = new GameTranslation(
    { gameName: "MyGame", levelData: (w, l) => ({ module: `Game.Levels.${w}.L0${l}_X` }) },
  );
  gt.attachServer(upstream.port1);
  const toWorker: any[] = [];
  upstream.port2.onmessage = (e) => toWorker.push(e.data);
  upstream.port2.start?.();

  gt.clientPort.start?.();
  const fromServer: any[] = [];
  gt.clientPort.onmessage = (e) => fromServer.push(e.data);

  const post = (m: any) => (gt.clientPort as any).postMessage(m);
  post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: null, initializationOptions: { difficulty: 1, inventory: ["rfl"] } } });
  post({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: "file:///levels/TestWorld__1.lean", languageId: "lean4", version: 1, text: "rfl" } } });
  post({ jsonrpc: "2.0", id: 7, method: "textDocument/hover", params: { textDocument: { uri: "file:///levels/TestWorld__1.lean" }, position: { line: 0, character: 2 } } });

  await until("initialize, didOpen and hover", () => toWorker.length >= 3);
  assert.equal(toWorker.length, 3);
  const [init, open, hover] = toWorker;
  assert.equal(init.params.rootUri, "MyGame");
  assert.equal(open.params.textDocument.uri, "file:///game/Metadata.lean");
  const text: string = open.params.textDocument.text;
  assert.ok(text.startsWith("import Game.Levels.TestWorld.L01_X import GameServer.Runner \n"));
  assert.ok(text.includes('Runner "MyGame" "TestWorld" 1 (difficulty := 1) (inventory := ["rfl"]) := by\nrfl\n'));
  // Elab.async on for the Runner command (RUNNER_PRELUDE): a command of its
  // own on the Runner's line — never `… in`, never a line of its own (the
  // proof stays at PROOF_START_LINE, which GameServer's getProofState
  // assumes too) — and the header line stays import lines only.
  assert.equal(RUNNER_PRELUDE, "set_option Elab.async true ");
  const lines = text.split("\n");
  assert.equal(lines[0], "import Game.Levels.TestWorld.L01_X import GameServer.Runner ");
  assert.ok(lines[1].startsWith('set_option Elab.async true Runner "MyGame" '), lines[1]);
  assert.ok(!lines[1].includes(" in Runner"));
  assert.equal(lines[PROOF_START_LINE], "rfl");
  assert.equal(hover.params.position.line, 0 + PROOF_START_LINE);
  assert.equal(hover.params.textDocument.uri, "file:///game/Metadata.lean");

  // full-text didChange (resident front door: change = 1) is wrapped like the
  // didOpen; a ranged change is only line-shifted.
  post({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: "file:///levels/TestWorld__1.lean", version: 2 }, contentChanges: [{ text: "rw [h]\nrfl" }] } });
  post({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: "file:///levels/TestWorld__1.lean", version: 3 }, contentChanges: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, text: "rfl" }] } });
  await until("the two didChanges", () => toWorker.length >= 5);
  const full = toWorker[3], ranged = toWorker[4];
  assert.equal(full.params.textDocument.uri, "file:///game/Metadata.lean");
  assert.ok(full.params.contentChanges[0].text.startsWith("import Game.Levels.TestWorld.L01_X import GameServer.Runner \n"), "full-text change carries the header");
  assert.ok(full.params.contentChanges[0].text.endsWith(':= by\nrw [h]\nrfl\n'));
  assert.equal(ranged.params.contentChanges[0].text, "rfl");
  assert.equal(ranged.params.contentChanges[0].range.start.line, 0 + PROOF_START_LINE);

  // level switch: didClose + didOpen of another level, then a full-text
  // didChange — the wrapper must carry the NEW level's header and command,
  // and the version must pass through.
  post({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri: "file:///levels/TestWorld__1.lean" } } });
  post({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: "file:///levels/Other__2.lean", languageId: "lean4", version: 1, text: "simp" } } });
  post({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: "file:///levels/Other__2.lean", version: 2 }, contentChanges: [{ text: "simp\nrfl" }] } });
  await until("the level switch", () => toWorker.length >= 8);
  const [close, open2, change2] = toWorker.slice(5, 8);
  assert.equal(close.method, "textDocument/didClose");
  assert.equal(close.params.textDocument.uri, "file:///game/Metadata.lean");
  assert.ok(open2.params.textDocument.text.startsWith("import Game.Levels.Other.L02_X import GameServer.Runner \n"));
  assert.ok(open2.params.textDocument.text.includes('Runner "MyGame" "Other" 2 '));
  assert.equal(change2.params.textDocument.version, 2);
  assert.ok(change2.params.contentChanges[0].text.includes('Runner "MyGame" "Other" 2 '), "full-text change after a switch carries the new level's command");
  assert.ok(change2.params.contentChanges[0].text.endsWith(":= by\nsimp\nrfl\n"));

  // returning to a level whose model still exists: the editor sends only a
  // full-text didChange of THAT uri — it must become a re-open carrying that
  // level's header, never the previous level's.
  post({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: "file:///levels/TestWorld__1.lean", version: 7 }, contentChanges: [{ text: "rfl" }] } });
  await until("the return to the level", () => toWorker.length >= 9);
  const back = toWorker[8];
  assert.equal(back.method, "textDocument/didOpen", "cross-level change re-opens the worker document");
  assert.equal(back.params.textDocument.uri, "file:///game/Metadata.lean");
  assert.equal(back.params.textDocument.version, 7);
  assert.ok(back.params.textDocument.text.startsWith("import Game.Levels.TestWorld.L01_X import GameServer.Runner \n"));
  assert.ok(back.params.textDocument.text.includes('Runner "MyGame" "TestWorld" 1 '), "the header is the level of the uri, not of the last didOpen");
  assert.ok(back.params.textDocument.text.endsWith(":= by\nrfl\n"));

  // fileProgress → onProcessing: ranges in flight = true; a lone kind-2 (fatal
  // error) entry is a verdict, not work; empty = false.
  const seen: boolean[] = [];
  gt.onProcessing = (b) => seen.push(b);
  for (const processing of [[{ range: {}, kind: 1 }], [{ range: {}, kind: 2 }], []]) {
    gt["toClient"]({ jsonrpc: "2.0", method: "$/lean/fileProgress", params: { textDocument: { uri: "file:///game/Metadata.lean" }, processing } } as any);
  }
  assert.deepEqual(seen, [true, false, false]);
  // server → client: diagnostics on the wrapped doc come back rebased + re-uri'd
  upstream.port2.postMessage({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics",
    params: { uri: "file:///game/Metadata.lean", diagnostics: [{ range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } }, message: "boom" }] } });
  await until("the diagnostics", () => fromServer.length >= 1);
  assert.equal(fromServer.length, 1);
  const d = fromServer[0];
  assert.equal(d.params.uri, "file:///levels/TestWorld__1.lean");
  assert.equal(d.params.diagnostics[0].range.start.line, 0);
  // A proof state's goal references are released once the reply to a later
  // request has arrived; its diagnostics' references, and other methods', never.
  {
    const call = (id: number, method: string, sessionId = "s1") => post({ jsonrpc: "2.0", id, method: "$/lean/rpc/call", params: { method, sessionId, textDocument: { uri: "file:///levels/TestWorld__1.lean" }, position: { line: 0, character: 0 }, params: {} } });
    const code = (p: string) => ({ tag: [{ info: { p } }, { text: "x" }] });
    const state = (g: string) => ({
      steps: [
        { goals: [], command: "", diags: [], line: 0, character: 0 },
        { goals: [{ goal: { hyps: [{ names: ["h"], type: code(g) }], type: code(g), ctx: { p: `${g}-ctx` }, mvarId: "m" }, hints: [{ text: "t", hidden: false, p: "not a ref" }] }],
          command: "intro h", diags: [{ severity: 1, message: { tag: [{ expr: code("d") }, { text: "e" }] } }], line: 1, character: 7 },
      ],
      diagnostics: [{ severity: 1, message: { expr: code("d") } }], completed: false, completedWithWarnings: false, lastPos: 1,
    });
    const reply = (id: number, result: unknown) => upstream.port2.postMessage({ jsonrpc: "2.0", id, result });
    const releases = () => toWorker.filter((m) => m.method === "$/lean/rpc/release");
    const sent = (n: number) => until(`request ${n}`, () => toWorker.some((m) => m.id === n));
    const answered = (n: number) => until(`reply ${n}`, () => fromServer.some((m) => m.id === n));
    call(101, "Game.getProofState"); await sent(101);
    reply(101, state("a")); await answered(101);
    assert.equal(releases().length, 0, "the state on screen is not released");
    call(102, "Lean.Widget.getInteractiveDiagnostics"); await sent(102);
    reply(102, [{ message: { expr: code("o") } }]); await answered(102);
    assert.equal(releases().length, 0, "another method's references stay the infoview's");
    // Two requests out: the older one's reply is held, not released, until the newest one's arrives.
    call(103, "Game.getProofState"); call(104, "Game.getProofState"); await sent(104);
    reply(103, state("b")); await answered(103);
    assert.equal(releases().length, 0, "a reply the newest request has not answered yet is held");
    reply(104, state("c")); await answered(104);
    await until("the older states' releases", () => releases().length === 2);
    assert.deepEqual(releases()[0].params, { uri: "file:///game/Metadata.lean", sessionId: "s1", refs: [{ p: "a" }, { p: "a" }, { p: "a-ctx" }] }, "the goals only, once per occurrence; `p` beside other keys is no reference");
    assert.deepEqual(releases()[1].params.refs, [{ p: "b" }, { p: "b" }, { p: "b-ctx" }]);
    // An error answer, or none, changes nothing: the state on screen stays.
    call(105, "Game.getProofState"); await sent(105);
    upstream.port2.postMessage({ jsonrpc: "2.0", id: 105, error: { code: -32900, message: "gone" } });
    await answered(105);
    call(106, "Game.getProofState"); await sent(106);
    reply(106, null); await answered(106);
    assert.equal(releases().length, 2);
    // After a checker death the infoview connects a new session: the state from
    // the old one is released under the old session's id.
    call(107, "Game.getProofState", "s2"); await sent(107);
    reply(107, state("e")); await answered(107);
    await until("the old session's release", () => releases().length === 3);
    assert.deepEqual(releases()[2].params, { uri: "file:///game/Metadata.lean", sessionId: "s1", refs: [{ p: "c" }, { p: "c" }, { p: "c-ctx" }] });
    assert.ok(!releases().some((m) => m.params.refs.some((r: { p: string }) => r.p === "d" || r.p === "o")), "no diagnostic's reference");
  }
  console.log("game-translation: ALL TESTS PASS");
  process.exit(0);
}
