import { ethers, raw, hex } from "./rpc.mjs";
import fs from "node:fs";
const dabi = JSON.parse(fs.readFileSync("hookDeployer/_abi.json","utf8"));
const di = new ethers.Interface(dabi);
const START = 26125550;
const latest = Number(await raw("eth_blockNumber", []));
const logs = await raw("eth_getLogs", [{ address: "0xB012e4A8F2c5FC4E8E4faCA9D5Ad6FfF13FBA887", fromBlock: hex(START), toBlock: hex(latest) }]);
console.log("logs", logs.length, "latest", latest);
const byTx = {};
for (const l of logs) {
  const p = di.parseLog(l);
  const t = (byTx[l.transactionHash] ||= { block: Number(l.blockNumber), targets: [] });
  if (p.name === "ProgrammableCreate2GraphTargetDeployed") t.targets.push({ idx: Number(p.args.targetIndex), id: p.args.targetIdHash, addr: p.args.deployment, runtime: p.args.runtimeCodeHash, dv: p.args.deploymentValue.toString(), iv: p.args.initializerValue.toString() });
  else Object.assign(t, { launcher: p.args.authorizedLauncher, ns: p.args.routeNamespace, topology: p.args.topologyHash, value: p.args.totalValue.toString(), n: Number(p.args.targetCount) });
}
fs.writeFileSync("graphs.json", JSON.stringify(byTx, null, 1));
console.log("graph txs:", Object.keys(byTx).length);
for (const [tx, t] of Object.entries(byTx)) console.log(t.block, tx, "launcher", t.launcher, "ns", t.ns?.slice(0,12), "topo", t.topology?.slice(0,12), "value", t.value, "targets", t.targets.map(x => x.addr + ":" + x.runtime.slice(0,10)).join(" "));
