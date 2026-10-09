// The bill: the ledger keeps one line per paid call; the view adds them up per brownie against the caps, per day
// for two weeks, per model and per job, with the month so far and the two balances; the Telegram text reads right.
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../lib/store.mjs";
import { costsView, billText, dayKeys, DAYS } from "../lib/costs.mjs";

const T0 = Date.parse("2026-10-09T10:00:00Z"); // 12:00 in Rome
const DAY = 86_400_000;
const near = (a, b, what = "") => assert.ok(Math.abs(a - b) < 1e-9, `${what} ${a} is not ${b}`);

/// Fudge: two AI calls today and one yesterday. Sprinkle: one AI call and two clips today (one priced by our own
/// table), one clip twenty days ago. Truffle: one call today, but it is not on the roster any more.
function filled() {
  const store = new Store(":memory:", { tz: "Europe/Rome" });
  store.addSpend("fudge", 125_000, T0 - DAY);
  store.addSpend("fudge", 30_000, T0); store.addEntry({ at: T0, helper: "fudge", kind: "ai", model: "anthropic/claude-sonnet-5.5", job: "fudge-post", tokensIn: 900, tokensOut: 120, tokensThink: 40, costMicro: 30_000, ms: 1200 });
  store.addSpend("fudge", 10_000, T0 + 500); store.addEntry({ at: T0 + 500, helper: "fudge", kind: "ai", model: "anthropic/claude-haiku-5.5", job: "fudge-mentions", tokensIn: 300, tokensOut: 50, costMicro: 10_000, ms: 400 });
  store.addSpend("sprinkle", 50_000, T0); store.addEntry({ at: T0, helper: "sprinkle", kind: "ai", model: "anthropic/claude-opus-5.5", job: "sprinkle-episode", tokensIn: 2000, tokensOut: 400, costMicro: 50_000, ms: 3000 });
  store.addEntry({ at: T0 + 1000, helper: "sprinkle", kind: "video", model: "bytedance/seedance-2.5/text-to-video", job: "sprinkle-episode", seconds: 10, costMicro: 4_622_000, guessed: false, note: "Clip 11: Ep. 3" });
  store.addEntry({ at: T0 + 2000, helper: "sprinkle", kind: "video", model: "bytedance/seedance-2.5/text-to-video", job: "clip", seconds: 8, costMicro: 3_697_600, guessed: true, note: "Clip 12: Trend" });
  store.addEntry({ at: T0 - 20 * DAY, helper: "sprinkle", kind: "video", seconds: 10, costMicro: 4_000_000, note: "old" });
  store.addSpend("truffle", 5_000, T0); store.addEntry({ at: T0, helper: "truffle", kind: "ai", model: "m", costMicro: 5_000 });
  return store;
}

test("the ledger: lines per day, helper and kind; per model and job; per day; since a time; the newest and the biggest", () => {
  const store = filled();
  assert.deepEqual(dayKeys(store, T0, 3), ["2026-10-07", "2026-10-08", "2026-10-09"]);
  assert.equal(DAYS, 14);
  const day = store.ledgerDay("2026-10-09");
  assert.deepEqual(day.find((l) => l.helper === "fudge"), { helper: "fudge", kind: "ai", n: 2, micro: 40_000, tokensIn: 1200, tokensOut: 170, tokensThink: 40, seconds: 0, maxMicro: 30_000, guessed: 0 });
  assert.deepEqual(day.find((l) => l.helper === "sprinkle" && l.kind === "video"), { helper: "sprinkle", kind: "video", n: 2, micro: 8_319_600, tokensIn: 0, tokensOut: 0, tokensThink: 0, seconds: 18, maxMicro: 4_622_000, guessed: 1 });
  assert.equal(store.ledgerModels("2026-10-09").find((m) => m.model === "anthropic/claude-haiku-5.5").job, "fudge-mentions");
  assert.deepEqual(store.ledgerDays("2026-10-08"), [{ day: "2026-10-09", kind: "ai", n: 4, micro: 95_000 }, { day: "2026-10-09", kind: "video", n: 2, micro: 8_319_600 }]);
  assert.deepEqual(store.ledgerSince(T0 - DAY), [{ kind: "ai", n: 4, micro: 95_000 }, { kind: "video", n: 2, micro: 8_319_600 }]);
  assert.deepEqual(store.ledgerToday("sprinkle", "video", T0 + 3000), { n: 2, micro: 8_319_600, seconds: 18 });
  assert.deepEqual(store.ledgerToday("crumb", "video", T0), { n: 0, micro: 0, seconds: 0 });
  assert.equal(store.ledgerRecent(1)[0].note, "Clip 12: Trend");
  assert.equal(store.ledgerBiggest("2026-10-09", 1)[0].micro, 4_622_000);
  assert.deepEqual(store.spendDays("2026-10-09").map((r) => r.helper), ["fudge", "sprinkle", "truffle"]);
  // a line keeps only what is sane: no negative numbers, a note cut short
  const id = store.addEntry({ at: T0 + 5000, helper: "nib", costMicro: -5, tokensIn: "x", note: "n".repeat(300) });
  const l = store.ledgerRecent(1)[0];
  assert.equal(l.id, id); assert.equal(l.micro, 0); assert.equal(l.tokensIn, 0); assert.equal(l.note.length, 200); assert.equal(l.kind, "ai");
});

