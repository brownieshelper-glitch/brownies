// The X client renews its token on 401 and when it is old, and persists the new pair atomically.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../lib/clock.mjs";
import { XClient, CredentialsError } from "../lib/xapi.mjs";
import { makeFetch, mockX } from "./mock.mjs";

const T0 = Date.UTC(2026, 9, 7, 8, 0, 0);
const tmp = () => join(mkdtempSync(join(tmpdir(), "brownies-x-")), "x-token.json");

test("a token of unknown age is renewed before the first call, and the new pair is written to the file", async () => {
  const fetch = makeFetch(), clock = new FakeClock(T0), xm = mockX(fetch), file = tmp();
  const x = new XClient({ clientId: "cid", clientSecret: "sec", accessToken: "access-old", refreshToken: "refresh-old", tokenFile: file, username: "Feedthebrownies", fetch, clock });
  const posted = await x.post("Hello from the test.");
  assert.equal(xm.refreshes, 1);
  assert.deepEqual(posted, { id: "1000", url: "https://x.com/Feedthebrownies/status/1000" });
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual([saved.access_token, saved.refresh_token, saved.obtained_at], ["access-1", "refresh-1", T0]);
  assert.equal(existsSync(file + ".tmp"), false, "no temp file left behind");
  const tokenCall = xm.tokenCalls[0];
  assert.match(tokenCall.headers.authorization, /^Basic /);
  assert.match(String(tokenCall.body), /grant_type=refresh_token/);
});

test("a 401 renews the token once and retries; the rotated refresh token is the one kept", async () => {
  const fetch = makeFetch(), clock = new FakeClock(T0), xm = mockX(fetch), file = tmp();
  const x = new XClient({ clientId: "cid", accessToken: "access-old", refreshToken: "refresh-old", tokenFile: file, fetch, clock });
  x.pair.obtained_at = T0; // pretend it is fresh
  await x.post("one");
  assert.equal(xm.refreshes, 0, "a fresh valid token is used as is");
  xm.validAccess = "revoked-on-the-server"; // X stops taking the old access token
  await x.post("two");
  assert.equal(xm.refreshes, 1);
  assert.equal(xm.posts.length, 2);
  assert.equal(x.pair.refresh_token, xm.currentRefresh, "the client holds the rotated refresh token");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).refresh_token, "refresh-1");
  assert.equal(fetch.callsTo("/2/tweets").length, 3, "the failed call, then the retry");
});

test("a token older than 100 minutes is renewed before the call", async () => {
  const fetch = makeFetch(), clock = new FakeClock(T0), xm = mockX(fetch);
  const x = new XClient({ clientId: "cid", accessToken: "access-old", refreshToken: "refresh-old", fetch, clock });
  x.pair.obtained_at = T0;
  await x.me();
  assert.equal(xm.refreshes, 0);
  await clock.advance(101 * 60_000);
  await x.post("later");
  assert.equal(xm.refreshes, 1);
  assert.equal(fetch.callsTo("/2/tweets").length, 1, "renewed first, no failed call");
});

test("a saved pair wins over the env pair, and a refused refresh is a credentials error", async () => {
  const fetch = makeFetch(), clock = new FakeClock(T0), xm = mockX(fetch), file = tmp();
  writeFileSync(file, JSON.stringify({ access_token: "saved-access", refresh_token: "saved-refresh", obtained_at: T0 }));
  const x = new XClient({ clientId: "cid", accessToken: "env-access", refreshToken: "env-refresh", tokenFile: file, fetch, clock });
  assert.equal(x.pair.access_token, "saved-access");
  xm.refuseRefresh = true;
  await assert.rejects(() => x.post("x"), (e) => e instanceof CredentialsError && e.service === "x");
  assert.equal(xm.posts.length, 0);
});

test("a 403 for duplicate content is a plain error, not a credentials alarm", async () => {
  const fetch = makeFetch(), clock = new FakeClock(T0);
  fetch.on("POST", "api.x.com/2/tweets", () => ({ status: 403, json: { title: "Forbidden", detail: "You are not allowed to create a Tweet with duplicate content." } })); // before the mock's own route: first match wins
  const xm = mockX(fetch);
  const x = new XClient({ clientId: "cid", accessToken: "access-old", refreshToken: "refresh-old", fetch, clock });
  x.pair.obtained_at = T0;
  await assert.rejects(() => x.post("same again"), (e) => !e.credentials && /duplicate content/.test(e.message));
  assert.equal(xm.refreshes, 0);
});

test("mentions come back oldest first with the author's handle and the newest id", async () => {
  const fetch = makeFetch(), clock = new FakeClock(T0), xm = mockX(fetch);
  xm.mentions = [{ id: "5001", text: "@Feedthebrownies how does staking work?", authorId: "u1", author: "ann" }, { id: "5002", text: "gm", authorId: "u2", author: "bob" }];
  const x = new XClient({ clientId: "cid", accessToken: "access-old", refreshToken: "refresh-old", fetch, clock });
  const r = await x.mentions({ sinceId: null });
  assert.deepEqual(r.tweets.map((t) => [t.id, t.author]), [["5001", "ann"], ["5002", "bob"]]);
  assert.equal(r.newestId, "5002");
  const again = await x.mentions({ sinceId: "5002" });
  assert.deepEqual(again.tweets, []);
  assert.equal(again.newestId, "5002", "nothing new keeps the old since id");
});
