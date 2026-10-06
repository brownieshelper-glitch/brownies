import { ethers, raw } from "./rpc.mjs";
const S = "0x755509eA6e3F5Ec1aA2E797bb68f1B87DD8b886b";
const c = async (to, sig, args=[]) => { const i = new ethers.Interface(["function " + sig]); const f = i.fragments[0]; const r = await raw("eth_call", [{ to, data: i.encodeFunctionData(f, args) }, "latest"]); return i.decodeFunctionResult(f, r); };
console.log("owners", (await c(S, "getOwners() view returns (address[])"))[0]);
console.log("threshold", (await c(S, "getThreshold() view returns (uint256)"))[0].toString());
console.log("version", (await c(S, "VERSION() view returns (string)"))[0]);
// ledger of CLAUSTR
const L = "0x9e57f6D5568C7836f856064BB5Fb8cDf7F0453FF";
for (const f of ["platformReceived","platformClaimed","creatorReceived","creatorCredited","creatorClaimed","creatorShareBps"]) console.log(f, (await c(L, `${f}() view returns (uint256)`))[0].toString());
console.log("ledger creator", (await c(L, "creator() view returns (address)"))[0], "quote", (await c(L, "quote() view returns (address)"))[0]);
const PM = "0x000000000004444c5dc75cB358380D2e3dE08A90", WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
console.log("ledger ERC6909 WETH claims", (await c(PM, "balanceOf(address,uint256) view returns (uint256)", [L, BigInt(WETH)]))[0].toString());
// hook: moduleAt for the first launch with 1 module
const H1 = "0xd5c26574ADae1Dc742e4E5c0B783Cf7Ed9EC20CC";
const m = await c(H1, "moduleAt(uint256) view returns (tuple(address instance,bytes32 codeHash,bytes32 configurationHash,tuple(bytes32 moduleId,uint16 abiVersion,uint8 phases,uint8 resources,uint32 beforeGas,uint32 afterGas,uint32 actionGas,bool failOpenAfter,bytes32 exclusiveGroup) descriptor))", [0]);
console.log("launch1 module instance", m[0].instance, "resources", m[0].descriptor.resources.toString());
const L1 = "0xc87D914a8935f127Bb92B6e2fBD2F91FA4B01845";
console.log("launch1 ledger moduleShareBps", (await c(L1, "moduleShareBps(address) view returns (uint16)", [m[0].instance]))[0].toString(), "creatorShareBps", (await c(L1, "creatorShareBps() view returns (uint16)"))[0].toString());
console.log("walletcap limit", (await c(m[0].instance, "supplyLimitBps() view returns (uint16)"))[0].toString(), "minutes", (await c(m[0].instance, "durationMinutes() view returns (uint32)"))[0].toString());
