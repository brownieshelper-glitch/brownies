// The Router side of a stamped launch: what Programmable's API turns our packed request into, rebuilt here from the
// exact pinned sources of ProgrammableLaunchStampRouter24hV1 and ProgrammableCreate2GraphDeployerV1 so that
//   - a fork rehearsal can run the real Router + Graph Factory with our graph (a stand-in permit authority), and
//   - the wallet transaction the API hands us can be decoded and checked field by field before the owner's wallet
//     signs it (the permit, every target's init code, the predicted addresses, the pool key).
import { ethers, abi, A } from "../programmable.mjs";
import { ROUTER_24H, GRAPH_FACTORY, PERMIT_AUTHORITY, NATIVE } from "./build.mjs";

export { ROUTER_24H, GRAPH_FACTORY, PERMIT_AUTHORITY };
export const PERMIT_AUTHORITY_CODE_HASH = "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c";
export const KIND_CUSTOM_GRAPH = 1;
export const COMPONENT_KIND = { other: 0, token: 1, hook: 2 };
export const SCOPE_EXCLUSIVE = 1;

const h = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
export const TYPEHASH = {
  targetCommitment: h("ProgrammableCreate2GraphTargetCommitmentV1(uint256 targetIndex,bytes32 targetIdHash,bytes32 applicantSalt,uint256 deploymentValue,uint256 initializerValue,bytes32 initCodeHash,bytes32 initializerCalldataHash)"),
  graphCommitment: h("ProgrammableCreate2GraphCommitmentV1(uint256 chainId,address factory,bytes32 routeNamespace,bytes32 routeNonce,bytes32 topologyHash,address authorizedLauncher,uint256 totalValue,bytes32 targetCommitmentsHash)"),
  targetSalt: h("ProgrammableCreate2GraphTargetSaltV1(uint256 chainId,address factory,bytes32 routeNamespace,bytes32 routeNonce,bytes32 targetIdHash,bytes32 applicantSalt,address authorizedLauncher)"),
  accumulator: h("ProgrammableCreate2GraphDeploymentAccumulatorV1(bytes32 previous,uint256 targetIndex,bytes32 targetIdHash,address deployment,bytes32 effectiveSalt,bytes32 initCodeHash,bytes32 initializerCalldataHash,bytes32 runtimeCodeHash,uint256 deploymentValue,uint256 initializerValue)"),
  expectedOutput: h("ProgrammableExpectedGraphOutputV1(uint8 targetIndex,bytes32 targetIdHash,address account,bytes32 runtimeCodeHash)"),
  expectedResult: h("ProgrammableExpectedGraphResultV1(bytes32 expectedOutputsHash,bytes32 graphDeploymentHash)"),
  routeNamespace: h("ProgrammableApiCustomGraphRouteNamespaceV1(bytes32 sourceBundleSha256,address launchWallet,address router,address graphFactory)"),
};

export const T_TARGET = "tuple(bytes32 targetIdHash,bytes32 applicantSalt,uint256 deploymentValue,uint256 initializerValue,bytes initCode,bytes initializerCalldata)";
export const T_OUTPUT = "tuple(uint8 targetIndex,bytes32 targetIdHash,address account,bytes32 runtimeCodeHash)";
export const T_ROUTE = `tuple(bytes32 routeNamespace,bytes32 routeNonce,bytes32 topologyHash,bytes32 graphCommitment,${T_TARGET}[] targets,${T_OUTPUT}[] expectedOutputs,bytes32 expectedGraphDeploymentHash)`;
export const T_COMPONENT = "tuple(uint8 resultIndex,address account,bytes32 runtimeCodeHash,uint8 kind,uint8 scope)";
export const T_POOL_KEY = "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
export const T_STAMP = `tuple(bytes32 launchId,address token,bytes32 tokenRuntimeCodeHash,${T_POOL_KEY} poolKey,bytes32 hookRuntimeCodeHash,${T_COMPONENT}[] components)`;
export const T_PERMIT = "tuple(uint256 chainId,address router,address launchWallet,uint8 kind,bytes32 routePayloadHash,bytes32 expectedResultHash,bytes32 stampRequestHash,bytes32 nonce,uint64 validAfter,uint64 deadline,uint256 value)";
export const T_AUTH = "tuple(bytes32 routeNamespace,bytes32 routeNonce,bytes32 topologyHash,bytes32 graphCommitment,address authorizedLauncher,uint256 totalValue)";

