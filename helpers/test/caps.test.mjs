// Caps and effort: the owner hears once a day when a brownie has used 80% of its cap, and again when the cap is
// reached; a brownie's config can set its own reasoning effort and the headroom that goes with it; the control
// room's cap command raises a cap for today and persists it.
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./mock.mjs";
import { REASONING_HEADROOM } from "../lib/brain.mjs";

test("at 80% of the cap the owner is warned once a day with the /cap hint; at the cap, the budget alert", async () => {
  const W = makeWorld({ cost: 0.3 }); // 0.30 USD a call against Nib's 1 USD cap
  await W.brain.chat("nib", { prompt: "one", maxTokens: 50 });
  await W.brain.chat("nib", { prompt: "two", maxTokens: 50 });
  assert.equal(W.alerts.sent.filter((a) => a.topic.startsWith("nearcap")).length, 0, "60%: nothing yet");
  await W.brain.chat("nib", { prompt: "three", maxTokens: 50 }); // 90%
  const near = W.alerts.sent.filter((a) => a.topic.startsWith("nearcap:nib"));
  assert.equal(near.length, 1);
  assert.match(near[0].text, /^Nib has used 90% of its daily cap: 0\.90 of 1\.00 USD\. Reply \/cap nib 2 to raise it/);
  assert.match(W.tg.sent.at(-1).text, /Nib has used 90%/);
  await W.brain.chat("nib", { prompt: "four", maxTokens: 50 }); // 120%: the cap is reached
  assert.equal(W.alerts.sent.filter((a) => a.topic.startsWith("nearcap:nib")).length, 1, "the warning goes once a day");
  assert.ok(W.alerts.sent.some((a) => a.topic === "budget:nib" && /Reply \/cap nib <usd>/.test(a.text)), "the budget alert says how to raise the cap");
  await assert.rejects(W.brain.chat("nib", { prompt: "five", maxTokens: 50 }), (e) => e.budget === true);
  W.clock.advance(86_400_000);
  await W.brain.chat("nib", { prompt: "next day", maxTokens: 50 });
  assert.equal(W.alerts.sent.filter((a) => a.topic.startsWith("nearcap:nib")).length, 1, "a new day starts clean at 30%");
});

test("a brownie's config sets its reasoning effort and headroom; a call can still override; others keep the default", async () => {
  const W = makeWorld({ config: { chip: { reasoning: { effort: "medium" }, reasoningHeadroom: 8000 } } });
  await W.brain.chat("chip", { prompt: "plan", maxTokens: 500 });
  assert.deepEqual(W.or.calls.at(-1).body.reasoning, { effort: "medium" });
  assert.equal(W.or.calls.at(-1).body.max_tokens, 500 + 8000);
  await W.brain.chat("chip", { prompt: "quick", maxTokens: 100, reasoning: { effort: "low" } });
  assert.deepEqual(W.or.calls.at(-1).body.reasoning, { effort: "low" }, "the call's own effort wins");
  assert.equal(W.or.calls.at(-1).body.max_tokens, 100 + 8000, "the headroom stays the brownie's");
  await W.brain.chat("fudge", { prompt: "post", maxTokens: 200 });
  assert.deepEqual(W.or.calls.at(-1).body.reasoning, { effort: "low" });
  assert.equal(W.or.calls.at(-1).body.max_tokens, 200 + REASONING_HEADROOM);
});
