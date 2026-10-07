// The money jobs board: one URL is one job, the owner's actions move the state and keep a log, the totals add up,
// and the public read answers with the board and its labels.
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../lib/store.mjs";
import { refFor, normalizeUrl, applyAction, totalsView, JobsApi, STATE_LABEL, KINDS } from "../lib/moneyjobs.mjs";

const T0 = Date.UTC(2026, 9, 8, 9, 0, 0);

test("a URL is one job however it is written; adding it twice adds nothing", () => {
  assert.equal(normalizeUrl("https://Grants.Example.org/apply/?utm_source=x&ref=tw#top"), "https://grants.example.org/apply");
  assert.equal(normalizeUrl("https://grants.example.org/apply?round=3"), "https://grants.example.org/apply?round=3");
  assert.equal(normalizeUrl("ftp://x"), null); assert.equal(normalizeUrl("not a url"), null); assert.equal(refFor(""), null);
  assert.equal(refFor("https://grants.example.org/apply/"), refFor("https://GRANTS.example.org/apply?utm_campaign=a"));
  const s = new Store();
  const id = s.addMoneyJob({ at: T0, kind: "grant", title: "Example grants, round 3", url: "https://grants.example.org/apply", ref: refFor("https://grants.example.org/apply"), source: "zest", score: 82, effort: "medium", expectedUsd: 5000, deadline: "2026-10-31", summary: "Open source builders.", nextStep: "Fill the form.", note: "found while searching: grants" });
  assert.equal(id, 1);
  assert.equal(s.addMoneyJob({ at: T0 + 1, kind: "grant", title: "The same, again", url: "https://GRANTS.example.org/apply/", ref: refFor("https://GRANTS.example.org/apply/"), source: "zest" }), null, "the same ref adds nothing");
  const j = s.moneyJob(1);
  assert.equal(j.title, "Example grants, round 3"); assert.equal(j.state, "found"); assert.equal(j.score, 82); assert.equal(j.expectedUsd, 5000); assert.equal(j.earnedUsd, 0);
  assert.deepEqual(j.log, [{ at: T0, by: "zest", text: "found while searching: grants" }]);
  assert.equal(s.moneyJobByRef(j.ref).id, 1);
  assert.equal(s.moneyJobs().length, 1); assert.equal(s.moneyJobs({ state: "won" }).length, 0);
});

