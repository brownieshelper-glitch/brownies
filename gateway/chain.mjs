// The chain side: index Sugar.Activated into the ledger, and (optionally) be the keeper.
//
// The keeper has three duties on Ethereum. Anyone may do each of them; the keeper just makes sure somebody does.
//   1. ledger.claimCreator()   Programmable's ledger holds the coin's creator fee (WETH). The claim pays it to the
//                              harvester. Called when at least CLAIM_MIN_ETH waits there.
//   2. harvester.claim()       Books the fresh WETH (40% to the main wallet, the rest for the swap), swaps when at
//                              least MIN_SWAP waits, pays the main wallet. Called when fresh WETH of at least
//                              CLAIM_MIN_ETH sits in the harvester, or a swap is waiting, or the main wallet is owed.
//   3. vault.release()         Once a day, hands one thirtieth of the TeamVault's SUGAR to the brownies' keys.
//                              Called when the day is over and the budget is worth at least RELEASE_MIN_SUGAR.
// Every transaction is simulated first (staticCall); a simulation that fails is logged and skipped, never sent.
import { JsonRpcProvider, Contract, Wallet, id as topicId, parseEther, formatEther } from "ethers";

const SUGAR_ABI = [
  "event Activated(uint256 indexed id, address indexed from, bytes32 indexed beneficiary, uint256 amount)",
  "function totalActivated() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];
const HARVESTER_ABI = [
  "function claim()",
  "function WETH() view returns (address)",
  "function programOn() view returns (bool)",
  "function pendingRest() view returns (uint256)",
  "function mainOwed() view returns (uint256)",
  "function totalMainPaid() view returns (uint256)",
  "function totalStakersFunded() view returns (uint256)",
  "function totalTeamFunded() view returns (uint256)",
  "function MIN_SWAP() view returns (uint256)",
];
const LEDGER_ABI = [
  "function creatorReceived() view returns (uint256)",
  "function creatorClaimed() view returns (uint256)",
  "function claimCreator() returns (uint256)",
];
const VAULT_ABI = [
  "function lastRelease() view returns (uint256)",
  "function RELEASE_PERIOD() view returns (uint256)",
  "function dailyBudget() view returns (uint256)",
  "function totalActiveWeight() view returns (uint256)",
  "function release() returns (uint256)",
];
const WETH_ABI = ["function balanceOf(address) view returns (uint256)"];

const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || "");
const short = (e) => e?.shortMessage || e?.reason || e?.message || String(e);

export class Chain {
  /// `opts` is for tests: a fake provider and a fake contract factory `(address, abi, provider) => contract`.
  constructor(cfg, ledger, opts = {}) {
    this.cfg = cfg;
    this.ledger = ledger;
    this.log = opts.log || console;
    this.provider = opts.provider || new JsonRpcProvider(cfg.rpcUrl, Number(cfg.chainId), { staticNetwork: true });
    const make = opts.contract || ((address, abi) => new Contract(address, abi, this.provider));
    this.make = make;
    this.sugar = make(cfg.sugarAddress, SUGAR_ABI);
    this.harvester = isAddress(cfg.harvesterAddress) ? make(cfg.harvesterAddress, HARVESTER_ABI) : null;
    this.feeLedger = isAddress(cfg.ledgerAddress) ? make(cfg.ledgerAddress, LEDGER_ABI) : null;
    this.vault = isAddress(cfg.teamVaultAddress) ? make(cfg.teamVaultAddress, VAULT_ABI) : null;
    this.weth = null; // made on first use from harvester.WETH()
    this.topic = topicId("Activated(uint256,address,bytes32,uint256)");
    this.maxRange = 9_000_000; // the RPC allows 10M blocks per getLogs
    this.claimMinWei = parseEther(String(cfg.claimMinEth ?? 0.05));
    this.keeperFloorWei = parseEther(String(cfg.keeperFloorEth ?? 0.01));
    this.releaseMinMicro = BigInt(Math.round(Number(cfg.releaseMinSugar ?? 1) * 1e6));
    this.signer = cfg.keeperPrivateKey ? new Wallet(cfg.keeperPrivateKey, this.provider) : null;
    this.lastWarn = new Map(); // topic -> time, so a standing problem is logged once an hour, not every tick
    this.claimMemo = null; this.claimStuck = 0; this.claimBackoffUntil = 0; // a claim that moved nothing is not repeated every tick
    this.stopped = false;
  }

