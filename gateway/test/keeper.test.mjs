// The keeper's three duties, against fake contracts: it claims the creator fee, runs the harvester and releases the
// vault only when due, simulates before sending, and sends nothing when its own wallet is under the gas floor.
import test from "node:test";
import assert from "node:assert/strict";
import { parseEther, Wallet } from "ethers";
import { Chain } from "../chain.mjs";

const KEY = "0x" + "11".repeat(32);
const keeper = new Wallet(KEY).address;
const ADDR = { sugar: "0x" + "a1".repeat(20), harvester: "0x" + "a2".repeat(20), ledger: "0x" + "a3".repeat(20), vault: "0x" + "a4".repeat(20), weth: "0x" + "a5".repeat(20) };

/// A fake contract: views answer from `state`, writes record themselves in `sent` and may be told to revert in simulation.
function fake(state, sent, reverts = {}) {
  const c = { connect: () => c, interface: { parseLog: () => null } };
  for (const [k, v] of Object.entries(state)) c[k] = async () => (typeof v === "function" ? v() : v);
  for (const fn of ["claimCreator", "claim", "release"]) {
    const f = async (o) => { sent.push({ fn, gas: o?.gasLimit }); return { wait: async () => ({ hash: "0x" + fn }) }; };
    f.staticCall = async () => { if (reverts[fn]) throw new Error(reverts[fn]); };
    c[fn] = f;
  }
  return c;
}

function world({ keeperEth = "1", unclaimed = "0", fresh = "0", pendingRest = "0", mainOwed = "0", lastRelease = 0, now = 100_000, budget = 50_000_000, weight = 4, reverts = {}, cfg = {} } = {}) {
  const sent = [];
  const warned = [];
  const log = { log: () => {}, warn: (t) => warned.push(t) };
  const provider = {
    getBalance: async (a) => (a === keeper ? parseEther(keeperEth) : 0n),
    getBlock: async () => ({ timestamp: now }),
    getBlockNumber: async () => 1,
  };
  const books = { pendingRest: parseEther(pendingRest), mainOwed: parseEther(mainOwed) };
  const contracts = {
    [ADDR.sugar]: fake({ totalActivated: 0n, totalSupply: 0n }, sent),
    [ADDR.ledger]: fake({ creatorReceived: parseEther(unclaimed) + 5n, creatorClaimed: 5n }, sent, reverts),
    [ADDR.harvester]: fake({ WETH: ADDR.weth, programOn: true, pendingRest: books.pendingRest, mainOwed: books.mainOwed, MIN_SWAP: parseEther("0.03"), totalMainPaid: 0n, totalStakersFunded: 0n, totalTeamFunded: 0n }, sent, reverts),
    [ADDR.vault]: fake({ lastRelease: BigInt(lastRelease), RELEASE_PERIOD: 86400n, dailyBudget: BigInt(budget), totalActiveWeight: BigInt(weight) }, sent, reverts),
    [ADDR.weth]: fake({ balanceOf: parseEther(fresh) + books.pendingRest + books.mainOwed }, sent),
  };
  const chain = new Chain(
    { rpcUrl: "x", chainId: 1, sugarAddress: ADDR.sugar, harvesterAddress: ADDR.harvester, ledgerAddress: ADDR.ledger, teamVaultAddress: ADDR.vault, keeperPrivateKey: KEY, startBlock: 0, ...cfg },
    { lastBlock: 0, recordActivation: () => false },
    { log, provider, contract: (address) => contracts[address] },
  );
  return { chain, sent, warned };
}

test("keeper: nothing due, nothing sent", async () => {
  const { chain, sent } = world({ lastRelease: 90_000 });
  const r = await chain.keeperTick();
  assert.equal(sent.length, 0);
  assert.equal(r.claimedCreator, null);
  assert.equal(r.harvested, null);
  assert.equal(r.released, null);
  assert.equal(r.skipped.length, 3);
});

