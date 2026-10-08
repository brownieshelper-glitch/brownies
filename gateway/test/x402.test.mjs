// x402 v2, exact scheme on Base: the payer answers a 402 with a signed USDC authorization that a facilitator can
// verify, pays exactly the amount asked, refuses a price over its cap or a chain it does not hold, reads the receipt,
// and leaves a free resource alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { X402Payer, b64, recoverPayer, pickRequirement, USDC } from "../x402.mjs";

const PAY_TO = "0x6992c688c56BE442EfE1E1cE7D5c95212ED7d59B";
const required = (amount = "896") => ({
  x402Version: 2, error: "Payment-Signature header is required", resource: { url: "https://jumpgate.test/paid/chat/v2" },
  accepts: [
    { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount, payTo: "AYYo37bgztqAgP6wp2S9SiYWcijr8gz2o14c8RGWojJZ", maxTimeoutSeconds: 300, asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", extra: { feePayer: "x" } },
    { scheme: "exact", network: "eip155:8453", amount, payTo: PAY_TO, maxTimeoutSeconds: 300, asset: USDC[8453], extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" } },
  ],
});

/// A JumpGate stand-in with its own facilitator: verifies the signature and the numbers before serving.
function fakeResource({ amount = "896", refuse = false, free = false } = {}) {
  const seen = [];
  const fetch = async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    seen.push({ url: String(url), headers: Object.fromEntries(headers.entries()), body: init.body });
    if (free) return new Response("free lunch", { status: 200 });
    const sig = headers.get("payment-signature");
    if (!sig || refuse) return new Response("", { status: 402, headers: { "payment-required": b64.encode({ ...required(amount), error: refuse && sig ? "insufficient funds" : "Payment-Signature header is required" }) } });
    const payload = b64.decode(sig);
    const a = payload.payload.authorization;
    const payer = recoverPayer(payload, 8453);
    const now = Math.floor(Date.now() / 1000);
    const okay = payload.x402Version === 2 && payload.accepted.payTo === PAY_TO && a.to === PAY_TO && a.value === amount && Number(a.validAfter) <= now && Number(a.validBefore) > now && /^0x[0-9a-f]{64}$/.test(a.nonce) && payer.toLowerCase() === a.from.toLowerCase();
    if (!okay) return new Response("bad payment", { status: 400 });
    return new Response("data: {\"ok\":true}\n\n", { status: 200, headers: { "content-type": "text/event-stream", "payment-response": b64.encode({ success: true, transaction: "0xabc", network: "eip155:8453", payer }) } });
  };
  return { fetch, seen };
}

test("the payer signs what the facilitator verifies, pays the exact amount once and reads the receipt", async () => {
  const w = Wallet.createRandom();
  const { fetch, seen } = fakeResource();
  const logs = [];
  const p = new X402Payer({ wallet: w, chainId: 8453, fetch, log: (l) => logs.push(l) });
  const { response, paid } = await p.fetch("https://jumpgate.test/paid/chat/v2", { method: "POST", headers: { "content-type": "application/json", "x402-input-tokens": "11" }, body: "{}" });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "data: {\"ok\":true}\n\n");
  assert.equal(paid.micro, 896);
  assert.equal(paid.to, PAY_TO);
  assert.deepEqual(paid.settlement, { success: true, transaction: "0xabc", network: "eip155:8453", payer: w.address });
  assert.equal(paid.authorization.from, w.address);
  assert.equal(seen.length, 2, "the request, the 402, the paid retry");
  assert.equal(seen[1].headers["x402-input-tokens"], "11", "the original headers travel with the retry");
  assert.equal(seen[1].body, "{}");
  assert.equal(p.paid.count, 1); assert.equal(p.paid.micro, 896); assert.equal(p.paid.last.tx, "0xabc");
  assert.match(logs.at(-1), /\[x402\] paid 0\.000896 USDC to 0x6992/);
  // the signed payload is a faithful copy of the requirement
  const payload = b64.decode(seen[1].headers["payment-signature"]);
  assert.deepEqual(payload.accepted, required().accepts[1]);
  assert.deepEqual(payload.resource, { url: "https://jumpgate.test/paid/chat/v2" });
  assert.equal(Number(payload.payload.authorization.validBefore) - Number(payload.payload.authorization.validAfter), 900, "ten minutes of skew before, the resource's window after");
});

