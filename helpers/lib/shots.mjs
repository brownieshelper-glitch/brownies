// Screenshots of pages, taken in the box: the job that renders every page at desktop and phone width with the
// browser image (Chromium driven over the DevTools protocol by the script below, no network, less motion asked so
// entrance animations are settled), and the reading of what comes back. Each page yields, per width, the first
// screen, an overview of the whole page scaled to a long edge of 1900 px (so a model reads it as one picture), and
// at desktop width three full-size tiles for close reading; plus one info file with the measured sizes.
export const WIDTHS = [1440, 375];
export const FIRST_SCREEN = { 1440: 900, 375: 812 };
export const MAX_HEIGHT = { 1440: 4200, 375: 2400 }; // the page is cut here: the judges see the rhythm, not every pixel
export const TILE = 1400, TILES = 3, OVERVIEW_EDGE = 1900;

// The script that runs inside the box. Plain Node 22 (global WebSocket) and Debian's Chromium. No template
// literals inside, so this file can hold it as one string.
export const SHOT_SCRIPT = [
  '// Renders pages/*.html to shots/<name>-<width>-top.jpg, -full.jpg, -t<n>.jpg and shots/info.json. No network.',
  'import { spawn } from "node:child_process";',
  'import { readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";',
  'const BIN = [process.env.CHROME_BIN, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].filter(Boolean).find((p) => existsSync(p));',
  'if (!BIN) { console.error("no chromium in this image"); process.exit(2); }',
  'const widths = String(process.env.WIDTHS || "1440,375").split(",").map(Number);',
  'const firstScreen = { 1440: 900, 375: 812 }, maxH = { 1440: 4200, 375: 2400 };',
  'const tiles = Number(process.env.TILES || 0), tileH = 1400, edge = 1900;',
  'const waitMs = Number(process.env.WAIT_MS || 2500), quality = Number(process.env.QUALITY || 62);',
  'mkdirSync("shots", { recursive: true });',
  'const port = 9222;',
  'const chrome = spawn(BIN, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-extensions", "--disable-crash-reporter", "--no-first-run", "--hide-scrollbars", "--font-render-hinting=none", "--remote-debugging-port=" + port, "--user-data-dir=/tmp/chrome-profile", "--allow-file-access-from-files", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });',
  'let errText = ""; chrome.stderr.on("data", (d) => { if (errText.length < 4000) errText += d; });',
  'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
  'async function version() { for (let i = 0; i < 150; i++) { try { const r = await fetch("http://127.0.0.1:" + port + "/json/version"); if (r.ok) return r.json(); } catch {} await sleep(200); } throw new Error("Chromium did not open the debugging port: " + errText.slice(0, 500)); }',
  'class CDP {',
  '  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id && this.waiting.has(j.id)) { const { res, rej } = this.waiting.get(j.id); this.waiting.delete(j.id); j.error ? rej(new Error(j.error.message)) : res(j.result); } }; }',
  '  send(method, params, sessionId) { const id = ++this.id; return new Promise((res, rej) => { this.waiting.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params: params || {}, ...(sessionId ? { sessionId } : {}) })); }); }',
  '}',
  'const info = {};',
  'try {',
  '  const v = await version();',
  '  const ws = new WebSocket(v.webSocketDebuggerUrl);',
  '  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });',
  '  const cdp = new CDP(ws);',
  '  const pages = readdirSync("pages").filter((f) => f.endsWith(".html")).sort();',
  '  for (const f of pages) {',
  '    const name = f.replace(/\\.html$/, "");',
  '    info[name] = {};',
  '    for (const w of widths) {',
  '      const mobile = w < 700, top = firstScreen[w] || 900;',
  '      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });',
  '      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });',
  '      const S = (m, p) => cdp.send(m, p, sessionId);',
  '      try {',
  '        await S("Page.enable"); await S("Runtime.enable");',
  '        await S("Emulation.setDeviceMetricsOverride", { width: w, height: top, deviceScaleFactor: 1, mobile, screenWidth: w, screenHeight: top });',
  '        await S("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });',
  '        if (mobile) await S("Emulation.setTouchEmulationEnabled", { enabled: true });',
  '        await S("Page.navigate", { url: "file://" + process.cwd() + "/pages/" + f });',
  '        await sleep(waitMs);',
  '        try { await S("Runtime.evaluate", { expression: "document.fonts && document.fonts.ready", awaitPromise: true }); } catch {}',
  '        // every animation and transition brought to its end state: a capture beyond the viewport lays the page out again, and an entrance animation caught half way would show a faded page',
  '        await S("Runtime.evaluate", { expression: "(function () { var s = document.createElement(\'style\'); s.textContent = \'*, *::before, *::after { animation-delay: 0s !important; animation-duration: 0.001s !important; animation-iteration-count: 1 !important; transition-delay: 0s !important; transition-duration: 0s !important; }\'; document.head.appendChild(s); })()" });',
  '        await sleep(300);',
  '        const { result } = await S("Runtime.evaluate", { expression: "JSON.stringify({ h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth, chars: (document.body.innerText || \'\').length })", returnByValue: true });',
  '        const m = JSON.parse(result.value);',
  '        const first = await S("Page.captureScreenshot", { format: "jpeg", quality, captureBeyondViewport: false, clip: { x: 0, y: 0, width: w, height: top, scale: 1 } });',
  '        writeFileSync("shots/" + name + "-" + w + "-top.jpg", Buffer.from(first.data, "base64"));',
  '        const H = Math.max(top, Math.min(m.h, maxH[w] || 4200));',
  '        const full = await S("Page.captureScreenshot", { format: "jpeg", quality, captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: H, scale: Math.min(1, edge / H) } });',
  '        writeFileSync("shots/" + name + "-" + w + "-full.jpg", Buffer.from(full.data, "base64"));',
  '        let n = 0;',
  '        if (!mobile) for (let i = 0; i < tiles && i * tileH < H; i++) {',
  '          const t = await S("Page.captureScreenshot", { format: "jpeg", quality, captureBeyondViewport: true, clip: { x: 0, y: i * tileH, width: w, height: Math.min(tileH, H - i * tileH), scale: 1 } });',
  '          writeFileSync("shots/" + name + "-" + w + "-t" + (i + 1) + ".jpg", Buffer.from(t.data, "base64")); n++;',
  '        }',
  '        info[name][w] = { height: m.h, width: m.w, overflow: m.w > w, chars: m.chars, shown: H, tiles: n };',
  '        console.log(name + " at " + w + ": " + m.w + "x" + m.h + (m.w > w ? " OVERFLOW" : ""));',
  '      } catch (e) { console.error(name + " at " + w + " failed: " + e.message); info[name][w] = { error: e.message }; }',
  '      await cdp.send("Target.closeTarget", { targetId });',
  '    }',
  '  }',
  '  ws.close();',
  '} catch (e) { console.error("render failed: " + e.message); info.error = e.message; }',
  'writeFileSync("shots/info.json", JSON.stringify(info));',
  'chrome.kill();',
  'await sleep(300);',
  'process.exit(info.error ? 1 : 0);',
].join("\n");

