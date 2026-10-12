// Relay (relay.link): moves the pantry's USDC from Ethereum, where the coin's fees land, to Base, where x402 is
// paid. One quote (no referrer: a referrer needs an API key, a plain quote does not), then the steps Relay lists,
// in order, each a transaction from the pantry wallet (an approval of USDC, then the deposit), each item's check
// endpoint polled until Relay says success. Docs: docs.relay.link/references/api/get-quote-v2.
import { USDC } from "./x402.mjs";

export const RELAY = "https://api.relay.link";
const DONE = new Set(["success"]);
const DEAD = new Set(["failure", "refund"]);

/// Relay's deposit contract on Ethereum, as its quote named it on 2026-10-07 and again on 2026-10-12: the one address
/// the pantry may approve and call for a bridge. RELAY_ALLOW in the gateway's settings names others.
export const RELAY_DEPOSIT = { 1: ["0x4cd00e387622c35bddb9b4c962c136462338bc31"] };
const APPROVE = "0x095ea7b3";
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ""));

/// What the wallet may sign for a bridge of amountAtoms of `token`, and nothing else: transactions only; no ETH sent
/// along; on the token itself only approve(spender, amount) with a spender on the list and an amount not over what is
/// bridged; any other call only to a contract on the list; a stated minimum out that is not more than maxLossBps under
/// the amount; a sane gas limit. Throws with the reason at the first step that is not that. The quote comes from an
/// API over the network: it is read as a proposal, never as an order.
export function checkSteps(q, amountAtoms, { token, allow = [], maxLossBps = 500 } = {}) {
  const amount = BigInt(amountAtoms), list = allow.map((a) => String(a).toLowerCase()), tok = String(token || "").toLowerCase();
  if (!list.length) throw new Error("Relay: no deposit contract is named for this chain, so nothing is signed");
  let min; try { min = BigInt(q.minOutAtoms); } catch { throw new Error("Relay: the quote states no minimum out"); }
  if (min * 10000n < amount * BigInt(10000 - maxLossBps)) throw new Error(`Relay: the quote gives back at least ${min} for ${amount}, more than ${maxLossBps / 100}% lost`);
  for (const step of q.steps || []) {
    if (step.kind !== "transaction") throw new Error(`Relay step ${step.id} needs a ${step.kind}, not supported`);
    for (const item of step.items || []) {
      if (item.status === "complete") continue;
      const d = item.data || {}, to = String(d.to || "").toLowerCase(), data = String(d.data || "0x").toLowerCase();
      if (!isAddr(d.to)) throw new Error(`Relay step ${step.id}: no address to send to`);
      let value; try { value = BigInt(d.value || 0); } catch { value = 1n; }
      if (value !== 0n) throw new Error(`Relay step ${step.id}: it sends ETH along, which a USDC bridge never needs`);
      if (d.gas && BigInt(d.gas) > 1_500_000n) throw new Error(`Relay step ${step.id}: a gas limit of ${d.gas}`);
      if (to === tok) {
        if (!data.startsWith(APPROVE) || data.length !== 138) throw new Error(`Relay step ${step.id}: a call on the token that is not an approval`);
        const spender = "0x" + data.slice(34, 74), approved = BigInt("0x" + data.slice(74, 138));
        if (!list.includes(spender)) throw new Error(`Relay step ${step.id}: it approves ${spender}, not a contract the owner allowed; add it to RELAY_ALLOW if Relay moved`);
        if (approved > amount) throw new Error(`Relay step ${step.id}: it approves ${approved}, more than the ${amount} that is bridged`);
      } else if (!list.includes(to)) throw new Error(`Relay step ${step.id}: it calls ${d.to}, not a contract the owner allowed; add it to RELAY_ALLOW if Relay moved`);
    }
  }
  return true;
}

export class RelayBridge {
  /// wallet: an ethers Wallet connected to the origin chain's provider.
  constructor({ wallet, fetch = globalThis.fetch, api = RELAY, from = { chainId: 1, currency: USDC[1] }, to = { chainId: 8453, currency: USDC[8453] }, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {}, allow = null, maxLossBps = 500 }) {
    this.wallet = wallet; this.fetch = fetch; this.api = api.replace(/\/$/, ""); this.from = from; this.to = to; this.sleep = sleep; this.log = log;
    this.allow = [...(RELAY_DEPOSIT[from.chainId] || []), ...(allow || [])].filter(isAddr); this.maxLossBps = maxLossBps;
  }

