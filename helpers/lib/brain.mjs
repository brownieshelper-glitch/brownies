// Thinking, and what it costs. One OpenAI-style chat client for the four brownies.
//
//   MODE=prelaunch  the call goes to OpenRouter with OPENROUTER_API_KEY; the response's usage.cost (dollars) is the
//                   price. Each helper has a daily dollar cap and stops when it is reached.
//   MODE=live       the call goes to the gateway (POST /v1/chat/completions) with the helper's own key: its wallet
//                   signs "Brownies API key, chain 1, epoch N" (gateway/auth.mjs). The helper stops when GET /v1/key
//                   says its balance is under a few cents. The balance is SUGAR the vault fed it, and tips.
//
// Both modes count every call in the store (spend per helper per day) and return cost_micro for the job's report.
import { Wallet } from "ethers";

// the same two lines as gateway/auth.mjs and the site: the runtime is deployed alone, so they are repeated here
export const keyMessage = (chainId, epoch) => `Brownies API key, chain ${chainId}, epoch ${epoch}`;
export const keyFromSignature = (sig, epoch) => `sk-brownie-${epoch}-` + Buffer.from(sig.slice(2), "hex").toString("base64url");

export class BudgetError extends Error {
  constructor(helper, reason) { super(`${helper} is out of budget: ${reason}`); this.helper = helper; this.reason = reason; this.budget = true; }
}

const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";
export const REASONING_HEADROOM = 800; // tokens of thinking a Claude 5 model may spend before the answer (measured: about 250 on a research note)
export const DEFAULT_REASONING = { effort: "low" }; // measured: zero thinking tokens on our jobs, the whole budget goes to the answer

export class Brain {
  /// helpers: { fudge: { model, dailyCapUsd }, ... }   keys: { fudge: "0x...", ... } (live only)
  constructor({ mode = "prelaunch", openrouterKey = "", openrouterUrl = "https://openrouter.ai/api/v1", gateway = null, keys = {}, chainId = 1, helpers = {}, store, clock, fetch = globalThis.fetch, alerts = null, minBalanceMicro = 50_000, log = () => {} }) {
    if (!["prelaunch", "live"].includes(mode)) throw new Error("mode must be prelaunch or live");
    Object.assign(this, { mode, openrouterKey, openrouterUrl: openrouterUrl.replace(/\/$/, ""), gateway, keys, chainId, helpers, store, clock, fetch, alerts, minBalanceMicro, log });
    this.wallets = new Map(); this.keyCache = new Map(); this.balanceCache = new Map();
    this.calls = 0;
  }

  model(helper) { return this.helpers[helper]?.model || DEFAULT_MODEL; }
  capMicro(helper) { return Math.round((this.helpers[helper]?.dailyCapUsd ?? 1) * 1e6); }

  wallet(helper) {
    if (!this.wallets.has(helper)) {
      if (!this.keys[helper]) throw new Error(`${helper} has no wallet key (${helper.toUpperCase()}_PRIVATE_KEY)`);
      this.wallets.set(helper, new Wallet(this.keys[helper]));
    }
    return this.wallets.get(helper);
  }
  address(helper) { return this.wallet(helper).address; }

  /// The helper's gateway key for its current epoch. `fresh` re-reads the epoch (after a key_revoked answer).
  async key(helper, { fresh = false } = {}) {
    if (!fresh && this.keyCache.has(helper)) return this.keyCache.get(helper);
    const w = this.wallet(helper);
    const acc = await this.gateway.account(w.address);
    const epoch = Number(acc.body?.epoch ?? 0);
    const sig = await w.signMessage(keyMessage(this.chainId, epoch));
    const k = { epoch, key: keyFromSignature(sig, epoch) };
    this.keyCache.set(helper, k);
    return k;
  }

  /// Live balance in micro-dollars, re-read at most once a minute. Null when the gateway did not answer.
  async balanceMicro(helper, { fresh = false } = {}) {
    const c = this.balanceCache.get(helper);
    if (!fresh && c && this.clock.now() - c.at < 60_000) return c.micro;
    let k = await this.key(helper);
    let r = await this.gateway.key(k.key);
    if (r.status === 401) { k = await this.key(helper, { fresh: true }); r = await this.gateway.key(k.key); }
    if (!r.ok) return null;
    const micro = Math.round(Number(r.body?.balance?.available || 0) * 1e6);
    this.balanceCache.set(helper, { at: this.clock.now(), micro });
    return micro;
  }

