// Run: node --import ./client/src/wasm/ts-resolve-hook.mjs client/src/wasm/death-kind.test.ts
// HARDENING #52 (qed64 3b42714): the game's reading of the two new death
// reasons. "wedged" and "exit" are runtime verdicts (never the link's doing);
// "wedged" reboots under the stalled label; "exit" is a crash whose code the
// reboot label and the halted card name; ordinary deaths keep the old labels.
// D4 (live 2026-10-03): a reboot after a death the link caused reads as L4's
// wait for the connection, not as a crash; a real crash keeps the crash label.
// D4 residuals (live run of f468f2c): (a) a death's reading is remembered
// from its first one (the snapshot failure it was read through is reset
// while the relay still reboots with it); (b) inside a network episode a
// "silent" death reads as the link's too — one with evidence of its own (an
// unpaired or corrupt region, a messaged crash) and #52 verdicts never.
import assert from "node:assert";
import { EXIT_CARD_RE, NETWORK_WAIT_LABEL, STALLED_LABEL, exitCodeOf, haltedNote, isNetworkDeath, isRuntimeVerdict, deathReader, networkInEpisode, readDeath, rebootLabel, rebootNote } from "./death-kind.ts";

const wedged = { reason: "wedged", message: "the Lean runtime stopped answering (no output for 22 s while work was owed; liveness probe unanswered)" };
const exit1 = { reason: "exit", message: "lean --worker exited with code 1" };
const exitNeg = { reason: "exit", message: "lean --worker exited with code -7" };
const exitBare = { reason: "exit", message: "" };
const crash = { reason: "crash", message: "" };
const net = { reason: "bootFailed", message: "RUNTIME_FETCH_FAILED: Failed to fetch" };
const oobCrash = { reason: "crash", message: "Uncaught RuntimeError: memory access out of bounds" };

// runtime verdicts
assert.equal(isRuntimeVerdict(wedged), true);
assert.equal(isRuntimeVerdict(exit1), true);
assert.equal(isRuntimeVerdict(crash), false);
assert.equal(isRuntimeVerdict(net), false);
assert.equal(isRuntimeVerdict(null), false);
assert.equal(isRuntimeVerdict(undefined), false);

// exit codes
assert.equal(exitCodeOf(exit1), 1);
assert.equal(exitCodeOf(exitNeg), -7);
assert.equal(exitCodeOf(exitBare), null);
assert.equal(exitCodeOf(wedged), null);
assert.equal(exitCodeOf({ reason: "crash", message: "lean --worker exited with code 1" }), null); // only an "exit" death

// reboot labels (the relay's rebootReason first: an exit reboots as "crash")
assert.equal(rebootNote("wedged", wedged), STALLED_LABEL);
assert.equal(STALLED_LABEL, "the checker stalled and is restarting — your proof is kept");
assert.equal(rebootNote("crash", exit1), "Lean exited with code 1 — restarting the checker");
assert.equal(rebootNote("crash", exitBare), "Lean exited — restarting the checker");
assert.equal(rebootNote("crash", crash), null);
assert.equal(rebootNote("bootFailed", net), null);
assert.equal(rebootNote("heartbeat", { reason: "heartbeat", message: "" }), null);
// lastDeath outlives its reboot: a later user/boot reboot repeats nothing
assert.equal(rebootNote("user", exit1), null);
assert.equal(rebootNote("user", wedged), null);
assert.equal(rebootNote("boot", wedged), null);
// a relay without rebootReason (pre-3b42714 shape) falls back to the death
assert.equal(rebootNote(undefined, wedged), STALLED_LABEL);
assert.equal(rebootNote(null, exit1), "Lean exited with code 1 — restarting the checker");
assert.equal(rebootNote(null, crash), null);

// halted labels: the exit card names the code, matched by the pane's regex
const h = haltedNote(exit1)!;
assert.match(h, /^Lean exited with code 1 while replaying this level, so the checker stopped retrying$/);
assert.doesNotMatch(h, /each time/); // the window may mix death kinds: claim only the last death
assert.equal(EXIT_CARD_RE.exec(h)?.[1], "1");
assert.equal(EXIT_CARD_RE.exec(haltedNote(exitNeg)!)?.[1], "-7");
assert.equal(EXIT_CARD_RE.exec(haltedNote(exitBare)!), null); // no code: the generic exit wording, no code headline
assert.match(haltedNote(wedged)!, /stalled repeatedly/);
assert.equal(haltedNote(crash), null);
assert.equal(haltedNote(net), null);
assert.equal(haltedNote(null), null);
// the generic halted label never matches the exit card
assert.equal(EXIT_CARD_RE.exec("the checker halted after repeated crashes (snapshot 'nng4' failed to load)"), null);

