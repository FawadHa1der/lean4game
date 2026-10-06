/**
 * The checker's deaths as the game reads them (pure: unit-tested by
 * death-kind.test.ts, used by game-boot.ts), from the relay's `Death`
 * (qed64 docs/EMBEDDING.md §7.2): `reason` (the relay's raw reason),
 * `cause` (the FailureCause qed64 classified — null or absent: no evidence),
 * `exitCode`, and `seq`, the relay's death count. The relay hands out one
 * `lastDeath` object until the next death, but copies (a status snapshot)
 * are not that object: `seq` is the identity.
 *
 * qed64 HARDENING #52 (since qed64 3b42714) adds two reasons, both decided
 * INSIDE the live worker, so neither can be the link's doing:
 *  - "wedged": the worker's Lean-side liveness probe went unanswered with
 *    work owed (no server frame for ~22 s): every Lean thread froze behind a
 *    lost runtime-mailbox wakeup the 1 s mailbox kick could not heal. The
 *    relay reboots and replays the text like any death (its reboot reason is
 *    "wedged"); the player's proof is kept.
 *  - "exit": the FileWorker exited (a proxied `_proc_exit` /
 *    `exitOnMainThread`), its code in `exitCode`. It is a CRASH: the replay
 *    runs the same content, dies again, and the relay's breaker halts it —
 *    the faithful behaviour; the card names the code.
 * Neither is ever held for the network nor probed as a link problem (the D1
 * probe exists for workers whose script did not load; a worker that ran a
 * liveness probe or proxied an exit had loaded).
 */
import { WORKER_SCRIPT_LOAD_FAILED, type Death } from "qed64/embed";
import type { RelayErrorKind } from "./game-translation";

export type DeathLike = (Pick<Death, "reason" | "message"> & Partial<Pick<Death, "seq" | "session" | "exitCode" | "cause">>) | null | undefined;

/** A death the worker's own liveness / exit hook decided (HARDENING #52). */
export const isRuntimeVerdict = (d: DeathLike): boolean => d?.reason === "wedged" || d?.reason === "exit";

/** QED64 docs/EMBEDDING.md §7.7: lean.worker.js refused a sibling script of
 * another revision. The three worker scripts are served under stable names
 * and cached independently, and lean.worker.js loads lsp-front-door.js only
 * on its first LSP frame, so a deploy that lands between the two loads pairs
 * two versions; the worker dies with this code instead of running them
 * (qed64 names the code in the contract but exports no constant). */
export const WORKER_DEP_MISMATCH = "WORKER_DEP_MISMATCH";

/** QD-API-2 (review of phase 2): the site was updated under this page. Not
 * a crash of ours and not the link — this page's bundle is older than the
 * site's workers. The relay's replacement worker loads the new scripts and
 * usually serves again, but under this page's OLD bundle, which holds only
 * while the worker protocol changes additively; a reload loads the new
 * version, so the page says so (the reboot's label, the halted card) and
 * never probes the link for it. Keyed on the code only: the death reaches
 * the relay as the worker's error reply (reason and cause code
 * WORKER_DEP_MISMATCH); the same throw's uncaught `error` event, should it
 * arrive first, is a plain crash. */
export const isStalePageDeath = (d: DeathLike): boolean =>
  d?.reason === WORKER_DEP_MISMATCH || d?.cause?.code === WORKER_DEP_MISMATCH;

/** While the replacement of a stale page's worker boots (sticky, like the #52
 * notes: every boot stage shows it). */
export const STALE_PAGE_LABEL = "this site was updated — restarting the checker; reload the page to use the new version";

/** QD-API-2's residual (the live check of the adoption, 2026-10-04): a
 * stale-page death on the page's FIRST worker arrives at its first LSP frame
 * — the language client's own `initialize` (lean.worker.js loads the front
 * door then) — and orphans that request. The relay heals (its replacement
 * replays the initialize and serves again), but the client's start() has
 * failed and it stays "starting" for good ("Client is not running and can't
 * be stopped"): the pane read "Connecting to the checker…" for ever, and the
 * stale-page card showed on a halt only. A reboot worker's mismatch does not
 * do this (the client's initialize was answered long before). So the card is
 * published, and kept, the moment a relay-invented answer (the translation's
 * onOrphanedRequest) takes the client's `initialize` while the relay's last
 * death is a stale page's — only a reload helps either way. Any OTHER death
 * (or a halt) taking the initialize strands the client the same way with
 * nothing to reload for: game-boot restarts the language client once the
 * relay serves again (QB-2, `initializeLost`). */
