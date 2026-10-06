// What the four brownies share: a name, a role, a budget check, a system prompt built from the facts and Nib's
// latest note, and the two ways to talk to the Kitchen (a "status" when a job starts, a report when it is done).
import { systemPrompt } from "./voice.mjs";
import { latestNoteText, cap } from "./facts.mjs";
import { BudgetError } from "./brain.mjs";

export const ORDINAL = ["zeroth", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
export const ordinal = (n) => ORDINAL[n] || `${n}th`;

export class Helper {
  /// deps: { config, brain, gateway, store, clock, alerts, facts, log }
  constructor(name, deps) {
    this.name = name;
    this.Name = cap(name);
    this.config = deps.config || {};
    this.role = this.config.role || "";
    Object.assign(this, { brain: deps.brain, gateway: deps.gateway, store: deps.store, clock: deps.clock, alerts: deps.alerts || null, facts: deps.facts || "", log: deps.log || (() => {}) });
  }

  /// The system prompt: the voice, the facts, Nib's latest note and this helper's own rules.
  system(extra = "") { return systemPrompt({ name: this.Name, role: this.role, facts: this.facts, note: latestNoteText(this.store), extra }); }

  /// False (and an alert, at most once an hour) when the helper cannot pay for a thought right now.
  async ready() {
    const c = await this.brain.canSpend(this.name);
    if (!c.ok) { this.log(`[${this.name}] cannot think: ${c.reason}`); await this.alerts?.budget(this.name, c.reason); }
    return c.ok;
  }

  think(opts) { return this.brain.chat(this.name, opts); }

  /// "Writing today's second post": what the Kitchen shows as the task of the moment.
  status(title) { return this.gateway.report({ helper: this.name, kind: "status", title }); }

  /// A job done. Counted in the store too, so the helper knows what it did today after a restart.
  async report(kind, title, { body = null, url = null, place = null, cost_micro = 0 } = {}) {
    const row = await this.gateway.report({ helper: this.name, kind, title, body, url, place, cost_micro });
    this.store.jobDone({ at: this.clock.now(), helper: this.name, job: kind, ok: true, costMicro: cost_micro, note: title });
    return row;
  }

  /// Runs a job body. Budget and credential errors are turned into an alert and a log line; others are rethrown
  /// to the scheduler, which logs them. The helper never crashes the process.
  async guard(job, fn) {
    try { return await fn(); }
    catch (e) {
      if (e instanceof BudgetError || e.budget) { this.log(`[${this.name}] ${e.message}`); return null; }
      if (e.credentials) { this.log(`[${this.name}] ${e.message}`); await this.alerts?.credentials(e.service, e.message); return null; }
      if (e.rateLimited) { this.log(`[${this.name}] ${e.service} rate limit, trying later`); return null; }
      await this.alerts?.failure(this.name, job, e.message);
      throw e;
    }
  }
}
