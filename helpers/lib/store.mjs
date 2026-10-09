// The brownies' memory: one SQLite file through node:sqlite. What was done, what was posted (so nothing is said
// twice), the last turns of every conversation, the Telegram offset, the money spent today per helper, the
// approvals waiting for the owner, the last time each alert went out, and Nib's latest note.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { localParts } from "./clock.mjs";

/// Posts are compared by this: lower case, ASCII letters and digits only, so "Hello, world!" equals "hello world".
export const textKey = (s) => createHash("sha256").update(String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()).digest("hex");

/// A money_jobs row as the code reads it.
function moneyRow(r) {
  let log = []; try { log = JSON.parse(r.log || "[]"); } catch { log = []; }
  return { id: Number(r.id), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), kind: r.kind, title: r.title, url: r.url, ref: r.ref, source: r.source, helper: r.helper, state: r.state, score: Number(r.score), effort: r.effort, expectedUsd: Number(r.expected_usd) || 0, earnedUsd: Number(r.earned_usd) || 0, deadline: r.deadline, summary: r.summary, nextStep: r.next_step, ownerAction: r.owner_action, log };
}

function orderRow(r) { let result = null; try { result = r.result ? JSON.parse(r.result) : null; } catch { result = null; } return { id: Number(r.id), at: Number(r.at), updatedAt: Number(r.updated_at), key: r.key, item: r.item, prompt: r.prompt, payer: r.payer, micro: Number(r.micro), tx: r.tx, state: r.state, result, note: r.note, costMicro: Number(r.cost_micro) }; }

function ledgerRow(r) { return { id: Number(r.id), at: Number(r.at), day: r.day, helper: r.helper, kind: r.kind, model: r.model, job: r.job, tokensIn: Number(r.tokens_in), tokensOut: Number(r.tokens_out), tokensThink: Number(r.tokens_think), seconds: Number(r.seconds), micro: Number(r.cost_micro), guessed: Boolean(r.guessed), ms: Number(r.ms), note: r.note }; }

function rowSuggestion(r) { let flags = []; try { flags = JSON.parse(r.flags || "[]"); } catch { flags = []; } return { id: r.id, at: r.at, place: r.place, who: r.who, whoId: r.who_id, chat: r.chat, text: r.text, flags, ref: r.ref, url: r.url, state: r.state, note: r.note, decidedAt: r.decided_at }; }

