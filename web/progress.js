/* Progress: the coin's numbers from the chain, the brownies' last 7 days from the gateway, and the milestones.
   A block is shown only when it has something true in it. Words from reports are printed as plain text. */
(async () => {
  const B = window.Brownies, M = window.Mascot;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const row = (list, label, value) => { const d = el("div"); d.append(el("dt", null, label), el("dd", null, value)); list.append(d); };
  const known = new Map(M.team.map((h) => [h.id, h.name]));
  const S = await B.load();

  // ---- the city: one tower for every 100 finished jobs ----
  const city = await window.City.skyline($("city"), S);
  if (city.done > 0) $("cityLine").textContent = city.done + (city.done === 1 ? " job done. " : " jobs done. ") + "The brownies are on tower " + city.current + ".";
  window.BrowniesCity = city;   // for the browser tests

  // ---- the numbers, from the contracts ----
  if (S.live) {
    try {
      const zero = Promise.resolve(null);
      const [paid, team, bought, main, staked, released, skills] = await Promise.all([
        S.staking.totalMinted(), S.harvester.totalTeamFunded(), S.sugar.totalActivated(), S.harvester.totalMainPaid(), S.staking.totalStaked(),
        S.vault ? S.vault.totalReleased() : zero, S.registry ? S.registry.count() : zero,
      ]);
      const list = $("numbersList");
      row(list, "Paid to stakers", B.usd(paid));
      row(list, "Sent to feed the brownies", B.usd(team));
      row(list, "AI bought with SUGAR", B.usd(bought));
      row(list, "Sent to the protocol wallet", B.eth(main) + " ETH");
      row(list, "BROWNIE staked now", B.coin(staked));
      if (released != null) row(list, "SUGAR handed to the brownies", B.sugar(released, 2));
      if (skills != null) row(list, "Skills proposed by stakers", String(skills));
      $("numbers").hidden = false; $("figures").hidden = false;
    } catch (_) { /* the chain did not answer: the block stays hidden */ }
  }

  // ---- the last 7 days, from the brownies' reports ----
  const sum = await B.gw(S, "/api/team/summary");
  if (sum.ok && sum.body && sum.body.total > 0) {
    const w = sum.body.week || {}, list = $("weekList");
    for (const [k, label] of [["post", "Posts"], ["reply", "Answers to people"], ["research", "Research notes"], ["build", "Things built"], ["deal", "Deals"], ["milestone", "Milestones"]]) row(list, label, String(w[k] || 0));
    row(list, "Reports since the start", String(sum.body.total));
    $("week").hidden = false; $("figures").hidden = false;
  }

  // ---- milestones, newest first ----
  const miles = $("miles");
  const r = await B.gw(S, "/api/team/activity?kind=milestone&limit=100");
  for (const e of (r.ok && r.body && r.body.entries) || []) {
    const li = el("li"), box = el("div");
    const when = el("time", null, B.day(e.at)); when.dateTime = new Date(e.at).toISOString();
    box.append(el("p", "what", e.title));
    if (e.body) box.append(el("p", "more", e.body));
    box.append(el("p", "meta", "Reported by " + (e.helper === "team" ? "the team" : known.get(e.helper) || e.helper) + "."));
    if (e.url && /^https:\/\//.test(e.url)) {
      const a = el("a", "link", "See it"); a.href = e.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      box.append(a);
    }
    li.append(when, box);
    miles.append(li);
  }
  $("milesEmpty").hidden = miles.childElementCount > 0;
})();
