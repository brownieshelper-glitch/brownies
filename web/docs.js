/* Docs page: mark the part being read in the side list, close the phone list after a tap, and fill in the
   gateway address and the contract addresses once the site knows them. */
(async () => {
  // which part is on screen
  const links = [...document.querySelectorAll("#toc a")];
  const byId = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
  const seen = new Set();
  const mark = () => {
    let current = null;
    for (const id of byId.keys()) if (seen.has(id)) { current = id; break; }
    for (const [id, a] of byId) a.classList.toggle("on", id === current);
  };
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) e.isIntersecting ? seen.add(e.target.id) : seen.delete(e.target.id);
      mark();
    }, { rootMargin: "-80px 0px -55% 0px" });
    for (const id of byId.keys()) { const s = document.getElementById(id); if (s) io.observe(s); }
  }
  const m = document.querySelector(".toc-m");
  if (m) for (const a of m.querySelectorAll("a")) a.addEventListener("click", () => { m.open = false; });

  const S = await window.Brownies.load();
  if (S.gateway) {
    document.getElementById("gwUrl").textContent = S.gateway;
    document.getElementById("gwLine").hidden = false;
  }
  if (!S.live) return;
  const head = document.querySelector("#contracts .addr-h");
  if (head) head.hidden = false;
  for (const td of document.querySelectorAll("#contracts td.addr")) {
    const a = S.d[td.dataset.k];
    if (!a) continue;
    const link = document.createElement("a");
    link.href = `${S.cfg.explorer}/address/${a}`; link.target = "_blank"; link.rel = "noopener";
    link.textContent = a;
    td.replaceChildren(link); td.hidden = false;
  }
})();
