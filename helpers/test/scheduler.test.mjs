// The scheduler fires the right jobs at the right times, on a fake clock.
import test from "node:test";
import assert from "node:assert/strict";
import { FakeClock, localParts, nextDaily, atLocal } from "../lib/clock.mjs";
import { Scheduler } from "../lib/scheduler.mjs";
import { Store } from "../lib/store.mjs";

const T0 = Date.UTC(2026, 9, 7, 8, 0, 0); // 2026-10-07 08:00 UTC
const H = 3_600_000, M = 60_000;

test("a daily job fires at each configured hour and knows which slot of the day it is", async () => {
  const clock = new FakeClock(T0), runs = [];
  const s = new Scheduler({ clock, tz: "UTC", flags: new Store(":memory:") });
  s.add({ id: "post", helper: "fudge", daily: { hours: [9, 13, 18] }, run: async (slot) => { runs.push({ at: clock.now(), nth: slot.nth, hour: slot.hour }); } });
  s.start();
  await clock.advance(59 * M);
  assert.equal(runs.length, 0, "nothing before 09:00");
  await clock.advance(2 * M);
  assert.deepEqual(runs.map((r) => [r.nth, r.hour, new Date(r.at).toISOString()]), [[1, 9, "2026-10-07T09:00:00.000Z"]]);
  await clock.advance(9 * H);
  assert.deepEqual(runs.map((r) => r.nth), [1, 2, 3]);
  await clock.advance(15 * H + 1 * M); // 09:01 the next day
  assert.deepEqual(runs.map((r) => r.nth), [1, 2, 3, 1]);
  assert.equal(new Date(runs[3].at).toISOString(), "2026-10-08T09:00:00.000Z");
  s.stop();
});

test("an 'every' job repeats on its interval after a first delay", async () => {
  const clock = new FakeClock(T0);
  let n = 0;
  const s = new Scheduler({ clock, tz: "UTC" });
  s.add({ id: "mentions", helper: "fudge", every: 20 * M, initialDelay: 30_000, run: async () => { n++; } });
  s.start();
  await clock.advance(29_000);
  assert.equal(n, 0);
  await clock.advance(2_000);
  assert.equal(n, 1, "first run after the initial delay");
  await clock.advance(60 * M);
  assert.equal(n, 4, "then every 20 minutes");
  s.stop();
});

test("hours are local to the configured zone", async () => {
  const start = Date.UTC(2026, 9, 7, 6, 0, 0); // 08:00 in Rome (UTC+2 in early October)
  assert.equal(localParts(start, "Europe/Rome").h, 8);
  assert.equal(new Date(atLocal(start, 9, 0, "Europe/Rome")).toISOString(), "2026-10-07T07:00:00.000Z");
  assert.equal(new Date(nextDaily(start, [9], 0, "Europe/Rome")).toISOString(), "2026-10-07T07:00:00.000Z");
  const clock = new FakeClock(start), runs = [];
  const s = new Scheduler({ clock, tz: "Europe/Rome" });
  s.add({ id: "note", helper: "nib", daily: { hours: [9] }, run: async () => { runs.push(clock.now()); } });
  s.start();
  await clock.advance(59 * M);
  assert.equal(runs.length, 0);
  await clock.advance(2 * M);
  assert.equal(runs.length, 1);
  assert.equal(new Date(runs[0]).toISOString(), "2026-10-07T07:00:00.000Z");
  s.stop();
});

test("a slot missed while the service was down runs once at start, and never again after a restart", async () => {
  const store = new Store(":memory:");
  const clock = new FakeClock(T0 + 2 * H); // 10:00, the 09:00 post did not happen
  const runs = [];
  const a = new Scheduler({ clock, tz: "UTC", flags: store });
  a.add({ id: "post", helper: "fudge", daily: { hours: [9, 13, 18] }, run: async (slot) => { runs.push(slot.nth); } });
  a.start();
  await a.idle();
  assert.deepEqual(runs, [1], "the 09:00 slot ran at start");
  a.stop();
  const b = new Scheduler({ clock, tz: "UTC", flags: store }); // a restart a moment later
  b.add({ id: "post", helper: "fudge", daily: { hours: [9, 13, 18] }, run: async (slot) => { runs.push(slot.nth); } });
  b.start();
  await b.idle();
  assert.deepEqual(runs, [1], "the flag keeps it from running twice");
  await clock.advance(3 * H + M);
  assert.deepEqual(runs, [1, 2]);
  b.stop();
});

test("one job of a helper at a time; a failing job does not stop the others", async () => {
  const clock = new FakeClock(T0);
  let running = 0, most = 0, done = 0;
  const logs = [];
  const s = new Scheduler({ clock, tz: "UTC", log: (l) => logs.push(l) });
  const slow = async () => { running++; most = Math.max(most, running); await new Promise((r) => setImmediate(r)); running--; done++; };
  s.add({ id: "a", helper: "fudge", every: 10 * M, initialDelay: 0, run: slow });
  s.add({ id: "b", helper: "fudge", every: 10 * M, initialDelay: 0, run: slow });
  s.add({ id: "c", helper: "chip", every: 10 * M, initialDelay: 0, run: async () => { throw new Error("boom"); } });
  s.start();
  await clock.advance(1);
  await s.idle();
  assert.equal(done, 2);
  assert.equal(most, 1, "the two fudge jobs ran one after the other");
  assert.ok(logs.some((l) => /chip.*boom/.test(l)), "the failure was logged");
  await clock.advance(10 * M);
  await s.idle();
  assert.equal(done, 4, "the scheduler kept going");
  s.stop();
});
