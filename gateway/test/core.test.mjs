// node --test: the ledger books each activation once and charges correctly; a key is made by a sign-in that names
// the site and works once, lives until it runs out or is rotated away, and the old kind of key is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { Ledger } from "../ledger.mjs";
import { keyHash, mintKey, newNonce, signInMessage, signInSite, signerOf, SIGNIN_TTL_MS, walletToBeneficiary, beneficiaryToWallet } from "../auth.mjs";

const CHAIN = 4663; // any chain id will do here: the test for a wrong chain uses 1 as the other one
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

test("auth: the sign-in message names the site, the wallet and a number that works once; only that wallet's signature of it counts", async () => {
  const w = Wallet.createRandom(), other = Wallet.createRandom();
  const nonce = newNonce();
  assert.match(nonce, /^[0-9a-f]{32}$/); assert.notEqual(nonce, newNonce());
  const at = Date.parse("2026-10-13T15:00:00Z");
  const message = signInMessage({ domain: "feedthebrownies.com", wallet: w.address.toLowerCase(), chainId: 1, nonce, issuedAt: at, expiresAt: at + SIGNIN_TTL_MS });
  assert.equal(message, [
    "feedthebrownies.com wants you to sign in with your Ethereum account:",
    w.address,
    "",
    "Sign in to get your Brownies API key. This moves no money. Sign it only on the site named in the first line.",
    "",
    "URI: https://feedthebrownies.com",
    "Version: 1",
    "Chain ID: 1",
    `Nonce: ${nonce}`,
    "Issued At: 2026-10-13T15:00:00.000Z",
    "Expiration Time: 2026-10-13T15:05:00.000Z",
  ].join("\n"), "word for word the EIP-4361 layout, so a wallet can read who is asking");
  assert.equal(signerOf(message, await w.signMessage(message)), w.address);
  assert.equal(signerOf(message, await other.signMessage(message)), other.address, "another wallet's signature names another wallet");
  assert.notEqual(signerOf(message.replace(nonce, newNonce()), await w.signMessage(message)), w.address, "a signature of one number is no signature of another");
  assert.equal(signerOf(message, "0x1234"), null);
  assert.equal(beneficiaryToWallet(walletToBeneficiary(w.address)), w.address);
  assert.equal(beneficiaryToWallet("0x" + "ab".repeat(32)), null, "a non-wallet beneficiary is not an address");
});

test("auth: a browser gets a message for its own site only, and a site off the list gets none", () => {
  const sites = ["feedthebrownies.com", "www.feedthebrownies.com"];
  assert.deepEqual(signInSite(sites, { originHeader: "https://www.feedthebrownies.com" }), { domain: "www.feedthebrownies.com", origin: "https://www.feedthebrownies.com" });
  assert.throws(() => signInSite(sites, { originHeader: "https://feedthebrownies.com.evil.example" }), (e) => e.status === 403 && e.code === "site_not_allowed");
  assert.throws(() => signInSite(sites, { originHeader: "https://evil.example", asked: "feedthebrownies.com" }), (e) => e.status === 403, "what a page says about itself does not count: where it is does");
  assert.throws(() => signInSite(sites, { originHeader: "null" }), (e) => e.status === 403);
  // a program has no Origin: it gets the first site, or the one it names when that is on the list
  assert.deepEqual(signInSite(sites, {}), { domain: "feedthebrownies.com", origin: "https://feedthebrownies.com" });
  assert.equal(signInSite(sites, { asked: "WWW.feedthebrownies.com" }).domain, "www.feedthebrownies.com");
  assert.throws(() => signInSite(sites, { asked: "evil.example" }), (e) => e.status === 403);
  assert.deepEqual(signInSite(["localhost:8080"], {}), { domain: "localhost:8080", origin: "http://localhost:8080" });
  assert.throws(() => signInSite([], {}), (e) => e.status === 503);
});

