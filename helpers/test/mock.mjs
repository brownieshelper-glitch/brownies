// The test harness. A fetch stub that routes by method and URL and records every call, mocks of the five services
// the brownies talk to (gateway, OpenRouter, Telegram, X, GitHub), and makeWorld(), which wires the real modules
// to the stub. No test here touches the network.
import { verifyMessage, Wallet } from "ethers";
import { Store } from "../lib/store.mjs";
import { FakeClock } from "../lib/clock.mjs";
import { Gateway } from "../lib/gateway.mjs";
import { Brain } from "../lib/brain.mjs";
import { Alerts } from "../lib/alerts.mjs";
import { Telegram } from "../lib/telegram.mjs";
import { XClient } from "../lib/xapi.mjs";
import { GitHub } from "../lib/github.mjs";
import { Fudge } from "../helpers/fudge.mjs";
import { Crumb } from "../helpers/crumb.mjs";
import { Nib } from "../helpers/nib.mjs";
import { Chip } from "../helpers/chip.mjs";

// ---- the fetch stub ----
const lower = (h) => { const o = {}; for (const [k, v] of Object.entries(h || {})) o[k.toLowerCase()] = v; return o; };
function response(out = {}) {
  const status = out.status ?? 200;
  const headers = lower(out.headers || {});
  const text = out.text ?? JSON.stringify(out.json ?? {});
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => JSON.parse(text), text: async () => text };
}

/// fetch.on(method | "*", pattern (string includes or RegExp), handler(call, match) -> { status, json | text, headers })
export function makeFetch() {
  const routes = [], calls = [];
  const fetch = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    const u = String(url);
    let body = null;
    if (init.body != null) { try { body = JSON.parse(init.body); } catch { body = String(init.body); } }
    const call = { method, url: u, body, headers: lower(init.headers) };
    calls.push(call);
    for (const r of routes) {
      if (r.method !== "*" && r.method !== method) continue;
      const m = r.pattern instanceof RegExp ? r.pattern.exec(u) : (u.includes(r.pattern) ? [u] : null);
      if (m) return response(await r.handle(call, m));
    }
    throw new Error(`no mock route for ${method} ${u}`);
  };
  fetch.calls = calls;
  fetch.on = (method, pattern, handle) => { routes.push({ method, pattern, handle }); return fetch; };
  fetch.callsTo = (pattern, method = null) => calls.filter((c) => (pattern instanceof RegExp ? pattern.test(c.url) : c.url.includes(pattern)) && (!method || c.method === method));
  return fetch;
}

