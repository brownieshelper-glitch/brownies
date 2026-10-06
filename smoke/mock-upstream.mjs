// A stand-in for OpenRouter, for the local test stack: the gateway's upstream without a key or the network.
// It answers the two routes the gateway uses, with a tiny model catalogue and a fixed reply that carries a cost,
// so the proxy and the billing can be tested end to end. Nothing here talks to any real model.
//   PORT=8793 node smoke/mock-upstream.mjs
import { createServer } from "node:http";

const port = Number(process.env.PORT || 8793);
const models = {
  data: [
    { id: "test/echo-cheap", name: "Test Echo (cheap)", context_length: 8192, pricing: { prompt: "0.0000001", completion: "0.0000002" }, architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
    { id: "test/echo", name: "Test Echo", context_length: 8192, pricing: { prompt: "0.000001", completion: "0.000002" }, architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
    { id: "test/painter", name: "Test Painter (no text)", context_length: 4096, pricing: { prompt: "0.00001", completion: "0" }, architecture: { input_modalities: ["text"], output_modalities: ["image"] } },
  ],
};
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => resolve(s)); });
let n = 0;

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/models") return json(res, 200, models);
  if (req.method === "POST" && url.pathname === "/chat/completions") {
    if (!(req.headers.authorization || "").startsWith("Bearer ")) return json(res, 401, { error: { message: "No upstream key.", code: 401 } });
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: { message: "Bad JSON.", code: 400 } }); }
    const model = models.data.find((m) => m.id === body.model);
    if (!model) return json(res, 400, { error: { message: `Unknown model ${body.model}.`, code: 400 } });
    const asked = String(body.messages?.[body.messages.length - 1]?.content || "");
    const content = "Hello from the test model. You asked: " + asked.slice(0, 80);
    const promptTokens = Math.max(1, Math.ceil(JSON.stringify(body.messages || "").length / 4)), completionTokens = 12;
    const cost = promptTokens * Number(model.pricing.prompt) + completionTokens * Number(model.pricing.completion);
    const id = "gen-test-" + (++n);
    const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, cost };
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: model.id, choices: [{ index: 0, delta: { role: "assistant", content } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: model.id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    return json(res, 200, { id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: model.id, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage });
  }
  json(res, 404, { error: { message: "No such route.", code: 404 } });
}).listen(port, "127.0.0.1", () => console.log(`mock upstream on http://127.0.0.1:${port}`));
