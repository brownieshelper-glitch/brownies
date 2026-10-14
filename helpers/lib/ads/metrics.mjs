// The one shape every platform's numbers are read into, and the KPIs computed from it (playbook section 4).
// A "cell" is a campaign, an ad set or an ad; the connectors fill the raw counts, this file does the arithmetic.
export const EMPTY = { spendUsd: 0, impressions: 0, reach: 0, clicks: 0, views3s: 0, views15s: 0, thruplays: 0, results: 0, visits: 0, orders: 0 };

/// A normalized row: { platform, id, name, level, lane, status, dailyBudgetUsd, days, placement, ...counts }.
export function cell(o = {}) {
  const c = { platform: "meta", id: "", name: "", level: "campaign", lane: null, status: "active", dailyBudgetUsd: 0, days: 1, placement: "reels", resultType: "result", ...EMPTY, ...o };
  for (const k of Object.keys(EMPTY)) c[k] = Number(c[k]) || 0;
  return c;
}

const div = (a, b) => (b > 0 ? a / b : null);
const r4 = (n) => (n == null ? null : Math.round(n * 10000) / 10000);

/// The KPIs of a cell: rates as fractions (0.31), costs in USD, null where there is nothing to divide by.
export function kpis(c) {
  const spend = c.spendUsd;
  return {
    cpm: r4(div(spend * 1000, c.impressions)),
    ctr: r4(div(c.clicks, c.impressions)),
    cpc: r4(div(spend, c.clicks)),
    hookRate: r4(div(c.views3s, c.impressions)),
    holdRate: r4(div(c.views15s, c.views3s)),
    cpv3: r4(div(spend, c.views3s)),
    cpr: r4(div(spend, c.results)),
    cpVisit: r4(div(spend, c.visits)),
    cpOrder: r4(div(spend, c.orders)),
    frequency: r4(div(c.impressions, c.reach)),
    dailySpend: r4(div(spend, Math.max(1, c.days))),
  };
}

/// Totals of many cells, one row.
export function sum(cells, { platform = "all", name = "total" } = {}) {
  const t = cell({ platform, id: "sum", name, level: "total", days: Math.max(1, ...cells.map((c) => c.days)) });
  for (const c of cells) for (const k of Object.keys(EMPTY)) t[k] += c[k];
  return t;
}

export const money = (n) => (n == null ? "n/a" : `$${Number.isInteger(Number(n)) ? Number(n).toFixed(0) : Number(n).toFixed(2)}`);
export const pct = (f) => (f == null ? "n/a" : `${Math.round(f * 100)}%`);
