// The three ad platforms behind one small interface, so Butterscotch reads and acts the same way everywhere:
//   configured            the keys are there
//   campaigns()           -> [{ id, name, status, dailyBudgetUsd, lane }]
//   insights({ since, until }) -> normalized cells (lib/ads/metrics.mjs) per campaign for the date range
//   setStatus(id, "active" | "paused"), setBudget(id, dailyUsd)
// Endpoints follow the platforms' documentation as read on 2026-10-11 (Meta Graph API insights and status,
// TikTok Marketing API v1.3, X Ads API v12). None of them has been called against a live account yet: the
// accounts do not exist. The tests pin the request shapes; the first live run is a read with the owner watching.
// Lanes are read from the campaign's name: a name that contains "stories" or "services" belongs to that lane.
import { cell } from "./metrics.mjs";

const laneOf = (name) => (/stories/i.test(name) ? "stories" : /services/i.test(name) ? "services" : null);
const n = (v) => Number(v) || 0;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/// Meta Marketing API (Graph). token: a system user token with ads_read + ads_management; account: act_<id>.
export class MetaAds {
  constructor({ token = "", account = "", version = "v23.0", fetch = globalThis.fetch, log = () => {} } = {}) {
    Object.assign(this, { token, account: account && !String(account).startsWith("act_") ? `act_${account}` : account, version, fetch, log });
    this.base = `https://graph.facebook.com/${version}`;
  }
  get platform() { return "meta"; }
  get configured() { return Boolean(this.token && this.account); }
  async call(method, path, params = {}) {
    const url = new URL(`${this.base}/${path.replace(/^\//, "")}`);
    const body = method === "GET" ? null : new URLSearchParams();
    for (const [k, v] of Object.entries(params)) (method === "GET" ? url.searchParams : body).set(k, typeof v === "string" ? v : JSON.stringify(v));
    url.searchParams.set("access_token", this.token);
    const r = await this.fetch(url.toString(), { method, body, headers: body ? { "content-type": "application/x-www-form-urlencoded" } : {} });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(`Meta ${method} ${path}: ${j.error?.message || r.status}`);
    return j;
  }
  async campaigns() {
    const j = await this.call("GET", `${this.account}/campaigns`, { fields: "id,name,status,effective_status,daily_budget", limit: "100" });
    return (j.data || []).map((c) => ({ id: String(c.id), name: c.name, status: c.effective_status === "ACTIVE" ? "active" : "paused", dailyBudgetUsd: n(c.daily_budget) / 100, lane: laneOf(c.name) }));
  }
  async insights({ since, until }) {
    const j = await this.call("GET", `${this.account}/insights`, { level: "campaign", time_range: { since: iso(since), until: iso(until) }, fields: "campaign_id,campaign_name,spend,impressions,reach,frequency,clicks,actions,video_play_actions,video_p25_watched_actions,video_15_sec_watched_actions,video_thruplay_watched_actions", limit: "100" });
    const days = Math.max(1, Math.round((until - since) / 86_400_000) + 1);
    return (j.data || []).map((r) => {
      const act = (type) => n((r.actions || []).find((a) => a.action_type === type)?.value);
      const v3 = n((r.video_play_actions || [])[0]?.value) || act("video_view");
      return cell({ platform: "meta", id: String(r.campaign_id), name: r.campaign_name, lane: laneOf(r.campaign_name), days, placement: "reels", spendUsd: n(r.spend), impressions: n(r.impressions), reach: n(r.reach), clicks: n(r.clicks), views3s: v3, views15s: n((r.video_15_sec_watched_actions || [])[0]?.value), thruplays: n((r.video_thruplay_watched_actions || [])[0]?.value), results: laneOf(r.campaign_name) === "services" ? act("landing_page_view") : v3, resultType: laneOf(r.campaign_name) === "services" ? "landing page view" : "3-second view" });
    });
  }
  async setStatus(id, status) { await this.call("POST", String(id), { status: status === "active" ? "ACTIVE" : "PAUSED" }); return true; }
  async setBudget(id, dailyUsd) { await this.call("POST", String(id), { daily_budget: String(Math.round(dailyUsd * 100)) }); return true; }
}

