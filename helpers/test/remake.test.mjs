// The remake's plumbing: what a page is made of, read out of its HTML and CSS; the judges' scores summed; a built
// page cleaned and checked; the brief page.
import test from "node:test";
import assert from "node:assert/strict";
import { siteBrief, cssTokens, pickWinner, cleanHtml, checkBuilt, briefText, DESIGN_RULES, BRIEF_SYSTEM, SCORE_SYSTEM, BUILD_SYSTEM } from "../lib/remake.mjs";

const HOME = `<!doctype html><html lang="en"><head><title>Brownies. Four helpers.</title><meta name="description" content="Four AI helpers work for a coin."><link rel="icon" href="assets/favicon.svg"><meta property="og:image" content="https://feedthebrownies.com/assets/og.png"><link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@700&family=Rubik:wght@400&display=swap" rel="stylesheet"><link rel="stylesheet" href="styles.css"><script src="mascot.js"></script></head><body><header><nav><a href="team.html">Kitchen</a><a href="docs.html">Docs</a><a class="btn sm" href="app.html">Open app</a></nav></header><main><section class="hero"><h1>Every trade feeds the brownies<span class="dot">.</span></h1><p class="lead">Four AI helpers work for the BROWNIE coin. A 2% tax on every trade pays for them.</p><a class="btn" href="app.html">Stake BROWNIE</a><a class="btn ghost" href="#team">Meet the brownies</a><div class="lineup" data-mascot="lineup"></div></section><script>Mascot.fill();</script><div class="ticker"><div class="ticker-track"><span>Every trade feeds the brownies</span><span>Four brownies, one kitchen</span></div></div><section id="team"><h2>Each brownie has one job.</h2><p>Fudge writes. Crumb answers. Nib reads. Chip builds. ${"x".repeat(40)}</p><img src="assets/mark.svg" alt="the mark"></section></main><footer><a href="privacy.html">Privacy</a><a href="mailto:a@b.c">Contact</a><p>Made in the kitchen. ${"y".repeat(40)}</p></footer></body></html>`;

test("what a page is made of: the words, the sections, the buttons, the images, the fonts, the mascots; the colours out of the CSS", () => {
  const b = siteBrief(HOME, "https://feedthebrownies.com/");
  assert.equal(b.origin, "https://feedthebrownies.com"); assert.equal(b.title, "Brownies. Four helpers."); assert.equal(b.description, "Four AI helpers work for a coin."); assert.equal(b.h1, "Every trade feeds the brownies.");
  assert.deepEqual(b.nav.slice(0, 3), [{ text: "Kitchen", href: "team.html" }, { text: "Docs", href: "docs.html" }, { text: "Open app", href: "app.html" }]); assert.ok(!b.nav.some((l) => /^mailto/.test(l.href)));
  assert.equal(b.sections.length, 3); assert.equal(b.sections[0].tag, "section"); assert.equal(b.sections[0].heading, "Every trade feeds the brownies."); assert.match(b.sections[0].text, /^Every trade feeds the brownies\. Four AI helpers/); assert.equal(b.sections[1].heading, "Each brownie has one job."); assert.equal(b.sections[2].tag, "footer");
  assert.deepEqual(b.buttons, [{ text: "Open app", href: "app.html" }, { text: "Stake BROWNIE", href: "app.html" }, { text: "Meet the brownies", href: "#team" }]);
  assert.deepEqual(b.images, ["https://feedthebrownies.com/assets/mark.svg"]); assert.equal(b.icon, "https://feedthebrownies.com/assets/favicon.svg"); assert.equal(b.ogImage, "https://feedthebrownies.com/assets/og.png");
  assert.deepEqual(b.fonts, ["Baloo 2", "Rubik"]); assert.equal(b.mascots, true); assert.deepEqual(b.tickers, ["Every trade feeds the brownies", "Four brownies, one kitchen"]);
  const t = cssTokens(`:root { --ink: #2A1710; /* cocoa */ --bone: #F6EFE2; --accent: #FF5A1F; --display: "Baloo 2", sans-serif; --font: Rubik, Arial, sans-serif; --r: 22px; }`);
  assert.deepEqual(t.colours, { ink: "#2A1710", bone: "#F6EFE2", accent: "#FF5A1F" }); assert.deepEqual(Object.keys(t.fonts), ["display", "font"]); assert.equal(t.vars.r, "22px");
  assert.deepEqual(siteBrief("<p>tiny</p>").sections, [{ tag: "body", heading: "", text: "tiny" }], "a page with no sections still has its text");
  assert.match(BRIEF_SYSTEM, /Propose ONE direction/); assert.match(SCORE_SYSTEM, /"best"/); assert.match(BUILD_SYSTEM, /COMPLETE page as ONE HTML document/); assert.match(DESIGN_RULES, /Never: purple/);
});

