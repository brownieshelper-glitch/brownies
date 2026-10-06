import { ethers, raw } from "./rpc.mjs";
for (const h of ["0xfc044cf4223215ca8565b1d1c0104572fda58c1db9251dedc6b1dc8873b9372e","0x81de2fbe25ab114190bf90e191e21e2022ff1e05091664a65d93eaef5ce507da","0x672d0b6c30c19f5fc14ba189b8e87d46c8aaadf984b69d03f5e30578e56920b3"]) {
  const r = await raw("eth_getTransactionReceipt", [h]);
  console.log(h.slice(0,12), "status", r.status, "gasUsed", Number(r.gasUsed), "effGasPrice gwei", Number(r.effectiveGasPrice)/1e9, "cost ETH", ethers.formatEther(BigInt(r.gasUsed)*BigInt(r.effectiveGasPrice)));
}
// deployer of implementation = 0x9e13..., is it an EOA? And check claimCreator is permissionless by simulating from a random address on CLAUSTR ledger
const L = "0x9e57f6D5568C7836f856064BB5Fb8cDf7F0453FF";
const i = new ethers.Interface(["function claimCreator() returns (uint256)"]);
const ret = await raw("eth_call", [{ from: "0x000000000000000000000000000000000000dEaD", to: L, data: i.encodeFunctionData("claimCreator") }, "latest"]);
console.log("claimCreator simulated from a stranger -> returns WETH", ethers.formatEther(i.decodeFunctionResult("claimCreator", ret)[0]));
