// The roster: every brownie on one sheet, for the owner. What each one does in a plain line, whether the public
// can see it, and where it stands: working, stopped, in need of setup (an account, a key, a setting), in need of
// the owner (a word, a decision, a card), or with a problem (something that worked and broke, a cap spent).
// Each brownie says what it still needs through its own setup() (lib/helper.mjs); the troubles come from the
// alerts (lib/alerts.mjs); this module only puts the answers in order. The brownies that are planned and not
// built yet come from the config ("planned"), so the sheet also says what is still to make.
import { cap } from "./facts.mjs";
import { cut } from "./text.mjs";

const DAY = 86_400_000;
/// The states, the most urgent first: this is the order of the sheet.
export const STATES = ["problem", "setup", "you", "stopped", "working", "planned"];
export const STATE_LABEL = { problem: "Problem", setup: "Needs setup", you: "Needs you", stopped: "Stopped", working: "Working", planned: "Not built" };

const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x || "").replace(/\s+/g, " ").trim()).filter(Boolean);
const plain = (role) => { const s = String(role || "").replace(/\s+/g, " ").trim(); const i = s.indexOf(". "); return i > 0 ? s.slice(0, i) : s; };
const stamp = (ms, tz) => { try { return new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms)); } catch { return new Date(ms).toISOString().slice(0, 16).replace("T", " "); } };

/// The sheet. helpers: { name: helper }. config: the merged config (helpers, planned, timezone). isPaused(name) and
/// offByEnv(name): the two ways a brownie is stopped. approvals: the pending cards. alerts: lib/alerts.mjs (troubles).
export async function rosterView({ helpers = {}, config = {}, store, clock, brain = null, alerts = null, isPaused = () => false, offByEnv = () => false, approvals = null, log = () => {} } = {}) {
  const now = clock.now();
  const tz = config.timezone || "UTC";
  const cards = approvals || store.pendingApprovals();
  const troubles = alerts?.troubles ? alerts.troubles(now - DAY) : [];
  const rows = [];
  for (const [name, h] of Object.entries(helpers)) {
    const c = config.helpers?.[name] || {};
    let s = {};
    try { s = (await h.setup?.()) || {}; } catch (e) { log(`[roster] ${name} could not say what it needs: ${e.message}`); s = { problems: [`it could not say what it needs (${cut(e.message, 80)})`] }; }
    const missing = list(s.missing), waiting = list(s.waiting), problems = list(s.problems), notes = list(s.notes);
    let services = []; try { services = h.services || []; } catch { services = []; }
    for (const t of troubles) {
      if (t.helper === name) problems.push(`${t.job} failed, ${stamp(t.at, tz)}: ${cut(t.text, 160)}`);
      else if (t.service && services.includes(t.service)) problems.push(`${cut(t.text, 160)} (${stamp(t.at, tz)})`);
    }
    if (brain) {
      let capMicro = 0; try { capMicro = brain.capMicro(name); } catch { capMicro = 0; }
      if (capMicro > 0 && store.spentToday(name, now).micro >= capMicro) problems.push("today's AI cap is spent: it rests until tomorrow, or raise the cap from its card");
    }
    const mine = cards.filter((a) => a.helper === name).length;
    if (mine) waiting.push(`${mine} card${mine === 1 ? " waits" : "s wait"} for your yes or no, under Waiting for you`);
    const paused = Boolean(isPaused(name));
    const state = paused ? "stopped" : missing.length ? "setup" : problems.length ? "problem" : waiting.length ? "you" : "working";
    const lines = [];
    if (paused) lines.push({ kind: "stopped", text: offByEnv(name) ? "Switched off in the server settings (HELPERS_OFF). Its jobs do not run." : "Paused from the control room. Switch it on from its card." });
    for (const t of problems) lines.push({ kind: "problem", text: t });
    for (const t of missing) lines.push({ kind: "setup", text: t });
    for (const t of waiting) lines.push({ kind: "you", text: t });
    for (const t of notes) lines.push({ kind: "note", text: t });
    const last = store.lastJob(name);
    const baked = Boolean(h.spec?.baked);
    rows.push({
      name, title: cap(name), kind: baked ? "baked" : h.recruit ? "recruit" : "team",
      does: cut(String(c.does || (baked ? "A holder's own brownie, made in the Bakery." : h.spec?.why) || plain(c.role || h.role)), 220),
      hidden: Boolean(h.hidden), state, label: STATE_LABEL[state], lines,
      last: last ? { at: Number(last.at), job: last.job, ok: Boolean(last.ok), note: cut(last.note || "", 120) } : null,
    });
  }
  for (const p of Array.isArray(config.planned) ? config.planned : []) {
    if (!p?.name || helpers[p.name]) continue; // built since the list was written
    rows.push({ name: p.name, title: p.title || cap(p.name), kind: "planned", does: cut(String(p.does || ""), 220), hidden: true, state: "planned", label: STATE_LABEL.planned, lines: list(p.needs).map((text) => ({ kind: "you", text })), last: null });
  }
  rows.sort((a, b) => STATES.indexOf(a.state) - STATES.indexOf(b.state)); // a stable sort: the config's order inside a state
  const counts = Object.fromEntries(STATES.map((k) => [k, rows.filter((r) => r.state === k).length]));
  const built = rows.filter((r) => r.state !== "planned");
  const view = { at: now, counts, total: built.length, public: built.filter((r) => !r.hidden).length, hidden: built.filter((r) => r.hidden).length, rows };
  view.line = rosterLine(view); // the counts as one sentence, for the top of the sheet
  return view;
}

/// "17 brownies: 12 working, 2 need setup, 2 need you, 1 stopped. 2 more are not built yet."
export function rosterLine(v) {
  const c = v.counts, n = (k, one, many) => (c[k] ? `${c[k]} ${c[k] === 1 ? one : many}` : null);
  const parts = [n("working", "working", "working"), n("problem", "has a problem", "have a problem"), n("setup", "needs setup", "need setup"), n("you", "needs you", "need you"), n("stopped", "stopped", "stopped")].filter(Boolean);
  return `${v.total} brownie${v.total === 1 ? "" : "s"}: ${parts.join(", ") || "none running"}.${c.planned ? ` ${c.planned} more ${c.planned === 1 ? "is" : "are"} not built yet.` : ""}`;
}

/// The sheet as plain text (the start-up log): the line, then every brownie that is not simply working.
export function rosterText(v) {
  const out = [rosterLine(v)];
  for (const r of v.rows.filter((x) => x.state !== "working")) out.push(`- ${r.title} (${r.label.toLowerCase()}${r.hidden && r.state !== "planned" ? ", hidden" : ""}): ${r.lines.filter((l) => l.kind !== "note").map((l) => l.text).join(" ") || r.does}`);
  return out.join("\n");
}
