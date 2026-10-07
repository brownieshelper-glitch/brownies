// Ambient's JumpGate: inference paid per request with USDC on Base over x402, no account, no key, no card. The
// gateway lists Ambient's catalogue next to OpenRouter's under ids that start with "ambient/" (their own alias
// "ambient/large" stays as it is), asks JumpGate for a quote (the price of this request: input tokens plus the
// output bound), then sends the request through the pantry's X402Payer, which pays the quoted amount when JumpGate
// answers 402. The answer is a stream of server-sent events in the OpenAI shape. Docs: ambient.xyz/docs/build/x402.
export const JUMPGATE = "https://jumpgate.ambient.xyz";
export const CATALOGUE = "https://api.ambient.xyz/v1/models";
export const PREFIX = "ambient/";
const ALIASES = new Set(["ambient/large", "ambient/mini"]);
const MAX_OUTPUT = 32_000;

export class Ambient {
  constructor({ payer, fetch = globalThis.fetch, baseUrl = JUMPGATE, catalogueUrl = CATALOGUE, now = () => Date.now(), log = () => {} }) {
    this.payer = payer; this.fetch = fetch; this.baseUrl = baseUrl.replace(/\/$/, ""); this.catalogueUrl = catalogueUrl;
    this.now = now; this.log = log; this.cache = null;
  }

  /// Our model ids for Ambient's: "ambient/large" stays, "z-ai/glm-5.2" becomes "ambient/z-ai/glm-5.2".
  isOurs(id) { return typeof id === "string" && id.startsWith(PREFIX); }
  upstreamModel(id) { return ALIASES.has(id) ? id : id.slice(PREFIX.length); }
  ourId(upstreamId) { return ALIASES.has(upstreamId) ? upstreamId : PREFIX + upstreamId; }

  /// The catalogue in the OpenRouter shape (pricing per token as strings), cached an hour; the last good list when
  /// the catalogue cannot be read, an empty list when it never could.
  async models() {
    if (this.cache && this.now() - this.cache.at < 3_600_000) return this.cache.list;
    try {
      const r = await this.fetch(this.catalogueUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`catalogue ${r.status}`);
      const j = await r.json();
      const list = (j.data || []).filter((m) => m && m.id && m.is_ready !== false).map((m) => ({
        id: this.ourId(m.id), name: m.name || m.id, upstream: m.id, provider: "ambient", paid: "x402 USDC on Base",
        context_length: m.context_length,
        pricing: { prompt: String(m.pricing?.prompt ?? (Number(m.pricing?.input || 0) / 1e6)), completion: String(m.pricing?.completion ?? (Number(m.pricing?.output || 0) / 1e6)) },
        description: `${m.name || m.id} on Ambient, paid per request in USDC on Base.`,
      }));
      this.cache = { at: this.now(), list };
      return list;
    } catch (e) {
      this.log(`[ambient] catalogue not read: ${e.message}`);
      return this.cache?.list || [];
    }
  }

  /// The body JumpGate takes: our model id translated, always a paid stream, the output bounded, no tools.
  body(body) {
    const max = Math.min(Math.max(Number(body.max_completion_tokens || body.max_tokens) || 1024, 1), MAX_OUTPUT);
    const b = { ...body, model: this.upstreamModel(body.model), stream: true, is_paid: true, max_completion_tokens: max, max_tool_calls: 0 };
    delete b.max_tokens; delete b.usage; delete b.stream_options; delete b.tools; delete b.tool_choice;
    return b;
  }

  /// The price of this request, from JumpGate: { headers, micro, maxMicro, inputTokens, outputTokens, tier }.
  async quote(upstreamBody) {
    const r = await this.fetch(`${this.baseUrl}/paid/chat/v2/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(upstreamBody), signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Ambient quote ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const micro = Number(j.amount_micro_usdc) || 0;
    return { headers: j.headers || {}, micro, maxMicro: Number(j.max_amount_micro_usdc) || micro, inputTokens: Number(j.input_tokens) || 0, outputTokens: Number(j.output_tokens) || 0, tier: j.model_tier || null };
  }

  /// The paid request: quote, then the stream through the payer. Returns { response, paid, quote, upstreamModel }.
  async chat(body, { quote = null } = {}) {
    const up = this.body(body);
    const q = quote || await this.quote(up);
    const { response, paid } = await this.payer.fetch(`${this.baseUrl}/paid/chat/v2`, {
      method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream", ...q.headers }, body: JSON.stringify(up),
    });
    return { response, paid, quote: q, upstreamModel: up.model };
  }
}

/// A stream of chat events folded into one chat.completion: the content joined, the last finish_reason, the usage.
export function foldSse(text, { model = "" } = {}) {
  let id = null, created = Math.floor(Date.now() / 1000), upstreamModel = null, role = "assistant", finish = null, usage = null, content = "", reasoning = "";
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let j; try { j = JSON.parse(data); } catch { continue; }
    if (j.id) id = j.id;
    if (j.created) created = j.created;
    if (j.model) upstreamModel = j.model;
    if (j.usage) usage = j.usage;
    const ch = Array.isArray(j.choices) ? j.choices[0] : null;
    if (!ch) continue;
    const d = ch.delta || ch.message || {};
    if (d.role) role = d.role;
    if (typeof d.content === "string") content += d.content;
    if (typeof d.reasoning === "string") reasoning += d.reasoning;
    if (ch.finish_reason) finish = ch.finish_reason;
  }
  const message = { role, content };
  if (reasoning) message.reasoning = reasoning;
  return { id: id || `ambient-${created}`, object: "chat.completion", created, model: model || upstreamModel || "", upstream_model: upstreamModel || undefined, choices: [{ index: 0, message, finish_reason: finish || "stop" }], usage: usage || undefined };
}
