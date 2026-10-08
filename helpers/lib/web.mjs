// A web page as plain text for a brownie to read, or a one-line reason in brackets when it could not be read.
// Never throws: a page that is down is a fact the model can be told, not a failed job.
import { htmlToText, cut } from "./text.mjs";

/// Hosts a brownie must never fetch: this machine, private networks, link-local and cloud metadata addresses.
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1\]?|\[?::\]?|\[?f[cd][0-9a-f]{2}:.*|\[?fe80:.*|\[?::ffff:.*)$/i;
export function isPublicHttpUrl(u) {
  let x;
  try { x = new URL(String(u)); } catch { return false; }
  if (!/^https?:$/.test(x.protocol)) return false;
  return !PRIVATE_HOST.test(x.hostname);
}

async function readBody(r, maxBytes) {
  if (!r.body || typeof r.body.getReader !== "function") return String(await r.text()).slice(0, maxBytes);
  const reader = r.body.getReader(), chunks = [];
  let n = 0;
  while (n < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value)); n += value.length;
  }
  try { await reader.cancel(); } catch { /* the rest is not wanted */ }
  return Buffer.concat(chunks).toString("utf8").slice(0, maxBytes);
}

/// A page as plain text, at most `max` characters. Only public web addresses; each redirect is checked the same way;
/// at most a megabyte is read; a page that is not text is refused. A failure is a short line in brackets, never a throw.
export async function readPage(url, { fetch = globalThis.fetch, max = 3500, who = "a brownie", timeoutMs = 20_000, maxBytes = 1_000_000 } = {}) {
  try {
    let at = String(url), r = null;
    for (let hop = 0; hop < 4 && !r; hop++) {
      if (!isPublicHttpUrl(at)) return `[${at} is not a public web address]`;
      const init = { headers: { "user-agent": `brownies-helpers (${who}; https://feedthebrownies.com)`, accept: "text/html,text/plain,application/json" }, redirect: "manual" };
      if (typeof AbortSignal?.timeout === "function") init.signal = AbortSignal.timeout(timeoutMs);
      const res = await fetch(at, init);
      const loc = res.status >= 300 && res.status < 400 ? res.headers?.get?.("location") : null;
      if (loc) { at = new URL(loc, at).toString(); continue; }
      r = res;
    }
    if (!r) return `[${url} redirected too many times]`;
    if (!r.ok) return `[${url} answered ${r.status}]`;
    const type = String(r.headers?.get?.("content-type") || "");
    if (type && !/text\/|json|xml/i.test(type)) return `[${url} is not a text page (${type.split(";")[0].trim()})]`;
    const body = await readBody(r, maxBytes);
    return /<html|<body|<div/i.test(body) ? htmlToText(body, max) : cut(body, max);
  } catch (e) {
    return `[${url} could not be read: ${String(e?.message || e).slice(0, 80)}]`;
  }
}
