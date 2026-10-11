// Butterscotch's tools: the playbook is read with the learned notes, ad copy is checked against the word list,
// the KPIs come out of the counts, the morning rules decide (kill, hold, retire, scale, keep), the pace holds
// the cap, a plan splits a weekly budget by the platforms' floors with a creative brief and UTMs, the three
// connectors send the requests the platforms document and read their answers into one shape, and OAuth 1.0a
// signs the way X checks it.
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../lib/store.mjs";
import { playbookText, addLearned, learnedNotes, adProblems, landingProblems, rulesFor, section, KPI, LANES } from "../lib/ads/playbook.mjs";
import { cell, kpis, sum, money, pct } from "../lib/ads/metrics.mjs";
import { judge, scaleBudget, pace } from "../lib/ads/decide.mjs";
import { buildPlan, planText, utmLink, CONCEPTS } from "../lib/ads/plan.mjs";
import { MetaAds, TikTokAds, XAds, missing } from "../lib/ads/connectors.mjs";
import { oauth1Header } from "../lib/ads/oauth1.mjs";

test("the playbook: read whole, the learned notes appended, sections and rules by platform, the word list", () => {
  const store = new Store(":memory:");
  const text = playbookText(store);
  assert.match(text, /^# Butterscotch's playbook/); assert.match(text, /## 1\. What we advertise/); assert.match(text, /## Learned\s*$/);
  assert.match(section(2), /^## 2\. The platforms/); assert.match(section(2), /\| Meta/);
  assert.equal(section(99), "");
  assert.match(rulesFor("tiktok"), /^TikTok\. Allowed for us: Entertainment and software ads\. Not allowed: Crypto is "restricted"/);
  assert.match(rulesFor("x"), /^X\. Allowed/); assert.match(rulesFor("meta"), /Memecoin promotion is effectively unavailable/);
  addLearned(store, { at: Date.parse("2026-10-18T10:00:00Z"), text: "Reels now favours 9:16 under 20 seconds.", source: "example.com" });
  assert.equal(learnedNotes(store).length, 1);
  assert.match(playbookText(store), /## Learned\n\n- 2026-10-18: Reels now favours 9:16 under 20 seconds\. \(example\.com\)\n$/);
  assert.deepEqual(adProblems("Four brownies run a kitchen all day. Watch the newest episode."), []);
  assert.match(adProblems("Buy BROWNIE now")[0], /"Buy"/);
  assert.match(adProblems("stake and earn yield")[0], /"stake"/);
  assert.match(adProblems("the $BROWNIE token")[0], /\$BROWNIE/);
  assert.match(adProblems("see https://feedthebrownies.com/shop.html")[0], /without the UTM/);
  assert.deepEqual(adProblems("see https://feedthebrownies.com/shop.html?utm_source=meta&utm_medium=paid&utm_campaign=services"), []);
  assert.match(adProblems("café")[0], /plain ASCII/);
  assert.deepEqual(Object.keys(LANES), ["stories", "services"]); assert.equal(KPI.scaleStepPct, 20);
  // no reference to crypto at all (the owner, 2026-10-11): the crypto words themselves, and the names in capitals
  assert.match(adProblems("the first crypto cartoon")[0], /"crypto"/); assert.match(adProblems("our token is live")[0], /"token"/);
  assert.match(adProblems("pay in USDC on Base")[0], /"USDC"/); assert.match(adProblems("built on Ethereum")[0], /"Ethereum"/); assert.match(adProblems("a 2% tax to holders")[0], /"tax"/);
  assert.match(adProblems("one SUGAR, one dollar of AI")[0], /"SUGAR"/); assert.match(adProblems("BROWNIE is here")[0], /"BROWNIE"/);
  assert.deepEqual(adProblems("a sugar cube falls in the jar; four brownies cheer"), [], "the cartoon's sugar and brownies are fine");
  assert.deepEqual(adProblems("Nine dollars, fifteen minutes, your idea as a cartoon. Order one."), []);
  // every concept, hook and lane description of the plan passes its own list
  for (const lane of Object.keys(CONCEPTS)) {
    assert.deepEqual(adProblems(LANES[lane].what), [], `${lane} what`); assert.deepEqual(adProblems(LANES[lane].ask), [], `${lane} ask`);
    for (const c of CONCEPTS[lane]) { assert.deepEqual(adProblems(c.concept), [], `${c.id} concept`); for (const h of c.hooks) assert.deepEqual(adProblems(h), [], `${c.id} hook: ${h}`); }
  }
  // a landing page: the words anywhere on it, and those in the first screen
  const page = "<html><head><title>The room</title><style>.x{color:red}</style><script>var tax = 1;</script></head><body><nav>Kitchen Room Docs</nav><h1>The room</h1><p>Four brownies at work. Click a jar for a sugar cube.</p>" + "<p>filler line</p>".repeat(120) + "<ul><li>2% tax on every buy and every sell</li><li>35% to stakers, paid as SUGAR</li></ul><footer><a>Contracts</a></footer></body></html>";
  const lp = landingProblems(page);
  assert.deepEqual([...lp.words].sort(), ["SUGAR", "buy", "contracts", "stakers", "tax"]); assert.deepEqual(lp.firstScreen, [], "the first screen is clean, the rest is not");
  assert.deepEqual(landingProblems("<h1>Four brownies, one kitchen.</h1><p>Watch them work.</p>").words, []);
  assert.deepEqual(landingProblems(page, { firstScreen: 100_000 }).firstScreen.length, 5);
});

test("the KPIs: rates and costs out of the counts, null where there is nothing to divide by, totals", () => {
  const c = cell({ platform: "meta", id: "1", name: "stories-meta-main", lane: "stories", spendUsd: 42, impressions: 20000, reach: 8000, clicks: 240, views3s: 6400, views15s: 1700, results: 6400, visits: 150, days: 3 });
  const k = kpis(c);
  assert.equal(k.cpm, 2.1); assert.equal(k.ctr, 0.012); assert.equal(k.cpc, 0.175); assert.equal(k.hookRate, 0.32); assert.equal(k.holdRate, 0.2656); assert.equal(k.cpv3, 0.0066); assert.equal(k.cpr, 0.0066); assert.equal(k.cpVisit, 0.28); assert.equal(k.frequency, 2.5); assert.equal(k.dailySpend, 14);
  const empty = kpis(cell());
  assert.equal(empty.cpm, null); assert.equal(empty.cpr, null);
  const t = sum([c, cell({ spendUsd: 8, impressions: 1000, results: 2, days: 5 })]);
  assert.equal(t.spendUsd, 50); assert.equal(t.impressions, 21000); assert.equal(t.results, 6402); assert.equal(t.days, 5);
  assert.equal(money(0.0066), "$0.01"); assert.equal(money(142), "$142"); assert.equal(money(null), "n/a"); assert.equal(pct(0.32), "32%"); assert.equal(pct(null), "n/a");
});

test("the morning rules: too early, kill, hold then kill, retire for the hook or fatigue, scale, keep; the pace; the scale step", () => {
  const T = 12, base = { lane: "services", placement: "reels", days: 2 };
  assert.equal(judge(cell({ ...base, spendUsd: 5 }), { targetUsd: T }).action, "wait");
  assert.equal(judge(cell({ ...base, spendUsd: 40, results: 0 }), { targetUsd: T }).action, "kill");
  assert.equal(judge(cell({ ...base, spendUsd: 25, results: 1 }), { targetUsd: T }).action, "hold");
  assert.equal(judge(cell({ ...base, spendUsd: 25, results: 1, days: 3 }), { targetUsd: T }).action, "kill");
  assert.match(judge(cell({ ...base, spendUsd: 30, results: 2, impressions: 5000, views3s: 500 }), { targetUsd: T }).why, /hook rate is 10% against 30% for reels/);
  assert.equal(judge(cell({ ...base, spendUsd: 30, results: 3, impressions: 8000, reach: 2000, views3s: 3000 }), { targetUsd: T }).action, "retire", "frequency 4");
  assert.match(judge(cell({ ...base, spendUsd: 30, results: 3, impressions: 8000, reach: 8000, clicks: 40, views3s: 3000 }), { targetUsd: T, bestCtr: 0.02 }).why, /CTR fell/);
  const good = cell({ ...base, spendUsd: 30, results: 4, impressions: 8000, reach: 8000, clicks: 160, views3s: 3000, days: 3 });
  assert.equal(judge(good, { targetUsd: T, now: 10 * 86_400_000, lastScaledAt: 0 }).action, "scale");
  assert.equal(judge(good, { targetUsd: T, now: 10 * 86_400_000, lastScaledAt: 9 * 86_400_000 }).action, "keep", "scaled yesterday: not again");
  assert.equal(judge(cell({ ...base, spendUsd: 30, results: 2 }), { targetUsd: T }).action, "keep");
  assert.equal(judge(cell({ ...base, status: "paused", spendUsd: 100 }), { targetUsd: T }).action, "wait");
  assert.equal(judge(cell({ ...base, spendUsd: 100 }), { targetUsd: 0 }).action, "keep");
  assert.equal(scaleBudget(10, { weekCapUsd: 200, weekSpentUsd: 60, daysLeft: 4, otherDailyUsd: 20 }), 12);
  assert.equal(scaleBudget(10, { weekCapUsd: 200, weekSpentUsd: 160, daysLeft: 2, otherDailyUsd: 15 }), 5, "the cap leaves only 5 a day");
  assert.equal(scaleBudget(10, { weekCapUsd: 200, weekSpentUsd: 200, daysLeft: 1 }), 0);
  assert.equal(pace({ weekCapUsd: 0, weekSpentUsd: 10, elapsedFraction: 0.5 }).status, "ok");
  assert.equal(pace({ weekCapUsd: 140, weekSpentUsd: 70, elapsedFraction: 0.5 }).status, "ok");
  assert.match(pace({ weekCapUsd: 140, weekSpentUsd: 90, elapsedFraction: 0.5 }).line, /^over pace: 90\.00 spent where 70\.00 was the pace/);
  assert.equal(pace({ weekCapUsd: 140, weekSpentUsd: 20, elapsedFraction: 0.5, underDays: 1 }).status, "ok", "one day under is not a word yet");
  assert.equal(pace({ weekCapUsd: 140, weekSpentUsd: 20, elapsedFraction: 0.5, underDays: 2 }).status, "under");
  assert.match(pace({ weekCapUsd: 140, weekSpentUsd: 140, elapsedFraction: 0.3 }).line, /cap of 140\.00 is spent/);
});

test("a plan: the weekly budget split with the floors, a platform too small left out and said, six creatives with UTMs, the rules and the checks", () => {
  const p = buildPlan({ lane: "stories", platforms: ["meta", "tiktok", "x"], weeklyUsd: 1050 });
  assert.equal(p.title, "The stories"); assert.equal(p.dailyUsd, 150); assert.deepEqual(p.platforms, ["meta", "tiktok", "x"]);
  const byId = Object.fromEntries(p.cells.map((c) => [c.id, c]));
  assert.equal(byId["stories-tiktok-smartplus"].dailyUsd, 50); assert.equal(byId["stories-meta-main"].dailyUsd, 35); assert.equal(byId["stories-meta-test"].dailyUsd, 15); assert.equal(byId["stories-x-main"].dailyUsd, 35);
  assert.ok(Math.abs(p.cells.reduce((a, c) => a + c.dailyUsd, 0) - 150) < 0.05, "the cells add up to the day");
  assert.equal(p.creatives.length, 6); assert.equal(p.creatives[0].id, "ep-cut"); assert.equal(p.creatives[0].hooks.length, 3);
  assert.equal(p.creatives[0].links.meta, "https://feedthebrownies.com/room.html?utm_source=meta&utm_medium=paid&utm_campaign=stories&utm_content=ep-cut-h1");
  assert.equal(p.rules.targetUsd, 0.05); assert.equal(p.rules.resultType, "3-second view"); assert.match(p.rules.kill, /3 times the target cost \(\$0\.15\)/);
  assert.equal(p.checks.length, 5);
  const small = buildPlan({ lane: "services", platforms: ["meta", "tiktok", "x"], weeklyUsd: 280, targetUsd: 15 });
  assert.deepEqual(small.platforms, ["meta", "x"], "TikTok's floor is 50 a day; 13 a day is under it, and the others fit once it is out");
  assert.match(small.notes[0], /^tiktok left out: \$13\.33 a day is under its floor of \$50/);
  assert.deepEqual(buildPlan({ lane: "services", platforms: ["meta", "tiktok", "x"], weeklyUsd: 140 }).platforms, ["x"], "at 20 a day only X fits");
  assert.equal(buildPlan({ lane: "stories", platforms: ["tiktok"], weeklyUsd: 70 }).platforms.length, 0, "too small for anything: an empty plan with the note");
  const t = buildPlan({ lane: "stories", platforms: ["meta", "tiktok", "x"], weeklyUsd: 700 });
  assert.deepEqual(t.platforms, ["meta", "x"], "100 a day over three is 33 each: TikTok's 50 floor drops it first");
  assert.equal(small.rules.targetUsd, 15); assert.equal(small.creatives[0].id, "socials-alone", "the services lane opens with the agents running their socials alone"); assert.match(small.creatives[0].landing, /\/shop\.html$/);
  assert.equal(p.checks[1], "the landing page passes /butterscotch landing: no coin word anywhere on it");
  assert.throws(() => buildPlan({ lane: "coin", weeklyUsd: 100 }), /no lane called "coin"/);
  assert.throws(() => buildPlan({ lane: "stories", weeklyUsd: 0 }), /weekly budget/);
  const text = planText(p);
  assert.match(text, /^PLAN: The stories \(stories\)\./); assert.match(text, /\$1050 a week, \$150 a day, on meta, tiktok, x/); assert.match(text, /- stories-tiktok-smartplus \(main\): \$50 a day, objective video views\. Smart\+/); assert.match(text, /CHECKS BEFORE LAUNCH:/);
  assert.match(planText(small), /^Note: tiktok left out: \$13\.33 a day/m);
  assert.equal(utmLink("https://a.b/c?x=1", { source: "x", campaign: "services", content: "note-demo-h2" }), "https://a.b/c?x=1&utm_source=x&utm_medium=paid&utm_campaign=services&utm_content=note-demo-h2");
});

test("the connectors: the requests the platforms document, their answers read into one shape, status and budget writes, what is missing", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body ? (init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : JSON.parse(init.body)) : null, headers: init.headers || {} });
    const u = String(url);
    if (u.includes("/act_123/campaigns")) return { ok: true, json: async () => ({ data: [{ id: "c1", name: "stories-meta-main", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "2333" }, { id: "c2", name: "services-meta-main", effective_status: "PAUSED", daily_budget: "1000" }] }) };
    if (u.includes("/act_123/insights")) return { ok: true, json: async () => ({ data: [{ campaign_id: "c1", campaign_name: "stories-meta-main", spend: "42.10", impressions: "20000", reach: "8000", clicks: "240", video_play_actions: [{ value: "6400" }], video_15_sec_watched_actions: [{ value: "1700" }], actions: [{ action_type: "landing_page_view", value: "90" }] }] }) };
    if (u.includes("graph.facebook.com") && init.method === "POST") return { ok: true, json: async () => ({ success: true }) };
    if (u.includes("campaign/get/")) return { ok: true, json: async () => ({ code: 0, data: { list: [{ campaign_id: "t1", campaign_name: "stories-tiktok-smartplus", operation_status: "ENABLE", budget: 33.33 }] } }) };
    if (u.includes("report/integrated/get/")) return { ok: true, json: async () => ({ code: 0, data: { list: [{ dimensions: { campaign_id: "t1" }, metrics: { campaign_name: "services-tiktok-smartplus", spend: "30", impressions: "9000", reach: "6000", clicks: "80", video_watched_2s: "2500", video_watched_6s: "700", conversion: "3" } }] } }) };
    if (u.includes("business-api.tiktok.com") && init.method === "POST") return { ok: true, json: async () => ({ code: 0, data: {} }) };
    if (u.includes("ads-api.x.com/12/accounts/acc9/campaigns") && (init.method || "GET") === "GET") return { ok: true, json: async () => ({ data: [{ id: "x1", name: "stories-x-main", entity_status: "ACTIVE", daily_budget_amount_local_micro: 23330000 }] }) };
    if (u.includes("ads-api.x.com/12/stats/accounts/acc9")) return { ok: true, json: async () => ({ data: [{ id: "x1", id_data: [{ metrics: { billed_charge_local_micro: [15000000], impressions: [5000], clicks: [60], url_clicks: [40], video_3s100pct_views: [1200], video_views_50: [300] } }] }] }) };
    if (u.includes("ads-api.x.com") && init.method === "PUT") return { ok: true, json: async () => ({ data: {} }) };
    return { ok: false, status: 404, json: async () => ({ error: { message: "no such route" } }) };
  };
  const since = Date.parse("2026-10-13T00:00:00Z"), until = Date.parse("2026-10-19T00:00:00Z");
  // Meta
  const meta = new MetaAds({ token: "tok", account: "123", fetch });
  assert.equal(meta.configured, true); assert.equal(meta.account, "act_123");
  const mc = await meta.campaigns();
  assert.deepEqual(mc, [{ id: "c1", name: "stories-meta-main", status: "active", dailyBudgetUsd: 23.33, lane: "stories" }, { id: "c2", name: "services-meta-main", status: "paused", dailyBudgetUsd: 10, lane: "services" }]);
  assert.match(calls[0].url, /graph\.facebook\.com\/v23\.0\/act_123\/campaigns\?fields=id%2Cname%2Cstatus%2Ceffective_status%2Cdaily_budget&limit=100&access_token=tok$/);
  const mi = await meta.insights({ since, until });
  assert.equal(mi.length, 1); assert.equal(mi[0].platform, "meta"); assert.equal(mi[0].spendUsd, 42.1); assert.equal(mi[0].views3s, 6400); assert.equal(mi[0].views15s, 1700); assert.equal(mi[0].results, 6400, "a stories campaign counts 3-second views"); assert.equal(mi[0].days, 7);
  assert.match(calls[1].url, /time_range=%7B%22since%22%3A%222026-10-13%22%2C%22until%22%3A%222026-10-19%22%7D/);
  await meta.setStatus("c1", "paused"); await meta.setBudget("c1", 28);
  assert.deepEqual(calls[2].body, { status: "PAUSED" }); assert.deepEqual(calls[3].body, { daily_budget: "2800" }); assert.match(calls[3].url, /\/v23\.0\/c1\?access_token=tok$/);
  // TikTok
  const tt = new TikTokAds({ token: "ttk", advertiser: "77", fetch });
  const tc = await tt.campaigns();
  assert.deepEqual(tc, [{ id: "t1", name: "stories-tiktok-smartplus", status: "active", dailyBudgetUsd: 33.33, lane: "stories" }]);
  assert.equal(calls[4].headers["Access-Token"], "ttk");
  const ti = await tt.insights({ since, until });
  assert.equal(ti[0].lane, "services"); assert.equal(ti[0].results, 3); assert.equal(ti[0].resultType, "conversion"); assert.equal(ti[0].views3s, 2500); assert.equal(ti[0].spendUsd, 30);
  assert.match(calls[5].url, /report%2Fintegrated%2Fget|report\/integrated\/get\//); assert.match(calls[5].url, /start_date=2026-10-13&end_date=2026-10-19/);
  await tt.setStatus("t1", "paused"); await tt.setBudget("t1", 40);
  assert.deepEqual(calls[6].body, { advertiser_id: "77", campaign_ids: ["t1"], operation_status: "DISABLE" }); assert.deepEqual(calls[7].body, { advertiser_id: "77", campaign_id: "t1", budget: 40 });
  // X, with a signer
  const x = new XAds({ consumerKey: "ck", consumerSecret: "cs", accessToken: "at", accessSecret: "as", account: "acc9", fetch, sign: async (method, url) => `OAuth signed ${method} ${new URL(url).pathname}` });
  assert.equal(x.configured, true);
  const xc = await x.campaigns();
  assert.deepEqual(xc, [{ id: "x1", name: "stories-x-main", status: "active", dailyBudgetUsd: 23.33, lane: "stories" }]);
  assert.equal(calls[8].headers.authorization, "OAuth signed GET /12/accounts/acc9/campaigns");
  const xi = await x.insights({ since, until });
  assert.equal(xi[0].spendUsd, 15); assert.equal(xi[0].views3s, 1200); assert.equal(xi[0].results, 1200); assert.equal(xi[0].clicks, 60);
  assert.match(calls[10].url, /entity=CAMPAIGN&entity_ids=x1&start_time=2026-10-13T00%3A00%3A00\.000Z/);
  await x.setStatus("x1", "active"); await x.setBudget("x1", 30);
  assert.deepEqual(calls[11].body, { entity_status: "ACTIVE" }); assert.deepEqual(calls[12].body, { daily_budget_amount_local_micro: "30000000" });
  // errors and the missing list
  await assert.rejects(() => new MetaAds({ token: "t", account: "9", fetch }).campaigns(), /Meta GET act_9\/campaigns: no such route/);
  assert.equal(new XAds({ consumerKey: "ck", consumerSecret: "cs", accessToken: "at", accessSecret: "as", account: "acc9" }).configured, false, "no signer, not configured");
  const miss = missing({ meta: { token: "t", account: "a" }, tiktok: {}, x: {} });
  assert.equal(miss.length, 2); assert.match(miss[0], /^TikTok:/); assert.match(miss[1], /^X: Ads API access/);
  assert.deepEqual(missing({ meta: { token: "t", account: "a" }, tiktok: { token: "t", advertiser: "1" }, x: { consumerKey: "k", accessToken: "t", account: "1" } }), []);
});

test("OAuth 1.0a: the documented example signs the same way", () => {
  // the example X's own docs use ("Creating a signature"), with its nonce and timestamp
  const h = oauth1Header({ consumerKey: "xvz1evFS4wEEPTGEFPHBog", consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw", accessToken: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", accessSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE", method: "POST", url: "https://api.twitter.com/1.1/statuses/update.json?include_entities=true", params: { status: "Hello Ladies + Gentlemen, a signed OAuth request!" }, nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", timestamp: 1318622958 });
  assert.match(h, /^OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1318622958", oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", oauth_version="1.0"$/);
  const a = oauth1Header({ consumerKey: "k", consumerSecret: "s", accessToken: "t", accessSecret: "x", method: "GET", url: "https://ads-api.x.com/12/accounts" });
  const b = oauth1Header({ consumerKey: "k", consumerSecret: "s", accessToken: "t", accessSecret: "x", method: "GET", url: "https://ads-api.x.com/12/accounts" });
  assert.notEqual(a, b, "a fresh nonce each time");
});
