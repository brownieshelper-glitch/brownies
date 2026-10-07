// The project's YouTube channel, through the Data API v3, with the tokens the owner made once on the PC
// (tools/youtube-auth.mjs -> helix-secrets/brownies-youtube.env, copied to the server's helpers env as
// YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN, YOUTUBE_CHANNEL_ID). A short-lived access token
// is minted from the refresh token when needed. What it can do: read the channel, set the banner, update the
// description and keywords, upload a video (resumable, one PUT for our small files), set a thumbnail, list the
// uploads. Nothing here ever logs a token; errors carry .status and, for a dead credential, .credentials = true.
import { readFileSync, statSync } from "node:fs";

const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export class YouTube {
  constructor({ clientId = "", clientSecret = "", refreshToken = "", channelId = "", fetch = globalThis.fetch, log = () => {}, now = () => Date.now() } = {}) {
    Object.assign(this, { clientId, clientSecret, refreshToken, channelId, fetch, log, now });
    this.access = null; // { token, expiresAt }
    this.calls = 0;
  }

  get configured() { return Boolean(this.clientId && this.clientSecret && this.refreshToken); }

  /// A live access token, minted from the refresh token and kept until a minute before it expires.
  async token({ fresh = false } = {}) {
    if (!this.configured) throw fail(503, "YouTube is not configured (YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN)");
    if (!fresh && this.access && this.now() < this.access.expiresAt - 60_000) return this.access.token;
    const r = await this.fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: this.clientId, client_secret: this.clientSecret, refresh_token: this.refreshToken }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      const e = fail(r.status || 502, `YouTube refused the refresh token (${j.error || r.status}${j.error_description ? ": " + j.error_description : ""})`);
      if (r.status === 400 || r.status === 401) { e.credentials = true; e.service = "youtube"; }
      throw e;
    }
    this.access = { token: j.access_token, expiresAt: this.now() + Number(j.expires_in || 3600) * 1000 };
    return this.access.token;
  }

  /// One API call. JSON in, JSON out; a 401 mints a new token and tries once more.
  async api(method, url, { body = null, headers = {}, rawBody = null, retry = true } = {}) {
    const token = await this.token();
    const init = { method, headers: { authorization: `Bearer ${token}`, ...headers } };
    if (rawBody != null) init.body = rawBody;
    else if (body != null) { init.body = JSON.stringify(body); init.headers["content-type"] = "application/json"; }
    const r = await this.fetch(url, init);
    this.calls++;
    if (r.status === 401 && retry) { await this.token({ fresh: true }); return this.api(method, url, { body, headers, rawBody, retry: false }); }
    const text = await r.text();
    let j = null; try { j = text ? JSON.parse(text) : null; } catch { j = { raw: text.slice(0, 200) }; }
    if (!r.ok) {
      const reason = j?.error?.errors?.[0]?.reason || j?.error?.status || "";
      const e = fail(r.status, `YouTube answered ${r.status}${reason ? " " + reason : ""}: ${j?.error?.message || text.slice(0, 160)}`);
      e.reason = reason;
      if (r.status === 403 && /insufficientPermissions|forbidden|accessNotConfigured/i.test(reason + " " + (j?.error?.message || ""))) { e.credentials = true; e.service = "youtube"; }
      if (r.status === 403 && /quota/i.test(reason)) e.rateLimited = true;
      throw e;
    }
    return { json: j, headers: r.headers };
  }

  /// What is trending on YouTube now: the most popular videos in a region, [{ id, title, channel, views, likes, tags, categoryId, url }].
  async trending({ regionCode = "US", max = 25, categoryId = null } = {}) {
    const q = new URLSearchParams({ chart: "mostPopular", part: "snippet,statistics", maxResults: String(Math.min(50, Math.max(1, Number(max) || 25))), regionCode });
    if (categoryId) q.set("videoCategoryId", String(categoryId));
    const { json } = await this.api("GET", `https://www.googleapis.com/youtube/v3/videos?${q}`);
    return (json?.items || []).map((v) => ({ id: v.id, title: v.snippet?.title || "", channel: v.snippet?.channelTitle || "", views: Number(v.statistics?.viewCount || 0), likes: Number(v.statistics?.likeCount || 0), tags: (v.snippet?.tags || []).slice(0, 10), categoryId: v.snippet?.categoryId || null, url: `https://www.youtube.com/watch?v=${v.id}` }));
  }

  /// The channel: snippet (title, description), brandingSettings, statistics, the uploads playlist.
  async channel() {
    const { json } = await this.api("GET", `${API}/channels?part=snippet,brandingSettings,statistics,contentDetails&mine=true`);
    const ch = json.items?.[0];
    if (!ch) throw fail(404, "no channel for this account");
    if (!this.channelId) this.channelId = ch.id;
    return ch;
  }

  /// Sets the banner from a PNG or JPEG (2560x1440 recommended), then points the channel at it.
  async setBanner(file) {
    const bytes = readFileSync(file);
    const type = /\.jpe?g$/i.test(file) ? "image/jpeg" : "image/png";
    const { json } = await this.api("POST", `${UPLOAD}/channelBanners/insert?uploadType=media`, { rawBody: bytes, headers: { "content-type": type, "content-length": String(bytes.length) } });
    if (!json?.url) throw fail(502, "the banner upload returned no url");
    await this.updateBranding({ bannerExternalUrl: json.url });
    return { url: json.url, bytes: bytes.length };
  }

  /// Updates the channel's description, keywords and banner url, keeping every other branding setting as it is
  /// (the API replaces the whole block, so the current one is read first).
  async updateBranding({ description, keywords, bannerExternalUrl, title, country, defaultLanguage } = {}) {
    const ch = await this.channel();
    const b = ch.brandingSettings || {};
    const channel = { ...(b.channel || {}) };
    if (description != null) channel.description = String(description).slice(0, 1000);
    if (keywords != null) channel.keywords = Array.isArray(keywords) ? keywords.map((k) => (/\s/.test(k) ? `"${k}"` : k)).join(" ").slice(0, 500) : String(keywords).slice(0, 500);
    if (title != null) channel.title = String(title).slice(0, 100);
    if (country != null) channel.country = country;
    if (defaultLanguage != null) channel.defaultLanguage = defaultLanguage;
    const image = { ...(b.image || {}) };
    if (bannerExternalUrl) image.bannerExternalUrl = bannerExternalUrl;
    // the API refuses read-only image fields when they are sent back; keep only the one that can be set
    const body = { id: ch.id, brandingSettings: { channel, ...(image.bannerExternalUrl ? { image: { bannerExternalUrl: image.bannerExternalUrl } } : {}) } };
    const { json } = await this.api("PUT", `${API}/channels?part=brandingSettings`, { body });
    return json.brandingSettings;
  }

  /// Uploads a video (resumable: one request for the metadata, one PUT for the bytes). Returns { id, url }.
  async upload({ file, title, description = "", tags = [], privacy = "unlisted", categoryId = "28", madeForKids = false, publishAt = null, language = "en" }) {
    if (!["public", "unlisted", "private"].includes(privacy)) throw fail(400, "privacy must be public, unlisted or private");
    const size = statSync(file).size;
    const meta = {
      snippet: { title: String(title).slice(0, 100), description: String(description).slice(0, 5000), tags: tags.slice(0, 30), categoryId: String(categoryId), defaultLanguage: language, defaultAudioLanguage: language },
      status: { privacyStatus: privacy, selfDeclaredMadeForKids: Boolean(madeForKids), ...(publishAt ? { publishAt } : {}) },
    };
    const init = await this.api("POST", `${UPLOAD}/videos?uploadType=resumable&part=snippet,status`, { body: meta, headers: { "x-upload-content-type": "video/mp4", "x-upload-content-length": String(size) } });
    const location = init.headers.get("location");
    if (!location) throw fail(502, "the upload session has no location");
    const bytes = readFileSync(file);
    const token = await this.token();
    const r = await this.fetch(location, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "video/mp4", "content-length": String(size) }, body: bytes });
    this.calls++;
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.id) throw fail(r.status || 502, `the video upload failed: ${j?.error?.message || r.status}`);
    this.log(`[youtube] uploaded "${meta.snippet.title}" as ${privacy}: https://youtu.be/${j.id} (${(size / 1e6).toFixed(2)} MB)`);
    return { id: j.id, url: `https://youtu.be/${j.id}`, title: meta.snippet.title, privacy, bytes: size };
  }

  /// A custom thumbnail (needs a verified account on YouTube's side; the caller may catch a 403).
  async setThumbnail(videoId, file) {
    const bytes = readFileSync(file);
    const type = /\.jpe?g$/i.test(file) ? "image/jpeg" : "image/png";
    const { json } = await this.api("POST", `${UPLOAD}/thumbnails/set?videoId=${encodeURIComponent(videoId)}`, { rawBody: bytes, headers: { "content-type": type, "content-length": String(bytes.length) } });
    return json.items?.[0] || json;
  }

  /// Changes a video's privacy (public, unlisted, private), keeping its snippet.
  async setPrivacy(videoId, privacy) {
    const { json } = await this.api("GET", `${API}/videos?part=snippet,status&id=${encodeURIComponent(videoId)}`);
    const v = json.items?.[0];
    if (!v) throw fail(404, `no video ${videoId}`);
    const body = { id: v.id, snippet: v.snippet, status: { ...v.status, privacyStatus: privacy } };
    const r = await this.api("PUT", `${API}/videos?part=snippet,status`, { body });
    return r.json.status;
  }

  /// The channel's uploads, newest first: [{ id, title, publishedAt, url }]. Cheap: reads the uploads playlist.
  async uploads(n = 10) {
    const ch = await this.channel();
    const pl = ch.contentDetails?.relatedPlaylists?.uploads;
    if (!pl) return [];
    const { json } = await this.api("GET", `${API}/playlistItems?part=snippet,contentDetails&playlistId=${encodeURIComponent(pl)}&maxResults=${Math.min(50, Math.max(1, n))}`);
    return (json.items || []).map((i) => ({ id: i.contentDetails.videoId, title: i.snippet.title, publishedAt: i.contentDetails.videoPublishedAt || i.snippet.publishedAt, url: `https://youtu.be/${i.contentDetails.videoId}` }));
  }
}

/// A client from the settings (the server's helpers env, or helix-secrets/brownies-youtube.env on the PC).
export function youtubeFromEnv(env = process.env, extra = {}) {
  return new YouTube({ clientId: env.YOUTUBE_CLIENT_ID || "", clientSecret: env.YOUTUBE_CLIENT_SECRET || "", refreshToken: env.YOUTUBE_REFRESH_TOKEN || "", channelId: env.YOUTUBE_CHANNEL_ID || "", ...extra });
}

function fail(status, message) { const e = new Error(message); e.status = status; return e; }
