/**
 * Browser port of the relay's message translation layer
 * (relay/src/serverProcess.ts::messageTranslation, upstream lean4game).
 *
 * In stock lean4game the client speaks LSP over a websocket to a node relay,
 * which rewrites every message before handing it to a stock `lake serve`
 * process inside the game directory. In the wasm64 build there is no relay
 * and no process: the editor's LSP client talks over a MessagePort to the
 * QED64 watchdog shim in front of the in-tab wasm worker. This class is the
 * relay's rewriting, verbatim, as a MessagePort middleman:
 *
 *   lean4monaco client ⟷ [GameTranslation] ⟷ WatchdogShim.clientPort ⟷ worker
 *
 * Client→server:
 *  - initialize: capture difficulty/inventory from initializationOptions and
 *    smuggle the game name through rootUri (the GameServer library reads it
 *    back out of rc.initParams.rootUri? — upstream's own hack, preserved).
 *  - didOpen of the level uri (level-uri.ts) — and every FULL-text didChange
 *    (the resident front door syncs whole documents): rewrite the text to
 *      import {level module} import GameServer.Runner \n
 *      Runner "{game}" "{world}" {level} (difficulty := d) (inventory := [..]) := by\n
 *      {player text}\n
 *    so player content starts at line 2 (PROOF_START_LINE), and point every
 *    uri at the single constant worker document.
 *  - all positions shifted +2 lines; server→client shifted −2, uris mapped
 *    back, range semanticTokens disabled, full semanticTokens rebased.
 */
import { levelUri, parseLevelUri } from "./level-uri";

type JsonRpc = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
};

export interface GameLevelData {
  module: string;
}

export interface GameTranslationConfig {
  /** game.json's `name` field — the Runner's game id. */
  gameName: string;
  /** `${worldId}/${levelId}` → level data (from level__{w}__{l}.json). */
  levelData: (worldId: string, levelId: string) => GameLevelData | undefined;
  /** The uri the worker sees for every level document. */
  workerUri?: string;
  /** Live providers, read at didOpen time (the player's difficulty and
   * unlocked inventory move as they play; initialize-time capture — the
   * relay's approach — goes stale and forces reconnects upstream). */
  difficulty?: () => number;
  inventory?: () => string[];
}

export const PROOF_START_LINE = 2;
/** L6: the error a request about an unknown level's document is answered
 * with (goals.tsx reads it: not a crash, not retried). */
export const UNKNOWN_LEVEL_ERROR = "this level does not exist in the loaded game";
const DEFAULT_WORKER_URI = "file:///game/Metadata.lean";

function shift(line: number, offset: number): number {
  return Math.max(0, line + offset);
}

/** Deep in-place line shifting — exact port of the relay's shiftLines. */
export function shiftLines(p: any, offset: number): any {
  if (p !== null && typeof p === "object") {
    if (Object.prototype.hasOwnProperty.call(p, "line") && typeof p.line === "number") {
      p.line = shift(p.line, offset);
    }
    if (Object.prototype.hasOwnProperty.call(p, "lineRange") && p.lineRange) {
      p.lineRange.start = shift(p.lineRange.start, offset);
      p.lineRange.end = shift(p.lineRange.end, offset);
    }
    for (const key in p) {
      if (typeof p[key] === "object" && p[key] !== null) {
        p[key] = shiftLines(p[key], offset);
      }
    }
  }
  return p;
}

export function replaceUri(obj: any, val: string): any {
  if (obj !== null && typeof obj === "object") {
    for (const key in obj) {
      if (key === "uri") {
        obj[key] = val;
      } else if (typeof obj[key] === "object" && obj[key] !== null) {
        replaceUri(obj[key], val);
      }
    }
  }
  return obj;
}

/** Rebase a full-semantic-tokens data array past the Runner header lines. */
export function rebaseSemanticTokens(data: number[]): number[] {
  let i = 0;
  let line = 0;
  while (i < data.length) {
    line += data[i]; // line info is a delta
    if (line >= PROOF_START_LINE) {
      const newData = data.slice(i);
      newData[0] = line - PROOF_START_LINE;
      return newData;
    }
    i += 5;
  }
  return [];
}

