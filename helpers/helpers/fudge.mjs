// Fudge, marketing. Writes posts in the project's voice at fixed hours, and answers the mentions on X that ask
// something. Never the same post twice, never past its daily cap of posts or dollars. Facts come from facts.md
// and Nib's latest note, nothing else.
//
// Every post goes to two places at once: X and the website (the "posts" reports the site reads from the gateway).
// When X refuses (a banned or shadow-banned account, a dead token) or X is not configured, the post still goes
// out on the site and the owner is told once an hour; so the account can be taken down, the words cannot.
//
// The rules of X (lib/xrules.mjs) are checked on every text: no links, no addresses, no bait, no repeats, no
// hashtags in replies. An AI-written reply goes to the owner as a card and is posted on his Approve, because X's
// Automation rules (April 2026) want X's written approval before an AI reply bot runs on its own; /fudge replies
// auto turns that on once it is given. A fixed line that points to the bio answers anyone asking for the site,
// the contract or the chart; that one is not AI, so it goes out at once. A person who says stop is never
// answered again. Anyone claiming to be the owner, the team or support gets no answer and the owner is told.
import { Helper, ordinal } from "../lib/helper.mjs";
import { tidy, problems } from "../lib/voice.mjs";
import { cut, oneLine } from "../lib/text.mjs";
import { xProblems, X_RULES, BIO_LINE, LINK, ADDRESS, bare, wantsOptOut, asksForLink, claimsStaff, isSensitive, staffLikeName } from "../lib/xrules.mjs";
import { isSuggestion, flags as suggestionFlags, SUGGEST_LINE, noticeText } from "../lib/suggestions.mjs";

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
- At most 260 characters, one to three sentences, no title, no quotes around it, no hashtags, no links, no addresses, no @mentions.
- Say one true thing from the facts, in your own words. Make it concrete.
- Do not repeat an earlier post. Do not announce anything that is not in the facts.`;

const REPLY_RULES = `Your task now: answer a mention on X.
- At most 240 characters, one or two sentences, no hashtags, no greeting, no @handle (X adds it), no link, no address.
- Answer only what was asked, with the facts. If the facts do not cover it, say the docs on the site cover it, and the site is in our bio.
- Be kind and plain. Never argue about price. Never say you are a person.`;

/// How AI-written replies go out: a card for the owner (the default), at once, or not at all.
export const REPLY_MODES = ["approve", "auto", "off"];

/// A mention that asks something, once the handles and links are stripped.
export function isQuestion(text) {
  const t = String(text || "").replace(/@\w+/g, "").replace(/https?:\/\/\S+/g, "").trim();
  return /\?/.test(t) || /^(how|what|why|when|where|who|which|is|are|can|could|do|does|did|will|would|should|any)\b/i.test(t);
}

export class Fudge extends Helper {
  constructor(deps) {
    super("fudge", deps);
    this.x = deps.x;
    this.tg = deps.telegram || null;
    this.ownerChatId = String(deps.ownerChatId || "");
    this.page = deps.instagram || null; // the Facebook Page behind the Instagram account: every post goes there too (lib/instagram.mjs canPage)
    this.siteUrl = String(deps.siteUrl || "https://feedthebrownies.com").replace(/\/$/, "");
    this.topics = this.config.topics?.length ? this.config.topics : DEFAULT_TOPICS;
    this.maxPosts = this.config.maxPostsPerDay ?? 3;
    this.mediaOn = this.config.media === true; // pictures and videos on X need the media.write scope on the app; off until the owner connects it
    this.maxReplies = this.config.maxRepliesPerDay ?? 12;
    this.maxMedia = this.config.maxMediaPostsPerDay ?? 2; // clips and memes on X, counted apart from the text posts
    this.maxRepliesPerAuthor = this.config.maxRepliesPerAuthorPerDay ?? 2; // X: one answer per message, and no reply loops with one person
  }

  jobs() {
    return [
      { id: "fudge-post", helper: "fudge", daily: { hours: this.config.postHours || [9, 13, 18], minute: this.config.postMinute || 0 }, run: (slot) => this.guard("post", () => this.post(slot)) },
      { id: "fudge-mentions", helper: "fudge", every: (this.config.mentionsEveryMinutes || 20) * 60_000, run: () => this.guard("mentions", () => this.mentions()) },
    ];
  }

  /// "approve": every AI-written reply is a card, the owner's Approve posts it (the default; X's rules want X's
  /// written approval before an AI reply bot runs on its own). "auto": posted at once. "off": no replies. The
  /// owner's choice (/fudge replies) wins over the config.
  repliesMode() {
    const m = String(this.store.getMeta("fudge:replies") || this.config.replies || "approve");
    return REPLY_MODES.includes(m) ? m : "approve";
  }

  /// The topic of the day's nth post. Nib's note takes one slot a day when there is one.
  pickTopic(now, n) {
    const day = Math.floor(now / 86_400_000);
    const list = this.topics.filter((t) => this.store.latestNote || !/Nib/.test(t));
    return list[(day * 3 + n) % list.length];
  }

  /// Text posts made today, on X and on the site together (a post that only reached the site still counts).
  postsToday(now) { return this.store.postsToday("fudge", "x", "post", now) + this.store.postsToday("fudge", "site", "post", now); }
  /// Posts with a picture or a video made today (a clip, a meme): their own cap, so the words never crowd them out.
  mediaToday(now) { return this.store.postsToday("fudge", "x", "media", now) + this.store.postsToday("fudge", "site", "media", now); }
  /// The same text, wherever it went.
  hasPost(text) { return this.store.hasPost("x", text) || this.store.hasPost("site", text); }
  /// Replies drafted and waiting for the owner's Approve.
  pendingReplies() { return this.store.pendingApprovals().filter((a) => a.helper === "fudge" && a.kind === "x-reply").length; }
  /// Answers given to one author today (cards included).
  authorKey(authorId, now) { return `x:replies:${authorId}:${new Date(now).toISOString().slice(0, 10)}`; }

  /// One post, to X and to the site. Returns { id, url, text, place } or null when nothing was posted (cap,
  /// budget, or no clean text). `place` is "x" when X took it, "site" when only the site did. `slot.allowLinks`
  /// (the owner asked, in his own words, for a link or an address): the text may carry it, and it goes to the
  /// owner as a card instead of straight to X; the answer is then { approvalId, text }.
  async post(slot = {}) {
    const now = this.clock.now();
    const withMedia = Array.isArray(slot.media) && slot.media.length > 0;
    const made = withMedia ? this.mediaToday(now) : this.postsToday(now);
    if (withMedia ? made >= this.maxMedia : made >= this.maxPosts) { this.log(`[fudge] already ${made} ${withMedia ? "posts with files" : "posts"} today`); return null; }
    if (!(await this.ready())) return null;
    const nth = slot.nth || made + 1;
    await this.status(withMedia ? "Writing the words for a clip on X" : `Writing today's ${ordinal(nth)} post`);
    const recent = [...this.store.recentPosts("fudge", "x", "post", 12), ...this.store.recentPosts("fudge", "site", "post", 12)].slice(0, 12);
    const topic = slot.topic || this.pickTopic(now, made);
    const work = await this.todaysWork();
    const rules = slot.allowLinks ? `${POST_RULES}\n- The owner asked for this post himself: it may carry the link or the address in his words, exactly as he wrote it.\n\n${X_RULES}` : `${POST_RULES}\n\n${X_RULES}`;
    let text = null, cost = 0, lastProblems = [];
    for (let attempt = 0; attempt < 3 && !text; attempt++) {
      const prompt = [
        `Topic: ${topic}.`,
        recent.length ? `Earlier posts, do not repeat them:\n${recent.map((p) => "- " + oneLine(p)).join("\n")}` : "",
        work,
        attempt ? `The last try was refused (${lastProblems.join(", ")}). Write it again with different words.` : "",
        "Write the post now.",
      ].filter(Boolean).join("\n\n");
      const r = await this.think({ system: this.system(rules), prompt, maxTokens: 200, temperature: 0.8 });
      cost += r.costMicro;
      const t = tidy(r.text).replace(/\n+/g, " ");
      lastProblems = [...problems(t, { maxLen: 270, maxHashtags: 1 }), ...xProblems(t, { kind: "post", recent, approved: Boolean(slot.allowLinks) })];
      if (this.hasPost(t)) lastProblems.push("same as an earlier post");
      if (!lastProblems.length) text = t;
      else this.log(`[fudge] draft refused: ${lastProblems.join(", ")}`);
    }
    if (!text) {
      await this.status("Could not write a post that passed the checks");
      this.store.jobDone({ at: now, helper: "fudge", job: "post", ok: false, costMicro: cost, note: lastProblems.join(", ") });
      return null;
    }
    // the owner's own link or address: X reads links as spam and the rule forbids them, so his Approve posts it
    if (slot.allowLinks && (LINK.test(text) || ADDRESS.test(text))) return this.card({ kind: "x-post", text, cost, now, why: "a post with a link or an address. X gives posts with links less reach and the rule is no links on X; your Approve posts it anyway" });
    // X first, the site always. A refusal by X is not the end of the post.
    let posted = null;
    const mediaIds = [];
    if (this.x?.configured && Array.isArray(slot.media) && slot.media.length) {
      for (const f of slot.media.slice(0, 4)) {
        try { mediaIds.push((await this.x.uploadMedia(f)).mediaId); }
        catch (e) { this.log(`[fudge] X did not take the file ${f}: ${cut(e.message, 100)}`); if (e.credentials) await this.alerts?.credentials("x", e.message); }
      }
      if (!mediaIds.length) { this.log("[fudge] no file went up: the post waits for the next try"); this.store.jobDone({ at: now, helper: "fudge", job: "post", ok: false, costMicro: cost, note: "media upload failed" }); return null; }
    }
    if (this.x?.configured) {
      try { posted = await this.x.post(text, { mediaIds }); }
      catch (e) {
        if (e.budget) throw e;
        this.log(`[fudge] X refused the post (${cut(e.message, 100)}); it goes out on the site only`);
        if (e.credentials) await this.alerts?.credentials("x", e.message);
        else await this.alerts?.failure("fudge", "post on X", cut(e.message, 200));
      }
    } else this.log("[fudge] X is not configured: the post goes out on the site only");
    const place = posted ? "x" : "site";
    const url = posted ? posted.url : `${this.siteUrl}/posts.html`;
    this.store.addPost({ at: now, helper: "fudge", place, kind: withMedia ? "media" : "post", text, externalId: posted?.id || null, url });
    await this.toPage(text, withMedia ? "a post with files, words only" : "post");
    await this.report("post", cut(text, 160), { body: text.length > 160 ? text : null, url, place, cost_micro: cost });
    return { id: posted?.id || null, url, text, place };
  }

  /// The same words on the Facebook Page, when the owner allowed it. Never stops the post: a refusal is a log line.
  async toPage(text, what = "post") {
    if (!this.page?.canPage?.()) return null;
    try { const fb = await this.page.pagePost({ message: text }); this.log(`[fudge] the ${what} is on the Facebook Page too: ${fb.url}`); return fb; }
    catch (e) { this.log(`[fudge] Facebook did not take the ${what}: ${cut(e.message, 120)}`); return null; }
  }

  /// A text that waits for the owner: a card on Telegram with Approve and Reject. Returns { approvalId, text }.
  async card({ kind, text, cost = 0, now, why = "", replyTo = null, author = null, asked = "" }) {
    const id = this.store.addApproval({ at: now, helper: "fudge", kind, ref: replyTo || "", title: cut(text, 120), url: replyTo ? `https://x.com/i/status/${replyTo}` : null });
    this.store.setMeta(`fudge:card:${id}`, JSON.stringify({ kind, text, replyTo, author, cost }));
    const head = replyTo
      ? `Fudge, a reply to @${author || "someone"} on X (https://x.com/i/status/${replyTo}).\nThey wrote: ${cut(oneLine(asked), 200)}`
      : `Fudge, ${why}.`;
    const tail = replyTo ? "Approve posts it. AI replies go out by hand until X approves an AI reply bot for the account; /fudge replies auto turns that on." : "Approve posts it as it is.";
    if (this.tg?.configured && this.ownerChatId) {
      const msg = await this.tg.sendMessage(this.ownerChatId, `${head}\n\n${text}\n\n${tail}`, { buttons: [[{ text: "Approve", data: `approve:${id}` }, { text: "Reject", data: `reject:${id}` }]] });
      this.store.setApprovalMessage(id, this.ownerChatId, msg.message_id);
    } else this.log(`[fudge] no owner chat: the ${kind} waits in the store`);
    this.store.jobDone({ at: now, helper: "fudge", job: replyTo ? "reply" : "post", ok: true, costMicro: cost, note: `waiting for the owner: ${cut(text, 80)}` });
    return { approvalId: id, text };
  }

  /// The owner decided on a card (Crumb routes the button here). Approve posts the text to X as it is.
  async decide(id, decision) {
    const a = this.store.approval(id);
    if (!a || !/^x-(reply|post)$/.test(a.kind)) return false;
    let rec = null;
    try { rec = JSON.parse(this.store.getMeta(`fudge:card:${id}`) || "null"); } catch { rec = null; }
    if (!rec) return false;
    const now = this.clock.now();
    this.store.decide(id, decision === "approve" ? "approved" : "rejected", null, now);
    this.store.setMeta(`fudge:card:${id}`, null);
    const kind = rec.replyTo ? "reply" : "post";
    if (decision !== "approve") { this.log(`[fudge] the owner rejected the ${kind}`); return true; }
    if (!this.x?.configured) { this.log("[fudge] X is not configured: the approved text cannot go out"); return false; }
    try {
      const posted = await this.x.post(rec.text, { replyTo: rec.replyTo || null, approved: true });
      this.store.addPost({ at: now, helper: "fudge", place: "x", kind, text: rec.text, ref: rec.replyTo || "", externalId: posted.id, url: posted.url });
      if (kind === "post") await this.toPage(rec.text, "approved post");
      await this.report(kind, kind === "reply" ? `Answered @${rec.author || "someone"}: ${cut(rec.text, 120)}` : cut(rec.text, 160), { body: kind === "post" && rec.text.length > 160 ? rec.text : null, url: posted.url, place: "x", cost_micro: 0 });
      if (this.tg?.configured && this.ownerChatId) await this.tg.sendMessage(this.ownerChatId, `Posted: ${posted.url}`);
      return true;
    } catch (e) {
      this.log(`[fudge] X refused the approved ${kind}: ${cut(e.message, 120)}`);
      if (e.credentials) await this.alerts?.credentials("x", e.message);
      else await this.alerts?.failure("fudge", kind, cut(e.message, 200));
      return false;
    }
  }

  /// The owner's instruction (the control room, or /fudge on Telegram). "replies auto|approve|off|status" sets how
  /// replies go out and answers with a line; anything else is the topic of one post now, within the caps. A link
  /// or an address in the owner's own words is allowed in that post, which then comes back as a card.
  async onRequest(text) {
    const t = String(text || "").trim();
    const m = t.match(/^repl(?:y|ies)\s*(auto|approve|off|status)?\s*$/i);
    if (m) {
      const want = (m[1] || "status").toLowerCase();
      if (want !== "status") { this.store.setMeta("fudge:replies", want); this.log(`[fudge] replies: ${want}`); }
      const mode = this.repliesMode();
      const what = mode === "auto" ? "auto: posted at once (right only once X has approved an AI reply bot for the account)"
        : mode === "approve" ? "approve: each AI-written reply is a card and your Approve posts it; the fixed bio line goes out at once"
        : "off: no replies at all";
      return `Replies on X, ${what}. ${this.pendingReplies()} waiting for you, ${this.store.postsToday("fudge", "x", "reply", this.clock.now())} posted today.`;
    }
    const allowLinks = LINK.test(t) || ADDRESS.test(t);
    return this.guard("post", () => this.post({ topic: t, allowLinks }));
  }

  /// A post with pictures or a video (a trend's version made by Sprinkle): Fudge writes the words, X gets the files.
  /// Null while media posting is off (config media: true once the app may upload) or X is not configured.
  async postMedia({ topic, files = [] }) {
    if (!this.mediaOn) { this.log("[fudge] media posting is off: the file stays with the owner"); return null; }
    if (!this.x?.configured || !files.length) return null;
    return this.guard("post", () => this.post({ topic: String(topic || "").trim(), media: files }));
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

  /// A suggestion from a mention: kept for the owner's list, never acted on; the owner hears about new ones at most
  /// once an hour.
  async keepSuggestion(t, f, now) {
    if (this.store.seen("suggestion", `x:${t.id}`)) return null;
    this.store.markSeen("suggestion", `x:${t.id}`, now);
    const id = this.store.addSuggestion({ at: now, place: "x", who: t.author || null, whoId: t.authorId, text: t.text, flags: f, ref: t.id, url: `https://x.com/i/status/${t.id}` });
    this.log(`[fudge] suggestion ${id} from @${t.author || "someone"} kept for the owner${f.length ? ` (${f.join(", ")})` : ""}`);
    await this.alerts?.send("suggestions", noticeText(this.store, now, this.siteUrl));
    return id;
  }

  /// Reads new mentions and answers the ones that ask something, by the rules of X: never an author who said stop,
  /// never a staff claim or sensitive words, at most two answers per author a day, the bio line for link and
  /// contract asks (no model), and an AI-written answer as a card for the owner unless replies are "auto".
  /// Returns how many were answered or put on a card.
  async mentions() {
    if (!this.x?.configured) return 0;
    const mode = this.repliesMode();
    const now = this.clock.now();
    const sinceId = this.store.getMeta("x:mentions:since");
    const res = await this.x.mentions({ sinceId });
    if (res.newestId) this.store.setMeta("x:mentions:since", res.newestId);
    const me = await this.x.me();
    let answered = 0;
    for (const t of res.tweets) {
      if (this.store.seen("x-mention", t.id)) continue;
      this.store.markSeen("x-mention", t.id, now);
      if (t.authorId === me.id) continue;
      const author = t.author || "someone";
      if (this.store.getMeta(`x:optout:${t.authorId}`)) continue; // asked to be left alone, for good
      if (wantsOptOut(t.text)) { this.store.setMeta(`x:optout:${t.authorId}`, String(now)); this.log(`[fudge] @${author} asked to be left alone: never answered again`); continue; }
      if (claimsStaff(t.text) || staffLikeName(author)) {
        this.log(`[fudge] @${author} claims to be the owner, the team or support: no answer, the owner told`);
        await this.alerts?.send(`x:staff:${t.authorId}`, `@${author} on X says they are the owner, the team or support: "${cut(bare(t.text), 140)}". Fudge did not answer. The owner never speaks through X, so this is an impersonation unless you know better: https://x.com/i/status/${t.id}`);
        continue;
      }
      if (isSensitive(t.text) || isSensitive(author)) { this.log(`[fudge] mention ${t.id} carries sensitive words: no answer`); continue; }
      let suggested = null; // a suggestion: kept for the owner, answered with one fixed line unless it carries bait
      if (isSuggestion(t.text)) {
        const f = suggestionFlags(t.text);
        await this.keepSuggestion(t, f, now);
        if (f.length) continue; // a link, an address, another coin or drainer words: no answer at all, so bait is never amplified
        suggested = SUGGEST_LINE;
      }
      if (!suggested && !isQuestion(t.text)) continue;
      if (mode === "off") { this.log("[fudge] replies are off"); break; }
      const byAuthor = Number(this.store.getMeta(this.authorKey(t.authorId, now)) || 0);
      if (byAuthor >= this.maxRepliesPerAuthor) { this.log(`[fudge] @${author} already had ${byAuthor} answers today`); continue; }
      if (this.store.postsToday("fudge", "x", "reply", now) + this.pendingReplies() >= this.maxReplies) { this.log("[fudge] reply cap for today"); break; }
      let text, cost = 0;
      if (suggested) text = suggested; // the owner reads it and decides: one fixed line, no model
      else if (asksForLink(t.text)) text = BIO_LINE; // the site, the docs and the contract live in the bio: one fixed line, no model
      else {
        if (!(await this.ready())) break;
        if (!answered) await this.status("Answering mentions on X");
        const r = await this.think({ system: this.system(`${REPLY_RULES}\n\n${X_RULES}`), prompt: `@${author} wrote: ${oneLine(bare(t.text))}\n\nWrite the reply.`, maxTokens: 160, temperature: 0.5 });
        cost = r.costMicro;
        text = tidy(r.text).replace(/\n+/g, " ").replace(/^@\w+[:,]?\s*/, "");
        const bad = [...problems(text, { maxLen: 270, maxHashtags: 0 }), ...xProblems(text, { kind: "reply" })];
        if (bad.length) { this.log(`[fudge] reply refused: ${bad.join(", ")}`); continue; }
      }
      this.store.setMeta(this.authorKey(t.authorId, now), String(byAuthor + 1));
      if (mode === "auto" || text === BIO_LINE || text === SUGGEST_LINE) {
        const posted = await this.x.post(text, { replyTo: t.id });
        this.store.addPost({ at: now, helper: "fudge", place: "x", kind: "reply", text, ref: t.id, externalId: posted.id, url: posted.url });
        await this.report("reply", `Answered @${author}: ${cut(text, 120)}`, { url: posted.url, place: "x", cost_micro: cost });
      } else {
        await this.card({ kind: "x-reply", text, cost, now, replyTo: t.id, author, asked: bare(t.text) });
      }
      answered++;
    }
    return answered;
  }
}
