// The provider key's own limit (found 2026-10-12: the key stood at 101 of 100 dollars with credits still on the
// account, every call answered 403, and the guard that reads the credits said there was room).
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./mock.mjs";
import { Brain, BudgetError } from "../lib/brain.mjs";
import { Store } from "../lib/store.mjs";
import { costsView, billText } from "../lib/costs.mjs";

test("the room at the provider is the credits or the key's own limit, whichever is less", () => {
  assert.equal(Brain.roomUsd({ leftUsd: 49.5, limitUsd: null, limitLeftUsd: null }), 49.5, "no limit on the key: the credits");
  assert.equal(Brain.roomUsd({ leftUsd: 49.5 }), 49.5, "a reading with no word on the limit: the credits");
  assert.equal(Brain.roomUsd({ leftUsd: 400, limitUsd: 100, limitLeftUsd: 0 }), 0, "a key at its limit has no room, whatever the credits say");
  assert.equal(Brain.roomUsd({ leftUsd: 400, limitUsd: 100, limitLeftUsd: -1.14 }), 0, "a key past its limit: none, never a negative room");
  assert.equal(Brain.roomUsd({ leftUsd: 3, limitUsd: 100, limitLeftUsd: 60 }), 3, "the credits when they are the smaller");
  assert.equal(Brain.roomUsd(null), null);
  assert.equal(Brain.roomUsd({}), null);
});

test("a key at its limit is a budget to raise, not a key to replace: the owner is told so and the helper stops", async () => {
  const W = makeWorld({});
  const told = [];
  W.brain.alerts = { budget: async (helper, why) => told.push(["budget", helper, why]), credentials: async (what, why) => told.push(["credentials", what, why]) };
  W.or.reply = () => ({ status: 403, json: { error: { message: "Key limit exceeded (total limit). Manage it using https://openrouter.ai/settings/keys", code: 403 } } });
  await assert.rejects(() => W.brain.chat("nib", { prompt: "Say one thing." }), (e) => e instanceof BudgetError && /reached its own spending limit/.test(e.message));
  assert.equal(told.length, 1);
  assert.equal(told[0][0], "budget");
  assert.match(told[0][2], /spending limit \(raise it at openrouter\.ai/);
  // any other 403 is still a refused key
  W.or.reply = () => ({ status: 403, json: { error: { message: "Forbidden" } } });
  await assert.rejects(() => W.brain.chat("nib", { prompt: "Again." }), /OpenRouter refused the key \(403\)/);
  assert.equal(told[1][0], "credentials");
});

test("the bill says when the key is at its limit", () => {
  const view = (openrouter) => costsView({ store: new Store(":memory:"), now: Date.UTC(2026, 9, 12, 10), helpers: ["fudge"], caps: { fudge: 1 }, openrouter });
  const at = billText(view({ boughtUsd: 500, usedUsd: 101.14, leftUsd: 398.86, limitUsd: 100, limitLeftUsd: 0 }));
  assert.match(at, /OpenRouter: \$398\.86 left of \$500\.00 bought\./);
  assert.match(at, /The key's own limit: \$0\.00 left of \$100\.00\. AT THE LIMIT: no brownie can think until it is raised/);
  const under = billText(view({ boughtUsd: 500, usedUsd: 40, leftUsd: 460, limitUsd: 100, limitLeftUsd: 60 }));
  assert.match(under, /The key's own limit: \$60\.00 left of \$100\.00\.$/m);
  assert.doesNotMatch(billText(view({ boughtUsd: 60, usedUsd: 10, leftUsd: 50, limitUsd: null, limitLeftUsd: null })), /own limit/);
});
