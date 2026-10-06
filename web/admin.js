/* The owner's control room. Talks to the helpers' admin API through the gateway's domain (/admin/*). Nothing is
   shown before a login: a six-digit code from the bot (/admin on Telegram) or a signature from an admin wallet.
   The session token lives in this browser's storage for a day. Every helper is listed, hidden ones too. */
(async () => {
  const B = window.Brownies;
  const { load, toast, explainError } = B;
  const $ = (id) => document.getElementById(id);
  const S = await load();
  const API = (S.gateway || "").replace(/\/$/, "") + "/admin";
  const Wt = window.BrowniesWallet;
  Wt.init(S.cfg.chainId, { name: S.cfg.chainName, rpc: S.rpc, explorer: S.cfg.explorer });
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const KEY = "brownies-admin-token";
  let token = null;
  try { token = localStorage.getItem(KEY); } catch (_) {}
  let timer = null;

  async function api(path, opts = {}) {
    const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
    let r;
    try { r = await fetch(API + path, { ...opts, headers }); } catch (_) { return { ok: false, status: 0, body: { error: "the server did not answer" } }; }
    let body = null; try { body = await r.json(); } catch (_) {}
    if (r.status === 401 && token && path !== "/login") { token = null; try { localStorage.removeItem(KEY); } catch (_) {} show(false); }
    return { ok: r.ok, status: r.status, body };
  }

  function show(inRoom) {
    $("adminLogin").hidden = inRoom;
    $("adminRoom").hidden = !inRoom;
    if (!inRoom && timer) { clearInterval(timer); timer = null; }
  }
  function loginError(text) { const e = $("loginError"); e.textContent = text || ""; e.hidden = !text; }

  // ---- login ----
  $("codeForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const code = $("inCode").value.trim();
    if (!/^\d{6}$/.test(code)) return loginError("The code is six digits.");
    const r = await api("/login", { method: "POST", body: JSON.stringify({ code }) });
    if (!r.ok) return loginError(r.body?.error || "Could not log in.");
    enter(r.body.token);
  };
  $("btnWalletLogin").onclick = async () => {
    if (!Wt.state.account) return loginError("Connect the admin wallet first, top right.");
    const n = await api("/nonce");
    if (!n.ok) return loginError("The server did not give a nonce.");
    if (!n.body.wallets) return loginError("No admin wallet is set on the server. Use the Telegram code.");
    try {
      const message = n.body.message.replace("<nonce>", n.body.nonce);
      const signature = await Wt.state.signer.signMessage(message);
      const r = await api("/login", { method: "POST", body: JSON.stringify({ address: Wt.state.account, signature, nonce: n.body.nonce }) });
      if (!r.ok) return loginError(r.body?.error || "Could not log in.");
      enter(r.body.token);
    } catch (e) { loginError(explainError(e)); }
  };
  function enter(t) {
    token = t; try { localStorage.setItem(KEY, t); } catch (_) {}
    loginError("");
    show(true);
    refresh();
    timer = setInterval(refresh, 20_000);
  }
  $("btnLogout").onclick = async () => { await api("/logout", { method: "POST" }); token = null; try { localStorage.removeItem(KEY); } catch (_) {} show(false); };

  // ---- the room ----
  const money = (n) => `$${Number(n || 0).toFixed(2)}`;
  const when = (iso) => (iso ? B.ago(new Date(iso).getTime()) : "");
  const upcoming = (iso) => { if (!iso) return ""; const d = new Date(iso).getTime() - Date.now(); if (d < 60_000) return "in under a minute"; if (d < 3_600_000) return `in ${Math.round(d / 60_000)} min`; return `in ${(d / 3_600_000).toFixed(1)} h`; };

  async function refresh() {
    const [st, lg] = await Promise.all([api("/state"), api("/log?n=120")]);
    if (!st.ok) return;
    const s = st.body;
    const stats = $("adminStats"); stats.replaceChildren();
    for (const [k, v] of [["Mode", s.mode], ["Up for", `${Math.floor(s.uptimeSeconds / 3600)} h ${Math.floor((s.uptimeSeconds % 3600) / 60)} min`], ["Reports", s.reports], ["AI calls", s.thoughts], ["Videos", s.videos], ["Group", s.group || "none yet"]]) {
      const d = el("div"); d.append(el("dt", null, k), el("dd", null, String(v))); stats.append(d);
    }
    const ap = $("approvals"); ap.replaceChildren();
    for (const a of s.approvals) {
      const li = el("li");
      const box = el("div");
      box.append(el("p", "meta", `${cap(a.helper)}, ${when(a.at)}`), el("p", "what", a.title));
      if (a.url) { const l = el("a", "link", "See it"); l.href = a.url; l.target = "_blank"; l.rel = "noopener"; box.append(l); }
      const acts = el("div", "admin-row");
      const yes = el("button", "btn sm", "Approve"); yes.onclick = () => command({ action: "approve", id: a.id });
      const no = el("button", "btn sm ghost", "Reject"); no.onclick = () => command({ action: "reject", id: a.id });
      acts.append(yes, no); box.append(acts); li.append(box); ap.append(li);
    }
    $("approvalsEmpty").hidden = s.approvals.length > 0;
    const grid = $("agents"); grid.replaceChildren();
    for (const h of s.helpers) grid.append(card(h));
    if (lg.ok) { const pre = $("adminLog"); const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8; pre.textContent = (lg.body.lines || []).join("\n"); if (atEnd) pre.scrollTop = pre.scrollHeight; }
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function card(h) {
    const art = el("article", "admin-card" + (h.paused ? " paused" : "") + (h.hidden ? " hidden-helper" : ""));
    const head = el("div", "admin-card-head");
    const face = el("span", "face");
    if (window.Mascot) face.innerHTML = ["fudge", "crumb", "nib", "chip"].includes(h.name) ? window.Mascot.face(h.name) : window.Mascot.coin({ shape: "square" });
    const who = el("div");
    const title = el("h3", null, h.title);
    if (h.hidden) title.append(el("span", "badge", "hidden"));
    if (h.paused) title.append(el("span", "badge", "paused"));
    who.append(title, el("p", "role", h.role));
    head.append(face, who);
    const facts = el("dl", "admin-facts");
    const row = (k, v) => { const d = el("div"); d.append(el("dt", null, k), el("dd", null, v)); facts.append(d); };
    row("Model", h.model.replace(/^anthropic\//, ""));
    row("Today", `${money(h.spentTodayUsd)} of ${money(h.capUsd)}, ${h.callsToday} call${h.callsToday === 1 ? "" : "s"}`);
    row("Last", h.lastJob ? `${h.lastJob.job}${h.lastJob.ok ? "" : " (failed)"}, ${when(new Date(h.lastJob.at).toISOString())}: ${String(h.lastJob.note || "").slice(0, 70)}` : "nothing yet");
    for (const j of h.jobs) row(j.id.replace(h.name + "-", ""), `${j.daily ? "daily at " + j.daily.join(", ") : "every " + j.everyMinutes + " min"}, next ${upcoming(j.next)}, ran ${j.runs}`);
    const actions = el("div", "admin-row");
    const run = el("button", "btn sm", "Run now"); run.onclick = () => command({ helper: h.name, action: "run" });
    const toggle = el("button", "btn sm ghost", h.paused ? "Switch on" : "Pause"); toggle.onclick = () => command({ helper: h.name, action: h.paused ? "on" : "off" });
    const capBtn = el("button", "btn sm ghost", "Daily cap"); capBtn.onclick = () => { const v = prompt(`${h.title}'s daily cap in dollars`, String(h.capUsd)); if (v != null && v !== "") command({ helper: h.name, action: "cap", value: Number(v) }); };
    actions.append(run, toggle, capBtn);
    art.append(head, facts, actions);
    if (h.canAsk) {
      const ask = el("form", "admin-ask");
      const input = el("input"); input.placeholder = `Tell ${h.title} what to do`; input.setAttribute("aria-label", `An instruction for ${h.title}`);
      const send = el("button", "btn sm", "Send"); send.type = "submit";
      ask.append(input, send);
      ask.onsubmit = (ev) => { ev.preventDefault(); if (input.value.trim()) { command({ helper: h.name, action: "ask", text: input.value.trim() }); input.value = ""; } };
      art.append(ask);
    }
    return art;
  }

  async function command(c) {
    const r = await api("/command", { method: "POST", body: JSON.stringify(c) });
    if (!r.ok || !r.body?.ok) toast(r.body?.error || "The command failed.", "err");
    else toast(c.action === "run" ? "Started. Watch the log." : c.action === "ask" ? "Sent. The answer comes to your Telegram or the log." : r.body.note || "Done.");
    setTimeout(refresh, 800);
  }
  $("btnRefresh").onclick = refresh;
  $("btnSummary").onclick = () => command({ action: "summary" });

  if (!S.gateway) { loginError("This page needs the gateway address in config.js."); return; }
  if (token) { const st = await api("/state"); if (st.ok) { show(true); refresh(); timer = setInterval(refresh, 20_000); } else { token = null; show(false); } }
  else show(false);
})();
