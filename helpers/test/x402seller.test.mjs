// The selling side of x402: the 402 body says what we accept; a payment signed by the gateway's own payer passes
// the checks; a tampered, short, expired or foreign one does not; the chain's word (nonce, balance) is asked;
// the settlement submits the transfer and reports; without a settler or without gas the shop is closed.
import test from "node:test";
import assert from "node:assert/strict";
import { Wallet, getAddress } from "ethers";
import { requirement, checkPayment, parsePayment, Seller, USDC, b64 } from "../lib/x402seller.mjs";
import { X402Payer } from "../../gateway/x402.mjs";

const PAY_TO = "0x2c769cDE285eb0d3c7130F9F0f14932106384095";
const T0 = Date.parse("2026-10-09T12:00:00Z");

/// A USDC that answers like the chain, and a provider with one balance.
function fakeChain({ balance = 50_000_000n, used = false, gas = 10n ** 15n, revert = false } = {}) {
  const calls = [];
  const token = {
    authorizationState: async (who, nonce) => { calls.push(["authorizationState", who, nonce]); return used; },
    balanceOf: async (who) => { calls.push(["balanceOf", who]); return balance; },
    transferWithAuthorization: async (...args) => { calls.push(["transferWithAuthorization", ...args.map((a) => (typeof a === "bigint" ? String(a) : a))]); if (revert) throw new Error("execution reverted: FiatTokenV2: authorization is used or canceled"); return { hash: "0xabc", wait: async () => ({ status: 1, hash: "0xabc" }) }; },
  };
  const provider = { getBalance: async () => gas };
  return { token, provider, calls };
}

