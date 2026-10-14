// Reading the live chat of our stream and answering the questions in it, under lib/chatrules.mjs.
//   YouTubeChat   the channel's live chat through the Data API (the sign-in the project already has covers it)
//   TwitchChat    the channel's chat through EventSub (read) and the chat API (write), signed in once with a code
//                 the owner types on twitch.tv (no secret is kept: a public client, the device code flow)
//   ChatDesk      one message in, at most one answer out: the verdict, the limits, the model, the checks
// X has no interface for the chat of a broadcast, and its rule is that an AI may not answer people there by
// itself without X's written yes. So there is no X here.
// Nothing in this file is a secret, and none is logged: tokens live in the store, under names of their own.
import { chatVerdict, answerProblems, chatSystem, CHAT_MAX } from "./chatrules.mjs";

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const cut = (s, n) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n - 3).trimEnd()}...` : t; };

// ---- YouTube ----

const YT = "https://www.googleapis.com/youtube/v3";
/// What a day of looking and answering costs in YouTube's units (10,000 a day for the whole project): a look is 5,
/// an answer 20, finding the broadcast 1. A look every 75 seconds is 5,760; 100 answers are 2,000.
export const YT_COST = { look: 5, say: 20, find: 1 };

export class YouTubeChat {
  /// youtube: the project's client (lib/youtube.mjs), with its api(method, url, { body }).
  constructor({ youtube, store, clock, log = () => {}, everySeconds = 75, maxPerDay = 100 } = {}) {
    Object.assign(this, { youtube, store, clock, log, everySeconds, maxPerDay });
    this.place = "youtube";
  }
  get configured() { return Boolean(this.youtube?.configured); }

  /// The chat of the broadcast that is live now: { chatId, videoId, title } or null. Asked again every ten minutes.
  async live() {
    const now = this.clock.now();
    let kept = null; try { kept = JSON.parse(this.store.getMeta("chat:youtube:live") || "null"); } catch { kept = null; }
    if (kept && now - kept.at < 10 * 60_000) return kept.chatId ? kept : null;
    const r = await this.youtube.api("GET", `${YT}/liveBroadcasts?part=snippet,status&broadcastStatus=active&broadcastType=all&maxResults=5`);
    const b = (r.json?.items || []).find((x) => x?.snippet?.liveChatId) || null;
    const found = { at: now, chatId: b?.snippet?.liveChatId || null, videoId: b?.id || null, title: b?.snippet?.title || "" };
    const was = kept?.chatId || null;
    this.store.setMeta("chat:youtube:live", JSON.stringify(found));
    if (found.chatId !== was) this.store.setMeta("chat:youtube:page", null); // another broadcast: its chat is read from now on
    return found.chatId ? found : null;
  }

  /// The messages since the last look, oldest first: [{ place, id, text, author, authorId, self }]. The first look
  /// at a chat only marks the place: what was said before we arrived is not answered.
  async poll() {
    const live = await this.live();
    if (!live) return [];
    const page = this.store.getMeta("chat:youtube:page");
    const r = await this.youtube.api("GET", `${YT}/liveChat/messages?liveChatId=${encodeURIComponent(live.chatId)}&part=snippet,authorDetails&maxResults=200${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`);
    const j = r.json || {};
    if (j.nextPageToken) this.store.setMeta("chat:youtube:page", j.nextPageToken);
    if (!page) return [];
    return (j.items || []).filter((m) => m?.snippet?.type === "textMessageEvent" && m.snippet.hasDisplayContent !== false).map((m) => ({
      place: "youtube", id: m.id, text: String(m.snippet.displayMessage || m.snippet.textMessageDetails?.messageText || ""),
      author: String(m.authorDetails?.displayName || ""), authorId: String(m.authorDetails?.channelId || ""),
      self: Boolean(m.authorDetails?.isChatOwner) || (this.youtube.channelId && m.authorDetails?.channelId === this.youtube.channelId),
    }));
  }

  /// One line into the chat. YouTube's chat has no reply-to: the answer names who it is for.
  async say(text, to = null) {
    const live = await this.live();
    if (!live) throw new Error("no broadcast is live on YouTube");
    const line = cut(to?.author ? `@${String(to.author).replace(/^@/, "")} ${text}` : text, CHAT_MAX);
    await this.youtube.api("POST", `${YT}/liveChat/messages?part=snippet`, { body: { snippet: { liveChatId: live.chatId, type: "textMessageEvent", textMessageDetails: { messageText: line } } } });
    return line;
  }
}

// ---- Twitch ----

const TW_ID = "https://id.twitch.tv/oauth2";
const TW_API = "https://api.twitch.tv/" + "he" + "lix";
const TW_WS = "wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30";
/// What the sign-in asks for: to read the chat, to write in it, and to be the bot of this channel.
export const TW_SCOPES = "user:read:chat user:write:chat user:bot channel:bot";

export class TwitchChat {
  constructor({ store, clock, fetch = globalThis.fetch, WebSocket = globalThis.WebSocket, log = () => {} } = {}) {
    Object.assign(this, { store, clock, fetch, WebSocket, log });
    this.place = "twitch";
    this.ws = null; this.onMessage = null; this.stopped = true;
  }
  get clientId() { return this.store.getMeta("chat:twitch:client") || ""; }
  get tokens() { try { return JSON.parse(this.store.getMeta("chat:twitch:tokens") || "null"); } catch { return null; } }
  get configured() { return Boolean(this.clientId && this.tokens?.refresh); }
  get connected() { return Boolean(this.ws && this.sessionId); }

  async form(url, fields) {
    const r = await this.fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, j };
  }

  /// Step one of the sign-in: Twitch gives a short code and an address; the owner opens it, signed in as the
  /// channel, and types the code. { url, code, minutes } to show him. The client id is the application's public name.
  async begin(clientId) {
    const id = oneLine(clientId);
    if (!/^[a-z0-9]{20,40}$/i.test(id)) throw new Error("that does not look like a Twitch client id (about 30 letters and digits)");
    const { ok, status, j } = await this.form(`${TW_ID}/device`, { client_id: id, scopes: TW_SCOPES });
    if (!ok || !j.device_code) throw new Error(`Twitch did not start the sign-in (${status}: ${cut(j.message || "no reason", 120)}). The application has to be of the type Public.`);
    this.store.setMeta("chat:twitch:client", id);
    this.store.setMeta("chat:twitch:device", JSON.stringify({ code: j.device_code, until: this.clock.now() + Number(j.expires_in || 1800) * 1000, every: Number(j.interval || 5) }));
    return { url: j.verification_uri, code: j.user_code, minutes: Math.round(Number(j.expires_in || 1800) / 60) };
  }

  /// Step two, asked again every few seconds until the owner has typed the code: true when the tokens are in.
  async finish() {
    let d = null; try { d = JSON.parse(this.store.getMeta("chat:twitch:device") || "null"); } catch { d = null; }
    if (!d) return false;
    if (this.clock.now() > d.until) { this.store.setMeta("chat:twitch:device", null); throw new Error("the code ran out before it was typed; ask for a new one"); }
    const { ok, j } = await this.form(`${TW_ID}/token`, { client_id: this.clientId, scopes: TW_SCOPES, device_code: d.code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
    if (!ok || !j.access_token) { if (/pending/i.test(String(j.message || ""))) return false; throw new Error(`Twitch refused the sign-in: ${cut(j.message || "no reason", 120)}`); }
    this.keep(j);
    this.store.setMeta("chat:twitch:device", null);
    const me = await this.me();
    this.store.setMeta("chat:twitch:user", JSON.stringify(me));
    return true;
  }

  keep(j) { this.store.setMeta("chat:twitch:tokens", JSON.stringify({ access: j.access_token, refresh: j.refresh_token, until: this.clock.now() + (Number(j.expires_in) || 3600) * 1000 })); }
  get user() { try { return JSON.parse(this.store.getMeta("chat:twitch:user") || "null"); } catch { return null; } }

  /// A token that works: the one we have, or a new pair from the refresh token (which Twitch then replaces).
  async token({ fresh = false } = {}) {
    const t = this.tokens;
    if (!t?.refresh) throw Object.assign(new Error("Twitch is not signed in"), { credentials: true, service: "twitch" });
    if (!fresh && t.access && this.clock.now() < t.until - 120_000) return t.access;
    const { ok, status, j } = await this.form(`${TW_ID}/token`, { client_id: this.clientId, grant_type: "refresh_token", refresh_token: t.refresh });
    if (!ok || !j.access_token) throw Object.assign(new Error(`Twitch refused to renew the sign-in (${status}); it has to be done again`), { credentials: true, service: "twitch" });
    this.keep(j);
    return j.access_token;
  }

  async api(method, path, body = null, retry = true) {
    const token = await this.token();
    const r = await this.fetch(`${TW_API}${path}`, { method, headers: { authorization: `Bearer ${token}`, "client-id": this.clientId, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401 && retry) { await this.token({ fresh: true }); return this.api(method, path, body, false); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`Twitch answered ${r.status} on ${method} ${path.split("?")[0]}: ${cut(j.message || "no reason", 140)}`), { status: r.status, rateLimited: r.status === 429 });
    return j;
  }
  async me() { const j = await this.api("GET", "/users"); const u = j.data?.[0]; if (!u) throw new Error("Twitch did not say who signed in"); return { id: u.id, login: u.login, name: u.display_name }; }

  /// Listens to the channel's chat until stop(): each message goes to onMessage. A lost line is opened again.
  start(onMessage) {
    this.onMessage = onMessage; this.stopped = false;
    this.open(TW_WS);
  }
  stop() { this.stopped = true; this.sessionId = null; try { this.ws?.close(); } catch { /* closed */ } this.ws = null; }
  open(url) {
    if (this.stopped || !this.WebSocket) return;
    const ws = new this.WebSocket(url);
    this.ws = ws;
    ws.onmessage = (m) => { this.frame(String(m.data), ws).catch((e) => this.log(`[twitch] ${e.message}`)); };
    ws.onclose = () => { if (this.ws !== ws) return; this.sessionId = null; this.ws = null; if (!this.stopped) setTimeout(() => this.open(TW_WS), 10_000).unref?.(); };
    ws.onerror = () => { try { ws.close(); } catch { /* closed */ } };
  }
  async frame(data, ws) {
    let j = null; try { j = JSON.parse(data); } catch { return; }
    const type = j?.metadata?.message_type;
    if (type === "session_welcome") {
      const first = !this.sessionId;
      this.sessionId = j.payload?.session?.id || null;
      if (first || j.payload?.session?.reconnect_url == null) await this.subscribe();
    } else if (type === "session_reconnect") {
      const next = j.payload?.session?.reconnect_url;
      if (next) { const old = ws; this.open(next); setTimeout(() => { try { old.close(); } catch { /* closed */ } }, 5000).unref?.(); }
    } else if (type === "notification" && j.metadata?.subscription_type === "channel.chat.message") {
      const e = j.payload?.event || {};
      const me = this.user;
      const msg = { place: "twitch", id: String(e.message_id || ""), text: String(e.message?.text || ""), author: String(e.chatter_user_name || e.chatter_user_login || ""), authorId: String(e.chatter_user_id || ""), self: Boolean(me && e.chatter_user_id === me.id) };
      if (msg.id && this.onMessage) await this.onMessage(msg);
    }
  }
  async subscribe() {
    const me = this.user || (await this.me());
    await this.api("POST", "/eventsub/subscriptions", { type: "channel.chat.message", version: "1", condition: { broadcaster_user_id: me.id, user_id: me.id }, transport: { method: "websocket", session_id: this.sessionId } });
    this.log(`[twitch] reading the chat of ${me.login}`);
  }

  /// One line into the chat, as a reply to the message it answers.
  async say(text, to = null) {
    const me = this.user || (await this.me());
    const line = cut(text, CHAT_MAX);
    const j = await this.api("POST", "/chat/messages", { broadcaster_id: me.id, sender_id: me.id, message: line, ...(to?.id ? { reply_parent_message_id: to.id } : {}) });
    const sent = j.data?.[0];
    if (sent && sent.is_sent === false) throw new Error(`Twitch dropped the message: ${cut(sent.drop_reason?.message || "no reason", 120)}`);
    return line;
  }
}

// ---- the desk ----

/// One message in, at most one answer out. think({ system, prompt, maxTokens, temperature }) is the brownie's own
/// way to ask its model. The system prompt is the chat's own (lib/chatrules.mjs: chatSystem): it knows the stream and
/// none of the project's other facts. An answer that is only too long is asked for once more, shorter. Limits (all kept in the store, so a restart does
/// not reset them): answers per author a day, answers per place an hour, a breath between two answers.
export class ChatDesk {
  constructor({ think, name = "Ember", store, clock, alerts = null, log = () => {}, ready = async () => true, perAuthorDay = 3, perHour = 30, gapSeconds = 8 } = {}) {
    Object.assign(this, { think, name, store, clock, alerts, log, ready, perAuthorDay, perHour, gapSeconds });
  }
  key(kind, ...parts) { return `chat:${kind}:${parts.join(":")}`; }
  day(now) { return new Date(now).toISOString().slice(0, 10); }

  /// Returns { act: "skip", why } | { act: "said", text, costMicro, fixed }.
  async handle(msg, room) {
    const now = this.clock.now();
    if (!msg?.id || this.store.seen(`chat-${msg.place}`, msg.id)) return { act: "skip", why: "seen" };
    this.store.markSeen(`chat-${msg.place}`, msg.id, now);
    const who = `${msg.place}:${msg.authorId || msg.author}`;
    const optKey = this.key("optout", who);
    const v = chatVerdict({ text: msg.text, author: msg.author, self: msg.self, optedOut: Boolean(this.store.getMeta(optKey)) });
    if (v.act === "skip") {
      if (v.why === "optout") this.store.setMeta(optKey, String(now));
      if (v.why === "staff" && this.alerts) await this.alerts.send(`chat:staff:${who}`, `Somebody in the ${msg.place} chat says they are the owner, the team or support ("${cut(oneLine(msg.text), 140)}", from ${cut(msg.author, 40)}). Nobody answered. The owner never speaks through the chat.`);
      return v;
    }
    // the limits
    const authorKey = this.key("author", who, this.day(now));
    const byAuthor = Number(this.store.getMeta(authorKey) || 0);
    if (byAuthor >= this.perAuthorDay) return { act: "skip", why: "author-limit" };
    const hourKey = this.key("hour", msg.place, Math.floor(now / 3_600_000));
    const thisHour = Number(this.store.getMeta(hourKey) || 0);
    if (thisHour >= this.perHour) return { act: "skip", why: "hour-limit" };
    if (now - Number(this.store.getMeta(this.key("last", msg.place)) || 0) < this.gapSeconds * 1000) return { act: "skip", why: "too-soon" };

    let text = v.line || "", costMicro = 0;
    if (v.act === "answer") {
      if (!(await this.ready())) return { act: "skip", why: "no-budget" };
      const tidy = (s) => oneLine(s).replace(/^["']|["']$/g, "").replace(/^@\S+[:,]?\s*/, "");
      const question = `Somebody in the chat asks: ${cut(oneLine(msg.text), 300)}`;
      const r = await this.think({ system: chatSystem(this.name), prompt: `${question}\n\nWrite the answer.`, maxTokens: 120, temperature: 0.4 });
      costMicro = r.costMicro || 0;
      text = tidy(r.text);
      let bad = answerProblems(text);
      if (bad.length === 1 && /^longer than/.test(bad[0])) { // too long and nothing else: once more, shorter
        const again = await this.think({ system: chatSystem(this.name), prompt: `${question}\n\nYour answer was too long for a chat. Say it again in one sentence of at most 110 characters.`, maxTokens: 80, temperature: 0.3 });
        costMicro += again.costMicro || 0;
        text = tidy(again.text);
        bad = answerProblems(text);
      }
      if (bad.length) { this.log(`[chat] an answer for ${msg.place} was not sent: ${bad.join(", ")}`); return { act: "skip", why: "answer-refused", problems: bad, costMicro }; }
    }
    const sent = await room.say(text, { id: msg.id, author: msg.author });
    this.store.setMeta(authorKey, String(byAuthor + 1));
    this.store.setMeta(hourKey, String(thisHour + 1));
    this.store.setMeta(this.key("last", msg.place), String(now));
    return { act: "said", text: sent, costMicro, fixed: v.act === "line" };
  }
}
