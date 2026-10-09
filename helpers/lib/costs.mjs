// The bill: what every brownie spent on AI and on video, today and before, with its caps. Read by the control
// room (the "The bill" section), the owner's /bill on Telegram and the daily summary. Numbers come from the
// store only: the spend table is the AI cap counter (authoritative for "spent today"), the ledger has one line
// per paid call with model, tokens, job, seconds and price; the OpenRouter balance is what the brain read last.
import { cap } from "./facts.mjs";

export const DAYS = 14; // the history the room shows
const usd = (micro) => Math.round(Number(micro || 0)) / 1e6;
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/// The day keys of the last n days ending today, oldest first. Anchored at local noon so a clock change skips nothing.
export function dayKeys(store, now, n) {
  const noon = store.dayStart(now) + 12 * 3_600_000;
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(store.dayKey(noon - i * 86_400_000));
  return out;
}

/// Groups ledger lines by a key into [{ key, usd, calls, tokensIn, tokensOut }] sorted by usd, biggest first.
function grouped(rows, keyOf) {
  const by = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    const g = by.get(k) || { key: k, micro: 0, calls: 0, tokensIn: 0, tokensOut: 0 };
    g.micro += r.micro; g.calls += r.n; g.tokensIn += r.tokensIn || 0; g.tokensOut += r.tokensOut || 0;
    by.set(k, g);
  }
  return [...by.values()].sort((a, b) => b.micro - a.micro).map((g) => ({ key: g.key, usd: usd(g.micro), calls: g.calls, tokensIn: g.tokensIn, tokensOut: g.tokensOut }));
}

const jobLabel = (helper, job) => (job ? String(job).replace(new RegExp(`^${helper}-`), "") : "other");

/// The whole bill. helpers: the names on the roster; caps / videoCaps: { name: usd }; models: { name: model id };
/// openrouter: the brain's balance reading or null; refill: { usd, at } the owner set after a Higgsfield top-up.
export function costsView({ store, now, helpers = [], caps = {}, videoCaps = {}, videoMakers = [], hidden = [], paused = [], models = {}, openrouter = null, refill = null, timezone = "UTC", days = DAYS }) {
  const day = store.dayKey(now);
  const keys = dayKeys(store, now, days);
  const monthFirst = `${day.slice(0, 7)}-01`;
  const lines = store.ledgerDay(day);
  const detail = store.ledgerModels(day);
  const names = [...helpers];
  for (const l of lines) if (!names.includes(l.helper)) names.push(l.helper); // a brownie that is gone but spent today still shows

  const perHelper = names.map((name) => {
    const ai = lines.find((l) => l.helper === name && l.kind === "ai") || { n: 0, micro: 0, tokensIn: 0, tokensOut: 0, tokensThink: 0, maxMicro: 0 };
    const video = lines.find((l) => l.helper === name && l.kind === "video") || { n: 0, micro: 0, seconds: 0, maxMicro: 0, guessed: 0 };
    const spent = store.spentToday(name, now);
    const capUsd = Number(caps[name] ?? 0) || 0;
    const capMicro = Math.round(capUsd * 1e6);
    const aiUsd = usd(spent.micro);
    const videoUsd = usd(video.micro);
    const videoCapUsd = Number(videoCaps[name]) > 0 ? Number(videoCaps[name]) : null;
    const videoCapMicro = videoCapUsd ? Math.round(videoCapUsd * 1e6) : 0;
    // whole micro-dollars, so 0.04 of 0.05 is "near" without a float saying 0.0400000001
    const against = (micro, limit) => (limit > 0 && micro >= limit ? "capped" : limit > 0 && micro * 5 >= limit * 4 ? "near" : "ok");
    const pct = (micro, limit) => (limit > 0 ? Math.min(100, Math.round((100 * micro) / limit)) : 0);
    const mine = detail.filter((d) => d.helper === name && d.kind === "ai");
    return {
      name, title: cap(name), gone: !helpers.includes(name), hidden: hidden.includes(name), paused: paused.includes(name), model: models[name] || null,
      capUsd, aiUsd, calls: spent.calls, pct: pct(spent.micro, capMicro), leftUsd: Math.max(0, round2(capUsd - aiUsd)), state: against(spent.micro, capMicro),
      tokensIn: ai.tokensIn, tokensOut: ai.tokensOut, tokensThink: ai.tokensThink, avgUsd: spent.calls ? aiUsd / spent.calls : 0, biggestUsd: usd(ai.maxMicro),
      makesVideo: videoMakers.includes(name) || video.n > 0 || Boolean(videoCapUsd),
      videoUsd, videos: video.n, seconds: Math.round(video.seconds), videoCapUsd, videoPct: pct(video.micro, videoCapMicro), videoState: against(video.micro, videoCapMicro), videoGuessed: video.guessed,
      totalUsd: aiUsd + videoUsd,
      models: grouped(mine, (d) => d.model || "unknown").map((g) => ({ model: g.key, usd: g.usd, calls: g.calls })),
      jobs: grouped(mine, (d) => jobLabel(name, d.job)).map((g) => ({ job: g.key, usd: g.usd, calls: g.calls })),
    };
  });

  const sum = (k) => perHelper.reduce((a, h) => a + (h[k] || 0), 0);
  const today = { usd: sum("totalUsd"), aiUsd: sum("aiUsd"), videoUsd: sum("videoUsd"), calls: sum("calls"), videos: sum("videos"), seconds: sum("seconds"), tokensIn: sum("tokensIn"), tokensOut: sum("tokensOut"), tokensThink: sum("tokensThink"), capUsd: perHelper.filter((h) => !h.gone).reduce((a, h) => a + h.capUsd, 0), videoGuessed: sum("videoGuessed") };

  // the days: AI from the spend table, video from the ledger
  const aiDays = store.spendDays(keys[0] < monthFirst ? keys[0] : monthFirst);
  const ledgerDays = store.ledgerDays(keys[0] < monthFirst ? keys[0] : monthFirst);
  const dayRow = (k) => {
    const ai = aiDays.filter((r) => r.day === k);
    const v = ledgerDays.find((r) => r.day === k && r.kind === "video");
    return { day: k, aiUsd: usd(ai.reduce((a, r) => a + r.micro, 0)), calls: ai.reduce((a, r) => a + r.calls, 0), videoUsd: usd(v?.micro), videos: v?.n || 0 };
  };
  const history = keys.map(dayRow).map((r) => ({ ...r, usd: r.aiUsd + r.videoUsd }));
  const monthDays = [...new Set([...aiDays.map((r) => r.day), ...ledgerDays.map((r) => r.day)])].filter((k) => k >= monthFirst && k <= day).map(dayRow);
  const month = { since: monthFirst, aiUsd: monthDays.reduce((a, r) => a + r.aiUsd, 0), videoUsd: monthDays.reduce((a, r) => a + r.videoUsd, 0), calls: monthDays.reduce((a, r) => a + r.calls, 0), videos: monthDays.reduce((a, r) => a + r.videos, 0) };
  month.usd = month.aiUsd + month.videoUsd;

  // Higgsfield has no balance endpoint: the owner tells us the balance after a top-up and we count the clips since
  let higgsfield = null;
  if (refill && Number(refill.usd) > 0) {
    const since = store.ledgerSince(Number(refill.at) || 0).find((r) => r.kind === "video");
    const spentUsd = usd(since?.micro);
    higgsfield = { refillUsd: Number(refill.usd), refillAt: Number(refill.at) || null, spentUsd, leftUsd: Math.max(0, round2(Number(refill.usd) - spentUsd)), clips: since?.n || 0 };
  }

  const line = (r) => ({ id: r.id, at: r.at, helper: r.helper, title: cap(r.helper), kind: r.kind, model: r.model, job: jobLabel(r.helper, r.job), usd: usd(r.micro), tokensIn: r.tokensIn, tokensOut: r.tokensOut, tokensThink: r.tokensThink, seconds: r.seconds, guessed: r.guessed, ms: r.ms, note: r.note });
  return {
    day, timezone,
    today, month, history,
    helpers: perHelper,
    models: grouped(detail.filter((d) => d.kind === "ai"), (d) => d.model || "unknown").map((g) => ({ model: g.key, usd: g.usd, calls: g.calls, tokensIn: g.tokensIn, tokensOut: g.tokensOut })),
    recent: store.ledgerRecent(30).map(line),
    biggest: store.ledgerBiggest(day, 5).map(line),
    openrouter, higgsfield,
  };
}

