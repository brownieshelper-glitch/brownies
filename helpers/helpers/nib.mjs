// Nib, research. Once a day it reads the gateway's figures, the site, and a short list of competitor pages, and
// writes a note of about 300 words: what changed, what to do. The note goes to the repository as
// notes/YYYY-MM-DD.md in one commit, is reported with its link, and stays in the store for Fudge and Crumb.
import { Helper } from "../lib/helper.mjs";
import { tidy } from "../lib/voice.mjs";
import { htmlToText, cut } from "../lib/text.mjs";

const RULES = `Your task now: write today's research note.
- About 300 words. Two headings, exactly these: "What changed" and "What to do".
- Under "What changed": what is new in our numbers, on our site, and on the competitors' pages since the previous note. Short, concrete.
- Under "What to do": three to five plain suggestions for Fudge (posts), Crumb (answers) and Chip (code), each one line.
- Numbers only from the material given, each with its source in brackets, for example (gateway stats). If a page could not be read, say so in one line and move on.
- No markdown except the two headings ("## What changed", "## What to do") and plain lines. ASCII only.`;

export class Nib extends Helper {
  constructor(deps) {
    super("nib", deps);
    this.github = deps.github;
    this.fetch = deps.fetch || globalThis.fetch;
    this.siteUrl = String(deps.siteUrl || "https://feedthebrownies.com").replace(/\/$/, "");
    this.competitors = this.config.competitors || [];
  }

  jobs() {
    return [{ id: "nib-note", helper: "nib", daily: { hours: [this.config.hour ?? 8], minute: this.config.minute || 0 }, run: () => this.guard("note", () => this.note()) }];
  }

  /// A page as plain text, or a one-line reason in brackets when it could not be read.
  async page(url, max = 3500) {
    try {
      const init = { headers: { "user-agent": "brownies-helpers (Nib, research; https://feedthebrownies.com)", accept: "text/html,text/plain,application/json" } };
      if (typeof AbortSignal?.timeout === "function") init.signal = AbortSignal.timeout(20_000);
      const r = await this.fetch(url, init);
      if (!r.ok) return `[${url} answered ${r.status}]`;
      const body = await r.text();
      return /<html|<body|<div/i.test(body) ? htmlToText(body, max) : cut(body, max);
    } catch (e) {
      return `[${url} could not be read: ${String(e.message).slice(0, 80)}]`;
    }
  }

  /// Today's note. Returns { date, text, url } or null (already written today, or no budget).
  async note() {
    const now = this.clock.now();
    const date = this.store.dayKey(now);
    if (this.store.seen("nib-note", date)) { this.log(`[nib] the note for ${date} exists`); return null; }
    if (!(await this.ready())) return null;
    await this.status("Reading the chain, the site and the competitors");
    const [stats, summary] = await Promise.all([this.gateway.stats(), this.gateway.summary()]);
    const site = await this.page(`${this.siteUrl}/llms.txt`, 3000);
    const pages = [];
    for (const c of this.competitors) pages.push(`### ${c.name} (${c.url})\n${await this.page(c.url, c.max || 3500)}`);
    const prev = this.store.latestNote;
    const prompt = [
      `Today is ${date}.`,
      `GATEWAY STATS (JSON): ${stats.ok ? cut(JSON.stringify(stats.body), 1500) : "[the gateway did not answer]"}`,
      `TEAM SUMMARY (JSON): ${summary.ok ? cut(JSON.stringify(summary.body), 1500) : "[the gateway did not answer]"}`,
      `OUR SITE (llms.txt):\n${site}`,
      pages.length ? `COMPETITORS:\n${pages.join("\n\n")}` : "COMPETITORS: none configured.",
      prev ? `PREVIOUS NOTE (${prev.date}):\n${cut(prev.text, 2500)}` : "PREVIOUS NOTE: none, this is the first.",
      "Write today's note now.",
    ].join("\n\n");
    await this.status("Writing today's research note");
    const r = await this.think({ system: this.system(RULES), prompt, maxTokens: 800, temperature: 0.4 });
    const text = tidy(r.text);
    if (!text) { await this.status("The research note came back empty"); return null; }
    const md = `# Research note ${date}\n\nWritten by Nib, the research brownie, from the gateway's figures, the site and the competitors' pages.\n\n${text}\n`;
    const path = `notes/${date}.md`;
    let url = null;
    if (this.github?.configured) {
      const branch = await this.github.defaultBranch();
      const existing = await this.github.getFile(path, branch);
      await this.github.putFile(path, md, `Nib: research note ${date}`, { branch, sha: existing?.sha || null });
      url = this.github.fileUrl(path, branch);
    } else this.log("[nib] GitHub is not configured, the note stays in the store only");
    this.store.latestNote = { date, text, url, at: now };
    this.store.markSeen("nib-note", date, now);
    const first = text.split("\n").find((l) => l.trim() && !l.startsWith("#")) || "";
    await this.report("research", `Research note ${date}: ${cut(first, 120)}`, { body: cut(text, 1000), url, place: "github", cost_micro: r.costMicro });
    return { date, text, url };
  }
}
