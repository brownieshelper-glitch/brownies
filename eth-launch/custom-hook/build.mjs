// The pack input for Programmable's Custom Launch API (Ethereum, general hook profile 3.6.0) for OUR graph:
// BrownieLauncher + BrownieToken + BrownieHook, deployed by their Graph Factory and stamped by their 24-hour Router.
//
// What this does, offline, in a work directory of its own:
//   1. collects the exact Solidity sources the three contracts need (src/hook + the lib files they import),
//      copies them into the work directory at the same relative paths (the public repository must hold the same bytes
//      at the same paths at the commit named in the config: sources.txt lists them)
//   2. writes the Standard JSON input (solc 0.8.26, cancun, optimizer 200, via-IR, no metadata hash, no CBOR) and
//      compiles it with the exact solc build Programmable's server runs (0.8.26+commit.8a97fa7a)
//   3. writes one artifact per target in the shape their CLI reads, the runtime immutables of each target (every
//      compiler immutable named from the AST, nothing guessed), the build evidence and programmable-launch.config.json
//
// Their CLI (programmable-launch pack / validate / submit) does the rest: see pack.mjs.
//
//   node eth-launch/custom-hook/build.mjs --coin eth-launch/bundle/<coin>.json --out <workdir> --launch-wallet 0x..
//        --harvester 0x.. --owner 0x.. --nonce 0x<32 bytes> --tick <int24> --revision <40 hex git commit>
//        [--origin https://github.com/brownieshelper-glitch/brownies] [--image web/assets/logo-1024.png]
//        [--token-address 0x..  (second pass: the token's EIP-712 domain separator needs its own address)]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ethers, abi, A, PROJECT, TOKEN_SUPPLY } from "../programmable.mjs";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SOLC = process.env.SOLC_0_8_26 || (process.env.USERPROFILE || process.env.HOME || "") + "\\AppData\\Roaming\\svm\\0.8.26\\solc-0.8.26";
export const SOLC_BUILD = "0.8.26+commit.8a97fa7a";
export const GRAPH_FACTORY = "0xB012e4A8F2c5FC4E8E4faCA9D5Ad6FfF13FBA887"; // ProgrammableCreate2GraphDeployerV1: it runs the initializers
export const ROUTER_24H = "0xBE4bF6Ac8c6F012E1C8f25747A9fBccB2FDAC4C3"; // ProgrammableLaunchStampRouter24hV1: fresh 3.6 packs
export const PERMIT_AUTHORITY = "0x755509eA6e3F5Ec1aA2E797bb68f1B87DD8b886b";
export const PLATFORM_RECIPIENT_36 = "0xD88539d3c4C460136a733A3Fd60cf6BF269079da"; // the 30 bps of profile 3.6
export const NATIVE = "0x0000000000000000000000000000000000000000";
export const ENTRYPOINTS = ["src/hook/BrownieLauncher.sol", "src/hook/BrownieToken.sol", "src/hook/BrownieHook.sol"];
export const TARGET_IDS = { launcher: "launcher", token: "token", hook: "hook" };
export const ALL_PERMISSIONS = [
  "beforeInitialize", "afterInitialize", "beforeAddLiquidity", "afterAddLiquidity", "beforeRemoveLiquidity", "afterRemoveLiquidity",
  "beforeSwap", "afterSwap", "beforeDonate", "afterDonate", "beforeSwapReturnDelta", "afterSwapReturnDelta", "afterAddLiquidityReturnDelta", "afterRemoveLiquidityReturnDelta",
];

