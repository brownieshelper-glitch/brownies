/* The chat page: a wallet signs once, the signature is the gateway key, and the page talks to any model through
   POST /v1/chat/completions with streaming. The balance comes from GET /v1/key after every answer. Nothing leaves
   the tab but the request to the gateway; the conversation is not stored anywhere. Before the launch the gateway
   answers 503 not_launched and the page says so. */
(async () => {
  const B = window.Brownies;
  const { load, toast, gw, keyMessage, keyFromSignature, explainError } = B;
  const $ = (id) => document.getElementById(id);
  const S = await load();
  const Wt = window.BrowniesWallet;
  Wt.init(S.cfg.chainId, { name: S.cfg.chainName, rpc: S.rpc, explorer: S.cfg.explorer });
  const account = () => Wt.state.account;

  const U = { key: null, epoch: 0, balance: null, spentMicro: 0, model: "", busy: false, history: [] };
  const log = $("chatLog"), input = $("chatInput"), send = $("btnChatSend"), keyBtn = $("btnChatKey"), sel = $("chatModel");
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const money = (n) => `$${Number(n || 0).toFixed(4)}`;

  // the gateway: when it answers 503 not_launched the page is closed
  let open = Boolean(S.gateway);
  if (open) {
    const h = await gw(S, "/health");
    open = Boolean(h.ok && h.body && h.body.live);
  }
  if (!open) { $("chatClosed").hidden = false; keyBtn.textContent = "Not open yet"; }

  function setReady(on) {
    const can = on && Boolean(U.key) && open;
    input.disabled = !can; send.disabled = !can || U.busy; sel.disabled = !can;
  }
  function paintBalance() {
    $("chatBalance").hidden = U.balance == null;
    $("chatBal").textContent = U.balance == null ? "" : money(U.balance);
    $("chatSpent").textContent = money(U.spentMicro / 1e6);
  }

  async function readBalance() {
    const r = await gw(S, "/v1/key", { headers: { authorization: `Bearer ${U.key}` } });
    if (r.status === 401) { U.key = null; setReady(Boolean(account())); toast("Your key was replaced. Sign again.", "err"); return; }
    if (r.ok && r.body?.balance) { U.balance = Number(r.body.balance.available || 0); paintBalance(); }
  }

  async function loadModels() {
    const r = await gw(S, "/v1/models");
    if (!r.ok || !Array.isArray(r.body?.data)) return;
    const list = r.body.data.filter((m) => !m.architecture || !m.architecture.output_modalities || m.architecture.output_modalities.includes("text"));
    sel.replaceChildren();
    const prefer = ["anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-5.5", "openai/gpt-5-mini", "google/gemini-2.5-flash"];
    list.sort((a, b) => (prefer.indexOf(b.id) >= 0 ? 1 : 0) - (prefer.indexOf(a.id) >= 0 ? 1 : 0) || a.id.localeCompare(b.id));
    for (const m of list) {
      const o = el("option", null, `${m.id}${m.pricing ? `  (in $${(Number(m.pricing.prompt) * 1e6).toFixed(2)} / out $${(Number(m.pricing.completion) * 1e6).toFixed(2)} per M tokens)` : ""}`);
      o.value = m.id; sel.append(o);
    }
    U.model = prefer.find((p) => list.some((m) => m.id === p)) || list[0]?.id || "";
    if (U.model) sel.value = U.model;
  }
  sel.onchange = () => { U.model = sel.value; };

  async function makeKey() {
    const r = await gw(S, `/api/protocol/account/${account()}`);
    U.epoch = Number(r.body?.epoch || 0);
    const sig = await Wt.state.signer.signMessage(keyMessage(S.cfg.chainId, U.epoch));
    U.key = keyFromSignature(sig, U.epoch);
  }

  keyBtn.onclick = async () => {
    if (!account() || !open) return;
    const label = "Sign in your wallet";
    keyBtn.disabled = true; keyBtn.classList.add("busy"); keyBtn.textContent = label;
    try {
      await makeKey();
      await Promise.all([readBalance(), loadModels()]);
      keyBtn.textContent = "Signed. Key ready";
      $("chatKeyHint").textContent = U.balance != null && U.balance < 0.01 ? "Your balance is empty. Activate SUGAR in the app, then come back." : "Your key is in this tab only. Close the tab and it is gone.";
      setReady(true);
      input.focus();
    } catch (e) { toast(explainError(e), "err"); keyBtn.textContent = "Sign to get your key"; }
    finally { keyBtn.classList.remove("busy"); keyBtn.disabled = !account(); }
  };

  Wt.onChange(() => {
    U.key = null; U.balance = null; paintBalance();
    const on = Boolean(account()) && !Wt.state.wrongChain;
    keyBtn.disabled = !on || !open;
    keyBtn.textContent = !open ? "Not open yet" : on ? "Sign to get your key" : "Connect a wallet first";
    setReady(on);
  });

  function bubble(role, text) {
    const li = el("li", `msg ${role}`);
    if (role === "you") li.append(el("span", "who", "You"));
    else { const f = el("span", "who face"); if (window.Mascot) f.innerHTML = window.Mascot.face("crumb"); li.append(f); }
    const p = el("p", "text", text);
    li.append(p);
    log.append(li);
    $("chatEmpty").hidden = true;
    li.scrollIntoView({ block: "end" });
    return p;
  }

  $("chatForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text || !U.key || U.busy) return;
    if (!U.model) return toast("Pick a model first.", "err");
    input.value = "";
    U.busy = true; setReady(true);
    bubble("you", text);
    U.history.push({ role: "user", content: text });
    const out = bubble("bot", "");
    out.classList.add("typing");
    let full = "";
    try {
      const res = await fetch(`${S.gateway}/v1/chat/completions`, {
        method: "POST", headers: { authorization: `Bearer ${U.key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: U.model, messages: U.history.slice(-20), max_tokens: 1200, stream: true }),
      });
      if (!res.ok) {
        let j = null; try { j = await res.json(); } catch (_) {}
        const code = j?.error?.code || "";
        const why = res.status === 402 || code === "insufficient_balance" ? "Your balance is empty. Activate SUGAR in the app and come back."
          : res.status === 401 ? "Your key was refused. Sign again." : res.status === 503 ? "The gateway is not open yet." : (j?.error?.message || `The gateway answered ${res.status}.`);
        if (res.status === 401) { U.key = null; setReady(Boolean(account())); }
        throw new Error(why);
      }
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n"); buf = parts.pop();
        for (const line of parts) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const data = t.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const j = JSON.parse(data);
            const piece = j.choices?.[0]?.delta?.content || "";
            if (piece) { full += piece; out.textContent = full; log.lastElementChild.scrollIntoView({ block: "end" }); }
            if (j.usage?.cost != null) U.spentMicro += Math.round(Number(j.usage.cost) * 1e6);
          } catch (_) { /* a partial line */ }
        }
      }
      if (!full) out.textContent = "(the model sent nothing back)";
      U.history.push({ role: "assistant", content: full });
    } catch (e) {
      out.textContent = e.message || String(e);
      out.parentElement.classList.add("err");
      U.history.pop();
    } finally {
      out.classList.remove("typing");
      U.busy = false; setReady(Boolean(account()));
      paintBalance();
      if (U.key) readBalance();
      input.focus();
    }
  };

  $("btnChatClear").onclick = () => { U.history = []; log.replaceChildren(); $("chatEmpty").hidden = false; input.focus(); };
  input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("chatForm").requestSubmit(); } };
  paintBalance();
})();
