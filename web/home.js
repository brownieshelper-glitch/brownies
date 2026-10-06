/* Home page: the live numbers and the contract addresses. Both stay hidden until the chain answers, so the page
   never shows an empty or a broken number. */
(async () => {
  const S = await window.Brownies.load();
  if (!S.live) return;
  const $ = (id) => document.getElementById(id);

  // the contract addresses, with a link to the explorer
  const head = document.querySelector("#contracts .addr-h");
  if (head) head.hidden = false;
  for (const td of document.querySelectorAll("#contracts td.addr")) {
    const a = S.d[td.dataset.k];
    if (!a) continue;
    const link = document.createElement("a");
    link.href = `${S.cfg.explorer}/address/${a}`; link.target = "_blank"; link.rel = "noopener";
    link.textContent = window.Brownies.short(a);
    td.replaceChildren(link); td.hidden = false;
  }

  try {
    const [staked, rate, finish, minted, activated, block] = await Promise.all([
      S.staking.totalStaked(), S.staking.rewardRate(), S.staking.periodFinish(), S.staking.totalMinted(), S.sugar.totalActivated(),
      S.provider.getBlock("latest"),
    ]);
    const now = Number(block.timestamp); // the chain's clock, not this computer's
    const perHour = Number(finish) > now ? (rate * 3600n) / 10n ** 18n : 0n;
    $("liveStaked").textContent = window.Brownies.coin(staked);
    $("liveStream").textContent = window.Brownies.sugar(perHour, 2);
    $("livePaid").textContent = window.Brownies.usd(minted);
    $("liveBought").textContent = window.Brownies.usd(activated);
    $("live").hidden = false;
  } catch (_) { /* the chain did not answer: the band stays hidden */ }
})();
