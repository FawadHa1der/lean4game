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
 *  - didOpen of the level uri (level-uri.ts): rewrite the text to
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
      if (this.serverPort) this.serverPort.postMessage(this.toServer(e.data as JsonRpc));
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
    serverPort.onmessage = (e) => this.innerSide.postMessage(this.toClient(e.data as JsonRpc));
    serverPort.start?.();
    for (const m of this.pendingToServer) serverPort.postMessage(this.toServer(m));
    this.pendingToServer = [];
  }

  /** relay: client → server rewrites. */
  private toServer(message: JsonRpc): JsonRpc {
    if (message.method === "initialize") {
      this.difficulty = message.params?.initializationOptions?.difficulty;
      this.inventory = message.params?.initializationOptions?.inventory;
      // We abuse the rootUri field to pass the game name to the server.
      if (message.params) message.params.rootUri = this.config.gameName;
    }

    if (message.method === "textDocument/semanticTokens/full" && message.id !== undefined) {
      this.semanticTokenRequestIds.add(message.id);
    }

    if (message.method === "textDocument/didOpen") {
      const { worldId, levelId } = parseLevelUri(message.params.textDocument.uri);
      this.worldId = worldId;
      this.levelId = levelId;

      replaceUri(message, this.workerUri);

      const levelData = this.config.levelData(this.worldId, this.levelId);
      if (!levelData) {
        console.error(`[game-translation] missing level data for ${this.worldId}/${this.levelId}`);
      }
      // Freshest wins: live provider > initialize-time capture > default.
      this.difficulty = this.config.difficulty?.() ?? this.difficulty ?? 1;
      this.inventory = this.config.inventory?.() ?? this.inventory ?? [];

      const content = message.params.textDocument.text;
      message.params.textDocument.text =
        `import ${levelData?.module} import GameServer.Runner \nRunner ` +
        `${JSON.stringify(this.config.gameName)} ${JSON.stringify(this.worldId)} ${this.levelId} ` +
        `(difficulty := ${this.difficulty}) ` +
        `(inventory := [${(this.inventory ?? []).map((s) => JSON.stringify(s)).join(",")}]) ` +
        `:= by\n${content}\n`;
    } else {
      replaceUri(message, this.workerUri);
    }

    shiftLines(message, +PROOF_START_LINE);
    return message;
  }

  /** Optional sink for the document's processing state (see boot-atoms). */
  onProcessing: ((processing: boolean) => void) | null = null;

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
