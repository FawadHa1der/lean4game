/**
 * L3: Lean ≥ 4.2x diagnostics can carry a WIDGET embed in their message tree —
 * `{ tag: [{ widget: { wi, alt } }, inner] }` (the error-explanation link,
 * "Try this" suggestions). The bundled lean4-infoview trace explorer predates
 * widget embeds and renders them as `malformed MsgEmbed: {…json…}`. Every
 * widget embed carries `alt`, the plain TaggedText to show where widgets are
 * not supported — this pure pre-pass substitutes it (recursively: an alt may
 * itself contain embeds, and eager trace nodes carry message children), so
 * the tree that reaches InteractiveMessage only has embeds it knows.
 *
 * The "Try this" insertion link (`Lean.Meta.Hint.textInsertionWidget`) is
 * the exception: its alt is the literal link text "[apply]", which is not
 * clickable here and read as a broken control before every suggestion. It is
 * dropped together with the single space that separates it from the
 * suggestion, so the pane reads "Try this:\n  exact …" like upstream.
 *
 * LIMITATION: only the tree that arrives with the diagnostic is rewritten
 * (text / append / tag, widget alts, eager `children.strict` trace nodes).
 * LAZY trace children are fetched later inside the bundled component
 * (lean4-infoview traceExplorer: lazyTraceChildrenToInteractive) and never
 * pass through here — a widget embed inside an expanded lazy trace node
 * (editor mode, `set_option trace.… true in` around a tactic that emits a
 * Try-this / error-explanation widget) still renders "malformed MsgEmbed".
 * Covering that needs a patched copy of traceExplorer.tsx (one
 * `'widget' in embed` branch) aliased in vite — not done.
 *
 * No React / infoview imports: unit-tested with plain node
 * (msg-embed.test.ts).
 */
export type TaggedTextLike = { text: string } | { append: TaggedTextLike[] } | { tag: [unknown, TaggedTextLike] };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";

const INSERTION_WIDGET = "Lean.Meta.Hint.textInsertionWidget";
/** `{ tag: [{ widget: { wi: { id: textInsertionWidget } } }, _] }` */
function isInsertionLink(node: unknown): boolean {
  if (!isObj(node) || !Array.isArray(node.tag) || node.tag.length !== 2) return false;
  const embed = node.tag[0];
  if (!isObj(embed) || !isObj(embed.widget)) return false;
  const wi = (embed.widget as { wi?: unknown }).wi;
  return isObj(wi) && wi.id === INSERTION_WIDGET;
}
/** The text of a leaf as the server emits separators: `{text}` or
 * `{ tag: [{ expr: {text} }, {text: ""}] }`; undefined for anything else. */
function leafText(node: unknown): string | undefined {
  if (!isObj(node)) return undefined;
  if (typeof node.text === "string") return node.text;
  if (Array.isArray(node.tag) && node.tag.length === 2) {
    const [embed, inner] = node.tag as [unknown, unknown];
    if (isObj(embed) && isObj(embed.expr) && typeof embed.expr.text === "string" && leafText(inner) === "") return embed.expr.text;
  }
  return undefined;
}

/** Returns a tree without widget embeds; shares every untouched subtree
 * with the input (and returns the input itself when nothing changed, so
 * memoised renderers see a stable identity). Never throws on a shape it
 * does not know — that subtree is returned as it came. */
export function stripWidgetEmbeds<T>(fmt: T): T {
  if (!isObj(fmt)) return fmt;
  if (Array.isArray((fmt as { append?: unknown }).append)) {
    const old = (fmt as { append: unknown[] }).append;
    // "[apply] exact …": the link goes, and so does the one space after it.
    const kept = old.filter((n, i) => !isInsertionLink(n) && !(i > 0 && isInsertionLink(old[i - 1]) && leafText(n) === " "));
    const next = kept.map(stripWidgetEmbeds);
    return next.length !== old.length || next.some((n, i) => n !== old[i]) ? ({ ...fmt, append: next } as T) : fmt;
  }
  const tag = (fmt as { tag?: unknown }).tag;
  if (Array.isArray(tag) && tag.length === 2) {
    const [embed, inner] = tag as [unknown, unknown];
    if (isObj(embed) && isObj(embed.widget)) {
      if (isInsertionLink(fmt)) return { text: "" } as T; // outside an append: just the dead link
      const alt = (embed.widget as { alt?: unknown }).alt;
      // `alt` is the designated fallback; a widget without one falls back to
      // the tag's own inner text.
      return stripWidgetEmbeds((isObj(alt) ? alt : inner) as T);
    }
    let nextEmbed = embed;
    if (isObj(embed) && isObj(embed.trace)) {
      const trace = embed.trace as { msg?: unknown; children?: unknown };
      const msg = stripWidgetEmbeds(trace.msg);
      let children = trace.children;
      if (isObj(children) && Array.isArray(children.strict)) {
        const strict = (children.strict as unknown[]).map(stripWidgetEmbeds);
        if (strict.some((n, i) => n !== (children as { strict: unknown[] }).strict[i])) children = { ...children, strict };
      }
      if (msg !== trace.msg || children !== trace.children) nextEmbed = { ...embed, trace: { ...trace, msg, children } };
    }
    const nextInner = stripWidgetEmbeds(inner);
    return nextEmbed !== embed || nextInner !== inner ? ({ ...fmt, tag: [nextEmbed, nextInner] } as T) : fmt;
  }
  return fmt;
}
