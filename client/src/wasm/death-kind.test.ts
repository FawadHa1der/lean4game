// Run: node --import ./client/src/wasm/ts-resolve-hook.mjs client/src/wasm/death-kind.test.ts
// The game's reading of the relay's deaths, from qed64's structured `Death`
// (docs/EMBEDDING.md §7.2: reason, cause — null = no evidence —, exitCode,
// seq). Every death here is built the way qed64 builds it: ResidentSession
// classifies LeanSession's facts (deathCause), a failed boot step throws
// with failureCauseOf's cause, and the last block drives the REAL LspRelay
// so the objects are the relay's own.
// HARDENING #52 (qed64 3b42714): "wedged" and "exit" are runtime verdicts
// (never the link's doing); "wedged" reboots under the stalled label; "exit"
// is a crash whose code (Death.exitCode) the reboot label and the halted
// card name; ordinary deaths keep the old labels.
// D4 (live 2026-10-03): a reboot after a death the link caused reads as L4's
// wait for the connection, not as a crash; a real crash keeps the crash label.
// D4 residuals (live run of f468f2c): (a) a death's reading is its own — a
// "snapshot 'nng4' failed to load" death carries the snapshot failure's
// cause (it used to be read through a label the next session reset); (b)
// inside a network episode a "silent" death — no cause, or a worker script
// that did not load — reads as the link's too; one with evidence of its own
// (an unpaired or corrupt region, a messaged crash) and #52 verdicts never.
// NEW-3 (live run of 4083fb4): once the reboot's settle found the link back,
// its statuses read "starting", not "waiting for the connection". The halt's
// facts (exit code, repeated stall, stale page) reach the level pane's atom
// as data.
// Review of phase 2: PAR-4 — a worker that said hello and then could not
// import its lazily loaded sibling (lsp-front-door.js) posts
// WORKER_DEP_MISSING (qed64 84d594e; it was the handler's uncaught throw,
// read as our crash) and reads "silent" (probe the link); QD-API-2 —
// WORKER_DEP_MISMATCH (a deploy mixed the worker scripts' revisions) is a
// stale page: its own reboot label and halted card (reload), never probed as
// the link. Both also on the REAL worker scripts (the last block).
// QD-API-2's residual: a stale-page death that orphans the client's own
// `initialize` is the card without a halt (staleInitialize).
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { LeanSession, LspRelay, WORKER_SCRIPT_LOAD_FAILED, deathCause, failureCauseOf, type FailureCause, type JsonRpcMessage, type RelaySession, type RelayStatus, type WorkerStatus } from "qed64/embed";
import { NETWORK_WAIT_LABEL, STALE_INITIALIZE_LABEL, STALE_PAGE_LABEL, STALLED_LABEL, STARTING_LABEL, WORKER_DEP_MISMATCH, deathWords, haltFacts, haltedNote, isNetworkDeath, isRuntimeVerdict, isStalePageDeath, networkInEpisode, readDeath, rebootLabel, rebootNote, staleInitialize } from "./death-kind.ts";

type D = { reason: string; message: string; seq: number; session: string; exitCode?: number; cause?: FailureCause };
let seq = 0;
const death = (reason: string, message: string, cause: FailureCause | null, exitCode?: number): D =>
  ({ reason, message, seq: ++seq, session: "s1", ...(typeof exitCode === "number" ? { exitCode } : {}), ...(cause ? { cause } : {}) });
/** A worker-reported death, classified as ResidentSession does. */
const workerDied = (reason: string, message: string, facts: Parameters<typeof deathCause>[2] = {}, exitCode?: number): D =>
  death(reason, message, deathCause(reason, message, facts), exitCode);
/** A failed boot step: the session's throw carries failureCauseOf's cause. */
const bootFailed = (message: string, err: Error, at: { stage?: "snapshot" | "runtime"; subject?: string }): D =>
  death("bootFailed", message, failureCauseOf(err, at));
const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

