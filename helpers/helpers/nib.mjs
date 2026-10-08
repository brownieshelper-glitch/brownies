// Nib, research. Once a day it reads the gateway's figures, the site, and a short list of competitor pages, and
// writes a note of about 300 words: what changed, what to do. The note goes to the repository as
// notes/YYYY-MM-DD.md in one commit, is reported with its link, and stays in the store for Fudge and Crumb.
import { Helper } from "../lib/helper.mjs";
import { tidy } from "../lib/voice.mjs";
import { htmlToText, cut } from "../lib/text.mjs";
import { recentLaunches, launchesBlock } from "../lib/launches.mjs";

const RULES = `Your task now: write today's research note.
- About 300 words. Two headings, exactly these: "What changed" and "What to do".
- Under "What changed": what is new in our numbers and on our site since the previous note (and on the competitors' pages, when any are given). Short, concrete. Never compare us with anyone and never name another project in the note.
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
    this.rpcUrl = deps.rpcUrl || "";
    this.launches = this.config.launches || null; // { hours, max }: Programmable launches on Ethereum, from the chain
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

  /// The coins launched through Programmable on Ethereum in the last day, read from the chain. "" when off or unreachable.
  async programmableLaunches() {
    if (!this.launches || (!this.rpcUrl && !this.launches.rpcUrls?.length)) return "";
    try {
      const list = await recentLaunches({ rpcUrls: this.launches.rpcUrls || [this.rpcUrl], hours: this.launches.hours || 24, fetch: this.fetch });
      return launchesBlock(list, { hours: this.launches.hours || 24, max: this.launches.max || 15 });
    } catch (e) {
      this.log(`[nib] could not read the Programmable launches: ${String(e.message).slice(0, 80)}`);
      return "PROGRAMMABLE LAUNCHES (Ethereum, last day): [the chain could not be read today]";
    }
  }

  /// The owner's instruction (the control room, or /nib on Telegram): a note on that question, now.
  async onRequest(text) {
    return this.guard("note", () => this.note({ focus: String(text || "").trim() }));
  }

  /// Today's note. Returns { date, text, url } or null (already written today, or no budget). With a `focus` it is a
  /// second, focused note (notes/YYYY-MM-DD-focus-*.md) and the daily one is left alone.
  async note({ focus = "" } = {}) {
    const now = this.clock.now();
    const date = this.store.dayKey(now);
    if (!focus && this.store.seen("nib-note", date)) { this.log(`[nib] the note for ${date} exists`); return null; }
    if (!(await this.ready())) return null;
    await this.status(this.competitors.length ? "Reading the chain, the site and the competitors" : "Reading the chain and the site");
    const [stats, summary] = await Promise.all([this.gateway.stats(), this.gateway.summary()]);
    const site = await this.page(`${this.siteUrl}/llms.txt`, 3000);
    const pages = [];
    for (const c of this.competitors) pages.push(`### ${c.name} (${c.url})\n${await this.page(c.url, c.max || 3500)}`);
    const launches = await this.programmableLaunches();
    const prev = this.store.latestNote;
    const prompt = [
      `Today is ${date}.`,
      `GATEWAY STATS (JSON): ${stats.ok ? cut(JSON.stringify(stats.body), 1500) : "[the gateway did not answer]"}`,
      `TEAM SUMMARY (JSON): ${summary.ok ? cut(JSON.stringify(summary.body), 1500) : "[the gateway did not answer]"}`,
      `OUR SITE (llms.txt):\n${site}`,
      pages.length ? `COMPETITORS:\n${pages.join("\n\n")}` : "COMPETITORS: none configured.",
      launches,
      prev ? `PREVIOUS NOTE (${prev.date}):\n${cut(prev.text, 2500)}` : "PREVIOUS NOTE: none, this is the first.",
      focus ? `THE OWNER ASKED FOR A NOTE ON THIS, so "What changed" answers it first: ${cut(focus, 500)}` : "",
      "Write today's note now.",
    ].join("\n\n");
    await this.status("Writing today's research note");
    const r = await this.think({ system: this.system(RULES), prompt, maxTokens: 1200, temperature: 0.4 });
    const text = tidy(r.text);
    if (!text) { await this.status("The research note came back empty"); return null; }
    const md = `# Research note ${date}${focus ? ": " + cut(focus, 60) : ""}\n\nWritten by Nib, the research brownie, from the gateway's figures and the site${this.competitors.length ? " and the competitors' pages" : ""}.${focus ? " Asked for by the owner." : ""}\n\n${text}\n`;
    const path = focus ? `notes/${date}-focus-${Date.now().toString(36)}.md` : `notes/${date}.md`;
    let url = null;
    if (this.github?.configured) {
      const branch = await this.github.defaultBranch();
      const existing = await this.github.getFile(path, branch);
      await this.github.putFile(path, md, `Nib: research note ${date}`, { branch, sha: existing?.sha || null });
      url = this.github.fileUrl(path, branch);
    } else this.log("[nib] GitHub is not configured, the note stays in the store only");
    if (!focus) { this.store.latestNote = { date, text, url, at: now }; this.store.markSeen("nib-note", date, now); }
    const issues = await this.fileChipIssues(text, date, url).catch((e) => { this.log(`[nib] could not file Chip's issues: ${e.message}`); return []; });
    const first = text.split("\n").find((l) => l.trim() && !l.startsWith("#")) || "";
    await this.report("research", `Research note ${date}: ${cut(first, 120)}`, { body: cut(text, 1000), url, place: "github", cost_micro: r.costMicro });
    return { date, text, url, issues };
  }

  /// The research-to-code loop: every "Chip: ..." line under "What to do" becomes a GitHub issue labelled "chip",
  /// so Chip picks it up on its next round. Small changes merge after the three reviews, bigger ones go to the
  /// owner, as always. At most `maxIssuesPerNote` a day; a suggestion already filed (same words) is not filed twice.
  async fileChipIssues(text, date, noteUrl) {
    if (!this.github?.configured || this.config.chipIssues === false) return [];
    const max = this.config.maxIssuesPerNote ?? 2;
    const lines = String(text).split("\n").map((l) => l.match(/^\s*(?:-\s*)?Chip:\s*(.+)$/i)?.[1]?.trim()).filter(Boolean);
    const out = [];
    for (const task of lines) {
      if (out.length >= max) break;
      const key = task.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      if (!key || this.store.seen("nib-chip-issue", key)) continue;
      const issue = await this.github.createIssue({
        title: cut(task.replace(/[.\s]+$/, ""), 100),
        body: `From Nib's research note of ${date}${noteUrl ? ` (${noteUrl})` : ""}:\n\n> Chip: ${task}\n\nFiled by Nib, the research brownie. Do the smallest change that does this; if it needs src/, eth-launch/, gateway/auth or keys, refuse with the reason.`,
        labels: ["chip"],
      });
      this.store.markSeen("nib-chip-issue", key, this.clock.now());
      out.push({ ...issue, task });
      this.log(`[nib] filed issue #${issue.number} for Chip: ${cut(task, 80)}`);
    }
    return out;
  }
}
