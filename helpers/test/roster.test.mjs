// The roster: every brownie on one sheet with what it does, hidden or public, and where it stands. The state is
// stopped, needs setup, problem, needs you or working, in that order of weight; the lines say why; the troubles
// come from the alerts and go away when the thing works again or a day passes; the planned brownies close the
// sheet; the text version says the counts and every brownie that is not simply working.
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./mock.mjs";
import { rosterView, rosterLine, rosterText, STATES, STATE_LABEL } from "../lib/roster.mjs";
import { Helper } from "../lib/helper.mjs";
import { Admin } from "../lib/admin.mjs";
import { Fudge } from "../helpers/fudge.mjs";
import { Crumb } from "../helpers/crumb.mjs";
import { Chip } from "../helpers/chip.mjs";
import { Patch } from "../lib/patch.mjs";

const T0 = Date.parse("2026-10-12T10:00:00Z");
const fake = (o = {}) => ({ hidden: false, role: "", setup: () => ({}), services: [], ...o });

function world() {
  const W = makeWorld();
  W.clock.t = T0;
  const helpers = {
    fudge: fake({ services: ["x", "instagram"] }),
    crumb: fake({ setup: () => ({ waiting: ["Add the bot to the group."] }) }),
    chip: fake({ setup: () => ({ missing: ["GitHub is not connected."] }) }),
    sprinkle: fake({ hidden: true, services: ["youtube", "instagram"], setup: async () => ({ notes: ["TikTok: you post each draft by hand."] }) }),
    ember: fake({ hidden: true, setup: () => { throw new Error("no status"); } }),
    zest: fake({ hidden: true }),
    intern: fake({ hidden: true, recruit: true, spec: { why: "Answers the questions about the shop." } }),
    mine: fake({ hidden: true, spec: { baked: { wallet: "0xabc" } } }),
  };
  const config = { timezone: "CET", helpers: { fudge: { role: "marketing. You write the posts", does: "Marketing. Writes the posts for X." }, crumb: { role: "community. You answer people on Telegram" }, chip: { does: "Builder." }, sprinkle: { does: "Video." }, ember: { does: "The kitchen cam." }, zest: { does: "The scout." } }, planned: [{ name: "ciambella", does: "The Italian brownie.", needs: ["Not built. It waits for an Italian X account."] }, { name: "chip", does: "built since", needs: [] }] };
  for (const n of Object.keys(helpers)) W.brain.helpers[n] = { model: "test/small", dailyCapUsd: 1 };
  const view = (o = {}) => rosterView({ helpers, config, store: W.store, clock: W.clock, brain: W.brain, alerts: W.alerts, ...o });
  return { W, helpers, config, view };
}
const row = (v, name) => v.rows.find((r) => r.name === name);

test("the sheet: what each does, hidden or public, the state with its lines, the order, the counts, the planned ones", async () => {
  const { view } = world();
  const v = await view();
  assert.deepEqual(STATES, ["problem", "setup", "you", "stopped", "working", "planned"]);
  assert.equal(row(v, "fudge").does, "Marketing. Writes the posts for X."); assert.equal(row(v, "fudge").hidden, false); assert.equal(row(v, "fudge").state, "working"); assert.equal(row(v, "fudge").label, "Working"); assert.deepEqual(row(v, "fudge").lines, []);
  assert.equal(row(v, "crumb").does, "community", "no 'does' line: the role's first sentence");
  assert.equal(row(v, "crumb").state, "you"); assert.deepEqual(row(v, "crumb").lines, [{ kind: "you", text: "Add the bot to the group." }]);
  assert.equal(row(v, "chip").state, "setup"); assert.equal(row(v, "chip").label, "Needs setup"); assert.equal(row(v, "chip").lines[0].kind, "setup");
  assert.equal(row(v, "sprinkle").state, "working", "a note is not a reason to worry"); assert.deepEqual(row(v, "sprinkle").lines, [{ kind: "note", text: "TikTok: you post each draft by hand." }]); assert.equal(row(v, "sprinkle").hidden, true);
  assert.equal(row(v, "ember").state, "problem", "a brownie whose own check throws is a problem, not a crash"); assert.match(row(v, "ember").lines[0].text, /^it could not say what it needs \(no status\)$/);
  assert.equal(row(v, "intern").kind, "recruit"); assert.equal(row(v, "intern").does, "Answers the questions about the shop.");
  assert.equal(row(v, "mine").kind, "baked"); assert.equal(row(v, "mine").does, "A holder's own brownie, made in the Bakery.");
  assert.equal(row(v, "ciambella").state, "planned"); assert.equal(row(v, "ciambella").label, "Not built"); assert.deepEqual(row(v, "ciambella").lines, [{ kind: "you", text: "Not built. It waits for an Italian X account." }]);
  assert.equal(v.rows.filter((r) => r.name === "chip").length, 1, "a planned brownie that exists is not listed twice");
  assert.deepEqual(v.rows.map((r) => r.name), ["ember", "chip", "crumb", "fudge", "sprinkle", "zest", "intern", "mine", "ciambella"], "the most urgent first, the config's order inside a state");
  assert.deepEqual(v.counts, { problem: 1, setup: 1, you: 1, stopped: 0, working: 5, planned: 1 });
  assert.equal(v.total, 8); assert.equal(v.public, 3); assert.equal(v.hidden, 5);
  assert.equal(rosterLine(v), "8 brownies: 5 working, 1 has a problem, 1 needs setup, 1 needs you. 1 more is not built yet.");
  assert.equal(rosterText(v), ["8 brownies: 5 working, 1 has a problem, 1 needs setup, 1 needs you. 1 more is not built yet.", "- Ember (problem, hidden): it could not say what it needs (no status)", "- Chip (needs setup): GitHub is not connected.", "- Crumb (needs you): Add the bot to the group.", "- Ciambella (not built): Not built. It waits for an Italian X account."].join("\n"));
  assert.equal(Object.keys(STATE_LABEL).length, STATES.length);
});

