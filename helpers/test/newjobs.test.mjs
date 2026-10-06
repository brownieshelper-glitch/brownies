// The jobs added on the first live day: Crumb finds its group by itself and writes the day's questions digest,
// Fudge posts on the site when X refuses and tells the model what really happened today, Nib lists the coins
// launched through Programmable from the chain.
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./mock.mjs";
import { Crumb } from "../helpers/crumb.mjs";
import { iface, GRAPH_TOPIC, LAUNCH_TOPIC, GRAPH_DEPLOYER, recentLaunches, launchesBlock } from "../lib/launches.mjs";
import { AbiCoder } from "ethers";

const H = 3_600_000;

test("crumb: added to a group with no group configured, it adopts that group and remembers it across restarts", async () => {
  const W = makeWorld();
  // a Crumb with no group id, like the server before the owner made the group
  const crumb = new Crumb({ config: W.helpersCfg.crumb, brain: W.brain, gateway: W.gateway, store: W.store, clock: W.clock, alerts: W.alerts, facts: "facts", log: () => {}, telegram: W.telegram, groupChatId: "", ownerChatId: "999" });
  assert.equal(crumb.groupChatId, "");
  W.tg.queue.push({ update_id: ++W.tg.updateSeq, my_chat_member: { chat: { id: -1001234, type: "supergroup", title: "Brownies" }, new_chat_member: { status: "administrator", user: { id: 777 } } } });
  await crumb.pollOnce();
  assert.equal(crumb.groupChatId, "-1001234", "the group it was added to is the group now");
  assert.equal(W.store.getMeta("tg:group:auto"), "-1001234");
  assert.equal(W.store.getMeta("tg:group:-1001234"), "Brownies");
  // a question there is answered; chatter is not
  W.tg.message({ chatId: "-1001234", text: "hello hello" });
  W.tg.message({ chatId: "-1001234", text: "what is SUGAR?" });
  await crumb.pollOnce();
  assert.equal(W.tg.sent.length, 1);
  // a second group does not take over
  W.tg.message({ chatId: "-1009999", text: "is this the brownies?" });
  await crumb.pollOnce();
  assert.equal(crumb.groupChatId, "-1001234");
  assert.equal(W.tg.sent.length, 1, "no answer in a group that is not the group");
  // a restart with the same store finds the group again
  const again = new Crumb({ config: W.helpersCfg.crumb, brain: W.brain, gateway: W.gateway, store: W.store, clock: W.clock, alerts: W.alerts, facts: "facts", log: () => {}, telegram: W.telegram, groupChatId: "", ownerChatId: "999" });
  assert.equal(again.groupChatId, "-1001234");
  // removed from it: forgotten
  W.tg.queue.push({ update_id: ++W.tg.updateSeq, my_chat_member: { chat: { id: -1001234, type: "supergroup", title: "Brownies" }, new_chat_member: { status: "kicked", user: { id: 777 } } } });
  await crumb.pollOnce();
  assert.equal(crumb.groupChatId, "");
});

test("crumb: a configured group id wins, and a message in the group remembers its title", async () => {
  const W = makeWorld();
  W.tg.message({ chatId: "-100", text: "gm" });
  await W.crumb.pollOnce();
  assert.equal(W.crumb.groupChatId, "-100");
  assert.equal(W.store.getMeta("tg:group:-100"), "", "the mock chat has no title");
  W.tg.queue.push({ update_id: ++W.tg.updateSeq, my_chat_member: { chat: { id: -200, type: "supergroup", title: "Another" }, new_chat_member: { status: "member", user: { id: 777 } } } });
  await W.crumb.pollOnce();
  assert.equal(W.crumb.groupChatId, "-100", "a second group is remembered but not adopted");
  assert.equal(W.store.getMeta("tg:group:-200"), "Another");
});

