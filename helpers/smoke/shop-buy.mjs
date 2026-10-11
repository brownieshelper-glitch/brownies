// Buys one item from the live shop the way an agent would, with the gateway's own x402 payer: the 402, the signed
// authorization, the second request, the receipt. The buyer's key comes from BUYER_PRIVATE_KEY, or else from the
// helpers env file's SHOP_SETTLER_PRIVATE_KEY (the settler buying from itself is a fine first test).
// usage: node smoke/shop-buy.mjs [note|meme|clip] ["what you want"]   (SHOP_URL to point elsewhere)
import { readFileSync } from "node:fs";
import { Wallet } from "ethers";
import { X402Payer } from "../../gateway/x402.mjs";

const [item = "note", prompt = "A short note on what x402 is and why an agent would use it."] = process.argv.slice(2);
const base = (process.env.SHOP_URL || "https://api.feedthebrownies.com").replace(/\/$/, "");
let key = process.env.BUYER_PRIVATE_KEY || "";
if (!key) {
  const file = process.env.HELPERS_ENV || "C:/Users/andrea/helix-secrets/brownies-helpers.env";
  const m = /^SHOP_SETTLER_PRIVATE_KEY=(\S+)/m.exec(readFileSync(file, "utf8"));
  if (!m) throw new Error("no BUYER_PRIVATE_KEY and no SHOP_SETTLER_PRIVATE_KEY in the env file");
  key = m[1];
}
const wallet = new Wallet(key);
console.log(`buyer ${wallet.address}, buying "${item}" from ${base}`);
const payer = new X402Payer({ wallet, chainId: 8453, maxMicro: 20_000_000, log: (l) => console.log("   ", l) });
const t0 = Date.now();
try {
  const { response, paid } = await payer.fetch(`${base}/shop/${item}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }) });
  const body = await response.json().catch(() => null);
  console.log(`answer ${response.status} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (paid) console.log(`paid ${(paid.micro / 1e6).toFixed(2)} USDC, tx ${paid.settlement?.transaction || "none"}`);
  console.log(JSON.stringify(body, null, 2));
} catch (e) {
  console.log(`no purchase: ${e.message}`);
  process.exitCode = 1;
}
