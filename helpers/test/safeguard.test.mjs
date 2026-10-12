// The safeguard's arithmetic and words: the money to think with (the credit and the key's own limit), the money for
// video, the shop, and the evening's account of what went wrong. Each case is one that happened or nearly did.
import test from "node:test";
import assert from "node:assert/strict";
import { pace, thinkingMoney, videoMoney, shopState, plainFailure, dayReport, worse } from "../lib/safeguard.mjs";

const KEYS = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"]; // today last

test("the pace is the average day since the first day with any spend, today left out; fewer than three days say nothing", () => {
  const rows = [{ day: "2026-10-09", micro: 10_000_000 }, { day: "2026-10-09", micro: 2_000_000 }, { day: "2026-10-10", micro: 0 }, { day: "2026-10-11", micro: 18_000_000 }, { day: "2026-10-12", micro: 90_000_000 }];
  assert.equal(pace(rows, KEYS), 10, "three days: 12, 0 and 18 dollars; today's 90 is not in it");
  assert.equal(pace([{ day: "2026-10-10", micro: 5_000_000 }, { day: "2026-10-11", micro: 5_000_000 }], KEYS), null, "two days are not a pace");
  assert.equal(pace([{ day: "2026-10-12", micro: 5_000_000 }], KEYS), null); assert.equal(pace([], KEYS), null);
  assert.equal(pace([{ day: "2026-10-05", micro: 7_000_000 }], KEYS), 1, "one spend a week ago is a dollar a day over seven days");
});

test("the AI credit: the smaller of the credit and the key's own limit, and what to do says which of the two", () => {
  // the morning of 2026-10-12: credit on the account, the key at its limit
  const empty = thinkingMoney({ leftUsd: 58.86, limitUsd: 100, limitLeftUsd: 0 }, 20);
  assert.equal(empty.level, "empty"); assert.equal(empty.binds, "limit"); assert.equal(empty.roomUsd, 0);
  assert.equal(empty.text, "No brownie can think right now: the OpenRouter key has used up its own limit of 100 USD. Raise the key's limit at openrouter.ai: Settings, API Keys, edit the key. Until then the paid reviews are turned away before any money moves.");
  // the same with no limit on the key and no credit
  const dry = thinkingMoney({ leftUsd: 0.4, limitUsd: null, limitLeftUsd: null }, 20);
  assert.equal(dry.level, "empty"); assert.equal(dry.binds, "credit");
  assert.match(dry.text, /the OpenRouter credit is used up\. Add credit at openrouter\.ai: Settings, Credits\./);
  // low by dollars
  const low = thinkingMoney({ leftUsd: 38.2, limitUsd: 1500, limitLeftUsd: 1398.86 }, null);
  assert.equal(low.level, "low"); assert.equal(low.days, null);
  assert.equal(low.text, "The AI credit is getting low: 38.20 USD (the account's credit; the key's own limit still has 1398.86). Add credit at openrouter.ai: Settings, Credits.");
  // low by days: plenty of dollars, a fast week
  const fast = thinkingMoney({ leftUsd: 120 }, 50);
  assert.equal(fast.level, "low");
  assert.equal(fast.text, "The AI credit is getting low: 120.00 USD (the account's credit). At this week's pace of 50.00 USD a day that is about 2 days. Add credit at openrouter.ai: Settings, Credits.");
  // critical: under a day, the key's limit binding
  const crit = thinkingMoney({ leftUsd: 300, limitUsd: 200, limitLeftUsd: 21.5 }, 30);
  assert.equal(crit.level, "critical"); assert.equal(crit.binds, "limit");
  assert.equal(crit.text, "The AI credit is almost gone: 21.50 USD (the key's own limit has 21.50 of 200 left, the account has 300.00). At this week's pace of 30.00 USD a day that is less than a day. Raise the key's limit at openrouter.ai: Settings, API Keys, edit the key.");
  assert.equal(thinkingMoney({ leftUsd: 14 }).level, "critical", "under 15 dollars with no pace known");
  // fine
  const ok = thinkingMoney({ leftUsd: 258.86, limitUsd: 1500, limitLeftUsd: 1398.86 }, 21.4);
  assert.equal(ok.level, "ok"); assert.equal(ok.text, "The AI credit is fine: 258.86 USD, about 12 days at this week's pace.");
  assert.equal(thinkingMoney({ leftUsd: 500 }).text, "The AI credit is fine: 500.00 USD.");
  // a key past its limit is no negative room; no reading is no verdict
  assert.equal(thinkingMoney({ leftUsd: 50, limitUsd: 100, limitLeftUsd: -1.14 }).roomUsd, 0);
  assert.equal(thinkingMoney(null).level, "unknown"); assert.equal(thinkingMoney({}).level, "unknown");
  // the thresholds can be set
  assert.equal(thinkingMoney({ leftUsd: 38.2 }, null, { lowUsd: 30 }).level, "ok");
  assert.equal(worse("critical", "low"), true); assert.equal(worse("ok", "low"), false); assert.equal(worse("empty", "critical"), true);
});

