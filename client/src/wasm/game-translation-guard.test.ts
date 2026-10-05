// Run: node --import ./client/src/wasm/ts-resolve-hook.mjs client/src/wasm/game-translation-guard.test.ts
// L6: a document of a level the game has no data for is never forwarded, and
// requests about it are answered locally. L14: suspend() cuts both directions; resume() flushes what was held.
// N1: the relay's orphaned-request errors (checker died / halted / restart) reach the client as `result: null` or
// -32097, rpc answers untouched — the errors are the real qed64 relay's, read by `error.data.qed64.kind`.
// The editor-mode crash: a burst of full-text changes reaches the checker throttled (change-throttle.ts).
import { GameTranslation, UNKNOWN_LEVEL_ERROR, PENDING_RESPONSE_REJECTED, relayErrorKind } from "./game-translation.ts";
import { LspRelay, type JsonRpcMessage, type RelaySession, type WorkerStatus } from "qed64/embed";
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
// lifecycle requests keep an error, as PendingResponseRejected (-32097).
// The errors are the REAL relay's (qed64 LspRelay over a scripted session),
// read by their `error.data.qed64.kind` (relayErrorKind), not their text.
{
  class FakeSession implements RelaySession {
    static all: FakeSession[] = [];
    static n = 0;
    readonly id = `fs${++FakeSession.n}`;
    got: any[] = [];
    onLsp: (msg: JsonRpcMessage) => void = () => {};
    onStatus: (status: WorkerStatus) => void = () => {};
    onDied: (code: number | null, reason: string, message: string, cause?: unknown) => void = () => {};
    constructor() { FakeSession.all.push(this); }
    start(): Promise<void> { return Promise.resolve(); }
    arm(): Promise<void> { return Promise.resolve(); }
    lsp(msg: JsonRpcMessage): void { this.got.push(msg); }
    dispose(): void {}
    terminate(): void {}
  }
  const relay = new LspRelay(() => new FakeSession(), { status: () => {} }, () => Promise.resolve());
  const { gt, toClient, post } = rig();
  gt.attachServer(relay.clientPort);
  await wait(50);
  post({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: uri("Known", 1), languageId: "lean4", version: 1, text: "rfl" } } });
  const td = { textDocument: { uri: uri("Known", 1) } };
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
  post({ jsonrpc: "2.0", id: 20, method: "textDocument/codeAction", params: { ...td, range, context: { diagnostics: [] } } });
  post({ jsonrpc: "2.0", id: 21, method: "textDocument/inlayHint", params: { ...td, range } });
  post({ jsonrpc: "2.0", id: 23, method: "$/lean/rpc/call", params: { ...td, position: { line: 0, character: 0 }, method: "Game.getProofState", sessionId: "1" } });
  post({ jsonrpc: "2.0", id: 25, method: "textDocument/hover", params: { ...td, position: { line: 0, character: 0 } } });
  post({ jsonrpc: "2.0", id: 26, method: "textDocument/documentSymbol", params: td });
  post({ jsonrpc: "2.0", id: 27, method: "shutdown" });
  post({ jsonrpc: "2.0", id: 28, method: "textDocument/completion", params: { ...td, position: { line: 0, character: 0 } } });
  await wait(50);
  const s1 = FakeSession.all[0]!;
  assert.deepEqual(s1.got.map((m) => m.id).filter((x) => x !== undefined), [20, 21, 23, 25, 26, 27, 28], "every request reached the checker");
  // The checker's own answers: a genuine error, a success, the front door's
  // own "QED64: …" refusal (no relay kind), an answer to a request it never got.
  s1.onLsp({ jsonrpc: "2.0", id: 25, error: { code: -32603, message: "some genuine internal error" } });
  s1.onLsp({ jsonrpc: "2.0", id: 26, result: [] });
  s1.onLsp({ jsonrpc: "2.0", id: 28, error: { code: -32801, message: "QED64: the header is unresolved; completion is unavailable until it resolves" } });
  s1.onLsp({ jsonrpc: "2.0", id: 99, error: { code: -32603, message: "QED64: the Lean checker died (bootFailed)" } });
  // A death: the relay fails every request in flight (20, 21, 23, 27) — "orphaned".
  s1.onDied(null, "bootFailed", "snapshot 'nng4' failed to load", undefined);
  await wait(50);
  // Two more deaths in the window: the breaker halts; requests now refused — "halted".
  FakeSession.all[1]!.onDied(null, "crash", "", undefined);
  await wait(20);
  FakeSession.all[2]!.onDied(null, "crash", "", undefined);
  assert.equal(relay.state.kind, "halted");
  post({ jsonrpc: "2.0", id: 22, method: "textDocument/semanticTokens/full", params: td });
  post({ jsonrpc: "2.0", id: 24, method: "$/lean/rpc/connect", params: { uri: uri("Known", 1) } });
  await wait(100);
  const byId = new Map(toClient.filter((m) => m.method === undefined).map((m) => [m.id, m]));
  for (const [id, what] of [[20, "codeAction orphaned by a death"], [21, "inlayHint"], [22, "semanticTokens refused while halted"]] as const) {
    assert.equal(byId.get(id).error, undefined, `${what} → no error response`);
    assert.ok("result" in byId.get(id) && byId.get(id).result === null, `${what} → result: null`);
  }
  assert.equal(byId.get(27).error.code, PENDING_RESPONSE_REJECTED, "shutdown orphaned by a death → -32097");
  assert.equal(byId.get(27).error.message, "QED64: the Lean checker died (bootFailed)", "message kept");
  assert.equal(byId.get(27).error.data.qed64.kind, "orphaned", "data kept");
  assert.equal(byId.get(23).error.code, -32900, "rpc call keeps RpcNeedsReconnect (infoview session recovery)");
  assert.equal(relayErrorKind(byId.get(23).error), "orphaned");
  assert.equal(byId.get(24).error.code, -32603, "rpc connect refused while halted is untouched");
  assert.equal(relayErrorKind(byId.get(24).error), "halted", "goals.tsx keeps its card on this kind");
  assert.equal(byId.get(25).error.code, -32603, "the checker's own errors are untouched");
  assert.deepEqual(byId.get(26).result, [], "results pass through");
  assert.equal(byId.get(28).error.code, -32801, "a worker's own \"QED64: …\" refusal is the checker's answer: untouched");
  assert.equal(byId.get(99).error.code, -32603, "an answer to an unknown request is untouched");
  assert.equal(PENDING_RESPONSE_REJECTED, -32097);
  // A deliberate replacement orphans requests too ("restart"): a feature
  // request is answered `result: null`, never an error the client logs.
  relay.rearm();
  await wait(50);
  assert.equal(relay.state.kind, "serving");
  post({ jsonrpc: "2.0", id: 30, method: "textDocument/codeAction", params: { ...td, range, context: { diagnostics: [] } } });
  await wait(50);
  relay.restart({ snapshots: ["init", "nng4"] });
  await wait(50);
  const restarted = toClient.filter((m) => m.id === 30);
  assert.deepEqual(restarted, [{ jsonrpc: "2.0", id: 30, result: null }], "orphaned by a restart: result null");
  // ids are forgotten once answered: a later reuse of the id for an rpc request is not rewritten
  post({ jsonrpc: "2.0", id: 20, method: "$/lean/rpc/call", params: { ...td, position: { line: 0, character: 0 }, method: "Game.getProofState", sessionId: "1" } });
  await wait(50);
  FakeSession.all[FakeSession.all.length - 1]!.onDied(null, "crash", "Uncaught RuntimeError: memory access out of bounds", undefined);
  await wait(100);
  const reused = toClient.filter((m) => m.id === 20).slice(-1)[0];
  assert.equal(reused.error.code, -32900, "the reused id maps to its new (rpc) method");
  assert.equal(errored.length, 0);
  relay.clientPort.close();
}

