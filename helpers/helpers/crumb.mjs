// Crumb, community. Listens to Telegram with long polling and answers within a minute: in the group, the
// messages that are questions or name the bot or the brownies; in private chats, everyone. Short answers, numbers
// only from the facts, Nib's note and the gateway's live figures. Reports its answers once an hour per chat.
// Crumb also carries the owner's approval buttons for Chip (Approve / Reject) and the owner's reject note.
import { Helper } from "../lib/helper.mjs";
import { tidy, problems } from "../lib/voice.mjs";
import { cut } from "../lib/text.mjs";

const RULES = `Your task now: answer a message in a Telegram chat.
- Two to four short sentences at most. No greeting, no sign-off, no markdown, no bullet points.
- Answer only what was asked. If the facts do not cover it, say so and point to https://feedthebrownies.com/docs.html
- Numbers only from the facts or the live numbers below. Never guess a number or a date.
- Never argue about price. Never tell anyone to buy or sell.
- If someone asks for a private key, a seed phrase or money, say no in one sentence.`;

const FALLBACK = "I do not have a good answer for that one. The docs have the details: https://feedthebrownies.com/docs.html";

export class Crumb extends Helper {
  constructor(deps) {
    super("crumb", deps);
    this.tg = deps.telegram;
    this.groupChatId = String(deps.groupChatId || "");
    this.ownerChatId = String(deps.ownerChatId || "");
    this.onDecision = deps.onDecision || null;   // (approvalId, "approve" | "reject", { chatId, messageId })
    this.onNote = deps.onNote || null;           // (approvalId, text)
    this.live = { at: 0, text: "" };
    this.running = false;
    this.answered = 0;
    this.batchAge = (this.config.reportEveryMinutes || 60) * 60_000;
    this.idleWait = 1000;
  }

  jobs() {
    return [{ id: "crumb-flush", helper: "crumb", every: 5 * 60_000, initialDelay: 60_000, run: () => this.guard("flush", () => this.flush()) }];
  }

  /// Starts the polling loop (not awaited). It runs until stop().
  async start() {
    if (!this.tg?.configured) { this.log("[crumb] Telegram is not configured, not listening"); return false; }
    this.running = true;
    await this.status("Listening on Telegram");
    this.loop = (async () => {
      while (this.running) {
        try {
          const n = await this.pollOnce();
          if (!n && this.running) await this.clock.sleep(this.idleWait); // Telegram's long poll paces this; a short pause keeps it polite when it returns at once
        } catch (e) {
          if (e.credentials) { await this.alerts?.credentials("telegram", e.message); this.running = false; break; }
          this.log(`[crumb] poll failed: ${e.message}`);
          await this.clock.sleep(5000);
        }
      }
    })();
    return true;
  }
  /// Ends the loop after the poll in flight (a long poll can take up to 25 seconds; nothing waits on it).
  stop() { this.running = false; }

  /// One getUpdates call and the handling of what came. Returns the number of updates.
  async pollOnce({ timeout = 25 } = {}) {
    const offset = Number(this.store.getMeta("tg:offset", 0));
    const updates = await this.tg.getUpdates({ offset, timeout });
    for (const u of updates) {
      this.store.setMeta("tg:offset", u.update_id + 1);
      try { await this.handle(u); } catch (e) { if (e.credentials) throw e; this.log(`[crumb] update ${u.update_id} failed: ${e.message}`); }
    }
    return updates.length;
  }

  async handle(u) {
    if (u.callback_query) return this.callback(u.callback_query);
    const m = u.message;
    if (!m || typeof m.text !== "string" || !m.text.trim()) return null;
    const chatId = String(m.chat.id);
    const isOwner = this.ownerChatId && chatId === this.ownerChatId;
    // the owner answering "Reply to this message with a note": the note goes to the pull request
    if (isOwner && m.reply_to_message) {
      const a = this.store.approvalByMessage(chatId, m.reply_to_message.message_id);
      if (a && a.state === "rejected" && this.onNote) { await this.onNote(a.id, m.text.trim()); await this.tg.sendMessage(chatId, "Added your note to the pull request.", { replyTo: m.message_id }); return "note"; }
    }
    if (m.chat.type === "private" || isOwner) return this.answer(m);
    if (chatId === this.groupChatId || (!this.groupChatId && /group/.test(m.chat.type || ""))) {
      const me = await this.tg.me().catch(() => null);
      if (!this.wantsAnswer(m.text, me?.username)) return null;
      return this.answer(m);
    }
    return null; // a chat the bot was not told about
  }

