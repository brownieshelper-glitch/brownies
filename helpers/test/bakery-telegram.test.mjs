// Stage three of the Bakery: a holder links the private chat with the bot to their brownie with a code from the
// page; the brownie's drafts and answers reach that chat; /mybrownie shows how it is doing, instructs it, lists its
// work, unlinks and retires; a wrong code and an unlinked chat get plain answers; the routes hand out and forget
// the link.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Wallet } from "ethers";
import { makeWorld } from "./mock.mjs";
import { Recruit } from "../lib/recruit.mjs";
import { Bakery, bakeMessage } from "../lib/bakery.mjs";

function shop({ admins = [] } = {}) {
  const W = makeWorld({ reply: () => "Today the brownies did four jobs. The tax is 2% on every trade and SUGAR pays one dollar of AI." });
  const all = { fudge: W.fudge, crumb: W.crumb, nib: W.nib, chip: W.chip };
  const log = [];
  const deps = (name) => ({ config: W.helpersCfg[name] || {}, brain: W.brain, gateway: W.gateway, store: W.store, clock: W.clock, alerts: W.alerts, facts: "facts", log: (l) => log.push(String(l)) });
  const recruitNames = () => String(W.store.getMeta("recruits", "")).split(",").filter(Boolean);
  const hire = async (spec) => {
    W.store.setMeta(`recruit:${spec.name}`, JSON.stringify(spec));
    W.store.setMeta("recruits", [...recruitNames().filter((n) => n !== spec.name), spec.name].join(","));
    W.brain.helpers[spec.name] = { role: spec.role, model: spec.model, dailyCapUsd: spec.dailyCapUsd, hidden: spec.hidden };
    const r = new Recruit({ ...deps(spec.name), telegram: W.telegram, github: W.github, ownerChatId: "999", groupChatId: "-100", spec });
    all[spec.name] = r;
    return r;
  };
  const fire = async (name) => { if (!all[name]?.recruit) return false; delete all[name]; W.store.setMeta("recruits", recruitNames().filter((n) => n !== name).join(",")); return true; };
  const recruits = () => Object.values(all).filter((h) => h.recruit);
  const roster = () => Object.entries(all).map(([name, h]) => ({ name, role: W.helpersCfg[name]?.role || h.role || "" }));
  const world = { S: { mode: "prelaunch", telegram: { ownerChatId: "999", groupChatId: "-100" }, gatewayUrl: "https://gw.test" }, store: W.store, clock: W.clock, brain: W.brain, telegram: W.telegram, gateway: W.gateway, config: { chainId: 1, timezone: "UTC" } };
  const bakery = new Bakery({ W: world, log: (l) => log.push(String(l)), origins: ["https://site.test"], hire, fire, recruits, roster, config: { asksPerDay: 2, models: ["anthropic/claude-haiku-4.5"] }, adminWallets: admins });
  W.crumb.onHolderCommand = (cmd, rest, ctx) => bakery.holderCommand(cmd, rest, ctx);
  return { W, all, bakery, log };
}
const HOLDER_CHAT = 4242;
async function say(W, text, chatId = HOLDER_CHAT) {
  W.tg.message({ chatId, text, type: "private", from: { id: chatId, first_name: "Holder" } });
  await W.crumb.pollOnce();
  const m = W.tg.sent.at(-1);
  return { text: m.text, chat: String(m.chat_id) };
}

