// The gateway's books: activations read from the chain, spend written by the proxy. SQLite through node:sqlite.
// One row per activation id (so a re-indexed block credits nothing twice), one running balance per beneficiary.
//
// Grants: a wallet (the granter, by its beneficiary id) lets another wallet (the grantee) spend from its balance up
// to a daily cap. The grantee signs its own key and names the granter in a header; the charge lands on the granter,
// the spend row says who spent it (via), and a per-day counter holds the cap. Days are UTC dates.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const dayKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/// A hold or a charge is a whole number of micro-dollars from 0 up. Anything else is refused here, whoever sent it:
/// a negative hold lowers what is held and so reads as more balance, and NaN poisons the column for good.
const amount = (micro) => {
  if (!Number.isSafeInteger(micro) || micro < 0) { const e = new Error(`not an amount of micro-dollars: ${micro}`); e.badAmount = true; throw e; }
  return micro;
};

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
      CREATE TABLE IF NOT EXISTS grants (
        granter TEXT NOT NULL,
        grantee TEXT NOT NULL,
        daily_micro INTEGER NOT NULL,
        created INTEGER NOT NULL,
        revoked INTEGER,
        PRIMARY KEY(granter, grantee)
      );
      CREATE INDEX IF NOT EXISTS grants_g ON grants(grantee);
      CREATE TABLE IF NOT EXISTS grant_spend (
        granter TEXT NOT NULL,
        grantee TEXT NOT NULL,
        day TEXT NOT NULL,
        micro INTEGER NOT NULL DEFAULT 0,
        calls INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(granter, grantee, day)
      );
      CREATE TABLE IF NOT EXISTS holds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        beneficiary TEXT NOT NULL,
        micro INTEGER NOT NULL,
        via TEXT,
        day TEXT,
        at INTEGER NOT NULL,
        floor_micro INTEGER NOT NULL DEFAULT 0,
        upstream_id TEXT,
        model TEXT
      );
      CREATE TABLE IF NOT EXISTS signin (
        nonce TEXT PRIMARY KEY,
        wallet TEXT NOT NULL,
        message TEXT NOT NULL,
        key_ms INTEGER NOT NULL,
        expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_keys (
        hash TEXT PRIMARY KEY,
        beneficiary TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        created INTEGER NOT NULL,
        expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS api_keys_b ON api_keys(beneficiary, created);
    `);
    // a book opened before grants existed gets the column that says who spent through a grant
    if (!this.db.prepare("PRAGMA table_info(spend)").all().some((c) => c.name === "via")) this.db.exec("ALTER TABLE spend ADD COLUMN via TEXT");
    // holds: what requests in flight have reserved, so two requests can never both spend the same dollar
    if (!this.db.prepare("PRAGMA table_info(accounts)").all().some((c) => c.name === "held_micro")) this.db.exec("ALTER TABLE accounts ADD COLUMN held_micro INTEGER NOT NULL DEFAULT 0");
    if (!this.db.prepare("PRAGMA table_info(grant_spend)").all().some((c) => c.name === "held_micro")) this.db.exec("ALTER TABLE grant_spend ADD COLUMN held_micro INTEGER NOT NULL DEFAULT 0");
    // what a process that stopped left in flight is dealt with below (_recover), once the statements exist
    this.q = {
      getMeta: this.db.prepare("SELECT v FROM meta WHERE k = ?"),
      setMeta: this.db.prepare("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"),
      hasActivation: this.db.prepare("SELECT 1 FROM activations WHERE id = ?"),
      addActivation: this.db.prepare("INSERT INTO activations(id, beneficiary, sender, atoms, block, tx) VALUES(?, ?, ?, ?, ?, ?)"),
      ensureAccount: this.db.prepare("INSERT OR IGNORE INTO accounts(beneficiary) VALUES(?)"),
      credit: this.db.prepare("UPDATE accounts SET credited_atoms = credited_atoms + ? WHERE beneficiary = ?"),
      account: this.db.prepare("SELECT beneficiary, credited_atoms, spent_micro, epoch, held_micro FROM accounts WHERE beneficiary = ?"),
      hold: this.db.prepare("UPDATE accounts SET held_micro = held_micro + ? WHERE beneficiary = ?"),
      release: this.db.prepare("UPDATE accounts SET held_micro = MAX(0, held_micro - ?) WHERE beneficiary = ?"),
      grantHold: this.db.prepare("INSERT INTO grant_spend(granter, grantee, day, micro, calls, held_micro) VALUES(?, ?, ?, 0, 0, ?) ON CONFLICT(granter, grantee, day) DO UPDATE SET held_micro = held_micro + excluded.held_micro"),
      grantRelease: this.db.prepare("UPDATE grant_spend SET held_micro = MAX(0, held_micro - ?) WHERE granter = ? AND grantee = ? AND day = ?"),
      spend: this.db.prepare("UPDATE accounts SET spent_micro = spent_micro + ? WHERE beneficiary = ?"),
      logSpend: this.db.prepare("INSERT INTO spend(beneficiary, at, model, micro, upstream_id, prompt_tokens, completion_tokens, via) VALUES(?, ?, ?, ?, ?, ?, ?, ?)"),
      setEpoch: this.db.prepare("UPDATE accounts SET epoch = ? WHERE beneficiary = ?"),
      totals: this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(atoms), 0) AS atoms FROM activations"),
      spentTotal: this.db.prepare("SELECT COALESCE(SUM(micro), 0) AS micro, COUNT(*) AS n FROM spend"),
      recentSpend: this.db.prepare("SELECT at, model, micro, prompt_tokens, completion_tokens, via FROM spend WHERE beneficiary = ? ORDER BY at DESC LIMIT ?"),
      activationsOf: this.db.prepare("SELECT id, sender, atoms, block, tx FROM activations WHERE beneficiary = ? ORDER BY id DESC LIMIT ?"),
      // grants
      setGrant: this.db.prepare("INSERT INTO grants(granter, grantee, daily_micro, created, revoked) VALUES(?, ?, ?, ?, NULL) ON CONFLICT(granter, grantee) DO UPDATE SET daily_micro = excluded.daily_micro, revoked = NULL, created = CASE WHEN grants.revoked IS NULL THEN grants.created ELSE excluded.created END"),
      revokeGrant: this.db.prepare("UPDATE grants SET revoked = ? WHERE granter = ? AND grantee = ? AND revoked IS NULL"),
      revokeAllGrants: this.db.prepare("UPDATE grants SET revoked = ? WHERE granter = ? AND revoked IS NULL"),
      grant: this.db.prepare("SELECT granter, grantee, daily_micro, created FROM grants WHERE granter = ? AND grantee = ? AND revoked IS NULL"),
      grantsBy: this.db.prepare("SELECT granter, grantee, daily_micro, created FROM grants WHERE granter = ? AND revoked IS NULL ORDER BY created, grantee"),
      grantsTo: this.db.prepare("SELECT granter, grantee, daily_micro, created FROM grants WHERE grantee = ? AND revoked IS NULL ORDER BY created, granter"),
      grantSpent: this.db.prepare("SELECT micro, calls, held_micro FROM grant_spend WHERE granter = ? AND grantee = ? AND day = ?"),
      addGrantSpend: this.db.prepare("INSERT INTO grant_spend(granter, grantee, day, micro, calls) VALUES(?, ?, ?, ?, 1) ON CONFLICT(granter, grantee, day) DO UPDATE SET micro = micro + excluded.micro, calls = calls + 1"),
      grantCounts: this.db.prepare("SELECT COUNT(*) AS n FROM grants WHERE revoked IS NULL"),
      // the calls in flight, one row each, so a process that stops leaves a record of them
      addHold: this.db.prepare("INSERT INTO holds(beneficiary, micro, via, day, at) VALUES(?, ?, ?, ?, ?)"),
      dropHold: this.db.prepare("DELETE FROM holds WHERE id = ?"),
      noteHold: this.db.prepare("UPDATE holds SET floor_micro = MAX(floor_micro, ?), upstream_id = COALESCE(?, upstream_id), model = COALESCE(?, model) WHERE id = ?"),
      allHolds: this.db.prepare("SELECT id, beneficiary, micro, via, day, at, floor_micro, upstream_id, model FROM holds ORDER BY id"),
      // sign-ins waiting for their signature, and the keys made from them (kept as hashes)
      addSignin: this.db.prepare("INSERT INTO signin(nonce, wallet, message, key_ms, expires) VALUES(?, ?, ?, ?, ?)"),
      signin: this.db.prepare("SELECT nonce, wallet, message, key_ms, expires FROM signin WHERE nonce = ?"),
      dropSignin: this.db.prepare("DELETE FROM signin WHERE nonce = ?"),
      oldSignins: this.db.prepare("DELETE FROM signin WHERE expires < ?"),
      extraSignins: this.db.prepare("DELETE FROM signin WHERE wallet = ? AND nonce NOT IN (SELECT nonce FROM signin WHERE wallet = ? ORDER BY expires DESC LIMIT ?)"),
      addKey: this.db.prepare("INSERT INTO api_keys(hash, beneficiary, epoch, created, expires) VALUES(?, ?, ?, ?, ?)"),
      key: this.db.prepare("SELECT hash, beneficiary, epoch, created, expires FROM api_keys WHERE hash = ?"),
      dropKey: this.db.prepare("DELETE FROM api_keys WHERE hash = ?"),
      oldKeysOf: this.db.prepare("DELETE FROM api_keys WHERE beneficiary = ? AND (expires < ? OR epoch <> ?)"),
      extraKeys: this.db.prepare("DELETE FROM api_keys WHERE beneficiary = ? AND hash NOT IN (SELECT hash FROM api_keys WHERE beneficiary = ? ORDER BY created DESC LIMIT ?)"),
      keysOf: this.db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE beneficiary = ? AND expires >= ? AND epoch = ?"),
    };
    this.recovered = this._recover();
  }

  /// What a process that stopped left in flight. A call the upstream had taken is booked at what was known of it then
  /// (the floor the proxy noted: the prompt it read, or what the pantry paid), never more than its hold; a call that
  /// had not got that far cost nothing. Then nothing is held. Returns the list, so the server can ask the upstream what
  /// each really cost. Before 2026-10-12 a restart forgot them all: paid upstream, charged to nobody.
  _recover() {
    const rows = this.q.allHolds.all();
    const out = [];
    this._tx(() => {
      for (const r of rows) {
        const b = r.beneficiary, hold = Number(r.micro), at = Number(r.at);
        const floor = Math.max(0, Math.min(Number(r.floor_micro) || 0, hold));
        if (floor > 0) {
          this.q.ensureAccount.run(b);
          this.q.spend.run(floor, b);
          this.q.logSpend.run(b, at, r.model ?? null, floor, r.upstream_id ?? null, null, null, r.via ?? null);
          if (r.via) this.q.addGrantSpend.run(b, r.via, r.day || dayKey(at), floor);
        }
        out.push({ beneficiary: b, via: r.via || null, day: r.day || null, at, holdMicro: hold, bookedMicro: floor, upstreamId: r.upstream_id || null, model: r.model || null });
      }
      this.db.exec("DELETE FROM holds; UPDATE accounts SET held_micro = 0 WHERE held_micro <> 0; UPDATE grant_spend SET held_micro = 0 WHERE held_micro <> 0");
    });
    return out;
  }

  /// What the gateway carried itself so far: the part of a call's cost that was over its hold (see settle).
  get shortfallMicro() {
    const r = this.q.getMeta.get("shortfallMicro");
    return r ? Number(r.v) || 0 : 0;
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
    if (!a) return { creditedMicro: 0, spentMicro: 0, heldMicro: 0, availableMicro: 0, epoch: 0 };
    const credited = Number(a.credited_atoms);
    const spent = Number(a.spent_micro);
    const held = Number(a.held_micro || 0);
    return { creditedMicro: credited, spentMicro: spent, heldMicro: held, availableMicro: Math.max(0, credited - spent - held), epoch: Number(a.epoch) };
  }

  /// Reserves the most a request could cost before the call is made, in one step with the check, so two requests in
  /// flight can never both spend the same dollar. Returns the hold to settle; throws when the balance has no room.
  reserve(beneficiary, micro, now = Date.now()) {
    const b = beneficiary.toLowerCase();
    amount(micro);
    return this._tx(() => {
      this.q.ensureAccount.run(b);
      const bal = this.balance(b);
      if (bal.availableMicro < micro) { const e = new Error(`balance ${bal.availableMicro} under ${micro}`); e.insufficient = true; e.availableMicro = bal.availableMicro; throw e; }
      this.q.hold.run(micro, b);
      const id = Number(this.q.addHold.run(b, micro, null, null, now).lastInsertRowid);
      return { id, beneficiary: b, micro, via: null, day: null };
    });
  }

  /// The same through a grant: the room is the cap less today's spend and today's holds, and never more than the
  /// granter has free. The hold sits on the granter's account and on the grant's day.
  reserveVia(granter, granteeWallet, micro, now = Date.now()) {
    const b = granter.toLowerCase(), via = granteeWallet.toLowerCase(), day = dayKey(now);
    amount(micro);
    return this._tx(() => {
      const room = this.grantRoom(b, via, now);
      if (!room) { const e = new Error("no grant"); e.noGrant = true; throw e; }
      if (room.roomMicro < micro) { const e = new Error(`room ${room.roomMicro} under ${micro}`); e.insufficient = true; e.availableMicro = room.roomMicro; throw e; }
      this.q.ensureAccount.run(b);
      this.q.hold.run(micro, b);
      this.q.grantHold.run(b, via, day, micro);
      const id = Number(this.q.addHold.run(b, micro, via, day, now).lastInsertRowid);
      return { id, beneficiary: b, micro, via, day };
    });
  }

  /// What is known of a call in flight, written next to its hold so that a process that stops does not lose it: the
  /// least the call has cost so far (the floor only rises, and never passes the hold), the upstream's id, the model.
  note(hold, { floorMicro = null, upstreamId = null, model = null } = {}) {
    if (!hold || hold.id == null) return;
    const f = Number(floorMicro);
    const floor = Number.isFinite(f) && f > 0 ? Math.min(Math.ceil(f), hold.micro) : 0;
    this.q.noteHold.run(floor, upstreamId == null ? null : String(upstreamId).slice(0, 200), model == null ? null : String(model).slice(0, 200), hold.id);
  }

  /// Lets a hold go and books what the call really cost (0 when nothing is owed), never more than the hold: the hold
  /// is what the balance and the grant's day were checked against, so a cost over it is the gateway's to carry, and it
  /// is counted (shortfallMicro) so that an estimate that runs low is seen. A hold settled twice is settled once.
  /// Returns { micro, overMicro }: what was booked, and what was not.
  settle(hold, micro, info = {}, now = Date.now()) {
    const b = hold.beneficiary;
    const cost = Number.isFinite(Number(micro)) && Number(micro) > 0 ? Math.ceil(Number(micro)) : 0; // a cost is never negative and never NaN
    const over = Math.max(0, cost - hold.micro);
    micro = cost - over;
    return this._tx(() => {
      // settled before, or booked when the ledger opened: letting it go again would free another call's hold
      if (hold.id != null && Number(this.q.dropHold.run(hold.id).changes) === 0) return { micro: 0, overMicro: 0, stale: true };
      if (over > 0) this.q.setMeta.run("shortfallMicro", String(this.shortfallMicro + over));
      this.q.release.run(hold.micro, b);
      if (hold.via) this.q.grantRelease.run(hold.micro, b, hold.via, hold.day);
      if (micro > 0) {
        this.q.spend.run(micro, b);
        this.q.logSpend.run(b, info.at ?? now, info.model ?? null, micro, info.upstreamId ?? null, info.promptTokens ?? null, info.completionTokens ?? null, hold.via);
        // booked to the day the room was checked and held: a call that began before midnight and ended after it must
        // not land on a day whose room never saw it (two full days of a cap could be spent across one midnight)
        if (hold.via) this.q.addGrantSpend.run(b, hold.via, hold.day || dayKey(now), micro);
      }
      return { micro, overMicro: over };
    });
  }

  charge(beneficiary, micro, info = {}) {
    const b = beneficiary.toLowerCase();
    amount(micro);
    this._tx(() => {
      this.q.ensureAccount.run(b);
      this.q.spend.run(micro, b);
      this.q.logSpend.run(b, info.at ?? Date.now(), info.model ?? null, micro, info.upstreamId ?? null, info.promptTokens ?? null, info.completionTokens ?? null, null);
    });
  }

  /// Raises the wallet's epoch: every key made before is refused from now on (it is told so when it is next used, and
  /// swept when the wallet signs in again). The grants the wallet gave end in the same step: a grant made with a key that leaked must not outlive that key. The new epoch.
  bumpEpoch(beneficiary, now = Date.now()) {
    const b = beneficiary.toLowerCase();
    return this._tx(() => {
      this.q.ensureAccount.run(b);
      const cur = this.balance(b).epoch;
      this.q.setEpoch.run(cur + 1, b);
      this.q.revokeAllGrants.run(now, b);
      return cur + 1;
    });
  }

  // ---- signing in, and the keys made from it (auth.mjs) ----

  /// Keeps a sign-in message until its signature comes back. The ones that ran out are swept on the way, and a wallet
  /// has five waiting at most (the oldest go), so nobody can fill the table by asking.
  addSignin({ nonce, wallet, message, keyMs, expires }, now = Date.now()) {
    this._tx(() => {
      this.q.oldSignins.run(now);
      this.q.addSignin.run(nonce, wallet, message, keyMs, expires);
      this.q.extraSignins.run(wallet, wallet, 5);
    });
  }
  /// Takes a sign-in out: it works once, right or wrong. Null when it is not there or ran out.
  takeSignin(nonce, now = Date.now()) {
    return this._tx(() => {
      const r = this.q.signin.get(nonce);
      if (!r) return null;
      this.q.dropSignin.run(nonce);
      return Number(r.expires) < now ? null : { nonce: r.nonce, wallet: r.wallet, message: r.message, keyMs: Number(r.key_ms), expires: Number(r.expires) };
    });
  }
  /// Books a new key by its hash, at the wallet's current epoch. Keys that ran out or were rotated away are swept,
  /// and a wallet keeps its twenty newest. Returns { epoch, expires }.
  addKey({ hash, beneficiary, keyMs }, now = Date.now()) {
    const b = beneficiary.toLowerCase();
    return this._tx(() => {
      this.q.ensureAccount.run(b);
      const epoch = this.balance(b).epoch;
      this.q.oldKeysOf.run(b, now, epoch);
      this.q.addKey.run(hash, b, epoch, now, now + keyMs);
      this.q.extraKeys.run(b, b, 20);
      return { epoch, expires: now + keyMs };
    });
  }
  /// The key with this hash while it is good: not run out, and made at the wallet's current epoch. Otherwise
  /// { gone: "expired" | "rotated" } for one we knew, or null for one we never made.
  key(hash, now = Date.now()) {
    const r = this.q.key.get(hash);
    if (!r) return null;
    if (Number(r.expires) < now) { this.q.dropKey.run(hash); return { gone: "expired" }; }
    if (Number(r.epoch) !== this.balance(r.beneficiary).epoch) { this.q.dropKey.run(hash); return { gone: "rotated" }; }
    return { beneficiary: r.beneficiary, epoch: Number(r.epoch), created: Number(r.created), expires: Number(r.expires) };
  }
  liveKeys(beneficiary, now = Date.now()) { const b = beneficiary.toLowerCase(); return Number(this.q.keysOf.get(b, now, this.balance(b).epoch).n); }

  stats() {
    const t = this.q.totals.get();
    const s = this.q.spentTotal.get();
    return { activations: Number(t.n), creditedMicro: Number(t.atoms), spentMicro: Number(s.micro), requests: Number(s.n), grants: Number(this.q.grantCounts.get().n), lastBlock: this.lastBlock };
  }

  recent(beneficiary, limit = 50) {
    const b = beneficiary.toLowerCase();
    return { spend: this.q.recentSpend.all(b, limit), activations: this.q.activationsOf.all(b, limit) };
  }

  // ---- grants ----
  /// The granter (a beneficiary id) lets the grantee (a wallet) spend up to dailyMicro a day. Setting it again
  /// changes the cap; a revoked grant set again starts fresh.
  setGrant(granter, granteeWallet, dailyMicro, now = Date.now()) {
    if (!Number.isSafeInteger(dailyMicro) || dailyMicro <= 0) throw new Error("dailyMicro must be a positive whole number");
    this.q.setGrant.run(granter.toLowerCase(), granteeWallet.toLowerCase(), dailyMicro, now);
    return this.grant(granter, granteeWallet);
  }

  /// Ends a grant. Returns false when there was none.
  revokeGrant(granter, granteeWallet, now = Date.now()) {
    return this.q.revokeGrant.run(now, granter.toLowerCase(), granteeWallet.toLowerCase()).changes > 0;
  }

  /// The active grant, or null.
  grant(granter, granteeWallet) {
    const r = this.q.grant.get(granter.toLowerCase(), granteeWallet.toLowerCase());
    return r ? { granter: r.granter, grantee: r.grantee, dailyMicro: Number(r.daily_micro), created: Number(r.created) } : null;
  }

  /// What the grantee may still spend from the granter today: the cap less today's spend, and never more than
  /// the granter has. Null when there is no active grant.
  grantRoom(granter, granteeWallet, now = Date.now()) {
    const g = this.grant(granter, granteeWallet);
    if (!g) return null;
    return this._room(g, now);
  }
  _room(g, now) {
    const s = this.q.grantSpent.get(g.granter, g.grantee, dayKey(now));
    const spentMicro = s ? Number(s.micro) : 0, calls = s ? Number(s.calls) : 0, heldMicro = s ? Number(s.held_micro || 0) : 0;
    const roomMicro = Math.max(0, Math.min(g.dailyMicro - spentMicro - heldMicro, this.balance(g.granter).availableMicro));
    return { ...g, spentMicro, calls, heldMicro, roomMicro, day: dayKey(now) };
  }
  /// Every active grant this granter gave, with today's room.
  grantsBy(granter, now = Date.now()) {
    return this.q.grantsBy.all(granter.toLowerCase()).map((r) => this._room({ granter: r.granter, grantee: r.grantee, dailyMicro: Number(r.daily_micro), created: Number(r.created) }, now));
  }
  /// Every active grant this wallet received, with today's room.
  grantsTo(granteeWallet, now = Date.now()) {
    return this.q.grantsTo.all(granteeWallet.toLowerCase()).map((r) => this._room({ granter: r.granter, grantee: r.grantee, dailyMicro: Number(r.daily_micro), created: Number(r.created) }, now));
  }

  /// A charge paid by the granter for something the grantee did. Counted against the grant's day as well.
  chargeVia(granter, granteeWallet, micro, info = {}, now = Date.now()) {
    const b = granter.toLowerCase(), via = granteeWallet.toLowerCase();
    amount(micro);
    this._tx(() => {
      this.q.ensureAccount.run(b);
      this.q.spend.run(micro, b);
      this.q.logSpend.run(b, info.at ?? now, info.model ?? null, micro, info.upstreamId ?? null, info.promptTokens ?? null, info.completionTokens ?? null, via);
      this.q.addGrantSpend.run(b, via, dayKey(now), micro);
    });
  }
}
