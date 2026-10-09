// The shop: the brownies' work sold to other agents and to people, per request, paid in USDC over x402 (the
// selling side is lib/x402seller.mjs). Three things are for sale: a research note, a meme with the brownies, a
// cartoon clip with the brownies. The catalog is public at GET /shop; a buyer POSTs /shop/<item> with its words,
// gets a 402 with the price, pays by signing, and gets the note at once or an order to poll for the picture or the
// clip. Every payment lands in the owner's wallet directly; the brownies never hold it. A paid order that cannot
// be made is told to the owner, who refunds by hand: nothing moves money without him. Toffee (a hidden brownie)
// makes the orders; the shop only takes them and hands out the files.
import { createReadStream, copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { parsePayment } from "./x402seller.mjs";
import { clientIp } from "./net.mjs";

export const ITEMS = {
  note: { title: "A research note", what: "A short research note on your topic in the brownies' voice: what it is, what matters, what to watch. About 300 words of plain text.", usd: 1, mimeType: "application/json", minutes: 1, sync: true },
  meme: { title: "A meme with the brownies", what: "One picture of the four brownies acting out your idea, with a caption in their words. PNG, 1280 by 720.", usd: 0.5, mimeType: "image/png", minutes: 5, sync: false },
  clip: { title: "A cartoon clip with the brownies", what: "A vertical clip of 6 to 12 seconds, the four brownies acting your scene, captions burnt in. MP4, 720 by 1280.", usd: 9, mimeType: "video/mp4", minutes: 15, sync: false },
};
export const RULES = [
  "Say what you want in plain words, 10 to 600 characters.",
  "Nothing adult, hateful or violent; no real people; no price talk, no promises of returns, no links, no wallet or key asks.",
  "The brownies keep their look and their voice. What you buy is yours to use.",
  "A paid order that cannot be made is reported to the owner, who refunds by hand.",
];
/// Words that end a request before any money moves (the model judges the rest, in Toffee).
export const BANNED = /\b(nsfw|nude|naked|sex|sexual|porn|erotic|kill|murder|blood|gore|terror|nazi|hitler|rape|seed phrases?|private keys?|connect (your )?wallets?|claim (your )?(airdrops?|rewards?|prizes?)|guaranteed|100x|1000x|to the moon)\b/i;
export const PROMPT_MIN = 10, PROMPT_MAX = 600;
const usdToMicro = (usd) => Math.round(Number(usd) * 1e6);
const money = (micro) => `$${(Number(micro) / 1e6).toFixed(2)}`;
const short = (a) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "");
const EXT = { ".png": "image/png", ".mp4": "video/mp4", ".jpg": "image/jpeg" };

