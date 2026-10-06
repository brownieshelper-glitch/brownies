// Brownies on Ethereum: deploy the core, then launch BROWNIE on Programmable (Foundation, unstamped) with the
// harvester as the coin's creator. Four transactions from the deployer wallet, every address predicted first.
//
//   node eth-launch/launch.mjs plan                   predictions, encoded sizes, a simulation; NO transaction
//   node eth-launch/launch.mjs fork                   the real sequence against a LOCAL anvil fork (rehearse.sh runs it)
//   node eth-launch/launch.mjs broadcast --i-am-the-owner   the real thing; refuses unless LAUNCH_IT=1 too
//
// Environment:
//   RPC_URL          plan: any Ethereum RPC (default https://ethereum-rpc.publicnode.com)
//                    fork: a local anvil (default http://127.0.0.1:8557); anything else is refused
//                    broadcast: the owner's RPC, required
//   PRIVATE_KEY      broadcast only. In fork mode anvil's public account 0 is used and PRIVATE_KEY is ignored.
//                    In plan mode PRIVATE_KEY is optional (its address is used for the prediction) or set DEPLOYER=0x...
//   MAIN_WALLET      ADDRESS ONLY, the protocol's 40%            (fork default: anvil account 8)
//   FUNDING_WALLET   ADDRESS ONLY, the inference funding wallet   (fork default: anvil account 9)
//   TEAM_OWNER       optional, owner of the team vault and the harvester switch (default: the deployer)
//   LAUNCH_IT=1      broadcast only, together with --i-am-the-owner
//   CONFIG           optional path to the coin config (default eth-launch/brownies.json)
//
// Sequence: tx1 BrownieCore(token predicted) -> tx2 SkillRegistry(staking, vault) -> tx3 vault.setPayer(registry)
//           -> tx4 graphDeployer.deployGraph(engine, token, hook; launchWallet = harvester), value 0, no first buy.
// Output:   web/deployments/1.json (broadcast) or web/deployments/1.fork.json (fork), plus
//           eth-launch/launch-record-<timestamp>.json (launch-record-fork-... for a rehearsal). Addresses only. No key is ever printed.
import fs from "node:fs";
import path from "node:path";
import {
  ethers, abi, HERE, PROJECT, A, WALLET_CAP, TOKEN_SUPPLY, PLATFORM_BPS, ID_ENGINE, ID_TOKEN, ID_HOOK,
  ENGINE_ABI, GRAPH_DEPLOYER_ABI, HOOK_ABI, LEDGER_ABI, ERC20_ABI, POOL_MANAGER_ABI, T_PARAMS_V3,
  loadBytecodes, verifyInfrastructure, createAddress, routeNonce, targetSalt, engineInitCode, tokenInitCode,
  deriveGraph, buildGraphCall, EMPTY_FUNDING_PATH, ethUsdFromV3, tickForMcap, mcapAtTick, buildMetadata, buildModules,
  poolStateSlot,
} from "./programmable.mjs";

// ---- arguments and mode -------------------------------------------------------------------------------------------------
const args = process.argv.slice(2);
const MODE = args.find((a) => !a.startsWith("--"));
const FLAG_OWNER = args.includes("--i-am-the-owner");
if (!["plan", "fork", "broadcast"].includes(MODE)) {
  console.log("usage: node eth-launch/launch.mjs plan | fork | broadcast --i-am-the-owner");
  process.exit(2);
}
const fail = (msg) => { console.error("\nSTOP: " + msg); process.exit(1); };
const fmtEth = (wei) => ethers.formatEther(wei);
const bytesOf = (hex) => (hex.length - 2) / 2;
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");

