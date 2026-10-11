// The coins launched through Programmable on Ethereum, read straight from the chain. Every Programmable launch
// goes through its graph deployer, which emits ProgrammableCreate2GraphDeployed; the same transaction carries the
// coin's FoundationLaunchedV3 event (emitted by the new engine). So: the deployer's logs for the last day, then
// each transaction's receipt, then the coin's name and symbol with two eth_calls. Plain JSON-RPC over fetch, so
// the tests can answer it with a stub; ethers only decodes. (A topic-only eth_getLogs is refused by the public RPC,
// which is why the deployer's address is the anchor.) That is what Nib reads (recentLaunches, launchesBlock).
//
// The second half is for Caramel (helpers/caramel.mjs), the sales brownie, which needs more than names: the stamp
// router emits ProgrammableLaunchStampedV1 for every launch, and the launch transaction's input carries the coin's
// metadata (name, symbol, description, website, socials) inside the graph's initializeGraph call; the market side
// (trades, volume, liquidity, the socials DexScreener knows) comes from DexScreener's public API (GMGN blocks plain
// requests for Ethereum). Read-only: nothing here signs or sends anything. ABI fragments follow programmable-alerts/abi.mjs.
import { Interface, AbiCoder, getAddress, formatUnits, toUtf8String } from "ethers";

export const GRAPH_DEPLOYER = "0xB012e4A8F2c5FC4E8E4faCA9D5Ad6FfF13FBA887";
export const GRAPH_EVENT = "event ProgrammableCreate2GraphDeployed(bytes32 indexed routeNamespace, bytes32 indexed graphCommitment, bytes32 indexed graphDeploymentHash, bytes32 routeNonce, bytes32 topologyHash, address authorizedLauncher, uint256 totalValue, uint256 targetCount)";
export const LAUNCH_EVENT = "event FoundationLaunchedV3(address indexed token, address indexed creator, bytes32 indexed poolId, address hook, address ledger, address quote, bytes32 metadataHash, bytes32 compositionHash, bytes32 custodyId, uint256 initialBuyQuoteAmount, (address token, address hook, address ledger, bytes32 poolId, address basePositionOwner, address creatorPositionOwner, address roundingInventoryRecipient, uint256 basePositionId, uint256 creatorPositionId, uint256 initialBuyTokenAmount, uint128 baseTokenPrincipal, uint128 baseTokenRounding, uint128 creatorQuotePrincipal, uint256 actualQuoteRefund) result)";
export const iface = new Interface([GRAPH_EVENT, LAUNCH_EVENT]);
export const GRAPH_TOPIC = iface.getEvent("ProgrammableCreate2GraphDeployed").topicHash;
export const LAUNCH_TOPIC = iface.getEvent("FoundationLaunchedV3").topicHash;
const BLOCKS_PER_HOUR = 300; // 12-second blocks
const CHUNK = 2000; // blocks per eth_getLogs, what the public RPC accepts
const coder = AbiCoder.defaultAbiCoder();
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
// the quote tokens whose amounts can be printed; anything else is shown without a unit
const QUOTES = { [WETH]: { unit: "ETH", decimals: 18 }, [USDC]: { unit: "USDC", decimals: 6 } };
// the public RPCs that answer a day of eth_getLogs on one address (publicnode calls that an archive request)
export const DEFAULT_RPCS = ["https://rpc.mevblocker.io", "https://ethereum-rpc.publicnode.com"];

