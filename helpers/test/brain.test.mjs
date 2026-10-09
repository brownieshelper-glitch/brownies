// Costs are counted in both modes; the live mode signs the gateway key and stops when the balance is low.
import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { makeWorld } from "./mock.mjs";
import { Brain, BudgetError, keyMessage, keyFromSignature, REASONING_HEADROOM } from "../lib/brain.mjs";

test("prelaunch: the call goes to OpenRouter with usage accounting, the cost is counted, the cap stops the helper", async () => {
  const W = makeWorld({ cost: 0.0023, config: { nib: { dailyCapUsd: 0.005 } } });
  const r = await W.brain.chat("nib", { system: "You are Nib.", prompt: "Say one thing.", maxTokens: 50 });
  assert.equal(r.costMicro, 2300);
  assert.equal(r.model, "test/big");
  const call = W.or.calls[0];
  assert.equal(call.headers.authorization, "Bearer or-test-key");
  assert.deepEqual(call.body.usage, { include: true });
  assert.equal(call.body.max_tokens, 50 + REASONING_HEADROOM, "the answer gets its room plus the headroom for thinking");
  assert.equal(call.body.model, "test/big");
  assert.deepEqual(W.store.spentToday("nib", W.clock.now()), { micro: 2300, calls: 1 });
  await W.brain.chat("nib", { prompt: "Again." });
  assert.equal(W.store.spentToday("nib", W.clock.now()).micro, 4600);
  assert.equal((await W.brain.canSpend("nib")).ok, true, "4600 is under the cap of 5000");
  await W.brain.chat("nib", { prompt: "Once more." });
  const c = await W.brain.canSpend("nib");
  assert.equal(c.ok, false);
  assert.match(c.reason, /daily cap of 0.01 USD reached/);
  await assert.rejects(() => W.brain.chat("nib", { prompt: "No." }), (e) => e instanceof BudgetError && e.helper === "nib");
  assert.equal(W.or.calls.length, 3);
  assert.equal(W.alerts.sent.filter((a) => a.topic === "budget:nib").length, 1);
  assert.match(W.alerts.sent.find((a) => a.topic === "budget:nib").text, /Nib is out of budget: daily cap/);
  assert.ok(W.alerts.sent.some((a) => a.topic.startsWith("nearcap:nib")), "the 80% warning came before the cap");
  // a new day, a new budget
  await W.clock.advance(24 * 3_600_000);
  assert.equal((await W.brain.canSpend("nib")).ok, true);
});