export const staleInitialize = (method: string, kind: RelayErrorKind | null, d: DeathLike): boolean =>
  method === "initialize" && kind !== null && isStalePageDeath(d);

/** The label of that card (its facts travel as haltFacts: the pane keys on
 * `stalePage`, never on the label). */
export const STALE_INITIALIZE_LABEL = "this site was updated while the page was loading; reload the page to use the new version";

/** While a "wedged" death's replacement boots (every boot stage shows it). */
export const STALLED_LABEL = "the checker stalled and is restarting — your proof is kept";

const exitWords = (d: DeathLike): string =>
  typeof d?.exitCode === "number" ? `Lean exited with code ${d.exitCode}` : "Lean exited";

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
  // QD-API-2: an unrecoverable worker error reboots as "crash".
  if ((rebootReason === "crash" || !known) && isStalePageDeath(d)) return STALE_PAGE_LABEL;
  return null;
}

/* ---- L4: the link's deaths -------------------------------------------------
 * Read from the death's cause, which qed64 classifies from the worker's error
 * code AND message (failureKindOf): a "snapshot '<name>' failed to load"
 * death carries the snapshot failure's own cause (a cut download, a corrupt
 * or unpaired region, an allocation failure), and RUNTIME_FETCH_FAILED is
 * `missing` for "chunk N: HTTP 404" and `corrupt` for a failed SHA-256 check.
 * (The page used to read the label of the failure the boot reported just
 * before the death — text the next session's first stage reset.) */

/** What a death says of its cause by its own evidence (D4 residuals, live
 * run of f468f2c, and their review):
 *  - "network": the link's (cause kind `network`);
 *  - "silent": nothing — no cause (a bare worker `error` event after the
 *    worker said hello), or a worker script that did not load
 *    (WORKER_SCRIPT_LOAD_FAILED): a worker that never said hello, one that
 *    could not import lsp-frames.js, or one that said hello and then could
 *    not import its lazily loaded sibling lsp-front-door.js
 *    (WORKER_DEP_MISSING, below) — that looks the same offline as on a 404,
 *    so it means "probe the link", not "our crash";
 *  - "own": a cause of its own — a messaged crash ("RuntimeError: memory
 *    access out of bounds"), a heartbeat loss, a snapshot death whose cause
 *    is not the link (SNAPSHOT_UNPAIRED, a SHA-256 mismatch, an allocation
 *    failure, a 404), a #52 verdict, a stale page (WORKER_DEP_MISMATCH). */
export type DeathReading = "network" | "silent" | "own";

/** PAR-4 (review of phase 2), closed upstream in qed64 84d594e (§7.7):
 * lean.worker.js imports lsp-front-door.js on its first LSP frame, after its
 * hello. A load that fails there — on a page no service worker controls when
 * the link drops between the two loads, or on a deploy that lacks the file —
 * used to be the handler's uncaught error, which qed64 read as our crash
 * (code `crash`, Chromium's "Uncaught NetworkError: Failed to execute
 * 'importScripts' …") and this module read back by its message. The worker
 * now posts it as WORKER_DEP_MISSING, drops every later frame and never
 * throws, and qed64's deathCause classifies that code as
 * WORKER_SCRIPT_LOAD_FAILED — the eager import's reading, so no message rule
 * is needed: the link is probed, and the probe's preflight tells a deploy's
 * missing script from the link (death-kind.test.ts runs it on the real
 * worker scripts). */
export function readDeath(d: NonNullable<DeathLike>): DeathReading {
  if (isRuntimeVerdict(d) || isStalePageDeath(d)) return "own";
  const cause = d.cause;
  if (!cause || cause.code === WORKER_SCRIPT_LOAD_FAILED) return "silent";
  return cause.kind === "network" ? "network" : "own";
}

/** Is this death the link's doing, by its cause? */
export const isNetworkDeath = (d: DeathLike): boolean => !!d && readDeath(d) === "network";

