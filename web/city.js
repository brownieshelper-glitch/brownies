/* Brownie City. Every job a brownie reports is one brick. 100 bricks make a tower, then the next tower starts.

   City.site(el, S, opts)   the building site, on the Kitchen page. The brownies carry bricks from the oven to the
                            tower and throw them into place, one job after the other. Pointing at a brick shows the
                            job behind it. opts.about(id) gives the line to show when a brownie is clicked.
   City.skyline(el, S)      the whole city, on the Progress page: every tower so far and the empty lots to come.

   A brick is 90 wide. Towers come in three shapes, so the skyline is not a row of twins. The units are the ones of
   mascot.js: a brownie is about 330 tall. Words from reports are always written as plain text. */
(function () {
  var M = window.Mascot, B = window.Brownies, NS = "http://www.w3.org/2000/svg";
  var INK = M.colors.INK, BONE = M.colors.BONE, ORANGE = M.colors.ORANGE;
  var SIZE = 100, BW = 90, H = 1560, GROUND = 150, G = 3600;
  var SHAPES = [{ cols: 5, bh: 60 }, { cols: 4, bh: 50 }, { cols: 6, bh: 60 }];
  var mk = function (tag, attrs, parent) { var n = document.createElementNS(NS, tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (parent) parent.appendChild(n); return n; };
  var rand = function (a, b) { return a + Math.random() * (b - a); };
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var sign = function (v) { return v < 0 ? -1 : 1; };
  var known = {};
  for (var t = 0; t < M.team.length; t++) known[M.team[t].id] = M.team[t];

  function shape(i) { var s = SHAPES[i % SHAPES.length], rows = Math.ceil(SIZE / s.cols); return { cols: s.cols, bh: s.bh, rows: rows, width: s.cols * BW, height: rows * s.bh }; }
  // where brick n of tower i sits, from the tower's bottom left corner. Rows fill left to right, then right to left.
  function slot(i, n) {
    var s = shape(i), row = Math.floor(n / s.cols), col = n % s.cols;
    if (row % 2) col = s.cols - 1 - col;
    return { x: col * BW, y: -(row + 1) * s.bh, w: BW, h: s.bh };
  }
  function brick(parent, s, entry, n) {
    var g = mk("g", { class: "brick" + (entry && entry.kind === "milestone" ? " gold" : ""), transform: "translate(" + s.x + " " + s.y + ")", "data-n": n }, parent);
    mk("rect", { x: 1.5, y: 1.5, width: s.w - 3, height: s.h - 3, rx: 7 }, g);
    mk("rect", { class: "win", x: s.w / 2 - 15, y: s.h / 2 - 11, width: 30, height: 22, rx: 4 }, g);
    return g;
  }
  // a finished tower gets icing on top and a flag with its number
  function roof(parent, i) {
    var s = shape(i), last = SIZE - (s.rows - 1) * s.cols, w = last * BW, x0 = (s.rows - 1) % 2 ? s.width - w : 0, y = -s.height;
    var g = mk("g", { class: "roof" }, parent), n = Math.max(2, Math.round(w / 120)), step = (w - 40) / n;
    mk("rect", { x: x0 - 8, y: y - 22, width: w + 16, height: 46, rx: 21, fill: ORANGE }, g);
    for (var k = 0; k < n; k++) mk("rect", { x: x0 + 14 + k * step + ((i + k) % 2) * 12, y: y, width: 28, height: 38 + ((i * 7 + k * 13) % 36), rx: 14, fill: ORANGE }, g);
    mk("rect", { x: x0 + w / 2 - 4, y: y - 112, width: 8, height: 94, rx: 4, fill: INK }, g);
    mk("rect", { x: x0 + w / 2 + 4, y: y - 112, width: 74, height: 46, rx: 6, fill: INK }, g);
    var tx = mk("text", { x: x0 + w / 2 + 41, y: y - 78, "text-anchor": "middle", "font-size": 30, class: "flag" }, g);
    tx.textContent = String(i + 1);
    return g;
  }
  function drawTower(parent, i, count, entries) {
    for (var n = 0; n < count; n++) brick(parent, slot(i, n), entries ? entries[n] : null, n);
    if (count >= SIZE) roof(parent, i);
  }
  function floorRect(svg, W) { return mk("rect", { x: -50, y: H - GROUND, width: W + 100, height: GROUND + 50, fill: INK }, svg); }

  // ---------------------------------------------------------------------------------------------- the building site
  function site(el, S, opts) {
    opts = opts || {};
    var stageEl = el.querySelector(".site-stage"), svg = stageEl.querySelector("svg");
    var q = function (c) { return el.querySelector(c); };
    var W = 2600, FLOOR = H - 84, small = false, OVEN = 70, ovenW = 300;   // a thin strip of floor: the line under the stage is its base
    var Hv = H, want = H, aspect = 1.8;   // the camera: how tall a slice of the world is on show, and the slice it is moving to
    var floor = mk("rect", { x: -700, y: FLOOR, width: 9000, height: 400, fill: INK }, svg), ovenG = mk("g", { class: "oven" }, svg), towerG = mk("g", { class: "tower" }, svg), flyG = mk("g", {}, svg), actorsG = mk("g", {}, svg), bitsG = mk("g", {}, svg);
    var total = 0, latest = 0, view = 0, entries = [], nextLand = 0, tx = 0, token = 0, time = 0;
    var reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);   // less motion: the tower is drawn whole, nobody walks
    var actors = [], byId = {}, flying = [], bits = [];

    // the oven where the bricks are baked
    mk("rect", { x: 208, y: -338, width: 46, height: 100, rx: 9, fill: INK }, ovenG);
    mk("rect", { x: 0, y: -250, width: 300, height: 250, rx: 28, fill: INK }, ovenG);
    mk("rect", { x: 44, y: -186, width: 212, height: 126, rx: 18, fill: ORANGE }, ovenG);
    mk("rect", { x: 105, y: -150, width: 90, height: 60, rx: 7, fill: INK }, ovenG);
    for (var kn = 0; kn < 3; kn++) mk("circle", { cx: 62 + kn * 38, cy: -216, r: 10, fill: BONE }, ovenG);

    // On a phone the stage is narrow: there is no oven, the brownies fetch each brick from beyond the left edge.
    function place() {
      var s = shape(view);
      ovenW = small ? 0 : 300;
      tx = W - s.width - Math.max(110, W * 0.07);
      towerG.setAttribute("transform", "translate(" + tx + " " + FLOOR + ")");
      ovenG.setAttribute("transform", "translate(" + OVEN + " " + FLOOR + ")");
      ovenG.setAttribute("display", small ? "none" : "inline");
    }
    // The camera stays close while the tower is low and backs away as it grows. On a phone it always stays back.
    function frameUp(atOnce) {
      var s = shape(view), rows = Math.ceil(Math.max(nextLand, 1) / s.cols), far = small ? Math.max(H, 1300 / aspect) : H;
      want = small ? far : clamp(rows * s.bh + 660, 900, far);
      if (atOnce) Hv = want;
    }
    function camera() {
      W = Hv * aspect;
      svg.setAttribute("viewBox", "0 " + (H - Hv) + " " + W + " " + Hv);
      place();
    }
    function measure() {
      var w = stageEl.clientWidth || 1, h = stageEl.clientHeight || 1;
      aspect = w / h; small = w < 640;
      frameUp(true); camera();
    }
    var leftEdge = function () { return small ? 110 : OVEN + ovenW + 60; };

    // ---- the brownies ----
    var SPEED = { fudge: 520, crumb: 640, nib: 460, chip: 580 }, FRONT = { fudge: -1 };
    function Actor(h, i) {
      var g = mk("g", { class: "actor" }, actorsG);
      g.innerHTML = M.rig(h);
      var p = function (c) { return g.querySelector(c); }, piv = function (n) { return n.getAttribute("data-pivot"); };
      var a = { h: h, i: i, g: g, legL: p(".leg.l"), legR: p(".leg.r"), top: p(".top"), armL: p(".arm.l"), armR: p(".arm.r"), eyes: p(".eyes") };
      a.pLegL = piv(a.legL); a.pLegR = piv(a.legR); a.pArmL = piv(a.armL); a.pArmR = piv(a.armR); a.eyeY = +piv(a.eyes).split(" ")[1];
      a.freeL = !a.armL.hasAttribute("data-still"); a.freeR = !a.armR.hasAttribute("data-still");
      a.speed = SPEED[h.id] || 540; a.front = FRONT[h.id] || 1; a.half = h.w / 2; a.tall = h.h + 56;
      a.x = 0; a.y = 0; a.vx = 0; a.vy = 0; a.dir = 1; a.phase = i * 1.7; a.sq = 0; a.sqv = 0; a.lean = 0;
      a.goal = null; a.then = null; a.wait = 0.4 + i * 0.5; a.busy = false; a.jobs = []; a.job = null; a.carry = null; a.ready = false; a.throwing = false;
      a.wave = 0; a.blinkIn = rand(1, 4); a.blink = 0;
      g.addEventListener("click", function () { hop(a, 0.6); a.wave = 1.4; about(a); });
      return a;
    }
    function hop(a, power) { if (a.y > 0) return; a.vy = 1500 * power; a.y = 0.01; a.sq = 0.16; a.sqv = 0; }
    function runTo(a, x, then, anywhere) { a.goal = anywhere ? x : clamp(x, a.half + 40, W - a.half - 40); a.then = then || null; }

    function startJob(a) {
      var job = a.jobs.shift(), s = shape(view);
      a.busy = true; a.job = job;
      runTo(a, small ? -(a.half + 90) : OVEN + ovenW + 70 + a.i * 34, function () {
        a.carry = brick(flyG, { x: 0, y: 0, w: BW, h: s.bh }, job.entry, job.n);
        hop(a, 0.3);
        runTo(a, tx - 150 - a.i * 44, function () { a.dir = 1; a.ready = true; });
      }, true);
    }
    function idle(a) {
      var r = Math.random();
      if (r < 0.62) runTo(a, rand(leftEdge(), Math.max(leftEdge() + 20, tx - 130)));
      else if (r < 0.84) hop(a, rand(0.45, 0.7));
      else { a.wave = 1.4; hop(a, 0.4); }
      a.wait = rand(0.7, 2.4);
    }
    function release(a) {
      var s = slot(view, a.job.n);
      flying.push({ node: a.carry, job: a.job, x0: a.x - BW / 2, y0: FLOOR - a.y - a.tall - s.h - 10, x1: tx + s.x, y1: FLOOR + s.y, t: 0 });
      a.carry = null; a.throwing = false; a.busy = false; a.job = null; a.wait = rand(0.4, 1.4); a.wave = 0.7;
    }
    function landed(f) {
      flyG.removeChild(f.node);
      var s = slot(view, f.job.n);
      brick(towerG, s, f.job.entry, f.job.n);
      nextLand = Math.max(nextLand, f.job.n + 1);
      frameUp(false);
      for (var k = 0; k < 6; k++) spark(tx + s.x + s.w / 2, FLOOR + s.y + s.h / 2, rand(-320, 320), rand(-520, -120));
      label();
      if (nextLand >= SIZE) {
        roof(towerG, view);
        for (var i = 0; i < actors.length; i++) { hop(actors[i], 0.75); actors[i].wave = 2; }
        if (total > (view + 1) * SIZE) setTimeout(function () { latest = Math.max(latest, view + 1); show(view + 1, true); }, 2600);
      }
    }
    function spark(x, y, vx, vy) { bits.push({ x: x, y: y, vx: vx, vy: vy, life: 0.7, node: mk("circle", { r: rand(4, 8), fill: INK }, bitsG) }); }

    function step(dt) {
      time += dt;
      if (Math.abs(want - Hv) > 0.5) { Hv += (want - Hv) * Math.min(1, dt * 2.2); camera(); }
      for (var i = 0; i < actors.length; i++) {
        var a = actors[i], onFloor = a.y <= 0, speed = 0;
        if (!a.busy && a.jobs.length && onFloor) startJob(a);
        if (!a.busy && a.goal == null && onFloor) { a.wait -= dt; if (a.wait <= 0) idle(a); }
        if (a.ready && onFloor && a.job && a.job.n === nextLand + flying.length) { a.ready = false; a.throwing = true; hop(a, 0.85); }
        else if (a.ready && onFloor && Math.random() < dt * 0.6) hop(a, 0.25);       // waiting for its turn: a small hop
        if (a.goal != null) {
          var dx = a.goal - a.x;
          if (Math.abs(dx) > 14) { a.dir = sign(dx); speed = a.dir * a.speed; }
          else { var after = a.then; a.goal = null; a.then = null; if (after) after(); }
        }
        if (onFloor) a.vx += (speed - a.vx) * Math.min(1, dt * 9);
        a.x = clamp(a.x + a.vx * dt, small && a.busy ? -600 : a.half + 30, W - a.half - 30);
        if (!onFloor) {
          a.vy -= G * dt; a.y += a.vy * dt;
          if (a.throwing && a.vy <= 0) release(a);
          if (a.y <= 0) { a.sq = -clamp(-a.vy / 5200, 0.08, 0.24); a.sqv = 0; a.y = 0; a.vy = 0; }
        }
        if (a.carry) a.carry.setAttribute("transform", "translate(" + (a.x - BW / 2) + " " + (FLOOR - a.y - a.tall - shape(view).bh - 10 - Math.abs(Math.sin(a.phase)) * 6) + ")");
        pose(a, dt);
      }
      for (var j = flying.length - 1; j >= 0; j--) {
        var f = flying[j];
        f.t += dt / 0.6;
        var e = 1 - Math.pow(1 - Math.min(1, f.t), 3);
        f.node.setAttribute("transform", "translate(" + (f.x0 + (f.x1 - f.x0) * e) + " " + (f.y0 + (f.y1 - f.y0) * e - Math.sin(Math.PI * Math.min(1, f.t)) * 170) + ") rotate(" + (1 - e) * -28 + " 45 30)");
        if (f.t >= 1) { flying.splice(j, 1); landed(f); }
      }
      for (var b = bits.length - 1; b >= 0; b--) {
        var p = bits[b];
        p.life -= dt; p.vy += 1900 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.life <= 0) { bitsG.removeChild(p.node); bits.splice(b, 1); continue; }
        p.node.setAttribute("cx", p.x); p.node.setAttribute("cy", p.y); p.node.setAttribute("opacity", clamp(p.life * 2, 0, 1));
      }
    }

    function pose(a, dt) {
      var f = a.front, onFloor = a.y <= 0, running = onFloor && Math.abs(a.vx) > 40, legL = 0, legR = 0, bob = 0, lean = 0, armL = 0, armR = 0;
      if (running) {
        a.phase += Math.abs(a.vx) * dt * 0.036;
        var s = Math.sin(a.phase);
        legL = s * 38; legR = -s * 38; bob = Math.abs(s) * 9; lean = a.carry ? 3 : 9; armL = -s * 16; armR = s * 16;
      } else if (!onFloor) {
        var up = clamp(a.vy / 1500, -1, 1);
        legL = (up > 0 ? 44 : 14) * f; legR = (up > 0 ? -30 : -22) * f; lean = 6 * up; armL = -22 * up; armR = 22 * up;
      } else a.phase += dt * 2.2;
      if (a.wave > 0) { a.wave -= dt; var wv = Math.sin(time * 17) * 24; armL += wv; armR -= wv; }
      a.lean += (lean - a.lean) * Math.min(1, dt * 12);
      a.sqv += (-420 * a.sq - 24 * a.sqv) * dt; a.sq += a.sqv * dt;
      var sy = 1 + a.sq + (onFloor && !running ? Math.sin(a.phase) * 0.012 : 0), sx = 1 - a.sq * 0.7;
      a.g.setAttribute("transform", "translate(" + a.x + " " + (FLOOR - a.y) + ") scale(" + a.dir * f + " 1)");
      a.top.setAttribute("transform", "translate(0 " + (-bob) + ") rotate(" + a.lean * f + " 200 292) translate(200 292) scale(" + sx + " " + sy + ") translate(-200 -292)");
      a.legL.setAttribute("transform", "rotate(" + legL + " " + a.pLegL + ")");
      a.legR.setAttribute("transform", "rotate(" + legR + " " + a.pLegR + ")");
      if (a.freeL) a.armL.setAttribute("transform", "rotate(" + armL + " " + a.pArmL + ")");
      if (a.freeR) a.armR.setAttribute("transform", "rotate(" + armR + " " + a.pArmR + ")");
      a.blinkIn -= dt;
      if (a.blinkIn <= 0) { a.blink = 0.12; a.blinkIn = rand(1.6, 4.5); }
      if (a.blink > 0) { a.blink -= dt; a.eyes.setAttribute("transform", "translate(0 " + a.eyeY + ") scale(1 0.08) translate(0 " + (-a.eyeY) + ")"); }
      else if (a.eyes.hasAttribute("transform")) a.eyes.removeAttribute("transform");
    }

    // ---- words: the label of the tower and the line about a brick or a brownie ----
    var VERB = { post: "posted", reply: "answered", research: "researched", build: "built", deal: "closed a deal", milestone: "reached a milestone", note: "noted" };
    var nameOf = function (id) { return id === "team" ? "The team" : known[id] ? known[id].name : id.charAt(0).toUpperCase() + id.slice(1); };
    function label() {
      q(".site-title").textContent = "Tower " + (view + 1);
      q(".site-count").textContent = nextLand >= SIZE ? "Finished. " + SIZE + " bricks." : nextLand + " of " + SIZE + " bricks";
      q(".site-older").hidden = view <= 0; q(".site-newer").hidden = view >= latest;
    }
    function say(faceHtml, meta, what, more, url) {
      q(".site-info .face").innerHTML = faceHtml;
      q(".site-info .meta").textContent = meta; q(".site-info .what").textContent = what;
      q(".site-info .more").textContent = more || ""; q(".site-info .more").hidden = !more;
      var a = q(".site-info .link");
      if (url && /^https:\/\//.test(url)) { a.href = url; a.hidden = false; } else { a.removeAttribute("href"); a.hidden = true; }
    }
    function hint() {
      var touch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
      say(M.coin({ shape: "square" }), "Each brick is one job a brownie finished.", nextLand || entries.length ? (touch ? "Tap" : "Point at") + " a brick to read the job." : "No bricks yet. The first finished job lays the first one.", "", "");
    }
    function pick(n) {
      var e = entries[n];
      if (!e) return;
      var old = towerG.querySelector(".brick.on"), now = towerG.querySelector('.brick[data-n="' + n + '"]');
      if (old) old.classList.remove("on");
      if (now) now.classList.add("on");
      say(known[e.helper] ? M.face(known[e.helper]) : M.coin({ shape: "square" }), nameOf(e.helper) + " " + (VERB[e.kind] || "reported") + (e.place ? " on " + e.place : "") + ", " + B.ago(e.at) + ". Brick " + (n + 1) + ".", e.title, e.body, e.url);
    }
    function about(a) {
      var line = opts.about ? opts.about(a.h.id) : "";
      say(M.face(a.h), a.h.name + ", " + a.h.job.toLowerCase() + ".", line || a.h.line, "", "");
    }
    var over = function (ev) { var g = ev.target.closest ? ev.target.closest(".brick") : null; if (g) pick(+g.getAttribute("data-n")); };
    towerG.addEventListener("pointerover", over); towerG.addEventListener("click", over);

    // ---- which tower is on show ----
    function clear() {
      for (var i = 0; i < actors.length; i++) { var a = actors[i]; a.jobs = []; a.job = null; a.busy = false; a.ready = false; a.throwing = false; a.goal = null; a.then = null; if (a.carry) { flyG.removeChild(a.carry); a.carry = null; } }
      while (flying.length) flyG.removeChild(flying.pop().node);
    }
    function enqueue(n) { var e = entries[n]; (byId[e.helper] || actors[n % actors.length]).jobs.push({ n: n, entry: e }); }
    async function show(k, replay) {
      var mine = ++token;
      clear();
      var r = await B.gw(S, "/api/team/activity?order=asc&limit=" + SIZE + "&offset=" + k * SIZE);
      if (mine !== token) return;
      view = k; entries = (r.ok && r.body && r.body.entries) || [];
      towerG.replaceChildren();
      var keep = entries.length - (replay && k === latest ? Math.min(5, entries.length) : 0);
      drawTower(towerG, k, keep, entries);
      nextLand = keep;
      frameUp(true); camera();
      for (var n = keep; n < entries.length; n++) enqueue(n);
      label(); hint();
    }
    // new jobs since the last look: they join the queue of the tower being built
    async function refresh() {
      if (document.hidden) return;
      var r = await B.gw(S, "/api/team/summary");
      if (!r.ok || !r.body || r.body.total <= total) return;
      var was = latest;
      total = r.body.total; latest = Math.max(0, Math.ceil(total / SIZE) - 1);
      label();
      if (view !== was) return;                              // the visitor is looking at an older tower: leave it alone
      if (entries.length >= SIZE) { if (latest > view && nextLand >= SIZE && !flying.length) show(view + 1, !reduce); return; }
      if (reduce) { await show(view, false); settle(); return; }   // no walking: the new bricks are simply there
      var mine = token, more = await B.gw(S, "/api/team/activity?order=asc&limit=" + (SIZE - entries.length) + "&offset=" + (view * SIZE + entries.length));
      if (mine !== token || !more.ok || !more.body) return;
      for (var i = 0; i < more.body.entries.length; i++) { entries.push(more.body.entries[i]); enqueue(entries.length - 1); }
    }

    // ---- start ----
    for (var n = 0; n < M.team.length; n++) { var a = Actor(M.team[n], n); actors.push(a); byId[a.h.id] = a; }
    measure();
    actors.forEach(function (a, i) { a.x = leftEdge() + 20 + i * (Math.max(260, tx - leftEdge() - 140) / 4); a.dir = i % 2 ? -1 : 1; });
    window.addEventListener("resize", measure);
    q(".site-older").onclick = function () { if (view > 0) show(view - 1, false); };
    q(".site-newer").onclick = function () { if (view < latest) show(view + 1, false); };
    var last = 0;
    function settle() { for (var i = 0; i < 60; i++) step(0.1); }   // the camera reaches its place without a frame loop
    if (!reduce) requestAnimationFrame(function frame(now) { var dt = last ? Math.min((now - last) / 1000, 0.034) : 0.016; last = now; step(dt); requestAnimationFrame(frame); });

    (async function () {
      var r = await B.gw(S, "/api/team/summary");
      total = r.ok && r.body ? r.body.total : 0;
      latest = Math.max(0, Math.ceil(total / SIZE) - 1);
      var want = Number(new URLSearchParams(location.search).get("tower"));
      await show(want >= 1 && want <= latest + 1 ? want - 1 : latest, !reduce);
      if (reduce) settle();
      setInterval(refresh, 30000);
    })();

    return { state: function () { return { view: view, latest: latest, total: total, bricks: towerG.querySelectorAll(".brick").length, landed: nextLand, queued: actors.reduce(function (s, a) { return s + a.jobs.length + (a.busy ? 1 : 0); }, 0) + flying.length, roof: !!towerG.querySelector(".roof"), xs: actors.map(function (a) { return Math.round(a.x); }) }; }, pick: pick, refresh: refresh };
  }

  // ---------------------------------------------------------------------------------------------------- the skyline
  async function skyline(el, S) {
    var svg = el.querySelector("svg"), FLOOR = H - GROUND, PLOT = 720;
    var r = await B.gw(S, "/api/team/towers");
    var pxH = el.clientHeight || 340, lotPx = PLOT * pxH / H;
    // enough lots to reach the right edge of the page, and always one empty lot after the newest tower
    var list = (r.ok && r.body && r.body.towers) || [], lots = Math.max(list.length + 1, 6, Math.ceil((el.clientWidth || 0) / lotPx)), W = lots * PLOT;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("preserveAspectRatio", "xMinYMid meet");
    svg.style.width = Math.round(W * pxH / H) + "px";
    mk("rect", { x: -3000, y: FLOOR, width: W + 9000, height: GROUND + 50, fill: INK }, svg);
    var keep = new URLSearchParams(location.search); keep.delete("tower");
    for (var k = 0; k < lots; k++) {
      var s = shape(k), x = k * PLOT + (PLOT - s.width) / 2, t = list[k];
      var num = mk("text", { x: k * PLOT + PLOT / 2, y: FLOOR + 96, "text-anchor": "middle", "font-size": 54, class: "plot" }, svg);
      num.textContent = String(k + 1);
      if (!t) { mk("rect", { class: "lot", x: x, y: FLOOR - 300, width: s.width, height: 300, rx: 10 }, svg); continue; }
      keep.set("tower", String(k + 1));
      var a = mk("a", { href: "team.html?" + keep.toString(), class: "tower", "data-count": t.count }, svg);
      var g = mk("g", { transform: "translate(" + x + " " + FLOOR + ")" }, a), tip = mk("title", {}, g);
      tip.textContent = "Tower " + (k + 1) + ". " + t.count + " of " + SIZE + " bricks. " + (t.count >= SIZE ? B.day(t.firstAt) + " to " + B.day(t.lastAt) + "." : "Started " + B.day(t.firstAt) + ".");
      mk("rect", { x: 0, y: -s.height - 130, width: s.width, height: s.height + 130, fill: "transparent" }, g);   // the whole lot is the link
      drawTower(g, k, t.count, null);
    }
    // two brownies stand by the tower being built
    var cur = list.length ? list.length - 1 : 0, cs = shape(cur), bx = cur * PLOT + (PLOT - cs.width) / 2;
    var w1 = mk("g", { transform: "translate(" + (bx - 150) + " " + FLOOR + ")" }, svg), w2 = mk("g", { transform: "translate(" + (bx + cs.width + 150) + " " + FLOOR + ") scale(-1 1)" }, svg);
    w1.innerHTML = M.rig(known.chip); w2.innerHTML = M.rig(known.crumb);
    el.scrollLeft = Math.max(0, (cur + 1) * PLOT * pxH / H - el.clientWidth + 60);
    var done = list.reduce(function (n, t2) { return n + t2.count; }, 0);
    return { towers: list.length, done: done, current: cur + 1 };
  }

  window.City = { site: site, skyline: skyline, SIZE: SIZE };
})();
