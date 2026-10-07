// The pantry: the wallet that pays for inference per request. Its USDC lands on Ethereum (the harvester swaps the
// coin's fees to USDC and sends them here) and is spent on Base (x402, gasless for us). Every `everySeconds` the
// pantry reads both balances and, once at least `bridgeMinUsdc` waits on Ethereum and the wallet has ETH for the
// two transactions, moves all of it to Base through the bridge. Nothing is bought ahead: a request is paid the
// moment it is made, so no credits sit anywhere.
import { Contract, JsonRpcProvider, Wallet, formatEther, formatUnits } from "ethers";
import { USDC } from "./x402.mjs";

const ERC20 = ["function balanceOf(address) view returns (uint256)"];
const usdc = (atoms) => Number(formatUnits(atoms, 6));

export class Pantry {
  /// privateKey: the pantry wallet. bridge: a RelayBridge made for this wallet, or null (then nothing moves).
  constructor({ privateKey, ethRpcUrl, baseRpcUrl = "https://mainnet.base.org", bridge = null, payer = null, bridgeMinUsdc = 20, lowUsdc = 2, keepEth = 0.002, everySeconds = 600, now = () => Date.now(), log = () => {}, report = null } = {}) {
    this.wallet = new Wallet(privateKey);
    this.eth = new JsonRpcProvider(ethRpcUrl, 1, { staticNetwork: true });
    this.base = new JsonRpcProvider(baseRpcUrl, 8453, { staticNetwork: true });
    this.bridge = bridge; this.payer = payer;
    this.bridgeMinUsdc = bridgeMinUsdc; this.lowUsdc = lowUsdc; this.keepEth = keepEth; this.everySeconds = everySeconds;
    this.now = now; this.log = log; this.report = report;
    this.state = { at: 0, ethereum: null, base: null, lastBridge: null, error: null, bridging: false };
    this.timer = null;
  }
  get address() { return this.wallet.address; }

  /// Both balances: { ethereum: { eth, usdc }, base: { usdc } }.
  async balances() {
    const [ethWei, ethUsdc, baseUsdc] = await Promise.all([
      this.eth.getBalance(this.address),
      new Contract(USDC[1], ERC20, this.eth).balanceOf(this.address),
      new Contract(USDC[8453], ERC20, this.base).balanceOf(this.address),
    ]);
    return { ethereum: { eth: Number(formatEther(ethWei)), usdc: usdc(ethUsdc), usdcAtoms: ethUsdc }, base: { usdc: usdc(baseUsdc) } };
  }

  /// Whether this reading calls for a bridge: enough USDC waits and the wallet can pay the two transactions.
  shouldBridge(b) {
    return Boolean(this.bridge) && b.ethereum.usdc >= this.bridgeMinUsdc && b.ethereum.eth >= this.keepEth;
  }

  /// One reading, and the bridge when it is due.
  async tick() {
    if (this.state.bridging) return this.state;
    try {
      const b = await this.balances();
      this.state = { ...this.state, at: this.now(), ethereum: { eth: b.ethereum.eth, usdc: b.ethereum.usdc }, base: b.base, error: null };
      if (this.shouldBridge(b)) {
        this.state.bridging = true;
        try {
          const r = await this.bridge.bridge(b.ethereum.usdcAtoms);
          this.state.lastBridge = { at: this.now(), usdc: b.ethereum.usdc, requestId: r.requestId, status: r.status, txs: r.txs.map((t) => t.hash) };
          this.log(`[pantry] moved ${b.ethereum.usdc.toFixed(2)} USDC to Base (${r.status})`);
          if (this.report) await this.report(`Pantry: moved ${b.ethereum.usdc.toFixed(2)} USDC from Ethereum to Base for the brownies' inference.`).catch(() => {});
        } finally { this.state.bridging = false; }
      }
    } catch (e) {
      this.state = { ...this.state, at: this.now(), error: e.shortMessage || e.message, bridging: false };
      this.log(`[pantry] ${this.state.error}`);
    }
    return this.state;
  }

  start() {
    if (this.timer) return;
    this.tick().catch(() => {});
    this.timer = setInterval(() => this.tick().catch(() => {}), this.everySeconds * 1000);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /// What /health shows: the address to fund, both balances, whether Base runs low, the last bridge, what was paid.
  view() {
    const base = this.state.base?.usdc;
    return {
      address: this.address, ethereum: this.state.ethereum, base: this.state.base, readAt: this.state.at || null,
      low: base != null ? base < this.lowUsdc : null, bridgeMinUsdc: this.bridgeMinUsdc, lastBridge: this.state.lastBridge, error: this.state.error,
      paid: this.payer ? { requests: this.payer.paid.count, usdc: Number((this.payer.paid.micro / 1e6).toFixed(6)), last: this.payer.paid.last } : null,
    };
  }
}
