// Patch: Chip merges a small change only when the repository's checks pass; a red check blocks the merge and sends
// the change to the owner; the owner's Approve is also refused while the tests fail; no checks at all means no gate.
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./mock.mjs";
import { Patch } from "../lib/patch.mjs";

const README = "# Brownies\n\n| Folder | What it is |\n| --- | --- |\n| `web/` | The website |\n";
const FILES = { "README.md": README };
const change = { title: "List helpers/ in the README table", description: "Adds one row.", files: [{ path: "README.md", content: README.replace("| `web/` | The website |\n", "| `web/` | The website |\n| `helpers/` | The runtime |\n") }] };
const model = (plan) => (body) => (/Which files do you need/.test(body.messages.at(-1).content) ? JSON.stringify({ files: ["README.md"] }) : /review a code change/.test(body.messages[0].content) ? "YES. Fine." : JSON.stringify(plan));
const TASK = { chip: { standingTasks: [{ id: "readme-row", title: "List helpers/ in the root README", text: "Add a row." }] } };
const run = (name, conclusion) => ({ name, status: conclusion ? "completed" : "in_progress", conclusion });

/// A Patch whose waits move the fake clock, so a test runs straight through.
function withPatch(W, config = {}) {
  W.brain.helpers.patch = { model: "test/cheap", dailyCapUsd: 0.2 };
  const patch = new Patch({ config: { waitMinutes: 2, graceMinutes: 1, pollSeconds: 10, ...config }, brain: W.brain, gateway: W.gateway, store: W.store, clock: W.clock, alerts: W.alerts, facts: "facts", log: () => {}, github: W.github, sleep: (ms) => W.clock.advance(ms) });
  W.chip.patch = patch;
  return patch;
}

test("green checks: Chip waits for them and merges; Patch reports the pass", async () => {
  const W = makeWorld({ reply: model(change), github: { files: FILES }, config: TASK });
  withPatch(W);
  // the first look finds nothing yet, the second finds running checks, the third finds them green
  W.ghm.checksFn = (sha, n) => (n === 1 ? [] : n === 2 ? [run("helpers"), run("contracts")] : [run("helpers", "success"), run("contracts", "success")]);
  const r = await W.chip.work();
  assert.equal(r.merged, true);
  assert.equal(r.tests, "passed");
  assert.deepEqual(W.ghm.merged, [100]);
  assert.equal(W.ghm.checkCalls, 3);
  assert.match(W.store.lastJob("patch").note, /Tests passed on #100 \(2 checks\)/);
});

test("a red check blocks the merge: the change waits for the owner with the reason, Patch writes it on the pull request, Approve is refused until green", async () => {
  const W = makeWorld({ reply: model(change), github: { files: FILES }, config: TASK });
  withPatch(W);
  let green = false;
  W.ghm.checksFn = () => (green ? [run("helpers", "success"), run("gateway", "success")] : [run("helpers", "failure"), run("gateway", "success")]);
  const r = await W.chip.work();
  assert.equal(r.merged, false);
  assert.deepEqual(W.ghm.merged, []);
  assert.ok(W.ghm.comments.some((c) => /Patch: the checks did not pass.*helpers \(failure\)/.test(c.body)), "the verdict is on the pull request");
  assert.match(W.tg.sent.at(-1).text, /^The tests failed: List helpers/);
  assert.match(W.store.lastJob("patch").note, /Tests failed on #100: helpers \(failure\)/);
  // the owner presses Approve while the tests still fail: refused, the approval stays pending
  const id = W.store.pendingApprovals()[0].id;
  assert.equal(await W.chip.decide(id, "approve", { chatId: "999", messageId: W.tg.sent.at(-1).message_id }), false);
  assert.deepEqual(W.ghm.merged, []);
  assert.match(W.tg.edited.at(-1).text, /^Not merged: the tests fail on/);
  assert.equal(W.store.pendingApprovals().length, 1, "still pending");
  // the tests are fixed on the branch: Approve merges
  green = true;
  assert.equal(await W.chip.decide(id, "approve", {}), true);
  assert.deepEqual(W.ghm.merged, [100]);
});

test("a repository without checks is not gated: after the grace time the change merges as before", async () => {
  const W = makeWorld({ reply: model(change), github: { files: FILES }, config: TASK });
  withPatch(W, { graceMinutes: 1, pollSeconds: 20 });
  const t0 = W.clock.now();
  const r = await W.chip.work();
  assert.equal(r.merged, true);
  assert.equal(r.tests, "none");
  assert.ok(W.clock.now() - t0 >= 60_000, "it waited the grace minute for a check to appear");
  assert.ok(W.ghm.checkCalls >= 3);
});

test("without Patch, Chip merges as it always did", async () => {
  const W = makeWorld({ reply: model(change), github: { files: FILES }, config: TASK });
  const r = await W.chip.work();
  assert.equal(r.merged, true);
  assert.equal(r.tests, "none");
});
