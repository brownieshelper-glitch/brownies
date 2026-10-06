// Opens the app page in headless Edge and checks the tip and skills sections render from the fork. No wallet.
//   node smoke/eth-site-check.mjs <url>
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const url = process.argv[2], PORT = 9335, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const edge = spawn("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--disable-extensions", `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "brownies-ethcheck-"))}`, "about:blank"], { stdio: "ignore" });
let ws, seq = 0; const waiting = new Map(), errors = [];
for (let i = 0; i < 60; i++) { try { const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); ws = new WebSocket(v.webSocketDebuggerUrl); break; } catch { await sleep(250); } }
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { const { res, rej } = waiting.get(m.id); waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } if (m.method === "Runtime.exceptionThrown") errors.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text).split("\n")[0]); };
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, sessionId })); setTimeout(() => rej(new Error("timeout " + method)), 45000); });
let fails = 0;
const ok = (name, cond, detail = "") => { fails += cond ? 0 : 1; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`); };
try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S("Page.enable"); await S("Runtime.enable"); await S("Page.bringToFront");
  await S("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await S("Page.navigate", { url });
  const ev = async (expr) => { const r = await S("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const wait = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await sleep(400); } return false; };
  ok("the protocol numbers load from the fork", await wait(() => ev(`document.getElementById("pStaked").textContent.includes("BROWNIE")`)), await ev(`document.getElementById("pStaked").textContent`));
  ok("the tip box lists the four brownies", await wait(() => ev(`document.querySelectorAll("#tipWho option").length === 4`)), await ev(`[...document.querySelectorAll("#tipWho option")].map((o) => o.textContent).join(", ")`));
  ok("the skills list shows the proposal with its vote", await wait(() => ev(`document.querySelectorAll("#skills li").length === 1`)) && (await ev(`document.querySelector("#skills .meta").textContent`)).includes("vote open"), await ev(`document.querySelector("#skills .meta")?.textContent`));
  ok("the proposal links to its repository", await ev(`document.querySelector("#skills .what a")?.href?.startsWith("https://github.com/")`));
  ok("the vote buttons wait for a wallet", await ev(`[...document.querySelectorAll("#skills .acts button")].length === 2 && [...document.querySelectorAll("#skills .acts button")].every((b) => b.disabled)`));
  ok("the tip and propose buttons wait for a wallet", await ev(`document.getElementById("btnTip").disabled && document.getElementById("btnSubmitSkill").disabled`));
  const r = await S("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1440, height: 900, scale: 1 } });
  await ev(`document.getElementById("hSkills").scrollIntoView()`); await sleep(300);
  const r2 = await S("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1440, height: 900, scale: 1 } });
  writeFileSync("smoke/shots/app-eth-top.png", Buffer.from(r.data, "base64")); writeFileSync("smoke/shots/app-eth-skills.png", Buffer.from(r2.data, "base64"));
  ok("no script errors on the page", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (e) { console.log("ERROR", e.message); fails++; } finally { edge.kill(); }
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