if (MODE === "broadcast") {
  if (process.env.LAUNCH_IT !== "1" || !FLAG_OWNER) {
    fail("broadcast refused. It needs BOTH the environment LAUNCH_IT=1 AND the flag --i-am-the-owner, and the owner's word \"launch it\". Nothing was sent.");
  }
  if (!process.env.RPC_URL) fail("broadcast needs RPC_URL");
  if (!process.env.PRIVATE_KEY) fail("broadcast needs PRIVATE_KEY in the environment (never on the command line)");
  if (!process.env.MAIN_WALLET || !process.env.FUNDING_WALLET) fail("broadcast needs MAIN_WALLET and FUNDING_WALLET (addresses)");
}

// ---- config -------------------------------------------------------------------------------------------------------------
const cfgPath = process.env.CONFIG || path.join(HERE, "brownies.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
for (const k of ["creatorBuyFeeBps", "creatorSellFeeBps"]) {
  const v = Number(cfg[k]);
  if (!(Number.isInteger(v) && v >= 0 && v <= 1000 && v % 100 === 0)) fail(k + " must be 0..1000 in whole percents (multiples of 100)");
}
if (!(Number(cfg.startMcapUsd) > 0)) fail("startMcapUsd must be positive");
const MIN_POSITION = BigInt(cfg.minPosition || "10000000000000000000000");
const moduleOn = Boolean(cfg.walletCap && cfg.walletCap.enabled);
let metadata, modules;
try { metadata = buildMetadata(cfg, moduleOn); modules = buildModules(cfg); } catch (e) { fail(e.message); }

// ---- the chain ----------------------------------------------------------------------------------------------------------
const RPC = process.env.RPC_URL || (MODE === "fork" ? "http://127.0.0.1:8557" : "https://ethereum-rpc.publicnode.com");
// cacheTimeout -1: ethers caches identical reads for 250 ms, which on an instant-mining anvil returns stale nonces
const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: ethers.Network.from(1), cacheTimeout: -1 });
let client = "";
try { client = String(await provider.send("web3_clientVersion", [])); } catch (_) { /* some RPCs hide it */ }
const net = await provider.getNetwork();
if (net.chainId !== 1n) fail("this RPC is chain " + net.chainId + ", not Ethereum (1)");
if (MODE === "fork") {
  const host = new URL(RPC).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) fail("fork mode only talks to a local anvil, not " + host);
  if (!/anvil/i.test(client)) fail("fork mode needs an anvil node; this RPC reports \"" + client + "\"");
}
if (MODE === "broadcast" && /anvil|hardhat/i.test(client)) fail("broadcast mode against a local test node makes no sense; use fork mode");