const wedged = workerDied("wedged", "the Lean runtime stopped answering (no output for 22 s while work was owed; liveness probe unanswered)");
const exit1 = workerDied("exit", "lean --worker exited with code 1", {}, 1);
const exitNeg = workerDied("exit", "lean --worker exited with code -7", {}, -7);
const exitBare = workerDied("exit", "");
const bare = workerDied("crash", "", { bare: true, beforeHello: false }); // an `error` event after hello: no evidence
const scriptLoad = workerDied("crash", "", { bare: true, beforeHello: true }); // the D1 shape: the script never ran
const depMissing = workerDied("WORKER_DEP_MISSING", "lean.worker.js needs lsp-frames.js served beside it: NetworkError", { errorCode: "WORKER_DEP_MISSING" });
const oobCrash = workerDied("crash", "Uncaught RuntimeError: memory access out of bounds", { bare: false, beforeHello: false });
const heartbeat = workerDied("heartbeat", "no heartbeat for 6000 ms and the telemetry probe went unanswered");
const runtimeCut = workerDied("RUNTIME_FETCH_FAILED", "Failed to fetch", { errorCode: "RUNTIME_FETCH_FAILED" });
const chunk404 = workerDied("RUNTIME_FETCH_FAILED", "chunk 3: HTTP 404", { errorCode: "RUNTIME_FETCH_FAILED" });
const snapAt = { stage: "snapshot" as const, subject: "nng4" };
const snapCut = bootFailed("snapshot 'nng4' failed to load", coded("Failed to fetch", "SNAPSHOT_FAILED"), snapAt);
const snapFirefoxCut = bootFailed("snapshot 'nng4' failed to load", coded("NetworkError when attempting to fetch resource.", "SNAPSHOT_FAILED"), snapAt);
const snapUnpaired = bootFailed("snapshot 'nng4' failed to load", coded("snapshot 'nng4' was baked for runtime wasm64-aaaaaaaaaaaaaaaa, this runtime is wasm64-bbbbbbbbbbbbbbbb", "SNAPSHOT_UNPAIRED"), snapAt);
const snapCorrupt = bootFailed("snapshot 'nng4' failed to load", coded("SHA-256 verification failed for nng4", "SNAPSHOT_FAILED"), snapAt);
const snapOom = bootFailed("snapshot 'nng4' failed to load", coded("could not allocate 1.4 GiB for the region", "SNAPSHOT_FAILED"), snapAt);
// PAR-4: the lazy sibling import failed after the hello — the worker's structured death (qed64 84d594e).
const frontDoorMissing = workerDied("WORKER_DEP_MISSING", "lean.worker.js needs lsp-front-door.js served beside it: Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at 'https://l4g.test/workers/lsp-front-door.js' failed to load.", { errorCode: "WORKER_DEP_MISSING" });
// QD-API-2: the worker's error reply refusing a sibling of another revision.
const depMismatchMessage = "lsp-front-door.js is revision \"2\", lean.worker.js needs 1 (a deploy mixed versions; reload)";
const depMismatch = workerDied(WORKER_DEP_MISMATCH, depMismatchMessage, { errorCode: WORKER_DEP_MISMATCH });

const rebooting0 = (rebootReason: string | null | undefined, lastDeath: D | null) => ({ relay: "rebooting", rebootReason, lastDeath });

// runtime verdicts
assert.equal(isRuntimeVerdict(wedged), true);
assert.equal(isRuntimeVerdict(exit1), true);
assert.equal(isRuntimeVerdict(bare), false);
assert.equal(isRuntimeVerdict(runtimeCut), false);
assert.equal(isRuntimeVerdict(null), false);
assert.equal(isRuntimeVerdict(undefined), false);

// exit codes: the relay's `exitCode`, never parsed from the message
assert.deepEqual(haltFacts(exit1), { exitCode: 1, stalled: false, stalePage: false });
assert.deepEqual(haltFacts(exitNeg), { exitCode: -7, stalled: false, stalePage: false });
assert.deepEqual(haltFacts(exitBare), { exitCode: null, stalled: false, stalePage: false }, "an exit that reported no code: the generic card");
assert.deepEqual(haltFacts(wedged), { exitCode: null, stalled: true, stalePage: false });
assert.deepEqual(haltFacts({ ...oobCrash, exitCode: 1 }), { exitCode: null, stalled: false, stalePage: false }, "only an \"exit\" death's code is an exit code");
assert.deepEqual(haltFacts({ reason: "exit", message: "lean --worker exited with code 9" }), { exitCode: null, stalled: false, stalePage: false }, "the message is not read");
assert.deepEqual(haltFacts(null), { exitCode: null, stalled: false, stalePage: false });

