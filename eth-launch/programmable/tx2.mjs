import { ethers, raw } from "./rpc.mjs";
import fs from "node:fs";
const rabi = JSON.parse(fs.readFileSync("router/_abi.json","utf8"));
const ri = new ethers.Interface(rabi);
const graphs = JSON.parse(fs.readFileSync("graphs.json","utf8"));
const c = async (to, sig, args=[]) => { const i = new ethers.Interface(["function " + sig]); const f = i.fragments[0]; const r = await raw("eth_call", [{ to, data: i.encodeFunctionData(f, args) }, "latest"]); return i.decodeFunctionResult(f, r); };
const ROUTER = "0x8622DD5bAb44185f2A458ac90384Ac99248f8d56";
const hs = Object.keys(graphs).slice(6);
for (const h of hs) {
  const g = graphs[h];
  const tx = await raw("eth_getTransactionByHash", [h]);
  const [proxy, token, hook] = g.targets.sort((a,b)=>a.idx-b.idx).map(t => t.addr);
  const creator = (await c(hook, "creator() view returns (address)"))[0];
  const lw = (await c(proxy, "LAUNCH_WALLET() view returns (address)"))[0];
  const buy = (await c(hook, "creatorBuyFeeBps() view returns (uint16)"))[0];
  const sell = (await c(hook, "creatorSellFeeBps() view returns (uint16)"))[0];
  const mc = (await c(hook, "moduleCount() view returns (uint256)"))[0];
  const ledger = (await c(hook, "ledger() view returns (address)"))[0];
  const fromCode = await raw("eth_getCode", [tx.from, "latest"]);
  const toCode = await raw("eth_getCode", [tx.to, "latest"]);
  const creatorCode = await raw("eth_getCode", [creator, "latest"]);
  let fn = "?"; try { fn = ri.parseTransaction({ data: tx.input, value: tx.value })?.name || ("selector " + tx.input.slice(0,10)); } catch {}
  const launchId = (await c(ROUTER, "launchIdByToken(address) view returns (bytes32)", [token]))[0];
  console.log(JSON.stringify({ block: g.block, tx: h, from: tx.from, fromCodeLen: (fromCode.length-2)/2, to: tx.to, toCodeLen: (toCode.length-2)/2, fn, type: tx.type, value: ethers.formatEther(tx.value), proxy, token, hook, ledger, hookCreator: creator, creatorCodeLen: (creatorCode.length-2)/2, creatorCodePrefix: creatorCode.slice(0, 50), proxyLaunchWallet: lw, buyBps: Number(buy), sellBps: Number(sell), modules: Number(mc), stamped: launchId !== ethers.ZeroHash }));
}
