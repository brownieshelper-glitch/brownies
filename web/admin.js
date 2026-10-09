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
  const money = (n) => { n = Number(n || 0); return "$" + (n === 0 || n >= 0.0095 ? n.toFixed(2) : n.toFixed(4)); };
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
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
    bill(s.costs);
    shopView(s.shop);
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
    const sg = $("suggestions"); sg.replaceChildren();
    const sugg = s.suggestions || [];
    const sRow = (g) => {
      const li = el("li"); const box = el("div");
      const m = el("p", "meta", `${g.place === "x" ? "X" : "Telegram"}${g.who ? ", @" + g.who : ""}, ${when(g.at)}${g.state !== "new" ? ", " + g.state : ""}`);
      for (const f of g.flags || []) m.append(" ", el("span", "flag", f));
      box.append(m, el("p", "what", g.text));
      if (g.note) box.append(el("p", "meta", `Your note: ${g.note}`));
      const acts = el("div", "admin-row");
      if (g.state !== "listen") { const yes = el("button", "btn sm", "Listen"); yes.onclick = () => command({ action: "suggest", id: g.id, value: "listen" }); acts.append(yes); }
      if (g.state !== "ignore") { const no = el("button", "btn sm ghost", "Ignore"); no.onclick = () => command({ action: "suggest", id: g.id, value: "ignore" }); acts.append(no); }
      box.append(acts); li.append(box); return li;
    };
    for (const g of sugg.filter((x) => x.state === "new")) sg.append(sRow(g));
    const decidedS = sugg.filter((x) => x.state !== "new");
    if (decidedS.length) { const li = el("li"); const d = el("details"); d.append(el("summary", null, `${decidedS.length} decided`)); const ul = el("ul", "admin-approvals"); for (const g of decidedS) ul.append(sRow(g)); d.append(ul); li.append(d); sg.append(li); }
    $("suggestionsEmpty").hidden = sugg.length > 0;
    const jobs = s.jobs || { totals: {}, list: [] };
    const jt = jobs.totals || {};
    $("jobsTotals").textContent = `${jt.found || 0} found and not picked, ${jt.open || 0} in progress, ${jt.won || 0} won, ${jt.paid || 0} paid, ${money(jt.earnedUsd)} earned. The public page: jobs.html`;
    const jl = $("jobsList"); jl.replaceChildren();
    const DONE = ["won", "paid", "lost", "dropped"];
    const ORDER = ["waiting_owner", "working", "submitted", "preparing", "picked", "found", "won", "paid", "lost", "dropped"];
    const list = [...(jobs.list || [])].sort((x, y) => ORDER.indexOf(x.state) - ORDER.indexOf(y.state) || y.updatedAt - x.updatedAt);
    for (const j of list.filter((x) => !DONE.includes(x.state))) jl.append(jobRow(j));
    const done = list.filter((x) => DONE.includes(x.state));
    if (done.length) { const li = el("li"); const d = el("details"); d.append(el("summary", null, `${done.length} finished (won, paid, lost or dropped)`)); const ul = el("ul", "admin-approvals"); for (const j of done) ul.append(jobRow(j)); d.append(ul); li.append(d); jl.append(li); }
    $("jobsEmpty").hidden = list.length > 0;
    const grid = $("agents"); grid.replaceChildren();
    for (const h of s.helpers) grid.append(card(h));
    if (lg.ok) { const pre = $("adminLog"); const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8; pre.textContent = (lg.body.lines || []).join("\n"); if (atEnd) pre.scrollTop = pre.scrollHeight; }
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // ---- the shop: open or not, the sales, the last orders ----
  function shopView(v) {
    const hint = $("shopHint"), list = $("shopOrders");
    list.replaceChildren();
    if (!v) { hint.textContent = "The shop is not built on this server."; $("shopEmpty").hidden = true; return; }
    const shortAddr = (a) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "nobody");
    hint.textContent = (v.open ? `Open. Payments land in ${v.payTo}. ` : `Closed: ${v.reason}. `) + `The settler ${v.settler ? shortAddr(v.settler) : "is not set"}${v.gasEth != null ? ` holds ${v.gasEth.toFixed(5)} ETH for gas` : ""}. Today ${plural(v.today.n, "order")}, ${money(v.today.usd)} in, ${money(v.today.costUsd)} spent making them. This month ${plural(v.month.n, "order")}, ${money(v.month.usd)} in. Prices: ${v.items.map((i) => `${i.id} ${money(i.usd)}`).join(", ")}.`;
    for (const o of v.orders) {
      const li = el("li"); const box = el("div");
      const m = el("p", "meta", `#${o.id} ${o.item}, ${money(o.usd)} from ${shortAddr(o.payer)}, ${when(new Date(o.at).toISOString())}`);
      m.append(" ", el("span", "badge" + (o.state === "failed" ? " hot" : ""), o.state));
      box.append(m, el("p", "what", o.prompt));
      if (o.note) box.append(el("p", "role", o.note));
      const row = el("div", "admin-row");
      if (o.url) { const a = el("a", "link", "Open the file"); a.href = o.url; a.target = "_blank"; a.rel = "noopener"; row.append(a); }
      if (o.tx) { const t = el("a", "link", "The payment"); t.href = `https://basescan.org/tx/${o.tx}`; t.target = "_blank"; t.rel = "noopener"; row.append(t); }
      if (o.costUsd) row.append(el("span", "meta", `cost ${money(o.costUsd)}`));
      if (row.childNodes.length) box.append(row);
      li.append(box); list.append(li);
    }
    $("shopEmpty").hidden = v.orders.length > 0;
  }

  // ---- the bill: every brownie's AI and video spend against its caps, the history, the balances ----
  const shortModel = (m) => String(m || "").replace(/^[^/]+\//, "");
  const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const dateShort = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const monthName = (key) => new Date(`${key}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
  const face = (name, cls) => { const f = el("span", cls); const known = window.Mascot ? window.Mascot.team.find((m) => m.id === name) : null; if (window.Mascot) f.innerHTML = known ? window.Mascot.face(known) : window.Mascot.coin({ shape: "square" }); return f; };
  function bar(pct, state, { none = false, label = "" } = {}) {
    const b = el("div", "bill-bar" + (state && state !== "ok" ? " " + state : "") + (none ? " none" : ""));
    const i = el("i"); i.style.setProperty("--p", String(none ? 0 : Math.max(0, Math.min(100, pct)) / 100)); b.append(i);
    b.setAttribute("role", "img"); b.setAttribute("aria-label", label || (none ? "no cap" : `${pct}% of the cap`));
    return b;
  }
  function askCap(h, video) {
    const v = prompt(video ? `${h.title}'s video cap in dollars a day (0 removes it)` : `${h.title}'s daily cap in dollars`, String(video ? h.videoCapUsd || 0 : h.capUsd));
    if (v != null && v !== "") command({ helper: h.name, action: video ? "videocap" : "cap", value: Number(v) });
  }
  function billRow(h) {
    const row = el("div", "bill-row" + (h.paused ? " paused" : ""));
    row.append(face(h.name, "face"));
    const who = el("div", "who");
    who.append(el("b", null, h.title));
    if (h.hidden) who.append(el("span", "badge", "hidden"));
    if (h.paused) who.append(el("span", "badge", "paused"));
    if (h.gone) who.append(el("span", "badge", "gone"));
    if (h.state === "capped") who.append(el("span", "badge hot", "capped"));
    else if (h.state === "near") who.append(el("span", "badge hot", "near the cap"));
    who.append(el("span", "meta", `${plural(h.calls, "call")}${h.calls ? `, ${money(h.avgUsd)} a call` : ""}${h.model ? `, ${shortModel(h.model)}` : ""}`));
    row.append(who);
    const nums = el("div", "nums");
    nums.append(document.createTextNode(h.capUsd ? `${money(h.aiUsd)} of ${money(h.capUsd)}` : money(h.aiUsd)));
    nums.append(el("small", null, h.capUsd ? `${money(h.leftUsd)} left today` : "no cap"));
    row.append(nums);
    const track = el("div", "track");
    track.append(bar(h.pct, h.state, { none: !h.capUsd }), el("span", "pct", h.capUsd ? `${h.pct}%` : ""));
    if (!h.gone) { const b = el("button", "btn sm ghost", "Cap"); b.onclick = () => askCap(h, false); track.append(b); }
    row.append(track);
    if (h.makesVideo) {
      const sub = el("div", "sub");
      const text = `Video: ${money(h.videoUsd)}${h.videoCapUsd ? ` of ${money(h.videoCapUsd)}` : ", no cap"}, ${plural(h.videos, "clip")}${h.seconds ? `, ${h.seconds} s` : ""}${h.videoGuessed ? ` (${h.videoGuessed} priced from our table)` : ""}`;
      sub.append(el("span", null, text), bar(h.videoPct, h.videoState, { none: !h.videoCapUsd, label: h.videoCapUsd ? `${h.videoPct}% of the video cap` : "no video cap" }));
      if (!h.gone) { const b = el("button", "btn sm ghost", "Video cap"); b.onclick = () => askCap(h, true); sub.append(b); }
      row.append(sub);
    }
    return row;
  }
  function bill(c) {
    const box = $("bill");
    if (!c) { box.hidden = true; return; }
    box.hidden = false;
    const tiles = $("billTiles"); tiles.replaceChildren();
    const tile = (k, v, sub, action) => { const d = el("div", "bill-tile"); d.append(el("span", "k", k), el("span", "v", v)); if (sub) d.append(el("span", "sub", sub)); if (action) { const r = el("div", "admin-row"); r.append(action); d.append(r); } tiles.append(d); };
    tile("Today", money(c.today.usd), `AI ${money(c.today.aiUsd)} in ${plural(c.today.calls, "call")}, video ${money(c.today.videoUsd)} in ${plural(c.today.videos, "clip")}. The caps add up to ${money(c.today.capUsd)}.`);
    tile("This month", money(c.month.usd), `AI ${money(c.month.aiUsd)}, video ${money(c.month.videoUsd)}, since ${monthName(c.month.since)}.`);
    tile("OpenRouter", c.openrouter ? `${money(c.openrouter.leftUsd)} left` : "not read", c.openrouter ? `Of ${money(c.openrouter.boughtUsd)} bought, ${money(c.openrouter.usedUsd)} used in all.` : "The balance could not be read from OpenRouter.");
    const setBal = el("button", "btn sm ghost", c.higgsfield ? "New balance" : "Set the balance");
    setBal.onclick = () => { const v = prompt("The Higgsfield balance in dollars, as its page shows it (0 stops the count)", c.higgsfield ? String(c.higgsfield.leftUsd) : ""); if (v != null && v !== "") command({ action: "refill", value: Number(v) }); };
    tile("Higgsfield", c.higgsfield ? `about ${money(c.higgsfield.leftUsd)} left` : "not counted", c.higgsfield ? `${money(c.higgsfield.spentUsd)} in ${plural(c.higgsfield.clips, "clip")} since the ${money(c.higgsfield.refillUsd)} you set on ${dateShort(c.higgsfield.refillAt)}.` : "Higgsfield has no balance call. Tell the room your balance after a top-up and the clips count down from it.", setBal);
    const rows = $("billRows"); rows.replaceChildren();
    for (const h of c.helpers) rows.append(billRow(h));
    // the last 14 days: AI below, video on top, the amount over today and over the biggest day
    const chart = $("billChart"); chart.replaceChildren();
    const max = Math.max(0, ...c.history.map((d) => d.usd));
    const biggest = c.history.reduce((m, d) => (d.usd > (m?.usd || 0) ? d : m), null);
    for (const d of c.history) {
      const col = el("div", "bill-col" + (d.day === c.day ? " today" : ""));
      col.title = `${d.day}: ${money(d.usd)} (AI ${money(d.aiUsd)} in ${plural(d.calls, "call")}, video ${money(d.videoUsd)} in ${plural(d.videos, "clip")})`;
      const stack = el("div", "stack");
      const v = el("i", "v"), a = el("i", "a");
      v.style.height = max ? `${(100 * d.videoUsd) / max}%` : "0"; a.style.height = max ? `${(100 * d.aiUsd) / max}%` : "0";
      if (!d.videoUsd) v.style.border = "0"; if (!d.aiUsd) a.style.border = "0";
      stack.append(v, a);
      if (d.day === c.day || (biggest && d.day === biggest.day && d.usd > 0)) col.append(el("span", "amt", money(d.usd)));
      col.append(stack, el("span", "d", String(Number(d.day.slice(8)))));
      chart.append(col);
    }
    const models = $("billModels"); models.replaceChildren();
    const top = c.models[0]?.usd || 0;
    for (const m of c.models.slice(0, 8)) {
      const li = el("li");
      li.append(el("span", "name", shortModel(m.model)), el("span", "num", `${money(m.usd)}, ${plural(m.calls, "call")}`), bar(top ? Math.round((100 * m.usd) / top) : 0, "ok", { label: `${money(m.usd)} of today's ${money(c.today.aiUsd)} on AI` }));
      models.append(li);
    }
    $("billModelsEmpty").hidden = c.models.length > 0;
    const table = $("billRecent"); table.replaceChildren();
    const head = el("tr");
    for (const [t, cls] of [["When", ""], ["Brownie", ""], ["Job", ""], ["Model", ""], ["Tokens in / out", "num"], ["Cost", "num"], ["Note", ""]]) head.append(el("th", cls, t));
    table.append(head);
    for (const r of c.recent) {
      const tr = el("tr");
      tr.append(el("td", null, `${dateShort(r.at)} ${hhmm(r.at)}`), el("td", null, r.title), el("td", null, r.kind === "video" ? `video, ${r.seconds} s` : r.job), el("td", null, shortModel(r.model)), el("td", "num", r.kind === "video" ? "" : `${r.tokensIn} / ${r.tokensOut}${r.tokensThink ? ` (${r.tokensThink} thinking)` : ""}`), el("td", "num", money(r.usd) + (r.guessed ? " (our table)" : "")), el("td", "note", r.note || ""));
      table.append(tr);
    }
    if (!c.recent.length) { const tr = el("tr"); const td = el("td", "note", "No paid call on the ledger yet."); td.colSpan = 7; tr.append(td); table.append(tr); }
  }

  const usd = (n) => "$" + Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
  function jobRow(j) {
    const li = el("li", "admin-job");
    const box = el("div");
    const meta = el("p", "meta");
    const parts = [j.kind, j.stateLabel || j.state];
    if (j.helper) parts.push(cap(j.helper));
    if (j.score) parts.push(`fit ${j.score}`);
    if (j.expectedUsd) parts.push(`up to ${usd(j.expectedUsd)}`);
    if (j.earnedUsd) parts.push(`${usd(j.earnedUsd)} earned`);
    if (j.deadline) parts.push(`by ${j.deadline}`);
    meta.append(el("b", null, `#${j.id}`), document.createTextNode(` ${parts.join(", ")}, ${when(new Date(j.updatedAt).toISOString())}`));
    box.append(meta, el("p", "what", j.title));
    if (j.summary) box.append(el("p", "role", j.summary));
    if (j.nextStep) box.append(el("p", "role", `Next: ${j.nextStep}`));
    if (j.ownerAction) box.append(el("p", "what", `You: ${j.ownerAction}`));
    if (j.url) { const l = el("a", "link", "Open the page"); l.href = j.url; l.target = "_blank"; l.rel = "noopener nofollow"; box.append(l); }
    if (j.draft && j.draft.text) { const d = el("details"); d.append(el("summary", null, `The draft by ${cap(j.draft.by || "a brownie")}, ready to copy`)); const pre = el("pre", "admin-log"); pre.textContent = j.draft.text; d.append(pre); box.append(d); }
    const acts = el("div", "admin-row");
    const act = (label, value, ask = null, ghost = true) => { const b = el("button", "btn sm" + (ghost ? " ghost" : ""), label); b.onclick = () => { let text = ""; if (ask) { text = prompt(ask) || ""; if (!text.trim()) return; } command({ action: "job", id: j.id, value, text }); }; acts.append(b); };
    if (j.state === "found") act("Pick", "pick", null, false);
    if (["picked", "preparing", "waiting_owner"].includes(j.state)) act("Submitted", "submit", null, false);
    if (["picked", "preparing", "waiting_owner", "submitted"].includes(j.state)) act("In progress", "start");
    if (["submitted", "working", "waiting_owner", "picked", "preparing"].includes(j.state)) { act("Won", "won", "How much did it win, in dollars? (leave empty if unknown)"); act("Lost", "lost"); }
    if (["won", "working", "submitted"].includes(j.state)) act("Paid", "paid", "How much was paid, in dollars?");
    if (!["dropped", "paid", "lost"].includes(j.state)) act("Drop", "drop");
    act("Note", "note", "A note for the log");
    box.append(acts); li.append(box);
    return li;
  }

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
    if (h.recruit) title.append(el("span", "badge", "recruit"));
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
    if (h.recruit) {
      if (h.why) row("Hired for", h.why);
      for (const t of h.tasks || []) row("task", `${t.title} (${t.tool})`);
      const retire = el("button", "btn sm ghost", "Retire"); retire.onclick = () => { if (confirm(`Retire ${h.title}? Its jobs stop. The service restarts in a moment.`)) command({ helper: h.name, action: "retire" }); };
      actions.append(retire);
    }
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
      jobs: { totals: { found: 1, open: 1, won: 0, paid: 1, earnedUsd: 4500, expectedOpenUsd: 25000 }, list: [
        { id: 1, kind: "grant", state: "waiting_owner", stateLabel: "waiting for the owner", title: "Example Builder Grants, round 3", url: "https://example.org/1", helper: "glaze", score: 82, expectedUsd: 5000, deadline: "2026-10-31", summary: "Open-source Ethereum tooling fits the round.", nextStep: "Fill the form.", ownerAction: "Send what Glaze prepared; it is in your Telegram.", updatedAt: t0 - 20 * 60e3 },
        { id: 3, kind: "bounty", state: "found", stateLabel: "found", title: "Audit contest X", url: "https://example.org/3", score: 70, expectedUsd: 20000, deadline: "2026-10-20", summary: "Solidity contest, two weeks.", nextStep: "Register before the start.", updatedAt: t0 - 3 * 3600e3 },
        { id: 5, kind: "grant", state: "paid", stateLabel: "paid", title: "Small tooling grant", url: "https://example.org/5", helper: "glaze", score: 75, expectedUsd: 4500, earnedUsd: 4500, summary: "Paid for the open-source gateway.", updatedAt: t0 - 2 * 86400e3 },
      ] },
    };
    // the bill with made-up figures: one brownie near its cap, one capped, Sprinkle with two clips and a video cap
    const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
    const row = (name, title, o) => ({ name, title, gone: false, hidden: false, paused: false, model: "anthropic/claude-sonnet-5.5", capUsd: 31.5, aiUsd: 0, calls: 0, pct: 0, leftUsd: 31.5, state: "ok", tokensIn: 0, tokensOut: 0, tokensThink: 0, avgUsd: 0, biggestUsd: 0, makesVideo: false, videoUsd: 0, videos: 0, seconds: 0, videoCapUsd: null, videoPct: 0, videoState: "ok", videoGuessed: 0, totalUsd: 0, models: [], jobs: [], ...o });
    const costs = {
      day: dayKey(t0), timezone: "Europe/Rome",
      today: { usd: 9.86, aiUsd: 0.62, videoUsd: 9.24, calls: 41, videos: 2, seconds: 20, tokensIn: 180_000, tokensOut: 22_000, tokensThink: 1_400, capUsd: 157.5, videoGuessed: 1 },
      month: { since: dayKey(t0).slice(0, 8) + "01", usd: 61.4, aiUsd: 7.9, videoUsd: 53.5, calls: 380, videos: 12 },
      history: Array.from({ length: 14 }, (_, i) => { const ai = [0.3, 0.5, 0.4, 0.9, 0.6, 0.7, 0.2, 0.8, 0.5, 0.6, 0.4, 0.9, 0.7, 0.62][i], video = [0, 4.6, 0, 9.2, 4.6, 0, 0, 4.6, 9.2, 0, 4.6, 0, 4.6, 9.24][i]; return { day: dayKey(t0 - (13 - i) * 86400e3), aiUsd: ai, videoUsd: video, usd: ai + video, calls: Math.round(ai * 60), videos: Math.round(video / 4.6) }; }),
      helpers: [
        row("fudge", "Fudge", { model: "anthropic/claude-haiku-4.5", capUsd: 1.5, aiUsd: 1.26, calls: 14, pct: 84, leftUsd: 0.24, state: "near", avgUsd: 0.09, tokensIn: 40_000, models: [{ model: "anthropic/claude-haiku-4.5", usd: 1.26, calls: 14 }], jobs: [{ job: "post", usd: 0.9, calls: 5 }, { job: "mentions", usd: 0.36, calls: 9 }] }),
        row("crumb", "Crumb", { model: "anthropic/claude-haiku-4.5", capUsd: 2, aiUsd: 0.18, calls: 6, pct: 9, leftUsd: 1.82, avgUsd: 0.03 }),
        row("nib", "Nib", { capUsd: 1, aiUsd: 1, calls: 3, pct: 100, leftUsd: 0, state: "capped", avgUsd: 0.33 }),
        row("chip", "Chip", { capUsd: 3, aiUsd: 0.17, calls: 5, pct: 6, leftUsd: 2.83, avgUsd: 0.034, paused: true }),
        row("sprinkle", "Sprinkle", { hidden: true, model: "anthropic/claude-opus-5.5", capUsd: 31, aiUsd: 0.21, calls: 3, pct: 1, leftUsd: 30.79, avgUsd: 0.07, makesVideo: true, videoUsd: 9.24, videos: 2, seconds: 20, videoCapUsd: 20, videoPct: 46, videoGuessed: 1 }),
      ],
      models: [{ model: "anthropic/claude-haiku-4.5", usd: 1.44, calls: 20, tokensIn: 60_000, tokensOut: 8_000 }, { model: "anthropic/claude-sonnet-5.5", usd: 1.17, calls: 8, tokensIn: 80_000, tokensOut: 9_000 }, { model: "anthropic/claude-opus-5.5", usd: 0.21, calls: 3, tokensIn: 40_000, tokensOut: 5_000 }],
      recent: [
        { id: 3, at: t0 - 4 * 60e3, helper: "sprinkle", title: "Sprinkle", kind: "video", model: "bytedance/seedance-2.5/text-to-video", job: "clip", usd: 4.62, tokensIn: 0, tokensOut: 0, tokensThink: 0, seconds: 10, guessed: false, ms: 0, note: "Clip 12: Trend: Pumpkin Head Illusion" },
        { id: 2, at: t0 - 6 * 60e3, helper: "sprinkle", title: "Sprinkle", kind: "ai", model: "anthropic/claude-opus-5.5", job: "clip", usd: 0.0712, tokensIn: 9_800, tokensOut: 620, tokensThink: 0, seconds: 0, guessed: false, ms: 5200, note: null },
        { id: 1, at: t0 - 25 * 60e3, helper: "crumb", title: "Crumb", kind: "ai", model: "anthropic/claude-haiku-4.5", job: "flush", usd: 0.0031, tokensIn: 2_100, tokensOut: 140, tokensThink: 0, seconds: 0, guessed: false, ms: 900, note: null },
      ],
      biggest: [],
      openrouter: { boughtUsd: 60, usedUsd: 10.43, leftUsd: 49.57, usageDailyUsd: 2.39, limitUsd: 100, limitLeftUsd: 89.57 },
      higgsfield: { refillUsd: 100, refillAt: t0 - 2 * 86400e3, spentUsd: 32.34, leftUsd: 67.66, clips: 7 },
    };
    state.costs = costs;
    state.shop = { open: true, reason: "", payTo: "0x2c769cDE285eb0d3c7130F9F0f14932106384095", settler: "0x1111111111111111111111111111111111111111", gasEth: 0.00098, network: "eip155:8453", items: [{ id: "note", usd: 1 }, { id: "meme", usd: 0.5 }, { id: "clip", usd: 9 }], today: { n: 2, usd: 9.5, costUsd: 4.63 }, month: { n: 11, usd: 38.5, costUsd: 19.2 }, orders: [
      { id: 12, at: t0 - 9 * 60e3, item: "clip", state: "making", usd: 9, costUsd: 0, payer: "0xabcdef1234567890abcdef1234567890abcdef12", tx: "0x" + "1".repeat(64), url: null, note: null, prompt: "The four brownies land on the moon and plant a flag with a pancake on it." },
      { id: 11, at: t0 - 50 * 60e3, item: "meme", state: "done", usd: 0.5, costUsd: 0.01, payer: "0x1234567890abcdef1234567890abcdef12345678", tx: "0x" + "2".repeat(64), url: "https://api.feedthebrownies.com/shop/files/order-11-aa.png", note: null, prompt: "Crumb explaining rollups to a confused robot." },
      { id: 10, at: t0 - 3 * 3600e3, item: "clip", state: "failed", usd: 9, costUsd: 0.07, payer: "0x1234567890abcdef1234567890abcdef12345678", tx: "0x" + "3".repeat(64), url: null, note: "Higgsfield moderated the request (nsfw): nothing was made", prompt: "A scene the model would not film." },
    ] };
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
