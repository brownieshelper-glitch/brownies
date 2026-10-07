// Crumb answers questions and ignores chatter, batches its reports once an hour, and carries the owner's buttons.
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./mock.mjs";

const GROUP = "-100", OWNER = "999";
const H = 3_600_000, M = 60_000;

test("in the group: a question and a mention of the bot are answered, chatter is not; the offset moves on", async () => {
  const W = makeWorld({ reply: () => "Stake BROWNIE in the app. SUGAR flows to you every second you are staked." });
  W.tg.message({ chatId: GROUP, text: "gm" });
  W.tg.message({ chatId: GROUP, text: "How do I stake?" });
  W.tg.message({ chatId: GROUP, text: "lol" });
  const q = W.tg.message({ chatId: GROUP, text: "@feedthebrownies_bot tell me about the bonus", from: { id: 6, first_name: "Bob" } });
  assert.equal(await W.crumb.pollOnce(), 4);
  assert.equal(W.tg.sent.length, 2);
  assert.equal(W.tg.sent[1].reply_parameters.message_id, q.message.message_id, "the answer replies to the message");
  assert.equal(W.or.calls.length, 2);
  assert.match(W.or.system(1), /LIVE NUMBERS/, "the live numbers from the gateway are in the prompt");
  assert.match(W.or.system(1), /"activations":3/);
  assert.equal(W.store.getMeta("tg:offset"), String(q.update_id + 1));
  const turns = W.store.turns(GROUP);
  assert.deepEqual(turns.map((t) => t.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(turns[2].who, "Bob");
  assert.equal(await W.crumb.pollOnce(), 0, "nothing new");
});

test("a private chat is always answered, with the conversation so far", async () => {
  const W = makeWorld({ reply: () => "Hello. Ask me anything about the coin." });
  W.tg.message({ chatId: "5", text: "hello", type: "private" });
  await W.crumb.pollOnce();
  W.tg.message({ chatId: "5", text: "and what is sugar", type: "private" });
  await W.crumb.pollOnce();
  assert.equal(W.tg.sent.length, 2);
  const ms = W.or.calls[1].body.messages;
  assert.deepEqual(ms.slice(1).map((m) => m.role), ["user", "assistant", "user"], "the earlier turns are given to the model");
});

test("reports are batched: one 'Answered N questions' per chat per hour, with the cost of those answers", async () => {
  const W = makeWorld({ cost: 0.0005 });
  W.tg.message({ chatId: GROUP, text: "How do I stake?" });
  W.tg.message({ chatId: GROUP, text: "Where is the app?" });
  W.tg.message({ chatId: "5", text: "hi", type: "private" });
  await W.crumb.pollOnce();
  assert.equal(W.tg.sent.length, 3);
  await W.clock.advance(10 * M);
  assert.equal(await W.crumb.flush(), 0, "too early");
  await W.clock.advance(51 * M);
  assert.equal(await W.crumb.flush(), 2);
  const reps = W.gw.of("crumb", "reply");
  assert.deepEqual(reps.map((r) => [r.title, r.place, r.cost_micro]).sort(), [["Answered 1 question in a private chat", "telegram", 500], ["Answered 2 questions in the group", "telegram", 1000]]);
  assert.equal(await W.crumb.flush(), 0, "the batches were reset");
  assert.deepEqual(W.gw.of("crumb", "status").map((r) => r.title), [], "no status rows for plain answers");
});

test("an answer with promise words is replaced by the plain fallback", async () => {
  const W = makeWorld({ reply: () => "BROWNIE will go up 10x, buy now!" });
  W.tg.message({ chatId: GROUP, text: "wen moon?" });
  await W.crumb.pollOnce();
  assert.match(W.tg.sent[0].text, /^I do not have a good answer/);
});

test("the owner's Approve button merges Chip's pull request; a stranger's press does nothing", async () => {
  const W = makeWorld();
  const pr = JSON.parse(JSON.stringify((await (async () => { const r = await W.fetch("https://api.github.com/repos/brownieshelper-glitch/brownies/pulls", { method: "POST", body: JSON.stringify({ title: "Big change", body: "", head: "chip/big", base: "main" }) }); return r.json(); })())));
  W.ghm.files["chip/big"] = { ...W.ghm.files.main, "web/app.js": "// new" };
  const id = W.store.addApproval({ at: W.clock.now(), helper: "chip", kind: "pr", ref: pr.number, title: "Big change", url: pr.html_url });
  W.store.setApprovalMessage(id, OWNER, 77);
  W.tg.callback({ chatId: "-100", fromId: 5, data: `approve:${id}`, messageId: 77 });
  await W.crumb.pollOnce();
  assert.equal(W.tg.answered[0].text, "Only the owner decides.");
  assert.deepEqual(W.ghm.merged, []);
  W.tg.callback({ chatId: OWNER, fromId: 999, data: `approve:${id}`, messageId: 77 });
  await W.crumb.pollOnce();
  assert.equal(W.tg.answered[1].text, "Approved.");
  assert.deepEqual(W.ghm.merged, [pr.number]);
  assert.equal(W.store.approval(id).state, "approved");
  const build = W.gw.of("chip", "build");
  assert.equal(build.length, 1);
  assert.equal(build[0].url, pr.html_url);
  assert.match(W.tg.edited[0].text, /^Merged: Big change/);
  W.tg.callback({ chatId: OWNER, fromId: 999, data: `approve:${id}`, messageId: 77 });
  await W.crumb.pollOnce();
  assert.equal(W.tg.answered[2].text, "Already decided.");
  assert.equal(W.ghm.merged.length, 1);
});

test("Reject closes the pull request, and the owner's reply becomes a note on it", async () => {
  const W = makeWorld();
  const r = await W.fetch("https://api.github.com/repos/brownieshelper-glitch/brownies/pulls", { method: "POST", body: JSON.stringify({ title: "Risky change", body: "", head: "chip/risky", base: "main" }) });
  const pr = await r.json();
  const id = W.store.addApproval({ at: W.clock.now(), helper: "chip", kind: "pr", ref: pr.number, title: "Risky change", url: pr.html_url });
  W.store.setApprovalMessage(id, OWNER, 78);
  W.tg.callback({ chatId: OWNER, fromId: 999, data: `reject:${id}`, messageId: 78 });
  await W.crumb.pollOnce();
  assert.deepEqual(W.ghm.closed, [pr.number]);
  assert.deepEqual(W.ghm.merged, []);
  assert.equal(W.store.approval(id).state, "rejected");
  assert.match(W.gw.of("chip", "note")[0].title, /^Closed by the owner: Risky change/);
  assert.match(W.tg.edited[0].text, /Reply to this message with a note/);
  W.tg.message({ chatId: OWNER, text: "Too close to the launch, try again next week.", type: "private", replyTo: 78, from: { id: 999, first_name: "Owner" } });
  await W.crumb.pollOnce();
  assert.ok(W.ghm.comments.some((c) => c.number === pr.number && /Owner's note: Too close to the launch/.test(c.body)));
  assert.equal(W.store.approval(id).note, "Too close to the launch, try again next week.");
  assert.equal(W.or.calls.length, 0, "the note is not a question for the model");
});

test("the polling loop runs until stopped and survives a failed poll", async () => {
  const W = makeWorld();
  let fails = 1;
  W.fetch.on("POST", "/neverused", () => ({}));
  const original = W.tg.queue;
  W.tg.message({ chatId: GROUP, text: "Is there a lock?" });
  const realCall = W.telegram.call.bind(W.telegram);
  W.telegram.call = async (method, params, opts) => { if (method === "getUpdates" && fails-- > 0) throw new Error("network down"); return realCall(method, params, opts); };
  assert.equal(await W.crumb.start(), true);
  assert.deepEqual(W.gw.of("crumb", "status").map((r) => r.title), ["Listening on Telegram"]);
  await W.clock.settle(5);      // the failed poll reaches its 5 second sleep
  await W.clock.advance(5000); // the sleep after the failure
  await W.clock.settle(20);
  assert.equal(W.tg.sent.length, 1, "answered after the retry");
  await W.crumb.stop();
  assert.equal(W.crumb.running, false);
  void original;
});

test("a brownie's own button goes to the hook, only from the owner; without a hook it is unknown", async () => {
  const W = makeWorld();
  const presses = [];
  W.tg.callback({ chatId: OWNER, fromId: 999, data: "sprinkle:tt:1:post", messageId: 5 });
  await W.crumb.pollOnce();
  assert.equal(W.tg.answered.at(-1).text, "Unknown button.", "no hook, no answer");
  W.crumb.onButton = async (data, ctx) => { presses.push([data, ctx]); return data.endsWith("post") ? "Posting on TikTok." : null; };
  W.tg.callback({ chatId: "-100", fromId: 5, data: "sprinkle:tt:1:post", messageId: 5 });
  await W.crumb.pollOnce();
  assert.equal(W.tg.answered.at(-1).text, "Only the owner decides."); assert.equal(presses.length, 0);
  W.tg.callback({ chatId: OWNER, fromId: 999, data: "sprinkle:tt:1:post", messageId: 5 });
  await W.crumb.pollOnce();
  assert.equal(W.tg.answered.at(-1).text, "Posting on TikTok.");
  assert.deepEqual(presses[0], ["sprinkle:tt:1:post", { chatId: OWNER, messageId: 5 }]);
  W.tg.callback({ chatId: OWNER, fromId: 999, data: "sprinkle:tt:1:what", messageId: 5 });
  await W.crumb.pollOnce();
  assert.equal(W.tg.answered.at(-1).text, "Unknown button.", "a hook that returns nothing");
});