// reboot labels (the relay's rebootReason first: an exit reboots as "crash")
assert.equal(rebootNote("wedged", wedged), STALLED_LABEL);
assert.equal(STALLED_LABEL, "the checker stalled and is restarting — your proof is kept");
assert.equal(rebootNote("crash", exit1), "Lean exited with code 1 — restarting the checker");
assert.equal(rebootNote("crash", exitNeg), "Lean exited with code -7 — restarting the checker");
assert.equal(rebootNote("crash", exitBare), "Lean exited — restarting the checker");
assert.equal(rebootNote("crash", bare), null);
assert.equal(rebootNote("bootFailed", runtimeCut), null);
assert.equal(rebootNote("heartbeat", heartbeat), null);
// lastDeath outlives its reboot: a later user/boot reboot repeats nothing
assert.equal(rebootNote("user", exit1), null);
assert.equal(rebootNote("user", wedged), null);
assert.equal(rebootNote("boot", wedged), null);
// a relay without rebootReason falls back to the death
assert.equal(rebootNote(undefined, wedged), STALLED_LABEL);
assert.equal(rebootNote(null, exit1), "Lean exited with code 1 — restarting the checker");
assert.equal(rebootNote(null, bare), null);

// halted labels: the exit card names the code
const h = haltedNote(exit1)!;
assert.match(h, /^Lean exited with code 1 while replaying this level, so the checker stopped retrying$/);
assert.doesNotMatch(h, /each time/); // the window may mix death kinds: claim only the last death
assert.equal(haltedNote(exitNeg), "Lean exited with code -7 while replaying this level, so the checker stopped retrying");
assert.equal(haltedNote(exitBare), "Lean exited while replaying this level, so the checker stopped retrying");
assert.match(haltedNote(wedged)!, /stalled repeatedly/);
assert.equal(haltedNote(bare), null);
assert.equal(haltedNote(runtimeCut), null);
assert.equal(haltedNote(null), null);

