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
5. **Offline play survives a reload.** The checker never needed the
   network once its artifacts are cached (snapshots as raw regions in OPFS,
   the core library pack, the game data), but the page itself died at the
   first byte of a reload with the network off: the shell is served
   `must-revalidate` and there was no service worker. There is one now
   (`client/src/sw/sw.template.js`, generated into `dist/sw.js` by
   `scripts/build-sw.mjs` after every build, registered in production
   only): it precaches the shell at install — index, bundles, the four
   worker scripts, small fonts, icons, game data, i18n, api, and the
   artifact manifests including the pinned runtime manifest — serves
   navigations network-first with the cached index as the fallback,
   answers the boot's HEAD preflights from the cache, and caches the
   runtime chunks on first use. Because a first visit's boot fetches
   everything before the worker controls the page, the boot re-fetches the
   manifests and runtime chunks through the worker once the checker is
   ready (`force-cache`: the HTTP cache answers, no second download).
   Snapshots and pack parts stay network-only (OPFS owns them). Measured
   locally: after one online visit the worker is active and controlling,
   its caches hold the shell (431 files) and the warmed runtime (13), and
   an offline reload boots in 5.9 s, shows the level, and checks a tactic.
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
11. **Provisional "completed" states no longer act.** In editor mode every
    keystroke triggers a proof-state request, and the server answers for a
    tactic block that has not finished elaborating with `completed: true`,
    no goals and no diagnostics (the absence of errors so far, not a
    verdict) for a few hundred ms. The game acted on it at once: it
    rendered and focused the Next button (keystrokes lost — the cypress
    editor-mode test caught the focus), and marked the level completed in
    local storage. Completion is now ignored while the checker reports the
    document as processing, and whenever a "completed" state carries no
    diagnostic at all (a real completion always carries the server's
    "level completed" diagnostic); the pane reloads once the document
    settles. Surfaced by the faster byte-channel worker of the `e5df87a`
    closure; the race existed before.
12. **The level pane explains every waiting phase.** A bare "Loading the
    level…" read as hung to a first-time visitor (reported in use). The pane
    now names the phase with elapsed time: the first-visit download (with
    size, progress and ETA, and why it happens once), the in-tab start-up,
    the level's first elaboration (up to a minute cold), and "waiting for
    the checker's first answer". That last phase — the checker idle but no
    answer — now retries automatically every few seconds, offers a manual
    retry after 15 s, and after 90 s says that reloading is safe; those
    thresholds count from the moment the checker went idle, not from the
    level's load (after a four-minute first download the first idle second
    must not read "no answer after 4 min — reload"). The elapsed counter is
    owned by the level, so re-renders of the pane's branches do not reset
    it (verified on a 40 Mbit/s throttled first visit: 0 s → 4 min
    continuous, goal at 245 s). Chasing the phase that never ended found
    item 14.
13. **Per-step latency: GameServer `Runner` hoist + snapshot rebake.**
   `findForbiddenTactics` re-read and re-parsed the level's JSON
   (`loadLevelData`, ~46 ms under wasm64) once per syntax node; the load is
   now done once per elaboration. Headless probe: 8-step proof 8.1 s → 0.73 s,
   flat in proof length; the forbidden-tactic check still fires (verified
   with `inventory := []`). Only `GameServer/Runner.olean` changed; nng4 and
   testgame snapshots were rebaked against the pinned runtime and staged
   (`KERNEL.md`, `scripts/stage-snapshots.py`).
14. **Crossing into a new world hung the level for good.** The reported
    "stuck at Loading the level…" reproduced deterministically (qed64
    `work/stall-diag{2,3,4}.mjs`): Tutorial → Addition never showed a goal,
    while typed tactics still elaborated and the checker sat idle with no
    pending request. The port trace found the cause. lean4monaco derives one
    Lean language client per parent folder of the open document (its
    browser `findLeanProjectRootInfo` is `uri.join('..')`), and upstream's
    `file:///{world}/{level}.lean` scheme therefore creates a second client
    on the first world switch. Upstream can afford that — every client opens
    its own relay websocket — but here all clients share the single in-tab
    MessagePort: the newcomer's reader takes the port over, the rpc connect
    the infoview had already issued through the previous client is answered
    to the new one, which drops the unknown request id, and the level's rpc
    session promise hangs forever; every `Game.getProofState` (including the
    retries of item 12) awaited it silently. Fix (`client/src/wasm/level-uri.ts`):
    every level now lives in one folder, `file:///levels/{world}__{level}.lean`,
    so exactly one client and one document serve the whole game — the
    same-world level switch that always worked. The uri is synthetic on both
    sides (the translation layer maps it to the worker's document and back),
    so only the constructor, the fallback in the pane, and the translation's
    parser changed; the legacy shape still parses. Verified with
    `work/stall-verify.mjs`: the original recipe (two Tutorial levels, an
    editor-mode round trip, then Addition/1), a tactic in the new world, two
    more world switches and a return to Tutorial, with a single
    "Creating LeanClient" for the session.
15. **Boot no longer spins the level panel at ~1.2 kHz.** game-boot's
    status sink republished a fresh status object per progress event —
    thousands per second while a cached snapshot loads — and every jotai
    subscriber (the typewriter panel among them) re-rendered per event, each
    render creating a new infoview rpc session whose connect the not-yet-
    running client rejected ("No connection to Lean", ~6,000 per boot in the
    console, and CPU taken from the boot itself). Both publishers now skip
    unchanged content; the panel re-renders on stage changes only.
16. **A previous level's late reply is not shown under the next level.**
    Rapid next-level clicks (300 ms apart in `work/stall-verify2.mjs`) had
    Addition/1's goal rendered beneath Tutorial/1's statement, and a tactic
    typed at once judged against it. `loadGoals` now drops a proof state for
    a level the player has left (the infoview root stamps the current
    level). Typing *during* a level switch can still meet the checker's
    previous document for a moment — the verdict lock's processing gate
    covers the common case; the remaining window is listed under Open.
17. **First visit on the live site: "Waiting for the checker's first
    answer…" forever, input editable.** Reported on the deployed site right
    after the first deploy; a reload cured it. Cause: the level's first rpc
    session is created on the first render, a few milliseconds before the
    freshly started Lean client reports itself running, so its connect is
    rejected ("No connection to Lean"); the infoview's session manager drops
    the failed session, but every retry — the 4 s auto-retry, the settle
    reload, the manual Retry — called `loadGoals` from a timer closure that
    still held the dead session, so the pane asked a corpse for ever. A
    reload mounts the level while the checker is still starting, and the
    busy → idle flip re-renders the pane into a fresh session, which is why
    it "fixed itself"; locally an incidental re-render (the client's
    restarted event) hid the bug in every probe. Fix: retries are now state
    bumps that re-render, and the load effect requests with the session of
    that render (both typewriter and editor mode). The typewriter input is
    also read-only until the first proof state exists — a tactic typed into
    it before then had nothing to attach to. This closed a real gap but was
    not the reporter's case — see item 18.
18. **The checker never started when the game was entered by clicks.** The
    reporter's console (no `[game-boot]` line at all, "No active Lean
    client" then "No connection to Lean" for ever, "language client:
    stopped") showed the runtime was never booted on that page. The boot
    was triggered at page load and on the browser's `hashchange` event —
    but every in-app navigation (landing → game tile → world → level) goes
    through the location atoms, which navigate with `history.replaceState`,
    and that fires no `hashchange`. So a first visit by clicks never
    started the checker, while a reload of the level URL (hash form) did —
    the exact "fixes itself on refresh" report. Every probe and cypress run
    assigned `location.hash` or visited a hash URL, which does fire the
    event, and so never saw it. Fix: `App` boots the runtime from a React
    effect on the game id (any route, any navigation); `currentGameId`
    also accepts the path form of a game URL; and the level pane says
    "Starting the checker…" while the boot status is still inert instead
    of claiming the checker is up.
19. **The first CI-built deploy shipped no worker scripts.** After the
    pin bump the live site hung at "Lean is starting in your browser" for a
    returning visitor. Not the cache upgrade (reproduced locally: the new
    worker boots in 6 s from the cache the previous one wrote) — the site
    returned 404 for `workers/lean.worker.js`, `lsp-frames.js` and the
    prefetch worker. `client/public/workers/` is gitignored and populated
    from the vendored closure by the staging script, which the CI workflow
    never ran; every earlier deploy had been built on a laptop where the
    staged copies existed. Fixes: `scripts/stage-workers.sh` (one source of
    truth, called by the deploy and the asset staging scripts), the deploy
    script refuses a tree without the workers, manifests and game data, the
    boot preflights the worker script and any boot failure now reaches the
    level pane as "Lean failed to start: …" with reload advice instead of a
    spinner that never ends.
20. **Resident transport (qed64 closure `32e5e62`, kernel `992dc94`).**
    qed64 deleted the pump transport the game was built on (their
    `PUMP-REMOVAL-ASSESSMENT`): the shim's in-place session replacement per
    header change, its queue and its 15 s loss watchdog are gone; the worker
    owns the document and every header verdict, a level switch is a
    full-text document change the kernel's resolver serves from the game
    snapshot in-process, and the relay only re-establishes the document on
    a fresh session, fails requests a death orphaned, and breaks crash
    loops. Ported with no new dependency (`KERNEL.md`, substrate pin): the
    session adapter subclassed to write the gamedata on every boot, a game
    policy (init + game snapshot, 2 GiB initial commit, 3 GiB cap), the
    relay's status as the page's only readiness source (an armed checker
    with nothing open is "ready" — the world map), `pagehide →
    relay.unload()` (dispose plus the synchronous kill), a re-arm for the
    halted breaker from the pane and on level switch, and the translation
    wrapping every full-text change (the front door syncs whole
    documents). A kernel bump and a rebake of all three snapshots came with
    it (`wasm/build-from-source.sh`; the exports list is generated per
    build, the kernel gate is advisory on this pin, the bake probes are the
    acceptance test). Measured on the new pairing, locally: boot + goal
    18 s warm, `rfl` 0.66 s, every world switch shows its goal in 0.1 s,
    cypress 24/24, the reload-storm recipe survives the 100 ms storm after
    two reloads in 2 of 3 passes (1 of 3 on the previous worker, 0 of 3
    before). The retry rule stops re-asking an rpc session the infoview has
    marked failed (RpcNeedsReconnect) and leaves the pane's fresh-session
    ticks to it.
21. **Returning to a level checked its proof against the previous level.**
    The "tactic typed during a switch is judged against the previous
    document" item under Open was misattributed to timing. Trace: returning
    to a level whose Monaco model still exists (its first visit created it)
    sends no `didOpen` — the editor emits a full-text `didChange` of that
    level's uri with the saved proof — and the translation wrapped it with
    the header of the LAST `didOpen`, the level just left. The worker then
    held "Addition/1's command := by Tutorial/1's proof" (`rfl` failed
    against `0 + n = n`) and the session stayed on the wrong level. Same
    symptom on the pump build in the same probe (`stall-verify2`, item 16's
    run). Fix: the translation keys the level on each message's uri, and a
    full-text change for a level other than the one opened last becomes a
    re-open of the worker document with that level's header (the front door
    rebases the version, which a plain change behind the current version
    could not survive). Unit-tested; the probe's re-entered `rfl` now
    settles against the right goal.

## Live end-to-end matrix (deployed site, 2026-09-07, headless Chromium)

Run against `https://lean4game.fawadworkaddress.workers.dev` after the
worker-staging fix (item 19) went live. Drivers in qed64 `work/`:
`live-matrix.sh`, `live-persistent.mjs`, `live-offline.mjs`,
`click-crash-probe.mjs`, `click-mem-probe.mjs`, `stall-verify.mjs`,
`reload-storm-probe.mjs` (the last two take a base URL).

