/* The Bakery's public page: the rules from /bake/info and every baked brownie from /bake/feed, newest first,
   each with its face, its holder, its jobs and its latest work. With nothing behind it the page keeps the fixed
   facts and a plain empty line. */
(async () => {
  const B = window.Brownies, K = window.Baked;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const S = await B.load();

  const [info, feed] = await Promise.all([K.api(S, "/info"), K.api(S, "/feed")]);
  const I = info.ok && info.body ? info.body : null;
  if (I) {
    $("minHold").textContent = Number(I.minHold).toLocaleString("en-US");
    const oven = $("oven");
    if (I.on && I.live) { oven.textContent = `${I.total} baked, ${I.room} ${I.room === 1 ? "place" : "places"} left`; oven.hidden = false; }
  }

  const shelf = $("shelf");
  const list = feed.ok && feed.body && Array.isArray(feed.body.brownies) ? feed.body.brownies : [];
  if (!list.length) { $("shelfEmpty").hidden = false; return; }
  for (const b of list) shelf.append(card(b));

  function card(b) {
    const art = el("article", "baked-card");
    const pic = el("div", "pic"); pic.innerHTML = K.face(b.name);
    const who = el("div", "who");
    who.append(el("h3", null, b.title || K.cap(b.name)));
    who.append(el("span", "job", `baked by ${b.holderShort || B.short(b.holder || "")}${b.since ? `, ${K.when(b.since)}` : ""}`));
    const head = el("div", "baked-head"); head.append(pic, who);
    art.append(head);
    if (b.personality) art.append(el("p", "line", K.cap(b.personality)));
    if (b.role) art.append(el("p", "role", K.cap(b.role)));
    if (Array.isArray(b.tasks) && b.tasks.length) {
      const ul = el("ul", "jobs");
      for (const t of b.tasks) ul.append(el("li", null, K.jobLine(t)));
      art.append(ul);
    }
    const n = Number(b.outputs || 0);
    art.append(el("p", "count mono", n === 0 ? "No job done yet" : `${n} ${n === 1 ? "job" : "jobs"} done`));
    const last = Array.isArray(b.feed) && b.feed.length ? b.feed[0] : null;
    if (last) {
      const box = el("div", "latest");
      box.append(el("p", "meta", `${last.title || "Work"}, ${B.ago(Number(last.at))}`));
      box.append(el("p", "what", String(last.text || "")));
      art.append(box);
    }
    return art;
  }
})();
