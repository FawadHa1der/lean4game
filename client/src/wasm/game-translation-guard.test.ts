// Run: node --import ./client/src/wasm/ts-resolve-hook.mjs client/src/wasm/game-translation-guard.test.ts
// L6: a document of a level the game has no data for is never forwarded, and
// requests about it are answered locally. L14: suspend() cuts both directions; resume() flushes what was held.
import { GameTranslation, UNKNOWN_LEVEL_ERROR } from "./game-translation.ts";
import assert from "node:assert";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uri = (w: string, l: number) => `file:///levels/${w}__${l}.lean`;

function rig() {
  const upstream = new MessageChannel();
  const gt = new GameTranslation({ gameName: "G", levelData: (w, l) => (w === "Known" && Number(l) <= 2 ? { module: `Game.Levels.${w}.L${l}` } : undefined) });
  const toWorker: any[] = [], toClient: any[] = [];
  upstream.port2.onmessage = (e) => toWorker.push(e.data);
  upstream.port2.start?.();
  gt.clientPort.onmessage = (e) => toClient.push(e.data);
  gt.clientPort.start?.();
  const post = (m: any) => (gt.clientPort as any).postMessage(m);
  return { gt, upstream, toWorker, toClient, post };
}
const warn = console.warn; const warned: string[] = [];
console.warn = (...a: unknown[]) => { warned.push(a.join(" ")); };
const error = console.error; const errored: string[] = [];
console.error = (...a: unknown[]) => { errored.push(a.join(" ")); };

// --- L6: unknown level, buffered before the server attaches (a cold deep link)
{
  const { gt, upstream, toWorker, toClient, post } = rig();
  post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: null } });
  post({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: uri("NoSuchWorld", 1), languageId: "lean4", version: 1, text: "" } } });
  post({ jsonrpc: "2.0", id: 2, method: "$/lean/rpc/connect", params: { uri: uri("NoSuchWorld", 1) } });
  await wait(100);
  gt.attachServer(upstream.port1);
  post({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: uri("NoSuchWorld", 1), version: 2 }, contentChanges: [{ text: "rfl" }] } });
  post({ jsonrpc: "2.0", id: 3, method: "$/lean/rpc/call", params: { textDocument: { uri: uri("NoSuchWorld", 1) }, position: { line: 0, character: 0 }, method: "Game.getProofState" } });
  await wait(100);
  assert.deepEqual(toWorker.map((m) => m.method), ["initialize"], "only the initialize reaches the checker");
  assert.ok(!JSON.stringify(toWorker).includes("import  import"), "no wrapped document with an empty module");
  assert.deepEqual(toClient.map((m) => m.id), [2, 3], "both requests are answered locally");
  assert.ok(toClient.every((m) => String(m.error?.message).startsWith(UNKNOWN_LEVEL_ERROR)));
  assert.equal(errored.length, 0, "no console.error for a bad route");
  assert.ok(warned.some((w) => /no level data for NoSuchWorld\/1/.test(w)));

  // a known level's didOpen clears the flag and flows normally
  post({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: uri("Known", 1), languageId: "lean4", version: 1, text: "rfl" } } });
  post({ jsonrpc: "2.0", id: 4, method: "$/lean/rpc/connect", params: { uri: uri("Known", 1) } });
  await wait(100);
  assert.deepEqual(toWorker.map((m) => m.method), ["initialize", "textDocument/didOpen", "$/lean/rpc/connect"]);
  assert.ok(toWorker[1].params.textDocument.text.startsWith("import Game.Levels.Known.L1 import GameServer.Runner \n"));

  // unknown LEVEL of a known world, entered as the full-text didChange of a returning model
  post({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: uri("Known", 999), version: 5 }, contentChanges: [{ text: "x" }] } });
  await wait(100);
  assert.equal(toWorker.length, 3, "the re-open of an unknown level is not forwarded either");

  // --- L14: suspend cuts both directions
  post({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: uri("Known", 2), languageId: "lean4", version: 1, text: "" } } });
  await wait(100);
  assert.equal(toWorker.length, 4);
  const nWarn = warned.length, nClient = toClient.length;
  gt.suspend();
  post({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: uri("OtherGameWorld", 1), languageId: "lean4", version: 1, text: "" } } });
  post({ jsonrpc: "2.0", id: 9, method: "$/lean/rpc/call", params: { textDocument: { uri: uri("OtherGameWorld", 1) }, position: { line: 0, character: 0 } } });
  upstream.port2.postMessage({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///game/Metadata.lean", diagnostics: [] } });
  await wait(100);
  assert.equal(toWorker.length, 4, "suspended: nothing reaches the old checker");
  assert.equal(toClient.length, nClient, "suspended: nothing is relayed back");
  assert.equal(warned.length, nWarn, "suspended: the other game's level is not even looked up");
  assert.equal(errored.length, 0);

  // --- L14: resume() — the switch was cancelled; held traffic flushes in order
  post({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: uri("Known", 1), languageId: "lean4", version: 7, text: "rfl" } } });
  await wait(100);
  assert.equal(toWorker.length, 4, "still suspended: the bound game's didOpen is held, not dropped");
  gt.resume();
  post({ jsonrpc: "2.0", id: 10, method: "$/lean/rpc/connect", params: { uri: uri("Known", 1) } });
  await wait(100);
  assert.ok(warned.slice(nWarn).some((w) => /no level data for OtherGameWorld\/1/.test(w)), "the other game's didOpen hit the unknown-level defence");
  assert.ok(!toClient.slice(nClient).some((m) => m.id === 9), "its held request is dropped unanswered (an error answer is a console error in the client)");
  assert.deepEqual(toWorker.slice(4).map((m) => m.method), ["textDocument/didOpen", "$/lean/rpc/connect"], "only the bound game's document reaches the checker");
  assert.ok(toWorker[4].params.textDocument.text.startsWith("import Game.Levels.Known.L1 "));
  upstream.port2.postMessage({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///game/Metadata.lean", diagnostics: [] } });
  await wait(100);
  assert.ok(toClient.length > nClient, "resumed: server traffic is relayed again");
  assert.equal(errored.length, 0);
}

console.warn = warn; console.error = error;
console.log("game-translation-guard: ALL TESTS PASS");
process.exit(0);
