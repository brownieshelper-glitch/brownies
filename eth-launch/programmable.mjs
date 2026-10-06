// Programmable Foundation on Ethereum: everything needed to build an UNSTAMPED graph launch by hand.
//
// A Programmable launch on Ethereum is one call to the graph deployer (ProgrammableCreate2GraphDeployerV1), which
// CREATE2-deploys three contracts (engine proxy, token, hook) and then calls initializeGraph on the engine. The
// official page goes through the stamp router with a permit signed by Programmable's Safe; we call the graph deployer
// directly, so `authorizedLauncher` is OUR deployer wallet, and the coin is not "stamped" (Programmable indexes it by
// hand). Every address below is a pure function of (deployer wallet, launch wallet, token salt, metadata, tick, fees,
// modules), so the coin address is known before the harvester is deployed, and the harvester is the coin's creator.
//
// Checked against the real launches in programmable/graphs.json by check-derivation.mjs: same encodings give the
// same engine, token and hook addresses, the same graph commitment and the same initializer calldata, byte for byte.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT = path.resolve(HERE, "..");
const require = createRequire(path.join(PROJECT, "gateway", "package.json"));
export const { ethers } = require("ethers");

export const abi = ethers.AbiCoder.defaultAbiCoder();
export const h = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

// ---- Ethereum mainnet addresses (chain 1) ---------------------------------------------------------------------------
export const CHAIN_ID = 1n;
export const A = {
  IMPL: "0x487E8A196812fEC534f2D2514bfdc7c609EBAe35", // FoundationEthereumGraphLaunchV1, never called directly
  IMPL_CODE_HASH: "0x4013d721f43d3061e4593c5da8e1dfa64a943573240c7e247905c3a1986dbbec",
  GRAPH_DEPLOYER: "0xB012e4A8F2c5FC4E8E4faCA9D5Ad6FfF13FBA887", // ProgrammableCreate2GraphDeployerV1, no admin
  GRAPH_DEPLOYER_CODE_HASH: "0xd23692fae59331592048e71a96d4963e170ee56e449683dc9f7fa3f9470018b8",
  ROUTER: "0x8622DD5bAb44185f2A458ac90384Ac99248f8d56", // ProgrammableLaunchStampRouterV1, NOT used by us
  RELEASE_DIGEST: "0xfe914882521999a177d69b49f021a265b39c3ae27fb1f89c29ae826a0d7bde4a",
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  WETH_CODE_HASH: "0xd0a06b12ac47863b5c7be4185c2deaad1c61557033f56c7d4ea74429cbb25e23",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  V3_WETH_USDC_POOL: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640", // 0.05%, USDC is token0
  POOL_MANAGER: "0x000000000004444c5dc75cB358380D2e3dE08A90",
  POSITION_MANAGER: "0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e",
  UNIVERSAL_ROUTER: "0x4C82D1fBFe28C977cBB58D8C7FF8FCF9F70a2cCA",
  UNIVERSAL_ROUTER_CODE_HASH: "0x70c9ea2b275087aea3d57ae48e2d30e272a07ff5b6c7974bd47c21478b37face",
  PERMIT2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  PLATFORM_RECIPIENT: "0xD88539d3c4C460136a733A3Fd60cf6BF269079da",
};
// "Initial wallet buy limit", the only module published on Ethereum (programmable/api_chain1.json, catalog entry 0)
export const WALLET_CAP = {
  packageId: "0xd15566640c85edef5dd30a5523d7436ad5923d1a06ab03dd9ce883a97a9881c0",
  factory: "0x2960751d51a6559D630F9Fa9D94CD0011816d5D2",
  factoryCodeHash: "0x984c80e16fa4da55c7f1c69ca25a3fa4e60206aa1d67c73d5c0eb9849dabf39a",
  moduleCodeHash: "0x5be365d8785b43fc8e47d75b0006d59cca48ab93ebf67c91d3aa9414066564f6",
  descriptorHash: "0x1bd5aa9a4e6ca7771b3946b1ad429fdc7d301f5774e341b9ccf53e1cdeb1ac75",
};