// readDeath: what a death says of its cause by its own evidence
assert.equal(readDeath(snapCut), "network", "D4(a): the snapshot death carries its failure's cause — no label to read it through");
assert.equal(readDeath(snapFirefoxCut), "network");
assert.equal(readDeath(runtimeCut), "network");
assert.equal(readDeath(snapUnpaired), "own");
assert.equal(readDeath(snapCorrupt), "own");
assert.equal(readDeath(snapOom), "own");
assert.equal(readDeath(chunk404), "own", "a chunk the deploy lacks is no link problem");
assert.equal(readDeath(oobCrash), "own", "a messaged crash");
assert.equal(readDeath(heartbeat), "own");
assert.equal(readDeath(wedged), "own");
assert.equal(readDeath(exit1), "own");
assert.equal(readDeath({ ...exit1, cause: runtimeCut.cause }), "own", "a #52 verdict whatever its cause says");
assert.equal(readDeath(bare), "silent", "no cause: no evidence");
assert.equal(bare.cause, undefined);
assert.equal(readDeath(scriptLoad), "silent", "WORKER_SCRIPT_LOAD_FAILED: probe the link, not our crash");
assert.equal(scriptLoad.cause?.code, WORKER_SCRIPT_LOAD_FAILED);
assert.equal(readDeath(depMissing), "silent", "a sibling script that did not load is no crash of ours either");
assert.equal(readDeath({ reason: "crash", message: "Worker crashed: x", cause: undefined }), "silent");
// PAR-4 (closed upstream): the failed lazy import is WORKER_DEP_MISSING, which
// qed64 classifies as WORKER_SCRIPT_LOAD_FAILED — offline and on a 404 alike:
// probe the link. No death is read by its message any more (the old rule read
// a `crash` naming importScripts / NetworkError as "silent").
assert.deepEqual([frontDoorMissing.cause?.kind, frontDoorMissing.cause?.code], ["other", WORKER_SCRIPT_LOAD_FAILED], "qed64's own reading of it");
assert.equal(readDeath(frontDoorMissing), "silent");
assert.equal(isNetworkDeath(frontDoorMissing), false, "no evidence of the link by itself — the probe decides");
assert.equal(readDeath(workerDied("crash", "Uncaught NetworkError: Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at 'https://l4g.test/workers/lsp-front-door.js' failed to load.", { bare: false, beforeHello: false })), "own", "a messaged crash is the checker's own, whatever the message says (the worker no longer throws for a failed import)");
assert.equal(readDeath(workerDied("heartbeat", "no heartbeat; NetworkError", {})), "own");
assert.equal(rebootLabel(rebooting0("crash", frontDoorMissing), networkInEpisode(readDeath(frontDoorMissing), false, true)), NETWORK_WAIT_LABEL, "inside a network episode: the link's wording, not \"after a crash (…)\"");
// QD-API-2: a stale page — its own verdict, never the link's, never a crash label
assert.deepEqual([depMismatch.reason, depMismatch.cause?.kind, depMismatch.cause?.code], [WORKER_DEP_MISMATCH, "other", WORKER_DEP_MISMATCH], "qed64's classification of the error reply");
assert.equal(isStalePageDeath(depMismatch), true);
assert.equal(isStalePageDeath({ reason: "crash", message: "x", cause: { kind: "other", code: WORKER_DEP_MISMATCH, message: "x" } }), true, "by the cause's code");
assert.equal(isStalePageDeath(oobCrash), false);
assert.equal(isStalePageDeath(depMissing), false, "a missing sibling is the link or a deploy, not a stale page");
assert.equal(isStalePageDeath(null), false);
assert.equal(readDeath(depMismatch), "own");
assert.equal(isNetworkDeath(depMismatch), false);
assert.equal(networkInEpisode(readDeath(depMismatch), false, true), false, "not the link's, even inside an episode");
assert.equal(rebootNote("crash", depMismatch), STALE_PAGE_LABEL, "an unrecoverable worker error reboots as \"crash\"");
assert.equal(rebootNote(null, depMismatch), STALE_PAGE_LABEL);
assert.equal(rebootNote("user", depMismatch), null, "lastDeath outlives its reboot: a later restart repeats nothing");
assert.match(STALE_PAGE_LABEL, /reload the page/);
assert.match(haltedNote(depMismatch)!, /^this site was updated while the page was open, so the checker stopped; reload the page$/);
assert.deepEqual(haltFacts(depMismatch), { exitCode: null, stalled: false, stalePage: true });
// QD-API-2's residual: the client's own `initialize` taken by a stale-page
// death — the card without a halt. Keyed on the method, the relay's word
// (a kind) and the death; never on a request of another method, the
// checker's own answer, or another death.
assert.equal(staleInitialize("initialize", "orphaned", depMismatch), true);
assert.equal(staleInitialize("initialize", "halted", depMismatch), true, "refused by a halt on it: the same card the halt shows");
assert.equal(staleInitialize("textDocument/hover", "orphaned", depMismatch), false, "another request orphaned: the reboot's label says it");
assert.equal(staleInitialize("initialize", null, depMismatch), false, "the checker's own answer is no orphaning");
assert.equal(staleInitialize("initialize", "orphaned", oobCrash), false, "a crash orphaning the initialize is not a stale page");
assert.equal(staleInitialize("initialize", "orphaned", frontDoorMissing), false, "nor a missing sibling (the link or a deploy)");
assert.equal(staleInitialize("initialize", "orphaned", null), false);
assert.match(STALE_INITIALIZE_LABEL, /reload the page/);
assert.equal(isNetworkDeath(snapCut), true);
assert.equal(isNetworkDeath(snapUnpaired), false);
assert.equal(isNetworkDeath(bare), false);
assert.equal(isNetworkDeath(null), false);

// D4: the reboot label
const rebooting = rebooting0;
assert.equal(NETWORK_WAIT_LABEL, "waiting for the connection — the download restarts on its own"); // L4's wording, not a third one
assert.equal(rebootLabel(rebooting("bootFailed", snapCut), isNetworkDeath(snapCut)), NETWORK_WAIT_LABEL);
assert.equal(rebootLabel(rebooting("crash", runtimeCut), true), NETWORK_WAIT_LABEL);
assert.equal(rebootLabel(rebooting("heartbeat", runtimeCut), true), NETWORK_WAIT_LABEL);
assert.equal(rebootLabel(rebooting(undefined, runtimeCut), true), NETWORK_WAIT_LABEL); // a relay without rebootReason
// a real crash keeps the crash label
assert.equal(rebootLabel(rebooting("bootFailed", snapUnpaired), isNetworkDeath(snapUnpaired)), "restarting the checker after a crash (snapshot 'nng4' failed to load)");
assert.equal(rebootLabel(rebooting("crash", bare), false), "restarting the checker after a crash (crash)");
assert.equal(rebootLabel(rebooting("crash", { ...oobCrash, message: "x".repeat(200) }), false), `restarting the checker after a crash (${"x".repeat(80)})`);
// #52 deaths keep their own labels, whatever the network classification says
assert.equal(rebootLabel(rebooting("wedged", wedged), true), STALLED_LABEL);
assert.equal(rebootLabel(rebooting("crash", exit1), true), "Lean exited with code 1 — restarting the checker");
// QD-API-2: so does a stale page — the label says a reload helps (the crash
// label cut the 91-character message at 80: "…(a deploy mixed versio)")
assert.equal(rebootLabel(rebooting("crash", depMismatch), false), STALE_PAGE_LABEL);
// lastDeath outlives its reboot: a user/boot reboot (the automatic re-arm once
// the link is back) is not waiting for the link — and was no crash either
assert.equal(rebootLabel(rebooting("user", runtimeCut), true), STARTING_LABEL);
assert.equal(rebootLabel(rebooting("boot", snapCut), true), STARTING_LABEL);
assert.equal(rebootLabel(rebooting("user", bare), true), STARTING_LABEL); // a bare death the halt classified as the link's
// a user restart after a real crash keeps naming it
assert.equal(rebootLabel(rebooting("user", bare), false), "restarting the checker after a crash (crash)");
// no death, or a serving relay's booting phase
assert.equal(rebootLabel(rebooting("boot", null), false), STARTING_LABEL);
assert.equal(rebootLabel({ relay: "serving", rebootReason: null, lastDeath: runtimeCut }, true), STARTING_LABEL);

