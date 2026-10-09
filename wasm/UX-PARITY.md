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

### Live check of 476e8b6 and slow-link prefetch fix (HARDENING #54), 2026-10-03

**Live, commit 476e8b6.** Fresh profile, TestGame level 1, every byte
through one 300 kB/s bucket (`qed64/work/lv-live3-verify-D1-firstvisit.mjs`):

- The service worker registered when the game was served (+1004 s). Its
  install event took 5.9 s; it was 273–280 s on 955225e.
- The goal appeared at +1007 s with 309 MB on the wire (nothing downloaded
  twice), and the proof completed.
- The offline cache held all 28 runtime and game-data files and all 234
  shell files.
- Offline, the same level showed its goal 5.7 s after navigation and the
  proof completed; the landing page showed 9 tiles. No page errors.

**Slow-link prefetch (commits 7dab308 and 18cc7da).** Both the game's
Prepare (`game-cache.ts` `prefetchRawSnapshot`) and the vendored boot
(`qed64-boot.ts` `ensureRawSnapshotCached`, qed64 3e182ff) used to abandon
the raw-region prefetch worker a fixed 15 min after it started. On links
below ~2.5 Mbit/s that cut the largest regions (~280 MB gzip) short. Prepare
then failed with its partial deleted; the boot let the Lean worker download
the region again from zero. Both now give up only after 3 min without a
message, re-armed by every message. The prefetch worker reports every
500 ms while bytes arrive; it used to report once per 64 MiB inflated.

Local build, the NNG4 region (154 MB) paced by an in-probe proxy, everything
else unpaced (`qed64/work/lv-r4-prepare-silence.mjs`,
`lv-r4-boot-silence.mjs`):

| Path | Steady 160 kB/s (past the old 900 s) | Region request stalls (connection held open) |
|---|---|---|
| Prepare | Done at 965 s with one region request. The 569 MB region was committed, the runtime was cached (13/13 files), and the tile reads "Ready — plays offline". The tile's count rose about 1 MB every 5 s. | Stalled at 60 MB (+375 s). At +555 s (180 s later) the tile read "Preparation failed: the download stalled (no data for 3 minutes)" with Retry. No `.partial` was left in OPFS. |
| First boot | Ready at 970 s with one region request and no "raw prefetch silent" line; `rfl` proved the level. The banner text changed 193 times, never more than ~5 s apart. | Stalled at 40 MB (+253 s). At +433 s (180 s later): `[qed64] raw prefetch silent for 180 s`. The Lean worker's own region request then took the full 154 MB; ready at +474 s, level proved. |

Unit test `client/src/wasm/game-cache-prefetch.test.ts` (fake clock, Worker
and OPFS): 5/5. It fails both regressions it guards against: no re-arm on
progress, and a re-arm after the outcome.

### Live run of 22eda45 (D1–D8) and the fixes, 2026-10-03

The live run of 22eda45 (evidence `lv-shots/live4-*`) confirmed seven
findings; D5 (the boot banner frozen per 16 MiB runtime chunk) is in the
vendored `lean.worker.js` and was reported to qed64. The fixes, by finding:

| Finding | Fix |
|---|---|
| D6 (major): a game prepared only from the landing page did not boot offline ("Failed to fetch") although its tile said "Ready — plays offline": Prepare cached the region and the runtime, no game file | `game-data-urls.ts` lists a game's offline files from its `game.json` and `inventory.json` (inventory and docs first, game.json, every `level__<World>__<n>.json`, the i18n namespaces, the images its texts embed); a Prepare sends them in the same `warm` message as the runtime, and the boot's warm-up uses the same list |
| D1: the warm-up quit "stopped making progress" inside one 16 MiB chunk on a slow link; after a reload the tile said "Ready" from the OPFS region alone | the worker reports the chunk bytes a round received beyond any earlier round's (`bytes`), and such a round counts as progress; `WARM_ROUNDS` 8 → 24. A tile is `ready` only when the runtime cache holds every chunk of the current runtime and the game's `game.json`, `inventory.json` and level files; otherwise `partial` ("Environment downloaded — not yet playable offline", the cached counts, "Finish offline download", "Remove download"), read from the cache, so it holds after a reload |
| D2: a second landing tab did not show another tab's running Prepare | the `l4g-cache` channel carries `prepare-progress` (said at once, on progress at most once a second, on a phase or visibility change, and by a once-a-second heartbeat), `prepare-query` and `prepare-ended`; the tile shows "Being downloaded in another tab… N / M MB" and no Prepare. A game tab whose boot streams its region reports it too |
| D3: after tab 1's Prepare failed, tab 2's "Already being downloaded… Retry" stayed | every terminal outcome says `prepare-ended`; a look at a tab drops a busy refusal whose holder runs nowhere |
| D4: a network failure during a boot was labelled "restarting the checker after a crash (snapshot 'nng4' failed to load)" | `death-kind.ts rebootLabel`: a death the link caused reads "waiting for the connection — the download restarts on its own"; the automatic re-arm reads "starting the Lean checker" |
| D7: an offline boot of a cached game fired ~800 failing service-worker GETs | warm-ups wait for the `online` event while `navigator.onLine` is false; the worker starts no fetch after the first that fails outright (`linkDown`) and only looks the rest up |
| D8: sizes in MiB labelled "MB" (RAG "≈269 MB") | `sizes.ts`: decimal MB/GB for the tiles, Prepare's progress, the storage meter, the boot banner and the level pane (RAG "≈282 MB") |

Review round on the fixes (adversarially verified findings, all applied):

- **R1** A Prepare left running in a background tab: Chrome wakes a hidden
  tab's chained timers once a minute after 5 minutes, and the other tabs
  dropped the download after 6 s, so the tile went back to Prepare for ~54 s
  of every minute. Progress is now also said from the progress path (worker
  messages are not throttled); each message says whether its tab is hidden,
  and receivers keep a hidden sender 75 s; a tab that closes says
  `prepare-ended` on `pagehide`.
- **R2** A single transient fetch failure (ERR_NETWORK_CHANGED, one reset)
  ended the warm-up at its first round (a Prepare at 5 of 300 game files)
  or the shell fill at 17/203 for the rest of the visit. Now a link-down
  round that gained nothing gets one more round after 10 s while the
  browser says online; a second in a row ends it (`sw-client.ts
  retryAfterLinkFailure`).
- **R3** Remote downloads are kept per sender tab, so one tab's end does not
  drop another tab's download of the same snapshot. The game texts'
  embedded images are listed (RAG: 13 in game.json, 1 in a level file,
  1.8 MB); a Prepare reads the level files' images back from the runtime
  cache and caches them with one `warm-data`.
- **R4** Every warm round re-fetched every data file (`max-age=0,
  must-revalidate`): up to ~7,900 revalidations for a slow-link RAG Prepare.
  The page now sends `revalidate: false` from the round after the first one
  that reached the host, and for a boot whose early `warm-data` already
  revalidated; the worker then fetches only what the cache lacks.
- **UX1–UX5, I18N1, CQ1** No "Finish offline download" without a Cache API;
  the `partial` row states a fact, not an instruction; a warm-up the link cut
  off says "The connection dropped — try again once you are online.", not
  "stopped making progress"; failures in the `partial` row use the red
  `note failed` style; a phase change is said to other tabs at once (no
  "0 / N MB" flash); the nine new tile strings are in
  `public/locales/en/translation.json`; `prepare-ended`'s outcome is
  derived from the status (not the error's wording) and logged by receivers.

Tests: `game-cache-crosstab` 12/12, `game-data-urls` 9/9, `sw-offline-warm`
12/12 (the page's real warm-up loop against the real `sw.template.js` for
R2), `sw-warm` 3/3, `death-kind`, `game-cache-prefetch` 5/5,
`vendor-liveness` 11/11, `msg-embed`, the translation suites,
`infra/worker.test.mjs` 20/20. Each R fix was broken on purpose once and
its test failed. Smoke runs on the local build before the review round
(`qed64/work/lv-live4fix-A-smoke.mjs`, `lv-live4fix-B-smoke.mjs`): D2, D6
(NNG4 Prepare then an offline boot and proof), D1 (a deleted chunk and level
→ `partial` 9/10 and 80/81 → Finish → Ready), D7 (offline: 0 failing
warm-up GETs; a proxy cut: ~16) and D4 (a 1 s cut: no crash label) passed.
The A smoke's D1 check still matches the old `partial` wording ("finish
caching so it plays offline").

Known gaps:

- A bare "crash" death during a cut, while the relay is not halted, can
  still read "restarting the checker after a crash (crash)" for ~1.5 s,
  until the link probe classifies it and the network hold's label replaces
  it.
- The slow-link paths (byte-based progress, 24 rounds, the R2 retry, R4) and
  a reply from a worker deployed before this round (no `bytes`, `linkDown`
  or `revalidate`) are unit-tested only, not run on a throttled live link.
- Without a working service worker (the vite dev server, a failed
  registration) a downloaded game stays `partial`: "Finish offline
  download" ends with "The browser's offline cache did not answer".
- "Ready" covers the runtime chunks and the essential game files, not the
  shell, the docs, the i18n namespaces or the images (they degrade
  gracefully).
- A hidden tab that crashes without `pagehide` keeps showing "Being
  downloaded in another tab" for up to 75 s.
- Offline, the page's own reads of game files still fail once each at the
  network before the worker answers from its cache (not the warm-up storm).
- Not yet verified on the live site.

#### Round 2

**Round-1 browser results.** Local build of 0f2ecb7 on :3006, headless
Chromium, a pacing/cutting proxy in the probes (`qed64/work/lv-live4fix-*`,
evidence `lv-shots/live4fix-*`):

- **Offline** (`lv-live4fix-offline.mjs`, the proxy refusing every
  connection, Chromium still online): 13/13 steps. Logic 7/7: Prepare
  145/145 files; offline boot 6.1 s and a proof; a second level's goal in
  1.6 s; an inventory doc; the landing tile "Ready — plays offline"; the D1
  `partial` tile after deleting two runtime chunks, then game.json. NNG4
  6/6 the same way (Prepare 192/192, offline boot 5.0 s). Each offline boot
  still cost ~120 failing service-worker GETs (N1, N3 below).
- **Slow link** (`lv-live4fix-slow.mjs`, 150 kB/s, fresh profile, NNG4).
  Clicked once the worker was active: "region done; runtime 192/192 files
  cached" after 2126 s, in 10 warm rounds of ~225 s (153.6 MB of chunks);
  the tile read "Ready — plays offline", also after a reload. Clicked while
  the first worker was still installing: "region done; runtime not warmed"
  after 1146 s, no chunk cached, the tile `partial` "the checker 0 of 10
  files, this game's files 0 of 2" (S1, N2).
- **Tabs** (`lv-live4fix-tabs.mjs`, `-tabs-r.mjs`, NNG4): the other tabs
  showed a Prepare within 0.05 s with live counts. A stalled download failed
  on the 3-minute rule (179.7 s after the stall) and the other tabs dropped
  it within 0.02 s; its Retry was done in 30.9 s and every tab read Ready
  within 0.09 s. A game tab's boot region showed on a landing tab as "Being
  downloaded in another tab… N / 154 MB", then Ready. Closing or reloading a
  visible tab mid-Prepare left that line in the other tabs for 76.1 s and
  75.3 s (F1).
- **Boot** (`lv-live4fix-boot-D4.mjs`, a 20 s cut at 40 MB of the region,
  5 MB/s): ready 92.3 s after the navigation (64.8 s after link-back) and
  the proof completed; with an active worker (`PRESW=1`) 90.1 s and 62.4 s.
  An injected worker crash still read "restarting the checker after a crash
  (probe-injected crash)". A page-side watcher saw the crash label flash
  (< 0.1 s) at link-back and when the modules loaded under an active worker,
  and "after a crash (crash)" in a first visit's burst of deaths (D4
  residuals). D7 (`lv-live4fix-boot-D7.mjs`, RAG cached, offline): boot
  5.4 s and a proof, 165 failing service-worker /data GETs (~800 in the
  live run of 22eda45).
