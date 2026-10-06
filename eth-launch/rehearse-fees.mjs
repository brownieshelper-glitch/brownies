// After launch.mjs fork: trade the coin on the local anvil fork through the real Universal Router, then let a stranger
// pull the creator fee through the ledger and the harvester, and check that the dollars land where the design says.
//
//   node eth-launch/rehearse-fees.mjs [web/deployments/1.fork.json]      RPC_URL defaults to http://127.0.0.1:8557
//
// Steps: fund anvil account 1 (the buyer) -> buy 0.01 ETH inside the wallet-cap window -> a 0.2 ETH buy must be
// refused by the cap -> jump past the window -> buy 3 ETH -> sell half the coins -> a stranger (account 2) calls
// ledger.claimCreator() -> the same stranger calls harvester.claim() -> print and assert the split:
// 35% of the creator fee to MAIN_WALLET as ETH, 65% swapped to USDC and pulled by staking.fund (35/65) and the SUGAR
// minter (30/65), every dollar of it ending in FUNDING_WALLET. Local anvil only; refuses anything else.
import fs from "node:fs";
import path from "node:path";
import {
  ethers, abi, PROJECT, A, HOOK_ABI, LEDGER_ABI, ERC20_ABI, POOL_MANAGER_ABI, T_POOL_KEY,
} from "./programmable.mjs";

const fail = (msg) => { console.error("\nSTOP: " + msg); process.exit(1); };
const recPath = process.argv[2] || path.join(PROJECT, "web", "deployments", "1.fork.json");
const rec = JSON.parse(fs.readFileSync(recPath, "utf8"));
if (rec.mode !== "fork") fail("this rehearsal only runs against a fork record (mode " + rec.mode + ")");
const RPC = process.env.RPC_URL || "http://127.0.0.1:8557";
// cacheTimeout -1: ethers caches identical reads for 250 ms; anvil mines faster than that and nonces would come back stale
const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: ethers.Network.from(1), cacheTimeout: -1 });
const host = new URL(RPC).hostname;
if (!["127.0.0.1", "localhost", "::1"].includes(host)) fail("local anvil only, not " + host);
const client = String(await provider.send("web3_clientVersion", []).catch(() => ""));
if (!/anvil/i.test(client)) fail("not an anvil node: " + client);

const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const anvilWallet = (i) => ethers.HDNodeWallet.fromPhrase(ANVIL_MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).connect(provider);
const buyer = anvilWallet(1), stranger = anvilWallet(2);
await provider.send("anvil_setBalance", [buyer.address, ethers.toQuantity(ethers.parseEther("100"))]);
await provider.send("anvil_setBalance", [stranger.address, ethers.toQuantity(ethers.parseEther("1"))]);

const UR_ABI = ["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable", "function msgSender() view returns (address)"];
const PERMIT2_ABI = ["function approve(address token, address spender, uint160 amount, uint48 expiration)"];
const HARVESTER_ABI = JSON.parse(fs.readFileSync(path.join(PROJECT, "out", "BrownieHarvester.sol", "BrownieHarvester.json"), "utf8")).abi;
const STAKING_ABI = ["function totalFunded() view returns (uint256)", "function BROWNIE() view returns (address)"];

const token = new ethers.Contract(rec.token, ERC20_ABI, provider);
const weth = new ethers.Contract(A.WETH, ERC20_ABI, provider);
const usdc = new ethers.Contract(A.USDC, ERC20_ABI, provider);
const sugar = new ethers.Contract(rec.sugar, ERC20_ABI, provider);
const hook = new ethers.Contract(rec.hook, HOOK_ABI, provider);
const ledger = new ethers.Contract(rec.ledger, LEDGER_ABI, provider);
const harvester = new ethers.Contract(rec.harvester, HARVESTER_ABI, provider);
const staking = new ethers.Contract(rec.staking, STAKING_ABI, provider);
const ur = new ethers.Contract(A.UNIVERSAL_ROUTER, UR_ABI, buyer);
const permit2 = new ethers.Contract(A.PERMIT2, PERMIT2_ABI, buyer);
const pm = new ethers.Contract(A.POOL_MANAGER, POOL_MANAGER_ABI, provider);