// NEW-3: the reboot whose settle confirmed the link is starting, not waiting
assert.equal(rebootLabel(rebooting("bootFailed", snapCut), true, true), STARTING_LABEL, "link-back: no network flash between \"starting Lean\" and \"verifying\"");
assert.equal(rebootLabel(rebooting("bootFailed", snapCut), true, false), NETWORK_WAIT_LABEL, "still waiting before the settle's verdict");
assert.equal(rebootLabel(rebooting("crash", oobCrash), false, true), "restarting the checker after a crash (Uncaught RuntimeError: memory access out of bounds)", "a crash is named whatever the link");
assert.equal(rebootLabel(rebooting("wedged", wedged), false, true), STALLED_LABEL, "a #52 note stays");

// D4(b): a first visit's cut is a burst — the network-shaped bootFailed opens
// the episode, then workers whose scripts could not load before the breaker halts.
{
  const inEpisode = (d: D | null) => networkInEpisode(d ? readDeath(d) : null, false, true);
  assert.equal(networkInEpisode("network", true, false), true, "the death that opens the episode");
  assert.equal(rebootLabel(rebooting("crash", scriptLoad), inEpisode(scriptLoad)), NETWORK_WAIT_LABEL, "a worker script that did not load, inside the episode");
  assert.equal(rebootLabel(rebooting("crash", bare), inEpisode(bare)), NETWORK_WAIT_LABEL, "a bare death inside the episode");
  // Review of D4(b): the episode lasts until a session arms — it covers the
  // whole reboot after link-back. A death there with evidence of its own is
  // a crash, never "waiting for the connection" with the link up.
  assert.equal(rebootLabel(rebooting("bootFailed", snapUnpaired), inEpisode(snapUnpaired)), "restarting the checker after a crash (snapshot 'nng4' failed to load)", "an unpaired region after link-back");
  assert.equal(rebootLabel(rebooting("bootFailed", snapCorrupt), inEpisode(snapCorrupt)), "restarting the checker after a crash (snapshot 'nng4' failed to load)", "a corrupt region after link-back");
  assert.equal(rebootLabel(rebooting("crash", oobCrash), inEpisode(oobCrash)), "restarting the checker after a crash (Uncaught RuntimeError: memory access out of bounds)", "a messaged crash after a network re-arm");
  // wedged / exit keep their own labels and are never the link's
  assert.equal(inEpisode(wedged), false);
  assert.equal(inEpisode(exit1), false);
  assert.equal(rebootLabel(rebooting("wedged", wedged), inEpisode(wedged)), STALLED_LABEL);
  assert.equal(rebootLabel(rebooting("crash", exit1), inEpisode(exit1)), "Lean exited with code 1 — restarting the checker");
  // outside an episode (the relay served since): a bare crash is a crash
  assert.equal(rebootLabel(rebooting("crash", bare), networkInEpisode(readDeath(bare), false, false)), "restarting the checker after a crash (crash)");
  assert.equal(inEpisode(null), false, "no death: nothing to read");
  // the automatic re-arm inside the episode is still "starting", not a wait
  assert.equal(rebootLabel(rebooting("user", bare), inEpisode(bare)), STARTING_LABEL);
}

