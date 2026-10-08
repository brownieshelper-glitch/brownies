// The owner's control room. A small API on the helpers' own server (reached through the gateway's domain at
// /admin/*) that the admin page of the site talks to. Nothing is readable without a session, and a session comes
// from one of two proofs: a one-time code the bot sends to the owner's Telegram (/admin), or a signature from one
// of the admin wallets. Every helper is shown, hidden ones too; the owner can run a job now, pause and resume a
// helper, change its daily cap, give it an instruction, decide a pending approval, and read the live log.
//
//   GET  /admin/nonce                      { nonce }                      for a wallet login
//   POST /admin/login  { code } | { address, signature, nonce }   -> { token, expiresAt }
//   GET  /admin/state                      everything the page shows (bearer token)
//   POST /admin/command { helper, action, text?, id?, value? }     action: run | ask | off | on | cap | approve | reject | summary
//   GET  /admin/log?n=200                  the last lines of the service log
//   POST /admin/logout
import { defang } from "./suggestions.mjs";
import { clientIp } from "./net.mjs";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { applyAction as jobAction, totalsView as jobTotals, STATE_LABEL as JOB_STATE } from "./moneyjobs.mjs";
import { verifyMessage, getAddress, isAddress } from "ethers";
import { cap } from "./facts.mjs";

const CODE_TTL = 10 * 60_000, SESSION_TTL = 24 * 3_600_000, NONCE_TTL = 10 * 60_000;
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const nowIso = (ms) => new Date(ms).toISOString();

export class Admin {
  /// W: the built world (S, store, clock, scheduler, helpers, brain, telegram, alerts, config, hidden, off). ring: the log lines.
  constructor({ W, ring = [], log = () => {}, wallets = [], origins = [], sendSummary = null }) {
    this.W = W; this.ring = ring; this.log = log;
    this.wallets = wallets.filter(isAddress).map((a) => getAddress(a));
    this.origins = origins;
    this.sendSummary = sendSummary;
    this.attempts = new Map(); // ip -> [times]
    this.paused = new Set(this.W.store.getMeta("admin:paused", "").split(",").filter(Boolean));
    for (const [h, c] of Object.entries(this.W.brain.helpers || {})) { const v = this.W.store.getMeta(`admin:cap:${h}`); if (v != null) c.dailyCapUsd = Number(v); }
  }

