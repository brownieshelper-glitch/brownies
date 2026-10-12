// The ledger after the code review of 2026-10-12. Each test states the behaviour that must hold; before the fixes
// the first, third and fourth did not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { Ledger, dayKey } from "../ledger.mjs";
import { walletToBeneficiary } from "../auth.mjs";

const freshPath = () => join(mkdtempSync(join(tmpdir(), "brownies-")), "l.sqlite");
const fund = (l, b, micro) => l.recordActivation({ id: Math.floor(Math.random() * 1e9), beneficiary: b, sender: "0x" + "1".repeat(40), atoms: micro, block: 1, tx: "0x" + "2".repeat(64) });

test("a hold is a whole number of micro-dollars from zero up: a negative one, a fraction, NaN are refused and the balance does not move", () => {
  const l = new Ledger(freshPath());
  const b = walletToBeneficiary(Wallet.createRandom().address);
  fund(l, b, 20_000); // two cents
  for (const bad of [-1, -100_000_000_000, 0.5, NaN, Infinity, "5", null, undefined]) {
    assert.throws(() => l.reserve(b, bad), (e) => e.badAmount === true, `reserve(${bad})`);
  }
  assert.deepEqual([l.balance(b).heldMicro, l.balance(b).availableMicro], [0, 20_000], "nothing was held, nothing was freed");
  const hold = l.reserve(b, 15_000);
  assert.equal(l.balance(b).availableMicro, 5_000);
  assert.throws(() => l.reserve(b, 6_000), (e) => e.insufficient === true, "the room is what is left, not more");
  l.settle(hold, 0);
  assert.throws(() => l.charge(b, -5), (e) => e.badAmount === true); assert.equal(l.balance(b).spentMicro, 0);
});

test("what a call cost is booked as a whole number from zero up: a negative or unreadable cost books nothing, a fraction is rounded up", () => {
  const l = new Ledger(freshPath());
  const b = walletToBeneficiary(Wallet.createRandom().address);
  fund(l, b, 1_000_000);
  for (const [cost, booked] of [[-500, 0], [NaN, 0], [undefined, 0], ["abc", 0], [0.2, 1], [1234.01, 1235]]) {
    const before = l.balance(b).spentMicro;
    l.settle(l.reserve(b, 10_000), cost, { model: "m" });
    assert.equal(l.balance(b).spentMicro - before, booked, `settle(${cost})`);
    assert.equal(l.balance(b).heldMicro, 0, "the hold is always let go");
  }
});

test("a grant's spend lands on the day its room was held: a call across midnight cannot spend two days of the cap", () => {
  const l = new Ledger(freshPath());
  const holder = Wallet.createRandom(), brownie = Wallet.createRandom();
  const hb = walletToBeneficiary(holder.address);
  fund(l, hb, 100_000_000);
  l.setGrant(hb, brownie.address, 10_000_000); // ten dollars a day
  const lateEvening = Date.UTC(2026, 9, 12, 23, 59, 0), afterMidnight = Date.UTC(2026, 9, 13, 0, 1, 0);
  const first = l.reserveVia(hb, brownie.address, 10_000_000, lateEvening);
  assert.equal(first.day, dayKey(lateEvening));
  const second = l.reserveVia(hb, brownie.address, 10_000_000, afterMidnight); // the new day has its own room
  l.settle(first, 10_000_000, { model: "m" }, afterMidnight); // the first call ends after midnight
  l.settle(second, 10_000_000, { model: "m" }, afterMidnight);
  assert.equal(l.grantRoom(hb, brownie.address, lateEvening).spentMicro, 10_000_000, "the first call is on the day it was held");
  assert.equal(l.grantRoom(hb, brownie.address, afterMidnight).spentMicro, 10_000_000, "the new day carries only its own call");
  assert.equal(l.grantRoom(hb, brownie.address, afterMidnight).roomMicro, 0, "and its cap is used once, not twice");
});

test("a key rotation ends the grants the wallet gave: a grant made with a key that leaked does not outlive it", () => {
  const l = new Ledger(freshPath());
  const holder = Wallet.createRandom(), a = Wallet.createRandom(), b2 = Wallet.createRandom();
  const hb = walletToBeneficiary(holder.address);
  fund(l, hb, 50_000_000);
  l.setGrant(hb, a.address, 5_000_000); l.setGrant(hb, b2.address, 1_000_000);
  assert.equal(l.grantsBy(hb).length, 2);
  assert.equal(l.bumpEpoch(hb), 1);
  assert.equal(l.grantsBy(hb).length, 0); assert.equal(l.grantRoom(hb, a.address), null);
  assert.throws(() => l.reserveVia(hb, a.address, 1_000), (e) => e.noGrant === true, "nothing can be spent through an ended grant");
  l.setGrant(hb, a.address, 2_000_000); // the owner may give it again with the new key
  assert.equal(l.grantRoom(hb, a.address).dailyMicro, 2_000_000);
  // a wallet that gave none rotates as before
  const other = walletToBeneficiary(Wallet.createRandom().address);
  assert.equal(l.bumpEpoch(other), 1); assert.equal(l.bumpEpoch(other), 2);
});

