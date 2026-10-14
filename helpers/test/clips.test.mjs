// Clip links: a file in the videos folder gets an unguessable address for a while; it is served whole, in ranges,
// to a HEAD; after the time it is gone; a file outside the folder is never shared; a made-up token is nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../lib/store.mjs";
import { FakeClock } from "../lib/clock.mjs";
import { Clips } from "../lib/clips.mjs";

test("a clip link serves the file, honours ranges and HEAD, ends on time, and never leaves the folder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brownies-clips-"));
  const file = join(dir, "sprinkle-003-trend-clip.mp4");
  const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
  writeFileSync(file, bytes);
  const outside = join(mkdtempSync(join(tmpdir(), "brownies-other-")), "secret.mp4"); writeFileSync(outside, "nope");
  const store = new Store(":memory:"), clock = new FakeClock();
  const clips = new Clips({ store, clock, baseUrl: "https://gw.test", dir });
  const url = clips.url(file);
  assert.match(url, /^https:\/\/gw\.test\/clips\/[A-Za-z0-9_-]{20,30}\.mp4$/);
  assert.throws(() => clips.url(outside), /only files in the videos folder/);
  assert.throws(() => clips.url(join(dir, "missing.mp4")), /ENOENT/);
  const server = createServer((req, res) => (req.url.startsWith("/clips/") ? clips.handle(req, res) : (res.writeHead(404), res.end())));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const path = url.replace("https://gw.test", "");
  try {
    const whole = await fetch(base + path);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("content-type"), "video/mp4");
    assert.equal(whole.headers.get("content-length"), "5000");
    assert.equal(whole.headers.get("accept-ranges"), "bytes");
    assert.ok(Buffer.from(await whole.arrayBuffer()).equals(bytes));
    const part = await fetch(base + path, { headers: { range: "bytes=100-199" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 100-199/5000");
    assert.ok(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(100, 200)));
    const tail = await fetch(base + path, { headers: { range: "bytes=4900-" } });
    assert.equal(tail.status, 206); assert.equal(tail.headers.get("content-length"), "100");
    const head = await fetch(base + path, { method: "HEAD" });
    assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), "5000");
    assert.equal((await fetch(base + path, { headers: { range: "bytes=9000-9100" } })).status, 416);
    assert.equal((await fetch(base + "/clips/AAAAAAAAAAAAAAAAAAAAAAAA.mp4")).status, 404, "a made-up token");
    assert.equal((await fetch(base + "/clips/../../etc/passwd")).status, 404);
    assert.equal((await fetch(base + path, { method: "POST" })).status, 404);
    clock.t += 91 * 60_000;
    assert.equal((await fetch(base + path)).status, 404, "the link ended");
  } finally { server.close(); }
});

// ---- the reel: the approved videos, for the kitchen cam's hourly show ----
test("the reel lists the videos the owner approved once their light copy is made, serves only those, and drops one he takes back", async () => {
  const { EventEmitter } = await import("node:events");
  const { existsSync, readFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "brownies-reel-"));
  const store = new Store(":memory:"), clock = new FakeClock();
  const file = (n) => { const f = join(dir, `sprinkle-00${n}-clip.mp4`); writeFileSync(f, Buffer.from(`video ${n} `.repeat(50))); return f; };
  const rec = (n, r) => store.setMeta(`sprinkle:video:${n}`, JSON.stringify({ at: 1, kind: "trend", title: `Trend: Clip ${n}`, seconds: 12, files: [file(n)], ...r }));
  rec(1, { review: "approved", kind: "series", title: "Ep. 1: The Bell", seconds: 15 });
  rec(2, { review: "waiting" });
  rec(3, { review: "rejected" });
  rec(4, { review: "approved" });
  rec(5, { review: "approved", files: [join(dir, "gone.mp4")] }); // its file is not there any more
  rec(6, {}); // made before there was a yes or a no
  store.setMeta("sprinkle:videos", 6);
  const calls = [], logs = [];
  let fail = new Set([4]);
  const spawn = (cmd, args) => {
    calls.push([cmd, args]);
    const p = new EventEmitter(); p.stderr = new EventEmitter();
    const out = args.at(-1), n = Number(/(\d+)\.mp4\.part$/.exec(out)[1]);
    setImmediate(() => { if (fail.has(n)) { p.stderr.emit("data", "moov atom not found"); p.emit("exit", 1); } else { writeFileSync(out, Buffer.from(`light ${n} `.repeat(20))); p.emit("exit", 0); } });
    return p;
  };
  const clips = new Clips({ store, clock, baseUrl: "https://gw.test", dir, spawn, log: (l) => logs.push(l) });
  assert.deepEqual(clips.reel(), [], "nothing is ready the first time: the copies are being made");
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(calls.map((c) => c[1].at(-1).split(/[\\/]/).slice(-2).join("/")), ["reel/1.mp4.part", "reel/4.mp4.part"], "one after the other, the approved ones only");
  assert.ok(calls[0][1].includes("-an") && calls[0][1].join(" ").includes("scale=w=720:h=960"), "no sound, small picture");
  assert.deepEqual(clips.reel(), [{ n: 1, title: "Ep. 1: The Bell", kind: "series", seconds: 15, url: "https://gw.test/clips/reel/1.mp4" }]);
  assert.ok(logs.some((l) => /no light copy of video 4: ffmpeg ended with 1: moov atom not found/.test(l)));
  clips.reel(); await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 2, "a copy ffmpeg refused is not tried again and again");
  assert.equal(existsSync(join(dir, "reel", "4.mp4.part")), false);

  const server = createServer((req, res) => (req.url.startsWith("/clips/") ? clips.handle(req, res) : (res.writeHead(404), res.end())));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const list = await fetch(base + "/clips/reel.json?x=1");
    assert.equal(list.headers.get("access-control-allow-origin"), "*", "the Room's page reads it from the site");
    assert.deepEqual((await list.json()).videos.map((v) => [v.n, v.title]), [[1, "Ep. 1: The Bell"]]);
    const one = await fetch(base + "/clips/reel/1.mp4");
    assert.equal(one.status, 200); assert.equal(one.headers.get("content-type"), "video/mp4");
    assert.deepEqual(Buffer.from(await one.arrayBuffer()), readFileSync(join(dir, "reel", "1.mp4")), "the light copy, not the original");
    const part = await fetch(base + "/clips/reel/1.mp4", { headers: { range: "bytes=0-9" } });
    assert.equal(part.status, 206); assert.equal((await part.arrayBuffer()).byteLength, 10);
    for (const n of [2, 3, 4, 5, 6, 99]) assert.equal((await fetch(`${base}/clips/reel/${n}.mp4`)).status, 404, `video ${n} is not in the reel`);
    assert.equal((await fetch(base + "/clips/reel/../sprinkle-001-clip.mp4")).status, 404);
    // the owner takes a video back: it leaves the list and is no longer served
    rec(1, { review: "rejected" });
    assert.deepEqual((await (await fetch(base + "/clips/reel.json")).json()).videos, []);
    assert.equal((await fetch(base + "/clips/reel/1.mp4")).status, 404);
  } finally { await new Promise((r) => server.close(r)); }
});