test("prelaunch: a refused OpenRouter key alerts the owner about the credentials", async () => {
  const W = makeWorld();
  W.or.status = 401;
  await assert.rejects(() => W.brain.chat("fudge", { prompt: "x" }), /refused the key/);
  assert.equal(W.alerts.sent[0].topic, "credentials:openrouter");
  assert.match(W.alerts.sent[0].text, /Openrouter refused the brownies' credentials/);
});

test("live: the helper signs the gateway's key message, pays with its balance, and stops under a few cents", async () => {
  const W = makeWorld({ mode: "live" });
  const wallet = new Wallet(W.keys.fudge).address.toLowerCase();
  W.gw.balances[wallet] = 0.06;
  W.gw.chatCost = 0.004;
  const r = await W.brain.chat("fudge", { prompt: "Hello" });
  assert.equal(r.costMicro, 4000);
  assert.equal(W.gw.chats.length, 1);
  assert.equal(W.gw.chats[0].wallet, wallet, "the gateway recovered Fudge's wallet from the key");
  assert.equal(W.or.calls.length, 0, "nothing went to OpenRouter");
  const expected = keyFromSignature(await new Wallet(W.keys.fudge).signMessage(keyMessage(1, 0)), 0);
  assert.equal(W.fetch.callsTo("/v1/chat/completions")[0].headers.authorization, `Bearer ${expected}`);
  assert.deepEqual(W.store.spentToday("fudge", W.clock.now()), { micro: 4000, calls: 1 });
  await W.brain.chat("fudge", { prompt: "Again" });
  assert.equal(W.gw.balances[wallet].toFixed(3), "0.052");
  await W.brain.chat("fudge", { prompt: "Again" });
  const c = await W.brain.canSpend("fudge");
  assert.equal(c.ok, false);
  assert.match(c.reason, /gateway balance 0\.0480 USD/);
  await assert.rejects(() => W.brain.chat("fudge", { prompt: "No" }), BudgetError);
  assert.match(W.alerts.sent[0].text, /Fudge is out of budget\. Deposit SUGAR to the vault, or wait for the next tax claim\./);
  // Crumb has its own wallet and nothing on it
  assert.equal((await W.brain.canSpend("crumb")).ok, false);
});

test("live: a rotated epoch (key_revoked) makes the helper sign the new message and go on", async () => {
  const W = makeWorld({ mode: "live" });
  const wallet = new Wallet(W.keys.chip).address.toLowerCase();
  W.gw.balances[wallet] = 1;
  await W.brain.chat("chip", { prompt: "one" });
  W.gw.accounts[wallet] = { epoch: 2 }; // the owner rotated Chip's key on the gateway
  await W.brain.chat("chip", { prompt: "two" });
  assert.equal(W.gw.chats.length, 2);
  const epochs = (path) => W.fetch.callsTo(path).map((c) => c.headers.authorization.slice(0, 20));
  assert.deepEqual(epochs("/v1/key"), ["Bearer sk-brownie-0-", "Bearer sk-brownie-0-", "Bearer sk-brownie-2-"], "the balance read met the 401 and signed epoch 2");
  assert.deepEqual(epochs("/v1/chat/completions"), ["Bearer sk-brownie-0-", "Bearer sk-brownie-2-"]);
});

test("yesNo reads the first word", async () => {
  const answers = ["YES. Looks fine.", "No, it touches src/.", "  yes", "Yesterday it was fine"];
  const W = makeWorld({ reply: (b, n) => answers[n - 1] });
  const out = [];
  for (let i = 0; i < answers.length; i++) out.push((await W.brain.yesNo("fudge", { prompt: "?" })).yes);
  assert.deepEqual(out, [true, false, true, false]);
});

test("every thought leaves a line on the ledger: model, tokens, job, price, time; the OpenRouter balance is read and cached", async () => {
  const W = makeWorld({ cost: 0.0042 });
  W.or.reply = () => ({ json: { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 321, completion_tokens: 45, completion_tokens_details: { reasoning_tokens: 12 }, cost: 0.0042 } } });
  W.clock.advance(1500);
  await W.brain.chat("chip", { prompt: "Build.", job: "chip-tasks" });
  const [l] = W.store.ledgerRecent(1);
  assert.equal(l.helper, "chip"); assert.equal(l.kind, "ai"); assert.equal(l.model, W.brain.model("chip")); assert.equal(l.job, "chip-tasks");
  assert.equal(l.tokensIn, 321); assert.equal(l.tokensOut, 45); assert.equal(l.tokensThink, 12); assert.equal(l.micro, 4200); assert.equal(l.guessed, false);
  assert.equal(l.day, W.store.dayKey(W.clock.now())); assert.equal(l.at, W.clock.now());
  await W.brain.chat("chip", { prompt: "Again." });
  assert.equal(W.store.ledgerRecent(1)[0].job, null, "no job named, no label");
  assert.equal(W.store.ledgerDay(l.day).find((d) => d.helper === "chip").n, 2);
  // the balance behind the key: bought, used, left; cached for five minutes; nothing without a key
  let reads = 0;
  W.fetch.on("GET", "openrouter.ai/api/v1/credits", () => { reads++; return { json: { data: { total_credits: 60, total_usage: 10.5 } } }; });
  W.fetch.on("GET", "openrouter.ai/api/v1/key", () => ({ json: { data: { usage_daily: 2.4, limit: null, limit_remaining: null } } }));
  assert.deepEqual(await W.brain.openrouterBalance(), { boughtUsd: 60, usedUsd: 10.5, leftUsd: 49.5, usageDailyUsd: 2.4, limitUsd: null, limitLeftUsd: null });
  await W.brain.openrouterBalance(); assert.equal(reads, 1, "cached");
  W.clock.advance(6 * 60_000); await W.brain.openrouterBalance(); assert.equal(reads, 2, "re-read after five minutes");
  assert.equal(await new Brain({ store: W.store, clock: W.clock, fetch: W.fetch }).openrouterBalance(), null);
  // the provider down: the last reading stays
  W.fetch.on("GET", "openrouter.ai/api/v1/credits", () => ({ status: 500, json: {} }));
  W.clock.advance(6 * 60_000);
  assert.equal((await W.brain.openrouterBalance()).leftUsd, 49.5);
});
