// First-party visits: the site tells the gateway when a page is opened from a link with UTM tags (an ad, a
// post), and the gateway counts it per day, source, campaign and content. No cookie, no address, no person:
// a count. Butterscotch reads the counts to compute cost per visit when the platforms' pixels are blocked.
//   POST /api/visit  { source, medium, campaign, content, path }      -> { ok }
//   GET  /api/visits?days=14                                           -> { days, rows: [{ day, source, campaign, content, n }] }
const TAG = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const tag = (v) => { const s = String(v ?? "").toLowerCase().trim(); return TAG.test(s) ? s : null; };

export class Visits {
  constructor(db, { now = () => Date.now() } = {}) {
    this.db = db; this.now = now;
    db.exec("CREATE TABLE IF NOT EXISTS visits (day TEXT NOT NULL, source TEXT NOT NULL, campaign TEXT NOT NULL, content TEXT NOT NULL, path TEXT NOT NULL DEFAULT '', n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day, source, campaign, content, path))");
    this.q = {
      bump: db.prepare("INSERT INTO visits(day, source, campaign, content, path, n) VALUES(?, ?, ?, ?, ?, 1) ON CONFLICT(day, source, campaign, content, path) DO UPDATE SET n = n + 1"),
      since: db.prepare("SELECT day, source, campaign, content, SUM(n) AS n FROM visits WHERE day >= ? GROUP BY day, source, campaign, content ORDER BY day DESC, n DESC"),
      total: db.prepare("SELECT source, campaign, content, SUM(n) AS n FROM visits WHERE day >= ? GROUP BY source, campaign, content"),
    };
  }
  /// Counts one visit. Returns false when the tags are not ours (nothing is kept).
  count({ source, medium = "paid", campaign, content = "", path = "" } = {}) {
    const s = tag(source), c = tag(campaign), k = content ? tag(content) : "", m = tag(medium) || "paid";
    if (!s || !c || (content && !k)) return false;
    const p = String(path || "").replace(/[^a-z0-9/_.-]/gi, "").slice(0, 60);
    this.q.bump.run(new Date(this.now()).toISOString().slice(0, 10), `${s}:${m}`, c, k, p);
    return true;
  }
  rows(days = 14) {
    const from = new Date(this.now() - Math.max(0, Math.min(90, Number(days) || 14) - 1) * 86_400_000).toISOString().slice(0, 10);
    return this.q.since.all(from).map((r) => ({ day: r.day, source: r.source, campaign: r.campaign, content: r.content, n: Number(r.n) }));
  }
  /// Totals per content over the period, for cost per visit: { "meta:paid|stories|ep-cut-h1": n }.
  totals(days = 7) {
    const from = new Date(this.now() - Math.max(0, Math.min(90, Number(days) || 7) - 1) * 86_400_000).toISOString().slice(0, 10);
    const out = {};
    for (const r of this.q.total.all(from)) out[`${r.source}|${r.campaign}|${r.content}`] = Number(r.n);
    return out;
  }
}
