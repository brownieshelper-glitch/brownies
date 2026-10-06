// The YouTube client: a refresh token becomes a short-lived access token (reused, re-minted on a 401), the
// branding update keeps the current settings and sends back only what can be set, an upload is one metadata
// request plus one PUT of the bytes to the session URL, a dead refresh token is a credentials error, and no log
// line ever carries a token.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFetch } from "./mock.mjs";
import { YouTube, youtubeFromEnv } from "../lib/youtube.mjs";

const CH = { id: "UCtest", snippet: { title: "feedthebrownies" }, statistics: { subscriberCount: "3", videoCount: "1" }, contentDetails: { relatedPlaylists: { uploads: "UUtest" } }, brandingSettings: { channel: { title: "feedthebrownies", description: "old", keywords: "a b", country: "IT" }, image: { bannerExternalUrl: "https://img/old", bannerImageUrl: "https://img/readonly" } } };

function mockYouTube(fetch) {
  const y = { tokens: 0, puts: [], uploads: [], banners: 0, badRefresh: false, expire401Once: false };
  fetch.on("POST", "oauth2.googleapis.com/token", (c) => {
    y.tokens++;
    const form = new URLSearchParams(String(c.body));
    if (y.badRefresh || form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== "refresh-1") return { status: 400, json: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
    return { json: { access_token: `access-${y.tokens}`, expires_in: 3600, token_type: "Bearer" } };
  });
  const authed = (c) => { if (y.expire401Once && c.headers.authorization === "Bearer access-1") { y.expire401Once = false; return false; } return /^Bearer access-\d+$/.test(c.headers.authorization || ""); };
  const no = { status: 401, json: { error: { code: 401, message: "Invalid Credentials", errors: [{ reason: "authError" }] } } };
  fetch.on("GET", /googleapis\.com\/youtube\/v3\/channels\?/, (c) => (authed(c) ? { json: { items: [CH] } } : no));
  fetch.on("PUT", /googleapis\.com\/youtube\/v3\/channels\?part=brandingSettings/, (c) => { if (!authed(c)) return no; y.puts.push(c.body); return { json: { id: c.body.id, brandingSettings: c.body.brandingSettings } }; });
  fetch.on("POST", /upload\/youtube\/v3\/channelBanners\/insert/, (c) => { if (!authed(c)) return no; y.banners++; return { json: { url: "https://img/new-banner" } }; });
  fetch.on("POST", /upload\/youtube\/v3\/videos\?uploadType=resumable/, (c) => { if (!authed(c)) return no; y.uploads.push({ meta: c.body, headers: c.headers }); return { status: 200, json: {}, headers: { location: "https://upload.test/session/1" } }; });
  fetch.on("PUT", "https://upload.test/session/1", (c) => { if (!authed(c)) return no; y.putBytes = c.headers["content-length"]; return { json: { id: "vid123", snippet: { title: "t" }, status: { privacyStatus: "unlisted" } } }; });
  fetch.on("GET", /googleapis\.com\/youtube\/v3\/playlistItems\?/, (c) => (authed(c) ? { json: { items: [{ snippet: { title: "Meet the Brownies", publishedAt: "2026-10-07T00:00:00Z" }, contentDetails: { videoId: "vid123", videoPublishedAt: "2026-10-07T00:00:00Z" } }] } } : no));
  fetch.on("GET", /googleapis\.com\/youtube\/v3\/videos\?/, (c) => (authed(c) ? { json: { items: [{ id: "vid123", snippet: { title: "t", categoryId: "28" }, status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false } }] } } : no));
  fetch.on("PUT", /googleapis\.com\/youtube\/v3\/videos\?part=snippet,status/, (c) => (authed(c) ? { json: { id: c.body.id, status: c.body.status } } : no));
  return y;
}

const client = (fetch, log = () => {}, now = () => 1_800_000_000_000) => youtubeFromEnv({ YOUTUBE_CLIENT_ID: "cid", YOUTUBE_CLIENT_SECRET: "csecret", YOUTUBE_REFRESH_TOKEN: "refresh-1", YOUTUBE_CHANNEL_ID: "" }, { fetch, log, now });