// ---- the second pass: the hold is the ceiling, and a stopped process leaves a record ----
test("a charge never passes its hold: the balance and the day of a grant were checked against the hold, and what is over it is counted as ours", () => {
  const l = new Ledger(freshPath());
  const b = walletToBeneficiary(Wallet.createRandom().address);
  fund(l, b, 50_000);
  const out = l.settle(l.reserve(b, 10_000), 400_000, { model: "m" }); // the upstream says forty cents for a call held at one
  assert.deepEqual([out.micro, out.overMicro], [10_000, 390_000]);
  assert.deepEqual([l.balance(b).spentMicro, l.balance(b).heldMicro, l.balance(b).availableMicro], [10_000, 0, 40_000]);
  assert.equal(l.shortfallMicro, 390_000);
  assert.deepEqual(l.settle(l.reserve(b, 10_000), 2_500, { model: "m" }), { micro: 2_500, overMicro: 0 });
  assert.equal(l.shortfallMicro, 390_000, "a call under its hold adds nothing to it");
  // through a grant: the day cannot be passed by a call that cost more than it held
  const holder = walletToBeneficiary(Wallet.createRandom().address), brownie = Wallet.createRandom().address;
  fund(l, holder, 5_000_000); l.setGrant(holder, brownie, 20_000);
  l.settle(l.reserveVia(holder, brownie, 20_000), 3_000_000, { model: "m" });
  assert.deepEqual([l.grantRoom(holder, brownie).spentMicro, l.grantRoom(holder, brownie).roomMicro, l.balance(holder).spentMicro], [20_000, 0, 20_000]);
});

test("a hold settled twice is settled once: the second time frees nothing and books nothing", () => {
  const l = new Ledger(freshPath());
  const b = walletToBeneficiary(Wallet.createRandom().address);
  fund(l, b, 100_000);
  const first = l.reserve(b, 30_000), second = l.reserve(b, 30_000);
  l.settle(first, 5_000, { model: "m" });
  assert.deepEqual(l.settle(first, 5_000, { model: "m" }), { micro: 0, overMicro: 0, stale: true });
  assert.deepEqual([l.balance(b).spentMicro, l.balance(b).heldMicro], [5_000, 30_000], "the other call still holds its own");
  l.settle(second, 0);
  assert.deepEqual([l.balance(b).spentMicro, l.balance(b).heldMicro, l.balance(b).availableMicro], [5_000, 0, 95_000]);
});

test("a process that stops leaves a record: a call the upstream had taken is booked at what was known of it, one that had not is let go", () => {
  const path = freshPath();
  const l = new Ledger(path);
  const a = walletToBeneficiary(Wallet.createRandom().address), holder = walletToBeneficiary(Wallet.createRandom().address), brownie = Wallet.createRandom().address;
  fund(l, a, 1_000_000); fund(l, holder, 1_000_000); l.setGrant(holder, brownie, 500_000);
  const evening = Date.UTC(2026, 9, 12, 23, 58, 0);
  const taken = l.reserve(a, 100_000, evening);
  l.note(taken, { floorMicro: 1_200, model: "lab/model" });
  l.note(taken, { upstreamId: "gen-abc" }); // the id comes later and does not lower the floor
  l.note(taken, { floorMicro: 800 }); // the floor only rises
  const notYet = l.reserve(a, 50_000, evening); // held, the upstream not reached
  const granted = l.reserveVia(holder, brownie, 200_000, evening);
  l.note(granted, { floorMicro: 999_999_999, model: "lab/model", upstreamId: "gen-via" }); // a floor is never over its hold
  assert.equal(l.balance(a).heldMicro, 150_000);
  assert.ok(notYet.id > taken.id);
  l.db.close();

  const again = new Ledger(path); // the next process, after midnight
  assert.deepEqual([again.balance(a).spentMicro, again.balance(a).heldMicro, again.balance(a).availableMicro], [1_200, 0, 998_800]);
  assert.deepEqual([again.balance(holder).spentMicro, again.balance(holder).heldMicro], [200_000, 0]);
  assert.equal(again.grantRoom(holder, brownie, evening).spentMicro, 200_000, "the grant is charged on the day of the hold");
  assert.equal(again.grantRoom(holder, brownie, evening).heldMicro, 0);
  assert.deepEqual(again.recovered.map((r) => [r.bookedMicro, r.holdMicro, r.upstreamId, r.model, r.via ? "via" : "own"]), [[1_200, 100_000, "gen-abc", "lab/model", "own"], [0, 50_000, null, null, "own"], [200_000, 200_000, "gen-via", "lab/model", "via"]]);
  const row = again.recent(a, 5).spend[0];
  assert.deepEqual([row.model, row.micro, row.at], ["lab/model", 1_200, evening]);
  again.db.close();
  assert.deepEqual(new Ledger(path).recovered, [], "booked once: the third process finds nothing in flight");
});