/// The sandbox job that renders the given pages ({ name: html }, names [a-z0-9-]). Every page's pictures are
/// collected, plus info.json.
export function renderJob(pages, { widths = WIDTHS, tiles = TILES, waitMs = 2500, timeoutSeconds = 540 } = {}) {
  const names = Object.keys(pages).filter((n) => /^[a-z0-9-]{1,40}$/.test(n));
  const files = { "shot.mjs": SHOT_SCRIPT };
  for (const n of names) files[`pages/${n}.html`] = String(pages[n]);
  const collect = ["shots/info.json"];
  for (const n of names) for (const w of widths) {
    collect.push(`shots/${n}-${w}-top.jpg`, `shots/${n}-${w}-full.jpg`);
    if (w >= 700) for (let i = 1; i <= tiles; i++) collect.push(`shots/${n}-${w}-t${i}.jpg`);
  }
  return { image: "browser", files, command: `WIDTHS=${widths.join(",")} TILES=${tiles} WAIT_MS=${waitMs} node shot.mjs`, timeoutSeconds, collect };
}

/// What the box brought back, per page: { [name]: { [width]: { top, full, tiles: [], info } } } (pictures as base64 or
/// null) and the names whose pictures are missing or whose page came out blank.
export function readShots(result, names, widths = WIDTHS) {
  const blobs = result?.blobs || {};
  let info = {};
  try { info = JSON.parse(result?.files?.["shots/info.json"] || "{}"); } catch { info = {}; }
  const out = {}, missing = [];
  for (const n of names) {
    out[n] = {};
    let any = false;
    for (const w of widths) {
      const top = blobs[`shots/${n}-${w}-top.jpg`] || null, full = blobs[`shots/${n}-${w}-full.jpg`] || null;
      const tiles = []; for (let i = 1; i <= 9; i++) { const t = blobs[`shots/${n}-${w}-t${i}.jpg`]; if (!t) break; tiles.push(t); }
      if (top || full) any = true;
      out[n][w] = { top, full, tiles, info: info?.[n]?.[w] || null };
    }
    const chars = out[n][widths[0]]?.info?.chars;
    if (!any || (Number.isFinite(chars) && chars < 80)) missing.push(n);
  }
  return { shots: out, missing, error: info?.error || null };
}

/// The pictures of one page as message parts for a model that sees images, each under a line that says what it is.
/// mode "normal": first screen and overview at each width; "top": the first screens only; "detail": the desktop
/// tiles (close reading), the desktop overview, the phone's first screen and overview. [] when there are none.
export function shotParts(label, shots, { mode = "normal", widths = WIDTHS } = {}) {
  if (!shots) return [];
  const parts = [];
  const img = (text, image) => { if (image) parts.push({ text }, { image, mime: "image/jpeg" }); };
  for (const w of widths) {
    const s = shots[w]; if (!s) continue;
    const where = w < 700 ? "phone" : "desktop";
    const note = s.info?.height ? ` (the page is ${s.info.height} px tall${s.info.height > s.info.shown ? ", shown to " + s.info.shown : ""}${s.info.overflow ? ", SIDEWAYS OVERFLOW" : ""})` : "";
    if (mode === "detail" && s.tiles?.length) s.tiles.forEach((t, i) => img(`${label}, ${where} at full size, part ${i + 1} of ${s.tiles.length} (from ${i * TILE} px down)`, t));
    else img(`${label}, the first screen on ${where} (${w} wide)`, s.top);
    if (mode !== "top") img(`${label}, the whole page on ${where}, scaled down${note}`, s.full);
  }
  return parts;
}
