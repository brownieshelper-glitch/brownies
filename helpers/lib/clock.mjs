// Time. Everything that waits or asks what time it is goes through a clock, so the tests can run a day in a
// millisecond. RealClock is the wall clock; FakeClock is moved by hand with advance(ms) and fires what is due.
export class RealClock {
  now() { return Date.now(); }
  setTimeout(fn, ms) { return setTimeout(fn, ms); }
  clearTimeout(id) { clearTimeout(id); }
  sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
}

export class FakeClock {
  constructor(start = Date.UTC(2026, 9, 7, 8, 0, 0)) { this.t = start; this.timers = []; this.seq = 0; }
  now() { return this.t; }
  setTimeout(fn, ms) { const id = ++this.seq; this.timers.push({ id, at: this.t + Math.max(0, ms), fn }); return id; }
  clearTimeout(id) { this.timers = this.timers.filter((x) => x.id !== id); }
  sleep(ms) { return new Promise((r) => this.setTimeout(r, ms)); }
  /// Moves time forward, firing every timer that falls due on the way, in order, and waiting for each callback.
  async advance(ms) {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x.id !== due.id);
      this.t = Math.max(this.t, due.at);
      await due.fn();
    }
    this.t = target;
  }
  /// Lets promise chains settle without moving time (a few turns of the event loop).
  async settle(turns = 5) { for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r)); }
}

// ---- local time in a zone, without a library ----
const formats = new Map();
function fmt(tz) {
  if (!formats.has(tz)) formats.set(tz, new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  return formats.get(tz);
}

/// The local date and time of the instant t in the zone: { y, m, d, h, min, s, key } with key "YYYY-MM-DD".
export function localParts(t, tz = "UTC") {
  const p = {};
  for (const x of fmt(tz).formatToParts(new Date(t))) if (x.type !== "literal") p[x.type] = Number(x.value);
  if (p.hour === 24) p.hour = 0;
  return { y: p.year, m: p.month, d: p.day, h: p.hour, min: p.minute, s: p.second, key: `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}` };
}

/// The instant of hour:minute on the local day that contains t. The zone's offset is taken from t itself, so on
/// the two nights a year when the clocks change the answer can be an hour off. Good enough for a posting hour.
export function atLocal(t, hour, minute, tz = "UTC") {
  const p = localParts(t, tz);
  const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(t / 1000) * 1000;
  return Date.UTC(p.y, p.m - 1, p.d, hour, minute, 0) - offset;
}

/// The next instant strictly after t at one of the hours (local), today or tomorrow.
export function nextDaily(t, hours, minute = 0, tz = "UTC") {
  let best = Infinity;
  for (const shift of [0, 1, 2]) for (const h of hours) {
    const at = atLocal(t + shift * 86_400_000, h, minute, tz);
    if (at > t && at < best) best = at;
  }
  return best;
}

/// The slots of today (local) that are already due at t: [{ at, hour, index }], in order.
export function dueToday(t, hours, minute = 0, tz = "UTC") {
  const out = [];
  hours.forEach((h, index) => { const at = atLocal(t, h, minute, tz); if (at <= t) out.push({ at, hour: h, index }); });
  return out.sort((a, b) => a.at - b.at);
}