export class GameTranslation {
  /** Hand this to the editor's LSP client (WorkerDirect messagePort). */
  readonly clientPort: MessagePort;
  private readonly innerSide: MessagePort;

  private difficulty: number | undefined;
  private inventory: string[] | undefined;
  private worldId = "";
  private levelId = "";
  /** The level's Lean module (from level data), captured at didOpen. */
  private module = "";
  private readonly semanticTokenRequestIds = new Set<number | string>();
  private readonly workerUri: string;

  private config: GameTranslationConfig;
  private serverPort: MessagePort | null = null;
  /** Client traffic that arrived before the wasm side finished booting. */
  private pendingToServer: JsonRpc[] = [];

  constructor(config: GameTranslationConfig) {
    this.config = config;
    this.workerUri = config.workerUri ?? DEFAULT_WORKER_URI;
    const channel = new MessageChannel();
    this.clientPort = channel.port2;
    this.innerSide = channel.port1;
    this.innerSide.onmessage = (e) => {
      // Buffer RAW and translate at send time: early client traffic (the
      // editor's didOpen fires before game.json has even been fetched) must
      // be rewritten with the real level data, which only exists once the
      // boot has progressed. Translation is stateful and order-dependent, so
      // it runs exactly once per message, in order, at flush.
      // L14: a game switch is about to reload the page — nothing reaches the
      // checker. Kept RAW, not dropped: the switch is cancellable (resume()).
      // Requests beyond a bound are not kept (the pane retries every few
      // seconds through a wait that can last minutes); notifications always.
      if (this.suspended) {
        const m = e.data as JsonRpc;
        if (m.id === undefined || this.pendingToServer.length < 256) this.pendingToServer.push(m);
        return;
      }
      if (this.serverPort) this.forward(e.data as JsonRpc);
      else this.pendingToServer.push(e.data as JsonRpc);
    };
    this.innerSide.start?.();
  }

  /** Late-bind config once game.json has been fetched (the port must exist
   * synchronously, before any network round trip). */
  configure(partial: Partial<GameTranslationConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  /** Attach the wasm side (WatchdogShim.clientPort) once it has booted; the
   * editor's LSP client may already be talking — buffered traffic replays
   * in order. */
  attachServer(serverPort: MessagePort): void {
    this.serverPort = serverPort;
    serverPort.onmessage = (e) => { if (!this.suspended) this.innerSide.postMessage(this.toClient(e.data as JsonRpc)); };
    serverPort.start?.();
    for (const m of this.pendingToServer) this.forward(m);
    this.pendingToServer = [];
  }

  /** L14: the page is about to reload into ANOTHER game (game-boot's switch
   * branch). From this instant the outgoing game's session must see nothing:
   * React already mounts the new game's level, and its didOpen — wrapped
   * with this game's (missing) level data — reached the old checker, which
   * answered "No RPC method 'Game.getProofState'" until the reload. Client
   * traffic is held back untranslated, server traffic is no longer relayed. */
  suspend(): void {
    this.suspended = true;
    // Before the server attached the buffer already holds the boot's early
    // traffic (initialize, …) — that must survive a resume.
    if (this.serverPort) this.pendingToServer = [];
  }

  /** L14: the switch was cancelled (the player went back to the bound game
   * while the reload waited for running prepares). The held traffic flushes
   * in order: the other game's didOpen is caught by the L6 unknown-level
   * defence (warned, never forwarded, its requests answered locally) and the
   * bound game's didOpen that follows clears it. */
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    if (!this.serverPort) return; // attachServer flushes
    const queued = this.pendingToServer;
    this.pendingToServer = [];
    // Requests held from BEFORE the last didOpen belong to a document that
    // has been superseded (the other game's level, or this game's previous
    // one). Their issuers are unmounted; they are dropped UNANSWERED, as they
    // were before the switch became cancellable — the language client logs
    // every error answer (-32602 and -32800 alike) as a console error.
    let lastOpen = -1;
    queued.forEach((m, i) => { if (m.method === "textDocument/didOpen") lastOpen = i; });
    queued.forEach((m, i) => {
      const aboutDoc = m.params?.textDocument?.uri !== undefined || m.params?.uri !== undefined;
      if (i < lastOpen && m.id !== undefined && m.method !== undefined && aboutDoc) {
        return;
      }
      this.resuming = true;
      try { this.forward(m); } finally { this.resuming = false; }
    });
  }
  /** Set while resume() flushes: the other game's document requests that
   * follow its (unforwarded) didOpen are dropped unanswered too. */
  private resuming = false;
  private suspended = false;

