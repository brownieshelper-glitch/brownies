/* The studio page: the offer from the helpers' server (so the price and the slice are always the real ones) and
   the form, which lands on the money jobs board and tells the owner. Nothing is promised about price or returns. */
(() => {
  const $ = (id) => document.getElementById(id);
  const cfg = window.BROWNIES_CONFIG || {};
  const API = String(cfg.gateway || "").replace(/\/$/, "");
  const el = (tag, text) => { const n = document.createElement(tag); if (text != null) n.textContent = text; return n; };
  async function offer() {
    if (!API) return;
    try {
      const r = await fetch(`${API}/studio/info`);
      if (!r.ok) return;
      const o = await r.json();
      const list = $("includes"); list.replaceChildren();
      for (const x of o.includes || []) list.append(el("li", x));
      $("price").textContent = `${o.priceEth} ETH`;
      $("slice").textContent = `+ ${o.feeSlicePct}% of the creator fee`;
    } catch (_) { /* the page keeps its defaults */ }
  }
  const DEFAULTS = ["a name check, a logo and a banner in the coin's own style", "a one-page site with the story, the links and a live chart", "a short cartoon intro video for X, TikTok and Telegram", "the launch on Programmable on Ethereum, done for you, with the fee contract set at launch", "two weeks of community: a Telegram bot that answers your holders and daily posts on X"];
  for (const x of DEFAULTS) $("includes").append(el("li", x));
  offer();
  const status = (t, bad = false) => { const s = $("askStatus"); s.textContent = t; s.classList.toggle("bad", bad); };
  $("askForm").onsubmit = async (ev) => {
    ev.preventDefault();
    if (!API) return status("This page needs the gateway address in config.js.", true);
    const body = { name: $("fName").value.trim(), idea: $("fIdea").value.trim(), contact: $("fContact").value.trim(), link: $("fLink").value.trim(), website: $("fWebsite").value };
    if (body.name.length < 2) return status("Tell us the coin, or your name.", true);
    if (body.idea.length < 10) return status("A few sentences about the idea, please.", true);
    if (body.contact.length < 3) return status("How do we reach you?", true);
    $("askBtn").disabled = true; status("Sending...");
    try {
      const r = await fetch(`${API}/studio/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { status(j.error || "The studio could not take that. Try again in a minute.", true); $("askBtn").disabled = false; return; }
      status(j.duplicate ? "We already have this one. The owner answers within a day." : "Sent. The owner answers within a day with a proposal.");
      $("askForm").reset();
    } catch (_) { status("The server did not answer. Try again in a minute.", true); }
    $("askBtn").disabled = false;
  };
})();