test("the video credit is counted in clips, at what a clip really cost once three were made", () => {
  assert.equal(videoMoney(null).level, "unknown");
  assert.match(videoMoney({ refillUsd: 0 }).text, /The Higgsfield balance is not set\. After a top-up tell me the balance: \/refill <usd>\./);
  const ok = videoMoney({ refillUsd: 100, spentUsd: 29, leftUsd: 71, clips: 10 });
  assert.equal(ok.level, "ok"); assert.equal(ok.clips, 24); assert.equal(ok.text, "The video credit is fine: about 71.00 USD at Higgsfield, enough for 24 clips.");
  const low = videoMoney({ refillUsd: 100, spentUsd: 91.3, leftUsd: 8.7, clips: 31 });
  assert.equal(low.level, "low"); assert.equal(low.clips, 2);
  assert.equal(low.text, "The video credit is getting low: about 8.70 USD at Higgsfield, enough for 2 more clips at about 2.95 each. Top up at higgsfield.ai, then tell me the new balance: /refill <usd>.");
  const crit = videoMoney({ refillUsd: 100, spentUsd: 96, leftUsd: 4, clips: 32 });
  assert.equal(crit.level, "critical"); assert.match(crit.text, /^The video credit is almost gone: about 4\.00 USD at Higgsfield, enough for 1 more clip at about 3\.00 each\./);
  // the evening of 2026-10-08: "Your credit balance is too low to complete this request"
  const empty = videoMoney({ refillUsd: 100, spentUsd: 98.5, leftUsd: 1.5, clips: 33 });
  assert.equal(empty.level, "empty"); assert.match(empty.text, /^Sprinkle cannot make a clip: about 1\.50 USD is left at Higgsfield and a clip costs about 2\.98\./);
  // before three clips were made a clip is taken at the price in the settings
  assert.equal(videoMoney({ refillUsd: 20, spentUsd: 9, leftUsd: 11, clips: 2 }).clips, 3);
  assert.equal(videoMoney({ refillUsd: 20, spentUsd: 9, leftUsd: 11, clips: 2 }, { clipUsd: 6 }).clips, 1);
});

test("the shop: closed with its reason, open with nothing to make a review from, open", () => {
  const ai = (roomUsd, level = "ok") => ({ level, roomUsd });
  assert.equal(shopState(null, ai(100)).level, "unknown");
  assert.deepEqual(shopState({ open: false, closedBecause: "the settler has no gas" }, ai(100)), { level: "closed", text: "The shop is closed: the settler has no gas." });
  assert.deepEqual(shopState({ open: true }, ai(0, "empty")), { level: "starved", text: "The shop is open, but there is 0.00 USD of AI credit and the smallest review needs 12. Biscotti turns those orders away before any money moves." });
  assert.equal(shopState({ open: true }, ai(11.99, "critical")).level, "starved");
  assert.deepEqual(shopState({ open: true }, ai(12, "critical")), { level: "ok", text: "The shop is open." });
  assert.equal(shopState({ open: true }, { level: "unknown" }).level, "ok", "no reading of the credit is not a reason to cry starved");
});