  /// In the group: questions, and messages that name the bot or the brownies. Chatter is left alone.
  wantsAnswer(text, botUsername = "") {
    const t = String(text).trim();
    if (t.startsWith("/")) return /^\/(start|help|ask|brownies)\b/i.test(t);
    if (/\?/.test(t)) return true;
    if (botUsername && t.toLowerCase().includes("@" + botUsername.toLowerCase())) return true;
    return /\b(brownies?|crumb|fudge|nib|chip)\b/i.test(t);
  }

  /// Answers one message with the facts, the live numbers and the last turns of that chat.
  async answer(m) {
    const now = this.clock.now();
    const chat = String(m.chat.id);
    const who = m.from?.first_name || m.from?.username || "someone";
    this.store.addTurn(chat, "user", m.text.trim(), { who, at: now });
    if (!(await this.ready())) return null;
    await this.tg.sendChatAction(chat, "typing");
    const turns = this.store.turns(chat, 10);
    const messages = turns.map((t) => ({ role: t.role === "user" ? "user" : "assistant", content: t.role === "user" ? `${t.who || "someone"}: ${t.text}` : t.text }));
    const r = await this.think({ system: this.system(RULES + "\n\n" + (await this.liveNumbers())), messages, maxTokens: 300, temperature: 0.5 });
    let text = tidy(r.text);
    const bad = problems(text, { maxLen: 1500, maxHashtags: 3 });
    if (bad.length) { this.log(`[crumb] answer refused (${bad.join(", ")}), using the fallback`); text = FALLBACK; }
    await this.tg.sendMessage(chat, text, { replyTo: m.message_id });
    this.store.addTurn(chat, "assistant", text, { at: now });
    this.store.countAnswer(chat, now);
    this.store.setMeta(`tg:batchcost:${chat}`, Number(this.store.getMeta(`tg:batchcost:${chat}`, 0)) + r.costMicro);
    this.answered++;
    return text;
  }

  /// The gateway's public figures, re-read every 5 minutes, as a block for the prompt. Empty when unreachable.
  async liveNumbers() {
    const now = this.clock.now();
    if (now - this.live.at < 5 * 60_000) return this.live.text;
    const [stats, summary] = await Promise.all([this.gateway.stats(), this.gateway.summary()]);
    const parts = [];
    if (stats.ok && stats.body) parts.push(`protocol stats: ${cut(JSON.stringify(stats.body), 900)}`);
    if (summary.ok && summary.body) parts.push(`team summary: ${cut(JSON.stringify({ total: summary.body.total, week: summary.body.week, helpers: (summary.body.helpers || []).map((h) => ({ helper: h.helper, today: h.today, total: h.total, status: h.status?.title })) }), 900)}`);
    this.live = { at: now, text: parts.length ? `LIVE NUMBERS, read from the gateway just now (JSON; quote only what answers the question):\n${parts.join("\n")}` : "" };
    return this.live.text;
  }

  /// One report per chat per hour: "Answered N questions in the group".
  async flush() {
    const now = this.clock.now();
    let n = 0;
    for (const b of this.store.dueBatches(now, this.batchAge)) {
      const where = b.chat === this.groupChatId ? "in the group" : b.chat === this.ownerChatId ? "for the owner" : "in a private chat";
      const cost = Number(this.store.getMeta(`tg:batchcost:${b.chat}`, 0));
      await this.report("reply", `Answered ${b.count} question${b.count === 1 ? "" : "s"} ${where}`, { place: "telegram", cost_micro: cost });
      this.store.resetBatch(b.chat);
      this.store.setMeta(`tg:batchcost:${b.chat}`, null);
      n++;
    }
    return n;
  }

  /// A press on Approve or Reject. Only the owner's press counts; the decision itself is Chip's.
  async callback(cq) {
    const m = String(cq.data || "").match(/^(approve|reject):(\d+)$/);
    if (!m) return this.tg.answerCallbackQuery(cq.id, "Unknown button.");
    const chatId = String(cq.message?.chat?.id || "");
    if (!this.ownerChatId || (chatId !== this.ownerChatId && String(cq.from?.id || "") !== this.ownerChatId)) return this.tg.answerCallbackQuery(cq.id, "Only the owner decides.");
    const a = this.store.approval(Number(m[2]));
    if (!a) return this.tg.answerCallbackQuery(cq.id, "Nothing to decide.");
    if (a.state !== "pending") return this.tg.answerCallbackQuery(cq.id, "Already decided.");
    await this.tg.answerCallbackQuery(cq.id, m[1] === "approve" ? "Approved." : "Rejected.");
    if (this.onDecision) await this.onDecision(a.id, m[1], { chatId, messageId: cq.message?.message_id });
    return m[1];
  }
}
