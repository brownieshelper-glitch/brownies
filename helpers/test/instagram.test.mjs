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
