/* The Biscotti page: the menu's prices from the live shop (so the page never states a price the shop does not
   charge), and the request form: what the person needs, a link, a contact and up to three files. Everything is
   checked here before it is sent, and checked again by the server (POST /shop/ask). No money moves on this page. */
(() => {
  const $ = (id) => document.getElementById(id);
  const cfg = window.BROWNIES_CONFIG || {};
  // on a local machine ?api= points the page at a test server
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const API = String((local && new URLSearchParams(location.search).get("api")) || cfg.gateway || "").replace(/\/$/, "");
  const LIMITS = { max: 3, each: 4 * 1024 * 1024, all: 8 * 1024 * 1024, kinds: [".pdf", ".txt", ".md", ".png", ".jpg", ".jpeg", ".webp", ".zip"] };
  const WORDS = { min: 20, max: 4000 };
  const form = $("askForm"), btn = $("askBtn"), words = $("fWords"), list = $("fileList"), input = $("fFiles"), drop = $("drop");
  if (!form) return;
  const status = (t, bad = false) => { const s = $("askStatus"); s.textContent = t; s.classList.toggle("bad", bad); };
  const size = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " kB");
  const ext = (name) => { const m = /\.[A-Za-z0-9]+$/.exec(String(name)); return m ? m[0].toLowerCase() : ""; };

  // ---- the prices, and whether the form is open, from the shop itself ----
  (async () => {
    if (!API) return;
    try {
      const r = await fetch(API + "/shop");
      if (!r.ok) return;
      const c = await r.json();
      const money = (n) => "$" + (Number(n) % 1 === 0 ? String(Number(n)) : Number(n).toFixed(2));
      for (const it of c.items || []) {
        const b = document.querySelector('.bis-row[data-item="' + it.id + '"] .bis-price b');
        if (b) b.textContent = money(it.usd);
      }
      // a shop that does not say the form is open is a shop where it is closed
      if (!c.asks || c.asks.open !== true) { btn.disabled = true; status("For now, write to brownieshelper@gmail.com."); }
    } catch (_) { /* the page keeps what it says */ }
  })();

  // ---- the words, counted ----
  const count = () => { $("wordsCount").textContent = words.value.length.toLocaleString("en-US") + " of 4,000"; };
  words.addEventListener("input", count);
  count();

  // ---- the files: chosen or dropped, listed, removable ----
  let files = [];
  const total = () => files.reduce((a, f) => a + f.size, 0);
  function draw() {
    list.replaceChildren();
    files.forEach((f, i) => {
      const li = document.createElement("li");
      const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = f.name;
      const sz = document.createElement("span"); sz.className = "sz"; sz.textContent = size(f.size);
      const rm = document.createElement("button"); rm.type = "button"; rm.textContent = "Remove"; rm.setAttribute("aria-label", "Remove " + f.name);
      rm.addEventListener("click", () => { files.splice(i, 1); draw(); status(""); });
      li.append(nm, sz, rm);
      list.append(li);
    });
  }
  function add(picked) {
    let said = "";
    for (const f of Array.from(picked || [])) {
      if (files.length >= LIMITS.max) { said = "Up to 3 files."; break; }
      if (!LIMITS.kinds.includes(ext(f.name))) { said = f.name + " is not a kind we take. Send a PDF, text, a picture or a zip."; continue; }
      if (!f.size) { said = f.name + " is empty."; continue; }
      if (f.size > LIMITS.each) { said = f.name + " is over 4 MB."; continue; }
      if (total() + f.size > LIMITS.all) { said = "The files are over 8 MB in all."; continue; }
      if (files.some((x) => x.name === f.name && x.size === f.size)) continue;
      files.push(f);
    }
    draw();
    status(said, Boolean(said));
  }
  input.addEventListener("change", () => { add(input.files); input.value = ""; });
  for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
  for (const ev of ["dragleave", "dragend"]) drop.addEventListener(ev, () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); add(e.dataTransfer && e.dataTransfer.files); });
  const read = (f) => new Promise((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] || "");
    r.onerror = () => no(r.error || new Error("unreadable"));
    r.readAsDataURL(f);
  });

  // ---- sending ----
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!API) return status("This page needs the gateway address in config.js.", true);
    const kind = (form.querySelector('input[name="kind"]:checked') || {}).value || "idea";
    const text = words.value.trim(), contact = $("fContact").value.trim(), link = $("fLink").value.trim();
    if (text.length < WORDS.min) { words.focus(); return status("Tell us a little more: at least a sentence or two.", true); }
    if (link && !/^https:\/\/\S+$/i.test(link)) { $("fLink").focus(); return status("The link must start with https://", true); }
    if (contact.length < 3) { $("fContact").focus(); return status("How do we reach you?", true); }
    btn.disabled = true; btn.classList.add("busy");
    status(files.length ? "Sending the request and " + files.length + (files.length === 1 ? " file..." : " files...") : "Sending...");
    try {
      const sent = [];
      for (const f of files) sent.push({ name: f.name, data: await read(f) });
      const r = await fetch(API + "/shop/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, words: text, link, contact, files: sent, website: $("fWebsite").value }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const say = r.status === 503 || r.status === 404 ? "The form is closed for the moment. Write to brownieshelper@gmail.com." : r.status === 429 ? "Too many requests from here. Try again in an hour." : j.error ? j.error.charAt(0).toUpperCase() + j.error.slice(1) + "." : "That did not go through. Try again in a minute.";
        status(say, true);
      } else {
        form.reset(); files = []; draw(); count();
        status("Sent" + (j.request ? ", request " + j.request : "") + ". The owner answers within a day, by the contact you gave.");
      }
    } catch (_) { status("The server did not answer. Try again in a minute.", true); }
    btn.disabled = false; btn.classList.remove("busy");
  });
})();
