// Dough, the brownie that makes brownies. Once a day it looks at what the team is doing and what nobody covers
// (Nib's note, the questions people asked, the failed jobs, the open tasks) and, when a job is missing, it hires a
// recruit: a spec of role, tasks and tools (see recruit.mjs), never code. A recruit starts hidden, on a trial: after
// `trialDays` it must have produced at least `minOutputsPerWeek` results or Dough retires it. There is a ceiling on
// how many recruits exist and on their combined daily budget. The owner hears about every hire and can undo it
// (/fire <name>), or ask for one (/hire <what>), but nothing waits for the owner.
import { Helper } from "./helper.mjs";
import { validateSpec, TOOLS } from "./recruit.mjs";
import { parseJson, cut } from "./text.mjs";
import { cap } from "./facts.mjs";

const RULES = `Your task now: decide whether the team needs one more brownie this week, and if so describe it.
- A brownie is a worker with a role, one to three scheduled tasks written as instructions in plain words, and tools. The tools are: note (write a note into the repository), draft (send a draft to the owner to act on), announce (one short message a day in the Telegram group), issue (file a code task for Chip). A recruit can only produce text: it cannot run code, trade, or touch keys.
- Hire only when a real job is uncovered: something the project needs every week that no current brownie does. Do not duplicate a current brownie. Do not hire for one-off work.
- A good hire has a clear name (one word, lowercase letters), a role in one sentence, tasks that produce something checkable, and the cheapest model that can do them (anthropic/claude-haiku-4.5 for writing, anthropic/claude-sonnet-5.5 for analysis).
- Answer with JSON only: {"hire": false, "why": "one sentence"} or {"hire": true, "why": "one sentence", "spec": {"name": "...", "role": "...", "model": "...", "dailyCapUsd": 0.5, "tools": ["note"], "tasks": [{"id": "...", "title": "...", "text": "...", "tool": "note", "daily": {"hours": [10]}, "maxWords": 250}]}}`;

export class Dough extends Helper {
  /// deps: the Helper deps plus telegram, ownerChatId, hire(spec) -> recruit, fire(name), recruits() -> [recruit], github.
  constructor(deps) {
    super("dough", deps);
    this.tg = deps.telegram || null;
    this.ownerChatId = String(deps.ownerChatId || "");
    this.github = deps.github || null;
    this.hireFn = deps.hire; this.fireFn = deps.fire; this.recruitsFn = deps.recruits || (() => []);
    this.rosterFn = deps.roster || (() => []); // [{ name, role }] of every current brownie, for the prompt
    this.hour = this.config.hour ?? 12;
    this.maxRecruits = this.config.maxRecruits ?? 6;
    this.poolUsdPerDay = this.config.poolUsdPerDay ?? 5;
    this.maxCapUsd = this.config.maxCapUsd ?? 1;
    this.trialDays = this.config.trialDays ?? 7;
    this.minOutputsPerWeek = this.config.minOutputsPerWeek ?? 3;
    this.recruitsHidden = this.config.recruitsHidden !== false;
  }

  jobs() {
    return [{ id: "dough-review", helper: "dough", daily: { hours: [this.hour], minute: 0 }, run: () => this.guard("review", () => this.review()) }];
  }

  /// The recruits Dough is responsible for: the team's, not the holders' baked brownies (lib/bakery.mjs).
  teamRecruits() { return this.recruitsFn().filter((r) => !r.spec?.baked); }
  poolUsed() { return this.teamRecruits().reduce((n, r) => n + (r.spec?.dailyCapUsd || 0), 0); }

  /// The daily round: retire what failed its trial, then think about one hire.
  async review() {
    const retired = await this.trials();
    const hired = this.store.seen("dough-hire", this.store.dayKey(this.clock.now())) ? null : await this.consider();
    return { retired, hired };
  }

  /// A recruit past its trial with too little to show is retired; the owner is told.
  async trials() {
    const now = this.clock.now();
    const out = [];
    for (const r of this.teamRecruits()) {
      const spec = r.spec;
      if (!spec?.hiredAt || now - spec.hiredAt < this.trialDays * 86_400_000) continue;
      const outputs = Number(this.store.getMeta(`recruit:${spec.name}:outputs`, 0));
      const weeks = Math.max(1, (now - spec.hiredAt) / (7 * 86_400_000));
      if (outputs / weeks >= this.minOutputsPerWeek) continue;
      await this.fire(spec.name, `${outputs} result${outputs === 1 ? "" : "s"} in ${Math.round((now - spec.hiredAt) / 86_400_000)} days`);
      out.push(spec.name);
    }
    return out;
  }

