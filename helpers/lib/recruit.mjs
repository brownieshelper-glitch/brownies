// A recruit: a brownie made at runtime from a spec, not from code. The team can grow by itself (see hiring.mjs)
// because a new brownie is only data: a name, a role, a model, a budget, scheduled tasks written in plain words,
// and the tools it may use. Every tool is one of a fixed few, so a recruit can never run code or touch keys:
//
//   note      writes what it produced to the repository, notes/<name>/<date>-<task>.md (GitHub)
//   draft     sends what it produced to the owner on Telegram, as a draft to act on
//   announce  says one short message in the Telegram group (at most one a day, in the project's voice)
//   issue     files a task for Chip on GitHub (labelled chip), so a wish becomes code the usual way
//   report    (always) a line in the Kitchen, unless the recruit is hidden
//
// Spec: { name, title, role, model, dailyCapUsd, hidden, tools: [...], tasks: [{ id, title, text, daily: { hours } | everyMinutes, tool, maxWords }] }
import { Helper } from "./helper.mjs";
import { tidy, problems } from "./voice.mjs";
import { cut } from "./text.mjs";
import { cap } from "./facts.mjs";

export const TOOLS = ["note", "draft", "announce", "issue"];
const NAME = /^[a-z][a-z0-9]{2,15}$/;
const RESERVED = ["fudge", "crumb", "nib", "chip", "team", "admin", "owner", "brownies", "sugar"]; // the live roster is checked too, through `existing`

/// Checks a spec and returns a clean copy, or throws a plain sentence saying what is wrong.
export function validateSpec(raw, { maxCapUsd = 1, existing = [] } = {}) {
  if (!raw || typeof raw !== "object") throw new Error("the spec is not an object");
  const name = String(raw.name || "").toLowerCase().trim();
  if (!NAME.test(name)) throw new Error("the name must be 3 to 16 letters or digits, starting with a letter");
  if (RESERVED.includes(name) || existing.includes(name)) throw new Error(`the name ${name} is taken`);
  const role = cut(String(raw.role || "").trim(), 300);
  if (role.length < 12) throw new Error("the role needs a real sentence");
  const tools = [...new Set((raw.tools || []).map((t) => String(t).toLowerCase()))].filter((t) => TOOLS.includes(t));
  if (!tools.length) throw new Error(`the tools must be some of ${TOOLS.join(", ")}`);
  const tasks = (raw.tasks || []).slice(0, 4).map((t, i) => {
    const id = String(t.id || `task${i + 1}`).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24) || `task${i + 1}`;
    const text = cut(String(t.text || "").trim(), 1200);
    if (text.length < 12) throw new Error(`task ${id} needs instructions`);
    const tool = tools.includes(t.tool) ? t.tool : tools[0];
    const out = { id, title: cut(String(t.title || id), 80), text, tool, maxWords: Math.min(800, Math.max(40, Number(t.maxWords) || 250)) };
    if (t.everyMinutes) out.everyMinutes = Math.min(24 * 60, Math.max(30, Math.round(Number(t.everyMinutes))));
    else { const hours = (t.daily?.hours || [10]).map(Number).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23).slice(0, 3); out.daily = { hours: hours.length ? hours : [10] }; }
    return out;
  });
  if (!tasks.length) throw new Error("a recruit needs at least one task");
  const dailyCapUsd = Math.min(maxCapUsd, Math.max(0.1, Number(raw.dailyCapUsd) || 0.5));
  return { name, title: cap(name), role, model: String(raw.model || "anthropic/claude-haiku-4.5"), dailyCapUsd, hidden: raw.hidden !== false, tools, tasks, hiredAt: raw.hiredAt || null, why: cut(String(raw.why || ""), 300) };
}

export class Recruit extends Helper {
  /// deps: the usual Helper deps plus telegram, github, ownerChatId, groupChatId, and `spec`.
  constructor(deps) {
    const spec = deps.spec;
    super(spec.name, { ...deps, config: { role: spec.role, model: spec.model, dailyCapUsd: spec.dailyCapUsd, hidden: spec.hidden } });
    this.spec = spec;
    this.tg = deps.telegram || null;
    this.github = deps.github || null;
    this.ownerChatId = String(deps.ownerChatId || "");
    this.groupChatId = String(deps.groupChatId || "") || String(this.store.getMeta("tg:group:auto") || "");
    this.title = spec.title;
    this.recruit = true;
  }

  jobs() {
    return this.spec.tasks.map((t) => ({
      id: `${this.name}-${t.id}`, helper: this.name,
      ...(t.everyMinutes ? { every: t.everyMinutes * 60_000, initialDelay: 5 * 60_000 } : { daily: { hours: t.daily.hours, minute: 0 } }),
      run: () => this.guard(t.id, () => this.doTask(t)),
    }));
  }

