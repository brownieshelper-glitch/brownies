// The Brownies gateway. OpenAI-style API in front of OpenRouter, billed to SUGAR activations read from Robinhood Chain.
//
//   GET  /v1/models                     the model catalogue with prices (OpenRouter's, cached)
//   GET  /v1/key                        the key's balance: { balance: { currency, available, used }, wallet, epoch }
//   POST /v1/key/rotate                 bump the epoch: every older key dies on its next request
//   POST /v1/chat/completions           chat, streaming or not, charged after the call at OpenRouter's stated cost
//   GET  /v1/grants                     the grants this wallet gave and received, with today's room
//   POST /v1/grants                     { grantee, daily_usd } let another wallet spend from this balance, so much a day
//   POST /v1/grants/revoke              { grantee } end that grant
//   A grantee pays from a grant by adding the header X-Brownies-Pay-From: <granter wallet> to /v1/key and
//   /v1/chat/completions: the charge lands on the granter, within the grant's daily cap (the Bakery's holders fund
//   their brownies this way).
//   GET  /api/protocol/stats            public totals: activations, spend, requests, on-chain harvester figures
//   GET  /api/protocol/account/:wallet  public: that wallet's balance and recent activity
//   POST /api/protocol/index-tx         { tx } credit an activation the indexer has not reached yet
//   GET  /api/team/activity             public: what the brownies reported (?limit= ?before= ?helper= ?kind=
//                                       ?order=asc ?offset=)
//   GET  /api/team/towers               public: the jobs done, 100 to a tower: bricks and dates of each tower
//   GET  /api/team/summary              public: per brownie counts, its current task, the last 7 days by kind
//   POST /api/team/log                  the brownies report here (one entry or up to 20), with the team key
//   GET  /health
//
// A key is the wallet's signature of "Brownies API key, chain 4663, epoch N" (auth.mjs). One SUGAR atom is one
// micro-dollar of balance. The gateway never holds a private key for any user and never moves tokens.
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { Ledger } from "./ledger.mjs";
import { Chain } from "./chain.mjs";
import { TeamLog, clean as cleanEntry, isHelperName, KINDS } from "./teamlog.mjs";
import { verifyKey, err, keyMessage, beneficiaryToWallet, walletToBeneficiary, parseWallet } from "./auth.mjs";

// ---- config ----
// The secrets file lives outside the project folder (which syncs to OneDrive): BROWNIES_GATEWAY_ENV names it.
// A local ./.env is read after it, for anything not already set. Lines saved by Notepad (CRLF) are fine.
for (const f of [process.env.BROWNIES_GATEWAY_ENV, new URL("./.env", import.meta.url)]) {
  if (!f || !existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] !== "" && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
}
import { Wallet as PantryWallet, JsonRpcProvider as PantryProvider } from "ethers";
import { X402Payer } from "./x402.mjs";
import { Ambient, foldSse } from "./ambient.mjs";
import { RelayBridge } from "./bridge.mjs";
import { Pantry } from "./pantry.mjs";

