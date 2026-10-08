// Holds: the most a request could cost is reserved before the call, so many requests at once cannot spend the same
// dollar twice, and a grant's day cannot be passed by sending them together.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../ledger.mjs";

const fresh = () => new Ledger(join(mkdtempSync(join(tmpdir(), "brownies-")), "l.sqlite"));
const B = "0x" + "11".repeat(32), SENDER = "0x" + "22".repeat(20), GRANTEE = "0x" + "33".repeat(20);

test("a hold takes room away at once; settling books the real cost and lets the rest go", () => {
  const l = fresh();
  l.recordActivation({ id: 1, beneficiary: B, sender: SENDER, atoms: 11_000, block: 1, tx: "0xaa" });
  const h1 = l.reserve(B, 10_000);
  assert.equal(l.balance(B).availableMicro, 1_000, "held money is not available");
  assert.throws(() => l.reserve(B, 10_000), /under/, "a second request of the same size finds no room");
  l.settle(h1, 3_000, { model: "m" });
  const b = l.balance(B);
  assert.deepEqual([b.spentMicro, b.heldMicro, b.availableMicro], [3_000, 0, 8_000]);
  const h2 = l.reserve(B, 8_000);
  l.settle(h2, 0);
  assert.equal(l.balance(B).availableMicro, 8_000, "a call that cost nothing left everything");
  assert.equal(l.recent(B, 10).spend.length, 1, "only the real cost was written down");
});

test("a grant's holds count against its day and the granter's balance", () => {
  const l = fresh();
  l.recordActivation({ id: 1, beneficiary: B, sender: SENDER, atoms: 1_000_000, block: 1, tx: "0xaa" });
  l.setGrant(B, GRANTEE, 20_000);
  const h1 = l.reserveVia(B, GRANTEE, 15_000);
  assert.equal(l.grantRoom(B, GRANTEE).roomMicro, 5_000);
  assert.throws(() => l.reserveVia(B, GRANTEE, 10_000), /under/, "the day's room is what is left after the holds");
  l.settle(h1, 12_000, { model: "m" });
  const r = l.grantRoom(B, GRANTEE);
  assert.deepEqual([r.spentMicro, r.heldMicro, r.roomMicro, r.calls], [12_000, 0, 8_000, 1]);
  assert.equal(l.balance(B).availableMicro, 988_000);
  assert.throws(() => l.reserveVia(B, SENDER, 1), /no grant/);
  // many at once: the sum of what is granted never passes the cap
  let ok = 0, refused = 0;
  const holds = [];
  for (let i = 0; i < 100; i++) { try { holds.push(l.reserveVia(B, GRANTEE, 1_000)); ok++; } catch { refused++; } }
  assert.deepEqual([ok, refused], [8, 92]);
  for (const h of holds) l.settle(h, 1_000);
  assert.equal(l.grantRoom(B, GRANTEE).roomMicro, 0);
  assert.equal(l.grantRoom(B, GRANTEE).spentMicro, 20_000);
});

test("a restart forgets holds that were in flight", () => {
  const dir = mkdtempSync(join(tmpdir(), "brownies-"));
  const path = join(dir, "l.sqlite");
  const l = new Ledger(path);
  l.recordActivation({ id: 1, beneficiary: B, sender: SENDER, atoms: 5_000, block: 1, tx: "0xaa" });
  l.reserve(B, 5_000);
  assert.equal(l.balance(B).availableMicro, 0);
  l.db.close();
  const again = new Ledger(path);
  assert.equal(again.balance(B).availableMicro, 5_000);
});
