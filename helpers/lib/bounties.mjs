// The bounty board: things holders can do that spread the brownies (a meme, a reaction video, a thread, a
// translation, a drawing, a bug found), each worth some USDC. A holder sends a claim on Telegram (/bounty <n>
// <link or text> <wallet>), Nougat (helpers/nougat.mjs) checks it and proposes it, the owner approves or rejects
// on a card, and the owner pays the USDC out himself (on Base) and marks it paid: nothing here moves money. The
// owner sets one BUDGET for all the bounties, the ceiling Nougat proposes within, and OPENS the board when he
// wants: closed, it takes no claim and shows nothing. The board is public (GET /bounties, web/bounties.html).
import { BANNED } from "./shop.mjs";

export const SEED = [
  { kind: "meme", title: "A meme with the brownies", what: "Make a meme with the four brownies and post it on X, TikTok or Instagram with #brownies. Send us the link.", usd: 5, maxWinners: 20 },
  { kind: "video", title: "React to an episode", what: "Film yourself watching an episode of the brownies and post it on TikTok, YouTube or Instagram. Send us the link.", usd: 20, maxWinners: 10 },
  { kind: "thread", title: "Explain the brownies", what: "Write a post or a thread on X that explains, in your own words, what the brownies are and how SUGAR works. Send us the link.", usd: 10, maxWinners: 10 },
  { kind: "translation", title: "Translate the explainer", what: "Translate the first section of the Docs page into your language. Send us the text, with the language named.", usd: 15, maxWinners: 15 },
  { kind: "art", title: "Draw a brownie", what: "Draw one of the four brownies in your own style and post it with #brownies. Send us the link.", usd: 8, maxWinners: 20 },
  { kind: "bug", title: "Find a bug", what: "Find something broken on the site or in the app and tell us how to see it. Send us the steps.", usd: 10, maxWinners: 10 },
];
export const LINK_HOSTS = ["x.com", "twitter.com", "tiktok.com", "youtube.com", "youtu.be", "instagram.com"];
export const CLAIMS_PER_DAY = 5;
const ADDRESS = /0x[0-9a-fA-F]{40}/;
export const money = (usd) => { const n = Number(usd) || 0; return `$${Number.isInteger(n) ? n : n.toFixed(2)}`; };