const cfg = {
  port: Number(process.env.PORT || 8790),
  rpcUrl: process.env.RPC_URL || "https://ethereum-rpc.publicnode.com",
  chainId: Number(process.env.CHAIN_ID || 1),
  sugarAddress: process.env.SUGAR_ADDRESS,
  harvesterAddress: process.env.HARVESTER_ADDRESS || "",
  ledgerAddress: process.env.LEDGER_ADDRESS || "", // Programmable's fee ledger for the coin
  teamVaultAddress: process.env.TEAM_VAULT_ADDRESS || "",
  startBlock: Number(process.env.START_BLOCK || 0),
  // the keeper's floors: claim once this much WETH waits, keep this much ETH for gas, release once the day's budget is worth this
  claimMinEth: Number(process.env.CLAIM_MIN_ETH || 0.05),
  keeperFloorEth: Number(process.env.KEEPER_FLOOR_ETH || 0.01),
  releaseMinSugar: Number(process.env.RELEASE_MIN_SUGAR || 1),
  openrouterKey: process.env.OPENROUTER_API_KEY || "",
  openrouterUrl: (process.env.OPENROUTER_URL || "https://openrouter.ai/api/v1").replace(/\/$/, ""),
  dbPath: process.env.DB_PATH || "./data/gateway.sqlite",
  keeperPrivateKey: process.env.KEEPER_PRIVATE_KEY || "",
  claimEverySeconds: Number(process.env.CLAIM_EVERY_SECONDS || 300),
  priceMultiplier: Number(process.env.PRICE_MULTIPLIER || 1),
  minBalanceMicro: 10_000, // a request needs at least one cent of balance
  // the pantry: the wallet that pays Ambient per request over x402 with USDC on Base; empty = Ambient's models are not offered
  pantryKey: process.env.PANTRY_PRIVATE_KEY || "",
  baseRpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
  x402MaxUsd: Number(process.env.X402_MAX_USD_PER_REQUEST || 2),
  pantryBridgeMinUsdc: Number(process.env.PANTRY_BRIDGE_MIN_USDC || 20),
  pantryEverySeconds: Number(process.env.PANTRY_EVERY_SECONDS || 600),
  // the key the brownies send with their reports; under 24 characters counts as not set, and the log stays closed
  teamLogKey: (process.env.TEAM_LOG_KEY || "").length >= 24 ? process.env.TEAM_LOG_KEY : "",
};
// Before the launch there is no SUGAR address: the gateway still serves the brownies' reports, and every
// money route answers "not launched yet" until SUGAR_ADDRESS is set and the service restarted.
cfg.live = /^0x[0-9a-fA-F]{40}$/.test(cfg.sugarAddress || "");
if (!cfg.live) console.log("[gateway] SUGAR_ADDRESS not set: running without the chain, reports only");

const ledger = new Ledger(cfg.dbPath);
const chain = cfg.live ? new Chain(cfg, ledger) : null;
const team = new TeamLog(ledger.db);

// ---- the pantry and Ambient: inference paid per request, no account anywhere ----
let pantry = null, ambient = null;
if (/^0x[0-9a-fA-F]{64}$/.test(cfg.pantryKey)) {
  const payer = new X402Payer({ privateKey: cfg.pantryKey, chainId: 8453, maxMicro: Math.round(cfg.x402MaxUsd * 1e6), log: console.log });
  ambient = new Ambient({ payer, log: console.log });
  // the bridge moves the fees' USDC from Ethereum to Base; only when this gateway's chain is Ethereum
  const bridge = cfg.chainId === 1 ? new RelayBridge({ wallet: new PantryWallet(cfg.pantryKey, new PantryProvider(cfg.rpcUrl, 1, { staticNetwork: true })), log: console.log }) : null;
  pantry = new Pantry({ privateKey: cfg.pantryKey, ethRpcUrl: cfg.rpcUrl, baseRpcUrl: cfg.baseRpcUrl, bridge, payer, bridgeMinUsdc: cfg.pantryBridgeMinUsdc, everySeconds: cfg.pantryEverySeconds, log: console.log });
  console.log(`[gateway] pantry ${pantry.address}: Ambient's models offered, paid per request on Base${bridge ? ", USDC bridged from Ethereum by Relay" : ""}`);
}

