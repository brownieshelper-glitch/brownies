/* Wallet connect for the app page: EIP-6963 discovery, a picker, an address chip with a menu, chain switching.
   Exposes window.BrowniesWallet = { init, connect, disconnect, ensureChain, state, onChange }.
   Elements it expects: connectBtn, walletChip, chipBtn, walletIcon, walletAddr, chipNet, walletMenu, menuCopy,
   menuExplorer, menuDisconnect, walletModal, walletModalClose, walletList, netWarn, switchBtn. */
(() => {
  const E = window.ethers;
  const $ = (id) => document.getElementById(id);
  const W = { provider: null, raw: null, info: null, signer: null, account: null, chain: null, chainId: null, wrongChain: false };
  const listeners = [];
  const emit = () => listeners.forEach((f) => { try { f(W); } catch (_) {} });
  const short = (a) => (a ? a.slice(0, 6) + "..." + a.slice(-4) : "");
  const explain = (e) => window.Brownies.explainError(e);
  const safeIcon = (u) => (typeof u === "string" && (u.startsWith("data:image/") || u.startsWith("https://")) ? u : "");

  const wallets = new Map();
  window.addEventListener("eip6963:announceProvider", (ev) => {
    const d = ev.detail; if (!d?.info?.rdns || !d.provider) return;
    if (!wallets.has(d.info.rdns)) { wallets.set(d.info.rdns, d); renderList(); }
  });
  try { window.dispatchEvent(new Event("eip6963:requestProvider")); } catch (_) {}
  const INSTALL = [["MetaMask", "https://metamask.io/download/"], ["Rabby", "https://rabby.io/"], ["Coinbase Wallet", "https://www.coinbase.com/wallet"]];
  function entries() {
    const list = [...wallets.values()];
    if (!list.length && window.ethereum) list.push({ info: { rdns: "injected", name: "Browser wallet", icon: "" }, provider: window.ethereum });
    return list;
  }
  function renderList() {
    const el = $("walletList"); if (!el) return;
    const list = entries();
    if (!list.length) {
      el.replaceChildren();
      const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = "No wallet found in this browser.";
      el.appendChild(empty);
      for (const [n, u] of INSTALL) {
        const a = document.createElement("a"); a.className = "wallet-item"; a.href = u; a.target = "_blank"; a.rel = "noopener";
        const ph = document.createElement("span"); ph.className = "ph";
        const name = document.createElement("span"); name.textContent = "Install " + n;
        const sub = document.createElement("span"); sub.className = "sub"; sub.textContent = "opens " + new URL(u).host;
        name.appendChild(sub); a.append(ph, name); el.appendChild(a);
      }
      return;
    }
    // built node by node: a wallet announces its own name and icon, so none of it may be read as HTML
    el.replaceChildren(...list.map((w) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "wallet-item";
      const icon = safeIcon(w.info.icon);
      if (icon) { const img = document.createElement("img"); img.src = icon; img.alt = ""; b.appendChild(img); }
      else { const ph = document.createElement("span"); ph.className = "ph"; b.appendChild(ph); }
      const name = document.createElement("span"); name.textContent = String(w.info.name || "Wallet").slice(0, 40);
      const sub = document.createElement("span"); sub.className = "sub"; sub.textContent = w.info.rdns === "injected" ? "browser wallet" : String(w.info.rdns).slice(0, 60);
      name.appendChild(sub); b.appendChild(name);
      b.onclick = () => connectWith(w);
      return b;
    }));
  }
  function openModal() { renderList(); const m = $("walletModal"); m.classList.remove("out"); m.hidden = false; }
  function closeModal() { const m = $("walletModal"); if (!m || m.hidden) return; m.classList.add("out"); setTimeout(() => { m.hidden = true; m.classList.remove("out"); }, 180); }
  function openMenu() { const m = $("walletMenu"); m.classList.remove("out"); m.hidden = false; $("chipBtn").setAttribute("aria-expanded", "true"); }
  function closeMenu() { const m = $("walletMenu"); if (!m || m.hidden) return; m.classList.add("out"); $("chipBtn").setAttribute("aria-expanded", "false"); setTimeout(() => { m.hidden = true; m.classList.remove("out"); }, 140); }

  let switching = false;
  async function ensureChain() {
    const net = await W.provider.getNetwork();
    if (Number(net.chainId) === W.chainId) { W.wrongChain = false; $("netWarn").hidden = true; return; }
    const hex = "0x" + W.chainId.toString(16);
    switching = true;
    try {
      try { await W.raw.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }); }
      catch (e) {
        if ((e.code === 4902 || /unrecognized|not added/i.test(e.message || "")) && W.chain.rpc) {
          await W.raw.request({ method: "wallet_addEthereumChain", params: [{ chainId: hex, chainName: W.chain.name, rpcUrls: [W.chain.rpc], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, blockExplorerUrls: W.chain.explorer ? [W.chain.explorer] : [] }] });
        } else throw e;
      }
      W.provider = new E.BrowserProvider(W.raw, "any");
      W.wrongChain = false; $("netWarn").hidden = true;
    } catch (e) { W.wrongChain = true; $("netWarn").hidden = false; throw new Error(`Please switch your wallet to ${W.chain.name}.`); }
    finally { setTimeout(() => { switching = false; }, 1500); }
  }
  async function connectWith(entry) {
    try {
      W.raw = entry.provider; W.info = entry.info;
      W.provider = new E.BrowserProvider(entry.provider, "any");
      await W.provider.send("eth_requestAccounts", []);
      listen(entry.provider);
      closeModal();
      await ensureChain();
      await finishConnect();
    } catch (e) { window.Brownies.toast(explain(e), "err"); }
  }
  async function finishConnect() {
    W.signer = await W.provider.getSigner();
    W.account = await W.signer.getAddress();
    try { if (W.info?.rdns) localStorage.setItem("brownies.wallet", W.info.rdns); } catch (_) {}
    closeModal(); setUI(true); emit();
  }
  const heard = new WeakSet();
  function listen(raw) {
    if (!raw || typeof raw.on !== "function" || heard.has(raw)) return;
    heard.add(raw);
    raw.on("accountsChanged", () => location.reload());
    raw.on("chainChanged", () => { if (!switching) location.reload(); });
  }
  async function autoReconnect() {
    let rdns = null; try { rdns = localStorage.getItem("brownies.wallet"); } catch (_) {}
    if (!rdns) return;
    await new Promise((r) => setTimeout(r, 350));
    const entry = entries().find((w) => w.info.rdns === rdns); if (!entry) return;
    try { const a = await entry.provider.request({ method: "eth_accounts" }); if (a && a.length) await connectWith(entry); } catch (_) {}
  }
  function disconnect() {
    try { localStorage.removeItem("brownies.wallet"); } catch (_) {}
    W.provider = W.raw = W.info = W.signer = W.account = null; W.wrongChain = false;
    closeMenu(); setUI(false); emit();
  }
  function setUI(on) {
    $("connectBtn").hidden = on; $("walletChip").hidden = !on;
    if (on) {
      $("walletAddr").textContent = short(W.account);
      const ic = $("walletIcon"), src = safeIcon(W.info?.icon); if (src) { ic.src = src; ic.hidden = false; } else ic.hidden = true;
      $("menuExplorer").href = W.chain.explorer ? `${W.chain.explorer}/address/${W.account}` : "#";
    }
  }
  function init(chainId, chain) {
    W.chainId = chainId; W.chain = chain;
    $("connectBtn").onclick = openModal;
    $("walletModalClose").onclick = closeModal;
    $("walletModal").addEventListener("click", (ev) => { if (ev.target === $("walletModal")) closeModal(); });
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { closeModal(); closeMenu(); } });
    $("chipBtn").onclick = (ev) => { ev.stopPropagation(); $("walletMenu").hidden ? openMenu() : closeMenu(); };
    document.addEventListener("click", (ev) => { if (!$("walletChip").contains(ev.target)) closeMenu(); });
    $("menuCopy").onclick = async () => { try { await navigator.clipboard.writeText(W.account); window.Brownies.toast("Address copied."); } catch (_) {} closeMenu(); };
    $("menuDisconnect").onclick = disconnect;
    $("switchBtn").onclick = async () => { try { if (!W.provider) return openModal(); await ensureChain(); await finishConnect(); } catch (e) { window.Brownies.toast(explain(e), "err"); } };
    setUI(false);
    autoReconnect();
  }
  window.BrowniesWallet = { init, connect: openModal, disconnect, ensureChain, state: W, onChange: (f) => listeners.push(f) };
})();
