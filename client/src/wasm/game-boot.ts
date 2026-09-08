/**
 * Boot the QED64 wasm64 Lean runtime for a lean4game game, entirely in-tab.
 *
 * Replaces the relay + `lake serve` process pair: the QED64 worker hosts the
 * stock Lean FileWorker (with the GameServer library resident via the game
 * snapshot), the QED64 L3 relay supervises the session, and GameTranslation
 * reproduces the relay's message rewriting in front of it.
 *
 * The substrate is the qed64 closure vendored at one commit
 * (client/src/wasm/vendor/qed64, scripts/sync-qed64.sh — no live dependency):
 *  - artifacts/profiles/snapshot machinery: qed64/frontend/src/qed64-boot
 *  - session adapter + boot policy:         qed64/frontend/src/resident-session
 *  - the relay (crash recovery, replay):    qed64/frontend/src/lsp-relay
 *  - the worker itself:                     /workers/lean.worker.js (+ lsp-frames.js,
 *                                           lsp-front-door.js, snapshot-prefetch.worker.js)
 *
 * Game-specific responsibilities here:
 *  1. the boot policy: the init snapshot and the game snapshot (its baked
 *     environment covers every level header — the kernel's resolver serves
 *     `import Game.Levels.X import GameServer.Runner` from it in-process, so
 *     a level switch is a document change, not a session replacement);
 *  2. place `.lake/gamedata/*.json` into the worker FS on EVERY session —
 *     GameServer's Runner reads level data from the cwd at proof-check time
 *     (GameSession.start, which the relay runs on each boot and reboot);
 *  3. map the relay's status to the page's atoms (banner, input gating,
 *     readiness, boot failure).
 */
import { installArtifacts, type Qed64Artifacts, type StatusSink } from "qed64/frontend/src/qed64-boot";
import { LspRelay, type RelayStatus, type RestartOptions } from "qed64/frontend/src/lsp-relay";
import { ResidentSession, type ResidentHost, type ResidentPolicy } from "qed64/frontend/src/resident-session";
import { getDefaultStore } from "jotai";
import { difficultyAtom, progressAtom } from "../store/progress-atoms";
import { GameTranslation, type GameLevelData } from "./game-translation";
import { publishBootStatus, publishCheckerActivity, publishDocumentProcessing } from "../store/boot-atoms";
import { rememberGamedata } from "./gamedata-cache";

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
  // Hash form `#/g/{owner}/{game}/…` (what the location atoms write) or the
  // path form `/{owner}/{game}/…` (the newer URLs the atoms also read).
  let gameId: string | null = null;
  const m = /#\/(g\/[^/]+\/[^/]+)/.exec(window.location.hash);
  if (m) gameId = m[1];
  else {
    const seg = window.location.pathname.split("/").filter(Boolean);
    if (seg.length >= 2) gameId = `g/${seg[0]}/${seg[1]}`;
  }
  if (!gameId) return null;
  return { gameId, snapshot: gameId.split("/")[2].toLowerCase() };
}
/** Worker cwd is /workspace (lean.worker.js boots there); Runner reads
 * `./.lake/gamedata/...` relative to it. */
const WORKER_GAMEDATA_DIR = "/workspace/.lake/gamedata";

let boundGame: { gameId: string; snapshot: string } | null = null;

async function fetchJson(url: string): Promise<any> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
  const json = await r.json();
  rememberGamedata(url, json); // the UI's offline fallback for level texts
  return json;
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

const MiB = 1048576;
const GiB = 1073741824;

/** The relay's session for this game: the resident adapter plus the gamedata
 * files GameServer reads at check time. `start()` is what the relay awaits
 * before it replays the document and arms the loop, so the files are in the
 * worker FS before the first elaboration — on the first boot and on every
 * crash reboot alike. `request` is LeanSession-private; this adapter is a
 * trusted peer the same way qed64's own memory meter is. */
class GameSession extends ResidentSession {
  constructor(host: ResidentHost, private readonly files: { path: string; text: string }[], opts: RestartOptions = {}) {
    super(host, opts);
  }
  async start(): Promise<void> {
    await super.start();
    await (this.lean as unknown as { request(type: string, payload: Record<string, unknown>): Promise<unknown> })
      .request("write-files", { input: { files: this.files } });
  }
}

/** The game's boot policy. Snapshots: the init environment, then the game's
 * baked environment (it covers every level header in-process). Memory: the
 * game snapshot's region is ~1.4 GB, committed up front (qed64 measured
 * nondeterministic renderer crashes when a shared Memory64 grows by
 * gigabytes in many steps while a snapshot streams in); the 3 GiB cap keeps
 * the reservation a dead-but-unreclaimed page holds across reloads small
 * (the reload-then-switch-storm renderer crash). */
