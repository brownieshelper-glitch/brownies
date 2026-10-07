// The Bakery: holders bake their own brownies. A holder of BROWNIE connects a wallet, signs a login, and bakes one
// brownie: a name, a personality, one to three jobs (from the menu or in their own words), a daily cap. The brownie
// is a recruit (lib/recruit.mjs) like the ones Dough hires, hidden from the Kitchen, with two tools only: feed
// (its own feed, read by the Bakery pages) and draft (to the holder's Telegram once linked). It pays for its
// thinking from the holder's own SUGAR through a grant on the gateway: the brownie has a wallet of its own, derived
// from HELPERS_MNEMONIC by index, and every call it makes names the holder in X-Brownies-Pay-From. It never holds
// a key of the holder and never moves tokens.
//
//   GET  /bake/info                          public: open or not, the minimum hold, the menu, the room left
//   GET  /bake/feed                          public: every baked brownie and its latest work
//   GET  /bake/nonce                         { nonce, message } for the wallet login
//   POST /bake/login  { address, signature, nonce }  -> { token, expiresAt, wallet }
//   GET  /bake/mine                          (bearer) the holder's brownies, with wallet, cap, spend, feed
//   POST /bake/create { name, role, personality, model, dailyCapUsd, tasks: [{ menu } | { title, text, tool, hours }] }
//   POST /bake/ask    { name, text }         (bearer) one instruction now, a few a day
//   POST /bake/retire { name }               (bearer) ends the holder's brownie
//   POST /bake/link   { name }               (bearer) a six-digit code; the holder sends /link <code> to the bot in a
//                                            private chat and that chat gets the brownie's drafts and answers
//   POST /bake/unlink { name }               (bearer) the chat is forgotten
//   POST /bake/logout
//   In Telegram (handed over by Crumb from any private chat): /link <code>, /mybrownie, /mybrownie ask <what>,
//   /mybrownie feed, /mybrownie unlink, /mybrownie retire (asks once more).
//
// Before the launch there is no coin and no SUGAR: only the admin wallets may bake, so the owner can try it. Live,
// a wallet needs at least `minHold` BROWNIE held or staked (read from the chain), one brownie per wallet, and the
// Bakery as a whole holds at most `maxTotal`. The owner hears about every bake and can retire any brownie.
import { createHash, randomBytes, randomInt } from "node:crypto";
import { verifyMessage, getAddress, isAddress, JsonRpcProvider, Contract, formatUnits } from "ethers";
import { validateSpec, BAKED_TOOLS } from "./recruit.mjs";
import { cap } from "./facts.mjs";
import { cut } from "./text.mjs";

