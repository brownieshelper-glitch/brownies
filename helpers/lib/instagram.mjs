// Instagram, through the Instagram API with Instagram Login (a Meta developer app with the Instagram product; the
// account must be a professional one, business or creator; no Facebook Page is needed). The owner connects once
// with /instagram in the bot (lib/connect.mjs): the code becomes a short token, the short token a long one (60
// days) kept in the store (instagram:tokens) and renewed by itself after a week. Reels are published from a public
// URL of the file (lib/clips.mjs serves our own), images the same way. Nothing here logs a token.
const API = "https://graph.instagram.com";
const VERSION = "v21.0";
export const SCOPES = ["instagram_business_basic", "instagram_business_content_publish"];
const TOKENS_KEY = "instagram:tokens";

export class Instagram {
  constructor({ appId = "", appSecret = "", redirectUri = "", store, clock, fetch = globalThis.fetch, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    Object.assign(this, { appId, appSecret, redirectUri, store, clock, fetch, log, sleep });
    this.label = "Instagram";
    this.calls = 0;
  }
  now() { return this.clock ? this.clock.now() : Date.now(); }
  get configured() { return Boolean(this.appId && this.appSecret); }
  get connected() { return Boolean(this.tokens()?.access_token); }
  tokens() { try { const raw = this.store?.getMeta(TOKENS_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; } }
  saveTokens(t) { this.store?.setMeta(TOKENS_KEY, t ? JSON.stringify(t) : null); }
  disconnect() { this.saveTokens(null); }
  /// Days before the long-lived token ends (it is renewed by itself while it is alive).
  daysLeft() { const t = this.tokens(); return t?.expiresAt ? Math.floor((t.expiresAt - this.now()) / 86400_000) : null; }

  /// Where the owner's browser goes to allow the app.
  authUrl(state) {
    return `https://www.instagram.com/oauth/authorize?${new URLSearchParams({ client_id: this.appId, redirect_uri: this.redirectUri, response_type: "code", scope: SCOPES.join(","), state, force_reauth: "true" })}`;
  }

  /// The code from the callback becomes a long-lived token; the account's name is read and kept.
  async exchange(code) {
    const r = await this.fetch("https://api.instagram.com/oauth/access_token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: this.appId, client_secret: this.appSecret, grant_type: "authorization_code", redirect_uri: this.redirectUri, code }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw cred(`Instagram refused the code (${r.status}${j.error_message ? ": " + j.error_message : j.error?.message ? ": " + j.error.message : ""})`);
    const long = await this.fetch(`${API}/access_token?${new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: this.appSecret, access_token: j.access_token })}`);
    const l = await long.json().catch(() => ({}));
    if (!long.ok || !l.access_token) throw cred(`Instagram gave no long-lived token (${long.status}${l.error?.message ? ": " + l.error.message : ""})`);
    const t = { access_token: l.access_token, expiresAt: this.now() + Number(l.expires_in || 60 * 86400) * 1000, obtainedAt: this.now(), user_id: String(j.user_id || ""), permissions: j.permissions || SCOPES };
    this.saveTokens(t);
    let me = {};
    try { me = await this.me(); } catch (e) { this.log(`[instagram] connected, but the profile did not load: ${e.message}`); }
    this.saveTokens({ ...t, user_id: me.id || t.user_id, username: me.username || null, account_type: me.account_type || null });
    return { id: me.id || t.user_id, username: me.username || null, name: me.username ? "@" + me.username : "the Instagram account", account_type: me.account_type || null };
  }

  /// A live token: the long-lived one, renewed once it is a week old (Instagram renews only after a day, and never
  /// an expired one). An expired token is a credentials error: the owner connects again.
  async token() {
    const t = this.tokens();
    if (!t?.access_token) throw cred("Instagram is not connected: send /instagram to the bot and allow the app");
    if (this.now() >= t.expiresAt) throw cred("the Instagram connection expired: connect again with /instagram");
    if (this.now() - (t.obtainedAt || 0) > 7 * 86400_000 && t.expiresAt - this.now() < 53 * 86400_000) {
      try {
        const r = await this.fetch(`${API}/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: t.access_token })}`);
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.access_token) { this.saveTokens({ ...t, access_token: j.access_token, expiresAt: this.now() + Number(j.expires_in || 60 * 86400) * 1000, obtainedAt: this.now() }); return j.access_token; }
        this.log(`[instagram] the token could not be renewed yet (${r.status}${j.error?.message ? ": " + j.error.message : ""}); the current one still works`);
      } catch (e) { this.log(`[instagram] the token renewal failed: ${e.message}`); }
    }
    return t.access_token;
  }

  /// One Graph call. Errors come as { error: { message, type, code } }: 190 is a dead token, 4/17/32/613 are limits.
  async api(method, path, { query = null, body = null } = {}) {
    const token = await this.token();
    const q = new URLSearchParams({ ...(query || {}), access_token: token });
    const init = { method };
    if (body) { init.headers = { "content-type": "application/x-www-form-urlencoded" }; init.body = new URLSearchParams(body).toString(); }
    const r = await this.fetch(`${API}/${VERSION}${path}?${q}`, init);
    this.calls++;
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) {
      const code = Number(j.error?.code || 0);
      const e = new Error(`Instagram answered ${r.status}${code ? " (code " + code + ")" : ""}: ${j.error?.message || "no detail"}`);
      e.status = r.status; e.code = code;
      if (code === 190 || r.status === 401) { e.credentials = true; e.service = "instagram"; }
      if ([4, 17, 32, 613].includes(code) || r.status === 429) e.rateLimited = true;
      throw e;
    }
    return j;
  }

  async me() { return this.api("GET", "/me", { query: { fields: "id,username,account_type,name" } }); }
  userId() { const t = this.tokens(); return t?.user_id || "me"; }

  /// Waits for a container (a reel being processed) to be ready: FINISHED, or an error.
  async waitReady(containerId, { tries = 30, everyMs = 5000 } = {}) {
    let last = null;
    for (let i = 0; i < tries; i++) {
      last = await this.api("GET", `/${containerId}`, { query: { fields: "status_code,status" } });
      if (last.status_code === "FINISHED") return last;
      if (last.status_code === "ERROR" || last.status_code === "EXPIRED") throw new Error(`Instagram could not take the video: ${last.status || last.status_code}`);
      await this.sleep(everyMs);
    }
    throw new Error("Instagram is still processing the video; try again later");
  }

  /// A reel from a public MP4 URL (9:16, up to 15 minutes). Returns { id, url }.
  async publishReel({ videoUrl, caption = "", shareToFeed = true, coverUrl = null }) {
    const body = { media_type: "REELS", video_url: videoUrl, caption: String(caption || "").slice(0, 2200), share_to_feed: shareToFeed ? "true" : "false" };
    if (coverUrl) body.cover_url = coverUrl;
    const c = await this.api("POST", `/${this.userId()}/media`, { body });
    if (!c.id) throw new Error("Instagram gave no container for the reel");
    await this.waitReady(c.id);
    const p = await this.api("POST", `/${this.userId()}/media_publish`, { body: { creation_id: c.id } });
    if (!p.id) throw new Error("Instagram did not publish the reel");
    let url = null;
    try { url = (await this.api("GET", `/${p.id}`, { query: { fields: "permalink" } })).permalink || null; } catch { /* the id is enough */ }
    this.log(`[instagram] reel ${p.id} published${url ? " " + url : ""}`);
    return { id: p.id, url, container: c.id };
  }

  /// A single image from a public URL (JPEG or PNG). Returns { id, url }.
  async publishImage({ imageUrl, caption = "" }) {
    const c = await this.api("POST", `/${this.userId()}/media`, { body: { image_url: imageUrl, caption: String(caption || "").slice(0, 2200) } });
    if (!c.id) throw new Error("Instagram gave no container for the image");
    const p = await this.api("POST", `/${this.userId()}/media_publish`, { body: { creation_id: c.id } });
    if (!p.id) throw new Error("Instagram did not publish the image");
    let url = null;
    try { url = (await this.api("GET", `/${p.id}`, { query: { fields: "permalink" } })).permalink || null; } catch { /* the id is enough */ }
    this.log(`[instagram] image ${p.id} published${url ? " " + url : ""}`);
    return { id: p.id, url, container: c.id };
  }
}

function cred(message) { const e = new Error(message); e.credentials = true; e.service = "instagram"; e.status = 401; return e; }