export const ROUTER_ERRORS = [
  "error ComponentAlreadyStamped(address component, bytes32 launchId)", "error DuplicateOrUnsortedComponent(address previous, address current)",
  "error FactoryResultMismatch(uint8 field, uint256 index)", "error InvalidArrayLength(uint8 field, uint256 actual, uint256 expected)", "error InvalidBinding(uint8 field)",
  "error InvalidComponent(address component, bytes32 supplied, bytes32 actual)", "error InvalidPermitSignature()", "error LaunchAlreadyStamped(bytes32 launchId)",
  "error NonCanonicalRoutePayload()", "error NonceAlreadyUsed(address launchWallet, bytes32 nonce)", "error PermitAlreadyUsed(bytes32 permitDigest)",
  "error PermitOutsideValidityWindow(uint256 timestamp, uint256 validAfter, uint256 deadline)", "error PoolAlreadyInitialized(address poolManager, bytes32 poolId)",
  "error PoolAlreadyStamped(address poolManager, bytes32 poolId, bytes32 launchId)", "error ResidualLaunchValue(uint256 expected, uint256 actual)",
  "error UnauthorizedLaunchWallet(address caller, address launchWallet)", "error UnsupportedLaunchKind(uint8 kind)", "error RuntimeCodeHashDrift(address account)",
  "error DeploymentAddressAlreadyOccupied(uint256 targetIndex, address deployment)", "error DeploymentAddressMismatch(uint256 targetIndex, address actual, address predicted)",
  "error DeploymentRuntimeCodeMissing(uint256 targetIndex, address deployment)", "error DuplicateDeploymentAddress(uint256 firstIndex, uint256 duplicateIndex, address deployment)",
  "error DuplicateEffectiveSalt(uint256 firstIndex, uint256 duplicateIndex, bytes32 effectiveSalt)", "error DuplicateTargetId(uint256 firstIndex, uint256 duplicateIndex, bytes32 targetIdHash)",
  "error EmptyGraph()", "error GraphAuthorizationAlreadyConsumed(bytes32 authorizationKey)", "error GraphCommitmentMismatch(bytes32 actual, bytes32 reviewed)",
  "error GraphInputBytesLimitExceeded(uint256 actual, uint256 maximum)", "error GraphTargetLimitExceeded(uint256 actual, uint256 maximum)",
  "error GraphTargetValueSumMismatch(uint256 targetSum, uint256 authorized)", "error GraphValueMismatch(uint256 actual, uint256 authorized)",
  "error InitializerCallFailed(uint256 targetIndex, address deployment, uint256 returnDataLength, bytes returnData)", "error InvalidGraphAuthorization()",
  "error InvalidGraphTarget(uint256 targetIndex)", "error ReentrantGraphDeployment()", "error UnauthorizedLauncher(address caller, address authorizedLauncher)",
];
export const ROUTER_ABI = [
  `function launchAndStampV1(${T_PERMIT} permit, ${T_STAMP} stampRequest, bytes routePayload, bytes signature) payable returns (bytes32)`,
  `function permitDigest(${T_PERMIT} permit) view returns (bytes32)`,
  `function computeStampRequestHash(${T_STAMP} request) pure returns (bytes32)`,
  "function launchIdByToken(address) view returns (bytes32)", "function launchIdByPool(address, bytes32) view returns (bytes32)",
  "function launchIdByComponent(address) view returns (bytes32)", "function stampProof(address) view returns (bytes32 launchId, bytes32 stampHash)",
  "function PERMIT_AUTHORITY() view returns (address)", "function GRAPH_FACTORY() view returns (address)", "function POOL_MANAGER() view returns (address)",
  "event ProgrammableLaunchStampedV1(bytes32 indexed launchId, address indexed token, address indexed hook, address poolManager, bytes32 poolId, bytes32 stampHash)",
  "event ProgrammableLaunchRouteStampedV1(bytes32 indexed launchId, uint8 indexed kind, bytes32 indexed routePayloadHash, bytes32 expectedResultHash, bytes32 permitDigest)",
  "event ProgrammableComponentStampedV1(bytes32 indexed launchId, address indexed component, uint8 indexed kind, bytes32 runtimeCodeHash)",
  ...ROUTER_ERRORS,
];
export const FACTORY_ABI = [
  `function deployGraph(${T_AUTH} authorization, ${T_TARGET}[] targets) payable returns (address[] deployments, bytes32[] runtimeCodeHashes, bytes[] runtimeCodes, bytes32 graphDeploymentHash)`,
  `function computeGraphCommitment(${T_AUTH} authorization, ${T_TARGET}[] targets) view returns (bytes32 commitment, uint256 targetValueSum)`,
  `function effectiveTargetSalt(${T_AUTH} authorization, bytes32 targetIdHash, bytes32 applicantSalt) view returns (bytes32)`,
  "function consumedGraphAuthorization(bytes32) view returns (bool)",
  "event ProgrammableCreate2GraphDeployed(bytes32 indexed routeNamespace, bytes32 indexed graphCommitment, bytes32 indexed graphDeploymentHash, bytes32 routeNonce, bytes32 topologyHash, address authorizedLauncher, uint256 totalValue, uint256 targetCount)",
  "event ProgrammableCreate2GraphTargetDeployed(bytes32 indexed graphCommitment, bytes32 indexed targetIdHash, address indexed deployment, uint256 targetIndex, bytes32 effectiveSalt, bytes32 initCodeHash, bytes32 initializerCalldataHash, bytes32 runtimeCodeHash, uint256 deploymentValue, uint256 initializerValue)",
  ...ROUTER_ERRORS,
];
export const routerIface = new ethers.Interface(ROUTER_ABI);
export const factoryIface = new ethers.Interface(FACTORY_ABI);

