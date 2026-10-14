// An activation becomes credit only once enough blocks stand on top of its own. Credit given at the very tip of the
// chain stayed when that block was replaced and the payment went with it (finding 24 of the gateway's own review).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Interface, zeroPadValue } from "ethers";
import { Chain } from "../chain.mjs";
import { Ledger } from "../ledger.mjs";

const SUGAR = "0x" + "a1".repeat(20), BUYER = "0x" + "b2".repeat(20);
const ABI = ["event Activated(uint256 indexed id, address indexed from, bytes32 indexed beneficiary, uint256 amount)"];
const iface = new Interface(ABI);
const BENEFICIARY = zeroPadValue(BUYER, 32).toLowerCase();
const activation = (id, block, micro, tx) => ({ address: SUGAR, blockNumber: block, transactionHash: tx, ...iface.encodeEventLog("Activated", [id, BUYER, BENEFICIARY, micro]) });

/// A chain we move by hand: its tip, the logs that are in it now, what was asked of it.
function world({ confirmations } = {}) {
  const chainState = { tip: 100, logs: [], asked: [] };
  const provider = {
    getBlockNumber: async () => chainState.tip,
    getLogs: async ({ fromBlock, toBlock }) => { chainState.asked.push([fromBlock, toBlock]); return chainState.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock); },
    getTransactionReceipt: async (tx) => { const logs = chainState.logs.filter((l) => l.transactionHash === tx); return logs.length ? { blockNumber: logs[0].blockNumber, logs } : null; },
  };
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "brownies-depth-")), "l.sqlite"));
  const chain = new Chain({ rpcUrl: "x", chainId: 1, sugarAddress: SUGAR, startBlock: 90, ...(confirmations === undefined ? {} : { confirmations }) }, ledger, { provider, contract: () => ({ interface: iface }), log: { log() {}, warn() {} } });
  return { chainState, ledger, chain, credit: () => ledger.balance(BENEFICIARY).creditedMicro };
}
const TX = "0x" + "c3".repeat(32);

test("the indexer reads no block with fewer than five on top of it: the credit comes about a minute after the payment", async () => {
  const { chainState, chain, credit } = world();
  assert.equal(chain.confirmations, 5);
  chainState.logs.push(activation(1, 98, 2_000_000, TX));
  assert.equal(await chain.index(), 0); assert.equal(credit(), 0, "block 98 at tip 100: two on top");
  assert.ok(chainState.asked.every(([, to]) => to <= 95), "nothing past block 95 was read");
  chainState.tip = 102; assert.equal(await chain.index(), 0); assert.equal(credit(), 0, "four on top");
  chainState.tip = 103; assert.equal(await chain.index(), 1); assert.equal(credit(), 2_000_000, "five on top: credited");
  chainState.tip = 110; assert.equal(await chain.index(), 0); assert.equal(credit(), 2_000_000, "and never twice");
});

test("a payment in a block that is replaced before five stand on it leaves no credit", async () => {
  const { chainState, chain, credit } = world();
  chainState.logs.push(activation(1, 99, 5_000_000, TX));
  await chain.index();
  assert.deepEqual(await chain.indexTx(TX), { found: true, booked: 0, waitBlocks: 4, waitSeconds: 48 }, "asking for it by its number does not hurry it");
  chainState.logs.length = 0; // the block is replaced: the payment was never made on the chain that stands
  chainState.tip = 120;
  await chain.index();
  assert.deepEqual(await chain.indexTx(TX), { found: false, booked: 0, waitBlocks: 0, waitSeconds: 0 });
  assert.equal(credit(), 0);
});

test("asked for by its number, a payment says how long is left, then is credited once", async () => {
  const { chainState, chain, credit } = world();
  chainState.logs.push(activation(7, 100, 1_500_000, TX));
  assert.deepEqual(await chain.indexTx(TX), { found: true, booked: 0, waitBlocks: 5, waitSeconds: 60 });
  chainState.tip = 104;
  assert.deepEqual(await chain.indexTx(TX), { found: true, booked: 0, waitBlocks: 1, waitSeconds: 12 });
  chainState.tip = 105;
  assert.deepEqual(await chain.indexTx(TX), { found: true, booked: 1, waitBlocks: 0, waitSeconds: 0 });
  assert.equal(credit(), 1_500_000);
  assert.deepEqual(await chain.indexTx(TX), { found: true, booked: 0, waitBlocks: 0, waitSeconds: 0 }, "the indexer and this route cannot both credit it");
  assert.equal(await chain.index(), 0); assert.equal(credit(), 1_500_000);
  assert.deepEqual(await chain.indexTx("0x" + "d4".repeat(32)), { found: false, booked: 0, waitBlocks: 0, waitSeconds: 0 });
});

test("the wait is a setting: none on a test chain, and a wrong value falls back to five", async () => {
  const none = world({ confirmations: 0 });
  none.chainState.logs.push(activation(1, 100, 1_000_000, TX));
  assert.equal(await none.chain.index(), 1); assert.equal(none.credit(), 1_000_000);
  assert.equal(world({ confirmations: -3 }).chain.confirmations, 5);
  assert.equal(world({ confirmations: "abc" }).chain.confirmations, 5);
  assert.equal(world({ confirmations: 12 }).chain.confirmations, 12);
});
