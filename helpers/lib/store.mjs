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
    `);
    const p = (sql) => this.db.prepare(sql);
    this.q = {
      getMeta: p("SELECT v FROM meta WHERE k = ?"),
      setMeta: p("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"),
      delMeta: p("DELETE FROM meta WHERE k = ?"),
      addJob: p("INSERT INTO jobs(at, helper, job, ok, cost_micro, note) VALUES(?, ?, ?, ?, ?, ?)"),
      jobsSince: p("SELECT COUNT(*) AS n FROM jobs WHERE helper = ? AND job = ? AND at >= ? AND ok = 1"),
      lastJob: p("SELECT at, job, ok, note FROM jobs WHERE helper = ? ORDER BY id DESC LIMIT 1"),
      hasPost: p("SELECT 1 FROM posts WHERE place = ? AND key = ?"),
      addPost: p("INSERT INTO posts(at, helper, place, kind, key, text, external_id, url) VALUES(?, ?, ?, ?, ?, ?, ?, ?)"),
      postsSince: p("SELECT COUNT(*) AS n FROM posts WHERE helper = ? AND place = ? AND kind = ? AND at >= ?"),
      recentPosts: p("SELECT text, at FROM posts WHERE helper = ? AND place = ? AND kind = ? ORDER BY id DESC LIMIT ?"),
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
      batch: p("SELECT chat, count, since FROM batches WHERE chat = ?"),
      bump: p("INSERT INTO batches(chat, count, since) VALUES(?, 1, ?) ON CONFLICT(chat) DO UPDATE SET count = count + 1"),
      dueBatches: p("SELECT chat, count, since FROM batches WHERE count > 0 AND since <= ?"),
      resetBatch: p("DELETE FROM batches WHERE chat = ?"),
      lastAlert: p("SELECT at FROM alerts WHERE topic = ?"),
      setAlert: p("INSERT INTO alerts(topic, at) VALUES(?, ?) ON CONFLICT(topic) DO UPDATE SET at = excluded.at"),
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

  // ---- posts: never the same text twice in the same place. A reply is keyed with what it answers (`ref`). ----
  hasPost(place, text, ref = "") { return Boolean(this.q.hasPost.get(place, textKey(ref ? `${text}|${ref}` : text))); }
  addPost({ at, helper, place, kind = "post", text, ref = "", externalId = null, url = null }) {
    this.q.addPost.run(at, helper, place, kind, textKey(ref ? `${text}|${ref}` : text), text, externalId, url);
  }
  postsToday(helper, place, kind, now) { return Number(this.q.postsSince.get(helper, place, kind, this.dayStart(now)).n); }
  recentPosts(helper, place, kind = "post", n = 10) { return this.q.recentPosts.all(helper, place, kind, n).map((r) => r.text); }

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

  // ---- approvals the owner decides on Telegram ----
  addApproval({ at, helper, kind, ref, title, url = null }) { return Number(this.q.addApproval.run(at, helper, kind, String(ref), title, url).lastInsertRowid); }
  approval(id) { return this.q.approval.get(id) || null; }
  approvalByMessage(chatId, messageId) { return this.q.approvalByMessage.get(String(chatId), String(messageId)) || null; }
  pendingApprovals() { return this.q.pending.all(); }
  setApprovalMessage(id, chatId, messageId) { this.q.setApprovalMessage.run(String(chatId), String(messageId), id); }
  /// Marks the decision. Returns false when it was already decided (a second press of the button does nothing).
  decide(id, state, note, at) { return this.q.decide.run(state, note, at, id).changes > 0; }
  setApprovalNote(id, note) { this.q.setNote.run(note, id); }

  // ---- Crumb's hourly batches: how many answers per chat since the batch began ----
  countAnswer(chat, now) { this.q.bump.run(String(chat), now); }
  dueBatches(now, age) { return this.q.dueBatches.all(now - age).map((r) => ({ chat: r.chat, count: Number(r.count), since: Number(r.since) })); }
  resetBatch(chat) { this.q.resetBatch.run(String(chat)); }

  // ---- alerts: at most one per topic per hour ----
  lastAlert(topic) { const r = this.q.lastAlert.get(topic); return r ? Number(r.at) : 0; }
  setAlert(topic, at) { this.q.setAlert.run(topic, at); }

  // ---- Nib's latest note, where Fudge and Crumb read it ----
  get latestNote() { const v = this.getMeta("note:latest"); return v ? JSON.parse(v) : null; }
  set latestNote(n) { this.setMeta("note:latest", JSON.stringify(n)); }
}