// The failure card's words: a snapshot boot failure says "the game snapshot"
// (qed64 names the snapshot by its internal name); everything else verbatim.
assert.equal(deathWords(snapCut), "the game snapshot failed to load");
assert.equal(deathWords(snapUnpaired), "the game snapshot failed to load");
assert.equal(deathWords(chunk404), "chunk 3: HTTP 404");
assert.equal(deathWords(oobCrash), "Uncaught RuntimeError: memory access out of bounds");
assert.equal(deathWords(bare), "crash");
assert.equal(deathWords(bootFailed("runtime manifest: HTTP 404", new Error("runtime manifest: HTTP 404"), { stage: "runtime" })), "runtime manifest: HTTP 404");
assert.equal(deathWords(null), "");

// The relay's own deaths: the REAL LspRelay over scripted sessions. Each
// death's object is what game-boot reads off `relay.status().lastDeath`.
{
  type Script = { start?: () => Promise<void> };
  const scripts: Script[] = [];
  const sessions: FakeSession[] = [];
  class FakeSession implements RelaySession {
    static n = 0;
    readonly id = `fs${++FakeSession.n}`;
    onLsp: (msg: JsonRpcMessage) => void = () => {};
    onStatus: (status: WorkerStatus) => void = () => {};
    onDied: (code: number | null, reason: string, message: string, cause?: unknown) => void = () => {};
    private readonly script: Script;
    constructor() { this.script = scripts.shift() ?? {}; sessions.push(this); }
    start(): Promise<void> { return this.script.start?.() ?? Promise.resolve(); }
    arm(): Promise<void> { return Promise.resolve(); }
    lsp(): void {}
    dispose(): void {}
    terminate(): void {}
  }
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r)); };
  const relay = new LspRelay(() => new FakeSession(), { status: () => {} }, () => Promise.resolve());
  await flush();
  assert.equal(relay.status().relay, "serving");
  // The replacement's snapshot download will be cut: its start() throws with
  // the cause (the relay makes the replacement in the death's own turn).
  scripts.push({ start: () => Promise.reject(Object.assign(new Error("snapshot 'nng4' failed to load"), { cause: failureCauseOf(coded("Failed to fetch", "SNAPSHOT_FAILED"), snapAt) })) });
  scripts.push({ start: () => new Promise<void>(() => {}) }); // the one after it is still booting
  // A FileWorker exit, as ResidentSession reports it (code, reason, message, cause).
  sessions[0]!.onDied(1, "exit", "lean --worker exited with code 1", deathCause("exit", "lean --worker exited with code 1", {}));
  const exitDeath = relay.status().lastDeath!;
  assert.deepEqual([exitDeath.reason, exitDeath.exitCode, exitDeath.seq, exitDeath.session], ["exit", 1, 1, sessions[0]!.id]);
  assert.deepEqual(haltFacts(exitDeath), { exitCode: 1, stalled: false, stalePage: false });
  assert.equal(rebootLabel(relay.status(), isNetworkDeath(exitDeath)), "Lean exited with code 1 — restarting the checker");
  await flush();
  const cut = relay.status().lastDeath!;
  assert.deepEqual([cut.reason, cut.seq, cut.cause?.kind, cut.cause?.stage], ["bootFailed", 2, "network", "snapshot"]);
  assert.equal(readDeath(cut), "network");
  assert.equal(relay.status().rebootReason, "bootFailed");
  assert.equal(rebootLabel(relay.status(), isNetworkDeath(cut)), NETWORK_WAIT_LABEL);
  assert.equal(rebootLabel(relay.status(), isNetworkDeath(cut), true), STARTING_LABEL, "NEW-3");
  assert.equal(deathWords(cut), "the game snapshot failed to load");
  // A bare worker error after hello: no cause at all (no evidence).
  await flush();
  sessions[sessions.length - 1]!.onDied(null, "crash", "", deathCause("crash", "", { bare: true, beforeHello: false }));
  const silent = relay.status().lastDeath!;
  assert.deepEqual([silent.reason, silent.seq, "cause" in silent], ["crash", 3, false]);
  assert.equal(readDeath(silent), "silent");
  assert.equal(relay.status().relay, "halted", "three deaths in two minutes: the breaker");
  // The halt's death keeps its seq through copies — the identity game-boot keys on.
  assert.equal({ ...relay.status().lastDeath! }.seq, 3);
  relay.clientPort.close(); // the relay's channel would keep node running
}

