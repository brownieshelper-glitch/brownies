// The studio: the brownies build and launch coins for other people. This is the intake on the helpers' server:
// GET /studio/info says what the studio offers (the package, the price, the fee slice), POST /studio/apply takes a
// request from the site's form and puts it on the money jobs board as a studio job, found, for the owner to pick;
// the owner is told on Telegram. The brownies never reply to a client by themselves: a pick makes Glaze write the
// proposal, the owner sends it. No account, no login: a form, a honeypot field and a per-address limit.
import { createHash } from "node:crypto";
import { cut } from "./text.mjs";

export const DEFAULT_STUDIO = {
  priceEth: 0.2,
  feeSliceBps: 1000,
  includes: [
    "a name check, a logo and a banner in the coin's own style",
    "a one-page site with the story, the links and a live chart",
    "a short cartoon intro video for X, TikTok and Telegram",
    "the launch on Programmable on Ethereum, done for you, with the fee contract set at launch",
    "two weeks of community: a Telegram bot that answers your holders and daily posts on X",
  ],
  contact: "https://t.me/feedthebrownies",
};
const LIMITS = { name: [2, 80], idea: [10, 1500], contact: [3, 120], link: [0, 200] };

export class Studio {
  constructor({ store, clock, telegram = null, ownerChatId = "", config = {}, siteUrl = "https://feedthebrownies.com", log = () => {} }) {
    this.store = store; this.clock = clock; this.tg = telegram; this.ownerChatId = String(ownerChatId || "");
    this.config = { ...DEFAULT_STUDIO, ...config };
    this.siteUrl = String(siteUrl).replace(/\/$/, ""); this.log = log;
    this.attempts = new Map();
  }

  /// What the studio offers, for the page and for Glaze's proposals.
  info() {
    const c = this.config;
    return { priceEth: c.priceEth, feeSliceBps: c.feeSliceBps, feeSlicePct: Math.round(c.feeSliceBps / 100 * 10) / 10, includes: [...c.includes], contact: c.contact, contract: "StudioSplitter: the coin's creator fee lands in a contract nobody can change; it pays the studio its slice and the client the rest, anyone may trigger the payout" };
  }

  /// At most five requests per address per hour.
  tooMany(ip) {
    const now = this.clock.now();
    const list = (this.attempts.get(ip) || []).filter((t) => now - t < 3_600_000);
    list.push(now); this.attempts.set(ip, list);
    return list.length > 5;
  }

  /// A request from the form, checked. Returns { fields } or { error }.
  check(body) {
    if (!body || typeof body !== "object") return { error: "send the form as JSON" };
    if (String(body.website || "").trim()) return { error: "no" }; // the honeypot: a robot filled the hidden field
    const f = {};
    for (const [k, [min, max]] of Object.entries(LIMITS)) {
      const v = String(body[k] ?? "").replace(/\s+/g, " ").trim();
      if (v.length < min) return { error: k === "link" ? "" : `${k} is too short` };
      if (v.length > max) return { error: `${k} is too long (${max} characters at most)` };
      f[k] = v;
    }
    if (f.link && !/^https?:\/\/\S+$/i.test(f.link)) return { error: "link must start with http" };
    return { fields: f };
  }

  /// The request on the board, the owner told. Returns { id, duplicate }.
  async apply(fields) {
    const now = this.clock.now();
    const ref = `studio:${createHash("sha256").update(`${fields.name}|${fields.contact}|${fields.idea}`.toLowerCase()).digest("hex").slice(0, 24)}`;
    const existing = this.store.moneyJobByRef(ref);
    if (existing) return { id: existing.id, duplicate: true };
    const c = this.config;
    const id = this.store.addMoneyJob({
      at: now, kind: "studio", title: `Studio request: ${fields.name}`, url: fields.link || null, ref, source: "studio-form", state: "found", score: 50, effort: "high",
      expectedUsd: 0, summary: `${fields.idea}\nContact: ${fields.contact}${fields.link ? `\nLink: ${fields.link}` : ""}`,
      nextStep: `Reply to ${fields.contact} with the proposal: ${c.priceEth} ETH plus ${c.feeSliceBps / 100}% of the creator fee through the splitter.`,
      note: "asked through the studio form",
    });
    this.log(`[studio] request ${id} from ${fields.name} (${fields.contact})`);
    if (this.tg?.configured && this.ownerChatId) {
      await this.tg.sendMessage(this.ownerChatId, `New studio request from ${fields.name} (${fields.contact}):\n${cut(fields.idea, 400)}${fields.link ? `\n${fields.link}` : ""}\n\nIt is job ${id} on the board. /zest pick ${id} makes Glaze write the proposal; the board: ${this.siteUrl}/jobs.html`);
    }
    return { id, duplicate: false };
  }

  async handle(req, res) {
    const url = new URL(req.url, "http://x");
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" }); res.end(JSON.stringify(body)); };
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" }); return res.end(); }
    try {
      if (req.method === "GET" && url.pathname === "/studio/info") return json(200, this.info());
      if (req.method === "POST" && url.pathname === "/studio/apply") {
        const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "?";
        if (this.tooMany(ip)) return json(429, { error: "too many requests from here; try again in an hour" });
        let body; try { body = await readJson(req); } catch (e) { return json(400, { error: e.message }); }
        const c = this.check(body);
        if (c.error !== undefined && !c.fields) return c.error === "no" ? json(200, { ok: true, id: 0 }) : json(400, { error: c.error });
        const r = await this.apply(c.fields);
        return json(200, { ok: true, ...r });
      }
      return json(404, { error: "no such route" });
    } catch (e) {
      this.log(`[studio] ${e.message}`);
      return json(500, { error: "the studio could not take that" });
    }
  }
}

function readJson(req, limit = 8_000) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (d) => { s += d; if (s.length > limit) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}
