// The control room: nothing without a session; a code from the bot or an admin wallet's signature opens one; the
// state lists every helper (hidden too); commands run, pause, resume, cap, ask, decide; the log ring is served.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Wallet } from "ethers";
import { makeWorld } from "./mock.mjs";
import { Scheduler } from "../lib/scheduler.mjs";
import { Admin, adminMessage } from "../lib/admin.mjs";

function room({ wallets = [] } = {}) {
  const W = makeWorld({ reply: () => "A plain sentence about SUGAR." });
  const ring = ["2026-10-06T00:00:00.000Z [helpers] running"];
  const scheduler = new Scheduler({ clock: W.clock, tz: "UTC", flags: W.store, log: (l) => ring.push(String(l)) });
  const helpers = { fudge: W.fudge, crumb: W.crumb, nib: W.nib, chip: W.chip };
  W.chip.hidden = false; W.nib.hidden = true; // pretend Nib is a hidden one for the test
  for (const h of Object.values(helpers)) for (const j of h.jobs()) scheduler.add(j);
  const world = { S: { mode: "prelaunch", telegram: { groupChatId: "-100" }, siteUrl: "https://site.test" }, store: W.store, clock: W.clock, scheduler, helpers, brain: W.brain, telegram: W.telegram, alerts: W.alerts, gateway: W.gateway, config: { timezone: "UTC", helpers: W.helpersCfg }, hidden: ["nib"], off: [], startedAt: Date.now() };
  let summaries = 0;
  const admin = new Admin({ W: world, ring, log: (l) => ring.push(String(l)), wallets, origins: ["https://site.test"], sendSummary: async () => { summaries++; } });
  scheduler.isOff = (n) => admin.isPaused(n);
  return { W, admin, scheduler, ring, summaries: () => summaries };
}

/// A real HTTP round trip to the handler, like the page does.
async function serve(admin) {
  const server = createServer((req, res) => (req.url.startsWith("/admin/") ? admin.handle(req, res) : (res.writeHead(404), res.end())));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", origin: "https://site.test", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null), cors: r.headers.get("access-control-allow-origin") };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test("no session, no state; a code from the bot opens one, once, for a day; the page's origin is allowed", async () => {
  const { admin, W } = room();
  const { call, close } = await serve(admin);
  try {
    assert.equal((await call("GET", "/admin/state")).status, 401);
    assert.equal((await call("POST", "/admin/login", { code: "123456" })).status, 401, "a made-up code fails");
    const code = admin.newCode();
    assert.match(code, /^\d{6}$/);
    const ok = await call("POST", "/admin/login", { code });
    assert.equal(ok.status, 200);
    assert.equal(ok.cors, "https://site.test");
    assert.ok(/^[0-9a-f]{64}$/.test(ok.body.token));
    assert.equal((await call("POST", "/admin/login", { code })).status, 401, "a code works once");
    const st = await call("GET", "/admin/state", null, ok.body.token);
    assert.equal(st.status, 200);
    assert.deepEqual(st.body.helpers.map((h) => h.name), ["fudge", "crumb", "nib", "chip"]);
    assert.equal(st.body.helpers.find((h) => h.name === "nib").hidden, true, "hidden helpers are listed for the owner");
    assert.ok(st.body.helpers[0].jobs.length >= 2);
    assert.equal(st.body.mode, "prelaunch");
    W.clock.advance(25 * 3_600_000);
    assert.equal((await call("GET", "/admin/state", null, ok.body.token)).status, 401, "a day later the session is gone");
    W.clock.advance(-25 * 3_600_000);
    const expired = admin.newCode(); W.clock.advance(11 * 60_000);
    assert.equal((await call("POST", "/admin/login", { code: expired })).status, 401, "a code dies after ten minutes");
  } finally { await close(); }
});

test("an admin wallet logs in with a signature of the nonce; a stranger's wallet does not", async () => {
  const owner = Wallet.createRandom(), stranger = Wallet.createRandom();
  const { admin } = room({ wallets: [owner.address] });
  const { call, close } = await serve(admin);
  try {
    const n = await call("GET", "/admin/nonce");
    assert.equal(n.body.wallets, 1);
    const sig = await owner.signMessage(adminMessage(n.body.nonce));
    const ok = await call("POST", "/admin/login", { address: owner.address, signature: sig, nonce: n.body.nonce });
    assert.equal(ok.status, 200);
    const n2 = await call("GET", "/admin/nonce");
    const bad = await stranger.signMessage(adminMessage(n2.body.nonce));
    assert.equal((await call("POST", "/admin/login", { address: stranger.address, signature: bad, nonce: n2.body.nonce })).status, 401);
    assert.equal((await call("POST", "/admin/login", { address: owner.address, signature: sig, nonce: n.body.nonce })).status, 401, "a nonce is used once");
  } finally { await close(); }
});