// ---- the gateway: team log, public reads, keys and chat (live mode) ----
function verifyKey(bearer, accounts) {
  const m = /^Bearer sk-brownie-(\d+)-(.+)$/.exec(bearer || "");
  if (!m) return { error: { status: 401, code: "missing_api_key" } };
  let wallet;
  try { wallet = verifyMessage(`Brownies API key, chain 1, epoch ${m[1]}`, "0x" + Buffer.from(m[2], "base64url").toString("hex")); } catch { return { error: { status: 401, code: "invalid_api_key" } }; }
  const cur = accounts[wallet.toLowerCase()]?.epoch || 0;
  if (Number(m[1]) < cur) return { error: { status: 401, code: "key_revoked" } };
  return { wallet: wallet.toLowerCase() };
}
export function mockGateway(fetch, { url = "https://gw.test", teamKey = "team-key-0123456789abcdef0123456789" } = {}) {
  const g = { url, teamKey, reports: [], accounts: {}, balances: {}, chatCost: 0.0012, reply: () => "A plain sentence from the gateway.", chats: [],
    stats: { ledger: { activations: 3, creditedMicro: 5_000_000, spentMicro: 120_000, requests: 9 }, onchain: null },
    summary: { now: 0, helpers: [{ helper: "fudge", total: 4, today: 1, status: { title: "Writing a post", at: 0 } }], week: { post: 4 }, total: 4 } };
  fetch.on("POST", `${url}/api/team/log`, (c) => {
    if (c.headers.authorization !== `Bearer ${teamKey}`) return { status: 401, json: { error: { code: "bad_key", message: "Wrong team key." } } };
    const list = Array.isArray(c.body) ? c.body : [c.body];
    const added = list.map((e) => { const row = { id: g.reports.length + 1, ...e }; g.reports.push(row); return row; });
    return { json: { added } };
  });
  fetch.on("GET", `${url}/api/protocol/stats`, () => ({ json: g.stats }));
  fetch.on("GET", `${url}/api/team/summary`, () => ({ json: g.summary }));
  fetch.on("GET", new RegExp(`^${url}/api/protocol/account/(0x[0-9a-fA-F]{40})`), (c, m) => ({ json: { wallet: m[1], epoch: g.accounts[m[1].toLowerCase()]?.epoch || 0 } }));
  // grants: g.grants[granter wallet, lowercase][grantee wallet, lowercase] = room in dollars; the header names the granter
  g.grants = {};
  const room = (c, wallet) => { const from = String(c.headers["x-brownies-pay-from"] || "").toLowerCase(); if (!from) return null; const r = g.grants[from]?.[wallet]; return r == null ? { none: true, from } : { from, room: r }; };
  fetch.on("GET", `${url}/v1/key`, (c) => {
    const v = verifyKey(c.headers.authorization, g.accounts);
    if (v.error) return { status: v.error.status, json: { error: v.error } };
    const gr = room(c, v.wallet);
    if (gr?.none) return { status: 403, json: { error: { code: "no_grant", message: "no grant" } } };
    if (gr) return { json: { object: "key", wallet: v.wallet, paid_by: gr.from, balance: { currency: "USD", available: gr.room.toFixed(6), used: "0", credited: "0" } } };
    return { json: { object: "key", wallet: v.wallet, balance: { currency: "USD", available: (g.balances[v.wallet] || 0).toFixed(6), used: "0", credited: "0" } } };
  });
  fetch.on("POST", `${url}/v1/chat/completions`, (c) => {
    const v = verifyKey(c.headers.authorization, g.accounts);
    if (v.error) return { status: v.error.status, json: { error: v.error } };
    const gr = room(c, v.wallet);
    if (gr?.none) return { status: 403, json: { error: { code: "no_grant", message: "no grant" } } };
    const bal = gr ? gr.room : (g.balances[v.wallet] || 0);
    if (bal < 0.01) return { status: 402, json: { error: { code: "insufficient_balance", message: "Balance too low." } } };
    g.chats.push({ wallet: v.wallet, body: c.body, headers: c.headers, paidBy: gr?.from || null });
    if (gr) g.grants[gr.from][v.wallet] = bal - g.chatCost; else g.balances[v.wallet] = bal - g.chatCost;
    return { json: { id: "gw-" + g.chats.length, choices: [{ message: { role: "assistant", content: g.reply(c.body, g.chats.length) } }], usage: { prompt_tokens: 50, completion_tokens: 20, cost: g.chatCost }, brownies: { charged_usd: g.chatCost.toFixed(6), balance_usd: Number((gr ? g.grants[gr.from][v.wallet] : g.balances[v.wallet]) || 0).toFixed(6), ...(gr ? { paid_by: gr.from } : {}) } } };
  });
  g.kinds = () => g.reports.map((r) => r.kind);
  g.of = (helper, kind = null) => g.reports.filter((r) => r.helper === helper && (!kind || r.kind === kind));
  return g;
}

// ---- OpenRouter (prelaunch mode) ----
export function mockOpenRouter(fetch, { reply = () => "A plain sentence.", cost = 0.001 } = {}) {
  const o = { calls: [], reply, cost, status: null };
  fetch.on("POST", "openrouter.ai/api/v1/chat/completions", (c) => {
    o.calls.push(c);
    if (o.status) return { status: o.status, json: { error: { message: "refused" } } };
    const r = o.reply(c.body, o.calls.length);
    if (r && typeof r === "object") return r;
    const cost = typeof o.cost === "function" ? o.cost(c.body) : o.cost;
    return { json: { id: "gen-" + o.calls.length, model: c.body.model, choices: [{ message: { role: "assistant", content: String(r) } }], usage: { prompt_tokens: 100, completion_tokens: 40, cost } } };
  });
  /// the last user message of the nth call (1-based), to see what a helper asked
  o.lastUser = (n = o.calls.length) => { const ms = o.calls[n - 1].body.messages; return ms.filter((m) => m.role === "user").pop()?.content || ""; };
  o.system = (n = o.calls.length) => o.calls[n - 1].body.messages.find((m) => m.role === "system")?.content || "";
  return o;
}