// ---- helpers ----
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
};
const oaiError = (res, e) => json(res, e.status || 500, { error: { message: e.message, type: e.status === 401 ? "authentication_error" : e.status === 402 ? "insufficient_balance" : "api_error", code: e.code || "error" } });
const readBody = (req, limit = 4 * 1024 * 1024, res = null) => new Promise((resolve, reject) => {
  let size = 0, over = false; const chunks = [];
  req.on("data", (c) => {
    if (over) return;
    size += c.length;
    if (size > limit) {
      // the answer goes out first, then the connection is closed: a client that sent too much is told so
      over = true; req.pause();
      if (res && !res.headersSent) { res.setHeader("connection", "close"); res.once("finish", () => req.destroy()); } else req.destroy();
      reject(err(413, "too_large", `Body over ${Math.round(limit / 1024 / 1024) || 1} MB.`));
    } else chunks.push(c);
  });
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});
/// The body as a JSON object; anything else (bad JSON, null, a list, a number) is a 400, never a crash.
const parseObject = (raw) => {
  let v;
  try { v = JSON.parse(raw); } catch { throw err(400, "bad_json", "Body is not JSON."); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw err(400, "bad_json", "Body must be a JSON object.");
  return v;
};
/// The address a request came from: behind a proxy on this machine, the last X-Forwarded-For value.
const clientIp = (req) => {
  const sock = String(req.socket?.remoteAddress || "");
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean);
  return /^(::1|127\.|::ffff:127\.)/.test(sock) && fwd.length ? fwd[fwd.length - 1] : sock || "?";
};
/// A small allowance per address for the routes anyone may call that cost the gateway a chain call.
const buckets = new Map();
const allow = (key, perMinute) => {
  const now = Date.now(), list = (buckets.get(key) || []).filter((t) => now - t < 60_000);
  if (list.length >= perMinute) { buckets.set(key, list); return false; }
  list.push(now); buckets.set(key, list);
  if (buckets.size > 5000) for (const [k, v] of buckets) if (!v.length || now - v[v.length - 1] > 60_000) buckets.delete(k);
  return true;
};
const indexMisses = new Map(); // tx -> when it was last looked up and not found
const bearer = (req) => { const h = req.headers.authorization || ""; return h.startsWith("Bearer ") ? h.slice(7).trim() : ""; };
const dollars = (micro) => (micro / 1e6).toFixed(6);
const sha = (v) => createHash("sha256").update(String(v)).digest();
const sameSecret = (a, b) => timingSafeEqual(sha(a), sha(b));

function authed(req) {
  const k = verifyKey(bearer(req), cfg.chainId);
  const bal = ledger.balance(k.beneficiary);
  if (k.epoch !== bal.epoch) throw err(401, "key_revoked", `This key carries epoch ${k.epoch}; the wallet's current epoch is ${bal.epoch}. Sign the current message.`);
  return { ...k, bal };
}

const PAY_FROM = "x-brownies-pay-from";
/// Who pays for this request: the key's own balance, or the grant a granter named in the header gave this wallet.
function payer(req, who) {
  const from = parseWallet(req.headers[PAY_FROM], "X-Brownies-Pay-From");
  if (!from) return { beneficiary: who.beneficiary, availableMicro: who.bal.availableMicro, grant: null };
  const granter = walletToBeneficiary(from);
  const room = ledger.grantRoom(granter, who.wallet);
  if (!room) throw err(403, "no_grant", `${from} has not granted ${who.wallet} any spending.`);
  return { beneficiary: granter, availableMicro: room.roomMicro, grant: { from, ...room } };
}
const grantView = (g) => ({ granter: beneficiaryToWallet(g.granter), grantee: g.grantee, daily_usd: dollars(g.dailyMicro), spent_today_usd: dollars(g.spentMicro), room_today_usd: dollars(g.roomMicro), calls_today: g.calls, day: g.day, created: g.created });

// ---- models cache ----
let modelsCache = { at: 0, body: null, byId: new Map() };
async function models() {
  if (Date.now() - modelsCache.at < 10 * 60 * 1000 && modelsCache.body) return modelsCache;
  const r = await fetch(`${cfg.openrouterUrl}/models`, { headers: cfg.openrouterKey ? { authorization: `Bearer ${cfg.openrouterKey}` } : {} });
  if (!r.ok) throw err(502, "upstream", `models upstream ${r.status}`);
  const body = await r.json();
  const byId = new Map();
  for (const m of body.data || []) byId.set(m.id, m);
  if (ambient) {
    const extra = await ambient.models();
    body.data = [...(body.data || []).filter((m) => !ambient.isOurs(m.id)), ...extra];
    for (const m of extra) byId.set(m.id, m);
  }
  modelsCache = { at: Date.now(), body, byId };
  return modelsCache;
}

