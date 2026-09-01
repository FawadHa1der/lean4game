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

/** For non-React producers (game-boot's StatusSink). */
export function publishBootStatus(status: BootStatus): void {
  getDefaultStore().set(bootStatusAtom, status);
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
  /starting the Lean|checking the new imports|imports changed|restarting the checker|preparing the header|loading the .* environment|environment snapshot|downloading|unpacking|installing|Mounting|Verifying|starting Lean/i;

export function publishCheckerActivity(state: "busy" | "ready", label: string): void {
  getDefaultStore().set(checkerActivityAtom, {
    busy: state === "busy",
    switching: state === "busy" && SWITCHING_RE.test(label),
    label,
  });
}
