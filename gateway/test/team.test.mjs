// The team log: what is accepted, what is refused, and what the public reads back.
//   node --test test/team.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { TeamLog, clean, KINDS } from "../teamlog.mjs";

const NOW = 1_800_000_000_000;
const fresh = () => new TeamLog(new DatabaseSync(":memory:"));

test("a good entry is stored and read back, newest first", () => {
  const log = fresh();
  const a = log.add({ helper: "Fudge", kind: "post", title: "  Posted the   launch thread ", url: "https://x.com/brownies/status/1", place: "X", cost_micro: 1200 }, NOW);
  const b = log.add({ helper: "nib", kind: "research", title: "Read 3 competitors", body: "Orbio takes 10%." }, NOW + 1000);
  assert.equal(a.helper, "fudge");
  assert.equal(a.title, "Posted the launch thread");
  assert.equal(a.place, "x");
  const all = log.list();
  assert.deepEqual(all.map((r) => r.id), [b.id, a.id]);
  assert.deepEqual(log.list({ helper: "fudge" }).map((r) => r.id), [a.id]);
  assert.deepEqual(log.list({ before: b.id }).map((r) => r.id), [a.id]);
});

test("what is refused", () => {
  const no = (e, re) => assert.throws(() => clean(e, NOW), (err) => err.status === 400 && re.test(err.message));
  no(null, /object/);
  no({ helper: "Fudge!", kind: "post", title: "x" }, /helper/);
  no({ helper: "fudge", kind: "tweet", title: "x" }, /kind/);
  no({ helper: "fudge", kind: "post", title: "   " }, /title/);
  no({ helper: "fudge", kind: "post", title: "x", url: "http://x.com/a" }, /https/);
  no({ helper: "fudge", kind: "post", title: "x", url: "javascript:alert(1)" }, /https/);
  no({ helper: "fudge", kind: "post", title: "x", url: "not a link" }, /link/);
  no({ helper: "fudge", kind: "post", title: "x", place: "<b>" }, /place/);
  no({ helper: "fudge", kind: "post", title: "x", cost_micro: -1 }, /cost/);
  no({ helper: "fudge", kind: "post", title: "x", at: NOW + 3_600_000 }, /future/);
  assert.equal(KINDS.includes("status"), true);
});

test("text is cut to size and flattened to one line, markup is kept as plain text", () => {
  const e = clean({ helper: "crumb", kind: "reply", title: "a\n\tb" + "x".repeat(400), body: "<img src=x onerror=alert(1)>" }, NOW);
  assert.equal(e.title.length, 160);
  assert.equal(e.title.startsWith("a b"), true);
  assert.equal(e.body, "<img src=x onerror=alert(1)>");
});

test("the summary counts per helper, keeps the newest status, and counts the week by kind", () => {
  const log = fresh();
  const day = NOW - (NOW % 86_400_000);
  log.add({ helper: "fudge", kind: "post", title: "old post", at: day - 3 * 86_400_000 }, NOW);
  log.add({ helper: "fudge", kind: "post", title: "today 1", cost_micro: 500, at: day + 1000 }, NOW);
  log.add({ helper: "fudge", kind: "reply", title: "today 2", cost_micro: 250, at: day + 2000 }, NOW);
  log.add({ helper: "fudge", kind: "status", title: "Writing a thread", at: day + 3000 }, NOW);
  log.add({ helper: "fudge", kind: "status", title: "Answering replies", at: day + 4000 }, NOW);
  log.add({ helper: "chip", kind: "status", title: "Building the tip button", at: day + 5000 }, NOW);
  log.add({ helper: "team", kind: "milestone", title: "Launched on Pons", at: day - 9 * 86_400_000 }, NOW);
  const s = log.summary(NOW);
  const fudge = s.helpers.find((h) => h.helper === "fudge"), chip = s.helpers.find((h) => h.helper === "chip");
  assert.deepEqual([fudge.total, fudge.today, fudge.costTodayMicro], [3, 2, 750]);
  assert.equal(fudge.status.title, "Answering replies");
  assert.deepEqual([chip.total, chip.status.title], [0, "Building the tip button"]);
  assert.deepEqual(s.week, { post: 2, reply: 1 });
  assert.equal(s.total, 4);
  assert.equal(log.list().some((r) => r.kind === "status"), false, "status rows are not things done");
  assert.equal(log.list({ kind: "milestone" }).length, 1);
});

test("the bricks come back in the order they were laid, and are cut into towers", () => {
  const log = fresh();
  for (let i = 0; i < 205; i++) {
    log.add({ helper: ["fudge", "crumb", "nib", "chip"][i % 4], kind: "post", title: "job " + (i + 1), at: NOW - (300 - i) * 60_000 }, NOW);
    if (i % 50 === 0) log.add({ helper: "chip", kind: "status", title: "busy", at: NOW - (300 - i) * 60_000 }, NOW);   // never a brick
  }
  const second = log.list({ asc: true, offset: 100, limit: 100 });
  assert.equal(second.length, 100);
  assert.deepEqual([second[0].title, second[99].title], ["job 101", "job 200"]);
  assert.deepEqual(log.list({ asc: true, offset: 200, limit: 100 }).map((r) => r.title), ["job 201", "job 202", "job 203", "job 204", "job 205"]);
  const towers = log.towers(100);
  assert.deepEqual(towers.map((x) => [x.tower, x.count]), [[0, 100], [1, 100], [2, 5]]);
  assert.equal(towers[0].firstAt < towers[0].lastAt && towers[0].lastAt < towers[1].firstAt, true);
  assert.deepEqual(fresh().towers(100), []);
});

test("a hidden report leaves every public view: the list, the summary, the towers; the hide route needs the team key and an id or a url", async () => {
  const { TeamLog } = await import("../teamlog.mjs");
  const { DatabaseSync } = await import("node:sqlite");
  const team = new TeamLog(new DatabaseSync(":memory:"));
  const a = team.add({ helper: "fudge", kind: "post", title: "Our numbers", url: "https://x.com/Feedthebrownies/status/1" });
  const b = team.add({ helper: "fudge", kind: "post", title: "A comparison", url: "https://x.com/Feedthebrownies/status/2" });
  team.add({ helper: "fudge", kind: "status", title: "Writing" });
  assert.equal(team.list().length, 2); assert.equal(team.summary().total, 2); assert.equal(team.towers(100)[0].count, 2);
  assert.equal(team.hide({ url: "https://x.com/Feedthebrownies/status/2" }), 1);
  assert.equal(team.hide({ url: "https://x.com/Feedthebrownies/status/2" }), 0, "once");
  assert.deepEqual(team.list().map((r) => r.id), [a.id]);
  assert.equal(team.summary().total, 1); assert.equal(team.summary().helpers.find((h) => h.helper === "fudge").total, 1);
  assert.equal(team.towers(100)[0].count, 1);
  assert.equal(team.hide({ id: a.id }), 1); assert.equal(team.list().length, 0);
  assert.equal(team.hide({}), 0, "nothing named, nothing hidden");
  void b;
});