// ---- Protocol constants (FoundationTypesV1, FoundationHookV2, the graph deployer) --------------------------------------
export const TOKEN_SUPPLY = 1_000_000_000n * 10n ** 18n;
export const PLATFORM_BPS = 30;
export const TICK_SPACING = 60;
export const LP_FEE = 0;
export const MIN_USABLE_TICK = -887220; // TickMath.minUsableTick(60)
export const MAX_USABLE_TICK = 887220;
export const HOOK_FLAGS = 8396n; // beforeInitialize | beforeSwap | afterSwap | beforeSwapReturnDelta | afterSwapReturnDelta
export const HOOK_FLAG_MASK = (1n << 14n) - 1n;

export const NS = h("programmable.module-foundation.ethereum-graph.v1"); // routeNamespace
export const TOPOLOGY = h("engine-token-hook.v1");
export const NONCE_ID = h("programmable.module-foundation.ethereum-graph-nonce.v1");
export const LAUNCH_ID = h("programmable.module-foundation.ethereum-launch-id.v1");
export const ABI_ID = h("programmable.module-foundation.v1");
export const ID_ENGINE = h("engine"), ID_TOKEN = h("token"), ID_HOOK = h("hook");
export const TARGET_SALT_TYPEHASH = h(
  "ProgrammableCreate2GraphTargetSaltV1(uint256 chainId,address factory,bytes32 routeNamespace,bytes32 routeNonce,bytes32 targetIdHash,bytes32 applicantSalt,address authorizedLauncher)"
);
export const GRAPH_TARGET_COMMITMENT_TYPEHASH = h(
  "ProgrammableCreate2GraphTargetCommitmentV1(uint256 targetIndex,bytes32 targetIdHash,bytes32 applicantSalt,uint256 deploymentValue,uint256 initializerValue,bytes32 initCodeHash,bytes32 initializerCalldataHash)"
);
export const GRAPH_COMMITMENT_TYPEHASH = h(
  "ProgrammableCreate2GraphCommitmentV1(uint256 chainId,address factory,bytes32 routeNamespace,bytes32 routeNonce,bytes32 topologyHash,address authorizedLauncher,uint256 totalValue,bytes32 targetCommitmentsHash)"
);

// ---- ABI fragments ---------------------------------------------------------------------------------------------------
export const T_METADATA = "tuple(string name,string symbol,string description,string imageURI,string website,bytes socialData)";
export const T_MODULES = "tuple(address factory,bytes32 factoryCodeHash,bytes32 moduleCodeHash,bytes32 descriptorHash,bytes configuration,uint16 creatorShareBps)[]";
export const T_PARAMS_V3 = `tuple(${T_METADATA} metadata,address quote,uint8 quoteDecimals,int24 initialTick,uint16 creatorBuyFeeBps,uint16 creatorSellFeeBps,uint128 additionalQuoteAmount,uint128 initialBuyQuoteAmount,uint128 initialBuyMinimumTokenAmount,uint64 deadline,bytes32 tokenSalt,bytes32 hookSalt,${T_MODULES} modules)`;
export const T_RESULT_V2 = "tuple(address token,address hook,address ledger,bytes32 poolId,address basePositionOwner,address creatorPositionOwner,address roundingInventoryRecipient,uint256 basePositionId,uint256 creatorPositionId,uint256 initialBuyTokenAmount,uint128 baseTokenPrincipal,uint128 baseTokenRounding,uint128 creatorQuotePrincipal,uint256 actualQuoteRefund)";
export const T_POOL_KEY = "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
export const T_AUTH = "tuple(bytes32 routeNamespace,bytes32 routeNonce,bytes32 topologyHash,bytes32 graphCommitment,address authorizedLauncher,uint256 totalValue)";
export const T_TARGET = "tuple(bytes32 targetIdHash,bytes32 applicantSalt,uint256 deploymentValue,uint256 initializerValue,bytes initCode,bytes initializerCalldata)";
export const T_PATH_KEY = "tuple(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)";