test("crumb: the day's questions become notes/questions/<date>.md with a Q and an A each, reported once", async () => {
  const W = makeWorld({ reply: (body) => (/questions digest/.test(body.messages[0].content) ? "Q: What is SUGAR?\nA: One SUGAR pays for one dollar of AI on the gateway.\n\nQ: When is the launch?\nA: not in the facts yet\n" : "SUGAR is one dollar of AI.") });
  W.tg.message({ chatId: "-100", text: "what is sugar?" });
  W.tg.message({ chatId: "-100", text: "what is sugar??", from: { id: 7, first_name: "Cy" } });
  W.tg.message({ chatId: "5", text: "when is the launch", type: "private" });
  W.tg.message({ chatId: "999", text: "is the server fine?", type: "private" }); // the owner's own chat is not part of the digest
  await W.crumb.pollOnce();
  assert.equal(W.tg.sent.length, 4);
  W.clock.advance(2 * H);
  const r = await W.crumb.questionsDigest();
  assert.equal(r.asked, 3, "three messages from people, the owner's left out");
  assert.equal(r.questions, 2);
  const date = W.store.dayKey(W.clock.now());
  const file = W.ghm.files.main[`notes/questions/${date}.md`];
  assert.ok(file, "the digest is in the repository");
  assert.match(file, /^# Questions of /);
  assert.match(file, /Q: What is SUGAR\?/);
  assert.match(file, /not in the facts yet/);
  assert.equal(W.ghm.commits.at(-1).message, `Crumb: questions of ${date}`);
  const rep = W.gw.of("crumb", "note").at(-1);
  assert.equal(rep.title, "Questions of the day: 2 distinct from 3 messages");
  assert.equal(rep.place, "github");
  assert.match(W.or.lastUser(), /\[group\] Ann: what is sugar\?/);
  assert.match(W.or.lastUser(), /\[private\] Ann: when is the launch/);
  // nothing new: the next digest writes nothing and costs nothing
  const calls = W.or.calls.length;
  W.clock.advance(24 * H);
  assert.equal(await W.crumb.questionsDigest(), null);
  assert.equal(W.or.calls.length, calls);
  assert.equal(W.crumb.jobs().find((j) => j.id === "crumb-questions").daily.hours[0], 20);
});

test("fudge: when X refuses the post, it still goes out on the site and the owner is told; the day's count includes it", async () => {
  const W = makeWorld({ x: { valid: false }, reply: () => "Half of every trade's tax reaches stakers as SUGAR, one dollar of AI each." });
  W.xm.refuseRefresh = true; // the account is dead: the token cannot be renewed either
  const r = await W.fudge.post({ nth: 1 });
  assert.equal(r.place, "site");
  assert.equal(r.url, "https://feedthebrownies.com/posts.html");
  assert.equal(W.xm.posts.length, 0, "nothing reached X");
  const rep = W.gw.of("fudge", "post")[0];
  assert.equal(rep.place, "site");
  assert.equal(rep.url, "https://feedthebrownies.com/posts.html");
  assert.match(rep.title, /SUGAR/);
  assert.equal(W.fudge.postsToday(W.clock.now()), 1, "a site-only post counts toward the three a day");
  assert.ok(W.tg.sent.some((m) => /x|X/.test(m.text) && /refused|credentials|cannot|token/i.test(m.text)), "the owner hears that X refused");
  // the same text is not posted again anywhere
  const again = await W.fudge.post({ nth: 2 });
  assert.equal(again, null);
});

test("fudge: without X configured the post goes out on the site alone", async () => {
  const W = makeWorld({ reply: () => "Four brownies work for the coin. Fudge writes, Crumb answers, Nib reads, Chip builds." });
  W.fudge.x = { configured: false };
  const r = await W.fudge.post({ nth: 1 });
  assert.equal(r.place, "site");
  assert.equal(W.gw.of("fudge", "post")[0].place, "site");
});

test("fudge: the post prompt carries what the brownies really did today, from the Kitchen", async () => {
  const W = makeWorld({ reply: () => "The Kitchen shows one job by Fudge today, and a post being written." });
  W.gw.summary = { now: 0, helpers: [{ helper: "fudge", total: 4, today: 1, status: { title: "Writing a post", at: 0 } }, { helper: "chip", total: 0, today: 0, status: null }], week: {}, total: 4 };
  await W.fudge.post({ nth: 1 });
  const u = W.or.lastUser();
  assert.match(u, /TODAY'S WORK, read from the Kitchen just now/);
  assert.match(u, /- fudge: 1 job today, 4 in all, now: Writing a post/);
  assert.match(u, /- chip: 0 jobs today, 0 in all/);
});

test("nib: the coins launched through Programmable are read from the chain and listed in the note", async () => {
  const W = makeWorld({ reply: () => "## What changed\nOne coin launched.\n\n## What to do\nFudge: say so." });
  const RPC = "https://rpc.test";
  const coder = AbiCoder.defaultAbiCoder();
  const token = "0x1111111111111111111111111111111111111111", creator = "0x2222222222222222222222222222222222222222", weth = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const launch = iface.encodeEventLog("FoundationLaunchedV3", [token, creator, "0x" + "ab".repeat(32), "0x" + "33".repeat(20), "0x" + "44".repeat(20), weth, "0x" + "55".repeat(32), "0x" + "66".repeat(32), "0x" + "77".repeat(32), 10n ** 15n, [token, "0x" + "33".repeat(20), "0x" + "44".repeat(20), "0x" + "ab".repeat(32), creator, creator, creator, 1n, 2n, 3n, 4n, 5n, 6n, 7n]]);
  const seen = [];
  W.fetch.on("POST", RPC, (c) => {
    seen.push(c.body.method);
    if (c.body.method === "eth_blockNumber") return { json: { jsonrpc: "2.0", id: 1, result: "0x" + (26_000_000).toString(16) } };
    if (c.body.method === "eth_getLogs") {
      const q = c.body.params[0];
      assert.equal(q.address, GRAPH_DEPLOYER, "the deployer's address anchors the query");
      assert.deepEqual(q.topics, [GRAPH_TOPIC]);
      return { json: { jsonrpc: "2.0", id: 1, result: Number(q.fromBlock) <= 25_999_000 && Number(q.toBlock) >= 25_999_000 ? [{ transactionHash: "0xtx1", blockNumber: "0x" + (25_999_000).toString(16), topics: [GRAPH_TOPIC], data: "0x" }] : [] } };
    }
    if (c.body.method === "eth_getTransactionReceipt") return { json: { jsonrpc: "2.0", id: 1, result: { blockNumber: "0x" + (25_999_000).toString(16), logs: [{ topics: ["0x" + "00".repeat(32)], data: "0x" }, { topics: launch.topics, data: launch.data }] } } };
    if (c.body.method === "eth_call") return { json: { jsonrpc: "2.0", id: 1, result: coder.encode(["string"], [c.body.params[0].data === "0x06fdde03" ? "Santa Claus" : "SANTA"]) } };
    return { json: { jsonrpc: "2.0", id: 1, error: { message: "unknown" } } };
  });
  const list = await recentLaunches({ rpcUrls: ["https://dead.test", RPC], hours: 24, fetch: (u, i) => (u === "https://dead.test" ? Promise.reject(new Error("no route")) : W.fetch(u, i)) });
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "Santa Claus");
  assert.equal(list[0].symbol, "SANTA");
  assert.equal(list[0].unit, "ETH");
  assert.equal(list[0].initialBuy, 0.001);
  const block = launchesBlock(list, { hours: 24, max: 15 });
  assert.match(block, /1 coin launched:/);
  assert.match(block, /- Santa Claus \(SANTA\) token 0x1111/);
  assert.match(block, /first buy 0.001 ETH/);
  assert.ok(seen.includes("eth_getTransactionReceipt"));

  // Nib puts the block in its prompt
  W.nib.rpcUrl = RPC;
  W.nib.launches = { hours: 24, max: 15, rpcUrls: [RPC] };
  W.nib.fetch = W.fetch;
  await W.nib.note();
  assert.match(W.or.lastUser(), /PROGRAMMABLE LAUNCHES \(Ethereum, last 24 hours, read from the chain\): 1 coin launched/);
  assert.match(W.or.lastUser(), /Santa Claus/);
  assert.equal(launchesBlock([], { hours: 24 }), "PROGRAMMABLE LAUNCHES (Ethereum, last 24 hours, read from the chain): 0 coins launched.");
  assert.equal(LAUNCH_TOPIC.length, 66);
});

test("nib: a chain that does not answer leaves one plain line in the prompt and the note is still written", async () => {
  const W = makeWorld({ reply: () => "## What changed\nNothing.\n\n## What to do\nWait." });
  W.fetch.on("POST", "https://down.test", () => ({ status: 500, json: { error: { message: "down" } } }));
  W.nib.launches = { hours: 24, rpcUrls: ["https://down.test"] };
  W.nib.fetch = W.fetch;
  const r = await W.nib.note();
  assert.ok(r);
  assert.match(W.or.lastUser(), /PROGRAMMABLE LAUNCHES \(Ethereum, last day\): \[the chain could not be read today\]/);
});
