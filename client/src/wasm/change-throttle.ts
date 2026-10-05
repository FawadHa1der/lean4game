/**
 * The editor-mode crash (found during SEC1, characterised on 4083fb4 and
 * again under the qed64 package): select-all + Backspace, then a line typed
 * fast, and the TAB died — Chromium "V8 javascript OOM" with ~50–80 MB of
 * page heap. Not a session replacement: one runtime, no reboot, the header
 * unchanged. Every full-text didChange starts a fresh elaboration of the
 * whole Runner command while the threads of the abandoned ones still run
 * (Lean's cancellation is cooperative), so a burst — 9 didChanges in 230 ms
 * at 10 ms a character; the language client sends one before each of its
 * per-keystroke requests — keeps more Lean threads alive at once than the
 * runtime's 24-worker pthread pool holds. Emscripten then creates a new
 * worker for each, never returns one (the pool only grows), and each is
 * another ~130 MiB isolate in the renderer's one 4 GiB V8 cage: at ~35–40
 * isolates the cage is full and V8 aborts the renderer (qed64 HARDENING #55,
 * its open item). One change replacing the whole text stayed inside the
 * pool, and so did two header changes 150 ms apart.
 *
 * So the page hands the checker at most one full-text change per window:
 *  - a change with none sent in the last `ms` goes at once (typewriter mode
 *    sends one per Execute: no added latency);
 *  - a later one is held until the window ends, and a newer change replaces
 *    the held one (the worker owns whole documents — change = 1 — so the
 *    newest text is all it needs);
 *  - everything the client sends while a change is held is queued behind it,
 *    in order, so no request reaches the checker before the text the client
 *    already shows (a request queued behind a replaced change is answered
 *    against the newer text — the one the client's view has by then);
 *  - a document switch (didOpen / didClose) or an incremental change (never
 *    sent to the resident worker, which syncs whole documents) sends the held
 *    change first, then itself: a held change never crosses a document.
 * Pure (an injected clock): unit-tested by change-throttle.test.ts.
 */
export type JsonRpcLike = { jsonrpc?: string; id?: number | string; method?: string; params?: any };

export interface ThrottleClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

/** One full-text change per this many ms (the 10 ms-a-character burst that
 * crashed sends two: its first keystroke and its last text). */
export const CHANGE_THROTTLE_MS = 300;

const DEFAULT_CLOCK: ThrottleClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** A didChange whose every change carries the whole text (no `range`). */
export const isFullTextChange = (m: JsonRpcLike): boolean =>
  m.method === "textDocument/didChange" && Array.isArray(m.params?.contentChanges) && m.params.contentChanges.length > 0
  && m.params.contentChanges.every((c: { text?: unknown; range?: unknown } | null) => typeof c?.text === "string" && c.range === undefined);

export class ChangeThrottle {
  private held: JsonRpcLike | null = null;
  private queue: JsonRpcLike[] = [];
  private lastChange = Number.NEGATIVE_INFINITY;
  private timer: unknown = null;
  private readonly send: (m: JsonRpcLike) => void;
  private readonly ms: number;
  private readonly clock: ThrottleClock;

  // Plain fields, not parameter properties: Node's type-stripping test
  // runner refuses those (ts-resolve-hook.mjs).
  constructor(send: (m: JsonRpcLike) => void, ms: number = CHANGE_THROTTLE_MS, clock: ThrottleClock = DEFAULT_CLOCK) {
    this.send = send;
    this.ms = ms;
    this.clock = clock;
  }

  /** A translated client message on its way to the checker. */
  push(m: JsonRpcLike): void {
    if (isFullTextChange(m)) {
      if (this.held) { this.held = m; return; }
      const wait = this.lastChange + this.ms - this.clock.now();
      if (wait <= 0) { this.lastChange = this.clock.now(); this.send(m); return; }
      this.held = m;
      this.timer = this.clock.setTimeout(() => { this.timer = null; this.flush(); }, wait);
      return;
    }
    if (m.method === "textDocument/didOpen" || m.method === "textDocument/didClose" || m.method === "textDocument/didChange") {
      this.flush();
      // An open (or an incremental change) starts an elaboration too: the
      // next full-text change waits out the window after it.
      if (m.method !== "textDocument/didClose") this.lastChange = this.clock.now();
      this.send(m);
      return;
    }
    if (this.held) { this.queue.push(m); return; }
    this.send(m);
  }

  /** Send the held change (and what queued behind it) now. */
  flush(): void {
    if (this.timer !== null) { this.clock.clearTimeout(this.timer); this.timer = null; }
    const held = this.held;
    if (!held) return;
    const queued = this.queue;
    this.held = null;
    this.queue = [];
    this.lastChange = this.clock.now();
    this.send(held);
    for (const m of queued) this.send(m);
  }
}
