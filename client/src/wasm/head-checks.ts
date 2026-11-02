/**
 * What the page's HEADs on its own deployment say (pure: unit-tested by
 * head-checks.test.ts, used by game-boot.ts): the fetches are passed in.
 */

export type Preflight = { ok: true } | { ok: false; kind: "link" | "deploy"; detail: string };

/** One worker script's answer (null: the fetch failed outright, which is the
 * link, not the deploy). */
function scriptVerdict(script: string, r: Response | null): Preflight {
  if (!r) return { ok: false, kind: "link", detail: `${script} is unreachable` };
  // Missing ONLY on 404/410 or a 2xx single-page-fallback HTML answer (the
  // rule checkSnapshotPairing / gameKnownCheck follow): a 5xx/429/403 from
  // the edge or a proxy while the link recovers is transient — the link.
  const html = r.ok && /text\/html/i.test(r.headers.get("content-type") ?? "");
  if (r.status === 404 || r.status === 410 || html) return { ok: false, kind: "deploy", detail: `this deployment is missing ${script} (HTTP ${r.status}${html ? ", HTML page" : ""}) — the site needs a rebuild that stages the worker scripts` };
  if (!r.ok) return { ok: false, kind: "link", detail: `${script}: HTTP ${r.status}` };
  return { ok: true };
}

/** HEAD every script at once and report the first failure in the list's order:
 * the callers read its link-or-deploy verdict, so it is the verdict one at a
 * time would give, whichever answer comes back first. */
export async function preflightScripts(scripts: readonly string[], head: (script: string) => Promise<Response>): Promise<Preflight> {
  const verdicts = await Promise.all(scripts.map(async (script) => scriptVerdict(script, await head(script).catch(() => null))));
  return verdicts.find((v) => !v.ok) ?? { ok: true };
}

/** What an answered HEAD says of a snapshot object: why it is not there, else
 * null. A static host answers 404 for a missing object; a single-page fallback
 * (scripts/serve-dist.mjs, the vite dev server) answers 200 with the app's HTML
 * — neither is the snapshot. Any other refusal (405/501/5xx: a host that does
 * not serve HEAD) is no evidence of a missing object. */
export function snapshotMissing(r: Response): string | null {
  const html = /text\/html/i.test(r.headers.get("content-type") ?? "");
  return html || r.status === 404 || r.status === 410 ? `HTTP ${r.status}${html ? ", HTML page" : ""}` : null;
}

/** Re-checks of a rejected HEAD once the hold says the link answers: past them
 * something between this page and this one URL rejects it (a blocker, a proxy). */
const HEAD_RECHECKS = 3;

/** A HEAD that was rejected says nothing of the object: it is the link. Hold,
 * then ask again, until an answer. The hold ends when the link is back (it is
 * the boot's: holdForNetwork, whose "deploy" verdict ends the check too), and it
 * returns at once while the origin answers, so `wait` keeps a rejecting URL from
 * spinning. Null: the origin answers but this URL still rejects after the
 * re-checks, which is no evidence either; the caller goes on and the download
 * reports, rather than waiting for ever on a connection that is up. */
export async function headThroughHolds(head: () => Promise<Response>, hold: () => Promise<"ok" | "deploy">, wait: () => Promise<void>): Promise<Response | "deploy" | null> {
  for (let rechecks = 0; ; rechecks++) {
    const r = await head().catch(() => null);
    if (r) return r;
    if (rechecks === HEAD_RECHECKS) return null;
    if ((await hold()) === "deploy") return "deploy";
    await wait();
  }
}