test("keeper: creator fee above the floor is claimed, then the harvester runs", async () => {
  const { chain, sent } = world({ unclaimed: "0.2", fresh: "0.2", lastRelease: 90_000 });
  const r = await chain.keeperTick();
  assert.deepEqual(sent.map((s) => s.fn), ["claimCreator", "claim"]);
  assert.equal(r.claimedCreator.tx, "0xclaimCreator");
  assert.equal(r.harvested.tx, "0xclaim");
  assert.ok(sent[1].gas >= 2_000_000, "claim() gets room above its 700k gas floor");
});

test("keeper: a creator fee under the floor waits, a small fresh amount waits", async () => {
  const { chain, sent } = world({ unclaimed: "0.01", fresh: "0.01", lastRelease: 90_000 });
  const r = await chain.keeperTick();
  assert.equal(sent.length, 0);
  assert.match(r.skipped[0], /under the claim floor/);
  assert.match(r.skipped[1], /nothing due/);
});

test("keeper: a waiting swap or an owed main wallet makes the harvester run even with no fresh fee", async () => {
  const a = world({ pendingRest: "0.05", lastRelease: 90_000 });
  await a.chain.keeperTick();
  assert.deepEqual(a.sent.map((s) => s.fn), ["claim"]);
  const b = world({ mainOwed: "0.001", lastRelease: 90_000 });
  await b.chain.keeperTick();
  assert.deepEqual(b.sent.map((s) => s.fn), ["claim"]);
});

test("keeper: the vault is released once the day is over and the budget is worth it", async () => {
  const due = world({ lastRelease: 100_000 - 86400 });
  const r = await due.chain.keeperTick();
  assert.deepEqual(due.sent.map((s) => s.fn), ["release"]);
  assert.equal(r.released.tx, "0xrelease");

  const early = world({ lastRelease: 100_000 - 86399 });
  await early.chain.keeperTick();
  assert.equal(early.sent.length, 0);

  const dust = world({ lastRelease: 0, budget: 400_000 });
  const d = await dust.chain.keeperTick();
  assert.equal(dust.sent.length, 0);
  assert.match(d.skipped.at(-1), /under the release floor/);

  const nobody = world({ lastRelease: 0, weight: 0 });
  const n = await nobody.chain.keeperTick();
  assert.equal(nobody.sent.length, 0);
  assert.match(n.skipped.at(-1), /no active helper/);
});

test("keeper: a failed simulation is logged and never sent, the other duties still run", async () => {
  const { chain, sent, warned } = world({ unclaimed: "1", fresh: "1", lastRelease: 0, reverts: { claimCreator: "ledger paused" } });
  const r = await chain.keeperTick();
  assert.deepEqual(sent.map((s) => s.fn), ["claim", "release"]);
  assert.equal(r.claimedCreator.skipped, true);
  assert.match(r.claimedCreator.reason, /ledger paused/);
  assert.equal(warned.filter((w) => /claimCreator .* would revert/.test(w)).length, 1);
  await chain.keeperTick();
  assert.equal(warned.filter((w) => /would revert/.test(w)).length, 1, "the same standing problem is logged once an hour, not every tick");
});

test("keeper: an empty keeper wallet sends nothing and asks for a refill", async () => {
  const { chain, sent, warned } = world({ keeperEth: "0.005", unclaimed: "1", fresh: "1", lastRelease: 0 });
  const r = await chain.keeperTick();
  assert.equal(sent.length, 0);
  assert.deepEqual(r.skipped, ["keeper wallet under its gas floor"]);
  assert.match(warned[0], /under the 0.01 floor: refill it/);
});

test("keeper: no key means no keeper, the figures still read", async () => {
  const { chain, sent } = world({ unclaimed: "3", fresh: "2", pendingRest: "0.5", cfg: { keeperPrivateKey: "" } });
  assert.equal(await chain.keeperTick(), null);
  assert.equal(sent.length, 0);
  const t = await chain.onchainTotals();
  assert.equal(t.creatorUnclaimedWei, parseEther("3").toString());
  assert.equal(t.freshWei, parseEther("2").toString());
  assert.equal(t.pendingRestWei, parseEther("0.5").toString());
  assert.equal(t.programOn, true);
  assert.equal(t.vaultActiveWeight, 4);
});
