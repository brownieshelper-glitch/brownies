// The bounty board: the seed bounties, a claim's words (one link on an allowed site, a wallet, no bad words),
// the claim rules (open, winners left, once per person, five a day), the monthly pool against approvals, and the
// public view and the Telegram text. No money anywhere.
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../lib/store.mjs";
import { Board, parseClaim, SEED, LINK_HOSTS } from "../lib/bounties.mjs";

const T0 = Date.parse("2026-10-11T10:00:00Z");
function board(now = T0) {
  const store = new Store(":memory:", { tz: "CET" });
  const clock = { t: now, now() { return this.t; }, advance(ms) { this.t += ms; } };
  return { store, clock, b: new Board({ store, clock }) };
}

test("a claim's words: one link on an allowed site, the wallet pulled out, the text kept, bad things refused", () => {
  assert.deepEqual(parseClaim("https://x.com/ann/status/123 0x1234567890abcdef1234567890ABCDEF12345678"), { link: "https://x.com/ann/status/123", text: "", wallet: "0x1234567890abcdef1234567890abcdef12345678" });
  assert.deepEqual(parseClaim("here it is https://www.youtube.com/watch?v=abc the brownies reacting"), { link: "https://www.youtube.com/watch?v=abc", text: "here it is the brownies reacting", wallet: null });
  assert.equal(parseClaim("Ecco la traduzione: i brownies sono quattro aiutanti...").link, null);
  assert.match(parseClaim("https://evil.example/x").error, /links to x\.com, twitter\.com/);
  assert.match(parseClaim("https://x.com/a/1 https://x.com/a/2").error, /one link only/);
  assert.match(parseClaim("hi").error, /send a link/);
  assert.match(parseClaim("x".repeat(1201)).error, /too long/);
  assert.match(parseClaim("an nsfw meme https://x.com/a/status/1").error, /we do not take that/);
  assert.deepEqual(LINK_HOSTS, ["x.com", "twitter.com", "tiktok.com", "youtube.com", "youtu.be", "instagram.com"]);
});

test("the board: the seed, the claim rules, the pool, the view, the text", () => {
  const { b, clock } = board();
  const open = b.bounties();
  assert.equal(open.length, SEED.length); assert.equal(open[0].title, "A meme with the brownies"); assert.equal(open[0].sugar, 20); assert.equal(open[0].winners, 0);
  b.setPool(300);
  assert.deepEqual(b.pool(), { sugar: 300, approved: 0, owed: 0, paid: 0, left: 300, pending: 0, month: "2026-10" });
  // claims
  const ok = b.claim({ bountyId: 1, who: "u1", handle: "ann", chatId: "c1", raw: "https://x.com/ann/status/1 0x1111111111111111111111111111111111111111" });
  assert.ok(ok.id);
  const c = b.claimOf(ok.id);
  assert.equal(c.state, "new"); assert.equal(c.link, "https://x.com/ann/status/1"); assert.equal(c.wallet, "0x1111111111111111111111111111111111111111"); assert.equal(c.handle, "ann");
  assert.match(b.claim({ bountyId: 1, who: "u1", raw: "https://x.com/ann/status/2" }).error, /claimed this bounty already/);
  assert.match(b.claim({ bountyId: 99, who: "u1", raw: "https://x.com/ann/status/2" }).error, /no open bounty/);
  assert.match(b.claim({ bountyId: 1, who: "u2", raw: "a meme, trust me" }).error, /wants a link/);
  assert.ok(b.claim({ bountyId: 4, who: "u2", raw: "Italiano: i brownies sono quattro aiutanti che lavorano per la moneta." }).id, "a translation is text");
  assert.ok(b.claim({ bountyId: 6, who: "u2", raw: "The stake button stays grey after a refresh on Firefox: open app.html, connect, refresh." }).id, "a bug is text");
  b.close(1);
  assert.match(b.claim({ bountyId: 1, who: "u3", raw: "https://x.com/c/status/3" }).error, /no open bounty/);
  b.reopen(1);
  // five a day
  for (let i = 0; i < 4; i++) b.add({ title: `b${i}`, what: "do it", sugar: 1 });
  const who = "busy";
  const ids = [1, 2, 3, 5, 7].map((n) => b.claim({ bountyId: n, who, raw: `https://x.com/${who}/status/${n}` }));
  assert.ok(ids.every((r) => r.id), JSON.stringify(ids));
  assert.match(b.claim({ bountyId: 8, who, raw: "https://x.com/busy/status/8" }).error, /5 claims a day/);
  clock.advance(25 * 3_600_000);
  assert.ok(b.claim({ bountyId: 8, who, raw: "https://x.com/busy/status/8" }).id, "tomorrow is another day");
  // the pool follows approvals; winners cap a bounty
  b.setClaim(ok.id, { state: "approved", sugar: 20, decidedAt: clock.now() });
  assert.equal(b.winners(1), 1);
  assert.deepEqual(b.pool(), { sugar: 300, approved: 20, owed: 20, paid: 0, left: 280, pending: 8, month: "2026-10" }, "u2's two, busy's six");
  b.setClaim(ok.id, { state: "paid", paidAt: clock.now() });
  assert.equal(b.pool().paid, 20); assert.equal(b.pool().owed, 0); assert.equal(b.pool().left, 280);
  const small = b.add({ title: "one winner", what: "x", sugar: 5, maxWinners: 1 });
  const w1 = b.claim({ bountyId: small, who: "w1", raw: "https://x.com/w1/status/1" });
  b.setClaim(w1.id, { state: "approved", sugar: 5, decidedAt: clock.now() });
  assert.match(b.claim({ bountyId: small, who: "w2", raw: "https://x.com/w2/status/1" }).error, /all its winners already/);
  // the view and the text
  const v = b.view();
  assert.equal(v.pool.sugar, 300); assert.equal(v.pool.left, 275); assert.ok(v.bounties.every((x) => x.id && x.title && x.sugar));
  assert.equal(v.winners.length, 2); assert.equal(v.winners.find((x) => x.handle === "@ann").bounty, "A meme with the brownies"); assert.equal(v.winners.find((x) => x.handle === "a holder").sugar, 5);
  assert.ok(!JSON.stringify(v).includes("0x1111"), "no wallets on the public board");
  assert.match(b.listText(), /^Bounties open now/); assert.match(b.listText(), /1\. A meme with the brownies: 20 SUGAR\./); assert.match(b.listText(), /one winner: 5 SUGAR\. x \(0 left\)/);
  assert.throws(() => b.add({ title: "", what: "x", sugar: 1 }), /needs a title/);
});