  /** L6: set by a didOpen for a level the loaded game has no data for; the
   * next didOpen of a known level clears it. While set, nothing about that
   * document reaches the checker (see toServer). */
  private unknownLevel = false;

  /** Translate and send — unless the translation swallowed the message (L6:
   * a document of a level this game does not contain is never forwarded). */
  private forward(message: JsonRpc): void {
    const out = this.toServer(message);
    if (out && !this.suspended) this.serverPort!.postMessage(out);
  }

  /** relay: client → server rewrites. Returns null for a message that must
   * not reach the checker (L6: the document of an unknown level). */
  private toServer(message: JsonRpc): JsonRpc | null {
    if (message.method === "initialize") {
      this.difficulty = message.params?.initializationOptions?.difficulty;
      this.inventory = message.params?.initializationOptions?.inventory;
      // We abuse the rootUri field to pass the game name to the server.
      if (message.params) message.params.rootUri = this.config.gameName;
    }

    if (message.method === "textDocument/semanticTokens/full" && message.id !== undefined) {
      this.semanticTokenRequestIds.add(message.id);
    }

    // A full-text didChange for a level OTHER than the one opened last is a
    // document switch the editor never announced: returning to a level whose
    // Monaco model still exists (its first visit created it) sends no
    // didOpen, only a didChange of that uri with the saved text. Wrapping it
    // with the previous level's header handed the worker "Addition/1's
    // command := by <Tutorial/1's proof>" (a tactic judged against the wrong
    // goal, then a whole session on the wrong level). The worker holds one
    // document, so this becomes the re-open it is — the front door rebases
    // the version continuing the worker's sequence, which a plain didChange
    // could not survive if the returning model's version is behind.
    if (message.method === "textDocument/didChange" && message.params?.textDocument?.uri) {
      const here = parseLevelUri(message.params.textDocument.uri);
      const c = message.params.contentChanges?.[0];
      if ((here.worldId !== this.worldId || here.levelId !== this.levelId) && c && typeof c.text === "string" && c.range === undefined) {
        message = {
          ...message,
          method: "textDocument/didOpen",
          params: { textDocument: { uri: message.params.textDocument.uri, languageId: "lean4", version: message.params.textDocument.version, text: c.text } },
        };
      }
    }

    if (message.method === "textDocument/didOpen") {
      const { worldId, levelId } = parseLevelUri(message.params.textDocument.uri);
      this.worldId = worldId;
      this.levelId = levelId;

      replaceUri(message, this.workerUri);

      const levelData = this.config.levelData(this.worldId, this.levelId);
      if (!levelData) {
        // L6: wrapping with module "" produced `import  import GameServer.Runner`
        // — a parser error at 0:6 the pane blamed on the player's proof, and a
        // headerRefused session without `Game.getProofState`. The level does
        // not exist in this game (a hand-edited or stale URL; the route guard
        // in level.tsx normally never mounts an editor for it): forward
        // nothing. A warning, not an error — a game switch (L14) is suspended
        // before it gets here, so this line now only means a bad route.
        console.warn(`[game-translation] no level data for ${this.worldId}/${this.levelId} — the document is not forwarded`);
        this.unknownLevel = true;
        return null;
      }
      this.unknownLevel = false;
      // Freshest wins: live provider > initialize-time capture > default.
      this.difficulty = this.config.difficulty?.() ?? this.difficulty ?? 1;
      this.inventory = this.config.inventory?.() ?? this.inventory ?? [];

      this.module = levelData?.module ?? "";
      message.params.textDocument.text = this.wrapDocument(message.params.textDocument.text);
      this.onDidOpen?.(message);
    } else if (this.unknownLevel && (message.params?.textDocument?.uri !== undefined || message.params?.uri !== undefined)) {
      // L6: document traffic for the unknown level — notifications are
      // dropped, requests answered here (the checker holds no such document;
      // an rpc call would log "No RPC method" once per pane retry).
      if (message.id !== undefined && message.method !== undefined) {
        if (!this.resuming) this.innerSide.postMessage({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `${UNKNOWN_LEVEL_ERROR}: ${this.worldId}/${this.levelId}` } });
      }
      return null;
    } else if (message.method === "textDocument/didChange") {
      // The resident front door declares FULL-text sync (change = 1), so the
      // editor sends the whole player text on every edit; forwarding it as-is
      // would replace the worker's document with untranslated text (no import
      // line, no Runner command) on the first keystroke. Wrap it exactly like
      // the didOpen; a ranged change (incremental sync) is only line-shifted.
      replaceUri(message, this.workerUri);
      for (const c of message.params?.contentChanges ?? []) {
        if (c && typeof c.text === "string" && c.range === undefined) c.text = this.wrapDocument(c.text);
      }
    } else {
      replaceUri(message, this.workerUri);
    }

