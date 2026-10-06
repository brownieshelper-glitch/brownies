// The owner's daily summary on Telegram: what each brownie did today, what it spent and has left, what waits for
// a decision, and what went wrong. One message a day, plain text, numbers from the store only (no model call).
import { cap } from "./facts.mjs";

const usd = (micro) => `$${(Number(micro || 0) / 1e6).toFixed(2)}`;

/// The text of the summary for the day that contains `now`. `helpers` is the list of names to report on;
/// hidden helpers are listed too (the owner sees everything), with their name only known to the owner.
export function buildSummary({ store, now, helpers, caps = {}, mode = "prelaunch", hidden = [], pendingApprovals = [], failures = [] }) {
  const day = store.dayKey(now);
  const since = store.dayStart(now);
  const lines = [`Brownies, ${day}. MODE=${mode}.`, ""];
  let totalMicro = 0, totalJobs = 0;
  for (const h of helpers) {
    const jobs = store.jobsSince(h, since);
    const done = jobs.filter((j) => j.ok && j.job !== "status");
    const byKind = {};
    for (const j of done) byKind[j.job] = (byKind[j.job] || 0) + 1;
    const spent = store.spentToday(h, now);
    totalMicro += spent.micro; totalJobs += done.length;
    const kinds = Object.entries(byKind).map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`).join(", ");
    const capMicro = Math.round((caps[h] ?? 0) * 1e6);
    const budget = capMicro ? `${usd(spent.micro)} of ${usd(capMicro)}` : usd(spent.micro);
    const last = done.at(-1);
    lines.push(`${cap(h)}${hidden.includes(h) ? " (hidden)" : ""}: ${done.length ? kinds : "nothing yet"}. Spent ${budget}.${last?.note ? ` Last: ${String(last.note).slice(0, 90)}` : ""}`);
  }
  lines.push("", `${totalJobs} job${totalJobs === 1 ? "" : "s"} in all, ${usd(totalMicro)} of AI.`);
  if (pendingApprovals.length) {
    lines.push("", `Waiting for you (${pendingApprovals.length}):`);
    for (const a of pendingApprovals.slice(0, 5)) lines.push(`- ${String(a.title).slice(0, 100)}${a.url ? `\n  ${a.url}` : ""}`);
  }
  if (failures.length) {
    lines.push("", `Failed today (${failures.length}):`);
    for (const f of failures.slice(0, 5)) lines.push(`- ${cap(f.helper)} ${f.job}: ${String(f.note || "").slice(0, 100)}`);
  }
  if (!pendingApprovals.length && !failures.length) lines.push("Nothing waits for you.");
  return lines.join("\n");
}

/// Sends today's summary to the owner. Returns the text, or null when Telegram is not configured.
export async function sendSummary({ store, clock, telegram, ownerChatId, helpers, caps, mode, hidden, log = () => {} }) {
  const now = clock.now();
  const since = store.dayStart(now);
  const failures = helpers.flatMap((h) => store.jobsSince(h, since).filter((j) => !j.ok));
  const text = buildSummary({ store, now, helpers, caps, mode, hidden, pendingApprovals: store.pendingApprovals(), failures });
  store.jobDone({ at: now, helper: "team", job: "summary", ok: true, note: `daily summary ${store.dayKey(now)}` });
  if (!telegram?.configured || !ownerChatId) { log("[summary] Telegram is not configured, the summary stays in the log:\n" + text); return null; }
  await telegram.sendMessage(ownerChatId, text);
  log(`[summary] sent for ${store.dayKey(now)}`);
  return text;
}
