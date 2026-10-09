// A rehearsal of the shop's payment on a fork of Base: anvil forks mainnet, a buyer gets real USDC from a holder
// (impersonated), the gateway's own x402 payer signs the requirement, the Seller verifies it against the real USDC
// contract and settles it with anvil's first account as the settler; the owner's address ends up with the money.
// usage: node smoke/shop-base-fork.mjs   (needs anvil; ANVIL=path to the binary, FORK_URL to change the RPC)
import { spawn } from "node:child_process";
import { JsonRpcProvider, Contract, Wallet, getAddress, id as topic } from "ethers";
import { Seller, USDC } from "../lib/x402seller.mjs";
import { X402Payer } from "../../gateway/x402.mjs";

const ANVIL = process.env.ANVIL || `${process.env.USERPROFILE || process.env.HOME}/.foundry/bin/anvil${process.platform === "win32" ? ".exe" : ""}`;
const FORK_URL = process.env.FORK_URL || "https://base-rpc.publicnode.com"; // mainnet.base.org rate-limits a fork's log reads
/// Deep USDC pockets on Base to borrow from on the fork (tried in order; the last resort is the recent transfers).
const HOLDERS = ["0xd0b53D9277642d899DF5C87A3966A349A798F224", "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB", "0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A"];
const PORT = 8546;
const RPC = `http://127.0.0.1:${PORT}`;
const SETTLER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil's first account: public, fork only
const PAY_TO = "0x2c769cDE285eb0d3c7130F9F0f14932106384095";
const ABI = ["function balanceOf(address) view returns (uint256)", "function transfer(address, uint256) returns (bool)", "event Transfer(address indexed from, address indexed to, uint256 value)"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (cond, what) => { if (!cond) throw new Error(`CHECK FAILED: ${what}`); console.log(`ok  ${what}`); };

const anvil = spawn(ANVIL, ["--fork-url", FORK_URL, "--port", String(PORT), "--silent"], { stdio: "ignore" });
try {
  const provider = new JsonRpcProvider(RPC, 8453, { staticNetwork: true });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await provider.getBlockNumber(); up = true; } catch { await sleep(1000); } }
  if (!up) throw new Error("anvil did not come up (is it installed? ANVIL=path)");
  const block = await provider.getBlockNumber();
  console.log(`fork of Base at block ${block}`);
  const usdc = new Contract(USDC[8453], ABI, provider);

  // a USDC holder, impersonated to fund the buyer: a known deep pocket, else one from the last blocks' transfers
  let holder = null;
  for (const h of HOLDERS) if ((await usdc.balanceOf(h)) >= 20_000_000n) { holder = h; break; }
  if (!holder) {
    const logs = await provider.getLogs({ address: USDC[8453], topics: [topic("Transfer(address,address,uint256)")], fromBlock: block - 10, toBlock: block });
    for (const l of logs.reverse()) {
      const to = getAddress("0x" + l.topics[2].slice(26));
      if ((await usdc.balanceOf(to)) >= 20_000_000n) { holder = to; break; }
    }
  }
  if (!holder) throw new Error("no USDC holder found in the last blocks");
  const buyer = Wallet.createRandom().connect(provider);
  await provider.send("anvil_impersonateAccount", [holder]);
  await provider.send("anvil_setBalance", [holder, "0x" + (10n ** 18n).toString(16)]);
  const tx = await provider.send("eth_sendTransaction", [{ from: holder, to: USDC[8453], data: usdc.interface.encodeFunctionData("transfer", [buyer.address, 5_000_000n]) }]);
  await provider.waitForTransaction(tx);
  ok((await usdc.balanceOf(buyer.address)) === 5_000_000n, `the buyer holds 5 USDC (from ${holder})`);
  ok((await provider.getBalance(buyer.address)) === 0n, "the buyer holds no ETH: it pays no gas");

  // the shop's side
  const seller = new Seller({ chainId: 8453, payTo: PAY_TO, settlerKey: SETTLER_KEY, rpcUrl: RPC, log: (l) => console.log("   ", l) });
  const open = await seller.open();
  ok(open.ok, `the shop is open (settler ${seller.address})`);
  const required = seller.requirement({ micro: 1_000_000, url: "https://api.feedthebrownies.com/shop/note", description: "A research note", maxTimeoutSeconds: 600 });
  const payer = new X402Payer({ wallet: buyer, chainId: 8453, maxMicro: 10_000_000 });
  const { payload } = await payer.sign(required);
  const v = await seller.verify(payload, required);
  ok(v.ok, `the payment verifies against the real USDC contract (payer ${v.payer})${v.ok ? "" : ": " + v.error}`);
  const before = await usdc.balanceOf(PAY_TO);
  const s = await seller.settle(payload);
  ok(s.ok, `settled: ${s.tx || s.error}`);
  const after = await usdc.balanceOf(PAY_TO);
  ok(after - before === 1_000_000n, `the owner's wallet received exactly 1 USDC (${before} -> ${after})`);
  ok((await usdc.balanceOf(buyer.address)) === 4_000_000n, "the buyer has 4 USDC left");
  // the same authorization again: the chain refuses (nonce used), and so does verify
  const again = await seller.verify(payload, required);
  ok(!again.ok && /used already/.test(again.error), "the same authorization cannot pay twice");
  const twice = await seller.settle(payload);
  ok(!twice.ok, `a second settlement reverts: ${twice.error}`);
  console.log("\nALL CHECKS PASSED on the Base fork");
} finally {
  anvil.kill();
}
