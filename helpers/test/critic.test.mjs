// Critic reads the day's work and routes each improvement: a task for Chip, a note the brownies read tomorrow, or a
// line to the owner; the next prompts carry the feedback; a quiet day costs nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./mock.mjs";
import { Critic } from "../lib/critic.mjs";
import { latestCriticText } from "../lib/facts.mjs";

function criticIn(W, reply) {
  W.brain.helpers.critic = { model: "test/big", dailyCapUsd: 0.6 };
  W.or.reply = (body) => (/name at most three improvements/.test(body.messages[0].content) ? reply : "A plain sentence.");
  return new Critic({ config: { hour: 21, minute: 30, maxIssuesPerDay: 2 }, brain: W.brain, gateway: W.gateway, store: W.store, clock: W.clock, alerts: W.alerts, facts: "facts", log: () => {}, github: W.github, telegram: W.telegram, ownerChatId: "999" });
}

test("three improvements go three ways; the brownies read their feedback in the next prompt", async () => {
  const W = makeWorld();
  // the day's material: a post, an answer, a report in the Kitchen
  W.store.addPost({ at: W.clock.now(), helper: "fudge", place: "x", kind: "post", text: "Every trade of BROWNIE pays a 2% tax. Half of it reaches stakers as SUGAR." });
  W.store.addTurn("-100", "assistant", "SUGAR is one dollar of AI, roughly.", { at: W.clock.now() });
  W.gw.reports.push({ id: 1, at: W.clock.now(), helper: "nib", kind: "research", title: "Research note", body: "Nothing changed." });
  W.fetch.on("GET", "https://gw.test/api/team/activity", () => ({ json: { entries: W.gw.reports } }));
  const reply = JSON.stringify({ improvements: [
    { helper: "fudge", where: "feedback", what: "The post says half of the tax goes to stakers; the facts say 35%.", fix: "Use the split from the facts: 35% to stakers, 30% to the brownies." },
    { helper: "chip", where: "issue", what: "The docs page footer has no link to the FAQ.", fix: "Add a FAQ link to the docs footer." },
    { helper: "crumb", where: "owner", what: "Crumb answers about launch dates it cannot know.", fix: "Decide the launch date or tell Crumb to say 'not decided'." },
  ] });
  const c = criticIn(W, reply);
  const r = await c.review();
  assert.equal(r.feedback.length, 1);
  assert.equal(r.issues.length, 1);
  assert.equal(r.owner.length, 1);
  assert.deepEqual(W.ghm.issues.at(-1).labels, ["chip"]);
  assert.match(W.ghm.issues.at(-1).title, /^Chip: Add a FAQ link to the docs footer/);
  assert.match(W.tg.sent.at(-1).text, /^Critic, for you:\n- Crumb: Crumb answers about launch dates/);
  assert.match(W.or.lastUser(), /POSTS:\n- Fudge posted: Every trade/);
  assert.match(W.or.lastUser(), /ANSWERS:\n- Crumb answered: SUGAR is one dollar/);
  assert.match(W.or.lastUser(), /REPORTS TODAY:\n- nib research: Research note/);
  // the feedback reaches Fudge's next prompt, and only Fudge's
  assert.match(latestCriticText(W.store, "fudge"), /Use the split from the facts/);
  assert.equal(latestCriticText(W.store, "nib"), "");
  assert.match(W.fudge.system("x"), /FEEDBACK FROM CRITIC[\s\S]*35% to stakers/);
  assert.doesNotMatch(W.nib.system("x"), /FEEDBACK FROM CRITIC/);
  assert.match(W.store.lastJob("critic").note, /Reviewed the day: 1 task for Chip, 1 note for the brownies, 1 for the owner/);
});

test("a quiet day costs nothing; a day with nothing to improve is reported as such; at most two tasks a day", async () => {
  const W = makeWorld();
  W.fetch.on("GET", "https://gw.test/api/team/activity", () => ({ json: { entries: [] } }));
  const c = criticIn(W, JSON.stringify({ improvements: [] }));
  assert.equal(await c.review(), null, "nothing to read");
  assert.equal(W.or.calls.length, 0);
  W.store.addPost({ at: W.clock.now(), helper: "fudge", place: "site", kind: "post", text: "A fine post." });
  const r = await c.review();
  assert.deepEqual(r, { issues: [], feedback: [], owner: [] });
  assert.match(W.store.lastJob("critic").note, /nothing to improve/);
  const many = JSON.stringify({ improvements: [1, 2, 3].map((i) => ({ helper: "chip", where: "issue", what: `w${i}`, fix: `fix ${i}` })) });
  const c2 = criticIn(W, many);
  const r2 = await c2.review();
  assert.equal(r2.issues.length, 2, "the third becomes feedback, not a task");
  assert.equal(r2.feedback.length, 1);
});
