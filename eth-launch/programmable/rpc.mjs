import { createRequire } from "node:module";
const require = createRequire("C:/Users/andrea/OneDrive/Desktop/arc-cctp - Copy/helix-hook/keeper/package.json");
export const { ethers } = require("ethers");
export const RPCS = ["https://ethereum-rpc.publicnode.com","https://rpc.mevblocker.io","https://gateway.tenderly.co/public/mainnet"];
export const provider = new ethers.JsonRpcProvider(RPCS[0], 1, { staticNetwork: true });
export async function raw(method, params) {
  let last;
  for (const u of RPCS) {
    try {
      const r = await fetch(u, { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ jsonrpc:"2.0", id:1, method, params }), signal: AbortSignal.timeout(30000) });
      const j = await r.json();
      if (j.error) { last = new Error(u + " " + JSON.stringify(j.error).slice(0,300)); continue; }
      return j.result;
    } catch (e) { last = e; }
  }
  throw last;
}
export const hex = (n) => "0x" + BigInt(n).toString(16);
