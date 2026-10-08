// x402 version 2, the "exact" scheme on an EVM chain: how the gateway pays a web API per request with USDC, no
// account and no API key. The server answers 402 with a PAYMENT-REQUIRED header (base64 JSON) that lists what it
// accepts; we pick the entry on our chain, sign an EIP-3009 transfer authorization for exactly that amount (the
// facilitator pays the gas and settles it) and send the same request again with a PAYMENT-SIGNATURE header. The
// receipt comes back in PAYMENT-RESPONSE. Spec: github.com/coinbase/x402, specs/x402-specification-v2.md,
// specs/schemes/exact/scheme_exact_evm.md and specs/transports-v2/http.md.
import { Wallet, hexlify, randomBytes, verifyTypedData, getAddress } from "ethers";

/// USDC by chain id: Base, Ethereum.
export const USDC = { 8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" };

/// EIP-3009 transferWithAuthorization, the typed data USDC verifies.
export const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

/// The headers carry base64 JSON.
export const b64 = {
  encode: (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64"),
  decode: (s) => JSON.parse(Buffer.from(String(s || ""), "base64").toString("utf8")),
};

/// The requirement we can meet: the exact scheme on our chain, in our asset, by EIP-3009 (or with no method named).
export function pickRequirement(required, { chainId, asset }) {
  const net = `eip155:${chainId}`;
  const list = Array.isArray(required?.accepts) ? required.accepts : [];
  return list.find((a) => a && a.scheme === "exact" && a.network === net && typeof a.asset === "string" && typeof a.payTo === "string"
    && (!asset || a.asset.toLowerCase() === asset.toLowerCase())
    && (!a.extra?.assetTransferMethod || a.extra.assetTransferMethod === "eip3009")) || null;
}

/// The EIP-712 domain of the asset, from the requirement's extra (USDC: "USD Coin", "2").
export function domainFor(req, chainId) {
  return { name: req.extra?.name || "USD Coin", version: req.extra?.version || "2", chainId, verifyingContract: getAddress(req.asset) };
}

const asMessage = (a) => ({ from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce });

/// Who signed a payment payload (a facilitator's first check; the tests' facilitator uses it).
export function recoverPayer(payload, chainId) {
  return verifyTypedData(domainFor(payload.accepted, chainId), TYPES, asMessage(payload.payload.authorization), payload.payload.signature);
}

export class X402Payer {
  /// privateKey or wallet: the pantry wallet that holds USDC on `chainId`. maxMicro: the most one request may cost.
  constructor({ privateKey = "", wallet = null, chainId = 8453, asset = USDC[chainId] || USDC[8453], maxMicro = 2_000_000, fetch = globalThis.fetch, now = () => Date.now(), log = () => {} } = {}) {
    this.wallet = wallet || new Wallet(privateKey);
    this.chainId = chainId; this.asset = asset; this.maxMicro = maxMicro;
    this.fetchRaw = fetch; this.now = now; this.log = log;
    this.paid = { count: 0, micro: 0, last: null }; // what this process has paid so far
  }
  get address() { return this.wallet.address; }

  /// Signs the requirement we can meet in a PAYMENT-REQUIRED body. Returns { header, payload, micro }.
  async sign(required, { maxMicro = null } = {}) {
    const req = pickRequirement(required, { chainId: this.chainId, asset: this.asset });
    if (!req) {
      const offered = (Array.isArray(required?.accepts) ? required.accepts : []).map((a) => `${a?.scheme}/${a?.network}`).join(", ") || "nothing";
      throw new Error(`x402: nothing payable on eip155:${this.chainId} in USDC (offered: ${offered})`);
    }
    const micro = Number(req.amount);
    if (!Number.isInteger(micro) || micro < 0) throw new Error(`x402: bad amount ${req.amount}`);
    const cap = maxMicro != null && Number.isFinite(Number(maxMicro)) ? Math.min(this.maxMicro, Math.max(0, Math.ceil(Number(maxMicro)))) : this.maxMicro;
    if (micro > cap) throw new Error(`x402: the price ${(micro / 1e6).toFixed(6)} USDC is over the cap of ${(cap / 1e6).toFixed(cap === this.maxMicro ? 2 : 6)} USDC ${cap === this.maxMicro ? "per request" : "for this request"}`);
    const sec = Math.floor(this.now() / 1000);
    const window = Math.min(Math.max(Number(req.maxTimeoutSeconds) || 300, 60), 3600);
    const authorization = { from: this.address, to: getAddress(req.payTo), value: String(micro), validAfter: String(sec - 600), validBefore: String(sec + window), nonce: hexlify(randomBytes(32)) };
    const signature = await this.wallet.signTypedData(domainFor(req, this.chainId), TYPES, asMessage(authorization));
    const payload = { x402Version: 2, resource: required.resource, accepted: req, payload: { signature, authorization } };
    if (required.extensions) payload.extensions = required.extensions;
    return { header: b64.encode(payload), payload, micro };
  }

  /// fetch that pays: the request, the 402, the signed retry. Returns { response, paid }; paid is null when the
  /// resource asked for nothing. A second 402, a price over the cap or an unknown chain are errors, not payments.
  async fetch(url, init = {}, { maxMicro = null } = {}) {
    const first = await this.fetchRaw(url, init);
    if (first.status !== 402) return { response: first, paid: null };
    const header = first.headers.get("payment-required");
    if (!header) throw new Error(`x402: 402 without a PAYMENT-REQUIRED header from ${url}`);
    let required;
    try { required = b64.decode(header); } catch { throw new Error("x402: PAYMENT-REQUIRED is not base64 JSON"); }
    const { header: sig, payload, micro } = await this.sign(required, { maxMicro });
    const headers = new Headers(init.headers || {});
    headers.set("payment-signature", sig);
    const second = await this.fetchRaw(url, { ...init, headers });
    if (second.status === 402) {
      let why = ""; try { why = b64.decode(second.headers.get("payment-required")).error || ""; } catch { /* no detail */ }
      throw new Error(`x402: payment refused${why ? `: ${why}` : ""}`);
    }
    let settlement = null;
    const pr = second.headers.get("payment-response");
    if (pr) { try { settlement = b64.decode(pr); } catch { settlement = null; } }
    const paid = { micro, settlement, to: payload.accepted.payTo, authorization: payload.payload.authorization };
    if (second.ok) { this.paid.count++; this.paid.micro += micro; this.paid.last = { at: this.now(), micro, url: String(url), tx: settlement?.transaction || null }; }
    this.log(`[x402] paid ${(micro / 1e6).toFixed(6)} USDC to ${paid.to} for ${url}${settlement?.transaction ? ` (tx ${settlement.transaction})` : ""}`);
    return { response: second, paid };
  }
}
