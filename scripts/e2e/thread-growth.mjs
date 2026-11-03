#!/usr/bin/env node
// The thread-growth lane (QED64's architecture review, D14; wasm/UX-PARITY.md,
// "Editor mode crash"). QED64's worker runs its FileWorker with
// -DElab.async=false (its HARDENING #70), but this site's Runner documents turn
// async back on (RUNNER_PRELUDE, client/src/wasm/game-translation.ts), so that
// flag does not bound the Runner command. D14 accepts the gap and closes any
// pool ceiling or thread cap as "no". This lane measures the gap and changes
// nothing: it plays a level's real proof steps, then an edit burst in editor
// mode, and records what the relay says about the pthread pool.
//
//   node scripts/e2e/thread-growth.mjs --origin <url> --out <dir> [options] <level>...
//
// <level> is <game>/<world>/<n>; <game> is a catalog snapshot name or game id
// (rag/Lecture10/1). A proof comes from scripts/e2e/thread-growth-levels.json,
// else from a wasm/catalog.json probe of that level.
//
//   --out <dir>       the report, the samples and the browser's temp files
//   --profiles <dir>  fresh profiles, one per run, removed after it (default <out>/profiles)
//   --runs <n>        runs per level (default 2)
//   --mode <m>        play: the proof steps, then the burst (default)
//                     empty: the burst over the empty proof (a Runner with no tactic work)
//                     no-runner: the control. The burst with this page's typing and
//                       requests, but every didChange is rewritten in the page (at the
//                       relay's fromClient, not the shipped path) to a document with no
//                       Runner: the header, the typed comment, then QED64's edit-storm
//                       `#eval IO.sleep 3000`. That is QED64's own `pagelong` here.
//   --burst-chars <n> characters typed (default 133: about 20 s, as `pagelong`)
//
// Each run: a fresh profile; boot to ready (difficulty 0, so no tactic is
// locked); globalThis.qed64GameRelay.status() read every 250 ms from here, so a
// crash loses no sample; the proof, one line per Enter in the typewriter when
// every step is one line, else one top-level block at a time in the editor;
// then the burst: a block comment put above the proof, typed into at 150 ms per
// character, so every keystroke is a whole document that re-elaborates the
// proof, and the proof text put back at the end. pool.grown is not read: it
// leaves in QED64's next batch (R7b). Recorded per run, in <out>/<run>.json: the
// peak pool.running, pool.unused and their sum, whole run and per phase, the
// values at ready and at the end, the Worker count, the wasm heap's size every
// 5 s, any page crash, relay halt, checker death and new
// ~/Library/Logs/DiagnosticReports/chrome-headless-shell-*.ips, the changes and
// versions the checker saw, the #59 holds, and the verdict.
//
// Reading it: the runtime preallocates 24 pool Workers (running + unused), the
// cage's limit sits near 29-30, and a crash report's DedicatedWorker count is the
// pool plus 2. For scale, QED64's page under a 20.7 s burst went 24 to 26 with
// its #59 hold on and to 36-37 with it off (QED64 R16 L5).
//
// Run it under the host's browser lock, one run at a time; it starts no server.
// Exit: 0 every run ended with no crash and no halt; 1 a run crashed or halted;
// 2 usage; 3 a run could not measure (the boot failed, the harness threw).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const usage = (why) => { if (why) console.error(`thread-growth: ${why}`); console.error("usage: thread-growth.mjs --origin <url> --out <dir> [--profiles <dir>] [--runs <n>] [--mode play|empty|no-runner] [--burst-chars <n>] <game>/<world>/<n>..."); process.exit(2); };
let parsed;
try {
  parsed = parseArgs({ allowPositionals: true, options: {
    origin: { type: "string" }, out: { type: "string" }, profiles: { type: "string" },
    runs: { type: "string", default: "2" }, mode: { type: "string", default: "play" }, "burst-chars": { type: "string", default: "133" },
  } });
} catch (e) { usage(e.message); }
const { values: opt, positionals: levelArgs } = parsed;
if (!opt.origin || !opt.out || !levelArgs.length) usage();
const ORIGIN = opt.origin.replace(/\/+$/, "");
const OUT = path.resolve(opt.out);
const PROFILES = path.resolve(opt.profiles ?? path.join(OUT, "profiles"));
const RUNS = Number(opt.runs);
const MODE = opt.mode;
const BURST_CHARS = Number(opt["burst-chars"]);
if (!Number.isInteger(RUNS) || RUNS < 1) usage(`--runs ${opt.runs}`);
if (!["play", "empty", "no-runner"].includes(MODE)) usage(`--mode ${MODE}`);
if (!Number.isInteger(BURST_CHARS) || BURST_CHARS < 1) usage(`--burst-chars ${opt["burst-chars"]}`);

