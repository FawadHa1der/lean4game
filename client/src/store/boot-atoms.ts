/**
 * Live status of the in-tab Lean runtime boot, fed by game-boot's StatusSink.
 *
 * The wasm build downloads a large kernel on first visit and boots for ~10 s
 * on later ones; unlike the server-backed original there is real work to
 * show. game-boot writes here from outside React (default jotai store); the
 * BootBanner and the level loading pane read it.
 */
import { atom, getDefaultStore } from "jotai";

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

/** Pretty progress text: "213 / 600 MB" or "37 / 152 modules". */
export function formatProgress(s: BootStatus): string | null {
  if (s.loaded === undefined || !s.total) return null;
  if (s.unit === "bytes") {
    const mb = (n: number) => Math.round(n / 1048576);
    return `${mb(s.loaded)} / ${mb(s.total)} MB`;
  }
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
}

export const checkerActivityAtom = atom<CheckerActivity>({
  busy: false,
  switching: false,
  label: "",
});

const SWITCHING_RE =
  /starting the Lean|checking the new imports|imports changed|restarting the checker|preparing the header|preparing the .* environment|loading the .* environment|environment snapshot|downloading|unpacking|installing|Mounting|Verifying|starting Lean/i;

/** `booting`: the first boot has not finished — every stage is a switch then
 * (the stage labels vary: module names, "Starting the Emscripten runtime",
 * … — matching them one by one left the gate flickering between stages). */
export function publishCheckerActivity(state: "busy" | "ready", label: string, booting = false): void {
  const next: CheckerActivity = {
    busy: state === "busy",
    switching: state === "busy" && (booting || SWITCHING_RE.test(label)),
    label,
  };
  const store = getDefaultStore();
  const cur = store.get(checkerActivityAtom);
  if (cur.busy === next.busy && cur.switching === next.switching && cur.label === next.label) return;
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
