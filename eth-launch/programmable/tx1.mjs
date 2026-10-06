import { ethers, raw } from "./rpc.mjs";
import fs from "node:fs";
const rabi = JSON.parse(fs.readFileSync("router/_abi.json","utf8"));
const ri = new ethers.Interface(rabi);
const graphs = JSON.parse(fs.readFileSync("graphs.json","utf8"));
const ROUTER = "0x8622DD5bAb44185f2A458ac90384Ac99248f8d56";
const c = async (to, sig, args=[]) => { const i = new ethers.Interface(["function " + sig]); const f = i.fragments[0]; const r = await raw("eth_call", [{ to, data: i.encodeFunctionData(f, args) }, "latest"]); return i.decodeFunctionResult(f, r); };
console.log("PERMIT_AUTHORITY", (await c(ROUTER, "PERMIT_AUTHORITY() view returns (address)"))[0]);
console.log("GRAPH_FACTORY", (await c(ROUTER, "GRAPH_FACTORY() view returns (address)"))[0]);
console.log("POOL_MANAGER", (await c(ROUTER, "POOL_MANAGER() view returns (address)"))[0]);
const out = [];
for (const [h, g] of Object.entries(graphs)) {
  const tx = await raw("eth_getTransactionByHash", [h]);
  const d = ri.parseTransaction({ data: tx.input, value: tx.value });
  const permit = d.args.permit, sr = d.args.stampRequest;
  const [proxy, token, hook] = g.targets.sort((a,b)=>a.idx-b.idx).map(t => t.addr);
  const creator = (await c(hook, "creator() view returns (address)"))[0];
  const lw = (await c(proxy, "LAUNCH_WALLET() view returns (address)"))[0];
  const buy = (await c(hook, "creatorBuyFeeBps() view returns (uint16)"))[0];
  const sell = (await c(hook, "creatorSellFeeBps() view returns (uint16)"))[0];
  const quote = (await c(hook, "quote() view returns (address)"))[0];
  const mc = (await c(hook, "moduleCount() view returns (uint256)"))[0];
  const ledger = (await c(hook, "ledger() view returns (address)"))[0];
  const fromCode = await raw("eth_getCode", [tx.from, "latest"]);
  const row = { block: g.block, tx: h, from: tx.from, fromCodeLen: (fromCode.length-2)/2, to: tx.to, fn: d.name, value: ethers.formatEther(tx.value), permitWallet: permit.launchWallet, kind: Number(permit.kind), proxy, token, hook, ledger, hookCreator: creator, proxyLaunchWallet: lw, buyBps: Number(buy), sellBps: Number(sell), quote, modules: Number(mc), tokenGtWeth: BigInt(token) > BigInt("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2") };
  out.push(row);
  console.log(JSON.stringify(row));
}
fs.writeFileSync("launch_rows.json", JSON.stringify(out, null, 1));
