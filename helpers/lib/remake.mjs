// The remake, the part that is not secret: what a page is made of (its words, sections, buttons, images, scripts,
// colours and fonts, read out of its HTML and CSS), the design rules and the craft every direction and build must
// keep, the prompts of the studio (models propose directions, every model scores them, several builders build the
// best three, the panel judges screenshots against the page as it is today, the three best are critiqued, revised
// and judged again, the winner is polished twice), the checks a built page must pass, the preview copy, the brief
// and the gallery the buyer gets. Biscotti (a hidden brownie) runs the models, the box and the files.
import { escapeHtml } from "./review.mjs";

/// The owner's rules for a site that does not look made by a machine, in the words the models get.
export const DESIGN_RULES = `A site that a stranger could glance at and call machine-made has failed. Never: purple, violet or indigo as the main colour; gradients, and gradient-filled headline words; rows of big meaningless numbers; emoji in headings; "Why choose us", "Transform your X", "Start it. Build it. Launch it." cadences; glass panels and blur; a clutter of small pill badges under the hero; everything centred in one column; the system font or raw Inter as the whole type system; a soft drop shadow on every card. Always: the current brand kept (its colours as given, its fonts, its mark, its mascots when it has them); a display face for the big words and a legible face for reading, with an explicit scale; four to six named colours, one accent, text that reads on its background; a hero that states the thesis in one sentence; motion only where it tells something; a layout that works at 375 and at 1440 with no sideways scroll and tap targets of 44 pixels; short sentences, one idea each, plain keyboard characters only in the copy (no em dashes, no curly quotes, no arrows, no ticks); the facts and numbers of the current page kept exactly, nothing invented, no "coming soon" or "not live yet" lines.`;

/// What a studio does and a template does not: the craft the directions, the builders and the judges are held to.
export const CRAFT = `What a studio would do, and a template would not. The page as it is today is the bar: the new one must be clearly better at a glance, never a tidier, flatter copy; what gives today's page its character (its characters and their size, its shapes, its borders, its signature details) is kept or pushed further, never sanded off. ONE signature move, executed fully, that a visitor remembers: a scene drawn with the brand's own characters at a size that fills the space, a poster-sized headline on a tight measure, a ledger of ruled lines and monospaced figures, a counter or a shelf the content sits on, a full-bleed block of the dark colour that turns the page in two. Three levels of hierarchy, never five. A type scale with real jumps: display 64 to 96 px at 1440 with line-height 1.0 to 1.1 and letter-spacing -0.02em, section titles 36 to 48, body 17 to 19 at line-height 1.55, small text 13 to 14; on a phone the display at 40 to 48. A 12-column grid on a 1200 px measure with asymmetric splits (7/5, 8/4), never three equal cards with icons. Space that breathes: 96 to 160 px between sections on desktop, 64 to 96 on a phone, and one dense moment for contrast. Section treatments that alternate (the light colour, ruled, full-bleed dark, a drawn illustration, a wide table) so the scroll has a rhythm. Illustration drawn as inline SVG in the brand's colours wherever a picture helps (a counter, a kitchen, the flow of a tax, a shelf, a route), large and deliberate, with the same line weight and corner radius as the brand's own drawings; never a stock photo, never an icon set, never emoji. Numbers in the mono face with tabular figures. Interactions that answer: links with an underline that moves, buttons that press (transform: scale(0.97) on :active over 150ms), focus-visible rings in the accent, a phone menu that works without JavaScript (details and summary), prefers-reduced-motion respected. Copy in short sentences, each with a verb, the thesis as the headline. What always reads as a template and loses: a hero split 50/50 with small pictures on the right, three or four equal cards in a row with icons, a feature list with ticks, everything centred, a pricing-table look, thin progress bars standing in for a chart, a gradient, a glass panel, a wall of equal paragraphs, big empty bands of background with nothing designed in them.`;