test("the view: every brownie against its caps (near, capped, no cap), video apart, the history, the month, the balances", () => {
  const store = filled();
  const args = { store, now: T0 + 3000, helpers: ["fudge", "crumb", "sprinkle"], caps: { fudge: 0.05, crumb: 2, sprinkle: 31 }, videoCaps: { sprinkle: 10 }, hidden: ["sprinkle"], paused: ["crumb"], models: { fudge: "anthropic/claude-sonnet-5.5", crumb: "anthropic/claude-haiku-5.5", sprinkle: "anthropic/claude-opus-5.5" }, openrouter: { boughtUsd: 60, usedUsd: 10.43, leftUsd: 49.57, usageDailyUsd: 2.39, limitUsd: 100, limitLeftUsd: 89.57 }, refill: { usd: 100, at: T0 - DAY }, timezone: "Europe/Rome" };
  const v = costsView(args);
  assert.equal(v.day, "2026-10-09"); assert.equal(v.timezone, "Europe/Rome");
  near(v.today.aiUsd, 0.095, "ai today"); near(v.today.videoUsd, 8.3196, "video today"); near(v.today.usd, 8.4146, "today");
  assert.equal(v.today.calls, 4); assert.equal(v.today.videos, 2); assert.equal(v.today.seconds, 18); assert.equal(v.today.tokensIn, 3200); assert.equal(v.today.tokensThink, 40);
  near(v.today.capUsd, 33.05, "the caps of the roster, not of the one that is gone"); assert.equal(v.today.videoGuessed, 1);
  assert.deepEqual(v.helpers.map((h) => h.name), ["fudge", "crumb", "sprinkle", "truffle"], "the roster, then the one that spent but is gone");
  const [f, c, s, t] = v.helpers;
  assert.equal(f.title, "Fudge"); near(f.aiUsd, 0.04); assert.equal(f.capUsd, 0.05); assert.equal(f.pct, 80); assert.equal(f.state, "near"); near(f.leftUsd, 0.01); assert.equal(f.calls, 2);
  assert.equal(f.tokensIn, 1200); assert.equal(f.tokensOut, 170); near(f.avgUsd, 0.02); near(f.biggestUsd, 0.03); assert.equal(f.model, "anthropic/claude-sonnet-5.5");
  assert.deepEqual(f.models, [{ model: "anthropic/claude-sonnet-5.5", usd: 0.03, calls: 1 }, { model: "anthropic/claude-haiku-5.5", usd: 0.01, calls: 1 }]);
  assert.deepEqual(f.jobs, [{ job: "post", usd: 0.03, calls: 1 }, { job: "mentions", usd: 0.01, calls: 1 }]);
  assert.equal(f.videos, 0); assert.equal(f.videoCapUsd, null); assert.equal(f.hidden, false); assert.equal(f.gone, false);
  assert.equal(c.paused, true); assert.equal(c.aiUsd, 0); assert.equal(c.pct, 0); assert.equal(c.state, "ok"); assert.equal(c.leftUsd, 2); assert.deepEqual(c.models, []);
  assert.equal(s.hidden, true); near(s.videoUsd, 8.3196); assert.equal(s.videos, 2); assert.equal(s.seconds, 18); assert.equal(s.videoCapUsd, 10); assert.equal(s.videoPct, 83); assert.equal(s.videoState, "near"); assert.equal(s.videoGuessed, 1);
  near(s.totalUsd, 8.3696); assert.deepEqual(s.jobs, [{ job: "episode", usd: 0.05, calls: 1 }]);
  assert.equal(t.gone, true); assert.equal(t.capUsd, 0); near(t.aiUsd, 0.005); assert.equal(t.state, "ok"); assert.equal(t.pct, 0);
  // the history: fourteen days ending today, every day present
  assert.equal(v.history.length, 14);
  assert.deepEqual(v.history.map((d) => d.day).slice(-2), ["2026-10-08", "2026-10-09"]);
  const today = v.history.at(-1), yesterday = v.history.at(-2);
  near(today.aiUsd, 0.095); near(today.videoUsd, 8.3196); near(today.usd, 8.4146); assert.equal(today.calls, 4); assert.equal(today.videos, 2);
  near(yesterday.aiUsd, 0.125); assert.equal(yesterday.calls, 1); assert.equal(yesterday.videoUsd, 0); assert.equal(yesterday.videos, 0);
  assert.equal(v.history[0].usd, 0);
  // the month: the clip of twenty days ago is September's
  assert.equal(v.month.since, "2026-10-01"); near(v.month.aiUsd, 0.22); near(v.month.videoUsd, 8.3196); near(v.month.usd, 8.5396); assert.equal(v.month.calls, 5); assert.equal(v.month.videos, 2);
  // models across the team, the newest lines, the biggest
  assert.deepEqual(v.models.map((m) => [m.model, m.usd, m.calls]), [["anthropic/claude-opus-5.5", 0.05, 1], ["anthropic/claude-sonnet-5.5", 0.03, 1], ["anthropic/claude-haiku-5.5", 0.01, 1], ["m", 0.005, 1]]);
  assert.equal(v.models[0].tokensIn, 2000);
  assert.equal(v.recent.length, 7); assert.equal(v.recent[0].note, "Clip 12: Trend"); assert.equal(v.recent[0].guessed, true); assert.equal(v.recent[0].job, "clip"); near(v.recent[0].usd, 3.6976); assert.equal(v.recent[0].title, "Sprinkle");
  assert.equal(v.recent.find((l) => l.model === "anthropic/claude-haiku-5.5").job, "mentions");
  near(v.biggest[0].usd, 4.622); assert.equal(v.biggest.length, 5);
  // the balances: OpenRouter as read; Higgsfield counted down from the owner's figure by the clips since
  assert.equal(v.openrouter.leftUsd, 49.57);
  assert.deepEqual(v.higgsfield, { refillUsd: 100, refillAt: T0 - DAY, spentUsd: 8.3196, leftUsd: 91.68, clips: 2 });
  // capped
  const v2 = costsView({ ...args, caps: { ...args.caps, fudge: 0.04 }, videoCaps: { sprinkle: 8 }, openrouter: null, refill: null });
  assert.equal(v2.helpers[0].state, "capped"); assert.equal(v2.helpers[0].pct, 100); assert.equal(v2.helpers[0].leftUsd, 0);
  assert.equal(v2.helpers[2].videoState, "capped"); assert.equal(v2.helpers[2].videoPct, 100);
  assert.equal(v2.openrouter, null); assert.equal(v2.higgsfield, null);
  // an empty store is a bill of zeros, not an error
  const empty = costsView({ store: new Store(":memory:"), now: T0, helpers: ["fudge"], caps: { fudge: 1 } });
  assert.equal(empty.today.usd, 0); assert.equal(empty.history.length, 14); assert.deepEqual(empty.recent, []); assert.equal(empty.month.usd, 0);
});

