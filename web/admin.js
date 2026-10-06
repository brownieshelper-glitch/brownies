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

  // on a local machine, ?demo=1 shows the room with sample figures and no server, for a look at the layout
  const demo = B.local && new URLSearchParams(location.search).get("demo") === "1" ? demoApi() : null;
  async function api(path, opts = {}) {
    if (demo) return demo(path, opts);
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
    const known = window.Mascot ? window.Mascot.team.find((m) => m.id === h.name) : null;
    if (window.Mascot) face.innerHTML = known ? window.Mascot.face(known) : window.Mascot.coin({ shape: "square" });
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

  /// Sample answers for ?demo=1 on a local machine: a logged-in room with made-up figures.
  function demoApi() {
    const t0 = Date.now();
    const job = (id, daily, every, next) => ({ id, daily, everyMinutes: every, next: new Date(t0 + next).toISOString(), runs: 3 });
    const state = {
      mode: "prelaunch", now: new Date(t0).toISOString(), timezone: "Europe/Rome", uptimeSeconds: 5 * 3600 + 12 * 60, reports: 23, thoughts: 41, videos: 4, group: "-1004498393263",
      helpers: [
        { name: "fudge", title: "Fudge", role: "marketing. Writes the posts for X and answers mentions that ask something", hidden: false, paused: true, model: "anthropic/claude-haiku-4.5", capUsd: 1.5, spentTodayUsd: 0.0057, callsToday: 2, lastJob: null, jobs: [job("fudge-post", [9, 13, 18], null, 3 * 3600e3), job("fudge-mentions", null, 20, 9 * 60e3)], canAsk: true },
        { name: "crumb", title: "Crumb", role: "community. Answers people on Telegram, in the group and in private", hidden: false, paused: false, model: "anthropic/claude-haiku-4.5", capUsd: 2, spentTodayUsd: 0.0182, callsToday: 6, lastJob: { at: t0 - 25 * 60e3, job: "reply", ok: true, note: "Answered 3 questions in the group" }, jobs: [job("crumb-flush", null, 5, 2 * 60e3), job("crumb-questions", [20], null, 5 * 3600e3)], canAsk: true },
        { name: "nib", title: "Nib", role: "research. Reads the gateway's figures, the site and the competitors", hidden: false, paused: false, model: "anthropic/claude-sonnet-5.5", capUsd: 1, spentTodayUsd: 0.0292, callsToday: 1, lastJob: { at: t0 - 7 * 3600e3, job: "research", ok: true, note: "Research note 2026-10-06" }, jobs: [job("nib-note", [8], null, 11 * 3600e3)], canAsk: true },
        { name: "chip", title: "Chip", role: "builder. Changes code in the repository as pull requests", hidden: false, paused: false, model: "anthropic/claude-sonnet-5.5", capUsd: 3, spentTodayUsd: 0.0171, callsToday: 5, lastJob: { at: t0 - 50 * 60e3, job: "build", ok: true, note: "Add notes/README.md" }, jobs: [job("chip-tasks", null, 30, 14 * 60e3)], canAsk: true },
        { name: "glaze", title: "Glaze", role: "business development. Prepares everything the team has to send", hidden: true, paused: false, model: "anthropic/claude-sonnet-5.5", capUsd: 1.5, spentTodayUsd: 0.0204, callsToday: 1, lastJob: { at: t0 - 3 * 3600e3, job: "deal", ok: true, note: "Draft 1: Ask Programmable to index BROWNIE" }, jobs: [job("glaze-task", [10], null, 13 * 3600e3)], canAsk: true },
      ],
      approvals: [{ id: 2, helper: "chip", title: "Add a FAQ page from the questions people ask", url: "https://github.com/brownieshelper-glitch/brownies/pull/3", at: new Date(t0 - 40 * 60e3).toISOString() }],
    };
    const lines = ["[helpers] running", "[crumb] answering in the group -1004498393263 \"Brownies\" from now on", "[chip] a pull request waits for the owner", "[glaze] deal: Draft 1: Ask Programmable to index BROWNIE", "[admin] login (code)"].map((l, i) => `${new Date(t0 - (5 - i) * 60e3).toISOString()} ${l}`);
    return async (path) => {
      if (path === "/state") return { ok: true, status: 200, body: state };
      if (path.startsWith("/log")) return { ok: true, status: 200, body: { lines } };
      if (path === "/login") return { ok: true, status: 200, body: { token: "d".repeat(64) } };
      return { ok: true, status: 200, body: { ok: true } };
    };
  }
  if (demo) { token = "demo"; show(true); refresh(); return; }

  if (!S.gateway) { loginError("This page needs the gateway address in config.js."); return; }
  if (token) { const st = await api("/state"); if (st.ok) { show(true); refresh(); timer = setInterval(refresh, 20_000); } else { token = null; show(false); } }
  else show(false);
})();
