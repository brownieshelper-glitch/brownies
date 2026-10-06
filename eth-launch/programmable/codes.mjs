import { ethers, provider } from "./rpc.mjs";
const addrs = {
 factory: "0x487E8A196812fEC534f2D2514bfdc7c609EBAe35",
 hookDeployer: "0xB012e4A8F2c5FC4E8E4faCA9D5Ad6FfF13FBA887",
 walletCapFactory: "0x2960751d51a6559d630f9fa9d94cd0011816d5d2",
};
console.log("block", await provider.getBlockNumber());
for (const [k,a] of Object.entries(addrs)) {
  const c = await provider.getCode(a);
  console.log(k, a, "len", (c.length-2)/2, "hash", ethers.keccak256(c));
}
