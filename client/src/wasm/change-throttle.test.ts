// Run: node --import ./client/src/wasm/ts-resolve-hook.mjs client/src/wasm/change-throttle.test.ts
// The editor-mode crash (change-throttle.ts): the live burst — select-all,
// Backspace, then `rw [add_zero]` typed at 10 ms a character, the language
// client sending a request after each keystroke — reached the checker as 9
// full-text didChanges in 230 ms, each a fresh elaboration of the whole
// Runner command while the abandoned ones' threads still ran; the runtime's
// pthread pool grew past its 24 workers into the V8 cage's limit and the tab
// died. The throttle hands the checker one full-text change per window: the
// first at once, the newest at the window's end, and nothing the client sent
// after a held change overtakes it. A fake clock.
import assert from "node:assert/strict";
import { CHANGE_THROTTLE_MS, ChangeThrottle, isFullTextChange, type JsonRpcLike } from "./change-throttle";

let now = 0;
let nextId = 1;
const timers = new Map<number, { at: number; fn: () => void }>();
const clock = {
  now: () => now,
  setTimeout: (fn: () => void, ms: number) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
  clearTimeout: (id: unknown) => { timers.delete(id as number); },
};
function advance(ms: number): void {
  const end = now + ms;
  for (;;) {
    let due: [number, { at: number; fn: () => void }] | null = null;
    for (const e of timers) if (e[1].at <= end && (due === null || e[1].at < due[1].at)) due = e;
    if (!due) break;
    timers.delete(due[0]);
    now = due[1].at;
    due[1].fn();
  }
  now = end;
}
const change = (version: number, text: string): JsonRpcLike =>
  ({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: "file:///game/Metadata.lean", version }, contentChanges: [{ text }] } });
const request = (id: number, method = "$/lean/rpc/call"): JsonRpcLike => ({ jsonrpc: "2.0", id, method, params: {} });
const open = (version: number): JsonRpcLike => ({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: "file:///game/Metadata.lean", languageId: "lean4", version, text: "" } } });
const shape = (m: JsonRpcLike) => m.method === "textDocument/didChange" ? `change v${m.params.textDocument.version}` : m.method === "textDocument/didOpen" ? `open v${m.params.textDocument.version}` : `${m.method} #${m.id ?? "-"}`;

let failures = 0;
function test(name: string, body: () => void): void {
  now = 0; timers.clear();
  try { body(); console.log(`ok - ${name}`); } catch (e) { failures++; console.log(`not ok - ${name}\n  ${String((e as Error)?.stack ?? e).split("\n").slice(0, 4).join("\n  ")}`); }
}

assert.equal(CHANGE_THROTTLE_MS, 300);

test("the live burst: 13 keystrokes at 10 ms, a request after each — the checker gets the first change at once and the last text at the window's end: two elaborations, not thirteen", () => {
  const sent: JsonRpcLike[] = [];
  const t = new ChangeThrottle((m) => sent.push(m), CHANGE_THROTTLE_MS, clock);
  advance(10_000); // the level has been open for a while
  const line = "rw [add_zero]";
  for (let i = 1; i <= line.length; i++) {
    t.push(change(i + 1, `${line.slice(0, i)}\n`));
    t.push(request(100 + i));
    advance(10);
  }
  assert.deepEqual(sent.map(shape), ["change v2", "$/lean/rpc/call #101"], "only the first keystroke went at once");
  advance(CHANGE_THROTTLE_MS);
  const changes = sent.filter(isFullTextChange);
  assert.equal(changes.length, 2);
  assert.equal(changes[1]!.params.contentChanges[0].text, "rw [add_zero]\n", "the newest text, whole");
  assert.deepEqual(sent.slice(2).map(shape), ["change v14", ...Array.from({ length: 12 }, (_, i) => `$/lean/rpc/call #${102 + i}`)], "every request after the text it was asked about, in order");
  assert.equal(timers.size, 0);
});

test("one change after a quiet window goes at once (typewriter mode: one per Execute, no latency)", () => {
  const sent: JsonRpcLike[] = [];
  const t = new ChangeThrottle((m) => sent.push(m), CHANGE_THROTTLE_MS, clock);
  t.push(change(2, "rfl\n"));
  advance(5_000);
  t.push(change(3, "rfl\nrfl\n"));
  t.push(request(7));
  assert.deepEqual(sent.map(shape), ["change v2", "change v3", "$/lean/rpc/call #7"]);
  assert.equal(timers.size, 0, "nothing held, no timer");
});

