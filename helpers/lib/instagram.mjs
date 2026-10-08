// Instagram, two doors to the same publishing API:
// - login "instagram": the Instagram API with Instagram Login (a Meta app with the Instagram product; a
//   professional account; no Facebook Page). The code becomes a short token, then a long one (60 days) kept in
//   the store (instagram:tokens) and renewed by itself after a week. Host graph.instagram.com.
// - login "facebook": the Instagram API with Facebook Login (the same Meta app; the Instagram professional
//   account linked to a Facebook Page the owner manages). The owner logs in to Facebook, the code becomes a short
//   user token, then a long one (60 days), then the Page's own token, which does not expire; publishing uses the
//   Page token. Host graph.facebook.com. Meta's dashboard stopped showing the Instagram-login setup for new apps
//   on 2026-10-08, so this is the door in use.
// The owner connects once with /instagram in the bot (lib/connect.mjs). Reels are published from a public URL of
// the file (lib/clips.mjs serves our own), images the same way. Nothing here logs a token.
const IG_API = "https://graph.instagram.com";
const FB_API = "https://graph.facebook.com";
const VERSION = "v21.0";
export const SCOPES = ["instagram_business_basic", "instagram_business_content_publish"];
export const FB_SCOPES = ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement", "business_management"]; // business_management: Pages owned by a business portfolio are listed only with it
export const LOGINS = ["instagram", "facebook"];
const TOKENS_KEY = "instagram:tokens";

