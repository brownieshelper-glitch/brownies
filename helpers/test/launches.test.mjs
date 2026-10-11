// Programmable's launches as leads: a launch transaction's input gives back the coin's name, ticker and socials;
// the stamp events over a block range become launch records; DexScreener's answer becomes the market numbers;
// the score rewards trades, volume, liquidity and a way to reach the creator.
import test from "node:test";
import assert from "node:assert/strict";
import { AbiCoder, Wallet, ZeroHash, toUtf8Bytes, zeroPadValue, hexlify, randomBytes } from "ethers";
import { router, factoryV3, decodeLaunchInput, handleOf, launchLeads, marketOf, scoreLead, STAMPED_TOPIC, T_CUSTOM_GRAPH_ROUTE, ROUTER_V1 } from "../lib/launches.mjs";

const TOKEN = "0x1111111111111111111111111111111111111111", HOOK = "0x2222222222222222222222222222222222222222", WALLET = Wallet.createRandom().address;

/// A launchAndStampV1 call the way Programmable's front end sends it: the graph route carries initializeGraph with the metadata.
function launchInput({ name = "Pancake", symbol = "PANCAKE", description = "The flattest coin on Ethereum.", website = "https://pancake.example", social = { twitter: "https://x.com/pancakecoin", telegram: "https://t.me/pancakechat" } } = {}) {
  const params = { metadata: { name, symbol, description, imageURI: "ipfs://x", website, socialData: toUtf8Bytes(JSON.stringify(social)) }, quote: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", quoteDecimals: 18, initialTick: -200000, creatorBuyFeeBps: 200, creatorSellFeeBps: 200, additionalQuoteAmount: 0n, initialBuyQuoteAmount: 0n, initialBuyMinimumTokenAmount: 0n, deadline: 0n, tokenSalt: ZeroHash, hookSalt: ZeroHash, modules: [] };
  const init = factoryV3.encodeFunctionData("initializeGraph", [params, TOKEN, HOOK, "0x"]);
  const route = AbiCoder.defaultAbiCoder().encode([T_CUSTOM_GRAPH_ROUTE], [{ routeNamespace: ZeroHash, routeNonce: ZeroHash, topologyHash: ZeroHash, graphCommitment: ZeroHash, targets: [{ targetIdHash: ZeroHash, applicantSalt: ZeroHash, deploymentValue: 0n, initializerValue: 0n, initCode: "0x", initializerCalldata: init }], expectedOutputs: [], expectedGraphDeploymentHash: ZeroHash }]);
  const permit = { chainId: 1n, router: ROUTER_V1, launchWallet: WALLET, kind: 1, routePayloadHash: ZeroHash, expectedResultHash: ZeroHash, stampRequestHash: ZeroHash, nonce: ZeroHash, validAfter: 0n, deadline: 0n, value: 0n };
  const stampRequest = { launchId: ZeroHash, token: TOKEN, tokenRuntimeCodeHash: ZeroHash, poolKey: { currency0: TOKEN, currency1: HOOK, fee: 0, tickSpacing: 60, hooks: HOOK }, hookRuntimeCodeHash: ZeroHash, components: [] };
  return router.encodeFunctionData("launchAndStampV1", [permit, stampRequest, route, "0x"]);
}

test("a launch transaction gives back the coin: name, ticker, description, site, the X handle and the Telegram from the socials", () => {
  const d = decodeLaunchInput(launchInput());
  assert.equal(d.name, "Pancake"); assert.equal(d.symbol, "PANCAKE"); assert.equal(d.description, "The flattest coin on Ethereum."); assert.equal(d.website, "https://pancake.example");
  assert.equal(d.twitter, "pancakecoin"); assert.equal(d.telegram, "https://t.me/pancakechat"); assert.equal(d.launchWallet, WALLET); assert.equal(d.buyFeeBps, 200);
  assert.equal(decodeLaunchInput(launchInput({ social: { x: "@flatcoin" } })).twitter, "flatcoin");
  assert.equal(decodeLaunchInput(launchInput({ social: "not json" })).twitter, null);
  assert.equal(decodeLaunchInput("0x1234"), null); assert.equal(decodeLaunchInput("0x"), null);
  for (const [v, h] of [["@ann", "ann"], ["ann", "ann"], ["https://x.com/ann", "ann"], ["https://twitter.com/ann/", "ann"], ["https://x.com/ann?s=20", "ann"], ["x.com/ann", "ann"], ["https://x.com/ann/status/1", null], ["", null], ["https://example.com/ann", null], ["a".repeat(16), null]]) assert.equal(handleOf(v), h, v);
});

test("the stamp events over a block range become launch records, in chunks, with the transaction decoded", async () => {
  const calls = [];
  const logAt = (block, token) => ({ address: ROUTER_V1, blockNumber: block, transactionHash: `0xtx${block}`, topics: [STAMPED_TOPIC, ZeroHash, zeroPadValue(token, 32), zeroPadValue(HOOK, 32)], data: AbiCoder.defaultAbiCoder().encode(["address", "bytes32", "bytes32"], ["0x000000000004444c5dc75cB358380D2e3dE08A90", hexlify(randomBytes(32)), ZeroHash]) });
  const provider = {
    getLogs: async (f) => { calls.push([f.fromBlock, f.toBlock]); return [logAt(100, TOKEN), logAt(2500, "0x3333333333333333333333333333333333333333")].filter((l) => l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock); },
    getTransaction: async (hash) => ({ data: hash === "0xtx100" ? launchInput() : "0xdeadbeef" }),
  };
  const out = await launchLeads(provider, { fromBlock: 1, toBlock: 4000 });
  assert.deepEqual(calls, [[1, 2000], [2001, 4000]]);
  assert.equal(out.length, 2);
  assert.equal(out[0].token, TOKEN); assert.equal(out[0].symbol, "PANCAKE"); assert.equal(out[0].twitter, "pancakecoin"); assert.equal(out[0].block, 100); assert.equal(out[0].tx, "0xtx100");
  assert.equal(out[1].symbol, "", "a transaction that does not decode leaves an empty record"); assert.equal(out[1].twitter, null);
  const broken = await launchLeads({ getLogs: async () => { throw new Error("rate limited"); } }, { fromBlock: 1, toBlock: 10 });
  assert.deepEqual(broken, []);
});

test("DexScreener's answer becomes the market numbers; the score rewards life and a way to reach the creator", async () => {
  const fetch = async () => ({ ok: true, json: async () => ({ pairs: [
    { chainId: "ethereum", dexId: "uniswap", pairAddress: "0xpair1", url: "https://dexscreener.com/ethereum/0xpair1", priceUsd: "0.001", fdv: 120000, liquidity: { usd: 15000 }, volume: { h24: 48000 }, txns: { h24: { buys: 210, sells: 140 } }, pairCreatedAt: 1791168827000, info: { socials: [{ type: "twitter", url: "https://x.com/pancakecoin" }, { type: "telegram", url: "https://t.me/pancakechat" }], websites: [{ url: "https://pancake.example" }] } },
    { chainId: "ethereum", dexId: "uniswap", pairAddress: "0xpair2", fdv: 120000, liquidity: { usd: 1000 }, volume: { h24: 10 }, txns: { h24: { buys: 1, sells: 0 } } },
    { chainId: "base", pairAddress: "0xother", liquidity: { usd: 999999 } },
  ] }) });
  const m = await marketOf(TOKEN, { fetch });
  assert.equal(m.pair, "0xpair1", "the deepest Ethereum pair"); assert.equal(m.trades24, 350); assert.equal(m.buys24, 210); assert.equal(m.volume24Usd, 48000); assert.equal(m.liquidityUsd, 15000); assert.equal(m.fdvUsd, 120000);
  assert.equal(m.twitter, "pancakecoin"); assert.equal(m.telegram, "https://t.me/pancakechat"); assert.equal(m.website, "https://pancake.example"); assert.equal(m.priceUsd, 0.001);
  assert.equal(await marketOf(TOKEN, { fetch: async () => ({ ok: false }) }), null);
  assert.equal(await marketOf(TOKEN, { fetch: async () => ({ ok: true, json: async () => ({ pairs: [] }) }) }), null);
  assert.equal(await marketOf(TOKEN, { fetch: async () => { throw new Error("down"); } }), null);
  const dead = scoreLead({ trades24: 1, volume24Usd: 2, liquidityUsd: 4000, fdvUsd: 4000 });
  const alive = scoreLead({ trades24: 350, volume24Usd: 48000, liquidityUsd: 15000, fdvUsd: 120000, twitter: "pancakecoin" });
  const hot = scoreLead({ trades24: 3000, volume24Usd: 900000, liquidityUsd: 300000, fdvUsd: 9000000, twitter: "x" });
  assert.ok(dead < 25 && alive > 55 && alive < hot && hot >= 95, `${dead} ${alive} ${hot}`);
  assert.equal(scoreLead({ trades24: 350, volume24Usd: 48000, liquidityUsd: 15000, fdvUsd: 120000 }) + 12, alive, "an X account is worth 12 points");
  assert.equal(scoreLead(), 0);
});