| # | scenario | result |
|---|---|---|
| 1 | fresh first visit, persistent profile: boot, Tutorial 1–2, Addition 1, back | pass — ready 146 s (download), every step ≤ 0.9 s, 0 HTTP errors |
| 2 | returning visit, same profile (the post-deploy case) | pass — ready 11 s from the caches, steps 0.3–0.7 s |
| 3 | offline reload, same profile | **fail** — `ERR_INTERNET_DISCONNECTED` at the HTML: no service worker (item 5, Open) |
| 4 | click-only first visit: landing → tile → world → Start | 2 pass / 2 die — passes reach the goal at ~153 s; the deaths are the renderer going away at ~82 s, when the 1.4 GB game snapshot starts streaming (see below) |
| 5 | world walk + editor-mode round trip | pass — one Lean client, goal at every switch in 0.1–0.2 s |
| 6 | reload storm (boot, reload, storm, reload, storm@250, storm@100) | 250 ms storms settle; **100 ms storm after two reloads crashes** (known Open item; not a regression) |

**Rerun on the resident deploy (2026-09-08, closure `32e5e62`, runtime
`wasm64-d77d34b97592d014`), same drivers:**

| # | scenario | result |
|---|---|---|
| 1 | fresh first visit | pass — ready 187 s (a full download of the new pairing), steps 0.7–0.95 s, 0 HTTP errors |
| 2 | returning visit | pass — ready 11 s, steps 0.3–0.8 s |
| 3 | offline reload | fail at the time (no service worker); **pass on 2026-09-08 with item 5's service worker deployed** — first online visit 172 s, worker active and controlling, shell cache 432 + runtime 13, the stored document a plain 200 with COOP despite the host's 307 for /index.html; offline reload boots in 5.2 s, cross-origin isolated, level goal shown, `rw [h]` checked |
| 4 | click-only first visit, with crash timing | pass — boots during the download, goal at 124 s, no crash |
| 5 | world walk + editor round trip | pass — goal at every switch in 0.1 s, one Lean client |
| 6 | reload storm | **pass** — both 250 ms storms and the 100 ms storm after two reloads settle (one pass; locally 2 of 3) |

Two caveats from that run. The probes' post-reload boots (135 s) are the
probe's own cost: a fresh Playwright context has no persistent HTTP cache,
so every reload re-downloads the 154 MB runtime chunks (the snapshot raw
cache in OPFS is used: 0.3 s per snapshot) — a real browser profile booted
in 11 s (step 2). And a later rerun stalled for ten minutes on a first
visit because the path itself had slowed to ~1 MB/s (Cloudflare's own
speed endpoint gave 1.6 MB/s to this machine at that moment; 7 MB/s in the
morning): at that rate the 1.2 GB first visit takes twenty minutes, which
the loading pane reports with size, progress and ETA but cannot shorten.
Range requests are not honoured by the Worker (it streams whole objects);
the client never uses them.

**First-visit memory, measured per boot phase** (largest Chromium process,
`click-mem-probe.mjs`): 0.85 GB through the download and unpack; **3.6 GB at
"Starting the Emscripten runtime"; 7.4 GB at "Initializing the Lean
runtime"** (before any snapshot); 7.8 GB after the init snapshot; 6.7 GB
while the game snapshot streams in; 8.3 GB at ready. The same curve qed64
measured for its editor (their HARDENING #44: ~9.2 GB at ready). The first
reading of it — the 24-worker pthread pool compiled into `lean.js`
(`pthreadPoolSize=24`), each idle worker parsing the 48 MB glue — was
tested by qed64 the same day as kernel patch 0033
(`PTHREAD_POOL_DELAY_LOAD`): built, baked, measured, **identical curve**,
and dropped from their series. Their Node attribution settled it: the boot
reaches ~7.5 GB before any snapshot with or without the pool's threads and
with tier-up disabled; `WebAssembly.compile` alone is 0.28 GB; the growth
is machine code V8 generates lazily for every function the Lean stdlib
initializers execute. That is a floor of running the full Lean compiler as
a 106 MB module — only a leaner module (fewer linked components) or fewer
initializers moves it, kernel research rather than a pin bump, and a
pairing change without benefit would only invalidate every visitor's
content-addressed cache. Consequences for the game: there is no runtime
knob and no substrate bump to schedule; whether a first visit survives
depends on the visitor's machine (here two of four click-path visits died
at the game-snapshot handover, four direct level-URL visits survived), and
when it fails the whole renderer is gone, so no failure card can help.
What the page can do is say so beforehand: the download phase now warns
when `navigator.deviceMemory` reports less than 8 GB (Chrome caps the value
at 8, so machines with more say nothing) that the checker needs roughly
8–9 GB free while it starts and may not start on this device.

Minor: the world intro page fetches `level__<World>__0.json`, which does
not exist (two 404s per world entry). Harmless; upstream does the same.

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

- **Rare renderer crash right after an early edit (open, low rate).** In
  hook-free browser probes that boot TestGame, switch to editor mode and
  type one tactic, the page crashed once in about thirteen runs (once with
  the `e5df87a` closure); six-run series on both the `e5df87a` and the
  `8e708dc` closures over the same runtime then completed without a crash,
  so it is not closure-specific. Same shape as the reload-storm item
  (renderer death, not a Lean error) and as a signature the qed64 side has
  seen; expected to move with their worker-side memory work. Note: probes
  that patch page prototypes or serialise logged proof objects over the
  debugging protocol crash the page far more often — that is the probe,
  not the game; measure with hook-free probes only.

## Version drift (deliberately kept — our fork is upstream master)

Monospace statement/goal with the Lean signature line; hypothesis chips;
inventory as a locked-row list instead of chips; theorem sub-tabs on one
row; the "en" language button; Monaco bracket-pair boxes in the input; the
preferences popup's empty "Controls" section.

## Multi-game

The games this build serves are the rows of `wasm/catalog.json` (read only
through `scripts/games-manifest.mjs`); a port is described in
`wasm/PORTING.md`, the publish order in `wasm/DEPLOY.md`. One wasm session
hosts one game environment (every game's root module is `Game`; a snapshot
is one complete compacted environment for one exact import list, never a
delta), so a game is one snapshot region, lazily downloaded on first play
and cached in OPFS, and switching games reloads the page. What is shared is
the runtime (154 MB) and the shell.

**Local verification 2026-09-08** (`qed64/work/games-smoke.mjs
http://localhost:3006 <fresh profile> --all`, served from `client/dist` by
`scripts/serve-dist.mjs`, all artifacts local; the probe's wire counter
double-counts snapshot bytes — the prefetch worker's fetch and the
service-worker-observed response — so the index's transfer sizes are the
figures to trust):

| game | policy (console) | relay serving | proof | wire (index transfer) |
| --- | --- | --- | --- | --- |
| testgame (unlisted) | `[testgame]`, region 1,347 MB → initial 1,536 MiB, cap 3,072 MiB | 9.4 s | `rw [h]` `rw [g]` completed | runtime 154 MB + core 120 MB + 414 MB |
| nng4 | `[nng4]`, region 1,398 MB → initial 1,792 MiB, cap 3,072 MiB | 8.2 s | `rfl` completed | 428 MB |
| stg4 (new, slim) | `[stg4]`, region 634 MB → initial 1,024 MiB, cap 3,072 MiB | 6.2 s | `exact h` completed | 181 MB |

