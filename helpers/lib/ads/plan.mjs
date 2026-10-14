// A campaign plan from the playbook: a lane, the platforms, the owner's weekly cap; out come the cells with
// their daily budgets (the platforms' minimums respected, a test share kept), the creative brief with UTMs, the
// kill and scale rules written down before the first dollar, and the checks. Pure; Butterscotch adds the words.
import { LANES, PLATFORMS, KPI } from "./playbook.mjs";
import { money } from "./metrics.mjs";
export { money };

const r2 = (n) => Math.round(n * 100) / 100;

/// A link with our UTM convention (section 4). content = the creative's id, like "ep12-h2".
export function utmLink(base, { source, campaign, content }) {
  const u = new URL(base);
  u.searchParams.set("utm_source", source); u.searchParams.set("utm_medium", "paid"); u.searchParams.set("utm_campaign", campaign);
  if (content) u.searchParams.set("utm_content", content);
  return u.toString();
}

/// The concepts a lane starts with: six per lane, each with three hooks (section 3).
export const CONCEPTS = {
  stories: [
    { id: "ep-cut", concept: "A 20-second cut of the newest episode with a new opening", hooks: ["mid-action: the brownies already in trouble", "direct address: 'four brownies run a kitchen all day'", "bold claim: 'the only cartoon that never sleeps'"] },
    { id: "cam-moment", concept: "A real moment from the kitchen cam, captioned, 15 seconds", hooks: ["the clock and 'this is live right now'", "a report landing and a brownie walking to the board", "the oven opening"] },
    { id: "meet-fudge", concept: "Meet Fudge: 15 seconds of the megaphone", hooks: ["Fudge shouting the first line", "'he writes every post himself'", "a shout that scares the others"] },
    { id: "meet-crumb", concept: "Meet Crumb: answers everyone, drops everything", hooks: ["a sugar cube falling", "'he answers at 3 in the morning'", "the headset going on"] },
    { id: "nib-measures", concept: "Nib measures a thing twice, 15 seconds", hooks: ["the magnifier first", "'he reads the numbers so you do not have to'", "a tower leaning"] },
    { id: "chip-brick", concept: "Chip and one brick, 15 seconds, the tower growing", hooks: ["a brick dropped", "'one brick per job, 64 so far'", "the tower from the floor up"] },
  ],
  // the services lane in the owner's words: agents that run their socials and their jobs alone, and what you can order from them
  services: [
    { id: "socials-alone", concept: "The brownies run their own socials, nobody typing: one day of posts leaving the kitchen", hooks: ["'nobody typed this post'", "a post leaving at 3 in the morning", "the week's posts stacking up on the wall"] },
    { id: "jobs-day", concept: "All the jobs they do in a day, write, post, answer, measure, build, cut a clip, on one board", hooks: ["the board filling from empty", "'they clock in at midnight'", "a brownie carrying a finished job to the wall"] },
    { id: "clip-demo", concept: "Your idea to a cartoon clip in 15 minutes: the request on screen, then the clip", hooks: ["the finished clip first, then rewind", "'nine dollars, fifteen minutes, your idea'", "a timer starting"] },
    { id: "meme-demo", concept: "A meme made from one sentence", hooks: ["the sentence typed", "the meme appearing", "'50 cents, no account'"] },
    { id: "note-demo", concept: "A research note written on request, the first lines shown", hooks: ["a question asked", "the note scrolling", "'one dollar, one page'"] },
    { id: "agent-api", concept: "For agents: one HTTP call, pay per request, no key, no sign-up", hooks: ["a terminal with the curl line", "'your agent can order this on its own'", "the order arriving while nobody watches"] },
  ],
};

