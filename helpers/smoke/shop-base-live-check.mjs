// A read-only check against the real USDC contract on Base (no fork, no gas, no money): a fresh buyer wallet signs
// an x402 authorization for 1 USDC to the owner's address, and the settler's transferWithAuthorization call is
// SIMULATED with eth_call. USDC checks the time window, the nonce and the signature before it looks at the
// balance, so the expected answer is the revert "transfer amount exceeds balance" (the buyer holds nothing): that
// proves the encoding and the signature pass the real contract. "invalid signature" would mean they do not.
import { JsonRpcProvider, Contract, Wallet, Signature } from "ethers";
import { Seller, USDC } from "../lib/x402seller.mjs";
import { X402Payer } from "../../gateway/x402.mjs";

const RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const PAY_TO = process.env.SHOP_PAY_TO || "0x2c769cDE285eb0d3c7130F9F0f14932106384095";
const provider = new JsonRpcProvider(RPC, 8453, { staticNetwork: true });
const settler = Wallet.createRandom(); // any address may submit; the simulation needs no gas
const seller = new Seller({ chainId: 8453, payTo: PAY_TO, settlerKey: settler.privateKey, provider, log: (l) => console.log("   ", l) });
const buyer = Wallet.createRandom();
const required = seller.requirement({ micro: 1_000_000, url: "https://api.feedthebrownies.com/shop/note", description: "A research note", maxTimeoutSeconds: 600 });
const { payload } = await new X402Payer({ wallet: buyer, chainId: 8453 }).sign(required);
const a = payload.payload.authorization, sig = Signature.from(payload.payload.signature);
const usdc = new Contract(USDC[8453], ["function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)", "function authorizationState(address, bytes32) view returns (bool)"], provider);
console.log(`Base block ${await provider.getBlockNumber()}, buyer ${buyer.address} (empty), payTo ${PAY_TO}`);
console.log("nonce unused on chain:", !(await usdc.authorizationState(buyer.address, a.nonce)));
try {
  await usdc.transferWithAuthorization.staticCall(a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, sig.v, sig.r, sig.s, { from: settler.address });
  console.log("UNEXPECTED: the simulation passed with an empty buyer");
  process.exit(1);
} catch (e) {
  const why = String(e.reason || e.info?.error?.message || e.shortMessage || e.message);
  console.log("the real contract answered:", why.slice(0, 120));
  if (/exceeds balance/i.test(why)) { console.log("\nOK: the window, the nonce and the signature passed USDC's checks; only the balance was missing, as expected."); process.exit(0); }
  if (/invalid signature/i.test(why)) { console.log("\nFAILED: USDC rejected the signature (the domain or the encoding is wrong)."); process.exit(1); }
  console.log("\nUNCLEAR: another revert; read it above."); process.exit(2);
}
