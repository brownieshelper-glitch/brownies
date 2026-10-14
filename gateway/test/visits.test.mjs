// First-party visits: a tagged page view is one count per day, source, campaign and content; bad tags are not
// kept; the rows and the totals read back for the ads.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Visits } from "../visits.mjs";

test("visits are counted by their tags only, bad tags dropped, read back by day and in totals", () => {
  let now = Date.parse("2026-10-15T10:00:00Z");
  const v = new Visits(new DatabaseSync(":memory:"), { now: () => now });
  assert.equal(v.count({ source: "meta", medium: "paid", campaign: "stories", content: "ep-cut-h1", path: "/room.html" }), true);
  assert.equal(v.count({ source: "meta", campaign: "stories", content: "ep-cut-h1", path: "/room.html" }), true);
  assert.equal(v.count({ source: "TikTok", campaign: "Services", content: "", path: "/shop.html?x=1" }), true, "tags are lower-cased, the content may be empty");
  assert.equal(v.count({ source: "", campaign: "stories" }), false);
  assert.equal(v.count({ source: "meta", campaign: "sto ries" }), false);
  assert.equal(v.count({ source: "<script>", campaign: "stories" }), false);
  assert.equal(v.count({ source: "meta", campaign: "stories", content: "a".repeat(41) }), false);
  now += 86_400_000;
  assert.equal(v.count({ source: "x", campaign: "stories", content: "cam-moment-h2" }), true);
  const rows = v.rows(14);
  assert.deepEqual(rows, [
    { day: "2026-10-16", source: "x:paid", campaign: "stories", content: "cam-moment-h2", n: 1 },
    { day: "2026-10-15", source: "meta:paid", campaign: "stories", content: "ep-cut-h1", n: 2 },
    { day: "2026-10-15", source: "tiktok:paid", campaign: "services", content: "", n: 1 },
  ]);
  assert.deepEqual(v.totals(7), { "x:paid|stories|cam-moment-h2": 1, "meta:paid|stories|ep-cut-h1": 2, "tiktok:paid|services|": 1 });
  assert.deepEqual(v.rows(1), [{ day: "2026-10-16", source: "x:paid", campaign: "stories", content: "cam-moment-h2", n: 1 }], "one day back is today only");
});