  /// Read every Activated since the last indexed block, book the new ones. Safe to call any time.
  async index() {
    const head = await this.provider.getBlockNumber();
    let from = this.ledger.lastBlock ?? Number(this.cfg.startBlock);
    if (from > head) return 0;
    let booked = 0;
    while (from <= head) {
      const to = Math.min(head, from + this.maxRange);
      const logs = await this.provider.getLogs({ address: this.cfg.sugarAddress, topics: [this.topic], fromBlock: from, toBlock: to });
      for (const l of logs) {
        const parsed = this.sugar.interface.parseLog(l);
        const ok = this.ledger.recordActivation({
          id: Number(parsed.args.id),
          beneficiary: parsed.args.beneficiary,
          sender: parsed.args.from,
          atoms: Number(parsed.args.amount),
          block: l.blockNumber,
          tx: l.transactionHash,
        });
        if (ok) booked++;
      }
      // keep a 3-block overlap so a reorg of the tip cannot lose an event (ids make the overlap harmless)
      this.ledger.lastBlock = Math.max(from, to - 3);
      from = to + 1;
    }
    if (booked) this.log.log(`[chain] booked ${booked} activation(s), head ${head}`);
    return booked;
  }

  /// Credits from an activation tx that the indexer has not reached yet (the site calls this right after a wallet
  /// activates, so the balance shows at once).
  async indexTx(txHash) {
    const r = await this.provider.getTransactionReceipt(txHash);
    if (!r) return 0;
    let booked = 0;
    for (const l of r.logs) {
      if (l.address.toLowerCase() !== this.cfg.sugarAddress.toLowerCase() || l.topics[0] !== this.topic) continue;
      const parsed = this.sugar.interface.parseLog(l);
      if (this.ledger.recordActivation({ id: Number(parsed.args.id), beneficiary: parsed.args.beneficiary, sender: parsed.args.from, atoms: Number(parsed.args.amount), block: r.blockNumber, tx: txHash })) booked++;
    }
    return booked;
  }

  async wethContract() {
    if (!this.weth && this.harvester) this.weth = this.make(await this.harvester.WETH(), WETH_ABI);
    return this.weth;
  }

  /// What the ledger still owes the coin's creator (the harvester), in WETH.
  async creatorUnclaimed() {
    if (!this.feeLedger) return 0n;
    const [received, claimed] = await Promise.all([this.feeLedger.creatorReceived(), this.feeLedger.creatorClaimed()]);
    return received > claimed ? received - claimed : 0n;
  }

  /// The harvester's books: what arrived and is not booked yet, what waits for a swap, what the main wallet is owed.
  async harvesterState() {
    const h = this.harvester;
    const weth = await this.wethContract();
    const [wethBal, ethBal, pendingRest, mainOwed, minSwap, programOn] = await Promise.all([
      weth.balanceOf(this.cfg.harvesterAddress), this.provider.getBalance(this.cfg.harvesterAddress),
      h.pendingRest(), h.mainOwed(), h.MIN_SWAP(), h.programOn(),
    ]);
    const known = pendingRest + mainOwed;
    const held = wethBal + ethBal;
    return { fresh: held > known ? held - known : 0n, pendingRest, mainOwed, minSwap, programOn, held };
  }

  async onchainTotals() {
    const [activated, supply] = await Promise.all([this.sugar.totalActivated(), this.sugar.totalSupply()]);
    const out = { sugarActivatedMicro: Number(activated), sugarSupplyMicro: Number(supply) };
    if (this.harvester) {
      const [s, mainPaid, stakers, team, unclaimed] = await Promise.all([
        this.harvesterState(), this.harvester.totalMainPaid(), this.harvester.totalStakersFunded(), this.harvester.totalTeamFunded(), this.creatorUnclaimed(),
      ]);
      Object.assign(out, {
        programOn: s.programOn,
        creatorUnclaimedWei: unclaimed.toString(), // still inside Programmable's ledger
        freshWei: s.fresh.toString(), // in the harvester, not booked yet
        pendingRestWei: s.pendingRest.toString(), // booked, waiting for a swap
        mainOwedWei: s.mainOwed.toString(),
        totalMainPaidWei: mainPaid.toString(),
        totalStakersFundedMicro: Number(stakers),
        totalTeamFundedMicro: Number(team),
      });
    }
    if (this.vault) {
      const [last, period, budget, weight] = await Promise.all([this.vault.lastRelease(), this.vault.RELEASE_PERIOD(), this.vault.dailyBudget(), this.vault.totalActiveWeight()]);
      Object.assign(out, { vaultNextReleaseAt: Number(last + period), vaultDailyBudgetMicro: Number(budget), vaultActiveWeight: Number(weight) });
    }
    return out;
  }

  warnOnce(topic, text) {
    const now = Date.now();
    if ((this.lastWarn.get(topic) || 0) + 3600_000 > now) return;
    this.lastWarn.set(topic, now);
    this.log.warn(text);
  }

  /// Simulate, then send. Returns the tx hash, or null with the reason when the simulation fails.
  async send(label, contract, fn, overrides = {}) {
    const c = contract.connect(this.signer);
    try {
      await c[fn].staticCall(overrides);
    } catch (e) {
      this.warnOnce("sim:" + label, `[keeper] ${label} would revert: ${short(e)}`);
      return { skipped: true, reason: short(e) };
    }
    const tx = await c[fn](overrides);
    const r = await tx.wait();
    this.log.log(`[keeper] ${label} in ${r.hash}`);
    return { tx: r.hash };
  }