export const ENGINE_ABI = [
  `function initializeGraph(${T_PARAMS_V3} p, address token, address hook, bytes fundingPath) payable returns (${T_RESULT_V2} result)`,
  `function launchOf(address token) view returns (${T_RESULT_V2} result)`,
  "function LAUNCH_WALLET() view returns (address)",
  "function GRAPH_FACTORY() view returns (address)",
  "function initialized() view returns (bool)",
  "function implementation() view returns (address)",
  `event FoundationLaunchedV3(address indexed token,address indexed creator,bytes32 indexed poolId,address hook,address ledger,address quote,bytes32 metadataHash,bytes32 compositionHash,bytes32 custodyId,uint256 initialBuyQuoteAmount,${T_RESULT_V2} result)`,
];
export const GRAPH_DEPLOYER_ABI = [
  `function deployGraph(${T_AUTH} authorization, ${T_TARGET}[] targets) payable returns (address[] deployments, bytes32[] runtimeCodeHashes, bytes[] runtimeCodes, bytes32 graphDeploymentHash)`,
  `function computeGraphCommitment(${T_AUTH} authorization, ${T_TARGET}[] targets) view returns (bytes32 commitment, uint256 targetValueSum)`,
  `function predictTarget(${T_AUTH} authorization, ${T_TARGET} target) view returns (address)`,
  `function effectiveTargetSalt(${T_AUTH} authorization, bytes32 targetIdHash, bytes32 applicantSalt) view returns (bytes32)`,
  `function graphAuthorizationKey(${T_AUTH} authorization) view returns (bytes32)`,
  "function consumedGraphAuthorization(bytes32) view returns (bool)",
  "event ProgrammableCreate2GraphDeployed(bytes32 indexed routeNamespace,bytes32 indexed graphCommitment,bytes32 indexed graphDeploymentHash,bytes32 routeNonce,bytes32 topologyHash,address authorizedLauncher,uint256 totalValue,uint256 targetCount)",
  "event ProgrammableCreate2GraphTargetDeployed(bytes32 indexed graphCommitment,bytes32 indexed targetIdHash,address indexed deployment,uint256 targetIndex,bytes32 effectiveSalt,bytes32 initCodeHash,bytes32 initializerCalldataHash,bytes32 runtimeCodeHash,uint256 deploymentValue,uint256 initializerValue)",
  "error UnauthorizedLauncher(address caller,address authorizedLauncher)",
  "error GraphCommitmentMismatch(bytes32 actual,bytes32 reviewed)",
  "error DeploymentAddressAlreadyOccupied(uint256 targetIndex,address deployment)",
  "error DeploymentAddressMismatch(uint256 targetIndex,address actual,address predicted)",
  "error InitializerCallFailed(uint256 targetIndex,address deployment,uint256 returnDataLength,bytes boundedReturnData)",
  "error GraphAuthorizationAlreadyConsumed(bytes32 authorizationKey)",
];
export const HOOK_ABI = [
  "function creator() view returns (address)",
  "function token() view returns (address)",
  "function quote() view returns (address)",
  "function initializer() view returns (address)",
  "function ledger() view returns (address)",
  "function poolId() view returns (bytes32)",
  `function poolKey() view returns (${T_POOL_KEY})`,
  "function initialTick() view returns (int24)",
  "function creatorBuyFeeBps() view returns (uint16)",
  "function creatorSellFeeBps() view returns (uint16)",
  "function moduleCount() view returns (uint256)",
  "function compositionHash() view returns (bytes32)",
  "event FoundationSwap(bytes32 indexed poolId,address indexed router,bool buy,bool exactInput,uint256 grossQuote,uint256 platformQuote,uint256 creatorQuote,int128 coreAmount0,int128 coreAmount1)",
];
export const LEDGER_ABI = [
  "function creator() view returns (address)",
  "function hook() view returns (address)",
  "function quote() view returns (address)",
  "function platformReceived() view returns (uint256)",
  "function creatorReceived() view returns (uint256)",
  "function creatorCredited() view returns (uint256)",
  "function creatorClaimed() view returns (uint256)",
  "function creatorShareBps() view returns (uint16)",
  "function claimCreator() returns (uint256)",
  "function claimPlatform() returns (uint256)",
  "event QuoteClaimed(address indexed beneficiary,uint8 indexed budget,uint256 amount)",
];
export const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function deposit() payable",
  "function withdraw(uint256)",
];
export const V3_POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];
export const POOL_MANAGER_ABI = [
  "function extsload(bytes32 slot) view returns (bytes32)",
  "function balanceOf(address owner,uint256 id) view returns (uint256)",
];

