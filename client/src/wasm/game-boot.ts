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
 *  0. the artifacts: installGameArtifacts — the runtime manifest and the
 *     snapshot index, NO library pack (the vendored installArtifacts installs
 *     the core profile pack, 120 MB on the wire / 389 MB in OPFS, which a
 *     game never reads: its snapshot is a complete environment and the
 *     kernel serves headers from cached environments only);
 *  1. the boot policy: the game's snapshot, named by the catalog (/api/games,
 *     see games-api.ts) and checked against the served index and the runtime
 *     build BEFORE any artifact byte moves; its baked environment covers
 *     every level header — the kernel's resolver serves
 *     `import Game.Levels.X import GameServer.Runner` from it in-process, so
 *     a level switch is a document change, not a session replacement; the
 *     memory commit is sized from the index's region bytes;
 *  2. place `.lake/gamedata/*.json` into the worker FS on EVERY session —
 *     GameServer's Runner reads level data from the cwd at proof-check time
 *     (GameSession.start, which the relay runs on each boot and reboot);
 *  3. map the relay's status to the page's atoms (banner, input gating,
 *     readiness, boot failure).
 */
import type { Qed64Artifacts, StatusSink } from "qed64/frontend/src/qed64-boot";
import { fetchProfileIndex, type ProfileIndex } from "qed64/src/install/profiles";
import { LspRelay, type RelayStatus, type RestartOptions } from "qed64/frontend/src/lsp-relay";
import { ResidentSession, type ResidentHost, type ResidentPolicy } from "qed64/frontend/src/resident-session";
import type { SnapshotEntry, SnapshotIndex } from "qed64/src/runtime/snapshots";
import { atom, getDefaultStore } from "jotai";
import { difficultyAtom, progressAtom } from "../store/progress-atoms";
import { GameTranslation, type GameLevelData } from "./game-translation";
import { publishBootStatus, publishCheckerActivity, publishDocumentProcessing, publishNetworkHold } from "../store/boot-atoms";
import { rememberGamedata } from "./gamedata-cache";
import { MiB, devSnapshotsDir, fallbackSnapshotName, fetchSnapshotIndexOnce, findApiGame, findSnapshotEntry, gameKnown, gameMemoryPolicy, rawSnapshotCached, resolveRuntimeBuildId, resolveRuntimeManifest } from "./games-api";
import { claimSnapshotForBoot, notifyCacheChanged, inFlightPrepare, inFlightRegions, prepareStatusesAtom, sweepStaleSnapshots, warmRuntimeCache, type PrepareStatus } from "./game-cache";

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
function currentGameId(): string | null {
  // Hash form `#/g/{owner}/{game}/…` (what the location atoms write) or the
  // path form `/{owner}/{game}/…` (the newer URLs the atoms also read).
  let gameId: string | null = null;
  const m = /#\/(g\/[^/]+\/[^/]+)/.exec(window.location.hash);
  if (m) gameId = m[1];
  else {
    const seg = window.location.pathname.split("/").filter(Boolean);
    if (seg.length >= 2) gameId = `g/${seg[0]}/${seg[1]}`;
  }
  return gameId;
}

/** The snapshot a game boots is catalog DATA (wasm/catalog.json → the
 * /api/games row), not a URL convention. The lowercased last segment is the
 * fallback for an id the catalog does not know (a dev game) and for a page
 * that cannot read /api/games at all (404, offline before it was cached). */
async function resolveSnapshotName(gameId: string): Promise<string> {
  const fallback = fallbackSnapshotName(gameId);
  try {
    const row = await findApiGame(gameId);
    if (row?.snapshot) return row.snapshot;
    console.warn(`[game-boot] ${gameId} has no /api/games row naming its snapshot; assuming '${fallback}'`);
  } catch (err) {
    console.warn(`[game-boot] /api/games unavailable (${(err as Error).message}); assuming snapshot '${fallback}' for ${gameId}`);
  }
  return fallback;
}