/// Most a request could cost, in micro-dollars, from the model's stated prices: prompt estimate + max_tokens.
function worstCaseMicro(model, body) {
  const p = model?.pricing || {};
  const promptPrice = Number(p.prompt || 0); // dollars per token
  const completionPrice = Number(p.completion || 0);
  const text = JSON.stringify(body.messages || "");
  const promptTokens = Math.ceil(text.length / 3.5);
  const maxOut = Number(body.max_tokens || body.max_completion_tokens || 1024);
  return Math.ceil((promptTokens * promptPrice + maxOut * completionPrice) * 1e6 * cfg.priceMultiplier);
}

// ---- the proxy ----
async function chatCompletions(req, res) {
  const who = authed(req);
  const pay = payer(req, who);
  const body = parseObject(await readBody(req, 4 * 1024 * 1024, res));
  if (typeof body.model !== "string" || !body.model || body.model.length > 200 || !Array.isArray(body.messages)) throw err(400, "bad_request", "model and messages are required.");
  if (pay.availableMicro < cfg.minBalanceMicro) throw err(402, "insufficient_balance", pay.grant ? `The grant from ${pay.grant.from} has ${dollars(pay.availableMicro)} USD left today.` : `Balance ${dollars(pay.availableMicro)} USD. Activate SUGAR to this wallet.`);
  const { byId } = await models();
  const model = byId.get(body.model);
  if (!model) throw err(400, "unknown_model", `Unknown model ${body.model}. See GET /v1/models.`);
  if (!body.max_tokens && !body.max_completion_tokens) body.max_tokens = 1024;
  const maxOut = Number(body.max_tokens || body.max_completion_tokens);
  if (!Number.isFinite(maxOut) || maxOut < 1 || maxOut > 1_000_000) throw err(400, "bad_request", "max_tokens must be a whole number from 1 upwards.");

  if (ambient && ambient.isOurs(body.model)) return ambientChat({ res, who, pay, body });
  if (!cfg.openrouterKey) throw err(503, "upstream_unconfigured", "The gateway has no upstream key yet.");

  // the most this call could cost is held before the call, in one step with the check: two requests in flight can
  // never both spend the same dollar, and a grant's day cannot be passed by sending many requests at once
  const worst = worstCaseMicro(model, body);
  const hold = takeHold(pay, who, worst);
  let settled = false;
  const settle = (micro, info = {}) => { if (settled) return; settled = true; ledger.settle(hold, micro, { model: body.model, ...info }); };
  let sentAny = false;
  try {
    body.usage = { include: true }; // OpenRouter returns usage.cost (dollars) in the final chunk or the body
    const upstream = await fetch(`${cfg.openrouterUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.openrouterKey}`, "content-type": "application/json", "HTTP-Referer": "https://brownies.fun", "X-Title": "Brownies" },
      body: JSON.stringify(body),
    });
    if (!upstream.ok) {
      settle(0);
      const t = await upstream.text();
      res.writeHead(upstream.status, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(t);
      return;
    }
    const charge = (usage, upstreamId) => {
      const micro = billedMicro(model, usage);
      settle(micro, { upstreamId, promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens });
      return micro;
    };

    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
      const reader = upstream.body.getReader();
      const dec = new TextDecoder();
      let buf = "", usage = null, upstreamId = null;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        res.write(chunk); sentAny = true;
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try { const j = JSON.parse(data); if (j.usage) usage = j.usage; if (j.id) upstreamId = j.id; } catch {}
        }
      }
      res.end();
      charge(usage, upstreamId);
      return;
    }
    const j = await upstream.json();
    const micro = charge(j.usage, j.id);
    j.brownies = { charged_usd: dollars(micro), balance_usd: dollars(pay.grant ? (ledger.grantRoom(pay.beneficiary, who.wallet)?.roomMicro ?? 0) : ledger.balance(who.beneficiary).availableMicro) };
    if (pay.grant) j.brownies.paid_by = pay.grant.from;
    json(res, 200, j);
  } finally {
    // a call that broke after the answer started is billed its prompt: the upstream read it. One that never started costs nothing.
    if (!settled) settle(sentAny ? promptMicro(model, body) : 0, { upstreamId: null });
  }
}

