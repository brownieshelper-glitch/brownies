// Instagram: the connect flow (a one-time link, the state, the code becomes a long-lived token, the owner is told),
// a reel published from a public link with the status polled until ready, a picture published, the token renewed
// after a week, a dead token as a credentials error, and no token in any log line.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { makeFetch } from "./mock.mjs";
import { Store } from "../lib/store.mjs";
import { FakeClock } from "../lib/clock.mjs";
import { Instagram, SCOPES } from "../lib/instagram.mjs";
import { Connect } from "../lib/connect.mjs";

function mockInstagram(fetch) {
  const m = { codes: 0, longs: 0, refreshes: 0, containers: [], published: [], statusCalls: 0, statuses: ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"], dead: false };
  const authed = (c) => { const u = new URL(c.url); const t = u.searchParams.get("access_token"); return !m.dead && /^long-\d+$/.test(t || ""); };
  const no = { status: 400, json: { error: { message: "Error validating access token: Session has expired", type: "OAuthException", code: 190 } } };
  fetch.on("POST", "api.instagram.com/oauth/access_token", (c) => { const f = new URLSearchParams(String(c.body)); m.codes++; if (f.get("client_id") !== "app" || f.get("client_secret") !== "sec" || f.get("code") !== "good-code") return { status: 400, json: { error_message: "Invalid authorization code", code: 400 } }; return { json: { access_token: "short-1", user_id: "17841400000", permissions: SCOPES } }; });
  fetch.on("GET", /graph\.instagram\.com\/access_token\?/, (c) => { const u = new URL(c.url); m.longs++; if (u.searchParams.get("access_token") !== "short-1" || u.searchParams.get("client_secret") !== "sec") return { status: 400, json: { error: { message: "bad", code: 100 } } }; return { json: { access_token: "long-1", token_type: "bearer", expires_in: 5184000 } }; });
  fetch.on("GET", /graph\.instagram\.com\/refresh_access_token\?/, (c) => { const u = new URL(c.url); m.refreshes++; if (!/^long-\d+$/.test(u.searchParams.get("access_token") || "")) return no; return { json: { access_token: `long-${1 + m.refreshes}`, token_type: "bearer", expires_in: 5184000 } }; });
  fetch.on("GET", /graph\.instagram\.com\/v21\.0\/me\?/, (c) => (authed(c) ? { json: { id: "17841400000", username: "feedthebrownies", account_type: "BUSINESS", name: "Brownies" } } : no));
  fetch.on("POST", /graph\.instagram\.com\/v21\.0\/17841400000\/media\?/, (c) => { if (!authed(c)) return no; const f = new URLSearchParams(String(c.body)); m.containers.push(Object.fromEntries(f)); return { json: { id: `c-${m.containers.length}` } }; });
  fetch.on("GET", /graph\.instagram\.com\/v21\.0\/c-\d+\?/, (c) => { if (!authed(c)) return no; const s = m.statuses[Math.min(m.statusCalls, m.statuses.length - 1)]; m.statusCalls++; return { json: { status_code: s, status: s === "ERROR" ? "Media upload failed" : "", id: "c-1" } }; });
  fetch.on("POST", /graph\.instagram\.com\/v21\.0\/17841400000\/media_publish\?/, (c) => { if (!authed(c)) return no; const f = new URLSearchParams(String(c.body)); m.published.push(f.get("creation_id")); return { json: { id: `p-${m.published.length}` } }; });
  fetch.on("GET", /graph\.instagram\.com\/v21\.0\/p-\d+\?/, (c) => (authed(c) ? { json: { permalink: "https://www.instagram.com/reel/ABC123/" } } : no));
  return m;
}
const world = () => { const fetch = makeFetch(); const store = new Store(":memory:"); const clock = new FakeClock(); const lines = []; const ig = new Instagram({ appId: "app", appSecret: "sec", redirectUri: "https://gw.test/instagram/callback", store, clock, fetch, log: (l) => lines.push(String(l)), sleep: async () => {} }); return { fetch, store, clock, ig, lines, mock: mockInstagram(fetch) }; };

test("connecting: the link works once, the state is checked, the code becomes a long-lived token and the owner is told", async () => {
  const { store, clock, ig, mock, lines } = world();
  let told = null;
  const auth = new Connect({ name: "instagram", client: ig, store, clock, log: (l) => lines.push(String(l)), baseUrl: "https://gw.test", onConnected: async (me) => { told = me; } });
  const server = createServer((req, res) => (req.url.startsWith("/instagram/") ? auth.handle(req, res) : (res.writeHead(404), res.end())));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path) => fetch(base + path, { redirect: "manual" });
  try {
    assert.equal(ig.configured, true); assert.equal(ig.connected, false);
    assert.equal((await get("/instagram/start?t=nope")).status, 403);
    const link = auth.link();
    const r = await get(link.replace("https://gw.test", ""));
    assert.equal(r.status, 302);
    const to = new URL(r.headers.get("location"));
    assert.equal(to.origin + to.pathname, "https://www.instagram.com/oauth/authorize");
    assert.equal(to.searchParams.get("scope"), "instagram_business_basic,instagram_business_content_publish");
    assert.equal(to.searchParams.get("redirect_uri"), "https://gw.test/instagram/callback");
    const state = to.searchParams.get("state");
    assert.equal((await get(link.replace("https://gw.test", ""))).status, 403, "a link works once");
    assert.equal((await get(`/instagram/callback?code=good-code&state=wrong`)).status, 400);
    const ok = await get(`/instagram/callback?code=good-code%23_&state=${state}`); // Instagram appends #_ to the code
    assert.equal(ok.status, 200);
    assert.equal(mock.codes, 1); assert.equal(mock.longs, 1);
    assert.equal(ig.connected, true);
    const t = ig.tokens();
    assert.equal(t.username, "feedthebrownies"); assert.equal(t.account_type, "BUSINESS"); assert.equal(t.user_id, "17841400000");
    assert.equal(ig.daysLeft(), 60);
    assert.deepEqual(told, { id: "17841400000", username: "feedthebrownies", name: "@feedthebrownies", account_type: "BUSINESS" });
    assert.ok(lines.every((l) => !/long-1|short-1/.test(l)), "no token in the log");
  } finally { server.close(); }
});