async function rpc(fetch, url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message || "rpc error"}`);
  return j.result;
}

/// A string returned by name() or symbol(); "" when the coin does not answer or returns something odd.
function decodeString(hex) {
  if (!hex || hex === "0x") return "";
  try { return coder.decode(["string"], hex)[0]; } catch { return ""; }
}

/// The launches of the last `hours`, newest first: { block, tx, token, creator, quote, unit, initialBuy, name, symbol }.
/// Tries each RPC in `rpcUrls` in turn (one may refuse the day of logs) and throws the last error when none answers.
export async function recentLaunches({ rpcUrls = DEFAULT_RPCS, rpcUrl = null, hours = 24, fetch = globalThis.fetch, maxBlocks = 7200, maxTx = 200 } = {}) {
  const urls = rpcUrl ? [rpcUrl] : rpcUrls;
  let last = null;
  for (const url of urls) {
    try { return await readLaunches({ rpcUrl: url, hours, fetch, maxBlocks, maxTx }); }
    catch (e) { last = e; }
  }
  throw last || new Error("no RPC configured");
}

async function readLaunches({ rpcUrl, hours, fetch, maxBlocks, maxTx }) {
  const latest = Number(await rpc(fetch, rpcUrl, "eth_blockNumber", []));
  const span = Math.min(maxBlocks, Math.ceil(hours * BLOCKS_PER_HOUR));
  const start = Math.max(0, latest - span);
  const graphs = [];
  for (let from = start; from <= latest; from += CHUNK) {
    const to = Math.min(latest, from + CHUNK - 1);
    graphs.push(...(await rpc(fetch, rpcUrl, "eth_getLogs", [{ address: GRAPH_DEPLOYER, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics: [GRAPH_TOPIC] }])));
  }
  const txs = [...new Set(graphs.map((l) => l.transactionHash))].slice(-maxTx);
  const out = [];
  for (const tx of txs) {
    const rc = await rpc(fetch, rpcUrl, "eth_getTransactionReceipt", [tx]);
    for (const l of rc?.logs || []) {
      if (!l.topics || l.topics[0] !== LAUNCH_TOPIC) continue;
      let p;
      try { p = iface.parseLog({ topics: l.topics, data: l.data }); } catch { continue; }
      const token = getAddress(p.args.token);
      const [name, symbol] = await Promise.all([
        rpc(fetch, rpcUrl, "eth_call", [{ to: token, data: "0x06fdde03" }, "latest"]).then(decodeString).catch(() => ""),
        rpc(fetch, rpcUrl, "eth_call", [{ to: token, data: "0x95d89b41" }, "latest"]).then(decodeString).catch(() => ""),
      ]);
      const quote = getAddress(p.args.quote);
      const q = QUOTES[quote];
      out.push({
        block: Number(rc.blockNumber), tx, token, creator: getAddress(p.args.creator), quote, unit: q ? q.unit : "",
        initialBuy: q ? Number(formatUnits(p.args.initialBuyQuoteAmount, q.decimals)) : null,
        name: name.slice(0, 40), symbol: symbol.slice(0, 16),
      });
    }
  }
  return out.sort((a, b) => b.block - a.block);
}

/// The launches as a block for Nib's prompt. Plain ASCII lines; the newest `max` are listed, the rest counted.
export function launchesBlock(list, { hours = 24, max = 15 } = {}) {
  const clean = (s) => String(s || "").replace(/[^\x20-\x7e]/g, "").trim();
  const head = `PROGRAMMABLE LAUNCHES (Ethereum, last ${hours} hours, read from the chain): ${list.length} coin${list.length === 1 ? "" : "s"} launched`;
  if (!list.length) return head + ".";
  const rows = list.slice(0, max).map((x) => `- ${clean(x.name) || "(no name)"} (${clean(x.symbol) || "?"}) token ${x.token}, creator ${x.creator.slice(0, 6)}...${x.creator.slice(-4)}, first buy ${x.initialBuy == null ? "in another token" : `${x.initialBuy.toFixed(x.unit === "ETH" ? 3 : 0)} ${x.unit}`}, block ${x.block}`);
  const more = list.length > max ? `\n- and ${list.length - max} more` : "";
  return `${head}:\n${rows.join("\n")}${more}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Caramel's side: the launches as leads, with the socials from the launch itself and the market from DexScreener.

