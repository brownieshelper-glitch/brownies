// The Bakery: public info and feed; a wallet signature opens a session; before the launch only an admin wallet may
// bake; a baked brownie is a hidden recruit with the holder's personality, two tools, its own feed; one per wallet;
// the holder retires and instructs their own only; live, the hold gates it, the wallet comes from the mnemonic by
// index, and every call pays from the holder's grant (the pay-from header), nothing without a grant.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Wallet } from "ethers";
import { makeWorld } from "./mock.mjs";
import { Recruit, BAKED_TOOLS, TOOLS, validateSpec } from "../lib/recruit.mjs";
import { Bakery, bakeMessage, JOB_MENU } from "../lib/bakery.mjs";
import { Dough } from "../lib/hiring.mjs";

const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const INDEX0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const WEI = 10n ** 18n;

/// A world with the Bakery wired to a real hire/fire pair, like run.mjs does.
function shop({ mode = "prelaunch", admins = [], holdOf = null, config = {}, reply } = {}) {
  const W = makeWorld({ mode, reply: reply || (() => "Today the brownies did four jobs. The tax is 2% on every trade and SUGAR pays one dollar of AI.") });
  if (mode === "live") W.brain.mnemonic = TEST_MNEMONIC;
  const all = { fudge: W.fudge, crumb: W.crumb, nib: W.nib, chip: W.chip };
  const log = [];
  const deps = (name) => ({ config: W.helpersCfg[name] || {}, brain: W.brain, gateway: W.gateway, store: W.store, clock: W.clock, alerts: W.alerts, facts: "facts", log: (l) => log.push(String(l)) });
  const recruitNames = () => String(W.store.getMeta("recruits", "")).split(",").filter(Boolean);
  const hire = async (spec) => {
    W.store.setMeta(`recruit:${spec.name}`, JSON.stringify(spec));
    W.store.setMeta("recruits", [...recruitNames().filter((n) => n !== spec.name), spec.name].join(","));
    W.brain.helpers[spec.name] = { role: spec.role, model: spec.model, dailyCapUsd: spec.dailyCapUsd, hidden: spec.hidden, walletIndex: spec.walletIndex, payFrom: spec.payFrom };
    const r = new Recruit({ ...deps(spec.name), telegram: W.telegram, github: W.github, ownerChatId: "999", groupChatId: "-100", spec });
    all[spec.name] = r;
    return r;
  };
  const fire = async (name) => { if (!all[name]?.recruit) return false; delete all[name]; W.store.setMeta("recruits", recruitNames().filter((n) => n !== name).join(",")); return true; };
  const recruits = () => Object.values(all).filter((h) => h.recruit);
  const roster = () => Object.entries(all).map(([name, h]) => ({ name, role: W.helpersCfg[name]?.role || h.role || "" }));
  const world = { S: { mode, telegram: { ownerChatId: "999", groupChatId: "-100" }, gatewayUrl: "https://gw.test" }, store: W.store, clock: W.clock, brain: W.brain, telegram: W.telegram, gateway: W.gateway, config: { chainId: 1, timezone: "UTC" } };
  const bakery = new Bakery({ W: world, log: (l) => log.push(String(l)), origins: ["https://site.test"], hire, fire, recruits, roster, config: { minHold: 10_000, maxPerWallet: 1, maxTotal: 3, maxCapUsd: 1, defaultCapUsd: 0.5, asksPerDay: 2, models: ["anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-5.5"], ...config }, adminWallets: admins, holdOf, deploymentJson: "https://site.test/deployments/1.json" });
  return { W, all, bakery, log, hire, fire, recruits, roster, deps };
}

/// A real HTTP round trip to the handler, like the page does.
async function serve(bakery) {
  const server = createServer((req, res) => (req.url.startsWith("/bake/") ? bakery.handle(req, res) : (res.writeHead(404), res.end())));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token, origin = "https://site.test") => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(origin ? { origin } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null), cors: r.headers.get("access-control-allow-origin") };
  };
  const loginAs = async (wallet) => {
    const n = await call("GET", "/bake/nonce");
    const signature = await wallet.signMessage(bakeMessage(n.body.nonce));
    return call("POST", "/bake/login", { address: wallet.address, signature, nonce: n.body.nonce });
  };
  return { call, loginAs, close: () => new Promise((r) => server.close(r)) };
}