// relayErrorKind: the relay's structured kind, nothing from the text.
assert.equal(relayErrorKind({ code: -32603, message: "x", data: { qed64: { kind: "orphaned", reason: "r" } } }), "orphaned");
assert.equal(relayErrorKind({ code: -32603, message: "x", data: { qed64: { kind: "halted" } } }), "halted");
assert.equal(relayErrorKind({ code: -32603, message: "x", data: { qed64: { kind: "restart" } } }), "restart");
assert.equal(relayErrorKind({ code: -32603, message: "QED64: the Lean checker died (crash)" }), null, "text alone is not the relay's word");
assert.equal(relayErrorKind({ code: -32603, message: "x", data: { qed64: { kind: "other" } } }), null);
assert.equal(relayErrorKind(null), null);
assert.equal(relayErrorKind("No connection to Lean"), null);

// --- The editor-mode crash (change-throttle.ts) through the translation: a
// burst of full-text changes with a request after each reaches the checker
// as the first change and the last text — each wrapped in the Runner — with
// every request after the text it was asked about; a game switch's suspend
// sends a held change before it cuts the traffic.
{
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const clock = { now: () => now, setTimeout: (fn: () => void, ms: number) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; }, clearTimeout: (id: unknown) => { timers.delete(id as number); } };
  const fire = (ms: number) => { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); } };
  const upstream = new MessageChannel();
  const gt = new GameTranslation({ gameName: "G", levelData: (w, l) => ({ module: `Game.Levels.${w}.L${l}` }), clock });
  const toWorker: any[] = [];
  upstream.port2.onmessage = (e) => toWorker.push(e.data);
  gt.clientPort.onmessage = () => {};
  gt.attachServer(upstream.port1);
  const post = (m: any) => (gt.clientPort as any).postMessage(m);
  post({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: uri("Known", 1), languageId: "lean4", version: 1, text: "" } } });
  await wait(20);
  fire(10_000);
  for (let i = 1; i <= 9; i++) {
    post({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: uri("Known", 1), version: i + 1 }, contentChanges: [{ text: "rw [add_zero]".slice(0, i) }] } });
    post({ jsonrpc: "2.0", id: 200 + i, method: "$/lean/rpc/call", params: { textDocument: { uri: uri("Known", 1) }, position: { line: 0, character: i }, method: "Game.getProofState", sessionId: "1" } });
    await wait(5);
    fire(10);
  }
  await wait(20);
  assert.deepEqual(toWorker.map((m) => m.method ?? m.id), ["textDocument/didOpen", "textDocument/didChange", "$/lean/rpc/call"], "the first keystroke at once");
  fire(300);
  await wait(20);
  const changes = toWorker.filter((m) => m.method === "textDocument/didChange");
  assert.equal(changes.length, 2, "two elaborations for the burst, not nine");
  assert.ok(changes[1].params.contentChanges[0].text.startsWith("import Game.Levels.Known.L1 import GameServer.Runner \n"), "the held change was wrapped like any other");
  assert.ok(changes[1].params.contentChanges[0].text.endsWith(":= by\nrw [add_z\n"));
  assert.deepEqual(toWorker.slice(3).map((m) => m.method === "textDocument/didChange" ? "change" : m.id), ["change", 202, 203, 204, 205, 206, 207, 208, 209]);
  // A game switch: suspend() sends what is held, then nothing more.
  post({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: uri("Known", 1), version: 20 }, contentChanges: [{ text: "rfl" }] } });
  await wait(20);
  const before = toWorker.length;
  gt.suspend();
  assert.equal(toWorker.length, before, "(delivery is async)");
  await wait(20);
  assert.equal(toWorker.length, before + 1, "the held change went before the cut");
  assert.equal(toWorker[before].params.textDocument.version, 20);
  fire(1000);
  await wait(20);
  assert.equal(toWorker.length, before + 1, "nothing after it");
}

console.warn = warn; console.error = error;
console.log("game-translation-guard: ALL TESTS PASS");
process.exit(0);
