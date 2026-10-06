// Grants: a wallet lets another spend from its balance up to a daily cap. The room is the cap less today's spend,
// never more than the granter has; the day turns at midnight UTC; a revoked grant pays nothing; an old book gets
// the `via` column; the pay-from header is parsed strictly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Wallet } from "ethers";
import { Ledger, dayKey } from "../ledger.mjs";
import { walletToBeneficiary, parseWallet } from "../auth.mjs";

const freshPath = () => join(mkdtempSync(join(tmpdir(), "brownies-")), "l.sqlite");
const NOON = Date.UTC(2026, 9, 7, 12, 0, 0);
const fund = (l, b, micro) => l.recordActivation({ id: Math.floor(Math.random() * 1e9), beneficiary: b, sender: "0x" + "1".repeat(40), atoms: micro, block: 1, tx: "0x" + "2".repeat(64) });

test("a grant gives room up to the cap, the granter pays, the spend says who spent it", () => {
  const l = new Ledger(freshPath());
  const holder = Wallet.createRandom(), brownie = Wallet.createRandom();
  const hb = walletToBeneficiary(holder.address);
  fund(l, hb, 10_000_000); // 10 USD
  assert.equal(l.grantRoom(hb, brownie.address, NOON), null, "no grant yet");
  const g = l.setGrant(hb, brownie.address, 1_000_000, NOON);
  assert.equal(g.grantee, brownie.address.toLowerCase());
  let room = l.grantRoom(hb, brownie.address, NOON);
  assert.equal(room.roomMicro, 1_000_000, "the whole cap is free");
  assert.equal(room.day, "2026-10-07");
  l.chargeVia(hb, brownie.address, 300_000, { model: "m" }, NOON);
  room = l.grantRoom(hb, brownie.address, NOON + 1000);
  assert.equal(room.spentMicro, 300_000);
  assert.equal(room.calls, 1);
  assert.equal(room.roomMicro, 700_000);
  assert.equal(l.balance(hb).availableMicro, 9_700_000, "the holder paid");
  assert.equal(l.balance(walletToBeneficiary(brownie.address)).availableMicro, 0, "the brownie's own balance is untouched");
  const spend = l.recent(hb).spend;
  assert.equal(spend.length, 1);
  assert.equal(spend[0].via, brownie.address.toLowerCase());
  assert.equal(l.stats().grants, 1);
});

test("the room is never more than the granter has, and the day turns at midnight UTC", () => {
  const l = new Ledger(freshPath());
  const holder = Wallet.createRandom(), brownie = Wallet.createRandom();
  const hb = walletToBeneficiary(holder.address);
  fund(l, hb, 500_000); // 0.50 USD
  l.setGrant(hb, brownie.address, 2_000_000, NOON);
  assert.equal(l.grantRoom(hb, brownie.address, NOON).roomMicro, 500_000, "capped by the balance");
  l.chargeVia(hb, brownie.address, 500_000, {}, NOON);
  assert.equal(l.grantRoom(hb, brownie.address, NOON).roomMicro, 0);
  fund(l, hb, 5_000_000);
  assert.equal(l.grantRoom(hb, brownie.address, NOON).roomMicro, 1_500_000, "the cap less today's spend once the balance allows");
  const tomorrow = Date.UTC(2026, 9, 8, 0, 0, 1);
  assert.equal(dayKey(tomorrow), "2026-10-08");
  assert.equal(l.grantRoom(hb, brownie.address, tomorrow).spentMicro, 0, "a new day, a fresh cap");
  assert.equal(l.grantRoom(hb, brownie.address, tomorrow).roomMicro, 2_000_000);
});

test("setting again changes the cap; revoking ends it; lists show both sides", () => {
  const l = new Ledger(freshPath());
  const holder = Wallet.createRandom(), a = Wallet.createRandom(), b = Wallet.createRandom();
  const hb = walletToBeneficiary(holder.address);
  fund(l, hb, 10_000_000);
  l.setGrant(hb, a.address, 1_000_000, NOON);
  l.setGrant(hb, b.address, 250_000, NOON + 1);
  l.setGrant(hb, a.address, 2_000_000, NOON + 2);
  const given = l.grantsBy(hb, NOON);
  assert.deepEqual(given.map((g) => [g.grantee, g.dailyMicro]), [[a.address.toLowerCase(), 2_000_000], [b.address.toLowerCase(), 250_000]]);
  assert.equal(given[0].created, NOON, "changing the cap keeps the start date");
  assert.deepEqual(l.grantsTo(a.address, NOON).map((g) => g.granter), [hb]);
  assert.equal(l.revokeGrant(hb, a.address, NOON + 3), true);
  assert.equal(l.revokeGrant(hb, a.address, NOON + 4), false, "already revoked");
  assert.equal(l.grantRoom(hb, a.address, NOON), null, "a revoked grant pays nothing");
  assert.equal(l.grantsBy(hb, NOON).length, 1);
  assert.equal(l.stats().grants, 1);
  const again = l.setGrant(hb, a.address, 100_000, NOON + 10);
  assert.equal(again.created, NOON + 10, "set again after a revoke starts fresh");
  assert.throws(() => l.setGrant(hb, a.address, 0), /positive/);
});

test("a book made before grants existed gets the via column and keeps its rows", () => {
  const path = freshPath();
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE spend (id INTEGER PRIMARY KEY AUTOINCREMENT, beneficiary TEXT NOT NULL, at INTEGER NOT NULL, model TEXT, micro INTEGER NOT NULL, upstream_id TEXT, prompt_tokens INTEGER, completion_tokens INTEGER);
            INSERT INTO spend(beneficiary, at, model, micro) VALUES ('0xabc', 1, 'm', 7);`);
  old.close();
  const l = new Ledger(path);
  assert.ok(l.db.prepare("PRAGMA table_info(spend)").all().some((c) => c.name === "via"));
  assert.equal(l.recent("0xabc").spend[0].via, null);
  l.charge("0xabc", 3, { model: "n" });
  assert.equal(l.recent("0xabc").spend.length, 2);
  assert.equal(l.stats().requests, 2);
});

test("the pay-from header is an address or nothing", () => {
  const w = Wallet.createRandom().address;
  assert.equal(parseWallet(w.toLowerCase()), w, "checksummed back");
  assert.equal(parseWallet(""), null);
  assert.equal(parseWallet(undefined), null);
  assert.throws(() => parseWallet("0x1234"), (e) => e.status === 400 && e.code === "bad_wallet");
  assert.throws(() => parseWallet("not an address"), /address/);
});
