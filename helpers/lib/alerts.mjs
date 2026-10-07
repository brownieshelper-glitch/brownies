// Alerts to the owner on Telegram: a helper out of budget, a service that refuses the credentials, a restart,
// a job that keeps failing. Never more than one alert per topic per hour; the rest is only logged.
import { cap } from "./facts.mjs";

export class Alerts {
  constructor({ telegram = null, ownerChatId = "", store, clock, mode = "prelaunch", log = () => {} }) {
    Object.assign(this, { telegram, ownerChatId, store, clock, mode, log });
    this.sent = [];
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
    return this.send(`credentials:${service}`, `${cap(service)} refused the brownies' credentials. ${detail}. Check the helpers env file on the server and restart brownies-helpers.`);
  }
  restarted() { return this.send("restart", `The brownies restarted (MODE=${this.mode}).`); }
  failure(helper, job, message) { return this.send(`failure:${helper}:${job}`, `${cap(helper)}'s job "${job}" failed: ${String(message).slice(0, 300)}`); }
}
