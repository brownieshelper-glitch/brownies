// TikTok: the connect flow (a one-time ticket, the state, the code becomes tokens, the owner is told), tokens
// refreshed a minute before they expire and a dead refresh token is a credentials error, an inbox upload is an
// init plus a PUT of the bytes with the right range, a direct post carries the caption and the privacy level, the
// status is polled until final, the chunk plan follows TikTok's limits, and no log line carries a token.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFetch } from "./mock.mjs";
import { Store } from "../lib/store.mjs";
import { FakeClock } from "../lib/clock.mjs";
import { TikTok, TikTokAuth, SCOPES } from "../lib/tiktok.mjs";

function mockTikTok(fetch) {
  const t = { tokens: 0, refreshes: 0, badRefresh: false, inits: [], puts: [], statuses: ["PROCESSING_UPLOAD", "SEND_TO_USER_INBOX"], statusCalls: 0, expire401Once: false };
  fetch.on("POST", "open.tiktokapis.com/v2/oauth/token/", (c) => {
    const form = new URLSearchParams(String(c.body));
    if (form.get("client_key") !== "ck" || form.get("client_secret") !== "cs") return { status: 401, json: { error: "invalid_client" } };
    if (form.get("grant_type") === "authorization_code") { t.tokens++; if (form.get("code") !== "good-code") return { status: 400, json: { error: "invalid_grant", error_description: "bad code" } }; return { json: { access_token: "acc-1", expires_in: 86400, refresh_token: "ref-1", refresh_expires_in: 31536000, open_id: "open-1", scope: SCOPES.join(",") } }; }
    if (form.get("grant_type") === "refresh_token") { if (t.badRefresh || form.get("refresh_token") !== "ref-1") return { status: 400, json: { error: "invalid_grant", error_description: "refresh token expired" } }; t.refreshes++; return { json: { access_token: `acc-${1 + t.refreshes}`, expires_in: 86400, refresh_token: "ref-1", refresh_expires_in: 31536000, open_id: "open-1", scope: SCOPES.join(",") } }; }
    return { status: 400, json: { error: "unsupported_grant_type" } };
  });
  const authed = (c) => { if (t.expire401Once && c.headers.authorization === "Bearer acc-1") { t.expire401Once = false; return false; } return /^Bearer acc-\d+$/.test(c.headers.authorization || ""); };
  const no = { status: 401, json: { error: { code: "access_token_invalid", message: "The access token is invalid or not found in the request." } } };
  fetch.on("GET", /open\.tiktokapis\.com\/v2\/user\/info\//, (c) => (authed(c) ? { json: { data: { user: { open_id: "open-1", username: "feedthebrownies", display_name: "Brownies", avatar_url: "https://a/b.png" } }, error: { code: "ok", message: "" } } } : no));
  fetch.on("POST", /v2\/post\/publish\/creator_info\/query\//, (c) => (authed(c) ? { json: { data: { creator_username: "feedthebrownies", privacy_level_options: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"], max_video_post_duration_sec: 600 }, error: { code: "ok" } } } : no));
  fetch.on("POST", /v2\/post\/publish\/(inbox\/video|video)\/init\//, (c) => { if (!authed(c)) return no; t.inits.push({ url: c.url, body: c.body }); return { json: { data: { publish_id: `pub-${t.inits.length}`, upload_url: `https://upload.tiktok.test/u/${t.inits.length}` }, error: { code: "ok" } } }; });
  fetch.on("PUT", /upload\.tiktok\.test\/u\//, (c) => { if (!authed(c)) return no; t.puts.push({ url: c.url, headers: c.headers, size: c.body?.length }); return { status: 201, json: {} }; });
  fetch.on("POST", /v2\/post\/publish\/status\/fetch\//, (c) => { if (!authed(c)) return no; const s = t.statuses[Math.min(t.statusCalls, t.statuses.length - 1)]; t.statusCalls++; return { json: { data: { status: s, publicaly_available_post_id: s === "PUBLISH_COMPLETE" ? ["7123"] : [], uploaded_bytes: 2048 }, error: { code: "ok" } } }; });
  return t;
}
const world = () => { const fetch = makeFetch(); const store = new Store(":memory:"); const clock = new FakeClock(); const lines = []; const tiktok = new TikTok({ clientKey: "ck", clientSecret: "cs", redirectUri: "https://gw.test/tiktok/callback", store, clock, fetch, log: (l) => lines.push(String(l)) }); return { fetch, store, clock, tiktok, lines, mock: mockTikTok(fetch) }; };

test("connecting: a one-time ticket opens the TikTok login with a state, the callback checks the state, trades the code, keeps the tokens and tells the owner", async () => {
  const { store, clock, tiktok, mock, lines } = world();
  let told = null;
  const auth = new TikTokAuth({ tiktok, store, clock, log: (l) => lines.push(String(l)), baseUrl: "https://gw.test", onConnected: async (me) => { told = me; } });
  const server = createServer((req, res) => (req.url.startsWith("/tiktok/") ? auth.handle(req, res) : (res.writeHead(404), res.end())));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path) => fetch(base + path, { redirect: "manual" });
  try {
    assert.equal(tiktok.configured, true); assert.equal(tiktok.connected, false);
    assert.equal((await get("/tiktok/start?t=nope")).status, 403, "a made-up ticket");
    const link = auth.link();
    assert.ok(link.startsWith("https://gw.test/tiktok/start?t="));
    const r = await get(link.replace("https://gw.test", ""));
    assert.equal(r.status, 302);
    const to = new URL(r.headers.get("location"));
    assert.equal(to.origin + to.pathname, "https://www.tiktok.com/v2/auth/authorize/");
    assert.equal(to.searchParams.get("client_key"), "ck");
    assert.equal(to.searchParams.get("scope"), "user.info.basic,video.upload,video.publish");
    assert.equal(to.searchParams.get("redirect_uri"), "https://gw.test/tiktok/callback");
    const state = to.searchParams.get("state");
    assert.ok(/^[0-9a-f]{32}$/.test(state));
    assert.equal((await get(link.replace("https://gw.test", ""))).status, 403, "a ticket works once");
    assert.equal((await get(`/tiktok/callback?code=good-code&state=wrong`)).status, 400, "a wrong state");
    const link2 = auth.link(); const r2 = await get(link2.replace("https://gw.test", "")); const state2 = new URL(r2.headers.get("location")).searchParams.get("state");
    const cb = await get(`/tiktok/callback?code=good-code&state=${state2}`);
    assert.equal(cb.status, 200);
    assert.match(await cb.text(), /TikTok is connected/);
    assert.equal(tiktok.connected, true);
    assert.equal(tiktok.tokens().username, "feedthebrownies");
    assert.equal(tiktok.tokens().open_id, "open-1");
    assert.deepEqual(told, { open_id: "open-1", username: "feedthebrownies", display_name: "Brownies", name: "Brownies", scope: SCOPES.join(",") });
    assert.equal(mock.tokens, 1);
    assert.ok(lines.every((l) => !/acc-|ref-|cs\b/.test(l)), "no token in the log");
    // a bad code
    const link3 = auth.link(); const r3 = await get(link3.replace("https://gw.test", "")); const state3 = new URL(r3.headers.get("location")).searchParams.get("state");
    const bad = await get(`/tiktok/callback?code=bad&state=${state3}`);
    assert.equal(bad.status, 500); assert.match(await bad.text(), /refused the authorization_code/);
    // TikTok's own refusal
    const link4 = auth.link(); const r4 = await get(link4.replace("https://gw.test", "")); const state4 = new URL(r4.headers.get("location")).searchParams.get("state");
    const denied = await get(`/tiktok/callback?error=access_denied&error_description=The+user+denied&state=${state4}`);
    assert.equal(denied.status, 400); assert.match(await denied.text(), /TikTok said no/);
  } finally { await new Promise((r) => server.close(r)); }
});

test("tokens: reused while fresh, refreshed a minute before they expire and on a 401; a dead refresh token is a credentials error", async () => {
  const { tiktok, clock, mock } = world();
  await tiktok.exchange("good-code");
  const me = await tiktok.me();
  assert.equal(me.username, "feedthebrownies");
  assert.equal(mock.refreshes, 0, "fresh token reused");
  clock.advance(86400 * 1000 - 30_000);
  await tiktok.me();
  assert.equal(mock.refreshes, 1, "refreshed a minute before expiry");
  mock.expire401Once = true; tiktok.saveTokens({ ...tiktok.tokens(), access_token: "acc-1" });
  await tiktok.creatorInfo();
  assert.equal(mock.refreshes, 2, "a 401 refreshes once and retries");
  mock.badRefresh = true; tiktok.saveTokens({ ...tiktok.tokens(), expiresAt: 0 });
  await assert.rejects(tiktok.me(), (e) => e.credentials === true && e.service === "tiktok" && /refresh token expired/.test(e.message));
  tiktok.disconnect();
  assert.equal(tiktok.connected, false);
  await assert.rejects(tiktok.me(), /not connected/);
});

test("an inbox upload is an init and one PUT with the range; a direct post carries the caption and privacy; the status is polled until final; big files are chunked by TikTok's rules", async () => {
  const { tiktok, mock } = world();
  await tiktok.exchange("good-code");
  const dir = mkdtempSync(join(tmpdir(), "tt-"));
  const file = join(dir, "v.mp4"); writeFileSync(file, Buffer.alloc(2048, 7));
  const up = await tiktok.uploadInbox({ file });
  assert.deepEqual(up, { publishId: "pub-1", bytes: 2048, chunks: 1 });
  assert.match(mock.inits[0].url, /inbox\/video\/init/);
  assert.deepEqual(mock.inits[0].body, { source_info: { source: "FILE_UPLOAD", video_size: 2048, chunk_size: 2048, total_chunk_count: 1 } });
  assert.equal(mock.puts[0].headers["content-range"], "bytes 0-2047/2048");
  assert.equal(mock.puts[0].headers["content-type"], "video/mp4");
  assert.equal(mock.puts[0].size, 2048);
  const st = await tiktok.waitForStatus("pub-1", { tries: 5, everyMs: 1, sleep: async () => {} });
  assert.equal(st.status, "SEND_TO_USER_INBOX");
  assert.equal(mock.statusCalls, 2, "polled until final");
  const post = await tiktok.directPost({ file, title: "Meet the Brownies #brownies", privacy: "SELF_ONLY" });
  assert.equal(post.publishId, "pub-2");
  assert.match(mock.inits[1].url, /\/post\/publish\/video\/init\//);
  assert.deepEqual(mock.inits[1].body.post_info, { title: "Meet the Brownies #brownies", privacy_level: "SELF_ONLY", disable_duet: false, disable_comment: false, disable_stitch: false, video_cover_timestamp_ms: 1000 });
  assert.deepEqual(TikTok.chunks(3_000_000), { chunkSize: 3_000_000, count: 1 });
  assert.deepEqual(TikTok.chunks(64 * 1024 * 1024), { chunkSize: 64 * 1024 * 1024, count: 1 });
  const big = TikTok.chunks(100 * 1024 * 1024);
  assert.equal(big.chunkSize, 10 * 1024 * 1024); assert.equal(big.count, 10);
  const odd = TikTok.chunks(102 * 1024 * 1024); // 10 chunks of 10 MB and 2 MB over: the 2 MB joins the last chunk
  assert.equal(odd.count, 9);
});
