// What a request may cost and what it did cost. Each case below was a finding of the code review of 2026-10-12.
import test from "node:test";
import assert from "node:assert/strict";
import { price, prices, maxOut, promptTokens, worstCaseMicro, promptMicro, billedMicro, pinModel, deltaText, BYTES_PER_TOKEN, IMAGE_TOKENS } from "../billing.mjs";

const MODEL = { id: "lab/model", pricing: { prompt: "0.000003", completion: "0.000015" } }; // 3 and 15 dollars a million

test("a price is a number from zero up, or the model is not served: a router that states -1 has no price to hold against", () => {
  assert.equal(price("0.000003"), 0.000003); assert.equal(price(0), 0); assert.equal(price(undefined), 0); assert.equal(price(""), 0);
  assert.equal(price("-1"), null); assert.equal(price(-0.5), null); assert.equal(price("abc"), null); assert.equal(price(Infinity), null);
  assert.deepEqual(prices(MODEL), { prompt: 0.000003, completion: 0.000015, request: 0, image: 0 });
  assert.equal(prices({ pricing: { prompt: "-1", completion: "-1" } }), null);
  assert.equal(prices({ pricing: { prompt: "0.000001", completion: "NaN" } }), null);
  assert.equal(worstCaseMicro({ pricing: { prompt: "-1", completion: "-1" } }, { messages: [], max_tokens: 100000 }), null, "never a negative hold");
});

test("the hold covers everything that goes upstream: the tools and the schemas, not the messages alone; the larger of the two output bounds", () => {
  const small = { model: "lab/model", messages: [{ role: "user", content: "hi" }], max_tokens: 1 };
  const withTools = { ...small, tools: [{ type: "function", function: { name: "f", description: "x".repeat(300_000), parameters: {} } }] };
  assert.ok(promptTokens(withTools) > promptTokens(small) + 100_000, "three hundred thousand characters of tool text are counted");
  assert.ok(worstCaseMicro(MODEL, withTools) > 300_000, "and they are held for: over 30 cents here");
  assert.ok(worstCaseMicro(MODEL, small) < 200);
  assert.equal(maxOut({ max_tokens: 10, max_completion_tokens: 5000 }), 5000); assert.equal(maxOut({ max_tokens: 800 }), 800); assert.equal(maxOut({}), 1024);
  assert.ok(worstCaseMicro(MODEL, { messages: [], max_tokens: 1, max_completion_tokens: 100_000 }) >= 1_500_000, "a second, larger bound cannot hide behind the first");
  // dense text: a token is taken to be 2.5 bytes, so text in another script is not under-held
  const cjk = { messages: [{ role: "user", content: "你".repeat(1000) }] };
  assert.ok(promptTokens(cjk) >= 1000, "a thousand characters of three bytes each are at least a thousand tokens");
  assert.equal(BYTES_PER_TOKEN, 2.5);
});

test("an inline image is counted as an image, not as megabytes of text; a price per request and per image is added", () => {
  const img = { messages: [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(2_000_000) } }] }] };
  const t = promptTokens(img);
  assert.ok(t > IMAGE_TOKENS && t < IMAGE_TOKENS + 200, `one image and a few words, not 800,000 tokens (got ${t})`);
  const linked = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x.example/a.png" } }] }] };
  assert.ok(promptTokens(linked) >= IMAGE_TOKENS);
  const priced = { pricing: { prompt: "0.000001", completion: "0.000002", request: "0.01", image: "0.005" } };
  assert.ok(worstCaseMicro(priced, { ...linked, max_tokens: 1 }) >= 15_000, "the request's and the image's own prices are in the hold");
  assert.ok(promptMicro(priced, { messages: [] }) >= 10_000);
});

test("what a call cost: the upstream's stated cost, else its tokens, else what was read and what was delivered; never nothing for an answer that went out", () => {
  const body = { messages: [{ role: "user", content: "a".repeat(2500) }], max_tokens: 4000 };
  assert.equal(billedMicro(MODEL, { cost: 0.04 }), 40_000);
  assert.equal(billedMicro(MODEL, { cost: 0.04 }, { multiplier: 1.5 }), 60_000);
  assert.equal(billedMicro(MODEL, { prompt_tokens: 1000, completion_tokens: 2000 }), 33_000, "3,000 + 30,000 micro");
  assert.equal(billedMicro(MODEL, { cost: 0, prompt_tokens: 1000, completion_tokens: 0 }), 3_000, "a stated cost of zero falls back to the tokens");
  assert.equal(billedMicro(MODEL, null), 0, "no usage and no body to estimate from: nothing can be said");
  const cut = billedMicro(MODEL, null, { body, deliveredChars: 5000 });
  assert.ok(cut >= 3_000 + 30_000, `a stream that ended without its usage line is billed its prompt and the 5,000 characters that went out (got ${cut})`);
  assert.ok(billedMicro(MODEL, {}, { body, deliveredChars: 0 }) >= 3_000, "an empty usage object is not a reason to bill nothing either");
  assert.equal(billedMicro({ pricing: { prompt: "-1", completion: "-1" } }, null, { body, deliveredChars: 100 }), 0);
  assert.equal(billedMicro(MODEL, { cost: "abc" }, { body: null }), 0); assert.ok(billedMicro(MODEL, { cost: NaN, prompt_tokens: 10 }) > 0);
});

test("the model that was priced is the model that is called; the text of a stream line is counted", () => {
  const b = pinModel({ model: "lab/model", models: ["dear/model"], route: "fallback", provider: { order: ["x"] }, messages: [] });
  assert.deepEqual(Object.keys(b), ["model", "provider", "messages"]);
  assert.deepEqual(b.provider, { order: ["x"] }, "with no model given the provider choices are left as they are");
  // with the model: paid extras and a count of answers go, and no provider dearer than the catalogue may serve the call
  const priced = pinModel({ model: "lab/model", plugins: [{ id: "web" }], web_search_options: {}, n: 3, provider: { data_collection: "deny" }, messages: [] }, { pricing: { prompt: "0.00000132", completion: "0.00000396" } });
  assert.deepEqual(Object.keys(priced), ["model", "provider", "messages"]);
  assert.deepEqual(priced.provider, { data_collection: "deny", max_price: { prompt: 1.32, completion: 3.96 } }, "dollars per million, without the dust of floating point");
  assert.deepEqual(pinModel({ model: "m", provider: "cheap", messages: [] }, { pricing: { prompt: "0", completion: "0" } }).provider, { max_price: { prompt: 0, completion: 0 } }, "a provider field that is not an object is replaced");
  assert.equal("provider" in pinModel({ model: "m", messages: [] }, { pricing: { prompt: "-1", completion: "-1" } }), false, "a model with no fixed price gets no ceiling (it is refused before it is called)");
  assert.equal(deltaText({ choices: [{ delta: { content: "hello" } }] }), "hello"); assert.equal(deltaText({ choices: [{ delta: { reasoning: "hm", content: "ok" } }] }), "okhm");
  assert.equal(deltaText({ choices: [{ message: { content: "whole" } }] }), "whole"); assert.equal(deltaText({ usage: { cost: 1 } }), ""); assert.equal(deltaText(null), "");
});
