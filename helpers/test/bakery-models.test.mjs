// The Bakery's model list: OpenRouter's catalogue filtered to the main providers' text models with a price, no
// batch, free, image or code variants, the configured defaults first, cached; the configured list alone when the
// catalogue cannot be read; the caps: the trial cap before the launch, the holder's cap once live.
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./mock.mjs";
import { Bakery } from "../lib/bakery.mjs";

const CATALOGUE = { data: [
  { id: "anthropic/claude-sonnet-5.5", name: "Anthropic: Claude Sonnet 5.5", pricing: { prompt: "0.000002", completion: "0.00001" }, architecture: { output_modalities: ["text"] } },
  { id: "anthropic/claude-sonnet-5.5:batch", name: "Anthropic: Claude Sonnet 5.5 (batch)", pricing: { prompt: "0.000001", completion: "0.000005" }, architecture: { output_modalities: ["text"] } },
  { id: "anthropic/claude-opus-5.5", name: "Anthropic: Claude Opus 5.5", pricing: { prompt: "0.000004", completion: "0.00002" }, architecture: { output_modalities: ["text"] } },
  { id: "openai/gpt-5.5", name: "OpenAI: GPT-5.5", pricing: { prompt: "0.000005", completion: "0.00003" }, architecture: { output_modalities: ["text"] } },
  { id: "openai/gpt-5.5-pro", name: "OpenAI: GPT-5.5 Pro", pricing: { prompt: "0.00003", completion: "0.00018" }, architecture: { output_modalities: ["text"] } },
  { id: "openai/gpt-5.4-image-2", name: "OpenAI: GPT-5.4 Image 2", pricing: { prompt: "0.000008", completion: "0.000015" }, architecture: { output_modalities: ["image", "text"] } },
  { id: "openai/gpt-5.3-codex", name: "OpenAI: GPT-5.3-Codex", pricing: { prompt: "0.00000175", completion: "0.000014" }, architecture: { output_modalities: ["text"] } },
  { id: "google/gemini-3.8-flash", name: "Google: Gemini 3.8 Flash", pricing: { prompt: "0.00000075", completion: "0.00000375" }, architecture: { output_modalities: ["text"] } },
  { id: "google/gemini-3.1-flash-image", name: "Google: Nano Banana 2 (Gemini 3.1 Flash Image)", pricing: { prompt: "0.0000005", completion: "0.000003" }, architecture: { output_modalities: ["image", "text"] } },
  { id: "x-ai/grok-4.7", name: "SpaceXAI: Grok 4.7", pricing: { prompt: "0.000002", completion: "0.000006" }, architecture: { output_modalities: ["text"] } },
  { id: "deepseek/deepseek-v3.2", name: "DeepSeek: DeepSeek V3.2", pricing: { prompt: "0.00000028", completion: "0.00000042" }, architecture: { output_modalities: ["text"] } },
  { id: "meta-llama/llama-4-maverick:free", name: "Meta: Llama 4 Maverick (free)", pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text"] } },
  { id: "openai/whisper-1", name: "OpenAI: Whisper", pricing: { prompt: "0.000001", completion: "0.000001" }, architecture: { output_modalities: ["text"] } },
  { id: "someone/odd-model", name: "Someone: Odd", pricing: { prompt: "0.000001", completion: "0.000001" }, architecture: { output_modalities: ["text"] } },
] };

function bakery(W, { mode = "prelaunch", withCatalogue = true } = {}) {
  if (withCatalogue) W.fetch.on("GET", "openrouter.ai/api/v1/models", () => ({ json: CATALOGUE }));
  const world = { S: { mode, telegram: { ownerChatId: "999" }, gatewayUrl: "https://gw.test", openrouterUrl: "https://openrouter.ai/api/v1" }, store: W.store, clock: W.clock, brain: W.brain, telegram: W.telegram, gateway: W.gateway, config: { chainId: 1, timezone: "UTC" } };
  return new Bakery({ W: world, origins: [], hire: async () => null, fire: async () => true, recruits: () => [], roster: () => [], config: { models: ["anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-5.5"], maxCapUsd: 50, trialCapUsd: 1, defaultCapUsd: 1 }, fetch: W.fetch });
}

test("the catalogue: main providers, text models with a price, no variants, images, code or audio; defaults first; names without the provider prefix; prices per million", async () => {
  const W = makeWorld();
  const b = bakery(W);
  const list = await b.catalogue();
  assert.deepEqual(list.map((m) => m.id), [
    "anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-5.5", // the configured defaults, first (haiku is not in the catalogue but stays offered)
    "anthropic/claude-opus-5.5", "deepseek/deepseek-v3.2", "google/gemini-3.8-flash", "openai/gpt-5.5-pro", "openai/gpt-5.5", "x-ai/grok-4.7",
  ]);
  const opus = list.find((m) => m.id === "anthropic/claude-opus-5.5");
  assert.deepEqual(opus, { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", provider: "Anthropic", in: 4, out: 20 });
  assert.equal(list.find((m) => m.id === "x-ai/grok-4.7").provider, "xAI");
  assert.equal(list.find((m) => m.id === "anthropic/claude-haiku-4.5").in, null, "no price known for a default the catalogue lacks");
  const calls = W.fetch.callsTo("openrouter.ai/api/v1/models").length;
  await b.catalogue();
  assert.equal(W.fetch.callsTo("openrouter.ai/api/v1/models").length, calls, "cached");
  W.clock.advance(2 * 3_600_000);
  await b.catalogue();
  assert.equal(W.fetch.callsTo("openrouter.ai/api/v1/models").length, calls + 1, "read again after an hour");
  const info = await b.info();
  assert.equal(info.models.length, 8);
  assert.equal(info.maxCapUsd, 1, "before the launch the trial cap");
  assert.equal(info.liveMaxCapUsd, 50);
  assert.equal(info.defaultCapUsd, 1);
});

test("without the catalogue the configured list stands; live, the cap is the holder's", async () => {
  const W = makeWorld();
  const b = bakery(W, { withCatalogue: false, mode: "live" });
  const list = await b.catalogue();
  assert.deepEqual(list.map((m) => m.id), ["anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-5.5"]);
  assert.equal(list[0].name, "claude-haiku-4.5");
  const info = await b.info();
  assert.equal(info.maxCapUsd, 50);
  assert.equal(info.defaultCapUsd, 1);
  assert.equal(b.capUsd(), 50);
});