  /// Can this helper think right now? { ok, reason, spentMicro, capMicro, balanceMicro }.
  async canSpend(helper) {
    const now = this.clock.now();
    const spent = this.store.spentToday(helper, now).micro;
    const cap = this.capMicro(helper);
    if (spent >= cap) return { ok: false, reason: `daily cap of ${(cap / 1e6).toFixed(2)} USD reached`, spentMicro: spent, capMicro: cap };
    if (this.mode === "live") {
      const bal = await this.balanceMicro(helper);
      if (bal === null) return { ok: false, reason: "the gateway did not answer", spentMicro: spent, capMicro: cap, balanceMicro: null };
      if (bal < this.minBalanceMicro) return { ok: false, reason: `gateway balance ${(bal / 1e6).toFixed(4)} USD`, spentMicro: spent, capMicro: cap, balanceMicro: bal };
      return { ok: true, reason: "", spentMicro: spent, capMicro: cap, balanceMicro: bal };
    }
    return { ok: true, reason: "", spentMicro: spent, capMicro: cap };
  }

  async budgetOrThrow(helper) {
    const c = await this.canSpend(helper);
    if (!c.ok) { await this.alerts?.budget(helper, c.reason); throw new BudgetError(helper, c.reason); }
    return c;
  }

  /// One chat completion. Returns { text, costMicro, model, usage }. Throws BudgetError when the helper cannot pay.
  async chat(helper, { system = "", messages = [], prompt = "", maxTokens = 600, temperature = 0.7, reasoning = DEFAULT_REASONING } = {}) {
    await this.budgetOrThrow(helper);
    const list = [];
    if (system) list.push({ role: "system", content: system });
    list.push(...messages);
    if (prompt) list.push({ role: "user", content: prompt });
    // Claude 5 models think before they answer and that thinking is counted inside max_tokens. OpenRouter refuses
    // to switch it off, but "effort: low" leaves it at zero tokens on these jobs (measured), so that is the default;
    // a call may ask for more. The headroom stays as a belt to the braces.
    const body = { model: this.model(helper), messages: list, max_tokens: maxTokens + REASONING_HEADROOM, temperature, usage: { include: true } };
    if (reasoning) body.reasoning = reasoning;
    const j = this.mode === "live" ? await this._viaGateway(helper, body) : await this._viaOpenRouter(helper, body);
    if (j?.choices?.[0]?.finish_reason === "length") this.log(`[brain] ${helper}'s answer was cut at ${body.max_tokens} tokens (${j.usage?.completion_tokens_details?.reasoning_tokens ?? "?"} of them thinking)`);
    const text = j?.choices?.[0]?.message?.content ?? "";
    const usage = j?.usage || {};
    let costMicro = Math.ceil(Number(usage.cost || 0) * 1e6);
    if (!costMicro && j?.brownies?.charged_usd) costMicro = Math.ceil(Number(j.brownies.charged_usd) * 1e6);
    const now = this.clock.now();
    this.store.addSpend(helper, costMicro, now);
    this.calls++;
    if (this.store.spentToday(helper, now).micro >= this.capMicro(helper)) await this.alerts?.budget(helper, `daily cap of ${(this.capMicro(helper) / 1e6).toFixed(2)} USD reached`);
    if (this.mode === "live") this.balanceCache.delete(helper);
    return { text: typeof text === "string" ? text : JSON.stringify(text), costMicro, model: body.model, usage };
  }

  /// A yes/no question to a model. Yes only when the first word of the answer is yes.
  async yesNo(helper, opts) {
    const r = await this.chat(helper, { ...opts, temperature: 0.2, maxTokens: opts.maxTokens || 200 });
    const t = r.text.trim();
    return { yes: /^\W*yes\b/i.test(t), text: t, costMicro: r.costMicro };
  }

  async _viaOpenRouter(helper, body) {
    const r = await this.fetch(`${this.openrouterUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.openrouterKey}`, "content-type": "application/json", "HTTP-Referer": "https://feedthebrownies.com", "X-Title": "Brownies helpers" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => null);
    if (r.status === 401 || r.status === 403) { await this.alerts?.credentials("openrouter", `OpenRouter answered ${r.status}`); throw new Error(`OpenRouter refused the key (${r.status})`); }
    if (r.status === 402) { await this.alerts?.budget(helper, "the OpenRouter balance is empty"); throw new BudgetError(helper, "the OpenRouter balance is empty"); }
    if (!r.ok) throw new Error(`OpenRouter answered ${r.status}: ${j?.error?.message || "no detail"}`.slice(0, 200));
    return j;
  }

  async _viaGateway(helper, body) {
    let k = await this.key(helper);
    let r = await this.gateway.chat(k.key, body);
    if (r.status === 401 && r.body?.error?.code === "key_revoked") { k = await this.key(helper, { fresh: true }); r = await this.gateway.chat(k.key, body); }
    if (r.status === 401) { await this.alerts?.credentials("gateway", `the gateway refused ${helper}'s key`); throw new Error(`the gateway refused ${helper}'s key`); }
    if (r.status === 402) { this.balanceCache.delete(helper); await this.alerts?.budget(helper, "gateway balance too low"); throw new BudgetError(helper, "gateway balance too low"); }
    if (r.status < 200 || r.status >= 300) throw new Error(`the gateway answered ${r.status}: ${r.body?.error?.message || "no detail"}`.slice(0, 200));
    return r.body;
  }
}
