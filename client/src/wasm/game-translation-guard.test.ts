// Run: node --import ./client/src/wasm/ts-resolve-hook.mjs client/src/wasm/game-translation-guard.test.ts
// L6: a document of a level the game has no data for is never forwarded, and
// requests about it are answered locally. L14: suspend() cuts both directions; resume() flushes what was held.
// N1: the relay's orphaned-request errors (checker died / halted / restart) reach the client as `result: null` or
// -32097, rpc answers untouched — the errors are the real qed64 relay's, read by `error.data.qed64.kind`.
// QD-API-2's residual: a relay-invented answer to a forwarded request fires onOrphanedRequest (its method and the
// relay's kind) before N1's rewrite; a stale-page death that takes the client's `initialize` is read off the relay's
// status at that moment (death-kind staleInitialize). The full-text change coalescing is qed64's own (EMBEDDING §7.8);
// R3-1: its `superseded` ContentModified on a completion reaches the client as `result: null` (what the client makes
// of it anyway, and no error response for lean4monaco's messageStrategy to log), on a semantic-tokens request
// unchanged (the provider's CancellationError → refetch) — on the real coalescer (the package's edit-coalescer.ts,
// not in `qed64/embed`'s surface: read by path like the worker scripts in death-kind.test.ts).
import { GameTranslation, UNKNOWN_LEVEL_ERROR, PENDING_RESPONSE_REJECTED, isSupersededAnswer, relayErrorKind } from "./game-translation.ts";
import { staleInitialize } from "./death-kind.ts";
import { LspRelay, type JsonRpcMessage, type RelaySession, type WorkerStatus } from "qed64/embed";
import assert from "node:assert";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
  // The hook names every request the relay answers itself, nothing the checker answered.
  const orphaned: string[] = [];
  gt.onOrphanedRequest = (method, kind) => orphaned.push(`${method}:${kind}`);
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
  assert.deepEqual(orphaned, [
    "textDocument/codeAction:orphaned", "textDocument/inlayHint:orphaned", "$/lean/rpc/call:orphaned", "shutdown:orphaned", // the death, in the relay's order
    "textDocument/semanticTokens/full:halted", "$/lean/rpc/connect:halted", // refused while halted
    "textDocument/codeAction:restart", // the deliberate replacement
    "$/lean/rpc/call:orphaned", // the reused id, under its new method
  ], "onOrphanedRequest: every relay-invented answer, by method and kind — rpc ones included, the checker's own never");
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

