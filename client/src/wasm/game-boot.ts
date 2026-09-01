/**
 * Boot the QED64 wasm64 Lean runtime for a lean4game game, entirely in-tab.
 *
 * Replaces the relay + `lake serve` process pair: the QED64 worker hosts the
 * stock Lean FileWorker (with the GameServer library resident via the game
 * snapshot), the QED64 watchdog shim supervises it, and GameTranslation
 * reproduces the relay's message rewriting in front of the shim.
 *
 * The whole substrate comes from the qed64 repo (npm file: dependency —
 * single source of truth, no vendored copies):
 *  - artifacts/profiles/snapshot machinery: qed64/frontend/src/qed64-boot
 *  - session supervision + LSP pump:        qed64/frontend/src/watchdog-shim
 *  - the worker itself:                     /workers/lean.worker.js (static)
 *
 * Game-specific responsibilities here:
 *  1. load the game snapshot (covering-env serves every level header from it,
 *     so no olean packs are needed for the game modules at runtime);
 *  2. place `.lake/gamedata/*.json` into the worker FS — GameServer's Runner
 *     reads level data from the cwd at proof-check time;
 *  3. re-do both on every worker reboot (the shim's crash recovery calls
 *     makeSession again).
 */
import {
  installArtifacts,
  loadSnapshotByName,
  newSession,
  type Qed64Artifacts,
  type Qed64Session,
  type StatusSink,
} from "qed64/frontend/src/qed64-boot";
import { WatchdogShim } from "qed64/frontend/src/watchdog-shim";
import { getDefaultStore } from "jotai";
import { difficultyAtom, progressAtom } from "../store/progress-atoms";
import { GameTranslation, type GameLevelData } from "./game-translation";
import { publishBootStatus } from "../store/boot-atoms";

export interface GameDataBundle {
  gameName: string;
  /** `${worldId}/${levelId}` → parsed level__{w}__{l}.json */
  levels: Map<string, GameLevelData & Record<string, unknown>>;
  /** raw JSON files to place into the worker FS (path under .lake/gamedata) */
  rawFiles: { name: string; text: string }[];
}

/** The game bound to this page load, parsed from the SPA route
 * (#/g/{owner}/{repo}/...). One wasm session hosts one game environment —
 * every game package is rooted at `Game`, so their snapshots share an env
 * cache key and cannot coexist in a worker. Navigating to a DIFFERENT game
 * reloads the page (see the guard in bootGameRuntime). */
function currentGameId(): { gameId: string; snapshot: string } | null {
  const m = /#\/(g\/[^/]+\/[^/]+)/.exec(window.location.hash);
  if (!m) return null;
  const gameId = m[1];
  return { gameId, snapshot: gameId.split("/")[2].toLowerCase() };
}
/** Worker cwd is /workspace (lean.worker.js boots there); Runner reads
 * `./.lake/gamedata/...` relative to it. */
const WORKER_GAMEDATA_DIR = "/workspace/.lake/gamedata";

let boundGame: { gameId: string; snapshot: string } | null = null;

async function fetchJson(url: string): Promise<any> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
  return r.json();
}

export async function fetchGameData(): Promise<GameDataBundle> {
  const base = `/data/${boundGame!.gameId}`;
  const game = await fetchJson(`${base}/game.json`);
  const rawFiles: { name: string; text: string }[] = [
    { name: "game.json", text: JSON.stringify(game) },
  ];
  const levels = new Map<string, GameLevelData & Record<string, unknown>>();
  // game.json's worldSize is a flat { [worldId]: levelCount } map.
  const worldSize: Record<string, number> = game.worldSize ?? {};
  await Promise.all(
    Object.keys(worldSize).flatMap((w) => {
      const size = worldSize[w] ?? 0;
      return Array.from({ length: size }, (_, i) => i + 1).map(async (l) => {
        const data = await fetchJson(`/data/${boundGame!.gameId}/level__${w}__${l}.json`);
        levels.set(`${w}/${l}`, data);
        rawFiles.push({ name: `level__${w}__${l}.json`, text: JSON.stringify(data) });
      });
    }),
  );
  return { gameName: game.name, levels, rawFiles };
}

async function writeGamedataToWorker(qs: Qed64Session, bundle: GameDataBundle): Promise<void> {
  const files = bundle.rawFiles.map((f) => ({
    path: `${WORKER_GAMEDATA_DIR}/${f.name}`,
    text: f.text,
  }));
  await (qs.session as unknown as {
    request(type: string, payload: Record<string, unknown>): Promise<unknown>;
  }).request("write-files", { input: { files } });
}

