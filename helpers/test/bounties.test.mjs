// The bounty board: the seed bounties in USDC, a claim's words (one link on an allowed site, a wallet, no bad
// words), the claim rules (the board open, the bounty open, winners left, once per person, five a day), the
// budget against approvals, and the public view and the Telegram text. No money anywhere.
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../lib/store.mjs";
import { Board, parseClaim, SEED, LINK_HOSTS, money } from "../lib/bounties.mjs";

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
  assert.equal(money(5), "$5"); assert.equal(money(2.5), "$2.50"); assert.equal(money(0), "$0");
});

test("the board: closed until opened, the seed in USDC, the claim rules, the budget, the view, the text", () => {
  const { b, clock } = board();
  assert.equal(b.isOpen(), false);
  assert.deepEqual(b.view(), { open: false, pool: null, bounties: [], winners: [], how: b.view().how });
  assert.equal(b.listText(), "No bounty is open right now.");
  assert.match(b.claim({ bountyId: 1, who: "u1", raw: "https://x.com/ann/status/1" }).error, /no bounty is open right now/);
  b.setOpen(true);
  const open = b.bounties();
  assert.equal(open.length, SEED.length); assert.equal(open[0].title, "A meme with the brownies"); assert.equal(open[0].usd, 5); assert.equal(open[0].winners, 0);
  b.setBudget(300);
  assert.deepEqual(b.pool(), { budget: 300, approved: 0, owed: 0, paid: 0, left: 300, pending: 0 });
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
  for (let i = 0; i < 4; i++) b.add({ title: `b${i}`, what: "do it", usd: 1 });
  const who = "busy";
  const ids = [1, 2, 3, 5, 7].map((n) => b.claim({ bountyId: n, who, raw: `https://x.com/${who}/status/${n}` }));
  assert.ok(ids.every((r) => r.id), JSON.stringify(ids));
  assert.match(b.claim({ bountyId: 8, who, raw: "https://x.com/busy/status/8" }).error, /5 claims a day/);
  clock.advance(25 * 3_600_000);
  assert.ok(b.claim({ bountyId: 8, who, raw: "https://x.com/busy/status/8" }).id, "tomorrow is another day");
  // the budget follows approvals; winners cap a bounty; a price can change
  b.setClaim(ok.id, { state: "approved", usd: 5, decidedAt: clock.now() });
  assert.equal(b.winners(1), 1);
  assert.deepEqual(b.pool(), { budget: 300, approved: 5, owed: 5, paid: 0, left: 295, pending: 8 }, "u2's two, busy's six");
  b.setClaim(ok.id, { state: "paid", paidAt: clock.now() });
  assert.equal(b.pool().paid, 5); assert.equal(b.pool().owed, 0); assert.equal(b.pool().left, 295);
  const small = b.add({ title: "one winner", what: "x", usd: 2.5, maxWinners: 1 });
  const w1 = b.claim({ bountyId: small, who: "w1", raw: "https://x.com/w1/status/1" });
  b.setClaim(w1.id, { state: "approved", usd: 2.5, decidedAt: clock.now() });
  assert.match(b.claim({ bountyId: small, who: "w2", raw: "https://x.com/w2/status/1" }).error, /all its winners already/);
  assert.equal(b.setPrice(2, 25), true); assert.equal(b.bounty(2).usd, 25); assert.equal(b.setPrice(2, 0), false); assert.equal(b.setPrice(99, 5), false);
  // the view and the text
  const v = b.view();
  assert.equal(v.open, true); assert.equal(v.pool.budget, 300); assert.equal(v.pool.left, 292.5); assert.equal(v.pool.paid, 5); assert.ok(v.bounties.every((x) => x.id && x.title && x.usd));
  assert.equal(v.winners.length, 2); assert.equal(v.winners.find((x) => x.handle === "@ann").bounty, "A meme with the brownies"); assert.equal(v.winners.find((x) => x.handle === "a holder").usd, 2.5);
  assert.ok(!JSON.stringify(v).includes("0x1111"), "no wallets on the public board");
  assert.match(b.listText(), /^Bounties open now \(USDC/); assert.match(b.listText(), /1\. A meme with the brownies: \$5\./); assert.match(b.listText(), /one winner: \$2\.50\. x \(0 left\)/);
  assert.throws(() => b.add({ title: "", what: "x", usd: 1 }), /needs a title/);
  // closed again: nothing shows, nothing is taken, the winners stay
  b.setOpen(false);
  assert.equal(b.view().bounties.length, 0); assert.equal(b.view().winners.length, 2);
  assert.match(b.claim({ bountyId: 2, who: "late", raw: "https://x.com/late/status/1" }).error, /no bounty is open right now/);
});

test("an older board that paid in SUGAR is dropped and seeded again in USDC", () => {
  const store = new Store(":memory:");
  store.db.exec("CREATE TABLE bounties (id INTEGER PRIMARY KEY, created_at INTEGER, kind TEXT, title TEXT, what TEXT, sugar INTEGER, max_winners INTEGER, state TEXT); CREATE TABLE claims (id INTEGER PRIMARY KEY, sugar INTEGER); INSERT INTO bounties VALUES (1, 0, 'meme', 'old', 'old', 20, 10, 'open');");
  const b = new Board({ store, clock: { now: () => T0 } });
  assert.equal(b.bounties({ open: false }).length, SEED.length); assert.equal(b.bounty(1).usd, 5); assert.equal(b.bounty(1).title, "A meme with the brownies");
});
