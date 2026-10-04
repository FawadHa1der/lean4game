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
 * reboot (rebootLabel: the network wording or "restarting the checker after
 * a crash (…)").
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

/* ---- L4: the link's deaths -------------------------------------------------
 * Classified by the UNDERLYING error text, never by the generic death (the
 * reasoning is game-boot.ts's L4 block): a "snapshot '<name>' failed to load"
 * death is read through the snapshot failure the boot recorded before it
 * (`snapshotFailure`, qed64-boot's "<name> snapshot failed: <error>"). */
const NETWORK_DETAIL = /Failed to fetch|NetworkError|Load failed|network (error|changed)|ERR_(INTERNET|NETWORK|CONNECTION|TUNNEL|NAME)/i;
const SNAPSHOT_DEATH = /^snapshot '.*' failed to load$/;
/** Is this death the link's doing, by its text? */
export const isNetworkDeath = (d: DeathLike, snapshotFailure: string): boolean =>
  !!d && NETWORK_DETAIL.test(SNAPSHOT_DEATH.test(d.message) ? snapshotFailure : d.message);

/** What a death says of its cause by its own evidence (D4 residuals, live
 * run of f468f2c, and their review):
 *  - "network": the link's (isNetworkDeath);
 *  - "silent": nothing — a bare death (no message: the `error` event of a
 *    worker whose script could not load), or a "snapshot '<name>' failed to
 *    load" with no snapshot failure recorded for it;
 *  - "own": a cause of its own — a messaged crash ("RuntimeError: memory
 *    access out of bounds"), a heartbeat loss, a snapshot death whose
 *    recorded failure is not the link's (SNAPSHOT_UNPAIRED, a SHA-256
 *    mismatch, an allocation failure), a #52 verdict. */
export type DeathReading = "network" | "silent" | "own";

export function readDeath(d: NonNullable<DeathLike>, snapshotFailure: string): DeathReading {
  if (isNetworkDeath(d, snapshotFailure)) return "network";
  if (isRuntimeVerdict(d)) return "own";
  return !d.message || (SNAPSHOT_DEATH.test(d.message) && !snapshotFailure) ? "silent" : "own";
}

/** D4(a) (live run of f468f2c): readDeath, remembered per death object from
 * its first reading. The snapshot failure a "snapshot '<name>' failed to
 * load" death is read through is reset at the next session's "starting
 * Lean" — while the relay still reboots with that SAME death (it hands out
 * one `lastDeath` object until the next death), so every later relay status
 * of the reboot re-read it as a crash: "restarting the checker after a crash
 * (snapshot 'nng4' failed to load)" flashed at link-back and again when the
 * modules finished loading. The first reading has the evidence (qed64-boot
 * reports the failure before the session dies with it). game-boot holds one
 * reader per page. Null: no death. */
export function deathReader(): (d: DeathLike, snapshotFailure: string) => DeathReading | null {
  const readings = new WeakMap<object, DeathReading>();
  return (d, snapshotFailure) => {
    if (!d) return null;
    let reading = readings.get(d);
    if (reading === undefined) { reading = readDeath(d, snapshotFailure); readings.set(d, reading); }
    return reading;
  };
}

/** D4(b) (live run of f468f2c): the network reading of a reboot's death
 * inside a network episode — from a death the link caused until the relay
 * serves again (game-boot `networkEpisode`). A first visit's cut is a burst:
 * the network-shaped bootFailed, then bare "crash" deaths of workers whose
 * scripts could not load (no service worker yet) before the breaker halts;
 * each such reboot read "restarting the checker after a crash (crash)".
 * Inside an episode only a "silent" death (readDeath) is read as the link's
 * too: the episode lasts until a session arms, so it covers the whole
 * reboot after link-back — a death there with evidence of its own (a
 * corrupt or unpaired region, an out-of-bounds crash after a network
 * re-arm) is a crash, not "waiting for the connection" with the link up
 * (review of D4(b)). `network`: the death is the link's by itself. */
export const networkInEpisode = (reading: DeathReading | null, network: boolean, episode: boolean): boolean =>
  network || (episode && reading === "silent");

/** L4's word for a download the network cut: the held boot's banner, and
 * (D4) the reboot after a network-shaped death. */
export const NETWORK_WAIT_LABEL = "waiting for the connection — the download restarts on its own";

/** The label of a relay status that replaces its session (game-boot
 * publishRelayStatus): a #52 death's own note; D4 (live 2026-10-03) — a
 * reboot after a death the link caused (`networkDeath`: isNetworkDeath) gets
 * L4's network wording, not "restarting the checker after a crash (snapshot
 * 'nng4' failed to load)" for a "Failed to fetch"; any other death keeps the
 * crash label. The network wording only for a reboot the death caused
 * (bootFailed / crash / heartbeat, or a relay without `rebootReason`):
 * `lastDeath` outlives its reboot, and a later "user"/"boot" reboot — the
 * automatic re-arm once the link is back (a didChange replay: "user") — is
 * not waiting for the link; it is "starting the Lean checker", never "after a
 * crash" (live: "restarting the checker after a crash (crash)" for the re-arm
 * after a 1 s cut). A status with no death, or not a relay reboot (a serving
 * relay's booting phase), is "starting the Lean checker". */
export function rebootLabel(st: { relay: string; rebootReason?: string | null; lastDeath?: DeathLike }, networkDeath: boolean): string {
  const d = st.lastDeath;
  if (st.relay === "rebooting") {
    const note = rebootNote(st.rebootReason, d);
    if (note) return note;
  }
  const death = d ? `${d.message || d.reason}` : "";
  if (!death || st.relay !== "rebooting") return "starting the Lean checker";
  if (networkDeath) return st.rebootReason === "user" || st.rebootReason === "boot" ? "starting the Lean checker" : NETWORK_WAIT_LABEL;
  return `restarting the checker after a crash (${death.slice(0, 80)})`;
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