const sha256 = (buf) => "sha256:" + createHash("sha256").update(buf).digest("hex");
const utf8Compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// ---- sources ------------------------------------------------------------------------------------------------------------
export function readRemappings() {
  return fs.readFileSync(path.join(PROJECT, "remappings.txt"), "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return { prefix: l.slice(0, i), target: l.slice(i + 1) }; })
    .sort((a, b) => b.prefix.length - a.prefix.length);
}

function resolveImport(fromFile, spec, remappings) {
  if (spec.startsWith("./") || spec.startsWith("../")) return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  for (const r of remappings) if (spec.startsWith(r.prefix)) return path.posix.normalize(r.target + spec.slice(r.prefix.length));
  return path.posix.normalize(spec);
}

const IMPORT_RE = /^\s*import\s+(?:[^;]*?\sfrom\s+)?["']([^"']+)["']\s*;/gmu;

/// Every source the entrypoints need, keyed by its path relative to the project (what the public repository shows).
export function collectSources(entrypoints = ENTRYPOINTS) {
  const remappings = readRemappings();
  const out = new Map();
  const pending = [...entrypoints];
  while (pending.length) {
    const file = pending.shift();
    if (out.has(file)) continue;
    if (file.startsWith("../") || path.posix.isAbsolute(file)) throw new Error("unsafe source path " + file);
    const abs = path.join(PROJECT, ...file.split("/"));
    if (!fs.existsSync(abs)) throw new Error(`source ${file} is missing (run forge install?)`);
    const content = fs.readFileSync(abs, "utf8");
    if (content.includes("\r")) throw new Error(`source ${file} has CRLF line endings; the public repository and the pack must hold the same bytes (LF). Convert it first.`);
    out.set(file, content);
    for (const m of content.matchAll(IMPORT_RE)) {
      const imported = resolveImport(file, m[1], remappings);
      if (!out.has(imported) && !pending.includes(imported)) pending.push(imported);
    }
  }
  return { sources: new Map([...out.entries()].sort((a, b) => utf8Compare(a[0], b[0]))), remappings: remappings.map((r) => r.prefix + "=" + r.target) };
}

// ---- solc ---------------------------------------------------------------------------------------------------------------
export function solcVersion() {
  const r = spawnSync(SOLC, ["--version"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`solc not found at ${SOLC} (set SOLC_0_8_26): ${r.stderr || r.error}`);
  const m = r.stdout.match(/Version:\s*(\S+)/);
  if (!m || !m[1].startsWith(SOLC_BUILD)) throw new Error(`solc at ${SOLC} is ${m && m[1]}, Programmable needs ${SOLC_BUILD}`);
  return m[1];
}

export function standardJsonInput({ sources, remappings }) {
  return {
    language: "Solidity",
    sources: Object.fromEntries([...sources.entries()].map(([p, content]) => [p, { content }])),
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      viaIR: true,
      metadata: { bytecodeHash: "none", appendCBOR: false, useLiteralContent: true },
      libraries: {},
      remappings,
      outputSelection: {
        "*": { "*": ["abi", "metadata", "evm.bytecode.object", "evm.bytecode.linkReferences", "evm.deployedBytecode.object", "evm.deployedBytecode.linkReferences", "evm.deployedBytecode.immutableReferences"], "": ["ast"] },
      },
    },
  };
}

export function compile(inputBytes) {
  const r = spawnSync(SOLC, ["--standard-json"], { input: inputBytes, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error("solc failed: " + (r.stderr || r.error));
  const start = r.stdout.indexOf("{");
  const out = JSON.parse(r.stdout.slice(start));
  const errors = (out.errors || []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error("solc errors:\n" + errors.map((e) => e.formattedMessage).join("\n"));
  return out;
}

function immutableDeclarations(output) {
  const decl = new Map();
  const walk = (node) => {
    if (node === null || typeof node !== "object") return;
    if (node.nodeType === "VariableDeclaration" && node.mutability === "immutable" && Number.isSafeInteger(node.id)) {
      decl.set(String(node.id), { name: node.name, type: node.typeDescriptions?.typeString || "" });
    }
    for (const v of Object.values(node)) { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") walk(v); }
  };
  for (const s of Object.values(output.sources || {})) walk(s.ast);
  return decl;
}

const abiTypeOf = (typeString) => (typeString.startsWith("contract ") || typeString === "address payable" ? "address" : typeString);

/// Every compiler immutable of a contract, each with its value from `values` (a literal or { target }); nothing guessed.
function runtimeImmutables(output, compiled, values, label) {
  const decl = immutableDeclarations(output);
  const refs = compiled.evm.deployedBytecode.immutableReferences || {};
  return Object.keys(refs).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)).map((id) => {
    const d = decl.get(id);
    if (!d) throw new Error(`${label}: immutable ${id} has no AST declaration`);
    if (!(d.name in values)) throw new Error(`${label}: immutable ${d.name} (${d.type}) is not mapped; refusing to guess`);
    const v = values[d.name];
    const abiType = abiTypeOf(d.type);
    if (v && typeof v === "object" && "target" in v) { if (abiType !== "address") throw new Error(`${label}: ${d.name} is ${abiType}, not an address`); return { immutableId: id, abiType, target: v.target }; }
    return { immutableId: id, abiType, literal: literalFor(abiType, v) };
  });
}

function literalFor(abiType, v) {
  if (abiType === "address") return ethers.getAddress(v);
  if (abiType === "bool") return Boolean(v);
  if (/^bytes\d+$/.test(abiType)) return String(v).toLowerCase();
  return BigInt(v).toString();
}

/// solmate's ERC20: DOMAIN_SEPARATOR at birth = keccak(EIP712Domain(name, "1", chainId, token)).
export function domainSeparator(name, tokenAddress) {
  return ethers.keccak256(abi.encode(["bytes32", "bytes32", "bytes32", "uint256", "address"], [
    ethers.keccak256(ethers.toUtf8Bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
    ethers.keccak256(ethers.toUtf8Bytes(name)), ethers.keccak256(ethers.toUtf8Bytes("1")), 1, tokenAddress,
  ]));
}

// ---- the hook's constructor config (the same numbers as the direct path, hookpath.mjs) ----------------------------------
export const PROGRAMMABLE_TRADING_ROUTER = "0xd92A36B0000531EF3063dEd4De20A0783308446C"; // their Ethereum trading router: msgSender() like the Universal Router

/// The launch tax of a coin config: `launchTax: { buyBps, sellBps, blocks, wallet, devExempt }`. The project's fee on buys
/// and sells for the first `blocks` blocks, counting the block the pool opens in; then the normal fee. None when the
/// config has none. The walls are the hook constructor's: at most 30%, at most 50 blocks, never below the normal fee.
/// `wallet`: the plain address that receives the part of the launch tax above the normal fee (none: the harvester gets
/// it all). `devExempt`: the launch (dev) wallet's own buys pay the normal fee during the launch tax.
export function launchTaxOf(cfg) {
  const t = cfg.launchTax;
  if (!t || t.enabled === false) return { buyBps: 0, sellBps: 0, blocks: 0, wallet: null, devExempt: false };
  const buyBps = Number(t.buyBps), sellBps = Number(t.sellBps), blocks = Number(t.blocks);
  if (![buyBps, sellBps, blocks].every(Number.isInteger) || blocks < 1 || blocks > 50 || buyBps > 3000 || sellBps > 3000 || buyBps < Number(cfg.creatorBuyFeeBps) || sellBps < Number(cfg.creatorSellFeeBps)) {
    throw new Error("launchTax: buyBps and sellBps go from the normal fee up to 3000 (30%), blocks from 1 to 50");
  }
  return { buyBps, sellBps, blocks, wallet: t.wallet ? ethers.getAddress(t.wallet) : null, devExempt: Boolean(t.devExempt) };
}

export function hookConfig({ cfg, harvester, owner, launchWallet = null }) {
  const h = cfg.hook || {};
  const lt = launchTaxOf(cfg);
  if (lt.devExempt && !launchWallet) throw new Error("launchTax.devExempt needs the launch wallet");
  const capOn = Boolean(cfg.walletCap?.enabled);
  return {
    poolManager: A.POOL_MANAGER, token: { target: TARGET_IDS.token }, quote: NATIVE, harvester: ethers.getAddress(harvester),
    platformRecipient: ethers.getAddress(h.platformRecipient || PLATFORM_RECIPIENT_36), platformBps: String(h.platformBps ?? 30),
    launcher: { target: TARGET_IDS.launcher }, owner: ethers.getAddress(owner), firstModule: NATIVE,
    baseBuyBps: String(cfg.creatorBuyFeeBps), baseSellBps: String(cfg.creatorSellFeeBps),
    maxBuyBps: String(h.maxBuyBps ?? 300), maxSellBps: String(h.maxSellBps ?? 300), maxModuleShareBps: String(h.maxModuleShareBps ?? 5000),
    capBps: String(capOn ? Number(cfg.walletCap.bps) : 10000), capSeconds: String(capOn ? Number(cfg.walletCap.minutes) * 60 : 1),
    capRouter: A.UNIVERSAL_ROUTER, capRouter2: ethers.getAddress(h.capRouter2 || PROGRAMMABLE_TRADING_ROUTER),
    moduleDelay: String(h.moduleDelaySeconds ?? 0), moduleGas: String(h.moduleGas ?? 150_000),
    launchBuyBps: String(lt.buyBps), launchSellBps: String(lt.sellBps), launchBlocks: String(lt.blocks),
    launchTaxWallet: lt.wallet || NATIVE, launchTaxFreeBuyer: lt.devExempt ? ethers.getAddress(launchWallet) : NATIVE,
    liquidityRouter: A.POSITION_MANAGER, // the owner's door to add liquidity (Uniswap's PositionManager)
  };
}

// ---- the build -----------------------------------------------------------------------------------------------------------
export function buildStampedPack({
  cfg, workdir, launchWallet, harvester, owner, nonce, initialTick, revision, origin = "https://github.com/brownieshelper-glitch/brownies",
  imagePath = path.join(PROJECT, "web", "assets", "logo-1024.png"), permitWindow = null, tokenAddress = null, extraChecks = [], log = console.log,
  initialBuyTokens = 0n, devBuyWei = 0n,
}) {
  initialBuyTokens = BigInt(initialBuyTokens); devBuyWei = BigInt(devBuyWei);
  if ((initialBuyTokens === 0n) !== (devBuyWei === 0n)) throw new Error("the initial buy needs both the coins (initialBuyTokens) and the ETH (devBuyWei), or neither");
  if (initialBuyTokens >= TOKEN_SUPPLY) throw new Error("initialBuyTokens must be below the supply");
  if (!/^0x[0-9a-f]{64}$/.test(nonce) || /^0x0{64}$/.test(nonce)) throw new Error("nonce must be a nonzero lowercase bytes32");
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("revision must be a lowercase 40-hex git commit");
  if (!cfg.website || !/^https:\/\//.test(cfg.website)) throw new Error("the coin config needs a public https website (website)");
  if (!cfg.x || !/^https:\/\/x\.com\/[A-Za-z0-9_]{1,64}$/.test(cfg.x)) throw new Error("the coin config needs the X profile as https://x.com/<handle> (x)");
  if (!cfg.imageURI || !/^(https|ipfs|ar):/.test(cfg.imageURI)) throw new Error("the coin config needs the public image URI (imageURI)");
  if (!fs.existsSync(imagePath)) throw new Error("image file missing: " + imagePath);
  const description = String(cfg.description || "").normalize("NFC").trim();
  if (Buffer.byteLength(description) < 20) throw new Error("description: at least 20 bytes");
  // a launch tax is disclosed in the coin's own description, in numbers: the rate and the number of blocks
  const tax = launchTaxOf(cfg);
  if (tax.blocks > 0 && !(description.includes(`${tax.buyBps / 100}%`) && description.includes(`${tax.sellBps / 100}%`) && new RegExp(`\\b${tax.blocks} blocks\\b`).test(description))) {
    throw new Error(`description: the launch tax must be written in it ("${tax.buyBps / 100}%", "${tax.sellBps / 100}%" and "${tax.blocks} blocks")`);
  }
  if (tax.wallet && !/tax wallet/i.test(description)) throw new Error("description: it must say that part of the launch tax goes to a tax wallet (the words \"tax wallet\")");
  if (tax.devExempt && !/launch wallet|dev wallet/i.test(description)) throw new Error("description: it must say that the launch wallet's buys do not pay the launch tax (the words \"launch wallet\")");
  const tick = Number(initialTick);
  if (!Number.isInteger(tick) || tick % 60 !== 0) throw new Error("initialTick must be a multiple of 60");

  const version = solcVersion();
  const { sources, remappings } = collectSources();
  fs.mkdirSync(workdir, { recursive: true });
  for (const d of ["standard-json", "artifacts", "evidence", "assets"]) fs.mkdirSync(path.join(workdir, d), { recursive: true });
  for (const [p, content] of sources) { const abs = path.join(workdir, ...p.split("/")); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content); }
  fs.copyFileSync(path.join(PROJECT, "remappings.txt"), path.join(workdir, "remappings.txt"));
  fs.writeFileSync(path.join(workdir, "sources.txt"), [...sources.keys()].join("\n") + "\n");

  const input = standardJsonInput({ sources, remappings });
  const inputBytes = Buffer.from(JSON.stringify(input) + "\n", "utf8");
  fs.writeFileSync(path.join(workdir, "standard-json", "hook-graph.json"), inputBytes);
  log(`solc             ${version}; ${sources.size} sources; compiling ...`);
  const output = compile(inputBytes);
  const pick = (file, name) => { const c = output.contracts?.[file]?.[name]; if (!c?.abi || !c?.metadata || !c?.evm?.bytecode?.object) throw new Error(`no output for ${file}:${name}`); return c; };
  const launcher = pick("src/hook/BrownieLauncher.sol", "BrownieLauncher");
  const token = pick("src/hook/BrownieToken.sol", "BrownieToken");
  const hook = pick("src/hook/BrownieHook.sol", "BrownieHook");

  const config = hookConfig({ cfg, harvester, owner, launchWallet });
  const capTokens = (TOKEN_SUPPLY * BigInt(config.capBps)) / 10000n;
  const immutables = {
    launcher: runtimeImmutables(output, launcher, { poolManager: A.POOL_MANAGER, INITIALIZER: GRAPH_FACTORY, INITIAL_TICK: String(tick), BUYER: ethers.getAddress(launchWallet), INITIAL_BUY_TOKENS: initialBuyTokens.toString() }, "launcher"),
    token: runtimeImmutables(output, token, { decimals: "18", INITIAL_CHAIN_ID: "1", INITIAL_DOMAIN_SEPARATOR: tokenAddress ? domainSeparator(cfg.name, tokenAddress) : ethers.ZeroHash }, "token"),
    hook: runtimeImmutables(output, hook, {
      poolManager: A.POOL_MANAGER, TOKEN: { target: TARGET_IDS.token }, QUOTE: NATIVE, QUOTE_ID: "0", QUOTE_IS_0: true, HARVESTER: config.harvester,
      PLATFORM_RECIPIENT: config.platformRecipient, PLATFORM_BPS: config.platformBps, LAUNCHER: { target: TARGET_IDS.launcher },
      BASE_BUY_BPS: config.baseBuyBps, BASE_SELL_BPS: config.baseSellBps, MAX_BUY_BPS: config.maxBuyBps, MAX_SELL_BPS: config.maxSellBps, MAX_MODULE_SHARE_BPS: config.maxModuleShareBps,
      CAP_TOKENS: capTokens.toString(), CAP_SECONDS: config.capSeconds, CAP_ROUTER: config.capRouter, CAP_ROUTER_2: config.capRouter2, MODULE_DELAY: config.moduleDelay, MODULE_GAS: config.moduleGas,
      LAUNCH_BUY_BPS: config.launchBuyBps, LAUNCH_SELL_BPS: config.launchSellBps, LAUNCH_BLOCKS: config.launchBlocks,
      LAUNCH_TAX_WALLET: config.launchTaxWallet, LAUNCH_TAX_FREE_BUYER: config.launchTaxFreeBuyer, LIQUIDITY_ROUTER: config.liquidityRouter,
    }, "hook"),
  };

  const artifacts = {};
  for (const [id, c] of [["launcher", launcher], ["token", token], ["hook", hook]]) {
    const value = { abi: c.abi, bytecode: c.evm.bytecode, deployedBytecode: c.evm.deployedBytecode, metadata: c.metadata };
    const bytes = Buffer.from(JSON.stringify(value) + "\n", "utf8");
    fs.writeFileSync(path.join(workdir, "artifacts", id + ".json"), bytes);
    artifacts[id] = sha256(bytes);
  }

  const ext = path.extname(imagePath).toLowerCase().replace(".jpeg", ".jpg") || ".png";
  const imageRel = "assets/token" + ext;
  fs.copyFileSync(imagePath, path.join(workdir, ...imageRel.split("/")));

  const checkedAt = new Date().toISOString();
  // no timestamp in the evidence: the pack hashes every file of the work directory (sources, standard JSON, artifacts,
  // evidence, image) into the route namespace, and the predicted addresses must not move between two packs
  const evidence = {
    schemaVersion: "brownies.custom-hook-build-evidence.v1", compiler: version, settings: input.settings,
    standardJsonSha256: sha256(inputBytes), sources: Object.fromEntries([...sources].map(([p, c]) => [p, sha256(Buffer.from(c, "utf8"))])), artifacts,
    targets: { launcher: "src/hook/BrownieLauncher.sol:BrownieLauncher", token: "src/hook/BrownieToken.sol:BrownieToken", hook: "src/hook/BrownieHook.sol:BrownieHook" },
    graphFactory: GRAPH_FACTORY, router: ROUTER_24H, initialTick: tick, hookConfig: config,
    launchTax: tax.blocks > 0
      ? { buyBps: tax.buyBps, sellBps: tax.sellBps, blocks: tax.blocks, note: "the project's fee for the first `blocks` blocks, counting the block the pool opens in (the launch block); immutable in the hook (LAUNCH_BUY_BPS, LAUNCH_SELL_BPS, LAUNCH_BLOCKS, LAUNCH_TAX_WALLET, LAUNCH_TAX_FREE_BUYER); the module is not asked; the base part (the normal fee) goes to the harvester as always and the part above it goes to `wallet`, a plain address of the project (claimLaunchTax() by anyone), or to the harvester when `wallet` is null; `exemptBuyer`, when set, is the launch wallet: its buys pay the normal fee instead, only while the wallet cap runs and counted against that cap, and its sells pay the launch tax like everyone's; from the block after the last one the base fee and the permanent ceilings apply; the platform fee stays its own leg on the gross throughout", wallet: tax.wallet, exemptBuyer: tax.devExempt ? ethers.getAddress(launchWallet) : null }
      : null,
    initialBuy: { buyer: ethers.getAddress(launchWallet), tokens: initialBuyTokens.toString(), maxEthWei: devBuyWei.toString(), note: "executed by the launcher inside the launch transaction with the ETH sent on the Router call; the unused part is refunded to the buyer in the same transaction" },
    note: "built by eth-launch/custom-hook/build.mjs from the exact sources listed in sources.txt",
  };
  fs.writeFileSync(path.join(workdir, "evidence", "build.json"), JSON.stringify(evidence, null, 2) + "\n");

  const now = Math.floor(Date.now() / 1000);
  const window = permitWindow || { validAfter: String(now - 120), deadline: String(now - 120 + 86_400 - 60) };
  const social = { v: 1, x: cfg.x, telegram: cfg.telegram || "" };
  const links = [{ kind: "website", uri: cfg.website }, { kind: "x", uri: cfg.x }];
  if (cfg.telegram && /^https:\/\//.test(cfg.telegram)) links.push({ kind: "telegram", uri: cfg.telegram });
  const packConfig = {
    schemaVersion: "programmable.launch-pack-config.v3",
    // no profileVersion: a fresh pack reads /v3/capabilities and takes the live profile (3.6.0) and its treasury policy
    launchWallet: ethers.getAddress(launchWallet),
    chainId: "1",
    nonce,
    source: { root: ".", paths: [...sources.keys()], sourceLineageNonce: "1", publicOrigin: { url: origin, revision } },
    compilationUnits: [{ compilationUnitId: "brownie-hook-graph", standardJson: "standard-json/hook-graph.json" }],
    targets: [
      {
        targetId: TARGET_IDS.launcher, compilationUnitId: "brownie-hook-graph", artifact: "artifacts/launcher.json", applicantSalt: "0x" + "01".repeat(32),
        constructorArguments: [A.POOL_MANAGER, GRAPH_FACTORY, String(tick), ethers.getAddress(launchWallet), initialBuyTokens.toString()],
        initializer: { function: "initializeGraph", arguments: [{ target: TARGET_IDS.token }, { target: TARGET_IDS.hook }] },
        deploymentValueWei: "0", initializerValueWei: devBuyWei.toString(), componentKind: "other", declaredHookPermissions: null, runtimeImmutables: immutables.launcher,
      },
      {
        targetId: TARGET_IDS.token, compilationUnitId: "brownie-hook-graph", artifact: "artifacts/token.json", applicantSalt: "0x" + "02".repeat(32),
        constructorArguments: [cfg.name, cfg.symbol, { target: TARGET_IDS.launcher }, description, cfg.website, cfg.imageURI, ethers.hexlify(ethers.toUtf8Bytes(JSON.stringify(social)))],
        initializer: null, deploymentValueWei: "0", initializerValueWei: "0", componentKind: "token", declaredHookPermissions: null, runtimeImmutables: immutables.token,
      },
      {
        targetId: TARGET_IDS.hook, compilationUnitId: "brownie-hook-graph", artifact: "artifacts/hook.json",
        applicantSalt: { mode: "deterministic-hook-permission-grind-v1", start: "0", maxAttempts: "1000000" },
        constructorArguments: [config],
        initializer: null, deploymentValueWei: "0", initializerValueWei: "0", componentKind: "hook", declaredHookPermissions: ALL_PERMISSIONS, runtimeImmutables: immutables.hook,
      },
    ],
    pool: { tokenTargetId: TARGET_IDS.token, hookTargetId: TARGET_IDS.hook, fee: 0, tickSpacing: 60, quoteCurrency: NATIVE },
    projectMetadata: {
      schemaVersion: "programmable.project-metadata-input.v1",
      token: { name: cfg.name, symbol: cfg.symbol },
      presentation: { description, image: { sourcePath: imageRel, uri: cfg.imageURI }, links },
    },
    launchProfile: {
      schemaVersion: "programmable.direct-native-hook-graph-profile-selection.v3",
      profileId: "programmable.direct-native-hook-graph.v1",
      profileRevision: 3,
      targetRoles: { tokenTargetId: TARGET_IDS.token, hookTargetId: TARGET_IDS.hook, initializerTargetId: TARGET_IDS.launcher, platformFeeBindingTargetId: TARGET_IDS.hook },
      liquidityModel: {
        schemaVersion: "programmable.direct-native-liquidity-model-intent.v1", model: "launch-seeded-concentrated-liquidity", declaredLaunchState: "assessment_required",
        liquidityTargetId: TARGET_IDS.launcher,
        assessment: { schemaVersion: "programmable.direct-native-liquidity-model-assessment.v1", status: "required", requestClaimsExecution: false, requiredVectorIds: ["liquidity.seeded.pool-active-liquidity", "liquidity.seeded.position-custody-and-withdrawal", "liquidity.seeded.buy-and-sell"] },
      },
      fundingMode: devBuyWei > 0n ? "wallet-transaction-value" : "none",
      accountingMode: "additive-platform-share",
      assessmentBase: "executed-gross-declared-quote",
      feeCurrency: "declared-quote-currency",
      claimMode: "immutable-payout-recipient",
      payoutRecipient: config.platformRecipient,
      applicantSelectedBuyHundredthsOfBip: String(Number(cfg.creatorBuyFeeBps) * 100),
      applicantSelectedSellHundredthsOfBip: String(Number(cfg.creatorSellFeeBps) * 100),
    },
    permitWindow: window,
    agentAttestation: { agentId: "brownies-eth-launch-custom-hook", checkedAt, checks: [{ checkId: "exact-solc-build", evidence: "evidence/build.json" }, ...extraChecks] },
  };
  fs.writeFileSync(path.join(workdir, "programmable-launch.config.json"), JSON.stringify(packConfig, null, 2) + "\n");
  log(`pack config      ${path.join(workdir, "programmable-launch.config.json")}  (profile 3.6.0, 3 targets, 24h router ${ROUTER_24H})`);
  return { packConfig, evidence, config, sources: [...sources.keys()], workdir, window, capTokens, initialBuyTokens, devBuyWei };
}

/// Second pass: the token's EIP-712 domain separator (a solmate immutable) needs the token's own address, which only
/// the first pack can predict. Only the config changes; the hashed files stay, so the addresses stay.
export function setTokenDomainSeparator(workdir, tokenName, tokenAddress) {
  const file = path.join(workdir, "programmable-launch.config.json");
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  const token = cfg.targets.find((t) => t.targetId === TARGET_IDS.token);
  const sep = domainSeparator(tokenName, ethers.getAddress(tokenAddress));
  let n = 0;
  for (const im of token.runtimeImmutables) if (im.abiType === "bytes32" && typeof im.literal === "string") { im.literal = sep; n++; }
  if (n !== 1) throw new Error(`expected exactly one bytes32 immutable on the token (the domain separator), found ${n}`);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  return sep;
}

// ---- command line --------------------------------------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const flag = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const need = (n) => { const v = flag(n); if (v === null) { console.error("missing " + n); process.exit(2); } return v; };
  const cfg = JSON.parse(fs.readFileSync(need("--coin"), "utf8"));
  const r = buildStampedPack({
    cfg, workdir: path.resolve(need("--out")), launchWallet: need("--launch-wallet"), harvester: need("--harvester"), owner: flag("--owner", need("--launch-wallet")),
    nonce: need("--nonce"), initialTick: need("--tick"), revision: need("--revision"), origin: flag("--origin") || undefined,
    imagePath: flag("--image") ? path.resolve(flag("--image")) : undefined, tokenAddress: flag("--token-address"),
    initialBuyTokens: BigInt(flag("--initial-buy-tokens", "0")), devBuyWei: BigInt(flag("--dev-buy-wei", "0")),
  });
  console.log(`sources          ${r.sources.length} files listed in sources.txt`);
}