/// The hold for a request: on the key's own balance, or on the granter's through the grant. A refusal is the 402.
function takeHold(pay, who, worst) {
  try {
    return pay.grant ? ledger.reserveVia(pay.beneficiary, who.wallet, worst) : ledger.reserve(who.beneficiary, worst);
  } catch (e) {
    if (e.noGrant) throw err(403, "no_grant", `${pay.grant?.from} has not granted ${who.wallet} any spending.`);
    if (e.insufficient) throw err(402, "insufficient_balance", `This request could cost up to ${dollars(worst)} USD and ${pay.grant ? "the grant's room today" : "the balance"} is ${dollars(e.availableMicro)} USD. Lower max_tokens${pay.grant ? "" : " or activate more SUGAR"}.`);
    throw e;
  }
}

/// What a finished call costs: the upstream's stated cost, or the tokens at the catalogue's prices when it stated none.
function billedMicro(model, usage) {
  if (!usage) return 0;
  if (usage.cost != null && Number(usage.cost) > 0) return Math.ceil(Number(usage.cost) * 1e6 * cfg.priceMultiplier);
  const p = model?.pricing || {};
  const micro = (Number(usage.prompt_tokens) || 0) * Number(p.prompt || 0) + (Number(usage.completion_tokens) || 0) * Number(p.completion || 0);
  return Math.ceil(micro * 1e6 * cfg.priceMultiplier);
}
/// The prompt's share of the worst case: what a call that broke mid-answer is billed.
function promptMicro(model, body) {
  const p = model?.pricing || {};
  const promptTokens = Math.ceil(JSON.stringify(body.messages || "").length / 3.5);
  return Math.ceil(promptTokens * Number(p.prompt || 0) * 1e6 * cfg.priceMultiplier);
}

/// Ambient over x402: the quote is the price (input plus the output bound), the pantry pays it when JumpGate asks,
/// the caller is charged exactly what was paid (times the multiplier). Streams pass through; a plain request gets
/// the stream folded into one answer.
async function ambientChat({ res, who, pay, body }) {
  const up = ambient.body(body);
  let quote;
  try { quote = await ambient.quote(up); } catch (e) { throw err(502, "upstream", e.message); }
  const worst = Math.ceil(quote.maxMicro * cfg.priceMultiplier);
  const hold = takeHold(pay, who, worst);
  let settled = false;
  const settle = (micro, info = {}) => { if (settled) return; settled = true; ledger.settle(hold, micro, { model: body.model, ...info }); };
  let out;
  try { out = await ambient.chat(body, { quote, maxMicro: Math.ceil(quote.maxMicro * 1.05) }); } catch (e) { settle(0); throw err(502, "upstream", `Ambient: ${e.message}`); }
  const { response: upstream, paid } = out;
  if (!upstream.ok) {
    // the pantry paid nothing for a refusal (a second 402 is an error above); a paid request that failed is still paid
    settle(paid ? Math.ceil(paid.micro * cfg.priceMultiplier) : 0, { upstreamId: null });
    const t = await upstream.text();
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "text/plain", "access-control-allow-origin": "*" });
    res.end(t);
    return;
  }
  const micro = Math.ceil((paid ? paid.micro : quote.micro) * cfg.priceMultiplier);
  const info = { upstreamId: paid?.settlement?.transaction || null, promptTokens: quote.inputTokens, completionTokens: null };
  const charge = () => settle(micro, info);
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
    try {
      const reader = upstream.body.getReader();
      const dec = new TextDecoder();
      while (true) { const { value, done } = await reader.read(); if (done) break; res.write(dec.decode(value, { stream: true })); }
    } finally { res.end(); charge(); } // paid is paid, whatever the client did with the stream
    return;
  }
  const j = foldSse(await upstream.text(), { model: body.model });
  charge();
  j.brownies = { charged_usd: dollars(micro), paid_usdc: paid ? dollars(paid.micro) : null, upstream: "ambient", balance_usd: dollars(pay.grant ? (ledger.grantRoom(pay.beneficiary, who.wallet)?.roomMicro ?? 0) : ledger.balance(who.beneficiary).availableMicro) };
  if (pay.grant) j.brownies.paid_by = pay.grant.from;
  json(res, 200, j);
}

