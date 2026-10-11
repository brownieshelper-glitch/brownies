// The remake, the part that is not secret: what a page is made of (its words, sections, buttons, images, colours
// and fonts, read out of its HTML and CSS), the design rules every proposal and build must keep, the prompts of
// the design-off (each model proposes, every model scores every proposal, the best one is built), the checks a
// built page must pass before it is shown. Biscotti (a hidden brownie) runs the models and keeps the files.
import { escapeHtml } from "./review.mjs";

/// The owner's rules for a site that does not look made by a machine, in the words the models get.
export const DESIGN_RULES = `A site that a stranger could glance at and call machine-made has failed. Never: purple, violet or indigo as the main colour; gradients, and gradient-filled headline words; rows of big meaningless numbers; emoji in headings; "Why choose us", "Transform your X", "Start it. Build it. Launch it." cadences; glass panels and blur; a clutter of small pill badges under the hero; everything centred in one column; the system font or raw Inter as the whole type system; a soft drop shadow on every card. Always: the current brand kept (its colours as given, its fonts, its mark, its mascots when it has them); a display face for the big words and a legible face for reading, with an explicit scale; four to six named colours, one accent, text that reads on its background; a hero that states the thesis in one sentence; motion only where it tells something; a layout that works at 375 and at 1440 with no sideways scroll and tap targets of 44 pixels; short sentences, one idea each, plain keyboard characters only in the copy (no em dashes, no curly quotes, no arrows, no ticks); the facts and numbers of the current page kept exactly, nothing invented, no "coming soon" or "not live yet" lines.`;