function gamePolicy(snapshot: string): ResidentPolicy {
  return {
    snapshotsFor: () => ["init", snapshot],
    initialBytesFor: () => 2048 * MiB,
    maximumBytes: 3 * GiB,
  };
}

export interface GameRuntime {
  translation: GameTranslation;
  relay: LspRelay;
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
  // fileProgress → documentProcessingAtom: proof states fetched while the
  // document is still being processed are provisional (see settleProof).
  translationSingleton.onProcessing = publishDocumentProcessing;
  return translationSingleton;
}


/** Post-boot, routine checker chatter (per-edit elaboration, import probes)
 * must not resurrect the boot banner — only real boot/restart stages do. */
const ROUTINE_BUSY = /elaborating|checking the new imports|imports changed/i;

/** qed64's labels carry their own size notes ("(1.4 GiB — one-time)",
 * "(3.3 GiB unpacked — cached …)"); the banner shows byte progress in MB
 * itself, so three unit systems met on one line. Strip the notes and say
 * "game environment" where qed64 says the snapshot's internal name. */
function humanizeLabel(label: string): string {
  // Per-module progress reports the module name ("Mathlib.Tactic.Attr.Register").
  if (/^[A-Z][\w']*(\.[\w']+)+$/.test(label.trim())) return "loading the game's modules";
  const out = label
    .replace(/\s*\([^)]*(GiB|MiB|MB|KB)[^)]*\)/g, "")
    .replace(/\b(the )?(nng4|testgame|mathlib|init|core)( environment| snapshot)\b/i, (m, the, _name, what) =>
      `${the ?? ""}game${what}`)
    .trim();
  // qed64 capitalises some stage names ("Mounting verified library packs");
  // they read as mid-sentence here ("Lean is starting — mounting …").
  return /^[A-Z][a-z]/.test(out) && !/^(Lean|Mathlib|Init)\b/.test(out) ? out[0].toLowerCase() + out.slice(1) : out;
}
let bootFinishedOnce = false;
/** The relay, once constructed (re-arm from the pane; status facts). */
let relayRef: LspRelay | null = null;
/** The relay is replacing its session (crash reboot): the input gate must
 * stay closed even while the replacement's boot stages publish labels the
 * SWITCHING_RE would not recognise. */
let relayRebooting = false;

const consoleSink: StatusSink = {
  busy: (rawLabel) => {
    const label = humanizeLabel(rawLabel);
    console.info(`[game-boot] ⏳ ${rawLabel}`);
    publishCheckerActivity("busy", label, !bootFinishedOnce, relayRebooting || !bootFinishedOnce);
    if (!bootFinishedOnce || !ROUTINE_BUSY.test(label)) {
      publishBootStatus({ state: "busy", label });
    }
  },
  progress: (rawLabel, info) => {
    const label = humanizeLabel(rawLabel);
    console.debug(`[game-boot] … ${rawLabel}`, info ?? "");
    publishCheckerActivity("busy", label, !bootFinishedOnce, relayRebooting || !bootFinishedOnce);
    if (!bootFinishedOnce || !ROUTINE_BUSY.test(label)) {
      publishBootStatus({ state: "busy", label, loaded: info?.loaded, total: info?.total, unit: info?.unit });
    }
  },
  idle: (rawLabel) => {
    const label = humanizeLabel(rawLabel);
    console.info(`[game-boot] ✔ ${rawLabel}`);
    publishCheckerActivity("ready", label);
    publishBootStatus({ state: "ready", label });
  },
};

/** The relay's status → the page's atoms. This is the ONLY source of
 * ready / elaborating / halted under the resident transport (the session
 * adapter reports boot stages through the StatusSink, never readiness).
 *
 * Facts read: `relay` (serving | rebooting | halted) and `phase`. A serving
 * relay whose worker reports `starting` with no document version is the
 * armed, idle checker with nothing open yet (the world map: lean4monaco
 * opens no document until a level mounts) — that is "ready" for the page.
 * `elaborating` is routine after the first boot (no banner). booting/dead,
 * or any phase while the relay is rebooting, is a session replacement: the
 * input gate closes. headerRefused: the kernel could not serve the header
 * (cannot happen for a covered game header; treated as a hard error).
 * halted: the crash-loop breaker (three deaths in two minutes) — a
 * permanent idle until the document changes or the page re-arms it. */