/** The environment this page's session is bound to, once the pairing check
 * has passed: the level pane reads the transfer size from it ("about N MB")
 * instead of a literal. Null on the landing page and until the check ran. */
export interface BoundEnvironment {
  gameId: string;
  snapshot: string;
  /** Raw region bytes (what the worker holds). */
  bytes: number;
  /** Bytes the first play transfers (gzip on the wire; raw if unknown). */
  transfer: number;
}
export const boundEnvironmentAtom = atom<BoundEnvironment | null>(null);

/** Fail fast — BEFORE the artifacts install and before any snapshot byte:
 * the bound snapshot must be in the served index, baked for the runtime
 * this shell boots (snapshots are function-table-paired to one binary; the
 * worker refuses an unpaired one, the relay reboots it three times, and only
 * then would the page have said anything), and its object must exist — the
 * "index says yes, object missing" case (a publish window, a failed upload)
 * is one HEAD away (infra/worker.js serves HEAD from R2). A region already
 * inflated into OPFS needs no object, so the HEAD is skipped for it and an
 * offline reload keeps working. The thrown message is the reason only: the
 * boot's catch prefixes "Lean failed to start: " and the level pane shows
 * it as the failure card. */
async function checkSnapshotPairing(snapshot: string): Promise<{ entry: SnapshotEntry; index: SnapshotIndex; buildId: string }> {
  const [buildId, index] = await Promise.all([resolveRuntimeBuildId(), fetchSnapshotIndexOnce()]);
  const unpublished = (why: string) => new Error(`the environment "${snapshot}" is not published for this build (${why})`);
  if (!index) throw unpublished(`the snapshot index could not be read; this shell runs ${buildId}`);
  const entry = findSnapshotEntry(index, snapshot);
  if (!entry) throw unpublished(`no entry in the snapshot index; this shell runs ${buildId}`);
  if (entry.runtime !== buildId) throw unpublished(`baked for ${entry.runtime ?? "an unknown runtime"}, this shell runs ${buildId}`);
  if (!(await rawSnapshotCached(entry))) {
    const head = await fetch(entry.url, { method: "HEAD" }).catch(() => null);
    // A static host answers 404 for a missing object; a single-page fallback
    // (scripts/serve-dist.mjs, the vite dev server) answers 200 with the
    // app's HTML — neither is the snapshot. Any other refusal (405/501/5xx:
    // a host that does not serve HEAD) is no evidence of a missing object,
    // so it is logged and the download itself reports.
    const html = /text\/html/i.test(head?.headers.get("content-type") ?? "");
    if (!head || html || head.status === 404 || head.status === 410) {
      throw unpublished(`${head ? `HTTP ${head.status}${html ? ", HTML page" : ""}` : "unreachable"} for ${entry.url}`);
    }
    if (!head.ok) console.warn(`[game-boot] HEAD ${entry.url}: HTTP ${head.status} — not treated as missing; the download will report`);
  }
  return { entry, index, buildId };
}

/** The game's artifacts, in the vendored `Qed64Artifacts` shape, WITHOUT
 * the core profile pack the editor's installArtifacts (qed64-boot.ts) puts
 * in: a game session never imports from oleans — the game snapshot is one
 * complete environment and the kernel's header resolver (FileWorker.lean →
 * lookupPrebuiltEnv) serves headers only from cached environments on
 * Emscripten — so the pack was 120 MB of first-visit wire and 389 MB of
 * OPFS for nothing. With `installed` empty the session boots the worker
 * with leanPath "" and no packs (resident-session.ts start: LEAN_PATH is
 * joined from the installed ids; lean.worker.js mountPacks over [] is a
 * no-op and mkdirp("") creates nothing; Lean parses LEAN_PATH "" as one
 * empty entry, which nothing consults because headers never reach findOLean
 * here). The runtime manifest is the ONE resolver's choice
 * (resolveRuntimeManifest — the same manifest the pairing check read), the
 * snapshot index the same memoised fetch (with the `?snapshots=` dev
 * re-rooting), and the profile index is kept in the shape only: a missing
 * one is not fatal for a game (an empty profile list; ensureProfile then
 * answers "not published", which no game path asks). */
