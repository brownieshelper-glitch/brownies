// A real chat through the Brownies gateway, to prove the proxy and the billing with a live upstream.
//   node smoke/chat-check.mjs <gateway url> <sk-brownie key> [model id]
// With no model given it tries free models (":free"), which cost nothing, until one answers. Give a paid model id
// to see a real charge land on the key's balance. Prints only replies, usage and balances, never a key.
const [gw, key, wanted] = process.argv.slice(2);
if (!gw || !key) {
  console.error("usage: node smoke/chat-check.mjs <gateway> <key> [model]");
  process.exit(2);
}
const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
const balance = async () => (await (await fetch(`${gw}/v1/key`, { headers })).json()).balance;

const all = (await (await fetch(`${gw}/v1/models`)).json()).data || [];
const textOut = (m) => (m.architecture?.output_modalities || []).includes("text");
const candidates = wanted ? [wanted] : all.filter((m) => m.id.endsWith(":free") && textOut(m)).slice(0, 8).map((m) => m.id);
console.log(`models in the catalogue: ${all.length}; trying: ${candidates.slice(0, 3).join(", ")}${candidates.length > 3 ? ", ..." : ""}`);
console.log("balance before:", JSON.stringify(await balance()));

let model = null;
for (const id of candidates) {
  const r = await fetch(`${gw}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: id, messages: [{ role: "user", content: "Say hello in five words." }], max_tokens: 400 }),
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok && j.choices?.[0]) {
    model = id;
    console.log(`plain call, ${id}: http ${r.status}`);
    console.log("  reply:", JSON.stringify(j.choices[0].message?.content ?? ("(reasoning) " + String(j.choices[0].message?.reasoning || "").slice(0, 160))));
    console.log("  usage:", JSON.stringify({ prompt: j.usage?.prompt_tokens, completion: j.usage?.completion_tokens, cost: j.usage?.cost }));
    console.log("  gateway:", JSON.stringify(j.brownies));
    break;
  }
  console.log(`  ${id}: http ${r.status} ${JSON.stringify(j.error?.message || j.error || "").slice(0, 120)}`);
}
if (!model) {
  console.log("no model answered");
  process.exit(1);
}

// the same model, streamed: the gateway must pass the chunks through and still find the usage at the end
const r = await fetch(`${gw}/v1/chat/completions`, {
  method: "POST",
  headers,
  body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "Count from one to five." }], max_tokens: 400 }),
});
let text = "", chunks = 0, sawUsage = false, buf = "";
const dec = new TextDecoder();
for await (const part of r.body) {
  buf += dec.decode(part, { stream: true });
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") continue;
    try {
      const j = JSON.parse(data);
      chunks++;
      if (j.usage) sawUsage = true;
      text += j.choices?.[0]?.delta?.content || "";
    } catch {}
  }
}
console.log(`streamed call: http ${r.status}, ${chunks} chunks, usage in stream: ${sawUsage}`);
console.log("  reply:", JSON.stringify(text.slice(0, 120)));
console.log("balance after:", JSON.stringify(await balance()));