const CATALOG = JSON.parse(readFileSync(new URL("../../wasm/catalog.json", import.meta.url), "utf8"));
const LEVELS = JSON.parse(readFileSync(new URL("./thread-growth-levels.json", import.meta.url), "utf8"));

const BOOT_BUDGET_MS = 900_000, STEP_BUDGET_MS = 180_000, VERDICT_BUDGET_MS = 30_000, SETTLE_BUDGET_MS = 300_000;
const SAMPLE_MS = 250, HEAP_EVERY_SAMPLES = 20, BURST_DELAY_MS = 150, QUIET_AFTER_MS = 5000;
const SLEEP_LINE = "#eval (IO.sleep 3000 : IO Unit)";
// A comment's text: letters and spaces, nothing Monaco auto-closes.
const burstText = (n) => "the quick brown fox jumps over the lazy dog ".repeat(Math.ceil(n / 44)).slice(0, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Monaco's cursorTop and cursorBottom: Meta+Home does nothing on a Mac.
const DOC_TOP = process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home";
const DOC_END = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";

function resolveLevel(arg) {
  const m = /^([^/]+)\/([^/]+)\/(\d+)$/.exec(arg);
  if (!m) usage(`${arg} is not <game>/<world>/<n>`);
  const [, name, world, level] = m;
  const game = CATALOG.games.find((g) => g.snapshot === name || g.game === name);
  if (!game) usage(`no catalog game ${name}`);
  const key = `${game.snapshot}/${world}/${level}`;
  const probe = Object.entries(game).find(([k, v]) => k.startsWith("probe") && v.world === world && String(v.level) === level)?.[1];
  const proof = LEVELS[key]?.proof ?? probe?.proof ?? null;
  if (proof === null && MODE === "play") usage(`no proof for ${key}: add it to thread-growth-levels.json`);
  return { key, id: `g/${game.owner}/${game.game}`, world, level: Number(level), proof, why: LEVELS[key]?.why ?? null };
}

/** The proof's top-level steps: a line at the first line's indent, with the deeper lines below it. */
function topLevelBlocks(proof) {
  const lines = proof.split("\n").filter((l) => l.trim());
  const indent = (l) => l.length - l.trimStart().length;
  const blocks = [];
  for (const line of lines) {
    if (blocks.length && indent(line) > indent(lines[0])) blocks[blocks.length - 1] += `\n${line}`;
    else blocks.push(line);
  }
  return blocks;
}

const REPORTS_DIR = path.join(os.homedir(), "Library/Logs/DiagnosticReports");
const crashReports = () => {
  try { return new Set(readdirSync(REPORTS_DIR).filter((f) => /^chrome-headless-shell-.*\.ips$/.test(f))); } catch { return new Set(); }
};
/** A macOS crash report's signature: a JSON header line, then a JSON body. */
function reportSignature(name) {
  try {
    const text = readFileSync(path.join(REPORTS_DIR, name), "utf8");
    const body = JSON.parse(text.slice(text.indexOf("\n") + 1));
    const threads = body.threads ?? [];
    const faulting = threads[body.faultingThread] ?? {};
    return {
      name, exception: body.exception?.type ?? null, indicator: body.termination?.indicator ?? null,
      threads: threads.length, dedicatedWorkers: threads.filter((t) => /DedicatedWorker/.test(t.name ?? "")).length,
      faultingThread: faulting.name ?? null, frames: (faulting.frames ?? []).slice(0, 6).map((f) => f.symbol ?? null),
    };
  } catch (e) { return { name, unreadable: String(e).slice(0, 120) }; }
}

// In the page.
const readStatus = () => {
  const s = globalThis.qed64GameRelay?.status?.();
  if (!s) return null;
  return { running: s.pool?.running ?? -1, unused: s.pool?.unused ?? -1, parked: s.pool?.parked ?? -1, relay: s.relay, phase: s.phase, version: s.version, session: s.session, death: s.lastDeath ?? null };
};
const readDocVersion = () => globalThis.qed64GameRelay?.relay?.doc?.version ?? null;
/** The wasm heap's size, and the worker's new pool sample with it. The heap never shrinks: this is its high-water mark. */
const readHeap = async () => {
  const memory = (await globalThis.qed64GameRelay?.relay?.session?.lean?.request?.("telemetry").catch(() => null))?.memory;
  return memory ? { mib: Math.round(memory.currentBytes / 2 ** 20), maxMib: Math.round((memory.maximumBytes ?? 0) / 2 ** 20) } : null;
};
const seedDifficulty = (id) => {
  try {
    const p = JSON.parse(localStorage.getItem("game_progress") ?? "null") ?? { games: {} };
    p.games ??= {};
    const g = p.games[id] ?? { inventory: [], data: {}, readIntro: false };
    if (g.difficulty !== 0) { g.difficulty = 0; p.games[id] = g; localStorage.setItem("game_progress", JSON.stringify(p)); }
  } catch { /* the level then runs at its default difficulty; the verdict shows it */ }
};
/** The relay is serving, the worker is idle at the newest version the client sent, and the pane is not waiting.
 * A halted relay counts too: nothing will come until the next edit re-arms it. */
const isSettled = () => {
  const g = globalThis.qed64GameRelay;
  const s = g?.status?.();
  if (s?.relay === "halted") return true;
  return !!s && s.relay === "serving" && s.phase === "ready" && s.version === (g.relay?.doc?.version ?? s.version)
    && !document.querySelector(".lean-gate-overlay") && !document.querySelector(".lean-checking-note");
};
/** Paste into a Monaco textarea: one exact edit (keyboard.insertText types each character, with Monaco's auto-indent).
 * Monaco applies it a moment later, where the cursor is then: see `paste`. */
const pasteInto = ({ selector, text }) => {
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", text);
  document.querySelector(selector).dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
};
const readVerdict = ({ id, world, level }) => {
  let flag = false;
  try { flag = JSON.parse(localStorage.getItem("game_progress") ?? "null")?.games?.[id]?.data?.[world]?.[level]?.completed === true; } catch { /* no flag */ }
  const texts = (sel) => Array.from(document.querySelectorAll(sel)).map((m) => m.innerText.replace(/\s+/g, " ").slice(0, 200));
  return { flag, completedText: (document.body.innerText.match(/Level completed[^\n]*/) ?? [null])[0], errors: texts(".message.error"), warnings: texts(".message.warning") };
};
/** The player's text as the relay last saw it: the worker document's lines under the Runner line, less the newline it adds. */
const readClientText = () => (globalThis.qed64GameRelay?.relay?.lastText ?? "").split("\n").slice(2).join("\n").replace(/\n$/, "");
const readEnd = () => {
  const r = globalThis.qed64GameRelay?.relay;
  return { stats: r?.stats ?? null, backPressure: r?.session?.backPressure ?? null, lastDeath: r?.status?.().lastDeath ?? null, seen: { ...globalThis.__threadGrowthSeen } };
};
/** Count the frames that reach the relay and the checker's last diagnostics; with `noRunnerTail` set later, rewrite each full-text change. */
const tapRelay = () => {
  const r = globalThis.qed64GameRelay.relay;
  const seen = { changes: 0, requests: 0, versionsChecked: 0, lastChecked: null, diagnostics: null, noRunnerTail: null };
  globalThis.__threadGrowthSeen = seen;
  const fromClient = r.fromClient.bind(r);
  r.fromClient = (msg) => {
    if (msg.method === "textDocument/didChange") {
      seen.changes += 1;
      const change = msg.params?.contentChanges?.[0];
      if (seen.noRunnerTail && typeof change?.text === "string") {
        const [header, , ...body] = change.text.split("\n"); // line 1 is the Runner line; the line count stays
        change.text = [header, "", ...body, seen.noRunnerTail, ""].join("\n");
      }
    } else if (msg.id !== undefined && msg.method !== undefined) seen.requests += 1;
    return fromClient(msg);
  };
  const toClient = r.toClient.bind(r);
  r.toClient = (msg) => {
    if (msg.method === "$/lean/fileProgress" && msg.params?.textDocument?.version !== seen.lastChecked) {
      seen.lastChecked = msg.params?.textDocument?.version;
      seen.versionsChecked += 1;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const of = (severity) => (msg.params?.diagnostics ?? []).filter((d) => d.severity === severity).map((d) => `${d.range?.start?.line}: ${String(d.message).slice(0, 120)}`);
      seen.diagnostics = { version: msg.params?.version ?? null, errors: of(1), warnings: of(2) };
    }
    return toClient(msg);
  };
};

function summarise(samples) {
  const known = samples.filter((s) => s.running >= 0 && s.unused >= 0);
  const peak = (list) => ({ running: Math.max(-1, ...list.map((s) => s.running)), unused: Math.max(-1, ...list.map((s) => s.unused)), sum: Math.max(-1, ...list.map((s) => s.running + s.unused)), workers: Math.max(0, ...list.map((s) => s.workers)) });
  const phases = {};
  for (const name of new Set(known.map((s) => s.mark))) phases[name] = peak(known.filter((s) => s.mark === name));
  const point = (s) => (s ? { running: s.running, unused: s.unused, sum: s.running + s.unused, workers: s.workers, t: s.t } : null);
  const ready = known.find((s) => s.relay === "serving" && s.phase === "ready");
  const afterReady = known.filter((s) => s.mark !== "boot");
  let maxGapMs = 0;
  for (let i = 1; i < samples.length; i++) maxGapMs = Math.max(maxGapMs, samples[i].t - samples[i - 1].t);
  return { atReady: point(ready), atEnd: point(known.at(-1)), peak: peak(known), peakAfterReady: peak(afterReady), peakByPhase: phases, sessions: [...new Set(samples.map((s) => s.session).filter((s) => s != null))], samples: samples.length, maxGapMs };
}

async function oneRun(level, n) {
  const slug = `${level.key.replaceAll("/", "-")}-${MODE}-r${n}`;
  const profile = path.join(PROFILES, `thread-growth-${slug}`);
  if (existsSync(profile)) throw new Error(`${profile} exists: a fresh profile must not`);
  mkdirSync(profile, { recursive: true });
  const reportsBefore = crashReports();
  const report = { level: level.key, mode: MODE, run: n, origin: ORIGIN, startedAt: new Date().toISOString(), why: level.why, burstChars: BURST_CHARS, infra: null, crash: null, halt: null, deaths: [] };
  const samples = [], heap = [], consoleLines = [];
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  const log = (m) => console.log(`[${slug} +${(at() / 1000).toFixed(1)}s] ${m}`);
  const ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 1400, height: 900 } });
  report.browser = ctx.browser()?.version() ?? null;
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const hold = { holds: 0, longestMs: 0 };
  let mark = "boot", step = null, stop = false; // step: the play's index, when a death needs naming
  page.on("crash", () => { report.crash = { atMs: at(), mark }; log("PAGE CRASH"); });
  page.on("console", (m) => {
    const t = m.text();
    if (t.startsWith("[qed64] edit back-pressure:")) {
      if (t.includes("holding")) hold.holds += 1;
      hold.longestMs = Math.max(hold.longestMs, Number(/(?:released after|cap at) (\d+) ms/.exec(t)?.[1] ?? 0));
    }
    if ((m.type() === "error" || /\[lean:|\[pool\]|\[qed64\]|\[boot\]|\[game-boot\]/.test(t)) && consoleLines.length < 5000) consoleLines.push(`${at()} ${t.slice(0, 500)}`);
  });
  const sampler = (async () => {
    for (let tick = 0; !stop && !report.crash; tick++) {
      const began = Date.now();
      if (tick % HEAP_EVERY_SAMPLES === 0) {
        const h = await Promise.race([page.evaluate(readHeap).catch(() => null), sleep(1000).then(() => null)]);
        if (h) heap.push({ t: at(), mark, step, ...h });
      }
      const s = await Promise.race([page.evaluate(readStatus).catch(() => null), sleep(2000).then(() => null)]);
      if (s) {
        const { death, ...sample } = s;
        samples.push({ t: at(), mark, ...sample, workers: page.workers().length });
        if (s.relay === "halted" && !report.halt) { report.halt = { atMs: at(), mark }; log("RELAY HALTED"); }
        if (death && !report.deaths.some((d) => d.seq === death.seq)) { report.deaths.push({ atMs: at(), mark, step, ...death }); log(`CHECKER DIED: ${JSON.stringify(death).slice(0, 300)}`); }
      }
      await sleep(Math.max(0, SAMPLE_MS - (Date.now() - began)));
    }
  })();
  const settled = (budget = STEP_BUDGET_MS) => page.waitForFunction(isSettled, null, { timeout: budget, polling: 100 }).then(() => true, () => false);
  const verdict = () => page.evaluate(readVerdict, { id: level.id, world: level.world, level: level.level }).catch(() => null);
  const EDITOR = ".codeview .monaco-editor textarea";
  const editor = () => page.locator(EDITOR).first();
  const lastText = () => globalThis.qed64GameRelay?.relay?.lastText ?? "";
  const paste = async (selector, text) => {
    const was = await page.evaluate(lastText);
    await page.evaluate(pasteInto, { selector, text });
    // The editor's paste is done when its change reaches the relay; no key may overtake it.
    if (selector === EDITOR) await page.waitForFunction((w) => (globalThis.qed64GameRelay?.relay?.lastText ?? "") !== w, was, { timeout: 5000, polling: 20 }).catch(() => {});
  };
  const seenNow = () => page.evaluate(() => ({ ...globalThis.__threadGrowthSeen, noRunnerTail: undefined }));
  const toEditorMode = async () => {
    const button = page.locator('button[title="Editor mode"]');
    if (await button.count()) await button.click();
    await editor().waitFor({ state: "attached", timeout: 30_000 });
    await settled();
  };

  try {
    await ctx.addInitScript(seedDifficulty, level.id);
    await page.goto(`${ORIGIN}/#/${level.id}/world/${level.world}/level/${level.level}`, { waitUntil: "domcontentloaded" });
    const ready = await page.waitForFunction(() => {
      const s = globalThis.qed64GameRelay?.status?.();
      if (/Lean could not start in your browser|Lean failed to start/.test(document.body.innerText)) return "failed";
      return s?.relay === "serving" && s?.phase === "ready" ? "ready" : false;
    }, null, { timeout: BOOT_BUDGET_MS, polling: 250 }).then((h) => h.jsonValue(), (e) => `timeout: ${String(e).slice(0, 120)}`);
    report.bootMs = at();
    log(`boot ${ready}`);
    if (ready !== "ready") { report.infra = `boot: ${ready}`; return report; }

    mark = "level";
    await page.evaluate(tapRelay);
    await page.waitForFunction(() => !!document.querySelector(".proof .goal-tabs") || !!document.querySelector(".codeview .monaco-editor textarea"), null, { timeout: STEP_BUDGET_MS });
    await settled();

    if (MODE === "play") {
      mark = "play";
      const blocks = topLevelBlocks(level.proof);
      const flat = blocks.every((b) => !b.includes("\n"));
      const TYPEWRITER = ".typewriter-input textarea";
      const typewriter = page.locator(TYPEWRITER).first();
      const useTypewriter = flat && (await typewriter.count()) > 0;
      const play = report.play = { how: useTypewriter ? "typewriter" : "editor", steps: blocks.length, unsettled: [], ms: null };
      const began = at();
      if (useTypewriter) {
        const typed = () => page.evaluate(() => (document.querySelector(".typewriter-input .view-lines")?.innerText ?? "").replace(/\s+/g, ""));
        for (const [i, line] of blocks.entries()) {
          step = i;
          await settled();
          // The input is read-only until the last step's verdict: check the text landed before Enter.
          for (let tries = 0; tries < 20 && (await typed()) !== line.replace(/\s+/g, ""); tries++) {
            await typewriter.focus();
            await page.keyboard.press("ControlOrMeta+A");
            await paste(TYPEWRITER, line.trim());
            await sleep(100);
          }
          await page.keyboard.press("Enter");
          await sleep(300);
          if (!(await settled())) play.unsettled.push(i);
        }
      } else {
        await toEditorMode();
        await editor().focus();
        for (const [i, block] of blocks.entries()) {
          step = i;
          await page.keyboard.press(DOC_END);
          await paste(EDITOR, `${block}\n`);
          await sleep(300);
          if (!(await settled())) play.unsettled.push(i);
        }
      }
      play.ms = at() - began;
      step = null;
      play.proofLanded = (await page.evaluate(readClientText).catch(() => "")).trimEnd() === blocks.join("\n");
      const deadline = Date.now() + VERDICT_BUDGET_MS;
      do {
        report.verdictAfterPlay = await verdict();
        if (report.verdictAfterPlay?.flag || report.verdictAfterPlay?.completedText) break;
        await sleep(500);
      } while (Date.now() < deadline && !report.crash);
      log(`played ${blocks.length} steps by ${play.how} in ${(play.ms / 1000).toFixed(1)} s, ${play.unsettled.length} unsettled; ${report.verdictAfterPlay?.completedText ?? "not completed"}`);
    }

    mark = "burst";
    await toEditorMode();
    const before = await page.evaluate(readClientText);
    if (MODE === "no-runner") await page.evaluate((tail) => { globalThis.__threadGrowthSeen.noRunnerTail = tail; }, SLEEP_LINE);
    await editor().focus();
    await page.keyboard.press(DOC_TOP);
    await paste(EDITOR, "/-  -/\n");
    await page.keyboard.press(DOC_TOP);
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight"); // between the two spaces
    const text = burstText(BURST_CHARS);
    const seenBefore = await seenNow();
    const burstBegan = Date.now();
    await page.keyboard.type(text, { delay: BURST_DELAY_MS });
    const burst = report.burst = { ms: Date.now() - burstBegan, chars: text.length, changes: null, requests: null, versionsChecked: null, settleMs: null, documentHead: null, landed: null, noRunnerDocument: null, diagnosticsUnderComment: null, restored: null };

    mark = "settle";
    const settleBegan = Date.now();
    if (await settled(SETTLE_BUDGET_MS)) burst.settleMs = Date.now() - settleBegan;
    const seenAfter = await seenNow();
    burst.changes = seenAfter.changes - seenBefore.changes;
    burst.requests = seenAfter.requests - seenBefore.requests;
    burst.versionsChecked = seenAfter.versionsChecked - seenBefore.versionsChecked;
    const worker = await page.evaluate(() => globalThis.qed64GameRelay.relay.lastText ?? "");
    // The comment closed, above the whole proof, with nothing else moved.
    const squeeze = (t) => t.replace(/\s+/g, "");
    burst.landed = squeeze(worker.split("\n").slice(2).join("\n")) === squeeze(`/-${text}-/${before}${MODE === "no-runner" ? SLEEP_LINE : ""}`);
    burst.documentHead = worker.slice(worker.indexOf("\n") + 1).slice(0, 400);
    if (MODE === "no-runner") burst.noRunnerDocument = !worker.includes("Runner \"") && worker.includes(SLEEP_LINE);
    await page.waitForFunction(() => globalThis.__threadGrowthSeen.diagnostics?.version === globalThis.qed64GameRelay.relay.doc?.version, null, { timeout: VERDICT_BUDGET_MS, polling: 100 }).catch(() => {});
    burst.diagnosticsUnderComment = (await seenNow()).diagnostics;
    if (!burst.landed) report.infra = "the comment did not land above the proof, so this burst measures something else";
    log(`burst ${text.length} chars in ${(burst.ms / 1000).toFixed(1)} s, ${burst.changes} changes, ${burst.versionsChecked} versions checked; settled after ${burst.settleMs ?? "never"} ms; landed ${burst.landed}`);

    mark = "restore";
    await editor().focus();
    await page.keyboard.press("ControlOrMeta+A");
    if (before) await paste(EDITOR, before);
    else await page.keyboard.press("Backspace");
    await sleep(300);
    await settled(SETTLE_BUDGET_MS);
    if (MODE !== "no-runner") burst.restored = (await page.evaluate(readClientText)) === before;
    await sleep(QUIET_AFTER_MS);
    mark = "end";
    report.heapAtEnd = await page.evaluate(readHeap).catch(() => null); // and a fresh pool sample for atEnd
    await sleep(2 * SAMPLE_MS);
    report.verdict = await verdict();
    Object.assign(report, await page.evaluate(readEnd).catch(() => ({})));
    await page.screenshot({ path: path.join(OUT, `${slug}.png`) }).catch(() => {});
  } catch (e) {
    if (!report.crash) report.infra = String(e).slice(0, 400);
    log(`stopped: ${String(e).slice(0, 200)}`);
  } finally {
    stop = true;
    await sampler;
    if (report.crash) await sleep(6000); // the crash report arrives a few seconds after the crash
    await Promise.race([ctx.close().catch(() => {}), sleep(30_000)]);
    rmSync(profile, { recursive: true, force: true });
    report.newCrashReports = [...crashReports()].filter((f) => !reportsBefore.has(f)).map(reportSignature);
    Object.assign(report, summarise(samples));
    report.heapPeakMib = Math.max(-1, ...heap.map((h) => h.mib));
    report.heapMaxMib = Math.max(-1, ...heap.map((h) => h.maxMib));
    report.editHolds = hold;
    report.totalMs = at();
    writeFileSync(path.join(OUT, `${slug}-samples.json`), JSON.stringify({ samples, heap }));
    writeFileSync(path.join(OUT, `${slug}-console.log`), consoleLines.join("\n"));
    writeFileSync(path.join(OUT, `${slug}.json`), JSON.stringify(report, null, 1));
  }
  return report;
}