async function installGameArtifacts(ui: StatusSink): Promise<Qed64Artifacts> {
  ui.busy("fetching manifests");
  const [runtime, snapshots] = await Promise.all([resolveRuntimeManifest(), fetchSnapshotIndexOnce()]);
  const index: ProfileIndex = await fetchProfileIndex().catch((e) => {
    console.warn(`[game-boot] profile index unavailable (${(e as Error).message}); a game needs no library pack`);
    return { schema: "qed64.profile-index/v1", runtime: { buildId: runtime.buildId, leanVersion: runtime.leanVersion }, profiles: [] };
  });
  return { runtime, index, installed: new Map(), snapshots };
}

/** Worker cwd is /workspace (lean.worker.js boots there); Runner reads
 * `./.lake/gamedata/...` relative to it. */
const WORKER_GAMEDATA_DIR = "/workspace/.lake/gamedata";

let boundGameId: string | null = null;
let sweptOnce = false;
/** A game switch is waiting for running prepares before it reloads. */
let switchPending = false;
/** Each switch attempt's token: a cancelled attempt's waiter must neither
 * reload nor paint the banner, also when a LATER switch is pending again. */
let switchGen = 0;

/** Mirror a prepare's status onto the boot banner while `until` runs: the
 * running region's bytes as progress (the worker's inflated offsets — the
 * level pane says what they unpack to), a plain busy label otherwise.
 * Renders once immediately: jotai's sub fires only on the NEXT change, and
 * a wait that started between two 64 MiB ticks showed no bytes at all. */
async function mirrorPrepare<T>(ui: StatusSink, snapshot: string | null, label: string, until: Promise<T>, live: () => boolean = () => true): Promise<T> {
  const store = getDefaultStore();
  const render = () => {
    if (!live()) return; // a cancelled game switch: the banner belongs to the bound game again
    const st: PrepareStatus | undefined = snapshot ? store.get(prepareStatusesAtom)[snapshot] : undefined;
    if (st?.phase === "running") ui.progress(label, { phase: "snapshot", loaded: st.bytes, total: st.total, unit: "bytes" });
    else ui.busy(label);
  };
  const unsub = store.sub(prepareStatusesAtom, render);
  try { render(); return await until; } finally { unsub(); }
}

async function fetchJson(url: string): Promise<any> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
  const json = await r.json();
  rememberGamedata(url, json); // the UI's offline fallback for level texts
  return json;
}

export async function fetchGameData(): Promise<GameDataBundle> {
  const base = `/data/${boundGameId!}`;
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
        const data = await fetchJson(`/data/${boundGameId!}/level__${w}__${l}.json`);
        levels.set(`${w}/${l}`, data);
        rawFiles.push({ name: `level__${w}__${l}.json`, text: JSON.stringify(data) });
      });
    }),
  );
  return { gameName: game.name, levels, rawFiles };
}

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

/** The game's boot policy, from data. Snapshots: the game's baked environment
 * ALONE — it covers every level header in-process, and the kernel's resolver
 * can never pick the Init-only env for a level header, so the init snapshot
 * (107 MB on the wire, ~340 MB of heap) left the game session; a browser
 * probe of the built shell validates this, and `["init", snapshot]` is the
 * fallback if it fails (the memory formula sums whichever list the session
 * loads, so that flip is one line). Memory: the region bytes come from the
 * served index (gameMemoryPolicy: +10 %, 256 MiB steps, ≥1 GiB; cap ≥3 GiB
 * and ≥ initial + 1 GiB — the vendored session filters that cap against the
 * device's reservation rungs, see games-api.ts). The cap keeps the
 * reservation a dead-but-unreclaimed page holds across reloads small (the
 * reload-then-switch-storm renderer crash). */