test("a holder links the chat with a code; drafts and answers reach it; /mybrownie shows, instructs, lists, unlinks and retires", async () => {
  const admin = Wallet.createRandom();
  const { W, all, bakery, log } = shop({ admins: [admin.address] });
  await bakery.create(admin.address, { name: "sage", role: "a holder's helper that watches the coin", personality: "calm", tasks: [{ menu: "watch" }, { menu: "digest" }] });
  const r = all.sage;
  const owner = W.tg.sent.length; // the owner heard about the bake
  // an unlinked chat, a wrong code
  let a = await say(W, "/mybrownie");
  assert.match(a.text, /^No brownie is linked to this chat yet/); assert.equal(a.chat, "4242");
  a = await say(W, "/link 000000");
  assert.match(a.text, /not valid or has expired/);
  a = await say(W, "/link abc");
  assert.match(a.text, /six-digit code/);
  // the code from the page
  const { code, bot, url, expiresAt } = await bakery.linkCode(admin.address, "sage");
  assert.match(code, /^\d{6}$/); assert.equal(bot, "@feedthebrownies_bot"); assert.ok(expiresAt > W.clock.now());
  assert.equal(url, `https://t.me/feedthebrownies_bot?start=link_${code}`, "the deep link carries the code");
  await assert.rejects(bakery.linkCode(Wallet.createRandom().address, "sage"), /not one of your brownies/);
  a = await say(W, `/link ${code}`);
  assert.match(a.text, /^Linked\. Sage's drafts and answers come to this chat/);
  assert.equal(r.spec.baked.chatId, "4242"); assert.equal(r.baked.chatId, "4242");
  assert.equal(JSON.parse(W.store.getMeta("recruit:sage")).baked.chatId, "4242", "kept across a restart");
  assert.equal(bakery.view(r).telegram, true);
  assert.equal(bakery.consumeLink(code, "1"), null, "a code works once");
  // a draft goes to the holder's chat now, not to the owner
  const sentBefore = W.tg.sent.length;
  const d = await r.doTask(r.spec.tasks[1]);
  assert.equal(d.place, "telegram"); assert.equal(d.where, "to the holder");
  assert.equal(W.tg.sent.length, sentBefore + 1);
  assert.equal(String(W.tg.sent.at(-1).chat_id), "4242"); assert.match(W.tg.sent.at(-1).text, /^Sage, Evening digest:/);
  assert.ok(W.tg.sent.slice(owner).every((m) => String(m.chat_id) !== "999"), "nothing of the holder's went to the owner");
  // how it is doing, its work, an instruction
  a = await say(W, "/mybrownie");
  assert.match(a.text, /^Sage: a holder's helper that watches the coin\nJobs: Daily watch at 9:00; Evening digest at 20:00\nJobs done: 1\. Spent today: 0\.0010 of 1\.00 USD\.\nLatest: Evening digest, just now\.$/);
  a = await say(W, "/mybrownie feed");
  assert.match(a.text, /^Sage's latest work:\n\nEvening digest, just now:\n/);
  a = await say(W, "/mybrownie ask Write one line about SUGAR.");
  assert.match(a.text, /^Sage is on it\. The answer comes here and lands in its feed\. 1 instruction left today\.$/);
  await new Promise((res) => setTimeout(res, 40));
  const answer = W.tg.sent.at(-1);
  assert.equal(String(answer.chat_id), "4242");
  assert.match(answer.text, /^Sage: Today the brownies did four jobs/);
  assert.equal(r.feed()[0].task, "ask");
  a = await say(W, "/mybrownie ask Another."); await new Promise((res) => setTimeout(res, 40));
  a = await say(W, "/mybrownie ask A third.");
  assert.match(a.text, /2 instructions a day; more tomorrow/);
  a = await say(W, "/mybrownie dance");
  assert.match(a.text, /^Commands: \/mybrownie/);
  // unlink: drafts go back to the feed only
  a = await say(W, "/mybrownie unlink");
  assert.match(a.text, /^Unlinked\. Sage's drafts stay in its feed/);
  assert.equal(r.spec.baked.chatId, null);
  const n = W.tg.sent.length;
  const d2 = await r.doTask(r.spec.tasks[1]);
  assert.equal(d2.place, "bakery"); assert.equal(W.tg.sent.length, n);
  // retire asks once more
  bakery.consumeLink((await bakery.linkCode(admin.address, "sage")).code, "4242");
  a = await say(W, "/mybrownie retire");
  assert.match(a.text, /Send: \/mybrownie retire yes$/);
  a = await say(W, "/mybrownie retire yes");
  assert.match(a.text, /^Sage is retired\.$/);
  assert.equal(all.sage, undefined);
  a = await say(W, "/mybrownie");
  assert.match(a.text, /^No brownie is linked/);
  assert.ok(log.some((l) => /Sage is linked to a Telegram chat/.test(l)));
  // the same words in the group are not for the Bakery: Crumb treats them as a message, nothing is linked
  const groupBefore = W.tg.sent.length;
  W.tg.message({ chatId: -100, text: "/mybrownie", type: "supergroup", from: { id: 7, first_name: "Ann" } });
  await W.crumb.pollOnce();
  assert.ok(!W.tg.sent.slice(groupBefore).some((m) => /No brownie is linked/.test(m.text)), "no Bakery answer in the group");
});

test("the routes hand out a code and forget the link; an expired code is refused", async () => {
  const admin = Wallet.createRandom();
  const { W, bakery, all } = shop({ admins: [admin.address] });
  const server = createServer((req, res) => (req.url.startsWith("/bake/") ? bakery.handle(req, res) : (res.writeHead(404), res.end())));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json", origin: "https://site.test", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  try {
    const n = await call("GET", "/bake/nonce");
    const signature = await admin.signMessage(bakeMessage(n.body.nonce));
    const token = (await call("POST", "/bake/login", { address: admin.address, signature, nonce: n.body.nonce })).body.token;
    await call("POST", "/bake/create", { name: "sage", role: "a holder's helper that watches the coin", tasks: [{ menu: "watch" }] }, token);
    assert.equal((await call("POST", "/bake/link", { name: "nobody" }, token)).status, 400);
    const link = await call("POST", "/bake/link", { name: "sage" }, token);
    assert.equal(link.status, 200);
    assert.match(link.body.code, /^\d{6}$/); assert.equal(link.body.bot, "@feedthebrownies_bot"); assert.equal(link.body.name, "sage");
    assert.equal((await call("GET", "/bake/mine", null, token)).body.brownies[0].telegram, false);
    assert.ok(bakery.consumeLink(link.body.code, "77"));
    assert.equal((await call("GET", "/bake/mine", null, token)).body.brownies[0].telegram, true);
    assert.deepEqual((await call("POST", "/bake/unlink", { name: "sage" }, token)).body, { unlinked: true });
    assert.equal((await call("GET", "/bake/mine", null, token)).body.brownies[0].telegram, false);
    assert.equal(all.sage.spec.baked.chatId, null);
    const late = await call("POST", "/bake/link", { name: "sage" }, token);
    W.clock.advance(11 * 60_000);
    assert.equal(bakery.consumeLink(late.body.code, "77"), null, "ten minutes, then the code is gone");
  } finally { await new Promise((r) => server.close(r)); }
});

test("the deep link: Telegram's /start link_<code> links the chat; a plain /start is answered like any message, not by the Bakery", async () => {
  const admin = Wallet.createRandom();
  const { W, all, bakery } = shop({ admins: [admin.address] });
  await bakery.create(admin.address, { name: "sage", role: "a holder's helper that watches the coin", tasks: [{ menu: "watch" }] });
  const { code } = await bakery.linkCode(admin.address, "sage");
  let a = await say(W, `/start link_${code}`);
  assert.match(a.text, /^Linked\. Sage's drafts/);
  assert.equal(all.sage.spec.baked.chatId, "4242");
  a = await say(W, "/start");
  assert.ok(!/Linked|No brownie is linked|not valid/.test(a.text), "a plain /start is Crumb's greeting, not a Bakery answer: " + a.text);
  a = await say(W, "/start link_000000");
  assert.match(a.text, /not valid or has expired/);
  assert.equal((await bakery.linkCode(admin.address, "sage")).url.startsWith("https://t.me/feedthebrownies_bot?start=link_"), true);
});
