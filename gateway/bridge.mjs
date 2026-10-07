// Relay (relay.link): moves the pantry's USDC from Ethereum, where the coin's fees land, to Base, where x402 is
// paid. One quote (no referrer: a referrer needs an API key, a plain quote does not), then the steps Relay lists,
// in order, each a transaction from the pantry wallet (an approval of USDC, then the deposit), each item's check
// endpoint polled until Relay says success. Docs: docs.relay.link/references/api/get-quote-v2.
import { USDC } from "./x402.mjs";

export const RELAY = "https://api.relay.link";
const DONE = new Set(["success"]);
const DEAD = new Set(["failure", "refund"]);

export class RelayBridge {
  /// wallet: an ethers Wallet connected to the origin chain's provider.
  constructor({ wallet, fetch = globalThis.fetch, api = RELAY, from = { chainId: 1, currency: USDC[1] }, to = { chainId: 8453, currency: USDC[8453] }, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
    this.wallet = wallet; this.fetch = fetch; this.api = api.replace(/\/$/, ""); this.from = from; this.to = to; this.sleep = sleep; this.log = log;
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

  /// Runs a quote's steps. Returns { requestId, txs, status }. Only transaction steps are supported: a signature step
  /// (a different route) stops the bridge before anything is sent.
  async execute(q, { tries = 60, everyMs = 5000 } = {}) {
    for (const step of q.steps) if (step.kind !== "transaction") throw new Error(`Relay step ${step.id} needs a ${step.kind}, not supported`);
    const txs = [];
    let status = "sent";
    for (const step of q.steps) {
      for (const item of step.items || []) {
        if (item.status === "complete") continue;
        const d = item.data || {};
        const tx = { to: d.to, data: d.data, value: d.value ? BigInt(d.value) : 0n };
        if (d.gas) tx.gasLimit = BigInt(d.gas);
        if (d.maxFeePerGas) { tx.maxFeePerGas = BigInt(d.maxFeePerGas); tx.maxPriorityFeePerGas = BigInt(d.maxPriorityFeePerGas || 0); }
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
    return this.execute(q, opts);
  }
}
