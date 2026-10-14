// Alerts to the owner on Telegram: a helper out of budget, a service that refuses the credentials, a restart,
// a job that keeps failing. Never more than one alert per topic per hour; the rest is only logged.
// A failure or a refused credential is also kept as a "trouble" (its own small table) until the same thing works
// again or a day passes: the owner's roster (lib/roster.mjs) reads them, so a brownie that looks busy but whose
// posts are being refused is not shown as working.
import { cap } from "./facts.mjs";

export class Alerts {
  constructor({ telegram = null, ownerChatId = "", store, clock, mode = "prelaunch", log = () => {} }) {
    Object.assign(this, { telegram, ownerChatId, store, clock, mode, log });
    this.sent = [];
    this.q = null;
    try {
      this.store.db.exec("CREATE TABLE IF NOT EXISTS troubles (topic TEXT PRIMARY KEY, at INTEGER NOT NULL, text TEXT NOT NULL)");
      const p = (sql) => this.store.db.prepare(sql);
      this.q = { set: p("INSERT INTO troubles(topic, at, text) VALUES(?, ?, ?) ON CONFLICT(topic) DO UPDATE SET at = excluded.at, text = excluded.text"), clear: p("DELETE FROM troubles WHERE topic = ?"), since: p("SELECT topic, at, text FROM troubles WHERE at >= ? ORDER BY at DESC") };
    } catch { /* a store without a database (a test double): no trouble list */ }
  }

  /// Keeps a trouble, whether or not the hourly alert goes out.
  trouble(topic, text) { try { this.q?.set.run(topic, this.clock.now(), String(text).slice(0, 400)); } catch (e) { this.log(`[alert] could not keep the trouble: ${e.message}`); } }
  /// The thing works again: its trouble is forgotten. Called where a job or a post succeeds.
  resolved(helper, job) { try { this.q?.clear.run(`failure:${helper}:${job}`); } catch { /* nothing to forget */ } }
  /// The troubles since `sinceMs`, newest first: [{ topic, at, text, helper, job, service }].
  troubles(sinceMs = 0) {
    if (!this.q) return [];
    return this.q.since.all(sinceMs).map((r) => {
      const [kind, a, ...rest] = String(r.topic).split(":");
      return { topic: r.topic, at: Number(r.at), text: r.text, helper: kind === "failure" ? a : null, job: kind === "failure" ? rest.join(":") : null, service: kind === "credentials" ? a : null };
    });
  }

  /// Sends unless the same topic went out in the last hour. Returns true when a message was sent.
  async send(topic, text) {
    const now = this.clock.now();
    if (now - this.store.lastAlert(topic) < 3_600_000) return false;
    this.store.setAlert(topic, now);
    this.log(`[alert] ${text}`);
    this.sent.push({ topic, text, at: now });
    if (!this.telegram?.configured || !this.ownerChatId) return false;
    try { await this.telegram.sendMessage(this.ownerChatId, text); return true; }
    catch (e) { this.log(`[alert] Telegram did not take the alert: ${e.message}`); return false; }
  }

  budget(helper, reason) {
    const text = this.mode === "live"
      ? `${cap(helper)} is out of budget. Deposit SUGAR to the vault, or wait for the next tax claim. (${reason})`
      : `${cap(helper)} is out of budget: ${reason}. It rests until tomorrow. Reply /cap ${helper} <usd> to raise its cap for today and the days after.`;
    return this.send(`budget:${helper}`, text);
  }
  /// At 80% of the day's cap, once a day: the owner can raise it before the brownie stops.
  nearCap(helper, spentMicro, capMicro, now = this.clock.now()) {
    const day = this.store.dayKey(now);
    if (this.store.seen("nearcap", `${helper}:${day}`)) return Promise.resolve(false);
    this.store.markSeen("nearcap", `${helper}:${day}`, now);
    const pct = Math.floor((spentMicro / capMicro) * 100);
    return this.send(`nearcap:${helper}:${day}`, `${cap(helper)} has used ${pct}% of its daily cap: ${(spentMicro / 1e6).toFixed(2)} of ${(capMicro / 1e6).toFixed(2)} USD. Reply /cap ${helper} ${Math.ceil(capMicro / 1e6 * 2)} to raise it, or it rests at the cap until tomorrow.`);
  }
  credentials(service, detail) {
    this.trouble(`credentials:${service}`, `${cap(service)} refused the credentials: ${detail}`);
    return this.send(`credentials:${service}`, `${cap(service)} refused the brownies' credentials. ${detail}. Check the helpers env file on the server and restart brownies-helpers.`);
  }
  restarted() { return this.send("restart", `The brownies restarted (MODE=${this.mode}).`); }
  failure(helper, job, message) { this.trouble(`failure:${helper}:${job}`, String(message)); return this.send(`failure:${helper}:${job}`, `${cap(helper)}'s job "${job}" failed: ${String(message).slice(0, 300)}`); }
}
