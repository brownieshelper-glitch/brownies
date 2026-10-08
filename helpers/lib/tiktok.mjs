// TikTok, through the Content Posting API of the project's developer app. The owner connects the Brownies account
// once: /tiktok in the owner's chat gives a link to <gateway>/tiktok/start, which sends the browser to TikTok's
// login; TikTok comes back to <gateway>/tiktok/callback, the code becomes tokens and they live in the store
// (tiktok:tokens). Access tokens last a day and are refreshed from the refresh token (a year). Nothing here logs a
// token. Before TikTok audits the app, a video can only go to the account's inbox as a draft the owner finishes in
// the app (uploadInbox); after the audit it can be posted directly (directPost).
import { readFileSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

const AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";
const API = "https://open.tiktokapis.com/v2";
export const SCOPES = ["user.info.basic", "video.upload", "video.publish"];
const CHUNK = 10 * 1024 * 1024, ONE_CHUNK_MAX = 64 * 1024 * 1024, MIN_CHUNK = 5 * 1024 * 1024;
const TOKENS_KEY = "tiktok:tokens";

/// TikTok's error codes in plain words, for the owner.
export const EXPLAIN = {
  unaudited_client_can_only_post_to_private_accounts: "until TikTok reviews the app it may post only to a PRIVATE account: in the TikTok app set the account to private (Settings and privacy, Privacy, Private account), then try again",
  spam_risk_too_many_pending_share: "too many drafts are waiting in the account's inbox: post or delete them in the TikTok app, then try again",
  spam_risk_user_banned_from_posting: "TikTok has blocked this account from posting for now",
  spam_risk_too_many_posts: "TikTok says the account posted too much today; try tomorrow",
  reached_active_user_cap: "the app has reached TikTok's cap of users before the review",
  access_token_invalid: "the TikTok connection expired: connect again with /tiktok",
  scope_not_authorized: "the TikTok connection lacks the posting permission: connect again with /tiktok",
};

export class TikTok {
  constructor({ clientKey = "", clientSecret = "", redirectUri = "", store, clock, fetch = globalThis.fetch, log = () => {} } = {}) {
    Object.assign(this, { clientKey, clientSecret, redirectUri, store, clock, fetch, log });
    this.calls = 0;
  }
  now() { return this.clock ? this.clock.now() : Date.now(); }
  get configured() { return Boolean(this.clientKey && this.clientSecret); }
  get connected() { return Boolean(this.tokens()?.refresh_token); }

  tokens() { try { const raw = this.store?.getMeta(TOKENS_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; } }
  saveTokens(t) { this.store?.setMeta(TOKENS_KEY, t ? JSON.stringify(t) : null); }
  disconnect() { this.saveTokens(null); }

  /// Where the owner's browser goes to allow the app.
  authUrl(state) {
    return `${AUTH_URL}?${new URLSearchParams({ client_key: this.clientKey, scope: SCOPES.join(","), response_type: "code", redirect_uri: this.redirectUri, state })}`;
  }

  async _tokenCall(form) {
    const r = await this.fetch(`${API}/oauth/token/`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_key: this.clientKey, client_secret: this.clientSecret, ...form }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      const e = fail(r.status || 502, `TikTok refused the ${form.grant_type} (${j.error || r.status}${j.error_description ? ": " + j.error_description : ""})`);
      if (form.grant_type === "refresh_token" || r.status === 400 || r.status === 401) { e.credentials = true; e.service = "tiktok"; }
      throw e;
    }
    const now = this.now();
    return { access_token: j.access_token, expiresAt: now + Number(j.expires_in || 86400) * 1000, refresh_token: j.refresh_token, refreshExpiresAt: now + Number(j.refresh_expires_in || 365 * 86400) * 1000, open_id: j.open_id, scope: j.scope };
  }

  /// The code from the callback becomes tokens; the account's name is read and kept. Returns { open_id, username }.
  async exchange(code) {
    const t = await this._tokenCall({ grant_type: "authorization_code", code, redirect_uri: this.redirectUri });
    this.saveTokens(t);
    let me = {};
    try { me = await this.me(); } catch (e) { this.log(`[tiktok] connected, but the profile did not load: ${e.message}`); }
    this.saveTokens({ ...t, username: me.username || null, display_name: me.display_name || null });
    return { open_id: t.open_id, username: me.username || null, display_name: me.display_name || null, name: me.display_name || me.username || t.open_id, scope: t.scope };
  }

  /// A live access token, refreshed a minute before it expires.
  async token({ fresh = false } = {}) {
    const t = this.tokens();
    if (!t?.refresh_token) throw fail(503, "TikTok is not connected: send /tiktok to the bot and allow the app");
    if (!fresh && t.access_token && this.now() < t.expiresAt - 60_000) return t.access_token;
    const n = await this._tokenCall({ grant_type: "refresh_token", refresh_token: t.refresh_token });
    this.saveTokens({ ...t, ...n, refresh_token: n.refresh_token || t.refresh_token });
    return n.access_token;
  }

  /// One API call with the bearer; a 401 refreshes once. TikTok answers { data, error: { code, message, log_id } }.
  async api(method, path, { body = null, query = null, retry = true } = {}) {
    const token = await this.token();
    const url = `${API}${path}${query ? "?" + new URLSearchParams(query) : ""}`;
    const init = { method, headers: { authorization: `Bearer ${token}` } };
    if (body != null) { init.body = JSON.stringify(body); init.headers["content-type"] = "application/json; charset=UTF-8"; }
    const r = await this.fetch(url, init);
    this.calls++;
    if (r.status === 401 && retry) { await this.token({ fresh: true }); return this.api(method, path, { body, query, retry: false }); }
    const j = await r.json().catch(() => ({}));
    const code = j?.error?.code;
    if (!r.ok || (code && code !== "ok")) {
      const e = fail(r.status, `TikTok answered ${r.status}${code ? " " + code : ""}: ${EXPLAIN[code] || j?.error?.message || "no detail"}`);
      e.code = code;
      if (/access_token_invalid|scope_not_authorized|unaudited_client|invalid_grant/i.test(code || "")) { e.credentials = true; e.service = "tiktok"; }
      if (/rate_limit|spam_risk/i.test(code || "")) e.rateLimited = true;
      throw e;
    }
    return j.data || {};
  }

  /// The account: { open_id, username, display_name, avatar_url }. The basic scope gives the display name, not the
  /// handle (that would need user.info.profile), so the name shown to the owner is the display name.
  async me() {
    const d = await this.api("GET", "/user/info/", { query: { fields: "open_id,union_id,avatar_url,display_name" } });
    const u = d.user || {};
    return { open_id: u.open_id, username: u.username || null, display_name: u.display_name || null, avatar_url: u.avatar_url || null };
  }

  /// Must be read before a direct post: which privacy levels the account allows, the longest video it may post.
  creatorInfo() { return this.api("POST", "/post/publish/creator_info/query/", { body: {} }); }

  /// The chunk plan TikTok accepts: one chunk up to 64 MB, else 10 MB chunks with a last chunk of at least 5 MB.
  static chunks(size) {
    if (size <= ONE_CHUNK_MAX) return { chunkSize: size, count: 1 };
    let count = Math.floor(size / CHUNK);
    const rest = size - count * CHUNK;
    if (rest > 0 && rest < MIN_CHUNK && count > 1) count -= 1; // a remainder under 5 MB joins the last chunk
    return { chunkSize: CHUNK, count: Math.max(1, count) };
  }

  async _upload(initPath, body, file) {
    const size = statSync(file).size;
    const plan = TikTok.chunks(size);
    const d = await this.api("POST", initPath, { body: { ...body, source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: plan.chunkSize, total_chunk_count: plan.count } } });
    if (!d.publish_id || !d.upload_url) throw fail(502, "TikTok gave no upload address");
    const bytes = readFileSync(file);
    const token = await this.token();
    for (let i = 0; i < plan.count; i++) {
      const start = i * plan.chunkSize, end = i === plan.count - 1 ? size - 1 : start + plan.chunkSize - 1;
      const part = bytes.subarray(start, end + 1);
      const r = await this.fetch(d.upload_url, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "video/mp4", "content-length": String(part.length), "content-range": `bytes ${start}-${end}/${size}` }, body: part });
      this.calls++;
      if (r.status < 200 || r.status >= 300) throw fail(r.status, `the video upload failed at chunk ${i + 1}: ${r.status}`);
    }
    return { publishId: d.publish_id, bytes: size, chunks: plan.count };
  }

  /// A draft in the account's inbox: the owner finishes it in the TikTok app. Works before the app's audit.
  uploadInbox({ file }) { return this._upload("/post/publish/inbox/video/init/", {}, file); }

  /// A direct post. Before the audit TikTok only allows SELF_ONLY; after it, the levels creatorInfo lists.
  directPost({ file, title, privacy = "SELF_ONLY", disableDuet = false, disableComment = false, disableStitch = false, brandContent = false, brandOrganic = false, coverMs = 1000 }) {
    const post_info = { title: String(title || "").slice(0, 2200), privacy_level: privacy, disable_duet: disableDuet, disable_comment: disableComment, disable_stitch: disableStitch, brand_content_toggle: Boolean(brandContent), brand_organic_toggle: Boolean(brandOrganic), video_cover_timestamp_ms: coverMs };
    return this._upload("/post/publish/video/init/", { post_info }, file);
  }

  /// { status, fail_reason, publicaly_available_post_id, uploaded_bytes }.
  status(publishId) { return this.api("POST", "/post/publish/status/fetch/", { body: { publish_id: publishId } }); }

  /// Polls the status until it is final (in the inbox, published or failed), or gives up.
  async waitForStatus(publishId, { tries = 12, everyMs = 5000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    let last = null;
    for (let i = 0; i < tries; i++) {
      last = await this.status(publishId);
      if (["SEND_TO_USER_INBOX", "PUBLISH_COMPLETE", "FAILED"].includes(last.status)) return last;
      await sleep(everyMs);
    }
    return last;
  }
}

