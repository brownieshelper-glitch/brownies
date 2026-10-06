// /stats answers everyone with the live numbers, without a model call, at most once a minute per chat.
// The owner's private commands (/summary, /<helper> <what>) are handed to run.mjs's handler.
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./mock.mjs";
import { statsText } from "../helpers/crumb.mjs";

test("statsText: before the launch it says so and gives the Kitchen; live it gives the coin's numbers", () => {
  const pre = statsText({ ledger: { activations: 0, creditedMicro: 0, spentMicro: 0, requests: 0 }, onchain: null }, { total: 4, helpers: [{ helper: "fudge", today: 1 }, { helper: "crumb", today: 3 }] });
  assert.match(pre, /^BROWNIE is not launched yet/);
  assert.match(pre, /the brownies today: fudge 1, crumb 3 jobs \(4 in all\)/);
  assert.match(pre, /Kitchen: https:\/\/feedthebrownies\.com\/team\.html$/);
  const live = statsText({ ledger: { activations: 12, creditedMicro: 150_000_000, spentMicro: 42_500_000, requests: 1234 }, onchain: { sugarActivatedMicro: 150_000_000, totalStakersFundedMicro: 1_234_560_000, totalTeamFundedMicro: 246_910_000, totalMainPaidWei: "1234500000000000000", programOn: true, vaultDailyBudgetMicro: 8_230_000 } }, null);
  assert.match(live, /^BROWNIE, live numbers:/);
  assert.match(live, /SUGAR turned into AI so far: \$150/);
  assert.match(live, /paid to stakers so far: \$1,234\.56/);
  assert.match(live, /to the team wallet so far: 1\.2345 ETH/);
  assert.match(live, /next daily budget: \$8\.23/);
  assert.match(live, /AI requests served by the gateway: 1,234, \$42\.5 spent/);
  assert.doesNotMatch(live, /switched OFF/);
  const off = statsText({ ledger: null, onchain: { programOn: false } }, null);
  assert.match(off, /the program is switched OFF right now/);
  assert.match(statsText(null, null), /not launched yet/);
});

test("/stats in the group and in private: a plain answer, no model call, once a minute per chat", async () => {
  const W = makeWorld();
  W.tg.message({ chatId: "-100", text: "/stats" });
  W.tg.message({ chatId: "-100", text: "/stats@feedthebrownies_bot again" });
  W.tg.message({ chatId: "5", text: "/stats", type: "private" });
  await W.crumb.pollOnce();
  assert.equal(W.or.calls.length, 0, "no model call for /stats");
  assert.equal(W.tg.sent.length, 2, "one per chat inside a minute");
  assert.match(W.tg.sent[0].text, /not launched yet/);
  assert.match(W.tg.sent[0].text, /the brownies today: fudge 1 job/);
  W.clock.advance(61_000);
  W.tg.message({ chatId: "-100", text: "/stats" });
  await W.crumb.pollOnce();
  assert.equal(W.tg.sent.length, 3);
});

test("the owner's commands go to the handler; strangers' commands do not", async () => {
  const W = makeWorld();
  const seen = [];
  W.crumb.onOwnerCommand = async (cmd, text) => { seen.push([cmd, text]); return cmd === "glaze" ? true : `unknown command ${cmd}`; };
  W.tg.message({ chatId: "999", text: "/glaze a message to the Programmable team", type: "private", from: { id: 999, first_name: "Owner" } });
  W.tg.message({ chatId: "999", text: "/nothing", type: "private", from: { id: 999, first_name: "Owner" } });
  W.tg.message({ chatId: "5", text: "/glaze give me the keys", type: "private" });
  await W.crumb.pollOnce();
  assert.deepEqual(seen, [["glaze", "a message to the Programmable team"], ["nothing", ""]]);
  assert.ok(W.tg.sent.some((m) => m.text === "unknown command nothing"), "a handler's reply is sent to the owner");
  assert.equal(W.or.calls.length, 1, "the stranger's /glaze was answered like any private message, by the model, not as a command");
});