/// A claim's words, read: the one link we take (a post on an allowed site), the text, the wallet for the payout.
/// Returns { link, text, wallet } or { error }.
export function parseClaim(raw) {
  let s = String(raw || "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  const wallet = (ADDRESS.exec(s) || [null])[0];
  if (wallet) s = s.replace(wallet, " ").replace(/\s+/g, " ").trim();
  const urls = s.match(/https?:\/\/\S+/gi) || [];
  if (urls.length > 1) return { error: "one link only" };
  let link = null;
  if (urls.length === 1) {
    let u; try { u = new URL(urls[0]); } catch { return { error: "that link does not parse" }; }
    const host = u.hostname.replace(/^www\.|^m\.|^mobile\./, "");
    if (!LINK_HOSTS.some((h) => host === h || host.endsWith("." + h))) return { error: `links to ${LINK_HOSTS.join(", ")} only` };
    link = u.toString().slice(0, 300);
    s = s.replace(urls[0], " ").replace(/\s+/g, " ").trim();
  }
  if (!link && s.length < 5) return { error: "send a link to your post, or the text" };
  if (s.length > 1200) return { error: "too long: 1,200 characters at most" };
  if (BANNED.test(s)) return { error: "we do not take that" };
  return { link, text: s, wallet: wallet ? wallet.toLowerCase() : null };
}

const row = (r) => (r ? { id: Number(r.id), createdAt: Number(r.created_at), kind: r.kind, title: r.title, what: r.what, usd: Number(r.usd), maxWinners: Number(r.max_winners), state: r.state } : null);
const crow = (r) => (r ? { id: Number(r.id), at: Number(r.at), bountyId: Number(r.bounty_id), who: r.who, handle: r.handle, chatId: r.chat_id, wallet: r.wallet, link: r.link, text: r.text, state: r.state, verdict: r.verdict, note: r.note, usd: Number(r.usd), cardId: r.card_id == null ? null : Number(r.card_id), decidedAt: r.decided_at == null ? null : Number(r.decided_at), paidAt: r.paid_at == null ? null : Number(r.paid_at) } : null);

export class Board {
  constructor({ store, clock, log = () => {} }) {
    Object.assign(this, { store, clock, log });
    // an older board paid in SUGAR (columns named sugar): it had no claims, so it is dropped and seeded again
    const cols = store.db.prepare("PRAGMA table_info(bounties)").all().map((c) => c.name);
    if (cols.length && !cols.includes("usd")) store.db.exec("DROP TABLE IF EXISTS claims; DROP TABLE IF EXISTS bounties;");
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS bounties (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, what TEXT NOT NULL, usd REAL NOT NULL, max_winners INTEGER NOT NULL DEFAULT 10, state TEXT NOT NULL DEFAULT 'open');
      CREATE TABLE IF NOT EXISTS claims (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, bounty_id INTEGER NOT NULL, who TEXT NOT NULL, handle TEXT, chat_id TEXT, wallet TEXT, link TEXT, text TEXT, state TEXT NOT NULL DEFAULT 'new', verdict TEXT, note TEXT, usd REAL NOT NULL DEFAULT 0, card_id INTEGER, decided_at INTEGER, paid_at INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS claims_once ON claims(bounty_id, who);
    `);
    const p = (s) => store.db.prepare(s);
    this.q = {
      count: p("SELECT COUNT(*) AS n FROM bounties"),
      add: p("INSERT INTO bounties(created_at, kind, title, what, usd, max_winners) VALUES(?, ?, ?, ?, ?, ?)"),
      all: p("SELECT * FROM bounties ORDER BY id"),
      one: p("SELECT * FROM bounties WHERE id = ?"),
      setState: p("UPDATE bounties SET state = ? WHERE id = ?"),
      setUsd: p("UPDATE bounties SET usd = ? WHERE id = ?"),
      winners: p("SELECT COUNT(*) AS n FROM claims WHERE bounty_id = ? AND state IN ('approved', 'paid')"),
      claim: p("INSERT OR IGNORE INTO claims(at, bounty_id, who, handle, chat_id, wallet, link, text) VALUES(?, ?, ?, ?, ?, ?, ?, ?)"),
      claimOf: p("SELECT * FROM claims WHERE id = ?"),
      claims: p("SELECT * FROM claims ORDER BY id DESC LIMIT ?"),
      byState: p("SELECT * FROM claims WHERE state = ? ORDER BY id LIMIT ?"),
      byCard: p("SELECT * FROM claims WHERE card_id = ?"),
      today: p("SELECT COUNT(*) AS n FROM claims WHERE who = ? AND at >= ?"),
      set: p("UPDATE claims SET state = COALESCE(?, state), verdict = COALESCE(?, verdict), note = COALESCE(?, note), usd = COALESCE(?, usd), card_id = COALESCE(?, card_id), decided_at = COALESCE(?, decided_at), paid_at = COALESCE(?, paid_at) WHERE id = ?"),
      sums: p("SELECT state, COUNT(*) AS n, COALESCE(SUM(usd), 0) AS usd FROM claims GROUP BY state"),
      won: p("SELECT c.*, b.title AS bounty_title FROM claims c JOIN bounties b ON b.id = c.bounty_id WHERE c.state IN ('approved', 'paid') ORDER BY c.decided_at DESC LIMIT ?"),
    };
    if (Number(this.q.count.get().n) === 0) for (const b of SEED) this.q.add.run(clock.now(), b.kind, b.title, b.what, b.usd, b.maxWinners);
  }

  // ---- the switch: the board opens when the owner says so ----
  isOpen() { return this.store.getMeta("nougat:open") === "1"; }
  setOpen(on) { this.store.setMeta("nougat:open", on ? "1" : null); }

  // ---- bounties ----
  bounties({ open = true } = {}) { return this.q.all.all().map(row).filter((b) => !open || b.state === "open").map((b) => ({ ...b, winners: this.winners(b.id) })); }
  bounty(id) { const b = row(this.q.one.get(Number(id))); return b ? { ...b, winners: this.winners(b.id) } : null; }
  winners(id) { return Number(this.q.winners.get(Number(id)).n); }
  add({ kind = "other", title, what, usd, maxWinners = 10 }) {
    if (!title || !what || !(Number(usd) > 0)) throw new Error("a bounty needs a title, what to do and a reward in USDC");
    return Number(this.q.add.run(this.clock.now(), kind, String(title).slice(0, 80), String(what).slice(0, 400), Math.round(Number(usd) * 100) / 100, Math.max(1, Math.round(Number(maxWinners)) || 10)).lastInsertRowid);
  }
  close(id) { return this.q.setState.run("closed", Number(id)).changes > 0; }
  reopen(id) { return this.q.setState.run("open", Number(id)).changes > 0; }
  setPrice(id, usd) { if (!(Number(usd) > 0)) return false; return this.q.setUsd.run(Math.round(Number(usd) * 100) / 100, Number(id)).changes > 0; }

  // ---- the budget: what the owner allows for all the bounties, against what was approved and paid ----
  budget() { return Number(this.store.getMeta("nougat:budget", 0)) || 0; }
  setBudget(usd) { this.store.setMeta("nougat:budget", Math.max(0, Math.round(Number(usd) * 100) / 100 || 0)); }
  pool() {
    const by = {}; for (const r of this.q.sums.all()) by[r.state] = { n: Number(r.n), usd: Number(r.usd) };
    const owed = by.approved?.usd || 0, paid = by.paid?.usd || 0, pending = (by.proposed?.n || 0) + (by.new?.n || 0);
    const budget = this.budget();
    const r2 = (n) => Math.round(n * 100) / 100;
    return { budget, approved: r2(owed + paid), owed: r2(owed), paid: r2(paid), left: r2(Math.max(0, budget - owed - paid)), pending };
  }

  // ---- claims ----
  /// A holder's claim. Returns { id } or { error }. who = the Telegram user id; one claim per bounty per person; five a day.
  claim({ bountyId, who, handle = null, chatId = null, raw }) {
    if (!this.isOpen()) return { error: "no bounty is open right now" };
    const b = this.bounty(bountyId);
    if (!b || b.state !== "open") return { error: "no open bounty with that number; /bounties lists them" };
    if (b.winners >= b.maxWinners) return { error: "that bounty has all its winners already" };
    if (Number(this.q.today.get(String(who), this.store.dayStart(this.clock.now())).n) >= CLAIMS_PER_DAY) return { error: `${CLAIMS_PER_DAY} claims a day at most; try again tomorrow` };
    const p = parseClaim(raw);
    if (p.error) return { error: p.error };
    if (b.kind !== "translation" && b.kind !== "bug" && !p.link) return { error: "this bounty wants a link to your post" };
    const r = this.q.claim.run(this.clock.now(), b.id, String(who), handle, chatId == null ? null : String(chatId), p.wallet, p.link, p.text);
    if (r.changes === 0) return { error: "you claimed this bounty already; one claim per person per bounty" };
    return { id: Number(r.lastInsertRowid) };
  }
  claimOf(id) { return crow(this.q.claimOf.get(Number(id))); }
  claimByCard(cardId) { return crow(this.q.byCard.get(Number(cardId))); }
  claims({ state = null, limit = 50 } = {}) { return (state ? this.q.byState.all(state, limit) : this.q.claims.all(limit)).map(crow); }
  setClaim(id, { state = null, verdict = null, note = null, usd = null, cardId = null, decidedAt = null, paidAt = null } = {}) { this.q.set.run(state, verdict, note, usd, cardId, decidedAt, paidAt, Number(id)); return this.claimOf(id); }

  // ---- the public view and the texts ----
  view() {
    const open = this.isOpen();
    const pool = this.pool();
    return {
      open,
      pool: open ? { budget: pool.budget, left: pool.left, paid: pool.paid, approved: pool.approved } : null,
      bounties: open ? this.bounties().map((b) => ({ id: b.id, kind: b.kind, title: b.title, what: b.what, usd: b.usd, winners: b.winners, maxWinners: b.maxWinners })) : [],
      winners: this.q.won.all(30).map((r) => ({ handle: r.handle ? "@" + r.handle : "a holder", bounty: r.bounty_title, usd: Number(r.usd), at: new Date(Number(r.decided_at || r.at)).toISOString() })),
      how: "Send /bounty <number> <link or text> to @feedthebrownies_bot in a private chat, with your wallet address for the payout (USDC on Base).",
    };
  }
  listText() {
    if (!this.isOpen()) return "No bounty is open right now.";
    const bs = this.bounties();
    if (!bs.length) return "No bounty is open right now.";
    return ["Bounties open now (USDC for spreading the brownies):", ...bs.map((b) => `${b.id}. ${b.title}: ${money(b.usd)}. ${b.what}${b.maxWinners - b.winners <= 3 ? ` (${b.maxWinners - b.winners} left)` : ""}`), "", "Claim one: /bounty <number> <link or text>, plus your wallet address for the payout (USDC on Base). One claim per bounty per person."].join("\n");
  }
}