test("over the cap, on the wrong chain, refused, or free: no payment is made", async () => {
  const w = Wallet.createRandom();
  const dear = fakeResource({ amount: "2500000" });
  const p = new X402Payer({ wallet: w, fetch: dear.fetch, maxMicro: 2_000_000 });
  await assert.rejects(() => p.fetch("https://jumpgate.test/x"), /over the cap of 2\.00 USDC/);
  assert.equal(dear.seen.length, 1, "nothing was retried");
  assert.equal(p.paid.count, 0);
  const onlySolana = { ...required(), accepts: [required().accepts[0]] };
  const sol = async () => new Response("", { status: 402, headers: { "payment-required": b64.encode(onlySolana) } });
  await assert.rejects(() => new X402Payer({ wallet: w, fetch: sol }).fetch("https://x"), /nothing payable on eip155:8453.*offered: exact\/solana/);
  const refusing = fakeResource({ refuse: true });
  await assert.rejects(() => new X402Payer({ wallet: w, fetch: refusing.fetch }).fetch("https://x"), /payment refused: insufficient funds/);
  const free = fakeResource({ free: true });
  const r = await new X402Payer({ wallet: w, fetch: free.fetch }).fetch("https://x");
  assert.equal(r.paid, null); assert.equal(await r.response.text(), "free lunch");
  const bare = async () => new Response("", { status: 402 });
  await assert.rejects(() => new X402Payer({ wallet: w, fetch: bare }).fetch("https://x"), /402 without a PAYMENT-REQUIRED header/);
  assert.equal(pickRequirement(required(), { chainId: 1, asset: USDC[1] }), null);
  assert.equal(pickRequirement({ accepts: [{ ...required().accepts[1], extra: { assetTransferMethod: "permit2" } }] }, { chainId: 8453, asset: USDC[8453] }), null, "only EIP-3009 is signed here");
});

test("the pantry pays only the address the owner allowed (X402_PAY_TO), or else the first address it met and no other", async () => {
  const w = Wallet.createRandom();
  const other = { ...required(), accepts: [{ ...required().accepts[1], payTo: "0x000000000000000000000000000000000000dEaD" }] };
  const otherFetch = async () => new Response("", { status: 402, headers: { "payment-required": b64.encode(other) } });
  const p = new X402Payer({ wallet: w, fetch: fakeResource().fetch, allowTo: [PAY_TO] });
  assert.equal((await p.fetch("https://x")).paid.to, PAY_TO);
  const q = new X402Payer({ wallet: w, fetch: otherFetch, allowTo: [PAY_TO] });
  await assert.rejects(() => q.fetch("https://x"), /would go to 0x0000.*dEaD, not an address the owner allowed; set X402_PAY_TO/);
  assert.equal(q.paid.count, 0);
  // no list: the first address paid is pinned for the life of the process
  const logs = [];
  const r = new X402Payer({ wallet: w, fetch: fakeResource().fetch, log: (l) => logs.push(l) });
  await r.fetch("https://x");
  assert.equal(r.pinnedTo, PAY_TO.toLowerCase());
  assert.match(logs[0], /\[x402\] the pantry will pay 0x6992.* and no other address until the owner sets X402_PAY_TO/);
  r.fetchRaw = otherFetch;
  await assert.rejects(() => r.fetch("https://x"), /not an address the owner allowed/);
  assert.equal(r.paid.count, 1);
  // the case of the address does not matter
  assert.equal((await new X402Payer({ wallet: w, fetch: fakeResource().fetch, allowTo: [PAY_TO.toLowerCase()] }).fetch("https://x")).paid.micro, 896);
});