/// TikTok Marketing API v1.3. token: the advertiser's access token from the developer app; advertiser: the advertiser id.
export class TikTokAds {
  constructor({ token = "", advertiser = "", fetch = globalThis.fetch, log = () => {} } = {}) {
    Object.assign(this, { token, advertiser: String(advertiser || ""), fetch, log });
    this.base = "https://business-api.tiktok.com/open_api/v1.3";
  }
  get platform() { return "tiktok"; }
  get configured() { return Boolean(this.token && this.advertiser); }
  async call(method, path, params = {}) {
    const url = new URL(`${this.base}/${path.replace(/^\//, "")}`);
    let body = null;
    if (method === "GET") for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
    else body = JSON.stringify(params);
    const r = await this.fetch(url.toString(), { method, body, headers: { "Access-Token": this.token, "content-type": "application/json" } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || (j.code != null && j.code !== 0)) throw new Error(`TikTok ${method} ${path}: ${j.message || r.status}`);
    return j.data || {};
  }
  async campaigns() {
    const d = await this.call("GET", "campaign/get/", { advertiser_id: this.advertiser, page_size: "100" });
    return (d.list || []).map((c) => ({ id: String(c.campaign_id), name: c.campaign_name, status: c.operation_status === "ENABLE" ? "active" : "paused", dailyBudgetUsd: n(c.budget), lane: laneOf(c.campaign_name) }));
  }
  async insights({ since, until }) {
    const d = await this.call("GET", "report/integrated/get/", { advertiser_id: this.advertiser, report_type: "BASIC", data_level: "AUCTION_CAMPAIGN", dimensions: ["campaign_id"], metrics: ["campaign_name", "spend", "impressions", "reach", "frequency", "clicks", "video_watched_2s", "video_watched_6s", "video_views_p25", "conversion", "result"], start_date: iso(since), end_date: iso(until), page_size: "100" });
    const days = Math.max(1, Math.round((until - since) / 86_400_000) + 1);
    return (d.list || []).map((row) => {
      const m = row.metrics || {}, name = m.campaign_name || "";
      return cell({ platform: "tiktok", id: String(row.dimensions?.campaign_id || ""), name, lane: laneOf(name), days, placement: "tiktok", spendUsd: n(m.spend), impressions: n(m.impressions), reach: n(m.reach), clicks: n(m.clicks), views3s: n(m.video_watched_2s), views15s: n(m.video_watched_6s), results: laneOf(name) === "services" ? n(m.conversion) : n(m.video_watched_2s), resultType: laneOf(name) === "services" ? "conversion" : "2-second view" });
    });
  }
  async setStatus(id, status) { await this.call("POST", "campaign/status/update/", { advertiser_id: this.advertiser, campaign_ids: [String(id)], operation_status: status === "active" ? "ENABLE" : "DISABLE" }); return true; }
  async setBudget(id, dailyUsd) { await this.call("POST", "campaign/update/", { advertiser_id: this.advertiser, campaign_id: String(id), budget: Math.round(dailyUsd * 100) / 100 }); return true; }
}

/// X Ads API v12. OAuth 1.0a: consumerKey/Secret + accessToken/Secret of the ads account's user; account: the ads account id.
export class XAds {
  constructor({ consumerKey = "", consumerSecret = "", accessToken = "", accessSecret = "", account = "", fetch = globalThis.fetch, sign = null, log = () => {} } = {}) {
    Object.assign(this, { consumerKey, consumerSecret, accessToken, accessSecret, account: String(account || ""), fetch, log });
    this.sign = sign; // (method, url, params) -> the Authorization header; set by whoever has an OAuth 1.0a signer
    this.base = "https://ads-api.x.com/12";
  }
  get platform() { return "x"; }
  get configured() { return Boolean(this.consumerKey && this.consumerSecret && this.accessToken && this.accessSecret && this.account && this.sign); }
  async call(method, path, params = {}) {
    const url = new URL(`${this.base}/${path.replace(/^\//, "")}`);
    let body = null;
    if (method === "GET") for (const [k, v] of Object.entries(params)) url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
    else body = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)]));
    const auth = await this.sign(method, url.toString(), method === "GET" ? {} : Object.fromEntries(body));
    const r = await this.fetch(url.toString(), { method, body, headers: { authorization: auth, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`X Ads ${method} ${path}: ${j.errors?.[0]?.message || r.status}`);
    return j;
  }
  async campaigns() {
    const j = await this.call("GET", `accounts/${this.account}/campaigns`, { count: 200 });
    return (j.data || []).map((c) => ({ id: String(c.id), name: c.name, status: c.entity_status === "ACTIVE" ? "active" : "paused", dailyBudgetUsd: n(c.daily_budget_amount_local_micro) / 1e6, lane: laneOf(c.name) }));
  }
  async insights({ since, until }) {
    const camps = await this.campaigns();
    if (!camps.length) return [];
    const j = await this.call("GET", `stats/accounts/${this.account}`, { entity: "CAMPAIGN", entity_ids: camps.map((c) => c.id).slice(0, 20), start_time: new Date(since).toISOString(), end_time: new Date(until + 86_400_000).toISOString(), granularity: "TOTAL", metric_groups: ["BILLING", "ENGAGEMENT", "VIDEO"], placement: "ALL_ON_TWITTER" });
    const days = Math.max(1, Math.round((until - since) / 86_400_000) + 1);
    const first = (a) => n((a || [])[0]);
    return (j.data || []).map((row) => {
      const m = row.id_data?.[0]?.metrics || {}, c = camps.find((x) => x.id === String(row.id)) || { name: "", lane: null };
      const v3 = first(m.video_3s100pct_views) || first(m.video_views_25);
      return cell({ platform: "x", id: String(row.id), name: c.name, lane: c.lane, days, placement: "x", spendUsd: first(m.billed_charge_local_micro) / 1e6, impressions: first(m.impressions), clicks: first(m.clicks) || first(m.url_clicks), views3s: v3, views15s: first(m.video_views_50), results: c.lane === "services" ? first(m.url_clicks) : v3, resultType: c.lane === "services" ? "link click" : "3-second view" });
    });
  }
  async setStatus(id, status) { await this.call("PUT", `accounts/${this.account}/campaigns/${id}`, { entity_status: status === "active" ? "ACTIVE" : "PAUSED" }); return true; }
  async setBudget(id, dailyUsd) { await this.call("PUT", `accounts/${this.account}/campaigns/${id}`, { daily_budget_amount_local_micro: Math.round(dailyUsd * 1e6) }); return true; }
}

/// What each platform still needs before Butterscotch can read it (section 9), from the settings present.
export function missing(settings = {}) {
  const out = [];
  if (!settings.meta?.token || !settings.meta?.account) out.push("Meta: a system user token (ads_read, ads_management) and the ad account id (META_ADS_TOKEN, META_AD_ACCOUNT_ID)");
  if (!settings.tiktok?.token || !settings.tiktok?.advertiser) out.push("TikTok: the developer app's access token and the advertiser id (TIKTOK_ADS_TOKEN, TIKTOK_ADVERTISER_ID)");
  if (!settings.x?.consumerKey || !settings.x?.accessToken || !settings.x?.account) out.push("X: Ads API access on our developer app, its OAuth 1.0a keys and the ads account id (X_ADS_CONSUMER_KEY, X_ADS_CONSUMER_SECRET, X_ADS_ACCESS_TOKEN, X_ADS_ACCESS_SECRET, X_ADS_ACCOUNT_ID)");
  return out;
}
