// The owner's daily summary: what each brownie did and spent, what waits, what failed; sent once to the owner.
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./mock.mjs";
import { buildSummary, sendSummary } from "../lib/summary.mjs";

const H = 3_600_000;

test("the summary lists each brownie's day, the spend against the cap, what waits for the owner and what failed", async () => {
  const W = makeWorld();
  const now = W.clock.now();
  W.store.jobDone({ at: now - 2 * H, helper: "fudge", job: "post", ok: true, costMicro: 1200, note: "A post about SUGAR" });
  W.store.jobDone({ at: now - H, helper: "fudge", job: "post", ok: true, costMicro: 900, note: "A second post" });
  W.store.jobDone({ at: now - H, helper: "fudge", job: "reply", ok: true, costMicro: 300, note: "Answered @ann" });
  W.store.jobDone({ at: now - H, helper: "nib", job: "research", ok: true, costMicro: 20_000, note: "Research note" });
  W.store.jobDone({ at: now - H, helper: "chip", job: "pr", ok: false, costMicro: 5000, note: "the model did not answer with JSON" });
  W.store.addSpend("fudge", 2400, now); W.store.addSpend("nib", 20_000, now); W.store.addSpend("chip", 5000, now);
  const id = W.store.addApproval({ at: now, helper: "chip", kind: "pr", ref: 7, title: "Add a FAQ page", url: "https://github.com/x/y/pull/7" });
  const text = buildSummary({ store: W.store, now, helpers: ["fudge", "crumb", "nib", "chip", "glaze"], caps: { fudge: 1.5, crumb: 2, nib: 1, chip: 3, glaze: 1.5 }, mode: "prelaunch", hidden: ["glaze"], pendingApprovals: W.store.pendingApprovals(), failures: W.store.jobsSince("chip", W.store.dayStart(now)).filter((j) => !j.ok) });
  assert.match(text, /^Brownies, \d{4}-\d{2}-\d{2}\. MODE=prelaunch\./);
  assert.match(text, /Fudge: 2 posts, 1 reply\. Spent \$0\.00 of \$1\.50\. Last: Answered @ann/);
  assert.match(text, /Crumb: nothing yet\. Spent \$0\.00 of \$2\.00\./);
  assert.match(text, /Nib: 1 research\. Spent \$0\.02 of \$1\.00\./);
  assert.match(text, /Glaze \(hidden\): nothing yet/);
  assert.match(text, /4 jobs in all, \$0\.03 of AI\./);
  assert.match(text, /Waiting for you \(1\):\n- Add a FAQ page\n  https:\/\/github\.com\/x\/y\/pull\/7/);
  assert.match(text, /Failed today \(1\):\n- Chip pr: the model did not answer with JSON/);
  assert.ok(id > 0);
});

test("sendSummary goes to the owner on Telegram, once, and is counted as a team job; without Telegram it stays in the log", async () => {
  const W = makeWorld();
  const logged = [];
  const text = await sendSummary({ store: W.store, clock: W.clock, telegram: W.telegram, ownerChatId: "999", helpers: ["fudge", "crumb", "nib", "chip"], caps: {}, mode: "prelaunch", hidden: [], log: (t) => logged.push(t) });
  assert.match(text, /Nothing waits for you\./);
  assert.equal(W.tg.sent.length, 1);
  assert.equal(String(W.tg.sent[0].chat_id), "999");
  assert.equal(W.tg.sent[0].text, text);
  assert.equal(W.store.lastJob("team").job, "summary");
  const none = await sendSummary({ store: W.store, clock: W.clock, telegram: { configured: false }, ownerChatId: "", helpers: ["fudge"], caps: {}, mode: "live", hidden: [], log: (t) => logged.push(t) });
  assert.equal(none, null);
  assert.ok(logged.some((l) => /stays in the log/.test(l)));
});