test("a reel: the container is made from the link, its status is polled until FINISHED, then it is published and the permalink read", async () => {
  const { ig, mock, clock } = world();
  ig.saveTokens({ access_token: "long-1", expiresAt: clock.now() + 60 * 86400_000, obtainedAt: clock.now(), user_id: "17841400000", username: "feedthebrownies" });
  const r = await ig.publishReel({ videoUrl: "https://gw.test/clips/abc.mp4", caption: "Ep. 1: The Bell. #brownies" });
  assert.deepEqual(r, { id: "p-1", url: "https://www.instagram.com/reel/ABC123/", container: "c-1" });
  assert.equal(mock.containers[0].media_type, "REELS");
  assert.equal(mock.containers[0].video_url, "https://gw.test/clips/abc.mp4");
  assert.equal(mock.containers[0].caption, "Ep. 1: The Bell. #brownies");
  assert.equal(mock.containers[0].share_to_feed, "true");
  assert.equal(mock.statusCalls, 3, "polled until FINISHED");
  assert.deepEqual(mock.published, ["c-1"]);
  // a picture needs no polling
  const p = await ig.publishImage({ imageUrl: "https://gw.test/clips/meme.png", caption: "A meme" });
  assert.equal(p.id, "p-2");
  assert.equal(mock.containers[1].image_url, "https://gw.test/clips/meme.png");
  // a failed container is an error, not a publish
  mock.statuses = ["ERROR"]; mock.statusCalls = 0;
  await assert.rejects(() => ig.publishReel({ videoUrl: "https://gw.test/clips/bad.mp4", caption: "x" }), /could not take the video/);
  assert.equal(mock.published.length, 2);
});

test("the token is renewed by itself after a week; an expired one, or a dead one, is a credentials error", async () => {
  const { ig, mock, clock } = world();
  ig.saveTokens({ access_token: "long-1", expiresAt: clock.now() + 60 * 86400_000, obtainedAt: clock.now(), user_id: "17841400000" });
  await ig.me();
  assert.equal(mock.refreshes, 0, "fresh: no renewal");
  clock.t += 8 * 86400_000;
  await ig.me();
  assert.equal(mock.refreshes, 1, "a week old: renewed");
  assert.equal(ig.tokens().access_token, "long-2");
  assert.equal(ig.daysLeft(), 60);
  ig.saveTokens({ ...ig.tokens(), expiresAt: clock.now() - 1 });
  await assert.rejects(() => ig.me(), (e) => e.credentials === true && /expired/.test(e.message));
  ig.saveTokens({ access_token: "long-9", expiresAt: clock.now() + 60 * 86400_000, obtainedAt: clock.now(), user_id: "17841400000" });
  mock.dead = true;
  await assert.rejects(() => ig.me(), (e) => e.credentials === true && e.code === 190);
  ig.disconnect();
  assert.equal(ig.connected, false);
  await assert.rejects(() => ig.me(), /not connected/);
});