export interface GameRuntime {
  translation: GameTranslation;
  shim: WatchdogShim;
  bundle: GameDataBundle;
}

let bootPromise: Promise<GameRuntime> | null = null;
let translationSingleton: GameTranslation | null = null;

/** The LSP MessagePort for the editor — available synchronously; traffic is
 * buffered until the wasm side finishes booting. */
export function gameLspPort(): MessagePort {
  ensureTranslation();
  return translationSingleton!.clientPort;
}

let bundlePromise: Promise<GameDataBundle> | null = null;
function ensureBundle(): Promise<GameDataBundle> {
  bundlePromise ??= fetchGameData();
  return bundlePromise;
}

function ensureTranslation(): GameTranslation {
  translationSingleton ??= new GameTranslation({
    gameName: "", // patched once game.json arrives (see bootGameRuntime)
    levelData: () => undefined,
  });
  return translationSingleton;
}


/** Post-boot, routine checker chatter (per-edit elaboration, import probes)
 * must not resurrect the boot banner — only real boot/restart stages do. */
const ROUTINE_BUSY = /elaborating|checking the new imports|imports changed/i;
let bootFinishedOnce = false;

const consoleSink: StatusSink = {
  busy: (label) => {
    console.info(`[game-boot] ⏳ ${label}`);
    if (!bootFinishedOnce || !ROUTINE_BUSY.test(label)) {
      publishBootStatus({ state: "busy", label });
    }
  },
  progress: (label, info) => {
    console.debug(`[game-boot] … ${label}`, info ?? "");
    if (!bootFinishedOnce || !ROUTINE_BUSY.test(label)) {
      publishBootStatus({ state: "busy", label, loaded: info?.loaded, total: info?.total, unit: info?.unit });
    }
  },
  idle: (label) => {
    console.info(`[game-boot] ✔ ${label}`);
    publishBootStatus({ state: "ready", label });
  },
};

export function bootGameRuntime(ui: StatusSink = consoleSink): Promise<GameRuntime> {
  const here = currentGameId();
  if (here && boundGame && boundGame.gameId !== here.gameId) {
    // The wasm session is bound to another game's environment; a clean
    // reload rebinds everything (snapshots reload from OPFS in seconds).
    console.warn(`[game-boot] switching game ${boundGame.gameId} → ${here.gameId}: reloading`);
    window.location.reload();
  }
  if (!bootPromise && !here) {
    // Landing page: defer binding until a game route is visited.
    return new Promise<GameRuntime>(() => {});
  }
  boundGame ??= here;
  bootPromise ??= (async () => {
    const translation = ensureTranslation();
    const bundle = await ensureBundle();
    const store = getDefaultStore();
    translation.configure({
      gameName: bundle.gameName,
      levelData: (w, l) => bundle.levels.get(`${w}/${l}`),
      difficulty: () => store.get(difficultyAtom),
      inventory: () => store.get(progressAtom)?.inventory ?? [],
    });

    const artifacts: Qed64Artifacts = await installArtifacts(ui);

    // makeSession is also the shim's crash-recovery path: everything a fresh
    // worker needs (snapshot + gamedata files) happens inside it.
    let shimRef: WatchdogShim | null = null;
    const makeSession = async (): Promise<Qed64Session> => {
      const qs = await newSession(artifacts, ui, () => void shimRef?.handleWorkerDeath(), {});
      await loadSnapshotByName(artifacts, qs, boundGame!.snapshot, ui);
      await writeGamedataToWorker(qs, bundle);
      return qs;
    };

    const qs = await makeSession();
    const shim: WatchdogShim = new WatchdogShim(artifacts, qs, ui, makeSession, {
      // Every level header (import {level module} import GameServer.Runner)
      // is covered by the game snapshot's baked environment — no packs, no
      // file imports, no warm compile.
      coveringSnapshotFor: (header) =>
        /^\s*import\s+(Game\b|Game\.|GameServer)/m.test(header) ? boundGame!.snapshot : null,
    });
    shimRef = shim;
    translation.attachServer(shim.clientPort);
    ui.idle("Lean ready");
    // Test hooks and status displays key off this.
    (globalThis as { qed64GameReady?: boolean }).qed64GameReady = true;
    bootFinishedOnce = true;
    return { translation, shim, bundle };
  })();
  return bootPromise;
}
