// What a request may cost and what it did cost, as plain arithmetic (server.mjs wires it to the ledger).
// Written after the code review of 2026-10-12, whose findings on this were: the hold was estimated from the messages
// alone while the whole body went upstream; an answer with no usage line was billed nothing; a catalogue price below
// zero (a router with a variable price says -1) made a negative hold, which reads as more balance.

/// How many UTF-8 bytes one token is taken to be when a prompt is estimated. Low on purpose: JSON, tool schemas,
/// digits and non-Latin text are denser than prose, and the hold must not come out under the cost.
export const BYTES_PER_TOKEN = 2.5;
/// What one image is taken to cost in prompt tokens when the model states no price per image.
export const IMAGE_TOKENS = 3000;

/// A catalogue price as dollars per token: a finite number from 0 up, or null when the catalogue states none.
export function price(v) {
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
/// The model's prices, or null when it has no fixed price to hold against (such a model is not served).
export function prices(model) {
  const p = model?.pricing || {};
  const prompt = price(p.prompt), completion = price(p.completion), request = price(p.request), image = price(p.image);
  return [prompt, completion, request, image].some((x) => x === null) ? null : { prompt, completion, request, image };
}
/// The output bound of a body: the larger of max_tokens and max_completion_tokens (a body may carry both).
export function maxOut(body) {
  return Math.max(Number(body?.max_tokens) || 0, Number(body?.max_completion_tokens) || 0) || 1024;
}
/// The body as it is measured for the prompt: everything that goes upstream and is read by the model (the messages,
/// the tools, the schemas), with each inline image's bytes taken out (an image is counted apart, not as text).
function measured(body) {
  const { max_tokens, max_completion_tokens, stream, stream_options, usage, ...rest } = body || {};
  let images = 0;
  const text = JSON.stringify(rest, (k, v) => {
    if (typeof v === "string" && /^data:image\//i.test(v)) { images++; return "data:image"; }
    if (k === "type" && v === "image_url") return v;
    return v;
  }) || "";
  // an image given by its address is one too
  const linked = (text.match(/"type":"image_url"/g) || []).length;
  return { bytes: Buffer.byteLength(text, "utf8"), images: Math.max(images, linked) };
}
/// The prompt estimate in tokens.
export function promptTokens(body) {
  const m = measured(body);
  return Math.ceil(m.bytes / BYTES_PER_TOKEN) + m.images * IMAGE_TOKENS;
}
/// The most a request could cost, in micro-dollars. null when the model has no fixed price.
export function worstCaseMicro(model, body, multiplier = 1) {
  const p = prices(model);
  if (!p) return null;
  const m = measured(body);
  const dollars = promptTokens(body) * p.prompt + maxOut(body) * p.completion + p.request + m.images * p.image;
  return Math.ceil(dollars * 1e6 * multiplier);
}
/// The prompt's share alone: what the upstream read, whatever came of the answer.
export function promptMicro(model, body, multiplier = 1) {
  const p = prices(model);
  return p ? Math.ceil((promptTokens(body) * p.prompt + p.request) * 1e6 * multiplier) : 0;
}
/// What a finished call costs. The upstream's stated cost when it gives one; else its token counts at the catalogue's
/// prices; else, when it said nothing of what it used (a stream cut before its last line, an error after the answer
/// began), the prompt estimate plus the text that was actually delivered. Never less than 0, never NaN.
export function billedMicro(model, usage, { multiplier = 1, body = null, deliveredChars = 0 } = {}) {
  const p = prices(model) || { prompt: 0, completion: 0, request: 0, image: 0 };
  const cost = Number(usage?.cost);
  if (usage && Number.isFinite(cost) && cost > 0) return Math.ceil(cost * 1e6 * multiplier);
  const inTok = Number(usage?.prompt_tokens) || 0, outTok = Number(usage?.completion_tokens) || 0;
  if (usage && (inTok > 0 || outTok > 0)) return Math.max(0, Math.ceil((inTok * p.prompt + outTok * p.completion + p.request) * 1e6 * multiplier));
  if (!body) return 0;
  const out = Math.ceil(Math.max(0, Number(deliveredChars) || 0) / BYTES_PER_TOKEN);
  return Math.max(0, Math.ceil((promptTokens(body) * p.prompt + out * p.completion + p.request) * 1e6 * multiplier));
}
/// The call that goes upstream is the call that was priced. Taken out of the body: the fields that could send it to
/// another model (a list of models, a route), the paid extras a hold does not see (a web search is billed per result),
/// a count of answers (the hold is for one). And with the model given, no provider dearer than the catalogue's price
/// may serve it (provider.max_price, in dollars per million tokens): the hold is worked out from that price, and a
/// caller who names a dearer provider would otherwise get its tokens at the cheaper one's price. The caller's other
/// provider choices (data policy, order) stay.
export function pinModel(body, model = null) {
  delete body.models; delete body.route;
  delete body.plugins; delete body.web_search_options;
  delete body.n;
  const p = model ? prices(model) : null;
  if (p) {
    const mine = body.provider && typeof body.provider === "object" && !Array.isArray(body.provider) ? body.provider : {};
    body.provider = { ...mine, max_price: { prompt: perMillion(p.prompt), completion: perMillion(p.completion) } };
  }
  return body;
}
/// A price per token as dollars per million tokens, without the dust of floating point (0.00000132 times a million is
/// 1.3200000000000003; a limit that came out a hair under the price would shut the model out).
const perMillion = (perToken) => Number((perToken * 1e6).toFixed(6));
/// The text of the answer in a stream's data line, for counting what was delivered. "" when the line carries none.
export function deltaText(json) {
  const c = json?.choices?.[0];
  const d = c?.delta || c?.message || {};
  return (typeof d.content === "string" ? d.content : "") + (typeof d.reasoning === "string" ? d.reasoning : "");
}
