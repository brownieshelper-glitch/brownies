// The Brownies gateway, seen from the helpers. Two uses: the brownies report every job to the team log, and in
// MODE=live they also think through it (POST /v1/chat/completions with their own key) and read their balance.
//
//   report  POST /api/team/log   bearer TEAM_LOG_KEY   { helper, kind, title, body?, url?, place?, cost_micro? }
//   kinds: status, post, reply, research, build, deal, milestone, note (gateway/teamlog.mjs checks them)
//
// A failed report is logged and forgotten: a brownie never stops working because the Kitchen is down.
export const KINDS = ["status", "post", "reply", "research", "build", "deal", "milestone", "note"];

export class Gateway {
  constructor({ url, teamKey = "", fetch = globalThis.fetch, log = () => {} }) {
    this.url = String(url || "").replace(/\/$/, "");
    this.teamKey = teamKey;
    this.fetch = fetch;
    this.log = log;
    this.reports = 0;
  }

  /// One report. Returns the stored row, or null when the gateway refused it or was unreachable.
  async report({ helper, kind, title, body = null, url = null, place = null, cost_micro = 0 }) {
    if (!KINDS.includes(kind)) throw new Error(`bad report kind ${kind}`);
    const entry = { helper, kind, title: String(title).slice(0, 160) };
    if (body) entry.body = String(body).slice(0, 1000);
    if (url) entry.url = url;
    if (place) entry.place = place;
    if (cost_micro) entry.cost_micro = Math.max(0, Math.round(cost_micro));
    try {
      const r = await this.fetch(`${this.url}/api/team/log`, { method: "POST", headers: { authorization: `Bearer ${this.teamKey}`, "content-type": "application/json" }, body: JSON.stringify(entry) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { this.log(`[gateway] report refused ${r.status} ${j.error?.code || ""} (${helper} ${kind})`); return null; }
      this.reports++;
      return j.added?.[0] || null;
    } catch (e) {
      this.log(`[gateway] report failed: ${e.message} (${helper} ${kind})`);
      return null;
    }
  }

  /// A plain GET of a public route: { ok, status, body } (body is parsed JSON, or null).
  async get(path, headers = {}) {
    try {
      const r = await this.fetch(`${this.url}${path}`, { headers });
      return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
    } catch (e) {
      return { ok: false, status: 0, body: null, error: e.message };
    }
  }
  stats() { return this.get("/api/protocol/stats"); }
  summary() { return this.get("/api/team/summary"); }
  account(wallet) { return this.get(`/api/protocol/account/${wallet}`); }
  key(bearer, headers = {}) { return this.get("/v1/key", { authorization: `Bearer ${bearer}`, ...headers }); }
  health() { return this.get("/health"); }

  /// A chat completion through the gateway, paid by the key's SUGAR balance. Returns { status, body }.
  async chat(bearer, body, headers = {}) {
    const r = await this.fetch(`${this.url}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }
}
