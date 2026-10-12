// Relay and the pantry: a quote without a referrer, the steps sent in order from the pantry wallet and each check
// polled to success; a signature step stops before anything is sent; a dead status throws. The pantry bridges only
// when enough USDC waits and the wallet has gas, and its health view names the address to fund.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { RelayBridge, checkSteps, RELAY_DEPOSIT } from "../bridge.mjs";
import { Pantry } from "../pantry.mjs";
import { USDC } from "../x402.mjs";

const USDC_ETH = USDC[1], USDC_BASE = USDC[8453];
const DEPOSIT = "0x4cd00e387622c35bddb9b4c962c136462338bc31";
const approveData = (spender, atoms) => "0x095ea7b3" + spender.slice(2).toLowerCase().padStart(64, "0") + BigInt(atoms).toString(16).padStart(64, "0");
const stepsFor = (atoms, { spender = DEPOSIT, to = DEPOSIT, value = "0", approved = atoms, tokenData = null } = {}) => [
  { id: "approve", kind: "transaction", items: [{ status: "incomplete", data: { from: "0xpantry", to: USDC_ETH, data: tokenData || approveData(spender, approved), value: "0", maxFeePerGas: "1000000000", maxPriorityFeePerGas: "100000000" } }] },
  { id: "deposit", kind: "transaction", items: [{ status: "incomplete", data: { from: "0xpantry", to, data: "0xdeadbeef", value, gas: "120000" }, check: { endpoint: "/intents/status/v2?requestId=0xreq", method: "GET" } }] },
];
function relay({ statuses = ["pending", "success"], signatureStep = false, error = null } = {}) {
  const calls = []; let polls = 0, steps = [];
  const fetch = async (url, init = {}) => {
    if (String(url).endsWith("/quote/v2") && init.body) steps = signatureStep ? [{ id: "authorize", kind: "signature", items: [{ status: "incomplete", data: {} }] }] : stepsFor(BigInt(JSON.parse(init.body).amount));
    const u = String(url); calls.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
    if (u.endsWith("/quote/v2")) return error ? Response.json({ message: error, errorCode: "UNAUTHORIZED_QUOTE" }, { status: 401 }) : Response.json({ requestId: "0xreq", steps, fees: { gas: { amountUsd: "0.02" }, relayerGas: { amountUsd: "0.01" }, relayerService: { amountUsd: "0.15" } }, details: { currencyIn: { amountFormatted: "20.0" }, currencyOut: { amountFormatted: "19.82", minimumAmount: String(BigInt(JSON.parse(init.body).amount) * 985n / 1000n) }, timeEstimate: 12 } });
    if (u.includes("/intents/status/v2")) { const s = statuses[Math.min(polls++, statuses.length - 1)]; return Response.json({ status: s }); }
    return new Response("nope", { status: 404 });
  };
  return { fetch, calls, polls: () => polls };
}
function fakeWallet() {
  const sent = [];
  return { address: "0x" + "ab".repeat(20), sent, sendTransaction: async (tx) => { sent.push(tx); const hash = `0xtx${sent.length}`; return { hash, wait: async () => ({ status: 1 }) }; } };
}

test("a bridge: quote without referrer, approve then deposit from the wallet, the check polled to success", async () => {
  const R = relay(); const w = fakeWallet(); const logs = [];
  const b = new RelayBridge({ wallet: w, fetch: R.fetch, sleep: async () => {}, log: (l) => logs.push(l) });
  const out = await b.bridge(20_000_000n);
  assert.deepEqual(R.calls[0].body, { user: w.address, recipient: w.address, originChainId: 1, destinationChainId: 8453, originCurrency: USDC_ETH, destinationCurrency: USDC_BASE, amount: "20000000", tradeType: "EXACT_INPUT" });
  assert.equal("referrer" in R.calls[0].body, false, "a referrer would need an API key");
  assert.equal(w.sent.length, 2);
  assert.equal(w.sent[0].to, USDC_ETH); assert.equal(w.sent[0].maxFeePerGas, undefined, "the fee is the wallet's own reading, never the quote's"); assert.equal(w.sent[0].value, 0n);
  assert.equal(w.sent[1].gasLimit, 120_000n); assert.equal(w.sent[1].data, "0xdeadbeef");
  assert.deepEqual(out, { requestId: "0xreq", txs: [{ step: "approve", hash: "0xtx1" }, { step: "deposit", hash: "0xtx2" }], status: "success" });
  assert.equal(R.polls(), 2, "pending, then success");
  assert.match(logs[0], /20\.0 USDC Ethereum -> Base, out 19\.82, fees gas 0\.02 relayer 0\.15 USD, about 12 s/);
});