test("commands: pause skips scheduled runs but not a run by hand, resume, cap, ask, summary, decide", async () => {
  const { admin, W, scheduler, ring, summaries } = room();
  const { call, close } = await serve(admin);
  try {
    const token = (await call("POST", "/admin/login", { code: admin.newCode() })).body.token;
    const cmd = (c) => call("POST", "/admin/command", c, token).then((r) => r.body);
    // pause Fudge: its scheduled post is skipped, the state says paused, "run" refuses, "on" resumes
    assert.deepEqual(await cmd({ helper: "fudge", action: "off" }), { ok: true, paused: true });
    assert.equal(W.store.getMeta("admin:paused"), "fudge");
    const job = scheduler.jobs.find((j) => j.id === "fudge-post");
    await scheduler._run(job, { at: W.clock.now(), hour: 9, index: 0 });
    assert.ok(ring.some((l) => /\[fudge\] paused, fudge-post skipped/.test(l)), "a scheduled run is skipped while paused");
    assert.equal((await cmd({ helper: "fudge", action: "run" })).ok, false);
    assert.deepEqual(await cmd({ helper: "fudge", action: "on" }), { ok: true, paused: false });
    // a run by hand goes through the scheduler and really posts
    const r = await cmd({ helper: "fudge", action: "run", id: "fudge-post" });
    assert.equal(r.started, "fudge-post");
    await scheduler.idle();
    assert.equal(W.xm.posts.length, 1, "Fudge posted");
    // the cap is changed and remembered
    assert.deepEqual(await cmd({ helper: "crumb", action: "cap", value: 4.5 }), { ok: true, capUsd: 4.5, note: "Crumb's cap is now 4.5 USD a day." });
    assert.equal(W.brain.capMicro("crumb"), 4_500_000);
    assert.equal(W.store.getMeta("admin:cap:crumb"), "4.5");
    assert.equal((await cmd({ helper: "crumb", action: "cap", value: -1 })).ok, false);
    // an instruction: Crumb announces in the group, Fudge posts on the topic
    assert.equal((await cmd({ helper: "crumb", action: "ask", text: "Launch tomorrow at noon." })).started, "request");
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(W.tg.sent.some((m) => String(m.chat_id) === "-100" && m.text === "Launch tomorrow at noon."), "the announcement reached the group");
    assert.equal((await cmd({ helper: "fudge", action: "ask", text: "" })).ok, false);
    // the summary
    assert.deepEqual(await cmd({ action: "summary" }), { ok: true });
    assert.equal(summaries(), 1);
    // a decision on a pending approval
    const id = W.store.addApproval({ at: W.clock.now(), helper: "chip", kind: "pr", ref: 100, title: "A change", url: "https://github.com/x/y/pull/100" });
    W.ghm.prs.push({ number: 100, state: "open", merged: false, html_url: "https://github.com/x/y/pull/100", title: "A change", head: { ref: "chip/a", sha: "sha-a" }, base: "main" });
    W.ghm.branches["chip/a"] = "sha-a"; W.ghm.files["chip/a"] = { ...W.ghm.files.main };
    const st = await call("GET", "/admin/state", null, token);
    assert.equal(st.body.approvals.length, 1);
    assert.deepEqual(await cmd({ action: "approve", id }), { ok: true });
    assert.deepEqual(W.ghm.merged, [100]);
    assert.equal((await cmd({ action: "approve", id: 999 })).ok, false);
    // the log
    const lg = await call("GET", "/admin/log?n=5", null, token);
    assert.ok(lg.body.lines.length <= 5 && lg.body.lines.some((l) => /\[admin\]/.test(l)));
    // unknowns
    assert.equal((await cmd({ helper: "nobody", action: "run" })).ok, false);
    assert.equal((await cmd({ helper: "fudge", action: "dance" })).ok, false);
    assert.equal((await call("GET", "/admin/nothing", null, token)).status, 404);
    // logout
    await call("POST", "/admin/logout", null, token);
    assert.equal((await call("GET", "/admin/state", null, token)).status, 401);
  } finally { await close(); }
});

test("too many wrong codes from one place are refused for a while", async () => {
  const { admin } = room();
  const { call, close } = await serve(admin);
  try {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await call("POST", "/admin/login", { code: "000000" })).status;
    assert.equal(last, 429);
  } finally { await close(); }
});

test("the control room lists the suggestions with links unclickable and lets the owner listen or ignore", async () => {
  const { admin, W } = room();
  const { call, close } = await serve(admin);
  try {
    const token = (await call("POST", "/admin/login", { code: admin.newCode() })).body.token;
    const id = W.store.addSuggestion({ at: W.clock.now(), place: "x", who: "ann", whoId: "u1", text: "add https://example.com/chart to the site", flags: ["link"], ref: "1", url: "https://x.com/i/status/1" });
    const st = (await call("GET", "/admin/state", null, token)).body;
    assert.equal(st.suggestions.length, 1);
    assert.equal(st.suggestions[0].text, "add hxxps://example[.]com/chart to the site");
    assert.deepEqual(st.suggestions[0].flags, ["link"]);
    assert.equal(st.suggestions[0].state, "new");
    const cmd = (c) => call("POST", "/admin/command", c, token).then((r) => r.body);
    assert.equal((await cmd({ action: "suggest", id, value: "maybe" })).ok, false);
    assert.match((await cmd({ action: "suggest", id, value: "listen", text: "only the chart idea" })).note, /^The brownies will consider it/);
    assert.equal(W.store.suggestion(id).state, "listen");
    assert.equal(W.store.suggestion(id).note, "only the chart idea");
    assert.deepEqual(await cmd({ action: "suggest", id, value: "ignore" }), { ok: true, note: "Ignored." });
    assert.equal((await cmd({ action: "suggest", id: 999, value: "listen" })).ok, false);
  } finally { await close(); }
});

