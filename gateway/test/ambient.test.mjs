// Ambient over x402: the catalogue under our ids, the body JumpGate takes, the quote's headers on the paid request,
// the payment for exactly the quoted amount, the stream folded into one answer when the caller did not ask for one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { X402Payer, b64, USDC } from "../x402.mjs";
import { Ambient, foldSse } from "../ambient.mjs";

const CATALOGUE = { object: "list", data: [
  { id: "z-ai/glm-5.2", name: "GLM 5.2", is_ready: true, context_length: 202752, pricing: { input: 0.6, output: 2, prompt: "0.0000006", completion: "0.000002" } },
  { id: "qwen/qwen3.8-27b", name: "Qwen3.8 27B", is_ready: true, context_length: 32768, pricing: { input: 0.32, output: 3.2, prompt: "0.00000032", completion: "0.0000032" } },
  { id: "ambient/large", name: "GLM 5.2", is_ready: true, context_length: 202752, pricing: { input: 0.6, output: 2, prompt: "0.0000006", completion: "0.000002" } },
  { id: "qwen/qwen3.6-27b", name: "Qwen3.6 27B", is_ready: false, pricing: { input: 0.32, output: 3.2 } },
] };
const SSE = ["data: {\"id\":\"chatcmpl-1\",\"model\":\"z-ai/glm-5.2\",\"created\":1791400000,\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hello \"}}]}",
  "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"there.\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":3}}", "data: [DONE]", ""].join("\n\n");

function world({ amount = "896" } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = String(url); const headers = new Headers(init.headers || {});
    calls.push({ url: u, headers: Object.fromEntries(headers.entries()), body: init.body ? JSON.parse(init.body) : null });
    if (u.endsWith("/v1/models")) return Response.json(CATALOGUE);
    if (u.endsWith("/paid/chat/v2/quote")) return Response.json({ headers: { "x402-input-tokens": "11", "x402-max-completion-tokens": "200", "x402-max-tool-calls": "0", "x402-model-tier": "standard" }, input_tokens: 11, output_tokens: 200, model_tier: "standard", amount_micro_usdc: Number(amount), max_amount_micro_usdc: Number(amount) + 50 });
    if (u.endsWith("/paid/chat/v2")) {
      if (!headers.get("x402-input-tokens")) return new Response("Invalid header: x402-input-tokens", { status: 400 });
      if (!headers.get("payment-signature")) return new Response("", { status: 402, headers: { "payment-required": b64.encode({ x402Version: 2, resource: { url: u }, accepts: [{ scheme: "exact", network: "eip155:8453", amount, payTo: "0x6992c688c56BE442EfE1E1cE7D5c95212ED7d59B", maxTimeoutSeconds: 300, asset: USDC[8453], extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" } }] }) } });
      return new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream", "payment-response": b64.encode({ success: true, transaction: "0xfeed", network: "eip155:8453" }) } });
    }
    return new Response("nope", { status: 404 });
  };
  let t = 1_000_000;
  const payer = new X402Payer({ wallet: Wallet.createRandom(), fetch });
  const ambient = new Ambient({ payer, fetch, baseUrl: "https://jumpgate.test", catalogueUrl: "https://catalogue.test/v1/models", now: () => t });
  return { calls, payer, ambient, tick: (ms) => { t += ms; } };
}

test("the catalogue under our ids with per-token prices, cached an hour; the body JumpGate takes", async () => {
  const { ambient, calls, tick } = world();
  const list = await ambient.models();
  assert.deepEqual(list.map((m) => m.id), ["ambient/z-ai/glm-5.2", "ambient/qwen/qwen3.8-27b", "ambient/large"], "ready models only, the alias kept");
  assert.equal(list[0].pricing.prompt, "0.0000006"); assert.equal(list[0].pricing.completion, "0.000002");
  assert.equal(list[0].provider, "ambient"); assert.equal(list[0].upstream, "z-ai/glm-5.2"); assert.equal(list[0].context_length, 202752);
  await ambient.models(); assert.equal(calls.length, 1, "cached");
  tick(3_600_001); await ambient.models(); assert.equal(calls.length, 2, "read again after an hour");
  assert.equal(ambient.isOurs("ambient/large"), true); assert.equal(ambient.isOurs("anthropic/claude-fable-5.1"), false);
  assert.equal(ambient.upstreamModel("ambient/large"), "ambient/large"); assert.equal(ambient.upstreamModel("ambient/z-ai/glm-5.2"), "z-ai/glm-5.2");
  const b = ambient.body({ model: "ambient/z-ai/glm-5.2", messages: [{ role: "user", content: "hi" }], max_tokens: 50_000, stream: false, usage: { include: true }, tools: [{}] });
  assert.deepEqual(b, { model: "z-ai/glm-5.2", messages: [{ role: "user", content: "hi" }], stream: true, is_paid: true, max_completion_tokens: 32_000, max_tool_calls: 0 });
  assert.equal(ambient.body({ model: "ambient/large", messages: [] }).max_completion_tokens, 1024, "the default output bound");
  // a dead catalogue keeps the last good list
  const broken = new Ambient({ payer: null, fetch: async () => new Response("x", { status: 500 }) });
  assert.deepEqual(await broken.models(), []);
});

test("a chat: the quote's headers go on the paid request, the exact amount is paid, the stream comes back and folds", async () => {
  const { ambient, calls, payer } = world();
  const out = await ambient.chat({ model: "ambient/large", messages: [{ role: "user", content: "Say hello in five words." }], max_tokens: 200 });
  assert.equal(out.upstreamModel, "ambient/large");
  assert.equal(out.quote.micro, 896); assert.equal(out.quote.maxMicro, 946); assert.equal(out.quote.inputTokens, 11);
  assert.equal(out.paid.micro, 896); assert.equal(out.paid.settlement.transaction, "0xfeed");
  assert.equal(payer.paid.micro, 896);
  const paidCall = calls.find((c) => c.url.endsWith("/paid/chat/v2") && c.headers["payment-signature"]);
  assert.equal(paidCall.headers["x402-input-tokens"], "11"); assert.equal(paidCall.headers["x402-model-tier"], "standard");
  assert.equal(paidCall.body.is_paid, true); assert.equal(paidCall.body.stream, true); assert.equal(paidCall.body.max_completion_tokens, 200);
  const quoteCall = calls.find((c) => c.url.endsWith("/quote"));
  assert.deepEqual(quoteCall.body, paidCall.body, "the quote is for the very body that is sent");
  const text = await out.response.text();
  const j = foldSse(text, { model: "ambient/large" });
  assert.equal(j.object, "chat.completion"); assert.equal(j.id, "chatcmpl-1"); assert.equal(j.model, "ambient/large"); assert.equal(j.upstream_model, "z-ai/glm-5.2");
  assert.deepEqual(j.choices[0].message, { role: "assistant", content: "Hello there." }); assert.equal(j.choices[0].finish_reason, "stop");
  assert.deepEqual(j.usage, { prompt_tokens: 11, completion_tokens: 3 });
  assert.equal(foldSse("").choices[0].message.content, "");
});
