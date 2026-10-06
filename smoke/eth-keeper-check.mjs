// The keeper against a local Ethereum fork where the coin was launched the real way (eth-launch/launch.mjs fork), the
// fees were traded and claimed once (rehearse-fees.mjs) and the four brownies are on the payroll. Checks that the
// gateway's keeper releases the vault, runs the harvester when a fresh fee arrives, and otherwise sends nothing.
//   RPC_URL=http://127.0.0.1:8559 node smoke/eth-keeper-check.mjs [web/deployments/1.fork.json]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Chain } from "../gateway/chain.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "..", "gateway", "package.json"));
const ethers = require("ethers");

const fail = (m) => { console.error("\nSTOP: " + m); process.exit(1); };
const rec = JSON.parse(fs.readFileSync(process.argv[2] || path.join(here, "..", "web", "deployments", "1.fork.json"), "utf8"));
if (rec.mode !== "fork") fail("fork records only");
const RPC = process.env.RPC_URL || "http://127.0.0.1:8559";
if (!["127.0.0.1", "localhost", "::1"].includes(new URL(RPC).hostname)) fail("local anvil only");
const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: ethers.Network.from(1), cacheTimeout: -1 });
const keeper = ethers.HDNodeWallet.fromPhrase("test test test test test test test test test test test junk", undefined, "m/44'/60'/0'/0/9").connect(provider);

const ERC20 = ["function balanceOf(address) view returns (uint256)"];
const sugar = new ethers.Contract(rec.sugar, ERC20, provider);
const harvester = new ethers.Contract(rec.harvester, ["function totalStakersFunded() view returns (uint256)", "function pendingRest() view returns (uint256)", "function mainOwed() view returns (uint256)"], provider);
const vault = new ethers.Contract(rec.teamVault, ["function helperCount() view returns (uint256)", "function lastRelease() view returns (uint256)", "function releasedTo(uint256) view returns (uint256)"], provider);

const sent = [];
const log = { log: (t) => { console.log("  " + t); if (/ in 0x/.test(t)) sent.push(t); }, warn: (t) => console.log("  WARN " + t) };
const chain = new Chain(
  { rpcUrl: RPC, chainId: 1, sugarAddress: rec.sugar, harvesterAddress: rec.harvester, ledgerAddress: rec.ledger, teamVaultAddress: rec.teamVault, keeperPrivateKey: keeper.privateKey, startBlock: rec.startBlock, claimMinEth: 0.05, keeperFloorEth: 0.01, releaseMinSugar: 0.5 },
  { lastBlock: null, recordActivation: () => false },
  { log, provider },
);
const fmt = (w) => Number(ethers.formatEther(w)).toFixed(6);
const fmtS = (a) => (Number(a) / 1e6).toFixed(6);
let checks = 0;
const ok = (cond, what) => { if (!cond) fail(what); checks++; console.log("  ok  " + what); };

console.log("state after the fee rehearsal");
const n = await vault.helperCount();
ok(n === 4n, "four brownies on the payroll");
ok((await chain.creatorUnclaimed()) === 0n, "the ledger owes the creator nothing (the rehearsal claimed it)");
const vault0 = await sugar.balanceOf(rec.teamVault);
ok(vault0 > 0n, `the vault holds ${fmtS(vault0)} SUGAR`);

console.log("\ntick 1: the first daily release is due, nothing else is");
const t1 = await chain.keeperTick();
ok(t1.claimedCreator === null, "no creator claim");
ok(t1.harvested === null, "no harvester claim");
ok(Boolean(t1.released?.tx), "vault.release sent");
const vault1 = await sugar.balanceOf(rec.teamVault);
const handed = vault0 - vault1;
ok(handed > 0n && handed <= vault0 / 30n && handed > vault0 / 30n - 4n, `one thirtieth released: ${fmtS(handed)} SUGAR`);
let paid = 0n;
for (let i = 0; i < 4; i++) paid += await vault.releasedTo(i);
ok(paid === handed, "every helper's share adds up to the release");

console.log("\ntick 2: a fresh 0.1 ETH fee reaches the harvester");
await (await keeper.sendTransaction({ to: rec.harvester, value: ethers.parseEther("0.1") })).wait();
const main0 = await provider.getBalance(rec.mainWallet);
const stakers0 = await harvester.totalStakersFunded();
const t2 = await chain.keeperTick();
ok(t2.claimedCreator === null, "no creator claim (ledger empty)");
ok(Boolean(t2.harvested?.tx), "harvester.claim sent");
ok(t2.released === null && t2.skipped.some((s) => /next release at/.test(s)), "vault not released twice in a day");
const mainDelta = (await provider.getBalance(rec.mainWallet)) - main0;
ok(mainDelta === ethers.parseEther("0.04"), `main wallet received exactly 40%: ${fmt(mainDelta)} ETH`);
ok((await harvester.pendingRest()) === 0n && (await harvester.mainOwed()) === 0n, "nothing left waiting in the harvester");
const stakersDelta = (await harvester.totalStakersFunded()) - stakers0;
ok(stakersDelta > 0n, `stakers funded with ${fmtS(stakersDelta)} USDC from the 60% swap`);

console.log("\ntick 3: nothing due");
const t3 = await chain.keeperTick();
ok(!t3.claimedCreator && !t3.harvested && !t3.released && t3.skipped.length === 3, "three duties, three skips, no transaction");

console.log("\nfigures for /api/protocol/stats");
const totals = await chain.onchainTotals();
ok(totals.programOn === true && totals.freshWei === "0" && totals.pendingRestWei === "0", "harvester figures read");
ok(totals.vaultActiveWeight === 4 && totals.vaultNextReleaseAt > 0, "vault figures read");

console.log(`\nKEEPER CHECK PASSED: ${checks} checks, ${sent.length} transactions sent by the keeper`);
