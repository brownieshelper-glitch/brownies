// LinkedIn: the code becomes a 60-day token and the member's id, a post carries the author and the escaped text
// and comes back with its address, an image is uploaded first when given, the token's end is a credentials error,
// a refresh token is used when LinkedIn gave one, a 429 is a rate limit, and no token is logged.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { makeFetch } from "./mock.mjs";
import { Store } from "../lib/store.mjs";
import { FakeClock } from "../lib/clock.mjs";
import { LinkedIn, escapeCommentary, SCOPES } from "../lib/linkedin.mjs";
import { Connect } from "../lib/connect.mjs";

function mockLinkedIn(fetch) {
  const m = { tokens: 0, refreshes: 0, posts: [], uploads: [], giveRefresh: false, limit: false };
  const authed = (c) => /^Bearer li-(acc|ref)-\d+$/.test(c.headers.authorization || "");
  fetch.on("POST", "www.linkedin.com/oauth/v2/accessToken", (c) => {
    const f = new URLSearchParams(String(c.body));
    if (f.get("client_id") !== "cid" || f.get("client_secret") !== "csec") return { status: 401, json: { error: "invalid_client" } };
    if (f.get("grant_type") === "authorization_code") { m.tokens++; if (f.get("code") !== "good-code") return { status: 400, json: { error: "invalid_request", error_description: "bad code" } }; return { json: { access_token: "li-acc-1", expires_in: 5184000, scope: SCOPES.join(","), ...(m.giveRefresh ? { refresh_token: "li-r-1", refresh_token_expires_in: 31536000 } : {}) } }; }
    if (f.get("grant_type") === "refresh_token") { m.refreshes++; return { json: { access_token: `li-ref-${m.refreshes}`, expires_in: 5184000, refresh_token: "li-r-1", refresh_token_expires_in: 31536000 } }; }
    return { status: 400, json: { error: "unsupported_grant_type" } };
  });
  fetch.on("GET", "api.linkedin.com/v2/userinfo", (c) => (authed(c) ? { json: { sub: "AbC123", name: "Andrea Rossi", given_name: "Andrea", picture: "https://p/x.jpg" } } : { status: 401, json: {} }));
  fetch.on("POST", "api.linkedin.com/rest/posts", (c) => { if (!authed(c)) return { status: 401, text: "{}" }; if (m.limit) return { status: 429, text: "" }; if (c.headers["linkedin-version"] !== "202509" || c.headers["x-restli-protocol-version"] !== "2.0.0") return { status: 400, text: "missing headers" }; m.posts.push(c.body); return { status: 201, text: "", headers: { "x-restli-id": `urn:li:share:${7000 + m.posts.length}` } }; });
  fetch.on("POST", "api.linkedin.com/rest/images?action=initializeUpload", (c) => (authed(c) ? { json: { value: { uploadUrl: "https://upload.linkedin.test/img/1", image: "urn:li:image:C5F" } } } : { status: 401, text: "" }));
  fetch.on("PUT", "upload.linkedin.test/img/1", (c) => { m.uploads.push({ type: c.headers["content-type"], size: c.body?.length }); return { status: 201, text: "" }; });
  return m;
}
const world = () => { const fetch = makeFetch(); const store = new Store(":memory:"); const clock = new FakeClock(); const lines = []; const li = new LinkedIn({ clientId: "cid", clientSecret: "csec", redirectUri: "https://gw.test/linkedin/callback", store, clock, fetch, log: (l) => lines.push(String(l)) }); return { fetch, store, clock, li, lines, mock: mockLinkedIn(fetch) }; };