// ---- Creation bytecodes (from the site bundle; the verified _creation.hex files are checked to start with them) -------
export function loadBytecodes() {
  const dir = path.join(HERE, "programmable");
  const site = JSON.parse(fs.readFileSync(path.join(dir, "site", "eth_bytecode.json"), "utf8")).contracts;
  const out = {};
  for (const [name, folder] of [["FoundationEthereumGraphProxyV1", "proxy1"], ["FoundationTokenV1", "token1"], ["FoundationHookV2", "hook1"]]) {
    const code = site[name].creationBytecode.toLowerCase();
    if (!code.startsWith("0x") || code.length < 100) throw new Error("bad creation bytecode for " + name);
    if (ethers.keccak256(code) !== site[name].creationCodeHash.toLowerCase()) throw new Error("creationCodeHash mismatch for " + name);
    const verified = fs.readFileSync(path.join(dir, folder, "_creation.hex"), "utf8").trim().toLowerCase();
    if (!verified.startsWith(code)) throw new Error("the verified deployment of " + name + " does not start with the site bytecode");
    out[name] = code;
  }
  return out;
}

// ---- Address algebra ---------------------------------------------------------------------------------------------------
export const createAddress = (deployer, nonce) => ethers.getCreateAddress({ from: deployer, nonce: Number(nonce) });

export function routeNonce(launchWallet, tokenSalt) {
  return ethers.keccak256(abi.encode(["bytes32", "uint256", "address", "bytes32", "address", "bytes32"], [NONCE_ID, CHAIN_ID, A.IMPL, A.RELEASE_DIGEST, launchWallet, tokenSalt]));
}
export function targetSalt(nonce, targetIdHash, applicantSalt, launcher) {
  return ethers.keccak256(abi.encode(
    ["bytes32", "uint256", "address", "bytes32", "bytes32", "bytes32", "bytes32", "address"],
    [TARGET_SALT_TYPEHASH, CHAIN_ID, A.GRAPH_DEPLOYER, NS, nonce, targetIdHash, applicantSalt, launcher]
  ));
}
export function launchId(nonce, token) {
  return ethers.keccak256(abi.encode(["bytes32", "bytes32", "address"], [LAUNCH_ID, nonce, token]));
}
export function engineInitCode(bc, launchWallet) {
  return ethers.concat([bc.FoundationEthereumGraphProxyV1, abi.encode(["address", "bytes32", "address"], [A.IMPL, A.IMPL_CODE_HASH, launchWallet])]);
}
export function tokenInitCode(bc, metadata, engine) {
  return ethers.concat([bc.FoundationTokenV1, abi.encode([T_METADATA, "address"], [metadata, engine])]);
}
export function hookInitCode(bc, { engine, token, quote, launchWallet, initialTick, creatorBuyFeeBps, creatorSellFeeBps, modules }) {
  return ethers.concat([bc.FoundationHookV2, abi.encode(
    ["address", "address", "address", "address", "address", "int24", "uint16", "uint16", T_MODULES],
    [A.POOL_MANAGER, engine, token, quote, launchWallet, initialTick, creatorBuyFeeBps, creatorSellFeeBps, modules]
  )]);
}
export function poolKeyFor(token, quote, hook) {
  const quote0 = BigInt(quote) < BigInt(token);
  return { currency0: quote0 ? quote : token, currency1: quote0 ? token : quote, fee: LP_FEE, tickSpacing: TICK_SPACING, hooks: hook };
}
export const poolIdOf = (key) => ethers.keccak256(abi.encode([T_POOL_KEY], [key]));
export const poolStateSlot = (poolId) => ethers.keccak256(ethers.concat([poolId, ethers.zeroPadValue("0x06", 32)])); // StateLibrary.POOLS_SLOT = 6