// ---- the graph, from the pack --------------------------------------------------------------------------------------------
export function routeNamespace(sourceBundleSha256, launchWallet, router = ROUTER_24H, factory = GRAPH_FACTORY) {
  const hash = "0x" + sourceBundleSha256.replace(/^sha256:/, "");
  return ethers.keccak256(abi.encode(["bytes32", "bytes32", "address", "address", "address"], [TYPEHASH.routeNamespace, hash, launchWallet, router, factory]));
}
export function effectiveSalt(ns, nonce, targetIdHash, applicantSalt, router = ROUTER_24H, factory = GRAPH_FACTORY) {
  return ethers.keccak256(abi.encode(["bytes32", "uint256", "address", "bytes32", "bytes32", "bytes32", "bytes32", "address"], [TYPEHASH.targetSalt, 1, factory, ns, nonce, targetIdHash, applicantSalt, router]));
}

/// The ordered targets of the packed request, each checked against the receipt's predictions and recomputed here.
export function targetsFromPack({ launch, receipt, router = ROUTER_24H }) {
  const ns = routeNamespace(launch.graphBundle.sourceBundleSha256, launch.launchWallet, router);
  const nonce = launch.nonce;
  const out = launch.graphBundle.targets.map((t, index) => {
    const p = receipt.predictions.find((x) => x.targetId === t.targetId);
    if (!p) throw new Error("no prediction for target " + t.targetId);
    const initCode = ethers.concat([t.creationBytecode, p.resolvedConstructorArguments]);
    const initCodeHash = ethers.keccak256(initCode);
    if (initCodeHash !== p.initCodeHash) throw new Error(`${t.targetId}: init code hash differs from the receipt`);
    const salt = effectiveSalt(ns, nonce, p.targetIdHash, p.applicantSalt, router);
    if (salt !== p.effectiveSalt) throw new Error(`${t.targetId}: the effective salt recomputed here differs from the receipt (router ${router})`);
    const address = ethers.getCreate2Address(GRAPH_FACTORY, salt, initCodeHash);
    if (address !== ethers.getAddress(p.predictedAddress)) throw new Error(`${t.targetId}: CREATE2 address differs from the receipt`);
    const initializerCalldata = p.resolvedInitializerCalldata && p.resolvedInitializerCalldata !== "0x" ? p.resolvedInitializerCalldata : "0x";
    return {
      index, targetId: t.targetId, targetIdHash: p.targetIdHash, applicantSalt: p.applicantSalt, effectiveSalt: salt, initCode, initCodeHash, initializerCalldata,
      deploymentValue: BigInt(t.deploymentValueWei || 0), initializerValue: BigInt(t.initializerValueWei || 0),
      address, expectedRuntimeCodeHash: t.expectedRuntimeCodeHash, componentKind: t.componentKind,
    };
  });
  return { ns, nonce, targets: out };
}

