// X, through the API v2 with an OAuth 2.0 user token. Fudge posts and reads its mentions with this.
//
// The access token lives two hours. The refresh token CHANGES at every renewal: the pair that comes back is the
// only one that still works, so it is written to X_TOKEN_FILE at once, atomically (write a temp file, rename).
// A token is renewed when it is older than 100 minutes or when X answers 401. Nothing here ever logs a token.
import { xHardProblems } from "./xrules.mjs";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname, extname, basename } from "node:path";

export const X_API = "https://api.x.com/2";
export const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
const MAX_AGE = 100 * 60_000;

export class CredentialsError extends Error {
  constructor(service, message) { super(message); this.service = service; this.credentials = true; }
}
export class RateLimited extends Error {
  constructor(service, resetAt) { super(`${service} rate limit`); this.service = service; this.resetAt = resetAt; this.rateLimited = true; }
}

export class XClient {
  constructor({ clientId, clientSecret = "", accessToken = "", refreshToken = "", tokenFile = "", username = "", fetch = globalThis.fetch, clock, log = () => {} }) {
    Object.assign(this, { clientId, clientSecret, tokenFile, username, fetch, clock, log });
    this.pair = { access_token: accessToken, refresh_token: refreshToken, obtained_at: 0 }; // age unknown: renewed on first use
    this.refreshes = 0;
    this.user = null;
    this.load();
  }

  /// The pair saved by an earlier run wins over the one in the env file, because the env one may be used up.
  load() {
    if (!this.tokenFile || !existsSync(this.tokenFile)) return false;
    try {
      const j = JSON.parse(readFileSync(this.tokenFile, "utf8"));
      if (j.access_token && j.refresh_token) { this.pair = { access_token: j.access_token, refresh_token: j.refresh_token, obtained_at: Number(j.obtained_at) || 0 }; return true; }
    } catch (e) { this.log(`[x] token file unreadable: ${e.message}`); }
    return false;
  }

  save() {
    if (!this.tokenFile) return;
    mkdirSync(dirname(this.tokenFile), { recursive: true });
    const tmp = `${this.tokenFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.pair), { mode: 0o600 });
    renameSync(tmp, this.tokenFile);
  }

  get configured() { return Boolean(this.clientId && (this.pair.refresh_token || this.pair.access_token)); }

  async ensureToken() {
    if (!this.pair.access_token || this.clock.now() - this.pair.obtained_at > MAX_AGE) await this.refreshOnce();
  }

  /// One renewal at a time: X accepts a refresh token once, so two callers that find the token old share one request,
  /// and a caller that arrives right after a renewal does not renew again.
  refreshOnce({ force = false } = {}) {
    if (this.refreshing) return this.refreshing;
    if (!force && this.pair.access_token && this.clock.now() - this.pair.obtained_at < 30_000) return Promise.resolve();
    this.refreshing = this.refresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /// Trades the refresh token for a new pair and stores it. Throws CredentialsError when X refuses.
  async refresh() {
    if (!this.pair.refresh_token) throw new CredentialsError("x", "X has no refresh token to renew with");
    const headers = { "content-type": "application/x-www-form-urlencoded" };
    if (this.clientSecret) headers.authorization = "Basic " + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.pair.refresh_token, client_id: this.clientId });
    const r = await this.fetch(X_TOKEN_URL, { method: "POST", headers, body: form.toString() });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new CredentialsError("x", `X refused the refresh token (${r.status})`);
    this.pair = { access_token: j.access_token, refresh_token: j.refresh_token || this.pair.refresh_token, obtained_at: this.clock.now() };
    this.refreshes++;
    this.save();
  }

  /// One API call. A 401 renews the token once and retries. Returns the parsed body.
  async request(method, path, { body, query, retry = true } = {}) {
    await this.ensureToken();
    const url = new URL(`${X_API}${path}`);
    for (const [k, v] of Object.entries(query || {})) if (v != null && v !== "") url.searchParams.set(k, String(v));
    const r = await this.fetch(url.toString(), { method, headers: { authorization: `Bearer ${this.pair.access_token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401 && retry) { await this.refreshOnce({ force: true }); return this.request(method, path, { body, query, retry: false }); }
    if (r.status === 401) throw new CredentialsError("x", `X refused the request (401 on ${path.split("?")[0]})`);
    if (r.status === 429) throw new RateLimited("x", Number(r.headers?.get?.("x-rate-limit-reset") || 0) * 1000);
    const j = await r.json().catch(() => ({}));
    // X answers 403 both for a dead app (a credentials matter) and for a refused tweet, such as duplicate content
    if (r.status === 403 && /enrolled|authenticat|permission|suspended|access level|oauth|scope/i.test(`${j.title || ""} ${j.detail || ""}`)) throw new CredentialsError("x", `X refused the request (403: ${j.detail || j.title})`.slice(0, 200));
    if (!r.ok) throw new Error(`X answered ${r.status} on ${method} ${path}: ${j.detail || j.title || "no detail"}`.slice(0, 200));
    return j;
  }

  async me() {
    if (!this.user) { const j = await this.request("GET", "/users/me"); this.user = { id: j.data.id, username: j.data.username }; if (!this.username) this.username = j.data.username; }
    return this.user;
  }