test("one access token serves many calls, is re-minted on a 401, and a dead refresh token is a credentials error", async () => {
  const fetch = makeFetch();
  const y = mockYouTube(fetch);
  const yt = client(fetch);
  assert.equal(yt.configured, true);
  assert.equal(new YouTube({}).configured, false);
  const ch = await yt.channel();
  assert.equal(ch.snippet.title, "feedthebrownies");
  assert.equal(yt.channelId, "UCtest", "the channel id is learnt");
  await yt.uploads(5);
  assert.equal(y.tokens, 1, "the token is reused");
  y.expire401Once = true;
  const list = await yt.uploads(5);
  assert.equal(y.tokens, 2, "a 401 mints a new token once");
  assert.equal(list[0].url, "https://youtu.be/vid123");
  y.badRefresh = true; yt.access = null;
  await assert.rejects(yt.channel(), (e) => e.credentials === true && e.service === "youtube" && /invalid_grant/.test(e.message));
});

test("the branding update keeps the current channel settings, replaces only what was given, and never sends read-only image fields", async () => {
  const fetch = makeFetch();
  const y = mockYouTube(fetch);
  const yt = client(fetch);
  await yt.updateBranding({ description: "new words", keywords: ["Brownies", "AI helpers"] });
  const sent = y.puts.at(-1);
  assert.equal(sent.id, "UCtest");
  assert.equal(sent.brandingSettings.channel.description, "new words");
  assert.equal(sent.brandingSettings.channel.keywords, 'Brownies "AI helpers"', "a keyword with a space is quoted");
  assert.equal(sent.brandingSettings.channel.title, "feedthebrownies", "the title is kept");
  assert.equal(sent.brandingSettings.channel.country, "IT", "other settings are kept");
  assert.equal(sent.brandingSettings.image.bannerExternalUrl, "https://img/old", "the current banner is kept");
  assert.equal(sent.brandingSettings.image.bannerImageUrl, undefined, "read-only image fields are not sent back");
  const dir = mkdtempSync(join(tmpdir(), "yt-"));
  const png = join(dir, "banner.png"); writeFileSync(png, Buffer.alloc(1000, 1));
  const r = await yt.setBanner(png);
  assert.equal(y.banners, 1);
  assert.equal(r.url, "https://img/new-banner");
  assert.equal(y.puts.at(-1).brandingSettings.image.bannerExternalUrl, "https://img/new-banner", "the channel points at the new banner");
  assert.equal(y.puts.at(-1).brandingSettings.channel.description, "old", "setting the banner leaves the description alone");
});

test("an upload is the metadata then the bytes; the privacy is checked; a log line names the video but no token", async () => {
  const fetch = makeFetch();
  const y = mockYouTube(fetch);
  const lines = [];
  const yt = client(fetch, (l) => lines.push(String(l)));
  const dir = mkdtempSync(join(tmpdir(), "yt-"));
  const mp4 = join(dir, "v.mp4"); writeFileSync(mp4, Buffer.alloc(2048, 7));
  await assert.rejects(yt.upload({ file: mp4, title: "t", privacy: "everyone" }), /privacy must be/);
  const v = await yt.upload({ file: mp4, title: "Meet the Brownies", description: "d", tags: ["a", "b"], privacy: "unlisted" });
  assert.equal(v.id, "vid123");
  assert.equal(v.url, "https://youtu.be/vid123");
  const u = y.uploads[0];
  assert.equal(u.meta.snippet.title, "Meet the Brownies");
  assert.deepEqual(u.meta.snippet.tags, ["a", "b"]);
  assert.equal(u.meta.status.privacyStatus, "unlisted");
  assert.equal(u.meta.status.selfDeclaredMadeForKids, false);
  assert.equal(u.headers["x-upload-content-length"], "2048");
  assert.equal(y.putBytes, "2048", "the bytes went to the session url");
  assert.ok(lines.some((l) => /uploaded "Meet the Brownies" as unlisted: https:\/\/youtu\.be\/vid123/.test(l)));
  assert.ok(lines.every((l) => !/access-|refresh-|csecret/.test(l)), "no token in the log");
  const s = await yt.setPrivacy("vid123", "public");
  assert.equal(s.privacyStatus, "public");
});