const poolKey = rec.poolKey;
const tokenIs0 = ethers.getAddress(poolKey.currency0) === ethers.getAddress(rec.token);
const fmt = (wei, d = 18, digits = 6) => Number(ethers.formatUnits(wei, d)).toFixed(digits);
const fmtUsdc = (a) => Number(ethers.formatUnits(a, 6)).toFixed(2);
const fmtTok = (a) => Math.round(Number(ethers.formatUnits(a, 18))).toLocaleString("en-US");

// Universal Router 2.1.1 encodings
const CMD_WRAP_ETH = "0b", CMD_V4_SWAP = "10";
const ACT_SWAP_EXACT_IN_SINGLE = "06", ACT_SETTLE = "0b", ACT_SETTLE_ALL = "0c", ACT_TAKE_ALL = "0f";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const OPEN_DELTA = 0n;
const T_EXACT_IN_SINGLE = `tuple(${T_POOL_KEY} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)`;
const deadline = async () => BigInt((await provider.getBlock("latest")).timestamp) + 600n;
// every trade is mined before the next is built, so the exact nonce is the "latest" count
const nonceOf = (w) => provider.getTransactionCount(w.address, "latest");

function swapEvent(rc) {
  for (const log of rc.logs) {
    if (ethers.getAddress(log.address) !== ethers.getAddress(rec.hook)) continue;
    try { const ev = hook.interface.parseLog(log); if (ev && ev.name === "FoundationSwap") return ev.args; } catch (_) { /* skip */ }
  }
  return null;
}
async function buyWithEth(ethIn, label) {
  // ETH -> WETH inside the router (WRAP_ETH to the router itself), then a v4 exact-in swap settled from the router's balance
  const swap = abi.encode([T_EXACT_IN_SINGLE], [{ poolKey, zeroForOne: !tokenIs0, amountIn: ethIn, amountOutMinimum: 0n, minHopPriceX36: 0n, hookData: "0x" }]);
  const settle = abi.encode(["address", "uint256", "bool"], [A.WETH, OPEN_DELTA, false]);
  const take = abi.encode(["address", "uint256"], [rec.token, 0n]);
  const v4 = abi.encode(["bytes", "bytes[]"], ["0x" + ACT_SWAP_EXACT_IN_SINGLE + ACT_SETTLE + ACT_TAKE_ALL, [swap, settle, take]]);
  const wrap = abi.encode(["address", "uint256"], [ADDRESS_THIS, ethIn]);
  const before = await token.balanceOf(buyer.address);
  const tx = await ur.execute("0x" + CMD_WRAP_ETH + CMD_V4_SWAP, [wrap, v4], await deadline(), { value: ethIn, gasLimit: 1_500_000, nonce: await nonceOf(buyer) });
  const rc = await tx.wait();
  if (rc.status !== 1) fail(label + " reverted");
  const got = (await token.balanceOf(buyer.address)) - before;
  const ev = swapEvent(rc);
  console.log(`${label.padEnd(26)} ${fmt(ethIn, 18, 2)} ETH in -> ${fmtTok(got)} BROWNIE | fee platform ${fmt(ev.platformQuote)} creator ${fmt(ev.creatorQuote)} WETH | gas ${rc.gasUsed}`);
  return { got, ev };
}
async function sellTokens(amount, label) {
  await (await new ethers.Contract(rec.token, ERC20_ABI, buyer).approve(A.PERMIT2, ethers.MaxUint256, { nonce: await nonceOf(buyer) })).wait();
  await (await permit2.approve(rec.token, A.UNIVERSAL_ROUTER, amount, Math.floor(Date.now() / 1000) + 86400 * 30, { nonce: await nonceOf(buyer) })).wait();
  const swap = abi.encode([T_EXACT_IN_SINGLE], [{ poolKey, zeroForOne: tokenIs0, amountIn: amount, amountOutMinimum: 0n, minHopPriceX36: 0n, hookData: "0x" }]);
  const settleAll = abi.encode(["address", "uint256"], [rec.token, amount]);
  const takeAll = abi.encode(["address", "uint256"], [A.WETH, 0n]);
  const v4 = abi.encode(["bytes", "bytes[]"], ["0x" + ACT_SWAP_EXACT_IN_SINGLE + ACT_SETTLE_ALL + ACT_TAKE_ALL, [swap, settleAll, takeAll]]);
  const before = await weth.balanceOf(buyer.address);
  const tx = await ur.execute("0x" + CMD_V4_SWAP, [v4], await deadline(), { gasLimit: 1_500_000, nonce: await nonceOf(buyer) });
  const rc = await tx.wait();
  if (rc.status !== 1) fail(label + " reverted");
  const got = (await weth.balanceOf(buyer.address)) - before;
  const ev = swapEvent(rc);
  console.log(`${label.padEnd(26)} ${fmtTok(amount)} BROWNIE in -> ${fmt(got)} WETH | fee platform ${fmt(ev.platformQuote)} creator ${fmt(ev.creatorQuote)} WETH | gas ${rc.gasUsed}`);
  return { got, ev };
}

