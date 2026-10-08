/* Draws the brownies as SVG. One file for the site, the intro, the coin logo and the banner, so the characters
   never drift.

   Mascot.svg(options)   one brownie
   Mascot.rig(helper)    one brownie built to be moved: its feet stand on the point 0,0 (see "moving parts" below)
   Mascot.lineup(o)      the team standing in a row, as one picture
   Mascot.coin(o)        the coin logo: the face on an orange coin
   Mascot.face(helper)   one brownie's face in a square, for a line in a list
   Mascot.team           the four helpers
   Mascot.fill(root)     fills every [data-mascot] element: "lineup" (with an optional data-team="fudge,crumb"),
                         "coin", or a helper's id

   options of svg():
     w, h      body size (default 192 x 186); the body is centred on x = 200 and stands on y = 292
     drips     lengths of the icing drips, right to left (their count is fitted to the width)
     bite      "tr", "tl" or null: the corner with a bite out of it
     crumbs    false to leave out the crumbs that fly off the bite
     mouth     "smile", "open", "grin" or "o"
     look      [dx, dy] where the pupils look
     blush     true for orange cheeks
     prop      "megaphone", "headset", "magnifier", "wrench" or null
     limbs     false to draw only the body (for a coin logo)
     icing     the icing colour (default orange)
     viewBox   the frame (default fits any helper with any prop)
     inner     true to get the shapes without the <svg> around them
     rig       true to draw every mouth (all hidden but one) and hide the megaphone's sound waves

   Moving parts. Every brownie is drawn as groups a script can turn, each with its turning point in data-pivot:
     g.leg.l, g.leg.r     a leg with its foot, turning at the hip
     g.top                everything above the legs, turning and squashing at the feet line
       g.arm.l, g.arm.r   an arm with what it holds, turning at the shoulder (data-still marks an arm that aims a tool)
       g.eyes             both eyes (scale it flat for a blink); g.pupils inside moves the gaze
       g.mouth[data-m]    the mouths
       g.waves            the megaphone's sound waves */
