// Chip, builder. Works from GitHub issues labelled "chip", or from the standing tasks in brownies.json when no
// issue is open. For a task it reads the files it needs through the GitHub API, writes whole new files, opens a
// branch and a pull request with a plain description, and asks the other three brownies for a yes or no.
//
//   small change  text, docs, styles, tests; under about 60 changed lines; nothing protected
//                 -> merges itself after three yes
//   bigger change -> three reviews, then the owner decides on Telegram (Approve / Reject)
//
// Protected and never touched: src/, eth-launch/, gateway/auth, deploy scripts, and any path or content that
// looks like a key or a secret. Every merge is a "build" report with the pull request's link.
import { Helper } from "../lib/helper.mjs";
import { systemPrompt } from "../lib/voice.mjs";
import { cap } from "../lib/facts.mjs";
import { parseJson, changedLines, unifiedDiff, slug, cut } from "../lib/text.mjs";

export const PROTECTED = [/^src\//, /^eth-launch\//, /^gateway\/auth/, /(^|\/)deploy[^/]*\.sh$/, /\.service$/, /(^|\/)\.github\//, /(^|\/)\.env/, /secret|private|wallet|keyfile|\.pem$|\.key$/i, /^helpers\/lib\/brain\.mjs$/, /^helpers\/lib\/env\.mjs$/, /(^|\/)package(-lock)?\.json$/, /^lib\//, /^node_modules\//];
const SMALL_KIND = [/\.(md|txt|css|html|svg)$/i, /(^|\/)test\/[^/]+\.(mjs|js|t\.sol)$/, /\.test\.mjs$/];
const TEXT_KIND = /\.(md|txt|css|html|js|mjs|cjs|json|sol|sh|yml|yaml|toml|svg)$/i;
const SKIP_DIRS = /^(lib|out|cache|broadcast|node_modules|versions|web\/vendor|web\/assets)\//;
const SECRET_SHAPE = /0x[0-9a-fA-F]{64}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|xox[baprs]-[A-Za-z0-9-]{10,}|\b\d{9,10}:[A-Za-z0-9_-]{35}\b/;

export const isProtected = (p) => PROTECTED.some((re) => re.test(p));
export const isSmallKind = (p) => SMALL_KIND.some((re) => re.test(p));

const CHIP_RULES = `Your task now: change code in the Brownies repository (github.com/brownieshelper-glitch/brownies).
- Make the smallest change that does the task. Keep the style of the file you touch: short comments in plain English, the same indentation.
- Never touch src/, eth-launch/, gateway/auth, deploy scripts, env files, package files, or anything about keys and secrets. If the task needs that, say so instead of doing it.
- Never put a key, a token, an address of a wallet, or a secret of any kind in a file.
- Answer with JSON only, nothing before or after it.`;

const REVIEW_RULES = `Your task now: review a code change that Chip, the builder brownie, wants to merge into the Brownies repository.
Say NO if the change touches src/, eth-launch/, gateway/auth, deploy scripts or env files, adds a secret or a key, breaks a test or a page, does something the task did not ask, or makes a claim that is not in the facts.
Say YES when it is small, does what the task says, and reads like the rest of the repository.
Answer YES or NO as the first word, then one sentence why.`;

const REVIEW_ROLE = { fudge: "marketing; you check the words", crumb: "community; you check that nothing promises a price and nothing confuses a reader", nib: "research; you check the facts and the numbers" };

export class Chip extends Helper {
  constructor(deps) {
    super("chip", deps);
    this.github = deps.github;
    this.tg = deps.telegram || null;
    this.ownerChatId = String(deps.ownerChatId || "");
    this.patch = deps.patch || null; // the quality brownie: waits for the checks before a merge (set by run.mjs)
    this.smallMaxLines = this.config.smallMaxLines ?? 60;
    this.reviewers = this.config.reviewers || ["fudge", "crumb", "nib"];
    this.standing = this.config.standingTasks || [];
  }

  jobs() {
    return [{ id: "chip-tasks", helper: "chip", every: (this.config.checkEveryMinutes || 30) * 60_000, run: () => this.guard("tasks", () => this.work()) }];
  }

  /// The owner's instruction (the control room, or /chip on Telegram): filed as an issue labelled chip and taken at once.
  async onRequest(text) {
    const t = String(text || "").trim();
    if (!t || !this.github?.configured) return null;
    const issue = await this.github.createIssue({ title: cut(t.split(/\n/)[0], 100), body: `${t}\n\nFiled by the owner from the control room.`, labels: ["chip"] });
    this.log(`[chip] issue #${issue.number} filed by the owner`);
    const r = await this.guard("tasks", () => this.work());
    return { title: `#${issue.number} ${cut(t, 80)}`, url: issue.url, worked: Boolean(r) };
  }

  /// One round: the next task, if any, while no pull request of Chip's waits for the owner.
  async work() {
    if (!this.github?.configured) { this.log("[chip] GitHub is not configured, no tasks"); return null; }
    await this.syncApprovals();
    if (this.store.pendingApprovals().some((a) => a.helper === "chip")) { this.log("[chip] a pull request waits for the owner"); return null; }
    const task = await this.nextTask();
    if (!task) return null;
    if (!(await this.ready())) return null;
    return this.doTask(task);
  }

  /// A waiting pull request the owner merged or closed on GitHub itself counts as decided, so Chip is not stuck.
  async syncApprovals() {
    for (const a of this.store.pendingApprovals().filter((x) => x.helper === "chip")) {
      const pr = await this.github.pr(Number(a.ref)).catch(() => null);
      if (!pr || pr.state === "open") continue;
      const now = this.clock.now();
      if (pr.merged) { this.store.decide(a.id, "approved", "merged on GitHub", now); await this.report("build", a.title, { body: "Merged on GitHub by the owner.", url: a.url, place: "github" }); }
      else { this.store.decide(a.id, "rejected", "closed on GitHub", now); await this.report("note", `Closed on GitHub: ${a.title}`, { url: a.url, place: "github" }); }
    }
  }

  async nextTask() {
    for (const i of await this.github.issues({ labels: "chip" })) if (!this.store.seen("chip-issue", i.number)) return { kind: "issue", number: i.number, title: i.title, text: i.body, url: i.url };
    for (const t of this.standing) if (!this.store.seen("chip-standing", t.id)) return { kind: "standing", id: t.id, title: t.title, text: t.text || "" };
    return null;
  }

  async doTask(task) {
    const now = this.clock.now();
    this.store.markSeen(task.kind === "issue" ? "chip-issue" : "chip-standing", task.kind === "issue" ? task.number : task.id, now); // once, even if it fails
    await this.status(`Working on: ${cut(task.title, 120)}`);
    const base = await this.github.defaultBranch();
    const baseSha = await this.github.branchSha(base);
    const tree = (await this.github.tree(baseSha)).filter((t) => t.type === "blob" && TEXT_KIND.test(t.path) && !SKIP_DIRS.test(t.path) && !isProtected(t.path) && t.size < 200_000);
    const taskText = `TASK: ${task.title}\n${task.text || ""}`.trim();

    // 1. which files does the change need
    const pick = await this.think({ system: this.system(CHIP_RULES), prompt: `${taskText}\n\nFILES IN THE REPOSITORY (the ones you may touch):\n${tree.map((t) => t.path).join("\n")}\n\nWhich files do you need to read to do this task? Answer with JSON only: {"files": ["path", ...]}. At most 6, existing paths only. [] when the task only adds a new file.`, maxTokens: 300, temperature: 0.1 });
    let cost = pick.costMicro;
    const want = (parseJson(pick.text)?.files || []).filter((p) => typeof p === "string" && tree.some((t) => t.path === p)).slice(0, 6);
    const files = {};
    for (const p of want) { const f = await this.github.getFile(p, base); if (f) files[p] = f; }

    // 2. the change itself: whole files
    const shown = Object.entries(files).map(([p, f]) => `=== ${p} ===\n${cut(f.content, 30_000)}`).join("\n\n") || "(no existing file read)";
    const change = await this.think({ system: this.system(CHIP_RULES), prompt: `${taskText}\n\nCURRENT FILES:\n${shown}\n\nWrite the change. Answer with JSON only:\n{"title": "one line", "description": "two or three plain sentences for the pull request", "files": [{"path": "...", "content": "the whole new file"}]}\nWhole files, never fragments. Only the files that change. If the task cannot be done safely, answer {"refuse": "one sentence why"}.`, maxTokens: 8000, temperature: 0.2 });
    cost += change.costMicro;
    const plan = parseJson(change.text);
    const bad = this.check(plan);
    if (bad) {
      this.log(`[chip] no change: ${bad}`);
      if (task.kind === "issue") await this.github.comment(task.number, `Chip could not do this safely: ${bad}`).catch(() => {});
      await this.status(`Could not make a safe change for: ${cut(task.title, 100)}`);
      this.store.jobDone({ at: now, helper: "chip", job: "build", ok: false, costMicro: cost, note: bad });
      return { done: false, reason: bad };
    }
    const title = cut(plan.title || task.title, 120);
    let changed = 0;
    for (const f of plan.files) changed += changedLines(files[f.path]?.content ?? "", f.content);
    const small = changed <= this.smallMaxLines && plan.files.every((f) => isSmallKind(f.path));

    // 3. branch, commits, pull request
    let branch = `chip/${slug(title)}-${this.store.dayKey(now)}`;
    if (await this.github.branchExists(branch)) branch += `-${now % 1000}`;
    await this.github.createBranch(branch, baseSha);
    for (const f of plan.files) await this.github.putFile(f.path, f.content, title, { branch, sha: files[f.path]?.sha || null });
    const n = plan.files.length;
    const body = [
      plan.description || "",
      task.kind === "issue" ? `Closes #${task.number}.` : `Standing task: ${task.id}.`,
      `Written by Chip, the builder brownie. ${changed} changed line${changed === 1 ? "" : "s"} in ${n} file${n === 1 ? "" : "s"}. ` + (small ? "Small change: it merges itself after the other brownies' review." : "Bigger change: the other brownies review it, then the owner decides on Telegram."),
    ].filter(Boolean).join("\n\n");
    const pr = await this.github.createPR({ title, body, head: branch, base });

    // 4. three reviews, each paid by its reviewer and reported in its name
    const diff = cut(plan.files.map((f) => unifiedDiff(f.path, files[f.path]?.content ?? "", f.content)).join("\n\n"), 20_000);
    const reviews = await this.review(pr, title, plan.description || "", diff);
    await this.github.comment(pr.number, "Reviews by the other brownies:\n" + reviews.map((r) => `- ${cap(r.by)}: ${r.yes ? "yes" : "no"}. ${r.text}`).join("\n")).catch(() => {});
    const allYes = reviews.length === this.reviewers.length && reviews.every((r) => r.yes);

    // 5. the tests (Patch waits for the repository's checks), then merge alone, or ask the owner
    const tests = small && allYes && this.patch ? await this.patch.verify(pr) : { state: "none" };
    if (small && allYes && tests.state !== "failed") {
      await this.github.mergePR(pr.number, { title });
      await this.report("build", title, { body: plan.description || null, url: pr.url, place: "github", cost_micro: cost });
      return { done: true, merged: true, pr, changed, small, tests: tests.state };
    }
    const id = this.store.addApproval({ at: now, helper: "chip", kind: "pr", ref: pr.number, title, url: pr.url });
    const why = tests.state === "failed" ? "The tests failed" : !allYes ? "A reviewer said no" : "A bigger change";
    const text = `${why}: ${title}\n${pr.url}\n\n${plan.description || ""}\n\nReviews: ${reviews.map((r) => `${cap(r.by)} ${r.yes ? "yes" : "no"}`).join(", ")}.\n${changed} changed line${changed === 1 ? "" : "s"} in ${n} file${n === 1 ? "" : "s"}.`;
    if (this.tg?.configured && this.ownerChatId) {
      const msg = await this.tg.sendMessage(this.ownerChatId, text, { buttons: [[{ text: "Approve", data: `approve:${id}` }, { text: "Reject", data: `reject:${id}` }]] });
      this.store.setApprovalMessage(id, this.ownerChatId, msg.message_id);
    } else this.log("[chip] no Telegram owner chat: the pull request waits on GitHub");
    await this.status(`Waiting for the owner: ${title}`);
    this.store.jobDone({ at: now, helper: "chip", job: "pr", ok: true, costMicro: cost, note: title });
    return { done: true, merged: false, pr, approvalId: id, changed, small, reviews };
  }

  /// What is wrong with a plan, as one sentence, or null when it can be applied.
  check(plan) {
    if (!plan || typeof plan !== "object") return "the model did not answer with JSON";
    if (plan.refuse) return String(plan.refuse).slice(0, 200);
    if (!Array.isArray(plan.files) || !plan.files.length) return "no files in the change";
    if (plan.files.length > 8) return "too many files in one change";
    for (const f of plan.files) {
      if (!f || typeof f.path !== "string" || typeof f.content !== "string") return "a file without a path or content";
      const p = f.path.replace(/^\.?\//, "");
      if (p !== f.path || p.includes("..") || !TEXT_KIND.test(p)) return `the path ${f.path} is not allowed`;
      if (isProtected(p)) return `the path ${p} is protected`;
      if (SECRET_SHAPE.test(f.content)) return `the content of ${p} looks like it holds a key or a token`;
      if (f.content.length > 400_000) return `${p} is too large`;
    }
    return null;
  }

  /// The other brownies' yes or no on the diff, each one a "note" report in its own name.
  async review(pr, title, description, diff) {
    const out = [];
    for (const by of this.reviewers) {
      try {
        const system = systemPrompt({ name: cap(by), role: REVIEW_ROLE[by] || "reviewer", facts: this.facts, extra: REVIEW_RULES });
        const question = `TITLE: ${title}\nDESCRIPTION: ${description}\n\nDIFF:\n${diff}\n\nIs it safe and correct to merge? YES or NO first, then one sentence.`;
        let v = await this.brain.yesNo(by, { system, prompt: question });
        let why = cut(v.text.replace(/^\W*(yes|no)\W*/i, ""), 300);
        if (!why) {
          // a bare word, or nothing: ask once more for the sentence, so a no is never without its reason
          this.log(`[chip] ${by}'s review came back without a reason (${JSON.stringify(v.text).slice(0, 80)}), asking again`);
          const again = await this.brain.yesNo(by, { system, prompt: question + "\n\nAnswer with YES or NO, a comma, and then the one sentence that says why." });
          v = { yes: again.yes, text: again.text, costMicro: v.costMicro + again.costMicro };
          why = cut(v.text.replace(/^\W*(yes|no)\W*/i, ""), 300) || "(no reason given)";
        }
        out.push({ by, yes: v.yes, text: why, cost: v.costMicro });
        await this.gateway.report({ helper: by, kind: "note", title: `Reviewed Chip's change #${pr.number}: ${v.yes ? "yes" : "no"}`, body: out[out.length - 1].text, url: pr.url, place: "github", cost_micro: v.costMicro });
      } catch (e) {
        out.push({ by, yes: false, text: `could not review (${cut(e.message, 80)})`, cost: 0 });
      }
    }
    return out;
  }

  /// The owner's decision from the Telegram buttons. Merges or closes, reports, and rewrites the message.
  async decide(id, decision, ctx = null) {
    const a = this.store.approval(id);
    if (!a || a.state !== "pending") return false;
    const now = this.clock.now();
    const n = Number(a.ref);
    if (decision === "approve") {
      // even the owner's yes waits for the tests: a red check is told, not merged
      const tests = this.patch ? await this.patch.verify({ number: n, url: a.url, html_url: a.url }) : { state: "none" };
      if (tests.state === "failed") {
        if (ctx?.messageId && this.tg) await this.tg.editMessageText(ctx.chatId, ctx.messageId, `Not merged: the tests fail on ${a.title}
${a.url}
Fix them (or ask Chip to) and press Approve again.`).catch(() => {});
        else if (this.tg?.configured && this.ownerChatId) await this.tg.sendMessage(this.ownerChatId, `Not merged: the tests fail on ${a.title}
${a.url}`);
        return false;
      }
      this.store.decide(id, "approved", null, now);
      await this.github.mergePR(n, { title: a.title });
      await this.report("build", a.title, { body: "Approved by the owner.", url: a.url, place: "github" });
      if (ctx?.messageId && this.tg) await this.tg.editMessageText(ctx.chatId, ctx.messageId, `Merged: ${a.title}\n${a.url}`).catch(() => {});
    } else {
      this.store.decide(id, "rejected", null, now);
      await this.github.closePR(n);
      await this.github.comment(n, "Closed: the owner rejected this change.").catch(() => {});
      await this.report("note", `Closed by the owner: ${a.title}`, { url: a.url, place: "github" });
      if (ctx?.messageId && this.tg) await this.tg.editMessageText(ctx.chatId, ctx.messageId, `Rejected and closed: ${a.title}\n${a.url}\nReply to this message with a note and Chip will add it to the pull request.`).catch(() => {});
    }
    return true;
  }

  /// The owner's note after a rejection, added to the pull request.
  async addNote(id, text) {
    const a = this.store.approval(id);
    if (!a) return false;
    await this.github.comment(Number(a.ref), `Owner's note: ${cut(text, 1000)}`);
    this.store.setApprovalNote(id, cut(text, 1000));
    return true;
  }
}
