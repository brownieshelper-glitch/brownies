// Drives the real site in a real browser (headless Edge over the DevTools protocol) against the local stack that
// smoke/site-stack.sh brings up: an anvil fork of Ethereum with the coin launched the real way, the gateway in live
// mode and the site. A test wallet is injected into the page: it forwards to anvil, which signs for its own
// account 1 (the wallet that holds BROWNIE and has staked). Every button of the app is pressed and its effect is
// checked; then every page is photographed at 375, 768, 1024 and 1440 pixels wide.
//   node smoke/site-e2e.mjs [flow|intro|pages|shots|all]      (default all)
// The stack's addresses come from web/deployments/1.fork.json. SITE, RPC, GW and DEP in the environment override
// the defaults (http://127.0.0.1:8791, :8563, :8792, 1.fork).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "shots");
mkdirSync(OUT, { recursive: true });
const mode = process.argv[2] || "all";
if (!["flow", "intro", "pages", "shots", "all"].includes(mode)) { console.log("usage: node smoke/site-e2e.mjs [flow|intro|pages|shots|all]"); process.exit(2); }
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const SITE = process.env.SITE || "http://127.0.0.1:8791", RPC = process.env.RPC || "http://127.0.0.1:8563", GW = process.env.GW || "http://127.0.0.1:8792";
const DEP = process.env.DEP || "1.fork";
let dep = null;
try { dep = JSON.parse(readFileSync(join(here, "..", "web", "deployments", `${DEP}.json`), "utf8")); } catch {}
if (!dep) { console.log(`no deployment record web/deployments/${DEP}.json: run bash smoke/site-stack.sh first`); process.exit(2); }
const QS = `?intro=0&dep=${DEP}&rpc=${encodeURIComponent(RPC)}&gw=${encodeURIComponent(GW)}`;
// a page with nothing behind it: no deployment, and a gateway address nothing answers on (the real one must not be called from a test)
const NOGW = `gw=${encodeURIComponent("http://127.0.0.1:9")}`;
const ACCOUNT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // anvil account 1
const PORT = 9337;
const STACK_SKILL = "https://github.com/brownieshelper-glitch/brownies/pull/1"; // proposed and voted on by account 1 in site-stack.sh
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WALLET = `(() => {
  const RPC = ${JSON.stringify(RPC)}, ACCOUNT = ${JSON.stringify(ACCOUNT)};
  let id = 1;
  const rpc = async (method, params = []) => {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }) });
    const j = await r.json();
    if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; }
    return j.result;
  };
  const provider = {
    request: async ({ method, params }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [ACCOUNT];
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
      if (method === "eth_sendTransaction") return rpc("eth_sendTransaction", [{ ...params[0], from: ACCOUNT }]);
      return rpc(method, params || []);
    },
    on() {}, removeListener() {},
  };
  window.ethereum = provider;
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: { uuid: "t", name: "Test Wallet", icon: "", rdns: "test.wallet" }, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce); announce();
})();`;

async function rpc(method, params = []) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()).result;
}
// the chain's clock moves forward (anvil only), and the page is asked to read again: a hidden tab does not refresh itself
const timeJump = async (seconds) => { await rpc("evm_increaseTime", [seconds]); await rpc("evm_mine", []); };

// ---- browser ----
// a fresh profile and no extensions: a real wallet extension would otherwise load into the test browser
const profile = mkdtempSync(join(tmpdir(), "brownies-edge-"));
const edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--disable-extensions", "--disable-component-extensions-with-background-pages", "--no-default-browser-check", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let ws, seq = 0;
const waiting = new Map();
async function connect() {
  for (let i = 0; i < 60; i++) {
    try { const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); ws = new WebSocket(v.webSocketDebuggerUrl); break; } catch { await sleep(250); }
  }
  if (!ws) throw new Error("Edge did not open its debugging port " + PORT);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { const { res, rej, timer } = waiting.get(m.id); clearTimeout(timer); waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); return; }
    // what the page itself complains about: uncaught errors and console errors
    if (m.method === "Runtime.exceptionThrown") console.log("PAGE ERROR  " + String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text).split("\n").slice(0, 3).join(" | "));
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") console.log("PAGE CONSOLE  " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
  };
}
// every protocol call gives up after 45 seconds, so a stuck browser is reported and never hangs the run
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq;
  const timer = setTimeout(() => { waiting.delete(id); rej(new Error("browser did not answer: " + method)); }, 45000);
  waiting.set(id, { res, rej, timer });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

