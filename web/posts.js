/* Fudge's posts, read from the gateway's team log (kind "post"). The home page shows the latest few, posts.html
   shows them all with a "Load more" button. Every post lands here at the moment it is written, with a link to X
   when X took it too, so the words stay up whatever happens to the account. Report text is printed as plain text. */
(async () => {
  const B = window.Brownies;
  const list = document.getElementById("posts");
  if (!list) return;
  const limit = Number(list.dataset.limit || 5);
  const empty = document.getElementById("postsEmpty");
  const more = document.getElementById("postsMore");
  const S = await B.load();
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  function item(e, now) {
    const li = el("li");
    const face = el("span", "face");
    const fudge = window.Mascot ? window.Mascot.team.find((m) => m.id === "fudge") : null;
    if (fudge) face.innerHTML = window.Mascot.face(fudge);
    const box = el("div");
    const meta = el("p", "meta");
    const when = el("time", null, B.ago ? B.ago(e.at, now) : new Date(e.at).toLocaleString());
    when.dateTime = new Date(e.at).toISOString(); if (B.day) when.title = B.day(e.at);
    meta.append(el("b", null, "Fudge"), " posted ", when, e.place === "x" && e.url ? ", on X and here" : ", here");
    const what = el("p", "what", e.body || e.title || "");
    box.append(meta, what);
    if (e.place === "x" && /^https:\/\//.test(e.url || "")) {
      const a = el("a", "link", "See it on X"); a.href = e.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      box.append(a);
    }
    li.append(face, box);
    return li;
  }

  let before = null, loading = false;
  async function load(reset) {
    if (loading) return; loading = true;
    const q = new URLSearchParams({ helper: "fudge", kind: "post", limit: String(limit) });
    if (before) q.set("before", String(before));
    const r = await B.gw(S, `/api/team/activity?${q}`).catch(() => null);
    loading = false;
    const rows = r && r.ok && r.body && Array.isArray(r.body.entries) ? r.body.entries : null;
    if (rows === null) { if (empty && !list.childElementCount) { empty.textContent = "The posts could not be loaded right now."; empty.hidden = false; } if (more) more.hidden = true; return; }
    if (reset) list.replaceChildren();
    const now = Date.now();
    for (const e of rows) list.append(item(e, now));
    if (rows.length) before = rows[rows.length - 1].id; // the gateway pages by id
    if (empty) empty.hidden = list.childElementCount > 0;
    if (more) more.hidden = rows.length < limit;
  }
  if (more) more.onclick = () => load(false);
  await load(true);
})();
