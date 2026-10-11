// A live look at Caramel's leads: the Programmable launches of the last hours on Ethereum (read-only RPC), each
// decoded and measured on DexScreener, scored and printed. Nothing is written, nothing is posted.
// usage: node smoke/caramel-scan.mjs [hours]   (RPC_URL to change the node)
import { JsonRpcProvider } from "ethers";
import { launchLeads, marketOf, scoreLead } from "../lib/launches.mjs";

const hours = Number(process.argv[2] || 24);
const provider = new JsonRpcProvider(process.env.RPC_URL || "https://ethereum-rpc.publicnode.com");
const head = await provider.getBlockNumber();
const from = head - hours * 300;
console.log(`Ethereum block ${head}; the last ${hours} h = blocks ${from}..${head}`);
const t0 = Date.now();
const launches = await launchLeads(provider, { fromBlock: from, toBlock: head, log: (l) => console.log("   ", l) });
console.log(`${launches.length} launch${launches.length === 1 ? "" : "es"} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const rows = [];
for (const l of launches) {
  const m = await marketOf(l.token).catch(() => null);
  const handle = l.twitter || m?.twitter || null;
  rows.push({ symbol: l.symbol || "?", name: l.name || "?", token: l.token, handle, telegram: l.telegram || m?.telegram || null, trades: m?.trades24 || 0, vol: Math.round(m?.volume24Usd || 0), liq: Math.round(m?.liquidityUsd || 0), fdv: Math.round(m?.fdvUsd || 0), score: m ? scoreLead({ ...m, twitter: handle, telegram: l.telegram || m.telegram }) : 0 });
}
rows.sort((a, b) => b.score - a.score);
for (const r of rows) console.log(`${String(r.score).padStart(3)}  ${r.symbol.padEnd(10)} ${(r.handle ? "@" + r.handle : "(no X)").padEnd(18)} trades ${String(r.trades).padStart(5)}  vol $${String(r.vol).padStart(8)}  liq $${String(r.liq).padStart(8)}  fdv $${String(r.fdv).padStart(9)}  ${r.token}${r.telegram ? "  " + r.telegram : ""}`);
