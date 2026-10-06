// The team that grows by itself: a recruit is a spec, not code; Dough hires one when a job is uncovered, within
// the ceiling and the budget pool, tells the owner, and retires a recruit that produced nothing in its trial.
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./mock.mjs";
import { validateSpec, Recruit, TOOLS } from "../lib/recruit.mjs";
import { Dough } from "../lib/hiring.mjs";

const DAY = 86_400_000;
const SPEC = { name: "quill", role: "translation and community docs. You write the Italian version of what the team publishes", model: "anthropic/claude-haiku-4.5", dailyCapUsd: 0.4, tools: ["note", "draft"], tasks: [{ id: "italian", title: "Italian summary of the day", text: "Write a short Italian summary of what the brownies did today for the Italian community.", tool: "note", daily: { hours: [19] }, maxWords: 150 }] };

/// A world with a Dough wired to a real hire/fire pair, like run.mjs does.
function team(W, { config = {} } = {}) {
  const all = { fudge: W.fudge, crumb: W.crumb, nib: W.nib, chip: W.chip };
  const log = [];
  const deps = (name) => ({ config: W.helpersCfg[name] || {}, brain: W.brain, gateway: W.gateway, store: W.store, clock: W.clock, alerts: W.alerts, facts: "facts", log: (l) => log.push(String(l)) });
  const hire = async (spec) => { W.store.setMeta(`recruit:${spec.name}`, JSON.stringify(spec)); W.brain.helpers[spec.name] = { model: spec.model, dailyCapUsd: spec.dailyCapUsd }; const r = new Recruit({ ...deps(spec.name), telegram: W.telegram, github: W.github, ownerChatId: "999", groupChatId: "-100", spec }); all[spec.name] = r; return r; };
  const fire = async (name) => { if (!all[name]?.recruit) return false; delete all[name]; return true; };
  const recruits = () => Object.values(all).filter((h) => h.recruit);
  const roster = () => Object.entries(all).map(([name, h]) => ({ name, role: W.helpersCfg[name]?.role || h.role || "" }));
  W.brain.helpers.dough = { model: "test/big", dailyCapUsd: 0.5 };
  const dough = new Dough({ ...deps("dough"), config: { hour: 12, maxRecruits: 2, poolUsdPerDay: 1, maxCapUsd: 0.6, trialDays: 7, minOutputsPerWeek: 3, ...config }, telegram: W.telegram, github: W.github, ownerChatId: "999", hire, fire, recruits, roster });
  return { all, dough, log, recruits };
}

test("a spec is checked: names, tools, tasks, budget; a recruit's jobs come from its tasks", () => {
  const s = validateSpec(SPEC, { maxCapUsd: 1, existing: ["fudge"] });
  assert.equal(s.title, "Quill");
  assert.equal(s.hidden, true, "hidden unless said otherwise");
  assert.deepEqual(s.tools, ["note", "draft"]);
  assert.equal(s.tasks[0].daily.hours[0], 19);
  assert.throws(() => validateSpec({ ...SPEC, name: "fudge" }), /taken/);
  assert.throws(() => validateSpec({ ...SPEC, name: "x" }), /name must be/);
  assert.throws(() => validateSpec({ ...SPEC, tools: ["trade"] }), /tools must be/);
  assert.throws(() => validateSpec({ ...SPEC, tasks: [] }), /at least one task/);
  assert.equal(validateSpec({ ...SPEC, dailyCapUsd: 50 }, { maxCapUsd: 0.7 }).dailyCapUsd, 0.7, "the cap is bounded");
  assert.deepEqual(TOOLS, ["note", "draft", "announce", "issue"]);
});

