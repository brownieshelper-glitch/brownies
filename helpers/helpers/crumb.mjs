// Crumb, community. Listens to Telegram with long polling and answers within a minute: in the group, the
// messages that are questions or name the bot or the brownies; in private chats, everyone. Short answers, numbers
// only from the facts, Nib's note and the gateway's live figures. Reports its answers once an hour per chat.
// Crumb also carries the owner's approval buttons for Chip (Approve / Reject) and the owner's reject note.
// The group: TELEGRAM_GROUP_CHAT_ID when set; otherwise Crumb adopts the first group it is added to (or hears a
// message in) and remembers it in the store, so the owner never has to look up a chat id.
// Once a day it writes the questions people asked into notes/questions/YYYY-MM-DD.md with a short answer each,
// so Chip can turn them into a FAQ page and the team sees what people want to know.
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
const ALLOWANCE = { burst: 5, day: 40, all: 150 };
/// A request for money, tokens or keys from someone who is not the owner: answered with a fixed line, never a model.
/// A verb with me/us and a money word ("send me 5$", "lend us some eth"), a key or seed phrase, a transfer to a wallet
/// or an address, or an amount with please. "send me the link" and "can I get SUGAR by staking?" go to the model.
const MONEY = String.raw`(\$|usd|usdc|dollars?|euros?|eth\b|ether\b|sugar|tokens?|coins?|money|funds|cash|gas|crypto|airdrop|bucks)`;
const AMOUNT = String.raw`(\$ ?\d|\d+ ?(\$|usd|usdc|dollars?|euros?|eth\b|bucks))`;
export const MONEY_ASK = new RegExp([
  String.raw`\b(send|lend|give|transfer|airdrop|pay|wire|loan|spot|drop|donate)\b[^.?!\n]{0,40}\b(me|us|him|her|them)\b[^.?!\n]{0,40}${MONEY}`,
  String.raw`\b(send|transfer|pay|airdrop|deposit|move)\b[^.?!\n]{0,60}\b(to|into|at) (my|this|our|the following) (wallet|address|addy|account)\b`,
  String.raw`\b(send|transfer|pay|airdrop)\b[^.?!\n]{0,60}0x[0-9a-fA-F]{40}`,
  String.raw`0x[0-9a-fA-F]{40}[^.?!\n]{0,40}\b(send|transfer|pay|airdrop)\b`,
  String.raw`\b(borrow|lend|loan)\b[^.?!\n]{0,30}${MONEY}`,
  String.raw`${AMOUNT}[^.?!\n]{0,30}\b(please|pls|plz)\b`,
  String.raw`\b(private|secret) keys?\b|\bseed phrases?\b|\bmnemonic\b|\brecovery phrase|\bwallet password|\bprivkeys?\b|\bpks?\b[^.?!\n]{0,30}\bwallets?\b|\bwallets?\b[^.?!\n]{0,30}\bpks?\b`,
].join("|"), "i");
export const MONEY_LINE = "The brownies hold no money, no tokens and no keys, and cannot send or promise anything to anyone. Only the owner moves funds, by hand. If you want to help the project, stake BROWNIE or tip a brownie from the app on the site."; // answers for one stranger's chat in ten minutes, in a day, and for all strangers in a day

const money = (micro) => `$${(Number(micro || 0) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const num = (n) => Number(n || 0).toLocaleString("en-US");

/// The /stats answer. Pre-launch: the Kitchen only. Live: the coin's numbers from the gateway's ledger and chain reads.
export function statsText(stats, summary) {
  const lines = [];
  const on = stats?.onchain && !stats.onchain.error ? stats.onchain : null;
  if (!stats || !on) {
    lines.push("BROWNIE is not launched yet, so there are no coin numbers to show.");
  } else {
    lines.push("BROWNIE, live numbers:");
    if (on.sugarActivatedMicro != null) lines.push(`- SUGAR turned into AI so far: ${money(on.sugarActivatedMicro)}`);
    if (on.totalStakersFundedMicro != null) lines.push(`- paid to stakers so far: ${money(on.totalStakersFundedMicro)}`);
    if (on.totalTeamFundedMicro != null) lines.push(`- fed to the brownies so far: ${money(on.totalTeamFundedMicro)}`);
    if (on.totalMainPaidWei != null) lines.push(`- to the team wallet so far: ${(Number(on.totalMainPaidWei) / 1e18).toFixed(4)} ETH`);
    if (on.programOn === false) lines.push("- the program is switched OFF right now");
    if (on.vaultDailyBudgetMicro != null) lines.push(`- the brownies' next daily budget: ${money(on.vaultDailyBudgetMicro)}`);
  }
  if (stats?.ledger) lines.push(`- AI requests served by the gateway: ${num(stats.ledger.requests)}, ${money(stats.ledger.spentMicro)} spent`);
  if (summary?.helpers?.length) {
    const today = summary.helpers.map((h) => `${h.helper} ${num(h.today)}`).join(", ");
    lines.push(`- the brownies today: ${today} job${summary.total === 1 ? "" : "s"} (${num(summary.total)} in all)`);
  }
  lines.push("", "Kitchen: https://feedthebrownies.com/team.html");
  return lines.join("\n");
}

