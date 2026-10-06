// Every call asks the model for low reasoning effort by default (measured: no hidden thinking tokens, the whole
// budget goes to the answer); a call may ask for something else or for none.
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./mock.mjs";
import { DEFAULT_REASONING, REASONING_HEADROOM } from "../lib/brain.mjs";

test("the default call carries reasoning effort low and the headroom; a call can override or drop it", async () => {
  const W = makeWorld({ reply: () => "fine" });
  await W.brain.chat("nib", { prompt: "hello", maxTokens: 100 });
  const first = W.or.calls[0].body;
  assert.deepEqual(first.reasoning, { effort: "low" });
  assert.deepEqual(DEFAULT_REASONING, { effort: "low" });
  assert.equal(first.max_tokens, 100 + REASONING_HEADROOM);
  await W.brain.chat("nib", { prompt: "think hard", maxTokens: 100, reasoning: { effort: "high" } });
  assert.deepEqual(W.or.calls[1].body.reasoning, { effort: "high" });
  await W.brain.chat("nib", { prompt: "plain", maxTokens: 100, reasoning: null });
  assert.equal(W.or.calls[2].body.reasoning, undefined);
});