// --- QD-API-2's residual (the live check of the adoption): a stale-page
// death (WORKER_DEP_MISMATCH on the page's first worker, at its first LSP
// frame) orphans the language client's own `initialize`. The relay heals on
// its own — the replacement replays the initialize — but the client's start()
// has failed and it stays "starting" for good. The hook names the orphaned
// request before N1's -32097 reaches the client, and the relay's status
// carries that death when it fires: what game-boot latches the stale-page
// card on (death-kind staleInitialize).
{
  class FakeSession implements RelaySession {
    static all: FakeSession[] = [];
    static n = 0;
    readonly id = `ss${++FakeSession.n}`;
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
  const seen: Array<{ method: string; kind: string; stale: boolean; relay: string }> = [];
  gt.onOrphanedRequest = (method, kind) => seen.push({ method, kind, stale: staleInitialize(method, kind, relay.status().lastDeath), relay: relay.status().relay });
  gt.attachServer(relay.clientPort);
  await wait(50);
  post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { initializationOptions: { difficulty: 1 } } });
  post({ jsonrpc: "2.0", id: 1, method: "textDocument/hover", params: { textDocument: { uri: uri("Known", 1) }, position: { line: 0, character: 0 } } });
  await wait(50);
  const s1 = FakeSession.all[0]!;
  assert.deepEqual(s1.got.map((m) => m.method), ["initialize", "textDocument/hover"], "both reached the first worker");
  // The worker's error reply refusing a front door of another revision (the real relay classifies nothing: the cause is the session's).
  const message = "lsp-front-door.js is revision \"2\", lean.worker.js needs 1 (a deploy mixed versions; reload)";
  s1.onDied(null, "WORKER_DEP_MISMATCH", message, { kind: "other", code: "WORKER_DEP_MISMATCH", message });
  await wait(50);
  // The relay has healed by the time the port delivers the orphan answers
  // (`serving` already: a settle and a boot that resolve at once) — so the
  // latch keys on the death, which the relay keeps until a session reports
  // ready, never on the relay's state.
  assert.deepEqual(seen, [
    { method: "initialize", kind: "orphaned", stale: true, relay: "serving" },
    { method: "textDocument/hover", kind: "orphaned", stale: false, relay: "serving" },
  ], "the initialize is the stale page's; the hover is an ordinary orphan (the reboot's label says it)");
  const init = toClient.find((m) => m.id === 0)!;
  assert.equal(init.error.code, PENDING_RESPONSE_REJECTED, "N1 unchanged: the client sees its initialize fail");
  assert.equal(relayErrorKind(init.error), "orphaned");
  // The relay heals without the client: the replacement got the replayed
  // initialize, and its answer to that id reaches a client no longer waiting.
  const s2 = FakeSession.all[1]!;
  assert.deepEqual(s2.got.map((m) => m.method), ["initialize"], "replayed into the replacement");
  s2.onLsp({ jsonrpc: "2.0", id: 0, result: { capabilities: {} } });
  await wait(50);
  assert.equal(toClient.filter((m) => m.id === 0).length, 2, "the replay's answer is passed through (the client ignores a response to an id it no longer waits for)");
  assert.equal(seen.length, 2, "the checker's own answer fires nothing");
  // Any other death orphaning the initialize is not a stale page.
  post({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
  await wait(50);
  s2.onDied(null, "crash", "Uncaught RuntimeError: memory access out of bounds", { kind: "other", code: "crash", message: "Uncaught RuntimeError: memory access out of bounds" });
  await wait(50);
  assert.deepEqual(seen[2], { method: "initialize", kind: "orphaned", stale: false, relay: "serving" });
  relay.clientPort.close();
}

// --- R3-1: the session's edit coalescer (qed64 84d594e, EMBEDDING §7.8)
// answers a queued completion or semantic-tokens request whose change a
// newer full-text change replaced with ContentModified (-32801, kind
// "superseded") — an error response, which lean4monaco's messageStrategy
// logs. The REAL coalescer, wired as ResidentSession wires it (`reject` →
// the session's onLsp), under the real relay: a superseded completion crosses
// as `result: null`; a superseded semantic-tokens request keeps its -32801
// (the provider refetches on the CancellationError); neither fires
// onOrphanedRequest; the hover queued with them waits for the window.
{
  const pkg = path.dirname(createRequire(import.meta.url).resolve("qed64/package.json"));
  const { createEditCoalescer, SUPERSEDED, DEFAULT_EDIT_COALESCE_MS } = await import(pathToFileURL(path.join(pkg, "lib/edit-coalescer.ts")).href);
  assert.equal(DEFAULT_EDIT_COALESCE_MS, 300, "the window the game's throttle measured");
  // Injected timers: the window ends when the test says so.
  let timers: Array<{ id: number; f: () => void }> = [];
  let nextTimer = 1;
  const clock = { setTimeout: (f: () => void) => { const id = nextTimer++; timers.push({ id, f }); return id; }, clearTimeout: (id: unknown) => { timers = timers.filter((t) => t.id !== id); } };
  const endWindow = () => { for (const t of timers.splice(0)) t.f(); };
  class CoalescingSession implements RelaySession {
    static all: CoalescingSession[] = [];
    readonly id = `cs${CoalescingSession.all.length + 1}`;
    got: any[] = [];
    onLsp: (msg: JsonRpcMessage) => void = () => {};
    onStatus: (status: WorkerStatus) => void = () => {};
    onDied: (code: number | null, reason: string, message: string, cause?: unknown) => void = () => {};
    private readonly edits = createEditCoalescer({ forward: (m: any) => this.got.push(m), reject: (req: any, error: any) => this.onLsp({ jsonrpc: "2.0", id: req.id, error }), ms: DEFAULT_EDIT_COALESCE_MS, timers: clock });
    constructor() { CoalescingSession.all.push(this); }
    start(): Promise<void> { return Promise.resolve(); }
    arm(): Promise<void> { return Promise.resolve(); }
    lsp(msg: JsonRpcMessage, replay?: boolean): void { this.edits.send(msg, replay); }
    dispose(): void { this.edits.dispose(); }
    terminate(): void {}
  }
  const relay = new LspRelay(() => new CoalescingSession(), { status: () => {} }, () => Promise.resolve());
  const { gt, toClient, post } = rig();
  const orphaned: string[] = [];
  gt.onOrphanedRequest = (method, kind) => orphaned.push(`${method}:${kind}`);
  gt.attachServer(relay.clientPort);
  await wait(50);
  const td = { textDocument: { uri: uri("Known", 1) } };
  const change = (version: number, text: string) => post({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: uri("Known", 1), version }, contentChanges: [{ text }] } });
  post({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: uri("Known", 1), languageId: "lean4", version: 1, text: "" } } });
  change(2, "r"); // forwarded at once: the window opens
  await wait(50);
  change(3, "rw"); // held
  await wait(50);
  post({ jsonrpc: "2.0", id: 40, method: "textDocument/semanticTokens/full", params: td }); // queued behind the held change
  post({ jsonrpc: "2.0", id: 41, method: "textDocument/completion", params: { ...td, position: { line: 0, character: 2 }, context: { triggerKind: 1 } } });
  post({ jsonrpc: "2.0", id: 42, method: "textDocument/hover", params: { ...td, position: { line: 0, character: 2 } } });
  await wait(50);
  const s = CoalescingSession.all[0]!;
  assert.deepEqual(s.got.map((m) => m.method), ["textDocument/didOpen", "textDocument/didChange"], "the checker saw the open and the first change only");
  change(4, "rw "); // replaces the held change: the queued tokens and completion requests are superseded now
  await wait(50);
  const tokens = toClient.find((m) => m.id === 40)!;
  assert.equal(tokens.error?.code, -32801, "superseded semantic tokens: the -32801 stays (the provider refetches on it)");
  assert.equal(tokens.error.message, SUPERSEDED.message, "the coalescer's own answer, untouched");
  assert.equal(tokens.error.data.qed64.kind, "superseded");
  assert.equal(relayErrorKind(tokens.error), null, "not a relay-invented kind");
  assert.equal(isSupersededAnswer(tokens.error), true);
  assert.deepEqual(toClient.find((m) => m.id === 41), { jsonrpc: "2.0", id: 41, result: null }, "superseded completion: result null, no error response for the client to log");
  assert.equal(toClient.filter((m) => m.id === 42).length, 0, "the hover stays queued: answered against the newer text after the window");
  assert.deepEqual(orphaned, [], "a superseded answer is nobody's death: the hook stays quiet");
  assert.deepEqual(s.got.map((m) => m.method), ["textDocument/didOpen", "textDocument/didChange"], "nothing reached the checker meanwhile");
  endWindow();
  await wait(50);
  assert.deepEqual(s.got.map((m) => m.id ?? m.method), ["textDocument/didOpen", "textDocument/didChange", "textDocument/didChange", 42], "window end: the newest change, then the queue");
  assert.ok(s.got[2].params.contentChanges[0].text.endsWith("rw \n"), "the newest text, wrapped");
  // The front door's own ContentModified on a completion carries no kind: the checker's answer, untouched (as in the N1 block).
  post({ jsonrpc: "2.0", id: 43, method: "textDocument/completion", params: { ...td, position: { line: 0, character: 3 } } });
  await wait(50);
  s.onLsp({ jsonrpc: "2.0", id: 43, error: { code: -32801, message: "QED64: the header is unresolved; completion is unavailable until it resolves" } });
  await wait(50);
  assert.equal(toClient.find((m) => m.id === 43)?.error?.code, -32801, "the front door's own refusal keeps its code");
  assert.equal(isSupersededAnswer(toClient.find((m) => m.id === 43)!.error), false);
  assert.equal(errored.length, 0);
  relay.clientPort.close();
}

// isSupersededAnswer: the coalescer's structured kind, nothing else.
assert.equal(isSupersededAnswer({ code: -32801, message: "x", data: { qed64: { kind: "superseded", reason: "r" } } }), true);
assert.equal(isSupersededAnswer({ code: -32801, message: "QED64: the document changed before this request reached the checker" }), false, "text alone is not the coalescer's word");
assert.equal(isSupersededAnswer({ code: -32603, message: "x", data: { qed64: { kind: "orphaned" } } }), false);
assert.equal(isSupersededAnswer(null), false);
assert.equal(isSupersededAnswer(undefined), false);

console.warn = warn; console.error = error;
console.log("game-translation-guard: ALL TESTS PASS");
process.exit(0);
