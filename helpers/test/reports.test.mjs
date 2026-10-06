// Every job reports to the gateway with the right kind, and every dollar spent is in exactly one report.
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./mock.mjs";
import { KINDS } from "../lib/gateway.mjs";

const README = "# Brownies\n\nFour AI helpers.\n";

test("a day of work: post, reply, research, build and status, each with its cost", async () => {
  const change = { title: "Add notes/README.md", description: "Says what the notes folder holds.", files: [{ path: "notes/README.md", content: "# Notes\n\nNib's daily research notes, one file per day.\n" }] };
  const reply = (body) => {
    const user = body.messages.filter((m) => m.role === "user").pop().content;
    if (/Is it safe and correct to merge/.test(user)) return "YES. Small and plain.";
    if (/Which files do you need/.test(user)) return '{"files": []}';
    if (/Write the change/.test(user)) return JSON.stringify(change);
    if (/Write today's note now/.test(user)) return "## What changed\n\nNothing yet.\n\n## What to do\n\n- Fudge: post about staking.";
    if (/Write the post now/.test(user)) return "Every trade of BROWNIE pays a 2% tax. Half of it reaches stakers as SUGAR.";
    return "Stake BROWNIE in the app and claim SUGAR whenever you like.";
  };
  const W = makeWorld({ reply, cost: 0.0007, github: { files: { "README.md": README } }, config: { chip: { standingTasks: [{ id: "notes-readme", title: "Add notes/README.md", text: "" }] } } });
  await W.fudge.post({ nth: 1 });
  W.tg.message({ chatId: "-100", text: "How do I claim?" });
  await W.crumb.pollOnce();
  await W.clock.advance(61 * 60_000);
  await W.crumb.flush();
  await W.nib.note();
  await W.chip.work();

  const byKind = {};
  for (const r of W.gw.reports) (byKind[r.kind] ??= []).push(r);
  assert.deepEqual(Object.keys(byKind).sort(), ["build", "note", "post", "reply", "research", "status"]);
  for (const k of Object.keys(byKind)) assert.ok(KINDS.includes(k));
  assert.deepEqual(byKind.post.map((r) => [r.helper, r.place]), [["fudge", "x"]]);
  assert.deepEqual(byKind.reply.map((r) => [r.helper, r.place, r.title]), [["crumb", "telegram", "Answered 1 question in the group"]]);
  assert.deepEqual(byKind.research.map((r) => [r.helper, r.place]), [["nib", "github"]]);
  assert.deepEqual(byKind.build.map((r) => [r.helper, r.place]), [["chip", "github"]]);
  assert.deepEqual(byKind.note.map((r) => r.helper), ["fudge", "crumb", "nib"], "the three reviews, in the reviewers' names");
  assert.ok(byKind.status.length >= 4);
  for (const r of byKind.status) assert.equal(r.cost_micro, undefined, "a status carries no cost");
  // every report went with the team key, as one JSON entry
  for (const c of W.fetch.callsTo("/api/team/log")) { assert.equal(c.headers.authorization, `Bearer ${W.gw.teamKey}`); assert.equal(Array.isArray(c.body), false); }
  // every dollar spent is reported exactly once
  const reported = W.gw.reports.reduce((s, r) => s + (r.cost_micro || 0), 0);
  const spent = ["fudge", "crumb", "nib", "chip"].reduce((s, h) => s + W.store.spentToday(h, W.clock.now()).micro, 0);
  assert.equal(reported, spent);
  assert.equal(spent, W.or.calls.length * 700);
  assert.equal(W.or.calls.length, 8, "post, answer, note, pick, change, three reviews");
});

test("a gateway that is down loses the report but not the job, and the Kitchen gets nothing it would not accept", async () => {
  const W = makeWorld({ reply: () => "Every trade of BROWNIE pays a 2% tax." });
  W.gateway.url = "https://gone.test";
  W.fetch.on("*", "https://gone.test", () => ({ status: 503, json: { error: { code: "closed" } } }));
  const r = await W.fudge.post();
  assert.ok(r, "the post still went out");
  assert.equal(W.xm.posts.length, 1);
  assert.equal(W.gw.reports.length, 0);
  await assert.rejects(() => W.gateway.report({ helper: "fudge", kind: "tweet", title: "x" }), /bad report kind/);
});
