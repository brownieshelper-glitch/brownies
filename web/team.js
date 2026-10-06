/* The kitchen: one card per brownie and the list of what they reported.
   The cards always show who the brownies are. The live parts appear only when there is something true to show:
   the chain says what each one was fed and tipped, the gateway says what each one reported and is doing now.
   Every word that comes from a report is printed as plain text. */
(async () => {
  const B = window.Brownies, M = window.Mascot;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const known = new Map(M.team.map((h) => [h.id, h]));
  const title = (id) => (known.get(id) ? known.get(id).name : id.charAt(0).toUpperCase() + id.slice(1));
  const money = (micro) => "$" + (micro / 1e6).toFixed(micro > 0 && micro < 10000 ? 4 : 2);
  const WORKING_FOR = 45 * 60 * 1000;   // a task reported in the last 45 minutes counts as "now"

  // ---- the cards ----
  const crew = $("crew"), cards = new Map();
  function card(id, job, line) {
    if (cards.has(id)) return cards.get(id);
    const root = el("article", "live-card"), pic = el("div", "pic");
    pic.innerHTML = known.has(id) ? M.svg(Object.assign({}, known.get(id), { label: title(id) })) : M.svg({ label: title(id) });
    const now = el("p", "now"); now.hidden = true;
    const dl = el("dl");
    const rows = {};
    for (const [k, label] of [["today", "Reports today"], ["total", "Reports so far"], ["cost", "AI used today"], ["fed", "Fed by the vault"], ["tips", "Tips"]]) {
      const row = el("div"), dd = el("dd");
      row.append(el("dt", null, label), dd); row.hidden = true; dl.append(row);
      rows[k] = { row, dd };
    }
    root.append(pic, el("h3", null, title(id)));
    if (job) root.append(el("span", "job", job));
    if (line) root.append(el("p", "line", line));
    root.append(now, dl);
    crew.append(root);
    const c = { root, now, set: (k, text) => { rows[k].dd.textContent = text; rows[k].row.hidden = false; } };
    cards.set(id, c);
    return c;
  }
  for (const h of M.team) card(h.id, h.job, h.line);

  const S = await B.load();

  // the building site: the brownies lay one brick for each job. A click on a brownie shows its line from the card.
  const site = window.City.site($("site"), S, { about: (id) => { const c = cards.get(id); return c && !c.now.hidden ? c.now.textContent : ""; } });

  // the chain: who is on the payroll, and what each one was fed and tipped
  if (S.live && S.vault) {
    try {
      const n = Number(await S.vault.helperCount());
      for (let i = 0; i < n; i++) {
        const [h, fed, tips] = await Promise.all([S.vault.helper(i), S.vault.releasedTo(i), S.vault.tippedTo(i)]);
        if (!h.active) continue;
        const c = card(String(h.name).toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24) || "helper" + i);
        c.set("fed", B.sugar(fed, 2) + " SUGAR");
        c.set("tips", B.sugar(tips, 2) + " SUGAR");
      }
    } catch (_) { /* the chain did not answer: the cards keep what they have */ }
  }

  // ---- the gateway: counts, the task of the moment, and the reports ----
  const feed = $("feed"), more = $("more"), who = $("who");
  let filter = "", oldest = 0, pages = 0;

  async function summary() {
    const r = await B.gw(S, "/api/team/summary");
    if (!r.ok || !r.body) return;
    for (const h of r.body.helpers) {
      if (h.helper === "team") continue;                    // the people behind the coin report milestones, they have no card
      const c = card(h.helper);
      if (h.total) { c.set("today", String(h.today)); c.set("total", String(h.total)); }
      if (h.costTodayMicro) c.set("cost", money(h.costTodayMicro));
      const fresh = h.status && r.body.now - h.status.at < WORKING_FOR;
      c.now.hidden = !(fresh || h.lastAt);
      c.now.classList.toggle("rest", !fresh);
      c.now.textContent = fresh ? "Now: " + h.status.title : h.lastAt ? "Resting. Last report " + B.ago(h.lastAt, r.body.now) + "." : "";
    }
    chips();
  }

  function chips() {
    if (who.childElementCount || cards.size < 2) return;
    const add = (id, label) => {
      const b = el("button", null, label); b.type = "button"; b.setAttribute("aria-pressed", String(id === filter));
      b.onclick = () => { filter = id; for (const x of who.children) x.setAttribute("aria-pressed", String(x === b)); load(true); };
      who.append(b);
    };
    add("", "All");
    for (const id of cards.keys()) add(id, title(id));
    who.hidden = false;
  }

  const VERB = { post: "posted", reply: "answered", research: "researched", build: "built", deal: "closed a deal", milestone: "reached a milestone", note: "noted" };
  function entry(e, now) {
    const li = el("li"), face = el("span", "face"), box = el("div");
    face.innerHTML = known.has(e.helper) ? M.face(known.get(e.helper)) : M.coin({ shape: "square" });
    const meta = el("p", "meta");
    const when = el("time", null, B.ago(e.at, now)); when.dateTime = new Date(e.at).toISOString(); when.title = B.day(e.at);
    meta.append(el("b", null, e.helper === "team" ? "The team" : title(e.helper)), " " + (VERB[e.kind] || "reported") + (e.place ? " on " + e.place : "") + ", ", when);
    box.append(meta, el("p", "what", e.title));
    if (e.body) box.append(el("p", "more", e.body));
    if (e.url && /^https:\/\//.test(e.url)) {
      const a = el("a", "link", "See it"); a.href = e.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      box.append(a);
    }
    li.append(face, box);
    return li;
  }

  async function load(reset) {
    if (reset) { oldest = 0; pages = 0; }
    const r = await B.gw(S, "/api/team/activity?limit=20" + (filter ? "&helper=" + encodeURIComponent(filter) : "") + (oldest ? "&before=" + oldest : ""));
    if (!r.ok || !r.body) { if (!feed.childElementCount) $("feedEmpty").hidden = false; return; }
    const list = r.body.entries || [], now = Date.now();
    if (reset) feed.replaceChildren();
    for (const e of list) feed.append(entry(e, now));
    if (list.length) oldest = list[list.length - 1].id;
    pages++;
    more.hidden = list.length < 20;
    $("feedEmpty").hidden = feed.childElementCount > 0;
  }
  more.onclick = () => load(false);

  await Promise.all([summary(), load(true)]);
  // stay current while the page is open, unless the reader has gone back in time
  setInterval(() => { if (document.hidden) return; summary(); if (pages <= 1) load(true); }, 60000);

  window.BrowniesTeam = { reload: () => Promise.all([summary(), load(true)]), site };   // for the browser tests
})();