// ---- Telegram ----
export function mockTelegram(fetch, { token = "123456789:TESTTOKENTESTTOKENTESTTOKENTESTTOK" } = {}) {
  const t = { token, sent: [], answered: [], edited: [], actions: [], queue: [], nextMessageId: 100, updateSeq: 10, msgSeq: 500, getUpdatesCalls: 0 };
  const ok = (result = true) => ({ json: { ok: true, result } });
  fetch.on("POST", `/bot${token}/getUpdates`, (c) => { t.getUpdatesCalls++; const out = t.queue.filter((u) => u.update_id >= (c.body.offset || 0)); t.queue = []; return ok(out); });
  fetch.on("POST", `/bot${token}/getMe`, () => ok({ id: 777, is_bot: true, username: "feedthebrownies_bot", first_name: "Brownies" }));
  fetch.on("POST", `/bot${token}/sendMessage`, (c) => { const message_id = t.nextMessageId++; t.sent.push({ ...c.body, message_id }); return ok({ message_id, chat: { id: c.body.chat_id }, text: c.body.text }); });
  fetch.on("POST", `/bot${token}/answerCallbackQuery`, (c) => { t.answered.push(c.body); return ok(); });
  fetch.on("POST", `/bot${token}/editMessageReplyMarkup`, (c) => { t.edited.push(c.body); return ok(); });
  fetch.on("POST", `/bot${token}/editMessageText`, (c) => { t.edited.push(c.body); return ok(); });
  fetch.on("POST", `/bot${token}/sendChatAction`, (c) => { t.actions.push(c.body); return ok(); });
  /// queue a text message; type "supergroup" (the group) or "private"
  t.message = ({ chatId, text, from = { id: 5, first_name: "Ann", username: "ann" }, type = "supergroup", replyTo = null }) => {
    const u = { update_id: ++t.updateSeq, message: { message_id: ++t.msgSeq, date: 0, chat: { id: Number(chatId), type }, from, text } };
    if (replyTo) u.message.reply_to_message = { message_id: replyTo };
    t.queue.push(u); return u;
  };
  /// queue a button press
  t.callback = ({ chatId, fromId, data, messageId }) => {
    const u = { update_id: ++t.updateSeq, callback_query: { id: "cq" + t.updateSeq, from: { id: Number(fromId) }, message: { message_id: messageId, chat: { id: Number(chatId) } }, data } };
    t.queue.push(u); return u;
  };
  return t;
}

// ---- X ----
export function mockX(fetch, { access = "access-old", refresh = "refresh-old", valid = true } = {}) {
  const x = { posts: [], mentions: [], refreshes: 0, validAccess: valid ? access : "nothing-valid", currentRefresh: refresh, tokenCalls: [], userId: "42", refuseRefresh: false };
  fetch.on("POST", "api.x.com/2/oauth2/token", (c) => {
    x.tokenCalls.push(c);
    const form = new URLSearchParams(String(c.body));
    if (x.refuseRefresh || form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== x.currentRefresh) return { status: 400, json: { error: "invalid_request", error_description: "Value passed for the token was invalid." } };
    x.refreshes++;
    x.validAccess = `access-${x.refreshes}`; x.currentRefresh = `refresh-${x.refreshes}`;
    return { json: { token_type: "bearer", expires_in: 7200, access_token: x.validAccess, refresh_token: x.currentRefresh, scope: "tweet.read tweet.write users.read offline.access" } };
  });
  const authed = (c) => c.headers.authorization === `Bearer ${x.validAccess}`;
  const no = { status: 401, json: { title: "Unauthorized", type: "about:blank", status: 401, detail: "Unauthorized" } };
  fetch.on("GET", "api.x.com/2/users/me", (c) => (authed(c) ? { json: { data: { id: x.userId, name: "Brownies", username: "Feedthebrownies" } } } : no));
  fetch.on("POST", "api.x.com/2/tweets", (c) => { if (!authed(c)) return no; const id = String(1000 + x.posts.length); x.posts.push({ id, ...c.body }); return { status: 201, json: { data: { id, text: c.body.text } } }; });
  fetch.on("GET", /api\.x\.com\/2\/users\/\d+\/mentions/, (c) => {
    if (!authed(c)) return no;
    const since = new URL(c.url).searchParams.get("since_id");
    const list = x.mentions.filter((m) => !since || BigInt(m.id) > BigInt(since));
    const data = list.slice().reverse().map((m) => ({ id: m.id, text: m.text, author_id: m.authorId, conversation_id: m.id }));
    return { json: { ...(data.length ? { data } : {}), includes: { users: list.map((m) => ({ id: m.authorId, username: m.author })) }, meta: { result_count: list.length, ...(list.length ? { newest_id: list[list.length - 1].id } : {}) } } };
  });
  return x;
}