test("connecting: the login asks the three scopes, the code becomes a token and the member's id, and the owner is told", async () => {
  const { store, clock, li, mock, lines } = world();
  let told = null;
  const auth = new Connect({ name: "linkedin", client: li, store, clock, log: (l) => lines.push(String(l)), baseUrl: "https://gw.test", onConnected: async (me) => { told = me; } });
  const server = createServer((req, res) => (req.url.startsWith("/linkedin/") ? auth.handle(req, res) : (res.writeHead(404), res.end())));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path) => fetch(base + path, { redirect: "manual" });
  try {
    const link = auth.link();
    const r = await get(link.replace("https://gw.test", ""));
    const to = new URL(r.headers.get("location"));
    assert.equal(to.origin + to.pathname, "https://www.linkedin.com/oauth/v2/authorization");
    assert.equal(to.searchParams.get("scope"), "openid profile w_member_social");
    const state = to.searchParams.get("state");
    assert.equal((await get(`/linkedin/callback?error=user_cancelled_login&error_description=The+member+declined&state=${state}`)).status, 400, "a refusal is shown, not a crash");
    const link2 = auth.link(); const r2 = await get(link2.replace("https://gw.test", "")); const state2 = new URL(r2.headers.get("location")).searchParams.get("state");
    assert.equal((await get(`/linkedin/callback?code=good-code&state=${state2}`)).status, 200);
    assert.equal(mock.tokens, 1);
    assert.equal(li.connected, true);
    assert.equal(li.author(), "urn:li:person:AbC123");
    assert.equal(li.tokens().name, "Andrea Rossi");
    assert.equal(li.daysLeft(), 60);
    assert.deepEqual(told, { sub: "AbC123", name: "Andrea Rossi" });
    assert.ok(lines.every((l) => !/li-acc-1/.test(l)), "no token in the log");
  } finally { server.close(); }
});

test("a post carries the author, the escaped text, the public visibility, and comes back with its address; an image is uploaded first", async () => {
  const { li, mock, clock } = world();
  li.saveTokens({ access_token: "li-acc-1", expiresAt: clock.now() + 60 * 86400_000, sub: "AbC123", name: "Andrea Rossi" });
  const r = await li.post({ text: "Day 12 of building Brownies (the kitchen).\n\nFour AI helpers, one founder. #brownies" });
  assert.deepEqual(r, { urn: "urn:li:share:7001", url: "https://www.linkedin.com/feed/update/urn:li:share:7001/" });
  const body = mock.posts[0];
  assert.equal(body.author, "urn:li:person:AbC123");
  assert.equal(body.visibility, "PUBLIC"); assert.equal(body.lifecycleState, "PUBLISHED"); assert.equal(body.distribution.feedDistribution, "MAIN_FEED");
  assert.equal(body.commentary, "Day 12 of building Brownies \\(the kitchen\\).\n\nFour AI helpers, one founder. \\#brownies");
  assert.equal(body.content, undefined);
  assert.equal(escapeCommentary("a (b) [c] {d} <e> @f *g* _h_ ~i~ #j | k \\ l"), "a \\(b\\) \\[c\\] \\{d\\} \\<e\\> \\@f \\*g\\* \\_h\\_ \\~i\\~ \\#j \\| k \\\\ l");
  // with a picture
  const dir = mkdtempSync(join(tmpdir(), "brownies-li-"));
  const png = join(dir, "poster.png"); writeFileSync(png, Buffer.alloc(300, 7));
  const r2 = await li.post({ text: "With a picture.", imageFile: png, imageTitle: "The brownies" });
  assert.equal(r2.urn, "urn:li:share:7002");
  assert.deepEqual(mock.uploads, [{ type: "image/png", size: 300 }]);
  assert.deepEqual(mock.posts[1].content, { media: { title: "The brownies", id: "urn:li:image:C5F" } });
});

test("the token's end is a credentials error unless a refresh token was given; a 429 is a rate limit", async () => {
  const { li, mock, clock } = world();
  li.saveTokens({ access_token: "li-acc-1", expiresAt: clock.now() + 2 * 86400_000, sub: "AbC123", name: "Andrea Rossi" });
  assert.equal(li.daysLeft(), 2);
  clock.t += 3 * 86400_000;
  await assert.rejects(() => li.post({ text: "late" }), (e) => e.credentials === true && /connect again/.test(e.message));
  assert.equal(mock.posts.length, 0);
  li.saveTokens({ access_token: "li-acc-1", expiresAt: clock.now() - 1, refresh_token: "li-r-1", refreshExpiresAt: clock.now() + 300 * 86400_000, sub: "AbC123" });
  const r = await li.post({ text: "renewed" });
  assert.equal(mock.refreshes, 1); assert.ok(r.urn);
  assert.equal(li.tokens().access_token, "li-ref-1");
  mock.limit = true;
  await assert.rejects(() => li.post({ text: "again" }), (e) => e.rateLimited === true);
  await assert.rejects(() => new LinkedIn({ clientId: "cid", clientSecret: "csec", store: new Store(":memory:"), clock, fetch: makeFetch() }).post({ text: "x" }), /not connected/);
});
