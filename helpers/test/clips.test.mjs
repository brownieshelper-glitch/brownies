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
