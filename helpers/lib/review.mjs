// The reviews sold in the shop (lib/shop.mjs): what is not secret about them. The plain names of the models on
// the panel, a Markdown renderer small enough to trust (every piece of text is escaped, links are http only),
// the page a review becomes (one HTML file in the site's look, nothing loaded from elsewhere but the fonts),
// a plain-ASCII pass for the text, and a timeout. Biscotti (a hidden brownie) runs the panel and writes the words.

/// The models as the page names them. Anything else shows its id's tail.
export const MODEL_LABEL = {
  "anthropic/claude-fable-5.1": "Claude Fable 5.1", "anthropic/claude-opus-5.5": "Claude Opus 5.5", "anthropic/claude-sonnet-5.5": "Claude Sonnet 5.5", "anthropic/claude-haiku-5.5": "Claude Haiku 5.5",
  "openai/gpt-6-astra": "GPT-6 Astra", "openai/gpt-6-astra-pro": "GPT-6 Astra Pro", "openai/gpt-6.1-sol": "GPT-6.1 Sol", "openai/gpt-6.1-sol-pro": "GPT-6.1 Sol Pro",
  "moonshotai/kimi-k3": "Kimi K3", "deepseek/deepseek-v4-pro-0813": "DeepSeek V4 Pro", "deepseek/deepseek-v4.1-flash": "DeepSeek V4.1 Flash",
  "google/gemini-3.8-flash": "Gemini 3.8 Flash", "qwen/qwen3.8-max-prime": "Qwen 3.8 Max", "x-ai/grok-4.7": "Grok 4.7", "z-ai/glm-5.3-prime": "GLM 5.3 Prime", "mistralai/mistral-large-4-0": "Mistral Large 4",
};
export const label = (id) => MODEL_LABEL[id] || String(id || "").split("/").pop().replace(/[-_]/g, " ");

/// Rejects with "<what> did not answer in <n> minutes" when the promise is slower than ms.
export function withTimeout(promise, ms, what = "the model") {
  let t;
  const late = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} did not answer in ${Math.round(ms / 60_000)} minutes`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(t));
}

/// The text as plain keyboard characters: dashes to commas, curly quotes straight, accents dropped, the rest removed.
export function asciiOnly(s) {
  return String(s ?? "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[–—]/g, ", ").replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"').replace(/…/g, "...").replace(/[•●▪]/g, "-").replace(/ /g, " ").replace(/×/g, "x")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "")
    .replace(/ ,/g, ",").replace(/,[ ]{2,}/g, ", ").replace(/[ \t]+(\n|$)/g, "$1");
}

export const escapeHtml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/// Bold, code and links inside a line. A link is kept only when it is http or https.
function inline(text) {
  let out = "", rest = String(text);
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/;
  for (;;) {
    const m = re.exec(rest);
    if (!m) { out += escapeHtml(rest); break; }
    out += escapeHtml(rest.slice(0, m.index));
    if (m[1] !== undefined) out += `<b>${escapeHtml(m[1])}</b>`;
    else if (m[2] !== undefined) out += `<code>${escapeHtml(m[2])}</code>`;
    else out += `<a href="${escapeHtml(m[4])}" rel="noopener nofollow" target="_blank">${escapeHtml(m[3])}</a>`;
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

/// Headings (#, ##, ###), paragraphs, "-" and "1." lists, bold, code and links. Nothing else is Markdown here:
/// raw HTML in the text is shown as text.
export function renderMarkdown(md) {
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let para = [], list = null; // list: { tag, items }
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) { flushPara(); flushList(); const lvl = Math.max(2, m[1].length); out.push(`<h${lvl}>${inline(m[2].trim())}</h${lvl}>`); continue; } // the page's h1 is its title: "#" and "##" are both h2
    if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) { flushPara(); if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; } list.items.push(m[1]); continue; }
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { flushPara(); if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [] }; } list.items.push(m[1]); continue; }
    if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += " " + line.trim(); continue; } // a wrapped list item
    flushList(); para.push(line.trim());
  }
  flushPara(); flushList();
  return out.join("\n");
}

/// One standalone page: the site's colours and type, the title, a line under it, the body, the footer. The body
/// is HTML already rendered by renderMarkdown; everything else is escaped here.
export function reviewPage({ title, subtitle = "", body = "", footer = "" } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@700;800&family=Rubik:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root { --ink: #2A1710; --bone: #F6EFE2; --paper: #FFFBF4; --line: #D8CAB3; --accent: #FF5A1F; --muted: #6B5447; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bone); color: var(--ink); font-family: Rubik, "Segoe UI", Arial, sans-serif; font-size: 17px; line-height: 1.6; }
main { max-width: 760px; margin: 0 auto; padding: 40px 20px 80px; }
.head { border-bottom: 3px solid var(--ink); padding-bottom: 18px; margin-bottom: 28px; }
.brand { font-family: "Baloo 2", "Arial Rounded MT Bold", sans-serif; font-weight: 800; font-size: 20px; letter-spacing: -0.01em; }
.brand i { display: inline-block; width: 0.45em; height: 0.45em; margin-left: 2px; border-radius: 2px; background: var(--accent); }
h1 { font-family: "Baloo 2", "Arial Rounded MT Bold", sans-serif; font-weight: 800; font-size: 40px; line-height: 1.05; letter-spacing: -0.02em; margin: 14px 0 8px; }
.sub { color: var(--muted); font-size: 15px; margin: 0; }
h2 { font-family: "Baloo 2", "Arial Rounded MT Bold", sans-serif; font-weight: 700; font-size: 26px; line-height: 1.15; margin: 34px 0 10px; }
h3 { font-size: 19px; margin: 24px 0 6px; }
p { margin: 0 0 14px; }
ul, ol { padding-left: 24px; margin: 0 0 14px; }
li { margin-bottom: 6px; }
a { color: var(--ink); font-weight: 600; text-decoration-color: var(--accent); text-decoration-thickness: 2px; text-underline-offset: 3px; }
code { font-family: "JetBrains Mono", ui-monospace, Consolas, monospace; font-size: 15px; background: var(--paper); border: 1.5px solid var(--line); border-radius: 6px; padding: 1px 6px; }
.panel { margin: 20px 0 0; padding: 16px 18px; border: 3px solid var(--ink); border-radius: 18px; background: var(--paper); }
.panel b { font-family: "Baloo 2", sans-serif; font-size: 18px; }
.panel ul { margin: 8px 0 0; }
.foot { margin-top: 44px; padding-top: 16px; border-top: 1.5px solid var(--line); color: var(--muted); font-size: 14px; }
@media print { body { background: #fff; } main { padding: 0; } }
</style>
</head>
<body>
<main>
<div class="head"><div class="brand">brownies<i></i></div><h1>${escapeHtml(title)}</h1>${subtitle ? `<p class="sub">${escapeHtml(subtitle)}</p>` : ""}</div>
${body}
${footer ? `<div class="foot">${footer}</div>` : ""}
</main>
</body>
</html>
`;
}
