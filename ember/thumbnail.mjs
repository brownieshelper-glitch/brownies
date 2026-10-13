// Makes the stream's thumbnail: the picture a network shows for the stream (1280 by 720, PNG). The words are
// given here, so the picture can be made again whenever they change:
//   node ember/thumbnail.mjs "Brownies kitchen" "LIVE 24/24"
//   node ember/thumbnail.mjs "Brownies kitchen" "LIVE 24/24" "feedthebrownies.com" C:/some/folder/name.png
// It serves the site's folder on a port of its own, opens web/live-thumb.html in this machine's Edge with an empty
// profile of its own, saves the picture and closes only what it started. Run from the project folder.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(here, "../web");
const [a = "Brownies kitchen", b = "LIVE 24/24", c = "feedthebrownies.com", outArg = ""] = process.argv.slice(2);
const out = outArg ? resolve(outArg) : join(homedir(), "OneDrive", "Desktop", "brownies-stream-thumbnail.png");
const EDGE = process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const sitePort = 18900 + Math.floor(Math.random() * 200), dbgPort = 9950 + Math.floor(Math.random() * 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "thumb-edge-"));
const server = spawn(process.execPath, [join(WEB, "serve.mjs")], { env: { ...process.env, PORT: String(sitePort) }, stdio: "ignore" });
const edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", `--user-data-dir=${profile}`, `--remote-debugging-port=${dbgPort}`, "about:blank"], { stdio: "ignore" });

function session(url) {
  const ws = new WebSocket(url);
  let id = 0; const waiting = new Map(), events = [];
  ws.onmessage = (m) => {
    const j = JSON.parse(m.data);
    if (j.id && waiting.has(j.id)) { const { ok, no } = waiting.get(j.id); waiting.delete(j.id); j.error ? no(new Error(j.error.message)) : ok(j.result); }
    else if (j.method) for (const e of events.filter((x) => x.method === j.method)) { events.splice(events.indexOf(e), 1); e.ok(j.params); }
  };
  return {
    open: new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error("no connection to the browser")); }),
    send: (method, params = {}) => new Promise((ok, no) => { waiting.set(++id, { ok, no }); ws.send(JSON.stringify({ id, method, params })); }),
    once: (method) => new Promise((ok) => events.push({ method, ok })),
    close: () => ws.close(),
  };
}

try {
  let list = null;
  for (let i = 0; i < 80 && !list; i++) { try { list = await (await fetch(`http://127.0.0.1:${dbgPort}/json`)).json(); } catch { await sleep(150); } }
  const target = (list || []).find((t) => t.type === "page");
  if (!target) throw new Error("Edge did not start");
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${sitePort}/live-thumb.html`)).ok) break; } catch { await sleep(100); } }
  const page = session(target.webSocketDebuggerUrl);
  await page.open;
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  const loaded = page.once("Page.loadEventFired");
  await page.send("Page.navigate", { url: `http://127.0.0.1:${sitePort}/live-thumb.html?${new URLSearchParams({ a, b, c })}` });
  await loaded;
  const ev = async (expression) => (await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
  await ev("document.fonts.ready.then(() => 1)");
  for (let i = 0; i < 40 && !(await ev("document.documentElement.dataset.ready === '1'")); i++) await sleep(100);
  await sleep(400);
  const fonts = await ev("[...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/\"/g, '')).filter((v, i, l) => l.indexOf(v) === i).join(', ')");
  const shot = await page.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1280, height: 720, scale: 1 } });
  mkdirSync(dirname(out), { recursive: true });
  const bytes = Buffer.from(shot.data, "base64");
  writeFileSync(out, bytes);
  console.log(`${out}  (1280 x 720, ${(bytes.length / 1024).toFixed(0)} KB; fonts: ${fonts || "the fallback ones, the web fonts did not load"})`);
  page.close();
  try { const v = await (await fetch(`http://127.0.0.1:${dbgPort}/json/version`)).json(); const br = session(v.webSocketDebuggerUrl); await br.open; await Promise.race([br.send("Browser.close"), sleep(1500)]); } catch { /* closed below */ }
} finally {
  await sleep(300);
  try { edge.kill(); } catch { /* gone */ }
  try { server.kill(); } catch { /* gone */ }
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* left in the temp folder */ }
}