let everServed = false;
function markServed(ui: StatusSink): void {
  if (everServed) return;
  everServed = true;
  bootFinishedOnce = true;
  (globalThis as { qed64GameReady?: boolean }).qed64GameReady = true;
  ui.idle("Lean ready");
  void warmOfflineCache();
}

/** Offline reloads: the service worker (client/src/sw) caches the runtime
 * chunks and manifests it sees pass through — but on a first visit the boot
 * fetched them before the worker controlled the page. Once the checker is
 * up, ask the worker itself to fetch them (through the HTTP cache: no
 * second download) and to prune chunks of superseded runtimes. Needs no
 * page control, so it works on the very first visit. Snapshots and pack
 * parts are not needed here (OPFS). */
let warmedArtifacts: Qed64Artifacts | null = null;
async function warmOfflineCache(): Promise<void> {
  const a = warmedArtifacts; warmedArtifacts = null;
  if (!a || !("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const urls: string[] = ["/runtime/runtime-manifest.json", "/snapshots/index.json", "/profiles/index.json"];
    for (const f of Object.values((a.runtime as { files?: Record<string, { chunks?: { url: string }[] }> }).files ?? {})) {
      for (const c of f.chunks ?? []) urls.push(c.url);
    }
    const reply = await new Promise<{ cached: number; pruned: number; total: number } | null>((resolve) => {
      const ch = new MessageChannel();
      const t = window.setTimeout(() => resolve(null), 120000);
      ch.port1.onmessage = (e) => { window.clearTimeout(t); resolve(e.data); };
      reg.active?.postMessage({ type: "warm", urls }, [ch.port2]);
    });
    if (reply) console.info(`[game-boot] offline cache: ${reply.cached}/${reply.total} runtime files cached, ${reply.pruned} superseded pruned`);
    else console.warn("[game-boot] offline cache warm-up: no reply from the service worker");
  } catch (e) {
    console.warn("[game-boot] offline cache warm-up skipped:", e);
  }
}

function publishRelayStatus(st: RelayStatus, ui: StatusSink): void {
  const death = st.lastDeath ? `${st.lastDeath.message || st.lastDeath.reason}` : "";
  if (st.relay === "halted") {
    relayRebooting = false;
    if (!everServed) ui.idle(`Lean failed to start: ${death || "the checker crashed repeatedly while starting"}`);
    else {
      const label = `the checker halted after repeated crashes${death ? ` (${death.slice(0, 80)})` : ""}`;
      publishCheckerActivity("ready", label, false, false, true);
      publishBootStatus({ state: "ready", label });
    }
    return;
  }
  if (st.relay === "rebooting" || st.phase === "booting" || st.phase === "dead") {
    relayRebooting = true;
    const label = death && st.relay === "rebooting" ? `restarting the checker after a crash (${death.slice(0, 80)})` : "starting the Lean checker";
    publishCheckerActivity("busy", label, !bootFinishedOnce, true);
    publishBootStatus({ state: "busy", label });
    return;
  }
  // serving
  relayRebooting = false;
  switch (st.phase) {
    case "ready":
      markServed(ui);
      publishCheckerActivity("ready", "ready");
      publishBootStatus({ state: "ready", label: "ready" });
      return;
    case "starting":
      if (st.version === null) { // armed, nothing open: the idle checker
        markServed(ui);
        publishCheckerActivity("ready", "ready");
        publishBootStatus({ state: "ready", label: "ready" });
        return;
      }
      // a queued document is about to open — elaboration follows
      publishCheckerActivity("busy", "elaborating", !bootFinishedOnce);
      if (!bootFinishedOnce) publishBootStatus({ state: "busy", label: "elaborating" });
      return;
    case "elaborating":
      publishCheckerActivity("busy", "elaborating", !bootFinishedOnce);
      if (!bootFinishedOnce) publishBootStatus({ state: "busy", label: "elaborating" });
      return;
    case "headerRefused": {
      const missing = st.header?.missing?.length ? ` (missing: ${st.header.missing.slice(0, 4).join(", ")})` : "";
      if (!everServed) { markServed(ui); ui.idle(`Lean failed to start: the level header could not be served${missing}`); return; }
      publishCheckerActivity("ready", `the level header could not be served${missing}`);
      publishBootStatus({ state: "ready", label: `the level header could not be served${missing}` });
      return;
    }
    default:
      return;
  }
}

/** Re-arm a halted relay: it leaves `halted` only on a document change, so
 * replay the document it holds as a full-text change at the same version
 * (the editor's next real change is still newer). Returns false when there
 * is nothing to re-arm. Used by the level pane's "Restart the checker" and
 * on a level switch while halted (a new level is a new document). */
export function rearmCheckerIfHalted(): boolean {
  const relay = relayRef;
  if (!relay || relay.state.kind !== "halted" || !relay.doc) return false;
  relay.fromClient({
    jsonrpc: "2.0",
    method: "textDocument/didChange",
    params: { textDocument: { uri: relay.doc.uri, version: relay.doc.version }, contentChanges: [{ text: relay.lastText }] },
  });
  return true;
}

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
   try {
    const translation = ensureTranslation();
    const bundle = await ensureBundle();
    const store = getDefaultStore();
    translation.configure({
      gameName: bundle.gameName,
      levelData: (w, l) => bundle.levels.get(`${w}/${l}`),
      difficulty: () => store.get(difficultyAtom),
      inventory: () => store.get(progressAtom)?.inventory ?? [],
    });

    // Preflight the worker scripts: they are generated into public/workers
    // from the vendored closure (gitignored), and a shell deployed without
    // them (the first CI-built deploy, 2026-09-07) hangs at "starting Lean"
    // with no error — `new Worker(404)` never answers. Fail loud instead.
    for (const script of ["/workers/lean.worker.js", "/workers/lsp-frames.js", "/workers/lsp-front-door.js", "/workers/snapshot-prefetch.worker.js"]) {
      const r = await fetch(script, { method: "HEAD", cache: "no-cache" }).catch(() => null);
      // A static host answers 404; a single-page fallback answers 200 with
      // the app's HTML — neither is a worker script.
      const html = /text\/html/i.test(r?.headers.get("content-type") ?? "");
      if (!r || !r.ok || html) {
        throw new Error(`this deployment is missing ${script} (${r ? `HTTP ${r.status}${html ? ", HTML page" : ""}` : "unreachable"}) — the site needs a rebuild that stages the worker scripts`);
      }
    }
    const artifacts: Qed64Artifacts = await installArtifacts(ui);
    warmedArtifacts = artifacts;

    const files = bundle.rawFiles.map((f) => ({ path: `${WORKER_GAMEDATA_DIR}/${f.name}`, text: f.text }));
    const policy = gamePolicy(boundGame!.snapshot);
    // The relay constructs and boots its first session synchronously, so
    // everything the session needs exists by now (artifacts, bundle, the
    // configured translation). `headerText` is the document the session will
    // serve — the relay's last full text on a reboot; the game's policy does
    // not read it (every header is covered by the game snapshot).
    let relay!: LspRelay;
    relay = new LspRelay(
      (opts) => new GameSession({ artifacts, ui, policy, headerText: relay?.lastText ?? "" }, files, opts ?? {}),
      { status: (st) => publishRelayStatus(st, ui) },
      () => new Promise((r) => window.setTimeout(r, 1500)),
    );
    relayRef = relay;
    // A level switch while the relay is halted: the new level is a new
    // document, and the relay leaves `halted` only on a change — re-arm it.
    translation.onDidOpen = () => { rearmCheckerIfHalted(); };
    // Diagnostics hooks for harnesses: the relay's own datum, plus the shape
    // the pump-era probes read (phase/version/stats).
    (globalThis as { qed64GameRelay?: unknown }).qed64GameRelay = { relay, status: () => relay.status() };
    (globalThis as { qed64GameShim?: unknown }).qed64GameShim = {
      status: () => {
        const st = relay.status();
        return { phase: st.phase, version: st.version, stats: { recentDeaths: relay.deaths.length, pendingRequests: relay.pending.size, queued: 0 } };
      },
    };
    // Release the wasm heap the moment the page goes away: dispose + the
    // synchronous kill inside the pagehide handler's own turn. A reload does
    // not promptly reclaim a dead page's committed multi-GiB shared memory;
    // the next boot commits its own, and a burst of level switches on top of
    // the stacked heaps jetsams the renderer.
    window.addEventListener("pagehide", () => relay.unload(), { once: true });
    translation.attachServer(relay.clientPort);
    // Readiness is the relay's fact (its first `serving` + ready status), not
    // the boot promise's: publishRelayStatus flips qed64GameReady / bootFinishedOnce.
    return { translation, relay, bundle };
   } catch (err) {
    // A failed boot must reach the page: the banner and the level pane read
    // the status atoms, and a rejected promise alone left "Lean is starting
    // in your browser" spinning for ever. The idle label carries the reason
    // (the pane renders "Lean failed to start" from it) and the promise is
    // reset so a Retry/reload can boot again.
    const message = (err as Error)?.message ?? String(err);
    ui.idle(`Lean failed to start: ${message}`);
    bootPromise = null;
    throw err;
   }
  })();
  return bootPromise;
}