export function graphCommitment({ ns, nonce, topologyHash, targets, router = ROUTER_24H, totalValue = 0n }) {
  const commitments = targets.map((t) => ethers.keccak256(abi.encode(
    ["bytes32", "uint256", "bytes32", "bytes32", "uint256", "uint256", "bytes32", "bytes32"],
    [TYPEHASH.targetCommitment, t.index, t.targetIdHash, t.applicantSalt, t.deploymentValue, t.initializerValue, t.initCodeHash, ethers.keccak256(t.initializerCalldata)],
  )));
  return ethers.keccak256(abi.encode(
    ["bytes32", "uint256", "address", "bytes32", "bytes32", "bytes32", "address", "uint256", "bytes32"],
    [TYPEHASH.graphCommitment, 1, GRAPH_FACTORY, ns, nonce, topologyHash, router, totalValue, ethers.keccak256(abi.encode(["bytes32[]"], [commitments]))],
  ));
}

/// The factory's accumulator over the deployments, from the runtime hashes we expect.
export function deploymentHash({ commitment, targets, runtimeHashes }) {
  let acc = commitment;
  for (const t of targets) {
    acc = ethers.keccak256(abi.encode(
      ["bytes32", "bytes32", "uint256", "bytes32", "address", "bytes32", "bytes32", "bytes32", "bytes32", "uint256", "uint256"],
      [TYPEHASH.accumulator, acc, t.index, t.targetIdHash, t.address, t.effectiveSalt, t.initCodeHash, ethers.keccak256(t.initializerCalldata), runtimeHashes[t.index], t.deploymentValue, t.initializerValue],
    ));
  }
  return acc;
}

export function expectedResultHash(outputs, graphDeploymentHash) {
  const hashes = outputs.map((o) => ethers.keccak256(abi.encode(["bytes32", "uint8", "bytes32", "address", "bytes32"], [TYPEHASH.expectedOutput, o.targetIndex, o.targetIdHash, o.account, o.runtimeCodeHash])));
  return ethers.keccak256(abi.encode(["bytes32", "bytes32", "bytes32"], [TYPEHASH.expectedResult, ethers.keccak256(ethers.concat(hashes)), graphDeploymentHash]));
}

/// Everything the Router call needs, from the targets and the runtime hashes (ours or the factory's dry run).
export function buildRoute({ ns, nonce, topologyHash, targets, runtimeHashes, router = ROUTER_24H, totalValue = 0n }) {
  const commitment = graphCommitment({ ns, nonce, topologyHash, targets, router, totalValue });
  const outputs = targets.map((t) => ({ targetIndex: t.index, targetIdHash: t.targetIdHash, account: t.address, runtimeCodeHash: runtimeHashes[t.index] }));
  const expectedGraphDeploymentHash = deploymentHash({ commitment, targets, runtimeHashes });
  const route = {
    routeNamespace: ns, routeNonce: nonce, topologyHash, graphCommitment: commitment,
    targets: targets.map((t) => ({ targetIdHash: t.targetIdHash, applicantSalt: t.applicantSalt, deploymentValue: t.deploymentValue, initializerValue: t.initializerValue, initCode: t.initCode, initializerCalldata: t.initializerCalldata })),
    expectedOutputs: outputs, expectedGraphDeploymentHash,
  };
  const payload = abi.encode([T_ROUTE], [route]);
  return { route, payload, payloadHash: ethers.keccak256(payload), resultHash: expectedResultHash(outputs, expectedGraphDeploymentHash), commitment, outputs };
}

