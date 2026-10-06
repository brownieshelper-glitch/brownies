// Fills the local test gateway's team log with made-up reports, so the Kitchen and Progress pages have something
// to show in tests. One of them carries markup on purpose: the site must print it as plain text.
//   node smoke/seed-team.mjs <gateway url> <team key>
const [gw, key] = process.argv.slice(2);
const now = Date.now(), min = 60_000, hour = 60 * min, day = 24 * hour;
const entries = [
  { helper: "team", kind: "milestone", title: "BROWNIE launched on Pons", body: "The coin, the staking and the gateway went live in one transaction.", at: now - 9 * day },
  { helper: "nib", kind: "milestone", title: "First 100 stakers", body: "100 wallets now stake BROWNIE.", at: now - 5 * day },
  { helper: "chip", kind: "milestone", title: "Tip button shipped", url: "https://github.com/example/brownies/pull/12", at: now - 2 * day },
  { helper: "nib", kind: "research", title: "Compared the tax split of 5 agent coins", body: "Orbio keeps 10% for itself. Brownies keeps 40% and pays 50% to stakers.", at: now - 26 * hour, cost_micro: 41000 },
  { helper: "fudge", kind: "post", title: "Thread: how a trade turns into SUGAR", url: "https://x.com/example/status/1", place: "x", at: now - 7 * hour, cost_micro: 18000 },
  { helper: "crumb", kind: "reply", title: "Answered 14 questions about staking", place: "telegram", at: now - 3 * hour, cost_micro: 9000 },
  { helper: "chip", kind: "build", title: "Added a chart of SUGAR paid per day", url: "https://github.com/example/brownies/pull/14", place: "github", at: now - 95 * min, cost_micro: 250000 },
  { helper: "fudge", kind: "post", title: "<img src=x onerror=\"window.__pwned=1\"> A post title with markup in it", body: "<script>window.__pwned=1</script> It must show as text.", place: "x", at: now - 40 * min, cost_micro: 12000 },
  { helper: "crumb", kind: "reply", title: "Helped a holder find the staking page", place: "telegram", at: now - 12 * min, cost_micro: 2000 },
  { helper: "fudge", kind: "status", title: "Writing tomorrow's thread about the loyalty bonus", at: now - 6 * min },
  { helper: "chip", kind: "status", title: "Reviewing Nib's change to the progress page", at: now - 2 * min },
  { helper: "nib", kind: "status", title: "Reading yesterday's trades", at: now - 3 * hour },
];
// the older jobs go in first: the towers are built in the order the reports arrive
const WHO = ["fudge", "crumb", "nib", "chip"], KIND = { fudge: "post", crumb: "reply", nib: "research", chip: "build" };
const WHAT = { fudge: "Posted update number", crumb: "Answered question number", nib: "Wrote research note number", chip: "Shipped change number" };
const old = [];
for (let i = 0; i < 222; i++) { const w = WHO[(i * 7 + (i >> 2)) % 4]; old.push({ helper: w, kind: KIND[w], title: WHAT[w] + " " + (i + 1), at: now - 40 * day + i * 3 * hour, cost_micro: 1000 + (i % 9) * 700 }); }
for (let i = 0; i < old.length; i += 20) {
  const res = await fetch(gw + "/api/team/log", { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body: JSON.stringify(old.slice(i, i + 20)) });
  if (!res.ok) { console.log("seed failed:", res.status, await res.text()); process.exit(1); }
}
const r = await fetch(gw + "/api/team/log", { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body: JSON.stringify(entries) });
const j = await r.json();
if (!r.ok) { console.log("seed failed:", r.status, JSON.stringify(j)); process.exit(1); }
console.log("team log seeded with", old.length + j.added.length, "reports");
