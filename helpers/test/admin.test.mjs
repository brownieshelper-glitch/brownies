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
    assert.deepEqual(await cmd({ helper: "crumb", action: "cap", value: 4.5 }), { ok: true, capUsd: 4.5 });
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
    W.ghm.prs.push({ number: 100, state: "open", merged: false, html_url: "https://github.com/x/y/pull/100", title: "A change", head: "chip/a", base: "main" });
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