export const ROUTER_V1 = "0x8622DD5bAb44185f2A458ac90384Ac99248f8d56"; // Programmable's stamp router on Ethereum
export const T_METADATA = "tuple(string name,string symbol,string description,string imageURI,string website,bytes socialData)";
export const T_MODULES = "tuple(address factory,bytes32 factoryCodeHash,bytes32 moduleCodeHash,bytes32 descriptorHash,bytes configuration,uint16 creatorShareBps)[]";
export const T_PARAMS_V3 = `tuple(${T_METADATA} metadata,address quote,uint8 quoteDecimals,int24 initialTick,uint16 creatorBuyFeeBps,uint16 creatorSellFeeBps,uint128 additionalQuoteAmount,uint128 initialBuyQuoteAmount,uint128 initialBuyMinimumTokenAmount,uint64 deadline,bytes32 tokenSalt,bytes32 hookSalt,${T_MODULES} modules)`;
export const T_RESULT_V2 = "tuple(address token,address hook,address ledger,bytes32 poolId,address basePositionOwner,address creatorPositionOwner,address roundingInventoryRecipient,uint256 basePositionId,uint256 creatorPositionId,uint256 initialBuyTokenAmount,uint128 baseTokenPrincipal,uint128 baseTokenRounding,uint128 creatorQuotePrincipal,uint256 actualQuoteRefund)";
export const T_CUSTOM_GRAPH_ROUTE = "tuple(bytes32 routeNamespace,bytes32 routeNonce,bytes32 topologyHash,bytes32 graphCommitment,tuple(bytes32 targetIdHash,bytes32 applicantSalt,uint256 deploymentValue,uint256 initializerValue,bytes initCode,bytes initializerCalldata)[] targets,tuple(uint8 targetIndex,bytes32 targetIdHash,address account,bytes32 runtimeCodeHash)[] expectedOutputs,bytes32 expectedGraphDeploymentHash)";
export const ROUTER_ABI = [
  "function launchAndStampV1(tuple(uint256 chainId,address router,address launchWallet,uint8 kind,bytes32 routePayloadHash,bytes32 expectedResultHash,bytes32 stampRequestHash,bytes32 nonce,uint64 validAfter,uint64 deadline,uint256 value) permit, tuple(bytes32 launchId,address token,bytes32 tokenRuntimeCodeHash,tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bytes32 hookRuntimeCodeHash,tuple(uint8 resultIndex,address account,bytes32 runtimeCodeHash,uint8 kind,uint8 scope)[] components) stampRequest, bytes routePayload, bytes signature) payable returns (bytes32)",
  "event ProgrammableLaunchStampedV1(bytes32 indexed launchId,address indexed token,address indexed hook,address poolManager,bytes32 poolId,bytes32 stampHash)",
];
export const FACTORY_V3_ABI = [`function initializeGraph(${T_PARAMS_V3} p, address token, address hook, bytes fundingPath) payable returns (${T_RESULT_V2} result)`];
export const router = new Interface(ROUTER_ABI);
export const factoryV3 = new Interface(FACTORY_V3_ABI);
export const STAMPED_TOPIC = router.getEvent("ProgrammableLaunchStampedV1").topicHash;