  /// The quote for `amountAtoms` (USDC has 6 decimals): the steps and the fees. Throws on Relay's errors.
  async quote(amountAtoms, { recipient = this.wallet.address } = {}) {
    const body = { user: this.wallet.address, recipient, originChainId: this.from.chainId, destinationChainId: this.to.chainId, originCurrency: this.from.currency, destinationCurrency: this.to.currency, amount: String(amountAtoms), tradeType: "EXACT_INPUT" };
    const r = await this.fetch(`${this.api}/quote/v2`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.message || j.errorCode) throw new Error(`Relay quote: ${j.message || j.errorCode || r.status}`);
    const usd = (f) => (f && f.amountUsd != null ? Number(f.amountUsd) : null);
    return {
      requestId: j.requestId, steps: j.steps || [],
      fees: { gasUsd: usd(j.fees?.gas), relayerGasUsd: usd(j.fees?.relayerGas), relayerServiceUsd: usd(j.fees?.relayerService) },
      inFormatted: j.details?.currencyIn?.amountFormatted || null, outFormatted: j.details?.currencyOut?.amountFormatted || null,
      minOutAtoms: j.details?.currencyOut?.minimumAmount || null, timeEstimate: j.details?.timeEstimate ?? null,
    };
  }

  /// Runs a quote's steps. Returns { requestId, txs, status }. Every step is checked before the first is sent
  /// (checkSteps): a step that is not what a bridge of this amount needs stops everything with nothing signed.
  async execute(q, { tries = 60, everyMs = 5000, amountAtoms = null } = {}) {
    if (amountAtoms == null) throw new Error("Relay: the amount is needed to check the steps");
    checkSteps(q, amountAtoms, { token: this.from.currency, allow: this.allow, maxLossBps: this.maxLossBps });
    const txs = [];
    let status = "sent";
    for (const step of q.steps) {
      for (const item of step.items || []) {
        if (item.status === "complete") continue;
        const d = item.data || {};
        // the fee is the wallet's own reading of the chain, never a number from the quote
        const tx = { to: d.to, data: d.data, value: 0n };
        if (d.gas) tx.gasLimit = BigInt(d.gas);
        const sent = await this.wallet.sendTransaction(tx);
        this.log(`[bridge] ${step.id}: tx ${sent.hash}`);
        const rc = await sent.wait();
        if (!rc || rc.status !== 1) throw new Error(`Relay step ${step.id}: transaction ${sent.hash} failed`);
        txs.push({ step: step.id, hash: sent.hash });
        if (item.check?.endpoint) status = await this.waitFor(item.check, { tries, everyMs });
      }
    }
    return { requestId: q.requestId, txs, status };
  }

  /// Polls an item's check endpoint until Relay reports success (or a dead state, which throws).
  async waitFor(check, { tries = 60, everyMs = 5000 } = {}) {
    const url = /^https?:/.test(check.endpoint) ? check.endpoint : `${this.api}${check.endpoint}`;
    let last = "unknown";
    for (let i = 0; i < tries; i++) {
      const r = await this.fetch(url, { method: check.method || "GET", signal: AbortSignal.timeout(15000) }).catch(() => null);
      const j = r ? await r.json().catch(() => ({})) : {};
      last = String(j.status || last);
      if (DONE.has(last)) return last;
      if (DEAD.has(last)) throw new Error(`Relay reports ${last}${j.details ? `: ${j.details}` : ""}`);
      await this.sleep(everyMs);
    }
    return last; // still moving when we stopped looking: the pantry's next tick sees the balance anyway
  }

  /// Quote and execute in one go.
  async bridge(amountAtoms, opts = {}) {
    const q = await this.quote(amountAtoms, opts);
    this.log(`[bridge] ${q.inFormatted || amountAtoms} USDC Ethereum -> Base, out ${q.outFormatted || "?"}, fees gas ${q.fees.gasUsd ?? "?"} relayer ${q.fees.relayerServiceUsd ?? "?"} USD, about ${q.timeEstimate ?? "?"} s`);
    return this.execute(q, { ...opts, amountAtoms });
  }
}