function gamePolicy(snapshot: string, index: SnapshotIndex): ResidentPolicy {
  const regionBytes = (names: readonly string[]) => names.reduce((n, name) => n + (findSnapshotEntry(index, name)?.bytes ?? 0), 0);
  const snapshots = [snapshot];
  const chosen = gameMemoryPolicy(regionBytes(snapshots));
  console.info(`[game-boot] policy ${snapshot}: region ${Math.round(regionBytes(snapshots) / MiB)} MB → initial ${chosen.initialBytes / MiB} MiB, cap ${chosen.maximumBytes / MiB} MiB`);
  return {
    snapshotsFor: () => snapshots,
    // Sized for the list the session WILL load (explicit restart options win
    // over snapshotsFor), not for the policy's own list.
    initialBytesFor: (_header, names) => gameMemoryPolicy(regionBytes(names)).initialBytes,
    maximumBytes: chosen.maximumBytes,
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
 * "game environment" where qed64 says the snapshot's internal name — ANY
 * name ("preparing the stg4 environment", "loading the nng4 environment",
 * "nng4 snapshot failed: …", the death message "snapshot 'nng4' failed to
 * load"), so no per-game data flows into the label layer; init/core/mathlib
 * read as "game" too, as before. The generic words are excluded so the
 * worker's own "Loading environment snapshot" / "Loading the environment
 * into Lean" stay untouched. (No pack label occurs on the game path any
 * more — installGameArtifacts installs none — but the rule is harmless.) */
function humanizeLabel(label: string): string {
  // Per-module progress reports the module name ("Mathlib.Tactic.Attr.Register").
  if (/^[A-Z][\w']*(\.[\w']+)+$/.test(label.trim())) return "loading the game's modules";
  const out = label
    .replace(/\s*\([^)]*(GiB|MiB|MB|KB)[^)]*\)/g, "")
    .replace(/(^|\s)(the )?(?!(?:the|environment|loading|game)\b)([\w-]+)( environment| snapshot)\b/i, (m, pre, the, _name, what) =>
      `${pre}${the ?? ""}game${what}`)
    .replace(/\bsnapshot '[\w-]+'/gi, "the game snapshot")
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

/** L4/L5 latch: the relay is halted. A session the breaker left behind can
 * still run its start() after the settle and publish "starting Lean" over
 * the failure card — for good, since nothing follows it (seen live: an
 * endless spinner with the relay halted and no Reload). Busy/progress labels
 * are dropped while it is set; any non-halted relay status clears it. */
let relayHalted = false;

/** The underlying reason of the last snapshot failure. The vendored session
 * dies with the same "snapshot '<name>' failed to load" for a cut download,
 * a corrupt region, an unpaired snapshot and an allocation failure alike; the
 * real error only reaches this side as qed64-boot's progress label
 * "<name> snapshot failed: <error>". Recorded BEFORE the halted gate, reset
 * at each session's "starting Lean". Read by looksLikeNetworkDeath. */
let lastSnapshotFailure = "";
function noteSnapshotFailure(rawLabel: string): void {
  const m = /snapshot failed: (.*)$/.exec(rawLabel);
  if (m) lastSnapshotFailure = m[1];
  // (not while halted: a session the breaker left behind may still publish
  // "starting Lean", and the halted classification must keep its evidence)
  else if (!relayHalted && /^starting Lean$/i.test(rawLabel.trim())) lastSnapshotFailure = "";
}

