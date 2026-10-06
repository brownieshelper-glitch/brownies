import { ethers, raw } from "./rpc.mjs";
const A = "0x9aFCaab8Ef326e44BE357CF7B21ddA7fc51d39Db";
const code = await raw("eth_getCode", [A, "latest"]);
console.log("code", code);
const slot = await raw("eth_getStorageAt", [A, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", "latest"]);
console.log("erc1967 impl slot", slot);
const impl = "0x" + slot.slice(26);
const r = await fetch(`https://sourcify.dev/server/v2/contract/1/${impl}?fields=compilation`); const j = await r.json();
console.log("impl", impl, j.compilation?.name, j.compilation?.fullyQualifiedName, j.match);
const rcpt = await raw("eth_getTransactionReceipt", ["0xaac0c9f09e9dfed5d2959ea40c846ecf221e19cd790e3ff52d06ff81e6fe999a"]);
console.log("logs", rcpt.logs.length, "gasUsed", Number(rcpt.gasUsed));
// find UserOperationEvent topic 0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f
for (const l of rcpt.logs) if (l.topics[0] === "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f") console.log("UserOp sender", "0x"+l.topics[2].slice(26), "paymaster", "0x"+l.topics[3].slice(26));
// Also check ns constant
console.log("ns", ethers.keccak256(ethers.toUtf8Bytes("programmable.module-foundation.ethereum-graph.v1")));
console.log("topology", ethers.keccak256(ethers.toUtf8Bytes("engine-token-hook.v1")));
