// A page made self-contained: its stylesheets, scripts, images and web fonts fetched once and written into the
// document as inline code and data URIs, so the box can render it with no network. The remake renders every
// candidate page this way, and the page as it is today for the judges to compare with.
const FONT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"; // the font hosts answer a browser with woff2
const UA = "Mozilla/5.0 (compatible; BrowniesSiteCheck/1.0; +https://feedthebrownies.com/shop.html)"; // everyone else is told who asks
const MIME = { css: "text/css", js: "text/javascript", mjs: "text/javascript", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon", woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf", eot: "application/vnd.ms-fontobject", mp4: "video/mp4", webm: "video/webm" };
const mimeOf = (url, header) => { const h = String(header || "").split(";")[0].trim().toLowerCase(); if (h && h !== "application/octet-stream" && h !== "text/plain") return h; const ext = (/\.([a-z0-9]+)(?:[?#]|$)/i.exec(url) || [])[1]; return MIME[(ext || "").toLowerCase()] || "application/octet-stream"; };
const skip = (u) => /^(data:|about:|blob:|javascript:|#|mailto:|tel:)/i.test(u) || !u;

/// { html, bytes, assets, failed } : the page with its assets inside. `cache` (a Map) may be shared across pages of one
/// site so each asset is fetched once. Assets over perAsset or beyond maxBytes in all stay as links (they fail offline).
export async function inlinePage(html, baseUrl, fetchFn = globalThis.fetch, { maxBytes = 12_000_000, perAsset = 3_000_000, timeoutMs = 15_000, cache = new Map() } = {}) {
  const state = { bytes: 0, assets: 0, failed: [] };
  const abs = (u) => { try { return new URL(u.trim(), baseUrl).href; } catch { return null; } };
  const get = async (url, accept) => {
    if (cache.has(url)) return cache.get(url);
    let out = null;
    try {
      const r = await fetchFn(url, { headers: { "user-agent": url.startsWith("https://fonts.googleapis.com/") || url.startsWith("https://fonts.gstatic.com/") ? FONT_UA : UA, accept }, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
      if (r.ok) { const buf = Buffer.from(await r.arrayBuffer()); if (buf.length <= perAsset) out = { buf, mime: mimeOf(url, r.headers.get("content-type")) }; }
    } catch { out = null; }
    cache.set(url, out);
    return out;
  };
  const room = (n) => state.bytes + n <= maxBytes;
  const dataUri = async (url, accept = "*/*") => {
    const a = abs(url); if (!a || skip(url)) return null;
    const got = await get(a, accept);
    if (!got || !room(got.buf.length)) { state.failed.push(a); return null; }
    state.bytes += got.buf.length; state.assets++;
    return `data:${got.mime};base64,${got.buf.toString("base64")}`;
  };
  // url(...) inside CSS, relative to the sheet's own address
  const cssUrls = async (css, sheetUrl, quote = null) => {
    const parts = [];
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    let last = 0, m;
    while ((m = re.exec(css))) {
      parts.push(css.slice(last, m.index));
      const u = m[2].trim(), q = quote || m[1] || '"';
      let rep = m[0];
      if (!skip(u)) { const a = (() => { try { return new URL(u, sheetUrl).href; } catch { return null; } })(); if (a) { const d = await dataUri(a); if (d) rep = `url(${q}${d}${q})`; } }
      parts.push(rep);
      last = m.index + m[0].length;
    }
    parts.push(css.slice(last));
    return parts.join("");
  };
  const sheet = async (url, depth = 0) => {
    const a = abs(url); if (!a) return null;
    const got = await get(a, "text/css,*/*;q=0.1");
    if (!got) { state.failed.push(a); return null; }
    let css = got.buf.toString("utf8");
    css = latinFaces(css);
    if (depth < 2) { const imports = [...css.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)['"]?\s*\)?[^;]*;/g)]; for (const im of imports) { const inner = await sheet(new URL(im[1], a).href, depth + 1); css = css.replace(im[0], () => inner || ""); } }
    return cssUrls(css, a);
  };
  let out = String(html || "");
  out = out.replace(/<base\b[^>]*>/gi, "");
  out = out.replace(/<link\b[^>]*\brel=["'](?:preconnect|dns-prefetch|preload|modulepreload|prefetch)["'][^>]*>/gi, "");
  // stylesheets
  const links = [...out.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).filter((t) => /\brel=["'][^"']*\bstylesheet\b/i.test(t));
  for (const tag of links) {
    const href = (/\bhref=["']([^"']+)["']/i.exec(tag) || [])[1];
    if (!href) continue;
    const css = await sheet(href);
    // every replacement below is a function: the code that goes in may hold "$&" or "$1", which a string replacement would expand
    out = out.replace(tag, () => (css === null ? tag : `<style data-from="${escapeAttr(abs(href) || href)}">\n${css.replace(/<\/style/gi, "<\\/style")}\n</style>`));
  }
  // inline style blocks and style attributes
  const styles = [...out.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];
  for (const m of styles) { if (/data-from=/.test(m[0])) continue; const css = await cssUrls(m[1], baseUrl); if (css !== m[1]) out = out.replace(m[0], () => m[0].replace(m[1], () => css)); }
  const styleAttrs = [...out.matchAll(/\sstyle=(?:"([^"]*url\([^"]*)"|'([^']*url\([^']*)')/gi)];
  for (const m of styleAttrs) { const inner = m[1] ?? m[2]; const css = await cssUrls(inner, baseUrl, m[1] !== undefined ? "'" : '"'); if (css !== inner) out = out.replace(m[0], () => m[0].replace(inner, () => css)); }
  // scripts with a source: the code goes into the src itself as a data address, so the tag keeps its place, its order
  // and its defer or async, and runs exactly when it did
  const scripts = [...out.matchAll(/<script\b([^>]*)\bsrc=(["'])([^"']+)\2([^>]*)>/gi)];
  for (const m of scripts) {
    const a = abs(m[3]); if (!a || skip(m[3])) continue;
    const got = await get(a, "*/*");
    if (!got || !room(got.buf.length)) { state.failed.push(a); continue; }
    state.bytes += got.buf.length; state.assets++;
    const attrs = (s) => s.replace(/\s(?:integrity|crossorigin)(?:=(?:"[^"]*"|'[^']*'))?/gi, "");
    out = out.replace(m[0], () => `<script${attrs(m[1])}src="data:text/javascript;base64,${got.buf.toString("base64")}" data-from="${escapeAttr(a)}"${attrs(m[4])}>`);
  }
  // images and media sources
  const imgs = [...out.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  for (const tag of imgs) {
    const src = (/\bsrc=["']([^"']+)["']/i.exec(tag) || [])[1];
    if (!src || skip(src)) continue;
    const d = await dataUri(src, "image/*,*/*;q=0.5");
    let t = tag.replace(/\ssrcset=["'][^"']*["']/i, "").replace(/\ssizes=["'][^"']*["']/i, "");
    if (d) t = t.replace(/\bsrc=["'][^"']+["']/i, () => `src="${d}"`);
    if (t !== tag) out = out.replace(tag, () => t);
  }
  out = out.replace(/<source\b[^>]*>/gi, (tag) => tag.replace(/\ssrcset=["'][^"']*["']/i, ""));
  return { html: out, bytes: state.bytes, assets: state.assets, failed: [...new Set(state.failed)] };
}

/// Google's font CSS carries one @font-face per unicode range; only the ranges that cover plain Latin are kept, the
/// rest would be dead weight in a data URI. A sheet with no ranges is returned as it is.
export function latinFaces(css) {
  if (!/unicode-range/i.test(css)) return css;
  return css.replace(/@font-face\s*\{[^}]*\}/gi, (block) => (/unicode-range\s*:[^;]*U\+0000-00FF/i.test(block) || !/unicode-range/i.test(block) ? block : ""));
}

const escapeAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