const strip = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
const cut = (s, n) => (String(s).length > n ? String(s).slice(0, n - 3).trimEnd() + "..." : String(s));

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
    const text = cut(strip(inner.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")), 700);
    if (text.length > 30) sections.push({ tag: m[1].toLowerCase(), heading, text });
  }
  if (!sections.length) sections.push({ tag: "body", heading: h1, text: cut(strip(h.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")), 3000) });
  const buttons = [...h.matchAll(/<(a|button)\b([^>]*\bclass=["'][^"']*\bbtn\b[^"']*["'][^>]*)>([\s\S]*?)<\/\1>/gi)].map((x) => ({ text: cut(strip(x[3]), 40), href: (/\bhref=["']([^"']*)["']/i.exec(x[2]) || [])[1] || null })).filter((b) => b.text).slice(0, 12);
  const images = [...new Set([...h.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((x) => abs(x[1])))].slice(0, 20);
  const icon = attr("link[^>]*rel=[\"'](?:icon|shortcut icon)[\"']", "href");
  const ogImage = (/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i.exec(h) || [])[1] || null;
  const fonts = [...new Set([...h.matchAll(/fonts\.googleapis\.com\/css2?\?([^"']+)/gi)].flatMap((x) => [...x[1].matchAll(/family=([^&:|]+)/gi)].map((f) => decodeURIComponent(f[1]).replace(/\+/g, " ").trim())))];
  const mascots = /data-mascot=/.test(h) && /mascot\.js/.test(h);
  const lists = [...h.matchAll(/<(?:ul|ol)[^>]*class=["'][^"']*ticker[^"']*["'][^>]*>[\s\S]*?<\/(?:ul|ol)>/gi)].length;
  const tickers = [...h.matchAll(/<div class=["']ticker-track["']>([\s\S]*?)<\/div>/gi)].flatMap((x) => [...x[1].matchAll(/<span>([\s\S]*?)<\/span>/gi)].map((s) => strip(s[1]))).slice(0, 12);
  return { origin, title, description, h1, nav, sections, buttons, images, icon: icon ? abs(icon) : null, ogImage: ogImage ? abs(ogImage) : null, fonts, mascots, tickers, lists };
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

export const BRIEF_SYSTEM = `You are one designer on a panel of several AI models from different labs. A site owner paid for a new version of their home page: the same brand, the same facts, the problems of a review fixed, and a better look. You get what the page is made of today, its colours and fonts, and the review's findings. Propose ONE direction for the new home page, as JSON only:
{"name": "three to five words", "idea": "two sentences: the one thing this version does better and how a visitor feels it", "hero": "the first screen: the headline (keep the thesis, you may reword it), the one line under it, the one or two buttons, what is beside the words", "sections": ["each section in order, one line each: what it says and how it looks"], "type": "the display face and the reading face, from the fonts the site already loads, and the scale", "colour": "which of the given colours does what; the one accent", "motion": "the one or two motions that tell something, or none", "fixes": ["which findings of the review this version fixes, by their titles, and how"], "keeps": ["what stays exactly as it is: facts, numbers, names, the mark, the mascots"], "risk": "the one thing that could make this version worse than today"}
Rules: ${DESIGN_RULES} Plain ASCII; no markdown.`;

export const SCORE_SYSTEM = `You judge home page proposals for a site owner, on a panel of several AI models. You get the page as it is today, the review's findings, the design rules, and the proposals, each named. Score every proposal, as JSON only:
{"scores": [{"name": "the proposal's name as given", "score": 0 to 10, "why": "one plain sentence"}], "best": "the name of the one to build", "warning": "one sentence on what the best one must not get wrong when built, or empty"}
Rules: a proposal that breaks a design rule, invents a fact, drops the brand or would not work on a phone scores low whatever its charm; a proposal that fixes more of the review's findings scores higher; judge the visitor's first screen most; plain ASCII; no markdown.`;

export const BUILD_SYSTEM = `You build the new home page a site owner paid for, from the proposal the panel chose. You get what the page is made of today (its words, sections, buttons, images, colours, fonts), the proposal, the judges' warning, the review's findings to fix, and the design rules. Answer with the COMPLETE page as ONE HTML document and nothing else: no markdown fences, no words before or after.
The page: a full HTML5 document with the same title and meta description as today, the viewport, the canonical link, the icon and the open graph image as given; ALL its CSS in one style element in the head (custom properties for the colours, the fonts loaded from Google Fonts with the same link the site uses, a mobile-first layout with one media query at 760px and one at 1100px); the words of today kept (the facts, the numbers, the names, the buttons and where they go) and rewritten only where the proposal says, in short sentences with plain keyboard characters; the images and the mark by their absolute URLs as given; when the site draws mascots with mascot.js, load it from the site's origin and keep elements with data-mascot="lineup" (and data-mascot="fudge", "crumb", "nib", "chip" for one each) then call Mascot.fill() in a script at the end, exactly as today; no other script, no framework, no tracking, no external CSS but the fonts; every link relative to the site as given (href="app.html"), the nav and the footer links kept; alt text on every image; a skip link; one h1; headings in order; colour contrast that reads; tap targets of 44 pixels; nothing centred-everything; no gradients, no blur, no emoji in headings, no soft shadow on every card. Mark the version with a comment on the first line after the doctype: <!-- a new version by the brownies, from the proposal "NAME" -->.`;

/// The judges' scores summed, best first: [{ name, total, votes, lines }].
export function pickWinner(briefs, scoreAnswers) {
  const totals = new Map(briefs.map((b) => [b.name, { name: b.name, total: 0, votes: 0, best: 0, lines: [] }]));
  for (const a of scoreAnswers) {
    for (const s of a?.scores || []) { const t = totals.get(s.name); if (!t) continue; const n = Number(s.score); if (Number.isFinite(n)) { t.total += Math.max(0, Math.min(10, n)); t.votes++; } if (s.why) t.lines.push(String(s.why).slice(0, 200)); }
    const b = totals.get(a?.best); if (b) b.best++;
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

/// What is wrong with a built page: [] when it may be shown.
export function checkBuilt(html, brief = {}) {
  const out = [];
  const h = String(html || "");
  if (!/^<!doctype html>/i.test(h.trim())) out.push("it does not start with <!doctype html>");
  if (!/<title[^>]*>[^<]+<\/title>/i.test(h)) out.push("no title");
  if (!/<meta[^>]+name=["']viewport["']/i.test(h)) out.push("no viewport meta");
  if ((h.match(/<h1[\s>]/gi) || []).length !== 1) out.push("not exactly one h1");
  if (!/<style[\s>]/i.test(h)) out.push("no style element");
  if (/<link[^>]+rel=["']stylesheet["'][^>]+href=["'](?!https:\/\/fonts\.googleapis\.com)/i.test(h)) out.push("an external stylesheet other than the fonts");
  for (const m of h.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) if (!/mascot\.js$/.test(m[1])) out.push(`a script from ${m[1]}`);
  if (/<img(?![^>]*\balt=)[^>]*>/i.test(h)) out.push("an image without alt");
  if (/[^\x09\x0A\x0D\x20-\x7E]/.test(h)) out.push("characters that are not plain ASCII");
  if (/(linear|radial|conic)-gradient\(/i.test(h)) out.push("a gradient");
  if (/backdrop-filter/i.test(h)) out.push("a blur panel");
  if (/<h[1-6][^>]*>[^<]*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(h)) out.push("an emoji in a heading");
  if (h.length < 4000) out.push("too short to be a whole page");
  if (brief.h1 && !h.toLowerCase().includes(brief.h1.toLowerCase().split(" ").slice(0, 2).join(" "))) out.push("the thesis of the headline is gone");
  return out;
}

/// The page that explains the version: the winner, the scores, what it fixes, what it keeps.
export function briefText({ winner, ranking, briefs, warning, findings = [] }) {
  const b = briefs.find((x) => x.name === winner.name) || {};
  const lines = [`# A new version of the home page: "${winner.name}"`, "", b.idea || "", "", "## The panel's choice", "", ...ranking.map((r, i) => `${i + 1}. ${r.name}: ${r.total} points over ${r.votes} judges${r.best ? `, named best by ${r.best}` : ""}`), ""];
  if (warning) lines.push("## What the judges warned about", "", warning, "");
  lines.push("## The first screen", "", b.hero || "", "", "## The sections", "", ...(b.sections || []).map((s) => `- ${s}`), "", "## Type and colour", "", `${b.type || ""} ${b.colour || ""}`.trim(), "", "## What it fixes from the review", "", ...((b.fixes || []).length ? b.fixes.map((f) => `- ${f}`) : ["- nothing named"]), "", "## What stays as it is", "", ...((b.keeps || []).map((k) => `- ${k}`)), "", "## The risk the designer named", "", b.risk || "", "");
  if (findings.length) lines.push("## The review's findings this version was built against", "", ...findings.map((f) => `- ${f.id ? f.id + ". " : ""}${f.title} (${f.severity})`), "");
  lines.push("## Next steps", "", "Open the new version beside the current one. Keep the one you prefer. The brownies can wire the live parts (the numbers, the posts, the app) into the new version on a quote, through the shop.");
  return lines.join("\n");
}

export const previewNote = (url) => `<!-- a preview: the current site stays as it is until the owner chooses; ${escapeHtml(url)} -->`;