export class Instagram {
  constructor({ appId = "", appSecret = "", redirectUri = "", login = "instagram", store, clock, fetch = globalThis.fetch, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    Object.assign(this, { appId, appSecret, redirectUri, store, clock, fetch, log, sleep });
    this.login = LOGINS.includes(String(login)) ? String(login) : "instagram";
    this.label = "Instagram";
    this.calls = 0;
  }
  now() { return this.clock ? this.clock.now() : Date.now(); }
  get facebook() { return this.login === "facebook"; }
  get api_() { return this.facebook ? FB_API : IG_API; }
  get configured() { return Boolean(this.appId && this.appSecret); }
  get connected() { return Boolean(this.tokens()?.access_token); }
  tokens() { try { const raw = this.store?.getMeta(TOKENS_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; } }
  saveTokens(t) { this.store?.setMeta(TOKENS_KEY, t ? JSON.stringify(t) : null); }
  disconnect() { this.saveTokens(null); }
  /// Days before the user token ends (null with no expiry: a Page token). The token is renewed by itself while alive.
  daysLeft() { const t = this.tokens(); if (t?.page_token) return null; return t?.expiresAt ? Math.floor((t.expiresAt - this.now()) / 86400_000) : null; }

  /// Where the owner's browser goes to allow the app.
  authUrl(state) {
    if (this.facebook) return `https://www.facebook.com/${VERSION}/dialog/oauth?${new URLSearchParams({ client_id: this.appId, redirect_uri: this.redirectUri, state, response_type: "code", scope: FB_SCOPES.join(","), auth_type: "rerequest" })}`;
    return `https://www.instagram.com/oauth/authorize?${new URLSearchParams({ client_id: this.appId, redirect_uri: this.redirectUri, response_type: "code", scope: SCOPES.join(","), state, force_reauth: "true" })}`;
  }

  /// The code from the callback becomes the tokens; the account's name is read and kept. Returns { id, username, name, account_type }.
  async exchange(code) {
    if (this.facebook) return this.exchangeFacebook(code);
    const r = await this.fetch("https://api.instagram.com/oauth/access_token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: this.appId, client_secret: this.appSecret, grant_type: "authorization_code", redirect_uri: this.redirectUri, code }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw cred(`Instagram refused the code (${r.status}${j.error_message ? ": " + j.error_message : j.error?.message ? ": " + j.error.message : ""})`);
    const long = await this.fetch(`${IG_API}/access_token?${new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: this.appSecret, access_token: j.access_token })}`);
    const l = await long.json().catch(() => ({}));
    if (!long.ok || !l.access_token) throw cred(`Instagram gave no long-lived token (${long.status}${l.error?.message ? ": " + l.error.message : ""})`);
    const t = { login: "instagram", access_token: l.access_token, expiresAt: this.now() + Number(l.expires_in || 60 * 86400) * 1000, obtainedAt: this.now(), user_id: String(j.user_id || ""), permissions: j.permissions || SCOPES };
    this.saveTokens(t);
    let me = {};
    try { me = await this.me(); } catch (e) { this.log(`[instagram] connected, but the profile did not load: ${e.message}`); }
    this.saveTokens({ ...t, user_id: me.id || t.user_id, username: me.username || null, account_type: me.account_type || null });
    return { id: me.id || t.user_id, username: me.username || null, name: me.username ? "@" + me.username : "the Instagram account", account_type: me.account_type || null };
  }

  /// Facebook Login: code -> short user token -> long user token (60 days) -> the Pages the owner manages; the Page
  /// with the linked Instagram professional account gives the Instagram id and a Page token that does not expire.
  async exchangeFacebook(code) {
    const r = await this.fetch(`${FB_API}/${VERSION}/oauth/access_token?${new URLSearchParams({ client_id: this.appId, redirect_uri: this.redirectUri, client_secret: this.appSecret, code })}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw cred(`Facebook refused the code (${r.status}${j.error?.message ? ": " + j.error.message : ""})`);
    const long = await this.fetch(`${FB_API}/${VERSION}/oauth/access_token?${new URLSearchParams({ grant_type: "fb_exchange_token", client_id: this.appId, client_secret: this.appSecret, fb_exchange_token: j.access_token })}`);
    const l = await long.json().catch(() => ({}));
    if (!long.ok || !l.access_token) throw cred(`Facebook gave no long-lived token (${long.status}${l.error?.message ? ": " + l.error.message : ""})`);
    const pr = await this.fetch(`${FB_API}/${VERSION}/me/accounts?${new URLSearchParams({ fields: "id,name,access_token,instagram_business_account{id,username,name}", access_token: l.access_token })}`);
    const pages = await pr.json().catch(() => ({}));
    if (!pr.ok || !Array.isArray(pages.data)) throw cred(`Facebook did not list the Pages (${pr.status}${pages.error?.message ? ": " + pages.error.message : ""})`);
    let page = pages.data.find((p) => p.instagram_business_account?.id);
    if (!page) page = await this.pageThroughBusinesses(l.access_token);
    if (!page) {
      let granted = "unknown", who = "unknown", chosen = "unknown";
      try { const g = await (await this.fetch(`${FB_API}/${VERSION}/me/permissions?${new URLSearchParams({ access_token: l.access_token })}`)).json(); if (Array.isArray(g.data)) granted = g.data.filter((x) => x.status === "granted").map((x) => x.permission).join(", ") || "none"; } catch { granted = "unknown"; }
      try { const m = await (await this.fetch(`${FB_API}/${VERSION}/me?${new URLSearchParams({ fields: "id,name", access_token: l.access_token })}`)).json(); if (m.name) who = `${m.name} (${m.id})`; } catch { who = "unknown"; }
      try { const d = await (await this.fetch(`${FB_API}/${VERSION}/debug_token?${new URLSearchParams({ input_token: l.access_token, access_token: `${this.appId}|${this.appSecret}` })}`)).json(); const gs = d.data?.granular_scopes; if (Array.isArray(gs)) { const ps = gs.find((x) => x.scope === "pages_show_list"); chosen = ps ? (Array.isArray(ps.target_ids) && ps.target_ids.length ? ps.target_ids.join(", ") : "all Pages (none chosen one by one)") : "the Pages permission carries no Page list"; } } catch { chosen = "unknown"; }
      throw cred(`no Facebook Page you manage has a linked Instagram professional account (${pages.data.length} Page${pages.data.length === 1 ? "" : "s"} seen; logged in as ${who}; Pages ticked in the Facebook screen: ${chosen}; permissions granted: ${granted}): the account that logs in must be an admin of the Brownies Page, and the Page must be ticked in the Facebook screen`);
    }
    const ig = page.instagram_business_account;
    const t = { login: "facebook", access_token: l.access_token, expiresAt: this.now() + Number(l.expires_in || 60 * 86400) * 1000, obtainedAt: this.now(), page_id: String(page.id), page_name: page.name || null, page_token: page.access_token || null, user_id: String(ig.id), username: ig.username || null, account_type: "professional", permissions: FB_SCOPES };
    this.saveTokens(t);
    this.log(`[instagram] connected through the Page ${page.name || page.id} (Facebook Login)`);
    return { id: t.user_id, username: t.username, name: t.username ? "@" + t.username : "the Instagram account", account_type: "professional", page: page.name || page.id };
  }

  /// A Page owned by a business portfolio does not always show in /me/accounts: walk the portfolios the user is in,
  /// their owned Pages, and read each Page's own token with the user token. Null when nothing fits.
  async pageThroughBusinesses(userToken) {
    try {
      const br = await this.fetch(`${FB_API}/${VERSION}/me/businesses?${new URLSearchParams({ fields: "id,name,owned_pages{id,name,instagram_business_account{id,username,name}}", access_token: userToken })}`);
      const b = await br.json().catch(() => ({}));
      const candidates = [];
      for (const biz of Array.isArray(b.data) ? b.data : []) for (const pg of biz.owned_pages?.data || []) candidates.push(pg);
      this.log(`[instagram] ${candidates.length} Page${candidates.length === 1 ? "" : "s"} through the business portfolios`);
      for (const pg of candidates) {
        const pr = await this.fetch(`${FB_API}/${VERSION}/${pg.id}?${new URLSearchParams({ fields: "id,name,access_token,instagram_business_account{id,username,name}", access_token: userToken })}`);
        const full = await pr.json().catch(() => ({}));
        if (pr.ok && full.access_token && full.instagram_business_account?.id) return full;
        this.log(`[instagram] Page ${pg.name || pg.id}: ${!pr.ok ? "not readable" : !full.access_token ? "no Page token" : "no Instagram account linked"}`);
      }
    } catch (e) { this.log(`[instagram] the portfolio lookup failed: ${e.message}`); }
    return null;
  }

  /// A live token. Instagram Login: the long-lived one, renewed once it is a week old (Instagram renews only after
  /// a day, and never an expired one). Facebook Login: the Page token, which does not expire; the user token behind
  /// it is renewed when it can be. An expired token is a credentials error: the owner connects again.
  async token() {
    const t = this.tokens();
    if (!t?.access_token) throw cred("Instagram is not connected: send /instagram to the bot and allow the app");
    if (t.login === "facebook" || t.page_token) {
      if (this.now() - (t.obtainedAt || 0) > 7 * 86400_000 && t.expiresAt - this.now() < 53 * 86400_000 && this.now() < t.expiresAt) {
        try {
          const r = await this.fetch(`${FB_API}/${VERSION}/oauth/access_token?${new URLSearchParams({ grant_type: "fb_exchange_token", client_id: this.appId, client_secret: this.appSecret, fb_exchange_token: t.access_token })}`);
          const j = await r.json().catch(() => ({}));
          if (r.ok && j.access_token) this.saveTokens({ ...t, access_token: j.access_token, expiresAt: this.now() + Number(j.expires_in || 60 * 86400) * 1000, obtainedAt: this.now() });
          else this.log(`[instagram] the user token could not be renewed (${r.status}${j.error?.message ? ": " + j.error.message : ""}); the Page token still works`);
        } catch (e) { this.log(`[instagram] the user token renewal failed: ${e.message}`); }
      }
      if (t.page_token) return t.page_token;
      if (this.now() >= t.expiresAt) throw cred("the Instagram connection expired: connect again with /instagram");
      return this.tokens().access_token;
    }
    if (this.now() >= t.expiresAt) throw cred("the Instagram connection expired: connect again with /instagram");
    if (this.now() - (t.obtainedAt || 0) > 7 * 86400_000 && t.expiresAt - this.now() < 53 * 86400_000) {
      try {
        const r = await this.fetch(`${IG_API}/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: t.access_token })}`);
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
    const host = this.tokens()?.login === "facebook" ? FB_API : this.api_;
    const r = await this.fetch(`${host}/${VERSION}${path}?${q}`, init);
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

  async me() {
    if (this.tokens()?.login === "facebook") { const m = await this.api("GET", `/${this.userId()}`, { query: { fields: "id,username,name" } }); return { ...m, account_type: "professional" }; }
    return this.api("GET", "/me", { query: { fields: "id,username,account_type,name" } });
  }
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
