/* Small shared behaviour for every page: the phone menu and the ticker. No dependencies. */
(function () {
  var doc = document;

  // the phone menu: the Menu button shows the page links in a card under the header
  var nav = doc.querySelector(".nav");
  var btn = doc.getElementById("menuBtn");
  if (nav && btn) {
    var close = function () { nav.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); btn.setAttribute("aria-label", "Menu"); };
    btn.addEventListener("click", function () {
      var open = !nav.classList.contains("open");
      nav.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.setAttribute("aria-label", open ? "Close the menu" : "Menu");
    });
    doc.addEventListener("click", function (e) { if (nav.classList.contains("open") && !nav.contains(e.target)) close(); });
    doc.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
    window.addEventListener("resize", function () { if (window.innerWidth > 900) close(); });
  }

  // the socials: the "@" button shows the six networks in a card under the header; one card open at a time
  var soc = doc.getElementById("socials");
  var socBtn = doc.getElementById("socialBtn");
  if (soc && socBtn) {
    var closeSoc = function () { soc.classList.remove("open"); socBtn.setAttribute("aria-expanded", "false"); };
    socBtn.addEventListener("click", function () {
      var open = !soc.classList.contains("open");
      if (open && nav && btn) { nav.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); btn.setAttribute("aria-label", "Menu"); }
      soc.classList.toggle("open", open);
      socBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    if (btn) btn.addEventListener("click", closeSoc);
    doc.addEventListener("click", function (e) { if (soc.classList.contains("open") && !soc.contains(e.target)) closeSoc(); });
    doc.addEventListener("keydown", function (e) { if (e.key === "Escape") closeSoc(); });
  }

  var reduce = false;
  try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

  // cards come in as the page is scrolled to them; what is already on screen when the page opens stays as it is
  if (!reduce && "IntersectionObserver" in window) {
    var picks = doc.querySelectorAll(".member, .facts li, .steps li, .splitkey > div, .splitbar, .bakery-how li, .studio-steps li, .studio-card, .board-totals div, .job-card, .baked-card, .crew div, .site, .city, .panel, .use-grid > *, .tbl, .foot-cols > div");
    var io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) if (entries[i].isIntersecting) { entries[i].target.classList.add("in"); io.unobserve(entries[i].target); }
    }, { rootMargin: "0px 0px -6% 0px", threshold: 0.1 });
    var vh = window.innerHeight || 800;
    for (var k = 0; k < picks.length; k++) {
      var el = picks[k], r = el.getBoundingClientRect();
      if (r.bottom > 0 && r.top < vh * 0.92) continue;
      var sib = el.parentNode ? Array.prototype.indexOf.call(el.parentNode.children, el) : 0;
      el.style.setProperty("--i", String(Math.min(sib, 5)));
      el.classList.add("reveal");
      io.observe(el);
    }
  }

  // the brownies watch the pointer (a mouse, not a finger), and jump when they are clicked
  var pointer = false;
  try { pointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches; } catch (e) {}
  if (!reduce && pointer) {
    var eyes = null, px = 0, py = 0, raf = 0;
    var collect = function () { eyes = doc.querySelectorAll(".hero [data-mascot] .eyes, .team [data-mascot] .eyes, .crewlive .pic .eyes, .crew [data-mascot] .eyes, .shelf .pic .eyes"); };
    var look = function () {
      raf = 0;
      if (!eyes) collect();
      for (var i = 0; i < eyes.length; i++) {
        var e = eyes[i], r = e.getBoundingClientRect();
        if (!r.width) continue;
        var cx = r.left + r.width / 2, cy = r.top + r.height / 2, dx = px - cx, dy = py - cy, d = Math.hypot(dx, dy) || 1;
        var k = Math.min(1, d / 260) * 7;   // up to 7 units of the drawing
        var p = e.querySelector(".pupils");
        if (p) p.style.transform = "translate(" + (dx / d * k).toFixed(1) + "px," + (dy / d * k).toFixed(1) + "px)";
      }
    };
    doc.addEventListener("pointermove", function (ev) { px = ev.clientX; py = ev.clientY; if (!raf) raf = requestAnimationFrame(look); }, { passive: true });
    doc.addEventListener("pointerleave", function () {
      if (!eyes) return;
      for (var i = 0; i < eyes.length; i++) { var p = eyes[i].querySelector(".pupils"); if (p) p.style.transform = ""; }
    });
    setTimeout(collect, 800); setTimeout(collect, 4000);   // some pages draw their brownies after this script
  }
  if (!reduce) {
    doc.addEventListener("click", function (ev) {
      var hit = ev.target.closest ? ev.target.closest(".lineup g.m, .member .pic, .live-card .pic, .crew .pic, .baked-card .pic") : null;
      if (!hit) return;
      var box = hit.classList.contains("m") ? hit : hit.querySelector("svg");
      if (!box || box.classList.contains("jump")) return;
      box.classList.add("jump");
      box.addEventListener("animationend", function () { box.classList.remove("jump"); }, { once: true });
    });
  }

  // the ticker: its line is repeated once so the loop never shows a gap
  var tracks = doc.querySelectorAll(".ticker-track");
  for (var i = 0; i < tracks.length; i++) {
    var t = tracks[i], copy = t.cloneNode(true);
    copy.setAttribute("aria-hidden", "true");
    t.parentNode.appendChild(copy);
  }
})();
