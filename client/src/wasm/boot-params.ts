/**
 * SEC1: the page's dev overrides — `?snapshots=<dir>`, `?profiles=<dir>`,
 * `?runtime=<buildId>` — read and judged in ONE place (pure apart from the
 * one `location` read; unit-tested by boot-params.test.ts, used by
 * games-api.ts, game-boot.ts, game-cache.ts and the landing page).
 *
 * The hole (review of 4083fb4): games-api returned the raw query values with
 * no check, and the index fetch spliced `?snapshots` into `/${dir}/index.json`.
 * A browser resolves `//evil.example/x`, `/evil.example/x` with the leading
 * slash the splice adds, `\evil.example` (a backslash is a slash in special
 * schemes) and their percent-encoded spellings (URLSearchParams decodes
 * them) to https://evil.example/…/index.json — a cross-origin index COEP
 * does not stop (a CORS-enabled host answers), whose absolute entry urls
 * survived the `/snapshots/` re-root and reached the pairing HEAD, the
 * prefetch worker and the Lean worker. The region is committed in OPFS under
 * the key the index ITSELF names (name + digest, never verified), so one
 * crafted link poisoned the live key for every later visit, and in editor
 * mode the infoview imports widget JS from that environment as a blob
 * module on this origin. `?profiles` went cross-origin the same way;
 * `?runtime` kept its same-origin prefix but could path-traverse.
 *
 * The rule is qed64's own (docs/EMBEDDING.md §4, `validateBootOverrides`):
 * a directory override is one directory name, optionally under the promoted
 * directory's name (`snapshots/…`, `profiles/…`), that resolves on this
 * page's origin; a runtime override is a build id. This page is stricter in
 * three ways the rule leaves to it: an EMPTY value is refused (qed64 reads it
 * as "unset" — a silent fallback to the served set), a parameter given TWICE
 * is refused (qed64 takes the first), and every parameter is judged on its
 * own, so the landing notice and the card name each refusal. Anything
 * refused is refused loudly: the boot fails with the reason on the failure
 * card and the landing page says so — never a silent fallback to the default
 * (a dev who typed a wrong value must not test the served bake believing it
 * is theirs). The values are read from URLSearchParams once (decoded once —
 * nothing decodes them again) and a refused value is never handed to
 * anything that fetches.
 *
 * And the second line of defence: every URL an index or a manifest names
 * must resolve to this origin before it reaches fetch, a worker or the
 * service worker. qed64's loaders refuse a snapshot index (redirects and
 * entries included), a profile index, manifest or part, and the prefetch and
 * Lean workers refuse a region URL, all off this site (HARDENING #57); its
 * runtime-manifest resolver does not look at the chunk URLs, so
 * refuseForeignManifestUrls does, and isSameOrigin guards what this page
 * sends the service worker.
 */
import { BootParamError, validateBootOverrides, type BootOverrides, type RuntimeManifest } from "qed64/embed";

export type BootParamName = "snapshots" | "profiles" | "runtime";
const BOOT_PARAM_NAMES: readonly BootParamName[] = ["snapshots", "profiles", "runtime"];

/** The codes a SEC1 refusal carries (in its message too: the failure card
 * shows the message and the level pane tells the kinds apart by them). */
export const BOOT_PARAM_REFUSED = "BOOT_PARAM_REFUSED";
export const SNAPSHOT_INDEX_FOREIGN_URL = "SNAPSHOT_INDEX_FOREIGN_URL";
export const RUNTIME_MANIFEST_FOREIGN_URL = "RUNTIME_MANIFEST_FOREIGN_URL";
export type Sec1Code = typeof BOOT_PARAM_REFUSED | typeof SNAPSHOT_INDEX_FOREIGN_URL | typeof RUNTIME_MANIFEST_FOREIGN_URL;

/** The level pane's (and the landing page's) test for a SEC1 refusal in a
 * failure label: the code, or no match. */
export const SEC1_REFUSAL_RE = /\((BOOT_PARAM_REFUSED|SNAPSHOT_INDEX_FOREIGN_URL|RUNTIME_MANIFEST_FOREIGN_URL)\)/;

/** A refusal: the error the boot throws (its message is the failure card's
 * reason) and the landing page shows. */