test("the owner's actions: pick, a note, submit, paid with the amount; wrong ids and actions are errors; totals add up", () => {
  const s = new Store();
  s.addMoneyJob({ at: T0, kind: "grant", title: "Grant A", url: "https://a.test/grant", ref: refFor("https://a.test/grant"), source: "zest", score: 80, expectedUsd: 5000 });
  s.addMoneyJob({ at: T0, kind: "bounty", title: "Bounty B", url: "https://b.test/bounty", ref: refFor("https://b.test/bounty"), source: "zest", score: 70, expectedUsd: 800 });
  s.addMoneyJob({ at: T0, kind: "hackathon", title: "Hack C", url: "https://c.test/hack", ref: refFor("https://c.test/hack"), source: "owner", score: 60, expectedUsd: 2000 });
  let r = applyAction(s, { id: 1, action: "pick", by: "owner", now: T0 + 1000 });
  assert.equal(r.job.state, "picked"); assert.equal(r.job.updatedAt, T0 + 1000);
  assert.deepEqual(r.job.log.at(-1), { at: T0 + 1000, by: "owner", text: "pick (owner)" });
  r = applyAction(s, { id: 1, action: "note", text: "Asked them about the deadline.", by: "owner", now: T0 + 2000 });
  assert.equal(r.job.state, "picked", "a note moves nothing"); assert.equal(r.job.log.at(-1).text, "Asked them about the deadline.");
  assert.equal(applyAction(s, { id: 1, action: "note", text: "  ", now: T0 }).error, "A note needs text.");
  r = applyAction(s, { id: 1, action: "submit", now: T0 + 3000 }); assert.equal(r.job.state, "submitted");
  r = applyAction(s, { id: 1, action: "won", text: "4500", now: T0 + 4000 }); assert.equal(r.job.state, "won"); assert.equal(r.job.expectedUsd, 4500);
  r = applyAction(s, { id: 1, action: "paid", value: "$4,500", now: T0 + 5000 }); assert.equal(r.job.state, "paid"); assert.equal(r.job.earnedUsd, 4500); assert.equal(r.job.ownerAction, null);
  r = applyAction(s, { id: 2, action: "drop", text: "too small", now: T0 + 6000 }); assert.equal(r.job.state, "dropped"); assert.equal(r.job.log.at(-1).text, "drop: too small (owner)");
  applyAction(s, { id: 3, action: "start", by: "chip", now: T0 + 7000 });
  assert.match(applyAction(s, { id: 9, action: "pick", now: T0 }).error, /no job 9/);
  assert.match(applyAction(s, { id: 1, action: "fly", now: T0 }).error, /No such action "fly"/);
  const t = totalsView(s);
  assert.deepEqual(t, { found: 0, open: 1, won: 0, paid: 1, lost: 0, dropped: 1, earnedUsd: 4500, expectedOpenUsd: 2000 });
  // the record stays readable through the raw totals too
  assert.equal(s.moneyTotals().paid.earnedUsd, 4500);
  // a brownie's update with a patch
  const u = s.updateMoneyJob(3, { helper: "chip", nextStep: "Register the team." }, { at: T0 + 8000, by: "zest", note: "handed to Chip" });
  assert.equal(u.helper, "chip"); assert.equal(u.nextStep, "Register the team."); assert.equal(u.log.length, 2);
  assert.equal(s.updateMoneyJob(99, { helper: "x" }, { at: T0 }), null);
});

test("the public read: the list with labels, filters by state and kind, the totals; anything else is refused", async () => {
  const s = new Store();
  s.addMoneyJob({ at: T0, kind: "grant", title: "Grant A", url: "https://a.test/grant", ref: refFor("https://a.test/grant"), source: "zest", score: 80, expectedUsd: 5000 });
  s.addMoneyJob({ at: T0 + 1, kind: "bounty", title: "Bounty B", url: "https://b.test/bounty", ref: refFor("https://b.test/bounty"), source: "zest", score: 70, expectedUsd: 800 });
  applyAction(s, { id: 2, action: "start", by: "chip", now: T0 + 2 });
  const api = new JobsApi({ store: s });
  const call = (method, url) => new Promise((resolve) => { let status = 0, headers = {}, body = ""; api.handle({ method, url, headers: {} }, { writeHead: (st, h) => { status = st; headers = h || {}; }, end: (b) => { body += b || ""; resolve({ status, headers, body: body ? JSON.parse(body) : null }); } }); });
  let r = await call("GET", "/jobs/list");
  assert.equal(r.status, 200); assert.equal(r.headers["access-control-allow-origin"], "*");
  assert.deepEqual(r.body.jobs.map((j) => [j.id, j.stateLabel]), [[2, "in progress"], [1, "found"]], "the latest change first");
  assert.deepEqual(r.body.totals, totalsView(s)); assert.deepEqual(r.body.states, STATE_LABEL); assert.deepEqual(r.body.kinds, KINDS);
  r = await call("GET", "/jobs/list?state=found"); assert.deepEqual(r.body.jobs.map((j) => j.id), [1]);
  r = await call("GET", "/jobs/list?kind=bounty"); assert.deepEqual(r.body.jobs.map((j) => j.id), [2]);
  r = await call("GET", "/jobs/list?state=flying"); assert.equal(r.status, 400);
  r = await call("GET", "/jobs/totals"); assert.equal(r.body.open, 1); assert.equal(r.body.found, 1);
  r = await call("POST", "/jobs/list"); assert.equal(r.status, 405);
  r = await call("GET", "/jobs/nothing"); assert.equal(r.status, 404);
  r = await call("OPTIONS", "/jobs/list"); assert.equal(r.status, 204);
});
