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
    window.addEventListener("resize", function () { if (window.innerWidth > 760) close(); });
  }

  // the ticker: its line is repeated once so the loop never shows a gap
  var tracks = doc.querySelectorAll(".ticker-track");
  for (var i = 0; i < tracks.length; i++) {
    var t = tracks[i], copy = t.cloneNode(true);
    copy.setAttribute("aria-hidden", "true");
    t.parentNode.appendChild(copy);
  }
})();
