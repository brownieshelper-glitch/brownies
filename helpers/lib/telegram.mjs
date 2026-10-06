// Telegram Bot API. Crumb reads the group and private chats with long polling; the alerts and the approval
// buttons for the owner go through the same bot. Messages are sent as plain text. The bot token is part of every
// URL, so no error here ever repeats a URL.
import { CredentialsError } from "./xapi.mjs";

export class Telegram {
  constructor({ token, fetch = globalThis.fetch, log = () => {} }) {
    this.token = token; this.fetch = fetch; this.log = log; this.user = null;
  }
  get configured() { return Boolean(this.token); }

  /// One method call. Returns `result`. Throws a plain sentence (status and Telegram's description) on failure.
  async call(method, params = {}, { timeoutMs = 30_000 } = {}) {
    const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) };
    if (typeof AbortSignal?.timeout === "function") init.signal = AbortSignal.timeout(timeoutMs);
    const r = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, init);
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 404) throw new CredentialsError("telegram", `Telegram refused the bot token (${r.status})`);
    if (!r.ok || !j.ok) throw new Error(`Telegram ${method} failed: ${r.status} ${j.description || ""}`.trim().slice(0, 200));
    return j.result;
  }

  async me() {
    if (!this.user) { const u = await this.call("getMe"); this.user = { id: u.id, username: u.username }; }
    return this.user;
  }

  /// Long poll: waits up to `timeout` seconds for messages and button presses after `offset`.
  getUpdates({ offset = 0, timeout = 25, limit = 50 } = {}) {
    return this.call("getUpdates", { offset, timeout, limit, allowed_updates: ["message", "callback_query", "my_chat_member"] }, { timeoutMs: (timeout + 15) * 1000 });
  }

  /// Plain text, cut to Telegram's size. `buttons` is [[{ text, data }]] for an inline keyboard.
  sendMessage(chatId, text, { replyTo = null, buttons = null } = {}) {
    const params = { chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true };
    if (replyTo) params.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
    if (buttons) params.reply_markup = { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) };
    return this.call("sendMessage", params);
  }

  answerCallbackQuery(id, text = "") { return this.call("answerCallbackQuery", { callback_query_id: id, text: String(text).slice(0, 200) }); }

  /// Takes the buttons off a message once the decision is made.
  clearButtons(chatId, messageId) { return this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }); }

  editMessageText(chatId, messageId, text) { return this.call("editMessageText", { chat_id: chatId, message_id: messageId, text: String(text).slice(0, 4000), disable_web_page_preview: true }); }

  sendChatAction(chatId, action = "typing") { return this.call("sendChatAction", { chat_id: chatId, action }).catch(() => null); }
}