// ---- the state before ----------------------------------------------------------------------------------------------------
console.log(`fork             ${RPC} (${client})`);
console.log(`coin             ${await token.name()} (${await token.symbol()}) ${rec.token}`);
console.log(`pool             ${poolKey.currency0} / ${poolKey.currency1}, token is currency${tokenIs0 ? "0" : "1"}`);
console.log(`buyer            ${buyer.address}  stranger ${stranger.address}`);
if (ethers.getAddress(await ledger.creator()) !== ethers.getAddress(rec.harvester)) fail("the ledger's creator is not the harvester");
if (ethers.getAddress(await staking.BROWNIE()) !== ethers.getAddress(rec.token)) fail("staking does not stake this token");
const main0 = await provider.getBalance(rec.mainWallet);
const funding0 = await usdc.balanceOf(rec.fundingWallet);
const totalFunded0 = await staking.totalFunded();
const sugarVault0 = await sugar.balanceOf(rec.teamVault);
const harvesterWeth0 = await weth.balanceOf(rec.harvester);
if (harvesterWeth0 !== 0n) fail("the harvester already holds WETH; the split arithmetic below assumes none");
console.log("");

// ---- trades --------------------------------------------------------------------------------------------------------------
const b1 = await buyWithEth(ethers.parseEther("0.01"), "buy 1 (inside the cap window)");
if (rec.walletCap) {
  const cap = (BigInt(rec.walletCap.bps) * 10n ** 27n) / 10000n;
  let refused = false, reason = "";
  try {
    await buyWithEth(ethers.parseEther("0.2"), "buy over the cap");
  } catch (e) { refused = true; reason = (e.shortMessage || e.message || "").slice(0, 80); }
  if (!refused) fail("a buy above the wallet cap went through inside the window");
  console.log(`${"cap check".padEnd(26)} a 0.2 ETH buy (more than ${fmtTok(cap)} BROWNIE) was refused inside the ${rec.walletCap.minutes}-minute window: ok`);
  await provider.send("evm_increaseTime", [rec.walletCap.minutes * 60 + 60]);
  await provider.send("evm_mine", []);
  console.log(`${"time".padEnd(26)} jumped ${rec.walletCap.minutes + 1} minutes ahead; the cap window is over`);
}
const b2 = await buyWithEth(ethers.parseEther("3"), "buy 2");
const held = await token.balanceOf(buyer.address);
const s1 = await sellTokens(held / 2n, "sell 1 (half the coins)");
const creatorFeeTotal = b1.ev.creatorQuote + b2.ev.creatorQuote + s1.ev.creatorQuote;
const platformFeeTotal = b1.ev.platformQuote + b2.ev.platformQuote + s1.ev.platformQuote;

// ---- the ledger ------------------------------------------------------------------------------------------------------------
const creatorReceived = await ledger.creatorReceived();
const platformReceived = await ledger.platformReceived();
if (creatorReceived !== creatorFeeTotal) fail(`ledger.creatorReceived ${creatorReceived} != the sum of the swap events ${creatorFeeTotal}`);
if (platformReceived !== platformFeeTotal) fail("ledger.platformReceived differs from the swap events");
const backing = await pm.balanceOf(rec.ledger, BigInt(A.WETH));
console.log("");
console.log(`ledger           creator fee accrued ${fmt(creatorReceived)} WETH, platform fee ${fmt(platformReceived)} WETH, backed by ${fmt(backing)} WETH of ERC-6909 credit in the PoolManager`);

const claimRc = await (await new ethers.Contract(rec.ledger, LEDGER_ABI, stranger).claimCreator({ gasLimit: 400_000, nonce: await nonceOf(stranger) })).wait();
if (claimRc.status !== 1) fail("claimCreator reverted");
const harvesterWeth = await weth.balanceOf(rec.harvester);
if (harvesterWeth !== creatorReceived) fail(`the harvester received ${harvesterWeth} WETH, expected ${creatorReceived}`);
console.log(`claimCreator     by a stranger: ${fmt(harvesterWeth)} WETH paid to the harvester ${rec.harvester} (gas ${claimRc.gasUsed})`);

