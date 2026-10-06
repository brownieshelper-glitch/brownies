import { ethers, provider } from "./rpc.mjs";
import fs from "node:fs";
const fabi = JSON.parse(fs.readFileSync("factory/_abi.json","utf8"));
const dabi = JSON.parse(fs.readFileSync("hookDeployer/_abi.json","utf8"));
const fi = new ethers.Interface(fabi), di = new ethers.Interface(dabi);
const START = 26125550;
const latest = await provider.getBlockNumber();
const t0 = fi.getEvent("FoundationLaunchedV3").topicHash;
console.log("FoundationLaunchedV3 topic", t0);
let all = [];
for (let from = START; from <= latest; from += 2000) {
  const to = Math.min(latest, from + 1999);
  const l = await provider.getLogs({ fromBlock: from, toBlock: to, topics: [t0] });
  all.push(...l);
}
console.log("launch events since start:", all.length);
const out = [];
for (const l of all) {
  const p = fi.parseLog(l);
  const r = p.args.result;
  out.push({ block: l.blockNumber, tx: l.transactionHash, emitter: l.address, token: p.args.token, creator: p.args.creator, hook: p.args.hook, ledger: p.args.ledger, quote: p.args.quote, initialBuy: p.args.initialBuyQuoteAmount.toString(), basePosOwner: r.basePositionOwner });
}
fs.writeFileSync("launches.json", JSON.stringify(out, null, 1));
for (const o of out.slice(0, 12)) console.log(JSON.stringify(o));
console.log("distinct emitters", new Set(out.map(o=>o.emitter)).size, "distinct creators", new Set(out.map(o=>o.creator)).size);
// graph deployer events in the same range
const g0 = di.getEvent("ProgrammableCreate2GraphDeployed").topicHash;
let gl = [];
for (let from = START; from <= latest; from += 2000) {
  const to = Math.min(latest, from + 1999);
  gl.push(...await provider.getLogs({ address: "0xB012e4A8F2c5FC4E8E4faCA9D5Ad6FfF13FBA887", fromBlock: from, toBlock: to, topics: [g0] }));
}
console.log("graph deployed events:", gl.length);
const launchers = {};
for (const l of gl) { const p = di.parseLog(l); const k = p.args.authorizedLauncher + " ns " + p.args.routeNamespace + " targets " + p.args.targetCount; launchers[k] = (launchers[k]||0)+1; }
console.log(launchers);