export class Store {
  constructor(path = ":memory:", { tz = "UTC" } = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.tz = tz;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      ${path === ":memory:" ? "" : "PRAGMA journal_mode = WAL;"}
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, helper TEXT NOT NULL, job TEXT NOT NULL, ok INTEGER NOT NULL, cost_micro INTEGER NOT NULL DEFAULT 0, note TEXT);
      CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, helper TEXT NOT NULL, place TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, text TEXT NOT NULL, external_id TEXT, url TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS posts_key ON posts(place, key);
      CREATE TABLE IF NOT EXISTS seen (place TEXT NOT NULL, ref TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(place, ref));
      CREATE TABLE IF NOT EXISTS turns (id INTEGER PRIMARY KEY AUTOINCREMENT, chat TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL, who TEXT, text TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS turns_chat ON turns(chat, id);
      CREATE TABLE IF NOT EXISTS spend (helper TEXT NOT NULL, day TEXT NOT NULL, micro INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(helper, day));
      CREATE TABLE IF NOT EXISTS approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, helper TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, title TEXT NOT NULL, url TEXT, state TEXT NOT NULL DEFAULT 'pending', note TEXT, chat_id TEXT, message_id TEXT, decided_at INTEGER);
      CREATE TABLE IF NOT EXISTS batches (chat TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, since INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS alerts (topic TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, place TEXT NOT NULL, who TEXT, who_id TEXT, chat TEXT, text TEXT NOT NULL, flags TEXT NOT NULL DEFAULT '[]', ref TEXT, url TEXT, state TEXT NOT NULL DEFAULT 'new', note TEXT, decided_at INTEGER);
      CREATE TABLE IF NOT EXISTS money_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, url TEXT, ref TEXT, source TEXT NOT NULL, helper TEXT, state TEXT NOT NULL DEFAULT 'found', score INTEGER NOT NULL DEFAULT 0, effort TEXT, expected_usd REAL NOT NULL DEFAULT 0, earned_usd REAL NOT NULL DEFAULT 0, deadline TEXT, summary TEXT, next_step TEXT, owner_action TEXT, log TEXT NOT NULL DEFAULT '[]');
      CREATE UNIQUE INDEX IF NOT EXISTS money_jobs_ref ON money_jobs(ref);
      CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, helper TEXT NOT NULL, kind TEXT NOT NULL, model TEXT, job TEXT, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, tokens_think INTEGER NOT NULL DEFAULT 0, seconds REAL NOT NULL DEFAULT 0, cost_micro INTEGER NOT NULL DEFAULT 0, guessed INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0, note TEXT);
      CREATE INDEX IF NOT EXISTS ledger_day ON ledger(day, helper);
      CREATE INDEX IF NOT EXISTS ledger_at ON ledger(at);
      CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, updated_at INTEGER NOT NULL, key TEXT NOT NULL, item TEXT NOT NULL, prompt TEXT NOT NULL, payer TEXT NOT NULL, micro INTEGER NOT NULL, tx TEXT, state TEXT NOT NULL DEFAULT 'paid', result TEXT, note TEXT, cost_micro INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, at INTEGER NOT NULL);
    `);
    const p = (sql) => this.db.prepare(sql);
    this.q = {
      getMeta: p("SELECT v FROM meta WHERE k = ?"),
      setMeta: p("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"),
      delMeta: p("DELETE FROM meta WHERE k = ?"),
      addJob: p("INSERT INTO jobs(at, helper, job, ok, cost_micro, note) VALUES(?, ?, ?, ?, ?, ?)"),
      jobsSince: p("SELECT COUNT(*) AS n FROM jobs WHERE helper = ? AND job = ? AND at >= ? AND ok = 1"),
      lastJob: p("SELECT at, job, ok, note FROM jobs WHERE helper = ? ORDER BY id DESC LIMIT 1"),
      jobsOf: p("SELECT at, job, ok, cost_micro, note FROM jobs WHERE helper = ? AND at >= ? ORDER BY id"),
      hasPost: p("SELECT 1 FROM posts WHERE place = ? AND key = ?"),
      addPost: p("INSERT INTO posts(at, helper, place, kind, key, text, external_id, url) VALUES(?, ?, ?, ?, ?, ?, ?, ?)"),
      postsSince: p("SELECT COUNT(*) AS n FROM posts WHERE helper = ? AND place = ? AND kind = ? AND at >= ?"),
      recentPosts: p("SELECT text, at FROM posts WHERE helper = ? AND place = ? AND kind = ? ORDER BY id DESC LIMIT ?"),
      postByExternal: p("SELECT * FROM posts WHERE place = ? AND external_id = ?"),
      delPost: p("DELETE FROM posts WHERE id = ?"),
      seen: p("SELECT 1 FROM seen WHERE place = ? AND ref = ?"),
      markSeen: p("INSERT OR IGNORE INTO seen(place, ref, at) VALUES(?, ?, ?)"),
      addTurn: p("INSERT INTO turns(chat, at, role, who, text) VALUES(?, ?, ?, ?, ?)"),
      turns: p("SELECT role, who, text, at FROM turns WHERE chat = ? ORDER BY id DESC LIMIT ?"),
      turnsSince: p("SELECT chat, role, who, text, at FROM turns WHERE at >= ? AND role = ? ORDER BY id"),
      pruneTurns: p("DELETE FROM turns WHERE chat = ? AND id NOT IN (SELECT id FROM turns WHERE chat = ? ORDER BY id DESC LIMIT ?)"),
      addSpend: p("INSERT INTO spend(helper, day, micro, calls) VALUES(?, ?, ?, 1) ON CONFLICT(helper, day) DO UPDATE SET micro = micro + excluded.micro, calls = calls + 1"),
      spend: p("SELECT micro, calls FROM spend WHERE helper = ? AND day = ?"),
      addApproval: p("INSERT INTO approvals(at, helper, kind, ref, title, url) VALUES(?, ?, ?, ?, ?, ?)"),
      approval: p("SELECT * FROM approvals WHERE id = ?"),
      approvalByMessage: p("SELECT * FROM approvals WHERE chat_id = ? AND message_id = ?"),
      pending: p("SELECT * FROM approvals WHERE state = 'pending' ORDER BY id"),
      setApprovalMessage: p("UPDATE approvals SET chat_id = ?, message_id = ? WHERE id = ?"),
      decide: p("UPDATE approvals SET state = ?, note = ?, decided_at = ? WHERE id = ? AND state = 'pending'"),
      setNote: p("UPDATE approvals SET note = ? WHERE id = ?"),
      addSuggestion: p("INSERT INTO suggestions(at, place, who, who_id, chat, text, flags, ref, url) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)"),
      suggestion: p("SELECT * FROM suggestions WHERE id = ?"),
      suggestionsAll: p("SELECT * FROM suggestions ORDER BY id DESC LIMIT ?"),
      suggestionsByState: p("SELECT * FROM suggestions WHERE state = ? ORDER BY id DESC LIMIT ?"),
      suggestionsSince: p("SELECT * FROM suggestions WHERE at >= ? ORDER BY id"),
      decideSuggestion: p("UPDATE suggestions SET state = ?, note = COALESCE(?, note), decided_at = ? WHERE id = ?"),
      batch: p("SELECT chat, count, since FROM batches WHERE chat = ?"),
      bump: p("INSERT INTO batches(chat, count, since) VALUES(?, 1, ?) ON CONFLICT(chat) DO UPDATE SET count = count + 1"),
      dueBatches: p("SELECT chat, count, since FROM batches WHERE count > 0 AND since <= ?"),
      resetBatch: p("DELETE FROM batches WHERE chat = ?"),
      lastAlert: p("SELECT at FROM alerts WHERE topic = ?"),
      setAlert: p("INSERT INTO alerts(topic, at) VALUES(?, ?) ON CONFLICT(topic) DO UPDATE SET at = excluded.at"),
      addMoneyJob: p("INSERT OR IGNORE INTO money_jobs(created_at, updated_at, kind, title, url, ref, source, helper, state, score, effort, expected_usd, deadline, summary, next_step, owner_action, log) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
      moneyJob: p("SELECT * FROM money_jobs WHERE id = ?"),
      moneyJobByRef: p("SELECT * FROM money_jobs WHERE ref = ?"),
      moneyJobs: p("SELECT * FROM money_jobs ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?"),
      moneyJobsByState: p("SELECT * FROM money_jobs WHERE state = ? ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?"),
      moneyTotals: p("SELECT state, COUNT(*) AS n, SUM(expected_usd) AS expected, SUM(earned_usd) AS earned FROM money_jobs GROUP BY state"),
      addEntry: p("INSERT INTO ledger(at, day, helper, kind, model, job, tokens_in, tokens_out, tokens_think, seconds, cost_micro, guessed, ms, note) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
      ledgerDay: p("SELECT helper, kind, COUNT(*) AS n, SUM(cost_micro) AS micro, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout, SUM(tokens_think) AS tthink, SUM(seconds) AS seconds, MAX(cost_micro) AS max_micro, SUM(guessed) AS guessed FROM ledger WHERE day = ? GROUP BY helper, kind"),
      ledgerModels: p("SELECT helper, kind, model, job, COUNT(*) AS n, SUM(cost_micro) AS micro, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout FROM ledger WHERE day = ? GROUP BY helper, kind, model, job"),
      ledgerDays: p("SELECT day, kind, COUNT(*) AS n, SUM(cost_micro) AS micro FROM ledger WHERE day >= ? GROUP BY day, kind ORDER BY day"),
      ledgerKindSince: p("SELECT kind, COUNT(*) AS n, SUM(cost_micro) AS micro FROM ledger WHERE at >= ? GROUP BY kind"),
      ledgerHelperKindDay: p("SELECT COUNT(*) AS n, SUM(cost_micro) AS micro, SUM(seconds) AS seconds FROM ledger WHERE helper = ? AND kind = ? AND day = ?"),
      ledgerRecent: p("SELECT * FROM ledger ORDER BY at DESC, id DESC LIMIT ?"),
      ledgerBiggest: p("SELECT * FROM ledger WHERE day = ? ORDER BY cost_micro DESC, id DESC LIMIT ?"),
      spendDays: p("SELECT helper, day, micro, calls FROM spend WHERE day >= ? ORDER BY day"),
      addOrder: p("INSERT INTO orders(at, updated_at, key, item, prompt, payer, micro, tx, state) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'paid')"),
      order: p("SELECT * FROM orders WHERE id = ?"),
      orders: p("SELECT * FROM orders ORDER BY id DESC LIMIT ?"),
      ordersByState: p("SELECT * FROM orders WHERE state = ? ORDER BY id LIMIT ?"),
      setOrder: p("UPDATE orders SET state = ?, result = COALESCE(?, result), note = COALESCE(?, note), cost_micro = cost_micro + ?, updated_at = ? WHERE id = ?"),
      sales: p("SELECT COUNT(*) AS n, COALESCE(SUM(micro), 0) AS micro, COALESCE(SUM(cost_micro), 0) AS cost FROM orders WHERE at >= ?"),
      useNonce: p("INSERT OR IGNORE INTO nonces(nonce, at) VALUES(?, ?)"),
    };
  }

  close() { this.db.close(); }
  dayKey(now) { return localParts(now, this.tz).key; }
  dayStart(now) { const p = localParts(now, this.tz); return now - ((p.h * 60 + p.min) * 60 + p.s) * 1000; }

  // ---- small values ----
  getMeta(k, fallback = null) { const r = this.q.getMeta.get(k); return r ? r.v : fallback; }
  setMeta(k, v) { if (v == null) this.q.delMeta.run(k); else this.q.setMeta.run(k, String(v)); }
  hasFlag(k) { return this.getMeta(k) != null; }
  setFlag(k, at = Date.now()) { this.setMeta(k, at); }

  // ---- jobs ----
  jobDone({ at, helper, job, ok = true, costMicro = 0, note = null }) { this.q.addJob.run(at, helper, job, ok ? 1 : 0, Math.round(costMicro), note); }
  jobsToday(helper, job, now) { return Number(this.q.jobsSince.get(helper, job, this.dayStart(now)).n); }
  lastJob(helper) { return this.q.lastJob.get(helper) || null; }
  /// Every job of a helper since `at`, oldest first (for the owner's daily summary).
  jobsSince(helper, at) { return this.q.jobsOf.all(helper, at).map((r) => ({ helper, at: Number(r.at), job: r.job, ok: Boolean(r.ok), costMicro: Number(r.cost_micro), note: r.note })); }

  // ---- posts: never the same text twice in the same place. A reply is keyed with what it answers (`ref`). ----
  hasPost(place, text, ref = "") { return Boolean(this.q.hasPost.get(place, textKey(ref ? `${text}|${ref}` : text))); }
  addPost({ at, helper, place, kind = "post", text, ref = "", externalId = null, url = null }) {
    this.q.addPost.run(at, helper, place, kind, textKey(ref ? `${text}|${ref}` : text), text, externalId, url);
  }
  postsToday(helper, place, kind, now) { return Number(this.q.postsSince.get(helper, place, kind, this.dayStart(now)).n); }
  recentPosts(helper, place, kind = "post", n = 10) { return this.q.recentPosts.all(helper, place, kind, n).map((r) => r.text); }
  postByExternalId(place, externalId) { return this.q.postByExternal.get(place, String(externalId)) || null; }
  deletePost(id) { return this.q.delPost.run(id).changes > 0; }

  // ---- things handled once: a mention, an issue, an update ----
  seen(place, ref) { return Boolean(this.q.seen.get(place, String(ref))); }
  markSeen(place, ref, at) { this.q.markSeen.run(place, String(ref), at); }

  // ---- conversations, the last N turns per chat ----
  addTurn(chat, role, text, { who = null, at, keep = 40 } = {}) {
    this.q.addTurn.run(String(chat), at, role, who, text);
    this.q.pruneTurns.run(String(chat), String(chat), keep);
  }
  turns(chat, n = 12) { return this.q.turns.all(String(chat), n).reverse(); }
  /// Every turn of one role since `at`, across all chats (what people asked today, for the questions digest).
  turnsSince(at, role = "user") { return this.q.turnsSince.all(at, role); }

  // ---- money, per helper per local day ----
  addSpend(helper, micro, now) { this.q.addSpend.run(helper, this.dayKey(now), Math.max(0, Math.round(micro))); }
  spentToday(helper, now) { const r = this.q.spend.get(helper, this.dayKey(now)); return r ? { micro: Number(r.micro), calls: Number(r.calls) } : { micro: 0, calls: 0 }; }
  /// The AI spend rows of every helper from a day on (for the bill's history).
  spendDays(fromDay) { return this.q.spendDays.all(String(fromDay)).map((r) => ({ helper: r.helper, day: r.day, micro: Number(r.micro), calls: Number(r.calls) })); }

  // ---- the ledger: one line per paid call (an AI answer, a video render), what it was and what it cost (lib/costs.mjs reads it) ----
  /// kind: "ai" | "video". guessed: the price came from our own table, not from the provider.
  addEntry({ at, helper, kind = "ai", model = null, job = null, tokensIn = 0, tokensOut = 0, tokensThink = 0, seconds = 0, costMicro = 0, guessed = false, ms = 0, note = null }) {
    const n = (v) => Math.max(0, Math.round(Number(v) || 0));
    return Number(this.q.addEntry.run(at, this.dayKey(at), helper, kind, model, job, n(tokensIn), n(tokensOut), n(tokensThink), Math.max(0, Number(seconds) || 0), n(costMicro), guessed ? 1 : 0, n(ms), note == null ? null : String(note).slice(0, 200)).lastInsertRowid);
  }
  /// Per helper and kind on one day: count, cost, tokens, seconds, the biggest line, how many prices were guessed.
  ledgerDay(day) { return this.q.ledgerDay.all(String(day)).map((r) => ({ helper: r.helper, kind: r.kind, n: Number(r.n), micro: Number(r.micro), tokensIn: Number(r.tin), tokensOut: Number(r.tout), tokensThink: Number(r.tthink), seconds: Number(r.seconds), maxMicro: Number(r.max_micro), guessed: Number(r.guessed) })); }
  /// Per helper, kind, model and job on one day.
  ledgerModels(day) { return this.q.ledgerModels.all(String(day)).map((r) => ({ helper: r.helper, kind: r.kind, model: r.model, job: r.job, n: Number(r.n), micro: Number(r.micro), tokensIn: Number(r.tin), tokensOut: Number(r.tout) })); }
  /// Per day and kind from a day on.
  ledgerDays(fromDay) { return this.q.ledgerDays.all(String(fromDay)).map((r) => ({ day: r.day, kind: r.kind, n: Number(r.n), micro: Number(r.micro) })); }
  /// Per kind since a time (the month so far).
  ledgerSince(at) { return this.q.ledgerKindSince.all(at).map((r) => ({ kind: r.kind, n: Number(r.n), micro: Number(r.micro) })); }
  /// One helper's lines of one kind today: { n, micro, seconds } (Sprinkle's video cap reads this).
  ledgerToday(helper, kind, now) { const r = this.q.ledgerHelperKindDay.get(helper, kind, this.dayKey(now)); return { n: Number(r?.n || 0), micro: Number(r?.micro || 0), seconds: Number(r?.seconds || 0) }; }
  ledgerRecent(n = 30) { return this.q.ledgerRecent.all(n).map(ledgerRow); }
  ledgerBiggest(day, n = 5) { return this.q.ledgerBiggest.all(String(day), n).map(ledgerRow); }

  // ---- the shop's orders (lib/shop.mjs): paid, making, done, failed; and the payment nonces, each used once ----
  addOrder({ at, key, item, prompt, payer, micro, tx = null }) { return Number(this.q.addOrder.run(at, at, String(key), item, String(prompt), String(payer).toLowerCase(), Math.round(micro), tx).lastInsertRowid); }
  order(id) { const r = this.q.order.get(Number(id)); return r ? orderRow(r) : null; }
  orders({ state = null, limit = 50 } = {}) { return (state ? this.q.ordersByState.all(state, limit) : this.q.orders.all(limit)).map(orderRow); }
  /// The oldest order in a state (the next one to make), or null.
  nextOrder(state = "paid") { const r = this.q.ordersByState.get(state, 1); return r ? orderRow(r) : null; }
  setOrder(id, { state, result = null, note = null, costMicro = 0, at }) { this.q.setOrder.run(state, result == null ? null : JSON.stringify(result), note, Math.round(costMicro), at, Number(id)); return this.order(id); }
  /// Since a time: how many orders, what they paid, what they cost us.
  sales(since) { const r = this.q.sales.get(since); return { n: Number(r.n), micro: Number(r.micro), costMicro: Number(r.cost) }; }
  /// True the first time a nonce is seen; false ever after (the same authorization cannot buy twice).
  useNonce(nonce, at) { return this.q.useNonce.run(String(nonce).toLowerCase(), at).changes > 0; }

  // ---- approvals the owner decides on Telegram ----
  addApproval({ at, helper, kind, ref, title, url = null }) { return Number(this.q.addApproval.run(at, helper, kind, String(ref), title, url).lastInsertRowid); }
  approval(id) { return this.q.approval.get(id) || null; }
  approvalByMessage(chatId, messageId) { return this.q.approvalByMessage.get(String(chatId), String(messageId)) || null; }
  pendingApprovals() { return this.q.pending.all(); }
  setApprovalMessage(id, chatId, messageId) { this.q.setApprovalMessage.run(String(chatId), String(messageId), id); }
  /// Marks the decision. Returns false when it was already decided (a second press of the button does nothing).
  decide(id, state, note, at) { return this.q.decide.run(state, note, at, id).changes > 0; }
  setApprovalNote(id, note) { this.q.setNote.run(note, id); }

  // ---- suggestions from the public: the owner's list, never acted on by a brownie ----
  addSuggestion({ at, place, who = null, whoId = null, chat = null, text, flags = [], ref = null, url = null }) { return Number(this.q.addSuggestion.run(at, place, who, whoId, chat, text, JSON.stringify(flags), ref, url).lastInsertRowid); }
  suggestion(id) { const r = this.q.suggestion.get(id); return r ? rowSuggestion(r) : null; }
  suggestions({ state = null, limit = 100 } = {}) { return (state ? this.q.suggestionsByState.all(state, limit) : this.q.suggestionsAll.all(limit)).map(rowSuggestion); }
  suggestionsSince(at) { return this.q.suggestionsSince.all(at).map(rowSuggestion); }
  /// "listen" (the brownies may consider it), "ignore", or back to "new"; a note from the owner travels with it.
  decideSuggestion(id, state, note = null, at = Date.now()) { return this.q.decideSuggestion.run(state, note, at, id).changes > 0; }

  // ---- Crumb's hourly batches: how many answers per chat since the batch began ----
  countAnswer(chat, now) { this.q.bump.run(String(chat), now); }
  dueBatches(now, age) { return this.q.dueBatches.all(now - age).map((r) => ({ chat: r.chat, count: Number(r.count), since: Number(r.since) })); }
  resetBatch(chat) { this.q.resetBatch.run(String(chat)); }

  // ---- alerts: at most one per topic per hour ----
  lastAlert(topic) { const r = this.q.lastAlert.get(topic); return r ? Number(r.at) : 0; }
  setAlert(topic, at) { this.q.setAlert.run(topic, at); }

  // ---- money jobs: the opportunities the brownies hunt and the work that brings money in (lib/moneyjobs.mjs) ----
  /// Adds a job; null when one with the same ref (the normalized URL) is on the board already.
  addMoneyJob({ at, kind, title, url = null, ref = null, source, helper = null, state = "found", score = 0, effort = null, expectedUsd = 0, deadline = null, summary = null, nextStep = null, ownerAction = null, note = null }) {
    const log = note ? [{ at, by: source, text: String(note).slice(0, 400) }] : [];
    const r = this.q.addMoneyJob.run(at, at, kind, title, url, ref, source, helper, state, Math.round(Number(score) || 0), effort, Number(expectedUsd) || 0, deadline, summary, nextStep, ownerAction, JSON.stringify(log));
    return r.changes > 0 ? Number(r.lastInsertRowid) : null;
  }
  moneyJob(id) { const r = this.q.moneyJob.get(Number(id)); return r ? moneyRow(r) : null; }
  moneyJobByRef(ref) { const r = this.q.moneyJobByRef.get(String(ref)); return r ? moneyRow(r) : null; }
  moneyJobs({ state = null, limit = 200, offset = 0 } = {}) { return (state ? this.q.moneyJobsByState.all(state, limit, offset) : this.q.moneyJobs.all(limit, offset)).map(moneyRow); }
  /// Changes the named fields and appends a log line. Returns the job, or null when there is none.
  updateMoneyJob(id, patch = {}, { at, by = "system", note = null } = {}) {
    const job = this.moneyJob(id);
    if (!job) return null;
    const cols = { kind: "kind", title: "title", url: "url", helper: "helper", state: "state", score: "score", effort: "effort", expectedUsd: "expected_usd", earnedUsd: "earned_usd", deadline: "deadline", summary: "summary", nextStep: "next_step", ownerAction: "owner_action" };
    const sets = [], vals = [];
    for (const [k, col] of Object.entries(cols)) if (patch[k] !== undefined) { sets.push(`${col} = ?`); vals.push(patch[k]); }
    const log = job.log.slice(-40);
    if (note) log.push({ at, by, text: String(note).slice(0, 400) });
    sets.push("log = ?", "updated_at = ?"); vals.push(JSON.stringify(log), at);
    this.db.prepare(`UPDATE money_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...vals, Number(id));
    return this.moneyJob(id);
  }
  /// Per state: how many, the expected and the earned dollars.
  moneyTotals() { const by = {}; for (const r of this.q.moneyTotals.all()) by[r.state] = { n: Number(r.n), expectedUsd: Number(r.expected) || 0, earnedUsd: Number(r.earned) || 0 }; return by; }

  // ---- Nib's latest note, where Fudge and Crumb read it ----
  get latestNote() { const v = this.getMeta("note:latest"); if (!v) return null; try { return JSON.parse(v); } catch { return null; } }
  set latestNote(n) { this.setMeta("note:latest", JSON.stringify(n)); }
}
