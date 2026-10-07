// Fudge never posts the same text twice, stops at its caps, keeps the voice, and answers only the mentions that ask.
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./mock.mjs";
import { isQuestion } from "../helpers/fudge.mjs";

const POSTS = [
  "Every trade of BROWNIE pays a 2% tax. Half of it reaches stakers as SUGAR, one dollar of AI each.",
  "Four brownies work for the coin. Fudge writes, Crumb answers, Nib reads, Chip builds.",
  "A stake that stays earns more. Ten percent more after 30 days, twenty after 90, thirty after 180.",
  "Anyone can tip a brownie in SUGAR. The tip lands on its key and is counted on the chain.",
];

test("a post goes out once, is reported as kind post on x, and the same text is never posted again", async () => {
  const W = makeWorld({ reply: () => POSTS[0] });
  const first = await W.fudge.post({ nth: 1 });
  assert.equal(first.text, POSTS[0]);
  assert.deepEqual(W.xm.posts.map((p) => p.text), [POSTS[0]]);
  const report = W.gw.of("fudge", "post")[0];
  assert.equal(report.place, "x");
  assert.equal(report.url, "https://x.com/Feedthebrownies/status/1000");
  assert.equal(report.title, POSTS[0]);
  assert.equal(report.cost_micro, 1000);
  assert.deepEqual(W.gw.of("fudge", "status").map((r) => r.title), ["Writing today's first post"]);
  const second = await W.fudge.post({ nth: 2 });
  assert.equal(second, null, "the model only knows one sentence, so nothing new went out");
  assert.equal(W.xm.posts.length, 1);
  assert.equal(W.or.calls.length, 4, "one call for the first post, three tries for the second");
  assert.match(W.or.lastUser(3), /do not repeat them/i);
});

test("at most maxPostsPerDay posts, then nothing more that day", async () => {
  const W = makeWorld({ reply: (b, n) => POSTS[n % POSTS.length] });
  for (let i = 0; i < 5; i++) await W.fudge.post();
  assert.equal(W.xm.posts.length, 3);
  assert.equal(W.gw.of("fudge", "post").length, 3);
  assert.equal(W.or.calls.length, 3, "no thinking once the cap is reached");
});

test("Fudge stops at its daily dollar cap and the owner is told once", async () => {
  const W = makeWorld({ reply: (b, n) => POSTS[n % POSTS.length], cost: 0.0008, config: { fudge: { dailyCapUsd: 0.001, maxPostsPerDay: 10 } } });
  assert.ok(await W.fudge.post());
  assert.ok(await W.fudge.post(), "the second post is allowed: 0.0008 spent is under the cap of 0.001");
  assert.equal(W.store.spentToday("fudge", W.clock.now()).micro, 1600);
  assert.equal(await W.fudge.post(), null, "over the cap: no third post");
  assert.equal(W.xm.posts.length, 2);
  const budgetAlerts = W.alerts.sent.filter((a) => a.topic === "budget:fudge");
  assert.equal(budgetAlerts.length, 1);
  assert.match(budgetAlerts[0].text, /Fudge is out of budget/);
  assert.equal(W.tg.sent.filter((m) => String(m.chat_id) === "999").length, 2, "two Telegram lines to the owner: the 80% warning, then the cap");
  await W.fudge.post();
  assert.equal(W.alerts.sent.filter((a) => a.topic === "budget:fudge").length, 1, "not alerted again within the hour");
});

test("a draft with emoji or promise words is refused and rewritten before anything reaches X", async () => {
  const drafts = ["BROWNIE to the moon! \u{1F680} #brownie #sugar #eth", "“Every trade pays a 2% tax.” Half goes to stakers as SUGAR — one dollar of AI each."];
  const W = makeWorld({ reply: (b, n) => drafts[n - 1] });
  const r = await W.fudge.post();
  assert.equal(r.text, '"Every trade pays a 2% tax." Half goes to stakers as SUGAR - one dollar of AI each.', "ASCII only, smart quotes made plain");
  assert.equal(W.xm.posts.length, 1);
  assert.doesNotMatch(W.xm.posts[0].text, /moon/);
  assert.match(W.or.lastUser(2), /refused.*promise words/);
});