export class Sec1Refusal extends Error {
  // A plain field, not a parameter property: Node's type-stripping test
  // runner refuses those (ts-resolve-hook.mjs).
  readonly code: Sec1Code;
  constructor(code: Sec1Code, message: string) {
    super(message);
    this.name = "Sec1Refusal";
    this.code = code;
  }
}

export const isSec1Refusal = (e: unknown): e is Sec1Refusal =>
  e instanceof Sec1Refusal || (typeof (e as { message?: unknown })?.message === "string" && SEC1_REFUSAL_RE.test((e as { message: string }).message));

/** The value as the card shows it: quoted with escapes (a tab or a
 * backslash stays visible), and short — it is attacker-chosen text. */
const shown = (v: string): string => JSON.stringify(v.length > 80 ? `${v.slice(0, 80)}…` : v);

const WHY: Record<BootParamName, string> = {
  snapshots: "only a same-origin environment directory is allowed (one directory name of letters, digits, '.', '_' or '-', optionally under snapshots/)",
  profiles: "only a same-origin profile directory is allowed (one directory name of letters, digits, '.', '_' or '-', optionally under profiles/)",
  runtime: "only a runtime build id is allowed (wasm64- and 16 hexadecimal digits)",
};

function refusedParam(name: BootParamName, value: string, why = WHY[name]): Sec1Refusal {
  return new Sec1Refusal(BOOT_PARAM_REFUSED, `refused ?${name}=${shown(value)} (${BOOT_PARAM_REFUSED}) — ${why}`);
}

/** Does `url` resolve to the origin of `href` (the page)? Relative and
 * absolute-path URLs do; `//host/…`, `\\host`, `https://other/…`, `data:`
 * (origin "null") and anything unparsable do not. */
export function isSameOrigin(url: unknown, href: string = globalThis.location?.href): boolean {
  if (typeof url !== "string") return false;
  try {
    const page = new URL(href);
    // An opaque page origin ("null": file:, data:) would equal a data: URL's.
    return page.origin !== "null" && new URL(url, page).origin === page.origin;
  } catch {
    return false;
  }
}

/** The origin `url` resolves to, for a refusal message (the bare input when
 * it does not parse). */
function originOf(url: unknown, href: string): string {
  try { return new URL(String(url), href).origin; } catch { return shown(String(url)); }
}

/** The checked overrides. A refused one is null here and listed in
 * `refused`; every reader of an override goes through `bootOverrides`, which
 * throws a refusal instead of returning anything. */
export interface BootParams {
  snapshots: string | null;
  profiles: string | null;
  runtime: string | null;
  refused: Sec1Refusal[];
  refusedNames: BootParamName[];
}

/** The rule, pure: `search` is `location.search`, `href` the page URL the
 * directory overrides must stay on. Absent = null. Present but empty, given
 * twice, or refused by qed64's validateBootOverrides = refused (an empty
 * `?snapshots=` used to mean "no override": a silent fallback, now a loud
 * refusal like any other value the rule does not accept). */
export function parseBootParams(search: string, href: string): BootParams {
  const q = new URLSearchParams(search);
  const out: BootParams = { snapshots: null, profiles: null, runtime: null, refused: [], refusedNames: [] };
  const refuse = (name: BootParamName, r: Sec1Refusal) => { out.refused.push(r); out.refusedNames.push(name); };
  // An unparsable page URL has no origin to stay on: "null", which no
  // directory resolves to (an opaque page origin — file:, data: — is "null" too).
  let origin = "null";
  try { origin = new URL(href).origin; } catch { /* every directory override is refused */ }
  for (const name of BOOT_PARAM_NAMES) {
    const all = q.getAll(name);
    if (all.length === 0) continue;
    if (all.length > 1) { refuse(name, refusedParam(name, all.join("&"), `given ${all.length} times; at most one value is allowed`)); continue; }
    const value = all[0]!;
    if (value === "") { refuse(name, refusedParam(name, value)); continue; }
    try {
      out[name] = validateBootOverrides({ [name]: value }, origin)[name];
    } catch (e) {
      if (!(e instanceof BootParamError)) throw e;
      refuse(name, refusedParam(name, value));
    }
  }
  return out;
}