(function (root) {
  var INK = "#2A1710", BONE = "#F6EFE2", ORANGE = "#FF5A1F", ORANGE2 = "#E64A12";   // cocoa, cream, icing
  var NS = 'xmlns="http://www.w3.org/2000/svg"';
  var MOUTHS = ["smile", "open", "grin", "o"];
  var esc = function (s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"); };   // a name goes into markup
  var uid = 0;

  function icingPath(x, top, w, drips) {
    var n = Math.max(2, Math.round((w - 28) / 52) + 1);
    var gap = (w - n * 28) / (n - 1);
    var d = "M" + x + " " + (top + 40) + " V" + (top + 30) + " Q" + x + " " + top + " " + (x + 30) + " " + top +
      " H" + (x + w - 30) + " Q" + (x + w) + " " + top + " " + (x + w) + " " + (top + 30);
    var px = x + w;
    for (var i = 0; i < n; i++) {
      var len = Math.max(14, drips[i % drips.length]);
      var L = top + 40 + len;
      d += " V" + (L - 14) + " Q" + px + " " + L + " " + (px - 14) + " " + L + " Q" + (px - 28) + " " + L + " " + (px - 28) + " " + (L - 14) + " V" + (top + 40);
      px -= 28;
      if (i < n - 1) {
        d += " Q" + px + " " + (top + 30) + " " + (px - gap / 2) + " " + (top + 30) + " Q" + (px - gap) + " " + (top + 30) + " " + (px - gap) + " " + (top + 40);
        px -= gap;
      }
    }
    return d + " Z";
  }

  function svg(o) {
    o = o || {};
    var w = o.w || 192, h = o.h || 186, icing = o.icing || ORANGE;
    var limbs = o.limbs !== false, rig = !!o.rig, id = "mb" + (++uid);
    var x = 200 - w / 2, R = x + w, bottom = 292, top = bottom - h;
    var eyeY = top + h * 0.64, e = w * 0.185, r = Math.min(27, w * 0.14);
    var look = o.look || [5, 4];
    var drips = o.drips || [22, 44, 26, 14];
    var lens = limbs && o.prop === "magnifier";
    var legs = "", armL = "", armR = "", stillL = false, stillR = false, back = "", front = "";
    var arm = function (d) { return '<path d="' + d + '" fill="none" stroke="' + INK + '" stroke-width="12" stroke-linecap="round"/>'; };

    if (limbs) {
      // each leg starts inside the body, so a leaning body never shows a gap at the hip
      var lx = 200 - w * 0.19, rx = 200 + w * 0.19;
      var leg = function (side, hx, fx, footx) {
        return '<g class="leg ' + side + '" data-pivot="' + hx + " " + (bottom - 4) + '"><path d="M' + hx + " " + (bottom - 16) + " V" + (bottom - 2) + " L" + fx + ' 336" fill="none" stroke="' + INK + '" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/><ellipse cx="' + footx + '" cy="340" rx="17" ry="8" fill="' + INK + '"/></g>';
      };
      legs = leg("l", lx, lx - 6, lx - 14) + leg("r", rx, rx + 8, rx + 16);

      var waveL = "M" + (x + 2) + " " + (eyeY - 10) + " C" + (x - 22) + " " + (eyeY - 20) + " " + (x - 34) + " " + (eyeY - 40) + " " + (x - 36) + " " + (eyeY - 64);
      var hipL = "M" + (x + 2) + " " + (eyeY - 4) + " C" + (x - 26) + " " + (eyeY + 6) + " " + (x - 30) + " " + (eyeY + 30) + " " + (x - 10) + " " + (eyeY + 44);
      var hipR = "M" + (R - 2) + " " + (eyeY - 4) + " C" + (R + 26) + " " + (eyeY + 6) + " " + (R + 30) + " " + (eyeY + 30) + " " + (R + 10) + " " + (eyeY + 44);
      if (o.prop === "megaphone") {
        armR = arm(hipR);
        armL = arm("M" + (x + 2) + " " + (eyeY - 8) + " C" + (x - 16) + " " + (eyeY - 6) + " " + (x - 26) + " " + (eyeY + 4) + " " + (x - 34) + " " + (eyeY + 16)) +
          '<path d="M' + (x - 26) + " " + (eyeY + 6) + " L" + (x - 78) + " " + (eyeY - 26) + " L" + (x - 78) + " " + (eyeY + 50) + " L" + (x - 26) + " " + (eyeY + 26) + ' Z" fill="' + ORANGE + '" stroke="' + ORANGE + '" stroke-width="6" stroke-linejoin="round"/>' +
          '<ellipse cx="' + (x - 78) + '" cy="' + (eyeY + 12) + '" rx="9" ry="40" fill="' + ORANGE2 + '"/>' +
          '<g class="waves"' + (rig ? ' display="none"' : "") + ' fill="none" stroke="' + ORANGE + '" stroke-width="7" stroke-linecap="round"><path d="M' + (x - 100) + " " + (eyeY - 12) + " Q" + (x - 112) + " " + (eyeY + 12) + " " + (x - 100) + " " + (eyeY + 36) + '"/><path d="M' + (x - 118) + " " + (eyeY - 26) + " Q" + (x - 138) + " " + (eyeY + 12) + " " + (x - 118) + " " + (eyeY + 50) + '"/></g>';
        stillL = true;
      } else if (o.prop === "headset") {
        armL = arm(waveL); armR = arm(hipR);
        back = '<path d="M' + (x - 8) + " " + (eyeY - 4) + " C" + (x - 8) + " " + (top - 74) + " " + (R + 8) + " " + (top - 74) + " " + (R + 8) + " " + (eyeY - 4) + '" fill="none" stroke="' + INK + '" stroke-width="10" stroke-linecap="round"/>';
      } else if (o.prop === "magnifier") {
        var cxm = 200 + e, Rm = r * 1.62, hx = cxm + Rm * 0.72, hy = eyeY + Rm * 0.72;
        armL = arm(hipL);
        armR = arm("M" + (R - 2) + " " + (eyeY + 34) + " C" + (R + 22) + " " + (eyeY + 44) + " " + (R + 30) + " " + (eyeY + 60) + " " + (hx + 30) + " " + (hy + 30));
        stillR = true;
      } else if (o.prop === "wrench") {
        // the jaw of the wrench is a real cut (a mask), so whatever is behind it shows through
        armL = arm(waveL);
        armR = arm("M" + (R - 2) + " " + (eyeY - 10) + " C" + (R + 22) + " " + eyeY + " " + (R + 36) + " " + (eyeY - 8) + " " + (R + 42) + " " + (eyeY - 28)) +
          '<mask id="' + id + 'w" maskUnits="userSpaceOnUse" x="-30" y="-110" width="60" height="130"><rect x="-30" y="-110" width="60" height="130" fill="#fff"/><rect x="-7" y="-98" width="14" height="26" fill="#000"/></mask>' +
          '<g transform="translate(' + (R + 46) + " " + (eyeY - 34) + ') rotate(22)"><g mask="url(#' + id + 'w)"><rect x="-7" y="-62" width="14" height="66" rx="7" fill="' + ORANGE + '"/><circle cx="0" cy="-74" r="20" fill="' + ORANGE + '"/></g></g>';
      } else {
        armL = arm(waveL); armR = arm(hipR);
      }
    }

    // the body and the icing; the bite is a real cut (a mask), so it works on any background and over other brownies
    var body = '<rect x="' + x + '" y="' + top + '" width="' + w + '" height="' + h + '" rx="30" fill="' + INK + '"/><path d="' + icingPath(x, top, w, drips) + '" fill="' + icing + '"/>';
    var crumbs = "";
    if (o.bite) {
      var bx = o.bite === "tl" ? x : R, sgn = o.bite === "tl" ? -1 : 1;
      var box = 'x="' + (x - 10) + '" y="' + (top - 10) + '" width="' + (w + 20) + '" height="' + (h + 20) + '"';
      body = '<mask id="' + id + 'b" maskUnits="userSpaceOnUse" ' + box + "><rect " + box + ' fill="#fff"/><g fill="#000"><circle cx="' + (bx + sgn * 4) + '" cy="' + (top - 4) + '" r="35"/><circle cx="' + (bx - sgn * 32) + '" cy="' + (top - 16) + '" r="20"/><circle cx="' + (bx + sgn * 16) + '" cy="' + (top + 36) + '" r="20"/></g></mask><g mask="url(#' + id + 'b)">' + body + "</g>";
      if (o.crumbs !== false && !rig) crumbs = '<g fill="' + INK + '"><circle cx="' + (bx + sgn * 32) + '" cy="' + (top - 28) + '" r="6.5"/><circle cx="' + (bx + sgn * 52) + '" cy="' + (top + 2) + '" r="5"/><circle cx="' + (bx + sgn * 14) + '" cy="' + (top - 48) + '" r="4"/></g>';
    }

    // the face
    var white = function (cx, k) { return '<circle cx="' + cx + '" cy="' + eyeY + '" r="' + r * k + '" fill="#fff"/>'; };
    var pupil = function (cx, k) {
      var pr = r * k * 0.44;
      return '<circle cx="' + (cx + look[0] * k) + '" cy="' + (eyeY + look[1] * k) + '" r="' + pr + '" fill="' + INK + '"/><circle cx="' + (cx + look[0] * k + pr * 0.36) + '" cy="' + (eyeY + look[1] * k - pr * 0.5) + '" r="' + pr * 0.34 + '" fill="#fff"/>';
    };
    var k2 = lens ? 1.34 : 1;
    var eyes = '<g class="eyes" data-pivot="200 ' + eyeY + '">' + white(200 - e, 1) + white(200 + e, k2) + '<g class="pupils">' + pupil(200 - e, 1) + pupil(200 + e, k2) + "</g></g>";
    var blush = o.blush ? '<circle cx="' + (200 - e - r - 4) + '" cy="' + (eyeY + r + 2) + '" r="9" fill="' + ORANGE + '"/><circle cx="' + (200 + e + r + 4) + '" cy="' + (eyeY + r + 2) + '" r="9" fill="' + ORANGE + '"/>' : "";
    // the mouth sits under the left eye when a lens covers the right one
    var mx = lens ? 200 - e * 0.7 : 200, my = eyeY + r + 12;
    var mouth = function (kind) {
      if (kind === "open") return '<path d="M' + (mx - 24) + " " + my + " Q" + mx + " " + (my + 44) + " " + (mx + 24) + " " + my + ' Z" fill="#fff" stroke="#fff" stroke-width="5" stroke-linejoin="round"/><ellipse cx="' + mx + '" cy="' + (my + 14) + '" rx="10" ry="6" fill="' + ORANGE + '"/>';
      if (kind === "grin") return '<path d="M' + (mx - 26) + " " + my + " H" + (mx + 26) + " Q" + (mx + 26) + " " + (my + 24) + " " + mx + " " + (my + 24) + " Q" + (mx - 26) + " " + (my + 24) + " " + (mx - 26) + " " + my + ' Z" fill="#fff" stroke="#fff" stroke-width="4" stroke-linejoin="round"/><path d="M' + mx + " " + (my + 1) + " V" + (my + 23) + '" stroke="' + INK + '" stroke-width="2.5"/>';
      if (kind === "o") return '<ellipse cx="' + mx + '" cy="' + (my + 8) + '" rx="9" ry="11" fill="#fff"/>';
      return '<path d="M' + (mx - 22) + " " + my + " Q" + mx + " " + (my + 22) + " " + (mx + 24) + " " + (my - 2) + '" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/>';
    };
    var own = MOUTHS.indexOf(o.mouth) >= 0 ? o.mouth : "smile", mouths = "";
    if (rig) for (var m = 0; m < MOUTHS.length; m++) mouths += '<g class="mouth" data-m="' + MOUTHS[m] + '"' + (MOUTHS[m] === own ? "" : ' display="none"') + ">" + mouth(MOUTHS[m]) + "</g>";
    else mouths = '<g class="mouth" data-m="' + own + '">' + mouth(own) + "</g>";

    // things held in front of the body
    if (limbs && o.prop === "headset") {
      var mcx = 200 + e + 10, mcy = Math.min(my + 10, bottom - 16);
      front = '<rect x="' + (x - 22) + '" y="' + (eyeY - 28) + '" width="26" height="50" rx="12" fill="' + ORANGE + '" stroke="' + INK + '" stroke-width="5"/><rect x="' + (R - 4) + '" y="' + (eyeY - 28) + '" width="26" height="50" rx="12" fill="' + ORANGE + '" stroke="' + INK + '" stroke-width="5"/>' +
        '<path d="M' + (R + 6) + " " + (eyeY + 20) + " C" + (R + 6) + " " + (mcy + 14) + " " + (mcx + 26) + " " + (mcy + 12) + " " + mcx + " " + mcy + '" fill="none" stroke="' + BONE + '" stroke-width="5" stroke-linecap="round"/><circle cx="' + mcx + '" cy="' + mcy + '" r="7.5" fill="' + ORANGE + '"/>';
    }
    if (lens) {
      var cx2 = 200 + e, R2 = r * 1.62, hx2 = cx2 + R2 * 0.72, hy2 = eyeY + R2 * 0.72;
      front = '<path d="M' + hx2 + " " + hy2 + " L" + (hx2 + 32) + " " + (hy2 + 32) + '" stroke="' + ORANGE + '" stroke-width="14" stroke-linecap="round"/><circle cx="' + cx2 + '" cy="' + eyeY + '" r="' + R2 + '" fill="#fff" fill-opacity="0.10" stroke="' + ORANGE + '" stroke-width="11"/>';
    }

    var armG = function (side, inner, still, px) {
      return inner ? '<g class="arm ' + side + '"' + (still ? ' data-still="1"' : "") + ' data-pivot="' + px + " " + (eyeY - 8) + '">' + inner + "</g>" : "";
    };
    var all = legs + '<g class="top" data-pivot="200 ' + bottom + '">' + armG("l", armL, stillL, x + 2) + armG("r", armR, stillR, R - 2) + back + body + crumbs + eyes + blush + mouths + front + "</g>";
    if (o.inner) return all;
    return "<svg " + NS + ' viewBox="' + (o.viewBox || "-60 16 470 333") + '" role="img" aria-label="' + esc(o.label || "A brownie") + '">' + all + "</svg>";
  }

  // the four helpers; each frame is the same size, shifted to fit its prop, so they share one scale
  var team = [
    { id: "fudge", name: "Fudge", job: "Marketing", line: "Writes the posts and never whispers.", w: 214, h: 172, drips: [18, 40, 22, 34, 14], bite: "tr", mouth: "open", look: [-6, 2], prop: "megaphone", viewBox: "-62 16 410 333" },
    { id: "crumb", name: "Crumb", job: "Community", line: "Answers everyone, at any hour.", w: 168, h: 160, drips: [16, 30, 20], bite: null, mouth: "smile", look: [4, 4], blush: true, prop: "headset", viewBox: "-5 16 410 333" },
    { id: "nib", name: "Nib", job: "Research", line: "Reads the chain and the competition.", w: 170, h: 214, drips: [26, 16, 48], bite: "tl", mouth: "o", look: [4, -2], prop: "magnifier", viewBox: "-5 16 410 333" },
    { id: "chip", name: "Chip", job: "Builder", line: "Builds new tools for the other three.", w: 192, h: 186, drips: [22, 44, 26, 14], bite: "tr", mouth: "grin", look: [5, 4], prop: "wrench", viewBox: "5 16 410 333" },
  ];
  function merge(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in b) o[k] = b[k]; return o; }
  function byId(id) { for (var i = 0; i < team.length; i++) if (team[i].id === id) return team[i]; return null; }

  // a brownie to be moved by a script: the shapes only, shifted so the feet stand on 0,0
  function rig(h) {
    return '<g transform="translate(-200 -348)">' + svg(merge(h, { rig: true, inner: true, crumbs: false })) + "</g>";
  }

  // how far a helper reaches left and right of its centre, props and crumbs included
  function reach(h) {
    var half = (h.w || 192) / 2;
    var L = h.prop === "megaphone" ? 146 : h.prop === "magnifier" ? 36 : 42;
    var Rr = h.prop === "wrench" ? 104 : 36;
    if (h.bite === "tl") L = Math.max(L, 60);
    if (h.bite === "tr") Rr = Math.max(Rr, 60);
    return [half + L, half + Rr];
  }

  // the highest point a helper reaches: the crumbs of its bite, the band of its headset, the top of its wrench
  function reachTop(h) {
    var top = 292 - (h.h || 186), eyeY = top + (h.h || 186) * 0.64, y = top;
    if (h.bite) y = Math.min(y, top - 56);
    if (h.prop === "headset") y = Math.min(y, top - 62);
    if (h.prop === "wrench") y = Math.min(y, eyeY - 145);
    return y - 6;
  }

  // the team standing in a row; o.team picks who, o.gap is the air between two helpers. The feet touch the
  // bottom edge of the picture, so it can stand on the edge of a section. Each helper is a <g class="m">
  // carrying its place in the row as --i, for a staggered entrance.
  function lineup(o) {
    o = o || {};
    var list = o.team || team, gap = o.gap == null ? 8 : o.gap, cursor = 0, g = [], names = [], y0 = 292;
    for (var i = 0; i < list.length; i++) {
      var h = list[i], rr = reach(h), cx = cursor + rr[0];
      g.push('<g transform="translate(' + (cx - 200) + ' 0)"><g class="m" style="--i:' + i + '">' + svg(merge(h, { inner: true, icing: o.icing })) + "</g></g>");
      names.push(h.name);
      y0 = Math.min(y0, reachTop(h));
      cursor = cx + rr[1] + gap;
    }
    var total = cursor - gap, tall = 349 - y0;
    return "<svg " + NS + ' viewBox="0 ' + y0 + " " + total + " " + tall + '" data-ratio="' + (total / tall) + '" role="img" aria-label="The brownies: ' + esc(names.join(", ")) + '">' + g.join("") + "</svg>";
  }

  // the coin logo: the face on an orange coin, with cream icing so it reads on orange.
  // o.shape: "round" (default), "square" (a full square, for platforms that crop it themselves) or "none".
  function coin(o) {
    o = o || {};
    var shape = o.shape || "round";
    var back = shape === "round" ? '<circle cx="200" cy="202" r="160" fill="' + ORANGE + '"/>' : shape === "square" ? '<rect x="40" y="42" width="320" height="320" fill="' + ORANGE + '"/>' : "";
    var face = svg({ w: 192, h: 186, limbs: false, bite: "tr", crumbs: false, mouth: "smile", icing: BONE, inner: true });
    return "<svg " + NS + ' viewBox="40 42 320 320" role="img" aria-label="Brownies">' + back + face + "</svg>";
  }

  // just the face, in a square: for a line in a list
  function face(h) {
    var w = h.w || 192, hh = h.h || 186, s = Math.max(w, hh) + 26;
    return svg(merge(h, { limbs: false, crumbs: false, viewBox: (200 - s / 2) + " " + (292 - hh / 2 - s / 2) + " " + s + " " + s, label: h.name }));
  }

  function fill(scope) {
    var els = (scope || root.document).querySelectorAll("[data-mascot]:not([data-drawn])");
    for (var i = 0; i < els.length; i++) {
      var el = els[i], kind = el.getAttribute("data-mascot"), html = "";
      if (kind === "lineup") {
        var ids = (el.getAttribute("data-team") || "").split(",").filter(Boolean);
        html = lineup({ team: ids.length ? ids.map(byId).filter(Boolean) : team });
      } else if (kind === "coin") {
        html = coin({ shape: el.getAttribute("data-shape") || "round" });
      } else if (byId(kind)) {
        var h = byId(kind);
        html = svg(merge(h, { label: h.name }));
      }
      el.innerHTML = html;
      el.setAttribute("data-drawn", "1");
    }
    if (els.length) blink();
  }

  // A blink now and then, one brownie at a time. Each blink is two class changes: no animation keeps running,
  // so nothing is repainted between blinks.
  var blinking = false;
  function blink() {
    if (blinking || !root.matchMedia || root.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    blinking = true;
    (function next() {
      root.setTimeout(function () {
        if (!root.document.hidden) {
          var all = root.document.querySelectorAll("[data-mascot] .eyes"), seen = [];
          for (var i = 0; i < all.length; i++) if (all[i].getBoundingClientRect().width > 0) seen.push(all[i]);
          if (seen.length) {
            var el = seen[Math.floor(Math.random() * seen.length)];
            el.classList.add("shut");
            root.setTimeout(function () { el.classList.remove("shut"); }, 130);
          }
        }
        next();
      }, 900 + Math.random() * 1900);
    })();
  }

  root.Mascot = { svg: svg, rig: rig, face: face, lineup: lineup, coin: coin, team: team, fill: fill, colors: { INK: INK, BONE: BONE, ORANGE: ORANGE } };
  if (root.document) {
    if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", function () { fill(); });
    else fill();
  }
})(typeof window !== "undefined" ? window : globalThis);