- **Smoke and Cypress:** the ten-game smoke 10/10 (each level proved and
  "Next" shown); Cypress 24/24 (`01-basic-interface` 5/5,
  `game-features` 19/19). The landing page on a fresh profile registered on
  load and filled the shell (234/234) in 3.4 s.

**The 76be299 closure sync (D5), commit 0f2ecb7.** The vendored
`lean.worker.js` streams each 16 MiB runtime chunk and reports progress
every 500 ms inside it (qed64 5e94697): at 300 kB/s the boot banner's
runtime count used to stand still for ~56 s per chunk. Length and SHA-256
verification and the force-cache → reload retry are unchanged;
`profiles.ts` does the same for the core pack's parts (76be299), which game
sessions do not install. In the round-1 runs the banner's count moved
inside a chunk ("verifying lean.wasm · 98 / 154 MB"). Accepted: after a
failed first attempt the in-chunk count steps back once (qed64 HARDENING
#54).

**Fixes of this round**, by finding:

| Finding | Fix |
|---|---|
| S1 (major): a Prepare clicked before the first-visit service worker was active never warmed the runtime or the game's files (`warmTarget` gave up after ~60 s while the region downloaded for 19 more minutes) | A Prepare's warm-up waits for a worker with no fixed cap (`game-cache.ts activeWorkerWhenInstalled`): an installing registration until it activates (`ready`, and a look every 10 s), or this page's own registration while a game page still defers it (`sw-client.ts ownServiceWorkerRegistration`, never forced). The wait ends at activation or when no registration can be had (one re-registration per page; a second loss is final), so a Prepare ends `partial`, never hangs; no service worker or the dev server still answer within seconds. The tile says what it waits for (`awaitingWorker`): a note while the region runs, "waiting for the browser to finish installing this site's offline cache…" after it |
| F1: closing or reloading a visible tab mid-Prepare left "Being downloaded in another tab…" in the other tabs for ~75 s (`pagehide` said the end, the `visibilitychange` after it said the download again, hidden) | A tab says nothing after `pagehide` until a persisted `pageshow` (a page restored from the back/forward cache says its downloads again under new ids); every download carries an id, and a receiver ignores progress of a (tab, id) it heard end for 75 s |
| D4 residuals: (a) "restarting the checker after a crash (snapshot 'nng4' failed to load)" flashed at link-back under an active worker (the recorded snapshot failure is reset while the relay still reboots with the same death); (b) a first visit's burst of deaths showed "after a crash (crash)" | `death-kind.ts deathReader`: a death is read once, by object (`network`, `silent` — no message, or a snapshot death with no failure recorded — or `own`); a network episode runs from a death the link caused until the relay serves again, and inside it a `silent` death reads as the link's too. A death with evidence of its own (an unpaired or corrupt region, a messaged crash) keeps the crash label, as do `wedged` and `exit`; a stale death cannot reopen an episode after the relay served |
| N1: offline with every file held, "the connection failed at 192/192 files — one more round" and "offline cache INCOMPLETE: 192/192" (~120 more failing GETs) | `heldButNotRevalidated`: such a round ends the warm-up as `done`; the log says all files are held but could not be revalidated |
| N2: the partial tile read "this game's files 1 of 2" without a cached game.json | the offline report says whether game.json listed the files (`data.listed`); if not, the tile says "this game's own files are not cached yet" |
| N3: offline, each network-first page read tried the network before the held copy answered | after a fetch fails outright, held `/data` and `/i18n` files answer cache-first for 5 s (bypass requests such as the L4 probe, and files not held, still go to the network; any HTTP answer ends it) |

Review round on these fixes (adversarially verified, all applied):

- **D4(b) episode** The episode lasts until a session arms, so it covered
  the whole reboot after link-back: an unpaired region, or an
  out-of-bounds crash after a network re-arm, read "waiting for the
  connection" with the link up. Only `silent` deaths join the episode now,
  and only a death not seen opening one opens it (the relay keeps handing
  out the old death after it serves).
- **R2-1** A Retry after the region failed joined the first Prepare's
  warm-up (same build id), whose wait was told only to the first Prepare: the
  retried tile never said it was waiting. The wait state lives on the
  warm-up in flight; a joiner hears it at once.
- **R2-2** A Prepare on a page whose registration was still deferred (a
  game link, then the landing page in-app) gave up 3 s in. It now waits for
  that registration; a Prepare whose region is in and whose warm-up waits
  for a worker no longer counts as a running download
  (`preparesDownloading`), so the deferral's fallback registers within ~5 s
  instead of at its 30-minute cap when the boot is never served.
- **R2-3** The wait could call `ensureServiceWorkerRegistration` on a page
  whose own registration was deferred (another tab's registration lost),
  starting the install beside the boot's download. Only a registration this
  page made is registered again.
- **R2-4** The N3 memo covered every network-first path: after a deploy and
  one blip, a new page could get the previous worker scripts and snapshot
  index. It covers `/data` and `/i18n` only.
- **R2-5** The "lost registration" test passed only because
  `import.meta.env.PROD` is undefined under node. The test now loads
  `sw-client.ts` with a switch for it and checks the once-per-page
  re-registration through `prepareGame`.

Tests: `game-cache-sw-wait` 7/7 (new: S1, R2-1, R2-2/R2-3, R2-5 on a fake
clock, service-worker container and prefetch worker), `game-cache-crosstab`
15/15 (F1), `sw-offline-warm` 16/16 (N1, N3, R2-4 against the real
`sw.template.js`), `game-data-urls` 9/9 (N2), `death-kind` (D4 residuals
and the episode review), `sw-warm` 3/3, `game-cache-prefetch` 5/5,
`vendor-liveness` 11/11, `msg-embed`, the translation suites,
`infra/worker.test.mjs` 20/20. Each fix was broken on purpose once (27
mutants) and its test failed. The `game-boot.ts` wiring of the episode was
checked against the real vendored relay with fake sessions, not in a unit
test (`game-boot` imports modules the test hook cannot resolve).

Browser results of round 2. Local build, sw `9d0342ebba44`; evidence is under
`lv-shots/live4r2-*`.

- **S1 at 150 kB/s** (`lv-live4r2-slow.mjs immediate`):
  - Prepare NNG4 was clicked while the first-visit worker was still
    installing. The console then said "waiting for the service worker to
    finish installing", and the tile showed the note.
  - The worker became active 112 s later. The warm-up then ran 10 rounds
    and ended "runtime 192/192 files cached".
  - Click to done took 2229 s, with 334 MB on the wire since the click. The
    tile read Ready, and still did after a reload.
- **D5 at 300 kB/s:** an NNG4 first boot was sampled every 1 s and watched
  for changes.
  - Through the runtime phase the label never stood still for more than
    7.0 s (it was 48–56 s per chunk before 0f2ecb7). The count never went
    backwards.
  - The boot was ready at 1086 s and proved `rfl`.
  - One cosmetic flicker: at 61 s the banner read "starting the Lean
    checker" for 0.6 s, and the time-left estimate restarted. A worker
    status during the boot re-published the relay's generic label over the
    session's stage.
  - The fix: `publishRelayStatus` keeps the StatusSink's label once the sink
    has described the boot of the same session and relay state
    (`STARTING_LABEL`, `sinkSpoke`). A new session or relay state still
    shows the relay's label until the sink speaks.
  - The same 300 kB/s NNG4 first boot after the fix (sw `56b5013751f2`):
    "starting the Lean checker" never appeared, and the runtime count was
    never still for more than 7.0 s. Ready at 1086 s, proved.
  - Also re-run after the fix:
    - `PRESW=1` D4: no crash text, the injected crash still labelled,
      ready 89.9 s.
    - Smoke 10/10.
    - Cypress 24/24.
- **F1** (`lv-live4r2-tabs.mjs` A/B/D/R/G and `-dwell`):
  - When the sending tab was reloaded, the other tab dropped its line in
    0.04 s. The reloaded tab's new Prepare then showed there from 0 MB.
  - When the sending tab was closed, the other tabs dropped it in 0.21–0.49 s.
  - When a game tab was closed while its boot streamed the region, the
    landing tab dropped it in 0.12–0.20 s.
  - Nothing came back within 12 s in any of these. Checks 1, 3 and 4 and the
    game-tab report pass as in round 1.
- **D4** (`lv-live4r2-boot-D4.mjs` with a page-side text watcher):
  - Over a 20 s cut, neither the first visit nor the `PRESW=1` run showed
    "after a crash" at any point. Each showed "waiting for the connection —
    the download restarts on its own", recovered, and proved (ready
    92.4 s / 89.5 s).
  - The injected worker crash still read "restarting the checker after a
    crash (probe-injected crash)".
- **D7, N1, N3:** RAG fully cached, then reloaded offline.
  - With the proxy refusing every connection, the boot took 6.0 s and the
    proof completed. There were 12 failing service-worker /data GETs (165
    in round 1, ~800 live). The log reads "all 357 files are held — the
    connection failed, so they were not revalidated", with no INCOMPLETE.
  - With `setOffline`, the boot took 5.4 s, with 0 failing GETs.
- **D6, D1, N2** (`lv-live4r2b-offline.mjs`, `lv-live4r2b-rag.mjs`):
  - NNG4 prepared from the landing page only. It booted offline at two
    levels never opened online, both proved, and an inventory doc opened.
  - With two runtime chunks deleted, the tile showed "checker 8 of 10";
    Finish restored Ready. With game.json deleted, it said "this game's own
    files are not cached yet"; Finish restored Ready.
  - RAG's Prepare cached 356/356 files, including the 14 embedded images.
    Offline, a level-introduction image (1594×732) and the 6 world-intro
    images rendered from the service worker.
- **Regression:**
  - The ten-game smoke passed 10/10.
  - The landing page loaded fresh in 0.4 s (shell filled in 3.5 s), cached
    in 0.3 s and offline in 0.4 s, with 0 errors. After the smoke booted
    every game, all 9 tiles read "Ready".
  - Cypress 24/24.

Known gaps after round 2:

- A hidden tab that crashes without `pagehide` still shows its download in
  the other tabs for up to 75 s (F1 covers closing and reloading).
- A Prepare on a game page whose boot is never served waits, with its
  region in, until the deferred registration's fallback runs (≤ 5 s once
  nothing downloads) and the worker installs.
- N3 covers game content only: offline, the unhashed shell files still try
  the network once each. The memo lives in the worker's memory and is lost
  when the browser stops an idle worker.
- A bare death outside a network episode still reads as a crash until the
  halt's link probe classifies it.
- Accepted, unchanged: no stall indication while a link is held (F2; the
  3-minute silence rule reports it), the ~55 kB/s shared-link floor for
  completing the runtime warm-up in 24 rounds, the in-chunk count stepping
  back once.

## Live run of 4083fb4 (2026-10-04)

