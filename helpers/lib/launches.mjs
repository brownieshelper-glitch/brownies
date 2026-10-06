// The coins launched through Programmable on Ethereum, read straight from the chain. Every Programmable launch
// goes through its graph deployer, which emits ProgrammableCreate2GraphDeployed; the same transaction carries the
// coin's FoundationLaunchedV3 event (emitted by the new engine). So: the deployer's logs for the last day, then
// each transaction's receipt, then the coin's name and symbol with two eth_calls. Plain JSON-RPC over fetch, so
// the tests can answer it with a stub; ethers only decodes. (A topic-only eth_getLogs is refused by the public RPC,
// which is why the deployer's address is the anchor.)
import { Interface, AbiCoder, getAddress, formatUnits } from "ethers";

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
