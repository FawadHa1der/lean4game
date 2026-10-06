/**
 * Live status of the in-tab Lean runtime boot, fed by game-boot's StatusSink.
 *
 * The wasm build downloads a large kernel on first visit and boots for ~10 s
 * on later ones; unlike the server-backed original there is real work to
 * show. game-boot writes here from outside React (default jotai store); the
 * BootBanner and the level loading pane read it.
 */
import { atom, getDefaultStore } from "jotai";
import { wholeMB } from "../wasm/sizes";

export interface BootStatus {
  /** "busy" while a stage runs, "ready" once the checker is usable. */
  state: "busy" | "ready";
  /** Human label of the current stage ("downloading the Lean kernel", …). */
  label: string;
  /** Determinate progress when the stage reports sizes. */
  loaded?: number;
  total?: number;
  unit?: string;
}

// Starts inert: the landing page binds no game and must show no banner —
// game-boot publishes the first real "busy" only once a game route is
// entered and the kernel actually starts loading.
export const bootStatusAtom = atom<BootStatus>({
  state: "ready",
  label: "",
});

/** For non-React producers (game-boot's StatusSink). Unchanged content is
 * not republished: the sink fires per progress event (thousands per second
 * while a cached snapshot loads), and every fresh object re-rendered each
 * subscriber at that rate — measured as a ~1.2 kHz render loop of the level
 * panel during boot, each render issuing a doomed rpc connect. */
export function publishBootStatus(status: BootStatus): void {
  const store = getDefaultStore();
  const cur = store.get(bootStatusAtom);
  if (cur.state === status.state && cur.label === status.label && cur.loaded === status.loaded
      && cur.total === status.total && cur.unit === status.unit) return;
  store.set(bootStatusAtom, status);
}

/** Pretty progress text: "213 / 600 MB" (decimal MB — D8) or "37 / 152 modules". */
export function formatProgress(s: BootStatus): string | null {
  if (s.loaded === undefined || !s.total) return null;
  if (s.unit === "bytes") return `${wholeMB(s.loaded)} / ${wholeMB(s.total)} MB`;
  return `${s.loaded} / ${s.total}${s.unit ? ` ${s.unit}` : ""}`;
}

/** Coarse checker activity, published on EVERY status event (unlike the
 * banner's filtered view): drives input gating. `switching` covers boot and
 * level/import switches — the states where typed tactics would race a
 * session replacement — but not routine per-step elaboration, which the
 * typewriter's own processing gate already handles. */
export interface CheckerActivity {
  busy: boolean;
  switching: boolean;
  label: string;
  /** The relay's crash-loop breaker tripped: every request is refused until
   * the document changes (or the page re-arms it) — a permanent idle, not a
   * transient one the pane should keep retrying. */
  halted: boolean;
  /** HARDENING #52, while halted: the FileWorker's exit code when exits
   * halted it (the card's headline names it; null otherwise, also for an
   * exit that reported none), and whether repeated liveness stalls did. */
  exitCode: number | null;
  stalled: boolean;
  /** QD-API-2, while halted: the site was updated under this page (a worker
   * refused a sibling of another revision) — the card asks for a reload. */
  stalePage: boolean;
}

export const checkerActivityAtom = atom<CheckerActivity>({
  busy: false,
  switching: false,
  label: "",
  halted: false,
  exitCode: null,
  stalled: false,
  stalePage: false,
});

/** What halted the relay (death-kind haltFacts), for a halted status. */
export type HaltFacts = Pick<CheckerActivity, "exitCode" | "stalled" | "stalePage">;

/** `booting`: the first boot has not finished — every stage is a switch then
 * (the stage labels vary: module names, "Starting the Emscripten runtime",
 * … — matching them one by one left the gate flickering between stages).
 * `switching` is the relay's fact when given (a session is being replaced).
 * `halted`: true, or the halt's facts. */
export function publishCheckerActivity(state: "busy" | "ready", label: string, booting = false, switching?: boolean, halted: boolean | HaltFacts = false): void {
  const facts: HaltFacts = typeof halted === "object" ? halted : { exitCode: null, stalled: false, stalePage: false };
  const next: CheckerActivity = {
    busy: state === "busy",
    switching: state === "busy" && (switching ?? booting),
    label,
    halted: halted !== false,
    exitCode: halted !== false ? facts.exitCode : null,
    stalled: halted !== false && facts.stalled,
    stalePage: halted !== false && facts.stalePage,
  };
  const store = getDefaultStore();
  const cur = store.get(checkerActivityAtom);
  if (cur.busy === next.busy && cur.switching === next.switching && cur.label === next.label && cur.halted === next.halted
      && cur.exitCode === next.exitCode && cur.stalled === next.stalled && cur.stalePage === next.stalePage) return;
  store.set(checkerActivityAtom, next);
}

/** Is the checker still processing the level document (`$/lean/fileProgress`
 * with non-empty ranges)? Written by the LSP translation layer on every
 * progress notification. Proof states that arrive while this is true are
 * provisional: an edit that has not been elaborated yet reports
 * `completed` with no goals and no diagnostics for a few hundred ms. */
export const documentProcessingAtom = atom<boolean>(false);
export function publishDocumentProcessing(processing: boolean): void {
  getDefaultStore().set(documentProcessingAtom, processing);
}
export function isDocumentProcessing(): boolean {
  return getDefaultStore().get(documentProcessingAtom);
}

/** L4/L5: the boot is held (or halted) because the network went away in the
 * middle of a download — not a crash. `halted` = the relay's breaker tripped
 * anyway and a re-arm is scheduled for when a connectivity probe succeeds.
 * The level pane says so instead of "Lean could not start". Null otherwise. */
export interface NetworkHold { since: number; halted: boolean }
export const networkHoldAtom = atom<NetworkHold | null>(null);
export function publishNetworkHold(hold: NetworkHold | null): void {
  const store = getDefaultStore();
  const cur = store.get(networkHoldAtom);
  if (cur === hold || (cur && hold && cur.halted === hold.halted)) return;
  store.set(networkHoldAtom, hold);
}

/** QB-2 (game-boot `initializeLost`): the page's language client lost its
 * own `initialize` to a checker death or halt, and the relay serves again
 * without it — the client stays "starting"/"stopped" for good unless it is
 * restarted. game-boot bumps `seq` when that relay reports serving; app.tsx,
 * which owns the LeanMonaco instance, restarts the client on it (the action
 * of the editor's "Restart Lean" and of the level pane's 20 s self-heal:
 * lean4monaco LeanClient.restart()). `why` is for the console. seq 0: never. */
export interface LanguageClientRestart { seq: number; why: string }
export const languageClientRestartAtom = atom<LanguageClientRestart>({ seq: 0, why: "" });
export function publishLanguageClientRestart(why: string): void {
  const store = getDefaultStore();
  store.set(languageClientRestartAtom, { seq: store.get(languageClientRestartAtom).seq + 1, why });
}