/// The HTTP side of connecting: /tiktok/start?t=<ticket> (a one-time ticket the owner got from the bot) sends the
/// browser to TikTok with a state; /tiktok/callback checks the state, trades the code for tokens and says so.
export class TikTokAuth {
  constructor({ tiktok, store, clock, log = () => {}, onConnected = null, baseUrl = "" }) {
    Object.assign(this, { tiktok, store, clock, log, onConnected, baseUrl });
  }
  now() { return this.clock ? this.clock.now() : Date.now(); }
  /// The link the owner opens (ten minutes).
  link() {
    const ticket = randomBytes(16).toString("hex");
    this.store.setMeta("tiktok:ticket", JSON.stringify({ hash: sha(ticket), expiresAt: this.now() + 10 * 60_000 }));
    return `${this.baseUrl}/tiktok/start?t=${ticket}`;
  }
  _ticketOk(t) {
    const raw = this.store.getMeta("tiktok:ticket");
    if (!raw || !t) return false;
    const c = JSON.parse(raw);
    if (this.now() > c.expiresAt || sha(t) !== c.hash) return false;
    this.store.setMeta("tiktok:ticket", null);
    return true;
  }
  async handle(req, res) {
    const url = new URL(req.url, "http://x");
    const page = (status, title, text) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><body style="font-family:sans-serif;padding:40px;max-width:560px;background:#0E0E0C;color:#F3EFE6"><h2>${title}</h2><p>${text}</p></body>`); };
    try {
      if (req.method === "GET" && url.pathname === "/tiktok/start") {
        if (!this.tiktok.configured) return page(503, "TikTok is not set up", "The developer app's key and secret are missing on the server.");
        if (!this._ticketOk(url.searchParams.get("t"))) return page(403, "This link is not valid", "Ask the bot for a new one with /tiktok. A link works once, for ten minutes.");
        const state = randomBytes(16).toString("hex");
        this.store.setMeta("tiktok:state", JSON.stringify({ state, expiresAt: this.now() + 10 * 60_000 }));
        res.writeHead(302, { location: this.tiktok.authUrl(state), "cache-control": "no-store" });
        return res.end();
      }
      if (req.method === "GET" && url.pathname === "/tiktok/callback") {
        const raw = this.store.getMeta("tiktok:state");
        const s = raw ? JSON.parse(raw) : null;
        this.store.setMeta("tiktok:state", null);
        if (!s || this.now() > s.expiresAt || url.searchParams.get("state") !== s.state) return page(400, "Something went wrong", "The answer from TikTok did not match the request. Ask the bot for a new link with /tiktok.");
        if (url.searchParams.get("error")) return page(400, "TikTok said no", `${url.searchParams.get("error")}: ${url.searchParams.get("error_description") || ""}`);
        const me = await this.tiktok.exchange(url.searchParams.get("code"));
        this.log(`[tiktok] connected as ${me.name}`);
        if (this.onConnected) await this.onConnected(me).catch?.(() => {});
        return page(200, "TikTok is connected", `Brownies can now send videos to ${me.display_name ? me.display_name : "this account"}. You can close this tab.`);
      }
      return page(404, "Not here", "Nothing at this address.");
    } catch (e) {
      this.log(`[tiktok] ${url.pathname} failed: ${e.message}`);
      return page(500, "Something went wrong", e.message);
    }
  }
}

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
function fail(status, message) { const e = new Error(message); e.status = status; return e; }