export const bakeMessage = (nonce) => `Brownies bakery login ${nonce}`;
const SESSION_TTL = 24 * 3_600_000, NONCE_TTL = 10 * 60_000, LINK_TTL = 10 * 60_000;
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const nowIso = (ms) => new Date(ms).toISOString();
const short = (a) => (a ? a.slice(0, 6) + "..." + a.slice(-4) : "");
const ago = (at, now) => { const s = Math.max(0, Math.round((now - at) / 1000)); if (s < 60) return "just now"; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`; const d = Math.floor(s / 86400); return `${d} ${d === 1 ? "day" : "days"} ago`; };
const COMMANDS = "Commands: /mybrownie (how it is doing), /mybrownie ask <what to do>, /mybrownie feed (its latest work), /mybrownie unlink, /mybrownie retire.";

/// The jobs a holder can pick without writing instructions. Hours are the holder's choice; these are the defaults.
export const JOB_MENU = [
  { id: "watch", title: "Daily watch", tool: "feed", hours: [9], text: "Look at the live figures you are given about the coin, the gateway and the brownies, and write a short plain update for your holder: what changed since yesterday, in three to six lines. No predictions, no advice, no numbers that are not in what you were given." },
  { id: "digest", title: "Evening digest", tool: "draft", hours: [20], text: "Write a short digest of what the brownies did today and what people asked, for a holder who checks in once a day. Five to eight lines, plain words." },
  { id: "posts", title: "Post ideas", tool: "draft", hours: [11], text: "Draft three short posts about Brownies for X, each under 240 characters, in the project's voice, from the facts only. Your holder posts them, so make them ready to paste." },
  { id: "faq", title: "Questions people ask", tool: "feed", hours: [17], text: "Pick the three questions people asked most this week about Brownies and answer each in two or three plain sentences from the facts." },
  { id: "note", title: "Weekly note", tool: "feed", hours: [8], text: "Read the latest research note and the facts, and write what a holder should know this week, in a few lines, with no numbers that are not in the facts." },
];

export class Bakery {
  /// W: the built world (S, store, clock, brain, telegram, gateway, config). hire(spec) -> recruit, fire(name), recruits(), roster().
  /// holdOf(wallet) -> bigint of BROWNIE (held + staked) can be injected; by default it reads the chain from deploymentJson.
  constructor({ W, log = () => {}, origins = [], hire, fire, recruits, roster, config = {}, adminWallets = [], rpcUrl = "", deploymentJson = "", holdOf = null, fetch = globalThis.fetch }) {
    this.W = W; this.log = log; this.origins = origins;
    this.hireFn = hire; this.fireFn = fire; this.recruitsFn = recruits || (() => []); this.rosterFn = roster || (() => []);
    this.on = config.on !== false;
    this.minHold = Number(config.minHold ?? 10_000);
    this.maxPerWallet = Number(config.maxPerWallet ?? 1);
    this.maxTotal = Number(config.maxTotal ?? 50);
    this.maxCapUsd = Number(config.maxCapUsd ?? 1);
    this.defaultCapUsd = Number(config.defaultCapUsd ?? 0.5);
    this.asksPerDay = Number(config.asksPerDay ?? 3);
    this.models = Array.isArray(config.models) && config.models.length ? config.models : ["anthropic/claude-haiku-4.5"];
    this.adminWallets = adminWallets.filter(isAddress).map((a) => getAddress(a));
    this.rpcUrl = rpcUrl; this.deploymentJson = deploymentJson; this.fetch = fetch;
    this._holdOf = holdOf; this._deployment = null; this._bot = null;
    this.attempts = new Map();
  }

  get live() { return this.W.S?.mode === "live"; }
  baked() { return this.recruitsFn().filter((r) => r.spec?.baked); }
  ofHolder(wallet) { return this.baked().filter((r) => r.spec.baked.wallet === wallet); }

  // ---- proofs ----
  newNonce() {
    const nonce = randomBytes(16).toString("hex");
    this.W.store.setMeta(`bake:nonce:${nonce}`, this.W.clock.now() + NONCE_TTL);
    return nonce;
  }
  login({ address, signature, nonce }) {
    if (!isAddress(address || "") || !/^[0-9a-f]{32}$/.test(String(nonce || ""))) return null;
    const exp = Number(this.W.store.getMeta(`bake:nonce:${nonce}`, 0));
    if (!exp || this.W.clock.now() > exp) return null;
    let who;
    try { who = getAddress(verifyMessage(bakeMessage(nonce), signature)); } catch { return null; }
    if (who !== getAddress(address)) return null;
    this.W.store.setMeta(`bake:nonce:${nonce}`, null);
    const token = randomBytes(32).toString("hex");
    const expiresAt = this.W.clock.now() + SESSION_TTL;
    this.W.store.setMeta(`bake:session:${sha(token)}`, JSON.stringify({ wallet: who, expiresAt }));
    return { token, expiresAt, wallet: who };
  }
  /// The wallet of the session in the request, or null.
  authed(req) {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || "");
    if (!m) return null;
    const raw = this.W.store.getMeta(`bake:session:${sha(m[1])}`);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return this.W.clock.now() < s.expiresAt ? s.wallet : null;
  }
  logout(req) {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || "");
    if (m) this.W.store.setMeta(`bake:session:${sha(m[1])}`, null);
  }
  tooMany(ip) {
    const now = this.W.clock.now();
    const list = (this.attempts.get(ip) || []).filter((t) => now - t < 10 * 60_000);
    list.push(now); this.attempts.set(ip, list);
    return list.length > 20;
  }

  // ---- the hold ----
  async deployment() {
    if (this._deployment) return this._deployment;
    const r = await this.fetch(this.deploymentJson);
    if (!r.ok) throw new Error(`the deployment file answered ${r.status}`);
    this._deployment = await r.json();
    return this._deployment;
  }
  /// BROWNIE held plus staked, as a bigint of 18 decimals. Reads the chain unless a reader was injected.
  async holdOf(wallet) {
    if (this._holdOf) return BigInt(await this._holdOf(wallet));
    const d = await this.deployment();
    if (!isAddress(d.token || "") || !isAddress(d.staking || "")) throw new Error("the deployment file has no token or staking address");
    const provider = new JsonRpcProvider(this.rpcUrl, undefined, { staticNetwork: true });
    const token = new Contract(d.token, ["function balanceOf(address) view returns (uint256)"], provider);
    const staking = new Contract(d.staking, ["function stakeOf(address) view returns (uint256)"], provider);
    const [held, staked] = await Promise.all([token.balanceOf(wallet), staking.stakeOf(wallet).catch(() => 0n)]);
    return BigInt(held) + BigInt(staked);
  }

  /// May this wallet bake one more brownie now? { ok, reason, hold }.
  async mayBake(wallet) {
    if (!this.on) return { ok: false, reason: "the Bakery is closed for now" };
    if (this.baked().length >= this.maxTotal) return { ok: false, reason: "the Bakery is full for now" };
    if (this.ofHolder(wallet).length >= this.maxPerWallet) return { ok: false, reason: this.maxPerWallet === 1 ? "one brownie per wallet for now" : `${this.maxPerWallet} brownies per wallet for now` };
    if (!this.live) return this.adminWallets.includes(wallet) ? { ok: true, reason: "", hold: null, trial: true } : { ok: false, reason: "the Bakery opens with the launch" };
    if (!this.W.brain?.mnemonic) { this.log("[bakery] HELPERS_MNEMONIC is empty: no wallet can be made for a baked brownie"); return { ok: false, reason: "the Bakery cannot make wallets yet; try later" }; }
    let hold;
    try { hold = await this.holdOf(wallet); } catch (e) { this.log(`[bakery] could not read the hold of ${short(wallet)}: ${e.message}`); return { ok: false, reason: "could not read your BROWNIE balance; try again in a minute" }; }
    const whole = Number(formatUnits(hold, 18));
    if (whole < this.minHold) return { ok: false, reason: `you need at least ${this.minHold.toLocaleString("en-US")} BROWNIE held or staked; this wallet has ${Math.floor(whole).toLocaleString("en-US")}`, hold: whole };
    return { ok: true, reason: "", hold: whole };
  }

  // ---- baking ----
  /// Tasks from the request: a menu id, or a title with instructions. At most three, feed or draft only.
  tasks(list) {
    const out = [];
    for (const t of (Array.isArray(list) ? list : []).slice(0, 3)) {
      if (!t || typeof t !== "object") continue;
      const hours = (Array.isArray(t.hours) ? t.hours : t.daily?.hours || []).map(Number).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23).slice(0, 3);
      if (t.menu) {
        const m = JOB_MENU.find((j) => j.id === String(t.menu).toLowerCase());
        if (!m) throw new Error(`no menu job called ${cut(String(t.menu), 24)}`);
        out.push({ id: m.id, title: m.title, text: m.text, tool: m.tool, daily: { hours: hours.length ? hours : m.hours }, maxWords: 250 });
      } else {
        const tool = BAKED_TOOLS.includes(t.tool) ? t.tool : "feed";
        if (String(t.title || "").trim().length < 2 || String(t.text || "").trim().length < 12) continue; // an empty line in the form, not a job
        out.push({ id: String(t.id || t.title || `task${out.length + 1}`).toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 24) || `task${out.length + 1}`, title: String(t.title || "").trim(), text: String(t.text || "").trim(), tool, daily: { hours: hours.length ? hours : [10] }, maxWords: Math.min(500, Math.max(60, Number(t.maxWords) || 200)) });
      }
    }
    return out;
  }

  /// Bakes a brownie for the holder. Throws a plain sentence when it cannot.
  async create(wallet, body = {}) {
    const may = await this.mayBake(wallet);
    if (!may.ok) throw new Error(may.reason);
    const now = this.W.clock.now();
    const model = this.models.includes(body.model) ? body.model : this.models[0];
    const index = Number(this.W.store.getMeta("bakery:nextIndex", 0));
    const raw = {
      name: body.name, role: body.role, model, dailyCapUsd: body.dailyCapUsd ?? this.defaultCapUsd, hidden: true,
      tools: BAKED_TOOLS, tasks: this.tasks(body.tasks), hiredAt: now, why: `baked by ${wallet}`,
      baked: { wallet, chatId: null, personality: body.personality || "" },
      walletIndex: index,
      payFrom: this.live ? wallet : undefined,
    };
    const spec = validateSpec(raw, { maxCapUsd: this.maxCapUsd, existing: this.rosterFn().map((h) => h.name), allowedTools: BAKED_TOOLS });
    this.W.store.setMeta("bakery:nextIndex", index + 1);
    const r = await this.hireFn(spec);
    this.log(`[bakery] ${short(wallet)} baked ${spec.title} (${spec.tasks.map((t) => t.id).join(", ")}; cap ${spec.dailyCapUsd} USD a day${this.live ? "" : "; trial before the launch"})`);
    const tg = this.W.telegram, owner = this.W.S?.telegram?.ownerChatId;
    if (tg?.configured && owner) { try { await tg.sendMessage(owner, `A holder baked ${spec.title}: ${cut(spec.role, 160)}\nHolder ${wallet}\nJobs: ${spec.tasks.map((t) => t.title).join(", ")}. Cap ${spec.dailyCapUsd} USD a day.${this.live ? "" : " (a trial before the launch)"}\nRetire it with /fire ${spec.name} if it misbehaves.`); } catch (e) { this.log(`[bakery] could not tell the owner: ${e.message}`); } }
    return this.view(r, { full: true });
  }

  /// Ends the holder's own brownie.
  async retire(wallet, name) {
    const r = this.ofHolder(wallet).find((x) => x.name === String(name || "").toLowerCase());
    if (!r) throw new Error("that is not one of your brownies");
    const ok = await this.fireFn(r.name);
    if (ok) this.log(`[bakery] ${short(wallet)} retired ${r.title}`);
    return ok;
  }

  /// One instruction now, a few a day. Runs in the background; the result lands in the feed (and in the chat it came from).
  async ask(wallet, name, text, { chatId = null } = {}) {
    const r = this.ofHolder(wallet).find((x) => x.name === String(name || "").toLowerCase());
    if (!r) throw new Error("that is not one of your brownies");
    const t = cut(String(text || "").trim(), 1000);
    if (t.length < 4) throw new Error("write what you want it to do");
    const day = this.W.store.dayKey(this.W.clock.now()), k = `bakery:asks:${r.name}:${day}`;
    const n = Number(this.W.store.getMeta(k, 0));
    if (n >= this.asksPerDay) throw new Error(`${this.asksPerDay} instructions a day; more tomorrow`);
    this.W.store.setMeta(k, n + 1);
    const p = Promise.resolve().then(() => r.onRequest(t));
    p.then(async (out) => {
      this.log(`[bakery] ${r.name} did: ${out ? cut(String(out.title || out.text || "done"), 80) : "nothing (budget or an error)"}`);
      const tg = this.W.telegram;
      if (chatId && tg?.configured) await tg.sendMessage(chatId, out?.text ? `${r.title}: ${cut(String(out.text), 3700)}` : `${r.title} could not do that one now (budget or an error).`).catch(() => {});
    }).catch((e) => this.log(`[bakery] ${r.name} failed: ${e.message}`));
    return { started: true, left: this.asksPerDay - n - 1 };
  }

  // ---- Telegram: the holder links a private chat with the bot to their brownie ----
  async botName() {
    if (this._bot) return this._bot;
    try { const me = await this.W.telegram?.me?.(); if (me?.username) this._bot = `@${me.username}`; } catch { /* no Telegram */ }
    return this._bot || "the Brownies bot";
  }
  /// A one-time code the holder sends to the bot as /link <code>. Ten minutes.
  async linkCode(wallet, name) {
    const r = this.ofHolder(wallet).find((x) => x.name === String(name || "").toLowerCase());
    if (!r) throw new Error("that is not one of your brownies");
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = this.W.clock.now() + LINK_TTL;
    this.W.store.setMeta(`bake:link:${code}`, JSON.stringify({ name: r.name, wallet, expiresAt }));
    return { code, bot: await this.botName(), expiresAt, name: r.name };
  }
  /// The bot got /link <code> from a chat: that chat is the brownie's holder chat from now on. The recruit, or null.
  consumeLink(code, chatId) {
    const k = `bake:link:${String(code || "").trim()}`;
    const raw = this.W.store.getMeta(k);
    if (!raw) return null;
    this.W.store.setMeta(k, null);
    const c = JSON.parse(raw);
    if (this.W.clock.now() > c.expiresAt) return null;
    const r = this.recruitsFn().find((x) => x.name === c.name && x.spec?.baked);
    if (!r) return null;
    this.setChat(r, String(chatId));
    return r;
  }
  setChat(r, chatId) {
    r.spec.baked.chatId = chatId || null;
    if (r.baked) r.baked.chatId = chatId || null;
    this.W.store.setMeta(`recruit:${r.name}`, JSON.stringify(r.spec));
  }
  async unlink(wallet, name) {
    const r = this.ofHolder(wallet).find((x) => x.name === String(name || "").toLowerCase());
    if (!r) throw new Error("that is not one of your brownies");
    this.setChat(r, null);
    return true;
  }
  /// The brownies linked to a chat.
  ofChat(chatId) { return this.baked().filter((r) => r.spec.baked.chatId && r.spec.baked.chatId === String(chatId)); }

  /// /link <code> and /mybrownie ... from a private chat with the bot (Crumb hands them over). The reply, or null.
  async holderCommand(cmd, rest, { chatId } = {}) {
    const chat = String(chatId || "");
    const text = String(rest || "").trim();
    if (cmd === "link") {
      if (!/^\d{6}$/.test(text)) return "Send the six-digit code from the bake page, like this: /link 123456";
      const r = this.consumeLink(text, chat);
      if (!r) return "That code is not valid or has expired. Press Link Telegram on feedthebrownies.com/bake.html for a new one.";
      this.log(`[bakery] ${r.title} is linked to a Telegram chat`);
      return `Linked. ${r.title}'s drafts and answers come to this chat from now on.\n\n${COMMANDS}`;
    }
    if (cmd !== "mybrownie") return null;
    const mine = this.ofChat(chat);
    if (!mine.length) return "No brownie is linked to this chat yet. On feedthebrownies.com/bake.html press Link Telegram and send me the code with /link.";
    // "/mybrownie sage ask ..." names one of several; otherwise the first
    let r = mine[0], words = text;
    const first = (text.split(/\s+/)[0] || "").toLowerCase();
    const named = mine.find((x) => x.name === first);
    if (named) { r = named; words = text.slice(first.length).trim(); }
    const [, sub = "", arg = ""] = words.match(/^(\w*)\s*([\s\S]*)$/) || [];
    const s = sub.toLowerCase();
    if (!s) return mine.map((x) => this.statusText(x)).join("\n\n");
    if (s === "feed") { const f = r.feed(5); const now = this.W.clock.now(); return f.length ? `${r.title}'s latest work:\n\n${f.map((e) => `${e.title}, ${ago(e.at, now)}:\n${cut(String(e.text), 600)}`).join("\n\n")}` : `${r.title} has made nothing yet.`; }
    if (s === "ask") { try { const out = await this.ask(r.spec.baked.wallet, r.name, arg, { chatId: chat }); return `${r.title} is on it. The answer comes here and lands in its feed. ${out.left} ${out.left === 1 ? "instruction" : "instructions"} left today.`; } catch (e) { return e.message; } }
    if (s === "unlink") { this.setChat(r, null); return `Unlinked. ${r.title}'s drafts stay in its feed on the site.`; }
    if (s === "retire") { if (!/^yes\b/i.test(arg)) return `Retire ${r.title}? Its jobs stop and it leaves the shelf. Send: /mybrownie retire yes`; const ok = await this.fireFn(r.name); return ok ? `${r.title} is retired.` : "Could not retire it."; }
    return COMMANDS;
  }
  statusText(r) {
    const { store, clock } = this.W; const now = clock.now();
    const spent = store.spentToday(r.name, now);
    const last = r.feed(1)[0];
    const jobs = r.spec.tasks.map((t) => `${t.title} at ${(t.daily?.hours || []).map((h) => `${h}:00`).join(" and ")}`).join("; ");
    return `${r.title}: ${r.spec.role}\nJobs: ${jobs}\nJobs done: ${Number(store.getMeta(`recruit:${r.name}:outputs`, 0))}. Spent today: ${(spent.micro / 1e6).toFixed(4)} of ${Number(r.spec.dailyCapUsd).toFixed(2)} USD.${last ? `\nLatest: ${last.title}, ${ago(last.at, now)}.` : ""}`;
  }

  // ---- what the pages read ----
  view(r, { full = false } = {}) {
    const { store, clock, brain } = this.W;
    const now = clock.now();
    const spec = r.spec, b = spec.baked;
    const out = {
      name: r.name, title: r.title, role: spec.role, personality: b.personality, holder: b.wallet, holderShort: short(b.wallet),
      since: spec.hiredAt ? nowIso(spec.hiredAt) : null, outputs: Number(store.getMeta(`recruit:${r.name}:outputs`, 0)),
      lastJob: store.lastJob(r.name), tasks: spec.tasks.map((t) => ({ id: t.id, title: t.title, tool: t.tool, hours: t.daily?.hours || null })),
      feed: r.feed(full ? 10 : 3), telegram: Boolean(b.chatId),
    };
    if (full) {
      let wallet = null; try { wallet = brain.address(r.name); } catch { /* no mnemonic before the launch */ }
      const spent = store.spentToday(r.name, now);
      Object.assign(out, {
        wallet, payFrom: spec.payFrom || null, model: spec.model, capUsd: spec.dailyCapUsd, spentTodayUsd: spent.micro / 1e6, callsToday: spent.calls,
        fund: this.live && wallet ? { how: "grant", gateway: this.W.S.gatewayUrl, grantee: wallet, daily_usd: spec.dailyCapUsd, header: `X-Brownies-Pay-From: ${b.wallet}`, note: `Give ${r.title}'s wallet a grant on your SUGAR at the gateway (POST /v1/grants) and it starts working. Revoke the grant any time.` } : null,
        asksLeft: Math.max(0, this.asksPerDay - Number(store.getMeta(`bakery:asks:${r.name}:${store.dayKey(now)}`, 0))),
      });
    }
    return out;
  }
  info() {
    return {
      on: this.on, live: this.live, minHold: this.minHold, maxPerWallet: this.maxPerWallet, maxTotal: this.maxTotal, total: this.baked().length, room: Math.max(0, this.maxTotal - this.baked().length),
      maxCapUsd: this.maxCapUsd, defaultCapUsd: this.defaultCapUsd, asksPerDay: this.asksPerDay, models: this.models, tools: BAKED_TOOLS,
      menu: JOB_MENU.map((j) => ({ id: j.id, title: j.title, tool: j.tool, hours: j.hours, text: j.text })),
      message: bakeMessage("<nonce>"), chainId: this.W.config?.chainId || 1, timezone: this.W.config?.timezone || "UTC",
    };
  }
  feed() { return this.baked().map((r) => this.view(r)).sort((a, b) => String(b.since).localeCompare(String(a.since))); }

  // ---- the HTTP side ----
  cors(req, res) {
    const origin = req.headers.origin || "";
    const ok = this.origins.find((o) => (o instanceof RegExp ? o.test(origin) : o === origin));
    if (ok) { res.setHeader("access-control-allow-origin", origin); res.setHeader("vary", "origin"); }
    else if (!origin) res.setHeader("access-control-allow-origin", "*"); // a curl or a server: the public routes are public
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  }
  async handle(req, res) {
    const url = new URL(req.url, "http://x");
    this.cors(req, res);
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    try {
      if (req.method === "GET" && url.pathname === "/bake/info") return json(200, this.info());
      if (req.method === "GET" && url.pathname === "/bake/feed") return json(200, { brownies: this.feed() });
      if (req.method === "GET" && url.pathname === "/bake/nonce") return json(200, { nonce: this.newNonce(), message: bakeMessage("<nonce>") });
      if (req.method === "POST" && url.pathname === "/bake/login") {
        const ip = req.socket?.remoteAddress || "?";
        if (this.tooMany(ip)) return json(429, { error: "too many tries; wait ten minutes" });
        const s = this.login(await readJson(req));
        return s ? json(200, s) : json(401, { error: "the signature does not match the wallet, or the nonce expired" });
      }
      const wallet = this.authed(req);
      if (!wallet) return json(401, { error: "log in first" });
      if (req.method === "GET" && url.pathname === "/bake/mine") { const may = await this.mayBake(wallet); return json(200, { wallet, brownies: this.ofHolder(wallet).map((r) => this.view(r, { full: true })), canBake: may.ok, why: may.reason || "", hold: may.hold ?? null, trial: Boolean(may.trial) }); }
      if (req.method === "POST" && url.pathname === "/bake/create") {
        try { return json(200, await this.create(wallet, await readJson(req))); }
        catch (e) { return json(400, { error: e.message }); }
      }
      if (req.method === "POST" && url.pathname === "/bake/ask") {
        const b = await readJson(req);
        try { return json(200, await this.ask(wallet, b.name, b.text)); } catch (e) { return json(400, { error: e.message }); }
      }
      if (req.method === "POST" && url.pathname === "/bake/retire") {
        const b = await readJson(req);
        try { return json(200, { retired: await this.retire(wallet, b.name) }); } catch (e) { return json(400, { error: e.message }); }
      }
      if (req.method === "POST" && url.pathname === "/bake/link") { const b = await readJson(req); try { return json(200, await this.linkCode(wallet, b.name)); } catch (e) { return json(400, { error: e.message }); } }
      if (req.method === "POST" && url.pathname === "/bake/unlink") { const b = await readJson(req); try { return json(200, { unlinked: await this.unlink(wallet, b.name) }); } catch (e) { return json(400, { error: e.message }); } }
      if (req.method === "POST" && url.pathname === "/bake/logout") { this.logout(req); return json(200, { ok: true }); }
      return json(404, { error: "no such route" });
    } catch (e) {
      this.log(`[bakery] ${req.method} ${url.pathname} failed: ${e.message}`);
      return json(500, { error: e.message });
    }
  }
}

function readJson(req) {
  return new Promise((res, rej) => {
    let s = "";
    req.on("data", (d) => { s += d; if (s.length > 100_000) { rej(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { res(s ? JSON.parse(s) : {}); } catch { rej(new Error("bad json")); } });
    req.on("error", rej);
  });
}

export { cap };