test("stopped wins over everything; cards make a brownie need you; a spent cap is a problem", async () => {
  const { W, view } = world();
  const paused = new Set(["chip", "zest"]);
  W.store.addApproval({ at: T0, helper: "fudge", kind: "reply", ref: "1", title: "A reply" });
  W.store.addApproval({ at: T0, helper: "fudge", kind: "reply", ref: "2", title: "Another" });
  W.store.addApproval({ at: T0, helper: "sprinkle", kind: "clip", ref: "3", title: "A clip" });
  const v = await view({ isPaused: (n) => paused.has(n), offByEnv: (n) => n === "zest" });
  assert.equal(row(v, "chip").state, "stopped", "paused, though it also needs setup");
  assert.deepEqual(row(v, "chip").lines.map((l) => l.kind), ["stopped", "setup"]); assert.equal(row(v, "chip").lines[0].text, "Paused from the control room. Switch it on from its card.");
  assert.equal(row(v, "zest").lines[0].text, "Switched off in the server settings (HELPERS_OFF). Its jobs do not run.");
  assert.equal(row(v, "fudge").state, "you"); assert.equal(row(v, "fudge").lines[0].text, "2 cards wait for your yes or no, under Waiting for you");
  assert.equal(row(v, "sprinkle").lines.find((l) => l.kind === "you").text, "1 card waits for your yes or no, under Waiting for you");
  assert.equal(v.counts.stopped, 2);
  // the cap: the brain says one dollar a day, the store says it is spent
  const W2 = world();
  W2.W.brain.helpers.fudge = { model: "test/small", dailyCapUsd: 0.000001 };
  W2.W.store.spentToday = (name) => (name === "fudge" ? { micro: 5, calls: 1 } : { micro: 0, calls: 0 });
  const v2 = await W2.view();
  assert.equal(row(v2, "fudge").state, "problem"); assert.equal(row(v2, "fudge").lines[0].text, "today's AI cap is spent: it rests until tomorrow, or raise the cap from its card");
});

test("troubles: a failed job and a refused credential mark their brownies, a job that works again clears its own, a day clears the rest", async () => {
  const { W, view } = world();
  await W.alerts.failure("sprinkle", "instagram", "Instagram answered 400 (code 200): Cannot call API for app 1 on behalf of user 2");
  await W.alerts.credentials("x", "the refresh token was refused");
  assert.deepEqual(W.alerts.troubles(0).map((t) => t.topic).sort(), ["credentials:x", "failure:sprinkle:instagram"]);
  assert.deepEqual(W.alerts.troubles(0).find((t) => t.helper === "sprinkle"), { topic: "failure:sprinkle:instagram", at: T0, text: "Instagram answered 400 (code 200): Cannot call API for app 1 on behalf of user 2", helper: "sprinkle", job: "instagram", service: null });
  let v = await view();
  assert.equal(row(v, "sprinkle").state, "problem");
  assert.equal(row(v, "sprinkle").lines[0].text, "instagram failed, 12 Oct, 12:00: Instagram answered 400 (code 200): Cannot call API for app 1 on behalf of user 2", "the hour is the kitchen's (CET)");
  assert.equal(row(v, "fudge").state, "problem", "X refused the credentials: Fudge posts through X"); assert.match(row(v, "fudge").lines[0].text, /^X refused the credentials: the refresh token was refused \(12 Oct, 12:00\)$/);
  assert.equal(row(v, "zest").state, "working", "not its service");
  // the hourly throttle does not hide a trouble: a second failure inside the hour sends nothing and still updates it
  W.clock.t = T0 + 10 * 60_000;
  assert.equal(await W.alerts.failure("sprinkle", "instagram", "again"), false);
  assert.equal(W.alerts.troubles(0).find((t) => t.helper === "sprinkle").text, "again");
  // the reel goes through: the trouble is forgotten
  W.alerts.resolved("sprinkle", "instagram");
  v = await view();
  assert.equal(row(v, "sprinkle").state, "working"); assert.equal(row(v, "fudge").state, "problem", "the credentials trouble stays");
  W.clock.t = T0 + 25 * 3_600_000;
  v = await view();
  assert.equal(row(v, "fudge").state, "working", "a day later a trouble that did not come back is gone");
});

