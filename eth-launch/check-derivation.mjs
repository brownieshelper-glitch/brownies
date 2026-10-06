// Proof that programmable.mjs encodes a Programmable Ethereum graph launch exactly: for every real launch recorded in
// programmable/graphs.json, fetch the transaction, take only its INPUTS (launch wallet, token salt, metadata, tick,
// fees, modules, hook applicant salt), rebuild the three init codes, the salts, the addresses, the graph commitment
// and the initializer calldata with OUR code, and compare with what the chain actually deployed.
//
//   node eth-launch/check-derivation.mjs                       (reads from https://ethereum-rpc.publicnode.com)
//   RPC_URL=http://127.0.0.1:8557 node eth-launch/check-derivation.mjs   (an anvil fork forwards old transactions)
//
// Read-only: eth_getTransactionByHash and eth_call. Exit code 1 if anything differs.
import fs from "node:fs";
import path from "node:path";
import {
  ethers, abi, HERE, A, NS, TOPOLOGY, ID_ENGINE, ID_TOKEN, ID_HOOK, ENGINE_ABI, HOOK_ABI, T_PARAMS_V3, T_RESULT_V2,
  loadBytecodes, deriveGraph, buildGraphCall, graphCommitment, launchId,
} from "./programmable.mjs";

const RPC = process.env.RPC_URL || "https://ethereum-rpc.publicnode.com";
const provider = new ethers.JsonRpcProvider(RPC, 1, { staticNetwork: true });
const dir = path.join(HERE, "programmable");
const routerIface = new ethers.Interface(JSON.parse(fs.readFileSync(path.join(dir, "router", "_abi.json"), "utf8")));
const factoryIface = new ethers.Interface(JSON.parse(fs.readFileSync(path.join(dir, "factory", "_abi.json"), "utf8")));
const engineIface = new ethers.Interface(ENGINE_ABI);
const ROUTE = "tuple(bytes32 routeNamespace,bytes32 routeNonce,bytes32 topologyHash,bytes32 graphCommitment,tuple(bytes32 targetIdHash,bytes32 applicantSalt,uint256 deploymentValue,uint256 initializerValue,bytes initCode,bytes initializerCalldata)[] targets,tuple(uint8 targetIndex,bytes32 targetIdHash,address account,bytes32 runtimeCodeHash)[] expectedOutputs,bytes32 expectedGraphDeploymentHash)";
const graphs = JSON.parse(fs.readFileSync(path.join(dir, "graphs.json"), "utf8"));
const bc = loadBytecodes();

// our hand-written fragments must be the verified ABI's fragments
const mine = engineIface.getFunction("initializeGraph"), theirs = factoryIface.getFunction("initializeGraph");
if (mine.selector !== theirs.selector) throw new Error("initializeGraph selector differs from the verified ABI");
if (mine.format("full") !== theirs.format("full")) throw new Error("initializeGraph signature differs from the verified ABI:\n" + mine.format("full") + "\n" + theirs.format("full"));

