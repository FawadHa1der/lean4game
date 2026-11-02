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
