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
  15-minute prefetch bail also removes its own). Verified with the real
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

**Deep play of every game (tester "play")** is recorded in the next
subsection.


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
