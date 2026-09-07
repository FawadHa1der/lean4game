// Run: node client/src/wasm/game-translation.test.ts  (Node ≥22 type stripping)
import { GameTranslation, shiftLines, rebaseSemanticTokens, PROOF_START_LINE } from "./game-translation.ts";
import assert from "node:assert";
import { levelUri, parseLevelUri } from "./level-uri";

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

  setTimeout(() => {
    assert.equal(toWorker.length, 3);
    const [init, open, hover] = toWorker;
    assert.equal(init.params.rootUri, "MyGame");
    assert.equal(open.params.textDocument.uri, "file:///game/Metadata.lean");
    const text: string = open.params.textDocument.text;
    assert.ok(text.startsWith("import Game.Levels.TestWorld.L01_X import GameServer.Runner \n"));
    assert.ok(text.includes('Runner "MyGame" "TestWorld" 1 (difficulty := 1) (inventory := ["rfl"]) := by\nrfl\n'));
    assert.equal(hover.params.position.line, 0 + PROOF_START_LINE);
    assert.equal(hover.params.textDocument.uri, "file:///game/Metadata.lean");

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
    setTimeout(() => {
      assert.equal(fromServer.length, 1);
      const d = fromServer[0];
      assert.equal(d.params.uri, "file:///levels/TestWorld__1.lean");
      assert.equal(d.params.diagnostics[0].range.start.line, 0);
      console.log("game-translation: ALL TESTS PASS");
      process.exit(0);
    }, 50);
  }, 50);
}