test("Facebook Login: the dialog asks the Page scopes, the code becomes a long user token and the Page token of the Page with the Instagram account, and reels go through graph.facebook.com", async () => {
  const mf = makeFetch(); const store = new Store(":memory:"); const clock = new FakeClock(); const lines = [];
  const m = { codes: 0, longs: 0, pages: [{ id: "p1", name: "Brownies", access_token: "page-tok-1", instagram_business_account: { id: "17841499", username: "feedthebrownies", name: "Brownies" } }, { id: "p0", name: "Old page", access_token: "page-tok-0" }], containers: [], published: [] };
  mf.on("GET", /graph\.facebook\.com\/v21\.0\/oauth\/access_token\?/, (c) => { const u = new URL(c.url); if (u.searchParams.get("grant_type") === "fb_exchange_token") { m.longs++; return u.searchParams.get("fb_exchange_token").startsWith("short-") || u.searchParams.get("fb_exchange_token").startsWith("long-") ? { json: { access_token: `long-${m.longs}`, token_type: "bearer", expires_in: 5183944 } } : { status: 400, json: { error: { message: "bad", code: 190 } } }; } m.codes++; if (u.searchParams.get("client_id") !== "app" || u.searchParams.get("client_secret") !== "sec" || u.searchParams.get("code") !== "good-code") return { status: 400, json: { error: { message: "Invalid verification code", code: 100 } } }; return { json: { access_token: "short-1", token_type: "bearer", expires_in: 5000 } }; });
  mf.on("GET", /graph\.facebook\.com\/v21\.0\/me\/accounts\?/, (c) => (new URL(c.url).searchParams.get("access_token") === `long-${m.longs}` ? { json: { data: m.pages } } : { status: 401, json: { error: { message: "no", code: 190 } } }));
  const authed = (c) => new URL(c.url).searchParams.get("access_token") === "page-tok-1";
  mf.on("GET", /graph\.facebook\.com\/v21\.0\/17841499\?/, (c) => (authed(c) ? { json: { id: "17841499", username: "feedthebrownies", name: "Brownies" } } : { status: 401, json: { error: { message: "no", code: 190 } } }));
  mf.on("POST", /graph\.facebook\.com\/v21\.0\/17841499\/media\?/, (c) => { if (!authed(c)) return { status: 401, json: { error: { code: 190, message: "no" } } }; m.containers.push(Object.fromEntries(new URLSearchParams(String(c.body)))); return { json: { id: `c-${m.containers.length}` } }; });
  mf.on("GET", /graph\.facebook\.com\/v21\.0\/c-\d+\?/, () => ({ json: { status_code: "FINISHED" } }));
  mf.on("POST", /graph\.facebook\.com\/v21\.0\/17841499\/media_publish\?/, (c) => { if (!authed(c)) return { status: 401, json: { error: { code: 190, message: "no" } } }; m.published.push(new URLSearchParams(String(c.body)).get("creation_id")); return { json: { id: `p-${m.published.length}` } }; });
  mf.on("GET", /graph\.facebook\.com\/v21\.0\/p-\d+\?/, () => ({ json: { permalink: "https://www.instagram.com/reel/FB123/" } }));
  const ig = new Instagram({ appId: "app", appSecret: "sec", login: "facebook", redirectUri: "https://gw.test/instagram/callback", store, clock, fetch: mf, log: (l) => lines.push(String(l)), sleep: async () => {} });
  let told = null;
  const auth = new Connect({ name: "instagram", client: ig, store, clock, log: (l) => lines.push(String(l)), baseUrl: "https://gw.test", onConnected: async (me) => { told = me; } });
  const server = createServer((req, res) => (req.url.startsWith("/instagram/") ? auth.handle(req, res) : (res.writeHead(404), res.end())));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path) => fetch(base + path, { redirect: "manual" });
  try {
    assert.equal(ig.facebook, true);
    const r = await get(auth.link().replace("https://gw.test", ""));
    const to = new URL(r.headers.get("location"));
    assert.equal(to.origin + to.pathname, "https://www.facebook.com/v21.0/dialog/oauth");
    assert.equal(to.searchParams.get("scope"), "instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement,business_management");
    assert.equal(to.searchParams.get("response_type"), "code");
    const state = to.searchParams.get("state");
    assert.equal((await get(`/instagram/callback?error=access_denied&error_reason=user_denied&state=${state}`)).status, 400);
    const link2 = auth.link(); const state2 = new URL((await get(link2.replace("https://gw.test", ""))).headers.get("location")).searchParams.get("state");
    assert.equal((await get(`/instagram/callback?code=good-code&state=${state2}`)).status, 200);
    assert.equal(m.codes, 1); assert.equal(m.longs, 1);
    const t = ig.tokens();
    assert.equal(t.login, "facebook"); assert.equal(t.page_id, "p1"); assert.equal(t.page_token, "page-tok-1"); assert.equal(t.user_id, "17841499"); assert.equal(t.username, "feedthebrownies");
    assert.equal(ig.daysLeft(), null, "the Page token does not expire");
    assert.deepEqual(told, { id: "17841499", username: "feedthebrownies", name: "@feedthebrownies", account_type: "professional", page: "Brownies" });
    assert.ok(lines.every((l) => !/page-tok|long-1|short-1/.test(l)), "no token in the log");
    const out = await ig.publishReel({ videoUrl: "https://gw.test/clips/abc.mp4", caption: "Ep. 1" });
    assert.deepEqual(out, { id: "p-1", url: "https://www.instagram.com/reel/FB123/", container: "c-1" });
    assert.equal(m.containers[0].media_type, "REELS"); assert.equal(m.containers[0].video_url, "https://gw.test/clips/abc.mp4");
    assert.deepEqual(await ig.me(), { id: "17841499", username: "feedthebrownies", name: "Brownies", account_type: "professional" });
    // ten days on: the user token behind the Page token is renewed once, the Page token keeps working
    clock.t += 10 * 86400_000;
    await ig.me();
    assert.equal(m.longs, 2);
    assert.equal(ig.tokens().access_token, "long-2");
    // a Page owned by a business portfolio: /me/accounts is empty, the portfolio lookup finds it and reads its token
    m.pages = [];
    let bizData = [{ id: "biz1", name: "Brownies", owned_pages: { data: [{ id: "p7", name: "Feedthebrownies", instagram_business_account: { id: "17841499", username: "feedthebrownies" } }] } }];
    mf.on("GET", /graph\.facebook\.com\/v21\.0\/me\/businesses\?/, () => ({ json: { data: bizData } }));
    mf.on("GET", /graph\.facebook\.com\/v21\.0\/p7\?/, (c) => (new URL(c.url).searchParams.get("access_token").startsWith("long-") ? { json: { id: "p7", name: "Feedthebrownies", access_token: "page-tok-1", instagram_business_account: { id: "17841499", username: "feedthebrownies", name: "Brownies" } } } : { status: 401, json: { error: { code: 190, message: "no" } } }));
    ig.disconnect();
    const link4 = auth.link(); const state4 = new URL((await get(link4.replace("https://gw.test", ""))).headers.get("location")).searchParams.get("state");
    assert.equal((await get(`/instagram/callback?code=good-code&state=${state4}`)).status, 200);
    assert.equal(ig.tokens().page_id, "p7"); assert.equal(ig.tokens().page_token, "page-tok-1");
    // no Page with an Instagram account anywhere: a credentials error that says what to link
    bizData = [];
    m.pages = [{ id: "p0", name: "Old page", access_token: "page-tok-0" }];
    ig.disconnect();
    const link3 = auth.link(); const state3 = new URL((await get(link3.replace("https://gw.test", ""))).headers.get("location")).searchParams.get("state");
    const bad = await get(`/instagram/callback?code=good-code&state=${state3}`);
    assert.equal(bad.status, 500, "the connect page shows the reason");
    assert.match(await bad.text(), /no Facebook Page you manage has a linked Instagram professional account/);
    assert.equal(ig.connected, false);
  } finally { server.close(); }
});