/// An X handle from a handle or a profile link ("@ann", "ann", "https://x.com/ann", "twitter.com/ann/"); null when there is none.
export function handleOf(v) {
  if (!v) return null;
  let s = String(v).trim();
  const m = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/@?([A-Za-z0-9_]{1,15})\/?(?:[?#].*)?$/i.exec(s); // a profile link, not a post
  if (m) return m[1];
  s = s.replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(s) ? s : null;
}
const telegramOf = (v) => { if (!v) return null; const m = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:\+)?([A-Za-z0-9_+-]{3,64})/i.exec(String(v).trim()); return m ? `https://t.me/${m[1]}` : null; };

/// The coin's metadata from a launch transaction's input (router.launchAndStampV1 carrying initializeGraph), or null.
export function decodeLaunchInput(data) {
  let call;
  try { call = router.parseTransaction({ data }); } catch { return null; }
  if (!call || call.name !== "launchAndStampV1") return null;
  let route;
  try { [route] = coder.decode([T_CUSTOM_GRAPH_ROUTE], call.args.routePayload); } catch { return null; }
  for (const t of route.targets) {
    let init;
    try { init = factoryV3.parseTransaction({ data: t.initializerCalldata }); } catch { init = null; }
    if (!init || init.name !== "initializeGraph") continue;
    const md = init.args.p.metadata;
    let social = null;
    try { social = JSON.parse(toUtf8String(md.socialData)); } catch { social = null; }
    const s = social && typeof social === "object" ? social : {};
    const twitter = handleOf(s.twitter || s.x || s.X || s.Twitter);
    return {
      name: String(md.name || "").slice(0, 60), symbol: String(md.symbol || "").slice(0, 20), description: String(md.description || "").slice(0, 400),
      website: String(md.website || s.website || "").slice(0, 200) || null, twitter, telegram: telegramOf(s.telegram || s.tg || s.Telegram), launchWallet: getAddress(call.args.permit.launchWallet),
      buyFeeBps: Number(init.args.p.creatorBuyFeeBps), sellFeeBps: Number(init.args.p.creatorSellFeeBps), social: s,
    };
  }
  return null;
}

/// The launches stamped between two blocks as leads, newest last: { launchId, token, hook, poolId, block, tx, ...metadata }.
/// provider: an ethers provider (getLogs, getTransaction). Reads in the chunks the public nodes accept.
export async function launchLeads(provider, { fromBlock, toBlock, routerAddress = ROUTER_V1, chunk = CHUNK, log = () => {} } = {}) {
  const out = [];
  for (let a = fromBlock; a <= toBlock; a += chunk) {
    const b = Math.min(toBlock, a + chunk - 1);
    let logs;
    try { logs = await provider.getLogs({ address: routerAddress, topics: [STAMPED_TOPIC], fromBlock: a, toBlock: b }); }
    catch (e) { log(`[launches] blocks ${a}..${b} could not be read: ${e.message}`); continue; }
    for (const l of logs) {
      let ev; try { ev = router.parseLog(l); } catch { continue; }
      const rec = { launchId: ev.args.launchId, token: getAddress(ev.args.token), hook: getAddress(ev.args.hook), poolId: ev.args.poolId, block: Number(l.blockNumber), tx: l.transactionHash, name: "", symbol: "", description: "", website: null, twitter: null, telegram: null, launchWallet: null };
      try { const tx = await provider.getTransaction(l.transactionHash); Object.assign(rec, decodeLaunchInput(tx?.data || "0x") || {}); }
      catch (e) { log(`[launches] the launch of ${rec.token} could not be decoded: ${e.message}`); }
      out.push(rec);
    }
  }
  return out;
}

/// What DexScreener knows of a token on Ethereum: the deepest pair's numbers and socials, or null.
export async function marketOf(token, { fetch = globalThis.fetch } = {}) {
  let j;
  try { const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${String(token).toLowerCase()}`, { headers: { accept: "application/json" } }); if (!r.ok) return null; j = await r.json(); } catch { return null; }
  const pairs = (j?.pairs || []).filter((p) => p.chainId === "ethereum");
  if (!pairs.length) return null;
  const p = pairs.sort((x, y) => Number(y.liquidity?.usd || 0) - Number(x.liquidity?.usd || 0))[0];
  const socials = p.info?.socials || [];
  const find = (t) => socials.find((s) => String(s.type || s.platform || "").toLowerCase() === t)?.url || null;
  return {
    pair: p.pairAddress, dex: p.dexId, url: p.url || null, priceUsd: Number(p.priceUsd) || null, fdvUsd: Number(p.fdv) || 0, liquidityUsd: Number(p.liquidity?.usd) || 0,
    volume24Usd: Number(p.volume?.h24) || 0, buys24: Number(p.txns?.h24?.buys) || 0, sells24: Number(p.txns?.h24?.sells) || 0, trades24: (Number(p.txns?.h24?.buys) || 0) + (Number(p.txns?.h24?.sells) || 0),
    createdAt: p.pairCreatedAt ? Number(p.pairCreatedAt) : null, twitter: handleOf(find("twitter")), telegram: telegramOf(find("telegram")), website: (p.info?.websites || [])[0]?.url || null,
  };
}

/// A lead's score, 0 to 100: trades and volume in the last day, liquidity, and whether anyone can be reached.
export function scoreLead({ trades24 = 0, volume24Usd = 0, liquidityUsd = 0, fdvUsd = 0, twitter = null, telegram = null } = {}) {
  const lg = (n, cap) => Math.min(1, Math.log10(1 + Math.max(0, n)) / Math.log10(1 + cap));
  let s = 40 * lg(trades24, 2000) + 25 * lg(volume24Usd, 500_000) + 15 * lg(liquidityUsd, 200_000) + 5 * lg(fdvUsd, 5_000_000);
  if (twitter) s += 12; else if (telegram) s += 4;
  return Math.round(Math.min(100, s));
}
