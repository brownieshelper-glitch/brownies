// The chain side: index Sugar.Activated into the ledger, and (optionally) be the keeper that calls harvester.claim().
import { JsonRpcProvider, Contract, Wallet, id as topicId } from "ethers";

const SUGAR_ABI = [
  "event Activated(uint256 indexed id, address indexed from, bytes32 indexed beneficiary, uint256 amount)",
  "function totalActivated() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];
const HARVESTER_ABI = [
  "function claim()",
  "function escrowed() view returns (uint256)",
  "function pendingRest() view returns (uint256)",
  "function mainOwed() view returns (uint256)",
  "function totalMainPaid() view returns (uint256)",
  "function totalStakersFunded() view returns (uint256)",
  "function totalTeamFunded() view returns (uint256)",
  "function MIN_SWAP() view returns (uint256)",
];

export class Chain {
  constructor(cfg, ledger, log = console) {
    this.cfg = cfg;
    this.ledger = ledger;
    this.log = log;
    this.provider = new JsonRpcProvider(cfg.rpcUrl, Number(cfg.chainId), { staticNetwork: true });
    this.sugar = new Contract(cfg.sugarAddress, SUGAR_ABI, this.provider);
    this.harvester = cfg.harvesterAddress ? new Contract(cfg.harvesterAddress, HARVESTER_ABI, this.provider) : null;
    this.topic = topicId("Activated(uint256,address,bytes32,uint256)");
    this.maxRange = 9_000_000; // the RPC allows 10M blocks per getLogs
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

  async onchainTotals() {
    const [activated, supply] = await Promise.all([this.sugar.totalActivated(), this.sugar.totalSupply()]);
    const out = { sugarActivatedMicro: Number(activated), sugarSupplyMicro: Number(supply) };
    if (this.harvester) {
      const [escrowed, pendingRest, mainOwed, mainPaid, stakers, agent] = await Promise.all([
        this.harvester.escrowed(), this.harvester.pendingRest(), this.harvester.mainOwed(), this.harvester.totalMainPaid(), this.harvester.totalStakersFunded(), this.harvester.totalTeamFunded(),
      ]);
      Object.assign(out, { escrowedWei: escrowed.toString(), pendingRestWei: pendingRest.toString(), mainOwedWei: mainOwed.toString(), totalMainPaidWei: mainPaid.toString(), totalStakersFundedMicro: Number(stakers), totalTeamFundedMicro: Number(agent) });
    }
    return out;
  }

  /// The keeper duty: claim when Pons owes us something or when enough ETH waits to be swapped.
  async keeperClaim() {
    if (!this.harvester || !this.cfg.keeperPrivateKey) return null;
    const [escrowed, pendingRest, minSwap] = await Promise.all([this.harvester.escrowed(), this.harvester.pendingRest(), this.harvester.MIN_SWAP()]);
    if (escrowed === 0n && pendingRest < minSwap) return { skipped: true, reason: "nothing to claim" };
    const signer = new Wallet(this.cfg.keeperPrivateKey, this.provider);
    const h = this.harvester.connect(signer);
    try {
      await h.claim.staticCall();
    } catch (e) {
      this.log.warn(`[keeper] claim would revert: ${e.shortMessage || e.message}`);
      return { skipped: true, reason: e.shortMessage || e.message };
    }
    // claim() refuses to run under its gas floor (it must not be starved into a silent no-op); give it room
    const tx = await h.claim({ gasLimit: 2_500_000 });
    const r = await tx.wait();
    this.log.log(`[keeper] claimed in ${r.hash} (escrowed ${escrowed}, waiting ${pendingRest})`);
    return { tx: r.hash };
  }

  start({ indexEverySeconds = 20, claimEverySeconds = 300 } = {}) {
    const tick = async () => {
      if (this.stopped) return;
      try { await this.index(); } catch (e) { this.log.warn(`[chain] index failed: ${e.shortMessage || e.message}`); }
      setTimeout(tick, indexEverySeconds * 1000);
    };
    tick();
    if (this.cfg.keeperPrivateKey && this.harvester) {
      const ktick = async () => {
        if (this.stopped) return;
        try { await this.keeperClaim(); } catch (e) { this.log.warn(`[keeper] failed: ${e.shortMessage || e.message}`); }
        setTimeout(ktick, claimEverySeconds * 1000);
      };
      ktick();
    }
  }

  stop() {
    this.stopped = true;
  }
}
