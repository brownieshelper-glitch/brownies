// The rules of playbook section 5 as functions: what to do with a cell this morning (kill, hold, retire, scale,
// keep), how the week is pacing against the owner's cap, and what a scale step is. Pure: numbers in, a decision
// and its reason out, nothing sent anywhere. Butterscotch applies kills itself and puts scales to the owner.
import { KPI } from "./playbook.mjs";
import { kpis } from "./metrics.mjs";

/// { action: "kill" | "hold" | "retire" | "scale" | "keep" | "wait", why }.
/// targetUsd: the target cost per result for the cell's lane; bestCtr: the cell's best CTR so far (fatigue).
export function judge(c, { targetUsd, bestCtr = null, now = Date.now(), lastScaledAt = 0 } = {}) {
  const k = kpis(c);
  const spend = c.spendUsd, results = c.results;
  if (c.status !== "active") return { action: "wait", why: "not running" };
  if (!(targetUsd > 0)) return { action: "keep", why: "no target cost set for this lane; nothing to judge against" };
  if (spend < targetUsd) return { action: "wait", why: `too early: ${spend.toFixed(2)} spent of a ${targetUsd.toFixed(2)} target` };
  if (spend >= KPI.killAtTimesTarget * targetUsd && results === 0) return { action: "kill", why: `${KPI.killAtTimesTarget} times the target cost (${(KPI.killAtTimesTarget * targetUsd).toFixed(2)}) spent with no result` };
  if (spend >= KPI.holdAtTimesTarget * targetUsd && results <= 1 && c.days < KPI.holdDays) return { action: "hold", why: `${KPI.holdAtTimesTarget} times the target spent with ${results} result${results === 1 ? "" : "s"}: hold ${KPI.holdDays - c.days} more day${KPI.holdDays - c.days === 1 ? "" : "s"}` };
  if (spend >= KPI.holdAtTimesTarget * targetUsd && results <= 1 && c.days >= KPI.holdDays) return { action: "kill", why: `${c.days} days and ${results} result${results === 1 ? "" : "s"} for ${spend.toFixed(2)}` };
  const hookMin = KPI.hookRate[c.placement] ?? KPI.hookRate.feed;
  if (c.impressions >= 2000 && k.hookRate != null && k.hookRate < hookMin * 0.7 && (k.cpr == null || k.cpr > targetUsd)) return { action: "retire", why: `the hook rate is ${Math.round(k.hookRate * 100)}% against ${Math.round(hookMin * 100)}% for ${c.placement}: a creative problem, not a buying problem` };
  if (c.impressions >= 5000 && k.frequency != null && k.frequency > KPI.fatigueFrequency) return { action: "retire", why: `frequency ${k.frequency.toFixed(1)} in the window: the same people see it again and again` };
  if (c.impressions >= 5000 && bestCtr && k.ctr != null && k.ctr < bestCtr * (1 - KPI.fatigueCtrDrop)) return { action: "retire", why: `CTR fell to ${(k.ctr * 100).toFixed(2)}% from a best of ${(bestCtr * 100).toFixed(2)}%: fatigue` };
  if (results >= 3 && k.cpr != null && k.cpr <= targetUsd && c.days >= KPI.scaleEveryDays && now - lastScaledAt >= KPI.scaleEveryDays * 86_400_000) return { action: "scale", why: `${results} results at ${k.cpr.toFixed(2)} each, under the ${targetUsd.toFixed(2)} target, ${c.days} days in` };
  if (results >= 1 && k.cpr != null && k.cpr <= targetUsd * 1.5) return { action: "keep", why: `${results} result${results === 1 ? "" : "s"} at ${k.cpr.toFixed(2)} each` };
  return { action: "keep", why: `${results} result${results === 1 ? "" : "s"} for ${spend.toFixed(2)}; nothing to act on yet` };
}

/// The next daily budget of a cell that earned a scale: +20%, never past what the weekly cap leaves.
export function scaleBudget(dailyUsd, { weekCapUsd, weekSpentUsd, daysLeft = 1, otherDailyUsd = 0 }) {
  const wanted = Math.round(dailyUsd * (1 + KPI.scaleStepPct / 100) * 100) / 100;
  const room = Math.max(0, (weekCapUsd - weekSpentUsd) / Math.max(1, daysLeft) - otherDailyUsd);
  return Math.max(0, Math.min(wanted, Math.round(room * 100) / 100));
}

/// How the week is going against the cap: { status: "ok" | "over" | "under", ratio, expectedUsd, line }.
/// elapsedFraction: how much of the week has passed (0..1); underDays: days in a row under pace so far.
export function pace({ weekCapUsd, weekSpentUsd, elapsedFraction, underDays = 0 }) {
  if (!(weekCapUsd > 0)) return { status: "ok", ratio: null, expectedUsd: 0, line: "no weekly cap set" };
  const expected = weekCapUsd * Math.min(1, Math.max(0, elapsedFraction));
  const ratio = expected > 0 ? weekSpentUsd / expected : null;
  if (weekSpentUsd >= weekCapUsd) return { status: "over", ratio, expectedUsd: expected, line: `the week's cap of ${weekCapUsd.toFixed(2)} is spent (${weekSpentUsd.toFixed(2)})` };
  if (ratio != null && ratio > 1 + KPI.overPacePct / 100) return { status: "over", ratio, expectedUsd: expected, line: `over pace: ${weekSpentUsd.toFixed(2)} spent where ${expected.toFixed(2)} was the pace` };
  if (ratio != null && ratio < 1 - KPI.underPacePct / 100 && underDays >= KPI.underPaceDays) return { status: "under", ratio, expectedUsd: expected, line: `under pace for ${underDays} days: ${weekSpentUsd.toFixed(2)} spent where ${expected.toFixed(2)} was the pace; not chasing` };
  return { status: "ok", ratio, expectedUsd: expected, line: `on pace: ${weekSpentUsd.toFixed(2)} of ${weekCapUsd.toFixed(2)} this week` };
}
