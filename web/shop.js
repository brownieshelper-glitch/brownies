/* The shop page: the live catalog from the API (prices as set on the server, open or closed), with the static
   list as the fallback when the API does not answer. */
(async () => {
  const B = window.Brownies;
  const $ = (id) => document.getElementById(id);
  const S = await B.load();
  const api = (S.gateway || "").replace(/\/$/, "");
  const state = $("shopState");
  if (!api) return;
  let c = null;
  try { const r = await fetch(api + "/shop"); if (r.ok) c = await r.json(); } catch (_) { c = null; }
  if (!c) return;
  state.textContent = c.open ? "Open. Payments go to " + c.pay.payTo + " on Base." : "Closed for the moment: " + (c.closedBecause || "come back later") + ".";
  state.className = "shop-state " + (c.open ? "open" : "closed");
  const money = (n) => "$" + (Number(n) % 1 === 0 ? String(Number(n)) : Number(n).toFixed(2));
  const cards = $("shopItems").querySelectorAll(".shop-item");
  for (const it of c.items) {
    const card = Array.from(cards).find((x) => x.querySelector("code").textContent === "POST /shop/" + it.id);
    if (card) card.querySelector(".price b").textContent = money(it.usd);
  }
})();