test("a recruit does its task and delivers with its tool: a note in the repository, a draft to the owner, one announcement a day, an issue for Chip", async () => {
  const W = makeWorld({ reply: () => "Oggi i brownies hanno fatto tre lavori. Nib ha scritto la nota del giorno." });
  const { dough } = team(W);
  const r = await dough.hireFn(validateSpec(SPEC, { existing: [] }));
  assert.equal(r.jobs()[0].id, "quill-italian");
  const out = await r.doTask(r.spec.tasks[0]);
  assert.match(out.url, /notes\/quill\/\d{4}-\d{2}-\d{2}-italian\.md$/);
  assert.ok(Object.keys(W.ghm.files.main).some((p) => p.startsWith("notes/quill/")), "the note is in the repository");
  assert.equal(W.gw.reports.length, 0, "hidden: nothing in the Kitchen");
  assert.equal(W.store.getMeta("recruit:quill:outputs"), "1");
  await r.doTask({ ...r.spec.tasks[0], id: "d", tool: "draft" });
  assert.match(W.tg.sent.at(-1).text, /^Quill, Italian summary of the day:/);
  assert.equal(String(W.tg.sent.at(-1).chat_id), "999");
  await r.doTask({ ...r.spec.tasks[0], id: "a", tool: "announce" });
  assert.equal(String(W.tg.sent.at(-1).chat_id), "-100", "the announcement went to the group");
  const n = W.tg.sent.length;
  await r.doTask({ ...r.spec.tasks[0], id: "a", tool: "announce" });
  assert.equal(W.tg.sent.length, n, "one announcement a day");
  const issue = await r.doTask({ ...r.spec.tasks[0], id: "i", tool: "issue" });
  assert.match(issue.where, /issue #\d+/);
  assert.deepEqual(W.ghm.issues.at(-1).labels, ["chip"]);
  const asked = await r.onRequest("Translate the FAQ into Italian");
  assert.equal(asked.task, "ask");
});

test("Dough hires from the model's proposal within the ceiling and the pool, once a day, and tells the owner; a bad proposal hires nobody", async () => {
  const proposal = { hire: true, why: "Nobody writes for the Italian community.", spec: SPEC };
  const W = makeWorld({ reply: (body) => (/decide whether the team needs one more brownie/.test(body.messages[0].content) ? JSON.stringify(proposal) : "ok") });
  const { dough, recruits } = team(W);
  const r = await dough.review();
  assert.equal(r.hired.name, "quill");
  assert.equal(recruits().length, 1);
  assert.match(W.tg.sent.at(-1).text, /^Dough hired Quill: translation/);
  assert.match(W.tg.sent.at(-1).text, /Undo with \/fire quill/);
  assert.match(W.or.lastUser(), /THE TEAM TODAY:\n- Fudge/);
  assert.match(W.or.lastUser(), /RECRUITS: 0 of 2/);
  assert.equal((await dough.review()).hired, null, "one hire a day");
  W.clock.advance(DAY);
  const again = await dough.review();
  assert.equal(again.hired, null, "the pool (1 dollar) has 0.6 left but the same name is taken: the spec is refused");
  // a second, different recruit fits the pool; a third hits the ceiling
  proposal.spec = { ...SPEC, name: "scribe", role: "the weekly report. You write the week's summary for the holders", dailyCapUsd: 0.5 };
  W.clock.advance(DAY);
  assert.equal((await dough.review()).hired.name, "scribe");
  assert.equal(recruits().length, 2);
  proposal.spec = { ...SPEC, name: "third", role: "a third one that should not pass the ceiling of two" };
  W.clock.advance(DAY);
  assert.equal((await dough.review()).hired, null, "the ceiling");
});

test("Dough does not hire when the model says no; the owner's /hire forces one; /fire undoes it; a recruit with nothing to show is retired after its trial", async () => {
  let answer = { hire: false, why: "Every job is covered this week." };
  const W = makeWorld({ reply: (body) => (/decide whether the team needs one more brownie/.test(body.messages[0].content) ? JSON.stringify(answer) : "ok") });
  const { dough, recruits } = team(W);
  assert.equal((await dough.review()).hired, null);
  assert.equal(recruits().length, 0);
  answer = { hire: true, why: "the owner asked", spec: SPEC };
  const r = await dough.onRequest("someone to write Italian summaries");
  assert.equal(r.name, "quill");
  assert.match(W.or.lastUser(), /THE OWNER ASKED FOR THIS HIRE: someone to write Italian summaries/);
  // seven days pass with nothing produced: retired (and the model has nothing new to hire that day)
  answer = { hire: false, why: "Every job is covered this week." };
  W.clock.advance(8 * DAY);
  const rv = await dough.review();
  assert.deepEqual(rv.retired, ["quill"]);
  assert.equal(recruits().length, 0);
  assert.match(W.tg.sent.at(-1).text, /Quill was retired: 0 results in 8 days/);
  // /fire on a stranger fails plainly
  assert.equal(await dough.fire("nobody"), false);
});
