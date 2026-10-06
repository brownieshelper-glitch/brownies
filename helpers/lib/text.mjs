// Small text tools: a web page as plain text, a line diff with a count of changed lines, the JSON inside a model
// answer, slugs and cuts.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/// The readable text of an HTML page, cut to `max` characters. Scripts, styles and tags go; entities are decoded.
export function htmlToText(html, max = 6000) {
  let t = String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br|blockquote|pre)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#?\w+);/g, (m, e) => ENTITIES[e] ?? (e[0] === "#" ? String.fromCharCode(Number(e.slice(1))) || " " : m));
  t = t.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
  return t.length > max ? t.slice(0, max) + "\n[cut]" : t;
}

/// Lines of `a` and `b` aligned by a longest common subsequence. Returns [[" ", line] | ["-", line] | ["+", line]].
/// Very large inputs (over 4 million cells) are not aligned: everything counts as removed then added.
export function lineDiff(a, b) {
  const A = String(a ?? "").split("\n"), B = String(b ?? "").split("\n");
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length, endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) { endA--; endB--; }
  const out = A.slice(0, start).map((l) => [" ", l]);
  const midA = A.slice(start, endA), midB = B.slice(start, endB);
  if (midA.length * midB.length > 4_000_000) {
    for (const l of midA) out.push(["-", l]);
    for (const l of midB) out.push(["+", l]);
  } else {
    const n = midA.length, m = midB.length, W = m + 1;
    const L = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * W + j] = midA[i] === midB[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { out.push([" ", midA[i]]); i++; j++; }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) out.push(["-", midA[i++]]);
      else out.push(["+", midB[j++]]);
    }
    while (i < n) out.push(["-", midA[i++]]);
    while (j < m) out.push(["+", midB[j++]]);
  }
  for (const l of A.slice(endA)) out.push([" ", l]);
  return out;
}

/// How many lines a change touches: lines added plus lines removed.
export function changedLines(a, b) {
  let n = 0;
  for (const [op] of lineDiff(a, b)) if (op !== " ") n++;
  return n;
}

/// A readable diff for a reviewer: changed lines with two lines of context, per file. A new file shows as all added.
export function unifiedDiff(path, a, b, context = 2) {
  const rows = lineDiff(a, b);
  const keep = new Set();
  rows.forEach(([op], i) => { if (op !== " ") for (let k = i - context; k <= i + context; k++) keep.add(k); });
  const lines = [`--- ${path}`];
  let last = -2;
  rows.forEach((r, i) => { if (!keep.has(i)) return; if (i !== last + 1) lines.push("@@"); lines.push(r[0] + " " + r[1]); last = i; });
  return lines.join("\n");
}

/// The first JSON object or array inside a model answer, fences and chatter around it ignored. Null when none parses.
export function parseJson(text) {
  const t = String(text ?? "").replace(/```(?:json)?/g, "");
  const starts = [t.indexOf("{"), t.indexOf("[")].filter((i) => i >= 0);
  if (!starts.length) return null;
  const from = Math.min(...starts);
  const close = t[from] === "{" ? "}" : "]";
  for (let end = t.lastIndexOf(close); end > from; end = t.lastIndexOf(close, end - 1)) {
    try { return JSON.parse(t.slice(from, end + 1)); } catch { /* try a shorter slice */ }
  }
  return null;
}

export const slug = (s, max = 40) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max) || "change";
export const cut = (s, n) => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n - 3).trimEnd() + "..." : t; };
export const words = (s) => String(s ?? "").split(/\s+/).filter(Boolean).length;
export const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