// Anvil's well-known test accounts (mnemonic "test test ... junk"); public keys, fork mode only.
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const anvilWallet = (i) => ethers.HDNodeWallet.fromPhrase(ANVIL_MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`);

let signer = null, deployer;
if (MODE === "fork") {
  signer = anvilWallet(0).connect(provider);
  deployer = signer.address;
} else if (MODE === "broadcast") {
  signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  deployer = signer.address;
} else {
  deployer = process.env.DEPLOYER ? ethers.getAddress(process.env.DEPLOYER)
    : process.env.PRIVATE_KEY ? new ethers.Wallet(process.env.PRIVATE_KEY).address
    : anvilWallet(0).address;
}
// Rehearsal wallets: labelled addresses with no key (forge's makeAddr), because anvil's well-known accounts carry
// code on mainnet (7702 delegations) and the core demands plain wallets.
const labelled = (label) => ethers.getAddress("0x" + ethers.keccak256(ethers.toUtf8Bytes(label)).slice(26));
const mainWallet = ethers.getAddress(process.env.MAIN_WALLET || (MODE === "broadcast" ? "" : labelled("brownies rehearsal main wallet")));
const fundingWallet = ethers.getAddress(process.env.FUNDING_WALLET || (MODE === "broadcast" ? "" : labelled("brownies rehearsal funding wallet")));
const teamOwner = ethers.getAddress(process.env.TEAM_OWNER || deployer);
if (mainWallet === deployer) fail("MAIN_WALLET must not be the deployer wallet");
if ((await provider.getCode(mainWallet)) !== "0x") fail("MAIN_WALLET must be a plain wallet (it has code)");
if ((await provider.getCode(fundingWallet)) !== "0x") fail("FUNDING_WALLET must be a plain wallet (it has code)");

console.log(`mode             ${MODE}`);
console.log(`rpc              ${RPC}  (${client || "client unknown"}, chain ${net.chainId})`);
console.log(`deployer         ${deployer}  balance ${fmtEth(await provider.getBalance(deployer))} ETH`);
console.log(`main wallet      ${mainWallet}`);
console.log(`funding wallet   ${fundingWallet}`);
console.log(`team owner       ${teamOwner}`);

// ---- 1. Programmable's release on this chain -------------------------------------------------------------------------
try { await verifyInfrastructure(provider); } catch (e) { fail(e.message); }
console.log("programmable     implementation, graph deployer, WETH, universal router and wallet-cap factory code hashes match the release");
const bc = loadBytecodes();
const graphDeployer = new ethers.Contract(A.GRAPH_DEPLOYER, GRAPH_DEPLOYER_ABI, provider);

// ---- 2. Predictions ----------------------------------------------------------------------------------------------------
const nonce0 = await provider.getTransactionCount(deployer, "pending");
const core = ethers.getAddress(createAddress(deployer, nonce0));
// BrownieCore's children, by its nonce: 1 staking, 2 minter, 3 SUGAR, 4 team vault, 5 harvester (HARVESTER_NONCE)
const predictedChildren = Object.fromEntries(["staking", "minter", "sugar", "teamVault", "harvester"].map((k, i) => [k, ethers.getAddress(createAddress(core, i + 1))]));
const harvester = predictedChildren.harvester;
const registry = ethers.getAddress(createAddress(deployer, nonce0 + 1));
for (const [what, addr] of [["core", core], ["harvester", harvester], ["registry", registry]]) {
  if ((await provider.getCode(addr)) !== "0x") fail(`predicted ${what} ${addr} already has code; the deployer nonce is not what was expected`);
}
const ethUsd = await ethUsdFromV3(provider);

// The token salt from the seed; bump the seed if the address is taken or the route nonce was already used.
let tokenSalt, g, tries = 0, initialTick;
for (;;) {
  tokenSalt = ethers.keccak256(ethers.toUtf8Bytes(cfg.tokenSaltSeed + (tries ? " #" + tries : "")));
  // engine and token do not depend on the tick; the tick's sign depends on the token's sort order against WETH
  const nonce = routeNonce(harvester, tokenSalt);
  const engine = ethers.getCreate2Address(A.GRAPH_DEPLOYER, targetSalt(nonce, ID_ENGINE, ethers.ZeroHash, deployer), ethers.keccak256(engineInitCode(bc, harvester)));
  const token = ethers.getCreate2Address(A.GRAPH_DEPLOYER, targetSalt(nonce, ID_TOKEN, ethers.ZeroHash, deployer), ethers.keccak256(tokenInitCode(bc, metadata, engine)));
  const below = BigInt(token) < BigInt(A.WETH);
  initialTick = tickForMcap(ethUsd, Number(cfg.startMcapUsd), below);
  g = deriveGraph(bc, { launcher: deployer, launchWallet: harvester, tokenSalt, metadata, quote: A.WETH, initialTick, creatorBuyFeeBps: Number(cfg.creatorBuyFeeBps), creatorSellFeeBps: Number(cfg.creatorSellFeeBps), modules });
  if (g.engine !== ethers.getAddress(engine) || g.token !== ethers.getAddress(token)) fail("internal: two derivations disagree");
  const taken = (await Promise.all([g.engine, g.token, g.hook].map((a) => provider.getCode(a)))).some((c) => c !== "0x");
  const authKey = await graphDeployer.graphAuthorizationKey({ routeNamespace: ethers.ZeroHash, routeNonce: g.routeNonce, topologyHash: ethers.ZeroHash, graphCommitment: ethers.ZeroHash, authorizedLauncher: deployer, totalValue: 0 }).catch(() => null);
  const consumed = authKey ? await graphDeployer.consumedGraphAuthorization(authKey) : false;
  if (!taken && !consumed) break;
  if (++tries > 20) fail("no free token salt in 20 tries");
}

const latest = await provider.getBlock("latest");
const deadline = BigInt(latest.timestamp) + BigInt(cfg.deadlineSeconds || 3600);
const params = {
  metadata, quote: A.WETH, quoteDecimals: 18, initialTick, creatorBuyFeeBps: Number(cfg.creatorBuyFeeBps), creatorSellFeeBps: Number(cfg.creatorSellFeeBps),
  additionalQuoteAmount: 0n, initialBuyQuoteAmount: 0n, initialBuyMinimumTokenAmount: 0n, deadline, tokenSalt, hookSalt: g.hookApplicantSalt, modules,
};
const call = buildGraphCall(g, { launcher: deployer, params, fundingPath: EMPTY_FUNDING_PATH, firstBuyWei: 0n });
const deployGraphData = graphDeployer.interface.encodeFunctionData("deployGraph", [call.authorization, call.targets]);

// the graph deployer must agree with every offline number before anything is sent
const [onchainCommitment, valueSum] = await graphDeployer.computeGraphCommitment(call.authorization, call.targets);
if (onchainCommitment !== call.authorization.graphCommitment) fail("graph commitment differs from the graph deployer's: " + onchainCommitment);
if (valueSum !== 0n) fail("the graph carries value; it must not");
for (const [i, want] of [[0, g.engine], [1, g.token], [2, g.hook]]) {
  const p = ethers.getAddress(await graphDeployer.predictTarget(call.authorization, call.targets[i]));
  if (p !== want) fail(`the graph deployer predicts target ${i} at ${p}, we predicted ${want}`);
}

const coreArtifact = JSON.parse(fs.readFileSync(path.join(PROJECT, "out", "BrownieCore.sol", "BrownieCore.json"), "utf8"));
const registryArtifact = JSON.parse(fs.readFileSync(path.join(PROJECT, "out", "SkillRegistry.sol", "SkillRegistry.json"), "utf8"));
const harvesterAbi = JSON.parse(fs.readFileSync(path.join(PROJECT, "out", "BrownieHarvester.sol", "BrownieHarvester.json"), "utf8")).abi;
const vaultAbi = JSON.parse(fs.readFileSync(path.join(PROJECT, "out", "TeamVault.sol", "TeamVault.json"), "utf8")).abi;
const coreConfig = { token: g.token, weth: A.WETH, usdc: A.USDC, wethUsdcPool: A.V3_WETH_USDC_POOL, mainWallet, fundingWallet, teamOwner, minPosition: MIN_POSITION };
const coreFactory = new ethers.ContractFactory(coreArtifact.abi, coreArtifact.bytecode.object, signer || provider);
const coreDeployTx = await coreFactory.getDeployTransaction(coreConfig);
const registryFactory = new ethers.ContractFactory(registryArtifact.abi, registryArtifact.bytecode.object, signer || provider);

console.log("");
console.log(`coin             ${metadata.name} (${metadata.symbol})  fees ${params.creatorBuyFeeBps / 100}% buy / ${params.creatorSellFeeBps / 100}% sell to the creator, +${PLATFORM_BPS / 100}% Programmable`);
console.log(`wallet cap       ${moduleOn ? `${cfg.walletCap.bps / 100}% of supply per wallet for ${cfg.walletCap.minutes} minutes` : "off"}`);
console.log(`ETH price        $${ethUsd.toFixed(2)} (v3 WETH/USDC 0.05% pool)`);
console.log(`start            tick ${initialTick} (${g.tokenBelowWeth ? "token is currency0, below WETH" : "token is currency1, above WETH"}), about $${Math.round(mcapAtTick(ethUsd, initialTick, g.tokenBelowWeth)).toLocaleString("en-US")} market cap, target $${cfg.startMcapUsd}`);
console.log(`token salt       ${tokenSalt}  (seed "${cfg.tokenSaltSeed}"${tries ? ` #${tries}` : ""})`);
console.log(`hook salt        ${g.hookApplicantSalt}  (${g.hookTries} tries, flags ${(BigInt(g.hook) & 0x3fffn).toString()})`);
console.log(`deadline         ${new Date(Number(deadline) * 1000).toISOString()}`);
console.log("");
console.log(`deployer nonce   ${nonce0}`);
console.log(`core             ${core}   (tx1, CREATE at nonce ${nonce0})`);
console.log(`harvester        ${harvester}   (core's child 5 = the coin's creator and launch wallet)`);
console.log(`skill registry   ${registry}   (tx2, CREATE at nonce ${nonce0 + 1})`);
console.log(`engine           ${g.engine}   (graph target 0, CREATE2)`);
console.log(`TOKEN            ${g.token}   (graph target 1, CREATE2)`);
console.log(`hook             ${g.hook}   (graph target 2, CREATE2)`);
console.log(`ledger           ${g.ledger}   (CREATE(hook, 1))`);
console.log(`pool             ${g.poolKey.currency0} / ${g.poolKey.currency1} fee 0 spacing 60 hooks ${g.hook}`);
console.log(`poolId           ${g.poolId}`);
console.log(`launchId         ${g.launchId}   (unstamped: not registered in the router)`);
console.log(`route nonce      ${g.routeNonce}`);
console.log(`commitment       ${call.authorization.graphCommitment}   (matches graphDeployer.computeGraphCommitment)`);
console.log("");
const registryDeployTx = await registryFactory.getDeployTransaction(predictedChildren.staking, predictedChildren.teamVault);
console.log(`children         staking ${predictedChildren.staking} minter ${predictedChildren.minter} sugar ${predictedChildren.sugar} vault ${predictedChildren.teamVault}`);
console.log(`sizes            core init code ${bytesOf(coreDeployTx.data)} B | registry init code ${bytesOf(registryDeployTx.data)} B | deployGraph calldata ${bytesOf(deployGraphData)} B (engine ${bytesOf(g.initCodes.engine)}, token ${bytesOf(g.initCodes.token)}, hook ${bytesOf(g.initCodes.hook)}, initializer ${bytesOf(call.initializer)})`);

// ---- 3. Simulate the launch (the hook and the engine need no harvester code, so this works before tx1) -----------------
let simulated = false;
try {
  const ret = await provider.call({ from: deployer, to: A.GRAPH_DEPLOYER, data: deployGraphData, value: 0 });
  const [deployments] = graphDeployer.interface.decodeFunctionResult("deployGraph", ret);
  const got = deployments.map((a) => ethers.getAddress(a));
  if (got[0] !== g.engine || got[1] !== g.token || got[2] !== g.hook) fail("the simulated launch deployed elsewhere: " + got.join(" "));
  simulated = true;
  console.log("simulation       deployGraph ok: the three targets land at the predicted addresses");
} catch (e) {
  const msg = decodeError(e);
  if (MODE === "plan") console.log("simulation       not conclusive on this RPC: " + msg);
  else fail("the simulated launch reverted: " + msg);
}
if (MODE !== "plan") {
  const gas = await provider.estimateGas({ from: deployer, to: A.GRAPH_DEPLOYER, data: deployGraphData, value: 0 }).catch((e) => fail("estimateGas for deployGraph: " + decodeError(e)));
  console.log(`gas              deployGraph about ${gas.toString()}`);
}

if (MODE === "plan") {
  console.log("\nPLAN ONLY: no transaction was sent." + (simulated ? "" : " (The simulation needs an RPC that allows a heavy eth_call; the fork rehearsal runs it in full.)"));
  process.exit(0);
}

// ---- 4. The four transactions -------------------------------------------------------------------------------------------
if (MODE === "broadcast") {
  const bal = await provider.getBalance(deployer);
  if (bal < ethers.parseEther("0.2")) fail(`the deployer has ${fmtEth(bal)} ETH; the four transactions need gas for about 12M gas`);
  console.log("\nBROADCASTING TO ETHEREUM MAINNET");
}
const nonceNow = await provider.getTransactionCount(deployer, "pending");
if (nonceNow !== nonce0) fail(`the deployer nonce moved from ${nonce0} to ${nonceNow} since the prediction; run again`);
const startBlock = (await provider.getBlockNumber()) + 1;

console.log("\ntx1 BrownieCore ...");
const coreContract = await coreFactory.deploy(coreConfig, { nonce: nonce0 });
const coreRc = await coreContract.deploymentTransaction().wait();
if (coreRc.status !== 1) fail("BrownieCore reverted");
if (ethers.getAddress(coreRc.contractAddress) !== core) fail("core landed at " + coreRc.contractAddress + ", STOP");
const [staking, minter, sugar, teamVault, harvesterOnChain] = await Promise.all(["STAKING", "MINTER", "SUGAR", "TEAM_VAULT", "HARVESTER"].map((f) => coreContract[f]()));
if (ethers.getAddress(harvesterOnChain) !== harvester) fail("harvester landed at " + harvesterOnChain + ", STOP (the launch would name the wrong creator)");
const harvesterC = new ethers.Contract(harvester, harvesterAbi, provider);
if (ethers.getAddress(await harvesterC.TOKEN()) !== g.token) fail("the harvester holds another token address");
console.log(`    core ${core} gas ${coreRc.gasUsed}  staking ${staking} minter ${minter} sugar ${sugar} vault ${teamVault} harvester ${harvester}`);

console.log("tx2 SkillRegistry ...");
const registryContract = await registryFactory.deploy(staking, teamVault, { nonce: nonce0 + 1 });
const regRc = await registryContract.deploymentTransaction().wait();
if (regRc.status !== 1 || ethers.getAddress(regRc.contractAddress) !== registry) fail("registry landed at " + regRc.contractAddress);
console.log(`    registry ${registry} gas ${regRc.gasUsed}`);

console.log("tx3 TeamVault.setPayer(registry) ...");
const vault = new ethers.Contract(teamVault, vaultAbi, signer);
if (ethers.getAddress(await vault.owner()) !== deployer) fail("the deployer does not own the team vault (TEAM_OWNER is someone else); setPayer must be done by " + teamOwner);
const payRc = await (await vault.setPayer(registry, { nonce: nonce0 + 2 })).wait();
if (payRc.status !== 1 || ethers.getAddress(await vault.payer()) !== registry) fail("setPayer did not take");
console.log(`    payer = registry, gas ${payRc.gasUsed}`);

console.log("tx4 deployGraph (engine, BROWNIE, hook; creator = harvester) ...");
const gasEstimate = await provider.estimateGas({ from: deployer, to: A.GRAPH_DEPLOYER, data: deployGraphData, value: 0 }).catch((e) => fail("estimateGas: " + decodeError(e)));
const launchTx = await signer.sendTransaction({ to: A.GRAPH_DEPLOYER, data: deployGraphData, value: 0, gasLimit: (gasEstimate * 125n) / 100n, nonce: nonce0 + 3 });
const launchRc = await launchTx.wait();
if (launchRc.status !== 1) fail("deployGraph reverted: " + launchTx.hash);
const engineIface = new ethers.Interface(ENGINE_ABI);
const deployed = [];
let launched = null;
for (const log of launchRc.logs) {
  try {
    if (ethers.getAddress(log.address) === A.GRAPH_DEPLOYER) {
      const ev = graphDeployer.interface.parseLog(log);
      if (ev && ev.name === "ProgrammableCreate2GraphTargetDeployed") deployed[Number(ev.args.targetIndex)] = ethers.getAddress(ev.args.deployment);
    } else if (ethers.getAddress(log.address) === g.engine) {
      const ev = engineIface.parseLog(log);
      if (ev && ev.name === "FoundationLaunchedV3") launched = ev.args;
    }
  } catch (_) { /* other contracts' logs */ }
}
console.log(`    tx ${launchTx.hash} block ${launchRc.blockNumber} gas ${launchRc.gasUsed}`);

// ---- 5. Verify on chain ------------------------------------------------------------------------------------------------
const token = new ethers.Contract(g.token, ERC20_ABI, provider);
const hook = new ethers.Contract(g.hook, HOOK_ABI, provider);
const ledger = new ethers.Contract(g.ledger, LEDGER_ABI, provider);
const engine = new ethers.Contract(g.engine, ENGINE_ABI, provider);
const pm = new ethers.Contract(A.POOL_MANAGER, POOL_MANAGER_ABI, provider);
const checks = [];
const check = (name, ok, detail = "") => { checks.push([name, ok, detail]); console.log(`    ${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`); };
check("graph targets at the predicted addresses", deployed[0] === g.engine && deployed[1] === g.token && deployed[2] === g.hook, deployed.join(" "));
check("token has code", (await provider.getCode(g.token)) !== "0x");
const [name, symbol, supply, engineBal] = await Promise.all([token.name(), token.symbol(), token.totalSupply(), token.balanceOf(g.engine)]);
check("token name / symbol", name === metadata.name && symbol === metadata.symbol, `${name} (${symbol})`);
check("fixed supply 1B, none left in the engine", supply === TOKEN_SUPPLY && engineBal === 0n);
check("hook.creator == harvester", ethers.getAddress(await hook.creator()) === harvester);
check("hook.token / quote / initializer", ethers.getAddress(await hook.token()) === g.token && ethers.getAddress(await hook.quote()) === A.WETH && ethers.getAddress(await hook.initializer()) === g.engine);
check("hook.initialTick / fees", Number(await hook.initialTick()) === initialTick && Number(await hook.creatorBuyFeeBps()) === params.creatorBuyFeeBps && Number(await hook.creatorSellFeeBps()) === params.creatorSellFeeBps);
check("hook.moduleCount", Number(await hook.moduleCount()) === modules.length);
check("hook.ledger == predicted ledger", ethers.getAddress(await hook.ledger()) === g.ledger);
check("ledger.creator == harvester", ethers.getAddress(await ledger.creator()) === harvester);
check("ledger.creatorShareBps == 10000", Number(await ledger.creatorShareBps()) === 10000);
check("engine.LAUNCH_WALLET == harvester, initialized", ethers.getAddress(await engine.LAUNCH_WALLET()) === harvester && (await engine.initialized()) === true);
check("engine.launchOf(token).ledger == ledger", launched ? ethers.getAddress(launched.result.ledger) === g.ledger : false, launched ? `basePositionId ${launched.result.basePositionId} dust ${launched.result.baseTokenRounding}` : "no FoundationLaunchedV3 event");
const slot0 = BigInt(await pm.extsload(poolStateSlot(g.poolId)));
const sqrtPrice = slot0 & ((1n << 160n) - 1n);
let poolTick = Number((slot0 >> 160n) & 0xffffffn); if (poolTick >= 1 << 23) poolTick -= 1 << 24;
check("pool initialized at the start tick", sqrtPrice !== 0n && poolTick === initialTick, `sqrtPriceX96 ${sqrtPrice} tick ${poolTick}`);
check("harvester.TOKEN == token", ethers.getAddress(await harvesterC.TOKEN()) === g.token);
if (checks.some((c) => !c[1])) fail("a post-launch check failed; do not announce anything");

// ---- 6. The record ----------------------------------------------------------------------------------------------------
const record = {
  chainId: 1, mode: MODE, stamped: false, timestamp: new Date().toISOString(),
  token: g.token, staking, sugar, minter, harvester, teamVault, skillRegistry: registry, core,
  hook: g.hook, ledger: g.ledger, engine: g.engine, poolId: g.poolId,
  poolKey: { currency0: g.poolKey.currency0, currency1: g.poolKey.currency1, fee: 0, tickSpacing: 60, hooks: g.hook },
  startBlock, block: startBlock, launchBlock: launchRc.blockNumber, launchTx: launchTx.hash, coreTx: coreRc.hash,
  mainWallet, fundingWallet, teamOwner, deployer, minPosition: MIN_POSITION.toString(),
  initialTick, startMcapUsd: Number(cfg.startMcapUsd), ethUsdAtLaunch: Number(ethUsd.toFixed(2)),
  creatorBuyFeeBps: params.creatorBuyFeeBps, creatorSellFeeBps: params.creatorSellFeeBps, platformBps: PLATFORM_BPS,
  walletCap: moduleOn ? { bps: Number(cfg.walletCap.bps), minutes: Number(cfg.walletCap.minutes), factory: WALLET_CAP.factory } : null,
  tokenSalt, hookApplicantSalt: g.hookApplicantSalt, routeNonce: g.routeNonce, launchId: g.launchId, graphCommitment: call.authorization.graphCommitment,
  programmable: { implementation: A.IMPL, graphDeployer: A.GRAPH_DEPLOYER, releaseDigest: A.RELEASE_DIGEST, poolManager: A.POOL_MANAGER, universalRouter: A.UNIVERSAL_ROUTER },
};
const depDir = path.join(PROJECT, "web", "deployments");
fs.mkdirSync(depDir, { recursive: true });
const depFile = path.join(depDir, MODE === "broadcast" ? "1.json" : "1.fork.json");
fs.writeFileSync(depFile, JSON.stringify(record, null, 2) + "\n");
const recFile = path.join(HERE, `launch-record-${MODE === "fork" ? "fork-" : ""}${stamp()}.json`);
fs.writeFileSync(recFile, JSON.stringify(record, null, 2) + "\n");
console.log(`\nwritten          ${path.relative(PROJECT, depFile)} and ${path.relative(PROJECT, recFile)}`);
console.log(`LAUNCHED         ${metadata.symbol} ${g.token} on ${MODE === "fork" ? "the local fork" : "Ethereum"}, creator ${harvester}, block ${launchRc.blockNumber}`);
if (MODE === "broadcast") console.log("next: tell Programmable the launchId and token so they index the unstamped coin; start the keeper (ledger.claimCreator + harvester.claim); verify sources on Sourcify/Etherscan before announcing.");

function decodeError(e) {
  const data = e?.data || e?.info?.error?.data || e?.error?.data;
  if (typeof data === "string" && data.length >= 10) {
    for (const iface of [graphDeployer.interface, new ethers.Interface(ENGINE_ABI), new ethers.Interface(["error InvalidConfiguration()", "error InvalidSettlement()", "error InvalidInfrastructure()", "error DeadlineExpired()", "error InvalidMetadata()", "error InvalidInitialization()", "error WalletBuyLimitExceeded(address wallet,uint256 purchased,uint256 limit)"])]) {
      try { const d = iface.parseError(data); if (d) return d.name + "(" + d.args.map(String).join(", ") + ")"; } catch (_) { /* next */ }
    }
    return (e.shortMessage || e.message || "").slice(0, 200) + " data " + data.slice(0, 200);
  }
  return (e.shortMessage || e.message || String(e)).slice(0, 300);
}
