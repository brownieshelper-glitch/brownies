// The channel's live broadcast on YouTube: is one on air, and putting the channel back on air on the video the
// encoder is already sending (2026-10-13: YouTube ended the broadcast at a short break and never began another).
import test from "node:test";
import assert from "node:assert/strict";
import { onAir, arriving, goLive, keepOpen, broadcastBody, watchUrl } from "../lib/youtubelive.mjs";
import { fakeYouTubeLive, ended } from "./mock-youtubelive.mjs";

const NOW = Date.parse("2026-10-13T14:00:00Z");
const quick = { wait: async () => {}, now: NOW };

test("on air or not, and the encoder's stream is found without ever asking for its key", async () => {
  const dark = fakeYouTubeLive();
  assert.equal(await onAir(dark), null);
  assert.deepEqual(await arriving(dark), { id: "stream-1", title: "Default stream key", health: "good" });
  const live = fakeYouTubeLive({ live: { id: "vid1", snippet: { title: "Brownies Kitchen 24/24", liveChatId: "chat1" }, contentDetails: {} } });
  const b = await onAir(live);
  assert.equal(b.id, "vid1"); assert.equal(b.chatId, "chat1"); assert.equal(b.url, "https://www.youtube.com/watch?v=vid1"); assert.equal(b.life, "live");
  assert.equal(await arriving(fakeYouTubeLive({ signal: false })), null, "a stream YouTube receives nothing on is not one to go live with");
  for (const yt of [dark, live]) assert.ok(yt.calls.every((c) => !/cdn/.test(c[2])), "the part that carries the stream key is never read");
});

test("no video arriving: nothing is made", async () => {
  const yt = fakeYouTubeLive({ signal: false, ended: [ended("old1", "Brownies Kitchen 24/24", "2026-10-13T06:43:35Z")] });
  assert.deepEqual(await goLive(yt, quick), { ok: false, why: "no-signal" });
  assert.equal(yt.made.length, 0);
});

test("a broadcast like the last one is made, tied to the stream, and starts by itself: public, auto-start on, auto-stop off", async () => {
  const yt = fakeYouTubeLive({ ended: [ended("old0", "A test", "2026-10-12T20:00:00Z"), ended("old1", "Brownies Kitchen 24/24", "2026-10-13T06:43:35Z")] });
  const r = await goLive(yt, quick);
  assert.deepEqual(r, { ok: true, id: "made-1", url: watchUrl("made-1"), title: "Brownies Kitchen 24/24", made: true, life: "live" });
  const body = yt.made[0];
  assert.equal(body.snippet.title, "Brownies Kitchen 24/24"); assert.equal(body.snippet.description, "Brownies Kitchen 24/24, the words");
  assert.equal(body.snippet.scheduledStartTime, "2026-10-13T14:00:00.000Z");
  assert.deepEqual(body.status, { privacyStatus: "public", selfDeclaredMadeForKids: false });
  assert.deepEqual(body.contentDetails, { enableAutoStart: true, enableAutoStop: false, enableDvr: true, latencyPreference: "low", monitorStream: { enableMonitorStream: false, broadcastStreamDelayMs: 0 } });
  assert.deepEqual(yt.bound, [["made-1", "stream-1"]]);
  assert.deepEqual(yt.moved, [], "it started by itself: nothing was pushed");
});

test("one that does not start by itself is started from here; one that never starts is said as it is", async () => {
  const slow = fakeYouTubeLive({ startsAfter: Infinity });
  const r = await goLive(slow, { ...quick, fallbackTitle: "Brownies Kitchen 24/24" });
  assert.equal(r.ok, true); assert.equal(r.title, "Brownies Kitchen 24/24", "no broadcast before: the name it is given");
  assert.deepEqual(slow.moved, [["made-1", "live"]], "pushed once, after auto-start had its look");
  const stuck = fakeYouTubeLive({ startsAfter: Infinity });
  const api = stuck.api;
  stuck.api = async (m, u, o) => { if (u.includes("/transition")) throw Object.assign(new Error("YouTube answered 403 errorStreamInactive"), { status: 403, reason: "errorStreamInactive" }); return api(m, u, o); };
  const bad = await goLive(stuck, { ...quick, looks: 4 });
  assert.equal(bad.ok, false); assert.equal(bad.why, "not-live"); assert.equal(bad.life, "ready"); assert.equal(bad.made, true); assert.match(bad.trouble, /errorStreamInactive/);
});

test("a broadcast that already waits on the stream is used, through its test step when it has a monitor; never a second one beside it", async () => {
  const waitingOne = { id: "studio1", snippet: { title: "Brownies Kitchen 24/24" }, status: { lifeCycleStatus: "ready", privacyStatus: "public" }, contentDetails: { boundStreamId: "stream-1", enableAutoStart: false, monitorStream: { enableMonitorStream: true } } };
  const other = { id: "elsewhere", snippet: { title: "Another" }, status: { lifeCycleStatus: "ready", privacyStatus: "public" }, contentDetails: { boundStreamId: "stream-idle" } };
  const yt = fakeYouTubeLive({ waiting: [other, waitingOne] });
  const r = await goLive(yt, quick);
  assert.equal(r.ok, true); assert.equal(r.id, "studio1"); assert.equal(r.made, false);
  assert.equal(yt.made.length, 0);
  assert.deepEqual(yt.moved, [["studio1", "testing"], ["studio1", "live"]]);
});

test("a broadcast on air that would end at a short break is told to stay open, and keeps every other setting", async () => {
  const yt = fakeYouTubeLive({ live: { id: "studio2", snippet: { title: "Brownies Kitchen 24/24" }, contentDetails: { boundStreamId: "stream-1", boundStreamLastUpdateTimeMs: "2026-10-13T14:10:47Z", enableAutoStart: true, enableAutoStop: true, enableDvr: true, latencyPreference: "low", monitorStream: { enableMonitorStream: true, broadcastStreamDelayMs: 0, embedHtml: "<iframe>" } } } });
  assert.equal((await onAir(yt)).autoStop, true);
  assert.equal(await keepOpen(yt, "studio2"), true);
  assert.deepEqual(yt.updated, [{ id: "studio2", contentDetails: { enableAutoStart: true, enableAutoStop: false, enableDvr: true, latencyPreference: "low", monitorStream: { enableMonitorStream: true, broadcastStreamDelayMs: 0 } } }]);
  const after = await onAir(yt);
  assert.equal(after.autoStop, false); assert.equal(after.autoStart, true); assert.equal(after.life, "live");
  assert.equal(await keepOpen(yt, "studio2"), true); assert.equal(yt.updated.length, 1, "already off: nothing is sent");
  assert.equal(await keepOpen(yt, "nobody"), false);
});

test("the body keeps a title within YouTube's length and a privacy it knows", () => {
  const b = broadcastBody({ title: "x".repeat(140), privacy: "secret", now: NOW });
  assert.equal(b.snippet.title.length, 100); assert.equal(b.status.privacyStatus, "public");
  assert.equal(broadcastBody({ now: NOW }).snippet.title, "Live");
});