  /// Context the model gets: Nib's latest note is in the system prompt already; add the Kitchen's figures.
  async context() {
    const s = await this.gateway.summary();
    if (!s.ok || !s.body) return "";
    return `KITCHEN TODAY: ${cut(JSON.stringify({ total: s.body.total, helpers: (s.body.helpers || []).map((h) => ({ helper: h.helper, today: h.today })) }), 600)}`;
  }

  /// One task: think, check the voice, deliver with the task's tool, count it.
  async doTask(t) {
    if (!(await this.ready())) return null;
    const now = this.clock.now();
    await this.status(`Working on: ${t.title}`);
    const r = await this.think({
      system: this.system(`Your task now: ${t.title}.\n${t.text}\n\nWrite about ${t.maxWords} words at most. Plain text, ASCII only, no markdown, no emoji, no hashtags. Facts only from the facts given. Start with the result itself, no preamble.`),
      prompt: `${await this.context()}\n\nDo the task now.`, maxTokens: Math.min(2000, Math.round(t.maxWords * 2.2) + 200), temperature: 0.5,
    });
    const text = tidy(r.text);
    const bad = problems(text, { maxLen: 20_000, maxHashtags: 1 });
    if (!text || bad.length) { this.log(`[${this.name}] output refused (${bad.join(", ") || "empty"})`); this.store.jobDone({ at: now, helper: this.name, job: t.id, ok: false, costMicro: r.costMicro, note: bad.join(", ") || "empty" }); return null; }
    const out = await this.deliver(t, text, now);
    this.store.setMeta(`recruit:${this.name}:outputs`, Number(this.store.getMeta(`recruit:${this.name}:outputs`, 0)) + 1);
    await this.report(out.kind, `${t.title}${out.where ? ` (${out.where})` : ""}`, { body: cut(text, 1000), url: out.url, place: out.place, cost_micro: r.costMicro });
    return { task: t.id, text, ...out };
  }

  /// The tool: where the result goes. Returns { kind, url, place, where }.
  async deliver(t, text, now) {
    const date = this.store.dayKey(now);
    switch (t.tool) {
      case "note": {
        if (!this.github?.configured) { this.store.setMeta(`recruit:${this.name}:last`, JSON.stringify({ at: now, task: t.id, text: cut(text, 6000) })); return { kind: "note", url: null, place: null, where: "kept in the store" }; }
        const branch = await this.github.defaultBranch();
        const path = `notes/${this.name}/${date}-${t.id}.md`;
        const existing = await this.github.getFile(path, branch);
        await this.github.putFile(path, `# ${this.title}: ${t.title}, ${date}\n\n${this.role}\n\n${text}\n`, `${this.title}: ${t.title} ${date}`, { branch, sha: existing?.sha || null });
        return { kind: "note", url: this.github.fileUrl(path, branch), place: "github", where: "" };
      }
      case "draft": {
        if (this.tg?.configured && this.ownerChatId) await this.tg.sendMessage(this.ownerChatId, `${this.title}, ${t.title}:\n\n${cut(text, 3600)}`);
        return { kind: "deal", url: null, place: "telegram", where: "to the owner" };
      }
      case "announce": {
        if (this.store.seen(`${this.name}-announce`, date)) return { kind: "note", url: null, place: null, where: "kept: one announcement a day" };
        if (!this.groupChatId) return { kind: "note", url: null, place: null, where: "no group yet" };
        const short = cut(text.split("\n")[0], 400);
        await this.tg.sendMessage(this.groupChatId, short);
        this.store.markSeen(`${this.name}-announce`, date, now);
        return { kind: "post", url: null, place: "telegram", where: "in the group" };
      }
      case "issue": {
        if (!this.github?.configured) return { kind: "note", url: null, place: null, where: "no GitHub" };
        const issue = await this.github.createIssue({ title: cut(`${t.title}: ${text.split("\n")[0]}`, 100), body: `${text}\n\nFiled by ${this.title}, a brownie hired by the team (${this.role}).`, labels: ["chip"] });
        return { kind: "build", url: issue.url, place: "github", where: `issue #${issue.number}` };
      }
    }
    return { kind: "note", url: null, place: null, where: "" };
  }

  /// The owner's instruction: the first task, with the instruction as its text, now.
  async onRequest(text) {
    const t = { ...this.spec.tasks[0], id: "ask", title: cut(String(text || ""), 80), text: String(text || "") };
    return this.guard("ask", () => this.doTask(t));
  }
}