test("mentions: the question gets a reply, the chatter does not, and nothing is answered twice", async () => {
  const W = makeWorld({ reply: () => "Stake BROWNIE in the app and SUGAR flows to you every second. The docs explain the loyalty bonus." });
  W.xm.mentions = [
    { id: "7001", text: "@Feedthebrownies how does staking work?", authorId: "u1", author: "ann" },
    { id: "7002", text: "gm brownies", authorId: "u2", author: "bob" },
    { id: "7003", text: "@Feedthebrownies nice project", authorId: "u3", author: "cat" },
  ];
  assert.equal(await W.fudge.mentions(), 1);
  assert.equal(W.xm.posts.length, 1);
  assert.deepEqual(W.xm.posts[0].reply, { in_reply_to_tweet_id: "7001" });
  const rep = W.gw.of("fudge", "reply");
  assert.equal(rep.length, 1);
  assert.match(rep[0].title, /^Answered @ann/);
  assert.equal(rep[0].place, "x");
  assert.equal(W.store.getMeta("x:mentions:since"), "7003");
  assert.equal(await W.fudge.mentions(), 0, "the same mentions are not answered again");
  W.xm.mentions.push({ id: "7004", text: "@Feedthebrownies what is SUGAR?", authorId: "u4", author: "dan" });
  assert.equal(await W.fudge.mentions(), 1);
  assert.equal(W.xm.posts.length, 2);
});

test("isQuestion", () => {
  assert.equal(isQuestion("@Feedthebrownies how does staking work?"), true);
  assert.equal(isQuestion("@Feedthebrownies is there a lock"), true);
  assert.equal(isQuestion("gm brownies"), false);
  assert.equal(isQuestion("nice project https://x.com/a"), false);
});

test("without X credentials Fudge still posts, on the site alone, and says so in the report", async () => {
  const W = makeWorld({ reply: () => POSTS[1] });
  W.x.clientId = "";
  const r = await W.fudge.post();
  assert.equal(r.place, "site");
  assert.equal(W.xm.posts.length, 0, "nothing went to X");
  assert.equal(W.gw.of("fudge", "post")[0].place, "site");
  assert.equal(W.gw.of("fudge", "post")[0].url, "https://feedthebrownies.com/posts.html");
});

test("media posts: off by default; on, the files go up and the post carries them; a failed upload keeps the post back", async () => {
  const { makeWorld: mw } = await import("./mock.mjs");
  const { Fudge } = await import("../helpers/fudge.mjs");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const W = mw();
  const dir = mkdtempSync(join(tmpdir(), "fudge-media-"));
  const png = join(dir, "meme.png"); writeFileSync(png, Buffer.alloc(300, 1));
  assert.equal(await W.fudge.postMedia({ topic: "a meme", files: [png] }), null, "off by default");
  assert.equal(W.xm.posts.length, 0);
  const on = new Fudge({ config: { ...W.helpersCfg.fudge, media: true }, brain: W.brain, gateway: W.gateway, store: W.store, clock: W.clock, alerts: W.alerts, facts: "- Every trade pays a 2% tax.", log: () => {}, x: W.x, siteUrl: "https://feedthebrownies.com" });
  W.brain.helpers.fudge = { ...W.helpersCfg.fudge, media: true };
  let inits = 0;
  W.fetch.on("POST", "api.x.com/2/media/upload/initialize", () => { inits++; return { json: { data: { id: "m7" } } }; });
  W.fetch.on("POST", /media\/upload\/m7\/append$/, () => ({ status: 204 }));
  W.fetch.on("POST", /media\/upload\/m7\/finalize$/, () => ({ json: { data: { id: "m7" } } }));
  const r = await on.postMedia({ topic: "our version of a trend, the picture attached", files: [png] });
  assert.ok(r?.url, "posted");
  assert.equal(inits, 1); assert.deepEqual(W.xm.posts.at(-1).media, { media_ids: ["m7"] });
  // a refused upload: no post without its picture
  W.fetch.on("POST", "api.x.com/2/media/upload/initialize", () => ({ status: 403, json: { title: "Forbidden", detail: "the scope media.write is missing" } }));
  const bad = join(dir, "other.png"); writeFileSync(bad, Buffer.alloc(100, 3));
  const before = W.xm.posts.length;
  const r2 = await on.post({ topic: "another", media: [bad] });
  assert.equal(r2, null); assert.equal(W.xm.posts.length, before);
});
