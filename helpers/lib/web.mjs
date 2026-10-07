// A web page as plain text for a brownie to read, or a one-line reason in brackets when it could not be read.
// Never throws: a page that is down is a fact the model can be told, not a failed job.
import { htmlToText, cut } from "./text.mjs";

export async function readPage(url, { fetch = globalThis.fetch, max = 3500, who = "a brownie", timeoutMs = 20_000 } = {}) {
  try {
    const init = { headers: { "user-agent": `brownies-helpers (${who}; https://feedthebrownies.com)`, accept: "text/html,text/plain,application/json" } };
    if (typeof AbortSignal?.timeout === "function") init.signal = AbortSignal.timeout(timeoutMs);
    const r = await fetch(url, init);
    if (!r.ok) return `[${url} answered ${r.status}]`;
    const body = await r.text();
    return /<html|<body|<div/i.test(body) ? htmlToText(body, max) : cut(body, max);
  } catch (e) {
    return `[${url} could not be read: ${String(e?.message || e).slice(0, 80)}]`;
  }
}