let checked = 0, failed = 0, skipped = 0;
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
for (const [txh, g] of Object.entries(graphs)) {
  const tx = await provider.send("eth_getTransactionByHash", [txh]);
  if (!tx) { console.log(txh.slice(0, 12), "not found on this RPC, skipped"); skipped++; continue; }
  const d = routerIface.parseTransaction({ data: tx.input, value: tx.value });
  if (!d || d.name !== "launchAndStampV1") { console.log(txh.slice(0, 12), "to", tx.to, "is not a launchAndStampV1 call (" + tx.input.slice(0, 10) + "), skipped"); skipped++; continue; }
  const [route] = abi.decode([ROUTE], d.args.routePayload);
  const [eng, tok, hk] = route.targets;
  const init = factoryIface.parseTransaction({ data: eng.initializerCalldata });
  const p = init.args.p;
  const launchWallet = d.args.permit.launchWallet;
  const want = g.targets.slice().sort((a, b) => a.idx - b.idx).map((t) => t.addr);

  // rebuild from inputs only; the launcher of a stamped launch is the router
  const params = {
    metadata: { name: p.metadata.name, symbol: p.metadata.symbol, description: p.metadata.description, imageURI: p.metadata.imageURI, website: p.metadata.website, socialData: p.metadata.socialData },
    quote: p.quote, quoteDecimals: Number(p.quoteDecimals), initialTick: Number(p.initialTick), creatorBuyFeeBps: Number(p.creatorBuyFeeBps), creatorSellFeeBps: Number(p.creatorSellFeeBps),
    additionalQuoteAmount: p.additionalQuoteAmount, initialBuyQuoteAmount: p.initialBuyQuoteAmount, initialBuyMinimumTokenAmount: p.initialBuyMinimumTokenAmount, deadline: p.deadline,
    tokenSalt: p.tokenSalt, hookSalt: p.hookSalt,
    modules: p.modules.map((m) => ({ factory: m.factory, factoryCodeHash: m.factoryCodeHash, moduleCodeHash: m.moduleCodeHash, descriptorHash: m.descriptorHash, configuration: m.configuration, creatorShareBps: Number(m.creatorShareBps) })),
  };
  const mined = deriveGraph(bc, { launcher: A.ROUTER, launchWallet, tokenSalt: p.tokenSalt, metadata: params.metadata, quote: p.quote, initialTick: params.initialTick, creatorBuyFeeBps: params.creatorBuyFeeBps, creatorSellFeeBps: params.creatorSellFeeBps, modules: params.modules });
  const given = deriveGraph(bc, { launcher: A.ROUTER, launchWallet, tokenSalt: p.tokenSalt, metadata: params.metadata, quote: p.quote, initialTick: params.initialTick, creatorBuyFeeBps: params.creatorBuyFeeBps, creatorSellFeeBps: params.creatorSellFeeBps, modules: params.modules, hookApplicantSalt: hk.applicantSalt });
  const call = buildGraphCall(given, { launcher: A.ROUTER, params, fundingPath: init.args.fundingPath, firstBuyWei: BigInt(eng.initializerValue) });

  const rows = [
    ["routeNonce", eq(given.routeNonce, route.routeNonce)],
    ["namespace/topology", eq(NS, route.routeNamespace) && eq(TOPOLOGY, route.topologyHash)],
    ["target ids", eq(eng.targetIdHash, ID_ENGINE) && eq(tok.targetIdHash, ID_TOKEN) && eq(hk.targetIdHash, ID_HOOK)],
    ["engine initCode", eq(ethers.keccak256(given.initCodes.engine), ethers.keccak256(eng.initCode))],
    ["token initCode", eq(ethers.keccak256(given.initCodes.token), ethers.keccak256(tok.initCode))],
    ["hook initCode", eq(ethers.keccak256(given.initCodes.hook), ethers.keccak256(hk.initCode))],
    ["engine address", eq(given.engine, want[0])],
    ["token address", eq(given.token, want[1])],
    ["hook address (their salt)", eq(given.hook, want[2])],
    ["hook salt mined by us == theirs", eq(mined.hookApplicantSalt, hk.applicantSalt) && eq(mined.hook, want[2])],
    ["initializeGraph calldata byte-for-byte", eq(call.initializer, eng.initializerCalldata)],
    ["graph commitment", eq(call.authorization.graphCommitment, route.graphCommitment)],
    ["expectedOutputs", route.expectedOutputs.every((o, i) => eq(o.account, want[i]))],
    ["launchId", eq(launchId(given.routeNonce, given.token), d.args.stampRequest.launchId)],
    ["poolKey == stamp request", eq(given.poolKey.currency0, d.args.stampRequest.poolKey.currency0) && eq(given.poolKey.currency1, d.args.stampRequest.poolKey.currency1) && eq(given.poolKey.hooks, d.args.stampRequest.poolKey.hooks) && Number(d.args.stampRequest.poolKey.tickSpacing) === 60 && Number(d.args.stampRequest.poolKey.fee) === 0],
  ];
  // live reads: the hook's ledger is CREATE(hook, 1), and the creator is the launch wallet
  try {
    const hook = new ethers.Contract(want[2], HOOK_ABI, provider);
    const [ledger, creator, poolId] = await Promise.all([hook.ledger(), hook.creator(), hook.poolId()]);
    rows.push(["ledger == CREATE(hook, 1)", eq(ledger, given.ledger)]);
    rows.push(["hook.creator == launch wallet", eq(creator, launchWallet)]);
    rows.push(["poolId", eq(poolId, given.poolId)]);
  } catch (e) { rows.push(["live hook reads", false, (e.shortMessage || e.message).slice(0, 120)]); }

  const bad = rows.filter((r) => !r[1]);
  checked++;
  if (bad.length) failed++;
  console.log(`${bad.length ? "FAIL" : "ok  "} ${txh.slice(0, 12)} block ${g.block} ${p.metadata.symbol.padEnd(8)} tick ${String(params.initialTick).padStart(7)} fees ${params.creatorBuyFeeBps}/${params.creatorSellFeeBps} modules ${params.modules.length} hook salt tries ${mined.hookTries}` + (bad.length ? "\n     differs: " + bad.map((r) => r[0] + (r[2] ? " (" + r[2] + ")" : "")).join(", ") : ""));
  if (checked === 1) {
    console.log("     engine", given.engine, "token", given.token, "hook", given.hook, "ledger", given.ledger);
  }
}
console.log(`\n${checked} real launches recomputed from their inputs, ${checked - failed} match in every field, ${skipped} skipped (not router launches)`);
if (failed || !checked) process.exit(1);