export class Crumb extends Helper {
  constructor(deps) {
    super("crumb", deps);
    this.tg = deps.telegram;
    this.github = deps.github || null;
    this.groupChatId = String(deps.groupChatId || "") || String(this.store.getMeta("tg:group:auto") || "");
    this.ownerChatId = String(deps.ownerChatId || "");
    this.questionsHour = this.config.questionsHour ?? 20;
    this.onDecision = deps.onDecision || null;   // (approvalId, "approve" | "reject", { chatId, messageId })
    this.onButton = deps.onButton || null;       // (data, { chatId, messageId }) -> the answer to show, for every other button (a brownie's own card)
    this.onNote = deps.onNote || null;           // (approvalId, text)
    this.onOwnerCommand = deps.onOwnerCommand || null; // (command, text) -> true (done), a reply string, or nothing (not a command: answered as a message)
    this.onHolderCommand = deps.onHolderCommand || null; // (command, text, { chatId, from }) -> a reply string; /link and /mybrownie from any private chat (the Bakery)
    this.statsAt = new Map(); // chat -> time of the last /stats answer (one a minute per chat, no model call)
    this.live = { at: 0, text: "" };
    this.running = false;
    this.answered = 0;
    this.batchAge = (this.config.reportEveryMinutes || 60) * 60_000;
    this.idleWait = 1000;
  }

