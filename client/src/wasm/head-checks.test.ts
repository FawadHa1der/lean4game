// Run: node --import ./client/src/wasm/ts-resolve-hook.mjs client/src/wasm/head-checks.test.ts
// Review R13(c): the worker-script preflight sends its HEADs at once. Its three
// callers read the link-or-deploy verdict, so it must stay the verdict one at a
// time gives: the first failure in the list's order, whichever answer comes
// back first, with every status rule unchanged.
import assert from "node:assert";
import { WORKER_URLS } from "qed64/embed";
import { preflightScripts, type Preflight } from "./head-checks";

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

  console.log("head-checks: all assertions passed");
}
void main();