test("a failure note in plain words", () => {
  assert.equal(plainFailure("Higgsfield moderated the request (nsfw): nothing was made"), "The video model's safety filter refused the scene. It does that to harmless scenes now and then. Nothing was made.");
  assert.match(plainFailure("Higgsfield failed: The generated result was blocked by content safety checks. Try a different prompt"), /safety filter refused the scene/);
  assert.equal(plainFailure("Higgsfield failed: Your credit balance is too low to complete this request. Please top up your balance"), "The Higgsfield balance ran out.");
  assert.equal(plainFailure("the OpenRouter key reached its own spending limit"), "The AI key had reached its spending limit.");
  assert.equal(plainFailure("X answered 429: Too Many Requests"), "The service asked us to slow down.");
  assert.equal(plainFailure("OpenRouter refused the key (403)"), "The service refused our login.");
  assert.equal(plainFailure("fetch failed"), "The service did not answer.");
  assert.equal(plainFailure("the clip plan was   not usable"), "It said: the clip plan was not usable.");
  assert.equal(plainFailure(""), "It left no reason."); assert.equal(plainFailure(null), "It left no reason.");
});

test("the evening's account: a line for each brownie whose tries failed and for a daily one that did nothing; silence on a good day", () => {
  const at = (h) => Date.UTC(2026, 9, 12, h);
  // 2026-10-12 as it was: Sprinkle's one try refused, nothing after it
  const sprinkle = { name: "sprinkle", expected: true, today: [{ at: at(9), job: "clip", ok: false, note: "Higgsfield moderated the request (nsfw): nothing was made" }] };
  const one = dayReport([sprinkle, { name: "fudge", today: [{ at: at(8), job: "post", ok: true }] }], { hints: { sprinkle: { failed: "It tries the episode again tomorrow. /sprinkle next makes it now.", silent: "/sprinkle next makes the episode now." } } });
  assert.equal(one.text, "Today one thing did not go as planned.\n- Sprinkle: one try failed, and it made nothing today. The video model's safety filter refused the scene. It does that to harmless scenes now and then. Nothing was made. It tries the episode again tomorrow. /sprinkle next makes it now.");
  // a failure with work after it, a failure with work only before it, a daily brownie that was silent, one that is not daily
  const rep = dayReport([
    { name: "sprinkle", expected: true, today: [{ at: at(9), job: "clip", ok: false, note: "Higgsfield moderated the request (nsfw)" }, { at: at(16), job: "post", ok: true }] },
    { name: "fudge", today: [{ at: at(8), job: "post", ok: true }, { at: at(12), job: "post", ok: false, note: "X answered 429" }, { at: at(13), job: "post", ok: false, note: "X answered 429" }] },
    { name: "swirl", expected: true, today: [] },
    { name: "praline", today: [] },
    { name: "nib", today: [{ at: at(7), job: "research", ok: true }] },
  ]);
  assert.deepEqual(rep.lines, [
    "Sprinkle: one try failed, and it made 1 thing after that. The video model's safety filter refused the scene. It does that to harmless scenes now and then. Nothing was made.",
    "Fudge: 2 tries failed, and nothing worked after it. The service asked us to slow down.",
    "Swirl did nothing today, and it has a job every day.",
  ]);
  assert.match(rep.text, /^Today 3 things did not go as planned\.\n- Sprinkle/);
  assert.deepEqual(dayReport([{ name: "nib", today: [{ at: at(7), job: "research", ok: true }] }, { name: "praline", today: [] }]), { lines: [], text: "" });
});
