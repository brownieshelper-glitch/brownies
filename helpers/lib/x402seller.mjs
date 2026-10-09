// The selling side of x402 version 2, the "exact" scheme on an EVM chain: how the shop gets paid in USDC per
// request. We answer 402 with a PAYMENT-REQUIRED header (base64 JSON) that says what we accept; the buyer signs an
// EIP-3009 transfer authorization for exactly that amount and sends the request again with a PAYMENT-SIGNATURE
// header; we check the signature and the buyer's balance, then settle it ourselves: our settler wallet submits
// transferWithAuthorization to the USDC contract and pays the gas (a few hundredths of a cent on Base), and the
// USDC goes straight from the buyer to the owner's wallet (payTo). The brownies never hold the money. The receipt
// goes back in PAYMENT-RESPONSE. The payer side of the same protocol lives in gateway/x402.mjs; the runtime is
// deployed alone, so the shared lines are repeated here. Spec: github.com/coinbase/x402, specs/x402-specification-v2.md.
import { Contract, JsonRpcProvider, Wallet, Signature, getAddress, isAddress, verifyTypedData } from "ethers";

/// USDC by chain id: Base, Ethereum.
export const USDC = { 8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" };
export const NETWORK = (chainId) => `eip155:${chainId}`;

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
/// The EIP-712 domain USDC signs under (name "USD Coin", version "2" on Base and Ethereum).
export const EXTRA = { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" };

const ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
];

/// The headers carry base64 JSON.
export const b64 = {
  encode: (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64"),
  decode: (s) => JSON.parse(Buffer.from(String(s || ""), "base64").toString("utf8")),
};

export const domainFor = (asset, chainId, extra = EXTRA) => ({ name: extra?.name || EXTRA.name, version: extra?.version || EXTRA.version, chainId, verifyingContract: getAddress(asset) });
const asMessage = (a) => ({ from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce });
const isHex32 = (s) => /^0x[0-9a-fA-F]{64}$/.test(String(s || ""));
const isUint = (s) => /^\d+$/.test(String(s ?? ""));

/// The body of a 402: what we accept for this resource. `micro` is the price in USDC's atomic units (6 decimals).
export function requirement({ chainId, asset, payTo, micro, url, description = "", mimeType = "application/json", maxTimeoutSeconds = 300, error = "" }) {
  const body = {
    x402Version: 2,
    resource: { url: String(url), description: String(description), mimeType },
    accepts: [{ scheme: "exact", network: NETWORK(chainId), amount: String(Math.max(0, Math.round(Number(micro) || 0))), asset: getAddress(asset), payTo: getAddress(payTo), maxTimeoutSeconds, extra: { ...EXTRA } }],
  };
  if (error) body.error = String(error);
  return body;
}

/// The buyer's PAYMENT-SIGNATURE header as an object, or null when it is not base64 JSON.
export function parsePayment(header) {
  if (!header) return null;
  try { const p = b64.decode(header); return p && typeof p === "object" ? p : null; } catch { return null; }
}

/// The checks that need no chain: the payload fits what we asked (scheme, network, asset, payTo, amount), the
/// authorization pays us at least the price inside its time window, and the signature is the payer's own.
/// Returns { ok: true, payer, authorization, micro } or { ok: false, error }.
export function checkPayment(payload, required, { now = Date.now() } = {}) {
  const want = required?.accepts?.[0];
  if (!payload || payload.x402Version !== 2) return { ok: false, error: "x402Version must be 2" };
  const acc = payload.accepted, pl = payload.payload, a = pl?.authorization;
  if (!acc || !pl || !a) return { ok: false, error: "the payment is missing accepted, payload or authorization" };
  if (acc.scheme !== want.scheme || acc.network !== want.network) return { ok: false, error: `we accept ${want.scheme} on ${want.network}` };
  if (String(acc.asset).toLowerCase() !== want.asset.toLowerCase()) return { ok: false, error: "we accept USDC only" };
  if (String(acc.payTo).toLowerCase() !== want.payTo.toLowerCase()) return { ok: false, error: "the payment must go to our address" };
  if (!isUint(acc.amount) || BigInt(acc.amount) < BigInt(want.amount)) return { ok: false, error: `the price is ${want.amount} atomic units` };
  if (!isAddress(a.from) || !isAddress(a.to)) return { ok: false, error: "from and to must be addresses" };
  if (getAddress(a.to) !== want.payTo) return { ok: false, error: "the authorization must pay our address" };
  if (!isUint(a.value) || BigInt(a.value) < BigInt(want.amount)) return { ok: false, error: "the authorization is for less than the price" };
  if (!isUint(a.validAfter) || !isUint(a.validBefore)) return { ok: false, error: "validAfter and validBefore must be unix seconds" };
  const sec = Math.floor(now / 1000);
  if (BigInt(a.validAfter) > BigInt(sec)) return { ok: false, error: "the authorization is not valid yet" };
  if (BigInt(a.validBefore) <= BigInt(sec + 10)) return { ok: false, error: "the authorization expires too soon" };
  if (!isHex32(a.nonce)) return { ok: false, error: "the nonce must be 32 bytes" };
  if (typeof pl.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(pl.signature)) return { ok: false, error: "the signature must be 65 bytes" };
  const chainId = Number(String(want.network).split(":")[1]);
  let signer;
  try { signer = verifyTypedData(domainFor(want.asset, chainId, acc.extra), TYPES, asMessage(a), pl.signature); } catch { return { ok: false, error: "the signature does not parse" }; }
  if (signer.toLowerCase() !== String(a.from).toLowerCase()) return { ok: false, error: "the signature is not the payer's" };
  return { ok: true, payer: getAddress(a.from), authorization: a, micro: Number(BigInt(a.value)) };
}

export class Seller {
  /// payTo: the owner's wallet, where every payment lands. settlerKey: the wallet that submits the transfers and
  /// pays gas (it holds a little ETH and nothing else). provider/token can be given for tests and forks.
  constructor({ chainId = 8453, asset = USDC[chainId] || USDC[8453], payTo = "", settlerKey = "", rpcUrl = "https://mainnet.base.org", provider = null, token = null, now = () => Date.now(), log = () => {}, minGasWei = 20_000_000_000_000n } = {}) {
    this.chainId = chainId; this.asset = getAddress(asset); this.now = now; this.log = log; this.minGasWei = BigInt(minGasWei);
    this.payTo = isAddress(payTo) ? getAddress(payTo) : "";
    this.provider = provider || (rpcUrl ? new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true }) : null);
    this.settler = /^0x[0-9a-fA-F]{64}$/.test(settlerKey) ? new Wallet(settlerKey, this.provider) : null;
    this.token = token || (this.provider ? new Contract(this.asset, ABI, this.settler || this.provider) : null);
    this.gasCache = null;
    this.settled = { count: 0, micro: 0 };
  }
  get configured() { return Boolean(this.payTo && this.settler && this.token); }
  get address() { return this.settler?.address || null; }

  /// The settler's ETH, re-read at most once a minute. Null when the chain did not answer.
  async gasWei({ fresh = false } = {}) {
    if (!this.settler || !this.provider) return null;
    if (!fresh && this.gasCache && this.now() - this.gasCache.at < 60_000) return this.gasCache.wei;
    try { const wei = await this.provider.getBalance(this.settler.address); this.gasCache = { at: this.now(), wei }; return wei; }
    catch (e) { this.log(`[x402] the chain did not answer for the settler's balance: ${e.message}`); return this.gasCache?.wei ?? null; }
  }

  /// Can we take a payment right now? { ok, reason }.
  async open() {
    if (!this.payTo) return { ok: false, reason: "no payout address (SHOP_PAY_TO)" };
    if (!this.settler) return { ok: false, reason: "no settler wallet (SHOP_SETTLER_PRIVATE_KEY)" };
    const wei = await this.gasWei();
    if (wei === null) return { ok: false, reason: "the chain did not answer" };
    if (wei < this.minGasWei) return { ok: false, reason: `the settler wallet ${this.settler.address} needs ETH for gas on Base (it has ${(Number(wei) / 1e18).toFixed(6)})` };
    return { ok: true, reason: "" };
  }

  requirement(o) { return requirement({ chainId: this.chainId, asset: this.asset, payTo: this.payTo, ...o }); }

  /// The chain's word on a payment that passed checkPayment: the nonce unused, the balance there.
  async verify(payload, required, { now = this.now() } = {}) {
    const c = checkPayment(payload, required, { now });
    if (!c.ok) return c;
    if (!this.token) return { ok: false, error: "no chain to check against" };
    try {
      const [used, bal] = await Promise.all([this.token.authorizationState(c.payer, c.authorization.nonce), this.token.balanceOf(c.payer)]);
      if (used) return { ok: false, error: "this authorization was used already" };
      if (BigInt(bal) < BigInt(c.authorization.value)) return { ok: false, error: `the payer holds ${(Number(bal) / 1e6).toFixed(2)} USDC, less than the price` };
    } catch (e) { return { ok: false, error: `the chain did not answer: ${e.message.slice(0, 80)}` }; }
    return c;
  }

  /// Submits the transfer and waits for it. { ok: true, tx, payer, micro } or { ok: false, error }.
  async settle(payload) {
    if (!this.configured) return { ok: false, error: "the shop cannot settle: no settler wallet" };
    const a = payload.payload.authorization;
    const sig = Signature.from(payload.payload.signature);
    try {
      const tx = await this.token.transferWithAuthorization(a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, sig.v, sig.r, sig.s);
      const rc = await tx.wait(1);
      if (!rc || rc.status !== 1) return { ok: false, error: "the transfer reverted" };
      const micro = Number(BigInt(a.value));
      this.settled.count++; this.settled.micro += micro;
      this.gasCache = null;
      this.log(`[x402] settled ${(micro / 1e6).toFixed(2)} USDC from ${a.from} to ${a.to} (tx ${rc.hash})`);
      return { ok: true, tx: rc.hash, payer: getAddress(a.from), micro };
    } catch (e) {
      const why = String(e.shortMessage || e.reason || e.message || "").slice(0, 160);
      this.log(`[x402] settlement failed: ${why}`);
      return { ok: false, error: `the transfer did not go through: ${why}` };
    }
  }

  /// The PAYMENT-RESPONSE header value.
  response({ success, transaction = "", payer = null, errorReason = null }) {
    const r = { success: Boolean(success), transaction: transaction || "", network: NETWORK(this.chainId) };
    if (payer) r.payer = payer;
    if (errorReason) r.errorReason = errorReason;
    return b64.encode(r);
  }
}
