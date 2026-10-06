// Fudge, marketing. Writes posts in the project's voice at fixed hours, and answers the mentions on X that ask
// something. Never the same post twice, never past its daily cap of posts or dollars. Facts come from facts.md
// and Nib's latest note, nothing else.
//
// Every post goes to two places at once: X and the website (the "posts" reports the site reads from the gateway).
// When X refuses (a banned or shadow-banned account, a dead token) or X is not configured, the post still goes
// out on the site and the owner is told once an hour; so the account can be taken down, the words cannot.
import { Helper, ordinal } from "../lib/helper.mjs";
import { tidy, problems } from "../lib/voice.mjs";
import { cut, oneLine } from "../lib/text.mjs";

const DEFAULT_TOPICS = [
  "how a trade turns into SUGAR for stakers",
  "what the four brownies do, in one line each",
  "the loyalty bonus for stakers who stay",
  "the Kitchen page: what the brownies did today",
  "the fixed split of the tax and the three switches the team holds",
  "SUGAR as an API key: one signature, every model on OpenRouter",
  "what Nib found in its latest research note",
  "how to tip a brownie",
  "what the team vault releases each day",
  "one thing from the docs that people often ask about",
];

const POST_RULES = `Your task now: write ONE post for X.
- At most 260 characters, one to three sentences, no title, no quotes around it, no hashtags, no links unless asked.
- Say one true thing from the facts, in your own words. Make it concrete.
- Do not repeat an earlier post. Do not announce anything that is not in the facts.`;

const REPLY_RULES = `Your task now: answer a mention on X.
- At most 240 characters, one or two sentences, no hashtags, no greeting.
- Answer only what was asked, with the facts. If the facts do not cover it, say the docs do: https://feedthebrownies.com/docs.html
- Be kind and plain. Never argue about price.`;

/// A mention that asks something, once the handles and links are stripped.
export function isQuestion(text) {
  const t = String(text || "").replace(/@\w+/g, "").replace(/https?:\/\/\S+/g, "").trim();
  return /\?/.test(t) || /^(how|what|why|when|where|who|which|is|are|can|could|do|does|did|will|would|should|any)\b/i.test(t);
}

export class Fudge extends Helper {
  constructor(deps) {
    super("fudge", deps);
    this.x = deps.x;
    this.siteUrl = String(deps.siteUrl || "https://feedthebrownies.com").replace(/\/$/, "");
    this.topics = this.config.topics?.length ? this.config.topics : DEFAULT_TOPICS;
    this.maxPosts = this.config.maxPostsPerDay ?? 3;
    this.maxReplies = this.config.maxRepliesPerDay ?? 12;
  }

  jobs() {
    return [
      { id: "fudge-post", helper: "fudge", daily: { hours: this.config.postHours || [9, 13, 18], minute: this.config.postMinute || 0 }, run: (slot) => this.guard("post", () => this.post(slot)) },
      { id: "fudge-mentions", helper: "fudge", every: (this.config.mentionsEveryMinutes || 20) * 60_000, run: () => this.guard("mentions", () => this.mentions()) },
    ];
  }

  /// The topic of the day's nth post. Nib's note takes one slot a day when there is one.
  pickTopic(now, n) {
    const day = Math.floor(now / 86_400_000);
    const list = this.topics.filter((t) => this.store.latestNote || !/Nib/.test(t));
    return list[(day * 3 + n) % list.length];
  }

  /// Posts made today, on X and on the site together (a post that only reached the site still counts).
  postsToday(now) { return this.store.postsToday("fudge", "x", "post", now) + this.store.postsToday("fudge", "site", "post", now); }
  /// The same text, wherever it went.
  hasPost(text) { return this.store.hasPost("x", text) || this.store.hasPost("site", text); }

