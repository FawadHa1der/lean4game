/**
 * The checker's death reasons as the game reads them (pure: unit-tested by
 * death-kind.test.ts, used by game-boot.ts).
 *
 * qed64 HARDENING #52 (vendored at 3b42714) adds two reasons to the relay's
 * `lastDeath`, both decided INSIDE the live worker, so neither can be the
 * link's doing:
 *  - "wedged": the worker's Lean-side liveness probe went unanswered with
 *    work owed (no server frame for ~22 s): every Lean thread froze behind a
 *    lost runtime-mailbox wakeup the 1 s mailbox kick could not heal. The
 *    relay reboots and replays the text like any death (its reboot reason is
 *    "wedged"); the player's proof is kept.
 *  - "exit": the FileWorker exited (a proxied `_proc_exit` /
 *    `exitOnMainThread`), message "lean --worker exited with code N". It is
 *    a CRASH: the replay runs the same content, dies again, and the relay's
 *    breaker halts it — the faithful behaviour; the card names the code.
 * Neither is ever held for the network nor probed as a link problem (the D1
 * probe exists for bare deaths of a worker whose script did not load; a
 * worker that ran a liveness probe or proxied an exit had loaded).
 */
export type DeathLike = { reason: string; message: string } | null | undefined;

/** A death the worker's own liveness / exit hook decided (HARDENING #52). */
export const isRuntimeVerdict = (d: DeathLike): boolean => d?.reason === "wedged" || d?.reason === "exit";

/** The FileWorker's exit code from an "exit" death ("… exited with code N"); null otherwise. */
export function exitCodeOf(d: DeathLike): number | null {
  if (d?.reason !== "exit") return null;
  const m = /exited with code (-?\d+)/.exec(d.message);
  return m ? Number(m[1]) : null;
}

/** While a "wedged" death's replacement boots (every boot stage shows it). */
export const STALLED_LABEL = "the checker stalled and is restarting — your proof is kept";

const exitWords = (d: DeathLike): string => {
  const code = exitCodeOf(d);
  return code === null ? "Lean exited" : `Lean exited with code ${code}`;
};

/** The sticky label of a relay reboot after a #52 death; null for any other
 * reboot (the caller keeps its "restarting the checker after a crash (…)").
 * Keyed on the relay's reboot reason first (lsp-relay.ts: an "exit" death
 * reboots as "crash", a "wedged" one as "wedged"): `lastDeath` outlives its
 * reboot, so a later "user"/"boot" reboot must not repeat an old note. A
 * relay without `rebootReason` (null/undefined) falls back to the death. */
export function rebootNote(rebootReason: string | null | undefined, d: DeathLike): string | null {
  const known = rebootReason !== null && rebootReason !== undefined;
  if (rebootReason === "wedged" || (!known && d?.reason === "wedged")) return STALLED_LABEL;
  if ((rebootReason === "crash" || !known) && d?.reason === "exit") return `${exitWords(d)} — restarting the checker`;
  return null;
}

/** The halted relay's label (the failure card's detail) after a #52 death;
 * null for any other death. An exit names its code: matched by
 * EXIT_CARD_RE in the level pane (main.tsx) for its headline.
 * Only what the LAST death backs: the breaker's 120 s window can mix death
 * kinds (a wedge, then two exits), so no "each time". */
export function haltedNote(d: DeathLike): string | null {
  if (d?.reason === "exit") return `${exitWords(d)} while replaying this level, so the checker stopped retrying`;
  if (d?.reason === "wedged") return "the checker stalled repeatedly (Lean stopped answering) and stopped retrying";
  return null;
}

/** The level pane's test for an exit card: the exit code, or null. */
export const EXIT_CARD_RE = /\bLean exited with code (-?\d+)/;
