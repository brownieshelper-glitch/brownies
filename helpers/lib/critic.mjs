// Critic, the editor. Every evening it reads what the brownies produced that day (the Kitchen's reports, Fudge's
// posts, Crumb's answers) and names at most three concrete improvements. Each one goes where it can take effect:
//   issue     a change to code, a page, the docs or the facts -> a task for Chip (labelled chip)
//   feedback  how a brownie writes or behaves -> a short note every brownie reads in its prompt the next day
//   owner     something only the owner can change (a setting, a budget, an account) -> a line to the owner
// Nothing is vague: an improvement names the brownie, what was weak, and what to do instead.
import { Helper } from "./helper.mjs";
import { parseJson, cut } from "./text.mjs";
import { cap } from "./facts.mjs";

const RULES = `Your task now: read today's work of the brownies and name at most three improvements.
- Be concrete: which brownie, what exactly was weak (quote it), what to do instead. Skip praise. If the day was fine, return an empty list.
- Where each improvement goes: "issue" when code, a page, the docs or the facts should change (write it as a task Chip can do); "feedback" when a brownie should write or behave differently (one or two sentences the brownie will read tomorrow); "owner" when only the owner can change it (a setting, a budget, an account).
- Facts only from the facts given. Never suggest a promise of price, a hashtag storm, or anything the voice rules forbid.
- Answer with JSON only: {"improvements": [{"helper": "fudge", "where": "feedback", "what": "...", "fix": "..."}]}`;

export class Critic extends Helper {
  constructor(deps) {
    super("critic", deps);
    this.github = deps.github || null;
    this.tg = deps.telegram || null;
    this.ownerChatId = String(deps.ownerChatId || "");
    this.hour = this.config.hour ?? 21;
    this.minute = this.config.minute ?? 30;
    this.maxIssuesPerDay = this.config.maxIssuesPerDay ?? 2;
  }

  jobs() {
    return [{ id: "critic-review", helper: "critic", daily: { hours: [this.hour], minute: this.minute }, run: () => this.guard("review", () => this.review()) }];
  }

  /// What the team did today, as text: the reports since the day's start, the posts, a sample of Crumb's answers.
  async material() {
    const now = this.clock.now();
    const since = this.store.dayStart(now);
    const r = await this.gateway.get("/api/team/activity?limit=60");
    const reports = ((r.ok && r.body?.entries) || []).filter((e) => e.at >= since && e.kind !== "status").map((e) => `- ${e.helper} ${e.kind}: ${cut(e.title, 140)}${e.body ? " | " + cut(e.body, 200) : ""}`);
    const posts = this.store.recentPosts("fudge", "x", "post", 6).concat(this.store.recentPosts("fudge", "site", "post", 6)).map((t) => `- Fudge posted: ${cut(t, 280)}`);
    const answers = this.store.turnsSince(since, "assistant").slice(-8).map((t) => `- Crumb answered: ${cut(t.text, 240)}`);
    const failures = ["fudge", "crumb", "nib", "chip"].flatMap((h) => this.store.jobsSince(h, since).filter((j) => !j.ok).map((j) => `- ${h} failed ${j.job}: ${cut(j.note || "", 120)}`));
    return { text: [reports.length ? `REPORTS TODAY:\n${reports.join("\n")}` : "REPORTS TODAY: none", posts.length ? `POSTS:\n${posts.join("\n")}` : "", answers.length ? `ANSWERS:\n${answers.join("\n")}` : "", failures.length ? `FAILED JOBS:\n${failures.join("\n")}` : ""].filter(Boolean).join("\n\n"), count: reports.length + posts.length + answers.length };
  }

  async review() {
    const now = this.clock.now();
    const m = await this.material();
    if (!m.count) { this.log("[critic] nothing to review today"); return null; }
    if (!(await this.ready())) return null;
    await this.status("Reading today's work");
    const r = await this.think({ system: this.system(RULES), prompt: `${cut(m.text, 9000)}\n\nName the improvements now.`, maxTokens: 1200, temperature: 0.3 });
    const j = parseJson(r.text);
    const list = (Array.isArray(j?.improvements) ? j.improvements : []).filter((x) => x && typeof x.fix === "string" && x.fix.trim()).slice(0, 3);
    const done = { issues: [], feedback: [], owner: [] };
    for (const x of list) {
      const helper = String(x.helper || "team").toLowerCase().replace(/[^a-z]/g, "") || "team";
      const what = cut(String(x.what || ""), 300), fix = cut(String(x.fix), 500);
      if (x.where === "issue" && this.github?.configured && done.issues.length < this.maxIssuesPerDay) {
        const issue = await this.github.createIssue({ title: cut(`${cap(helper)}: ${fix}`, 100), body: `Found by Critic reviewing the day's work.\n\nWeak: ${what}\n\nDo: ${fix}`, labels: ["chip"] });
        done.issues.push({ helper, fix, url: issue.url });
      } else if (x.where === "owner") done.owner.push({ helper, what, fix });
      else done.feedback.push({ helper, fix });
    }
    const date = this.store.dayKey(now);
    if (done.feedback.length) this.store.setMeta("critic:latest", JSON.stringify({ date, items: done.feedback, at: now }));
    if (done.owner.length && this.tg?.configured && this.ownerChatId) await this.tg.sendMessage(this.ownerChatId, `Critic, for you:\n${done.owner.map((o) => `- ${cap(o.helper)}: ${o.what}\n  Do: ${o.fix}`).join("\n")}`);
    const n = done.issues.length + done.feedback.length + done.owner.length;
    await this.report("note", n ? `Reviewed the day: ${done.issues.length} task${done.issues.length === 1 ? "" : "s"} for Chip, ${done.feedback.length} note${done.feedback.length === 1 ? "" : "s"} for the brownies, ${done.owner.length} for the owner` : "Reviewed the day: nothing to improve", { body: cut(list.map((x) => `${cap(x.helper || "team")}: ${x.fix}`).join("\n"), 1000), cost_micro: r.costMicro });
    return done;
  }

  /// The owner's instruction: review with a question in mind.
  async onRequest(text) {
    return this.guard("review", async () => {
      const m = await this.material();
      if (!(await this.ready())) return null;
      const r = await this.think({ system: this.system(RULES), prompt: `${cut(m.text, 9000)}\n\nTHE OWNER ASKS: ${cut(String(text || ""), 400)}\n\nAnswer in plain text, then the JSON of improvements if any.`, maxTokens: 900, temperature: 0.3 });
      const answer = r.text.replace(/\{[\s\S]*\}\s*$/, "").trim();
      if (answer && this.tg?.configured && this.ownerChatId) await this.tg.sendMessage(this.ownerChatId, `Critic: ${cut(answer, 3800)}`);
      return { text: answer };
    });
  }
}
