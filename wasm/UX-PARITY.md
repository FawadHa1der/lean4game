# UX parity: wasm64 build vs adam.math.hhu.de

Adversarial UX comparison of this in-browser build against the deployed
server-backed site (https://adam.math.hhu.de, Natural Number Game), run on
2026-09-02. Method: one scripted journey (qed64 `work/ux-twin.mjs`) executed
identically on both sites — landing → world map → Tutorial level 1 (wrong
tactic, retry, solve) → Next → level 2 (hints, doc panel, editor mode,
Previous) → reload persistence → preferences — plus an adversarial section on
ours only (garbage-tactic storm, rapid Next/Previous, offline play, phone
viewport). Screenshots + JSON observations were then audited by four
independent review lenses (behaviour, visual, adversarial, "where ours is
better"), yielding 37 findings. Every finding was classified as
**port-caused** (ours to fix), **version drift** (our fork is upstream master;
the deployed site runs an older upstream — deliberately not reverted), or
**parity**.

## Result

Final verification (2026-09-02 evening, quiet machine): cypress **24/24**
(5 basic-interface + 19 game-feature tests) on the build that contains every
fix below; twin-harness journey and garbage storm green in the same run.

Apart from start-up (the one-time ~600 MB download and the ~10–20 s boot),
the wasm build is at parity or better on every checkpoint, and strictly
better on several behaviours the deployed site gets wrong or lacks.

| Checkpoint | ours | theirs | verdict |
| --- | --- | --- | --- |
| Landing, world map, welcome/rules, inventory tabs | ✓ | ✓ | parity |
| Level 1 time-to-goal (cold, includes boot) | 12.7 s | 5.7 s | start-up — excluded by design |
| Wrong tactic → "Failed command" | 0.98 s (was 2.1 s) | 0.63 s | parity (see latency note) |
| First `rfl` → level completed | 0.79 s (was 0.97 s) | 0.66 s | parity |
| Next → level 2 goal visible | 1.74 s | 5.80 s | **ours ~3× faster** |
| Level 2 `rw [h]` / `rfl` | 0.56 / 0.57 s (was 1.8 / 2.7 s) | 0.62 / 0.63 s | **ours faster** |
| Hints, hidden hint reveal, doc panel | ✓ | ✓ | parity |
| Editor mode: goals visible | ✓ (41 ms) | ✓ (harness timed out at 30 s) | parity |
| Previous, progress persistence after reload, preferences | ✓ | ✓ | parity |
| Garbage storm (8 malformed tactics) | survives, every step reported, input stays | soft-locks on `rw [unknown]` (below) | **ours better** |
| Rapid level switches ×6 at 100–250 ms | settles in 1.6–1.9 s, next step 0.8 s | not run (public server) | — |
| Network drops mid-session | next level loads, `rw [h]` + `rfl` complete, level after that loads | impossible (server) | **ours better** |
| Phone viewport (390×844) | input present | ✓ | parity |

### Latency note

Before this round, per-step feedback was the one place the deployed site
was faster once running: its native server answers in a flat ~0.63 s, ours
took 1–3.4 s and grew with proof length. Two things closed it. The wait
itself was made visible (fix 1 below), and the cause turned out not to be
wasm elaboration at all but a GameServer hot spot (fix 8): with it gone, a
step costs ~0.55–1.0 s here, flat in proof length, i.e. at or below the
native site. Numbers above are from the final run (harness run 5, quiet
machine); "was" values are from the same harness before fix 8.

## Fixed in this round (port-caused)

1. **Verdict-based step lock with a visible "Checking …" state.** The
   typewriter previously released its `processing` flag on the FIRST
   `publishDiagnostics` for an edit; the wasm worker publishes an interim,
   error-free set before the real one (and the proof-state RPC can be
   answered from the pre-edit document), so a second Enter could land before
   any verdict existed, and text typed during the wait was clobbered by the
   failed-command refill. Now the proof state is requested only once the
   server has published diagnostics for the edited document, the flag is
   released only by a proof state whose last step carries the submitted
   command (states from requests that were already in flight — the level's
   initial load, a session reconnect — come back with the pre-edit steps),
   the one-line editor is read-only while checking (with an explanatory
   read-only message), the Execute button shows a spinner, and a
   "Checking `rw [h]` …" note sits under the input. Safety valves: crash or
   a 60 s silence unlock the input.
2. **Silent tactic failures no longer soft-lock the level.** The GameServer
   calls a level "completed with warnings" whenever no *error* diagnostic
   exists; NNG4's `rw [unknown]` fails without producing one, so upstream —
   the deployed site included — hides the input with the goal still open and
   only Retry gets you out. Ours treats "no errors, goals still open" as a
   failed last step: the step is shown as *Failed command*, the input stays,
   refilled, and the next command replaces it.
3. **Level switch clears the previous level's proof.** The old steps sat
   under the new statement for the whole switch; the pane now shows the
   labelled "Loading the level…" state (with a properly sized spinner).
4. **Boot banner consistency.** One unit system (MB) instead of three;
   qed64's parenthetical size notes stripped; raw module names ("Mathlib.
   Tactic.Attr.Register") replaced by "loading the game's modules"; the
   download hint + ETA now trigger on byte-counted progress, not a label
   regex; the progress bar is 6 px instead of a hairline; the input gate no
   longer flickers off between boot stages (every stage of the first boot
   is a switch).
5. **Offline play survives a reload.** The checker never needed the network
   once loaded, but level texts were fetched per level and 404'd offline
   after a reload (the in-memory query cache is gone). The boot already
   downloads every level's JSON for the worker; the UI's queries now fall
   back to that copy when the network is unavailable.
6. **Documentation panel gutter.** Text sat flush against the panel's left
   edge and the close button against its right (upstream master styling);
   the panel now has the same side padding as the inventory lists.
7. **Landing page tells the truth.** The upstream "Server capacity" block
   (RAM/CPU 0.00 %, polled every 2 s from `/data/stats`) contradicted the
   "no server" hero text; replaced by a "Runs entirely in your browser"
   section (privacy, no capacity limit, first-visit download, browser
   requirements, progress stored locally). The stats polling is gone.
8. **Editor-mode panel could stay blank.** The upstream infoview resolves
   its request bundle after 500 ms with `goals: undefined` when the cursor is
   on line 0 and that line has a diagnostic (a fallback to show `lake
   print-paths` output while Lake builds). A promise settles once, so whenever
   the real answers took longer than 500 ms — typical under wasm, the
   proof-state request alone is ~1 s — the goals were discarded and the
   panel stayed blank until the next edit. This was the "chronic" editor-mode
   cypress margin failure. There is no Lake here; the fallback is removed
   (goal now renders ~2 s after the toggle, reliably).
9. **Pane recovers after a navigation storm.** While the checker replaces
   its session repeatedly (rapid level switches), every in-flight
   proof-state request is rejected with "switched documents"; once the
   loader's retries were spent nothing reloaded the pane, which sat on
   "Loading the level…" indefinitely (seen after an editor-mode toggle
   followed by rapid hash navigation). The pane now reloads its state
   whenever the checker settles with no state, and the loader retries the
   transient a few times with backoff before giving up.
10. **Reload hygiene.** The page now releases its checker on `pagehide` and
    caps the game session's Memory64 reservation at 3 GiB (see the open item
    for the measured effect; post-reload boot ~5.8 s). Keep both across
    substrate bumps: they remove two multi-GiB standing costs regardless of
    how the worker's boot-time transients get fixed.
11. **Per-step latency: GameServer `Runner` hoist + snapshot rebake.**
   `findForbiddenTactics` re-read and re-parsed the level's JSON
   (`loadLevelData`, ~46 ms under wasm64) once per syntax node; the load is
   now done once per elaboration. Headless probe: 8-step proof 8.1 s → 0.73 s,
   flat in proof length; the forbidden-tactic check still fires (verified
   with `inventory := []`). Only `GameServer/Runner.olean` changed; nng4 and
   testgame snapshots were rebaked against the pinned runtime and staged
   (`KERNEL.md`, `scripts/stage-snapshots.py`).

## Parity items verified (no action)

- `rw [zzz]` on Addition/1 yields no error message on either site (the
  GameServer/NNG4 `rw` swallows it); ours additionally keeps the input
  (fix 2).
- The duplicated "You have not unlocked the tactic 'rw' yet!" warning
  appears four times on both sites.
- Editor-mode "Loading goal…" is a short transient on ours; goals render
  ("No Goals" after a completed proof, also after a level switch) — see
  fix 8 for the case where they did not.
- The typewriter is hidden by the exercise panel overflow at some viewport
  heights only when a level has been solved (upstream layout, both sites).

## Version drift (deliberately kept — our fork is upstream master)

Monospace statement/goal with the Lean signature line; hypothesis chips;
inventory as a locked-row list instead of chips; theorem sub-tabs on one
row; the "en" language button; Monaco bracket-pair boxes in the input; the
preferences popup's empty "Controls" section.

## Open

- **Renderer crash: reloads then a 100 ms navigation storm (mitigated,
  not closed).** Recipe (qed64 `work/reload-storm-probe.mjs`): boot → reload
  → six hash switches at 250 ms → reload → six at 250 ms → six at 100 ms.
  Before any fix the third storm crashed the tab every time. Cause, from
  both sides: a reload does not promptly reclaim the previous worker's
  memory, and the worker's boot-time transient copies (snapshot staging and
  inflate buffers) take the renderer's resident size far above the wasm
  reservation itself (the qed64 side measured a ~15 GB peak during boot);
  a reload stacks a second set and the switch burst tips it over. Page-side
  mitigations shipped: `pagehide → shim.disposeForUnload()` (the game never
  released its worker on unload; qed64's own page does) and a 3 GiB
  Memory64 cap for game sessions (qed64 `8e708dc`, sessions peak under
  2 GiB). Measured: the hook alone let 2 of 4 full passes survive; the cap
  brought post-reload boots from ~13.6 s back to ~5.8 s but the 100 ms
  storm after two reloads still crashed (0 of 3). With the qed64 `e5df87a`
  closure (byte-exact worker channel, 2026-09-04) the full recipe survived
  2 of 2 passes on top of the hook and the cap. The worker-side fix for the
  boot-time transient copies (read the snapshot straight into the heap) has
  not landed on the qed64 side yet; when it does, bump the pin and re-run
  the recipe to confirm it is closed rather than improved. Fresh-page
  storms at 100–250 ms never crash.
- Only NNG4 is listed on the landing page; more games follow the catalog
  pattern in `KERNEL.md`.
- The boot strip can cover the bottom row of world-map labels during the
  first boot (scrollable, not lost).
