/* Bake a brownie. The holder connects a wallet and signs one message for the Bakery (a nonce, nothing else); the
   Bakery says whether this wallet may bake and shows its brownie if it has one. The form makes one; the panel
   shows it, takes an instruction, feeds it (a grant on the holder's SUGAR, signed once as the gateway key) and
   retires it. The Bakery token lives in this tab's session; the gateway key only in memory. */
(async () => {
  const B = window.Brownies, K = window.Baked;
  const { load, toast, gw, keyMessage, keyFromSignature, explainError } = B;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const S = await load();
  const Wt = window.BrowniesWallet;
  Wt.init(S.cfg.chainId, { name: S.cfg.chainName, rpc: S.rpc, explorer: S.cfg.explorer });
  const account = () => Wt.state.account;
  const TOKEN_KEY = "brownies-bakery-token";

  const U = { token: null, wallet: null, info: null, mine: null, key: null, grant: null, busy: false };
  try { const raw = sessionStorage.getItem(TOKEN_KEY); if (raw) { const t = JSON.parse(raw); if (t.expiresAt > Date.now()) { U.token = t.token; U.wallet = t.wallet; } } } catch (_) {}
  // a call that hits a hiccup on the server (a deploy, a restart) is tried again a few times; never a bake or a login
  const api = async (path, opts = {}) => {
    for (let i = 0; ; i++) {
      const r = await K.api(S, path, { ...opts, token: U.token });
      const again = (r.status === 0 || r.status === 502 || r.status === 503 || r.status === 504) && path !== "/create" && path !== "/login" && i < 4;
      if (!again) return r;
      await new Promise((res) => setTimeout(res, 2500));
    }
  };
  const modelName = (id) => { const m = (U.info?.models || []).find((x) => x.id === id); return m ? m.name : String(id || "").split("/").pop(); };

  // ---- the rules ----
  const inf = await api("/info");
  U.info = inf.ok && inf.body ? inf.body : null;
  const live = Boolean(U.info && U.info.live);
  if (U.info) {
    $("zoneName").textContent = K.zoneName(U.info.timezone);
    const sel = $("inModel"); sel.replaceChildren();
    const groups = new Map();
    for (const m of U.info.models || []) {
      const item = typeof m === "string" ? { id: m, name: m.split("/").pop(), provider: m.split("/")[0], in: null, out: null } : m;
      if (!groups.has(item.provider)) { const g = el("optgroup"); g.label = item.provider; groups.set(item.provider, g); sel.append(g); }
      const o = el("option", null, item.in != null ? `${item.name} (in $${item.in} / out $${item.out} per M tokens)` : item.name);
      o.value = item.id; groups.get(item.provider).append(o);
    }
    $("inCap").value = String(U.info.defaultCapUsd ?? 1);
    $("inCap").max = String(U.info.maxCapUsd ?? 1);
    $("capHint").textContent = live
      ? `The most it may spend in a day, up to ${U.info.maxCapUsd} USD, paid from your SUGAR through the grant you set. It stops when the cap or the grant is reached.`
      : `Before the launch a trial brownie may spend up to ${U.info.maxCapUsd} USD a day from the team's budget. After the launch the cap goes up to ${U.info.liveMaxCapUsd ?? 50} USD a day, paid from your SUGAR.`;
    const hours = $("ownHour"); hours.replaceChildren();
    for (let h = 0; h < 24; h++) { const o = el("option", null, K.hourLabel(h)); o.value = String(h); if (h === 10) o.selected = true; hours.append(o); }
    const menu = $("jobMenu"); menu.replaceChildren();
    for (const j of U.info.menu || []) {
      const li = el("li", "job");
      const lab = el("label", "job-pick");
      const cb = el("input"); cb.type = "checkbox"; cb.value = j.id; cb.setAttribute("aria-label", j.title);
      const txt = el("span", "job-text");
      txt.append(el("b", null, j.title), el("span", null, j.text));
      lab.append(cb, txt);
      const hour = el("select", "job-hour"); hour.setAttribute("aria-label", `Hour for ${j.title}`);
      for (let h = 0; h < 24; h++) { const o = el("option", null, K.hourLabel(h)); o.value = String(h); if (h === (j.hours && j.hours[0])) o.selected = true; hour.append(o); }
      const where = el("span", "job-where mono", j.tool === "draft" ? "to Telegram" : "to its feed");
      li.append(lab, hour, where);
      menu.append(li);
    }
  }

  // ---- the gate ----
  const sign = $("btnSignIn");
  function gateHint(text) { const h = $("gateHint"); h.textContent = text || ""; h.hidden = !text; }
  function paintGate() {
    const on = Boolean(account()) && !Wt.state.wrongChain;
    sign.disabled = !on || !U.info;
    sign.textContent = !U.info ? "The Bakery is closed right now" : on ? "Sign in to the Bakery" : "Connect a wallet first";
  }
  Wt.onChange(() => {
    if (U.token && U.wallet && account() && account().toLowerCase() !== U.wallet.toLowerCase()) signOut(false);
    paintGate();
    if (U.token && account()) refresh();
  });
  sign.onclick = async () => {
    if (!account()) return;
    sign.disabled = true; sign.classList.add("busy"); sign.textContent = "Sign in your wallet";
    try {
      const n = await api("/nonce");
      if (!n.ok) throw new Error("The Bakery did not answer.");
      const signature = await Wt.state.signer.signMessage(n.body.message.replace("<nonce>", n.body.nonce));
      const r = await api("/login", { method: "POST", body: { address: account(), signature, nonce: n.body.nonce } });
      if (!r.ok) throw new Error(r.body?.error || "Could not sign in.");
      U.token = r.body.token; U.wallet = r.body.wallet;
      try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token: U.token, wallet: U.wallet, expiresAt: r.body.expiresAt })); } catch (_) {}
      gateHint("");
      await refresh();
    } catch (e) { gateHint(explainError(e)); }
    finally { sign.classList.remove("busy"); paintGate(); }
  };
  function signOut(tell = true) {
    if (U.token) api("/logout", { method: "POST" });
    U.token = null; U.wallet = null; U.mine = null; U.key = null; U.grant = null;
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (_) {}
    show("gate");
    if (tell) toast("Signed out.");
  }
  $("btnSignOut").onclick = () => signOut();

  function show(which) {
    $("gate").hidden = which !== "gate";
    $("mine").hidden = which !== "mine";
    $("formWrap").hidden = which !== "form";
  }

  // ---- the holder's state ----
  async function refresh() {
    const r = await api("/mine");
    if (r.status === 401) { signOut(false); gateHint("Your session ended. Sign in again."); return; }
    if (!r.ok) { toast(r.body?.error || "The Bakery did not answer.", "err"); return; }
    U.mine = r.body;
    if (U.mine.brownies && U.mine.brownies.length) { paintMine(U.mine.brownies[0]); show("mine"); }
    else { paintForm(); show("form"); }
  }

  function paintForm() {
    const st = $("bakeStatus");
    const hold = U.mine.hold != null ? `${Math.floor(Number(U.mine.hold)).toLocaleString("en-US")} BROWNIE` : "";
    $("bakeWho").textContent = B.short(U.mine.wallet || U.wallet || "");
    if (U.mine.canBake) {
      st.textContent = U.mine.trial ? "This wallet is on the admin list. This bake is a trial before the launch." : `This wallet holds ${hold}. You can bake.`;
      st.className = "bake-status ok";
      $("bakeForm").hidden = false;
    } else {
      const why = K.cap(U.mine.why || "the Bakery is closed for now");
      st.textContent = `${why}.${hold ? ` This wallet holds ${hold}.` : ""}${/opens with the launch/.test(why) ? " Until then only the admin wallet can bake, as a trial." : ""}`;
      st.className = "bake-status";
      $("bakeForm").hidden = true;
    }
  }
  $("btnSwitch").onclick = () => { signOut(false); gateHint("Connect the other wallet, top right, then sign in again."); };

  // ---- baking ----
  $("bakeForm").onsubmit = async (ev) => {
    ev.preventDefault();
    if (U.busy) return;
    const name = $("inName").value.trim();
    if (!/^[a-zA-Z][a-zA-Z0-9]{2,15}$/.test(name)) return toast("The name is 3 to 16 letters or digits, starting with a letter.", "err");
    const role = $("inRole").value.trim();
    if (role.length < 12) return toast("Say what it does for you, in one sentence.", "err");
    const tasks = [];
    for (const li of $("jobMenu").querySelectorAll("li.job")) {
      const cb = li.querySelector("input[type=checkbox]");
      if (cb.checked) tasks.push({ menu: cb.value, hours: [Number(li.querySelector("select.job-hour").value)] });
    }
    const ownTitle = $("ownTitle").value.trim(), ownText = $("ownText").value.trim();
    if (ownTitle || ownText) {
      if (ownTitle.length < 2 || ownText.length < 12) return toast("Your own job needs a title and a sentence of instructions.", "err");
      tasks.push({ title: ownTitle, text: ownText, tool: $("ownTool").value, hours: [Number($("ownHour").value)] });
    }
    if (!tasks.length) return toast("Pick at least one job.", "err");
    if (tasks.length > 3) return toast("Three jobs at most.", "err");
    const body = { name, role, personality: $("inPersonality").value.trim(), model: $("inModel").value, dailyCapUsd: Number($("inCap").value) || undefined, tasks };
    const btn = $("btnBake");
    U.busy = true; btn.disabled = true; btn.classList.add("busy"); btn.textContent = "Baking";
    try {
      const r = await api("/create", { method: "POST", body });
      if (!r.ok) throw new Error(r.body?.error || "Could not bake it.");
      toast(`${r.body.title} is baked. Its first job runs at the hour you picked.`);
      $("bakeForm").reset();
      await refresh();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) { toast(explainError(e), "err"); }
    finally { U.busy = false; btn.disabled = false; btn.classList.remove("busy"); btn.textContent = "Bake"; }
  };

  // ---- the holder's brownie ----
  let shown = null;
  function paintMine(b) {
    shown = b;
    $("mineFace").innerHTML = K.face(b.name);
    $("mineName").textContent = b.title || K.cap(b.name);
    $("mineRole").textContent = b.role ? K.cap(b.role) : "";
    $("minePersonality").textContent = b.personality ? `${K.cap(b.personality)}.` : "";
    const jobs = $("mineJobs"); jobs.replaceChildren();
    for (const t of b.tasks || []) jobs.append(el("li", null, `${K.jobLine(t)}, ${t.tool === "draft" ? "to Telegram" : "to its feed"}`));
    const facts = $("mineFacts"); facts.replaceChildren();
    const row = (k, v) => { const d = el("div"); d.append(el("dt", null, k), el("dd", null, v)); facts.append(d); };
    row("Baked", b.since ? K.when(b.since) : "");
    row("Jobs done", String(b.outputs || 0));
    row("Spent today", `${Number(b.spentTodayUsd || 0).toFixed(4)} USD of ${Number(b.capUsd || 0).toFixed(2)}`);
    row("Model", modelName(b.model));
    if (b.wallet) row("Its wallet", B.short(b.wallet));
    row("Telegram", b.telegram ? "linked, drafts and answers go there" : "not linked yet");
    $("btnLink").hidden = Boolean(b.telegram); $("btnUnlink").hidden = !b.telegram;
    if (b.telegram) { $("linkHint").hidden = true; $("linkOpen").hidden = true; $("btnLink").textContent = "Link Telegram"; stopLinkPoll(); }
    // feed it
    const text = $("fundText"), fundBtn = $("btnFund"), revoke = $("btnRevoke"), ff = $("fundFacts");
    if (!live || !b.wallet) {
      text.textContent = !live ? "Before the launch your brownie runs on a small trial budget from the team. Funding with your own SUGAR opens with the launch." : "Your brownie has no wallet yet. Try again in a minute.";
      fundBtn.hidden = true; revoke.hidden = true; ff.hidden = true;
    } else {
      text.textContent = `Your brownie pays for its thinking from your SUGAR, through a grant of up to ${Number(b.capUsd).toFixed(2)} USD a day. You sign once with your wallet; the grant is set on the gateway and you can stop it here any time.`;
      fundBtn.hidden = false; fundBtn.textContent = U.key ? "Set the grant" : "Sign once and set the grant";
      revoke.hidden = !U.grant; ff.hidden = !U.grant;
      if (U.grant) paintGrant();
    }
    // ask
    const left = Number(b.asksLeft ?? 0);
    $("inAsk").disabled = left <= 0; $("btnAsk").disabled = left <= 0;
    $("askHint").textContent = left > 0 ? `${left} ${left === 1 ? "instruction" : "instructions"} left today. The answer lands in its feed in a minute or two.` : "No instructions left today. More tomorrow.";
    // feed
    const feed = $("mineFeed"); feed.replaceChildren();
    const list = Array.isArray(b.feed) ? b.feed : [];
    $("mineFeedEmpty").hidden = list.length > 0;
    if (!list.length) { const hours = [...new Set((b.tasks || []).flatMap((t) => t.hours || []))].sort((x, y) => x - y); $("mineFeedEmpty").textContent = hours.length ? `Nothing yet. It works at ${hours.map(K.hourLabel).join(" and ")}.` : "Nothing yet."; }
    for (const e of list) {
      const li = el("li");
      const face = el("span", "face"); face.innerHTML = K.face(b.name);
      const box = el("div");
      box.append(el("p", "meta", `${e.title || "Work"}, ${B.ago(Number(e.at))}${e.kind === "draft" ? ", a draft" : ""}`));
      box.append(el("p", "what", String(e.text || "")));
      li.append(face, box); feed.append(li);
    }
  }
  function paintGrant() {
    const ff = $("fundFacts"); ff.replaceChildren();
    const row = (k, v) => { const d = el("div"); d.append(el("dt", null, k), el("dd", null, v)); ff.append(d); };
    row("Grant", `${Number(U.grant.daily_usd).toFixed(2)} USD a day`);
    row("Left today", `${Number(U.grant.room_today_usd).toFixed(4)} USD`);
    row("Spent today", `${Number(U.grant.spent_today_usd).toFixed(4)} USD`);
    ff.hidden = false; $("btnRevoke").hidden = false;
    $("fundHint").textContent = "The grant is live. Your brownie works at its hours."; $("fundHint").hidden = false;
  }

  async function ensureKey() {
    if (U.key) return U.key;
    const r = await gw(S, `/api/protocol/account/${account()}`);
    const epoch = Number(r.body?.epoch || 0);
    const sig = await Wt.state.signer.signMessage(keyMessage(S.cfg.chainId, epoch));
    U.key = keyFromSignature(sig, epoch);
    return U.key;
  }
  async function readGrant(b) {
    if (K.demo) { U.grant = window.__bakeDemo.grant; return; }
    const r = await gw(S, "/v1/grants", { headers: { authorization: `Bearer ${U.key}` } });
    if (!r.ok) throw new Error(r.body?.error?.message || "The gateway did not answer.");
    U.grant = (r.body.given || []).find((g) => g.grantee && b.wallet && g.grantee.toLowerCase() === b.wallet.toLowerCase()) || null;
  }
  $("btnFund").onclick = async () => {
    const b = shown; if (!b || (!account() && !K.demo)) return;
    const btn = $("btnFund");
    btn.disabled = true; btn.classList.add("busy"); btn.textContent = U.key ? "Setting the grant" : "Sign in your wallet";
    try {
      if (!K.demo) await ensureKey();
      await readGrant(b);
      if (!U.grant || Number(U.grant.daily_usd) !== Number(b.capUsd)) {
        if (K.demo) U.grant = await K.demoGrant("set", b.capUsd);
        else {
          const r = await gw(S, "/v1/grants", { method: "POST", headers: { authorization: `Bearer ${U.key}`, "content-type": "application/json" }, body: JSON.stringify({ grantee: b.wallet, daily_usd: b.capUsd }) });
          if (!r.ok) throw new Error(r.body?.error?.message || "The gateway refused the grant.");
          await readGrant(b);
        }
        toast(`${b.title} is fed: up to ${Number(b.capUsd).toFixed(2)} USD a day from your SUGAR.`);
      }
      paintGrant();
      btn.textContent = "Grant set";
    } catch (e) { toast(explainError(e), "err"); btn.textContent = U.key ? "Set the grant" : "Sign once and set the grant"; }
    finally { btn.disabled = false; btn.classList.remove("busy"); }
  };
  $("btnRevoke").onclick = async () => {
    const b = shown; if (!b) return;
    if (!confirm(`Stop feeding ${b.title}? It keeps its jobs but cannot think until you set a grant again.`)) return;
    try {
      if (K.demo) await K.demoGrant("revoke");
      else {
        await ensureKey();
        const r = await gw(S, "/v1/grants/revoke", { method: "POST", headers: { authorization: `Bearer ${U.key}`, "content-type": "application/json" }, body: JSON.stringify({ grantee: b.wallet }) });
        if (!r.ok) throw new Error(r.body?.error?.message || "The gateway did not answer.");
      }
      U.grant = null;
      $("fundFacts").hidden = true; $("btnRevoke").hidden = true; $("fundHint").hidden = true; $("btnFund").textContent = "Set the grant";
      toast(`${b.title} is no longer fed.`);
    } catch (e) { toast(explainError(e), "err"); }
  };

  // Telegram: a code from the Bakery, sent to the bot as /link <code>; the page looks again every few seconds until linked
  let linkTimer = null;
  function stopLinkPoll() { if (linkTimer) { clearInterval(linkTimer); linkTimer = null; } }
  $("btnLink").onclick = async () => {
    const b = shown; if (!b) return;
    const r = await api("/link", { method: "POST", body: { name: b.name } });
    if (!r.ok) return toast(r.body?.error || "Could not make a code.", "err");
    const h = $("linkHint"), open = $("linkOpen");
    if (r.body.url) { open.href = r.body.url; open.hidden = false; }
    h.textContent = r.body.url
      ? `Press Open Telegram, then Start in the chat: the code goes to the bot by itself. Or send ${r.body.bot} this message yourself: /link ${r.body.code}. It works for ten minutes.`
      : `Open ${r.body.bot} on Telegram and send it this message within ten minutes: /link ${r.body.code}`;
    h.hidden = false;
    $("btnLink").textContent = "New code";
    stopLinkPoll();
    let tries = 0;
    linkTimer = setInterval(async () => { tries++; if (tries > 120 || $("mine").hidden) return stopLinkPoll(); await refresh(); }, 5000);
  };
  $("btnUnlink").onclick = async () => {
    const b = shown; if (!b) return;
    const r = await api("/unlink", { method: "POST", body: { name: b.name } });
    if (!r.ok) return toast(r.body?.error || "Could not unlink.", "err");
    toast("Telegram unlinked. Drafts stay in its feed.");
    await refresh();
  };

  $("askForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const b = shown, text = $("inAsk").value.trim();
    if (!b || text.length < 4) return toast("Write what you want it to do.", "err");
    const r = await api("/ask", { method: "POST", body: { name: b.name, text } });
    if (!r.ok) return toast(r.body?.error || "It could not take that.", "err");
    $("inAsk").value = "";
    toast(`${b.title} is on it. The result lands in its feed.`);
    // the brownie thinks in the background: look again soon, then a little later, then after a minute
    for (const ms of [2000, 15_000, 60_000]) setTimeout(() => { if (!$("mine").hidden) refresh(); }, ms);
    await refresh();
  };
  $("btnRetire").onclick = async () => {
    const b = shown; if (!b) return;
    if (!confirm(`Retire ${b.title}? Its jobs stop and it leaves the shelf. You can bake another one.`)) return;
    const r = await api("/retire", { method: "POST", body: { name: b.name } });
    if (!r.ok) return toast(r.body?.error || "Could not retire it.", "err");
    toast(`${b.title} retired.`);
    U.grant = null;
    await refresh();
  };

  // ---- start ----
  paintGate();
  if (K.demo) { U.token = "demo"; U.wallet = "0x8e45bA3c0dFc0F9A6B2d2b4E5C1a7F0b9D3e2C11"; sign.disabled = true; await refresh(); return; }
  if (!U.info) { show("gate"); gateHint("The Bakery is not reachable right now. Try again in a minute."); return; }
  if (U.token) await refresh(); else show("gate");
})();