  statusUrl(id) { return `https://x.com/${this.username || "i"}/status/${id}`; }

  /// Posts a tweet, or a reply when replyTo is a tweet id. Returns { id, url }.
  async post(text, { replyTo = null, mediaIds = null, approved = false } = {}) {
    const bad = approved ? [] : xHardProblems(text, { kind: replyTo ? "reply" : "post" });
    if (bad.length) throw new Error(`x: the text breaks the rules of X (${bad.join(", ")}) and was not sent`);
    const body = { text };
    if (replyTo) body.reply = { in_reply_to_tweet_id: String(replyTo) };
    if (Array.isArray(mediaIds) && mediaIds.length) body.media = { media_ids: mediaIds.map(String) };
    const j = await this.request("POST", "/tweets", { body });
    return { id: j.data.id, url: this.statusUrl(j.data.id) };
  }

  /// Deletes a post of ours. Returns true when X says it is gone.
  async delete(id) {
    const j = await this.request("DELETE", `/tweets/${String(id).replace(/\D/g, "")}`);
    return Boolean(j.data?.deleted);
  }

  /// One multipart call (the bytes of a media chunk). A 401 renews the token once and retries.
  async requestForm(method, path, form, { retry = true } = {}) {
    await this.ensureToken();
    const r = await this.fetch(`${X_API}${path}`, { method, headers: { authorization: `Bearer ${this.pair.access_token}` }, body: form });
    if (r.status === 401 && retry) { await this.refresh(); return this.requestForm(method, path, form, { retry: false }); }
    if (r.status === 429) throw new RateLimited("x", Number(r.headers?.get?.("x-rate-limit-reset") || 0) * 1000);
    const j = await r.json().catch(() => ({}));
    if (r.status === 403 && /enrolled|authenticat|permission|suspended|access level|oauth|scope/i.test(`${j.title || ""} ${j.detail || ""}`)) throw new CredentialsError("x", `X refused the upload (403: ${j.detail || j.title})`.slice(0, 200));
    if (!r.ok) throw new Error(`X answered ${r.status} on ${method} ${path}: ${j.detail || j.title || "no detail"}`.slice(0, 200));
    return j;
  }

  /// Uploads a picture or a video for a post (the app needs the media.write scope): initialize, the bytes in chunks
  /// of at most 5 MB, finalize, then X's processing until it is done. Returns { mediaId, type, category, bytes }.
  async uploadMedia(file, { mediaType = null, category = null, chunkBytes = 4 * 1024 * 1024, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const bytes = readFileSync(file);
    const type = mediaType || { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".mp4": "video/mp4" }[extname(file).toLowerCase()];
    if (!type) throw new Error(`X cannot take ${extname(file) || "that kind of"} files`);
    const cat = category || (type.startsWith("video/") ? "tweet_video" : type === "image/gif" ? "tweet_gif" : "tweet_image");
    if (cat === "tweet_image" && bytes.length > 5 * 1024 * 1024) throw new Error("X takes pictures up to 5 MB");
    const init = await this.request("POST", "/media/upload/initialize", { body: { media_type: type, total_bytes: bytes.length, media_category: cat } });
    const id = init.data?.id || init.media_id_string || init.id;
    if (!id) throw new Error("X gave no media id");
    for (let i = 0, seg = 0; i < bytes.length; i += chunkBytes, seg++) {
      const form = new FormData();
      form.set("segment_index", String(seg));
      form.set("media", new Blob([bytes.subarray(i, i + chunkBytes)], { type }), basename(file));
      await this.requestForm("POST", `/media/upload/${id}/append`, form);
    }
    const fin = await this.request("POST", `/media/upload/${id}/finalize`);
    let info = fin.data?.processing_info || null;
    for (let tries = 0; info && info.state !== "succeeded" && tries < 30; tries++) {
      if (info.state === "failed") throw new Error(`X could not process the media: ${info.error?.message || info.error?.name || "failed"}`);
      await sleep(Math.min(10, Number(info.check_after_secs) || 2) * 1000);
      const st = await this.request("GET", "/media/upload", { query: { command: "STATUS", media_id: id } });
      info = st.data?.processing_info || null;
    }
    if (info && info.state !== "succeeded") throw new Error("X is still processing the media; try again later");
    return { mediaId: String(id), type, category: cat, bytes: bytes.length };
  }

  /// Mentions newer than sinceId: [{ id, text, authorId, author, conversationId }], oldest first, with the newest id.
  async mentions({ sinceId = null, max = 20 } = {}) {
    const me = await this.me();
    const j = await this.request("GET", `/users/${me.id}/mentions`, { query: { since_id: sinceId, max_results: Math.min(100, Math.max(5, max)), "tweet.fields": "author_id,conversation_id,created_at", expansions: "author_id", "user.fields": "username" } });
    const users = new Map((j.includes?.users || []).map((u) => [u.id, u.username]));
    const tweets = (j.data || []).map((t) => ({ id: t.id, text: t.text, authorId: t.author_id, author: users.get(t.author_id) || null, conversationId: t.conversation_id })).reverse();
    return { tweets, newestId: j.meta?.newest_id || (tweets.length ? tweets[tweets.length - 1].id : sinceId) };
  }
}