// ---- GitHub ----
const hash = (s) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h.toString(16); };
export function mockGitHub(fetch, { repo = "brownieshelper-glitch/brownies", files = {}, issues = [], defaultBranch = "main" } = {}) {
  const gh = { repo, defaultBranch, branches: { [defaultBranch]: "sha-main-0" }, files: { [defaultBranch]: { ...files } }, prs: [], comments: [], merged: [], closed: [], commits: [], issues: [...issues], checks: {} };
  const R = `https://api.github.com/repos/${repo}`;
  const esc = R.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blobSha = (p, content) => "blob-" + hash(p + "\0" + content);
  const branchOf = (sha) => Object.entries(gh.branches).find(([, s]) => s === sha)?.[0] || gh.defaultBranch;
  const notFound = { status: 404, json: { message: "Not Found" } };
  fetch.on("GET", new RegExp(`^${esc}$`), () => ({ json: { default_branch: gh.defaultBranch, full_name: repo } }));
  fetch.on("GET", new RegExp(`^${esc}/git/ref/heads/([^?]+)$`), (c, m) => { const b = decodeURIComponent(m[1]); return gh.branches[b] ? { json: { ref: `refs/heads/${b}`, object: { sha: gh.branches[b] } } } : notFound; });
  fetch.on("POST", `${R}/git/refs`, (c) => { const b = c.body.ref.replace("refs/heads/", ""); gh.files[b] = { ...gh.files[branchOf(c.body.sha)] }; gh.branches[b] = c.body.sha; return { status: 201, json: { ref: c.body.ref, object: { sha: c.body.sha } } }; });
  fetch.on("GET", new RegExp(`^${esc}/contents/([^?]+)(?:\\?ref=([^&]+))?$`), (c, m) => {
    const p = decodeURIComponent(m[1]), b = m[2] ? decodeURIComponent(m[2]) : gh.defaultBranch;
    const content = gh.files[b]?.[p];
    if (content == null) return notFound;
    return { json: { type: "file", path: p, sha: blobSha(p, content), encoding: "base64", content: Buffer.from(content).toString("base64") } };
  });
  fetch.on("PUT", new RegExp(`^${esc}/contents/([^?]+)$`), (c, m) => {
    const p = decodeURIComponent(m[1]), b = c.body.branch;
    if (!gh.files[b]) return { status: 404, json: { message: "Branch not found" } };
    const content = Buffer.from(c.body.content, "base64").toString("utf8"), existing = gh.files[b][p];
    if (existing != null && c.body.sha !== blobSha(p, existing)) return { status: 409, json: { message: `${p} does not match ${c.body.sha}` } };
    if (existing == null && c.body.sha) return { status: 422, json: { message: "sha given for a new file" } };
    gh.files[b][p] = content;
    gh.commits.push({ branch: b, path: p, message: c.body.message });
    gh.branches[b] = `sha-${b}-${gh.commits.length}`;
    return { status: existing != null ? 200 : 201, json: { content: { path: p, sha: blobSha(p, content), html_url: `https://github.com/${repo}/blob/${b}/${p}` }, commit: { sha: gh.branches[b], message: c.body.message } } };
  });
  fetch.on("GET", new RegExp(`^${esc}/git/trees/([^?]+)`), (c, m) => { const b = branchOf(decodeURIComponent(m[1])); return { json: { sha: gh.branches[b], tree: Object.entries(gh.files[b]).map(([path, content]) => ({ path, type: "blob", size: content.length })) } }; });
  fetch.on("GET", new RegExp(`^${esc}/issues\\?`), () => ({ json: gh.issues.map((i) => ({ number: i.number, title: i.title, body: i.body || "", html_url: `https://github.com/${repo}/issues/${i.number}`, labels: (i.labels || ["chip"]).map((name) => ({ name })), state: "open", ...(i.pull_request ? { pull_request: {} } : {}) })) }));
  fetch.on("POST", new RegExp(`^${esc}/issues$`), (c) => { const number = 200 + gh.issues.length; const i = { number, title: c.body.title, body: c.body.body || "", labels: c.body.labels || [], state: "open" }; gh.issues.push(i); return { status: 201, json: { number, title: i.title, html_url: `https://github.com/${repo}/issues/${number}` } }; });
  fetch.on("POST", `${R}/pulls`, (c) => { const number = 100 + gh.prs.length; const pr = { number, title: c.body.title, body: c.body.body, head: { ref: c.body.head, sha: gh.branches[c.body.head] || "sha-" + c.body.head }, base: c.body.base, state: "open", merged: false, html_url: `https://github.com/${repo}/pull/${number}` }; gh.prs.push(pr); return { status: 201, json: pr }; });
  // the checks (CI) on a commit: gh.checks[sha] = [{ name, status, conclusion }]; none by default
  fetch.on("GET", new RegExp(`^${esc}/commits/(.+)/check-runs`), (c, m) => { gh.checkCalls = (gh.checkCalls || 0) + 1; return { json: { check_runs: gh.checksFn ? gh.checksFn(m[1], gh.checkCalls) : (gh.checks[m[1]] || []) } }; });
  fetch.on("GET", new RegExp(`^${esc}/pulls/(\\d+)$`), (c, m) => { const pr = gh.prs.find((p) => p.number === Number(m[1])); return pr ? { json: pr } : notFound; });
  fetch.on("PUT", new RegExp(`^${esc}/pulls/(\\d+)/merge$`), (c, m) => {
    const pr = gh.prs.find((p) => p.number === Number(m[1]));
    if (!pr || pr.state !== "open") return { status: 405, json: { message: "Pull Request is not mergeable" } };
    pr.merged = true; pr.state = "closed"; gh.merged.push(pr.number);
    Object.assign(gh.files[pr.base], gh.files[pr.head.ref]); gh.branches[pr.base] = `sha-${pr.base}-m${gh.merged.length}`;
    return { json: { merged: true, sha: gh.branches[pr.base], message: "Pull Request successfully merged" } };
  });
  fetch.on("PATCH", new RegExp(`^${esc}/pulls/(\\d+)$`), (c, m) => { const pr = gh.prs.find((p) => p.number === Number(m[1])); if (!pr) return notFound; pr.state = c.body.state || pr.state; if (pr.state === "closed" && !pr.merged) gh.closed.push(pr.number); return { json: pr }; });
  fetch.on("POST", new RegExp(`^${esc}/issues/(\\d+)/comments$`), (c, m) => { gh.comments.push({ number: Number(m[1]), body: c.body.body }); return { status: 201, json: { id: gh.comments.length, body: c.body.body } }; });
  fetch.on("PATCH", new RegExp(`^${esc}/issues/(\\d+)$`), (c, m) => { const i = gh.issues.find((x) => x.number === Number(m[1])); if (i) i.state = c.body.state; return { json: { number: Number(m[1]), state: c.body.state } }; });
  return gh;
}