const money = (n) => `$${Number(n || 0).toFixed(2)}`;

/// The bill as plain text for Telegram (/bill).
export function billText(v) {
  const out = [`The bill, ${v.day} (${v.timezone}).`, `Today: ${money(v.today.usd)} in all. AI ${money(v.today.aiUsd)} in ${v.today.calls} call${v.today.calls === 1 ? "" : "s"}, video ${money(v.today.videoUsd)} in ${v.today.videos} clip${v.today.videos === 1 ? "" : "s"}.`];
  if (v.openrouter) out.push(`OpenRouter: ${money(v.openrouter.leftUsd)} left of ${money(v.openrouter.boughtUsd)} bought.`);
  out.push(v.higgsfield ? `Higgsfield: about ${money(v.higgsfield.leftUsd)} left of the ${money(v.higgsfield.refillUsd)} you set (${v.higgsfield.clips} clip${v.higgsfield.clips === 1 ? "" : "s"} since).` : "Higgsfield: no balance set. After a top-up: /refill <usd>.");
  out.push("");
  for (const h of v.helpers) {
    const flag = h.state === "capped" ? ", CAPPED" : h.state === "near" ? ", near the cap" : "";
    const video = h.videos || h.videoCapUsd ? ` + video ${money(h.videoUsd)}${h.videoCapUsd ? ` of ${money(h.videoCapUsd)}` : ""} (${h.videos} clip${h.videos === 1 ? "" : "s"})` : "";
    out.push(`${h.title}${h.hidden ? " (hidden)" : ""}${h.gone ? " (gone)" : ""}: ${money(h.aiUsd)}${h.capUsd ? ` of ${money(h.capUsd)}` : ""} (${h.calls} call${h.calls === 1 ? "" : "s"})${flag}${video}`);
  }
  out.push("", `This month: ${money(v.month.usd)} (AI ${money(v.month.aiUsd)}, video ${money(v.month.videoUsd)}).`);
  return out.join("\n");
}