/// The plan. creatives: how many per lane to cut at launch (6 by default). targetUsd: the target cost per result.
export function buildPlan({ lane, platforms = PLATFORMS, weeklyUsd, siteUrl = "https://feedthebrownies.com", targetUsd = null, creatives = 6 } = {}) {
  const L = LANES[lane];
  if (!L) throw new Error(`no lane called "${lane}"; stories or services`);
  const weekly = Number(weeklyUsd);
  if (!(weekly > 0)) throw new Error("a weekly budget in dollars is needed");
  const chosen = platforms.filter((p) => PLATFORMS.includes(p));
  if (!chosen.length) throw new Error("no platform chosen");
  const daily = weekly / 7;
  const notes = [];
  // the share per platform: equal to start; while a platform's share is under its floor, the dearest floor goes first
  let active = [...chosen];
  const floor = { meta: KPI.minimums.meta.adsetDailyUsd * 2, tiktok: KPI.minimums.tiktok.campaignDailyUsd, x: KPI.minimums.x.campaignDailyUsd };
  let perPlatform = daily / active.length;
  for (;;) {
    const short = active.filter((p) => perPlatform < floor[p]).sort((a, b) => floor[b] - floor[a]);
    if (!short.length) break;
    const p = short[0];
    notes.push(`${p} left out: ${money(perPlatform)} a day is under its floor of ${money(floor[p])} (raise the weekly cap or pick fewer platforms)`);
    active = active.filter((x) => x !== p);
    perPlatform = active.length ? daily / active.length : 0;
    if (!active.length) break;
  }
  const testShare = KPI.testSharePct / 100;
  const cells = [];
  for (const p of active) {
    const main = r2(perPlatform * (1 - testShare)), test = r2(perPlatform * testShare);
    const objective = L.objective[p];
    if (p === "tiktok") cells.push({ platform: p, id: `${lane}-tiktok-smartplus`, kind: "main", dailyUsd: r2(perPlatform), objective, setup: "Smart+, at least six creatives and 2 to 5 headlines, the best organic posts as Spark Ads; judge nothing before 7 days", targeting: "broad, 18+, the open markets (US, Canada, UK)" });
    else {
      cells.push({ platform: p, id: `${lane}-${p}-main`, kind: "main", dailyUsd: main, objective, setup: p === "meta" ? "one campaign, Advantage+ campaign budget on, broad ad set, Reels and Stories first" : "promoted video, the account's own posts, interests animation / AI / startups", targeting: "broad, 18+" });
      cells.push({ platform: p, id: `${lane}-${p}-test`, kind: "test", dailyUsd: test, objective, setup: p === "meta" ? "one concept per ad set, Feed as the control placement" : "one concept per campaign, a second interest set as the control", targeting: p === "meta" ? "interest: cartoons and animation (the control)" : "lookalikes of our followers" });
    }
  }
  const brief = CONCEPTS[lane].slice(0, creatives).map((c) => ({ ...c, lane, length: "15 to 30 s, 9:16, captions burnt in, the brownies in the first second, one end card", landing: `${siteUrl.replace(/\/$/, "")}${L.landing}`, links: Object.fromEntries(active.map((p) => [p, utmLink(`${siteUrl.replace(/\/$/, "")}${L.landing}`, { source: p, campaign: lane, content: `${c.id}-h1` })])) }));
  const target = targetUsd ?? (lane === "stories" ? 0.05 : 12); // a 3-second view, a shop order
  return {
    lane, title: L.title, what: L.what, ask: L.ask, weeklyUsd: r2(weekly), dailyUsd: r2(daily), platforms: active, cells, notes,
    creatives: brief,
    rules: {
      targetUsd: target, resultType: lane === "stories" ? "3-second view" : "shop order",
      kill: `a creative dies at ${KPI.killAtTimesTarget} times the target cost (${money(target * KPI.killAtTimesTarget)}) with no result; holds 48 to 72 hours at ${KPI.holdAtTimesTarget} times with one`,
      scale: `a winner's daily budget rises ${KPI.scaleStepPct}% every ${KPI.scaleEveryDays} to 3 days, each rise a card for the owner, never past the weekly cap`,
      pace: `spend is checked against the cap every six hours; over pace by ${KPI.overPacePct}% pauses the worst cell first`,
      refresh: "3 to 5 new cuts a week on TikTok, a weekly refresh on Meta, one new promoted video a week on X",
      report: "09:15 CET every morning: spend, results, cost per result, hook and hold rates, winners, losers, the actions",
    },
    checks: ["every creative and caption passes the word list of section 1", "the landing page passes /butterscotch landing: no coin word anywhere on it", "every link carries the UTMs", "the weekly cap is set inside each ad account too", "the account is 18+ only"],
  };
}

/// The plan as plain text for Telegram and the control room.
export function planText(p) {
  const lines = [`PLAN: ${p.title} (${p.lane}). ${p.what}. The ask: ${p.ask}.`, `Budget: ${money(p.weeklyUsd)} a week, ${money(p.dailyUsd)} a day, on ${p.platforms.join(", ") || "no platform"}.`];
  for (const n of p.notes) lines.push(`Note: ${n}.`);
  lines.push("", "CELLS:");
  for (const c of p.cells) lines.push(`- ${c.id} (${c.kind}): ${money(c.dailyUsd)} a day, objective ${c.objective}. ${c.setup}. Targeting: ${c.targeting}.`);
  lines.push("", `CREATIVES TO CUT (${p.creatives.length}):`);
  for (const c of p.creatives) lines.push(`- ${c.id}: ${c.concept}. Hooks: ${c.hooks.map((h, i) => `h${i + 1} ${h}`).join("; ")}. ${c.length}. Lands on ${c.landing}.`);
  lines.push("", "RULES, WRITTEN BEFORE THE FIRST DOLLAR:", `- target: ${money(p.rules.targetUsd)} per ${p.rules.resultType}`, `- kill: ${p.rules.kill}`, `- scale: ${p.rules.scale}`, `- pace: ${p.rules.pace}`, `- refresh: ${p.rules.refresh}`, `- report: ${p.rules.report}`);
  lines.push("", "CHECKS BEFORE LAUNCH:", ...p.checks.map((c) => `- ${c}`));
  return lines.join("\n");
}