Every fix of the live run of 22eda45 (rounds 1 and 2, the D5 sync and the
banner fix) passed on the live site. Bundle `index-DBgcmA22.js`, sw
`3f76c30b021b`, workers = qed64 76be299; evidence under `lv-shots/live5-*`.

| Item | Live result |
|---|---|
| D6 offline after Prepare | NNG4 Prepare 29.8 s, 309 MB; offline (proxy refusing everything) Multiplication 1 boot 5.4 s, proved; Multiplication 2 goal in 1.6 s, proved; an inventory doc from the service worker; the offline tile still Ready. RAG 356/356 files incl. 14 images; offline, a level image (1594×732) and the 6 world-intro images render |
| D8 sizes | NNG4 ≈154 MB, RAG ≈282 MB |
| D1 / N2 tiles | 2 chunks deleted → "not yet playable offline", checker 8 of 10 → Finish → Ready in 2.1 s; game.json deleted → "this game's own files are not cached yet" → Ready in 1.8 s |
| S1 | 300 kB/s, Prepare 21 s after load with the worker installing: waiting note, worker active 423 s later, 192/192 files, Ready (also after a reload); 1037 s, 318 MB |
| D2 / D3 / F1 | the remote line in a tab open before the click 0.2 s after it; sender closed → other tabs drop it in 0.35 s; reload → 0.21 s after the old page unloaded, the new Prepare shown from 0 MB; a failure or a Retry reaches the other tabs at once |
| D5 + banner | a 300 kB/s NNG4 first boot: the runtime count never still for more than 4.1 s, never backwards, no "starting the Lean checker" after the first stage; ready 1050 s, proved |
| D4 | a 20 s cut, first visit and with the worker controlling: no "after a crash" text; recovered and proved |
| D7 / N1 / N3 | RAG cached, proxy refusing: 12 failing service-worker /data GETs (~800 before), "all 357 files are held" log, boot 5.5 s, proved; Chromium offline: 0 |
| Regression | ten-game smoke 10/10; Prepare + Remove (only that region removed); offline with two games (NNG4 prepared, Knights booted once): both boot and prove offline |

Two new minor findings (adversarially confirmed; open below): a landing
tab opened while another tab downloads shows the remote line ~4.2 s after
its tiles render, because the tile waits for the index and manifest
behind the download (NEW-2); "waiting for the connection" flashes
(< 0.1 s) after link-back when the worker controls the page (NEW-3).
Refuted: a held link with the warm-up running ends "network error" at
~145 s instead of the 3-minute stall message (Chromium's HTTP/2 PING
correctly closes the dead session when warm round 2 opens streams); the
banner's unpacked total next to the tile's download size (by design; the
level pane explains it).

## SEC1: boot overrides and CSP (2026-10-04)

**The hole** (found by the QED64 embedding-contract review of 4083fb4,
reproduced twice): `games-api.ts` returned the raw `?snapshots=` /
`?profiles=` values with no check and no dev gate, and the index fetch
spliced `?snapshots` into `/${dir}/index.json`. `/evil.example/x`,
`//evil.example/x`, `\evil.example`, `%2F%2F…`, `%5C%5C…` and `%09/…` all
resolve to `https://evil.example/…/index.json` (COEP does not stop a
CORS-enabled host; there was no CSP; the service worker passes cross-origin
requests through). The `/snapshots/` re-root left the attacker index's
absolute entry URLs alone, so the pairing HEAD, the prefetch worker and the
Lean worker fetched the attacker region, and OPFS committed it under the key
the index itself names (name + digest, never verified): one crafted link
poisoned the live key for later visits, and in editor mode the infoview
imports widget JS from that environment as a blob module on this origin.
`?profiles` went cross-origin the same way; `?runtime` kept its same-origin
prefix but could path-traverse.

**The fix** (`wasm/boot-params.ts`, the rule of QED64's draft §4):

- A directory override must match `^(?:snapshots/)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`
  and `/<dir>/index.json` must resolve to the page's origin; `?runtime` must
  match `^wasm64-[0-9a-f]{16}$`. Empty, repeated and off-pattern values are
  refused loudly (`BOOT_PARAM_REFUSED`), never read as "no override". The
  query is read once per document. The boot fails before any artifact fetch
  with the reason on the card, and the landing page shows a notice and
  fetches nothing for the tiles.
- Second line: an index or a runtime manifest naming any URL on another
  origin is refused whole (`SNAPSHOT_INDEX_FOREIGN_URL`,
  `RUNTIME_MANIFEST_FOREIGN_URL`), the default ones included; the pairing
  HEAD, the prefetch worker, both warm-ups and the service worker's
  `warm`/`warm-data` take same-origin URLs only; a profile index naming a
  foreign manifest is dropped (non-fatal, like a missing one).
- `Content-Security-Policy: connect-src 'self' blob: data:` on every
  response (`infra/worker.js`, `client/public/_headers`,
  `scripts/serve-dist.mjs`). `blob:` because Emscripten fetches lean.wasm
  from a blob URL; `data:` because vite inlines the Monaco theme and
  language files as `data:` URLs that are fetched at runtime. No
  `script-src` or `default-src`.
- Editor mode now has a boot failure card (it showed "Loading goal…" for
  ever). Review round: under a network hold it is the typewriter's "waiting
  for the connection" card (R1: a first-visit network halt publishes "Lean
  failed to start" and schedules the automatic re-arm at once), and a
  refused override's card and the landing notice offer "Open without the
  override" instead of Reload (R2: a reload keeps the query and refuses
  again).
- Still working: `?snapshots=staging` (an unpromoted same-origin index; the
  sweep stands down under it).

**Tests.** `client/src/wasm/boot-params.test.ts` (16 groups): every review
vector refused for `?snapshots` and `?profiles`, `staging` /
`snapshots-0031` / `snapshots/widgets8` accepted, the `?runtime` vectors,
the way out without the overrides, and the real `games-api.ts` against a
recording fetch (a refused value fetches nothing, no fallback to the served
index; a foreign index entry or manifest chunk is refused). Added cases in
`game-cache-prefetch` (no worker for a foreign URL), `sw-warm`,
`sw-offline-warm` and `infra/worker.test.mjs` (the CSP on every response
kind; `_headers` and `serve-dist` in step). 26 of 26 test-breaking
mutations caught.

**Browser results** (final build `index-3o78CzBM.js`; an attacker server on
another local origin serving a CORS + CORP index that copies every real
entry's name and digest; evidence `lv-shots/sec1-exploit`, `sec1-regress`):

- **Vectors:** 20 level-URL vectors refused on the card with
  `BOOT_PARAM_REFUSED` and "Open without the override", 3 more in editor
  mode, and the landing page refused one with a notice. Across all of them
  the attacker logged **0 requests**, nothing was written to OPFS, and a
  stored real nng4 region was untouched.
  - `?snapshots=` with `/H/x`, `//H/x`, `%2F%2F…`, `%5C%5C…`, `%5C/…`,
    `\/…`, `%09/…`, `http://H/x`, the bare host `H`, a traversal, and an
    empty value.
  - A repeated parameter in both orders, and the encoded name
    `%73napshots`.
  - `?profiles=` with three vectors, and `?runtime=` with two traversals.
- **Tampered index:** a site whose own index names an attacker URL
  (absolute or `//`) is refused whole with `SNAPSHOT_INDEX_FOREIGN_URL`, on
  the card and on the landing page.
- **Legit override:** `?snapshots=snapshots` booted and proved under the
  CSP, and the sweep stood down.
- **CSP itself:** the header blocks cross-origin fetch, XHR and WebSocket
  from the page console, while same-origin, `blob:` and `data:` pass.
- **Regression under the CSP**, with Chromium's own log watched so that
  worker and service-worker refusals count too:
  - ten-game smoke 10/10;
  - Prepare NNG4 then an offline boot of two never-visited levels and a doc;
  - the partial-tile checks;
  - an editor-mode proof;
  - Cypress 24/24 with the app's CSP enforced (`experimentalCspAllowList`;
    plain Cypress strips it).
  - **0** CSP violations in ~8,400 console lines.
- **Not covered:** `connect-src` does not govern script loads. A
  cross-origin `import()` from the console still reaches its host. No SEC1
  path uses one, since overrides are refused before any fetch and widget
  code comes through a covered fetch. A `script-src` would need its own
  inventory (blob: widget modules and workers, wasm).

Not changed: the vendored `qed64-boot.ts` `installArtifacts` still reads the
raw parameters (tree-shaken out of the game bundle; the fix belongs
upstream in QED64). Residual: see Open.

## QED64 as a dependency (2026-10-04)

**Why.** Until this branch the game carried a vendored copy of QED64
(`client/src/wasm/vendor/qed64`, `wasm/vendor/qed64-pipeline`, pinned in
`client/src/wasm/vendor/QED64-PIN` by `scripts/sync-qed64.sh`): a second
copy of another project's files, kept in step by hand, which the game also
reached into (`GameSession`'s private `request("write-files")`, regex
rewrites of qed64's label prose, death reasons read off message text). The
decision: lean4game depends on QED64 as an npm git dependency, uses only the
parts it needs, duplicates nothing, and stays cloneable and buildable by
anyone. The contract is QED64 `docs/EMBEDDING.md` v1 at `84d594e` (branch
`feature/embedding-api`; first pinned at `90aef68`, bumped 2026-10-05 —
"Bump to `84d594e`" below; ours are §6 the package, §7 the library API, §10
migration and §12 changes since the draft) and its `embedding/closure.json`.
The package carries an MIT LICENSE; its confirmation is pending on the
QED64 side. Branch `qed64-dep`, from `b9292f8`; evidence under
`lv-shots/qd-dep`, `lv-shots/qd-b11`.

**What was deleted** (phase 1): the vendored copy — 11 files under
`client/src/wasm/vendor/` (relay, boot, session, client, snapshot and
profile modules, the four workers, `QED64-PIN`), 18 under
`wasm/vendor/qed64-pipeline/` (the from-source pipeline scripts and kernel
probes) — and `scripts/sync-qed64.sh`. In their place nothing is copied
into git:
- `client/package.json`: `"qed64": "github:FawadHa1der/QED64#<40-hex>"`,
  the same SHA in `package-lock.json`. `npm ci` fetches it as an https
  tarball (no git, no SSH, no QED64 checkout): 41 files (42 since `84d594e`:
  `embed/edit-coalescer.ts`), no dependencies, no install script.
- `qed64/embed` is the only import path (`client/tsconfig.json` maps it to
  the package's entry file, which moduleResolution "node" cannot find
  through the exports map; Vite resolves the map). `ts-resolve-hook.mjs`
  transpiles the package's TypeScript for the node unit tests.
- `scripts/stage-workers.sh` stages the closure's `workers[]` (`path` →
  `serveAs`) into the gitignored `client/public/workers`; `deploy-app.sh`
  checks the deploy tree against the same list.
- `wasm/build-from-source.sh` copies the closure's `pipeline` and
  `pipelineData` files into `wasm/out/pipeline` and runs them there.
- `wasm/KERNEL-PIN` gained a machine-read `patch` line: the closure's
  `runtime.minKernelPatch` (0032) is checked against it on every build. The
  game still serves its OWN runtime (`wasm64-d77d34b97592d014`, kernel
  `992dc94`) and the same snapshots; QED64 tested `90aef68` on its runtime
  `wasm64-3ab1c6a9da03bc29`.

**What the v1 API replaced** (phase 2, B11) — the game's own copies of
what the package now exports (§7):