test("public info and feed; no session, nothing private; a wallet's signature opens a session for that wallet only", async () => {
  const { bakery } = shop();
  const { call, loginAs, close } = await serve(bakery);
  try {
    const info = await call("GET", "/bake/info", null, null, null);
    assert.equal(info.status, 200);
    assert.equal(info.cors, "*", "a public route answers anyone");
    assert.equal(info.body.on, true);
    assert.equal(info.body.live, false);
    assert.equal(info.body.minHold, 10_000);
    assert.deepEqual(info.body.tools, ["feed", "draft"]);
    assert.deepEqual(info.body.menu.map((m) => m.id), JOB_MENU.map((m) => m.id));
    assert.deepEqual((await call("GET", "/bake/feed")).body, { brownies: [] });
    assert.equal((await call("GET", "/bake/mine")).status, 401);
    assert.equal((await call("POST", "/bake/create", { name: "x" })).status, 401);
    const w = Wallet.createRandom();
    const n = await call("GET", "/bake/nonce");
    const other = Wallet.createRandom();
    const forged = await call("POST", "/bake/login", { address: w.address, signature: await other.signMessage(bakeMessage(n.body.nonce)), nonce: n.body.nonce });
    assert.equal(forged.status, 401, "another wallet's signature does not open this wallet's session");
    const ok = await loginAs(w);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.wallet, w.address);
    assert.ok(/^[0-9a-f]{64}$/.test(ok.body.token));
    const mine = await call("GET", "/bake/mine", null, ok.body.token);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.wallet, w.address);
    assert.equal(mine.body.canBake, false);
    assert.match(mine.body.why, /opens with the launch/);
    assert.equal((await call("POST", "/bake/create", { name: "sage", role: "a holder's helper that watches the coin", tasks: [{ menu: "watch" }] }, ok.body.token)).status, 400, "not an admin before the launch");
    await call("POST", "/bake/logout", null, ok.body.token);
    assert.equal((await call("GET", "/bake/mine", null, ok.body.token)).status, 401, "logged out");
  } finally { await close(); }
});

test("before the launch an admin wallet bakes a trial brownie: a hidden recruit with the holder's personality and two tools, working into its own feed; the owner is told; one per wallet", async () => {
  const admin = Wallet.createRandom();
  const { W, bakery, all, log } = shop({ admins: [admin.address] });
  const { call, loginAs, close } = await serve(bakery);
  try {
    const s = await loginAs(admin);
    const token = s.body.token;
    const mine0 = await call("GET", "/bake/mine", null, token);
    assert.equal(mine0.body.canBake, true);
    assert.equal(mine0.body.trial, true);
    const bad = await call("POST", "/bake/create", { name: "Fudge", role: "a copy", tasks: [{ menu: "watch" }] }, token);
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /taken/);
    assert.match((await call("POST", "/bake/create", { name: "sage", role: "a holder's helper that watches the coin", tasks: [{ menu: "nothing" }] }, token)).body.error, /no menu job/);
    assert.match((await call("POST", "/bake/create", { name: "sage", role: "a holder's helper that watches the coin", tasks: [] }, token)).body.error, /at least one task/);
    const made = await call("POST", "/bake/create", {
      name: "Sage", role: "a holder's helper that watches the coin and explains it simply", personality: "calm, a little dry, likes short sentences", dailyCapUsd: 5, model: "anthropic/claude-sonnet-5.5",
      tasks: [{ menu: "watch", hours: [7] }, { title: "Italian line", text: "Write one Italian sentence about what the brownies did today.", tool: "draft", hours: [21] }, { title: "x", text: "too short" }],
    }, token);
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.equal(made.body.name, "sage");
    assert.equal(made.body.title, "Sage");
    assert.equal(made.body.holder, admin.address);
    assert.equal(made.body.capUsd, 1, "the cap is bounded by the Bakery's maximum");
    assert.equal(made.body.model, "anthropic/claude-sonnet-5.5");
    assert.equal(made.body.wallet, null, "no mnemonic before the launch: no wallet yet");
    assert.equal(made.body.payFrom, null);
    assert.equal(made.body.fund, null);
    assert.deepEqual(made.body.tasks.map((t) => [t.id, t.tool, t.hours]), [["watch", "feed", [7]], ["italian-line", "draft", [21]]], "the menu job with the holder's hour, the custom one; the empty one dropped");
    const r = all.sage;
    assert.ok(r?.recruit);
    assert.equal(r.hidden, true);
    assert.equal(r.spec.walletIndex, 0);
    assert.deepEqual(r.spec.tools, BAKED_TOOLS);
    assert.equal(r.spec.baked.personality, "calm, a little dry, likes short sentences");
    assert.match(W.tg.sent.at(-1).text, /^A holder baked Sage/);
    assert.equal(String(W.tg.sent.at(-1).chat_id), "999", "the owner is told");
    // the brownie works: the model sees the personality, the result lands in the feed, nothing in the Kitchen
    const out = await r.doTask(r.spec.tasks[0]);
    assert.equal(out.place, "bakery");
    assert.match(W.or.system(), /home-baked brownie/);
    assert.match(W.or.system(), /calm, a little dry/);
    assert.equal(W.gw.reports.length, 0, "hidden: nothing in the Kitchen");
    assert.equal(r.feed().length, 1);
    assert.equal(r.feed()[0].task, "watch");
    // a draft with no Telegram linked goes to the feed, not to the owner
    const sentBefore = W.tg.sent.length;
    const d = await r.doTask(r.spec.tasks[1]);
    assert.equal(d.place, "bakery");
    assert.equal(W.tg.sent.length, sentBefore, "no message to the owner from a holder's brownie");
    assert.equal(r.feed().length, 2);
    assert.equal(r.feed()[0].kind, "draft");
    const feed = await call("GET", "/bake/feed");
    assert.equal(feed.body.brownies.length, 1);
    assert.equal(feed.body.brownies[0].name, "sage");
    assert.equal(feed.body.brownies[0].outputs, 2);
    assert.equal(feed.body.brownies[0].feed.length, 2);
    assert.equal(feed.body.brownies[0].holderShort, admin.address.slice(0, 6) + "..." + admin.address.slice(-4));
    assert.equal(feed.body.brownies[0].wallet, undefined, "the public feed shows no wallet");
    const mine = await call("GET", "/bake/mine", null, token);
    assert.equal(mine.body.brownies.length, 1);
    assert.equal(mine.body.canBake, false);
    assert.match(mine.body.why, /one brownie per wallet/);
    assert.equal(mine.body.brownies[0].asksLeft, 2);
    assert.equal((await call("POST", "/bake/create", { name: "sage2", role: "another holder's helper that watches", tasks: [{ menu: "watch" }] }, token)).status, 400);
    assert.ok(log.some((l) => /\[bakery\] .* baked Sage/.test(l)));
  } finally { await close(); }
});