  // ---- proofs ----
  /// A fresh one-time code for the owner (sent by the bot). Replaces any earlier code.
  newCode() {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.W.store.setMeta("admin:code", JSON.stringify({ hash: sha(code), expiresAt: this.W.clock.now() + CODE_TTL }));
    this.W.store.setMeta("admin:code:misses", 0);
    return code;
  }
  newNonce() {
    const nonce = randomBytes(16).toString("hex");
    this.W.store.setMeta(`admin:nonce:${nonce}`, this.W.clock.now() + NONCE_TTL);
    return nonce;
  }
  session() {
    const token = randomBytes(32).toString("hex");
    const expiresAt = this.W.clock.now() + SESSION_TTL;
    this.W.store.setMeta(`admin:session:${sha(token)}`, expiresAt);
    return { token, expiresAt };
  }
  tooMany(ip) {
    const now = this.W.clock.now();
    const list = (this.attempts.get(ip) || []).filter((t) => now - t < 10 * 60_000);
    list.push(now); this.attempts.set(ip, list);
    return list.length > 10;
  }
  loginWithCode(code) {
    const raw = this.W.store.getMeta("admin:code");
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (this.W.clock.now() > c.expiresAt) { this.W.store.setMeta("admin:code", null); return null; }
    if (sha(String(code || "").trim()) !== c.hash) {
      // five wrong guesses burn the code: a guesser gets nothing, the owner asks the bot for a fresh one
      const misses = Number(this.W.store.getMeta("admin:code:misses", 0)) + 1;
      this.W.store.setMeta("admin:code:misses", misses);
      if (misses >= 5) { this.W.store.setMeta("admin:code", null); this.log("[admin] the one-time code was burnt after five wrong tries"); }
      return null;
    }
    this.W.store.setMeta("admin:code", null); // one use
    this.W.store.setMeta("admin:code:misses", 0);
    return this.session();
  }
  loginWithWallet({ address, signature, nonce }) {
    if (!this.wallets.length || !isAddress(address || "")) return null;
    const exp = Number(this.W.store.getMeta(`admin:nonce:${nonce}`, 0));
    if (!exp || this.W.clock.now() > exp) return null;
    let who;
    try { who = getAddress(verifyMessage(adminMessage(nonce), signature)); } catch { return null; }
    if (who !== getAddress(address) || !this.wallets.includes(who)) return null;
    this.W.store.setMeta(`admin:nonce:${nonce}`, null);
    return this.session();
  }
  authed(req) {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || "");
    if (!m) return false;
    const exp = Number(this.W.store.getMeta(`admin:session:${sha(m[1])}`, 0));
    return Boolean(exp) && this.W.clock.now() < exp;
  }
  logout(req) {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || "");
    if (m) this.W.store.setMeta(`admin:session:${sha(m[1])}`, null);
  }

  // ---- what the page shows ----
  isPaused(helper) { return this.paused.has(helper) || this.W.off.includes(helper); }
  state() {
    const { S, store, clock, scheduler, helpers, brain, config } = this.W;
    const now = clock.now();
    const list = Object.entries(helpers).map(([name, h]) => {
      const c = config.helpers[name] || {};
      const jobs = scheduler.jobs.filter((j) => j.helper === name).map((j) => ({ id: j.id, next: j.next ? nowIso(j.next) : null, runs: j.runs, daily: j.daily ? j.daily.hours : null, everyMinutes: j.every ? Math.round(j.every / 60_000) : null }));
      const spent = store.spentToday(name, now);
      return {
        name, title: cap(name), role: c.role || h.role || "", hidden: Boolean(h.hidden), paused: this.isPaused(name), pausedByEnv: this.W.off.includes(name),
        model: brain.model(name), capUsd: brain.capMicro(name) / 1e6, spentTodayUsd: spent.micro / 1e6, callsToday: spent.calls,
        lastJob: store.lastJob(name), jobs, canAsk: typeof h.onRequest === "function",
        recruit: Boolean(h.recruit), tasks: h.recruit ? h.spec.tasks.map((t) => ({ id: t.id, title: t.title, tool: t.tool })) : undefined, why: h.recruit ? h.spec.why : undefined,
        baked: h.spec?.baked ? { holder: h.spec.baked.wallet, telegram: Boolean(h.spec.baked.chatId), wallet: (() => { try { return brain.address(name); } catch { return null; } })() } : undefined,
      };
    });
    return {
      mode: S.mode, now: nowIso(now), timezone: config.timezone || "UTC", uptimeSeconds: Math.round((Date.now() - (this.W.startedAt || Date.now())) / 1000),
      helpers: list,
      approvals: store.pendingApprovals().map((a) => ({ id: a.id, helper: a.helper, title: a.title, url: a.url, at: nowIso(a.at) })),
      suggestions: store.suggestions({ limit: 200 }).map((s) => ({ id: s.id, at: nowIso(s.at), place: s.place, who: s.who, chat: s.chat, text: defang(s.text), flags: s.flags, state: s.state, note: s.note, url: s.url })),
      videos: Number(store.getMeta("sprinkle:videos", 0)) || 0,
      jobs: { totals: jobTotals(store), list: store.moneyJobs({ limit: 80 }).map((j) => { let draft = null, contact = null; try { draft = JSON.parse(store.getMeta(`job:${j.id}:draft`) || "null"); } catch { draft = null; } try { contact = JSON.parse(store.getMeta(`job:${j.id}:contact`) || "null"); } catch { contact = null; } return { ...j, stateLabel: JOB_STATE[j.state] || j.state, draft, contact }; }) },
      group: store.getMeta("tg:group:auto") || this.W.S.telegram.groupChatId || "",
      reports: this.W.gateway.reports, thoughts: brain.calls,
    };
  }

  // ---- commands ----
  async command({ helper = "", action = "", text = "", id = null, value = null } = {}) {
    const { store, scheduler, helpers } = this.W;
    const h = helpers[helper];
    this.log(`[admin] ${action}${helper ? " " + helper : ""}${text ? ": " + String(text).slice(0, 80) : ""}`);
    switch (action) {
      case "summary": { if (!this.sendSummary) return { ok: false, error: "no summary here" }; await this.sendSummary(); return { ok: true }; }
      case "job": {
        const now = this.W.clock.now();
        if (String(value) === "pick" && helpers.zest?.pick) {
          const r = await helpers.zest.pick(Number(id));
          return r.error ? { ok: false, error: r.error } : { ok: true, job: r.job, note: `Picked for ${cap(r.helper)}${r.handed ? "; the draft is in your Telegram" : ""}.` };
        }
        const r = jobAction(store, { id: Number(id), action: String(value || ""), text, value: text, by: "owner", now });
        return r.error ? { ok: false, error: r.error } : { ok: true, job: r.job, note: `Job ${r.job.id} is now ${JOB_STATE[r.job.state]}.` };
      }
      case "suggest": {
        // the owner's decision on a suggestion from the public: listen (the brownies may consider it), ignore, or back to new
        const s = store.suggestion(Number(id));
        if (!s) return { ok: false, error: "no such suggestion" };
        const state = String(value || "");
        if (!["listen", "ignore", "new"].includes(state)) return { ok: false, error: "listen, ignore or new" };
        store.decideSuggestion(s.id, state, String(text || "").trim() || null, this.W.clock.now());
        return { ok: true, note: state === "listen" ? "The brownies will consider it. They still promise nothing and post no link or address from it." : state === "ignore" ? "Ignored." : "Back to new." };
      }
      case "approve": case "reject": {
        const a = store.approval(Number(id));
        if (!a) return { ok: false, error: "no such approval" };
        const owner = helpers[a.helper] || helpers.chip; // an approval filed by a module (bounties) is decided through Chip
        if (!owner?.decide) return { ok: false, error: `${a.helper} has no decisions to make` };
        await owner.decide(a.id, action === "approve" ? "approve" : "reject");
        return { ok: true };
      }
    }
    if (!h) return { ok: false, error: "no such helper" };
    switch (action) {
      case "off": {
        this.paused.add(helper); store.setMeta("admin:paused", [...this.paused].join(","));
        if (helper === "crumb" && h.stop) h.stop();
        return { ok: true, paused: true };
      }
      case "on": {
        this.paused.delete(helper); store.setMeta("admin:paused", [...this.paused].join(","));
        if (this.W.off.includes(helper)) return { ok: true, paused: true, note: `${cap(helper)} is also switched off by HELPERS_OFF in the server settings; remove it there and restart to switch it on.` };
        if (helper === "crumb" && h.start) await h.start();
        return { ok: true, paused: false };
      }
      case "cap": {
        const v = Number(value);
        if (!Number.isFinite(v) || v < 0 || v > 1000) return { ok: false, error: "the cap is dollars a day, 0 to 1000" };
        (this.W.brain.helpers[helper] ||= {}).dailyCapUsd = v;
        store.setMeta(`admin:cap:${helper}`, v);
        return { ok: true, capUsd: v };
      }
      case "run": {
        const job = scheduler.jobs.find((j) => j.helper === helper && (!id || j.id === id)) || scheduler.jobs.find((j) => j.helper === helper);
        if (!job) return { ok: false, error: `${cap(helper)} has no scheduled job` };
        if (this.isPaused(helper)) return { ok: false, error: `${cap(helper)} is paused; switch it on first` };
        scheduler.runNow(job.id).catch((e) => this.log(`[admin] ${job.id} failed: ${e.message}`));
        return { ok: true, started: job.id };
      }
      case "retire": {
        if (!h.recruit) return { ok: false, error: `${cap(helper)} is not a recruit; pause it instead` };
        const dough = helpers.dough;
        const ok = dough?.fire ? await dough.fire(helper, "retired from the control room") : false;
        return ok ? { ok: true, retired: helper } : { ok: false, error: "could not retire it (no hiring brownie)" };
      }
      case "ask": {
        if (typeof h.onRequest !== "function") return { ok: false, error: `${cap(helper)} takes no instructions yet` };
        if (!String(text || "").trim()) return { ok: false, error: "write what you want it to do" };
        if (this.isPaused(helper)) return { ok: false, error: `${cap(helper)} is paused; switch it on first` };
        const p = Promise.resolve().then(() => h.onRequest(String(text).trim()));
        p.then((r) => this.log(`[admin] ${helper} did: ${r ? (r.title || r.text || "done").toString().slice(0, 80) : "nothing (budget or an error)"}`)).catch((e) => this.log(`[admin] ${helper} failed: ${e.message}`));
        return { ok: true, started: "request" };
      }
    }
    return { ok: false, error: "unknown action" };
  }

  // ---- the HTTP side ----
  cors(req, res) {
    const origin = req.headers.origin || "";
    const ok = this.origins.find((o) => (o instanceof RegExp ? o.test(origin) : o === origin));
    if (ok) { res.setHeader("access-control-allow-origin", origin); res.setHeader("vary", "origin"); }
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  }
  async handle(req, res) {
    const url = new URL(req.url, "http://x");
    this.cors(req, res);
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    try {
      if (req.method === "GET" && url.pathname === "/admin/nonce") return json(200, { nonce: this.newNonce(), message: adminMessage("<nonce>"), wallets: this.wallets.length });
      if (req.method === "POST" && url.pathname === "/admin/login") {
        if (this.tooMany(clientIp(req))) return json(429, { error: "too many tries; wait ten minutes" });
        const body = await readJson(req);
        const s = body.code != null ? this.loginWithCode(body.code) : this.loginWithWallet(body);
        if (!s) return json(401, { error: body.code != null ? "wrong or expired code" : "the signature does not match an admin wallet" });
        this.log(`[admin] login (${body.code != null ? "code" : "wallet"})`);
        return json(200, s);
      }
      if (!this.authed(req)) return json(401, { error: "log in first" });
      if (req.method === "GET" && url.pathname === "/admin/state") return json(200, this.state());
      if (req.method === "GET" && url.pathname === "/admin/log") { const n = Math.min(500, Math.max(1, Number(url.searchParams.get("n") || 200))); return json(200, { lines: this.ring.slice(-n) }); }
      if (req.method === "POST" && url.pathname === "/admin/command") return json(200, await this.command(await readJson(req)));
      if (req.method === "POST" && url.pathname === "/admin/logout") { this.logout(req); return json(200, { ok: true }); }
      return json(404, { error: "no such route" });
    } catch (e) {
      this.log(`[admin] ${req.method} ${url.pathname} failed: ${e.message}`);
      return json(500, { error: e.message });
    }
  }
}

export const adminMessage = (nonce) => `Brownies admin login ${nonce}`;

function readJson(req) {
  return new Promise((res, rej) => {
    let s = "";
    req.on("data", (d) => { s += d; if (s.length > 100_000) { rej(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { res(s ? JSON.parse(s) : {}); } catch { rej(new Error("bad json")); } });
    req.on("error", rej);
  });
}
