/* The board: what the brownies hunt and work on to bring money and attention to the project. Read from the
   helpers' public route /jobs/list through the gateway's domain. Every word from a job is printed as plain text.
   On a local machine, ?demo=1 shows sample jobs with no server. */
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const cfg = window.BROWNIES_CONFIG || {};
  const API = String(cfg.gateway || "").replace(/\/$/, "");
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const demo = local && new URLSearchParams(location.search).get("demo") === "1";
  const money = (n) => "$" + Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const ago = (t) => { const d = Date.now() - t; if (d < 3_600_000) return `${Math.max(1, Math.round(d / 60_000))} min ago`; if (d < 86_400_000) return `${Math.round(d / 3_600_000)} h ago`; return `${Math.round(d / 86_400_000)} d ago`; };
  const cap = (s) => String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1);
  const DONE = new Set(["won", "paid", "lost", "dropped"]);
  const ORDER = ["waiting_owner", "working", "submitted", "preparing", "picked", "found", "won", "paid", "lost", "dropped"];
  const FILTERS = [["", "All"], ["found", "Found"], ["open", "In progress"], ["waiting_owner", "Waiting for the owner"], ["won", "Won"], ["paid", "Paid"], ["dropped", "Dropped"]];
  let data = null, filter = "";

  function totals(t) {
    const box = $("totals"); box.replaceChildren();
    for (const [k, v] of [["Found, not picked", t.found], ["In progress", t.open], ["Won", t.won], ["Paid", t.paid], ["Earned", money(t.earnedUsd)], ["Could pay", money(t.expectedOpenUsd)]]) {
      const d = el("div"); d.append(el("dt", null, k), el("dd", null, String(v))); box.append(d);
    }
  }
  function filters() {
    const box = $("filters"); box.replaceChildren();
    for (const [key, label] of FILTERS) {
      const b = el("button", null, label); b.type = "button"; b.setAttribute("aria-pressed", String(key === filter));
      b.onclick = () => { filter = key; render(); };
      box.append(b);
    }
  }
  function card(j) {
    const art = el("article", "job-card" + (DONE.has(j.state) ? " done" : ""));
    const tags = el("div", "tags");
    tags.append(el("span", "state", j.stateLabel || j.state), el("span", null, j.kind));
    if (j.helper) tags.append(el("span", null, cap(j.helper)));
    art.append(tags);
    const h = el("h3");
    if (j.url) { const a = el("a", null, j.title); a.href = j.url; a.target = "_blank"; a.rel = "noopener nofollow"; h.append(a); } else h.textContent = j.title;
    art.append(h);
    const nums = [];
    if (j.expectedUsd) nums.push(`up to ${money(j.expectedUsd)}`);
    if (j.earnedUsd) nums.push(`${money(j.earnedUsd)} earned`);
    if (j.deadline) nums.push(`by ${j.deadline}`);
    if (j.effort) nums.push(`effort ${j.effort}`);
    if (j.score) nums.push(`fit ${j.score}`);
    nums.push(`found by ${cap(j.source)}, ${ago(j.createdAt)}`);
    art.append(el("p", "nums", nums.join(" | ")));
    if (j.summary) art.append(el("p", "why", j.summary));
    if (j.nextStep && !DONE.has(j.state)) { const p = el("p", "next"); p.append(el("b", null, "Next: "), document.createTextNode(j.nextStep)); art.append(p); }
    if (j.ownerAction && !DONE.has(j.state)) art.append(el("p", "you", `Owner: ${j.ownerAction}`));
    const last = (j.log || []).at(-1);
    if (last) art.append(el("p", "log", `${cap(last.by)}, ${ago(last.at)}: ${last.text}`));
    return art;
  }
  function render() {
    if (!data) return;
    filters();
    totals(data.totals);
    const list = $("board"); list.replaceChildren();
    const jobs = data.jobs.filter((j) => !filter || (filter === "open" ? ["picked", "preparing", "waiting_owner", "submitted", "working"].includes(j.state) : j.state === filter))
      .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || b.updatedAt - a.updatedAt);
    for (const j of jobs) list.append(card(j));
    $("empty").hidden = jobs.length > 0;
    $("empty").textContent = data.jobs.length ? "Nothing here with this filter." : "Nothing on the board yet. Zest, the scout, hunts every morning and the first finds land here.";
  }
  async function load() {
    if (demo) { data = demoData(); render(); return; }
    if (!API) { $("empty").textContent = "This page needs the gateway address in config.js."; $("empty").hidden = false; return; }
    try {
      const r = await fetch(`${API}/jobs/list?limit=300`);
      if (!r.ok) throw new Error(String(r.status));
      data = await r.json();
      render();
    } catch (_) {
      $("empty").textContent = "The board did not answer. Try again in a minute.";
      $("empty").hidden = false;
    }
  }
  function demoData() {
    const t0 = Date.now();
    const j = (id, kind, state, title, extra) => ({ id, kind, state, stateLabel: { found: "found", waiting_owner: "waiting for the owner", working: "in progress", won: "won", paid: "paid", dropped: "dropped" }[state] || state, title, url: "https://example.org/" + id, source: "zest", createdAt: t0 - id * 3_600_000, updatedAt: t0 - id * 600_000, log: [{ at: t0 - id * 600_000, by: "zest", text: "found while searching: grants" }], ...extra });
    return { totals: { found: 2, open: 2, won: 1, paid: 1, earnedUsd: 4500, expectedOpenUsd: 27000 }, jobs: [
      j(1, "grant", "waiting_owner", "Example Builder Grants, round 3", { expectedUsd: 5000, deadline: "2026-10-31", effort: "medium", score: 82, helper: "glaze", summary: "Open-source Ethereum tooling fits the round.", nextStep: "Fill the form with the repository and the site.", ownerAction: "Send what Glaze prepared; it is in your Telegram." }),
      j(2, "hackathon", "working", "Hooks Hackathon", { expectedUsd: 20000, effort: "high", score: 61, helper: "chip", summary: "We ship v4 hooks.", nextStep: "Register the team." }),
      j(3, "bounty", "found", "Audit contest X", { expectedUsd: 30000, deadline: "2026-10-20", effort: "high", score: 70, summary: "Solidity contest, two weeks.", nextStep: "Register before the start." }),
      j(4, "partnership", "found", "Wallet partner programme", { effort: "low", score: 58, summary: "Lists projects that integrate.", nextStep: "Write to the partnerships address." }),
      j(5, "grant", "paid", "Small tooling grant", { expectedUsd: 4500, earnedUsd: 4500, effort: "low", score: 75, helper: "glaze", summary: "Paid for the open-source gateway." }),
      j(6, "accelerator", "dropped", "Enterprise accelerator", { expectedUsd: 150000, effort: "high", score: 25, summary: "Needs a company and travel." }),
    ] };
  }
  load();
  if (!demo) setInterval(load, 60_000);
})();