/// Mine the hook's applicant salt: the address must carry exactly the v4 flags of FoundationHookV2 in its low 14 bits.
export function mineHookSalt(nonce, launcher, hookInitHash, start = 0n, limit = 4_000_000n) {
  for (let r = start; r < start + limit; r++) {
    const applicant = ethers.toBeHex(r, 32);
    const addr = ethers.getCreate2Address(A.GRAPH_DEPLOYER, targetSalt(nonce, ID_HOOK, applicant, launcher), hookInitHash);
    if ((BigInt(addr) & HOOK_FLAG_MASK) === HOOK_FLAGS) return { applicantSalt: applicant, hook: ethers.getAddress(addr), tries: Number(r - start) + 1 };
  }
  throw new Error("no hook salt found in " + limit + " tries");
}

/// The whole graph from its inputs. `launcher` is whoever will call deployGraph (us: the deployer wallet; the official
/// page: the stamp router). `launchWallet` is the coin's creator (us: the harvester).
export function deriveGraph(bc, { launcher, launchWallet, tokenSalt, metadata, quote, initialTick, creatorBuyFeeBps, creatorSellFeeBps, modules, hookApplicantSalt }) {
  const nonce = routeNonce(launchWallet, tokenSalt);
  const engInit = engineInitCode(bc, launchWallet);
  const engine = ethers.getAddress(ethers.getCreate2Address(A.GRAPH_DEPLOYER, targetSalt(nonce, ID_ENGINE, ethers.ZeroHash, launcher), ethers.keccak256(engInit)));
  const tokInit = tokenInitCode(bc, metadata, engine);
  const token = ethers.getAddress(ethers.getCreate2Address(A.GRAPH_DEPLOYER, targetSalt(nonce, ID_TOKEN, ethers.ZeroHash, launcher), ethers.keccak256(tokInit)));
  const hkInit = hookInitCode(bc, { engine, token, quote, launchWallet, initialTick, creatorBuyFeeBps, creatorSellFeeBps, modules });
  const hkHash = ethers.keccak256(hkInit);
  let mined;
  if (hookApplicantSalt) {
    const hook = ethers.getAddress(ethers.getCreate2Address(A.GRAPH_DEPLOYER, targetSalt(nonce, ID_HOOK, hookApplicantSalt, launcher), hkHash));
    mined = { applicantSalt: hookApplicantSalt, hook, tries: 0 };
  } else mined = mineHookSalt(nonce, launcher, hkHash);
  const ledger = ethers.getAddress(createAddress(mined.hook, 1)); // `new FoundationLedgerV1` is the hook's first and only CREATE
  const poolKey = poolKeyFor(token, quote, mined.hook);
  return {
    routeNonce: nonce, engine, token, hook: mined.hook, hookApplicantSalt: mined.applicantSalt, hookTries: mined.tries, ledger,
    poolKey, poolId: poolIdOf(poolKey), launchId: launchId(nonce, token),
    initCodes: { engine: engInit, token: tokInit, hook: hkInit },
    tokenBelowWeth: BigInt(token) < BigInt(quote),
  };
}

/// Targets in graph order and the authorization with its commitment, exactly as the graph deployer recomputes them.
export function buildGraphCall(g, { launcher, params, fundingPath, firstBuyWei = 0n }) {
  const engineIface = new ethers.Interface(ENGINE_ABI);
  const initializer = engineIface.encodeFunctionData("initializeGraph", [params, g.token, g.hook, fundingPath]);
  const targets = [
    { targetIdHash: ID_ENGINE, applicantSalt: ethers.ZeroHash, deploymentValue: 0n, initializerValue: firstBuyWei, initCode: g.initCodes.engine, initializerCalldata: initializer },
    { targetIdHash: ID_TOKEN, applicantSalt: ethers.ZeroHash, deploymentValue: 0n, initializerValue: 0n, initCode: g.initCodes.token, initializerCalldata: "0x" },
    { targetIdHash: ID_HOOK, applicantSalt: g.hookApplicantSalt, deploymentValue: 0n, initializerValue: 0n, initCode: g.initCodes.hook, initializerCalldata: "0x" },
  ];
  const totalValue = targets.reduce((s, t) => s + t.deploymentValue + t.initializerValue, 0n);
  const authorization = { routeNamespace: NS, routeNonce: g.routeNonce, topologyHash: TOPOLOGY, graphCommitment: ethers.ZeroHash, authorizedLauncher: launcher, totalValue };
  authorization.graphCommitment = graphCommitment(authorization, targets);
  return { authorization, targets, initializer };
}

