/* The app page: stake and unstake BROWNIE, claim and activate SUGAR, show and replace the API key, buy SUGAR
   at par, try the key, and collect the tax for the protocol. Every number is read from the contracts or the
   gateway; nothing is shown that was not read. */
(async () => {
  const E = window.ethers;
  const { load, coin, coinHeld, sugar, usd, eth, dollars, parse, toast, tx, gw, keyMessage, keyFromSignature, beneficiary, explainError } = window.Brownies;
  const B = window.Brownies;
  const $ = (id) => document.getElementById(id);
  const S = await load();
  const Wt = window.BrowniesWallet;
  Wt.init(S.cfg.chainId, { name: S.cfg.chainName, rpc: S.rpc, explorer: S.cfg.explorer });
  const EXP = S.cfg.explorer;

  const U = { wallet: 0n, staked: 0n, earned: 0n, sugar: 0n, usdc: 0n, min: 0n, epoch: 0, balanceMicro: null, key: null };
  const actionBtns = ["btnStake", "btnUnstake", "btnPoke", "btnClaim", "btnActivate", "btnKey", "btnRotate", "btnBuyAct", "btnBuy", "btnSend", "btnCollect", "btnTip", "btnSubmitSkill"];
  const set = (id, text) => { const el = $(id); if (el) el.textContent = text ?? ""; };
  const account = () => Wt.state.account;
  const signerOf = (c) => c.connect(Wt.state.signer);

  if (S.live) {
    $("buyLink").href = S.cfg.gmgn + S.d.token;
    $("buyHint").hidden = false;
  }
  if (S.gateway) $("tryPanel").hidden = false;
  Wt.onChange(() => { U.key = null; $("keyWrap").hidden = true; refresh(); });

  /* ---------- reading ---------- */
  // Reads can overlap (the timer, a finished transaction, a returning tab). Each read takes a number and only the
  // newest one may write to the page, so an older, slower read can never put stale numbers back.
  let seqProtocol = 0, seqUser = 0;

  async function readProtocol() {
    if (!S.live) return;
    const my = ++seqProtocol;
    try {
      const [staked, rate, finish, minted, activated, pending, min, block] = await Promise.all([
        S.staking.totalStaked(), S.staking.rewardRate(), S.staking.periodFinish(), S.staking.totalMinted(),
        S.sugar.totalActivated(), S.harvester.pendingRest(), S.staking.MIN_POSITION(),
        S.provider.getBlock("latest"),
      ]);
      if (my !== seqProtocol) return;
      // the chain's own clock, not this computer's: ages and the stream are measured in block time
      const now = Number(block.timestamp);
      U.chainNow = now;
      U.min = min;
      const perHour = Number(finish) > now ? (rate * 3600n) / 10n ** 18n : 0n;
      set("pStaked", coin(staked) + " BROWNIE");
      set("pStream", sugar(perHour, 2) + " SUGAR");
      set("pPaid", usd(minted));
      set("pBought", usd(activated));
      set("pPending", eth(pending) + " ETH");
      set("vMin", coin(min) + " BROWNIE");
    } catch (_) { /* could not read: the numbers stay as they were */ }
    if (S.vault) {
      try {
        const [inVault, budget] = await Promise.all([S.sugar.balanceOf(S.d.teamVault), S.vault.dailyBudget()]);
        if (my !== seqProtocol) return;
        set("pVault", sugar(inVault, 2) + " SUGAR");
        set("pTeam", sugar(budget, 2) + " SUGAR");
      } catch (_) {}
    }
  }

  async function readUser() {
    const a = account();
    if (!S.live || !a) { for (const id of ["vWallet", "vStaked", "vEarned", "vSugar", "vUsdc", "vBalance", "vSpent", "vBoost"]) set(id, ""); $("boostHint").hidden = true; $("btnPoke").hidden = true; return; }
    const my = ++seqUser;
    try {
      const [w, st, er, sp, ug, boost, start] = await Promise.all([
        S.token.balanceOf(a), S.staking.stakeOf(a), S.staking.earned(a), S.sugar.balanceOf(a), S.usdc.balanceOf(a),
        S.staking.boostOf(a), S.staking.startOf(a),
      ]);
      if (my !== seqUser) return;
      Object.assign(U, { wallet: w, staked: st, earned: er, sugar: sp, usdc: ug });
      set("vWallet", coinHeld(w)); set("vStaked", coinHeld(st));
      set("vEarned", sugar(er, 4)); set("vSugar", sugar(sp, 4)); set("vUsdc", sugar(ug, 2));
      showBoost(st, boost[0], boost[1], start);
    } catch (_) {}
    const r = await gw(S, `/api/protocol/account/${a}`);
    if (my !== seqUser) return;
    if (r.ok && r.body) {
      U.epoch = Number(r.body.epoch || 0);
      set("vBalance", dollars(r.body.balance.available, 4));
      set("vSpent", dollars(r.body.balance.used));
    } else { set("vBalance", ""); set("vSpent", ""); }
  }

  /// The loyalty bonus: what the stake's age has earned, what the weight uses, and what comes next.
  const TIERS = [[30, 10], [90, 20], [180, 30]]; // days, percent
  function showBoost(staked, earnedBps, appliedBps, start) {
    const hint = $("boostHint"), poke = $("btnPoke");
    if (staked === 0n) { set("vBoost", ""); hint.hidden = true; poke.hidden = true; return; }
    const pct = (bps) => (Number(bps) - 10000) / 100;
    const now = U.chainNow || Math.floor(Date.now() / 1000);
    const days = Math.max(0, Math.floor((now - Number(start)) / 86400));
    set("vBoost", pct(appliedBps) > 0 ? "+" + pct(appliedBps) + "%" : "none yet");
    const next = TIERS.find(([d]) => d > days);
    let text = "Your stake is " + days + (days === 1 ? " day old." : " days old.");
    if (next) text += " It earns " + next[1] + "% more from day " + next[0] + ".";
    else text += " It has the full bonus.";
    if (earnedBps > appliedBps) text = "Your bonus grew to +" + pct(earnedBps) + "%. Apply it, or claim and it applies itself.";
    hint.textContent = text; hint.hidden = false;
    poke.hidden = !(earnedBps > appliedBps);
  }

  function gate() {
    const on = S.live && !!account() && !Wt.state.wrongChain;
    for (const id of actionBtns) { const b = $(id); if (b && !b.classList.contains("busy")) b.disabled = !on; }
    if (!S.gateway) { $("btnRotate").disabled = true; $("btnSend").disabled = true; }
  }

  async function refresh() { gate(); await Promise.all([readProtocol(), readUser(), readHelpers(), readSkills()]); gate(); }

  /* ---------- the brownies on the payroll, for tips ---------- */
  let helpers = [];
  async function readHelpers() {
    if (!S.live || !S.vault) return;
    try {
      const n = Number(await S.vault.helperCount());
      const list = [];
      for (let i = 0; i < n; i++) { const hp = await S.vault.helper(i); if (hp.active) list.push({ id: i, name: String(hp.name) }); }
      helpers = list;
      const sel = $("tipWho");
      sel.replaceChildren(...list.map((hp) => { const o = document.createElement("option"); o.value = String(hp.id); o.textContent = hp.name; return o; }));
      if (!list.length) { const o = document.createElement("option"); o.value = ""; o.textContent = "No brownie on the payroll yet"; sel.append(o); }
      $("btnTip").hidden = false;
    } catch (_) { /* the chain did not answer: the list stays */ }
  }
  $("maxTip").onclick = () => { $("inTip").value = B.amount(U.sugar, 6, 6).replace(/,/g, ""); };
  $("btnTip").onclick = async () => {
    const who = $("tipWho").value;
    if (who === "" || !helpers.length) return toast("No brownie is on the payroll yet.", "err");
    const v = parse($("inTip").value, 6);
    if (v == null || v === 0n) return toast("Enter how much SUGAR to tip.", "err");
    if (v > U.sugar) return toast("You do not have that much SUGAR.", "err");
    if (!(await approveIfShort($("btnTip"), S.sugar, S.d.teamVault, v, "SUGAR"))) return;
    const name = helpers.find((hp) => String(hp.id) === who)?.name || "the brownie";
    if (await tx($("btnTip"), () => signerOf(S.vault).tip(BigInt(who), v), `Tipped. ${name} says thank you.`, EXP)) { $("inTip").value = ""; refresh(); }
  };

  /* ---------- skills: the list, the votes, a new proposal ---------- */
  async function readSkills() {
    if (!S.live || !S.registry) return;
    try {
      const n = Number(await S.registry.count());
      const me = account();
      const items = [];
      for (let i = n - 1; i >= 0 && i >= n - 30; i--) {
        const sk = await S.registry.skill(i);
        const mine = me ? await S.registry.voted(i, me) : false;
        items.push({ id: i, sk, mine });
      }
      const list = $("skills"), now = U.chainNow || Math.floor(Date.now() / 1000);
      list.replaceChildren(...items.map(({ id, sk, mine }) => {
        const li = document.createElement("li"), left = document.createElement("div"), acts = document.createElement("div");
        acts.className = "acts";
        const what = document.createElement("p"); what.className = "what";
        const uri = String(sk.uri);
        if (/^https:\/\//.test(uri)) { const a = document.createElement("a"); a.href = uri; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = uri; what.append(a); } else what.textContent = uri;
        const yes = sk.yes, no = sk.no, total = yes + no, bar = sk.quorumWeight * 500n / 10000n;
        const open = now < Number(sk.closesAt) && !sk.vetoed && !sk.paid;
        const state = sk.vetoed ? "vetoed by the team" : sk.paid ? (sk.paidAmount > 0n ? "passed, paid " + sugar(sk.paidAmount, 2) + " SUGAR" : "did not pass") : open ? "vote open, closes " + B.day(Number(sk.closesAt) * 1000) : "vote closed, waiting to be settled";
        const meta = document.createElement("p"); meta.className = "meta";
        meta.textContent = "asks " + sugar(sk.ask, 2) + " SUGAR, by " + B.short(sk.author) + ", " + state + ". yes " + coin(yes) + ", no " + coin(no) + ", bar " + coin(bar) + (mine ? ". You voted." : "");
        const barEl = document.createElement("div"); barEl.className = "bar"; const fill = document.createElement("i");
        fill.style.width = (bar > 0n ? Math.min(100, Number(yes * 100n / (bar > total ? bar : total || 1n))) : 0) + "%"; barEl.append(fill);
        left.append(what, meta, barEl);
        if (open && !mine) {
          for (const [label, support] of [["Yes", true], ["No", false]]) {
            const b = document.createElement("button"); b.className = "btn ghost"; b.type = "button"; b.textContent = label; b.disabled = !me || Wt.state.wrongChain;
            b.onclick = () => tx(b, () => signerOf(S.registry).vote(id, support), "Vote counted.", EXP).then((ok) => ok && refresh());
            acts.append(b);
          }
        } else if (!open && !sk.paid && !sk.vetoed) {
          const b = document.createElement("button"); b.className = "btn ghost"; b.type = "button"; b.textContent = "Settle"; b.disabled = !me || Wt.state.wrongChain;
          b.onclick = () => tx(b, () => signerOf(S.registry).finalize(id), "Settled.", EXP).then((ok) => ok && refresh());
          acts.append(b);
        }
        li.append(left, acts);
        return li;
      }));
      $("skillsEmpty").hidden = items.length > 0;
    } catch (_) { /* the chain did not answer: the list stays */ }
  }
  $("btnSubmitSkill").onclick = async () => {
    const uri = $("inSkillUri").value.trim(), ask = parse($("inSkillAsk").value, 6);
    if (!uri || uri.length > 300) return toast("Say where the skill lives, in at most 300 characters.", "err");
    if (ask == null || ask === 0n) return toast("Enter the price you ask, in SUGAR.", "err");
    if (await tx($("btnSubmitSkill"), () => signerOf(S.registry).submit(uri, ask), "Proposed. The vote is open for 3 days.", EXP)) { $("inSkillUri").value = ""; $("inSkillAsk").value = ""; refresh(); }
  };

  /* ---------- helpers ---------- */
  function need(inputId, decimals, what) {
    const v = parse($(inputId).value, decimals);
    if (v == null) { toast(`Type an amount of ${what} first.`, "err"); $(inputId).focus(); }
    return v;
  }
  /// Approve exactly what the next call needs, when the allowance is short.
  async function approveIfShort(btn, token, spender, amountNeeded, name) {
    const have = await token.allowance(account(), spender);
    if (have >= amountNeeded) return true;
    const r = await tx(btn, () => signerOf(token).approve(spender, amountNeeded), `${name} approved. Now confirm the second step.`, EXP);
    return !!r;
  }
  async function indexTx(hash) { await gw(S, "/api/protocol/index-tx", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: hash }) }); }

  /* ---------- stake ---------- */
  $("maxStake").onclick = () => { $("inStake").value = E.formatUnits(U.wallet > 0n ? U.wallet : U.staked, 18); };
  $("btnStake").onclick = async () => {
    const v = need("inStake", 18, "BROWNIE"); if (v == null) return;
    if (v > U.wallet) return toast("Your wallet does not hold that much BROWNIE.", "err");
    if (U.staked + v < U.min) return toast(`A stake must be at least ${coin(U.min)} BROWNIE.`, "err");
    const b = $("btnStake");
    if (!(await approveIfShort(b, S.token, S.d.staking, v, "BROWNIE"))) return;
    if (await tx(b, () => signerOf(S.staking).stake(v), "Staked. You are earning SUGAR now.", EXP)) { $("inStake").value = ""; refresh(); }
  };
  $("btnUnstake").onclick = async () => {
    const v = need("inStake", 18, "BROWNIE"); if (v == null) return;
    if (v > U.staked) return toast("You have less than that staked.", "err");
    const left = U.staked - v;
    if (left !== 0n && left < U.min) return toast(`Leave at least ${coin(U.min)} BROWNIE staked, or unstake everything.`, "err");
    if (await tx($("btnUnstake"), () => signerOf(S.staking).unstake(v), "Unstaked. The BROWNIE is back in your wallet.", EXP)) { $("inStake").value = ""; refresh(); }
  };

  $("btnPoke").onclick = async () => {
    if (await tx($("btnPoke"), () => signerOf(S.staking).poke(account()), "Bonus applied. You earn more from now on.", EXP)) refresh();
  };

  /* ---------- SUGAR ---------- */
  $("btnClaim").onclick = async () => {
    if (U.earned === 0n) return toast("There is nothing to claim yet.", "err");
    if (await tx($("btnClaim"), () => signerOf(S.staking).claim(), "Claimed. The SUGAR is in your wallet.", EXP)) refresh();
  };
  $("maxActivate").onclick = () => { $("inActivate").value = E.formatUnits(U.sugar, 6); };
  $("btnActivate").onclick = async () => {
    const v = need("inActivate", 6, "SUGAR"); if (v == null) return;
    if (v > U.sugar) return toast("Your wallet does not hold that much SUGAR.", "err");
    const r = await tx($("btnActivate"), () => signerOf(S.sugar)["activate(uint256)"](v), "Activated. The dollars are on your key.", EXP);
    if (r) { $("inActivate").value = ""; await indexTx(r.hash); refresh(); }
  };

  /* ---------- the key ---------- */
  async function makeKey() {
    const sig = await Wt.state.signer.signMessage(keyMessage(S.cfg.chainId, U.epoch));
    U.key = keyFromSignature(sig, U.epoch);
    return U.key;
  }
  $("btnKey").onclick = async () => {
    const b = $("btnKey"), label = b.textContent;
    b.disabled = true; b.classList.add("busy"); b.textContent = "Sign in your wallet";
    try {
      await makeKey();
      set("keyBox", U.key); $("keyWrap").hidden = false;
    } catch (e) { toast(explainError(e), "err"); }
    finally { b.textContent = label; b.classList.remove("busy"); b.disabled = false; }
  };
  $("btnCopyKey").onclick = async () => { try { await navigator.clipboard.writeText(U.key || ""); toast("Key copied. Keep it secret."); } catch (_) { toast("Could not copy. Select the key and copy it by hand.", "err"); } };
  $("btnRotate").onclick = async () => {
    const b = $("btnRotate"), label = b.textContent;
    b.disabled = true; b.classList.add("busy"); b.textContent = "Sign in your wallet";
    try {
      if (!U.key) await makeKey();
      const r = await gw(S, "/v1/key/rotate", { method: "POST", headers: { authorization: "Bearer " + U.key } });
      if (!r.ok) throw new Error("rotate");
      U.epoch = Number(r.body.epoch);
      await makeKey();
      set("keyBox", U.key); $("keyWrap").hidden = false;
      toast("New key made. The old key no longer works.");
    } catch (e) { toast(e?.message === "rotate" ? "The gateway did not answer. Try again." : explainError(e), "err"); }
    finally { b.textContent = label; b.classList.remove("busy"); b.disabled = false; }
  };

  /* ---------- buy at par ---------- */
  $("maxBuy").onclick = () => { $("inBuy").value = E.formatUnits(U.usdc, 6); };
  async function buy(btn, activate) {
    const v = need("inBuy", 6, "USDC"); if (v == null) return;
    if (v > U.usdc) return toast("Your wallet does not hold that much USDC.", "err");
    if (!(await approveIfShort(btn, S.usdc, S.d.minter, v, "USDC"))) return;
    const m = signerOf(S.minter);
    const r = activate
      ? await tx(btn, () => m.mintAndActivate(v, beneficiary(account())), "Bought and activated. The dollars are on your key.", EXP)
      : await tx(btn, () => m.mint(account(), v), "Bought. The SUGAR is in your wallet.", EXP);
    if (r) { $("inBuy").value = ""; if (activate) await indexTx(r.hash); refresh(); }
  }
  $("btnBuyAct").onclick = () => buy($("btnBuyAct"), true);
  $("btnBuy").onclick = () => buy($("btnBuy"), false);

  /* ---------- try the key ---------- */
  if (S.gateway) gw(S, "/v1/models").then((r) => {
    if (r.ok && r.body?.data) {
      const text = r.body.data.filter((m) => (m.architecture?.output_modalities || []).includes("text"));
      const paid = text.filter((m) => Number(m.pricing?.completion) > 0).sort((a, b) => Number(a.pricing.completion) - Number(b.pricing.completion));
      $("modelList").replaceChildren(...text.slice(0, 400).map((m) => { const o = document.createElement("option"); o.value = m.id; return o; }));
      if (paid[0] && !$("inModel").value) $("inModel").value = paid[0].id;
    }
  });
  $("btnSend").onclick = async () => {
    const model = $("inModel").value.trim(), prompt = $("inPrompt").value.trim();
    if (!model) return toast("Pick a model first.", "err");
    if (!prompt) return toast("Type a question first.", "err");
    const b = $("btnSend"), label = b.textContent;
    b.disabled = true; b.classList.add("busy");
    try {
      if (!U.key) { b.textContent = "Sign in your wallet"; await makeKey(); }
      b.textContent = "Thinking";
      const r = await gw(S, "/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + U.key, "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
      });
      const out = $("reply");
      if (!r.ok) {
        const why = r.status === 402 ? "Your balance is too low for this request. Activate more SUGAR."
          : r.status === 401 ? "The gateway refused the key. Press Show my key and try again."
          : r.body?.error?.message ? String(r.body.error.message).slice(0, 200) : "The gateway did not answer. Try again.";
        toast(why, "err");
        return;
      }
      const msg = r.body.choices?.[0]?.message || {};
      out.replaceChildren(document.createTextNode(msg.content || msg.reasoning || "The model returned no text."));
      const meta = document.createElement("span"); meta.className = "meta";
      const u = r.body.usage || {};
      meta.textContent = `${model}, ${u.prompt_tokens ?? 0} tokens in, ${u.completion_tokens ?? 0} tokens out, charged $${r.body.brownies?.charged_usd ?? "0"}`;
      out.appendChild(meta); out.hidden = false;
      readUser();
    } catch (e) { toast(explainError(e), "err"); }
    finally { b.textContent = label; b.classList.remove("busy"); b.disabled = false; }
  };

  /* ---------- collect the tax ---------- */
  $("btnCollect").onclick = async () => {
    // the harvester refuses to run under its gas floor, so the wallet is told how much to send
    if (await tx($("btnCollect"), () => signerOf(S.harvester).claim({ gasLimit: 1_200_000n }), "Collected. The tax went into the split.", EXP)) refresh();
  };

  await refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 8000);
  // a tab that comes back from the background catches up at once
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  window.BrowniesApp = { refresh };
})();
