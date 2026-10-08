// The scheduler. A job runs at fixed local hours every day ("daily") or every so many milliseconds ("every").
// One job of a helper runs at a time: a helper that is still writing a post does not start answering mentions
// in parallel. A daily slot that was missed earlier today (the service was down) runs once at start, unless its
// flag says it already ran. The flag is set when the run starts, so a crash never posts the same slot twice.
//
//   const s = new Scheduler({ clock, tz: "Europe/Rome", flags: store });
//   s.add({ id: "fudge-post", helper: "fudge", daily: { hours: [9, 13, 18], minute: 0 }, run: async (slot) => {} });
//   s.add({ id: "fudge-mentions", helper: "fudge", every: 20 * 60_000, run: async () => {} });
//   s.start();
//
// A daily run gets { at, hour, index, nth, dayKey } (nth = 1 for the first slot of the day). An "every" run gets
// { at }. Errors thrown by a run are logged and do not stop the scheduler.
import { localParts, nextDaily, dueToday } from "./clock.mjs";

export class Scheduler {
  constructor({ clock, tz = "UTC", flags = null, log = () => {}, maxSleep = 60_000 } = {}) {
    this.clock = clock; this.tz = tz; this.flags = flags; this.log = log; this.maxSleep = maxSleep;
    this.jobs = []; this.chains = new Map(); this.timer = null; this.stopped = true;
  }

  add(job) {
    if (!job.id || !job.helper || typeof job.run !== "function") throw new Error("a job needs id, helper and run");
    if (!job.daily && !job.every) throw new Error(`job ${job.id} needs daily or every`);
    const j = { ...job, next: null, runs: 0 };
    if (j.daily) j.daily = { hours: [...j.daily.hours].sort((a, b) => a - b), minute: j.daily.minute || 0 };
    this.jobs.push(j);
    return j;
  }

  start() {
    this.stopped = false;
    const now = this.clock.now();
    for (const j of this.jobs) {
      if (j.daily) {
        for (const slot of dueToday(now, j.daily.hours, j.daily.minute, this.tz)) this._runDaily(j, slot, now); // catch up
        j.next = nextDaily(now, j.daily.hours, j.daily.minute, this.tz);
      } else {
        j.next = now + (j.initialDelay ?? 30_000);
      }
    }
    this._arm();
  }

  stop() { this.stopped = true; if (this.timer) this.clock.clearTimeout(this.timer); this.timer = null; }

  /// A promise that resolves when every running job is done (for a clean shutdown and for tests).
  idle() { return Promise.all([...this.chains.values()]); }

  /// Runs a job now, by hand (the owner's control room), behind the helper's running job as always.
  runNow(id) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return Promise.reject(new Error(`no job ${id}`));
    return this._run(j, { at: this.clock.now(), manual: true, nth: 1 });
  }

  _arm() {
    if (this.stopped) return;
    const now = this.clock.now();
    const next = Math.min(...this.jobs.map((j) => j.next));
    const wait = Number.isFinite(next) ? Math.max(0, Math.min(next - now, this.maxSleep)) : this.maxSleep;
    this.timer = this.clock.setTimeout(() => this.tick(), wait);
  }

  async tick() {
    if (this.stopped) return;
    const now = this.clock.now();
    const runs = [];
    try {
      for (const j of this.jobs) {
        if (j.next > now) continue;
        if (j.daily) {
          const h = localParts(j.next, this.tz).h, slot = { at: j.next, hour: h, index: j.daily.hours.indexOf(h) };
          j.next = nextDaily(now, j.daily.hours, j.daily.minute, this.tz);
          try { runs.push(this._runDaily(j, slot, now)); } catch (e) { this.log(`[${j.helper}] job ${j.id} could not start: ${e.message}`); }
        } else {
          j.next = now + j.every;
          try { runs.push(this._run(j, { at: now })); } catch (e) { this.log(`[${j.helper}] job ${j.id} could not start: ${e.message}`); }
        }
      }
    } finally {
      this._arm(); // whatever a start threw, the next tick is booked
    }
    await Promise.all(runs);
  }

  _runDaily(j, slot, now) {
    const dayKey = localParts(slot.at, this.tz).key;
    const key = `sched:${j.id}:${dayKey}:${slot.hour}`;
    if (this.flags && this.flags.hasFlag(key)) return Promise.resolve();
    if (this.flags) this.flags.setFlag(key, now);
    return this._run(j, { ...slot, nth: slot.index + 1, dayKey });
  }

  /// Runs behind the helper's previous job, never beside it. A paused helper (isOff) skips its scheduled runs; a
  /// run the owner asked for by hand goes through.
  _run(j, info) {
    if (!info?.manual && typeof this.isOff === "function" && this.isOff(j.helper)) { this.log(`[${j.helper}] paused, ${j.id} skipped`); return Promise.resolve(); }
    const prev = this.chains.get(j.helper) || Promise.resolve();
    const p = prev.then(async () => {
      j.runs++;
      try { await j.run(info); } catch (e) { this.log(`[${j.helper}] job ${j.id} failed: ${e.message}`); }
    });
    this.chains.set(j.helper, p);
    return p;
  }
}
