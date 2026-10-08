/* Shared by every page: the deployment, a read provider that survives the public RPC, the contracts, number
   formatting, plain error sentences, toasts and one helper that walks a button through a transaction.
   Read only except Brownies.tx, which sends through the visitor's own wallet. */
(() => {
  const E = window.ethers;
  const CFG = window.BROWNIES_CONFIG;
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  const q = new URLSearchParams(location.search);
  // overrides exist only on a local machine, for rehearsals against a fork: ?rpc= ?gw= ?dep=
  const over = (k) => (local ? q.get(k) : null);

  const ABI = {
    erc20: [
      "function balanceOf(address) view returns (uint256)",
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
      "function symbol() view returns (string)",
      "function totalSupply() view returns (uint256)",
    ],
    staking: [
      "function stakeOf(address) view returns (uint256)",
      "function earned(address) view returns (uint256)",
      "function totalStaked() view returns (uint256)",
      "function MIN_POSITION() view returns (uint256)",
      "function rewardRate() view returns (uint256)",
      "function periodFinish() view returns (uint256)",
      "function totalFunded() view returns (uint256)",
      "function totalMinted() view returns (uint256)",
      "function unstreamed() view returns (uint256)",
      "function boostOf(address) view returns (uint256 earnedBps, uint256 appliedBps)",
      "function startOf(address) view returns (uint256)",
      "function poke(address)",
      "function stake(uint256)",
      "function unstake(uint256)",
      "function claim() returns (uint256)",
      "function exit() returns (uint256)",
      "error BelowMinimumPosition(uint256 position, uint256 minimum)",
      "error NothingToClaim()",
      "error ZeroAmount()",
    ],
    sugar: [
      "function balanceOf(address) view returns (uint256)",
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
      "function totalSupply() view returns (uint256)",
      "function totalActivated() view returns (uint256)",
      "function activate(uint256) returns (uint256)",
      "error ZeroAmount()",
    ],
    minter: [
      "function mint(address to, uint256 usdcAtoms) returns (uint256)",
      "function mintAndActivate(uint256 usdcAtoms, bytes32 beneficiary) returns (uint256)",
      "function totalMinted() view returns (uint256)",
      "error ZeroAmount()",
    ],
    vault: [
      "function dailyBudget() view returns (uint256)",
      "function lastRelease() view returns (uint256)",
      "function helperCount() view returns (uint256)",
      "function helper(uint256) view returns (string name, bytes32 key, uint32 weight, bool active)",
      "function releasedTo(uint256) view returns (uint256)",
      "function tippedTo(uint256) view returns (uint256)",
      "function totalReleased() view returns (uint256)",
      "function release() returns (uint256)",
      "function tip(uint256 id, uint256 amount)",
      "error TooEarly(uint256 nextRelease)",
      "error NothingToRelease()",
      "error BadHelper()",
    ],
    harvester: [
      "function claim()",
      "function pendingRest() view returns (uint256)",
      "function mainOwed() view returns (uint256)",
      "function totalMainPaid() view returns (uint256)",
      "function totalStakersFunded() view returns (uint256)",
      "function totalTeamFunded() view returns (uint256)",
      "function MIN_SWAP() view returns (uint256)",
      "function programOn() view returns (bool)",
      "error NeedMoreGas(uint256 have, uint256 need)",
      "error OutsideBand(uint256 out, uint256 expected)",
      "error NoTwap()",
    ],
    registry: [
      "function count() view returns (uint256)",
      "function skill(uint256) view returns (tuple(address author, uint64 createdAt, uint64 closesAt, bool paid, bool vetoed, uint256 ask, uint256 yes, uint256 no, uint256 paidAmount, uint256 quorumWeight, string uri))",
      "function voted(uint256, address) view returns (bool)",
      "function maxPay() view returns (uint256)",
      "function MIN_STAKE_AGE() view returns (uint256)",
      "function submit(string uri, uint256 ask) returns (uint256)",
      "function vote(uint256 id, bool support)",
      "function finalize(uint256 id)",
      "error NotStaker()",
      "error StakeTooYoung()",
      "error AlreadyVoted()",
      "error AlreadyOpen(uint256 id)",
      "error VotingClosed()",
      "error VotingOpen()",
      "error AlreadyDone()",
      "error NothingToPay()",
      "error BadUri()",
    ],
  };

  // A public RPC answers a burst of reads with a 429 that browsers report as a CORS failure, so a
  // read simply throws. Reads are safe to repeat: three more tries, 0.8, 1.6 and 3.2 seconds apart.
  function readProvider(url, chainId) {
    const p = new E.JsonRpcProvider(url, chainId, { staticNetwork: true, cacheTimeout: -1 });
    const send = p._send.bind(p);
    p._send = async (payload) => {
      for (let i = 0; ; i++) {
        try { return await send(payload); }
        catch (e) { if (i >= 3) throw e; await new Promise((r) => setTimeout(r, 800 * 2 ** i + Math.random() * 400)); }
      }
    };
    return p;
  }

  let loaded = null;
  /// The deployment and its read contracts. `live` is false when there is no deployment file to read.
  function load() {
    if (loaded) return loaded;
    loaded = (async () => {
      const name = over("dep") || String(CFG.chainId);
      let d = null;
      try { const r = await fetch(`deployments/${name}.json`, { cache: "no-store" }); if (r.ok) d = await r.json(); } catch (_) {}
      const rpc = over("rpc") || CFG.rpc;
      const gateway = String(over("gw") || (d && d.gateway) || CFG.gateway || "").replace(/\/+$/, "");
      const provider = readProvider(rpc, CFG.chainId);
      const S = { cfg: CFG, d, rpc, gateway, provider, live: false, abi: ABI };
      if (d && E.isAddress(d.sugar) && E.isAddress(d.staking) && E.isAddress(d.token)) {
        S.live = true;
        S.token = new E.Contract(d.token, ABI.erc20, provider);
        S.staking = new E.Contract(d.staking, ABI.staking, provider);
        S.sugar = new E.Contract(d.sugar, ABI.sugar, provider);
        S.minter = new E.Contract(d.minter, ABI.minter, provider);
        S.harvester = new E.Contract(d.harvester, ABI.harvester, provider);
        S.usdc = new E.Contract(CFG.usdc, ABI.erc20, provider);
        if (E.isAddress(d.teamVault)) S.vault = new E.Contract(d.teamVault, ABI.vault, provider);
        if (E.isAddress(d.skillRegistry)) S.registry = new E.Contract(d.skillRegistry, ABI.registry, provider);
      }
      return S;
    })();
    return loaded;
  }

  /* ---------- numbers ---------- */
  const group = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  /// A token amount as text: `maxFrac` decimals at most, trailing zeros dropped, thousands grouped.
  function amount(v, decimals, maxFrac = 2) {
    if (v == null) return "";
    const s = E.formatUnits(v, decimals);
    let [i, f = ""] = s.split(".");
    f = f.slice(0, maxFrac).replace(/0+$/, "");
    return group(i) + (f ? "." + f : "");
  }
  const coin = (v, frac = 0) => amount(v, 18, frac);
  /// A holding of BROWNIE: whole coins once it is a thousand or more, two decimals below that.
  const coinHeld = (v) => (v == null ? "" : amount(v, 18, v >= 1000n * 10n ** 18n ? 0 : 2));
  /// SUGAR and USDC have 6 decimals; one atom is one millionth of a dollar.
  const sugar = (v, frac = 4) => amount(v, 6, frac);
  /// Dollars from 6 decimal atoms, always with two decimals: $41.30, never $41.3.
  const usd = (v) => { if (v == null) return ""; const cents = v / 10000n; return "$" + group((cents / 100n).toString()) + "." + (cents % 100n).toString().padStart(2, "0"); };
  const eth = (v, frac = 5) => amount(v, 18, frac);
  /// A dollar figure the gateway sent as text ("2.999999"): two decimals at least, six at most, so that even a
  /// charge of one millionth of a dollar shows.
  function dollars(text, maxFrac = 6) {
    const n = Number(text);
    if (!Number.isFinite(n)) return "";
    // cut, never round up: a balance must not read higher than it is
    let s = n.toFixed(6);
    s = s.slice(0, s.length - (6 - maxFrac)).replace(/0+$/, "");
    const dec = s.split(".")[1] || "";
    if (dec.length < 2) s = n.toFixed(2);
    const [i, f] = s.split(".");
    return "$" + group(i) + "." + f;
  }
  const short = (a) => (a ? a.slice(0, 6) + "..." + a.slice(-4) : "");
  /// What the visitor typed, as a BigInt of `decimals`, or null when it is not a positive number.
  function parse(text, decimals) {
    const t = String(text || "").replace(/,/g, "").trim();
    if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
    try { const v = E.parseUnits(t, decimals); return v > 0n ? v : null; } catch (_) { return null; }
  }

  /* ---------- errors, as one plain sentence ---------- */
  function explainError(e) {
    const m = String(e?.shortMessage || e?.reason || e?.message || "");
    const name = e?.revert?.name || "";
    if (e?.code === "ACTION_REJECTED" || e?.code === 4001 || /user (rejected|denied)/i.test(m)) return "You cancelled it in the wallet.";
    if (e?.code === "SLOW") return "The chain is slow to confirm this. Check your wallet's activity in a minute.";
    if (m === "reverted") return "The chain refused it. Nothing was spent except gas.";
    if (name === "BelowMinimumPosition") return "A stake must be at least " + coin(e.revert.args[1]) + " BROWNIE.";
    if (name === "StakeTooYoung") return "Your stake must be unchanged for a day first. Coins you added less than a day before the proposal cannot vote.";
    if (name === "NotStaker") return "You need a stake of at least the smallest stake to do this.";
    if (name === "AlreadyVoted") return "You already voted on this skill.";
    if (name === "AlreadyOpen") return "You already have an open proposal. Wait until it is settled.";
    if (name === "VotingClosed") return "The vote on this skill is closed.";
    if (name === "VotingOpen") return "The vote is still open. Come back when it closes.";
    if (name === "AlreadyDone") return "This skill is already settled.";
    if (name === "NothingToPay") return "The vault cannot pay this now. Try again when it holds SUGAR.";
    if (name === "BadHelper") return "That brownie is not on the payroll.";
    if (name === "NothingToClaim") return "There is nothing to claim yet.";
    if (name === "TooEarly") return "Today's budget was already released. Try again tomorrow.";
    if (name === "NothingToRelease") return "There is nothing to release yet.";
    if (name === "ZeroAmount") return "Type an amount first.";
    if (name === "NeedMoreGas") return "The wallet gave this too little gas. Try again.";
    if (name === "OutsideBand" || name === "NoTwap") return "The ETH price moved too fast for the swap. Try again in a minute.";
    if (/insufficient funds/i.test(m)) return "There is not enough ETH in the wallet for the gas.";
    if (/transfer amount exceeds balance|exceeds balance/i.test(m)) return "The wallet does not hold that much.";
    if (/switch your wallet/i.test(m)) return m;
    if (/network|fetch|timeout|failed to fetch/i.test(m)) return "The chain did not answer. Try again.";
    return "It did not go through. Try again.";
  }

  /* ---------- toasts ---------- */
  function toast(msg, kind = "", txUrl = null) {
    const host = document.getElementById("toasts"); if (!host) return;
    const el = document.createElement("div"); el.className = "toast " + kind; el.setAttribute("role", "status");
    el.textContent = String(msg ?? "");
    if (txUrl && /^https?:/i.test(String(txUrl))) {
      const a = document.createElement("a"); a.href = txUrl; a.target = "_blank"; a.rel = "noopener"; a.textContent = "view on the explorer";
      el.append(document.createElement("br"), a);
    }
    host.appendChild(el);
    setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 230); }, kind === "err" ? 11000 : 6500);
  }

  /// Walk a button through one transaction. `send` returns the sent transaction; the button keeps its own words
  /// when it is done. Returns the receipt, or null when it failed (the reason is toasted).
  /// Wait for a transaction by asking our own read provider for its receipt. A wallet's own wait() needs one more
  /// block to arrive before it answers and depends on the wallet's RPC; this depends on neither.
  async function waitReceipt(hash) {
    const S = await load();
    for (let i = 0; i < 150; i++) {
      try { const r = await S.provider.getTransactionReceipt(hash); if (r) return r; } catch (_) {}
      await new Promise((r) => setTimeout(r, i < 12 ? 600 : 1500));
    }
    const e = new Error("still pending"); e.code = "SLOW"; throw e;
  }

  async function tx(btn, send, done, explorer) {
    const label = btn.textContent;
    btn.disabled = true; btn.classList.add("busy");
    try {
      btn.textContent = "Confirm in your wallet";
      const t = await send();
      btn.textContent = "Sending";
      const r = await waitReceipt(t.hash);
      if (!r || r.status !== 1) throw new Error("reverted");
      toast(done, "", explorer ? `${explorer}/tx/${r.hash}` : null);
      return r;
    } catch (e) {
      toast(explainError(e), "err");
      return null;
    } finally {
      btn.textContent = label; btn.classList.remove("busy"); btn.disabled = false;
    }
  }

  /// The gateway, when the site knows where it is. Every call resolves to { ok, status, body }.
  async function gw(S, path, opts = {}) {
    if (!S.gateway) return { ok: false, status: 0, body: null };
    try {
      const r = await fetch(S.gateway + path, opts);
      let body = null; try { body = await r.json(); } catch (_) {}
      return { ok: r.ok, status: r.status, body };
    } catch (_) { return { ok: false, status: 0, body: null }; }
  }

  /// "3 hours ago" for a time in milliseconds
  function ago(at, now = Date.now()) {
    const s = Math.max(0, Math.round((now - at) / 1000));
    if (s < 60) return "just now";
    const say = (n, unit) => n + " " + unit + (n === 1 ? "" : "s") + " ago";
    if (s < 3600) return say(Math.floor(s / 60), "minute");
    if (s < 86400) return say(Math.floor(s / 3600), "hour");
    return say(Math.floor(s / 86400), "day");
  }
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  /// "5 Oct 2026" for a time in milliseconds (UTC)
  const day = (at) => { const d = new Date(at); return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear(); };

  const keyMessage = (chainId, epoch) => `Brownies API key, chain ${chainId}, epoch ${epoch}`;
  function keyFromSignature(sig, epoch) {
    const hex = sig.replace(/^0x/, "");
    let bin = ""; for (let i = 0; i < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return `sk-brownie-${epoch}-` + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  const beneficiary = (wallet) => E.zeroPadValue(wallet, 32);

  window.Brownies = { load, ABI, amount, coin, coinHeld, sugar, usd, eth, dollars, short, parse, explainError, toast, tx, gw, ago, day, keyMessage, keyFromSignature, beneficiary, local };
})();
