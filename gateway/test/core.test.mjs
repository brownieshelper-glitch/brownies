// node --test: the ledger books each activation once and charges correctly; keys verify, rotate and refuse forgeries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { Ledger } from "../ledger.mjs";
import { verifyKey, keyMessage, keyFromSignature, walletToBeneficiary, beneficiaryToWallet } from "../auth.mjs";

const CHAIN = 4663;
const freshLedger = () => new Ledger(join(mkdtempSync(join(tmpdir(), "brownies-")), "l.sqlite"));

test("ledger: an activation credits once, by id", () => {
  const l = freshLedger();
  const w = Wallet.createRandom();
  const b = walletToBeneficiary(w.address);
  assert.equal(l.recordActivation({ id: 1, beneficiary: b, sender: w.address, atoms: 5_000_000, block: 10, tx: "0x" + "1".repeat(64) }), true);
  assert.equal(l.recordActivation({ id: 1, beneficiary: b, sender: w.address, atoms: 5_000_000, block: 10, tx: "0x" + "1".repeat(64) }), false, "same id again books nothing");
  assert.equal(l.balance(b).availableMicro, 5_000_000);
  l.charge(b, 1_234, { model: "x" });
  assert.equal(l.balance(b).availableMicro, 5_000_000 - 1_234);
  assert.equal(l.balance(b).spentMicro, 1_234);
  assert.equal(l.stats().activations, 1);
  assert.equal(l.stats().requests, 1);
  assert.equal(l.recent(b).spend.length, 1);
});

test("ledger: balance never goes negative in the view, and epochs bump", () => {
  const l = freshLedger();
  const b = walletToBeneficiary(Wallet.createRandom().address);
  l.charge(b, 10);
  assert.equal(l.balance(b).availableMicro, 0);
  assert.equal(l.balance(b).epoch, 0);
  assert.equal(l.bumpEpoch(b), 1);
  assert.equal(l.bumpEpoch(b), 2);
  assert.equal(l.balance(b).epoch, 2);
});

test("auth: a wallet's signature is its key, and the beneficiary round-trips", async () => {
  const w = Wallet.createRandom();
  const sig = await w.signMessage(keyMessage(CHAIN, 0));
  const key = keyFromSignature(sig, 0);
  assert.ok(key.startsWith("sk-brownie-0-"));
  const v = verifyKey(key, CHAIN);
  assert.equal(v.wallet, w.address);
  assert.equal(v.epoch, 0);
  assert.equal(v.beneficiary, walletToBeneficiary(w.address));
  assert.equal(beneficiaryToWallet(v.beneficiary), w.address);
  assert.equal(beneficiaryToWallet("0x" + "ab".repeat(32)), null, "a non-wallet beneficiary is not an address");
});

test("auth: wrong chain, wrong epoch, tampered key all fail closed", async () => {
  const w = Wallet.createRandom();
  const sig = await w.signMessage(keyMessage(CHAIN, 3));
  const key = keyFromSignature(sig, 3);
  // the same signature claimed for another epoch recovers a DIFFERENT wallet, so it cannot steal the real one's balance
  const forged = verifyKey(keyFromSignature(sig, 4), CHAIN);
  assert.notEqual(forged.wallet, w.address);
  const otherChain = verifyKey(key, 1);
  assert.notEqual(otherChain.wallet, w.address);
  assert.throws(() => verifyKey("sk-brownie-3-not-base64!!", CHAIN), /Malformed/);
  assert.throws(() => verifyKey("sk-orb-0-abc", CHAIN), /missing_api_key|Send Authorization/);
  assert.throws(() => verifyKey("", CHAIN), /Send Authorization/);
});