test("slow typing: at most one change per window — each held change is the newest when it goes", () => {
  const sent: JsonRpcLike[] = [];
  const at: number[] = [];
  const t = new ChangeThrottle((m) => { sent.push(m); at.push(now); }, CHANGE_THROTTLE_MS, clock);
  advance(1_000);
  for (let i = 0; i < 20; i++) { t.push(change(i + 2, "x".repeat(i + 1))); advance(150); } // 150 ms a character for 3 s
  advance(CHANGE_THROTTLE_MS);
  for (let i = 1; i < at.length; i++) assert.ok(at[i]! - at[i - 1]! >= CHANGE_THROTTLE_MS, `${at[i]! - at[i - 1]!} ms between two changes`);
  assert.ok(sent.length <= 11 && sent.length >= 9, `${sent.length} changes for 20 keystrokes`);
  assert.equal(sent[sent.length - 1]!.params.contentChanges[0].text, "x".repeat(20), "the last text arrives");
});

test("a document switch sends the held change first, then itself; it never crosses documents, and the next change waits out its window", () => {
  const sent: JsonRpcLike[] = [];
  const t = new ChangeThrottle((m) => sent.push(m), CHANGE_THROTTLE_MS, clock);
  t.push(change(2, "a"));
  t.push(change(3, "ab"));
  t.push(request(1));
  t.push({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri: "file:///game/Metadata.lean" } } });
  t.push(open(1));
  assert.deepEqual(sent.map(shape), ["change v2", "change v3", "$/lean/rpc/call #1", "textDocument/didClose #-", "open v1"]);
  assert.equal(timers.size, 0, "the flush cleared the window's timer");
  t.push(change(2, "c"));
  assert.equal(sent.length, 5, "an open starts an elaboration too: held");
  advance(CHANGE_THROTTLE_MS);
  assert.deepEqual(sent.slice(5).map(shape), ["change v2"]);
  // Also with nothing held: a level opened after a quiet minute, typed into at once.
  advance(60_000);
  t.push(open(1));
  t.push(change(2, "r"));
  assert.deepEqual(sent.slice(6).map(shape), ["open v1"], "the first keystroke after an open waits out the open's window");
  advance(CHANGE_THROTTLE_MS);
  assert.deepEqual(sent.slice(6).map(shape), ["open v1", "change v2"]);
});

test("an incremental change is never coalesced (it applies to the text before it): the held change goes first", () => {
  const sent: JsonRpcLike[] = [];
  const t = new ChangeThrottle((m) => sent.push(m), CHANGE_THROTTLE_MS, clock);
  t.push(change(2, "a"));
  t.push(change(3, "ab"));
  const ranged = { jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: "u", version: 4 }, contentChanges: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, text: "x" }] } };
  assert.equal(isFullTextChange(ranged), false);
  t.push(ranged);
  assert.deepEqual(sent.map((m) => m.params.textDocument.version), [2, 3, 4]);
});

test("flush() sends what is held now (a game switch suspends the translation) and is a no-op with nothing held; 0 ms is no throttle", () => {
  const sent: JsonRpcLike[] = [];
  const t = new ChangeThrottle((m) => sent.push(m), CHANGE_THROTTLE_MS, clock);
  t.flush();
  assert.equal(sent.length, 0);
  t.push(change(2, "a"));
  t.push(change(3, "ab"));
  t.push(request(9, "textDocument/codeAction"));
  t.flush();
  assert.deepEqual(sent.map(shape), ["change v2", "change v3", "textDocument/codeAction #9"]);
  assert.equal(timers.size, 0);
  const none: JsonRpcLike[] = [];
  const off = new ChangeThrottle((m) => none.push(m), 0, clock);
  for (let i = 0; i < 5; i++) off.push(change(i + 2, `${i}`));
  assert.equal(none.length, 5);
});

if (failures) { console.log(`change-throttle: ${failures} FAILED`); process.exit(1); }
console.log("change-throttle: ALL TESTS PASS");
