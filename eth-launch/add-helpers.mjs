// Put the brownies on the payroll: TeamVault.addHelper(name, key, weight) for each helper that is not there yet.
// The key is the helper wallet's gateway beneficiary id, bytes32(uint256(uint160(wallet))), the same id the gateway
// bills, so the SUGAR the vault releases lands straight on that helper's API key.
//
//   node eth-launch/add-helpers.mjs plan      [record]   reads the chain, prints what would be sent, sends nothing
//   node eth-launch/add-helpers.mjs fork      [record]   local anvil fork only, signs with anvil's account 0
//   node eth-launch/add-helpers.mjs broadcast --i-am-the-owner [record]   the real thing; needs LAUNCH_IT=1 too
//
// Environment: RPC_URL (default publicnode), PRIVATE_KEY (broadcast only: the vault owner, the team wallet),
// HELPERS = "Fudge,Crumb,Nib,Chip" (default) and one address per helper: FUDGE_ADDRESS, CRUMB_ADDRESS, NIB_ADDRESS,
// CHIP_ADDRESS (public addresses only; the file helix-secrets/brownies-wallets.env also holds the private keys, so
// load only the *_ADDRESS lines from it, never print anything else). Every helper gets weight 1 unless
// <NAME>_WEIGHT is set. The record defaults to web/deployments/1.json (1.fork.json in fork mode).
import fs from "node:fs";
import path from "node:path";
import { ethers, PROJECT } from "./programmable.mjs";
import { walletToBeneficiary } from "../gateway/auth.mjs";

const fail = (m) => { console.error("\nSTOP: " + m); process.exit(1); };
const args = process.argv.slice(2);
const MODE = args.find((a) => !a.startsWith("--"));
const FLAG_OWNER = args.includes("--i-am-the-owner");
if (!["plan", "fork", "broadcast"].includes(MODE)) fail("usage: node eth-launch/add-helpers.mjs plan | fork | broadcast --i-am-the-owner [record]");
if (MODE === "broadcast" && (process.env.LAUNCH_IT !== "1" || !FLAG_OWNER)) fail("broadcast refused. It needs BOTH LAUNCH_IT=1 AND --i-am-the-owner, and the owner's word. Nothing was sent.");

const recPath = args.filter((a) => !a.startsWith("--"))[1] || path.join(PROJECT, "web", "deployments", MODE === "fork" ? "1.fork.json" : "1.json");
if (!fs.existsSync(recPath)) fail("no record at " + recPath);
const rec = JSON.parse(fs.readFileSync(recPath, "utf8"));
if (MODE === "fork" && rec.mode !== "fork") fail("fork mode needs a fork record");
if (MODE === "broadcast" && rec.mode === "fork") fail("broadcast with a fork record makes no sense");

const RPC = process.env.RPC_URL || (MODE === "fork" ? "http://127.0.0.1:8557" : "https://ethereum-rpc.publicnode.com");
const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: ethers.Network.from(1), cacheTimeout: -1 });
if (MODE === "fork") {
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(RPC).hostname)) fail("fork mode is local anvil only");
  if (!/anvil/i.test(String(await provider.send("web3_clientVersion", []).catch(() => "")))) fail("fork mode needs an anvil node");
}

const VAULT_ABI = [
  "function owner() view returns (address)",
  "function helperCount() view returns (uint256)",
  "function helper(uint256 id) view returns (string name, bytes32 key, uint32 weight, bool active)",
  "function addHelper(string name, bytes32 key, uint32 weight) returns (uint256)",
];
const vault = new ethers.Contract(rec.teamVault, VAULT_ABI, provider);
const owner = ethers.getAddress(await vault.owner());

let signer = null;
if (MODE === "fork") signer = ethers.HDNodeWallet.fromPhrase("test test test test test test test test test test test junk", undefined, "m/44'/60'/0'/0/0").connect(provider);
if (MODE === "broadcast") {
  if (!process.env.PRIVATE_KEY) fail("broadcast needs PRIVATE_KEY in the environment (the vault owner), never on the command line");
  signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
}
if (signer && ethers.getAddress(signer.address) !== owner) fail(`the signer ${signer.address} is not the vault owner ${owner}`);

// the helpers to add, from the environment
const names = (process.env.HELPERS || "Fudge,Crumb,Nib,Chip").split(",").map((s) => s.trim()).filter(Boolean);
const wanted = names.map((name) => {
  const up = name.toUpperCase();
  const address = process.env[up + "_ADDRESS"];
  if (!address || !ethers.isAddress(address)) fail(`${up}_ADDRESS is not set to a wallet address`);
  const weight = Number(process.env[up + "_WEIGHT"] || 1);
  if (!Number.isInteger(weight) || weight < 1 || weight > 1_000_000) fail(`${up}_WEIGHT must be a whole number from 1`);
  return { name, address: ethers.getAddress(address), key: walletToBeneficiary(address), weight };
});

// what is already there
const count = Number(await vault.helperCount());
const present = [];
for (let i = 0; i < count; i++) {
  const h = await vault.helper(i);
  present.push({ id: i, name: h.name, key: h.key.toLowerCase(), weight: Number(h.weight), active: h.active });
}
console.log(`vault ${rec.teamVault} on ${RPC}\nowner ${owner}\n${count} helper(s) on the payroll${present.map((h) => `\n  #${h.id} ${h.name} weight ${h.weight} ${h.active ? "active" : "off"} key ${h.key}`).join("")}`);

const todo = [];
for (const w of wanted) {
  const same = present.find((h) => h.key === w.key.toLowerCase());
  const sameName = present.find((h) => h.name.toLowerCase() === w.name.toLowerCase());
  if (same) { console.log(`skip ${w.name}: that wallet is already helper #${same.id} (${same.name})`); continue; }
  if (sameName) fail(`a helper named ${w.name} exists with another key (#${sameName.id}); refusing to add a second ${w.name}`);
  todo.push(w);
}
if (!todo.length) { console.log("\nnothing to add"); process.exit(0); }
console.log(`\nto add:${todo.map((w) => `\n  ${w.name.padEnd(6)} wallet ${w.address} key ${w.key} weight ${w.weight}`).join("")}`);

// simulate every call from the owner, in order
for (const w of todo) {
  try { await vault.addHelper.staticCall(w.name, w.key, w.weight, { from: owner }); }
  catch (e) { fail(`addHelper(${w.name}) would revert: ${e.shortMessage || e.message}`); }
}
console.log("simulation from the owner: every call passes");
if (MODE === "plan") { console.log("\nplan only, nothing sent. Run with fork or broadcast --i-am-the-owner."); process.exit(0); }

const v = vault.connect(signer);
for (const w of todo) {
  const tx = await v.addHelper(w.name, w.key, w.weight, { gasLimit: 200_000 });
  const rc = await tx.wait();
  if (rc.status !== 1) fail(`addHelper(${w.name}) reverted in ${rc.hash}`);
  console.log(`added ${w.name} in ${rc.hash} (gas ${rc.gasUsed})`);
}
const after = Number(await vault.helperCount());
console.log(`\n${after} helper(s) on the payroll now`);