export function buildStampRequest({ launchId, targets, runtimeHashes, poolKey }) {
  const token = targets.find((t) => t.componentKind === "token"), hook = targets.find((t) => t.componentKind === "hook");
  const components = targets.map((t) => ({ resultIndex: t.index, account: t.address, runtimeCodeHash: runtimeHashes[t.index], kind: COMPONENT_KIND[t.componentKind] ?? 0, scope: SCOPE_EXCLUSIVE }))
    .sort((a, b) => (BigInt(a.account) < BigInt(b.account) ? -1 : 1));
  return { launchId, token: token.address, tokenRuntimeCodeHash: runtimeHashes[token.index], poolKey, hookRuntimeCodeHash: runtimeHashes[hook.index], components };
}

export function encodeLaunch({ permit, stampRequest, payload, signature = "0x" }) {
  return routerIface.encodeFunctionData("launchAndStampV1", [permit, stampRequest, payload, signature]);
}

/// The API's wallet transaction, opened up: permit, stamp request, the route inside the payload, the signature.
export function decodeLaunch(calldata) {
  const d = routerIface.parseTransaction({ data: calldata });
  if (!d || d.name !== "launchAndStampV1") throw new Error("not a launchAndStampV1 call");
  const [permit, stampRequest, payload, signature] = d.args;
  const route = abi.decode([T_ROUTE], payload)[0];
  return { permit, stampRequest, payload, signature, route };
}

export function poolKeyOf(token, hook) {
  const key = { currency0: NATIVE, currency1: ethers.getAddress(token), fee: 0, tickSpacing: 60, hooks: ethers.getAddress(hook) };
  return { key, poolId: ethers.keccak256(abi.encode([T_POOL_KEY], [key])) };
}

// ---- the fork --------------------------------------------------------------------------------------------------------------
/// A permit authority that says yes to everything (isValidSignature returns its magic value for any input):
/// PUSH4 0x1626ba7e, PUSH1 0xe0, SHL, PUSH1 0, MSTORE, PUSH1 0x20, PUSH1 0, RETURN
export const STUB_AUTHORITY_CODE = "0x631626ba7e60e01b60005260206000f3";

/// On anvil only: the authority becomes the stub, and the Router's pinned authority code hash is rewritten to the
/// stub's, so the Router's own runtime check passes. The Router's logic is untouched.
export async function patchForkAuthority(provider, router = ROUTER_24H) {
  const stubHash = ethers.keccak256(STUB_AUTHORITY_CODE);
  await provider.send("anvil_setCode", [PERMIT_AUTHORITY, STUB_AUTHORITY_CODE]);
  const code = (await provider.getCode(router)).toLowerCase();
  const needle = PERMIT_AUTHORITY_CODE_HASH.slice(2).toLowerCase();
  const n = code.split(needle).length - 1;
  if (n === 0) throw new Error("the Router's code does not contain the permit authority code hash; cannot patch the fork");
  await provider.send("anvil_setCode", [router, code.split(needle).join(stubHash.slice(2))]);
  const check = await provider.getCode(PERMIT_AUTHORITY);
  if (ethers.keccak256(check) !== stubHash) throw new Error("the stub authority did not land");
  return { occurrences: n, stubHash };
}

