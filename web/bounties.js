/* The bounty board: the open bounties, the budget and who was paid, from the helpers' public route /bounties
   through the gateway's domain. Closed, the page shows the how-to and nothing else. Every word is plain text. */
(async () => {
  const $ = (id) => document.getElementById(id);
  const cfg = window.BROWNIES_CONFIG || {};
  const API = String(cfg.gateway || "").replace(/\/$/, "");
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const money = (n) => "$" + (Number.isInteger(Number(n)) ? String(Number(n)) : Number(n).toFixed(2));
  if (!API) { $("empty").hidden = false; return; }
  let v = null;
  try { const r = await fetch(API + "/bounties"); if (r.ok) v = await r.json(); } catch (_) { v = null; }
  if (!v) { $("empty").textContent = "The board did not answer. Try again in a minute."; $("empty").hidden = false; return; }
  const pool = $("pool"); pool.replaceChildren();
  if (v.open && v.pool) {
    for (const [k, val] of [["The budget", `${money(v.pool.budget)} USDC`], ["Left", `${money(v.pool.left)} USDC`], ["Paid out", `${money(v.pool.paid)} USDC`], ["Open bounties", String(v.bounties.length)]]) {
      const d = el("div"); d.append(el("dt", null, k), el("dd", null, val)); pool.append(d);
    }
  }
  const box = $("bounties"); box.replaceChildren();
  for (const b of v.bounties) {
    const art = el("article", "bounty");
    const head = el("div", "bounty-head");
    head.append(el("span", "num", String(b.id)), el("h2", null, b.title), el("span", "sugar", `${money(b.usd)} USDC`));
    art.append(head, el("p", null, b.what));
    const left = b.maxWinners - b.winners;
    art.append(el("p", "meta", `${b.winners} paid or approved, ${left} place${left === 1 ? "" : "s"} left. Claim: /bounty ${b.id} <link or text> <your wallet>`));
    box.append(art);
  }
  $("empty").hidden = v.bounties.length > 0;
  const w = $("winners"); w.replaceChildren();
  for (const x of v.winners) { const li = el("li"); li.append(el("b", null, x.handle), document.createTextNode(` ${x.bounty}, ${money(x.usd)} USDC, ${new Date(x.at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`)); w.append(li); }
  $("winnersEmpty").hidden = v.winners.length > 0;
})();