test("the holder instructs and retires their own brownie only, a few instructions a day; the owner can retire any; Dough leaves the holders' brownies alone", async () => {
  const admin = Wallet.createRandom(), stranger = Wallet.createRandom();
  const { W, bakery, all, recruits, deps } = shop({ admins: [admin.address, stranger.address] });
  const { call, loginAs, close } = await serve(bakery);
  try {
    const a = (await loginAs(admin)).body.token, s = (await loginAs(stranger)).body.token;
    await call("POST", "/bake/create", { name: "sage", role: "a holder's helper that watches the coin", tasks: [{ menu: "watch" }] }, a);
    assert.equal((await call("POST", "/bake/ask", { name: "sage", text: "Write one line about SUGAR." }, s)).status, 400, "not the stranger's");
    assert.equal((await call("POST", "/bake/retire", { name: "sage" }, s)).status, 400);
    const ask1 = await call("POST", "/bake/ask", { name: "sage", text: "Write one line about SUGAR." }, a);
    assert.equal(ask1.status, 200);
    assert.equal(ask1.body.left, 1);
    const ask2 = await call("POST", "/bake/ask", { name: "sage", text: "And one about the Kitchen." }, a);
    assert.equal(ask2.body.left, 0);
    const ask3 = await call("POST", "/bake/ask", { name: "sage", text: "A third." }, a);
    assert.equal(ask3.status, 400);
    assert.match(ask3.body.error, /2 instructions a day/);
    await new Promise((r) => setTimeout(r, 20)); // the instructions ran in the background
    assert.ok(all.sage.feed().length >= 1, "the instruction's result is in the feed");
    // Dough counts neither the budget nor the ceiling of a holder's brownie, and never retires it on trial
    W.brain.helpers.dough = { model: "test/big", dailyCapUsd: 0.5 };
    const dough = new Dough({ ...deps("dough"), config: { maxRecruits: 1, poolUsdPerDay: 1, trialDays: 7, minOutputsPerWeek: 3 }, telegram: W.telegram, ownerChatId: "999", hire: async () => null, fire: bakery.fireFn, recruits, roster: () => [] });
    assert.equal(dough.poolUsed(), 0, "a holder pays for their own brownie");
    assert.equal(dough.teamRecruits().length, 0);
    W.clock.advance(10 * 86_400_000);
    assert.deepEqual(await dough.trials(), [], "no trial for a holder's brownie");
    assert.ok(all.sage, "still there");
    // the owner (Dough's fire) can retire any brownie
    assert.equal(await dough.fire("sage", "the owner asked"), true);
    assert.equal(all.sage, undefined);
    // ten days later the session is gone; the holder logs in again, bakes again and retires it themselves
    assert.equal((await call("GET", "/bake/mine", null, a)).status, 401, "a session lasts a day");
    const a2 = (await loginAs(admin)).body.token;
    const again = await call("POST", "/bake/create", { name: "sage", role: "a holder's helper that watches the coin", tasks: [{ menu: "watch" }] }, a2);
    assert.equal(again.status, 200);
    assert.equal(all.sage.spec.walletIndex, 1, "a fresh wallet index, never reused");
    assert.equal((await call("POST", "/bake/retire", { name: "sage" }, a2)).body.retired, true);
    assert.deepEqual((await call("GET", "/bake/feed")).body.brownies, []);
    // the spec rules: a team recruit cannot take the feed tool, a baked one only feed and draft
    assert.throws(() => validateSpec({ name: "quill", role: "a role long enough here", tools: ["feed"], tasks: [{ text: "write something useful" }] }), /tools must be some of note, draft, announce, issue/);
    assert.deepEqual(TOOLS, ["note", "draft", "announce", "issue"]);
    assert.throws(() => validateSpec({ name: "quill", role: "a role long enough here", tools: ["feed"], tasks: [{ text: "write something useful" }], baked: { wallet: "nope" } }, { allowedTools: BAKED_TOOLS }), /holder's wallet/);
  } finally { await close(); }
});

test("live: the hold gates the Bakery, the brownie's wallet comes from the mnemonic by index, and it pays from the holder's grant; without a grant it cannot think", async () => {
  const holder = Wallet.createRandom(), poor = Wallet.createRandom();
  const holds = { [holder.address]: 25_000n * WEI, [poor.address]: 9_999n * WEI };
  const { W, bakery, all, log } = shop({ mode: "live", holdOf: async (w) => holds[w] ?? 0n });
  const { call, loginAs, close } = await serve(bakery);
  try {
    assert.equal((await call("GET", "/bake/info")).body.live, true);
    const p = (await loginAs(poor)).body.token;
    const minePoor = await call("GET", "/bake/mine", null, p);
    assert.equal(minePoor.body.canBake, false);
    assert.match(minePoor.body.why, /at least 10,000 BROWNIE/);
    assert.equal(minePoor.body.hold, 9999);
    const h = (await loginAs(holder)).body.token;
    const made = await call("POST", "/bake/create", { name: "pepper", role: "a holder's helper that drafts posts", personality: "bubbly", tasks: [{ menu: "posts" }] }, h);
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.equal(made.body.wallet, INDEX0, "index 0 of the test mnemonic");
    assert.equal(made.body.payFrom, holder.address);
    assert.equal(made.body.fund.how, "grant");
    assert.equal(made.body.fund.grantee, INDEX0);
    assert.match(made.body.fund.header, new RegExp(holder.address));
    const r = all.pepper;
    assert.equal(W.brain.address("pepper"), INDEX0);
    assert.deepEqual(W.brain.payHeaders("pepper"), { "x-brownies-pay-from": holder.address });
    // no grant yet: the gateway says 403, the brownie cannot think, nothing is charged anywhere
    assert.equal(await r.doTask(r.spec.tasks[0]), null);
    assert.ok(log.some((l) => /pepper\] cannot think/.test(l)), log.join("\n"));
    assert.equal(W.gw.chats.length, 0);
    // the holder gives a grant: the brownie thinks, the call carries the header, the grant's room goes down
    W.gw.grants[holder.address.toLowerCase()] = { [INDEX0.toLowerCase()]: 0.5 };
    W.brain.balanceCache.clear();
    const out = await r.doTask(r.spec.tasks[0]);
    assert.ok(out, "the brownie worked");
    assert.equal(W.gw.chats.length, 1);
    assert.equal(W.gw.chats[0].headers["x-brownies-pay-from"], holder.address);
    assert.equal(W.gw.chats[0].wallet, INDEX0.toLowerCase(), "signed by the brownie's own derived wallet");
    assert.ok(W.gw.grants[holder.address.toLowerCase()][INDEX0.toLowerCase()] < 0.5, "paid from the grant");
    assert.equal(W.gw.balances[INDEX0.toLowerCase()], undefined, "the brownie's own balance was never used");
    const mine = await call("GET", "/bake/mine", null, h);
    assert.ok(mine.body.brownies[0].spentTodayUsd > 0);
  } finally { await close(); }
});
