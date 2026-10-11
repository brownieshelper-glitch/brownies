// The review tools: the Markdown renderer escapes every piece of text and keeps only http links, the page frame
// escapes its title, the ASCII pass turns dashes and curly quotes into keyboard characters, the labels, the timeout.
import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, reviewPage, asciiOnly, label, withTimeout, escapeHtml } from "../lib/review.mjs";

test("Markdown: headings, paragraphs, lists, bold, code, http links; HTML and odd links are text", () => {
  const md = "# Title\n\nA line with **bold**, `code` and [a link](https://a.test/x?y=1).\nThe same paragraph.\n\n## Two\n- one <b>tag</b>\n- two [bad](javascript:alert(1)) and [ftp](ftp://x)\n  wrapped\n\n1. first\n2) second\n\n### Three\nText & more.";
  const html = renderMarkdown(md);
  assert.equal(html, [
    "<h2>Title</h2>",
    '<p>A line with <b>bold</b>, <code>code</code> and <a href="https://a.test/x?y=1" rel="noopener nofollow" target="_blank">a link</a>. The same paragraph.</p>',
    "<h2>Two</h2>",
    "<ul><li>one &lt;b&gt;tag&lt;/b&gt;</li><li>two [bad](javascript:alert(1)) and [ftp](ftp://x) wrapped</li></ul>",
    "<ol><li>first</li><li>second</li></ol>",
    "<h3>Three</h3>",
    "<p>Text &amp; more.</p>",
  ].join("\n"));
  assert.equal(renderMarkdown(""), ""); assert.equal(renderMarkdown("just text"), "<p>just text</p>");
  assert.equal(escapeHtml('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
});

test("the page escapes its title and subtitle and carries the body as it is; the ASCII pass; the labels; the timeout", async () => {
  const p = reviewPage({ title: "A <review>", subtitle: "one & two", body: "<p>ok</p>", footer: "f" });
  assert.match(p, /<title>A &lt;review&gt;<\/title>/); assert.match(p, /<h1>A &lt;review&gt;<\/h1>/); assert.match(p, /<p class="sub">one &amp; two<\/p>/); assert.match(p, /<p>ok<\/p>\n<div class="foot">f<\/div>/);
  assert.match(p, /<meta name="robots" content="noindex">/);
  assert.equal(asciiOnly("café — “quoted” … • ok x – y"), 'cafe, "quoted" ... - ok x, y');
  assert.equal(asciiOnly("line  \n\tnext ☃"), "line\n\tnext");
  assert.equal(label("anthropic/claude-fable-5.1"), "Claude Fable 5.1"); assert.equal(label("some-lab/new_model-x"), "new model x"); assert.equal(label(""), "");
  assert.equal(await withTimeout(Promise.resolve(3), 1000), 3);
  await assert.rejects(() => withTimeout(new Promise(() => {}), 20, "Kimi K3"), /^Error: Kimi K3 did not answer in 0 minutes$/);
});