test("the judges' scores summed; a built page cleaned and checked; the brief page", () => {
  const briefs = [{ name: "Warm shelf" }, { name: "Night kitchen" }, { name: "Plain ledger" }];
  const ranking = pickWinner(briefs, [
    { scores: [{ name: "Warm shelf", score: 8, why: "a" }, { name: "Night kitchen", score: 6 }, { name: "Plain ledger", score: 4 }], best: "Warm shelf" },
    { scores: [{ name: "Warm shelf", score: 7 }, { name: "Night kitchen", score: 9, why: "b" }, { name: "Nobody", score: 10 }], best: "Night kitchen" },
    null,
    { scores: [{ name: "Night kitchen", score: "7" }, { name: "Warm shelf", score: 12 }], best: "Night kitchen" },
  ]);
  assert.deepEqual(ranking.map((r) => [r.name, r.total, r.votes, r.best]), [["Warm shelf", 25, 3, 1], ["Night kitchen", 22, 3, 2], ["Plain ledger", 4, 1, 0]]);
  assert.deepEqual(ranking[0].lines, ["a"]);
  const raw = "```html\n<!doctype html>\n<!-- a new version by the brownies, from the proposal \"Warm shelf\" -->\n<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Brownies — four helpers</title><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><style>body{margin:0}</style></head><body><h1>Every trade feeds the brownies</h1><img src=\"https://x/y.svg\" alt=\"the mark\"><p>café “quoted”</p>" + "<p>filler</p>".repeat(400) + "</body></html>\n```";
  const page = cleanHtml(raw);
  assert.ok(page.startsWith("<!doctype html>")); assert.ok(!page.includes("```")); assert.match(page, /<title>Brownies, four helpers<\/title>/); assert.match(page, /cafe "quoted"/);
  assert.deepEqual(checkBuilt(page, { h1: "Every trade feeds the brownies." }), []);
  const bad = checkBuilt("<html><head></head><body><h1>a</h1><h1>b</h1><img src=\"x\"><script src=\"https://cdn.evil/x.js\"></script><div style=\"background: linear-gradient(red, blue); backdrop-filter: blur(4px)\"></div><h2>Hi \u{1F600}</h2></body></html>", { h1: "Every trade feeds the brownies." });
  assert.deepEqual(bad, ["it does not start with <!doctype html>", "no title", "no viewport meta", "not exactly one h1", "no style element", "a script from https://cdn.evil/x.js", "an image without alt", "characters that are not plain ASCII", "a gradient", "a blur panel", "an emoji in a heading", "too short to be a whole page", "the thesis of the headline is gone"]);
  assert.deepEqual(checkBuilt(page.replace("<style>body{margin:0}</style>", "<style>a{}</style><link rel=\"stylesheet\" href=\"https://fonts.googleapis.com/css2?family=Rubik\"><script src=\"https://feedthebrownies.com/mascot.js\"></script>"), {}), [], "the fonts and the mascots are allowed");
  const text = briefText({ winner: ranking[0], ranking, briefs: [{ name: "Warm shelf", idea: "Warmer.", hero: "The shelf.", sections: ["one", "two"], type: "Baloo 2 and Rubik", colour: "cocoa and icing", fixes: ["No contact: a mail in the footer"], keeps: ["the numbers"], risk: "too cosy" }], warning: "Kimi K3: keep the mascots", findings: [{ id: 1, title: "No contact", severity: "medium" }] });
  assert.match(text, /^# A new version of the home page: "Warm shelf"\n\nWarmer\.\n\n## The panel's choice\n\n1\. Warm shelf: 25 points over 3 judges, named best by 1\n2\. Night kitchen: 22 points over 3 judges, named best by 2\n3\. Plain ledger: 4 points over 1 judges\n\n## What the judges warned about\n\nKimi K3: keep the mascots/);
  assert.match(text, /## What it fixes from the review\n\n- No contact: a mail in the footer\n/); assert.match(text, /## The review's findings this version was built against\n\n- 1\. No contact \(medium\)\n/); assert.match(text, /## Next steps\n\nOpen the new version beside the current one\./);
});