  /// Think about one hire from what the team shows today. Returns the recruit or null.
  async consider(request = "") {
    const recruits = this.teamRecruits();
    if (recruits.length >= this.maxRecruits) { this.log(`[dough] ${recruits.length} recruits already, the ceiling`); return null; }
    if (!(await this.ready())) return null;
    const now = this.clock.now();
    const since = this.store.dayStart(now) - 2 * 86_400_000;
    const failures = this.rosterFn().flatMap((h) => this.store.jobsSince(h.name, since).filter((j) => !j.ok).map((j) => `${h.name}: ${j.job} (${cut(j.note || "", 60)})`)).slice(0, 8);
    const digest = this.store.getMeta("digest:latest");
    const d = digest ? JSON.parse(digest) : null;
    let openIssues = "";
    try { if (this.github?.configured) openIssues = (await this.github.issues({ labels: "chip" })).map((i) => i.title).slice(0, 8).join("; "); } catch { /* no GitHub */ }
    const prompt = [
      `THE TEAM TODAY:\n${this.rosterFn().map((h) => `- ${cap(h.name)}: ${h.role}`).join("\n")}`,
      `RECRUITS: ${recruits.length} of ${this.maxRecruits}; budget used ${this.poolUsed().toFixed(2)} of ${this.poolUsdPerDay} dollars a day; a new one may have at most ${Math.min(this.maxCapUsd, this.poolUsdPerDay - this.poolUsed()).toFixed(2)} a day.`,
      failures.length ? `FAILED JOBS, last two days:\n${failures.map((f) => "- " + f).join("\n")}` : "FAILED JOBS, last two days: none",
      d ? `WHAT PEOPLE ASKED (${d.date}):\n${cut(d.text, 1500)}` : "",
      openIssues ? `OPEN CODE TASKS: ${openIssues}` : "",
      request ? `THE OWNER ASKED FOR THIS HIRE: ${cut(request, 500)}. Write the spec for it.` : "Is a job uncovered this week? Decide.",
    ].filter(Boolean).join("\n\n");
    const r = await this.think({ system: this.system(RULES), prompt, maxTokens: 1500, temperature: 0.4 });
    const j = parseJson(r.text);
    if (!j || (!j.hire && !request)) { this.log(`[dough] no hire today${j?.why ? ": " + cut(j.why, 120) : ""}`); this.store.markSeen("dough-hire", this.store.dayKey(now), now); return null; }
    const room = Math.min(this.maxCapUsd, this.poolUsdPerDay - this.poolUsed());
    if (room < 0.1) { this.log("[dough] the budget pool is full"); return null; }
    let spec;
    try { spec = validateSpec({ ...(j.spec || {}), hidden: this.recruitsHidden, why: j.why, hiredAt: now }, { maxCapUsd: room, existing: this.rosterFn().map((h) => h.name) }); }
    catch (e) { this.log(`[dough] the spec was not usable: ${e.message}`); this.store.jobDone({ at: now, helper: "dough", job: "hire", ok: false, costMicro: r.costMicro, note: e.message }); return null; }
    const recruit = await this.hireFn(spec);
    this.store.markSeen("dough-hire", this.store.dayKey(now), now);
    const text = `Dough hired ${spec.title}: ${spec.role}\nWhy: ${spec.why || "a job nobody covered"}\nTasks: ${spec.tasks.map((t) => `${t.title} (${t.tool}, ${t.daily ? "daily at " + t.daily.hours.join(", ") : "every " + t.everyMinutes + " min"})`).join("; ")}\nBudget ${spec.dailyCapUsd.toFixed(2)} a day, model ${spec.model}. Trial: ${this.trialDays} days.\nUndo with /fire ${spec.name}`;
    if (this.tg?.configured && this.ownerChatId) await this.tg.sendMessage(this.ownerChatId, text);
    await this.report("milestone", `Hired ${spec.title}: ${cut(spec.role, 100)}`, { cost_micro: r.costMicro });
    return recruit;
  }

  /// Retires a recruit: its jobs stop, its spec is kept as history. The owner is told.
  async fire(name, reason = "the owner asked") {
    const ok = await this.fireFn(String(name).toLowerCase());
    if (!ok) return false;
    const text = `${cap(name)} was retired: ${reason}.`;
    this.log(`[dough] ${text}`);
    if (this.tg?.configured && this.ownerChatId) await this.tg.sendMessage(this.ownerChatId, text);
    await this.report("note", text);
    return true;
  }

  /// /hire <what> from the owner: a hire now, from the description.
  async onRequest(text) {
    return this.guard("hire", () => this.consider(String(text || "").trim()));
  }
}

export { TOOLS };
