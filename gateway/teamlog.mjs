// What the brownies did. One row per thing a helper reports: a post, an answer, a research note, something built,
// a deal, a milestone, or the task it is on right now ("status"). Anyone can read the log. Only a caller that holds
// the team key can write to it.
//
// The words in it are written by AI helpers and shown on a public page. So every field is checked and cut to size
// here, a link must be https, and the site prints everything as plain text.
export const KINDS = ["status", "post", "reply", "research", "build", "deal", "milestone", "note"];
const NAME = /^[a-z][a-z0-9_-]{1,23}$/;

const bad = (message) => Object.assign(new Error(message), { status: 400, code: "bad_entry" });
// one line of plain text: control characters and runs of spaces become one space
const line = (v, max) => String(v ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/// Checks one entry and returns the row to store. Throws a 400 with a plain sentence when it is not acceptable.
export function clean(e, now = Date.now()) {
  if (!e || typeof e !== "object" || Array.isArray(e)) throw bad("An entry must be an object.");
  const helper = String(e.helper ?? "").toLowerCase();
  if (!NAME.test(helper)) throw bad("helper must be a short lowercase name.");
  if (!KINDS.includes(e.kind)) throw bad("kind must be one of: " + KINDS.join(", ") + ".");
  const title = line(e.title, 160);
  if (!title) throw bad("title is empty.");
  const body = line(e.body, 1000) || null;
  let url = null;
  if (e.url != null && e.url !== "") {
    let u;
    try { u = new URL(String(e.url)); } catch { throw bad("url is not a link."); }
    if (u.protocol !== "https:" || u.href.length > 300) throw bad("url must be an https link of at most 300 characters.");
    url = u.href;
  }
  const place = line(e.place, 24).toLowerCase() || null;
  if (place && !/^[a-z0-9 ._-]+$/.test(place)) throw bad("place must be a plain word, for example x or telegram.");
  const cost = e.cost_micro == null ? 0 : Number(e.cost_micro);
  if (!Number.isSafeInteger(cost) || cost < 0 || cost > 1e9) throw bad("cost_micro must be a whole number of micro-dollars.");
  const at = e.at == null ? now : Number(e.at);
  if (!Number.isSafeInteger(at) || at < 1.6e12 || at > now + 60_000) throw bad("at must be a time in milliseconds that is not in the future.");
  return { at: Math.min(at, now), helper, kind: e.kind, title, body, url, place, cost_micro: cost };
}

export const isHelperName = (s) => NAME.test(s);

export class TeamLog {
  /// `db` is the gateway's own database (node:sqlite), so the log lives in the same file as the ledger.
  constructor(db) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS team_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        helper TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        url TEXT,
        place TEXT,
        cost_micro INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS team_log_helper ON team_log(helper, id);
      CREATE INDEX IF NOT EXISTS team_log_kind ON team_log(kind, id);
    `);
    // a report the owner took down: kept for the record, shown nowhere (the column arrived 2026-10-08)
    try { db.exec("ALTER TABLE team_log ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0"); } catch { /* already there */ }
    this.q = {
      add: db.prepare("INSERT INTO team_log(at, helper, kind, title, body, url, place, cost_micro) VALUES(?, ?, ?, ?, ?, ?, ?, ?)"),
      perHelper: db.prepare("SELECT helper, COUNT(*) AS total, COALESCE(SUM(at >= ?), 0) AS today, COALESCE(SUM(CASE WHEN at >= ? THEN cost_micro ELSE 0 END), 0) AS cost_today, MAX(at) AS last_at FROM team_log WHERE kind != 'status' AND hidden = 0 GROUP BY helper"),
      status: db.prepare("SELECT helper, title, at FROM team_log WHERE id IN (SELECT MAX(id) FROM team_log WHERE kind = 'status' GROUP BY helper)"),
      week: db.prepare("SELECT kind, COUNT(*) AS n FROM team_log WHERE kind != 'status' AND hidden = 0 AND at >= ? GROUP BY kind"),
      total: db.prepare("SELECT COUNT(*) AS n FROM team_log WHERE kind != 'status' AND hidden = 0"),
      hide: db.prepare("UPDATE team_log SET hidden = 1 WHERE hidden = 0 AND (id = ? OR (? != '' AND url = ?))"),
    };
  }

  /// Takes a report off every public view, by its id or by the exact address it carried. Returns how many rows changed.
  hide({ id = 0, url = "" } = {}) {
    const i = Math.floor(Number(id) || 0), u = String(url || "");
    if (!i && !u) return 0;
    return Number(this.q.hide.run(i, u, u).changes);
  }

  /// Stores a row that clean() returned. Returns it with its id.
  insert(row) {
    const r = this.q.add.run(row.at, row.helper, row.kind, row.title, row.body, row.url, row.place, row.cost_micro);
    return { id: Number(r.lastInsertRowid), ...row };
  }
  add(entry, now = Date.now()) { return this.insert(clean(entry, now)); }

  /// Newest first, or oldest first with asc (the order the bricks were laid; offset then counts from the first job).
  /// Without a kind it leaves out the "status" rows, which are not things done.
  list({ limit = 30, before = 0, helper = "", kind = "", offset = 0, asc = false } = {}) {
    const where = [], args = [];
    if (before > 0) { where.push("id < ?"); args.push(Math.floor(before)); }
    if (helper) { where.push("helper = ?"); args.push(helper); }
    if (kind) { where.push("kind = ?"); args.push(kind); } else where.push("kind != 'status'");
    where.push("hidden = 0");
    const sql = "SELECT id, at, helper, kind, title, body, url, place, cost_micro FROM team_log WHERE " + where.join(" AND ") + " ORDER BY id " + (asc ? "ASC" : "DESC") + " LIMIT ? OFFSET ?";
    return this.db.prepare(sql).all(...args, Math.max(1, Math.min(100, Math.floor(limit) || 30)), Math.max(0, Math.floor(offset) || 0));
  }

  /// The jobs done, cut into towers of `size` in the order they were reported: how many bricks each tower has, and
  /// when its first and its last brick were laid.
  towers(size = 100) {
    const n = Math.max(1, Math.floor(size));
    const rows = this.db.prepare(`SELECT (rn - 1) / ${n} AS tower, COUNT(*) AS count, MIN(at) AS first_at, MAX(at) AS last_at
      FROM (SELECT at, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM team_log WHERE kind != 'status' AND hidden = 0) GROUP BY tower ORDER BY tower`).all();
    return rows.map((r) => ({ tower: Number(r.tower), count: Number(r.count), firstAt: Number(r.first_at), lastAt: Number(r.last_at) }));
  }

  /// Per helper: how much it reported, what it costs today, when it was last seen and what it is on now.
  /// Plus the count of each kind over the last 7 days, and the count of everything.
  summary(now = Date.now()) {
    const day = now - (now % 86_400_000);
    const helpers = {};
    for (const r of this.q.perHelper.all(day, day)) helpers[r.helper] = { helper: r.helper, total: Number(r.total), today: Number(r.today), costTodayMicro: Number(r.cost_today), lastAt: Number(r.last_at), status: null };
    for (const s of this.q.status.all()) {
      helpers[s.helper] ??= { helper: s.helper, total: 0, today: 0, costTodayMicro: 0, lastAt: 0, status: null };
      helpers[s.helper].status = { title: s.title, at: Number(s.at) };
    }
    const week = {};
    for (const w of this.q.week.all(now - 7 * 86_400_000)) week[w.kind] = Number(w.n);
    return { now, helpers: Object.values(helpers), week, total: Number(this.q.total.get().n) };
  }
}