  /// One pass over the three duties. Returns what happened, for the log and the tests.
  async keeperTick() {
    if (!this.signer) return null;
    const out = { claimedCreator: null, harvested: null, released: null, skipped: [] };
    const bal = await this.provider.getBalance(this.signer.address);
    if (bal < this.keeperFloorWei) {
      this.warnOnce("gas", `[keeper] wallet ${this.signer.address} holds ${formatEther(bal)} ETH, under the ${formatEther(this.keeperFloorWei)} floor: refill it, nothing is sent until then`);
      out.skipped.push("keeper wallet under its gas floor");
      return out;
    }

    // 1. the creator fee inside Programmable's ledger
    if (this.feeLedger && this.harvester) {
      const unclaimed = await this.creatorUnclaimed();
      if (unclaimed >= this.claimMinWei) out.claimedCreator = await this.send(`claimCreator (${formatEther(unclaimed)} WETH)`, this.feeLedger, "claimCreator", { gasLimit: 400_000 });
      else out.skipped.push(`creator fee ${formatEther(unclaimed)} WETH under the claim floor`);
    }

    // 2. the harvester: book, swap, pay
    if (this.harvester) {
      const s = await this.harvesterState();
      const due = s.fresh >= this.claimMinWei || s.pendingRest >= s.minSwap || s.mainOwed > 0n;
      // a claim that left the waiting swap and the owed ETH exactly as they were (the price off its band, the staking
      // stopped, the main wallet refusing ETH) is not sent again every five minutes: it waits 1, 2, 4... hours, up to a
      // day, unless fresh fees arrive, which always get booked
      const unchanged = this.claimMemo && this.claimMemo.pendingRest === s.pendingRest && this.claimMemo.mainOwed === s.mainOwed;
      if (due && unchanged && s.fresh < this.claimMinWei && Date.now() < this.claimBackoffUntil) {
        out.skipped.push(`harvester: the last claim moved nothing; next try at ${new Date(this.claimBackoffUntil).toISOString()}`);
      } else if (due) {
        // claim() refuses to run under its gas floor (it must not be starved into a silent no-op); give it room
        out.harvested = await this.send(`harvester.claim (fresh ${formatEther(s.fresh)}, waiting ${formatEther(s.pendingRest)} WETH)`, this.harvester, "claim", { gasLimit: 2_500_000 });
        if (out.harvested?.tx) {
          const after = await this.harvesterState();
          if (after.pendingRest + after.mainOwed > 0n && after.pendingRest === s.pendingRest && after.mainOwed === s.mainOwed) {
            this.claimStuck++;
            const hours = Math.min(24, 2 ** (this.claimStuck - 1));
            this.claimBackoffUntil = Date.now() + hours * 3600_000;
            this.claimMemo = { pendingRest: after.pendingRest, mainOwed: after.mainOwed };
            this.warnOnce("claim-stuck", `[keeper] harvester.claim moved nothing: ${formatEther(after.pendingRest)} WETH still waits for its swap and ${formatEther(after.mainOwed)} ETH is still owed (the price off its band, the staking stopped, or the main wallet refusing ETH); next try in ${hours} h`);
          } else { this.claimStuck = 0; this.claimMemo = null; this.claimBackoffUntil = 0; }
        }
      } else out.skipped.push(`harvester: ${formatEther(s.fresh)} WETH fresh, nothing due`);
    }

    // 3. the brownies' daily budget
    if (this.vault) {
      const [last, period, budget, weight, block] = await Promise.all([this.vault.lastRelease(), this.vault.RELEASE_PERIOD(), this.vault.dailyBudget(), this.vault.totalActiveWeight(), this.provider.getBlock("latest")]);
      const now = BigInt(block.timestamp);
      if (now < last + period) out.skipped.push(`vault: next release at ${Number(last + period)}`);
      else if (weight === 0n) out.skipped.push("vault: no active helper");
      else if (budget < this.releaseMinMicro) out.skipped.push(`vault: budget ${Number(budget) / 1e6} SUGAR under the release floor`);
      else out.released = await this.send(`vault.release (${Number(budget) / 1e6} SUGAR)`, this.vault, "release", { gasLimit: 600_000 });
    }
    return out;
  }

  start({ indexEverySeconds = 20, claimEverySeconds = 300 } = {}) {
    const tick = async () => {
      if (this.stopped) return;
      try { await this.index(); } catch (e) { this.log.warn(`[chain] index failed: ${short(e)}`); }
      setTimeout(tick, indexEverySeconds * 1000);
    };
    tick();
    if (this.signer && (this.harvester || this.vault)) {
      const ktick = async () => {
        if (this.stopped) return;
        try { await this.keeperTick(); } catch (e) { this.log.warn(`[keeper] failed: ${short(e)}`); }
        setTimeout(ktick, claimEverySeconds * 1000);
      };
      ktick();
    }
  }

  stop() {
    this.stopped = true;
  }
}