/** D4(b) (live run of f468f2c): the network reading of a reboot's death
 * inside a network episode — from a death the link caused until the relay
 * serves again (game-boot `networkEpisode`). A first visit's cut is a burst:
 * the network-shaped bootFailed, then deaths of workers whose scripts could
 * not load (no service worker yet) before the breaker halts; each such
 * reboot read "restarting the checker after a crash (crash)".
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

/** The relay's own label for a session that boots: no death to name, or a
 * reboot that is not waiting for the link. The session's boot stages say
 * more (game-boot publishRelayStatus keeps them over this one). */
export const STARTING_LABEL = "starting the Lean checker";

/** The label of a relay status that replaces its session (game-boot
 * publishRelayStatus): a #52 death's own note; D4 (live 2026-10-03) — a
 * reboot after a death the link caused (`networkDeath`: isNetworkDeath) gets
 * L4's network wording, not "restarting the checker after a crash (snapshot
 * 'nng4' failed to load)" for a "Failed to fetch"; any other death keeps the
 * crash label. The network wording only for a reboot that WAITS for the
 * link: one the death caused (bootFailed / crash / heartbeat, or a relay
 * without `rebootReason`) whose settle has not found the link back yet.
 * `lastDeath` outlives its reboot, and a later "user"/"boot" reboot — the
 * automatic re-arm once the link is back — is not waiting for the link; it
 * is "starting the Lean checker", never "after a crash" (live: "restarting
 * the checker after a crash (crash)" for the re-arm after a 1 s cut). NEW-3
 * (live run of 4083fb4): neither is the reboot whose own settle confirmed
 * the link (`linkConfirmed` — game-boot keys it on the death's `seq`): the
 * replacement's worker reports its status while it boots, and each such
 * status put "waiting for the connection" back between "starting Lean" and
 * "verifying" for a moment after link-back. A status with no death, or not
 * a relay reboot (a serving relay's booting phase), is "starting the Lean
 * checker". */
export function rebootLabel(st: { relay: string; rebootReason?: string | null; lastDeath?: DeathLike }, networkDeath: boolean, linkConfirmed = false): string {
  const d = st.lastDeath;
  if (st.relay === "rebooting") {
    const note = rebootNote(st.rebootReason, d);
    if (note) return note;
  }
  const death = d ? `${d.message || d.reason}` : "";
  if (!death || st.relay !== "rebooting") return STARTING_LABEL;
  if (networkDeath) return st.rebootReason === "user" || st.rebootReason === "boot" || linkConfirmed ? STARTING_LABEL : NETWORK_WAIT_LABEL;
  return `restarting the checker after a crash (${death.slice(0, 80)})`;
}

/** The halted relay's label (the failure card's detail) after a #52 death
 * or a stale page's; null for any other death. An exit names its code.
 * Only what the LAST death backs: the breaker's 120 s window can mix death
 * kinds (a wedge, then two exits), so no "each time". A non-null note is a
 * verdict: game-boot classifyHalt shows it at once — no network probe. */
export function haltedNote(d: DeathLike): string | null {
  if (d?.reason === "exit") return `${exitWords(d)} while replaying this level, so the checker stopped retrying`;
  if (d?.reason === "wedged") return "the checker stalled repeatedly (Lean stopped answering) and stopped retrying";
  if (isStalePageDeath(d)) return "this site was updated while the page was open, so the checker stopped; reload the page";
  return null;
}

/** The halt's facts for the level pane's card (boot-atoms CheckerActivity):
 * the exit code of an "exit" halt (the card's headline names it; null for an
 * exit that reported none — the generic card), whether repeated liveness
 * stalls halted it, and whether a stale page did (QD-API-2: the reload
 * card). Structured: the pane used to parse them back out of haltedNote's
 * label. */
export function haltFacts(d: DeathLike): { exitCode: number | null; stalled: boolean; stalePage: boolean } {
  return { exitCode: d?.reason === "exit" && typeof d.exitCode === "number" ? d.exitCode : null, stalled: d?.reason === "wedged", stalePage: isStalePageDeath(d) };
}

/** A death as the failure card words it: the message, except a boot that
 * failed loading its snapshot — qed64's session names the snapshot by its
 * internal name ("snapshot 'nng4' failed to load"), the card says "the game
 * snapshot" (the cause's stage says which step failed). */
export function deathWords(d: DeathLike): string {
  if (!d) return "";
  if (d.reason === "bootFailed" && d.cause?.stage === "snapshot") return "the game snapshot failed to load";
  return d.message || d.reason;
}