  /// One post, to X and to the site. Returns { id, url, text, place } or null when nothing was posted (cap,
  /// budget, or no clean text). `place` is "x" when X took it, "site" when only the site did.
  async post(slot = {}) {
    const now = this.clock.now();
    const made = this.postsToday(now);
    if (made >= this.maxPosts) { this.log(`[fudge] already ${made} posts today`); return null; }
    if (!(await this.ready())) return null;
    const nth = slot.nth || made + 1;
    await this.status(`Writing today's ${ordinal(nth)} post`);
    const recent = [...this.store.recentPosts("fudge", "x", "post", 12), ...this.store.recentPosts("fudge", "site", "post", 12)].slice(0, 12);
    const topic = slot.topic || this.pickTopic(now, made);
    const work = await this.todaysWork();
    let text = null, cost = 0, lastProblems = [];
    for (let attempt = 0; attempt < 3 && !text; attempt++) {
      const prompt = [
        `Topic: ${topic}.`,
        recent.length ? `Earlier posts, do not repeat them:\n${recent.map((p) => "- " + oneLine(p)).join("\n")}` : "",
        work,
        attempt ? `The last try was refused (${lastProblems.join(", ")}). Write it again with different words.` : "",
        "Write the post now.",
      ].filter(Boolean).join("\n\n");
      const r = await this.think({ system: this.system(POST_RULES), prompt, maxTokens: 200, temperature: 0.8 });
      cost += r.costMicro;
      const t = tidy(r.text).replace(/\n+/g, " ");
      lastProblems = problems(t, { maxLen: 270, maxHashtags: 1 });
      if (this.hasPost(t)) lastProblems.push("same as an earlier post");
      if (!lastProblems.length) text = t;
      else this.log(`[fudge] draft refused: ${lastProblems.join(", ")}`);
    }
    if (!text) {
      await this.status("Could not write a post that passed the checks");
      this.store.jobDone({ at: now, helper: "fudge", job: "post", ok: false, costMicro: cost, note: lastProblems.join(", ") });
      return null;
    }
    // X first, the site always. A refusal by X is not the end of the post.
    let posted = null;
    if (this.x?.configured) {
      try { posted = await this.x.post(text); }
      catch (e) {
        if (e.budget) throw e;
        this.log(`[fudge] X refused the post (${cut(e.message, 100)}); it goes out on the site only`);
        if (e.credentials) await this.alerts?.credentials("x", e.message);
        else await this.alerts?.failure("fudge", "post on X", cut(e.message, 200));
      }
    } else this.log("[fudge] X is not configured: the post goes out on the site only");
    const place = posted ? "x" : "site";
    const url = posted ? posted.url : `${this.siteUrl}/posts.html`;
    this.store.addPost({ at: now, helper: "fudge", place, kind: "post", text, externalId: posted?.id || null, url });
    await this.report("post", cut(text, 160), { body: text.length > 160 ? text : null, url, place, cost_micro: cost });
    return { id: posted?.id || null, url, text, place };
  }

  /// The owner's instruction (the control room, or /fudge on Telegram): one post on that topic, now, within the caps.
  async onRequest(text) {
    return this.guard("post", () => this.post({ topic: String(text || "").trim() }));
  }

  /// What the brownies did today, from the gateway's team summary, as a block for the prompt ("" when unreachable).
  /// So a post about the Kitchen says what really happened, and never invents a job.
  async todaysWork() {
    const r = await this.gateway.summary();
    if (!r.ok || !r.body) return "";
    const rows = (r.body.helpers || []).map((h) => `- ${h.helper}: ${h.today ?? 0} job${h.today === 1 ? "" : "s"} today, ${h.total ?? 0} in all${h.status?.title ? `, now: ${oneLine(h.status.title)}` : ""}`);
    if (!rows.length) return "";
    return `TODAY'S WORK, read from the Kitchen just now (quote only what is here, never a job that is not listed):\n${rows.join("\n")}`;
  }

  /// Reads new mentions and answers the ones that ask something. Returns how many were answered.
  async mentions() {
    if (!this.x?.configured) return 0;
    const now = this.clock.now();
    const sinceId = this.store.getMeta("x:mentions:since");
    const res = await this.x.mentions({ sinceId });
    if (res.newestId) this.store.setMeta("x:mentions:since", res.newestId);
    const me = await this.x.me();
    let answered = 0;
    for (const t of res.tweets) {
      if (this.store.seen("x-mention", t.id)) continue;
      this.store.markSeen("x-mention", t.id, now);
      if (t.authorId === me.id || !isQuestion(t.text)) continue;
      if (this.store.postsToday("fudge", "x", "reply", now) >= this.maxReplies) { this.log("[fudge] reply cap for today"); break; }
      if (!(await this.ready())) break;
      if (!answered) await this.status("Answering mentions on X");
      const r = await this.think({ system: this.system(REPLY_RULES), prompt: `@${t.author || "someone"} wrote: ${oneLine(t.text)}\n\nWrite the reply.`, maxTokens: 160, temperature: 0.5 });
      const text = tidy(r.text).replace(/\n+/g, " ");
      const bad = problems(text, { maxLen: 270, maxHashtags: 1 });
      if (bad.length) { this.log(`[fudge] reply refused: ${bad.join(", ")}`); continue; }
      const posted = await this.x.post(text, { replyTo: t.id });
      this.store.addPost({ at: now, helper: "fudge", place: "x", kind: "reply", text, ref: t.id, externalId: posted.id, url: posted.url });
      await this.report("reply", `Answered @${t.author || "someone"}: ${cut(text, 120)}`, { url: posted.url, place: "x", cost_micro: r.costMicro });
      answered++;
    }
    return answered;
  }
}
