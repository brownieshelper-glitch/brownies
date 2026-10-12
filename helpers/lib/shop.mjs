// The shop: the brownies' work sold to other agents and to people, per request, paid in USDC over x402 (the
// selling side is lib/x402seller.mjs). For sale: a research note, a meme with the brownies, a cartoon clip with
// the brownies, a review of an idea by a panel of models and a brainstorm by the same panel (Biscotti makes those two,
// through Toffee). The catalog is public at GET /shop; a buyer POSTs /shop/<item> with its words,
// gets a 402 with the price, pays by signing, and gets the note at once or an order to poll for the picture or the
// clip. Every payment lands in the owner's wallet directly; the brownies never hold it. A paid order that cannot
// be made is told to the owner, who refunds by hand: nothing moves money without him. Toffee (a hidden brownie)
// makes the orders; the shop only takes them and hands out the files.
import { createReadStream, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { parsePayment } from "./x402seller.mjs";
import { clientIp } from "./net.mjs";

export const ITEMS = {
  note: { title: "A research note", what: "A short research note on your topic in the brownies' voice: what it is, what matters, what to watch. About 300 words of plain text.", usd: 1, mimeType: "application/json", minutes: 1, sync: true },
  meme: { title: "A meme with the brownies", what: "One picture of the four brownies acting out your idea, with a caption in their words. PNG, 1280 by 720.", usd: 0.5, mimeType: "image/png", minutes: 5, sync: false },
  clip: { title: "A cartoon clip with the brownies", what: "A vertical clip of 6 to 12 seconds, the four brownies acting your scene, captions burnt in. MP4, 720 by 1280.", usd: 9, mimeType: "video/mp4", minutes: 15, sync: false },
  idea: { title: "An idea review", what: "Your business or project idea, up to 4,000 characters. First the web is searched from three angles: who already does it, the demand and its numbers, what hurt the ones before. Then ten AI models from different labs review the idea, each alone, with that research in hand. Then the second reading: every model reads the others and answers again, says who is wrong and what nobody said. The open questions get a second search. Three specialists write the first 30 days, the money and the build. An editor checks the claims against their sources before the page leaves. One report: the verdict with the scores before and after, where the panel agrees and where it fights, the strongest objection, what to build first, what to drop, who else does this and the numbers with their links, the answers, the three plans. HTML and Markdown, about fifteen minutes.", usd: 50, mimeType: "text/html", minutes: 15, sync: false, maxChars: 4000, lines: true, judge: "idea" },
  brainstorm: { title: "A brainstorm", what: "A topic, a market, a skill or a problem, with your limits, up to 2,000 characters. The web is searched for what exists and what changed this year. Ten AI models from different labs each propose ten ideas with that research in hand. The hundred become one shortlist, and every model scores every candidate on four things: the demand, whether you can start it with what you have, your edge, and money within a year. The best ten are searched again for the closest thing that already exists, with its price. The best three get a start sheet: the first customer, the offer and the price to test, week one, month one, the costs, the numbers to watch, what kills it and the cheap test for that. One page: the ten ideas in the panel's order with their votes, the three sheets, the wild cards, where the panel argued. HTML and Markdown, about twenty minutes.", usd: 30, mimeType: "text/html", minutes: 20, sync: false, maxChars: 2000, lines: true, judge: "idea" },
  code: { title: "A code review", what: "The https link of a public git repository, with the branch and what to look at if you like, up to 5,000 lines of source; add \"only src/payments/\" with your own path to review one folder of a bigger one. The code is cloned and its own tests are run in a box with no network. Ten AI models from different labs review it, each alone. Three hunters then go through it with one lens each (security and money, failure and concurrency, logic and edges) for what the panel missed. The findings are merged and read a second time against the code; the ones most readers say the code already handles are listed apart. For each finding that stands, a script tries to reproduce it in the box. For each bug the box shows, a fix is written, applied in the box and proven there: your tests still pass and the script no longer shows the bug. One page: the verdict, the findings worst first, each with the second reading, the box and the proven patch, then what to fix first; and the patches as one file. HTML and Markdown, about ninety minutes.", usd: 200, mimeType: "text/html", minutes: 90, sync: false, maxChars: 600, judge: "code" },
  website: { title: "A website check", what: "The https link of a site that is yours: you prove it with a small file on the site or a DNS record holding the wallet you pay with. Plain requests only: the redirect to https, the certificate, the security headers, the cookies, files that should never be public, directory listings, mixed content, the page's basics for phones, search and screen readers, the dead links. Then ten AI models from different labs read the checks and the home page; their findings and the checks' own are merged and read a second time, each with where it is, how it shows, the fix and who found it. One page: the verdict, the checks, the findings worst first, what to fix first. HTML and Markdown, about twenty minutes.", usd: 20, mimeType: "text/html", minutes: 20, sync: false, maxChars: 600, judge: "website" },
  remake: { title: "A new version of your home page", what: "The https link of a site that is yours, proven the same way as the website check. The findings of the check are the brief. Ten AI models each propose a direction (same brand, same facts, the problems fixed, a look a studio would sign) and every model scores them. The three best go to eight builders, each of which builds a whole page. Every page is rendered at desktop and phone width and the panel judges the screenshots, your page as it is today among them. The three best are critiqued by art directors, revised and judged again; the winner is polished twice. You get the final page, two alternatives, every screenshot and a brief with the scores, including whether the new page beat yours, as previews beside your current site; your site is not touched. Wiring the one you choose into your site is a quote. HTML, about an hour.", usd: 150, mimeType: "text/html", minutes: 60, sync: false, maxChars: 600, judge: "website" },
};
export const RULES = [
  "Say what you want in plain words, 10 to 600 characters.",
  "Nothing adult, hateful or violent; no real people; no price talk, no promises of returns, no links, no wallet or key asks.",
  "The brownies keep their look and their voice. What you buy is yours to use.",
  "A paid order that cannot be made is reported to the owner, who refunds by hand.",
  "An idea review takes up to 4,000 characters: the problem, the people, the product, the money, the way you would tell a friend. A brainstorm takes a topic and your limits, up to 2,000. Both are the panel's opinion, not advice and not an audit.",
  "A code review takes the https link of a public git repository with up to 5,000 lines of source, or one folder of a bigger one named in the request (\"only src/payments/\"); more is refused before any payment. The code and its tests run in a box with no network, and it is read by models of several labs through their APIs. A fix is called proven only when it was applied in that box, the project's own tests still passed and the script stopped showing the bug. It is a review, not an audit and not a certification: no badge, no promise.",
  "A new version of your home page is a set of previews (the final page, two alternatives, the screenshots and the brief with the scores), built from the findings of the check by several models and judged from screenshots against your page as it is; the brief says so plainly when the new page did not beat yours. The current site is not touched, and the chosen page is wired in on a quote.",
  "A website check takes the https link of a site that is yours: before any payment the site must carry a file at /.well-known/brownies.txt, or a DNS TXT record, with brownies=<the wallet you pay with>. Only plain requests are made, never an attack. It is a check, not a penetration test and not a certification.",
];
/// Words that end a request before any money moves (the model judges the rest, in Toffee).
export const BANNED = /\b(nsfw|nude|naked|sex|sexual|porn|erotic|kill|murder|blood|gore|terror|nazi|hitler|rape|seed phrases?|private keys?|connect (your )?wallets?|claim (your )?(airdrops?|rewards?|prizes?)|guaranteed|100x|1000x|to the moon)\b/i;
/// For an idea the ban list is the hard part only: prices, returns and business claims are what a review is about.
export const BANNED_IDEA = /\b(nsfw|nude|naked|sex|sexual|porn|erotic|kill|murder|blood|gore|terror|nazi|hitler|rape|seed phrases?|private keys?)\b/i;
export const PROMPT_MIN = 10, PROMPT_MAX = 600;

// ---- a request by form (the Biscotti page): no money moves, the owner reads it and answers by hand ----
/// What a person may ask for by form.
export const ASK_KINDS = { idea: "an idea review", brainstorm: "a brainstorm", code: "a code review", website: "a website check", remake: "a new version of a home page", other: "something else" };
/// The files a request may carry: how many, how large, which kinds. A kind is told by the name's ending AND by the
/// file's first bytes, so a program renamed to .pdf is refused.
export const ASK_FILES = { max: 3, bytesEach: 4 * 1024 * 1024, bytesAll: 8 * 1024 * 1024, kinds: [".pdf", ".txt", ".md", ".png", ".jpg", ".jpeg", ".webp", ".zip"] };
export const ASK_WORDS = { min: 20, max: 4000 };
const ASK_BODY_MAX = 12 * 1024 * 1024;        // the files travel as base64 inside the JSON: a third more than their size
const ASK_PER_HOUR = 3, ASK_PER_DAY = 40;      // per address, and for everyone together
const ASK_DISK_MAX = 300 * 1024 * 1024;        // the folder of kept files never grows past this
const oneLine = (v, max) => { const t = String(v ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim(); return t.length > max ? null : t; };
/// Is this file what its name says? The first bytes decide for the binary kinds; a text file must be text.
export function fileLooksLike(ext, buf) {
  const head = (n) => buf.subarray(0, n).toString("latin1");
  if (ext === ".pdf") return head(5) === "%PDF-";
  if (ext === ".png") return buf.length > 8 && buf[0] === 0x89 && head(4).slice(1) === "PNG";
  if (ext === ".jpg" || ext === ".jpeg") return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ext === ".webp") return buf.length > 12 && head(4) === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP";
  if (ext === ".zip") return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5) && (buf[3] === 4 || buf[3] === 6);
  if (ext === ".txt" || ext === ".md") return buf.length > 0 && !buf.includes(0) && !/\uFFFD/.test(buf.toString("utf8"));
  return false;
}
const usdToMicro = (usd) => Math.round(Number(usd) * 1e6);
const money = (micro) => `$${(Number(micro) / 1e6).toFixed(2)}`;
const short = (a) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "");
const EXT = { ".png": "image/png", ".mp4": "video/mp4", ".jpg": "image/jpeg", ".html": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8" };

/// The buyer's words, cleaned: plain text on one line (or with its lines kept, for an idea), or null when too short or too long.
export function cleanPrompt(s, { max = PROMPT_MAX, keepLines = false } = {}) {
  let t = String(s ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ");
  t = keepLines ? t.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : t.replace(/\s+/g, " ").trim();
  if (t.length < PROMPT_MIN || t.length > max) return null;
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
    this.asksOpen = Boolean(config.asks); // the request form: closed until the settings say "shop": { "asks": true }
    this.askTimes = new Map(); // address -> the times of its requests by form, three an hour
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
      items: Object.entries(this.items).map(([id, it]) => ({ id, title: it.title, what: it.what, usd: it.usd, mimeType: it.mimeType, minutes: it.minutes, maxChars: it.maxChars || PROMPT_MAX, how: `POST ${this.baseUrl}/shop/${id} with JSON {"prompt": "..."}; answer 402 carries PAYMENT-REQUIRED; send it again with PAYMENT-SIGNATURE` })),
      pay: { protocol: "x402", version: 2, scheme: "exact", network: `eip155:${this.seller.chainId}`, asset: this.seller.asset, payTo: this.seller.payTo || null },
      rules: RULES, docs: `${this.siteUrl}/shop.html`,
      asks: this.asksOpen ? { open: true, how: `POST ${this.baseUrl}/shop/ask with JSON {"kind", "words", "contact", "link", "files": [{"name", "data": base64}]}`, kinds: Object.keys(ASK_KINDS), files: ASK_FILES } : { open: false },
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
      if ((req.method === "GET" || req.method === "HEAD") && (m = /^\/shop\/files\/([a-z0-9-]+\.(png|mp4|jpg|html|md))$/.exec(path))) return this.serveFile(req, res, m[1]);
      if (req.method === "GET" && (m = /^\/shop\/orders\/(\d+)$/.exec(path))) {
        const o = this.store.order(Number(m[1]));
        if (!o || o.key !== url.searchParams.get("key")) return json(404, { error: "no such order" });
        return json(200, this.orderView(o));
      }
      if (req.method === "POST" && path === "/shop/ask") {
        let body;
        try { body = await readBody(req, ASK_BODY_MAX, { answer: true }); } catch { res.setHeader("connection", "close"); return json(413, { error: `too large: up to ${ASK_FILES.max} files, ${ASK_FILES.bytesEach / 1048576} MB each and ${ASK_FILES.bytesAll / 1048576} MB in all` }); }
        const r = await this.ask(body, clientIp(req));
        return json(r.status, r.body);
      }
      if (req.method === "POST" && path === "/shop/quote") { const r = await this.quote(await readBody(req), clientIp(req)); return json(r.status, r.body); }
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
    const prompt = cleanPrompt(body?.prompt ?? body?.text ?? (typeof body === "string" ? body : ""), { max: it.maxChars || PROMPT_MAX, keepLines: Boolean(it.lines) });
    if (!prompt) return { status: 400, body: { error: `say what you want in ${PROMPT_MIN} to ${it.maxChars || PROMPT_MAX} characters, as {"prompt": "..."}` } };
    if ((it.judge === "idea" ? BANNED_IDEA : BANNED).test(prompt)) return { status: 400, body: { error: "we do not make that", rules: RULES } };
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
    const judged = await this.maker.allowed(prompt, item, { payer: v.payer });
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
  /// After a review: "build it for me". No money moves; the owner gets the ask and answers with a quote by hand.
  async quote(body, ip = "") {
    const id = Number(body?.order), key = String(body?.key || "");
    const o = Number.isInteger(id) ? this.store.order(id) : null;
    if (!o || o.key !== key) return { status: 404, body: { error: "no such order; send the order number and its key" } };
    const what = cleanPrompt(body?.what ?? "", { max: PROMPT_MAX });
    if (!what) return { status: 400, body: { error: `say what you want built in ${PROMPT_MIN} to ${PROMPT_MAX} characters, as {"order": n, "key": "...", "what": "...", "contact": "..."}` } };
    const contact = cleanPrompt(body?.contact ?? "", { max: 120 }) || "";
    if (!this.mayCheck(`quote:${ip}`, this.clock.now())) return { status: 429, body: { error: "too many asks; wait ten minutes" } };
    this.store.setMeta(`shop:quote:${o.id}`, JSON.stringify({ at: this.clock.now(), what, contact }));
    this.log(`[shop] a quote was asked on order ${o.id}: ${what.slice(0, 80)}`);
    await this.tell(`A quote was asked on order #${o.id} (${o.item}, paid by ${short(o.payer)}): "${what}"${contact ? `. Contact: ${contact}` : ". No contact given; the buyer's wallet is the only address."}. Nothing moves without you: answer them with a price if you want the work.`);
    return { status: 200, body: { ok: true, order: o.id, note: "The owner was told. A quote comes back by the contact you gave, or not at all; nothing is charged for asking." } };
  }
  /// A request by form: what the person wants, in their words, how to reach them, a link, up to three files. No
  /// money moves and no model is asked. The words and the files are kept, the owner is told (the files go to him as
  /// documents), and he answers by hand. Closed unless the settings open it. { status, body }.
  async ask(body, ip = "") {
    if (!this.asksOpen) return { status: 503, body: { error: "requests by form are not open yet" } };
    if (body?.website) return { status: 200, body: { ok: true, note: "Sent." } }; // the field no person sees: answered as if taken, nothing kept
    const bad = (error) => ({ status: 400, body: { error } });
    const kind = Object.hasOwn(ASK_KINDS, String(body?.kind)) ? String(body.kind) : null;
    if (!kind) return bad(`say what you want: ${Object.keys(ASK_KINDS).join(", ")}`);
    const words = cleanPrompt(body?.words ?? "", { max: ASK_WORDS.max, keepLines: true });
    if (!words || words.length < ASK_WORDS.min) return bad(`tell us what you need in ${ASK_WORDS.min} to ${ASK_WORDS.max} characters`);
    if (BANNED_IDEA.test(words)) return bad("we do not make that");
    const contact = oneLine(body?.contact, 120);
    if (!contact || contact.length < 3) return bad("say how to reach you: an email, or a handle on Telegram or X");
    const link = oneLine(body?.link, 300);
    if (link === null || (link && !/^https:\/\/[^\s"'<>]+$/i.test(link))) return bad("the link must start with https://");
    // the files: each one decoded, measured, and checked against what its name says it is
    const sent = Array.isArray(body?.files) ? body.files : [];
    if (sent.length > ASK_FILES.max) return bad(`up to ${ASK_FILES.max} files`);
    const files = [];
    let total = 0;
    for (const x of sent) {
      const name = oneLine(x?.name, 120) || "";
      const ext = extname(name).toLowerCase();
      if (!ASK_FILES.kinds.includes(ext)) return bad(`"${name.slice(0, 60)}" is not a kind we take: ${ASK_FILES.kinds.join(" ")}`);
      const data = String(x?.data ?? "");
      if (!data || data.length > ASK_FILES.bytesEach * 1.4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return bad(`"${name.slice(0, 60)}" did not arrive whole`);
      const buf = Buffer.from(data, "base64");
      if (buf.length > ASK_FILES.bytesEach) return bad(`"${name.slice(0, 60)}" is over ${ASK_FILES.bytesEach / 1048576} MB`);
      total += buf.length;
      if (total > ASK_FILES.bytesAll) return bad(`the files are over ${ASK_FILES.bytesAll / 1048576} MB in all`);
      if (!fileLooksLike(ext, buf)) return bad(`"${name.slice(0, 60)}" is not what its name says`);
      files.push({ name: name.split(/[\\/]/).pop().replace(/[^A-Za-z0-9._ ()-]/g, "_").slice(-80), ext, buf });
    }
    // how often: three an hour from one address, forty a day in all, and never past the room on the disk
    const now = this.clock.now();
    const mine = (this.askTimes.get(ip) || []).filter((t) => now - t < 3_600_000);
    if (mine.length >= ASK_PER_HOUR) return { status: 429, body: { error: "three requests an hour; try again later" } };
    const dayKey = `shop:asks:${this.store.dayKey(now)}`, today = Number(this.store.getMeta(dayKey, 0)) || 0;
    if (today >= ASK_PER_DAY) return { status: 429, body: { error: "the box is full for today; write to us tomorrow" } };
    const folder = join(this.dir, "asks");
    if (files.length) {
      mkdirSync(folder, { recursive: true });
      const kept = readdirSync(folder).reduce((a, n) => a + statSync(join(folder, n)).size, 0);
      if (kept + total > ASK_DISK_MAX) return { status: 507, body: { error: "we cannot take files right now; send the request without them, or a link" } };
    }
    mine.push(now); this.askTimes.set(ip, mine);
    if (this.askTimes.size > 5000) for (const [k, v] of this.askTimes) if (!v.length || now - v[v.length - 1] > 3_600_000) this.askTimes.delete(k);
    const id = (Number(this.store.getMeta("shop:ask:n", 0)) || 0) + 1;
    this.store.setMeta("shop:ask:n", id);
    this.store.setMeta(dayKey, today + 1);
    // a kept file is named by us, never by the sender, and no route serves this folder
    const saved = files.map((x, i) => { const file = join(folder, `ask-${id}-${i + 1}${x.ext}`); writeFileSync(file, x.buf); return { name: x.name, bytes: x.buf.length, file }; });
    this.store.setMeta(`shop:ask:${id}`, JSON.stringify({ at: now, kind, words, contact, link: link || "", files: saved.map(({ name, bytes, file }) => ({ name, bytes, file })) }));
    this.log(`[shop] request ${id} by form: ${kind}, ${words.length} characters, ${saved.length} file(s)`);
    const size = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} kB`);
    await this.tell(`Biscotti got request #${id} by the form: ${ASK_KINDS[kind]}.\nFrom: ${contact}${link ? `\nLink: ${link}` : ""}${saved.length ? `\nFiles: ${saved.map((x) => `${x.name} (${size(x.bytes)})`).join(", ")}` : ""}\n\n${words.length > 3000 ? words.slice(0, 3000) + " [cut here, the rest is kept]" : words}\n\nNothing was paid and nothing was made. Answer them yourself.`);
    for (const x of saved) await this.tellFile(x.file, x.name, `Request #${id}: ${x.name}`);
    return { status: 200, body: { ok: true, request: id, note: "Sent. The owner reads every request and answers within a day, by the contact you gave. Nothing is charged for asking." } };
  }
  /// A kept file to the owner as a Telegram document. True when it went.
  async tellFile(file, filename, caption = "") {
    if (!this.telegram?.configured || !this.ownerChatId || typeof this.telegram._send !== "function") return false;
    try {
      const form = new FormData();
      form.append("chat_id", String(this.ownerChatId));
      if (caption) form.append("caption", String(caption).slice(0, 1000));
      form.append("document", new Blob([readFileSync(file)]), filename);
      await this.telegram._send("sendDocument", { method: "POST", body: form }, 120_000);
      return true;
    } catch (e) { this.log(`[shop] Telegram did not take the file ${filename}: ${e.message}`); return false; }
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
  keep(order, srcFile, suffix = "") {
    mkdirSync(this.dir, { recursive: true });
    const name = `order-${order.id}-${order.key}${String(suffix || "").toLowerCase().replace(/[^a-z0-9-]/g, "")}${extname(srcFile).toLowerCase()}`;
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

/// The request body: JSON when it parses, else the text as the prompt. Never more than 20 KB, except where a
/// route says so (the request form carries files).
function readBody(req, max = 20_000, { answer = false } = {}) {
  return new Promise((res, rej) => {
    let s = "", over = false, extra = 0;
    // answer: the caller says why, so the rest of the body is let through and thrown away (a line cut while the
    // sender is still writing loses the answer), up to three times the limit; otherwise the line is cut at once
    req.on("data", (d) => {
      if (over) { extra += d.length; if (extra > 3 * max) req.destroy(); return; }
      s += d;
      if (s.length > max) { over = true; s = ""; rej(new Error("too large")); if (!answer) req.destroy(); }
    });
    req.on("end", () => { if (!s) return res({}); try { res(JSON.parse(s)); } catch { res({ prompt: s }); } });
    req.on("error", rej);
  });
}
