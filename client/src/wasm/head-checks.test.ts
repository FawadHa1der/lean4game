// Run: node --import ./client/src/wasm/ts-resolve-hook.mjs client/src/wasm/head-checks.test.ts
// Review R13(c): the worker-script preflight sends its HEADs at once. Its three
// callers read the link-or-deploy verdict, so it must stay the verdict one at a
// time gives: the first failure in the list's order, whichever answer comes
// back first, with every status rule unchanged.
// Review R13(d): a .snapz HEAD the network cut is a hold, not "not published":
// the boot holds, then asks again. An answered 404/410/HTML stays "not
// published". The hold can end, and no rejecting URL can spin.
import assert from "node:assert";
import { WORKER_URLS } from "qed64/embed";
import { headThroughHolds, preflightScripts, snapshotMissing, type Preflight } from "./head-checks";

const html = (status = 200) => new Response(null, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const js = (status = 200) => new Response(null, { status, headers: { "content-type": "text/javascript" } });
type Answer = () => Promise<Response>;
const answer = (r: () => Response): Answer => () => Promise.resolve(r());
const offline: Answer = () => Promise.reject(new TypeError("Failed to fetch"));
const ok = answer(() => js());

const run = (answers: Answer[]): Promise<Preflight> => {
  const scripts = answers.map((_, i) => `/workers/s${i}.js`);
  return preflightScripts(scripts, (script) => answers[scripts.indexOf(script)]!());
};

async function main(): Promise<void> {
  // The status rules, one script at a time: unchanged from the sequential loop.
  assert.deepEqual(await preflightScripts([], () => { throw new Error("no script to ask"); }), { ok: true });
  assert.deepEqual(await run([ok]), { ok: true });
  assert.deepEqual(await run([answer(() => js(204))]), { ok: true });
  assert.deepEqual(await run([offline]), { ok: false, kind: "link", detail: "/workers/s0.js is unreachable" });
  for (const status of [404, 410]) {
    assert.deepEqual(await run([answer(() => js(status))]), { ok: false, kind: "deploy", detail: `this deployment is missing /workers/s0.js (HTTP ${status}) — the site needs a rebuild that stages the worker scripts` });
    assert.deepEqual(await run([answer(() => html(status))]), { ok: false, kind: "deploy", detail: `this deployment is missing /workers/s0.js (HTTP ${status}) — the site needs a rebuild that stages the worker scripts` }, "a 404 page's HTML is still HTTP 404, no \"HTML page\"");
  }
  assert.deepEqual(await run([answer(() => html())]), { ok: false, kind: "deploy", detail: "this deployment is missing /workers/s0.js (HTTP 200, HTML page) — the site needs a rebuild that stages the worker scripts" }, "a single-page fallback is no worker script");
  for (const status of [403, 429, 500, 503]) {
    assert.deepEqual(await run([answer(() => js(status))]), { ok: false, kind: "link", detail: `/workers/s0.js: HTTP ${status}` }, "transient: the link");
    assert.deepEqual(await run([answer(() => html(status))]), { ok: false, kind: "link", detail: `/workers/s0.js: HTTP ${status}` }, "a proxy's error page is no single-page fallback");
  }

  // The whole list at once: every HEAD is in flight before any answer.
  {
    const scripts = ["/a.js", "/b.js", "/c.js"];
    const started: string[] = [];
    const answers: ((r: Response) => void)[] = [];
    const verdict = preflightScripts(scripts, (s) => { started.push(s); return new Promise((resolve) => answers.push(resolve)); });
    assert.deepEqual(started, scripts, "all started before the first answer");
    for (const a of answers) a(js());
    assert.deepEqual(await verdict, { ok: true });
  }

  // The order is the list's, not the network's: the later script answers first.
  {
    let answerFirst!: () => void;
    const first = new Promise<Response>((resolve, reject) => { answerFirst = () => reject(new TypeError("Failed to fetch")); });
    let secondAnswered = false;
    const verdict = preflightScripts(["/a.js", "/b.js"], (s) => {
      if (s === "/a.js") return first;
      secondAnswered = true;
      return Promise.resolve(js(404));
    });
    assert.equal(secondAnswered, true);
    await new Promise((r) => setImmediate(r)); // b's 404 is in; a's failure is not
    answerFirst();
    assert.deepEqual(await verdict, { ok: false, kind: "link", detail: "/a.js is unreachable" }, "link down first in the list: holds, even though b's 404 came back first");
  }

  // Every mix of three outcomes over three scripts: the verdict one at a time gives.
  const kinds: Answer[] = [ok, offline, answer(() => js(404)), answer(() => js(410)), answer(() => html()), answer(() => js(503))];
  for (const a of kinds) for (const b of kinds) for (const c of kinds) {
    let oneAtATime: Preflight = { ok: true };
    const answers = [a, b, c];
    for (let i = 0; i < 3; i++) {
      const v = await preflightScripts([`/workers/s${i}.js`], answers[i]!);
      if (!v.ok) { oneAtATime = v; break; }
    }
    assert.deepEqual(await run(answers), oneAtATime);
  }

  // qed64's own list: a missing one is named, in its order.
  {
    assert.ok(WORKER_URLS.length >= 5, "the pin's worker scripts");
    const missing = WORKER_URLS[2]!, last = WORKER_URLS[WORKER_URLS.length - 1]!;
    const verdict = await preflightScripts(WORKER_URLS, (s) => Promise.resolve(s === missing || s === last ? js(404) : js()));
    assert.deepEqual(verdict, { ok: false, kind: "deploy", detail: `this deployment is missing ${missing} (HTTP 404) — the site needs a rebuild that stages the worker scripts` });
    assert.deepEqual(await preflightScripts(WORKER_URLS, () => Promise.resolve(js())), { ok: true });
  }

  // R13(d): an answered HEAD, the rule of the "not published" card
  assert.equal(snapshotMissing(js(404)), "HTTP 404");
  assert.equal(snapshotMissing(js(410)), "HTTP 410");
  assert.equal(snapshotMissing(html()), "HTTP 200, HTML page", "a single-page fallback is no snapshot");
  assert.equal(snapshotMissing(html(404)), "HTTP 404, HTML page");
  assert.equal(snapshotMissing(js()), null);
  assert.equal(snapshotMissing(new Response(null, { status: 200 })), null, "no content type");
  for (const status of [403, 405, 429, 500, 501, 503]) assert.equal(snapshotMissing(js(status)), null, "a host that does not serve HEAD: no evidence, the download reports");

  // R13(d): the HEAD through holds. `log` is the order of every step.
  const through = (answers: Answer[], hold: () => Promise<"ok" | "deploy"> = () => Promise.resolve("ok")) => {
    const log: string[] = [];
    let asked = 0;
    const out = headThroughHolds(
      () => { log.push("head"); return (answers[Math.min(asked++, answers.length - 1)]!)(); },
      () => { log.push("hold"); return hold(); },
      () => { log.push("wait"); return Promise.resolve(); },
    );
    return { out, log };
  };
  {
    // An answer at once: nothing held, whatever it says.
    for (const r of [js(), js(404), html(), js(503)]) {
      const { out, log } = through([() => Promise.resolve(r)]);
      assert.equal(await out, r);
      assert.deepEqual(log, ["head"]);
    }
  }
  {
    // The link is down: no HEAD until the hold ends, then the check repeats and its answer stands.
    let linkBack!: (v: "ok") => void;
    const { out, log } = through([offline, ok], () => new Promise((resolve) => { linkBack = resolve; }));
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(log, ["head", "hold"], "held: nothing more is asked while the link is down");
    linkBack("ok");
    const r = await out;
    assert.equal((r as Response).status, 200);
    assert.deepEqual(log, ["head", "hold", "wait", "head"]);
  }
  {
    // A 404 behind the cut is still "not published": the answer decides.
    const { out, log } = through([offline, answer(() => js(404))]);
    assert.equal(snapshotMissing((await out) as Response), "HTTP 404");
    assert.deepEqual(log, ["head", "hold", "wait", "head"]);
  }
  {
    // The hold found a deploy problem: the check ends with it.
    const { out, log } = through([offline], () => Promise.resolve("deploy"));
    assert.equal(await out, "deploy");
    assert.deepEqual(log, ["head", "hold"]);
  }
  {
    // The origin answers (the hold returns at once) but this URL keeps rejecting:
    // a wait before every re-check, then it ends with no verdict.
    const { out, log } = through([offline]);
    assert.equal(await out, null, "no evidence: the download reports");
    assert.deepEqual(log, ["head", "hold", "wait", "head", "hold", "wait", "head", "hold", "wait", "head"]);
  }

  console.log("head-checks: all assertions passed");
}
void main();