const consoleSink: StatusSink = {
  busy: (rawLabel) => {
    noteSnapshotFailure(rawLabel);
    if (relayHalted) { console.info(`[game-boot] (halted, not shown) ⏳ ${rawLabel}`); return; }
    const label = humanizeLabel(rawLabel);
    console.info(`[game-boot] ⏳ ${rawLabel}`);
    publishCheckerActivity("busy", label, !bootFinishedOnce, relayRebooting || !bootFinishedOnce);
    if (!bootFinishedOnce || !ROUTINE_BUSY.test(label)) {
      publishBootStatus({ state: "busy", label });
    }
  },
  progress: (rawLabel, info) => {
    noteSnapshotFailure(rawLabel);
    if (relayHalted) return;
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
  // A served boot restores the full automatic-recovery budget: a long-lived
  // tab that survived three flaps gets a fourth recovery, and the one guarded
  // reload of the no-document re-arm is available again.
  autoRearms = 0;
  try { sessionStorage.removeItem("l4g-network-reload"); } catch { /* storage blocked */ }
  if (everServed) return;
  everServed = true;
  bootFinishedOnce = true;
  (globalThis as { qed64GameReady?: boolean }).qed64GameReady = true;
  ui.idle("Lean ready");
  // L12: the bound game's region landed in OPFS through this boot — other
  // tabs' landing tiles re-probe.
  notifyCacheChanged();
  void warmOfflineCache();
}

/** Offline reloads: the service worker (client/src/sw) caches the runtime
 * chunks and manifests it sees pass through — but on a first visit the boot
 * fetched them before the worker controlled the page. Once the checker is
 * up, ask the worker itself (game-cache.ts warmRuntimeCache, the same call
 * a landing-page Prepare makes) to fetch them through the HTTP cache — no
 * second download — and to prune chunks of superseded runtimes. Snapshots
 * are not needed here (OPFS). */
let warmedArtifacts: Qed64Artifacts | null = null;
async function warmOfflineCache(): Promise<void> {
  const a = warmedArtifacts; warmedArtifacts = null;
  if (!a) return;
  try {
    const reply = await warmRuntimeCache(a.runtime);
    if (reply) console.info(`[game-boot] offline cache: ${reply.cached}/${reply.total} runtime files cached, ${reply.pruned} superseded pruned`);
    else console.warn("[game-boot] offline cache warm-up: no service worker reply");
  } catch (e) {
    console.warn("[game-boot] offline cache warm-up skipped:", e);
  }
}

/* ---- L4: network-aware recovery -------------------------------------------
 * The vendored relay counts every failed boot as a death and reboots after
 * the injected settle; three deaths in two minutes halt it for good. A
 * download cut by an outage is such a death ("snapshot 'nng4' failed to
 * load", RUNTIME_FETCH_FAILED, "Failed to fetch"), so a 20 s outage burned
 * all three attempts in its first 10 s and the page stayed dead after the
 * network came back. Two game-side measures, no vendored change:
 *  1. the settle holds the reboot until a cheap same-origin probe succeeds
 *     (2, 4, 8, 15, 15 … s backoff, and at once on the `online` event);
 *  2. a relay that halted anyway for a network-shaped death is re-armed
 *     automatically once the probe succeeds (at most MAX_AUTO_REARMS times
 *     per page — a snapshot that "fails to load" with the network up is not
 *     retried for ever). */
/* Classified by the UNDERLYING error text, never by the generic death: the
 * session throws "snapshot '<name>' failed to load" for every snapshot
 * failure (cut download, corrupt region, SNAPSHOT_UNPAIRED, allocation) and
 * RUNTIME_FETCH_FAILED is also the worker's code for "chunk N: HTTP 404" and
 * a failed SHA-256 check. A corrupt snapshot with the network up was held
 * under the "download was interrupted" card and re-armed three times (12
 * boots, 24 .snapz GETs) before the right card showed. */
const NETWORK_DETAIL = /Failed to fetch|NetworkError|Load failed|network (error|changed)|ERR_(INTERNET|NETWORK|CONNECTION|TUNNEL|NAME)/i;
const SNAPSHOT_DEATH = /^snapshot '.*' failed to load$/;
const looksLikeNetworkDeath = (d: { reason: string; message: string } | null | undefined): boolean =>
  !!d && NETWORK_DETAIL.test(SNAPSHOT_DEATH.test(d.message) ? lastSnapshotFailure : d.message);
const NETWORK_WAIT_LABEL = "waiting for the connection — the download restarts on its own";

/** Any HTTP answer means the origin is reachable. `no-store` makes the
 * service worker go to the network and NOT fall back to its cache (sw
 * bypass()), so an offline page cannot fool the probe. */
async function probeNetwork(): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), 8000);
  try {
    await fetch(`/snapshots/index.json?probe=${Date.now()}`, { method: "HEAD", cache: "no-store", signal: ctl.signal });
    return true;
  } catch { return false; } finally { window.clearTimeout(timer); }
}