test("a signature step stops before any transaction; a refund is an error; Relay's errors are named", async () => {
  const w = fakeWallet();
  await assert.rejects(() => new RelayBridge({ wallet: w, fetch: relay({ signatureStep: true }).fetch, sleep: async () => {} }).bridge(1_000_000n), /needs a signature, not supported/);
  assert.equal(w.sent.length, 0);
  await assert.rejects(() => new RelayBridge({ wallet: fakeWallet(), fetch: relay({ statuses: ["pending", "refund"] }).fetch, sleep: async () => {} }).bridge(1_000_000n), /Relay reports refund/);
  await assert.rejects(() => new RelayBridge({ wallet: fakeWallet(), fetch: relay({ error: "Please provide an api key" }).fetch }).quote(1n), /Relay quote: Please provide an api key/);
});

test("the pantry bridges when enough USDC waits and the wallet has gas, and shows what to fund", async () => {
  const bridged = []; const logs = [];
  const bridge = { bridge: async (atoms) => { bridged.push(atoms); return { requestId: "0xreq", status: "success", txs: [{ step: "deposit", hash: "0xtx" }] }; } };
  const payer = { paid: { count: 3, micro: 2688, last: { tx: "0xfeed" } } };
  const p = new Pantry({ privateKey: Wallet.createRandom().privateKey, ethRpcUrl: "http://127.0.0.1:1", baseRpcUrl: "http://127.0.0.1:1", bridge, payer, bridgeMinUsdc: 20, lowUsdc: 2, keepEth: 0.002, now: () => 1_000, log: (l) => logs.push(l) });
  let reading = { ethereum: { eth: 0.01, usdc: 5, usdcAtoms: 5_000_000n }, base: { usdc: 1.5 } };
  p.balances = async () => reading;
  await p.tick();
  assert.equal(bridged.length, 0, "five dollars is under the floor");
  let v = p.view();
  assert.equal(v.address, p.address); assert.equal(v.low, true); assert.equal(v.ethereum.usdc, 5); assert.equal(v.base.usdc, 1.5); assert.equal(v.paid.requests, 3); assert.equal(v.paid.usdc, 0.002688);
  reading = { ethereum: { eth: 0.0001, usdc: 25, usdcAtoms: 25_000_000n }, base: { usdc: 3 } };
  await p.tick();
  assert.equal(bridged.length, 0, "no gas, no bridge");
  reading = { ethereum: { eth: 0.01, usdc: 25, usdcAtoms: 25_000_000n }, base: { usdc: 3 } };
  await p.tick();
  assert.deepEqual(bridged, [25_000_000n]);
  v = p.view();
  assert.equal(v.low, false); assert.deepEqual(v.lastBridge, { at: 1_000, usdc: 25, requestId: "0xreq", status: "success", txs: ["0xtx"] });
  assert.ok(logs.some((l) => /\[pantry\] moved 25\.00 USDC to Base \(success\)/.test(l)));
  p.balances = async () => { throw new Error("rpc down"); };
  await p.tick();
  assert.equal(p.view().error, "rpc down");
  const idle = new Pantry({ privateKey: Wallet.createRandom().privateKey, ethRpcUrl: "http://127.0.0.1:1", bridge: null });
  assert.equal(idle.shouldBridge({ ethereum: { eth: 1, usdc: 100 }, base: { usdc: 0 } }), false, "no bridge configured, nothing moves");
});

