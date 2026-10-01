// Run: node --import ./client/src/wasm/ts-resolve-hook.mjs client/src/wasm/game-translation-guard.test.ts
// L6: a document of a level the game has no data for is never forwarded, and
// requests about it are answered locally. L14: suspend() cuts both directions; resume() flushes what was held.
// N1: the relay's orphaned-request errors (checker died / halted) reach the client as -32097, rpc answers untouched.
import { GameTranslation, UNKNOWN_LEVEL_ERROR, PENDING_RESPONSE_REJECTED } from "./game-translation.ts";
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

// --- N1: orphaned feature requests are answered `result: null` (no error
// response reaches lean4monaco's messageStrategy, which logs every one);
// lifecycle requests keep an error, as PendingResponseRejected (-32097)
{
  const { gt, upstream, toWorker, toClient, post } = rig();
  gt.attachServer(upstream.port1);
  post({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: uri("Known", 1), languageId: "lean4", version: 1, text: "rfl" } } });
  const td = { textDocument: { uri: uri("Known", 1) } };
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
  post({ jsonrpc: "2.0", id: 20, method: "textDocument/codeAction", params: { ...td, range, context: { diagnostics: [] } } });
  post({ jsonrpc: "2.0", id: 21, method: "textDocument/inlayHint", params: { ...td, range } });
  post({ jsonrpc: "2.0", id: 22, method: "textDocument/semanticTokens/full", params: td });
  post({ jsonrpc: "2.0", id: 23, method: "$/lean/rpc/call", params: { ...td, position: { line: 0, character: 0 }, method: "Game.getProofState", sessionId: "1" } });
  post({ jsonrpc: "2.0", id: 24, method: "$/lean/rpc/connect", params: { uri: uri("Known", 1) } });
  post({ jsonrpc: "2.0", id: 25, method: "textDocument/hover", params: { ...td, position: { line: 0, character: 0 } } });
  post({ jsonrpc: "2.0", id: 26, method: "textDocument/documentSymbol", params: td });
  post({ jsonrpc: "2.0", id: 27, method: "shutdown" });
  await wait(100);
  assert.deepEqual(toWorker.map((m) => m.id).filter((x) => x !== undefined), [20, 21, 22, 23, 24, 25, 26, 27]);
  const err = (id: number | string, code: number, message: string) => upstream.port2.postMessage({ jsonrpc: "2.0", id, error: { code, message } });
  // the relay's failInFlight after a death, then its halted refusal
  err(20, -32603, "QED64: the Lean checker died (bootFailed)");
  err(21, -32603, "QED64: the Lean checker died (RUNTIME_FETCH_FAILED)");
  err(22, -32603, "QED64: checker halted after repeated crashes; edit the file to restart it");
  err(23, -32900, "QED64: the Lean checker died (bootFailed)");
  err(24, -32603, "QED64: checker halted after repeated crashes; edit the file to restart it");
  err(25, -32603, "some genuine internal error"); // not an orphaned-request answer: untouched
  upstream.port2.postMessage({ jsonrpc: "2.0", id: 26, result: [] }); // a success: untouched
  err(27, -32603, "QED64: the Lean checker died (crash)"); // lifecycle: an error, as -32097
  err(99, -32603, "QED64: the Lean checker died (bootFailed)"); // never went out through here: untouched
  await wait(100);
  const byId = new Map(toClient.filter((m) => m.method === undefined).map((m) => [m.id, m]));
  for (const [id, what] of [[20, "codeAction orphaned by a death"], [21, "inlayHint"], [22, "semanticTokens refused while halted"]] as const) {
    assert.equal(byId.get(id).error, undefined, `${what} → no error response`);
    assert.ok("result" in byId.get(id) && byId.get(id).result === null, `${what} → result: null`);
  }
  assert.equal(byId.get(27).error.code, PENDING_RESPONSE_REJECTED, "shutdown orphaned by a death → -32097");
  assert.equal(byId.get(27).error.message, "QED64: the Lean checker died (crash)", "message kept");
  assert.equal(byId.get(23).error.code, -32900, "rpc call keeps RpcNeedsReconnect (infoview session recovery)");
  assert.equal(byId.get(24).error.code, -32603, "rpc connect refused while halted is untouched");
  assert.equal(byId.get(25).error.code, -32603, "other errors are untouched");
  assert.deepEqual(byId.get(26).result, [], "results pass through");
  assert.equal(byId.get(99).error.code, -32603, "an answer to an unknown request is untouched");
  assert.equal(PENDING_RESPONSE_REJECTED, -32097);
  // ids are forgotten once answered: a later reuse of the id for an rpc request is not rewritten
  post({ jsonrpc: "2.0", id: 20, method: "$/lean/rpc/call", params: { ...td, position: { line: 0, character: 0 }, method: "Game.getProofState", sessionId: "1" } });
  await wait(50);
  err(20, -32603, "QED64: checker halted after repeated crashes; edit the file to restart it");
  await wait(100);
  assert.equal(toClient.filter((m) => m.id === 20).slice(-1)[0].error.code, -32603, "the reused id maps to its new (rpc) method");
  assert.equal(errored.length, 0);
}

console.warn = warn; console.error = error;
console.log("game-translation-guard: ALL TESTS PASS");
process.exit(0);