const strip = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
const cut = (s, n) => (String(s).length > n ? String(s).slice(0, n - 3).trimEnd() + "..." : String(s));
const noCode = (h) => String(h || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");

/// What the page is made of, read out of its HTML: the words and the parts, not the markup.
export function siteBrief(html, url = "") {
  const h = String(html || "");
  const origin = (() => { try { return new URL(url).origin; } catch { return ""; } })();
  const abs = (u) => { try { return new URL(u, url || "https://example.com/").href; } catch { return u; } };
  const attr = (tag, name) => { const m = new RegExp(`<${tag}[^>]*\\b${name}=["']([^"']*)["']`, "i").exec(h); return m ? m[1] : null; };
  const title = strip((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(h) || [])[1] || "");
  const description = (/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(h) || /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i.exec(h) || [])[1] || "";
  const nav = [...h.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ text: cut(strip(m[2]), 40), href: m[1] })).filter((l) => l.text && !/^(mailto|tel|javascript):/i.test(l.href)).slice(0, 40);
  const h1 = strip((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(h) || [])[1] || "");
  const sections = [];
  const body = h.replace(/<\/?main\b[^>]*>/gi, ""); // main is a wrapper, not a part
  const re = /<(section|article|footer)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(body)) && sections.length < 14) {
    const inner = m[2];
    const heading = strip((/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(inner) || [])[1] || "");
    const text = cut(strip(noCode(inner)), 700);
    if (text.length > 30) sections.push({ tag: m[1].toLowerCase(), heading, text });
  }
  const bodyText = strip(noCode((/<body[^>]*>([\s\S]*)<\/body>/i.exec(h) || [null, h])[1]));
  if (!sections.length) sections.push({ tag: "body", heading: h1, text: cut(bodyText, 3000) });
  const buttons = [...h.matchAll(/<(a|button)\b([^>]*\bclass=["'][^"']*\bbtn\b[^"']*["'][^>]*)>([\s\S]*?)<\/\1>/gi)].map((x) => ({ text: cut(strip(x[3]), 40), href: (/\bhref=["']([^"']*)["']/i.exec(x[2]) || [])[1] || null })).filter((b) => b.text).slice(0, 12);
  const images = [...new Set([...h.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((x) => abs(x[1])))].slice(0, 20);
  const scripts = [...new Set([...h.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((x) => abs(x[1])))].slice(0, 20);
  const icon = attr("link[^>]*rel=[\"'](?:icon|shortcut icon)[\"']", "href");
  const ogImage = (/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i.exec(h) || [])[1] || null;
  const fonts = [...new Set([...h.matchAll(/fonts\.googleapis\.com\/css2?\?([^"']+)/gi)].flatMap((x) => [...x[1].matchAll(/family=([^&:|]+)/gi)].map((f) => decodeURIComponent(f[1]).replace(/\+/g, " ").trim())))];
  const fontLink = (/<link[^>]+href=["'](https:\/\/fonts\.googleapis\.com\/css2?\?[^"']+)["'][^>]*>/i.exec(h) || [])[1] || null;
  const mascots = /data-mascot=/.test(h) && /mascot\.js/.test(h);
  const lists = [...h.matchAll(/<(?:ul|ol)[^>]*class=["'][^"']*ticker[^"']*["'][^>]*>[\s\S]*?<\/(?:ul|ol)>/gi)].length;
  const tickers = [...h.matchAll(/<div class=["']ticker-track["']>([\s\S]*?)<\/div>/gi)].flatMap((x) => [...x[1].matchAll(/<span>([\s\S]*?)<\/span>/gi)].map((s) => strip(s[1]))).slice(0, 12);
  return { origin, title, description, h1, nav, sections, buttons, images, scripts, icon: icon ? abs(icon) : null, ogImage: ogImage ? abs(ogImage) : null, fonts, fontLink: fontLink ? fontLink.replace(/&amp;/g, "&") : null, mascots, tickers, lists, textChars: bodyText.length };
}

/// The colours and fonts of the current look, from the :root custom properties of its stylesheet.
export function cssTokens(css) {
  const root = (/:root\s*\{([\s\S]*?)\}/.exec(String(css || "")) || [])[1] || "";
  const vars = {};
  for (const m of root.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].replace(/\/\*[\s\S]*?\*\//g, "").trim();
  const colours = Object.fromEntries(Object.entries(vars).filter(([, v]) => /^#[0-9a-f]{3,8}$/i.test(v)));
  const fonts = Object.fromEntries(Object.entries(vars).filter(([k, v]) => /font|display|mono/i.test(k) && /["']|serif|sans/i.test(v)));
  return { colours, fonts, vars };
}

export const LETTERS = "ABCDEFGHIJ";
export const MIN_WORDS = 200; // characters of text a home page must carry in its HTML for a remake to have something to work with

export const BRIEF_SYSTEM = `You are one designer on a panel of several AI models from different labs. A site owner paid for a new version of their home page: the same brand, the same facts, the problems of a review fixed, and a look a studio would sign. You get what the page is made of today, its colours and fonts, the review's findings, and, when you can see images, screenshots of the page today. Propose ONE direction for the new home page, as JSON only:
{"name": "three to five words", "reference": "a real site, studio or school of design this draws on, named, and the one thing taken from it", "signature": "the one move a visitor remembers, in two sentences, concrete enough that two builders would build it the same way", "idea": "two sentences: what this version does better than the page today and how a visitor feels it", "firstScreen": "what is where at 1440 (the headline, its size, the line under it, the buttons, what sits beside or behind the words and how big) and then at 375, in plain sentences", "sections": ["each section in order, one line each: what it says and how it is treated (light, ruled, full-bleed dark, drawn, a table)"], "illustration": "what is drawn as inline SVG in the brand colours, where, and how big; or none", "type": "the display face and the reading face from the fonts the site loads, and the scale in px for 1440 and 375", "colour": "which of the given colours does what; the one accent", "motion": "the one or two motions that tell something, or none", "fixes": ["which findings of the review this version fixes, by their titles, and how"], "keeps": ["what stays exactly as it is: facts, numbers, names, the mark, the mascots, the details that give today's page its character"], "risk": "the one thing that could make this version worse than today"}
Rules: ${DESIGN_RULES}
Craft: ${CRAFT}
Plain ASCII; no markdown.`;

export const SCORE_SYSTEM = `You judge home page directions for a site owner, on a panel of several AI models. You get the page as it is today, the review's findings, the design rules and the craft, and the directions, each named. The three best become briefs for several builders at once, so a direction must be specific enough to build the same way twice. Score every direction, as JSON only:
{"scores": [{"name": "the direction's name as given", "score": 0 to 10, "why": "one plain sentence"}], "best": "the name of the one to build first", "warning": "one sentence on what the best one must not get wrong when built, or empty"}
How to score: a direction that breaks a design rule, invents a fact, drops the brand or would not work on a phone scores low whatever its charm; a safe template layout (a hero split in two with cards under it) is a 4 or a 5; a direction with a real signature move and a specific first screen scores higher; one that fixes more of the review's findings scores higher; most honest scores are 4 to 7 and 9 is reference work. Plain ASCII; no markdown.
Rules: ${DESIGN_RULES}
Craft: ${CRAFT}`;

export const BUILD_SYSTEM = `You build a home page a site owner paid for, from a direction the panel chose. Several builders build at once; every page is rendered at 1440 and at 375 and judged from screenshots next to the others and next to the page as it is today, and only one is kept. A flat page loses, and so does one that is not clearly better than today's. You get what the page is made of today (its words, sections, buttons, images, scripts, colours, fonts), its HTML and the start of its CSS (for the brand's own shapes and components), the direction, the judges' warning, the review's findings to fix, the rules and the craft, and, when you can see images, screenshots of the page today. Answer with the COMPLETE page as ONE HTML document and nothing else: no markdown fences, no words before or after.
The page: a full HTML5 document with the same title and meta description as today, the viewport, the canonical link, the icon and the open graph image as given; ALL its CSS in one style element in the head (custom properties for the colours, the fonts loaded with the same Google Fonts link the site uses, a mobile-first layout with one media query at 760px and one at 1100px, every state: hover, :active with scale(0.97), :focus-visible, prefers-reduced-motion); the words of today kept (the facts, the numbers, the names, the buttons and where they go) and rewritten only where the direction says, in short sentences with plain keyboard characters; the images and the mark by their addresses as given, and everything else drawn as inline SVG in the brand's colours. Scripts: keep the site's own script tags that the page still needs, with the same src as today, at the end of the body, and keep the id and data- attributes of the elements they fill (live numbers, lists, mascots), so the page keeps working; drop a script only when you drop the part it drives; add no new script file; a few lines of inline script are allowed only to call what those scripts expose. When the site draws mascots with mascot.js, keep elements with data-mascot="lineup" (and data-mascot with one name each, as today's HTML has them), size them with CSS on the element, and call Mascot.fill() once the document is ready, as today's page does. No framework, no tracking, no external CSS but the fonts; every link as given (href="app.html"), the nav and the footer links kept; a phone menu with details and summary; alt text on every image; a skip link; one h1; headings in order; colour contrast that reads; tap targets of 44 pixels; no sideways scroll at 375. You have room: use it for real CSS, drawn SVG, and every state; a finished page is 35 to 70 KB. Mark the version with a comment on the first line after the doctype: <!-- a new version by the brownies, from the proposal "NAME" -->.
Rules: ${DESIGN_RULES}
Craft: ${CRAFT}`;

export const VISUAL_SYSTEM = `You judge home pages from screenshots, as one of several AI models on a panel. Each page is shown as the first screen and the whole page scaled down, at 1440 (desktop) and at 375 (phone), under a name that is a letter or a number. When THE PAGE TODAY is shown, it is the bar: score it too, under the name TODAY, on the same scale; a page that is not clearly better than it at a glance scores below it. Score every page, as JSON only:
{"scores": [{"name": "the name exactly as given, for example A or 3 or TODAY", "score": 0 to 10, "why": "one plain sentence naming what you saw"}], "best": "the name of the one to keep, never TODAY"}
How to score: the first screen counts most (would a stranger stop, and could they say in two seconds what this is); then craft (type scale, spacing rhythm, a signature move executed, drawn illustration that belongs, details); then brand (the given colours, fonts, mark and characters, nothing foreign, the character of today's page kept or pushed further); then the phone (readable, no overflow, a menu that works); then the rules. A page that looks like a template (a hero split in two with small pictures, equal cards in a row, thin bars, centred everything, a wall of equal paragraphs, empty bands) is a 4 or a 5 however tidy. A page with sideways overflow, unreadable text, empty broken regions or missing characters scores 3 or less. Most honest scores are 4 to 7; a 9 is work you would show as a reference. Plain ASCII; no markdown.
Rules: ${DESIGN_RULES}
Craft: ${CRAFT}`;

export const CRITIQUE_SYSTEM = `You are an art director reviewing a home page before it ships, from its screenshots (the desktop page at full size in parts, then scaled down whole, then the phone) and the direction it was built from. You may also see the first screen of the page as it is today: the bar to beat. Name the eight most valuable changes, as JSON only:
{"fixes": [{"where": "the section or element", "what": "what is wrong, as you see it", "how": "what to do instead, with numbers: px, the colour's name from the palette, the type size, the spacing"}]}
Say nothing vague ("improve the hierarchy", "make it pop"). Start with whatever makes the page look flat, generic or less alive than today's, and with anything broken (overflow, a cramped or empty region, a picture too small for its space, misaligned columns). Prefer changes a builder can apply in CSS and markup in one pass. Do not ask for anything the rules forbid, for new facts, or for assets the page does not have (draw with inline SVG instead). Order by value. Plain ASCII; no markdown.
Rules: ${DESIGN_RULES}
Craft: ${CRAFT}`;

export const REVISE_SYSTEM = `You revise a complete home page from an art director's list, keeping its direction, its facts and the rules. You get the page's HTML, the list, and, when you can see images, screenshots of the page as it renders now. Apply every item you can; where an item conflicts with the rules or the facts, skip it. Keep everything that already works: the scripts and the ids they fill, the links, the words. Answer with the COMPLETE revised page as ONE HTML document and nothing else: no fences, no words before or after. Keep the first-line comment.
Rules: ${DESIGN_RULES}
Craft: ${CRAFT}`;

export const VOTE_SYSTEM = `You compare two versions of the same home page, BEFORE and AFTER a revision, from screenshots (the desktop page at full size in parts, then scaled down whole, then the phone), with the list of changes that was asked for. Answer as JSON only: {"better": "before" or "after", "why": "one plain sentence"}. Choose "after" only when it is clearly the better page as a whole; a revision that broke something (overflow, an empty region, a missing character, worse type) loses even if it did what was asked. Plain ASCII; no markdown.`;

/// The judges' scores summed, best first: [{ name, total, votes, best, lines }]. Works for directions (by name) and
/// for pages (by letter or number).
export function pickWinner(entries, scoreAnswers) {
  const totals = new Map(entries.map((b) => [String(b.name), { name: String(b.name), total: 0, votes: 0, best: 0, lines: [] }]));
  for (const a of scoreAnswers) {
    for (const s of a?.scores || []) { const t = totals.get(String(s.name).trim()); if (!t) continue; const n = Number(s.score); if (Number.isFinite(n)) { t.total += Math.max(0, Math.min(10, n)); t.votes++; } if (s.why) t.lines.push(String(s.why).slice(0, 200)); }
    const b = totals.get(String(a?.best ?? "").trim()); if (b) b.best++;
  }
  return [...totals.values()].sort((x, y) => y.total - x.total || y.best - x.best);
}

/// The built page, cleaned: fences gone, a doctype first, plain ASCII, the version comment kept.
export function cleanHtml(text) {
  let s = String(text || "").replace(/^\s*```(?:html)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const at = s.search(/<!doctype html>/i);
  if (at > 0) s = s.slice(at);
  s = s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s*[–—]\s*/g, ", ").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, "...").replace(/ /g, " ").replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
  return s;
}

/// What is wrong with a built page: [] when it may be shown. brief (siteBrief of today's page) names the scripts a
/// page may keep and the headline whose thesis must survive.
export function checkBuilt(html, brief = {}) {
  const out = [];
  const h = String(html || "");
  const base = brief.origin ? brief.origin + "/" : "https://example.com/";
  const allowed = new Set(brief.scripts || []);
  if (!/^<!doctype html>/i.test(h.trim())) out.push("it does not start with <!doctype html>");
  if (!/<title[^>]*>[^<]+<\/title>/i.test(h)) out.push("no title");
  if (!/<meta[^>]+name=["']viewport["']/i.test(h)) out.push("no viewport meta");
  if ((h.match(/<h1[\s>]/gi) || []).length !== 1) out.push("not exactly one h1");
  if (!/<style[\s>]/i.test(h)) out.push("no style element");
  if (/<link[^>]+rel=["']stylesheet["'][^>]+href=["'](?!https:\/\/fonts\.googleapis\.com)/i.test(h)) out.push("an external stylesheet other than the fonts");
  for (const m of h.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) { let a = m[1]; try { a = new URL(m[1], base).href; } catch { /* as written */ } if (!allowed.has(a) && !/mascot\.js$/.test(m[1])) out.push(`a script the page does not have today: ${m[1]}`); }
  if (/data-mascot=/.test(h) && !/mascot\.js/.test(h)) out.push("mascot elements without mascot.js");
  if (/<img(?![^>]*\balt=)[^>]*>/i.test(h)) out.push("an image without alt");
  if (/[^\x09\x0A\x0D\x20-\x7E]/.test(h)) out.push("characters that are not plain ASCII");
  if (/(linear|radial|conic)-gradient\(/i.test(h)) out.push("a gradient");
  if (/backdrop-filter/i.test(h)) out.push("a blur panel");
  if (/<h[1-6][^>]*>[^<]*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(h)) out.push("an emoji in a heading");
  if (h.length < 4000) out.push("too short to be a whole page");
  if (!/<\/html>\s*$/i.test(h)) out.push("it does not end with </html>");
  if (brief.h1 && !h.toLowerCase().includes(brief.h1.toLowerCase().split(" ").slice(0, 2).join(" "))) out.push("the thesis of the headline is gone");
  return out;
}

/// The copy that is looked at from our address: every relative link, image and script written with the site's full
/// address, so the page works away from home; links inside the page (#team) stay inside it.
export function previewCopy(html, origin) {
  if (!origin) return String(html || "");
  const base = origin.replace(/\/+$/, "") + "/";
  const fix = (u) => { const v = String(u).trim(); if (!v || /^(#|data:|mailto:|tel:|javascript:|blob:|about:)/i.test(v) || /^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith("//")) return u; try { return new URL(v, base).href; } catch { return u; } };
  let out = String(html || "").replace(/(\s(?:href|src|action|poster)=)(["'])([^"']*)\2/gi, (m, a, q, v) => `${a}${q}${fix(v)}${q}`);
  out = out.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, v) => (/^(#|data:)/i.test(v.trim()) ? m : `url(${q}${fix(v)}${q})`));
  return out;
}

const scoreLine = (r) => `${r.total} points over ${r.votes} judge${r.votes === 1 ? "" : "s"}${r.best ? `, named best by ${r.best}` : ""}`;

/// The text of the brief: whether the new page beat today's, the panel's directions, the build-off, the finals, the
/// polish, what the chosen direction said, the findings, and the links when the caller has them.
export function briefText({ winner, directions, briefs, candidates, finals = [], today = null, polish = [], warning, findings = [], links = null }) {
  const d = briefs.find((x) => x.name === winner.direction) || {};
  const lines = [`# A new version of the home page: "${winner.direction}"`, "", d.idea || "", ""];
  const bar = today?.final?.votes ? today.final : today?.first?.votes ? today.first : null;
  if (bar && winner.total != null && winner.votes) {
    const mine = winner.total / winner.votes, theirs = bar.total / bar.votes;
    lines.push("## Read this first", "", mine > theirs
      ? `The judges scored the page as it is today at ${theirs.toFixed(1)} out of 10 and the new version at ${mine.toFixed(1)}, from screenshots, on the same scale.`
      : `The judges scored the page as it is today at ${theirs.toFixed(1)} out of 10 and the best new version at ${mine.toFixed(1)}, from screenshots, on the same scale. The new version did not beat the current page in their eyes. It is delivered as built, with the alternatives; keeping the current page is a fair choice.`, "");
  }
  if (d.signature) lines.push("## The signature move", "", d.signature, "");
  if (d.reference) lines.push("## The reference", "", d.reference, "");
  lines.push("## The panel's directions", "", ...directions.map((r, i) => `${i + 1}. ${r.name}: ${scoreLine(r)}`), "");
  lines.push("## The build-off, judged from screenshots", "", ...candidates.map((c, i) => `${i + 1}. ${c.letter}. "${c.direction}" built by ${c.model}: ${c.failed ? c.failed : scoreLine(c)}`), "");
  if (today?.first?.votes) lines.push(`The page today, on the same scale: ${scoreLine({ ...today.first, best: 0 })}.`, "");
  if (finals.length) {
    lines.push("## The finals", "", "The three best pages were critiqued by art directors and revised by their builders. Each was then judged again beside its revision.", "", ...finals.map((f, i) => `${i + 1}. ${f.label}: ${scoreLine(f)}`), "");
    if (today?.final?.votes) lines.push(`The page today, on the same scale: ${scoreLine({ ...today.final, best: 0 })}.`, "");
  }
  if (polish.length) {
    lines.push("## The polish", "");
    for (const p of polish) lines.push(`Round ${p.round}: ${p.kept === "after" ? "the revised page was kept" : p.kept === "before" ? "the earlier page was kept" : "no revision came back"}${p.why ? ` (${p.why})` : ""}.`, "", ...p.fixes.map((f) => `- ${f}`), "");
  }
  if (warning) lines.push("## What the judges warned about", "", warning, "");
  lines.push("## The first screen", "", d.firstScreen || d.hero || "", "", "## The sections", "", ...(d.sections || []).map((s) => `- ${s}`), "", "## Type and colour", "", `${d.type || ""} ${d.colour || ""}`.trim(), "", "## What it fixes from the review", "", ...((d.fixes || []).length ? d.fixes.map((f) => `- ${f}`) : ["- nothing named"]), "", "## What stays as it is", "", ...((d.keeps || []).map((k) => `- ${k}`)), "", "## The risk the designer named", "", d.risk || "", "");
  if (findings.length) lines.push("## The review's findings this version was built against", "", ...findings.map((f) => `- ${f.id ? f.id + ". " : ""}${f.title} (${f.severity})`), "");
  if (links) {
    lines.push("## The files", "", `- The new version, to look at: ${links.page}`);
    if (links.clean) lines.push(`- The same page with its links as your site writes them, to install: ${links.clean}`);
    if (links.brief) lines.push(`- This brief with the gallery and the scores: ${links.brief}`);
    for (const a of links.alternatives || []) lines.push(`- Alternative ${a.label}, "${a.direction}" by ${a.model}: ${a.url}`);
    lines.push("");
  }
  lines.push("## Next steps", "", "Open the new version beside the current one, and the alternatives. Keep the one you prefer. The brownies can wire it into your site on a quote, through the shop.");
  return lines.join("\n");
}

/// The gallery of the brief page: the page today, the final page, every candidate ranked with its pictures, the
/// revised finalists, the polish rounds. `src(name)` gives the address of a picture by its short name
/// (today-1440-full, a-375-full, a2-1440-full, round1-1440-full ...); a name it does not know returns "".
export function galleryHtml({ candidates, revised = [], today = false, polish = [], src }) {
  const pic = (name, alt) => { const s = src(name); return s ? `<a href="${escapeHtml(s)}"><img src="${escapeHtml(s)}" alt="${escapeHtml(alt)}" loading="lazy"></a>` : ""; };
  const pair = (prefix, alt) => `<div class="pair">${pic(`${prefix}-1440-full`, `${alt}, desktop`)}${pic(`${prefix}-375-full`, `${alt}, phone`)}</div>`;
  const parts = [`<style>.gallery h3{margin:28px 0 8px;font-size:17px}.gallery .pair{display:grid;grid-template-columns:3fr 1fr;gap:12px;align-items:start}.gallery img{width:100%;height:auto;border:1px solid #D8CAB3;border-radius:6px;background:#fff}.gallery p{margin:6px 0 0;font-size:14px;color:#6B5447}</style>`, `<div class="gallery">`];
  if (today) parts.push(`<h3>The page today</h3>`, pair("today", "The page today"));
  parts.push(`<h3>The final page</h3>`, pair("final", "The final page"));
  for (const c of candidates) parts.push(`<h3>${escapeHtml(c.letter)}. "${escapeHtml(c.direction)}" built by ${escapeHtml(c.model)}${c.failed ? "" : `: ${c.total} points`}</h3>`, c.failed ? `<p>${escapeHtml(c.failed)}</p>` : pair(c.letter.toLowerCase(), `Candidate ${c.letter}`), c.lines?.length ? `<p>${escapeHtml(c.lines.slice(0, 3).join(" "))}</p>` : "");
  for (const r of revised) parts.push(`<h3>${escapeHtml(r.letter)} revised</h3>`, pair(`${r.letter.toLowerCase()}2`, `Candidate ${r.letter}, revised`));
  for (const p of polish) if (p.kept) parts.push(`<h3>Polish round ${p.round}: ${p.kept === "after" ? "the revised page was kept" : "the earlier page was kept"}</h3>`, pair(`round${p.round}`, `Round ${p.round}, the revised page`));
  parts.push(`</div>`);
  return parts.filter(Boolean).join("\n");
}