async function openPage(withWallet) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S("Page.enable"); await S("Runtime.enable"); await S("Page.bringToFront");
  if (withWallet) await S("Page.addScriptToEvaluateOnNewDocument", { source: WALLET });
  const ev = async (expr) => {
    const r = await S("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  let cur = { w: 1440, h: 900, mobile: false };
  const metrics = (w, h, mobile) => S("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
  const size = (w, h, mobile = false) => { cur = { w, h, mobile }; return metrics(w, h, mobile); };
  const go = async (url) => { await S("Page.navigate", { url }); for (let i = 0; i < 80; i++) { await sleep(150); if ((await ev("document.readyState")) === "complete") break; } await sleep(700); };
  // fold = true photographs only what a visitor sees first. Otherwise the whole page: the window is made as tall
  // as the page first, because a capture beyond the window re-lays-out a page that sizes things by window height.
  const shot = async (name, fold = false) => {
    await S("Page.bringToFront");
    if (fold) {
      const r = await S("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: cur.w, height: cur.h, scale: 1 } });
      writeFileSync(join(OUT, name), Buffer.from(r.data, "base64"));
      return { w: cur.w, h: cur.h };
    }
    let m = await S("Page.getLayoutMetrics");
    await metrics(cur.w, Math.min(Math.ceil(m.cssContentSize.height), 9000), cur.mobile);
    await sleep(400);
    m = await S("Page.getLayoutMetrics");
    const w = Math.ceil(m.cssContentSize.width), h = Math.min(Math.ceil(m.cssContentSize.height), 9000);
    await metrics(cur.w, h, cur.mobile);
    await sleep(250);
    const r = await S("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
    writeFileSync(join(OUT, name), Buffer.from(r.data, "base64"));
    await metrics(cur.w, cur.h, cur.mobile);
    return { w, h };
  };
  const close = () => send("Target.closeTarget", { targetId });
  const media = (features) => S("Emulation.setEmulatedMedia", { features });
  return { ev, size, go, shot, close, media };
}

const results = [];
const ok = (name, cond, detail = "") => { results.push({ name, pass: !!cond, detail }); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`); };
const until = async (fn, ms = 30000, step = 300) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await sleep(step); } return false; };

// The app, with the test wallet: every button in the order a visitor would press them.
async function flow() {
  const p = await openPage(true);
  await p.size(1440, 900);
  await p.go(`${SITE}/app.html${QS}`);
  const text = (id) => p.ev(`document.getElementById(${JSON.stringify(id)}).textContent.trim()`);
  const num = async (id) => Number((await text(id)).replace(/[^0-9.]/g, "") || "0");
  const click = async (id) => { await until(() => p.ev(`!document.getElementById(${JSON.stringify(id)}).disabled`), 20000); return p.ev(`document.getElementById(${JSON.stringify(id)}).click()`); };
  const type = (id, v) => p.ev(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(String(v))}; el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  const lastToast = () => p.ev(`(() => { const t = [...document.querySelectorAll("#toasts .toast")]; return t.length ? t[t.length - 1].textContent : ""; })()`);
  const clearToasts = () => p.ev(`document.querySelectorAll("#toasts .toast").forEach(t => t.remove())`);
  const idle = (id) => until(async () => !(await p.ev(`document.getElementById(${JSON.stringify(id)}).classList.contains("busy")`)), 60000);
  const refresh = () => p.ev("window.BrowniesApp.refresh()");
  // the skills list, one entry by the address of the skill
  const skillLi = (uri) => `[...document.querySelectorAll("#skills li")].find((li) => (li.querySelector(".what a")?.href || li.querySelector(".what")?.textContent) === ${JSON.stringify(uri)})`;
  const skillMeta = (uri) => p.ev(`(${skillLi(uri)})?.querySelector(".meta")?.textContent || ""`);
  const skillButtons = (uri) => p.ev(`[...((${skillLi(uri)})?.querySelectorAll(".acts button") || [])].map((b) => b.textContent + (b.disabled ? " (off)" : "")).join(", ")`);
  const pressSkill = (uri, label) => p.ev(`(() => { const b = [...((${skillLi(uri)})?.querySelectorAll(".acts button") || [])].find((x) => x.textContent === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); return true; })()`);
  // what the vault has counted for helper 0, read through the page's own contracts
  const tippedTo0 = async () => BigInt(await p.ev(`window.Brownies.load().then((S) => S.vault.tippedTo(0)).then((v) => v.toString())`));

  ok("buttons are disabled before a wallet connects", await p.ev(`document.getElementById("btnStake").disabled && document.getElementById("btnClaim").disabled && document.getElementById("btnTip").disabled && document.getElementById("btnSubmitSkill").disabled`));
  ok("the protocol numbers load without a wallet", await until(async () => (await text("pStaked")).includes("BROWNIE")), await text("pStaked"));
  ok("the tip box lists the four brownies", await until(() => p.ev(`document.querySelectorAll("#tipWho option").length === 4`)), await p.ev(`[...document.querySelectorAll("#tipWho option")].map((o) => o.textContent).join(", ")`));
  ok("the skills list shows the stack's proposal", await until(() => p.ev(`document.querySelectorAll("#skills li").length >= 1`)) && (await skillMeta(STACK_SKILL)).includes("asks 5 SUGAR"), await skillMeta(STACK_SKILL));

  await click("connectBtn");
  ok("the wallet picker lists the wallet", await until(() => p.ev(`!!document.querySelector("#walletList .wallet-item")`)));
  await p.ev(`document.querySelector("#walletList .wallet-item").click()`);
  ok("connected: the address chip shows", await until(async () => (await text("walletAddr")).startsWith("0x7099")), await text("walletAddr"));
  ok("wallet balances are read", await until(async () => (await num("vWallet")) > 0 && (await num("vUsdc")) > 0 && (await num("vStaked")) >= 10000), `BROWNIE ${await text("vWallet")}, staked ${await text("vStaked")}, USDC ${await text("vUsdc")}`);

  // stake (approve, then stake)
  const before = await num("vWallet"), staked0 = await num("vStaked");
  await type("inStake", "50000");
  await click("btnStake");
  ok("stake goes through (approve then stake)", await until(async () => (await num("vStaked")) >= staked0 + 50000, 60000), `staked ${await text("vStaked")}, toast "${await lastToast()}"`);
  await idle("btnStake");
  ok("the wallet balance fell by the stake", Math.abs(before - (await num("vWallet")) - 50000) < 1);
  // the stake's age is the average of the old coins (a day, from the stack) and the new ones (now): still under a day
  ok("a young stake shows no loyalty bonus yet, and says when the first one comes", (await text("vBoost")) === "none yet" && /^Your stake is \d+ days? old\. It earns 10% more from day 30\./.test(await text("boostHint")), `${await text("vBoost")} | ${await text("boostHint")}`);

  // a stake under the minimum is refused before any transaction
  await clearToasts();
  await type("inStake", "abc"); await click("btnStake"); await sleep(300);
  ok("a bad amount is refused with a sentence", (await lastToast()).includes("Type an amount"), await lastToast());

  // collect the tax (the keeper's job, pressed by hand): 0.1 WETH of fee waits in the harvester; then let the hour stream
  await click("btnCollect");
  ok("collect the tax goes through", await until(async () => (await lastToast()).startsWith("Collected"), 60000), await lastToast());
  await idle("btnCollect");
  ok("the stream is running", await until(async () => (await num("pStream")) > 0), await text("pStream"));
  ok("the AI team vault received its 10% and shows a daily budget", await until(async () => (await num("pVault")) > 0 && (await num("pTeam")) > 0), `vault ${await text("pVault")}, today ${await text("pTeam")}`);
  await timeJump(1800);
  console.log("      (tab hidden in this browser: " + (await p.ev("document.hidden")) + ", so the test asks the page to refresh)");
  await refresh();
  ok("SUGAR is being earned", await until(async () => (await num("vEarned")) > 0, 30000), await text("vEarned"));

  await clearToasts();
  await click("btnClaim");
  ok("claim puts SUGAR in the wallet", await until(async () => (await num("vSugar")) > 0, 40000), `SUGAR "${await text("vSugar")}", toast "${await lastToast()}", button "${await text("btnClaim")}"`);
  await idle("btnClaim");

  // activate everything claimed
  await click("maxActivate");
  const toActivate = Number(await p.ev(`document.getElementById("inActivate").value`));
  await click("btnActivate");
  ok("activate moves SUGAR onto the key", await until(async () => (await num("vBalance")) >= toActivate * 0.999, 60000), `balance ${await text("vBalance")}`);
  await idle("btnActivate");

  // the key
  await click("btnKey");
  ok("show my key displays a key", await until(async () => (await text("keyBox")).startsWith("sk-brownie-0-")), (await text("keyBox")).slice(0, 18) + "...");

  // buy and activate 3 USDC
  const bal0 = await num("vBalance");
  await type("inBuy", "3");
  await click("btnBuyAct");
  ok("buy and activate adds 3 dollars to the key", await until(async () => (await num("vBalance")) >= bal0 + 2.999, 60000), `balance ${await text("vBalance")}`);
  await idle("btnBuyAct");
  // buy to wallet 2 USDC
  const sp0 = await num("vSugar");
  await type("inBuy", "2");
  await click("btnBuy");
  ok("buy to wallet adds 2 SUGAR", await until(async () => (await num("vSugar")) >= sp0 + 1.999, 60000), `SUGAR ${await text("vSugar")}`);
  await idle("btnBuy");

  // try the key: the stack's gateway talks to a stand-in upstream (smoke/mock-upstream.mjs), so no real model is called
  const hasTry = await p.ev(`!document.getElementById("tryPanel").hidden`);
  ok("the try panel is shown when the gateway is known", hasTry);
  const model = await until(() => p.ev(`!!document.getElementById("inModel").value`), 15000) ? await p.ev(`document.getElementById("inModel").value`) : "";
  ok("a model from the gateway's catalogue is picked", model.startsWith("test/"), model);
  await p.ev(`(() => { const el = document.getElementById("inPrompt"); el.value = "Say hello in five words."; })()`);
  const balBefore = await num("vBalance");
  await click("btnSend");
  const replied = await until(() => p.ev(`!document.getElementById("reply").hidden`), 90000);
  ok("a model answers through the gateway", replied && (await text("reply")).includes("Hello from the test model"), replied ? (await text("reply")).replace(/\s+/g, " ").slice(0, 110) : await lastToast());
  await idle("btnSend");
  ok("the request was charged to the balance", await until(async () => (await num("vSpent")) > 0 || (await num("vBalance")) < balBefore, 15000), `model ${model}, spent ${await text("vSpent")}`);

  // replace the key
  await click("btnRotate");
  ok("replace my key makes an epoch 1 key", await until(async () => (await text("keyBox")).startsWith("sk-brownie-1-"), 30000), (await text("keyBox")).slice(0, 18) + "...");
  await idle("btnRotate");

  // tip a brownie: half a SUGAR to the first on the payroll (approve, then tip); the vault counts it for that helper
  await clearToasts();
  const tipName = await p.ev(`document.querySelector("#tipWho option").textContent`);
  const tipped0 = await tippedTo0(), sugarBeforeTip = await num("vSugar");
  await p.ev(`(() => { const s = document.getElementById("tipWho"); s.value = s.options[0].value; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await type("inTip", "0.5");
  await click("btnTip");
  ok("tip goes through (approve then tip) and the vault counts it for the brownie", await until(async () => (await tippedTo0()) === tipped0 + 500000n, 60000), `${tipName}: tipped ${Number(tipped0) / 1e6} then ${Number(await tippedTo0()) / 1e6} SUGAR, toast "${await lastToast()}"`);
  await idle("btnTip");
  ok("the tip thanks the brownie by name", (await lastToast()).startsWith(`Tipped. ${tipName} says thank you.`), await lastToast()); // the toast carries an explorer link after the sentence
  ok("the tip left the wallet", await until(async () => Math.abs(sugarBeforeTip - (await num("vSugar")) - 0.5) < 0.002, 20000), `SUGAR ${sugarBeforeTip} then ${await text("vSugar")}`);
  // a tip over the wallet's SUGAR is refused before any transaction
  await clearToasts();
  await type("inTip", "999999"); await click("btnTip"); await sleep(300);
  ok("a tip the wallet cannot pay is refused with a sentence", (await lastToast()).includes("do not have that much SUGAR"), await lastToast());

  // unstake everything (the stack's 10,000 and the 50,000 of this run)
  await type("inStake", String(await num("vStaked")));
  await click("btnUnstake");
  ok("unstake returns the BROWNIE", await until(async () => (await num("vStaked")) === 0, 60000), `staked "${await text("vStaked")}"`);
  await idle("btnUnstake");

  // the loyalty bonus: stake, let 31 days pass, apply
  await type("inStake", "60000"); await click("btnStake");
  await until(async () => (await num("vStaked")) >= 60000, 60000); await idle("btnStake");
  await timeJump(31 * 86400);
  await refresh();
  ok("after 31 days the page offers the bonus", await until(() => p.ev(`!document.getElementById("btnPoke").hidden`), 20000), await text("boostHint"));
  await click("btnPoke");
  ok("apply my bonus sets +10%", await until(async () => (await text("vBoost")) === "+10%", 60000), await text("vBoost"));
  await idle("btnPoke");
  await type("inStake", "60000"); await click("btnUnstake");
  await until(async () => (await num("vStaked")) === 0, 60000); await idle("btnUnstake");

  // leave a stake and a visible state for the screenshots
  await type("inStake", "120000"); await click("btnStake");
  await until(async () => (await num("vStaked")) >= 120000, 60000); await idle("btnStake");

  // skills. The stake must be a day old to propose or vote, so a day passes first. The stack's proposal closed
  // while the days went by: it is settled, then a new skill is proposed, voted on, and settled after its 3 days.
  await timeJump(86401);
  await refresh();
  ok("a closed vote offers Settle", await until(async () => (await skillMeta(STACK_SKILL)).includes("waiting to be settled") && (await skillButtons(STACK_SKILL)) === "Settle", 20000), `${await skillMeta(STACK_SKILL)} [${await skillButtons(STACK_SKILL)}]`);
  await pressSkill(STACK_SKILL, "Settle");
  ok("settle pays the passed skill from the vault", await until(async () => /passed, paid [\d.,]+ SUGAR/.test(await skillMeta(STACK_SKILL)), 60000), await skillMeta(STACK_SKILL));
  const n0 = await p.ev(`document.querySelectorAll("#skills li").length`);
  const URI = `https://github.com/brownieshelper-glitch/brownies/pull/${n0 + 1}`;
  await clearToasts();
  await type("inSkillUri", URI); await type("inSkillAsk", "1");
  await click("btnSubmitSkill");
  ok("propose a skill opens a 3-day vote", await until(async () => (await skillMeta(URI)).includes("vote open"), 60000), `${await skillMeta(URI)} | toast "${await lastToast()}"`);
  await idle("btnSubmitSkill");
  ok("the new proposal is first in the list and links to its repository", await p.ev(`document.querySelector("#skills li .what a")?.href === ${JSON.stringify(URI)} && document.querySelector("#skills li .what a").target === "_blank"`));
  ok("the proposal shows the ask, the author, the count and the bar", /^asks 1 SUGAR, by 0x7099\.\.\.79C8, vote open, closes \d+ \w+ \d{4}\. yes 0, no 0, bar [\d,]+$/.test(await skillMeta(URI)), await skillMeta(URI));
  ok("a staker is offered Yes and No", (await skillButtons(URI)) === "Yes, No", await skillButtons(URI));
  await pressSkill(URI, "Yes");
  ok("a yes vote is counted with the stake's weight", await until(async () => /You voted\./.test(await skillMeta(URI)) && /yes [1-9][\d,]*, no 0/.test(await skillMeta(URI)), 60000), await skillMeta(URI));
  ok("a wallet that voted gets no second vote", (await skillButtons(URI)) === "", `[${await skillButtons(URI)}]`);
  await timeJump(3 * 86400 + 1);
  await refresh();
  ok("after 3 days the vote is closed and waits to be settled", await until(async () => (await skillMeta(URI)).includes("vote closed, waiting to be settled") && (await skillButtons(URI)) === "Settle", 20000), await skillMeta(URI));
  const sugarBeforePay = await num("vSugar");
  await pressSkill(URI, "Settle");
  ok("settle pays the author the SUGAR asked", await until(async () => /passed, paid 1 SUGAR/.test(await skillMeta(URI)), 60000), await skillMeta(URI));
  ok("the author's wallet received it", await until(async () => (await num("vSugar")) >= sugarBeforePay + 0.999, 20000), `SUGAR ${sugarBeforePay} then ${await text("vSugar")}`);
  ok("a settled skill offers no button", (await skillButtons(URI)) === "");

  await clearToasts();
  await sleep(600);
  await p.shot("app-1440-connected.png");
  await p.size(375, 812, true); await sleep(500);
  await p.shot("app-375-connected.png");
  await p.close();

  // the Kitchen shows the tip on the brownie's card
  const k = await openPage(false);
  await k.size(1440, 900);
  await k.go(`${SITE}/team.html${QS}`);
  const tipsOn = (name) => k.ev(`(() => { const c = [...document.querySelectorAll("#crew .live-card")].find((c) => c.querySelector("h3").textContent === ${JSON.stringify(name)}); const row = c && [...c.querySelectorAll("dl div")].find((d) => d.querySelector("dt").textContent === "Tips" && !d.hidden); return row ? row.querySelector("dd").textContent : ""; })()`);
  ok("kitchen: the brownie's card shows the tip", await until(async () => Number((await tipsOn(tipName)).replace(/[^0-9.]/g, "")) >= 0.5, 20000), `${tipName}: ${await tipsOn(tipName)}`);
  await k.close();
}

// The intro on the home page: it plays once per visit, the brownies move and eat, Enter lifts it.
async function intro() {
  const wait = (fn, ms = 15000, step = 300) => until(fn, ms, step);
  const p = await openPage(false);
  const on = () => p.ev(`document.documentElement.classList.contains("intro-on")`);
  const st = () => p.ev(`window.BrowniesIntro.state()`);
  await p.size(1440, 900);
  await p.go(`${SITE}/`);
  ok("first visit: the intro covers the page", (await on()) && (await p.ev(`document.querySelector("main").inert === true && getComputedStyle(document.getElementById("intro")).position === "fixed"`)));
  await sleep(2400);
  const a = await st();
  ok("the four brownies are on the stage", a.actors.length === 4 && a.actors.every((x) => x.x > 0 && x.x < a.w), a.actors.map((x) => x.id + " " + x.x).join(", "));
  await p.shot("intro-1440.png", true);
  await sleep(1200);
  const b = await st();
  ok("they keep moving", a.actors.some((x, i) => Math.abs(x.x - b.actors[i].x) > 40 || x.y !== b.actors[i].y));
  const eaten = async () => (await st()).actors.reduce((n, x) => n + x.score, 0);
  await wait(async () => (await st()).cubes === 0, 12000);
  const before = await eaten();
  await p.ev(`document.getElementById("intro").dispatchEvent(new PointerEvent("pointerdown", { clientX: 900, clientY: 260, bubbles: true }))`);
  ok("a click drops a cube", (await st()).cubes >= 1);
  ok("a brownie eats the cube", await wait(async () => (await eaten()) > before), `eaten ${await eaten()}`);
  await p.ev(`document.getElementById("introEnter").click()`);
  ok("Enter the site lifts the intro", await wait(() => p.ev(`!document.getElementById("intro") && !document.documentElement.classList.contains("intro-on") && document.querySelector("main").inert === false`), 5000));
  ok("the page under it is the home page", await p.ev(`document.querySelector(".hero h1").getBoundingClientRect().top < 400 && document.querySelectorAll(".lineup.all .m").length === 4`));
  await p.shot("intro-after-enter-1440.png", true);
  await p.go(`${SITE}/`);
  ok("the same visit does not see the intro twice", !(await on()));
  await p.go(`${SITE}/?intro=1`);
  ok("?intro=1 plays it again", await on());
  await p.ev(`sessionStorage.clear()`);
  await p.go(`${SITE}/?intro=0`);
  ok("?intro=0 skips it", !(await on()));
  await p.go(`${SITE}/#team`);
  ok("a link to a part of the page skips it", !(await on()));
  await p.media([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await p.go(`${SITE}/`);
  ok("a visitor who asked for less motion skips it", !(await on()));
  await p.media([]);
  await p.size(375, 812, true);
  await p.go(`${SITE}/`);
  await sleep(2600);
  ok("phone: the intro plays and fits", (await on()) && (await p.ev(`document.documentElement.scrollWidth <= 375 && document.getElementById("introEnter").getBoundingClientRect().height >= 44`)));
  await p.shot("intro-375.png", true);
  await p.close();
}

// The Kitchen and Progress pages, fed by the reports that smoke/seed-team.mjs wrote and by the fork.
async function pages() {
  const wait = (fn, ms = 15000, step = 300) => until(fn, ms, step);
  const p = await openPage(false);
  await p.size(1440, 900);
  await p.go(`${SITE}/team.html${QS}`);
  ok("kitchen: the reports load", await wait(() => p.ev(`document.querySelectorAll("#feed li").length >= 8`)), `${await p.ev(`document.querySelectorAll("#feed li").length`)} reports`);
  ok("kitchen: one card per brownie", (await p.ev(`document.querySelectorAll("#crew .live-card").length`)) === 4);
  const now = (name) => p.ev(`[...document.querySelectorAll("#crew .live-card")].find((c) => c.querySelector("h3").textContent === ${JSON.stringify(name)}).querySelector(".now").textContent`);
  ok("kitchen: a fresh task shows as Now", (await now("Fudge")).startsWith("Now: Writing tomorrow"), await now("Fudge"));
  ok("kitchen: an old task shows as resting", (await now("Nib")).startsWith("Resting. Last report"), await now("Nib"));
  ok("kitchen: the chain's numbers are on the cards", await wait(() => p.ev(`[...document.querySelectorAll("#crew .live-card dt")].filter((d) => d.textContent === "Fed by the vault" && !d.parentElement.hidden).length === 4 && [...document.querySelectorAll("#crew .live-card dt")].filter((d) => d.textContent === "Tips" && !d.parentElement.hidden).length === 4`)));
  ok("kitchen: markup in a report is shown as text and never runs", await p.ev(`window.__pwned === undefined && document.querySelector("#feed").textContent.includes("<img src=x onerror") && document.querySelectorAll("#feed img, #feed script").length === 0`));
  ok("kitchen: a link in a report opens the proof in a new tab", await p.ev(`[...document.querySelectorAll("#feed a.link")].every((a) => a.href.startsWith("https://") && a.target === "_blank" && a.rel.includes("noopener")) && document.querySelectorAll("#feed a.link").length >= 2`));
  await p.ev(`[...document.querySelectorAll("#who button")].find((b) => b.textContent === "Crumb").click()`);
  ok("kitchen: the filter shows one brownie", await wait(() => p.ev(`(() => { const n = [...document.querySelectorAll("#feed li .meta b")].map((b) => b.textContent); return n.length >= 2 && n.every((x) => x === "Crumb"); })()`)));

  // the building site: 231 jobs are two finished towers and 31 bricks of the third
  const site = () => p.ev(`window.BrowniesTeam.site.state()`);
  await wait(async () => { const s = await site(); return s.total === 231 && s.view === 2; });
  const s0 = await site();
  ok("site: it opens on the tower being built", s0.view === 2 && s0.latest === 2 && s0.total === 231 && (await p.ev(`document.querySelector(".site-title").textContent`)) === "Tower 3", JSON.stringify(s0));
  ok("site: the brownies lay the last bricks one by one", await wait(async () => { const s = await site(); return s.bricks === 31 && s.landed === 31 && s.queued === 0; }, 60000, 500), JSON.stringify(await site()));
  const s1 = await site(); await sleep(4500); const s2 = await site();
  ok("site: the brownies keep moving", s1.xs.some((x, i) => Math.abs(x - s2.xs[i]) > 20), s1.xs.join(",") + " then " + s2.xs.join(","));
  await p.ev(`document.querySelector('#site .brick[data-n="30"]').dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
  ok("site: a brick shows the job behind it", (await p.ev(`document.querySelector(".site-info .what").textContent`)) === "Helped a holder find the staking page" && (await p.ev(`document.querySelector(".site-info .meta").textContent`)).includes("Brick 31"), await p.ev(`document.querySelector(".site-info .meta").textContent`));
  await p.ev(`document.querySelector('#site .brick[data-n="29"]').dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
  ok("site: markup in a job is shown as text there too", await p.ev(`window.__pwned === undefined && document.querySelector(".site-info .what").textContent.startsWith("<img src=x") && document.querySelectorAll(".site-info img, .site-info script").length === 0`));
  await p.ev(`document.querySelector("#site .actor").dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
  ok("site: a click on a brownie says what it is doing", (await p.ev(`document.querySelector(".site-info .meta").textContent`)) === "Fudge, marketing." && (await p.ev(`document.querySelector(".site-info .what").textContent`)).startsWith("Now: Writing"), await p.ev(`document.querySelector(".site-info .what").textContent`));
  await p.ev(`document.querySelector(".site-older").click()`);
  ok("site: an older tower is whole, with its roof", await wait(async () => { const s = await site(); return s.view === 1 && s.bricks === 100 && s.roof; }) && (await p.ev(`document.querySelector(".site-count").textContent`)) === "Finished. 100 bricks.", JSON.stringify(await site()));
  await p.shot("kitchen-tower2-1440.png", true);

  await p.go(`${SITE}/progress.html${QS}`);
  ok("progress: the numbers come from the chain", await wait(() => p.ev(`!document.getElementById("numbers").hidden && document.getElementById("numbersList").textContent.includes("Paid to stakers") && document.getElementById("numbersList").textContent.includes("Skills proposed by stakers")`)), await p.ev(`[...document.querySelectorAll("#numbersList div")].slice(0, 3).map((d) => d.textContent).join(" | ")`));
  ok("progress: the last 7 days count the reports", await wait(() => p.ev(`!document.getElementById("week").hidden`)) && (await p.ev(`[...document.querySelectorAll("#weekList div")].find((d) => d.firstChild.textContent === "Posts").lastChild.textContent`)) === "2");
  ok("progress: the city has a tower for every 100 jobs", await wait(() => p.ev(`(() => { const t = [...document.querySelectorAll("#city a.tower")]; return t.length === 3 && t.map((a) => a.getAttribute("data-count")).join() === "100,100,31" && document.querySelectorAll("#city .roof").length === 2 && document.querySelectorAll("#city .lot").length >= 3; })()`)), await p.ev(`document.getElementById("cityLine").textContent`));
  ok("progress: the line counts the jobs", (await p.ev(`document.getElementById("cityLine").textContent`)) === "231 jobs done. The brownies are on tower 3.");
  ok("progress: a tower links to the kitchen", await p.ev(`document.querySelectorAll("#city a.tower")[1].getAttribute("href").includes("team.html?") && document.querySelectorAll("#city a.tower")[1].getAttribute("href").includes("tower=2")`));
  ok("progress: milestones, newest first", await p.ev(`(() => { const t = [...document.querySelectorAll("#miles .what")].map((x) => x.textContent); return t.length === 3 && t[0] === "Tip button shipped" && t[2] === "BROWNIE launched on Pons"; })()`));

  // the Bakery: with no Bakery behind the gateway the pages keep their fixed facts; in demo mode a holder bakes,
  // instructs, feeds and retires a brownie, and the shelf shows it
  await p.go(`${SITE}/bakery.html${QS}`);
  await sleep(500);
  ok("bakery with nothing behind it: the three steps, the fixed minimum, an empty shelf line, no oven count", await p.ev(`document.querySelectorAll(".bakery-how li").length === 3 && document.getElementById("minHold").textContent === "10,000" && !document.getElementById("shelfEmpty").hidden && document.getElementById("oven").hidden && document.querySelectorAll("#shelf .baked-card").length === 0`));
  await p.go(`${SITE}/bake.html${QS}`);
  await sleep(500);
  ok("bake with nothing behind it: the gate says the Bakery is closed, the button is disabled", await p.ev(`!document.getElementById("gate").hidden && document.getElementById("btnSignIn").disabled && document.getElementById("btnSignIn").textContent === "The Bakery is closed right now" && !document.getElementById("gateHint").hidden`));
  await p.go(`${SITE}/bakery.html?demo=1&${QS.slice(1)}`);
  await wait(() => p.ev(`document.querySelectorAll("#shelf .baked-card").length === 3`));
  ok("bakery demo: three brownies on the shelf, newest first, each with a face, its holder and its jobs", await p.ev(`(() => { const c = [...document.querySelectorAll("#shelf .baked-card")]; return c[0].querySelector("h3").textContent === "Sage" && c.every((x) => x.querySelector(".pic svg") && /baked by 0x/.test(x.querySelector(".job").textContent) && x.querySelectorAll(".jobs li").length >= 1); })()`));
  ok("bakery demo: the oven count", await p.ev(`document.getElementById("oven").textContent === "3 baked, 47 places left" && !document.getElementById("oven").hidden`));
  ok("bakery demo: a brownie with no work yet says so, one with work shows the latest", await p.ev(`(() => { const c = [...document.querySelectorAll("#shelf .baked-card")]; const rook = c.find((x) => x.querySelector("h3").textContent === "Rook"); const sage = c[0]; return rook.querySelector(".count").textContent === "No job done yet" && !rook.querySelector(".latest") && sage.querySelector(".latest .what").textContent.startsWith("Quiet day."); })()`));
  await p.go(`${SITE}/bake.html?demo=form&${QS.slice(1)}`);
  await wait(() => p.ev(`!document.getElementById("formWrap").hidden`));
  ok("bake demo: a holder who may bake sees the form with the five menu jobs and their hours", await p.ev(`document.getElementById("bakeStatus").textContent === "This wallet holds 24,500 BROWNIE. You can bake." && document.querySelectorAll("#jobMenu li.job").length === 5 && document.querySelector("#jobMenu li.job select.job-hour").value === "9" && document.getElementById("inModel").options.length >= 6 && document.querySelectorAll("#inModel optgroup").length >= 4`));
  await p.ev(`document.getElementById("inName").value = "Sage"; document.getElementById("inRole").value = "watches the coin for me and explains what moved"; document.getElementById("inPersonality").value = "calm, a little dry"; document.querySelector("#jobMenu li.job input").checked = true; document.querySelector("#jobMenu li.job select.job-hour").value = "7"; document.getElementById("bakeForm").requestSubmit();`);
  await wait(() => p.ev(`!document.getElementById("mine").hidden`));
  ok("bake demo: the form bakes it and the page shows the brownie with its job at the chosen hour", await p.ev(`document.getElementById("mineName").textContent === "Sage" && document.getElementById("mineJobs").textContent.includes("Daily watch, at 7:00") && document.getElementById("mineFace").querySelector("svg") && document.getElementById("mineFeedEmpty").textContent === "Nothing yet. It works at 7:00."`));
  ok("bake demo: the fund panel asks for one signature and shows no grant yet", await p.ev(`!document.getElementById("btnFund").hidden && document.getElementById("btnFund").textContent === "Sign once and set the grant" && document.getElementById("btnRevoke").hidden`));
  await p.ev(`document.getElementById("btnFund").click()`);
  await wait(() => p.ev(`!document.getElementById("fundFacts").hidden`));
  ok("bake demo: the grant is set and shown, and can be stopped", await p.ev(`document.getElementById("fundFacts").textContent.includes("1.00 USD a day") && !document.getElementById("btnRevoke").hidden`));
  await p.ev(`document.getElementById("inAsk").value = "Write one line about SUGAR."; document.getElementById("askForm").requestSubmit();`);
  await wait(() => p.ev(`document.querySelectorAll("#mineFeed li").length === 1`), 5000);
  ok("bake demo: an instruction lands in the feed and counts down", await p.ev(`document.querySelectorAll("#mineFeed li").length === 1 && document.getElementById("askHint").textContent.startsWith("2 instructions left")`));
  await p.ev(`window.confirm = () => true; document.getElementById("btnRetire").click()`);
  await wait(() => p.ev(`!document.getElementById("formWrap").hidden`));
  ok("bake demo: retiring brings the form back", await p.ev(`document.getElementById("mine").hidden && !document.getElementById("formWrap").hidden`));
  await p.go(`${SITE}/bake.html?demo=1&${QS.slice(1)}`);
  await wait(() => p.ev(`!document.getElementById("mine").hidden`));
  ok("bake demo: a holder with a brownie lands on it, with its feed and a live grant", await p.ev(`document.getElementById("mineName").textContent === "Sage" && document.querySelectorAll("#mineFeed li").length === 3 && document.getElementById("mineFacts").textContent.includes("Jobs done14")`));
  await p.ev(`document.getElementById("btnLink").click()`);
  await wait(() => p.ev(`!document.getElementById("linkHint").hidden`));
  ok("bake demo: Link Telegram gives a code to send to the bot", await p.ev(`document.getElementById("linkHint").textContent.includes("/link 123456") && document.getElementById("linkHint").textContent.includes("@feedthebrownies_bot") && document.getElementById("btnUnlink").hidden`));

  // with no deployment and no gateway: the pages still stand, with nothing empty or broken on show
  await p.go(`${SITE}/team.html?${NOGW}`);
  await sleep(600);
  ok("kitchen with nothing behind it: an empty lot and four brownies", await p.ev(`document.querySelectorAll("#site .actor").length === 4 && document.querySelectorAll("#site .brick").length === 0 && document.querySelector(".site-count").textContent === "0 of 100 bricks" && document.querySelector(".site-info .what").textContent.startsWith("No bricks yet")`));
  ok("kitchen with nothing behind it: the four cards and a plain empty line", await p.ev(`document.querySelectorAll("#crew .live-card").length === 4 && !document.getElementById("feedEmpty").hidden && document.getElementById("who").hidden && [...document.querySelectorAll("#crew .now")].every((n) => n.hidden)`));
  await p.go(`${SITE}/progress.html?${NOGW}`);
  await sleep(600);
  ok("progress with nothing behind it: empty lots, no empty blocks", await p.ev(`document.querySelectorAll("#city .lot").length >= 6 && document.querySelectorAll("#city a.tower").length === 0 && document.getElementById("figures").hidden && !document.getElementById("milesEmpty").hidden`));
  await p.close();
}

async function shots() {
  const p = await openPage(false);
  const list = [["home", `/${QS}`], ["app", `/app.html${QS}`], ["docs", `/docs.html${QS}`], ["team", `/team.html${QS}`], ["progress", `/progress.html${QS}`], ["posts", `/posts.html${QS}`], ["chat", `/chat.html${QS}`], ["bakery", `/bakery.html${QS}`], ["bake", `/bake.html${QS}`], ["bakery-demo", `/bakery.html?demo=1&${QS.slice(1)}`], ["bake-demo", `/bake.html?demo=1&${QS.slice(1)}`], ["bake-form", `/bake.html?demo=form&${QS.slice(1)}`], ["admin", `/admin.html${QS}`]];
  for (const [name, path] of list) {
    for (const w of [1920, 1440, 1024, 768, 375]) {
      await p.size(w, w === 375 ? 812 : 900, w === 375);
      await p.go(SITE + path);
      if (name === "team" || name === "progress") await sleep(1500);
      if (name === "app") await until(() => p.ev(`document.querySelectorAll("#skills li").length >= 1 && document.querySelectorAll("#tipWho option").length === 4`), 15000);
      const overflow = await p.ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
      if (name === "home") await p.shot(`${name}-${w}-fold.png`, true);
      const m = await p.shot(`${name}-${w}.png`);
      ok(`${name} at ${w}: no sideways scroll`, overflow <= 0, `overflow ${overflow}px, page ${m.w}x${m.h}`);
    }
    // the words on the page, for reading
    const txt = await p.ev(`document.body.innerText`);
    writeFileSync(join(OUT, `${name}.txt`), txt);
    const bad = [...new Set([...txt].filter((c) => c.charCodeAt(0) > 126))];
    ok(`${name}: only plain keyboard characters`, bad.length === 0, bad.length ? "found " + bad.map((c) => "U+" + c.charCodeAt(0).toString(16)).join(" ") : "");
    // links inside running text are exempt, like everywhere on the web; buttons and standalone links are not
    const small = await p.ev(`[...document.querySelectorAll("a, button")].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 44 && !e.closest("pre") && !e.closest(".prose p, .prose li, .prose td, .foot p, .hint, td.addr, .skills .what"); }).map(e => (e.textContent || e.id).trim().slice(0, 24) + " " + Math.round(e.getBoundingClientRect().height))`);
    ok(`${name} at 375: tap targets are at least 44px`, small.length === 0, small.join(" | "));
  }
  // the page with no deployment at all: nothing broken, nothing empty on show
  await p.size(1440, 900);
  await p.go(`${SITE}/index.html?intro=0&${NOGW}`);
  ok("home without a deployment hides the live numbers", await p.ev(`document.getElementById("live").hidden`));
  await p.go(`${SITE}/app.html?${NOGW}`);
  await p.shot("app-1440-nodeploy.png");
  ok("app without a deployment keeps its buttons disabled", await p.ev(`document.getElementById("btnStake").disabled && document.getElementById("btnTip").disabled && document.getElementById("btnSubmitSkill").disabled`));
  await p.close();
}

try {
  await connect();
  if (mode === "flow" || mode === "all") await flow();
  if (mode === "intro" || mode === "all") await intro();
  if (mode === "pages" || mode === "all") await pages();
  if (mode === "shots" || mode === "all") await shots();
} catch (e) {
  console.log("ERROR", e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  edge.kill(); // only the Edge this run started
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) process.exitCode = 1;
}