// ---- routes ----
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, x-brownies-pay-from", "access-control-allow-methods": "GET, POST, OPTIONS" }); return res.end(); }
    if (url.pathname === "/health") return json(res, 200, { ok: true, live: cfg.live, chainId: cfg.chainId, sugar: cfg.sugarAddress || null, lastBlock: ledger.lastBlock, upstream: Boolean(cfg.openrouterKey), pantry: pantry ? pantry.view() : null });
    if ((url.pathname.startsWith("/v1/") || url.pathname === "/api/protocol/index-tx") && !cfg.live) throw err(503, "not_launched", "The coin is not launched yet.");
    if (url.pathname === "/v1/models" && req.method === "GET") { const m = await models(); return json(res, 200, m.body); }
    if (url.pathname === "/v1/key" && req.method === "GET") {
      const who = authed(req);
      const pay = payer(req, who);
      if (pay.grant) return json(res, 200, { object: "key", wallet: who.wallet, beneficiary: who.beneficiary, epoch: who.epoch, message: keyMessage(cfg.chainId, who.epoch), paid_by: pay.grant.from, grant: grantView(pay.grant), balance: { currency: "USD", available: dollars(pay.availableMicro), used: dollars(pay.grant.spentMicro), credited: dollars(pay.grant.dailyMicro) } });
      return json(res, 200, { object: "key", wallet: who.wallet, beneficiary: who.beneficiary, epoch: who.epoch, message: keyMessage(cfg.chainId, who.epoch), balance: { currency: "USD", available: dollars(who.bal.availableMicro), used: dollars(who.bal.spentMicro), credited: dollars(who.bal.creditedMicro) } });
    }
    if (url.pathname === "/v1/key/rotate" && req.method === "POST") {
      const who = authed(req);
      const epoch = ledger.bumpEpoch(who.beneficiary);
      return json(res, 200, { object: "key", wallet: who.wallet, epoch, message: keyMessage(cfg.chainId, epoch), note: "Sign the new message to get the new key. Every older key is refused from now on." });
    }
    if (url.pathname === "/v1/grants" && req.method === "GET") {
      const who = authed(req);
      return json(res, 200, { object: "grants", wallet: who.wallet, given: ledger.grantsBy(who.beneficiary).map(grantView), received: ledger.grantsTo(who.wallet).map(grantView) });
    }
    if (url.pathname === "/v1/grants" && req.method === "POST") {
      const who = authed(req);
      const body = parseObject(await readBody(req, 4096, res));
      const grantee = parseWallet(body.grantee, "grantee");
      if (!grantee) throw err(400, "bad_wallet", "grantee must be an address.");
      if (grantee === who.wallet) throw err(400, "bad_grantee", "A wallet needs no grant to itself.");
      const daily = Number(body.daily_usd ?? body.dailyUsd);
      if (!Number.isFinite(daily) || daily < 0.01 || daily > 1000) throw err(400, "bad_amount", "daily_usd must be between 0.01 and 1000.");
      ledger.setGrant(who.beneficiary, grantee, Math.round(daily * 1e6));
      return json(res, 200, { object: "grant", ...grantView(ledger.grantRoom(who.beneficiary, grantee)), note: `${grantee} may now spend up to ${dollars(Math.round(daily * 1e6))} USD a day from ${who.wallet}'s balance, by sending the header X-Brownies-Pay-From: ${who.wallet}.` });
    }
    if (url.pathname === "/v1/grants/revoke" && req.method === "POST") {
      const who = authed(req);
      const body = parseObject(await readBody(req, 4096, res));
      const grantee = parseWallet(body.grantee, "grantee");
      if (!grantee) throw err(400, "bad_wallet", "grantee must be an address.");
      return json(res, 200, { object: "grant", grantee, revoked: ledger.revokeGrant(who.beneficiary, grantee) });
    }
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") return await chatCompletions(req, res);
    if (url.pathname === "/api/protocol/stats" && req.method === "GET") {
      let onchain = null;
      if (chain) { try { onchain = await chain.onchainTotals(); } catch (e) { onchain = { error: e.shortMessage || e.message }; } }
      return json(res, 200, { ledger: ledger.stats(), onchain });
    }
    if (url.pathname.startsWith("/api/protocol/account/") && req.method === "GET") {
      const wallet = url.pathname.split("/").pop();
      if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw err(400, "bad_wallet", "Not an address.");
      const b = walletToBeneficiary(wallet);
      const bal = ledger.balance(b);
      return json(res, 200, { wallet, beneficiary: b, epoch: bal.epoch, balance: { available: dollars(bal.availableMicro), used: dollars(bal.spentMicro), credited: dollars(bal.creditedMicro) }, recent: ledger.recent(b, 25) });
    }
    if (url.pathname === "/api/protocol/index-tx" && req.method === "POST") {
      const body = parseObject(await readBody(req, 4096, res));
      if (!/^0x[0-9a-fA-F]{64}$/.test(body.tx || "")) throw err(400, "bad_tx", "tx must be a transaction hash.");
      if (!chain) throw err(503, "not_live", "The chain is not connected yet.");
      // anyone may ask, a few times a minute; a hash that was not found is not looked up again for a minute
      if (!allow("index:" + clientIp(req), 6)) throw err(429, "slow_down", "Six lookups a minute per address.");
      const tx = body.tx.toLowerCase(), missedAt = indexMisses.get(tx) || 0;
      if (Date.now() - missedAt < 60_000) return json(res, 200, { booked: 0, note: "looked up a moment ago, nothing found yet" });
      const booked = await chain.indexTx(body.tx);
      if (!booked) { indexMisses.set(tx, Date.now()); if (indexMisses.size > 10_000) indexMisses.clear(); }
      return json(res, 200, { booked });
    }
    if (url.pathname === "/api/team/activity" && req.method === "GET") {
      const num = (k) => Number(url.searchParams.get(k) || 0) || 0;
      const helper = (url.searchParams.get("helper") || "").toLowerCase(), kind = url.searchParams.get("kind") || "";
      if (helper && !isHelperName(helper)) throw err(400, "bad_helper", "Not a helper name.");
      if (kind && !KINDS.includes(kind)) throw err(400, "bad_kind", "Not a kind.");
      return json(res, 200, { entries: team.list({ limit: num("limit") || 30, before: num("before"), helper, kind, offset: num("offset"), asc: url.searchParams.get("order") === "asc" }) });
    }
    if (url.pathname === "/api/team/towers" && req.method === "GET") return json(res, 200, { size: 100, towers: team.towers(100) });
    if (url.pathname === "/api/team/summary" && req.method === "GET") return json(res, 200, team.summary());
    if (url.pathname === "/api/team/log" && req.method === "POST") {
      if (!cfg.teamLogKey) throw err(503, "closed", "This gateway takes no reports.");
      if (!sameSecret(bearer(req), cfg.teamLogKey)) throw err(401, "bad_key", "Wrong team key.");
      let body;
      try { body = JSON.parse(await readBody(req, 64 * 1024, res)); } catch { throw err(400, "bad_entry", "The body is not JSON."); }
      if (!body || typeof body !== "object") throw err(400, "bad_entry", "The body is not an entry.");
      const list = Array.isArray(body) ? body : [body];
      if (!list.length || list.length > 20) throw err(400, "bad_entry", "Send 1 to 20 entries.");
      const rows = list.map((e) => cleanEntry(e)); // every entry is checked before any is written
      return json(res, 200, { added: rows.map((r) => team.insert(r)) });
    }
    throw err(404, "not_found", "No such route.");
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) oaiError(res, e.status ? e : err(500, "internal", "Internal error."));
    else res.end();
  }
});

server.listen(cfg.port, () => {
  console.log(`[gateway] listening on :${cfg.port}, chain ${cfg.chainId}, SUGAR ${cfg.sugarAddress || "not set"}, upstream ${cfg.openrouterKey ? "set" : "NOT SET"}`);
  if (chain) chain.start({ claimEverySeconds: cfg.claimEverySeconds });
  if (pantry) pantry.start();
});

export { server, ledger, chain, team, pantry, ambient, beneficiaryToWallet };