| Was ours | Now |
|---|---|
| `GameSession extends ResidentSession`, writing the gamedata through the private `request("write-files")` | `ResidentHost.files`: the session writes them on every boot before the relay arms the loop |
| `installGameArtifacts` (own profile-index read, own foreign-manifest drop) | `installArtifacts(ui, {overrides, profiles: "none", runtime, snapshots})` with the pairing check's manifest and index |
| `resolveRuntimeManifest`, `fetchSnapshotIndexOnce` | memo wrappers over qed64's `resolveRuntimeManifest` and `loadSnapshotIndex` / `fetchSnapshotIndexFor`; the SEC1 coded refusals and the foreign-chunk check stay ours |
| the boot-parameter rule (`DIR_OVERRIDE`, `RUNTIME_OVERRIDE`), `overrideOf`, `devSnapshotsDir`, `devProfilesDir` | qed64's `validateBootOverrides`, behind `bootOverrides()`; the page still refuses an empty or doubled value, names every refusal and offers "Open without the override" |
| `refuseForeignSnapshotUrls`, `assertSameOriginSnapshot` | qed64's index loader refuses an index naming another site whole (HARDENING #57) |
| `prefetchRawSnapshot`, `PREFETCH_SILENCE_MS`, `claimSnapshotForBoot` + the busy refusal | `prefetchRaw`: one prefetch worker per region in the page, the Web Lock `qed64-raw:<key>` across tabs; a Prepare started while the boot's session prefetches joins it (it was refused `busy`); the boot still waits for a running Prepare's region first (`inFlightPrepare`, PAR-2 below) |
| `rawSnapshotCached`, `rawFileName`, `removeRawSnapshot` | `isRawCached`, `removeRawRegion` (the partial too), `isCacheKeyOf`, `snapshotCacheKey`, `SNAPSHOT_CACHE_DIR` (the sweep keeps its listed-name guard, PAR-3 below) |
| `runtimeChunkUrls`, the warm-up's chunk loop, `WORKER_SCRIPTS` | `runtimeUrls(manifest).chunks`, `WORKER_URLS` |
| `humanizeLabel` (regex rewrites of qed64's prose) | `boot-labels.ts stageLabel` from the structured `stage`/`step`/`error` |
| `noteSnapshotFailure`/`lastSnapshotFailure`, `deathReader`, `isNetworkDeath` by text, `exitCodeOf`, `EXIT_CARD_RE` | the relay's `Death`: `cause` (null = no evidence; `WORKER_SCRIPT_LOAD_FAILED` = probe the link), `exitCode`, `seq` (identity); the halt's exit code, stall and stale page travel in the checker-activity atom |
| relay-error text matching (`isOrphanedRequestError`, goals.tsx) | `error.data.qed64.kind` (`relayErrorKind`) |
| `rearmCheckerIfHalted`'s synthetic didChange (and the guarded reload with no document) | `LspRelay.rearm()` |
| the relay's internals (`state`, `lastDeath`, `lastText`) | `status()` — the projection §7 names (QD-API-3 below) |
| `SWITCHING_RE`, `ROUTINE_BUSY` (dead, B5) | deleted |

Behaviour changes:
- B4: the offline warm-up no longer names the mutable runtime manifest or
  the snapshot and profile indexes (the shell precache owns them; a RUNTIME
  copy went stale behind it).
- The stale-region sweep also removes a listed game's stale compressed
  copies (`<key>` without `.raw`), not only its stale `.raw` and partials.
  Names the page's index does not list are still never touched (PAR-3).
- `?profiles=` follows qed64's rule: `profiles/<dir>`, no longer
  `snapshots/<dir>`. A `?snapshots=<dir>` index that cannot be read is a
  named failure on the card (it used to read as "no snapshot index").
- The banner reads "loading the game environment" for the region read from
  the browser's storage (it was the worker's "loading environment
  snapshot"), and shows the session's own step "preparing 80 session files"
  (the gamedata write, ~10 ms). Every other label is unchanged, the D4 and
  #52 ones included.
- New: a worker refusing a sibling script of another revision (a deploy
  under a long-lived tab) reads as "this site was updated", with a reload
  card if the relay halts on it (QD-API-2).

**The editor-mode crash: fixed in QED64 ≥ `f150f47`** (`ResidentSession`'s
edit coalescing, EMBEDDING §7.8, `ResidentHost.editCoalesceMs`, default
300 ms; QED64 HARDENING #59). It was first closed on the game side by
`client/src/wasm/change-throttle.ts`, the measured prototype of that
coalescer, deleted with the bump to `84d594e` (below).
The crash is qed64 HARDENING #55's open item, not a session replacement: the
language client sends a full-text didChange before each of its per-keystroke
requests (vscode-languageclient flushes its pending full-document changes
before every request; the relay saw `didChange` then three `$/lean/rpc/call`
per keystroke), each change restarts the elaboration of the whole Runner
command while the cancelled ones' threads still run, the runtime's
24-worker pthread pool grows (it never shrinks), and ~35–40 isolates fill the
renderer's 4 GiB V8 cage. The session now hands the checker at most one
full-text change per 300 ms: the first at once (typewriter mode sends one
per Execute: no added latency), the newest at the window's end, and every
other frame the client sent after a held change queued behind it, in order
(didOpen, didClose, a ranged change or another document's change send the
held change first: a held change never crosses a document). What the game's
throttle did not do: a queued semantic-tokens or completion request whose
change a newer change replaces is answered `ContentModified` (-32801), since
Monaco rebases those replies by its later edits. Probes of the game-side
throttle on the same NNG4 level (Multiplication 1, editor mode, CDP worker
census; `lv-shots/qd-b11/edcrash*`) — the same window and the same queue,
so the expectation for the session's coalescer:

| Build | Run | Crash | Peak workers | Pool | Changes reaching the checker |
|---|---|---|---|---|---|
| 4083fb4 (:3006, control) | select-all, Backspace, `rw [add_zero]` at 10 ms/char | yes, +13.2 s | 37 | 33 | 7 |
| qed64-dep (:3007) | the same, 3 runs | no | 28 / 27 / 27 | 26 / 24 / 25 | 2 each |
| qed64-dep (:3007) | End, Enter, the line at 10 ms/char, 2 runs | no | 30 / 27 | 28 / 25 | 2 each |
| qed64-dep (:3007) | select-all line at 150 ms/char | no | 27 | 24 (30 before) | 8 (13 before) |

Every run's last forwarded text carries the typed line. The pool can still
grow a little (28) on a burst; the cap on live dedicated threads is QED64's
to add (#55's remedies).

**NEW-3: fixed.** The flash was the replacement worker's own status
(`booting`) arriving after "starting Lean": the relay's status still read
"rebooting after a network death", so the reboot label went back to
"waiting for the connection". The rule (`death-kind.ts rebootLabel`,
`linkConfirmed`): once the reboot's settle is over (the hold found the link
back, or there was nothing to hold for), that death's reboot is "starting",
which the session's own stages speak over — keyed on `Death.seq`. Local
reproduction behind a pacing proxy that cuts every connection for 20 s at
40 MB of the region, the service worker controlling the page
(`qed64/work/qd-b11-new3.mjs`, `lv-shots/qd-b11/new3-*`): 4083fb4 shows
"waiting for the connection" 0.01 s after "starting Lean" at link-back;
qed64-dep shows none, recovers by itself, proves the level, and never says
"after a crash" (D4 on the new cause reading). A crash injected afterwards
reads "restarting the checker after a crash (probe-injected crash)" on both.

**NEW-2: fixed.** Every word of a download on the `l4g-cache` channel now
carries the transfer size, and the tile shows another tab's download from
the word alone (it no longer waits for its own index entry). Probe
(`qed64/work/qd-b11-new2.mjs`, `lv-shots/qd-b11/new2b-*`): one tab says a
running nng4 download on the channel; a second landing tab opens with its
index and manifests held back 5 s. qed64-dep shows "Being downloaded in
another tab… 18 / 154 MB" 0.01 s after its tiles render, 5 s before its
index arrives; 4083fb4 shows it only after the index (+5.0 s).

**Review of phases 1 and 2** (adversarially verified findings; all fixed
in the worktree except where said):

| Finding | What happened | Now |
|---|---|---|
| PAR-2 | The boot no longer waited for a running Prepare of its own game: its session joined the Prepare's prefetch, and every caller of a flight gets the one result — a single transient failure of that download (ERR_NETWORK_CHANGED, a proxy reset) failed the session's snapshot load too, with no retry, and the Lean worker streamed and inflated the region itself for the whole session (the ~4.6 GB-heavier path), committing no `.raw`. The runtime's chunks also downloaded beside the region. | The boot waits for the Prepare's region again (`inFlightPrepare`, its bytes on the banner, before `installArtifacts`); a region that failed is then fetched by the session's own prefetch afresh (the failed flight is closed). |
| PAR-3 | The sweep removed every cache file no entry of the PAGE's index named: a tab that outlived a deploy (the service worker keeps the previous shell for it) deleted the region of a game the new deploy added, Prepared in a newer tab, and a developer's unpromoted bakes under other names (`nng4.dev.*`). | The listed-name guard is back: only a listed name's non-live keys go. The listed names are cut from qed64's own keys (`snapshotCacheKey`), so the sanitisation is qed64's; an unknown key shape names nothing. |
| PAR-4 | A worker that said hello, then failed its lazy import of `lsp-front-door.js` (the link dropped with no service worker controlling the page, or a 404) died as qed64's `crash`: "restarting the checker after a crash (Uncaught NetworkError …)", also inside a network episode, and the halt detoured as a crash. | `readDeath` read a `crash` whose message named a failed `importScripts` / `NetworkError` as "silent" — probe the link, like a worker script that never loaded; the probe's preflight tells a deploy's 404 from the link. Closed upstream in `84d594e` (§7.7): the worker posts `WORKER_DEP_MISSING`, which `deathCause` classifies as `WORKER_SCRIPT_LOAD_FAILED`; the game's message rule is gone (bump below). |
| QD-API-1 | The session's wait for another tab's writer (qed64 `onBusy: "wait"`) is capped at `PREFETCH_SILENCE_MS` (3 min) from the lock request and not re-armed by that tab's progress; a slower cross-tab download (RAG, 282 MB, at 1 MB/s) leaves the Lean worker streaming the region beside it. Not a regression (b9292f8 streamed at once). | Comment corrected (game-boot). `busyWaitMs` is per caller since `84d594e`, but the session's own prefetch call passes none and `ResidentHost` offers no way to: upstream (Open). |
| QD-API-2 | `WORKER_DEP_MISMATCH` (§7.7: a deploy mixed the worker scripts' revisions under a running tab) read as our crash, the label's 80-character cut dropping its "reload". | A stale-page verdict (`death-kind isStalePageDeath`, on the code): the reboot reads "this site was updated — restarting the checker; reload the page to use the new version"; a halt on it shows "This site was updated — reload to continue" with Reload only (no restart, no network probe) in the typewriter and in editor mode (`t()`: `Site updated headline`, `Site updated note`). Its residual — the client's own `initialize` taken by that death — is closed with the bump to `84d594e` (below). |
| QD-API-3 | game-boot read relay members v1 does not name (`state`, `lastDeath`, `lastText`, `deaths`, `pending`); a rename would throw in the network re-arm with no build error (the client build runs no tsc). | `status().relay` / `status().lastDeath`; `headerText: ""` (the game's policy reads no header); `deaths`/`pending` only in the harness hook, guarded (-1, not a throw). `clientPort` and `unload()` stay (no alternative; upstream). |
| PKG-1 | Nothing compared `node_modules/qed64` with the lockfile pin: a pulled qed64 bump over an older install built, staged and deployed the old package (`deploy-app.sh` skips `npm ci` when `client/node_modules` exists), and the from-source preflight printed the lockfile's SHA as if checked. | `stage-workers.sh` (every build and deploy, `--check` in the preflight) refuses unless npm's record of the install (`node_modules/.package-lock.json`) names the pinned commit: "node_modules/qed64 is 90aef68…, package-lock.json pins 37e38bf… — run npm ci". The preflight prints both SHAs. |
| PKG-2 | The four new modules were untracked; `git commit -a` would leave a branch whose clean clone does not build. | Commit them by name (the proposed commit split does), with `worker-liveness.test.ts`. |
| PKG-4 | Staging never removed a worker a bump dropped or renamed; it shipped and was precached as critical. | `stage-workers.sh` removes every file in `client/public/workers` the closure does not name. |
| PKG-7 | The `patch` line was never checked against the kernel: a pin moved back to a pre-0032 kernel with `patch 0032` left passed every check. | (2026-10-04) `patch 0032 992dc94…` named the kernel commit that completed the patch; the from-source preflight refused a pin whose history lacked it. Superseded 2026-10-06: `wasm/KERNEL-PIN` and that history check are gone with the kernel submodule; the patch id is the toolchain release record's `kernel.patch` (pinned with the record's id and self-digest), compared with the release tools' `comparePatchIds` by `stage-workers.sh` and the preflight. |
| PKG-8 | `client/tsconfig.json` hard-codes the package's entry file; a move (or a nested install) would leave tsc on a stale or missing file while Vite bundles the new one. | `stage-workers.sh` refuses a `paths` target that is not `closure.json` `entry`. |
| PKG-9 | The served `lean.worker.js` comment still describes lean4game's vendoring (QED64's text). | Reported upstream; `vendor-liveness.test.ts` is now `worker-liveness.test.ts`. |

Tests of the fixes: `death-kind.test.ts` runs both new death readings on
the real worker scripts — `lean.worker.js` with a REVISION-2 front door,
and with a failed front-door import, under the real `LeanSession` and
`LspRelay`; `game-cache-prefetch.test.ts` has the PAR-2 wait-then-fresh-
flight and the cross-deploy sweep; the script checks were run against
scratch copies (a stale lockfile pin, a missing install record, a dropped
worker, a moved entry, a pin moved back to `852d1b9`).

Live checks of the fixes on the final build (`index-DXlNGBJg.js`, sw
`5243270bf22f`, workers = qed64 `90aef68`; `:3007`; `lv-shots/qd-fix`):
- smoke, fresh profile: NNG4 boot 6.4 s, RAG 8.4 s, both levels proved
  (`smoke/`);
- PAR-3 (`qed64/work/qd-fix-par3-crossdeploy.mjs`, the review's
  reproduction: tab A on the old index — one index request, an in-page
  route — boots after tab B committed `lag`'s region): both
  `lag.f84d616679d0ceb0.snapz.raw` and `nng4.dev.0123456789abcdef.snapz.raw`
  kept, no sweep line (the phase-2 build removed both, `par3/`);
- QD-API-2 (`qed64/work/qd-fix-api2-mismatch.mjs` through a proxy that
  serves the next front door with REVISION "2"): the reboot reads "this site
  was updated — restarting the checker; reload the page to use the new
  version" from 0.5 s through its whole boot (bytes and modules kept), and
  the relay serves again at 5.8 s; three mixed front doors in a row halt it
  and the pane shows "This site was updated — reload to continue", the note
  and Reload only (`api2/p2-halted.png`). The page's language client did not
  connect after that first death: the residual, closed with the bump to
  `84d594e` (below).

**Regression results:** see "Regression results on the final build" at the
end of the "Bump to QED64 `84d594e`" subsection (the whole suite was run once,
on the bumped build).

Phase 2's runs on its build (`index-Cj_pD5M7.js`, sw `1f5cf5b445e9`,
workers = qed64 `90aef68`):
- smoke, fresh profile: NNG4 boot 7.4 s, RAG 8.3 s, both levels proved
  (`lv-shots/qd-b11/smoke2`);
- D2 on the structured progress (`qed64/work/qd-b11-d2boot.mjs`, 5 MB/s):
  a game tab's first boot shows in a landing tab as "Being downloaded in
  another tab… N / 154 MB" while its region streams, the line ends once the
  boot moves on, and a reload (the region read from storage) shows nothing;
- the editor burst again: no crash, 27 workers, 2 changes.

**Bump to QED64 `84d594e` (2026-10-05)** — the branch review after
`90aef68` (36 findings), the lean4game review's upstream items, and
HARDENING #59 (§12 lists every change). The runtime and the snapshots did
NOT change (`wasm64-d77d34b97592d014`, kernel patch 0032; the closure's
floor is still 0032 — `stage-workers.sh --check` passes). The install is the
`files` allowlist only (42 files, plus nothing: no nested `node_modules`, no
QED64 devDependency at the root), and `node_modules/.package-lock.json`
names the pin. What changed for the game:
- **Deleted: the change throttle** (`client/src/wasm/change-throttle.ts`,
  107 lines, and its test, 142 lines; the `changeThrottleMs`/`clock`
  config, the throttle instance and the flush on a game switch's suspend in
  `game-translation.ts`; its block in `game-translation-guard.test.ts`).
  `ResidentSession` coalesces every embedder's full-text didChanges itself
  (§7.8; `editCoalesceMs` left at its default, 300 ms). What carries over
  from the throttle: at most one full-text change per window, the newest at
  its end, every other frame queued behind a held change in order, a held
  change never crossing a document (didOpen, didClose, a ranged change and
  another document's change flush it first), dispose drops it. Two
  differences (review of the bump: QB-3/R3-2, R3-1):
  - **a didOpen or a ranged change opens no window.** The throttle started
    its window on those too ("an open starts an elaboration too: the next
    full-text change waits out the window after it"; its test pinned "the
    first keystroke after an open waits out the open's window"), so a
    full-text change within 300 ms of a level's open was held. The
    coalescer's barriers flush and forward but set no timer (§7.8:
    "barriers never wait"; only a forwarded change opens the window), so
    the first change after an open goes at once: switch level and type
    within 300 ms — or mount a templated level, whose `template-writer`
    replaces the empty model right after the didOpen (level.tsx) — and two
    elaborations start back to back instead of 300 ms apart. Side by side
    on one fake clock (both modules, the same frames): didOpen, then a
    change at +50 ms — the throttle forwards the change at +300, the
    coalescer at +50; the returning-level didChange the translation
    rewrites to a didOpen, then a change at +120 — +300 vs +120; a ranged
    change, then a full-text one at +100 — +300 vs +100; a window an
    earlier forwarded CHANGE opened does hold the change after a barrier.
    Harmless by the measured data (the throttle's own note: two header
    changes 150 ms apart stayed inside the pool; the edcrash runs peaked at
    24–28 workers), and the burst after it coalesces as before. If a census
    ever shows a level-open-plus-keystroke pair growing the pool, ask
    upstream to open the window on a barrier as the prototype did.
  - **a queued semantic-tokens or completion request superseded by a newer
    change is answered** `ContentModified` (-32801, `error.data.qed64.kind:
    "superseded"`) the moment the newer change replaces the held one; the
    throttle sent every queued request at the flush and never answered one.
    What the game does with those answers: R3-1 below.
- **R3-1: the coalescer's `superseded` answers reach lean4monaco** (review
  of the bump). lean4monaco's messageStrategy (monacoleanclient.js) shows
  EVERY error response as an error notification — in this build a
  `console.error` line (no notification service is loaded) — which is why N1
  answers an orphaned feature request `result: null`. Until the bump no
  relay-side error response to a feature request crossed to lean4monaco in
  editor mode (the throttle held, queued and forwarded; it never answered).
  Now a queued `textDocument/completion` or `semanticTokens/full`,
  `/full/delta`, `/range` request superseded by a newer change comes back
  -32801 from the session — and not only with the suggest widget open:
  Monaco asks for semantic tokens after every content change
  (documentSemanticTokens.js, an adaptive 300–2000 ms debounce), so a tokens
  request lands behind a held change whenever the typing cadence has a gap
  near the window and the next keystroke replaces that change. vscode-
  languageclient's handleFailedRequest makes the feature's default of a
  ContentModified on completion (null) and throws a CancellationError on the
  tokens methods (documentSemanticTokens treats it as "refetch"), so the
  translation answers a superseded completion `result: null`
  (`isSupersededAnswer`; the same outcome, no console line) and leaves the
  tokens answers alone (a `null` there would leave the highlighting stale):
  one console line per superseded tokens request remains, QED64's
  documented cost (§7.8; HARDENING #59 measured "several lines per
  keystroke" on e575160 before the rule was narrowed to tokens and
  completion). The front door's own -32801 completion refusals carry no
  kind and stay untouched. Test: `game-translation-guard.test.ts` on the
  real `edit-coalescer.ts` (read by path, like the worker scripts in
  `death-kind.test.ts`; not in `qed64/embed`'s surface) under the real
  relay — the completion rewritten, the tokens answer kept, the hook quiet,
  the hover queued until the window, the front door's refusal untouched.
  Frequency in ordinary typing (`qed64/work/qb-r31-superseded-probe.mjs`,
  NNG4 Multiplication/1, editor mode): at 250 ms/char, typing at the end of
  the text or replacing it, 0 superseded replies; at 150 ms/char, 2, both
  `textDocument/completion` with the suggest widget closed, reaching
  lean4monaco as `result: null` with 0 console lines and 0 page errors. No
  semantic-tokens reply was superseded.
- **QB-2: any death on the client's own `initialize` — the client is
  restarted** (review of the bump; the Open residual of QD-API-2's fix
  below). The latch keys on a stale page's code; a WORKER_DEP_MISSING death
  at the same first frame (the link dropping between the first worker's two
  script loads on a page no service worker controls, or a deploy briefly
  without the front door), or a bare crash there, orphans the initialize the
  same way: the relay's failInFlight answers it, N1 makes it -32097,
  vscode-languageclient's doInitialize calls stop() on a Starting client
  ("Client is not running and can't be stopped") and never asks again; the
  relay heals, serves, the banner says "ready", and the pane reads
  "Connecting to the checker…" for good (the QD-API-2 live check: 600 s,
  relay serving, phase `starting`, no document; the pane's own 20 s
  self-heal never fired — its recorded text never reached the 15 s
  wording). Now game-boot remembers any relay-invented answer to the
  client's `initialize` that is not a stale page's (`initializeLost`: the
  kind and the death) and, when the relay next reports `serving`
  (publishRelayStatus), publishes `languageClientRestartAtom` (boot-atoms);
  app.tsx, which owns the LeanMonaco instance, restarts the client on it —
  lean4monaco `LeanMonaco.restart()` → `LeanClient.restart()`, the editor's
  "Restart Lean" path, which stops nothing when the client is not running,
  creates a fresh client on the same MessagePort (vscode-jsonrpc's
  BrowserMessageReader assigns `port.onmessage`, so the failed client's
  reader is replaced) and sends a fresh `initialize`, which the serving
  front door answers from its table (a non-replay initialize is always
  answered and cached again). Skipped when a client is running already (the
  pane's self-heal or the player got there first). A halt refusing the
  initialize ("halted") is remembered too: the re-arm's `serving` restarts
  the client. Not established live (the window is tens of milliseconds on a
  first visit; the live datum is the QD-API-2 check's stranding,
  byte-for-byte the same relay path); `game-translation-guard.test.ts`
  shows the hook naming a plain crash's orphaned initialize (not stale)
  with the relay already serving, which is when game-boot records it.
- **`prefetchRaw`: `busy` is the lock's own answer** (`ifAvailable` first),
  and `onBusy`/`busyWaitMs`/`onBusyWait` are per caller. The landing tile's
  Prepare keeps the default `"return"`: the other tab's progress is on the
  tile already from its heartbeat (D2), and the `busy` refusal is the state
  D3/L12 drop when that download ends; a `"wait"` would show a "running"
  Prepare with no bytes of its own for up to 3 min and then say `busy`
  anyway. The session's own load keeps `"wait"`. The spurious 30 ms
  "waiting for another tab…" on every first download (Open, before) is
  gone with it: the wait is said only when another tab holds the lock.
- **Every boot failure carries a cause** (a pack install: `profile`; the
  host's `files()`, `beforeArm` and a refused arm: `files`). The game's
  `files` is a static list and it has no `beforeArm`, so no label changes;
  `readDeath` still reads "silent" only for no cause or
  `WORKER_SCRIPT_LOAD_FAILED`, and `deathWords` is unchanged.
- **PAR-4 closed upstream**: a lazy `lsp-front-door.js` that fails to load
  is `WORKER_DEP_MISSING` (classified `WORKER_SCRIPT_LOAD_FAILED`; later
  frames dropped, no uncaught throw). `death-kind.ts` lost its
  `importScripts`/`NetworkError` message rule; `death-kind.test.ts` runs the
  real worker scripts with a failed front-door load and asserts the
  structured death.
- `status().memory.initialBytes` is the commit actually made (the game
  reads no memory telemetry); the prefetch worker refuses a message without
  a positive `rawBytes` (the game always passes the index entry, whose
  `bytes` it is; the compressed-only mode is gone); the relay answers each
  orphaned request once and refuses a `restart()` issued while those
  answers go out (the game never calls `restart()`; its re-arms are
  `rearm()`, unaffected); `ResidentSession`'s v1 members are `#`-private
  (the game subclasses nothing since `90aef68`).
- **QD-API-2's residual: closed.** A stale-page death on the page's first
  worker arrives at its first LSP frame — the client's own `initialize` —
  and orphans it; the relay heals (the replacement replays the initialize)
  but the client's start() has failed and it stays "starting" for good. Now
  the translation fires `onOrphanedRequest(method, kind)` for every request
  the relay answers itself (before N1's rewrite), `death-kind.ts
  staleInitialize(method, kind, death)` says whether that was the client's
  `initialize` under a stale-page death, and game-boot latches the
  stale-page card (`publishCheckerActivity` with `haltFacts`: `halted`,
  `stalePage`; label `STALE_INITIALIZE_LABEL`) and keeps it over every later
  relay status and boot stage until the reload — `publishRelayStatus`, the
  StatusSink, the network hold and the settle return early, and
  `leanDownloadInFlight` reads it as a halt. Keyed on the death the relay
  keeps until a session reports `ready`, never on the relay's state: the
  unit test shows the relay already `serving` when the hook fires. Tests:
  `death-kind.test.ts` (the predicate, the card's facts),
  `game-translation-guard.test.ts` (the hook on the real relay: a
  WORKER_DEP_MISMATCH death orphaning the client's `initialize` and a
  `hover`, the replay's answer passed through, a plain crash not stale).
- Typecheck: no new error in `client/src` against MAIN; the package's new
  `#` members raise 10 `TS18028` inside `node_modules/qed64/…/
  resident-session.ts` under `client/tsconfig.json`'s `target: es5`
  (Vite/esbuild bundles them; tsc is not in the build).
- **Regression results on the final build** (`index-CzYztk_G.js`, sw
  `229dce05f147`, workers = qed64 `84d594e`; run 2026-10-06 after a host
  reboot, every probe on :3007, the live build on :3006 for comparison;
  evidence `lv-shots/qr-core`, `qr-net`, `qr-slow`, `qb-*`):
  - **Core:**
    - The ten-game smoke passed 10/10 (boot 6.3–8.3 s).
    - Landing fresh/reload/offline 0.4/0.3/0.4 s, and 9/9 Ready after the
      smoke.
    - D6 offline: a Prepare-only NNG4 boots in 5.3 s at a level never
      opened, a second level shows its goal in 1.6 s, and a doc opens.
    - D1/N2 partial tiles restored in 0.3 s; RAG's 14 images render
      offline.
    - Editor-mode crash: select-all + a line, and End + Enter + a line, at
      10 ms/char, 3 runs each — no crash, at most 29 workers (pool 25–27).
    - An editor-mode proof completed.
    - Cypress 24/24 plain and 24/24 with the app's CSP enforced; 0 CSP
      lines in ~31,000 console lines.
  - **Network and security:**
    - D4: no "after a crash" text, first visit (ready 90.8 s) and under the
      worker (87.0 s); the injected crash is still labelled.
    - NEW-3: no connection flash after link-back.
    - D7: with the proxy refusing, 14 failing service-worker /data GETs,
      boot 6.0 s, and the log "all 354 files are held"; with Chromium
      offline, 0 failing.
    - SEC1: 0 attacker requests over 20 vectors plus landing, editor mode
      and the rechecks; a tampered index is refused; `?snapshots=snapshots`
      boots.
    - QD-API-2: on a reboot worker the reboot label shows, then the relay
      serves; on the first worker the "This site was updated" card shows
      0.3 s after the mismatch, never "Connecting…".
    - QB-2: a 404 on the first worker's front door at a first visit recovers
      on its own; the goal appears at 9.2 s.
    - R3-1 as above.
  - **Slow links and tabs:**
    - S1 at 150 kB/s: 189/189 files, Ready.
    - D5 at 300 kB/s: longest still stretch 7.1 s, ready at 1087 s.
    - Tabs A/B/D/R/G with dwell: drop times 0.07–0.34 s, no ghosts;
      a stall fails at 179.7 s.
    - NEW-2: the remote line 0.01–0.04 s after the tiles.
    - A first visit never shows "waiting for another tab".
    - Two landing tabs preparing the same game make one region GET.
  - 189 instead of 192 files: B4 stopped warming the three mutable
    manifests.
  - Not regressions (also on the live build `b9292f8`):
    - Two GAME tabs booting the same new game: the second waits for the
      first tab's download, then downloads the region again. Both workers
      try `createSyncAccessHandle` on the same `.raw` at the same commit,
      and the loser streams; this is QED64's `openRawSnapshot` (reported
      upstream). Tab 1 is now faster (57 s instead of 101 s).
    - A `decide` deep enough to overflow a worker's JS stack (open below).
    - `?snapshots=…` placed after the `#` routes to the world map.

### Bump to QED64 `5c327c2` (2026-10-06)

QED64 `e4cffcc`, which `ResidentSession` inherits: the edit coalescer holds
full-text changes while the runtime has few free preallocated Workers, and
caps requests in flight (QED64 HARDENING #59 addendum;
`ResidentHost.editBackPressure`, `?edithold=` on QED64's own page). It fixes
the slow-typing crash: an edit per keystroke over work that ignores
cancellation grew the pthread pool until V8 ran out of memory. No API change
for lean4game.

Also `client/package.json` gets a `prebuild` that runs
`scripts/stage-workers.sh`. After a pin bump, a plain client build had kept
the previous `lean.worker.js` in `client/public/workers`.

Targeted re-test on the bumped build (`index-C3-6zpek.js`, sw
`416052e4330f`, :3007; evidence `lv-shots/qr-bp`):

| Check | `84d594e` | `5c327c2` |
|---|---|---|
| Ten-game smoke | 10/10 | 10/10 (boot 6.2–7.3 s) |
| Editor bursts (select-all + line, End + Enter + line, 10 ms/char) | no crash, ≤ 29 workers, pool 25–27 | no crash ×4, 27 workers, pool 24 |
| 150 ms/char above a 4 s `IO.sleep` line | survived, pool 30 | survived, pool 24 |
| 150 ms/char above an overflowing `decide` line | tab crashed (pool 75, 77 workers) | tab survives, pool 24; the checker still restarts 3 times (the kernel's stack-overflow bug, below) |
| Editor-mode proof | pass | pass |
| Cypress | 24/24 | 24/24 |

## Lean 4.34 on the toolchain release (2026-10-06)

Branch `lean-v4.34`: the game pins the kernel fork's toolchain release
`lean-v4.34.0-41ec565` instead of building its own kernel
(`wasm/KERNEL.md`, "Toolchain dependency"), and moves from Lean 4.33.0-pre
(runtime `wasm64-d77d34b97592d014`, patch 0032) to Lean 4.34.0 (runtime
`wasm64-57ae00dc5f6ce958`, patch 0036), with QED64 `bf9d947`. What a player
meets:

- **Every game re-downloads its environment once** (new runtime, new
  digests). Seven games are within ±1.2 % of their 4.33 size; NTG,
  lean4game-logic and LAG grew to ~364 MB each (from 231–280 MB): their
  `import Mathlib.Tactic` is now upstream's full umbrella from the
  `mathlib-game-extra` pack (388 imports, against the 246 of the deleted
  compat umbrella). Open: a trimmed umbrella in the pack (fork/QED64) or
  per-game import patches.
- **A deep `decide` no longer kills the checker** (patch 0036). NNG4
  Multiplication/1, editor mode, relaxed rules:
  `have h : ∀ n : Fin 40, ∀ m : Fin 40, n * m = m * n := by decide` fails in
  0.5 s with "maximum recursion depth has been reached: the WebAssembly
  runtime's stack is exhausted …" on its line, the proof after it closes,
  one session, no death, no reboot. Typing above it at 150 ms/char kept the
  pthread pool at 24 (13 versions with `rw [add_zero]`; 38 versions with a
  comment, 16 of which re-ran the `decide`) — before 0036 the same pace grew
  the pool 26 → 77 workers and crashed the tab (`v434-decide-probe.mjs`,
  `v434-pace-probe.mjs` in QED64's `work/lean4game-workflows/`).
- **The InfoView keeps its RPC session through a long check** (QED64
  `bf9d947`: `$/lean/rpc/keepAlive` no longer waits behind the edit
  back-pressure's request cap). QED64's `work/qk-keepalive.mjs` on this
  game: 22 "Outdated RPC session" lines on `5c327c2`, 0 on `bf9d947`.
- **STG4's `push_neg` levels complete again.** Mathlib (`de3a9cf` on 4.33
  and still `v4.34.0`) logs "`push_neg` has been deprecated. Prefer using
  `push Not` instead." on every `push_neg`, and any warning keeps a level
  from completing ("Level completed with warnings 🎭", no Next at
  difficulty ≥ 2, the new tiles not added to the inventory). STG4 teaches
  `push_neg` in Complement 4 and its model solutions use it in Combo 1 and
  FamCombo 1, 2, 5, 7 — the live 4.33 site has the same defect. The STG4
  patch now carries RAG's wrapper (`Game/CustomTactic/PushNeg.lean`,
  `push_neg` = `push Not` without the warning); the catalog's `probe3`
  (Complement 4's own solution) closes natively with no message, and the
  bake lane checks it on every STG4 bake. In the browser (the rebaked
  bundle on `scripts/serve-dist.mjs`, a fresh profile, QED64's
  `work/games-smoke.mjs` with `probe3` as the probe — `v434-pushneg-smoke.sh`):
  the eleven tactics typed one per Enter in the typewriter, `push_neg at h1`
  and `push_neg` included, and the level is marked completed (the
  `game_progress` flag and the Next button); boot 8.5 s.
- Port changes per game (imports of deprecated module shims rewritten,
  Knights' `deriving Fintype` option, LAG's umbrella): `wasm/PORTING.md` §8.

**Regression results on the 4.34 bundle** (`index-D1y0TwBs.js`, sw
`827e324300f3`, QED64 `bf9d947`, `scripts/serve-dist.mjs` on :3008, run
2026-10-08). The comparison is the 4.33 build on :3007 (QED64
`84d594e`/`5c327c2`, runtime `wasm64-d77d34b97592d014`) and its numbers
in "QED64 as a dependency" above; 4.33's figures are in parentheses.
Evidence: `lv-shots/qv-core`, `qv-net` and the `qv-*` probe directories
beside them (`qv-SUMMARY-slow.txt` for the slow-link set).

- **Core:**
  - The ten-game smoke passed 10/10, boot 6.2–9.3 s (6.3–8.3 s).
  - Deep play (each game's catalog probe, then Next and Previous) completed
    in all nine games, in 11–16 s. Three Mathlib-heavy levels complete:
    Knights SetTheory_Knights_Knaves/6 (11 steps, 21.0 s), Robo Babylon/6
    (9 steps, 22.3 s) and LAG InnerProductWorld/2 (15 steps, 31.2 s). RAG
    Lecture10/1 does not (below).
  - Landing fresh/reload 0.4/0.3 s, shell fill 3.4 s, 9/9 Ready after the
    smoke (the same).
  - Editor bursts at 10 ms/char: no crash, 27 workers, pool 24 (`5c327c2`:
    the same). At 150 ms/char above a 4 s `IO.sleep` line, the line settles
    in 4.48 s at pool 24 (4.45 s). The `decide` line behaves as above.
  - Reload storm (5 runs × 5 reloads + 2 relay restarts): 0/5 renderer
    crashes, ready 6.0–7.7 s after the storm (0/5, 5.7–5.9 s).
  - An editor-mode proof completed. Cypress 24/24 plain and 24/24 with the
    app's CSP enforced (0 CSP lines).
- **Network and security:**
  - D4: no "after a crash" text. First visit ready at 99.3 s, 69.9 s after
    link-back (90.8 s, 61.6 s; the region is 575 MB instead of 569 MB).
    Under the worker ready at 87.5 s (87.0 s). The injected crash is
    labelled; serving again in 7.3–8.3 s (6.7 s).
  - NEW-3: no connection flash after link-back; boot 102.2 s (101.4 s).
  - D7 with Chromium offline: boot 7.1 s, 0 failing service-worker GETs
    (5.9 s, 0). With the proxy refusing it failed: the local regression
    below.
  - SEC1: 0 attacker requests over the 20 vectors (on the app and on a
    no-CSP copy), the landing, editor mode and the rechecks. A tampered
    index is refused; `?snapshots=snapshots` boots and proves with 0 CSP
    violations. 67/69 checks: "P1 landing" (the local regression below)
    and "P2" (`?snapshots=` after the `#`, also on 4.33).
  - QD-API-2: on a reboot worker the mismatch label shows at 2.0 s and the
    relay serves again at 8.8 s (1.9 s, 7.6 s). On the first worker the
    "This site was updated" card shows 0.5 s after the reload (0.5 s),
    never "Connecting…".
  - QB-2: a 404 on the first worker's front door recovers on its own; the
    goal appears at 10.3 s (9.2 s).
- **Slow links and tabs** (NNG4: 155 MB, runtime 158.9 MB instead of
  153.6 MB):
  - S1 at 150 kB/s: 189/189 files, Ready, 356.5 MB in 2272.8 s (349.8 MB,
    2229.6 s).
  - D5 at 300 kB/s: longest still stretch 7.0 s, ready at 1108.9 s (7.1 s,
    1087.1 s).
  - Tabs A/B/D/R/G with dwell: drop times 0.15–0.34 s, no ghosts. A stall
    fails at 179.8 s and Retry finishes in 31.1 s (179.9 s, 30.9 s).
  - NEW-2: the remote line 0.01 s after the tiles. A first visit never
    shows "waiting for another tab". Two landing tabs preparing the same
    game make one download.
- **A local-build regression, fixed: the pinned runtime manifest was not
  staged.**
  - A QED64 boot first fetches `/runtime/runtime-manifest.<buildId>.json`,
    and the service worker precaches it. The release ships it beside
    `runtime/runtime-manifest.json`, with the same bytes. The bundle lane
    of `wasm/build-from-source.sh` copied only `runtime-manifest.json`. The
    4.33 tree still held the gitignored copy the old
    `scripts/upload-artifacts.sh` used to write.
  - The deployed site was not affected: the Worker serves `/runtime/` from
    the release.
  - On :3008 `serve-dist` answered the pinned path with `index.html`.
    Online, the boot fell back to `runtime-manifest.json`. Offline, or with
    `navigator.onLine` true but the link dead, the fetch itself threw:
    - D6 (NNG4 prepared from the landing only, booted offline at levels
      never opened) and RAG's offline boot failed with "Lean runtime boot
      failed: TypeError: Failed to fetch".
    - The offline landing showed no Download/Prepare row on any tile.
    - D7 with the proxy refusing failed after 0.9 s with "Lean could not
      start in your browser — Failed to fetch".
    - The service worker's install warned "1 of 68 critical shell files
      not cached". The shell fill stopped at 233/234 and retried the file
      every 10 s. That retry was SEC1 "P1 landing"'s one same-origin
      request.
  - A proxy serving that one file made every one of these checks match
    4.33.
  - The fix:
    - The bundle lane copies the release's pinned manifest into
      `client/public/runtime/`. It refuses when the mirror lacks it, names
      another runtime, or differs from `runtime-manifest.json`, and it
      removes other runtimes' pinned copies.
    - `scripts/stage-snapshots.py --copies` (which
      `scripts/fetch-artifacts.sh` runs) writes it from
      `runtime-manifest.json`.
    - `scripts/preflight-artifacts.mjs` requires it, byte-identical to
      `runtime-manifest.json`, and refuses another runtime's
      (`scripts/upload-artifacts.test.mjs`).
  - Re-run on the rebuilt bundle (`index-D1y0TwBs.js`, sw `37affd8686ee`,
    :3008, no proxy supplying the file; evidence `lv-shots/qv-pinfix`,
    `qv-d7/D7-rag-fixed`):

| Check | Before the fix | After | 4.33 |
|---|---|---|---|
| D6: NNG4 prepared only, offline, level A | "Failed to fetch" at 0.8 s | boot 5.9 s, proof 3.8 s | boot 5.3 s |
| D6: level B goal, inventory doc | no goal in 121 s; doc 0.0 s | goal 1.6 s, doc 0.0 s; "all 189 files are held" | 1.6 s; 189 held |
| D6: the game's landing tile, offline | no tile state after 33 s | Ready, 3.2 s | Ready |
| D1/N2 partial tiles (two runtime chunks, `game.json` deleted) | 0.3 / 0.3 s | 0.3 / 0.3 s | 0.3 s |
| Offline landing | no Download/Prepare row (`other: 9`), a failed resource | 0.4 s, 9 × Download, 0 errors | 9 × Download |
| RAG prepared, booted offline + images | "Failed to fetch" | boot 7.2 s; level and world-intro images all complete | boot 6.1 s, the same images |
| Shell fill, landing fresh / reload / offline | 233/234, 1 failed; offline: a retry round every 10 s | 234/234 complete in all three (fill 3.5 s) | 234/234 |
| Service-worker install | "1 of 68 critical shell files not cached" | no warning | no warning |
| D7 phase A (online warm-up) | boot 8.0 s, 354/354, shell 233/234 | boot 8.3 s, 354/354, shell 234/234 | boot 8.2 s, 354/354, shell complete |
| D7, proxy refusing (`onLine` true) | failed at 0.9 s | boot 6.1 s, proof done, 14 failing service-worker GETs (7 distinct), "all 354 files are held" | boot 6.0 s, 14 failing |
| D7, Chromium offline | boot 7.1 s, 0 failing (143) | boot 6.7 s, 0 failing (143) | boot 5.9 s, 0 failing |
| SEC1 | 67/69; "P1 landing" saw 1 same-origin request | 68/69 (only "P2"); "P1 landing" 0 requests; 0 attacker requests outside the two positive controls; `?snapshots=snapshots` ready in 7 s | 68/69; 0 attacker requests |
| Ten-game smoke (`--all`, fresh profile) | 10/10, boot 6.2–9.3 s; shell fill 233/234 in every game | 10/10, boot 6.2–10.3 s, the same bytes per game; shell fill 234/234; 0 CSP hits in 2,303 console lines; 2–3 textless errors per game | 10/10, 6.3–8.3 s |

- **RAG Lecture10/1 (the product-of-limits boss) cannot be finished in the
  browser, on 4.34 or on 4.33.**
  - On 4.34, `have ε1 : 0 < ε / (2 * K) := by bound` (step 3) gets
    "maximum recursion depth has been reached: the WebAssembly runtime's
    stack is exhausted …", and so do the `bound` calls at steps 12 and 26.
    The checker survives (patch 0036), on two runs.
  - On 4.33, steps 1–25 pass and the checker dies again and again at step
    26 ("Maximum call stack size exceeded").
  - So `bound` now runs out of stack earlier, but cleanly. Reported to the
    kernel session (the stack budget, or deeper recursion in 4.34's
    `bound`/aesop). Other `bound`-heavy RAG levels were not checked.
- **NTG, lean4game-logic and LAG snapshots grew** with the full
  `Mathlib.Tactic` umbrella (above). The download went 231.5 → 364.5 MB,
  231.3 → 364.3 MB and 280.1 → 365.0 MB (+133 / +133 / +85 MB; raw
  0.84 → 1.28 GB and 1.00 → 1.28 GB). Their boots take 8.2–9.3 s instead
  of 7.2–7.3 s. The smoke's "MB wire" column reads +266 / +266 / +170 MB
  because it counts every download twice (NNG4: 310.9 MB for its 155.5 MB
  snapshot). The other seven games moved by 3–10 MB raw. Follow-up: a
  trimmed umbrella or per-game imports (above).
- **Empty `console.error` lines, 1–3 per boot.** Each is
  `console.error("")` from lean4monaco's fallback notification service
  (`$showMessage` → `_showMessage` → `notify`). Something shows an
  Error-severity window message with no text while a level elaborates or
  is proved. No check is affected, and the sender is not traced. The net
  run saw none on 4.33, but the 4.33 smoke (`qr-core`) logged the same 1–3
  per game, and the slow run counted 1/2/6 against 4.33's 0/1/4. So they
  predate 4.34.
- **Two game tabs booting the same new game still download the snapshot
  twice** (2 × 155.5 MB; tab 1 ready at 58.6 s, tab 2 at 110.7 s; 4.33:
  57.2 s, 108.4 s). This is QED64's `openRawSnapshot`, as above.


### QED64 `385a1ac` (2026-10-09)

The QED64 pin moves from `bf9d947` to `385a1ac` (`wasm/KERNEL.md` lists
what it brings), and `infra/worker.js` becomes `qed64/edge`
(`wasm/DEPLOY.md`). A player meets one new behaviour, HARDENING #64:
when `/snapshots/index.json` names another runtime (an upload of the next
pairing ran ahead of this shell's deploy), the shell reads its own build's
copy `/snapshots/index.<buildId>.json`, and games still boot and prove.
Without a copy, every game refuses, as before. The review of the bump
found two client gaps, both fixed before this run. First, `?runtime=X`
paired the index with the shell's pin, not with X. Second, the copy was
not precached, so after a first visit inside a pairing window an offline
revisit refused every game. The service worker now precaches the
pin's two index copies, which makes 237 shell files instead of 235.

Bundle `index-B2CPBv8a.js`, sw `2313ea9a138d`, `scripts/serve-dist.mjs`
on :3008. "385a1ac" is the verifier's run before the fixes
(`index-D3K6RuED.js`, sw `3bf04b0b2161`, evidence `lv-shots/qv-385`).
"Fixed" is the re-run after them (`lv-shots/qv-385b`). "4.34 pinfix" is
the same 4.34 build on QED64 `bf9d947` with the pinned-manifest fix
(above).

| Check | 385a1ac | Fixed | 4.34 pinfix |
|---|---|---|---|
| Ten-game smoke (`--all`, fresh profile) | 10/10, boot 6.3–11.3 s | 10/10, boot 6.3–10.2 s, the same bytes per game | 10/10, 6.2–10.3 s |
| Smoke console | 0 CSP hits in 2,312 lines; 2–3 textless errors per game; shell 235/235 ×10 | 0 CSP hits in 2,315 lines; 2–3 textless errors per game (`index-B2CPBv8a.js:1897`); shell 237/237 ×10; 0 "not cached" | 0 CSP hits; 1–3 textless errors |
| Editor-mode proof, NNG4 Multiplication/1 | boot 7.0 s; error on the wrong line at 9.5 s; proof 3.6 s | 7.1 s; 9.5 s; 3.6 s | 6.7 s; 9.0 s; 3.5 s |
| `decide` line (Fin 40), editor mode | error stays on its line, 0 deaths, one session, settles 0.61 s | the same, 0.61 s | 0.51 s |
| D6: NNG4 prepared only, offline at never-visited levels | 7/7: prepare 1.3 s / 316.4 MB; A boot 6.0 s, proof 4.1 s; B goal 1.6 s; doc 0.1 s; landing Ready 3.2 s | 7/7: prepare 1.6 s / 316.4 MB; A 6.0 s, 3.9 s; B 1.6 s; doc 0.1 s; landing 3.2 s | 7/7: 2.8 s; 5.9 s, 3.8 s; 1.6 s; 0 s; 3.2 s |
| Landing fresh / reload / offline | 0.4 / 0.3 / 0.4 s, 9/9 Download; fill 3.5 s | the same | the same |
| D7 RAG, phase A (online) | boot 10.0 s, 492.8 MB; 354/354; shell 235/235 | 8.4 s, 492.8 MB; 354/354; shell 237/237 | 8.3 s, 492.8 MB, 354/354 |
| D7, proxy refusing (`onLine` true) | boot 6.6 s, proof 8.2 s; 14 failing SW GETs (7 distinct); "all 354 files are held" | 6.5 s, 7.6 s; 14 (7); all 354 held | 6.1 s, 7.9 s; 14 (7) |
| D7, Chromium offline | boot 6.4 s, proof 7.7 s; 0 of 143 failed | 6.1 s, 7.7 s; 0 of 143 | 6.7 s, 8.2 s; 0 of 143 |
| SEC1 exploit set | 68/69 (only the known P2); 0 attacker requests from the app | 68/69 (P2); 0 attacker requests; `?snapshots=snapshots` ready in 6 s, proof, 0 CSP violations | 68/69 |
| #64: index.json names `wasm64-d77d34b97592d014`, copy passes | 9 tiles "Download ≈155 MB"; NNG4 boots from the copy in 7.1 s; proof 1.4 s | 9 × Download; boot 6.6 s (155.5 MB); proof 1.4 s; shell 237/237 | refused (before #64) |
| #64: the copy answers 404 | 9 tiles "Not available on this build"; refused in 0.6 s with Reload; 0 snapshot requests | the same, 0.6 s; shell 236/237 "complete, 1 failed" (the 404, tolerated) | — |
| #64: the copy is mispaired too | refused in 0.6 s, 0 snapshot requests | the same, 0.6 s | — |
| #64: offline revisit after ONE online visit | FAIL: refused in 0.9 s (the copy was in no cache) | PASS: offline Multiplication/2 boots in 5.5 s, proof 5.9 s; the copy is in `l4g-shell` after the first visit | refused |
| #64: offline revisit after two online visits | PASS: 6.0 s, proof 5.3 s | not re-run (the one-visit case covers it) | — |

- **Boot times.** The verifier's run read about 1 s slower on six smoke
  games and on D7 phase A (10.0 s against 8.3 s). The wire bytes are
  identical, the host's load average was 5–6, and the re-run's figures
  are back within the earlier range (D7 phase A 8.4 s). We read it as host
  noise; nothing in the bump touches the boot path.
- **One more failed request per offline boot.** It comes from the fifth
  worker, `memory64-probe.js`: offline, its revalidation fails and the
  cached copy is used. D6 counted page 5 / service worker 30 failed
  requests against 4 / 27 before. Nothing breaks.
- **`?runtime=X`** is a dev override, and no second runtime is served
  here, so it was checked only by `boot-params.test.ts`. That test runs
  three cases: an index already on X is used as served; X's own copy
  replaces an index on the pin; with no copy for X, the index is kept and
  X's tile reads unavailable.
- Not re-run: deep play, editor crash bursts, pace, the reload storm,
  Cypress.

## Open

- **A deep `decide` kills the checker with a JS stack overflow (runtime or
  kernel; also on the live build).**
  - Repro: NNG4 Multiplication/1, editor mode,
    `have h : ∀ n : Fin 40, ∀ m : Fin 40, n * m = m * n := by decide`.
  - A pthread worker throws "RangeError: Maximum call stack size exceeded"
    instead of Lean's deep-recursion error. The FileWorker dies three times
    and the relay halts.
  - Typing over that line after a restart grew the pool 26 → 77 workers and
    crashed the tab.
  - Reported to QED64 and the kernel session.
  - Fixed by kernel patch 0036 (release `lean-v4.34.0-41ec565`, branch
    `lean-v4.34`): the line now fails with Lean's "maximum recursion depth
    has been reached: the WebAssembly runtime's stack is exhausted …" error
    and the checker stays up; typing above it at 150 ms/char keeps the pool
    at 24 (`wasm/KERNEL.md`, "The Lean 4.34 port"). Reproducing it needs the
    relaxed rules: at difficulty 2 the Runner cuts the proof before the
    locked `have` and the `decide` never runs.

- **Editor mode crash: closed upstream** (QED64 ≥ `f150f47`, `editCoalesceMs`;
  the game's throttle is deleted — "QED64 as a dependency" above). Residual,
  QED64's: a burst can still grow the pthread pool a little past 24 (28
  seen), the pool never shrinks, and a sustained 150 ms/char pace above work
  that ignores cancellation still crashes QED64's own page (HARDENING #59,
  open); #55's remedies (a cap on live dedicated threads, smaller isolates).
- **NEW-2: closed**, **NEW-3: closed** ("QED64 as a dependency" above).
- **The 30 ms "waiting for another tab to finish preparing the game
  environment" on every region download: closed upstream** in `84d594e`
  (the lock is asked with `ifAvailable` first; the wait is said only when
  another tab really holds it).
- **qed64 v1 (report upstream): `failureKindOf` reads WebKit's fetch
  failure ("Load failed") and a bare `ERR_INTERNET_DISCONNECTED` as
  `other`, not `network`** (the game's old text rule had both). Moot today
  (WebKit has no Memory64; Chromium says "Failed to fetch"), but the game
  now reads the link only through that table.
- **qed64 v1 (report upstream), from the review of the adoption:**
  - QD-API-1: make `onBusy: "wait"` silence-based (re-armed while the lock
    holder reports progress — a BroadcastChannel heartbeat, or the
    `.raw.partial` growing), or let a host pass `busyWaitMs` through
    `ResidentHost` / the policy (`84d594e` made `busyWaitMs` per caller,
    but the session's own prefetch call passes none). Until then a
    cross-tab download slower than 3 min leaves the second tab's Lean
    worker streaming the region; the game's D2 report on the tile is the
    only signal.
  - QD-API-3: name in §7 what an embedder of `LspRelay` cannot do without —
    `clientPort`, `unload()`, and `lastText` (or pass the header to the
    session factory); the game reads `status()` for the rest.
  - QD-API-2: export the `WORKER_DEP_MISMATCH` code (§7.7 names it; the game
    spells it).
  - PAR-4: closed in `84d594e` (`WORKER_DEP_MISSING` → `WORKER_SCRIPT_LOAD_FAILED`).
  - PKG-9: `public/workers/lean.worker.js` (~line 61) still says lean4game
    vendors a fixed closure through `sync-qed64.sh`; it stages the closure
    from the package.
- **A death on the language client's own `initialize` leaves the client
  in "starting": closed** (found by the QD-API-2 live check; "Bump to
  `84d594e`" above). A death of the FIRST worker of a page on its first
  LSP frame — the client's `initialize` (lean.worker.js loads the front
  door then) — orphans it (`failInFlight`), the translation answers it
  -32097 (N1), the console shows "Client is not running and can't be
  stopped. It's current state is: starting", and the client never connects
  to the healed relay. A stale page's death there shows the stale-page
  card at once (`staleInitialize`, the latched card: a reload is the way
  out); any other death — or a halt — taking the initialize restarts the
  language client once the relay serves again (QB-2: `initializeLost` →
  `languageClientRestartAtom` → app.tsx, lean4monaco's own "Restart Lean"
  path). Not established live for the first-frame case (a window of tens of
  milliseconds; the D4/NEW-3 cuts, later in the boot, recovered without
  it). Upstream candidate stays: answer an orphaned `initialize` from the
  replacement session's replay instead of -32097, so the client never fails
  its start.
- **Sweep residual (pre-existing, PAR-3's other half):** a tab that
  outlived a deploy still sweeps against its old index, so a game the new
  deploy RE-BAKED (a new key of a listed name) loses its new region to the
  old tab's first boot, and downloads it again. No data is damaged; telling
  a newer key from an older one needs a deploy marker in the index.
- **Not done:** B3 (the panel-widget path) and B12 (the bump script that
  respects `workerProtocol.deprecated`).
- **SEC1 residual: a region poisoned before the fix stays (R3).** A browser
  that opened a crafted `?snapshots=` link while 4083fb4 was live may hold an
  attacker region under the real live key (e.g. `nng4.db264c5f3eb7c69c`).
  The fix stops new poisoning but cannot detect an old one: the index digest
  covers the compressed transfer bytes, the browser keeps only the inflated
  region (the Lean worker checks size and the `olean` magic), and no record
  of where a region came from was kept. A purge of every committed region
  would cost every returning player a full re-download. Bounds: only a
  region of exactly the live byte count survives (any other size is
  discarded on the next visit), and only a browser that did not already
  hold the live region could have been poisoned. It closes with the next
  rebake or runtime release (new digests; the sweep drops the old keys),
  "Remove download", or clearing site data. Open decision: rotate the live
  digests now with a rebake, or ship a one-time purge; longer term, a digest
  of the raw region in the index, checked once when a region is first
  opened.
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
