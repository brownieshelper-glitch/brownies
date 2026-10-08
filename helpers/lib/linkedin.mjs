// LinkedIn, through the project's developer app with the self-serve products "Sign In with LinkedIn using OpenID
// Connect" and "Share on LinkedIn": posts on the member's own profile (w_member_social). The owner connects once
// with /linkedin in the bot (lib/connect.mjs); the access token lasts 60 days and LinkedIn gives a refresh token
// only to approved partners, so near the end Truffle asks the owner to connect again. Tokens live in the store
// (linkedin:tokens). Nothing here logs a token.
import { readFileSync } from "node:fs";

const OAUTH = "https://www.linkedin.com/oauth/v2";
const API = "https://api.linkedin.com";
export const SCOPES = ["openid", "profile", "w_member_social"];
const TOKENS_KEY = "linkedin:tokens";

/// LinkedIn's "little text format" gives these characters a meaning inside a post: they are escaped so the text
/// reads as written.
export function escapeCommentary(text) {
  return String(text || "").replace(/([\\|{}@[\]()<>#*_~])/g, "\\$1");
}

export class LinkedIn {
  constructor({ clientId = "", clientSecret = "", redirectUri = "", version = "202509", store, clock, fetch = globalThis.fetch, log = () => {} } = {}) {
    Object.assign(this, { clientId, clientSecret, redirectUri, version, store, clock, fetch, log });
    this.label = "LinkedIn";
    this.calls = 0;
  }
  now() { return this.clock ? this.clock.now() : Date.now(); }
  get configured() { return Boolean(this.clientId && this.clientSecret); }
  get connected() { return Boolean(this.tokens()?.access_token); }
  tokens() { try { const raw = this.store?.getMeta(TOKENS_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; } }
  saveTokens(t) { this.store?.setMeta(TOKENS_KEY, t ? JSON.stringify(t) : null); }
  disconnect() { this.saveTokens(null); }
  /// Days before the access ends (null when not connected).
  daysLeft() { const t = this.tokens(); return t?.expiresAt ? Math.floor((t.expiresAt - this.now()) / 86400_000) : null; }
  /// The member's urn, the author of every post.
  author() { const t = this.tokens(); return t?.sub ? `urn:li:person:${t.sub}` : null; }

  authUrl(state) {
    return `${OAUTH}/authorization?${new URLSearchParams({ response_type: "code", client_id: this.clientId, redirect_uri: this.redirectUri, state, scope: SCOPES.join(" ") })}`;
  }

  async _tokenCall(form) {
    const r = await this.fetch(`${OAUTH}/accessToken`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...form }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw cred(`LinkedIn refused the ${form.grant_type} (${r.status}${j.error_description ? ": " + j.error_description : j.error ? ": " + j.error : ""})`);
    const now = this.now();
    return { access_token: j.access_token, expiresAt: now + Number(j.expires_in || 60 * 86400) * 1000, refresh_token: j.refresh_token || null, refreshExpiresAt: j.refresh_token_expires_in ? now + Number(j.refresh_token_expires_in) * 1000 : null, scope: j.scope || SCOPES.join(" ") };
  }

  /// The code becomes a token; the member's name and id are read and kept. Returns { sub, name }.
  async exchange(code) {
    const t = await this._tokenCall({ grant_type: "authorization_code", code, redirect_uri: this.redirectUri });
    this.saveTokens(t);
    const me = await this.userinfo(t.access_token);
    this.saveTokens({ ...t, sub: me.sub, name: me.name || null, picture: me.picture || null });
    return { sub: me.sub, name: me.name || "the LinkedIn profile" };
  }

  async userinfo(token) {
    const r = await this.fetch(`${API}/v2/userinfo`, { headers: { authorization: `Bearer ${token}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.sub) throw cred(`LinkedIn did not say who this is (${r.status})`);
    return j;
  }

  /// A live token: renewed from the refresh token when LinkedIn gave one, else used until it ends.
  async token() {
    const t = this.tokens();
    if (!t?.access_token) throw cred("LinkedIn is not connected: send /linkedin to the bot and allow the app");
    if (this.now() < t.expiresAt - 60_000) return t.access_token;
    if (t.refresh_token && (!t.refreshExpiresAt || this.now() < t.refreshExpiresAt)) {
      const n = await this._tokenCall({ grant_type: "refresh_token", refresh_token: t.refresh_token });
      this.saveTokens({ ...t, ...n, refresh_token: n.refresh_token || t.refresh_token });
      return n.access_token;
    }
    throw cred("the LinkedIn connection expired: connect again with /linkedin");
  }

  async api(method, path, { body = null, headers = {}, raw = false } = {}) {
    const token = await this.token();
    const init = { method, headers: { authorization: `Bearer ${token}`, "LinkedIn-Version": this.version, "X-Restli-Protocol-Version": "2.0.0", ...headers } };
    if (body != null && !raw) { init.body = JSON.stringify(body); init.headers["content-type"] = "application/json"; }
    if (body != null && raw) init.body = body;
    const r = await this.fetch(`${API}${path}`, init);
    this.calls++;
    if (r.status === 401 || r.status === 403) { const txt = await r.text().catch(() => ""); throw cred(`LinkedIn refused the request (${r.status} on ${path.split("?")[0]}): ${txt.slice(0, 160)}`); }
    if (r.status === 429) { const e = new Error("LinkedIn rate limit"); e.rateLimited = true; e.service = "linkedin"; throw e; }
    if (r.status < 200 || r.status >= 300) { const txt = await r.text().catch(() => ""); const e = new Error(`LinkedIn answered ${r.status} on ${path.split("?")[0]}: ${txt.slice(0, 200)}`); e.status = r.status; throw e; }
    return r;
  }

  /// An image uploaded for a post. Returns the image urn.
  async uploadImage(file) {
    const author = this.author();
    if (!author) throw cred("LinkedIn is not connected");
    const r = await this.api("POST", "/rest/images?action=initializeUpload", { body: { initializeUploadRequest: { owner: author } } });
    const j = await r.json().catch(() => ({}));
    const up = j.value || {};
    if (!up.uploadUrl || !up.image) throw new Error("LinkedIn gave no upload address for the image");
    const bytes = readFileSync(file);
    const token = await this.token();
    const put = await this.fetch(up.uploadUrl, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": /\.png$/i.test(file) ? "image/png" : "image/jpeg" }, body: bytes });
    this.calls++;
    if (put.status < 200 || put.status >= 300) throw new Error(`the image upload failed: ${put.status}`);
    return up.image;
  }

  /// A post on the member's profile: the text, and an image when one is given. Returns { urn, url }.
  async post({ text, imageFile = null, imageTitle = "" }) {
    const author = this.author();
    if (!author) throw cred("LinkedIn is not connected: send /linkedin to the bot and allow the app");
    const body = { author, commentary: escapeCommentary(String(text || "").slice(0, 3000)), visibility: "PUBLIC", distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false };
    if (imageFile) { const image = await this.uploadImage(imageFile); body.content = { media: { title: String(imageTitle || "").slice(0, 200), id: image } }; }
    const r = await this.api("POST", "/rest/posts", { body });
    const urn = r.headers?.get?.("x-restli-id") || r.headers?.get?.("x-linkedin-id") || null;
    const url = urn ? `https://www.linkedin.com/feed/update/${urn}/` : null;
    this.log(`[linkedin] posted${urn ? " " + urn : ""}`);
    return { urn, url };
  }
}

function cred(message) { const e = new Error(message); e.credentials = true; e.service = "linkedin"; e.status = 401; return e; }
