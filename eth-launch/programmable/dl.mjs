import fs from "node:fs"; import path from "node:path";
const [addr, name] = process.argv.slice(2);
const r = await fetch(`https://sourcify.dev/server/v2/contract/1/${addr}?fields=all`);
if (!r.ok) { console.log(name, addr, "HTTP", r.status, (await r.text()).slice(0,200)); process.exit(0); }
const j = await r.json();
const dir = path.join(name);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "_meta.json"), JSON.stringify({ match: j.match, creationMatch: j.creationMatch, runtimeMatch: j.runtimeMatch, verifiedAt: j.verifiedAt, compilation: j.compilation, deployment: j.deployment, proxyResolution: j.proxyResolution }, null, 1));
fs.writeFileSync(path.join(dir, "_abi.json"), JSON.stringify(j.abi, null, 1));
if (j.creationBytecode?.onchainBytecode) fs.writeFileSync(path.join(dir, "_creation.hex"), j.creationBytecode.onchainBytecode);
let n = 0;
for (const [p, v] of Object.entries(j.sources || {})) {
  const out = path.join(dir, p.replace(/\.\.\//g, "__/"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, v.content); n++;
}
console.log(name, addr, j.match, j.compilation?.name, "files", n, "deployer", j.deployment?.deployer, "block", j.deployment?.blockNumber, "verifiedAt", j.verifiedAt);
