// The gateway's books: activations read from the chain, spend written by the proxy. SQLite through node:sqlite.
// One row per activation id (so a re-indexed block credits nothing twice), one running balance per beneficiary.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class Ledger {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS activations (
        id INTEGER PRIMARY KEY,
        beneficiary TEXT NOT NULL,
        sender TEXT NOT NULL,
        atoms INTEGER NOT NULL,
        block INTEGER NOT NULL,
        tx TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS accounts (
        beneficiary TEXT PRIMARY KEY,
        credited_atoms INTEGER NOT NULL DEFAULT 0,
        spent_micro INTEGER NOT NULL DEFAULT 0,
        epoch INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS spend (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        beneficiary TEXT NOT NULL,
        at INTEGER NOT NULL,
        model TEXT,
        micro INTEGER NOT NULL,
        upstream_id TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER
      );
      CREATE INDEX IF NOT EXISTS spend_b ON spend(beneficiary, at);
    `);
    this.q = {
      getMeta: this.db.prepare("SELECT v FROM meta WHERE k = ?"),
      setMeta: this.db.prepare("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"),
      hasActivation: this.db.prepare("SELECT 1 FROM activations WHERE id = ?"),
      addActivation: this.db.prepare("INSERT INTO activations(id, beneficiary, sender, atoms, block, tx) VALUES(?, ?, ?, ?, ?, ?)"),
      ensureAccount: this.db.prepare("INSERT OR IGNORE INTO accounts(beneficiary) VALUES(?)"),
      credit: this.db.prepare("UPDATE accounts SET credited_atoms = credited_atoms + ? WHERE beneficiary = ?"),
      account: this.db.prepare("SELECT beneficiary, credited_atoms, spent_micro, epoch FROM accounts WHERE beneficiary = ?"),
      spend: this.db.prepare("UPDATE accounts SET spent_micro = spent_micro + ? WHERE beneficiary = ?"),
      logSpend: this.db.prepare("INSERT INTO spend(beneficiary, at, model, micro, upstream_id, prompt_tokens, completion_tokens) VALUES(?, ?, ?, ?, ?, ?, ?)"),
      setEpoch: this.db.prepare("UPDATE accounts SET epoch = ? WHERE beneficiary = ?"),
      totals: this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(atoms), 0) AS atoms FROM activations"),
      spentTotal: this.db.prepare("SELECT COALESCE(SUM(micro), 0) AS micro, COUNT(*) AS n FROM spend"),
      recentSpend: this.db.prepare("SELECT at, model, micro, prompt_tokens, completion_tokens FROM spend WHERE beneficiary = ? ORDER BY at DESC LIMIT ?"),
      activationsOf: this.db.prepare("SELECT id, sender, atoms, block, tx FROM activations WHERE beneficiary = ? ORDER BY id DESC LIMIT ?"),
    };
  }

  /// node:sqlite has no transaction helper: BEGIN, run, COMMIT, and ROLLBACK on any throw.
  _tx(fn) {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  get lastBlock() {
    const r = this.q.getMeta.get("lastBlock");
    return r ? Number(r.v) : null;
  }
  set lastBlock(n) {
    this.q.setMeta.run("lastBlock", String(n));
  }

  /// Credit one Activated event. Returns false if that id was already booked.
  recordActivation({ id, beneficiary, sender, atoms, block, tx }) {
    if (this.q.hasActivation.get(id)) return false;
    const b = beneficiary.toLowerCase();
    this._tx(() => {
      this.q.addActivation.run(id, b, sender.toLowerCase(), atoms, block, tx);
      this.q.ensureAccount.run(b);
      this.q.credit.run(atoms, b);
    });
    return true;
  }

  /// Balance in micro-dollars: one SUGAR atom is one micro-dollar.
  balance(beneficiary) {
    const b = beneficiary.toLowerCase();
    const a = this.q.account.get(b);
    if (!a) return { creditedMicro: 0, spentMicro: 0, availableMicro: 0, epoch: 0 };
    const credited = Number(a.credited_atoms);
    const spent = Number(a.spent_micro);
    return { creditedMicro: credited, spentMicro: spent, availableMicro: Math.max(0, credited - spent), epoch: Number(a.epoch) };
  }

  charge(beneficiary, micro, info = {}) {
    const b = beneficiary.toLowerCase();
    this._tx(() => {
      this.q.ensureAccount.run(b);
      this.q.spend.run(micro, b);
      this.q.logSpend.run(b, Date.now(), info.model ?? null, micro, info.upstreamId ?? null, info.promptTokens ?? null, info.completionTokens ?? null);
    });
  }

  bumpEpoch(beneficiary) {
    const b = beneficiary.toLowerCase();
    this.q.ensureAccount.run(b);
    const cur = this.balance(b).epoch;
    this.q.setEpoch.run(cur + 1, b);
    return cur + 1;
  }

  stats() {
    const t = this.q.totals.get();
    const s = this.q.spentTotal.get();
    return { activations: Number(t.n), creditedMicro: Number(t.atoms), spentMicro: Number(s.micro), requests: Number(s.n), lastBlock: this.lastBlock };
  }

  recent(beneficiary, limit = 50) {
    const b = beneficiary.toLowerCase();
    return { spend: this.q.recentSpend.all(b, limit), activations: this.q.activationsOf.all(b, limit) };
  }
}