// D4: the link's deaths, by the underlying text
const snapDeath = { reason: "bootFailed", message: "snapshot 'nng4' failed to load" };
assert.equal(isNetworkDeath(snapDeath, "Failed to fetch"), true); // the live case: read through the recorded snapshot failure
assert.equal(isNetworkDeath(snapDeath, "SNAPSHOT_UNPAIRED: built for another runtime"), false); // a corrupt / unpaired region is no link problem
assert.equal(isNetworkDeath(snapDeath, ""), false);
assert.equal(isNetworkDeath(net, ""), true); // RUNTIME_FETCH_FAILED: Failed to fetch
assert.equal(isNetworkDeath({ reason: "bootFailed", message: "RUNTIME_FETCH_FAILED: chunk 3: HTTP 404" }, ""), false);
assert.equal(isNetworkDeath({ reason: "crash", message: "net::ERR_INTERNET_DISCONNECTED" }, ""), true);
assert.equal(isNetworkDeath(crash, "Failed to fetch"), false); // a bare crash is not read through a snapshot failure
assert.equal(isNetworkDeath(null, "Failed to fetch"), false);

// D4: the reboot label
const rebooting = (rebootReason: string | null | undefined, lastDeath: typeof net | null) => ({ relay: "rebooting", rebootReason, lastDeath });
assert.equal(NETWORK_WAIT_LABEL, "waiting for the connection — the download restarts on its own"); // L4's wording, not a third one
assert.equal(rebootLabel(rebooting("bootFailed", snapDeath), true), NETWORK_WAIT_LABEL);
assert.equal(rebootLabel(rebooting("crash", net), true), NETWORK_WAIT_LABEL);
assert.equal(rebootLabel(rebooting("heartbeat", net), true), NETWORK_WAIT_LABEL);
assert.equal(rebootLabel(rebooting(undefined, net), true), NETWORK_WAIT_LABEL); // a relay without rebootReason
// a real crash keeps the crash label
assert.equal(rebootLabel(rebooting("bootFailed", snapDeath), false), "restarting the checker after a crash (snapshot 'nng4' failed to load)");
assert.equal(rebootLabel(rebooting("crash", { reason: "crash", message: "" }), false), "restarting the checker after a crash (crash)");
assert.equal(rebootLabel(rebooting("crash", { reason: "crash", message: "x".repeat(200) }), false), `restarting the checker after a crash (${"x".repeat(80)})`);
// #52 deaths keep their own labels, whatever the network classification says
assert.equal(rebootLabel(rebooting("wedged", wedged), true), STALLED_LABEL);
assert.equal(rebootLabel(rebooting("crash", exit1), true), "Lean exited with code 1 — restarting the checker");
// lastDeath outlives its reboot: a user/boot reboot (the automatic re-arm once
// the link is back) is not waiting for the link — and was no crash either
assert.equal(rebootLabel(rebooting("user", net), true), "starting the Lean checker");
assert.equal(rebootLabel(rebooting("boot", snapDeath), true), "starting the Lean checker");
assert.equal(rebootLabel(rebooting("user", crash), true), "starting the Lean checker"); // a bare death the halt classified as the link's
// a user restart after a real crash keeps naming it
assert.equal(rebootLabel(rebooting("user", crash), false), "restarting the checker after a crash (crash)");
// no death, or a serving relay's booting phase
assert.equal(rebootLabel(rebooting("boot", null), false), "starting the Lean checker");
assert.equal(rebootLabel({ relay: "serving", rebootReason: null, lastDeath: net }, true), "starting the Lean checker");

// D4(a): the live sequence under an active service worker — the snapshot
// fetch fails ("nng4 snapshot failed: Failed to fetch"), the session dies
// "snapshot 'nng4' failed to load", the hold ends at link-back, the next
// session's "starting Lean" resets the recorded failure, and the relay goes on
// rebooting with the SAME death object: every status of that reboot is read
// again.
{
  const read = deathReader();
  const death = { reason: "bootFailed", message: "snapshot 'nng4' failed to load" };
  assert.equal(rebootLabel(rebooting("bootFailed", death), read(death, "Failed to fetch") === "network"), NETWORK_WAIT_LABEL, "the death's own status");
  assert.equal(read(death, ""), "network", "remembered: the failure it was read through has been reset since");
  assert.equal(rebootLabel(rebooting("bootFailed", death), read(death, "") === "network"), NETWORK_WAIT_LABEL, "link-back / modules loaded: no crash flash");
  // A NEW death (another object, same text) is read on its own evidence: a
  // corrupt region after the link came back is a crash.
  const next = { reason: "bootFailed", message: "snapshot 'nng4' failed to load" };
  assert.equal(read(next, "SNAPSHOT_UNPAIRED: built for another runtime"), "own");
  assert.equal(rebootLabel(rebooting("bootFailed", next), read(next, "Failed to fetch") === "network"), "restarting the checker after a crash (snapshot 'nng4' failed to load)", "its first reading stands too");
  // A messaged crash is remembered as one, a bare one as silent; no death is none.
  assert.equal(read(oobCrash, "Failed to fetch"), "own");
  assert.equal(read(crash, "Failed to fetch"), "silent");
  assert.equal(read(null, "Failed to fetch"), null);
  assert.equal(read(net, ""), "network");
  // Two readers (two pages) share nothing: another one reads the same death
  // afresh — with no failure recorded it says nothing.
  assert.equal(deathReader()(death, ""), "silent");
}