const levels = levelArgs.map(resolveLevel);
mkdirSync(OUT, { recursive: true });
mkdirSync(PROFILES, { recursive: true });
// Playwright's own temp files go with the rest, never to the system's temp dir.
const TMP = path.join(OUT, "tmp");
mkdirSync(TMP, { recursive: true });
process.env.TMPDIR = TMP;

const reports = [];
for (const level of levels) for (let n = 1; n <= RUNS; n++) reports.push(await oneRun(level, n));
rmSync(TMP, { recursive: true, force: true });

const crashed = (r) => !!r.crash || r.newCrashReports.length > 0;
const pair = (p) => (p ? `${p.running}/${p.unused}` : "-");
console.log("\n| level | mode | run | ready run/unused | peak running | peak unused | peak unused after ready | peak sum | end run/unused | peak workers after ready | heap MiB / cap | crash | halt | restarts | deaths | holds | burst changes / checked | verdict |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of reports) {
  console.log(`| ${r.level} | ${r.mode} | ${r.run} | ${pair(r.atReady)} | ${r.peak.running} | ${r.peak.unused} | ${r.peakAfterReady.unused} | ${r.peak.sum} | ${pair(r.atEnd)} | ${r.peakAfterReady.workers} | ${r.heapPeakMib} / ${r.heapMaxMib} | ${crashed(r) ? `yes (${r.newCrashReports.length} .ips)` : "no"} | ${r.halt ? "yes" : "no"} | ${r.sessions.length - 1} | ${r.deaths.length} | ${r.editHolds.holds} | ${r.burst?.changes ?? "-"} / ${r.burst?.versionsChecked ?? "-"} | ${r.infra ? `infra: ${r.infra.slice(0, 60)}` : r.verdict?.completedText ?? `not completed, ${r.seen?.diagnostics?.errors?.length ?? "?"} error lines`} |`);
}
writeFileSync(path.join(OUT, `summary-${MODE}.json`), JSON.stringify(reports, null, 1));
process.exit(reports.some((r) => r.infra) ? 3 : reports.some((r) => crashed(r) || r.halt) ? 1 : 0);