/// The buyer's words, cleaned: one line of plain text, or null when too short or too long.
export function cleanPrompt(s) {
  const t = String(s ?? "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (t.length < PROMPT_MIN || t.length > PROMPT_MAX) return null;
  return t;
}

export class Shop {
  /// seller: lib/x402seller.mjs Seller. maker: Toffee (allowed(prompt, item) and make(order)); without one the shop
  /// is closed. dir: where the sold files live (served at /shop/files/<name>). config.items: { note: { usd } ... } overrides.
  constructor({ store, clock, seller, log = () => {}, config = {}, baseUrl = "", siteUrl = "", dir = "", telegram = null, ownerChatId = "", maker = null }) {
    Object.assign(this, { store, clock, seller, log, baseUrl: baseUrl.replace(/\/$/, ""), siteUrl: siteUrl.replace(/\/$/, ""), dir, telegram, ownerChatId, maker });
    this.items = {};
    for (const [id, it] of Object.entries(ITEMS)) {
      const over = config.items?.[id] || {};
      if (over.off) continue;
      this.items[id] = { ...it, usd: Number.isFinite(Number(over.usd)) && Number(over.usd) > 0 ? Number(over.usd) : it.usd };
    }
    this.checks = new Map(); // payer -> the times of the model checks, six per ten minutes
    this.sold = { count: 0, micro: 0 };
  }

  /// Can the shop take money right now? { ok, reason }.
  async open() {
    if (!this.maker) return { ok: false, reason: "no brownie to make the orders" };
    return this.seller.open();
  }

  catalog({ open = null } = {}) {
    return {
      shop: "Brownies", what: "The brownies' work, per request, paid in USDC on Base over x402. No account, no key.",
      open: open?.ok ?? null, closedBecause: open && !open.ok ? open.reason : undefined,
      items: Object.entries(this.items).map(([id, it]) => ({ id, title: it.title, what: it.what, usd: it.usd, mimeType: it.mimeType, minutes: it.minutes, how: `POST ${this.baseUrl}/shop/${id} with JSON {"prompt": "..."}; answer 402 carries PAYMENT-REQUIRED; send it again with PAYMENT-SIGNATURE` })),
      pay: { protocol: "x402", version: 2, scheme: "exact", network: `eip155:${this.seller.chainId}`, asset: this.seller.asset, payTo: this.seller.payTo || null },
      rules: RULES, docs: `${this.siteUrl}/shop.html`,
    };
  }

  // ---- HTTP ----
  cors(res) {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type, payment-signature");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-expose-headers", "payment-required, payment-response");
  }
  async handle(req, res) {
    const url = new URL(req.url, "http://x");
    this.cors(res);
    const json = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }); res.end(JSON.stringify(body)); };
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    try {
      const path = url.pathname.replace(/\/$/, "") || "/shop";
      if (req.method === "GET" && path === "/shop") return json(200, this.catalog({ open: await this.open() }));
      let m;
      if ((req.method === "GET" || req.method === "HEAD") && (m = /^\/shop\/files\/([a-z0-9-]+\.(png|mp4|jpg))$/.exec(path))) return this.serveFile(req, res, m[1]);
      if (req.method === "GET" && (m = /^\/shop\/orders\/(\d+)$/.exec(path))) {
        const o = this.store.order(Number(m[1]));
        if (!o || o.key !== url.searchParams.get("key")) return json(404, { error: "no such order" });
        return json(200, this.orderView(o));
      }
      if (req.method === "POST" && (m = /^\/shop\/([a-z]+)$/.exec(path))) {
        const r = await this.buy(m[1], await readBody(req), req.headers["payment-signature"], clientIp(req));
        return json(r.status, r.body, r.headers || {});
      }
      return json(404, { error: "no such route; GET /shop lists what is for sale" });
    } catch (e) {
      this.log(`[shop] ${req.method} ${url.pathname} failed: ${e.message}`);
      return json(500, { error: "the shop stumbled; try again" });
    }
  }
  serveFile(req, res, name) {
    const file = join(this.dir, name);
    if (!this.dir || !existsSync(file)) { res.writeHead(404, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "no such file" })); }
    const size = statSync(file).size;
    res.writeHead(200, { "content-type": EXT[extname(name)] || "application/octet-stream", "content-length": size, "cache-control": "public, max-age=86400" });
    if (req.method === "HEAD") return res.end();
    createReadStream(file).pipe(res);
  }

  /// The purchase: the item and the words checked, the price asked (402), the payment checked on the chain, the
  /// maker's judgement, the settlement, the order. Returns { status, body, headers }.
  async buy(item, body, paymentHeader, ip = "") {
    const it = this.items[item];
    if (!it) return { status: 404, body: { error: `nothing called "${item}" is for sale; GET /shop lists what is` } };
    const prompt = cleanPrompt(body?.prompt ?? body?.text ?? (typeof body === "string" ? body : ""));
    if (!prompt) return { status: 400, body: { error: `say what you want in ${PROMPT_MIN} to ${PROMPT_MAX} characters, as {"prompt": "..."}` } };
    if (BANNED.test(prompt)) return { status: 400, body: { error: "we do not make that", rules: RULES } };
    const open = await this.open();
    if (!open.ok) return { status: 503, body: { error: `the shop is closed for the moment: ${open.reason}` } };
    const now = this.clock.now();
    const url = `${this.baseUrl}/shop/${item}`;
    const required = this.seller.requirement({ micro: usdToMicro(it.usd), url, description: `${it.title}. ${it.what}`, mimeType: it.mimeType, maxTimeoutSeconds: 600 });
    const ask = (error) => ({ status: 402, body: { error: error || "payment required", price: `${it.usd} USDC on Base`, item }, headers: { "payment-required": b64(required, error) } });
    if (!paymentHeader) return ask("");
    const payload = parsePayment(paymentHeader);
    if (!payload) return ask("PAYMENT-SIGNATURE is not base64 JSON");
    const v = await this.seller.verify(payload, required, { now });
    if (!v.ok) return ask(v.error);
    if (!this.store.useNonce(v.authorization.nonce, now)) return ask("this authorization was used already");
    // the maker's judgement before any money moves: a cent of AI, so six times per payer per ten minutes
    if (!this.mayCheck(v.payer, now)) return { status: 429, body: { error: "too many requests from this wallet; wait ten minutes" } };
    const judged = await this.maker.allowed(prompt, item);
    if (!judged.ok) return { status: 400, body: { error: judged.why || "we do not make that", rules: RULES } };
    const s = await this.seller.settle(payload);
    if (!s.ok) return ask(s.error);
    const key = randomBytes(8).toString("hex");
    const id = this.store.addOrder({ at: now, key, item, prompt, payer: s.payer, micro: s.micro, tx: s.tx });
    this.sold.count++; this.sold.micro += s.micro;
    this.log(`[shop] order ${id}: ${item} for ${money(s.micro)} by ${s.payer} (tx ${s.tx})`);
    await this.tell(`Toffee sold ${it.title.toLowerCase()} for ${money(s.micro)} to ${short(s.payer)}. Order #${id}, tx ${s.tx}.${it.sync ? "" : ` It is being made now, about ${it.minutes} minutes.`}`);
    const headers = { "payment-response": this.seller.response({ success: true, transaction: s.tx, payer: s.payer }) };
    if (it.sync) {
      const r = await this.maker.make(this.store.order(id));
      const o = this.store.order(id);
      return { status: 200, body: { ...this.orderView(o), ...(r.ok ? {} : { error: r.error }) }, headers };
    }
    return { status: 202, body: { ...this.orderView(this.store.order(id)), statusUrl: this.statusUrl(id, key) }, headers };
  }
  mayCheck(payer, now) {
    const k = String(payer).toLowerCase();
    const times = (this.checks.get(k) || []).filter((t) => now - t < 600_000);
    if (times.length >= 6) return false;
    times.push(now); this.checks.set(k, times);
    return true;
  }
  statusUrl(id, key) { return `${this.baseUrl}/shop/orders/${id}?key=${key}`; }
  orderView(o) {
    const it = this.items[o.item] || ITEMS[o.item] || {};
    const out = { order: o.id, item: o.item, state: o.state, at: new Date(o.at).toISOString(), minutes: it.minutes };
    if (o.result?.url) out.url = o.result.url;
    if (o.result?.text) out.text = o.result.text;
    if (o.state === "failed") out.note = `${o.note || "it could not be made"}. The owner was told; refunds are by hand.`;
    return out;
  }

  // ---- the orders, for the maker ----
  next() { return this.store.nextOrder("paid"); }
  start(id) { return this.store.setOrder(id, { state: "making", at: this.clock.now() }); }
  async finish(id, { url = null, text = null, costMicro = 0 } = {}) {
    const o = this.store.setOrder(id, { state: "done", result: { url, text }, costMicro, at: this.clock.now() });
    this.log(`[shop] order ${id} done${url ? ` (${url})` : ""}`);
    if (url) await this.tell(`Order #${id} (${o.item}) is done: ${url}`);
    return o;
  }
  async fail(id, why, costMicro = 0) {
    const o = this.store.setOrder(id, { state: "failed", note: String(why).slice(0, 200), costMicro, at: this.clock.now() });
    this.log(`[shop] order ${id} failed: ${why}`);
    await this.tell(`Order #${id} (${o.item}, ${money(o.micro)} paid by ${o.payer}) could not be made: ${why}. Nothing moves without you: refund that address by hand if you want to.`);
    return o;
  }
  /// Keeps a made file under the shop's folder with an unguessable name; returns its public url.
  keep(order, srcFile) {
    mkdirSync(this.dir, { recursive: true });
    const name = `order-${order.id}-${order.key}${extname(srcFile).toLowerCase()}`;
    copyFileSync(srcFile, join(this.dir, name));
    return `${this.baseUrl}/shop/files/${name}`;
  }
  async tell(text) {
    if (!this.telegram?.configured || !this.ownerChatId) return;
    try { await this.telegram.sendMessage(this.ownerChatId, text); } catch (e) { this.log(`[shop] Telegram did not take the note: ${e.message}`); }
  }

  /// For the control room: open or not, the balances behind it, the sales, the last orders.
  async view() {
    const now = this.clock.now();
    const open = await this.open();
    const dayStart = this.store.dayStart(now);
    const dayOfMonth = Number(this.store.dayKey(now).slice(8));
    const monthStart = dayStart - (dayOfMonth - 1) * 86_400_000;
    const sum = (s) => ({ n: s.n, usd: s.micro / 1e6, costUsd: s.costMicro / 1e6 });
    const gas = await this.seller.gasWei();
    return {
      open: open.ok, reason: open.reason, payTo: this.seller.payTo || null, settler: this.seller.address, gasEth: gas === null ? null : Number(gas) / 1e18, network: `eip155:${this.seller.chainId}`,
      items: Object.entries(this.items).map(([id, it]) => ({ id, title: it.title, usd: it.usd })),
      today: sum(this.store.sales(dayStart)), month: sum(this.store.sales(monthStart)),
      orders: this.store.orders({ limit: 30 }).map((o) => ({ id: o.id, at: o.at, item: o.item, state: o.state, usd: o.micro / 1e6, costUsd: o.costMicro / 1e6, payer: o.payer, tx: o.tx, url: o.result?.url || null, note: o.note, prompt: o.prompt.slice(0, 140) })),
    };
  }
}

const b64 = (required, error) => Buffer.from(JSON.stringify(error ? { ...required, error } : required), "utf8").toString("base64");

/// The request body: JSON when it parses, else the text as the prompt. Never more than 20 KB.
function readBody(req) {
  return new Promise((res, rej) => {
    let s = "";
    req.on("data", (d) => { s += d; if (s.length > 20_000) { rej(new Error("too large")); req.destroy(); } });
    req.on("end", () => { if (!s) return res({}); try { res(JSON.parse(s)); } catch { res({ prompt: s }); } });
    req.on("error", rej);
  });
}