// ---- the whole thing, wired to the stub ----
export const DEFAULT_CONFIG = {
  fudge: { role: "marketing", model: "test/cheap", dailyCapUsd: 1, postHours: [9, 13, 18], postMinute: 0, mentionsEveryMinutes: 20, maxPostsPerDay: 3, maxRepliesPerDay: 12 },
  crumb: { role: "community", model: "test/cheap", dailyCapUsd: 1, reportEveryMinutes: 60 },
  nib: { role: "research", model: "test/big", dailyCapUsd: 1, hour: 8, minute: 0, competitors: [{ name: "Orbio", url: "https://orbio.test/" }] },
  chip: { role: "builder", model: "test/big", dailyCapUsd: 2, checkEveryMinutes: 30, smallMaxLines: 60, reviewers: ["fudge", "crumb", "nib"], standingTasks: [] },
};
export const FACTS = "- BROWNIE is a coin on Ethereum with a 2% tax on every trade.\n- Half of the tax pays stakers in SUGAR. 1 SUGAR pays for 1 dollar of AI.\n- The four brownies are Fudge, Crumb, Nib and Chip.";

export function makeWorld({ mode = "prelaunch", clock = new FakeClock(), tz = "UTC", config = {}, reply, cost, x: xOpts = {}, tokenFile = "", github: ghOpts = {}, log = () => {} } = {}) {
  const fetch = makeFetch();
  const store = new Store(":memory:", { tz });
  const gw = mockGateway(fetch);
  const gateway = new Gateway({ url: "https://gw.test", teamKey: gw.teamKey, fetch, log });
  const or = mockOpenRouter(fetch, { reply: reply || (() => "Every trade of BROWNIE pays a 2% tax. Half of it reaches stakers as SUGAR, one dollar of AI each."), cost: cost ?? 0.001 });
  const tg = mockTelegram(fetch);
  const telegram = new Telegram({ token: tg.token, fetch, log });
  const alerts = new Alerts({ telegram, ownerChatId: "999", store, clock, mode, log });
  const helpersCfg = {};
  for (const h of Object.keys(DEFAULT_CONFIG)) helpersCfg[h] = { ...DEFAULT_CONFIG[h], ...(config[h] || {}) };
  const keys = mode === "live" ? Object.fromEntries(Object.keys(DEFAULT_CONFIG).map((h) => [h, Wallet.createRandom().privateKey])) : {};
  const brain = new Brain({ mode, openrouterKey: "or-test-key", gateway, keys, chainId: 1, helpers: helpersCfg, store, clock, fetch, alerts, log });
  const xm = mockX(fetch, xOpts);
  const x = new XClient({ clientId: "client-id", clientSecret: "client-secret", accessToken: "access-old", refreshToken: "refresh-old", tokenFile, username: "Feedthebrownies", fetch, clock, log });
  const ghm = mockGitHub(fetch, ghOpts);
  const github = new GitHub({ token: "ghp_testtoken", repo: ghm.repo, fetch, log });
  const deps = (name) => ({ config: helpersCfg[name], brain, gateway, store, clock, alerts, facts: FACTS, log });
  const chip = new Chip({ ...deps("chip"), github, telegram, ownerChatId: "999" });
  const fudge = new Fudge({ ...deps("fudge"), x });
  const crumb = new Crumb({ ...deps("crumb"), telegram, github, groupChatId: "-100", ownerChatId: "999", onDecision: (id, d, ctx) => chip.decide(id, d, ctx), onNote: (id, t) => chip.addNote(id, t) });
  const nib = new Nib({ ...deps("nib"), github, siteUrl: "https://site.test", fetch });
  fetch.on("GET", "https://site.test/llms.txt", () => ({ text: "# Brownies\n\n> Inference credits on Ethereum (chain id 1).", headers: { "content-type": "text/plain" } }));
  fetch.on("GET", "https://orbio.test/", () => ({ text: "<html><head><style>.a{}</style></head><body><h1>Orbio</h1><p>Agents on chain. The protocol takes 10% of fees.</p><script>secretScript()</script></body></html>", headers: { "content-type": "text/html" } }));
  return { fetch, clock, store, gateway, gw, or, tg, telegram, alerts, brain, x, xm, github, ghm, fudge, crumb, nib, chip, helpersCfg, keys };
}
