/**
 * The boot banner's words for qed64's boot steps (pure: unit-tested by
 * boot-labels.test.ts, used by game-boot.ts's StatusSink).
 *
 * qed64's labels are prose for its own editor ("labels are for humans and
 * are not API", docs/EMBEDDING.md §7.1): they name a snapshot by its internal
 * name ("preparing the nng4 environment (0.5 GiB — one-time)", "loading the
 * nng4 environment (1.4 GiB unpacked — cached in your browser …)") and carry
 * their own size notes, while the banner shows the byte progress in MB
 * itself — three unit systems met on one line. Every call qed64 makes also
 * says WHICH step it is, structured (`stage`, `step`, `subject`, `error`), so
 * the game's words are chosen from that, never by rewriting the prose:
 *  - the game environment's steps (stage `snapshot`) — downloading or
 *    inflating it into the browser's storage, waiting for another tab that
 *    is doing so, loading it into Lean, and its failure — say "the game
 *    environment" / "the game snapshot", whatever the snapshot is called;
 *  - the per-module progress of loading it (stage `modules`, the subject a
 *    module name such as "Mathlib.Tactic.Attr.Register") is one step;
 *  - every other step keeps qed64's or the worker's own words ("fetching
 *    manifests", "starting Lean", "Verifying lean.js", "Shared Memory64
 *    heap: …"), read mid-sentence ("Lean is starting — verifying lean.js").
 * A label without structure (the game's own: "checking this game's
 * environment", a game switch's wait) is the game's words already.
 */
import type { ProgressInfo } from "qed64/embed";

/** qed64 capitalises some stage names ("Mounting verified library packs");
 * the banner reads them mid-sentence ("Lean is starting — mounting …"). */
const midSentence = (label: string): string =>
  /^[A-Z][a-z]/.test(label) && !/^(Lean|Mathlib|Init)\b/.test(label) ? label[0]!.toLowerCase() + label.slice(1) : label;

export function stageLabel(label: string, info?: ProgressInfo): string {
  switch (info?.stage) {
    case "snapshot":
      if (info.error) return `game snapshot failed: ${info.error.message}`;
      // The region read from the browser's storage, or loaded into Lean.
      if (info.step === "read" || info.step === "load") return "loading the game environment";
      // qed64's prefetch reports bytes (`download`, or `inflate` from a local
      // compressed copy); its wait for another tab's writer (the Web Lock
      // `qed64-raw:<key>`, docs/EMBEDDING.md §7.4) reports none.
      return info.loaded === undefined ? "waiting for another tab to finish preparing the game environment" : "preparing the game environment";
    case "modules":
      return "loading the game's modules";
    default:
      return midSentence(label);
  }
}