test("a helper's guard forgets the trouble of a job that works again; a helper with nothing to say is working", async () => {
  const { W } = world();
  const h = new Helper("nib", { config: { role: "research. You read the figures" }, brain: W.brain, gateway: W.gateway, store: W.store, clock: W.clock, alerts: W.alerts, facts: "", log: () => {} });
  assert.deepEqual(h.setup(), { missing: [], waiting: [], problems: [], notes: [] }); assert.deepEqual(h.services, []);
  await assert.rejects(() => h.guard("note", async () => { throw new Error("the page did not load"); }), /did not load/);
  assert.equal(W.alerts.troubles(0)[0].topic, "failure:nib:note");
  let v = await rosterView({ helpers: { nib: h }, config: { helpers: { nib: { role: "research. You read the figures" } } }, store: W.store, clock: W.clock, brain: W.brain, alerts: W.alerts });
  assert.equal(v.rows[0].state, "problem"); assert.match(v.rows[0].lines[0].text, /^note failed, .*: the page did not load$/); assert.equal(v.rows[0].does, "research");
  assert.equal(await h.guard("note", async () => 7), 7);
  assert.deepEqual(W.alerts.troubles(0), []);
  v = await rosterView({ helpers: { nib: h }, config: { helpers: {} }, store: W.store, clock: W.clock, brain: W.brain, alerts: W.alerts });
  assert.equal(v.rows[0].state, "working"); assert.equal(rosterLine(v), "1 brownie: 1 working.");
});

test("the control room's state carries the team, with the pause switch and HELPERS_OFF read as stopped", async () => {
  const { W, helpers, config } = world();
  const world2 = { S: { mode: "prelaunch", telegram: {} }, store: W.store, clock: W.clock, scheduler: { jobs: [] }, helpers, brain: W.brain, config, alerts: W.alerts, gateway: W.gateway, off: ["zest"], hidden: [], startedAt: T0 };
  const admin = new Admin({ W: world2, log: () => {} });
  admin.paused.add("fudge");
  const v = await admin.roster();
  assert.equal(v.rows.find((r) => r.name === "fudge").state, "stopped"); assert.match(v.rows.find((r) => r.name === "zest").lines[0].text, /HELPERS_OFF/);
  assert.equal(v.counts.stopped, 2); assert.equal(v.counts.planned, 1);
});

test("the public brownies say what they need: X for Fudge, Telegram and the group for Crumb, GitHub for Chip and Patch", () => {
  const say = (Cls, self) => Cls.prototype.setup.call(self);
  const services = (Cls) => Object.getOwnPropertyDescriptor(Cls.prototype, "services").get.call({});
  assert.deepEqual(say(Fudge, { x: { configured: true }, page: null }), { missing: [], notes: [] });
  assert.match(say(Fudge, { x: null, page: null }).missing[0], /^X is not connected/);
  assert.deepEqual(say(Fudge, { x: { configured: true }, page: { canPage: () => true } }).notes, ["Every post also goes on the Facebook Page."]);
  assert.deepEqual(services(Fudge), ["x", "instagram"]);
  assert.match(say(Crumb, { tg: null }).missing[0], /^Telegram is not connected/);
  assert.match(say(Crumb, { tg: { configured: true }, groupChatId: "" }).waiting[0], /^It answers private chats only\./);
  assert.deepEqual(say(Crumb, { tg: { configured: true }, groupChatId: "-100" }), {});
  assert.deepEqual(say(Chip, { github: { configured: true } }), {}); assert.match(say(Chip, { github: null }).missing[0], /^GitHub is not connected/);
  assert.match(say(Patch, { github: null }).missing[0], /^GitHub is not connected: without it there are no tests to wait for\.$/);
  assert.deepEqual(services(Chip), ["github"]);
});

test("Fudge's Facebook Page: a refusal is an alert and a trouble, the next post that goes through forgets it", async () => {
  const W = makeWorld();
  let fail = true;
  const self = { page: { canPage: () => true, pagePost: async () => { if (fail) throw new Error("Instagram answered 400 (code 200): Cannot call API for app 1 on behalf of user 2"); return { id: "p1", url: "https://facebook.test/p1" }; } }, log: () => {}, alerts: W.alerts, store: W.store };
  assert.equal(await Fudge.prototype.toPage.call(self, "Four brownies, one kitchen."), null, "the X post is not stopped by it");
  assert.equal(W.alerts.sent.length, 1); assert.match(W.alerts.sent[0].text, /^Fudge's job "facebook" failed: Instagram answered 400/);
  assert.equal(W.alerts.troubles(0)[0].topic, "failure:fudge:facebook");
  fail = false;
  assert.equal((await Fudge.prototype.toPage.call(self, "Four brownies, one kitchen.")).id, "p1");
  assert.deepEqual(W.alerts.troubles(0), []);
});
