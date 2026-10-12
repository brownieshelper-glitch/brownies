// The render job for the box and the reading of its pictures.
import test from "node:test";
import assert from "node:assert/strict";
import { renderJob, readShots, shotParts, SHOT_SCRIPT, WIDTHS } from "../lib/shots.mjs";

test("renderJob: the script, the pages under pages/, the command with the widths and the tiles, every picture and the info collected; bad names dropped", () => {
  const j = renderJob({ a: "<html>a</html>", "b-2": "<html>b</html>", "Bad Name": "<html>x</html>" }, { waitMs: 1000 });
  assert.equal(j.image, "browser"); assert.equal(j.files["shot.mjs"], SHOT_SCRIPT); assert.equal(j.files["pages/a.html"], "<html>a</html>"); assert.equal(j.files["pages/b-2.html"], "<html>b</html>"); assert.equal(Object.keys(j.files).length, 3);
  assert.equal(j.command, "WIDTHS=1440,375 TILES=3 WAIT_MS=1000 node shot.mjs"); assert.equal(j.timeoutSeconds, 540);
  assert.deepEqual(j.collect.slice(0, 8), ["shots/info.json", "shots/a-1440-top.jpg", "shots/a-1440-full.jpg", "shots/a-1440-t1.jpg", "shots/a-1440-t2.jpg", "shots/a-1440-t3.jpg", "shots/a-375-top.jpg", "shots/a-375-full.jpg"]); assert.equal(j.collect.length, 15);
  assert.deepEqual(renderJob({ a: "x" }, { tiles: 0 }).collect, ["shots/info.json", "shots/a-1440-top.jpg", "shots/a-1440-full.jpg", "shots/a-375-top.jpg", "shots/a-375-full.jpg"]);
  assert.match(SHOT_SCRIPT, /--no-sandbox/); assert.match(SHOT_SCRIPT, /captureBeyondViewport: true/); assert.match(SHOT_SCRIPT, /prefers-reduced-motion/); assert.ok(!/\$\{/.test(SHOT_SCRIPT), "no template holes in the script"); assert.ok(!/setDeviceMetricsOverride[^\n]*height: H/.test(SHOT_SCRIPT), "the viewport is never stretched to the page, so vh layouts keep their shape"); assert.deepEqual(WIDTHS, [1440, 375]);
});

test("readShots: the pictures by page and width with their tiles and info, the missing and the blank pages named; shotParts in its three modes", () => {
  const result = { blobs: { "shots/a-1440-top.jpg": "AAA", "shots/a-1440-full.jpg": "AAAA", "shots/a-1440-t1.jpg": "T1", "shots/a-1440-t2.jpg": "T2", "shots/a-375-top.jpg": "BBB", "shots/a-375-full.jpg": "BBBB", "shots/c-1440-top.jpg": "CCC", "shots/c-1440-full.jpg": "CCCC" }, files: { "shots/info.json": JSON.stringify({ a: { 1440: { height: 5200, width: 1440, overflow: false, chars: 900, shown: 4200, tiles: 2 }, 375: { height: 9000, width: 390, overflow: true, chars: 900, shown: 2400, tiles: 0 } }, c: { 1440: { height: 900, width: 1440, overflow: false, chars: 12, shown: 900, tiles: 0 } } }) } };
  const r = readShots(result, ["a", "b", "c"]);
  assert.deepEqual(r.missing, ["b", "c"], "b has no picture, c rendered blank"); assert.equal(r.error, null);
  assert.equal(r.shots.a[1440].top, "AAA"); assert.deepEqual(r.shots.a[1440].tiles, ["T1", "T2"]); assert.deepEqual(r.shots.a[375].tiles, []); assert.equal(r.shots.a[375].info.overflow, true); assert.equal(r.shots.b[1440].top, null);
  const parts = shotParts("CANDIDATE A", r.shots.a);
  assert.equal(parts.length, 8);
  assert.deepEqual(parts[0], { text: "CANDIDATE A, the first screen on desktop (1440 wide)" }); assert.deepEqual(parts[1], { image: "AAA", mime: "image/jpeg" });
  assert.deepEqual(parts[2], { text: "CANDIDATE A, the whole page on desktop, scaled down (the page is 5200 px tall, shown to 4200)" });
  assert.deepEqual(parts[6], { text: "CANDIDATE A, the whole page on phone, scaled down (the page is 9000 px tall, shown to 2400, SIDEWAYS OVERFLOW)" });
  const top = shotParts("A", r.shots.a, { mode: "top" });
  assert.deepEqual(top.filter((p) => p.image).map((p) => p.image), ["AAA", "BBB"]);
  const detail = shotParts("THE PAGE", r.shots.a, { mode: "detail" });
  assert.deepEqual(detail.filter((p) => p.image).map((p) => p.image), ["T1", "T2", "AAAA", "BBB", "BBBB"], "desktop tiles and overview, the phone's first screen and overview");
  assert.deepEqual(detail[0], { text: "THE PAGE, desktop at full size, part 1 of 2 (from 0 px down)" }); assert.deepEqual(detail[2], { text: "THE PAGE, desktop at full size, part 2 of 2 (from 1400 px down)" });
  assert.deepEqual(shotParts("x", null), []); assert.deepEqual(shotParts("x", r.shots.b), []);
  assert.equal(readShots({ files: { "shots/info.json": JSON.stringify({ error: "render failed: no chromium" }) } }, ["a"]).error, "render failed: no chromium");
});