test("the 402 body: version 2, the resource, one exact requirement in USDC on Base to the owner's address", () => {
  const r = requirement({ chainId: 8453, asset: USDC[8453], payTo: PAY_TO.toLowerCase(), micro: 1_000_000, url: "https://api.test/shop/note", description: "A note", mimeType: "application/json", error: "" });
  assert.equal(r.x402Version, 2); assert.deepEqual(r.resource, { url: "https://api.test/shop/note", description: "A note", mimeType: "application/json" });
  assert.equal(r.accepts.length, 1);
  const a = r.accepts[0];
  assert.equal(a.scheme, "exact"); assert.equal(a.network, "eip155:8453"); assert.equal(a.amount, "1000000"); assert.equal(a.asset, USDC[8453]); assert.equal(a.payTo, PAY_TO); assert.equal(a.maxTimeoutSeconds, 300);
  assert.deepEqual(a.extra, { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" });
  assert.equal(r.error, undefined);
  assert.equal(requirement({ chainId: 8453, asset: USDC[8453], payTo: PAY_TO, micro: 5, url: "u", error: "no" }).error, "no");
  assert.equal(parsePayment("not base64 json"), null); assert.equal(parsePayment(""), null);
  assert.deepEqual(parsePayment(b64.encode({ a: 1 })), { a: 1 });
});

test("a payment the gateway's payer signs passes the checks; tampering, a short amount, an expiry or a stranger's signature do not", async () => {
  const wallet = Wallet.createRandom();
  let now = T0;
  const payer = new X402Payer({ wallet, chainId: 8453, now: () => now, maxMicro: 10_000_000 });
  const required = requirement({ chainId: 8453, asset: USDC[8453], payTo: PAY_TO, micro: 1_000_000, url: "https://api.test/shop/note", maxTimeoutSeconds: 600 });
  const { payload } = await payer.sign(required);
  const ok = checkPayment(payload, required, { now });
  assert.equal(ok.ok, true, ok.error); assert.equal(ok.payer, wallet.address); assert.equal(ok.micro, 1_000_000); assert.equal(ok.authorization.to, PAY_TO);
  const broken = (patch) => checkPayment(JSON.parse(JSON.stringify(payload), (k, v) => v), required, { now });
  const mut = (f) => { const p = JSON.parse(JSON.stringify(payload)); f(p); return checkPayment(p, required, { now }); };
  assert.match(mut((p) => { p.x402Version = 1; }).error, /must be 2/);
  assert.match(mut((p) => { p.accepted.payTo = wallet.address; p.payload.authorization.to = wallet.address; }).error, /must go to our address/);
  assert.match(mut((p) => { p.accepted.amount = "999999"; }).error, /the price is 1000000/);
  assert.match(mut((p) => { p.payload.authorization.value = "999999"; }).error, /less than the price/);
  assert.match(mut((p) => { p.accepted.asset = "0x0000000000000000000000000000000000000001"; }).error, /USDC only/);
  assert.match(mut((p) => { p.accepted.network = "eip155:1"; }).error, /we accept exact on eip155:8453/);
  assert.match(mut((p) => { p.payload.authorization.nonce = "0x12"; }).error, /32 bytes/);
  // a changed value breaks the signature: the signer is no longer the payer
  assert.match(mut((p) => { p.payload.authorization.validBefore = String(Number(p.payload.authorization.validBefore) + 1); }).error, /not the payer's/);
  // the window: not yet valid, and expired
  assert.match(checkPayment(payload, required, { now: T0 - 700_000 }).error, /not valid yet/);
  assert.match(checkPayment(payload, required, { now: T0 + 600_000 }).error, /expires too soon/);
  // a payment made for another requirement (another price) fails on the amount
  const cheaper = requirement({ chainId: 8453, asset: USDC[8453], payTo: PAY_TO, micro: 500_000, url: "u" });
  const { payload: p2 } = await payer.sign(cheaper);
  assert.match(checkPayment(p2, required, { now }).error, /the price is 1000000/);
  assert.equal(typeof broken, "function");
});

test("the seller asks the chain (nonce unused, balance there), settles by submitting the transfer, and is closed without a key or without gas", async () => {
  const wallet = Wallet.createRandom();
  const now = T0;
  const payer = new X402Payer({ wallet, chainId: 8453, now: () => now });
  const chain = fakeChain();
  const settler = Wallet.createRandom();
  const log = [];
  const s = new Seller({ chainId: 8453, payTo: PAY_TO, settlerKey: settler.privateKey, provider: chain.provider, token: chain.token, now: () => now, log: (l) => log.push(l) });
  assert.equal(s.configured, true); assert.equal(s.address, settler.address); assert.equal(s.payTo, PAY_TO);
  assert.deepEqual(await s.open(), { ok: true, reason: "" });
  const required = s.requirement({ micro: 1_000_000, url: "https://api.test/shop/note", description: "A note" });
  assert.equal(required.accepts[0].payTo, PAY_TO);
  const { payload } = await payer.sign(required);
  const v = await s.verify(payload, required);
  assert.equal(v.ok, true, v.error); assert.equal(v.payer, wallet.address);
  assert.deepEqual(chain.calls.map((c) => c[0]), ["authorizationState", "balanceOf"]);
  const st = await s.settle(payload);
  assert.deepEqual(st, { ok: true, tx: "0xabc", payer: wallet.address, micro: 1_000_000 });
  const call = chain.calls.find((c) => c[0] === "transferWithAuthorization");
  assert.equal(call[1], wallet.address); assert.equal(getAddress(call[2]), PAY_TO); assert.equal(call[3], "1000000"); assert.equal(call[6], payload.payload.authorization.nonce);
  assert.equal(typeof call[7], "number"); assert.ok(call[7] === 27 || call[7] === 28, "v");
  assert.deepEqual(s.settled, { count: 1, micro: 1_000_000 });
  assert.ok(log.some((l) => /\[x402\] settled 1\.00 USDC from/.test(l)));
  assert.deepEqual(b64.decode(s.response({ success: true, transaction: "0xabc", payer: wallet.address })), { success: true, transaction: "0xabc", network: "eip155:8453", payer: wallet.address });
  assert.deepEqual(b64.decode(s.response({ success: false, errorReason: "no" })), { success: false, transaction: "", network: "eip155:8453", errorReason: "no" });
  // the chain says no: a used nonce, a thin balance, a reverting transfer
  const used = new Seller({ chainId: 8453, payTo: PAY_TO, settlerKey: settler.privateKey, ...fakeChain({ used: true }), now: () => now });
  assert.match((await used.verify(payload, required)).error, /used already/);
  const poor = new Seller({ chainId: 8453, payTo: PAY_TO, settlerKey: settler.privateKey, ...fakeChain({ balance: 10n }), now: () => now });
  assert.match((await poor.verify(payload, required)).error, /holds 0\.00 USDC, less than the price/);
  const rev = new Seller({ chainId: 8453, payTo: PAY_TO, settlerKey: settler.privateKey, ...fakeChain({ revert: true }), now: () => now });
  assert.match((await rev.settle(payload)).error, /did not go through: execution reverted/);
  // closed: no settler, no payout address, no gas
  const noKey = new Seller({ chainId: 8453, payTo: PAY_TO, provider: chain.provider, token: chain.token, now: () => now });
  assert.equal(noKey.configured, false); assert.match((await noKey.open()).reason, /no settler wallet/);
  assert.match((await noKey.settle(payload)).error, /cannot settle/);
  const noPay = new Seller({ chainId: 8453, settlerKey: settler.privateKey, provider: chain.provider, token: chain.token, now: () => now });
  assert.match((await noPay.open()).reason, /no payout address/);
  const dry = new Seller({ chainId: 8453, payTo: PAY_TO, settlerKey: settler.privateKey, ...fakeChain({ gas: 0n }), now: () => now });
  assert.match((await dry.open()).reason, new RegExp(`the settler wallet ${settler.address} needs ETH for gas on Base`));
});