- **Init-snapshot drop: KEPT.** Every game booted with `snapshots = [<game>]`
  alone (no `init` region), every level header was covered in-process and
  the proofs completed; the boot is one region load shorter (locally 8 s
  where the resident pairing's first local smoke measured 18 s) and the
  first visit skips init's 107 MB on the wire / 342 MB of heap.
- **Slim per-game trees: KEPT.** stg4's region is 665 MB raw / 181 MB gz
  against nng4's fat 1,466 MB / 428 MB with a larger Mathlib closure; the
  bake-lane probe elaborates through it (`SNAPSHOT PROBE PASS`, compile
  1.3 s) and the game plays. The served init/nng4/testgame stay fat until
  the next full lane run.
- **Landing tiles** read `/snapshots/index.json` + OPFS: "Ready — plays
  offline" / "Download ≈ N MB" / "Not available on this build"; a game
  whose snapshot is not published for the shell's runtime never starts a
  download — the boot's pairing check names the reason on the failure card.
- The two console errors per game are the known world-intro
  `level__W__0.json` 404s (harmless).
- **Cypress (24 tests) passes only in Chrome: `npx cypress run --browser
  chrome --config baseUrl=http://localhost:3006`** (24/24 on this build,
  2026-09-11). Under Cypress' bundled Electron every checker-dependent test
  fails with the worker's `Missing capability` card (`sharedArrayBuffer:
  false`): the proxy strips COOP/COEP and the `--enable-features=
  SharedArrayBuffer` launch arg in cypress.config.ts is not honoured by
  Electron. The previous commit (6b91080) fails identically under Electron,
  so this is a harness property, not a regression of the multi-game work.

**Live verification 2026-09-11** (commit 2fce1b7 deployed by the operator;
`games-smoke.mjs https://lean4game.fawadworkaddress.workers.dev <fresh
profile> --games nng4,stg4`, then the same profile again for nng4; the
bandwidth control `speed.cloudflare.com/__down?bytes=50000000` read
3.9 MB/s at the time):

| scenario | wire | relay serving | proof |
| --- | --- | --- | --- |
| first visit, first game (NNG4: runtime 154 MB + core pack 120 MB + nng4 428 MB, no init) | 702.3 MB | 119.6 s | `rfl` completed |
| second game after it (STG4: its slim region only) | 181.2 MB | 32.3 s | `exact h` completed |
| switch back to the cached game (NNG4, page reload) | 0 MB | 6.5 s | `rfl` completed |

Landing page on the deployed shell: a fresh browser shows "Environment —
Download ≈409 MB" (NNG4) and "Download ≈173 MB" (STG4) under the two tiles
plus the one-line "the first game also downloads the checker once (about
260 MB)"; after both games were played the same rows read "Ready — plays
offline". Both cover images resolve (absolute `/data/<id>/images/cover.png`,
HTTP 200). The per-game console error is the known world-intro
`level__W__0.json` 404. For comparison the last matrix on this pairing
(2026-09-08, init still loaded) measured the first visit at 146–187 s and
the return visit at 11 s.

### Client features 2026-09-11 (core-pack skip, Prepare, storage meter)

Three client-only changes on top of the multi-game architecture (no vendored
code touched; `client/src/wasm/game-cache.ts` is the new shared OPFS /
prefetch / service-worker-warm helper, `installGameArtifacts` in
`game-boot.ts` replaces the vendored `installArtifacts`):

- **Core profile pack skipped for game sessions.** A game never imports
  from oleans (its snapshot is one complete environment; the kernel's
  header resolver serves headers from cached environments only), so the
  session boots with `installed` empty → `leanPath ""`, no packs (the
  worker's `mountPacks([])` and `mkdirp("")` are no-ops). Measured on a
  fresh profile (`qed64/work/cf-pack-skip.mjs`, local `serve-dist` on
  :3006): NNG4 first visit **582.0 MB on the wire** (runtime 153.6 MB +
  nng4 428.4 MB; `/profiles/*.part-*` requests: **0** page-side and
  0 service-worker-side, where the previous matrix read 702 MB with the
  120 MB pack), OPFS afterwards holds only `qed64-snapshots/` (no
  `qed64-packs`; `navigator.storage.estimate()` usage 1.66 GB instead of
  ~2.05 GB), relay serving at 11.1 s (local), `rfl` completed, the
  inventory doc opens and the goal-term tooltip answers from the
  interactive RPC (`@OfNat.ofNat ℕ 37 instofNat : ℕ`). The first-visit copy
  now says "about 150 MB" for the checker (landing line and level pane).
- **"Prepare offline"** on a tile in the `download` state runs the
  disposable snapshot-prefetch worker (raw region into OPFS) and, through
  the service worker's existing `warm` message, the runtime chunks —
  without booting Lean. A page-level map of in-flight prepares makes the
  boot await a running prepare of its own snapshot instead of spawning a
  second prefetch worker. Measured (`cf-prepare.mjs`, two fresh profiles,
  STG4): prepare finished in 2.1 s locally with **0 page-side
  `/runtime/chunks` requests** (the service worker's own warm-up fetched
  the 10 chunks, 153.6 MB, plus the 181.0 MB `.snapz`), the raw file
  reached exactly 665,285,845 bytes, the tile flipped to "Ready — plays
  offline", the meter to "1 (0.9 GB of the 11.6 GB …)", and entering the
  game then served in **4.9 s** with no further network bytes. The race
  (Prepare, then the tile 0.3 s later) served in 6.1 s with exactly **one**
  `snapshot-prefetch.worker.js` construction.
- **Storage meter + "Remove download" + stale sweep.** The landing page
  shows "Games cached in this browser: N (X GB of the Y GB this site may
  use)" from `navigator.storage.estimate()` (hidden where it throws);
  "Remove download" on a `ready` tile deletes that game's
  `qed64-snapshots/<cacheKey>.raw` only; the boot sweeps, once per page
  after the pairing check, `<name>.*.snapz.raw` files of index names whose
  key is not the served key. Measured (`cf-storage.mjs` on the profile
  above): meter "1 (1.7 GB of the 12.4 GB …)" → Remove → tile "Download
  ≈409 MB", OPFS empty, meter "0 (0.2 GB of the 10.9 GB …)"; a planted
  `nng4.deadbeef00000000.snapz.raw` was removed by the next boot
  (`[game-boot] removed 1 stale cached region(s)`), which re-downloaded
  the live region (428.4 MB) and served in 10 s.

Review fixes (same day, local `serve-dist` on :3006, headless Chromium):

- **Game switch no longer kills a running prepare.** `bootGameRuntime`'s
  switch branch waits for every in-flight prepare's REGION (the raw file
  committed; the runtime warm-up is the service worker's and survives a
  reload) and mirrors it on the boot banner before `location.reload()`;
  the outgoing relay's status is muted meanwhile. Probe (NNG4 bound,
  SPA home, Prepare STG4, tile 200 ms later): banner "preparing the game
  environment · 64 … 576 / 634 MB", reload deferred 1.2 s until
  `prepare stg4: region done`, exactly one page-level `.snapz` GET (none
  after the reload), raw complete, no partials — before the fix the
  region was fetched twice.
- **One runtime warm-up per build.** `warmRuntimeCache` shares one
  in-flight `warm` per `buildId` page-side, and the service worker keeps
  one fetch per URL across concurrent warms (two tabs). Two Prepares
  0.1 s apart, counted on the server: 10 `/runtime/chunks` hits /
  153.6 MB (was 17–20 / 269–307 MB).
- **Region ready ≠ warm done.** `PrepareStatus.phase` gained `warming`
  (region in OPFS, warm-up running): the tile flips to "Ready — plays
  offline" the moment the region lands and says "caching the checker…"
  under it; the boot awaits the region only (`inFlightPrepare`) and
  renders the current status immediately. With chunks delayed 8 s the
  stale window went from 79.8 s to 0.0 s. `warmTarget` gives up on
  `serviceWorker.ready` once the page has loaded and no registration
  appears within 3 s (the dev server registers none) instead of 30 s.
- **The bound game's tile** shows "Loaded in this tab — its download is
  managed by the game." instead of Prepare/Remove (`boundEnvironmentAtom`),
  `prepareGame` refuses a snapshot the boot has claimed
  (`claimSnapshotForBoot`), and the landing page re-probes the tiles when
  the bound boot turns ready. Probe: no Prepare button while the boot
  streams, one prefetch worker, row "Ready — plays offline" after the boot
  (was: "Preparation failed: … createSyncAccessHandle …" + Retry, 2 workers).
- **Copy/units.** The tile's progress is scaled to the transfer size it
  promised ("Preparing… 393 / 409 MB" under "Download ≈409 MB"; the bar's
  value/max stay raw); the banner keeps raw bytes and the level pane now
  says "(about 173 MB to download, 634 MB once unpacked)". Worker exits
  read as user copy (`busy`, `unavailable` without Retry); `Prepare note`,
  `Prepare memory note`, `Storage meter` carry English defaultValues;
  `<progress>` has an aria-label and the status cell is `aria-live=polite`.
- **No OPFS (Firefox private mode).** The landing page probes
  `getDirectory()` once; when it throws, no Prepare/Remove, no meter, one
  note "This browser mode cannot keep games offline…" (simulated in
  Chromium with a rejecting getDirectory: 0 buttons, note shown).
- **Sweep.** Skipped under `?snapshots=<dir>` (the unpromoted index's
  keys are not the served ones — it deleted the promoted 1.47 GB region);
  matches the exact key shape after a listed name (`nng4.dev.*` next to
  `nng4` is left alone); reclaims stale-key `.partial` files (the
  prefetch's silence bail, 3 min without progress, also removes its own;
  until 2026-10-03 it was a fixed 15 min). Verified with the real
  function in Node and the dev-index browser probe (`stale region sweep
  skipped: unpromoted index ?snapshots=staging`, promoted key kept).

## Nine games (2026-09-11)

Every game of https://adam.math.hhu.de is now a catalog row (`wasm/catalog.json`,
ten rows with TestGame), each baked slim on the served runtime from its own
overlay; the init snapshot is retired (no game session loads it) and the
core profile pack is no longer installed by a game session. Per game, the
one-time download on first play and the region held in the browser:

| game | snapshot | on the wire | raw region |
| --- | --- | --- | --- |
| djvelleman/STG4 | stg4 | 181 MB | 665 MB |
| test/TestGame | testgame | 149 MB | 547 MB |
| hhu-adam/NNG4 | nng4 | 154 MB | 569 MB |
| emilyriehl/ReintroductionToProofs | reintro | 153 MB | 563 MB |
| JadAbouHawili/KnightsAndKnaves-Lean4Game | knights | 199 MB | 729 MB |
| k88-b/NumberTheoryGame | ntg | 232 MB | 836 MB |
| AlexKontorovich/RealAnalysisGame | rag | 282 MB | 1005 MB |
| hhu-adam/Robo | robo | 281 MB | 1002 MB |
| Trequetrum/lean4game-logic | logic | 231 MB | 835 MB |
| ZRTMRH/LinearAlgebraGame | lag | 280 MB | 999 MB |
| **all ten** | | **2,142 MB** | **7.75 GB** |

A first visit of any game now transfers the runtime (154 MB) plus that
game's snapshot; a second game costs only its own row. The landing page
lists nine tiles with live state (Ready / Download ≈N MB / Not available on
this build), a Prepare button, the storage meter and Remove download; the
service worker precaches the shell and the nine cover images only (per-game
level data is cached on use). Ports are documented per game in
`wasm/PORTING.md` §8. The local test campaign (2026-09-11, three testers +
adversarial verification + fixes, client/dist on :3006) is summarised here;
evidence lives under the session scratchpad `tc-shots/` and `tc-res-*.log`.

**Landing, Prepare, storage, visuals, accessibility (tester "landing").**
9/9 tiles show "Download ≈N MB" with N = round(transfer/1048576) on a fresh
profile and "Ready — plays offline" after play; a snapshot removed from the
index or baked for another runtime renders "Not available on this build"
(no navigation) and a direct level URL shows the failure card naming the
reason in 0.5 s with zero snapshot bytes requested. Prepare: keyboard
activation, `<progress>` with an aria-label, region complete in 1.1 s on
localhost, then entering the game reaches serving in 3.7 s; the Prepare→
enter race constructs exactly one prefetch worker. Storage meter counts the
cached regions; Remove download deletes exactly that region and the tile
flips back; the stale-region sweep removed two planted stale `.raw` files
and kept the live ones. Screenshots at 1400×900 and 390×844: no horizontal
overflow, tiles three per row at desktop after the grid fix.

**Switching, offline, i18n, low memory, Cypress, SW upgrade, memory
(tester "resilience").** Switch matrix over NNG4/STG4/ReintroductionToProofs:
7/7 transitions serving (downloads 5.1–6.2 s to serving on localhost, cached
4.1–4.6 s, wire bytes equal to the index's transfer sizes). Offline with
three games cached: reload → serving 5.8 s and `rfl` completes; hash to the
second game offline → 6.2 s, `exact h` completes; landing offline renders
nine tiles with images and correct states. i18n: STG4 es, NNG4 fr, Robo de
and zh, NumberTheoryGame ru all switch intro, tabs, goal header and tactic
docs; a game without the language falls back to English without errors.
deviceMemory=4 shows the heads-up above the tiles and in the level pane.
Cypress in Chrome 24/24 (a run under memory pressure from concurrent
browsers crashed the renderer: run the suite alone). Service-worker upgrade
from the live build's worker: new worker controlling in 5.7 s, 0 HTML
bodies under non-HTML names, offline reload serves the new shell.

**Defects found (17, all reproduced by a second agent) and their fate:**

| id | severity | defect |
| --- | --- | --- |
| D1 | major | STG4 in Spanish: level statement stays English although the es dictionary contains its translation (game-namespace text translated without §-placehold |
| D2 | major | Landing-page game tiles are not keyboard-operable (no role/tabindex/accessible name); keyboard and screen-reader users cannot open a game from the lan |
| D3 | minor | Storage meter undercounts cached games: "3 (0.2 GB …)" while OPFS raw regions total ~1.7 GB (navigator.storage.estimate() appears to omit OPFS in that |
| D4 | minor | Non-focusable controls: language menu opener "en" (<a> without href), the 9 language menu items, and footer "Impressum"/"Privacy Policy" (<a class="li |
| D5 | minor | Hamburger menu button #menu-btn has no accessible name (AX role button, name "") |
| D6 | minor | Keyboard focus is dropped to <body> after activating "Prepare offline" or "Remove download" (button unmounts); user must Tab from the top again |
| D7 | minor | Leaving a level for the landing page fires GET /data/undefined/level__undefined__undefined.json (SPA-fallback 200 online; console error ERR_FAILED off |
| D8 | minor | Offline landing page logs 24 console errors: i18n.loadNamespaces fetches /i18n/g/<owner>/<game>/en for each of the 6 never-played games (not in any ca |
| D9 | minor | Empty-text console.error("") from the bundled vscode/monaco code on every level boot (1–2 per boot) and again after a tactic settles |
| D10 | minor | Console error `Unable to read file 'extension-file://leanprover.lean4/language-configuration.json'` on level load (monaco-vscode extension file lookup |
| D11 | minor | Local scripts/serve-dist.mjs has no .jpg MIME mapping: 2 of 9 cover images served as application/octet-stream (would break under X-Content-Type-Option |
| D12 | minor | Cypress game-features.cy.ts crashes the Chrome renderer when the host is short of memory (each of its 19 tests re-boots TestGame in the same tab at ~8 |
| D13 | cosmetic | Robo tile shows the raw i18n key "[Game] Prerequisites" in the Prerequisites cell |
| D14 | cosmetic | No dark theme: 0 prefers-color-scheme rules in any stylesheet; landing and level pane (incl. failure card with hard-coded #333/#666 on white) render i |
| D15 | cosmetic | Failure card (unpublished / runtime-mismatch environment) keeps an animated spinner and "0 s elapsed" on a terminal failure, and the typewriter input  |
| D16 | cosmetic | Boot gate overlay is 96% opaque and shorter than the input row: the "Execute" button shows through at the right edge of the note during download/elabo |
| D17 | cosmetic | Fixed-height .short-description (6.5 rem) leaves a 60–90 px blank band on tiles with one-line summaries (RAG, logic, LAG, knights); 9 listed tiles lea |

Fixed in this build: D1–D8, D10, D15–D17 (statement translation through the
game namespace, keyboard-operable tiles with `role="link"`, focus kept after
Prepare/Remove, storage meter summing the OPFS regions, no
`/data/undefined/…` request on leaving a level, no offline i18n error storm,
failure card without a live spinner, opaque gate overlay, three-column grid)
plus a service-worker fix found on the way (offline navigation after a
deploy could serve the previous build's shell from the older cache — the
lookup now checks the current shell cache first). Not fixed: D9 (empty
`console.error` from lean4monaco's message strategy — upstream), D11 (local
static server MIME table — fixed separately in `scripts/serve-dist.mjs`),
D12 (Cypress renderer crashes under host memory pressure — run it alone),
D13 (Robo's tile lists an untranslated `[Game] Prerequisites` key — the
tile now drops untranslated keys), D14 (no dark theme — inherited from
upstream, a theming pass is a separate item).

**Deep play of every game (tester "play", same build, one persistent
profile, loopback).** Catalog smoke over all ten games from a fresh profile:
every game boots to serving in 5.4–7.2 s and completes its level-1 proof
(wire 305–564 MB per game including the shared runtime on the first one).
Deep play on a mid-game level per game — statement, intro hints, the taught
tactic in the inventory, the proof one tactic at a time with a fresh goal
pane after each step, "Level completed! 🎉", Next loads the following level,
Previous shows the completed state:

| game | level | boot s | first goal s | steps | completed at |
| --- | --- | --- | --- | --- | --- |
| NNG4 | Addition 1 (`induction`) | 5.5 | 5.7 | 6 | 14.0 s |
| STG4 | Complement 1 (`by_contra`) | 5.5 | 6.2 | 2 | 10.5 s |
| ReintroductionToProofs | ConjunctionWorld 1 (`constructor`) | 5.5 | 5.5 | 3 | 10.8 s |
| KnightsAndKnaves | Logic 7 (`cases`) | 5.5 | 5.8 | 3 | 11.6 s |
| NumberTheoryGame | Congruence 8 (`induction'`) | 5.5 | 5.8 | 6 | 15.0 s |
| RealAnalysisGame | Lecture6 5 (`cases'`) | 5.5 | 5.9 | 5 | 14.0 s |
| Robo | Implis 1 (`intro`) | 5.5 | 6.2 | 4 | 12.3 s |
| lean4game-logic | ImpTactic 1 (`apply`) | 5.5 | 5.8 | 2 | 9.9 s |
| LinearAlgebraGame | LinearMapsWorld 1 (`unfold`) | 6.5 | 6.5 | 2 | 10.9 s |

Editor mode (Monaco) completes the same proofs on the logic game and
RealAnalysisGame; the reload storm on NNG4 (reload, six 250 ms switches,
reload, six at 250 ms, six at 100 ms) ends serving with the goal rendered
and no renderer crash. Console noise per boot: the empty `console.error`
from lean4monaco's message strategy (D9) and a few "No connection to Lean"
warnings before the client reports running; nothing else. One intermittent
defect surfaced (1 of 3 typed editor-mode runs): a stale `Game.getProofState`
reply applied after the finished proof's replies hid the completion until
the pane reloaded — fixed by dropping replies superseded by a newer request
(`goals.tsx`, `proofRequestSeq`).



## Live campaign 2026-09-14/21

Three adversarial testers (play, landing, resilience) ran against the deployed build of `88fe4fb`
(`https://lean4game.fawadworkaddress.workers.dev`, runtime `wasm64-d77d34b97592d014`, ten catalog games,
slim snapshots, core-pack skip, Prepare, storage meter) on a shared ≈6.8 MB/s link; every defect was then
re-reproduced by an independent verifier, diagnosed from the source, and the client-side ones fixed here
(working tree on top of `88fe4fb`, not yet deployed). Harness: Playwright scripts `lv-*.mjs` in
`qed64/work` of the peer repo; network chaos through a local proxy (Playwright's `setOffline` does not
reach the snapshot prefetch worker).

### Live PASS matrix (in brief)

| Area | Result | Numbers |
|---|---|---|
| Catalog smoke, fresh profile, all ten games | 10/10 PASS | first visit 33.5 s (reintro, 153 MB) … 88.5 s (lag, 280 MB); testgame 63.2 s incl. the 154 MB runtime; 2298 MB on the wire in total, each game = its index transfer size ±1 MB; console: only the known empty lean4monaco error |
| Deep play, cached (statement, hints, inventory, steps, completion, Next, Previous) | 9/9 PASS | boot 6.6–14.2 s, step 0.8–1.6 s, level completed in 13.2–20.2 s |
| Wrong tactics / sorry / admit / undo / leave-and-return (nng4, rag, robo) | PASS | errors in 0.7–1.3 s; forbidden tactics in 0.6–1.0 s (but `exact?` 13.7–45.8 s → L8); undo ≈0.7 s; return replays in 3.3–4.1 s |
| Editor mode (rag, logic) and reload storm (nng4) | PASS | completion 1.5–3.8 s after typing; 18 switches, settle ≤ 394 ms, no crash |
| Progress download / upload | PASS (erase FAIL → L1) | 1009-byte JSON round-trips |
| Landing: tiles vs index, covers, keyboard, overflow (desktop + mobile, light + dark) | PASS | 9/9 sizes exact, 9/9 Tab-reachable, no horizontal overflow; cold tiles 10.9 s, warm 5.7 s |
| Prepare (small, large while loaded, double click, two at once, reload mid-way, busy from a second tab) | PASS | STG4 89.7 s / 181 MB, RAG 72.2 s / 282 MB, one prefetch worker and one `.snapz` request each, runtime warmed once; cached boot 8.5–10.1 s |
| Storage: meter, Remove download, stale sweep, returning-visitor upgrade | PASS | meter 1.9 GB vs 1.67 GB of regions (+ runtime); 2 planted stale regions swept, live ones kept |
| Offline after caching (reload, game switch, landing) | PASS | nng4 7.0 s, stg4 7.8 s, proofs complete; landing 9 tiles, covers from the SW |
| i18n: STG4 es, NNG4 fr, Robo de/zh, NTG ru, English fallback, switch mid-proof | PASS | 0 console errors (typo → L18, `<html lang>` → L15) |
| Two tabs (same game; two games) | PASS | both boot and prove; largest process 6.3 / 7.8 GB, sum 6.7 / 9.1 GB (tile state not shared → L12) |
| Mobile 390×844, `deviceMemory=4`, reduced motion | PASS | single-column layout, no overflow, proof by touch; the memory notice shows on landing and in the level pane |
| Memory | measured | Robo first visit peak 7.6 GB renderer; five games in one tab 8.0–8.9 GB at ready, peak 9.0 GB, follows region size, no growth with switches |
| Service-worker lifecycle (first visit, `cache: reload`, previous-deploy worker) | PASS | 235 precache entries; live worker takes over an old one in 23.8 s, 0 HTML bodies under non-HTML names |
| Switch matrix A→B→A→B→C→A→C, Back/Forward, Back during boot | PASS 7/7 | cached switch 7.2–9.4 s, 0 MB (console errors per hash switch → L14) |
| Resilience: reload / close tab mid-download, 1 MiB/s throttle | PASS | restart from zero (→ L10), serving 28–28.7 s after reopening; throttled first visit 293 s with a moving ETA |
| Resilience: 20 s outage mid-snapshot-download | FAIL → L4, L5 | halted 10 s into the outage, never retried; pane flipped to "Crashed!" 12× in 80 s |

### Defects

| Id | Severity | Defect | Fate |
|---|---|---|---|
| L1 | major | Erased progress resurrects in the same tab | **fixed** — `level.tsx` soft-reverts the level's (dirty, hence undisposable) Monaco model on unmount and resets the proof atoms per level; `erase.tsx` empties the mounted editor and the in-memory proof; `main.tsx`/`goals.tsx` stamp the proof with its level so the previous level's `completed` cannot complete the next one |
| L2 | major | NNG4: `rw [unknown]` accepted silently | inherited from upstream (only "declaration uses sorry" reaches the diagnostics), left; the input soft-lock it causes upstream stays fixed here (`lastStepHasErrors` in `goals.tsx`) |
| L3 | major | "malformed MsgEmbed: {widget…}" in error boxes | **fixed** — `msg-embed.ts` pre-pass replaces widget embeds by their `alt` text before `InteractiveMessage` The Try-this insertion link (alt = the dead text `[apply]`) is dropped with its separator space. **Limitation:** lazily loaded trace children are fetched inside the bundled `traceExplorer` and never pass the pre-pass — a widget inside an expanded lazy trace node (editor mode, `set_option trace.… true in`) still renders the blob |
| L4 | major | Outage during the first download → dead card, no retry | **fixed** — `game-boot.ts`: the relay's settle holds a restart after a network-shaped death until a same-origin `no-store` HEAD succeeds (2, 4, 8, 15 s …, at once on `online`); a relay that halted anyway is re-armed automatically (≤ 3 per page); the pane says "The download was interrupted — waiting for the connection" with Reload Review round: a death is network-shaped only by its UNDERLYING error (`<name> snapshot failed: <error>` progress label / the runtime death message), never by the generic `snapshot '…' failed to load` or `RUNTIME_FETCH_FAILED` — a corrupt snapshot with the network up halts after three deaths with the normal card; the settle no longer holds while `navigator.onLine` is false (a cached game reboots offline); a served boot resets the re-arm budget and the reload guard, and a refused no-document reload drops the hold card |
| L5 | major | Failure card replaced by editor-mode "Crashed!" | **fixed** — a halted relay's refusal is not a crash (`goals.tsx`), `halted` is published before the first serve too, the wrapper never outranks a boot failure / halt (`main.tsx`), and a halted relay's leftover session cannot repaint "starting Lean" |
| L6 | major → minor | Unknown world / level → parser "Crashed!" | **fixed** — route guard + `LevelNotFound` view in `level.tsx`; the translation layer never forwards a document without level data and answers its requests itself; "Level 1 / undefined" header fixed Review round: `levelInfoAtom` obeys the same guard (no `level__<W>__<n>.json` request for a level outside `worldSize`, nor for level 0) |
| L7 | major | Intermittent renderer crash on NNG4 | not reproduced (0 crashes in the verifier's repeats and in every run of this round) |
| L8 | minor | Forbidden `exact?` runs the library search first (13.7–45.8 s) | **fixed in source** — `server/GameServer/Runner.lean` now checks the player's top-level tactics before elaboration and, at difficulty 2, elaborates the proof truncated before the first forbidden tactic (earlier steps keep their goals; the error stays at the tactic's position; verified natively: no `Try this`, rejection at the import floor). Takes effect for players with the next snapshot bake (the v4.34.0 import); browser check pending there |
| L9 | minor | Multi-line paste concatenated into one line | inherited from upstream, left |
| L10 | minor | Interrupted game downloads restart from byte 0 | **copy fixed, resume deferred** — the level pane and the Prepare note no longer promise that a download survives (only the checker stays cached); real resume = Range support in `infra/worker.js` (Chrome already sends `Range` + `If-Range`), not done here Review round: `infra/worker.js` now answers `Range`, so the copy is neutral — "what finished downloading stays cached; an interrupted download is fetched again" (pane) / "Prepare then starts over (bytes your browser already fetched are reused)" (tile) |
| L11 | minor | Unknown game id renders an empty game shell + 404 burst | **fixed** — `gameKnown()` (no `/api/games` row AND `game.json` refused; a network failure is no evidence) → the app's not-found page, no boot, no failure label Review round: only 404/410/HTML count as a refusal (403/429/5xx = no evidence); the wait is bounded (4 s, not memoised) and the router shows a spinner instead of an empty page while it runs |
| L12 | minor | Tile state not shared across tabs | **fixed** — `BroadcastChannel('l4g-cache')`: prepare committed, remove, stale sweep, bound boot served → other tabs re-probe and drop their stale `failed` status; focus / visibilitychange fallback Review round: only `busy` refusals are dropped — a genuine local failure / `unavailable` status stays |
| L13 | minor | Prepare bar pauses near the end | not reproduced |
| L14 | minor | Console errors at every hash game switch | **fixed** — `GameTranslation.suspend()` at the instant of the switch Review round: the switch is cancellable — client traffic is held (not dropped) while suspended, `resume()` flushes it when the player returns to the bound game before the reload, and the pending reload is called off |
| L15 | minor | `<html lang>` never set | inherited from upstream, left |
| L16 | cosmetic | First command's errors rendered twice | inherited from upstream, left |
| L17 | cosmetic | No dark theme | inherited from upstream, left |
| L18 | cosmetic | "voheriges Level" | **fixed** (`locales/de/translation.json`; worth a one-line upstream PR) |

L19–L23 were notes (by-design behaviour and harness caveats), not defects.

### Measurements of the fixes (local build of the working tree, `scripts/serve-dist.mjs` on :3006, headless Chromium, 2026-09-21)

Network chaos ran through `lv-impl-chaosproxy.mjs` (a plain-HTTP reverse proxy in front of :3006 with the
resilience tester's control surface: `.snapz` bodies paced to 4 MiB/s, `/__cut?ms=` destroys every
connection and refuses new ones) — the tester's proxy is CONNECT-only and cannot front a localhost origin.

| Probe | Result |
|---|---|
| L1 `lv-verifyL1-erase.mjs` | after "Delete Everything": L1 and L2 open fresh in the same tab (0 commands, `completed:false`, code `""`), still false after the map; after "Delete this Level": pane fresh at once, L2 → L1 stays uncompleted; a never-solved L2 is no longer marked completed on opening; a completed level still replays on return. 65 s, 0 exceptions |
| L1 `lv-play-eraseprobe.mjs` | all steps `flag1=false flag2=false completedMsg=false` after each erase; re-completion works |
| L5 copy of `lv-verify-L5-proxyonly.mjs` (20 s cut 6 s into the 154 MB body, `navigator.onLine` stays true) | pane: booting → "The download was interrupted — waiting for the connection" (Reload visible) 2 s after the cut → booting 10.6 s after the network returned → goal at +89 s with no user action; `secondsInCrashed: 0`, `secondsInCard: 0`, relay never halted; proof OK |
| L4 copy of `lv-verifyL4-chaos.mjs` (proxy cut + `setOffline`, so `online` fires) | 60 s after the network returned: `relayAtEnd: serving/ready`, `cardAtEnd: false`, 1 new `.snapz` GET; proof OK |
| L4 flapping link (`lv-impl-L4-flap.mjs`: three 2.5 s cuts, each 3 s into a fresh download) | breaker tripped at +26.1 s (third death) showing the interrupted-download card, re-armed automatically at +28.7 s, goal at +78 s; "Crashed!" never shown |
| L6 `lv-verifyL6-badroutes.mjs` | unknown world, level 999 and a cold bad URL: "Level not found" view, relay stays `serving/ready`, console 0 × "missing level data", 0 × "No RPC method", 0 × 404; level 0 still the introduction; recovery to Tutorial/2 immediate |
| L11 copy of `lv-verify-L11.mjs` | `#/g/nobody/NoGame` and its level URL: not-found page, relay null, 0 snapz / chunk / worker requests, 0 console errors, 1 warning, +0 requests in the next 20 s |
| L14 copy of `lv-verify-L14.mjs` | hash switches nng4 → reintro → nng4: 0 errors before the reload (were 3 each); after it only the accepted empty lean4monaco error; boots 5.7–7.0 s |
| L12 copy of `lv-verify-L12.mjs` | tab 2's "Already being downloaded… Retry" became "Ready — plays offline / Remove download" in the sample taken as tab 1 reached Ready; after Remove in tab 2, tab 1 showed "Prepare offline" and meter 0 in the next sample |
| L3 `lv-verify-L3.mjs` | `exact hZZ` / `simp [hZZ]`: "Unknown identifier `hZZ`", `blob=false`, while the raw diagnostics still carry `Lean.errorDescriptionWidget` |
| Unit tests | `game-translation.test.ts`, `game-translation-guard.test.ts` (L6/L14), `msg-embed.test.ts` (L3): pass |

Not verified here: the fixes on the deployed site (a shell redeploy is enough — no artifact changes); L11 on
a host that answers 404 for a missing `game.json` (the local server answers its SPA fallback; there the
HEAD probe logs one 404 line); the no-document re-arm path (a halt on the world map → one guarded reload).

### Live verification 2026-09-22

The fixes above went live as `4c7a416`; the live verification of that deploy confirmed them and found four
defects the local measurements had not covered, all in first-visit / slow-link territory (the local server
answers in milliseconds and the service worker installs its 37 MB precache in seconds; live, on a slow link,
that install takes minutes and the registration can even disappear when it times out — so for the whole
first play nothing serves the worker scripts or the game data from a cache). Fixed here (working tree on
top of `4c7a416`, not yet deployed) and measured on the local build through `lv-r2-chaosproxy.mjs`
(`lv-impl-chaosproxy.mjs` plus `/__block`, `/__hold`/`/__release` and `/__rateall` rules; probes
`lv-r2-*.mjs` in `qed64/work`):

| Id | Severity | Defect | Fix |
|---|---|---|---|
| D1 | major | The network-cut recovery does not work on a first visit before the service worker controls the page: the three worker-script fetches (`lean.worker.js`, `lsp-frames.js`, `lsp-front-door.js`) fail at each relay reboot, those deaths arrive as `{reason:"crash"}` with NO message, three of them within 2 s trip the breaker (the vendored session constructs its Worker in the relay's synchronous reboot, BEFORE the injected settle runs — no settle can hold), and the old failure card showed with no recovery | **fixed** — `game-boot.ts`: (a) `networkSuspected` — a death that is not network-shaped by its text is still checked against the link by the same same-origin probe while the bound game's raw region is not in OPFS (a cached game is never held); (b) the halted case is classified the same way (`classifyHalt`, async: the halted fact is published first so nothing polls the halted relay, the pane says "checking the connection" meanwhile) and re-armed by the existing `scheduleNetworkRearm`, whose wait resolves on `online` and on the next successful probe; (c) after every hold the worker scripts are preflighted before the relay may reboot (`awaitLink`): a failed fetch is the link (hold again), a 404/HTML answer is a deploy problem (no re-arm — the card names the script); the boot's own preflight now holds for the link instead of throwing "this deployment is missing …"; (d) nothing relies on the service worker. Corrupt / unpaired snapshot deaths carry their messages and their region is in OPFS by then: the normal card, as before |
| D2 | major | Offline play of a game whose data files were fetched BEFORE the service worker controlled the page fails: `game.json` / `level__*.json` / `inventory.json` / i18n were never cached (the precache deliberately skips per-game data; the network-first path caches only what passes through a controlling worker) | **fixed** — `game-boot.ts` `offlineDataUrls` + `warmOfflineCache`: once the checker is up the bound game's `game.json`, every level file the boot fetched, `inventory.json`, every inventory documentation file it lists (`doc__<Tactic\|Theorem\|Definition>__<name>.json`, `inventoryDocUrls`; at most 188 files / 85 KB per game) and `/i18n/<id>/<lang>` (UI language + `en`) ride in the SAME `warm` message as the runtime list (`game-cache.ts warmRuntimeCacheOutcome(runtime, extraUrls, 10 min)` — a data-only message to a previous deploy's worker would have pruned the runtime). `/api/games` is not warmed: it is in the shell precache, and network-first refreshes only the shell copy. No active worker → re-warm on `navigator.serviceWorker.ready`; an active worker that does not answer in time → not retried this page. `sw.template.js`: network-only paths skipped, only content-addressed chunks are skipped when already cached — every other warmed URL is fetched again (HTTP cache) and replaces the stored copy on a storable answer (offline / refused keeps it); the prune runs only for a message that names chunks. Warmed files land in the runtime cache, which the network-first fallback (`lookup`) already consults; a later online hit through the worker, or the next warm-up, replaces the stored copy. Level images stay cached-on-use (shown offline only if a controlling worker saw them) |
| D3 | minor | A failed tactic the typewriter pre-fills after "Failed command" on level N still pre-fills the box on level N+1 (upstream shows an empty box) | **fixed** — the content is the global `typewriterContentAtom`; `level.tsx` resets it on every level change (the effect used to reset a dead local state), and `typewriter.tsx` ignores a proof state stamped for another level (`proofLevel`, the L1 stamp) so the previous level's failed step cannot refill the new level's box |
| D4 | minor | On a slow link an unknown game's level URL boots (banner "checking this game's environment", then a "Lean failed to start" card) before the not-found page: `gameKnown()` answered "known" at its 4 s bound while the catalog was still loading, and the boot started on it | **fixed** — `bootGameRuntime` binds on the UNBOUNDED `gameKnownCheck` (no boot, nothing published, for an unknown game); the router follows the unbounded check too and keeps the bounded `gameKnown` (now 20 s) as the stalled-link escape hatch only; the network-failure = known rule is unchanged |

Measurements (local build, `serve-dist.mjs` on :3006 behind the r2 proxy, headless Chromium):

| Probe | Result |
|---|---|
| D1 `lv-r2-D1-nosw.mjs` (fresh profile, `/sw.js` blocked → `controller === null`, no registration at the cut; 20 s proxy cut 6 s into the 154 MB `.snapz` body, `navigator.onLine` stays true) | breaker tripped 0.2 s after the cut with `lastDeath {reason:"crash", message:""}` (5 worker-script fetch failures); the pane showed "The download was interrupted — waiting for the connection" at once, never "Lean could not start", never "Crashed!"; re-armed 12 s after the link returned, `.snapz` fetched again, `serving/ready` + goal 60.5 s after the link returned with no user action; `rfl` completes the level |
| D2 `lv-r2-D2-offline.mjs` A (worker installs during the first boot) | warm-up reply `96/96 runtime + game-data files cached`; `game.json`, `level__Tutorial__1.json`, `inventory.json`, `/i18n/…/en` in `l4g-runtime-v1`; link cut for good, reload: `serving/ready` + goal in 5.2 s, every `/data`, `/i18n`, `/api/games` request answered by the worker after its own network attempt failed (84 of 84), `rfl` completes the level offline |
| D2 B (worker script held at the proxy until 45 s after the level rendered: `controller === false` at the goal — the live first-visit shape) | `offline cache warm-up: no service worker reply — retried when a worker is ready` at +77 s, the worker released at +93 s, `ready`, re-warm reply `96/96` 0.6 s later; offline reload: goal in 5.4 s, proof completes; 0 data files unserved |
| Review fixes (2026-10-01) `lv-r2-fx-budget.mjs` (no SW, four 20 s cuts mid-`.snapz`, 2 MB/s) | each automatic re-arm drops the "download was interrupted" card at once (`rebooting/booting`, `interrupted:false` 0.3 s after `re-arming … attempt n/3`); the fourth halt shows the normal card at +116.9 s and keeps it 120 s after the link returned: `{"relay":"halted/halted","death":"crash:","interrupted":false,"oldCard":true,"buttons":["Reload","Restart the checker"]}`; no leftover "the network is back" lines (the settles of a halted relay return before holding) |
| `lv-r2-fx-cachednosw.mjs` (region in OPFS, `/sw.js` blocked, 30 s cut, `relay.restart({})` during it) | halt at +13.6 s classified as the link (`with the network unreachable — recovery is automatic`), re-armed 2.4 s after the link returned, `serving` 8.1 s after it |
| `lv-r2-fx-5xx.mjs` (no SW, 20 s cut, `/workers/lsp-frames.js` answering 503 until 25 s after the link returned) | `the origin answered but /workers/lsp-frames.js: HTTP 503 — still waiting for the connection` every 2 s, re-armed when the 503 stopped, goal; no deploy card |
| `lv-r2-fx-deploy.mjs` (same, but 404) | `this deployment is missing /workers/lsp-frames.js (HTTP 404)` → normal card (Reload + Restart the checker), no re-arm |
| `lv-r2-fx-D2.mjs` A and B (D2 + docs) | warm reply `192/192` (96 + the 97 inventory docs − 1 `/api/games`); offline reload: goal, proof completes, `doc__Tactic__rfl`, `doc__Theorem__MyNat.add_comm`, `doc__Definition__Add`, `doc__Tactic__induction` answered 200 by the worker; the offline reload's own warm-up reports `192/192` (held copies count) |
| `lv-r2-rev2-swwarm.mjs` (stale `game.json` / `/api/games` seeded into `l4g-runtime-v1`, then a warm) | both replaced by the served copies; HTML fallbacks (`/i18n/…/pl`, an unknown game) still never stored |
| D3 `lv-r2-D3-prefill.mjs` (NNG4 Tutorial/1 `exact hZZ`, hash to Tutorial/2) | L1: "Failed command : exact hZZ", box `exact hZZ`; L2: box `""` in all 12 samples over 6 s, no failed-command box; back on L1 the saved failed step refills the box (upstream behaviour, unchanged) |
| D4 `lv-r2-D4-unknown.mjs` (`/__rateall` 300 kB/s, `#/g/nobody/NoGame/world/W/level/1`, fresh profile) | not-found page 34 s after the navigation (the shell itself takes 33 s at that rate); banner never shown, no card, no level mount, relay never constructed, 0 page-originated boot requests (the 10 requests to `/workers`, `/runtime`, `/profiles`, `/snapshots` at +33.8 s are the service worker's precache install); the known-check itself: `/api/games` + one `HEAD game.json` (200 HTML from the SPA fallback = refused). The checking placeholder was not sampled: the local catalog answers in 0.1 s |
| D1 with the worker controlling: `lv-r2-L5.mjs` (copy of the L5 probe, own proxy) | pane: booting → "The download was interrupted — waiting for the connection" (Reload visible) 1.5 s after a 20 s cut 8 s into the `.snapz` body → booting 10.6 s after the link returned → goal at +86 s with no user action; relay never halted (the settle hold), `secondsInCrashed: 0`, `secondsInCard: 0`; proof OK; cached reload afterwards 5.3 s, 0 new `.snapz` GETs |
| D1 with the worker controlling: `lv-r2-L4-flap.mjs` (three 2.5 s cuts) | cuts at +7, +16, +25 s; the first two held the settle ("the network is back after 2 s — restarting the checker"), the third tripped the breaker at +25.8 s (`snapshot 'nng4' failed to load`) showing the interrupted card, `classifyHalt` → "recovery is automatic", goal at +75.7 s, `serving/ready`; "Crashed!" never shown |
| `games-smoke.mjs http://localhost:3006 <fresh profile> --all` | 10/10 PASS (testgame, nng4, stg4, reintro, knights, ntg, rag, robo, logic, lag), boot 5.3–7.3 s, 305–564 MB on the wire per game (local link), each level completed (Next button shown); console: only the known empty lean4monaco error (1–3 per game) |
| Unit tests | `game-translation.test.ts`, `game-translation-guard.test.ts`, `msg-embed.test.ts`: pass; `tsc --noEmit`: no errors in the changed wasm modules (the pre-existing upstream strictness errors in `typewriter.tsx` / `level.tsx` are untouched) |

Not verified here: the deployed site (a shell redeploy is enough — no artifact changes). The deploy-problem
branch (404 after a hold), a transient 503, and the re-arm budget's exhaustion are covered by the review-fix
rows above; the boot warm-up's `timeout` outcome (an active worker that never answers) is read from the code only.

### Live verification 2026-10-01

`cbb925d` (the D1–D4 fixes above) went live as bundle `index-luXvxrON.js` / `sw.js` `ac9f6bfb6faa` (CI run
36880472784). The live round-2 verification (three testers through `lv-resilience-proxy.mjs`, a judge, one
adversarial re-reproduction per new defect; probes `lv-live2-*.mjs` in `qed64/work`) returned **16 of 16 PASS**:

| # | Check | Verdict |
|---|---|---|
| 1 | D1 network cut with NO service worker controlling (1 MB/s; one cut inside the `.snapz` body, one inside the runtime download) | PASS |
| 2 | D1 on a realistic first visit (every tunnel paced to 300 kB/s) | PASS |
| 3 | D1 regression with the worker controlling: 20 s cut + flap | PASS |
| 4 | Cached game offline is not held for the network | PASS |
| 5 | D2 offline play of a game whose data was fetched before the worker controlled the page | PASS |
| 6 | D3 failed-command prefill does not leak into the next level | PASS |
| 7 | D4 unknown game's level URL on a slow link: not-found page, no boot | PASS |
| 8 | TestGame control | PASS |
| 9 | Ten-game smoke | PASS (10/10) |
| 10 | Deep play | PASS |
| 11 | Landing page | PASS |
| 12–15 | Round-1 re-checks L1 (erased progress), L3 (widget embeds), L6 (bad routes), L11 (unknown game) | PASS ×4 |
| 16 | Memory | PASS — Robo peak ~6.4 GB |

Five new defects were confirmed (each re-reproduced by an independent verifier) and are fixed in the working tree
on top of `cbb925d` (not yet deployed):

| Id | Severity | Defect | Fix |
|---|---|---|---|
| N1 | minor (console noise; breaks Cypress, which fails a spec on an uncaught exception) | Every network cut throws 3–4 uncaught page errors `QED64: the Lean checker died (bootFailed\|RUNTIME_FETCH_FAILED)` (and, after a halt, `… checker halted after repeated crashes; edit the file to restart it`). Cause: the vendored relay's `failInFlight` answers the orphaned `textDocument/codeAction`, `inlayHint`, `semanticTokens/full` requests with JSON-RPC `-32603`; `vscode-languageclient` 9.0.1 `handleFailedRequest` rethrows every code except `-32097`/`-32096`/`-32800`/`-32801`/`-32802`, and Monaco's unexpected-error handler rethrows from a `setTimeout`. Upstream's websocket drop answers `-32097` (PendingResponseRejected), which the client swallows | **fixed** game-side, the vendored relay untouched — `game-translation.ts` (it sits between the editor client and the relay port) remembers the method of every request it forwards; a server→client error answer whose message starts with `QED64: the Lean checker died` or contains `checker halted` becomes `result: null` (what `handleFailedRequest` returns for `-32097` anyway) for every method except `$/lean/rpc/*` (their `-32900` drives the infoview's session recovery) and the lifecycle requests `initialize`/`shutdown` (those keep an error, as `-32097`, message kept); an answer to an id it never forwarded is left alone. A null result rather than `-32097` because lean4monaco's `messageStrategy` (`node_modules/lean4monaco/dist/monacoleanclient.js:16-21`, `handleMessage`: `if (message.error) displayNotification("Error", …)`) shows EVERY error response that crosses the client connection as an error notification → `console.error`, whatever its code (upstream rejects orphaned requests inside vscode-jsonrpc, so nothing reaches that hook there). Unit test in `game-translation-guard.test.ts` |
| N2 | minor/medium | On a slow first visit (300 kB/s shared link) the service worker's install exceeds Chromium's 300 s install-event timeout — it waited on 235 precache fetches plus `/`, competing with the 147 MB runtime and the game snapshot — the version goes redundant, the registration is deleted, `navigator.serviceWorker.ready` never settles, the D2 offline warm-up never runs, and the game is not offline-playable after that visit | **fixed** — (1) split precache (`scripts/build-sw.mjs` emits `CRITICAL`, `sw.template.js`): the install caches only the critical shell — the closure a LEVEL page needs to render offline: the document as a fresh copy of `/` + `/index.html`, every `/assets` `.js`/`.wasm`/`.json`/`.css`/`.html` (the entry and every lazy chunk: extension host, LeanMonaco's theme defaults, onig wasm, grammars — they change hash on every deploy, so a previous shell cannot stand in), `/infoview/*`, `/locales/en/*`, `/workers/*.js`, the artifact manifests, `/api/games`, the small root files — 68 files, 16.9 MB, mostly answered by the HTTP cache (the first cut, 17 files / 10.9 MB of entry chunks only, reloaded a level offline as a white page whenever the fill below had not run); an install that cannot fetch a critical file (network or storage error) or the document FAILS, so the previous worker stays in control (a 404 is tolerated); the remaining precache entries (fonts, KaTeX, other locales, icons, tile images) are filled after activation on the page's `{type:"warm-shell", entry}` (bounded concurrency 6, skips what the shell cache holds, 45 s start budget and a 2-min hard abort per message, the page repeats while it makes progress), posted only while no Lean download runs (after `markServed`; on the landing page between Prepares) and only to THIS build's worker: the page asks for an update check and waits for an installing/waiting worker to settle first, and re-posts when the target goes redundant, loses control, never answers (the deployed previous worker ignores the message) or answers `current: false` (its precache list lacks the page's entry script); an incomplete fill is not memoized, so a later page event retries. A `warm` without `pageFillsShell: true` (an old-build page this worker claimed) is followed by the worker's own shell fill. Invariants kept: fresh redirect-free `/`, no HTML under non-HTML names, cache-first only for hashed assets, previous shell kept one generation once the new shell is complete and two while it is not (never more: a fill that keeps failing no longer grows storage by a shell per deploy); (2) `wasm/sw-client.ts` + `index.tsx`: a game route defers `register()` until the game is served or 60 s after load, whichever first; the landing page registers on load; (3) a registration that vanished is registered again once (`whenServiceWorkerReady` looks it up every 10 s while the warm-up or the shell fill waits; `ensureServiceWorkerRegistration`). A game page that is never served (unknown game, failed boot, a relay halted before its first `serving`, a deploy problem) still registers at 60 s and fills its shell once no download runs (`leanDownloadInFlight` counts a halted boot as idle; the fill waits on it at most 30 min). Also: the `warm` handler works its list in order — data files 6 at a time, runtime chunks ONE at a time beside them — stops starting fetches at 3 min and aborts every fetch still running at 4 min (one AbortController per message), so the event always settles inside Chromium's 5-minute event limit with every completed chunk stored, and answers `partial: true`; `game-cache.ts` `warmRuntimeCacheOutcome` re-sends the message while a round adds files (at most 8 rounds) for EVERY caller — the boot's warm-up and a landing-page Prepare, whose tile stays at "caching the checker…" through the rounds and, if they stop short, says the checker is only partly cached instead of a plain "Ready" |
| N3 | tab crash | An open inventory doc refetched its file 4–60 times a second and leaked ~8.6 MB per refetch until the tab died of V8 OOM after 9–15 s (upstream lean4game main bug; adam.math.hhu.de runs an older build) | **fixed** — `store/inventory-atoms.ts`: the doc atom families compare their `[tab, name]` keys element-wise (`sameDocKey`; the default reference comparison minted a new query atom per render), and the legacy-name family has its own `queryKey`; that family (doc__Lemma__*, games from before the Lemma → Theorem rename) is only a fallback — enabled for a theorem whose new-name doc failed, `retry: false` (no served game has a legacy file: each retry was a 404) — and neither family fetches with no doc selected |
| N4 | latency | `HEAD` of an artifact (`.snapz`) at the edge took 3–8 s: `infra/worker.js` answered it from R2 `get()`, which opens the object body | **fixed** — `HEAD` is answered from R2 `head()`; `infra/worker.test.mjs` |
| N5 | cosmetic | Inventory docs reached the offline cache 9–20 s after the first goal: the game-data warm ran serially, after `markServed`, behind the runtime list | **fixed** — `game-boot.ts`: as soon as the game data's URLs are known and a worker is already active, a `warm-data` message (its own type: a previous deploy's worker ignores it instead of pruning its runtime) caches them; `offlineDataUrls` lists `inventory.json` and the docs first; `warmRuntimeCacheOutcome` puts the data before the chunks; the worker fetches 6 at a time |

Not verified here: the deployed site (a shell + edge-worker redeploy; no artifact change), Cypress, and the
ten-game smoke on this build (browser time was shared with another session; NNG4 and STG4 were played). A page of
the PREVIOUS build controlled by the new worker never sends `warm-shell` (it predates the message); its boot's
`warm` (no `pageFillsShell`) makes the worker fill the shell itself, and the critical set alone already renders a
level offline (review round below). That old-page path is read from the code, not probed.

Measurements (local build of the working tree, `scripts/serve-dist.mjs` on :3006; for N2/N5 behind
`qed64/work/lv-r3-chaosproxy.mjs` — the r2 chaos proxy with ONE shared token bucket for `/__rateall` and the live
host's caching headers: hashed assets, runtime chunks and `.snapz` `immutable`, the rest `max-age=0,
must-revalidate` + content ETag with 304s; probes `lv-r3-*.mjs`, evidence under the session scratchpad
`lv-shots/r3/`):

| Probe | Result |
|---|---|
| N1 `lv-r3-n1-cut.mjs` (sed copy of `lv-live2-verify-N1.mjs`: fresh profile, `.snapz` paced 4 MB/s, 20 s cut 6.4 s into its body; no worker controlling, so the cut also halts the relay) | **0 uncaught page errors** (live before the fix: 3), 0 unhandled rejections; the relay's answers `codeAction`/`inlayHint`/`semanticTokens/full` `-32603` reach the editor as `-32097`, `$/lean/rpc/connect` keeps `-32900`, the halted refusal of `rpc/connect` keeps `-32603`; "download was interrupted" card, goal 65.8 s after the link returned, no "Crashed!". Still logged (not thrown): one `console.error` per orphaned request with the bare relay message (5 × `…died (bootFailed)`, 1 × `(crash)`, 2 × `checker halted …`) — their stack is the standalone notification service (`notify` ← `$showMessage` from the extension host), i.e. lean4monaco's `messageStrategy` (`monacoleanclient.js:16-21`, `displayNotification("Error", message.error.message)` for every error response → `window.showErrorMessage` → `MainThreadMessageService.$showMessage` → `StandaloneNotificationService.notify` → `console.error`), not `handleFailedRequest` (its own notifications are disabled by `revealOutputChannelOn: Never` and carry "Request … failed."); the live run before the fix had the same 4 console lines next to the 3 page errors |
| N2 `lv-r3-n2-firstvisit.mjs slow300 307200` (fresh profile, NNG4 Tutorial/1, every body through one 300 kB/s bucket; CDP `ServiceWorker.enable`) | load event +33 s; registration deferred, `register()` 60 s after load (+93.5 s); install of the critical shell 7.8 s (installing +93.5 → activated +101.3 s, `controlled=1`); **no redundant version, registration never deleted**; the page stayed controlled for the rest of the boot (runtime chunks cached as they passed); goal +1066.5 s at 326.9 MB on the wire; `offline cache: 192/192 runtime + game-data files cached`; `rfl` completes; shell fill after `markServed`: `225/234` (first 45 s round) → `234/234 — complete` (+1140 s, shell cache 235 = 234 + `/`); offline reload (proxy refusing everything): goal 6.7 s, `rfl` completes, 0 page errors; offline landing: 9 tiles, 9 cover images |
| N2 `… slow100 102400` (same at 100 kB/s; NNG4 — run before the coordinator asked for shorter slow-link probes) | load event +99 s; `register()` at +160.1 s, activated + controlling at +197.8 s (install 37.7 s while competing with the runtime download); no redundant version, no deletion; goal +4087 s (418 MB on the wire — more than the 327 MB of the 300 kB/s run; not investigated); warm-up `192/192`; shell fill `168/234` → `234/234 — complete` (+4316 s); offline reload goal 6.8 s + `rfl`; offline landing 9/9 tiles |
| N2 `… fast 0` (unthrottled) | served 6.5 s → registered, installing → activated 0.1 s, `192/192`, `234/234 — complete` 0.6 s after `markServed`; goal 8.7 s; offline reload goal 6.8 s + `rfl`; offline landing 9 tiles / 9 images |
| N2 landing `lv-r3-landing-fill.mjs` (fresh profile, landing page only) | `[sw] registered (page loaded)` 0.4 s, activated + controlling 0.5 s, `shell fill: 234/234 — complete` 0.6 s; shell cache 235 entries; offline reload of the landing page: 9 tiles, 9 images, fonts loaded |
| N2 prune `lv-r3-prune.mjs` (two superseded shells `old0`, `old1` planted, one entry of the current shell deleted) | the next `warm-shell` refetched the 1 missing file, reported `complete`, `pruned: 1`: `old0` deleted, the newest previous `old1` kept |
| N2 (3) `lv-r3-n2-reregister.mjs` (the proxy parks `/robots.txt` — a critical file the page never requests — so the first install hangs; released when the version goes redundant) | served 6.3 s → registered; warm-up `no active service worker` at +36 s; Chromium's install timeout made version 0 `redundant` at +306.4 s (CDP never reported the registration as deleted — the page's `getRegistration()` simply returns nothing); `[sw] the registration is gone (the install did not complete) — registering again` at +316.4 s (the 10 s look-up), version 1 activated + controlling at once, `shell fill: 234/234 — complete` and `offline cache: 192/192` at +316.6 s; offline reload: goal 5.5 s, `rfl` completes. The first run of this probe found a race in the watcher — the warm-up's and the shell fill's waits each ran their own, one saw the registration missing while the other's `register()` was still settling, gave up, and the warm-up never ran (`lv-shots/r3/n2-reregister-2.log`: shell filled, no `offline cache` line); fixed by one shared watcher per page (`whenServiceWorkerReady`) and `ensureServiceWorkerRegistration` deferring to a re-registration already under way |
| Final build (all of the above) `lv-r3-n2-firstvisit.mjs fast-final 0` + `lv-r3-landing-fill.mjs` | registered on serve, activated + controlling 5.9 s, `192/192`, `234/234 — complete` 6.2 s, goal 8.6 s, offline reload goal 6.7 s + `rfl`, offline landing 9/9; landing: registered 0.4 s, `234/234 — complete` 0.7 s, offline landing 9 tiles / 9 images. (The N1, slow300, slow100, fast, landing, prune, N5 and N3 rows above ran on the build before the last `sw-client.ts` change — the shared watcher, the 60 s-registration shell fill and the path-form game route — which those paths do not exercise) |
| N5 `lv-r3-n5-warm.mjs A` (fresh profile, unthrottled) | goal 8.2 s; all 97 NNG4 docs in `l4g-runtime-v1` AT the goal (`docsCompleteAfterGoalS: 0`; live before: 9–20 s) |
| N5 `… B` (returning profile, the 97 docs deleted from the cache first) | `game data cached early: 179/179 files` 0.5 s after navigation; goal 6.6 s with 97/97 docs (`docsCompleteAfterGoalS: 0`), 0.2 MB on the wire |
| N5 `… D` (B, then quit the browser 1 s after the goal; relaunch with the link cut) | 97 docs at the quit; offline: goal 6.2 s, the `rfl` doc opens from the cache |
| N3 `lv-docloop-local.mjs` (STG4 Subset/1, one doc open 5 s) | Theorem doc 4 fetches / 5 s, Tactic doc 2 / 5 s — bounded (live before: 4–60 per second). Per URL (`lv-r3x-docfetch.mjs`, 12 s): 1× `doc__Theorem__` + 4× `doc__Lemma__` (0/1/3/7 s: the legacy query's retries); Tactic: the same file twice (both families). Re-measured after the legacy-query fix: see below |
| N3 heap `lv-r3-n3-heap.mjs` (forced GC + `Runtime.getHeapUsage` every 1 s for 10 s with one doc open) | Theorem doc 34.9 → 34.6 MB (spread 0.3 MB), Tactic doc 34.7 MB flat (spread 0.0 MB); no crash, 0 page errors (live before: ~8.6 MB per refetch, V8 OOM after 9–15 s) |
| N4 `node --test infra/worker.test.mjs` | 20/20 pass (HEAD answered from `head()`, no body opened; HEAD ignores Range) |
| Unit tests | `game-translation.test.ts`, `game-translation-guard.test.ts` (incl. the N1 rewrite), `msg-embed.test.ts`: pass; `tsc --noEmit`: no errors in the changed modules (the pre-existing strictness errors at `inventory-atoms.ts` 100–141, outside the N3 hunks, are untouched) |


#### Review round on the fixes (r3x)

A review of the working tree confirmed thirteen findings against the N1–N5 fixes; all are fixed in the working tree
(sw `bc9e0a42946a`; probes `qed64/work/lv-r3x-*.mjs`, evidence under the session scratchpad `lv-shots/r3x/fix/`,
the reviewers' runs kept in `lv-shots/r3x/pre-fix/`):

| Finding | Fix | Measured after the fix |
|---|---|---|
| The first page after a deploy posted `warm-shell` to the OUTGOING worker (it answered for its own shell, or — the deployed one — never); the new shell stayed at the critical set | `sw-client.ts` `requestShellFill`: asks for an update check, waits until no worker is installing/waiting, posts `{type:"warm-shell", entry}` to the then-active worker; a target that goes redundant, loses control, never answers (150 s) or answers `current: false` is replaced by the new active worker (not counted as a round); an incomplete outcome is not memoized | `lv-r3x-swupdate-fill.mjs newer`: `shell fill: 234/234 — complete (worker bc9e0a42946a)` at 5.6 s, new shell 235 (before: 18); `… deployed`: same at 5.5 s, 235 (before: no fill line, 18); `lv-r3x-oldsw-fill.mjs`: `newShellEntries 235` at 2.8 s (before: 18, no fill line) |
| The critical install set could not reload a level offline (white page) when the fill never ran | `build-sw.mjs` CRITICAL = the level-page closure (68 files, 16.9 MB); a `warm` without `pageFillsShell` (an old-build page) is followed by the worker's own fill | `lv-r3x-nofill-offline.mjs` (every `warm-shell` dropped): offline relaunch goal + Monaco at 6.5 s, `lazyMissing: []` (before: white page, 43 files missing). Install cost: TestGame first visit at 300 kB/s, registered at the 60 s point: installing → activated 31.3 s (`lv-r3x-fix-install-slow.mjs game`; the 17-file set: 7.8 s); landing page at 100 kB/s: see the row below |
| Six 16 MB chunks in flight past the 5-minute event limit stored nothing | `warmUrls`: chunks 1 at a time beside 6 data fetches, start budget 3 min, every fetch aborted at 4 min | `lv-r3x-warm-slow.mjs` (250 kB/s, the Prepare's list): chunks cached 1 @ 80 s, 2 @ 140 s, 3 @ 195 s; reply `{"cached":6,"total":13,"partial":true}` after 192.3 s (before: 0 chunks, reply after 390 s) |
| A Prepare took a `partial` reply as done ("Ready — plays offline" with 4 of 10 chunks never fetched) | `game-cache.ts` `warmRuntimeCacheOutcome` re-sends while a round adds files (≤ 8 rounds) for every caller; the boot's own loop is gone; a Prepare stays `warming` through the rounds, and a reply still partial after them shows "The checker is only partly cached" on the tile | `lv-r3x-prepare-partial.mjs` (NNG4, chunks at 600 kB/s): `runtime warm-up: 10/13 files so far — continuing (round 2)` at 192 s, `prepare nng4: region done; runtime 13/13 files cached` at 256 s, 10/10 chunks cached, 10 chunk requests / 153.6 MB (before: 6/10, 4 never requested) |
| Superseded shells were never pruned while the current shell was incomplete | `pruneShells(keep)`: two previous shells while incomplete, one once complete (activate and every fill) | `lv-r3x-fix-prune-quota.mjs 24` (quota clamped so the fill fails 93 files): shells `old1, old2, current` while clamped (`old0` pruned at activate); after unclamping `complete`, `pruned: 1` → `old2, current`. `lv-r3x-fix-prune.mjs`: `old0` pruned, `old1` kept |
| The install no longer failed when the document or a critical file could not be fetched | install throws on any network/storage error among CRITICAL or a missing document (404 tolerated) | `lv-r3x-sw-install-netdrop.mjs` (node-vm): v2 install REJECTED, v1 stays in control, offline navigation and worker scripts from v1 |
| The shell fill waited forever on a relay halted before it served | `game-boot.ts` `leanDownloadInFlight`: a halted relay or a deploy problem is not a download; `requestShellFill` waits on `busy()` at most 30 min | `lv-r3x-halt-fill.mjs`: relay halted at 0.9 s, `registered (60 s after load)` 60.4 s, `shell fill: 234/234 — complete` 60.7 s (before: no fill line) |
| N1: lean4monaco's `messageStrategy` logs every error response | orphaned feature requests answered `result: null` (lifecycle requests keep `-32097`) | `lv-r3x-fix-n1-cut.mjs`: 0 page errors, 0 unhandled rejections; QED64 `console.error` lines 8 → 4 — the remaining four are the `$/lean/rpc/connect` error answers (`-32900` ×2 "died (bootFailed)/(crash)", `-32603` ×2 "checker halted"), deliberately untouched (the infoview's session recovery keys on them); goal 66 s after the link returned |
| N3: the legacy doc query always ran (Theorem: 1 + 4 failing `doc__Lemma__` fetches; Tactic: the same file twice) | legacy family enabled only for a theorem whose new-name doc failed, `retry: false`; neither family fetches with no doc selected | `lv-r3x-docfetch.mjs` (12 s open): Theorem `{"doc__Theorem__And.intro.json":["0.0s:200"]}` total 1; Tactic `{"doc__Tactic__apply.json":["0.0s:200"]}` total 1; 0 console errors |
| Regression | — | `lv-r3x-fix-n2-firstvisit.mjs fast-final 0` (NNG4): activated 6.2 s, goal 8.6 s, `192/192`, `234/234 — complete`, `rfl` ok, offline goal 6.7 s, offline landing 9 tiles / 9 images; `lv-r3x-fix-landing-fill.mjs`: registered 0.4 s, `234/234 — complete` 0.7 s, offline landing 9/9; `lv-r3x-fix-n5-warm.mjs A`: goal 6.7 s, `docsCompleteAfterGoalS: 0`; unit tests pass, worker tests 20/20 |

Slow landing page (`lv-r3x-fix-install-slow.mjs landing 102400`: fresh profile, the landing page registers on load,
every body through one 100 kB/s bucket shared with the 9 tile images): load event +99.4 s, installing +100.3 s. In the
proxy, two large bodies were cut deterministically (`ERR_CONTENT_LENGTH_MISMATCH`: the worker's
`/assets/extensionHost.worker-*.js` at +178 s, the page's JuliaMono font at +265 s — the same two in three runs; most
likely the test proxy idling a paused upstream socket, not the host). Without a retry the install failed on the cut
chunk and the version went redundant at +299.1 s; the page re-registered at once and, the failed attempt's shell cache
being reused, activated at +326.3 s (`lv-shots/r3x/fix/install-slow-landing-run1|run2`). With the install's second
pass over what a transient error cut (`sw.template.js` install), the final run installed in 225.5 s (activated
+325.8 s, no redundant version) and the fill reported `234/234 — complete` at +427.6 s. The margin to Chromium's 300 s
install timeout is ~75 s at 100 kB/s on a landing page that also loads its tile images; below ~75 kB/s the first
install may time out, and the re-registration (one per page) then finishes it from the partial shell cache —
not measured at that rate. One of four TestGame runs of `lv-r3x-nofill-offline.mjs` lost its renderer during the
online visit (`Target crashed`, after the game was served; the offline relaunch still passed); two re-runs with crash
logging (`lv-r3x-fix-nofill.mjs`) did not reproduce it — cause not determined.

## Freeze fix (HARDENING #52) 2026-10-02

The vendored qed64 closure moved `32e5e62` → `3b42714` (wasm/KERNEL.md,
substrate pin): the worker now runs its runtime mailbox in message mode,
kicks it every second (healing a lost wakeup — the freeze where the page
said "elaborating" for ever with the heartbeat ticking), probes the Lean
side while work is owed and turns a frozen worker into a death "wedged",
and reports a FileWorker exit as a death "exit" with its code. Runtime
(`wasm64-d77d34b97592d014`) and snapshots unchanged. Game side
(`death-kind.ts`, `game-boot.ts`, `infoview/main.tsx`): both reasons are
runtime verdicts, never held for the network and never probed as a link
problem; a "wedged" reboot shows "the checker stalled and is restarting —
your proof is kept" for the whole reboot (input gate and boot strip); an
"exit" is a crash — the replay dies again, the breaker halts, and the card
reads "The checker stopped: Lean exited with code N" with Restart (also on a
page that never reached "ready": a runtime verdict means the runtime started,
so never the "Lean could not start" boot-failure card); the way out is an
edit — a step pending when the checker halted is put back into the input
(released at once, cursor on its line, so Execute replaces it), and without
a proof state the card offers "Remove the last line (…)"; a halted
checker now shows its card under the proof steps too (it was only shown
while the level had no proof state, so a mid-proof halt left stale steps
and no word). Drills (`qed64/work/lv-ff-liveness.mjs`, faults injected into
the live worker with Playwright, NNG4 Addition/1, local build on :3006,
headless Chromium, through the browser lock):

| Drill | Result |
|---|---|
| mailbox mode at boot | `waitAsyncPolyfilled` true, `checkMailboxCounted` installed, `waiting_async` (pthread_ptr+204) 0, proxied calls counted, FileWorker exit hooked, mailbox word located; worker log `[boot] runtime mailbox: message notifications (no Atomics.waitAsync); proxied calls counted; FileWorker exit hooked`; `status.liveness` all 0, `pool.parked` -1 |
| (d) idle, 25 s | 0 probes, 0 stalls, 0 rescues, 0 link probes |
| (a) 10% of mailbox notifications dropped, 12 edits (5 steps, Retry, 5 steps, Retry) | 12/12 settled (4.9–15.7 s each; normally ~1 s), 1,215 notifications, 130 dropped, **130 rescues**, 0 probes, 0 deaths; fault removed → next edit 0.5 s |
| (b) mailbox disabled + one edit | died "wedged" at 22.7 s / 19.5 s (two runs), the stalled label on the input gate and the boot strip at the same moment, replay on a new session settled at 29.5 s / 26.9 s with the command kept; 1 death, 1 reboot, 0 breaker trips; no network card, no "checking the connection", no "Crashed!", 0 link probes |
| (c) raw `exit` into every new worker's ring (death classification, breaker, card — NOT a content-caused exit: the injection ignores the text and lands after a settled step) | died "exit" (`lean --worker exited with code 0`) 2.2 s after the injection, ×3 → breaker at 9.8 s; card "The checker stopped: Lean exited with code 0 / Lean exited with code 0 while replaying this level, so the checker stopped retrying" under the proof step with Retry + "Remove the last line (induction n with d hd)" + "Restart the checker"; no network card/probe/hold, no "Crashed!"; Restart (no more injection) → serving/ready in 6.6 s, the step kept |
| (g) content-caused exit (`lv-ff-exit-content.mjs`): after one step, type `#eval (IO.Process.exit 3 : IO Unit)` | deaths exit@1.0/7.1/13.3 s (code 3) → halted; card "The step you just entered (#eval …) made Lean exit with code 3 …"; input released 24 ms after the halt was seen with the step back in it (before: "Checking…" locked ≥ 30 s); typing `rw [add_zero]` instead re-arms → serving/ready in 8.1 s, steps [induction, rw [add_zero]], exit line gone from the saved text |
| (g) reload with that text saved (page never reaches "ready") | halted after exits at 5.1/11.4/17.7 s, `qed64GameReady` false; the exit card (code 3), not "Lean could not start"; typewriter not disabled; buttons "Remove the last line (#eval (IO.Process.exit 3 : IO Unit))" + "Restart the checker"; Restart replays and halts again (+3 exits, 20.4 s — the faithful verdict); "Remove the last line" → serving/ready in 8.7 s with both good steps, saved text without the exit line |
| (e) reload storm (`lv-ff-reload-storm.mjs`, port of qed64 `reload-storm.mjs`): 5 fresh-browser runs, NNG4 Addition/2 ready → relay restart (raw exit) → 5 reloads 3 s apart while live → ready → relay restart → ready | **0/5 renderer crashes**, every run ready after the storm (5.7–5.9 s) and after the second restart (5.5–5.9 s); peak live workers 26–31; 0 page errors |
| (f) network cuts still a network hold | `lv-ff-n1-cut.mjs` (20 s cut 6.3 s into the paced `.snapz`): "download was interrupted" card, goal 65.8 s after the link returned, 0 page errors, 0 unhandled rejections, no "Crashed!"; `lv-ff-D1-nosw.mjs` (no service worker, bare deaths): halted → "checking the connection" → interrupted card, automatic re-arm, goal 65.7 s after the link returned, 0 page errors |

0 uncaught page errors across all drills. The halted exit label claims only
the last death ("… while replaying this level"): the breaker's 120 s window
can mix kinds (the first liveness run showed "exited with code 0 each time"
after one wedge and two exits). Not drilled: a content-caused exit in editor
mode (the editor is editable there; no card), the long silent
command (qed64's negative control — a ~40 s `#eval` answering probes; the
game's levels have no such command) and a stall that resumes inside the
grace window (unit-tested on the vendored worker,
`client/src/wasm/vendor-liveness.test.ts`).

### Live verification 2026-10-02 (round 3 + freeze fix, commit 955225e)

All 24 checks passed on the live site: network cuts with zero uncaught page
errors (service worker controlling and blocked), slow first visits at 300 and
240 kB/s (activation, warm-up, shell fill, offline reload), an open inventory
doc fetching once with a flat heap, snapshot HEAD in 0.13–0.45 s (the
"checking this game's environment" label is on screen for ~0.8 s), all 97
NNG4 docs cached by the first goal, the flapping link; the freeze-fix drills
(message-mode mailbox, idle sessions never probed, 140/140 lost wakeups
rescued, a total stall dying as "wedged" at ~24 s with the stalled label and
the proof kept, exit cards for codes 0 and 3 with "Remove the last line" and
"Restart the checker", reload storm 0/5); and the regression (ten-game smoke
10/10, deep play 3/3, landing, the round-1/2 re-checks, offline with two
games, Robo first visit ~7.3 GB renderer peak).

One confirmed minor finding: on a 300 kB/s first visit the service-worker
install event took 273–280 s against Chromium's 300 s limit, because the
deferred registration's 60 s fallback started the install while the runtime
was still downloading on the same HTTP/2 connection. Fix: the fallback now
also waits until no Lean download is in flight (capped at 30 min); a served
game registers at once as before. Locally at 300 kB/s the install now takes
20.4 s after the game is served; an unknown game and a halted boot still
register at 60 s; the landing page registers on load.

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
  boot-time transient copies landed as qed64 "W5a" and is vendored with the
  `f98e009` pin (2026-09-07): `lean.worker.js` keeps two snapshot load
  paths (raw OPFS sync-read into a wasm allocation, or fetch → gunzip →
  heap) and drops the compressed-snapshot cache, the download tee and the
  MEMFS staging file. Same-day A/B on the recipe, three passes each: the
  previous worker survived 0 of 3 and its boot after the second reload took
  14 s in two passes (the stacked-heap signature); the new worker boots in
  5.8 s after every reload and survived 1 of 3. Improved, not closed. qed64's
  per-process attribution (their HARDENING #44 and its follow-up) puts the
  remaining floor in V8's lazily generated machine code for the 106 MB
  module (~7.5 GB before any snapshot); the pthread-pool patch they tried
  against it (0033) measured as a no-op and was dropped. Nothing below the
  kernel moves it — a leaner module or fewer initializers is kernel
  research. Fresh-page storms at 100–250 ms never crash.
- Listed games are the `listed: true` rows of `wasm/catalog.json`; adding
  one is `wasm/PORTING.md`.
- The boot strip can cover the bottom row of world-map labels during the
  first boot (scrollable, not lost).