/** Resolves once the probe succeeds; returns whether it ever failed. */
async function waitForNetwork(onWaiting: () => void): Promise<boolean> {
  let delay = 2000, everDown = false;
  for (;;) {
    if (await probeNetwork()) return everDown;
    if (!everDown) { everDown = true; onWaiting(); }
    await new Promise<void>((resolve) => {
      const done = () => { window.clearTimeout(id); window.removeEventListener("online", done); resolve(); };
      const id = window.setTimeout(done, delay);
      window.addEventListener("online", done);
    });
    delay = Math.min(delay * 2, 15000); // capped: a 20 s outage is noticed within 15 s of its end
  }
}

/** The relay's settle: the 1.5 s heap-release wait, then — after a
 * network-shaped death ONLY — the hold. Not "while the browser reports
 * offline": a cached game reboots offline in seconds (runtime in the service
 * worker cache, region in OPFS), and holding every reboot locked an offline
 * player out after any checker death. A reboot that really needs the network
 * while offline dies once with a fetch-shaped death; the NEXT settle holds. */
async function networkAwareSettle(): Promise<void> {
  await new Promise((r) => window.setTimeout(r, 1500));
  const death = relayRef?.lastDeath;
  if (!looksLikeNetworkDeath(death)) return;
  const t0 = Date.now();
  const waited = await waitForNetwork(() => {
    console.warn(`[game-boot] the network is unreachable after "${death?.message ?? "offline"}" — holding the restart until it returns`);
    publishNetworkHold({ since: t0, halted: false });
    publishCheckerActivity("busy", NETWORK_WAIT_LABEL, !bootFinishedOnce, true);
    publishBootStatus({ state: "busy", label: NETWORK_WAIT_LABEL });
  });
  if (waited) console.info(`[game-boot] the network is back after ${Math.round((Date.now() - t0) / 1000)} s — restarting the checker`);
  if (!relayHalted) publishNetworkHold(null);
}

const MAX_AUTO_REARMS = 3;
let autoRearms = 0, autoRearmScheduled = false;
/** Safety net (2): re-arm a relay that halted for a network reason. */
function scheduleNetworkRearm(): void {
  if (autoRearmScheduled || autoRearms >= MAX_AUTO_REARMS) return;
  autoRearmScheduled = true;
  const since = Date.now();
  publishNetworkHold({ since, halted: true });
  void (async () => {
    // Not at once: a flapping link would burn the fresh breaker budget too.
    await new Promise((r) => window.setTimeout(r, [3000, 15000, 30000][autoRearms] ?? 30000));
    await waitForNetwork(() => {});
    autoRearmScheduled = false;
    if (relayRef?.state.kind !== "halted") return;
    autoRearms += 1;
    console.warn(`[game-boot] the network is reachable again — re-arming the halted checker (automatic attempt ${autoRearms}/${MAX_AUTO_REARMS})`);
    if (rearmCheckerIfHalted()) return;
    // No document to replay (the world map): one guarded reload. When the
    // guard refuses, nothing else is scheduled — drop the hold so the normal
    // failure card (Reload + "Restart the checker") shows, not a card that
    // says recovery is automatic.
    try {
      if (sessionStorage.getItem("l4g-network-reload") === "1") { publishNetworkHold(null); return; }
      sessionStorage.setItem("l4g-network-reload", "1");
    } catch { publishNetworkHold(null); return; }
    window.location.reload();
  })();
}