// readDeath: what a death says of its cause by its own evidence.
assert.equal(readDeath({ reason: "crash", message: "" }, ""), "silent", "a worker whose script could not load");
assert.equal(readDeath({ reason: "crash", message: undefined as unknown as string }, ""), "silent", "an `error` Event without a message");
assert.equal(readDeath(snapDeath, "Failed to fetch"), "network");
assert.equal(readDeath(snapDeath, ""), "silent", "no failure recorded for it");
assert.equal(readDeath(snapDeath, "SNAPSHOT_UNPAIRED: built for another runtime"), "own");
assert.equal(readDeath(snapDeath, "SHA-256 mismatch for nng4"), "own");
assert.equal(readDeath(oobCrash, ""), "own", "a messaged crash");
assert.equal(readDeath({ reason: "heartbeat", message: "no heartbeat for 30000 ms and the telemetry probe went unanswered" }, ""), "own");
assert.equal(readDeath(wedged, ""), "own");
assert.equal(readDeath(exit1, "Failed to fetch"), "own");

// D4(b): a first visit's cut is a burst — the network-shaped bootFailed opens
// the episode, then bare "crash" deaths (workers whose scripts could not
// load) before the breaker halts.
{
  const bare = { reason: "crash", message: "" };
  const inEpisode = (d: { reason: string; message: string } | null, failure = "") => networkInEpisode(d ? readDeath(d, failure) : null, false, true);
  assert.equal(networkInEpisode("network", true, false), true, "the death that opens the episode");
  assert.equal(rebootLabel(rebooting("crash", bare), inEpisode(bare)), NETWORK_WAIT_LABEL, "a bare crash inside the episode");
  assert.equal(rebootLabel(rebooting("bootFailed", snapDeath), inEpisode(snapDeath)), NETWORK_WAIT_LABEL, "a snapshot death with no failure recorded");
  // Review of D4(b): the episode lasts until a session arms — it covers the
  // whole reboot after link-back. A death there with evidence of its own is
  // a crash, never "waiting for the connection" with the link up.
  assert.equal(rebootLabel(rebooting("bootFailed", snapDeath), inEpisode(snapDeath, "SNAPSHOT_UNPAIRED: built for another runtime")), "restarting the checker after a crash (snapshot 'nng4' failed to load)", "an unpaired region after link-back");
  assert.equal(rebootLabel(rebooting("bootFailed", snapDeath), inEpisode(snapDeath, "SHA-256 mismatch for nng4")), "restarting the checker after a crash (snapshot 'nng4' failed to load)", "a corrupt region after link-back");
  assert.equal(rebootLabel(rebooting("crash", oobCrash), inEpisode(oobCrash)), "restarting the checker after a crash (Uncaught RuntimeError: memory access out of bounds)", "a messaged crash after a network re-arm");
  // wedged / exit keep their own labels and are never the link's
  assert.equal(inEpisode(wedged), false);
  assert.equal(inEpisode(exit1), false);
  assert.equal(rebootLabel(rebooting("wedged", wedged), inEpisode(wedged)), STALLED_LABEL);
  assert.equal(rebootLabel(rebooting("crash", exit1), inEpisode(exit1)), "Lean exited with code 1 — restarting the checker");
  // outside an episode (the relay served since): a bare crash is a crash
  assert.equal(rebootLabel(rebooting("crash", bare), networkInEpisode(readDeath(bare, ""), false, false)), "restarting the checker after a crash (crash)");
  assert.equal(inEpisode(null), false, "no death: nothing to read");
  // the automatic re-arm inside the episode is still "starting", not a wait
  assert.equal(rebootLabel(rebooting("user", bare), inEpisode(bare)), "starting the Lean checker");
}

console.log("death-kind: all assertions passed");