test("auth: a key is random and kept as a hash; the old kind, a signature of a fixed sentence, is refused by name", async () => {
  const a = mintKey(), b = mintKey();
  assert.match(a.key, /^sk-brownie-k1\.[A-Za-z0-9_-]{43}$/); assert.notEqual(a.key, b.key);
  assert.match(a.hash, /^[0-9a-f]{64}$/); assert.equal(keyHash(a.key), a.hash); assert.ok(!a.key.includes(a.hash));
  // what used to be a key: anybody who got the wallet to sign this sentence held it
  const w = Wallet.createRandom();
  const old = "sk-brownie-0-" + Buffer.from((await w.signMessage("Brownies API key, chain 1, epoch 0")).slice(2), "hex").toString("base64url");
  assert.throws(() => keyHash(old), (e) => e.status === 401 && e.code === "key_retired" && /POST \/v1\/auth\/challenge/.test(e.message));
  assert.throws(() => keyHash("sk-brownie-k1.short"), (e) => e.status === 401 && e.code === "invalid_api_key");
  assert.throws(() => keyHash("sk-orb-0-abc"), (e) => e.code === "missing_api_key");
  assert.throws(() => keyHash(""), /Send Authorization/);
});

test("ledger: a sign-in works once and runs out; a key lives until it runs out or the wallet rotates its keys", () => {
  const l = freshLedger();
  const wallet = Wallet.createRandom().address, b = walletToBeneficiary(wallet);
  const t0 = 1_000_000;
  l.addSignin({ nonce: "a".repeat(32), wallet, message: "m1", keyMs: 86_400_000, expires: t0 + SIGNIN_TTL_MS }, t0);
  assert.deepEqual(l.takeSignin("a".repeat(32), t0 + 1000), { nonce: "a".repeat(32), wallet, message: "m1", keyMs: 86_400_000, expires: t0 + SIGNIN_TTL_MS });
  assert.equal(l.takeSignin("a".repeat(32), t0 + 2000), null, "used once, gone");
  l.addSignin({ nonce: "b".repeat(32), wallet, message: "m2", keyMs: 1, expires: t0 + SIGNIN_TTL_MS }, t0);
  assert.equal(l.takeSignin("b".repeat(32), t0 + SIGNIN_TTL_MS + 1), null, "run out");
  assert.equal(l.takeSignin("c".repeat(32), t0), null, "never asked for");
  // a wallet has five waiting at most
  for (let i = 0; i < 8; i++) l.addSignin({ nonce: String(i).repeat(32), wallet, message: "m", keyMs: 1, expires: t0 + 10_000 + i }, t0);
  assert.equal(l.db.prepare("SELECT COUNT(*) AS n FROM signin WHERE wallet = ?").get(wallet).n, 5);
  assert.equal(l.takeSignin("0".repeat(32), t0), null); assert.ok(l.takeSignin("7".repeat(32), t0));

  const k = mintKey();
  assert.deepEqual(l.addKey({ hash: k.hash, beneficiary: b, keyMs: 1000 }, t0), { epoch: 0, expires: t0 + 1000 });
  assert.deepEqual(l.key(k.hash, t0 + 500), { beneficiary: b, epoch: 0, created: t0, expires: t0 + 1000 });
  assert.equal(l.db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE hash = ?").get(k.key).n, 0, "the key itself is nowhere in the books");
  assert.deepEqual(l.key(k.hash, t0 + 1001), { gone: "expired" });
  assert.equal(l.key(k.hash, t0 + 1002), null, "and then it is forgotten");
  assert.equal(l.key(mintKey().hash, t0), null, "a key we never made");
  const k2 = mintKey(), k3 = mintKey();
  l.addKey({ hash: k2.hash, beneficiary: b, keyMs: 86_400_000 }, t0); l.addKey({ hash: k3.hash, beneficiary: b, keyMs: 86_400_000 }, t0);
  assert.equal(l.liveKeys(b, t0), 2);
  assert.equal(l.bumpEpoch(b), 1);
  assert.deepEqual(l.key(k2.hash, t0), { gone: "rotated" }, "rotating ends every key of the wallet, and the key is told why");
  assert.equal(l.key(k2.hash, t0), null, "once");
  assert.equal(l.liveKeys(b, t0), 0);
  assert.deepEqual(l.addKey({ hash: mintKey().hash, beneficiary: b, keyMs: 1000 }, t0), { epoch: 1, expires: t0 + 1000 }, "a key made after the rotation carries the new epoch");
});