test("the bridge signs only what a bridge needs: an approval of the named contract for no more than the amount, a call to that contract, no ETH, a fair minimum out", async () => {
  const A = 20_000_000n, token = USDC_ETH, allow = RELAY_DEPOSIT[1];
  const q = (steps, minOutAtoms = "19700000") => ({ steps, minOutAtoms });
  assert.equal(checkSteps(q(stepsFor(A)), A, { token, allow }), true);
  const evil = "0x000000000000000000000000000000000000dEaD";
  const transfer = "0xa9059cbb" + evil.slice(2).toLowerCase().padStart(64, "0") + A.toString(16).padStart(64, "0");
  const refused = [
    [q(stepsFor(A, { tokenData: transfer })), /a call on the token that is not an approval/],
    [q(stepsFor(A, { spender: evil })), /it approves 0x0+dead, not a contract the owner allowed/],
    [q(stepsFor(A, { approved: A * 1000n })), /it approves 20000000000, more than the 20000000 that is bridged/],
    [q(stepsFor(A, { to: evil })), /it calls 0x0+dEaD, not a contract the owner allowed/],
    [q(stepsFor(A, { value: "1000000000000000000" })), /it sends ETH along/],
    [q(stepsFor(A), "15000000"), /at least 15000000 for 20000000, more than 5% lost/],
    [q(stepsFor(A), null), /the quote states no minimum out/],
    [q([{ id: "sign", kind: "signature", items: [{ data: {} }] }]), /needs a signature, not supported/],
  ];
  for (const [quote, why] of refused) assert.throws(() => checkSteps(quote, A, { token, allow }), why);
  assert.throws(() => checkSteps(q(stepsFor(A)), A, { token, allow: [] }), /no deposit contract is named/);
  // and through the bridge itself: a quote that is not a bridge stops with nothing signed
  const w = fakeWallet();
  const bad = async (url, init = {}) => (String(url).endsWith("/quote/v2") ? Response.json({ requestId: "0xreq", steps: stepsFor(A, { spender: evil, to: evil }), details: { currencyOut: { minimumAmount: "19700000" } } }) : new Response("", { status: 404 }));
  await assert.rejects(() => new RelayBridge({ wallet: w, fetch: bad, sleep: async () => {} }).bridge(A), /not a contract the owner allowed/);
  assert.equal(w.sent.length, 0);
  // the owner may name another contract when Relay moves
  const moved = async (url) => (String(url).endsWith("/quote/v2") ? Response.json({ requestId: "0xreq", steps: stepsFor(A, { spender: evil, to: evil }).map((x) => ({ ...x, items: x.items.map(({ check, ...i }) => i) })), details: { currencyOut: { minimumAmount: "19700000" } } }) : new Response("", { status: 404 }));
  const w2 = fakeWallet();
  await new RelayBridge({ wallet: w2, fetch: moved, sleep: async () => {}, allow: [evil] }).bridge(A);
  assert.equal(w2.sent.length, 2);
});

test("one pantry tick at a time: two ticks that start together read once and bridge once; a setting that is not a number is the usual ten minutes", async () => {
  const bridged = [];
  const bridge = { bridge: async (atoms) => { bridged.push(atoms); await new Promise((r) => setTimeout(r, 20)); return { requestId: "0xreq", status: "success", txs: [] }; } };
  const p = new Pantry({ privateKey: Wallet.createRandom().privateKey, ethRpcUrl: "http://127.0.0.1:1", baseRpcUrl: "http://127.0.0.1:1", bridge, bridgeMinUsdc: 20, keepEth: 0.002 });
  let readings = 0;
  p.balances = async () => { readings++; await new Promise((r) => setTimeout(r, 15)); return { ethereum: { eth: 0.01, usdc: 25, usdcAtoms: 25_000_000n }, base: { usdc: 0 } }; };
  await Promise.all([p.tick(), p.tick(), p.tick()]);
  assert.equal(readings, 1); assert.deepEqual(bridged, [25_000_000n]);
  await p.tick();
  assert.equal(readings, 2, "the next tick runs when the first is done");
  const mk = (everySeconds) => new Pantry({ privateKey: Wallet.createRandom().privateKey, ethRpcUrl: "http://127.0.0.1:1", everySeconds }).everySeconds;
  assert.deepEqual([mk("10m"), mk(NaN), mk(2), mk(0), mk(120), mk("300")], [600, 600, 600, 600, 120, 300]);
});