/// The factory runs our graph once, from the Router's address, on a snapshot that is thrown away: the runtime hashes
/// and the deployment hash it reports are the truth the real call must match.
export async function dryRunGraph(provider, { ns, nonce, topologyHash, targets, router = ROUTER_24H, totalValue = 0n }) {
  totalValue = BigInt(totalValue);
  const commitment = graphCommitment({ ns, nonce, topologyHash, targets, router, totalValue });
  const auth = { routeNamespace: ns, routeNonce: nonce, topologyHash, graphCommitment: commitment, authorizedLauncher: router, totalValue };
  const factory = new ethers.Contract(GRAPH_FACTORY, FACTORY_ABI, provider);
  const [viewCommitment] = await factory.computeGraphCommitment(auth, targets.map((t) => ({ targetIdHash: t.targetIdHash, applicantSalt: t.applicantSalt, deploymentValue: t.deploymentValue, initializerValue: t.initializerValue, initCode: t.initCode, initializerCalldata: t.initializerCalldata })));
  if (viewCommitment !== commitment) throw new Error(`graph commitment: ours ${commitment} vs the factory's ${viewCommitment}`);
  const snap = await provider.send("evm_snapshot", []);
  let result;
  try {
    await provider.send("anvil_impersonateAccount", [router]);
    await provider.send("anvil_setBalance", [router, ethers.toQuantity(ethers.parseEther("1") + totalValue)]);
    const data = factoryIface.encodeFunctionData("deployGraph", [auth, targets.map((t) => ({ targetIdHash: t.targetIdHash, applicantSalt: t.applicantSalt, deploymentValue: t.deploymentValue, initializerValue: t.initializerValue, initCode: t.initCode, initializerCalldata: t.initializerCalldata }))]);
    const hash = await provider.send("eth_sendTransaction", [{ from: router, to: GRAPH_FACTORY, data, value: ethers.toQuantity(totalValue), gas: ethers.toQuantity(30_000_000) }]);
    let rc = null;
    for (let i = 0; i < 100 && !rc; i++) { rc = await provider.getTransactionReceipt(hash); if (!rc) await new Promise((r) => setTimeout(r, 300)); }
    if (!rc) throw new Error("dry run: no receipt");
    if (rc.status !== 1) {
      let reason = "no revert data";
      try { const t = await provider.send("debug_traceTransaction", [hash, { disableStorage: true, disableStack: true, disableMemory: true, enableReturnData: true }]); if (t?.returnValue) reason = decodeRouteError("0x" + String(t.returnValue).replace(/^0x/, "")); } catch (_) { /* none */ }
      throw new Error("dry run: deployGraph reverted: " + reason);
    }
    const runtimeHashes = [], deployments = [];
    let graphDeploymentHash = null;
    for (const l of rc.logs) {
      if (ethers.getAddress(l.address) !== GRAPH_FACTORY) continue;
      let ev = null; try { ev = factoryIface.parseLog(l); } catch (_) { continue; }
      if (ev?.name === "ProgrammableCreate2GraphTargetDeployed") { runtimeHashes[Number(ev.args.targetIndex)] = ev.args.runtimeCodeHash; deployments[Number(ev.args.targetIndex)] = ev.args.deployment; }
      if (ev?.name === "ProgrammableCreate2GraphDeployed") graphDeploymentHash = ev.args.graphDeploymentHash;
    }
    if (!graphDeploymentHash || runtimeHashes.length !== targets.length) throw new Error("dry run: events missing");
    for (const t of targets) if (ethers.getAddress(deployments[t.index]) !== t.address) throw new Error(`dry run: ${t.targetId} landed at ${deployments[t.index]}, predicted ${t.address}`);
    result = { runtimeHashes, deployments, graphDeploymentHash, commitment, gasUsed: rc.gasUsed };
  } finally {
    try { await provider.send("anvil_stopImpersonatingAccount", [router]); } catch (_) { /* none */ }
    if (!(await provider.send("evm_revert", [snap]))) throw new Error("anvil could not revert the dry-run snapshot");
  }
  return result;
}

export function decodeRouteError(data) {
  for (const iface of [routerIface, factoryIface]) {
    try { const d = iface.parseError(data); if (d) return d.name + "(" + d.args.map(String).join(", ") + ")"; } catch (_) { /* next */ }
  }
  return "revert data " + String(data).slice(0, 140);
}

export const UNIVERSAL_ROUTER = A.UNIVERSAL_ROUTER;
