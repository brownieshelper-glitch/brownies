// The money jobs board: every opportunity the brownies find and every piece of work meant to bring money or
// visibility to the project, with its state, the dollars expected and earned, and a log. Found by the scout or
// added by the owner, picked by the owner, prepared by a brownie, sent by the owner, won or lost. Read by the
// public page (/jobs/*) and by the control room, where the owner acts on it.
import { createHash } from "node:crypto";

export const KINDS = ["grant", "bounty", "hackathon", "accelerator", "listing", "partnership", "service", "studio", "channel", "other"];
export const STATES = ["found", "picked", "preparing", "waiting_owner", "submitted", "working", "won", "paid", "lost", "dropped"];
export const OPEN = new Set(["picked", "preparing", "waiting_owner", "submitted", "working"]);
export const STATE_LABEL = { found: "found", picked: "picked", preparing: "preparing", waiting_owner: "waiting for the owner", submitted: "submitted", working: "in progress", won: "won", paid: "paid", lost: "lost", dropped: "dropped" };

/// The owner's actions and the state each one sets (a note sets none).
export const ACTIONS = { pick: "picked", drop: "dropped", prepare: "preparing", wait: "waiting_owner", submit: "submitted", start: "working", won: "won", lost: "lost", paid: "paid", note: null };

/// One URL, one job: lower-case host, no tracking parameters, no hash, no trailing slash.
export function normalizeUrl(u) {
  try {
    const x = new URL(String(u).trim());
    if (!/^https?:$/.test(x.protocol)) return null;
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|ref$|fbclid|gclid|mc_)/i.test(k)) x.searchParams.delete(k);
    x.hash = "";
    let s = x.toString();
    s = s.replace(/\/+$/, "").replace(/\?$/, "");
    return s.toLowerCase();
  } catch { return null; }
}
export function refFor(url) {
  const n = normalizeUrl(url);
  return n ? createHash("sha256").update(n).digest("hex").slice(0, 32) : null;
}

export const money = (usd) => `$${Number(usd || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

/// Applies an owner's (or a brownie's) action to a job. Returns { job } or { error }.
export function applyAction(store, { id, action, text = "", value = null, by = "owner", now = Date.now() } = {}) {
  const a = String(action || "").toLowerCase();
  if (!(a in ACTIONS)) return { error: `No such action "${action}". Actions: ${Object.keys(ACTIONS).join(", ")}.` };
  const job = store.moneyJob(Number(id));
  if (!job) return { error: `There is no job ${id} on the board.` };
  const patch = {};
  if (ACTIONS[a]) patch.state = ACTIONS[a];
  if (a === "paid" || a === "won") {
    const n = Number(String(value ?? text ?? "").replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n) && n > 0) { if (a === "paid") patch.earnedUsd = n; else patch.expectedUsd = n; }
  }
  if (a === "drop" || a === "lost" || a === "paid") patch.ownerAction = null;
  const note = a === "note" ? String(text || "").trim() : `${a}${text && !/^[0-9.\s$]*$/.test(text) ? `: ${String(text).trim()}` : ""} (${by})`;
  if (a === "note" && !note) return { error: "A note needs text." };
  return { job: store.updateMoneyJob(job.id, patch, { at: now, by, note }) };
}

/// The strip of totals on the board.
export function totalsView(store) {
  const t = store.moneyTotals();
  const n = (s) => t[s]?.n || 0;
  const open = [...OPEN].reduce((sum, s) => sum + n(s), 0);
  const expectedOpen = [...OPEN].reduce((sum, s) => sum + (t[s]?.expectedUsd || 0), 0) + (t.found?.expectedUsd || 0);
  const earned = Object.values(t).reduce((sum, r) => sum + (r.earnedUsd || 0), 0);
  return { found: n("found"), open, won: n("won"), paid: n("paid"), lost: n("lost"), dropped: n("dropped"), earnedUsd: Math.round(earned * 100) / 100, expectedOpenUsd: Math.round(expectedOpen) };
}

/// The public read of the board on the helpers' server: GET /jobs/list?state=&kind=&limit=, GET /jobs/totals.
export class JobsApi {
  constructor({ store, log = () => {} }) { this.store = store; this.log = log; }
  handle(req, res) {
    const url = new URL(req.url, "http://x");
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "content-type" }); res.end(JSON.stringify(body)); };
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "content-type" }); return res.end(); }
    if (req.method !== "GET") return json(405, { error: "GET only" });
    try {
      if (url.pathname === "/jobs/totals") return json(200, totalsView(this.store));
      if (url.pathname === "/jobs/list") {
        const state = url.searchParams.get("state") || null, kind = url.searchParams.get("kind") || null;
        if (state && !STATES.includes(state)) return json(400, { error: "no such state" });
        if (kind && !KINDS.includes(kind)) return json(400, { error: "no such kind" });
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 200)));
        let list = this.store.moneyJobs({ state, limit: kind ? 500 : limit });
        if (kind) list = list.filter((j) => j.kind === kind).slice(0, limit);
        return json(200, { jobs: list.map((j) => ({ ...j, stateLabel: STATE_LABEL[j.state] || j.state })), totals: totalsView(this.store), states: STATE_LABEL, kinds: KINDS });
      }
      return json(404, { error: "no such route" });
    } catch (e) {
      this.log(`[jobs] ${e.message}`);
      return json(500, { error: "the board could not be read" });
    }
  }
}