  jobs() {
    return [
      { id: "crumb-flush", helper: "crumb", every: 5 * 60_000, initialDelay: 60_000, run: () => this.guard("flush", () => this.flush()) },
      { id: "crumb-questions", helper: "crumb", daily: { hours: [this.questionsHour], minute: 0 }, run: () => this.guard("questions", () => this.questionsDigest()) },
    ];
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
    if (u.my_chat_member) return this.membership(u.my_chat_member);
    const m = u.message;
    if (!m || typeof m.text !== "string" || !m.text.trim()) return null;
    const chatId = String(m.chat.id);
    if (/group/.test(m.chat.type || "")) this.rememberGroup(m.chat);
    const isOwner = this.ownerChatId && chatId === this.ownerChatId;
    // the owner answering "Reply to this message with a note": the note goes to the pull request
    if (isOwner && m.reply_to_message) {
      const a = this.store.approvalByMessage(chatId, m.reply_to_message.message_id);
      if (a && a.state === "rejected" && this.onNote) {
        const ok = await this.onNote(a.id, m.text.trim());
        await this.tg.sendMessage(chatId, ok ? "Added your note to the pull request." : "This card is not a pull request, so there is no place to add a note.", { replyTo: m.message_id });
        return "note";
      }
    }
    // /stats works everywhere, costs nothing, and never goes through a model
    if (/^\/stats(@\w+)?(\s|$)/i.test(m.text.trim())) return this.stats(m);
    if (isOwner && /^\/\w+/.test(m.text.trim()) && this.onOwnerCommand) {
      const [, cmd, rest = ""] = m.text.trim().match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/) || [];
      const reply = await this.onOwnerCommand(cmd.toLowerCase(), rest.trim());
      if (reply === true) return "command";
      if (typeof reply === "string" && reply) { await this.tg.sendMessage(chatId, reply, { replyTo: m.message_id }); return "command"; }
    }
    // a holder's commands for their baked brownie, in a private chat: /link <code> binds this chat, /mybrownie ... (the Bakery answers, no model)
    if (m.chat.type === "private" && /^\/(link|mybrownie|start)\b/i.test(m.text.trim()) && this.onHolderCommand) {
      const [, cmd, rest = ""] = m.text.trim().match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/) || [];
      const reply = await this.onHolderCommand(cmd.toLowerCase(), rest.trim(), { chatId, from: m.from || null });
      if (typeof reply === "string" && reply) { await this.tg.sendMessage(chatId, reply, { replyTo: m.message_id }); return "holder"; }
    }
    if (m.chat.type === "private" || isOwner) return this.answer(m);
    if (chatId === this.groupChatId) {
      const me = await this.tg.me().catch(() => null);
      if (!this.wantsAnswer(m.text, me?.username)) return null;
      return this.answer(m);
    }
    return null; // a chat the bot was not told about
  }

  /// The bot was added to a chat, promoted, or removed. A group it joins becomes the group when none is set.
  async membership(cm) {
    const chat = cm.chat || {};
    const status = cm.new_chat_member?.status || "";
    if (!/group/.test(chat.type || "")) return null;
    this.log(`[crumb] ${status === "left" || status === "kicked" ? "removed from" : "in"} the group ${chat.id} ${JSON.stringify(chat.title || "")} as ${status || "?"}`);
    if (["member", "administrator"].includes(status)) this.rememberGroup(chat);
    else if (String(chat.id) === this.groupChatId && ["left", "kicked"].includes(status)) { this.groupChatId = ""; this.store.setMeta("tg:group:auto", null); }
    return status;
  }

  /// Keeps the group's id and title; adopts it as the group to answer in when none is configured.
  rememberGroup(chat) {
    const id = String(chat.id);
    this.store.setMeta(`tg:group:${id}`, chat.title || "");
    if (!this.groupChatId) {
      this.groupChatId = id;
      this.store.setMeta("tg:group:auto", id);
      this.log(`[crumb] answering in the group ${id} ${JSON.stringify(chat.title || "")} from now on`);
    }
  }

  /// In the group: questions, and messages that name the bot or the brownies. Chatter is left alone.
  wantsAnswer(text, botUsername = "") {
    const t = String(text).trim();
    if (t.startsWith("/")) return /^\/(start|help|ask|brownies)\b/i.test(t);
    if (/\?/.test(t)) return true;
    if (botUsername && t.toLowerCase().includes("@" + botUsername.toLowerCase())) return true;
    return /\b(brownies?|crumb|fudge|nib|chip)\b/i.test(t);
  }

  /// Strangers get a limited number of answers: a burst of 5 in ten minutes and 40 a day for one chat, 150 a day for
  /// all of them together. Over the limit nothing goes to the model; a private chat hears one fixed line, the group
  /// hears nothing. The owner is never limited.
  allowance(chat, now) {
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.quotaDay !== day) { this.quotaDay = day; this.quota = new Map(); this.quotaAll = 0; }
    const q = this.quota.get(chat) || { recent: [], day: 0, told: false };
    q.recent = q.recent.filter((t) => now - t < 10 * 60_000);
    const ok = q.recent.length < ALLOWANCE.burst && q.day < ALLOWANCE.day && this.quotaAll < ALLOWANCE.all;
    if (ok) { q.recent.push(now); q.day++; this.quotaAll++; }
    this.quota.set(chat, q);
    return { ok, told: q.told, tell: () => { q.told = true; } };
  }

  /// Answers one message with the facts, the live numbers and the last turns of that chat.
  async answer(m) {
    const now = this.clock.now();
    const chat = String(m.chat.id);
    if (!(this.ownerChatId && chat === this.ownerChatId)) {
      if (MONEY_ASK.test(m.text)) {
        this.log(`[crumb] chat ${chat} asked for money or keys; the fixed line went out, no model`);
        await this.tg.sendMessage(chat, MONEY_LINE, { replyTo: m.message_id });
        const key = `tg:moneyask:${chat}:${new Date(now).toISOString().slice(0, 10)}`;
        if (!this.store.getMeta(key) && this.tg?.configured && this.ownerChatId) { this.store.setMeta(key, "1"); await this.tg.sendMessage(this.ownerChatId, `Someone ${m.chat.type === "private" ? "in a private chat" : "in the group"} asked ${this.Name} for money or keys: "${cut(m.text.trim(), 120)}". The fixed line went out, nothing else. Nothing was sent.`).catch(() => {}); }
        return null;
      }
      const a = this.allowance(chat, now);
      if (!a.ok) {
        this.log(`[crumb] chat ${chat} is over its allowance; nothing goes to the model`);
        if (m.chat.type === "private" && !a.told) { a.tell(); await this.tg.sendMessage(chat, "That is all I can answer for now. Ask me again in a little while.", { replyTo: m.message_id }); }
        return null;
      }
    }
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

  /// The owner's instruction (the control room, or /crumb on Telegram): say this in the group, as it is. No model.
  async onRequest(text) {
    const t = String(text || "").trim();
    if (!t) return null;
    if (!this.groupChatId) { this.log("[crumb] no group to announce in"); return null; }
    await this.tg.sendMessage(this.groupChatId, t.slice(0, 3800));
    await this.report("post", `Announced in the group: ${cut(t, 120)}`, { place: "telegram" });
    return { text: t };
  }

  /// /stats: the live numbers as plain text, from the gateway only. One answer a minute per chat.
  async stats(m) {
    const chat = String(m.chat.id);
    const now = this.clock.now();
    if (now - (this.statsAt.get(chat) || 0) < 60_000) return null;
    this.statsAt.set(chat, now);
    const [st, su] = await Promise.all([this.gateway.stats(), this.gateway.summary()]);
    const text = statsText(st.ok ? st.body : null, su.ok ? su.body : null);
    await this.tg.sendMessage(chat, text, { replyTo: m.message_id });
    this.store.countAnswer(chat, now);
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

  /// Once a day: what people asked since the last digest, grouped, each with a short answer, into the repository.
  async questionsDigest() {
    const now = this.clock.now();
    const since = Number(this.store.getMeta("tg:digest:since", 0)) || now - 86_400_000;
    const asked = this.store.turnsSince(since, "user").filter((t) => String(t.chat) !== this.ownerChatId);
    if (!asked.length) { this.log("[crumb] no questions since the last digest"); this.store.setMeta("tg:digest:since", now); return null; }
    if (!(await this.ready())) return null;
    await this.status("Writing down what people asked today");
    const date = this.store.dayKey(now);
    const list = asked.map((t) => `- [${String(t.chat) === this.groupChatId ? "group" : "private"}] ${t.who || "someone"}: ${cut(t.text.replace(/\s+/g, " "), 300)}`).join("\n");
    const r = await this.think({
      system: this.system(`Your task now: write the day's questions digest for the team.
- Group the messages below into the distinct questions people asked (merge the same question asked twice). Leave out chatter and greetings.
- For each: one line "Q: the question in plain words", then one line "A: a short answer from the facts", then an empty line. If the facts do not cover it, write "A: not in the facts yet" so the team can add it.
- Plain text, ASCII only, no markdown beyond those two labels. Most asked first.`),
      prompt: `Messages since the last digest (${asked.length}):
${cut(list, 12_000)}

Write the digest now.`, maxTokens: 1500, temperature: 0.3,
    });
    const text = tidy(r.text);
    const questions = (text.match(/^Q:/gm) || []).length;
    const md = `# Questions of ${date}

Written by Crumb, the community brownie, from ${asked.length} messages in the Telegram group and private chats. One Q and A per distinct question, most asked first. "Not in the facts yet" marks what the team should add to helpers/facts.md.

${text}
`;
    const path = `notes/questions/${date}.md`;
    let url = null;
    if (this.github?.configured) {
      const branch = await this.github.defaultBranch();
      const existing = await this.github.getFile(path, branch);
      await this.github.putFile(path, md, `Crumb: questions of ${date}`, { branch, sha: existing?.sha || null });
      url = this.github.fileUrl(path, branch);
    }
    this.store.setMeta("tg:digest:since", now);
    this.store.setMeta("digest:latest", JSON.stringify({ date, text: cut(text, 6000), url, at: now }));
    await this.report("note", `Questions of the day: ${questions} distinct from ${asked.length} messages`, { body: cut(text, 1000), url, place: url ? "github" : "telegram", cost_micro: r.costMicro });
    return { date, questions, asked: asked.length, url };
  }

  /// A press on Approve or Reject. Only the owner's press counts; the decision itself is Chip's.
  async callback(cq) {
    const m = String(cq.data || "").match(/^(approve|reject):(\d+)$/);
    const chatId = String(cq.message?.chat?.id || "");
    const isOwner = this.ownerChatId && (chatId === this.ownerChatId || String(cq.from?.id || "") === this.ownerChatId);
    if (!m) {
      // a brownie's own card (TikTok's post settings, for one): the owner's press goes to it, the answer comes back
      if (!this.onButton || !cq.data) return this.tg.answerCallbackQuery(cq.id, "Unknown button.");
      if (!isOwner) return this.tg.answerCallbackQuery(cq.id, "Only the owner decides.");
      const answer = await this.onButton(String(cq.data), { chatId, messageId: cq.message?.message_id });
      return this.tg.answerCallbackQuery(cq.id, answer || "Unknown button.");
    }
    if (!isOwner) return this.tg.answerCallbackQuery(cq.id, "Only the owner decides.");
    const a = this.store.approval(Number(m[2]));
    if (!a) return this.tg.answerCallbackQuery(cq.id, "Nothing to decide.");
    if (a.state !== "pending") return this.tg.answerCallbackQuery(cq.id, "Already decided.");
    await this.tg.answerCallbackQuery(cq.id, m[1] === "approve" ? "Approved." : "Rejected.");
    if (this.onDecision) await this.onDecision(a.id, m[1], { chatId, messageId: cq.message?.message_id });
    return m[1];
  }
}