export function graphCommitment(auth, targets) {
  const commitments = targets.map((t, i) => ethers.keccak256(abi.encode(
    ["bytes32", "uint256", "bytes32", "bytes32", "uint256", "uint256", "bytes32", "bytes32"],
    [GRAPH_TARGET_COMMITMENT_TYPEHASH, i, t.targetIdHash, t.applicantSalt, t.deploymentValue, t.initializerValue, ethers.keccak256(t.initCode), ethers.keccak256(t.initializerCalldata)]
  )));
  return ethers.keccak256(abi.encode(
    ["bytes32", "uint256", "address", "bytes32", "bytes32", "bytes32", "address", "uint256", "bytes32"],
    [GRAPH_COMMITMENT_TYPEHASH, CHAIN_ID, A.GRAPH_DEPLOYER, auth.routeNamespace, auth.routeNonce, auth.topologyHash, auth.authorizedLauncher, auth.totalValue, ethers.keccak256(abi.encode(["bytes32[]"], [commitments]))]
  ));
}

/// `abi.encode(PathKey[] {})`: the engine demands a non-empty fundingPath, and with a WETH quote the path must be empty.
export const EMPTY_FUNDING_PATH = abi.encode([T_PATH_KEY + "[]"], [[]]);

// ---- Price and tick --------------------------------------------------------------------------------------------------
/// ETH in dollars from the v3 WETH/USDC 0.05% pool's current price (USDC is token0 with 6 decimals, WETH token1 with 18).
export async function ethUsdFromV3(provider) {
  const pool = new ethers.Contract(A.V3_WETH_USDC_POOL, V3_POOL_ABI, provider);
  const [t0, t1, s] = await Promise.all([pool.token0(), pool.token1(), pool.slot0()]);
  if (ethers.getAddress(t0) !== A.USDC || ethers.getAddress(t1) !== A.WETH) throw new Error("unexpected v3 pool tokens");
  const sqrt = BigInt(s.sqrtPriceX96);
  // price1per0 = sqrt^2 / 2^192 = raw WETH per raw USDC; ETH/USD = 1e12 / price1per0
  const e6 = (10n ** 12n * (1n << 192n) * 10n ** 6n) / (sqrt * sqrt);
  return Number(e6) / 1e6;
}

/// The 60-grid tick at which the whole supply is worth `mcapUsd` dollars. Price = token1 per token0, so the sign
/// flips with the sort order: a token below WETH is currency0 and gets a negative tick (about -201060 at $5,000).
export function tickForMcap(ethUsd, mcapUsd, tokenBelowWeth) {
  const ratio = (1e9 * ethUsd) / mcapUsd; // tokens per ETH at the start
  const raw = Math.log(ratio) / Math.log(1.0001);
  const tick = Math.round((tokenBelowWeth ? -raw : raw) / TICK_SPACING) * TICK_SPACING;
  if (!(tick > MIN_USABLE_TICK && tick < MAX_USABLE_TICK) || tick % TICK_SPACING !== 0) throw new Error("tick out of range: " + tick);
  return tick;
}
export function mcapAtTick(ethUsd, tick, tokenBelowWeth) {
  const p = Math.pow(1.0001, tick); // token1 per token0
  const tokenPriceEth = tokenBelowWeth ? p : 1 / p;
  return 1e9 * tokenPriceEth * ethUsd;
}

