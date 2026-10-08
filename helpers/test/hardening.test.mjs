// The fixes from the review of 2026-10-08, each pinned by a test: settings parsing, the client address behind the
// proxy, the public view of a job, the scheduler surviving a bad write, the page reader staying on the public web.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnvFile, offList } from "../lib/env.mjs";
import { clientIp } from "../lib/net.mjs";
import { publicJob, applyAction, STATE_LABEL } from "../lib/moneyjobs.mjs";
import { isPublicHttpUrl, readPage } from "../lib/web.mjs";
import { FakeClock } from "../lib/clock.mjs";
import { Scheduler } from "../lib/scheduler.mjs";
import { Store } from "../lib/store.mjs";

test("env: values are trimmed, quotes come off, an unquoted comment is dropped, a quoted hash stays", () => {
  const dir = mkdtempSync(join(tmpdir(), "brownies-env-"));
  const f = join(dir, "x.env");
  writeFileSync(f, 'A="quoted"  \nB=value # a comment\nC=\'single\'\nD="keep # this"\nE=  spaced  \n# F=commented\n');
  const env = {};
  assert.equal(readEnvFile(f, env), 5);
  assert.deepEqual(env, { A: "quoted", B: "value", C: "single", D: "keep # this", E: "spaced" });
});

test("env: HELPERS_OFF takes any helper's name, hidden ones too", () => {
  assert.deepEqual(offList({ HELPERS_OFF: "zest, Sprinkle" }), ["zest", "sprinkle"]);
});

test("net: behind the proxy the client is the last forwarded address; off the proxy the header is ignored", () => {
  const mk = (remote, fwd) => ({ socket: { remoteAddress: remote }, headers: fwd ? { "x-forwarded-for": fwd } : {} });
  assert.equal(clientIp(mk("127.0.0.1", "1.2.3.4")), "1.2.3.4");
  assert.equal(clientIp(mk("::ffff:127.0.0.1", "9.9.9.9, 1.2.3.4")), "1.2.3.4", "the proxy appends the real client last");
  assert.equal(clientIp(mk("::1", "")), "::1");
  assert.equal(clientIp(mk("5.6.7.8", "1.2.3.4")), "5.6.7.8", "a direct client cannot pick its own address");
  assert.equal(clientIp({}), "?");
});

test("board: the public view of a job carries no owner instruction and no contact, and a studio request shows only the idea", () => {
  const job = { id: 3, kind: "studio", title: "Studio request: Moon Cat", url: null, state: "found", score: 50, effort: "high", expectedUsd: 0, earnedUsd: 0,
    summary: "A cat coin.\nContact: cat@example.com\nLink: https://x.com/cat", nextStep: "Reply to cat@example.com", ownerAction: "Send the proposal to cat@example.com",
    helper: "glaze", source: "studio-form", createdAt: 1, updatedAt: 2, log: [{ at: 1, by: "studio-form", text: "asked" }] };
  const v = publicJob(job);
  assert.equal(v.summary, "A cat coin.");
  assert.equal(v.nextStep, undefined);
  assert.equal(v.ownerAction, undefined);
  assert.equal(v.stateLabel, STATE_LABEL.found);
  assert.ok(!JSON.stringify(v).includes("cat@example.com"));
  const grant = publicJob({ id: 4, kind: "grant", title: "A grant", state: "picked", summary: "Money for hooks", nextStep: "Apply", ownerAction: "Sign the form", log: [] });
  assert.equal(grant.nextStep, "Apply");
  assert.equal(grant.ownerAction, undefined);
});

test("board: a prototype name is not an action", () => {
  const s = new Store(":memory:");
  const id = s.addMoneyJob({ at: 1, kind: "grant", title: "A grant", url: "https://example.org/g", ref: "r1", source: "zest", state: "found" });
  assert.match(applyAction(s, { id, action: "constructor" }).error, /No such action/);
  assert.match(applyAction(s, { id, action: "__proto__" }).error, /No such action/);
  assert.equal(applyAction(s, { id, action: "pick" }).job.state, "picked");
});

test("store: a corrupt latest note reads as none", () => {
  const s = new Store(":memory:");
  s.setMeta("note:latest", "{not json");
  assert.equal(s.latestNote, null);
});

test("scheduler: a flag write that throws does not stop the clock", async () => {
  const clock = new FakeClock(Date.UTC(2026, 9, 7, 8, 59, 0));
  const flags = { hasFlag: () => false, setFlag: () => { throw new Error("SQLITE_FULL"); } };
  const logs = [];
  const s = new Scheduler({ clock, tz: "UTC", flags, log: (l) => logs.push(l) });
  let ran = 0;
  s.add({ id: "post", helper: "fudge", daily: { hours: [9] }, run: async () => { ran++; } });
  let every = 0;
  s.add({ id: "poll", helper: "crumb", every: 60_000, initialDelay: 1_000, run: async () => { every++; } });
  s.start();
  await clock.advance(2 * 60_000);
  assert.equal(ran, 0, "the daily job could not start");
  assert.ok(logs.some((l) => /could not start: SQLITE_FULL/.test(l)));
  assert.ok(every >= 1, "the other job still runs");
  await clock.advance(10 * 60_000);
  assert.ok(every >= 10, "and keeps running: the timer was armed again");
  s.stop();
});

test("web: only public web addresses are read; a redirect to a private host is refused; a huge page is cut", async () => {
  assert.equal(isPublicHttpUrl("https://example.org/x"), true);
  for (const u of ["http://127.0.0.1:8791/health", "http://localhost/x", "http://169.254.169.254/latest", "http://10.0.0.5/", "http://192.168.1.1/", "http://172.20.0.1/", "ftp://example.org/", "file:///etc/passwd", "http://[::1]/", "http://metadata.internal/"]) assert.equal(isPublicHttpUrl(u), false, u);
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (url === "https://example.org/go") return { status: 302, ok: false, headers: new Map([["location", "http://127.0.0.1:8791/admin/state"]]) };
    if (url === "https://example.org/big") return { status: 200, ok: true, headers: new Map([["content-type", "text/plain"]]), text: async () => "x".repeat(5_000_000) };
    if (url === "https://example.org/pdf") return { status: 200, ok: true, headers: new Map([["content-type", "application/pdf"]]), text: async () => "%PDF" };
    return { status: 200, ok: true, headers: new Map([["content-type", "text/html"]]), text: async () => "<html><body><div>Hello there</div></body></html>" };
  };
  assert.match(await readPage("http://127.0.0.1:8791/admin/state", { fetch }), /not a public web address/);
  assert.equal(calls.length, 0, "nothing was fetched");
  assert.match(await readPage("https://example.org/go", { fetch }), /not a public web address/);
  assert.deepEqual(calls, ["https://example.org/go"], "the redirect target was checked and not fetched");
  const big = await readPage("https://example.org/big", { fetch, max: 100, maxBytes: 1000 });
  assert.ok(big.length <= 100);
  assert.match(await readPage("https://example.org/pdf", { fetch }), /not a text page/);
  assert.match(await readPage("https://example.org/page", { fetch }), /Hello there/);
});