    shiftLines(message, +PROOF_START_LINE);
    return message;
  }

  /** The worker document for the player's text: the level's import line,
   * GameServer.Runner, and the Runner command whose proof block is the text
   * (PROOF_START_LINE lines above it). Used for didOpen and for every
   * full-text didChange, so the worker never sees the bare player text. */
  private wrapDocument(content: string): string {
    return (
      `import ${this.module} import GameServer.Runner \nRunner ` +
      `${JSON.stringify(this.config.gameName)} ${JSON.stringify(this.worldId)} ${this.levelId} ` +
      `(difficulty := ${this.difficulty}) ` +
      `(inventory := [${(this.inventory ?? []).map((s) => JSON.stringify(s)).join(",")}]) ` +
      `:= by\n${content}\n`
    );
  }

  /** Optional sink for the document's processing state (see boot-atoms). */
  onProcessing: ((processing: boolean) => void) | null = null;
  /** Fired with the TRANSLATED didOpen (a level switch): the host re-arms a
   * halted relay from it, since the relay only leaves `halted` on a change. */
  onDidOpen: ((translated: JsonRpc) => void) | null = null;

  /** relay: server → client rewrites. */
  private toClient(message: JsonRpc): JsonRpc {
    if (message.method === "$/lean/fileProgress" && this.onProcessing) {
      // A kind-2 entry (LeanFileProgressKind.fatalError — a refused or
      // unresolvable header) is a verdict, not work in flight: it never
      // drains, so counting it would pin "processing" for good (qed64
      // HARDENING #46; the vendored shim applies the same reading).
      const ranges = message.params?.processing;
      this.onProcessing(Array.isArray(ranges) && ranges.some((r: { kind?: number } | null) => r?.kind !== 2));
    }
    shiftLines(message, -PROOF_START_LINE);
    replaceUri(message, levelUri(this.worldId, this.levelId));

    // Range semantic tokens are difficult to shift — disable the capability.
    if (message?.result?.capabilities?.semanticTokensProvider?.range) {
      message.result.capabilities.semanticTokensProvider.range = false;
    }

    if (message.id !== undefined && this.semanticTokenRequestIds.delete(message.id)) {
      if (Array.isArray(message.result?.data)) {
        message.result.data = rebaseSemanticTokens(message.result.data);
      }
    }

    return message;
  }
}