// ---- Metadata --------------------------------------------------------------------------------------------------------
export function buildMetadata(cfg, moduleOn) {
  const social = { v: 1 };
  if (cfg.x) social.x = String(cfg.x).startsWith("http") ? cfg.x : "https://x.com/" + String(cfg.x).replace(/^@/, "");
  if (cfg.telegram) social.telegram = String(cfg.telegram).startsWith("http") ? cfg.telegram : "https://t.me/" + String(cfg.telegram).replace(/^@/, "");
  social.foundation = { v: 1, packages: moduleOn ? [WALLET_CAP.packageId] : [] };
  const m = {
    name: cfg.name, symbol: cfg.symbol, description: cfg.description || "", imageURI: cfg.imageURI, website: cfg.website || "",
    socialData: ethers.hexlify(ethers.toUtf8Bytes(JSON.stringify(social))),
  };
  const len = (s) => ethers.toUtf8Bytes(s).length;
  if (!m.name || len(m.name) > 48) throw new Error("name must be 1..48 bytes");
  if (!m.symbol || len(m.symbol) > 12) throw new Error("symbol must be 1..12 bytes");
  if (len(m.description) > 280) throw new Error("description must be at most 280 bytes");
  if (!m.imageURI || len(m.imageURI) > 2048) throw new Error("imageURI must be 1..2048 bytes");
  if (len(m.website) > 2048) throw new Error("website must be at most 2048 bytes");
  if ((m.socialData.length - 2) / 2 > 1200) throw new Error("socialData must be at most 1200 bytes");
  return m;
}
export function buildModules(cfg) {
  const w = cfg.walletCap || {};
  if (!w.enabled) return [];
  const bps = Number(w.bps), minutes = Number(w.minutes);
  if (!(bps >= 1 && bps <= 10000 && Number.isInteger(bps))) throw new Error("walletCap.bps must be 1..10000");
  if (!(minutes >= 1 && Number.isInteger(minutes))) throw new Error("walletCap.minutes must be a positive integer");
  return [{
    factory: WALLET_CAP.factory, factoryCodeHash: WALLET_CAP.factoryCodeHash, moduleCodeHash: WALLET_CAP.moduleCodeHash, descriptorHash: WALLET_CAP.descriptorHash,
    configuration: abi.encode(["uint16", "uint32"], [bps, minutes]), creatorShareBps: 0,
  }];
}

// ---- Live checks ---------------------------------------------------------------------------------------------------------
/// The release we encode against must be the code on the chain we talk to.
export async function verifyInfrastructure(provider) {
  const checks = [
    ["implementation", A.IMPL, A.IMPL_CODE_HASH],
    ["graph deployer", A.GRAPH_DEPLOYER, A.GRAPH_DEPLOYER_CODE_HASH],
    ["WETH", A.WETH, A.WETH_CODE_HASH],
    ["universal router", A.UNIVERSAL_ROUTER, A.UNIVERSAL_ROUTER_CODE_HASH],
    ["wallet-cap factory", WALLET_CAP.factory, WALLET_CAP.factoryCodeHash],
  ];
  for (const [what, addr, want] of checks) {
    const got = ethers.keccak256(await provider.getCode(addr));
    if (got.toLowerCase() !== want.toLowerCase()) throw new Error(`${what} at ${addr} has code hash ${got}, expected ${want}`);
  }
  const disc = JSON.parse(fs.readFileSync(path.join(HERE, "programmable", "api_chain1.json"), "utf8"));
  const b = disc.binding;
  if (ethers.getAddress(b.factory.address) !== A.IMPL || b.factory.runtimeCodeHash.toLowerCase() !== A.IMPL_CODE_HASH) throw new Error("api_chain1.json names another implementation");
  if (ethers.getAddress(b.hookDeployer.address) !== A.GRAPH_DEPLOYER || b.hookDeployer.runtimeCodeHash.toLowerCase() !== A.GRAPH_DEPLOYER_CODE_HASH) throw new Error("api_chain1.json names another graph deployer");
  if (b.ethereumGraph.releaseDigest.toLowerCase() !== A.RELEASE_DIGEST) throw new Error("api_chain1.json names another release digest");
  const rel = disc.catalog.document.entries[0].release;
  for (const k of ["factory", "factoryCodeHash", "moduleCodeHash", "descriptorHash"]) {
    if (String(rel[k]).toLowerCase() !== WALLET_CAP[k].toLowerCase()) throw new Error("api_chain1.json wallet-cap " + k + " differs");
  }
  return true;
}