function publishRelayStatus(st: RelayStatus, ui: StatusSink): void {
  // A game switch is waiting for running prepares before it reloads: the
  // banner shows THAT wait, and the outgoing game's relay (still serving,
  // its document closing) must not blank it with a "ready" in between.
  if (switchPending) return;
  const death = st.lastDeath ? `${st.lastDeath.message || st.lastDeath.reason}` : "";
  if (st.relay === "halted") {
    relayRebooting = false;
    relayHalted = true;
    const network = looksLikeNetworkDeath(st.lastDeath) && autoRearms < MAX_AUTO_REARMS;
    if (network) scheduleNetworkRearm(); else publishNetworkHold(null);
    if (!everServed) {
      ui.idle(`Lean failed to start: ${death || "the checker crashed repeatedly while starting"}`);
      // L5: publish the halted FACT for the not-yet-served case too — the
      // pane's 4 s retry tick is guarded by it; without it each tick asked a
      // halted relay, was refused, and flipped the pane between the failure
      // card and the editor-mode "Crashed!" wrapper every few seconds.
      publishCheckerActivity("ready", humanizeLabel(death || "the checker crashed repeatedly while starting"), false, false, true);
    } else {
      const label = `the checker halted after repeated crashes${death ? ` (${death.slice(0, 80)})` : ""}`;
      publishCheckerActivity("ready", label, false, false, true);
      publishBootStatus({ state: "ready", label });
    }
    return;
  }
  relayHalted = false;
  if (st.relay === "serving") publishNetworkHold(null);
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
  if (switchPending && here && here === boundGameId) {
    // L14: the player went back to the BOUND game while the switch was still
    // waiting for running prepares (minutes, possibly): the switch is
    // cancelled, not one-way — the suspended translation resumes (its
    // buffered messages flush; the other game's didOpen is caught by the
    // unknown-level defence) and the pending reload is called off below.
    switchPending = false;
    console.warn(`[game-boot] back on ${boundGameId} before the switch reload — switch cancelled, checker resumed`);
    translationSingleton?.resume();
    if (relayRef) publishRelayStatus(relayRef.status(), ui);
  }
  if (here && boundGameId && boundGameId !== here) {
    // The wasm session is bound to another game's environment; a clean
    // reload rebinds everything (snapshots reload from OPFS in seconds).
    // Nothing may run after the reload: returning the bound promise would
    // hand the caller game A's runtime under game B's route. But a reload
    // kills the prepare workers of this document and discards their
    // partials (the tile only warned about a USER reload) — so every
    // running prepare's region is waited for first, shown on the banner,
    // and the reloaded boot then finds the region cached instead of
    // downloading it again from zero.
    if (!switchPending) {
      switchPending = true;
      const gen = ++switchGen;
      const live = () => switchPending && gen === switchGen;
      // L14: from this instant the outgoing game's session sees nothing —
      // React is already mounting the new game's level, whose didOpen used
      // to be wrapped with THIS game's (missing) level data and sent to its
      // checker ("missing level data" + 2x "No RPC method" per switch).
      translationSingleton?.suspend();
      const regions = inFlightRegions();
      console.warn(`[game-boot] switching game ${boundGameId} → ${here}: reloading${regions.length ? ` after ${regions.length} running prepare(s) commit (${regions.map((r) => r.name).join(", ")})` : ""}`);
      void (async () => {
        if (regions.length) {
          const target = await resolveSnapshotName(here);
          const label = regions.some((r) => r.name === target) ? `preparing the ${target} environment` : "finishing the download you started before switching games";
          await mirrorPrepare(ui, target, label, Promise.allSettled(regions.map((r) => r.region)), live);
        }
        if (!live()) return; // cancelled: the player returned to the bound game
        window.location.reload();
      })();
    }
    return new Promise<GameRuntime>(() => {});
  }
  if (!bootPromise && !here) {
    // Landing page: defer binding until a game route is visited.
    return new Promise<GameRuntime>(() => {});
  }
  boundGameId ??= here;
  bootPromise ??= (async () => {
   try {
    // L11: an id this site does not serve (no /api/games row AND game.json
    // refused) boots nothing and publishes no failure — the router shows the
    // not-found page. Unbound again, so a real game entered later binds
    // without a reload. The promise stays pending like the landing page's.
    if (!(await gameKnown(boundGameId!))) {
      console.warn(`[game-boot] ${boundGameId} is not a game on this site — nothing to boot`);
      boundGameId = null;
      bootPromise = null;
      return await new Promise<GameRuntime>(() => {});
    }
    const translation = ensureTranslation();
    // Bind the snapshot from the catalog and check its pairing before the
    // gamedata (80 small files for NNG4) and long before any artifact byte.
    ui.busy("checking this game's environment");
    const snapshot = await resolveSnapshotName(boundGameId!);
    const { entry, index } = await checkSnapshotPairing(snapshot);
    const store = getDefaultStore();
    store.set(boundEnvironmentAtom, { gameId: boundGameId!, snapshot, bytes: entry.bytes, transfer: entry.transfer ?? entry.bytes });
    // One sweep per page of raw regions a rebake superseded (the served
    // index is the truth about each name's live key); never a boot blocker.
    // Not under the `?snapshots=<dir>` dev re-rooting: that index's keys are
    // an unpromoted bake's, and the sweep would take the promoted regions
    // for stale (and the next plain visit the unpromoted ones).
    if (!sweptOnce) {
      sweptOnce = true;
      const dev = devSnapshotsDir();
      if (dev) console.info(`[game-boot] stale region sweep skipped: unpromoted index ?snapshots=${dev}`);
      else try {
        const removed = await sweepStaleSnapshots(index);
        if (removed.length) console.info(`[game-boot] removed ${removed.length} stale cached region(s): ${removed.join(", ")}`);
      } catch (e) { console.warn("[game-boot] stale region sweep skipped:", e); }
    }
    const bundle = await ensureBundle();
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
    // A landing-page Prepare of THIS environment still running: wait for it
    // (its bytes show on the banner) rather than spawn a second prefetch
    // worker, which would find the file busy and leave the Lean worker to
    // stream the region itself — the heavy path.
    const pending = inFlightPrepare(snapshot);
    if (pending) await mirrorPrepare(ui, snapshot, `preparing the ${snapshot} environment`, pending);
    // From here the session's own prefetch worker owns the region file: a
    // Prepare of this snapshot started later would only collide with it.
    claimSnapshotForBoot(snapshot);
    const artifacts = await installGameArtifacts(ui);
    warmedArtifacts = artifacts;

    const files = bundle.rawFiles.map((f) => ({ path: `${WORKER_GAMEDATA_DIR}/${f.name}`, text: f.text }));
    const policy = gamePolicy(snapshot, index);
    // The relay constructs and boots its first session synchronously, so
    // everything the session needs exists by now (artifacts, bundle, the
    // configured translation). `headerText` is the document the session will
    // serve — the relay's last full text on a reboot; the game's policy does
    // not read it (every header is covered by the game snapshot).
    let relay!: LspRelay;
    relay = new LspRelay(
      (opts) => new GameSession({ artifacts, ui, policy, headerText: relay?.lastText ?? "" }, files, opts ?? {}),
      { status: (st) => publishRelayStatus(st, ui) },
      networkAwareSettle, // L4: 1.5 s, then held while the network is away
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
