// Run: node --import ./client/src/wasm/ts-resolve-hook.mjs client/src/components/infoview/msg-embed.test.ts
import assert from "node:assert";
import { stripWidgetEmbeds } from "./msg-embed.ts";

const text = (t: string) => ({ text: t });
const expr = { tag: [{ expr: { text: "n + 0" } }, text("n + 0")] };
const widget = (alt: unknown, inner: unknown = text("")) => ({ tag: [{ widget: { wi: { id: "Lean.errorDescriptionWidget", javascriptHash: "1", props: { code: "lean.unknownIdentifier" } }, alt } }, inner] });

// untouched trees keep their identity
const plain = { append: [text("unsolved goals"), expr] };
assert.equal(stripWidgetEmbeds(plain), plain);
assert.equal(stripWidgetEmbeds(expr), expr);

// the live shape: Unknown identifier `hZZ` + the error-explanation widget
const live = { append: [widget(text("")), text("Unknown identifier `hZZ`")] };
const out = stripWidgetEmbeds(live) as any;
assert.deepEqual(out, { append: [text(""), text("Unknown identifier `hZZ`")] });
assert.ok(!JSON.stringify(out).includes("widget"));

// "Try this" suggestion: alt is the readable text; nested embeds in alt survive, nested widgets do not
const tryThis = widget({ append: [text("Try this: "), expr, widget(text("exact zero_add n"))] });
assert.deepEqual(stripWidgetEmbeds(tryThis), { append: [text("Try this: "), expr, text("exact zero_add n")] });
assert.equal((stripWidgetEmbeds(tryThis) as any).append[1], expr, "untouched subtrees are shared");

// the live-captured Try-this shape (lv-shots/r3/L3-nng4.json): the alt of the
// insertion widget is the dead link text "[apply]" — dropped with its space
const sep = (t: string) => ({ tag: [{ expr: { text: t } }, text("")] });
const apply = { tag: [{ widget: { alt: sep("[apply]"), wi: { id: "Lean.Meta.Hint.textInsertionWidget", javascriptHash: "14102652505372521831", props: { acceptSuggestionProps: { hoverText: "Apply suggestion", kind: "text", linkText: "[apply]" }, suggestion: "exact Eq.refl (37 * x + q)" } } } }, text("")] };
const flat = (n: any): string => typeof n?.text === "string" ? n.text : Array.isArray(n?.append) ? n.append.map(flat).join("") : Array.isArray(n?.tag) ? (n.tag[0]?.expr ? flat(n.tag[0].expr) : flat(n.tag[1])) : "";
const suggestion = { append: [sep("Try this:"), sep(""), sep("\n  "), sep(""), apply, sep(" "), sep(""), sep("exact "), { tag: [{ expr: text("Eq.refl (37 * x + q)") }, text("")] }] };
const shown = stripWidgetEmbeds(suggestion) as any;
assert.equal(flat(shown), "Try this:\n  exact Eq.refl (37 * x + q)");
assert.ok(!JSON.stringify(shown).includes("widget") && !JSON.stringify(shown).includes("[apply]"));
assert.deepEqual(stripWidgetEmbeds(apply), text(""), "a bare insertion link renders nothing");

// a widget without alt falls back to the tag's inner text
assert.deepEqual(stripWidgetEmbeds({ tag: [{ widget: { wi: {} } }, text("inner")] }), text("inner"));

// widgets inside a non-widget tag's inner text and inside eager trace children
const inTag = { tag: [{ expr: { text: "x" } }, { append: [widget(text("a")), text("b")] }] };
assert.deepEqual(stripWidgetEmbeds(inTag), { tag: [{ expr: { text: "x" } }, { append: [text("a"), text("b")] }] });
const trace = { tag: [{ trace: { indent: 0, cls: "Meta", collapsed: false, msg: widget(text("m")), children: { strict: [widget(text("c")), text("d")] } } }, text("")] };
const t = stripWidgetEmbeds(trace) as any;
assert.deepEqual(t.tag[0].trace.msg, text("m"));
assert.deepEqual(t.tag[0].trace.children.strict, [text("c"), text("d")]);
const lazy = { tag: [{ trace: { indent: 0, cls: "Meta", collapsed: true, msg: text("m"), children: { lazy: { p: "1" } } } }, text("")] };
assert.equal(stripWidgetEmbeds(lazy), lazy);

// junk in, junk out — never throws
for (const junk of [null, undefined, 3, "s", {}, { tag: [1] }, { append: "x" }]) assert.equal(stripWidgetEmbeds(junk as any), junk);

console.log("msg-embed: ALL TESTS PASS");