// ---- the harvester -----------------------------------------------------------------------------------------------------------
const hClaimRc = await (await new ethers.Contract(rec.harvester, HARVESTER_ABI, stranger).claim({ gasLimit: 1_500_000, nonce: await nonceOf(stranger) })).wait();
if (hClaimRc.status !== 1) fail("harvester.claim reverted");
const names = ["Claimed", "Swapped", "SwapWaited", "MainPaid"];
for (const log of hClaimRc.logs) {
  if (ethers.getAddress(log.address) !== ethers.getAddress(rec.harvester)) continue;
  try {
    const ev = harvester.interface.parseLog(log);
    if (ev && names.includes(ev.name)) console.log(`  event ${ev.name.padEnd(10)} ${ev.args.map((a, i) => ev.fragment.inputs[i].name + "=" + (ev.fragment.inputs[i].type === "bytes" ? String(a).slice(0, 20) : String(a))).join(" ")}`);
  } catch (_) { /* skip */ }
}
const mainDelta = (await provider.getBalance(rec.mainWallet)) - main0;
const fundingDelta = (await usdc.balanceOf(rec.fundingWallet)) - funding0;
const totalFunded = await staking.totalFunded();
const sugarVault = await sugar.balanceOf(rec.teamVault);
const [mainOwed, pendingRest, totalMainPaid, totalStakersFunded, totalTeamFunded] = await Promise.all([harvester.mainOwed(), harvester.pendingRest(), harvester.totalMainPaid(), harvester.totalStakersFunded(), harvester.totalTeamFunded()]);

console.log("");
console.log("RESULT");
console.log(`  creator fee collected (WETH)        ${fmt(creatorReceived)}`);
console.log(`  ETH received by MAIN_WALLET         ${fmt(mainDelta)}   (${(Number(mainDelta * 10000n / creatorReceived) / 100).toFixed(2)}% of the fee)`);
console.log(`  USDC received by FUNDING_WALLET     ${fmtUsdc(fundingDelta)}`);
console.log(`  staking.totalFunded() (USDC)        ${fmtUsdc(totalFunded - totalFunded0)}`);
console.log(`  SUGAR in the TeamVault              ${fmtUsdc(sugarVault - sugarVault0)}`);
console.log(`  harvester: mainOwed ${fmt(mainOwed)} pendingRest ${fmt(pendingRest)} WETH, totalMainPaid ${fmt(totalMainPaid)} ETH, stakers ${fmtUsdc(totalStakersFunded)} team ${fmtUsdc(totalTeamFunded)} USDC`);

const expectMain = (creatorReceived * 3500n) / 10000n;
const problems = [];
if (mainDelta !== expectMain) problems.push(`main wallet got ${mainDelta}, expected exactly 35% = ${expectMain}`);
if (fundingDelta <= 0n) problems.push("the funding wallet received no dollars");
if (fundingDelta !== totalStakersFunded + totalTeamFunded) problems.push("funding wallet USDC != stakers + team legs");
if (totalFunded - totalFunded0 !== totalStakersFunded) problems.push("staking.totalFunded != the stakers leg");
if (sugarVault - sugarVault0 !== totalTeamFunded) problems.push("SUGAR in the vault != the team leg");
if (pendingRest !== 0n) problems.push(`WETH still waiting for a swap: ${pendingRest}`);
if (mainOwed !== 0n) problems.push("the main wallet is still owed WETH");
// about 60% of the fee, in dollars, within the harvester's 1% band of the pool's 30-minute average
const ethUsd = Number(fundingDelta) / 1e6 / (Number(creatorReceived - expectMain) / 1e18);
if (!(ethUsd > 500 && ethUsd < 20000)) problems.push("the USDC leg implies an absurd ETH price: " + ethUsd);
console.log(`  implied ETH price of the swap       $${ethUsd.toFixed(2)}`);
if (problems.length) fail(problems.join("\n      "));
console.log("\nREHEARSAL PASSED: 35% to the main wallet as ETH, the rest in dollars to the funding wallet through staking.fund and the SUGAR minter.");