// The halt's facts reach the level pane as data (boot-atoms CheckerActivity):
// the card's headline reads `exitCode` / `stalled`, never the label.
{
  const { checkerActivityAtom, publishCheckerActivity } = await import("../store/boot-atoms");
  const { getDefaultStore } = await import("jotai");
  const activity = () => getDefaultStore().get(checkerActivityAtom);
  publishCheckerActivity("ready", haltedNote(exitNeg)!, false, false, haltFacts(exitNeg));
  assert.deepEqual([activity().halted, activity().exitCode, activity().stalled], [true, -7, false]);
  publishCheckerActivity("ready", haltedNote(wedged)!, false, false, haltFacts(wedged));
  assert.deepEqual([activity().halted, activity().exitCode, activity().stalled], [true, null, true]);
  publishCheckerActivity("ready", haltedNote(depMismatch)!, false, false, haltFacts(depMismatch));
  assert.deepEqual([activity().halted, activity().exitCode, activity().stalled, activity().stalePage], [true, null, false, true], "QD-API-2: the reload card's fact");
  // The latched card (game-boot latchStalePage) publishes the same facts under its own label: the pane keys on `stalePage`.
  publishCheckerActivity("ready", STALE_INITIALIZE_LABEL, false, false, haltFacts(depMismatch));
  assert.deepEqual([activity().halted, activity().stalePage, activity().label], [true, true, STALE_INITIALIZE_LABEL], "QD-API-2's residual: the card without a halt");
  publishCheckerActivity("ready", "Lean exited with code 3 while replaying this level", false, false, true);
  assert.deepEqual([activity().halted, activity().exitCode, activity().stalled], [true, null, false], "a plain halt names no code, whatever its label says");
  publishCheckerActivity("ready", "ready");
  assert.deepEqual([activity().halted, activity().exitCode, activity().stalled, activity().stalePage], [false, null, false, false], "facts go with the halt");
  // B5: the gate's `switching` is the caller's fact, else the first boot's — no label regex.
  publishCheckerActivity("busy", "loading the game environment");
  assert.equal(activity().switching, false, "a stage label alone switches nothing");
  publishCheckerActivity("busy", "elaborating", true);
  assert.equal(activity().switching, true, "every stage of the first boot is a switch");
  publishCheckerActivity("busy", "restarting the checker after a crash (crash)", false, true);
  assert.equal(activity().switching, true);
}