/** The page's verdict, read once per document: keyed by the Location
 * object, which is one per document — a later replaceState (the location
 * atoms navigate with it) can change `location.search` mid-page, and the
 * index the boot fetched, the sweep's stand-down and the landing tiles must
 * all go by the SAME first reading. (A fresh Location — each case of a unit
 * test — reads again.) */
let memo: { at: unknown; params: BootParams } | null = null;
export function bootParams(): BootParams {
  const loc = globalThis.location;
  if (memo?.at !== loc) memo = { at: loc, params: parseBootParams(loc?.search ?? "", loc?.href) };
  return memo.params;
}

/** The page's overrides in qed64's shape, for the readers that fetch with
 * them (qed64's resolvers and installArtifacts, the sweep's stand-down) —
 * or the first refusal THROWN, never a fallback: a page carrying a refused
 * override fetches no artifact for any of them. */
export function bootOverrides(): BootOverrides {
  const p = bootParams();
  if (p.refused.length) throw p.refused[0]!;
  return { snapshots: p.snapshots, profiles: p.profiles, runtime: p.runtime };
}

/** The boot's gate: throws the first refusal (any override), so a page
 * carrying one boots nothing at all. */
export function assertBootParams(): void {
  bootOverrides();
}

/** SEC1-R2: the page's address without its dev overrides — the way out a
 * refusal card (and the landing notice) offers. A reload keeps the query
 * and refuses again, and no in-app navigation drops it (the location atoms
 * keep `search`), so the player had to edit the address by hand (on a phone,
 * hardly). All three names go, as the rule read them (URLSearchParams
 * decodes the names too: `%73napshots` is `snapshots`); the rest of the
 * query and the hash (the level) stay. Nothing to remove: `href` itself. */
export function addressWithoutOverrides(href: string): string {
  const u = new URL(href);
  if (!BOOT_PARAM_NAMES.some((n) => u.searchParams.has(n))) return href;
  for (const n of BOOT_PARAM_NAMES) u.searchParams.delete(n);
  return u.href;
}

/** Go there. With nothing left to remove (a replaceState dropped the
 * override after the page's first reading, which bootParams keeps for the
 * document) an assign would be a same-document hash navigation that reads
 * nothing again: reload instead — a new document reads the address anew. */
export function openWithoutOverrides(loc: Pick<Location, "href" | "assign" | "reload"> = globalThis.location): void {
  const next = addressWithoutOverrides(loc.href);
  if (next === loc.href) loc.reload();
  else loc.assign(next);
}

/** The qed64 index loader's refusal as the SEC1 one. `loadSnapshotIndex`
 * refuses an index, a redirect or an entry off this site WHOLE before it
 * returns (HARDENING #57: one foreign entry means the index is not this
 * site's, and a partial index would still bind the others' keys), with code
 * SNAPSHOT_URL_REFUSED — which the package's `fetchSnapshotIndex` answers
 * with the same null as a missing index ("unreadable", retried). The card
 * and the landing notice need the coded refusal instead. Its message names
 * the attacker's entry: bounded like any shown value. */
export function refusedSnapshotIndex(detail: string): Sec1Refusal {
  return new Sec1Refusal(SNAPSHOT_INDEX_FOREIGN_URL,
    `the snapshot index was refused (${SNAPSHOT_INDEX_FOREIGN_URL}): ${detail.length > 160 ? `${detail.slice(0, 160)}…` : detail} — only same-origin snapshot URLs are allowed`);
}

/** Refuse a runtime manifest whose chunk urls leave this origin (the Lean
 * worker fetches them, the service worker caches them). */
export function refuseForeignManifestUrls(manifest: RuntimeManifest, href: string = globalThis.location?.href): void {
  const files = (manifest.files ?? {}) as Record<string, { chunks?: { url?: unknown }[] } | undefined>;
  for (const [file, f] of Object.entries(files)) {
    (f?.chunks ?? []).forEach((c, i) => {
      if (!isSameOrigin(c?.url, href)) {
        throw new Sec1Refusal(RUNTIME_MANIFEST_FOREIGN_URL,
          `the runtime manifest was refused (${RUNTIME_MANIFEST_FOREIGN_URL}): ${file} chunk ${i} points to ${originOf(c?.url, href)}, not this site — only same-origin runtime URLs are allowed`);
      }
    });
  }
}