test("the bill: every helper's AI and video spend against its caps, the balances, videocap and refill", async () => {
  const { admin, W } = room();
  W.fetch.on("GET", "openrouter.ai/api/v1/credits", () => ({ json: { data: { total_credits: 60, total_usage: 10.5 } } }));
  W.fetch.on("GET", "openrouter.ai/api/v1/key", () => ({ json: { data: { usage_daily: 2.4, limit: 100, limit_remaining: 89.5 } } }));
  await W.brain.chat("fudge", { prompt: "One line.", job: "fudge-post" });
  W.store.addEntry({ at: W.clock.now(), helper: "fudge", kind: "video", seconds: 8, costMicro: 3_000_000, note: "Clip 1" });
  const { call, close } = await serve(admin);
  try {
    const token = (await call("POST", "/admin/login", { code: admin.newCode() })).body.token;
    const c = (await call("GET", "/admin/state", null, token)).body.costs;
    assert.equal(c.day, W.store.dayKey(W.clock.now())); assert.equal(c.timezone, "UTC");
    assert.deepEqual(c.helpers.map((h) => h.name), ["fudge", "crumb", "nib", "chip"]);
    const f = c.helpers[0];
    assert.equal(f.aiUsd, 0.001); assert.equal(f.calls, 1); assert.equal(f.capUsd, W.brain.capMicro("fudge") / 1e6); assert.equal(f.model, W.brain.model("fudge"));
    assert.equal(f.videoUsd, 3); assert.equal(f.videos, 1); assert.equal(f.videoCapUsd, null); assert.equal(f.state, "ok");
    assert.equal(f.makesVideo, true, "it filmed one today"); assert.equal(c.helpers[1].makesVideo, false);
    assert.deepEqual(f.jobs, [{ job: "post", usd: 0.001, calls: 1 }]);
    assert.equal(c.helpers[2].hidden, true, "Nib is hidden in this room");
    assert.equal(c.today.usd, 3.001); assert.equal(c.history.length, 14); assert.equal(c.history.at(-1).videoUsd, 3); assert.equal(c.recent.length, 2);
    assert.deepEqual(c.openrouter, { boughtUsd: 60, usedUsd: 10.5, leftUsd: 49.5, usageDailyUsd: 2.4, limitUsd: 100, limitLeftUsd: 89.5 });
    assert.equal(c.higgsfield, null);
    const cmd = (x) => call("POST", "/admin/command", x, token).then((r) => r.body);
    // a video cap for a brownie, kept in the store and read back by a new room; 0 removes it
    assert.deepEqual(await cmd({ helper: "fudge", action: "videocap", value: 12 }), { ok: true, videoCapUsd: 12, note: "Fudge's video cap is now 12 USD a day." });
    assert.equal(W.store.getMeta("admin:videocap:fudge"), "12"); assert.equal(W.brain.helpers.fudge.videoDailyCapUsd, 12);
    assert.equal((await cmd({ helper: "nobody", action: "videocap", value: 12 })).ok, false);
    assert.equal((await cmd({ helper: "fudge", action: "videocap", value: 2000 })).ok, false);
    const again = new Admin({ W: admin.W, ring: [], wallets: [], origins: [] });
    assert.equal(again.W.brain.helpers.fudge.videoDailyCapUsd, 12);
    // the Higgsfield balance the owner sets: counted down by the clips from then on (the clip above came before)
    W.clock.advance(1000);
    assert.equal((await cmd({ action: "refill", value: 100 })).ok, true);
    W.clock.advance(1000);
    W.store.addEntry({ at: W.clock.now(), helper: "fudge", kind: "video", seconds: 8, costMicro: 2_500_000 });
    const c2 = (await call("GET", "/admin/state", null, token)).body.costs;
    assert.equal(c2.helpers[0].videoCapUsd, 12); assert.equal(c2.helpers[0].videoUsd, 5.5); assert.equal(c2.helpers[0].videoPct, 46);
    assert.deepEqual(c2.higgsfield, { refillUsd: 100, refillAt: W.clock.now() - 1000, spentUsd: 2.5, leftUsd: 97.5, clips: 1 });
    assert.equal((await cmd({ action: "refill", value: "abc" })).ok, false);
    assert.equal((await cmd({ action: "refill", value: 0 })).ok, true);
    assert.equal((await cmd({ helper: "fudge", action: "videocap", value: 0 })).note, "Fudge has no video cap.");
    const c3 = (await call("GET", "/admin/state", null, token)).body.costs;
    assert.equal(c3.higgsfield, null); assert.equal(c3.helpers[0].videoCapUsd, null); assert.equal(W.store.getMeta("admin:videocap:fudge"), null);
  } finally { await close(); }
});