// PAR-4 and QD-API-2 on the REAL worker scripts of the pinned qed64 package:
// lean.worker.js in a vm sandbox whose importScripts serves its siblings —
// as installed, a newer deploy's front door (REVISION "2", the only change),
// or a failed load — under the real LeanSession (over a Worker shim), with
// ResidentSession's cause mapping (deathCause; no boot stage once started)
// and the real LspRelay. The deaths are the relay's own objects.
{
  const workers = path.join(path.dirname(createRequire(import.meta.url).resolve("qed64/package.json")), "public/workers");
  const read = (name: string) => readFileSync(path.join(workers, name), "utf8");
  /** What the origin serves for a sibling import right now (throws: the load failed). */
  let sibling: (name: string) => string = read;
  const tick = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r)); };
  type Listener = (e: { data?: unknown; message?: string }) => void;
  class WorkerShim {
    private readonly page = new Map<string, Listener[]>();
    private readonly inside: Listener[] = [];
    private readonly loaded: Promise<void>;
    private readonly ctx: vm.Context;
    constructor(_url: string) {
      const sb: Record<string, unknown> = {
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms).unref(), clearTimeout,
        setInterval: (fn: () => void, ms: number) => setInterval(fn, ms).unref(), clearInterval,
        performance, TextEncoder, TextDecoder, structuredClone, URL, navigator: {}, close() {},
      };
      sb.self = sb;
      sb.postMessage = (m: unknown) => { const data = structuredClone(m); setImmediate(() => this.emit("message", { data })); };
      sb.addEventListener = (type: string, fn: Listener) => { if (type === "message") this.inside.push(fn); };
      sb.importScripts = (name: string) => { vm.runInContext(sibling(name), this.ctx, { filename: name }); };
      this.ctx = vm.createContext(sb);
      const main = read("lean.worker.js");
      this.loaded = new Promise((r) => setImmediate(() => { vm.runInContext(main, this.ctx, { filename: "lean.worker.js" }); r(); }));
    }
    private emit(type: string, e: { data?: unknown; message?: string }) { for (const fn of this.page.get(type) ?? []) fn(e); }
    addEventListener(type: string, fn: Listener) { this.page.set(type, [...(this.page.get(type) ?? []), fn]); }
    removeEventListener() {}
    postMessage(m: unknown) {
      const data = structuredClone(m);
      void this.loaded.then(() => setImmediate(() => {
        for (const fn of this.inside) {
          // An uncaught throw in the worker's handler: the page's `error`
          // event, after the messages the worker posted before it.
          try { fn({ data }); } catch (e) { const err = e as Error; setImmediate(() => setImmediate(() => this.emit("error", { message: `Uncaught ${err.name}: ${err.message}` }))); }
        }
      }));
    }
    terminate() {}
  }
  (globalThis as { Worker?: unknown }).Worker = WorkerShim;
  class Session implements RelaySession {
    private readonly lean = new LeanSession("/workers/lean.worker.js");
    readonly id = this.lean.id;
    set onLsp(f: (msg: JsonRpcMessage) => void) { this.lean.onLsp = f; }
    set onStatus(f: (status: WorkerStatus) => void) { this.lean.onStatus = f; }
    set onDied(f: (code: number | null, reason: string, message: string, cause?: unknown) => void) {
      this.lean.onDied = (code, reason, message, facts) => f(code, reason, message, deathCause(reason, message, facts, {}));
    }
    start(): Promise<void> { return Promise.resolve(); } // the wasm boot is not what is tested
    arm(): Promise<void> { return Promise.resolve(); }
    lsp(msg: JsonRpcMessage, replay?: boolean): void { this.lean.lsp(msg, replay); }
    dispose(): void { this.lean.dispose(); }
    terminate(): void { this.lean.terminate(); }
  }
  /** Boot a relay, let the worker load, then serve `next` for its siblings and
   * send the first LSP frame (the worker imports its front door now). The
   * status of the reboot that death caused. */
  const firstFrameDeath = async (next: (name: string) => string): Promise<RelayStatus> => {
    sibling = read;
    const statuses: RelayStatus[] = [];
    const relay = new LspRelay(() => new Session(), { status: (st) => statuses.push(st) }, () => new Promise(() => {}));
    await tick();
    assert.equal(relay.status().relay, "serving");
    sibling = next;
    relay.clientPort.postMessage({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
    await tick();
    relay.clientPort.close();
    const st = statuses.find((x) => x.relay === "rebooting");
    assert.ok(st?.lastDeath, "the first frame killed the worker");
    return st;
  };
  // QD-API-2: a deploy lands between the worker's load and its front door's.
  const newer = await firstFrameDeath((name) => {
    const text = read(name);
    if (name !== "lsp-front-door.js") return text;
    const bumped = text.replace('REVISION: "1" };', 'REVISION: "2" };');
    assert.notEqual(bumped, text, "the front door's REVISION marker moved — update this test");
    return bumped;
  });
  const dm = newer.lastDeath!;
  assert.deepEqual([dm.reason, dm.cause?.code, newer.rebootReason], [WORKER_DEP_MISMATCH, WORKER_DEP_MISMATCH, "crash"]);
  assert.match(dm.message, /lsp-front-door\.js is revision "2", lean\.worker\.js needs 1/);
  assert.equal(isStalePageDeath(dm), true);
  assert.equal(readDeath(dm), "own");
  assert.equal(rebootLabel(newer, networkInEpisode(readDeath(dm), isNetworkDeath(dm), true)), STALE_PAGE_LABEL);
  assert.deepEqual(haltFacts(dm), { exitCode: null, stalled: false, stalePage: true });
  // PAR-4 (closed upstream): the link drops (or the deploy lacks the file)
  // before the first frame — the worker's own structured death, never the
  // handler's uncaught throw (which the shim would report as `crash`).
  const failed = await firstFrameDeath((name) => {
    if (name !== "lsp-front-door.js") return read(name);
    throw new DOMException("Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at 'https://l4g.test/workers/lsp-front-door.js' failed to load.", "NetworkError");
  });
  const fl = failed.lastDeath!;
  assert.deepEqual([fl.reason, fl.cause?.code, failed.rebootReason], ["WORKER_DEP_MISSING", WORKER_SCRIPT_LOAD_FAILED, "crash"]);
  assert.match(fl.message, /lean\.worker\.js needs lsp-front-door\.js served beside it: .*failed to load/);
  assert.equal(readDeath(fl), "silent", "probe the link — like a worker script that never loaded, not \"after a crash\" inside an episode");
  assert.equal(isStalePageDeath(fl), false);
  delete (globalThis as { Worker?: unknown }).Worker;
}

console.log("death-kind: all assertions passed");