test("the bill as text for Telegram", () => {
  const store = filled();
  const v = costsView({ store, now: T0 + 3000, helpers: ["fudge", "crumb", "sprinkle"], caps: { fudge: 0.05, crumb: 2, sprinkle: 31 }, videoCaps: { sprinkle: 10 }, hidden: ["sprinkle"], openrouter: { boughtUsd: 60, usedUsd: 10.43, leftUsd: 49.57 }, refill: { usd: 100, at: T0 - DAY }, timezone: "Europe/Rome" });
  const text = billText(v);
  assert.deepEqual(text.split("\n"), [
    "The bill, 2026-10-09 (Europe/Rome).",
    "Today: $8.41 in all. AI $0.10 in 4 calls, video $8.32 in 2 clips.",
    "OpenRouter: $49.57 left of $60.00 bought.",
    "Higgsfield: about $91.68 left of the $100.00 you set (2 clips since).",
    "",
    "Fudge: $0.04 of $0.05 (2 calls), near the cap",
    "Crumb: $0.00 of $2.00 (0 calls)",
    "Sprinkle (hidden): $0.05 of $31.00 (1 call) + video $8.32 of $10.00 (2 clips)",
    "Truffle (gone): $0.01 (1 call)",
    "",
    "This month: $8.54 (AI $0.22, video $8.32).",
  ]);
  const plain = billText(costsView({ store: new Store(":memory:"), now: T0, helpers: ["fudge"], caps: { fudge: 1 } }));
  assert.match(plain, /Higgsfield: no balance set\. After a top-up: \/refill <usd>\./);
  assert.ok(!/OpenRouter/.test(plain));
});
