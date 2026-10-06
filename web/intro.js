/* The intro: the four brownies run onto a stage and live there until the visitor enters the site.
   SUGAR cubes fall (one now and then, and one wherever the visitor clicks). The brownies race for each cube, jump to
   catch it, leap over whoever is in the way, and react to the winner. Between cubes each one does its own thing:
   Fudge shouts through the megaphone and the others jump, Nib inspects a neighbour, Crumb hops and waves, Chip
   waves the wrench.

   It runs only when the page has the class "intro-on" on <html> (set by the small script in the page head: first
   visit of the session, no reduced motion, no #anchor). Everything is drawn with Mascot.rig from mascot.js and moved
   by setting SVG transforms in one requestAnimationFrame loop. Stage units: a brownie is about 330 units tall. */
(function () {
  var doc = document, html = doc.documentElement, el = doc.getElementById("intro"), M = window.Mascot;
  if (!el || !M || !html.classList.contains("intro-on")) return;

  var SVG = "http://www.w3.org/2000/svg";
  var stage = el.querySelector(".stage");
  var mk = function (tag, attrs, parent) { var n = doc.createElementNS(SVG, tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (parent) parent.appendChild(n); return n; };
  var rand = function (a, b) { return a + Math.random() * (b - a); };
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var sign = function (v) { return v < 0 ? -1 : 1; };

  // ---- the stage ----
  var W = 2000, H = 1250, FLOOR = 1060, PX = 1, small = false;   // PX = screen pixels per stage unit
  var floorRect = mk("rect", { class: "floor", fill: M.colors.INK }, stage);
  var tagsG = mk("g", {}, stage), cubesG = mk("g", {}, stage), actorsG = mk("g", {}, stage), bitsG = mk("g", {}, stage);
  function measure() {
    var vw = el.clientWidth || 1, vh = el.clientHeight || 1;
    small = vw < 640;
    H = Math.max(1250, (small ? 1350 : 1500) * vh / vw); W = H * vw / vh; PX = vh / H;
    FLOOR = H - clamp(vh * 0.15, 96, 150) / PX;
    stage.setAttribute("viewBox", "0 0 " + W + " " + H);
    floorRect.setAttribute("x", -50); floorRect.setAttribute("y", FLOOR); floorRect.setAttribute("width", W + 100); floorRect.setAttribute("height", H - FLOOR + 50);
    for (var i = 0; i < actors.length; i++) { actors[i].sizeTag(); actors[i].label(); }
  }

  // ---- the brownies ----
  var G = 3600;                                  // gravity, units per second squared
  var KIND = {                                   // front: which way the drawing faces before any flip
    fudge: { speed: 470, jump: 1500, front: -1 },
    crumb: { speed: 610, jump: 1660, front: 1 },
    nib: { speed: 400, jump: 1460, front: 1 },
    chip: { speed: 540, jump: 1570, front: 1 },
  };
  var actors = [], order = [], cubes = [], bits = [], time = 0, lastDrop = 0, nextAuto = 2.4, closing = false;

  function Actor(h, i) {
    var g = mk("g", { class: "actor" }, actorsG);
    g.innerHTML = M.rig(h);
    var q = function (s) { return g.querySelector(s); };
    var piv = function (n) { return n ? n.getAttribute("data-pivot") : "0 0"; };
    this.h = h; this.k = KIND[h.id]; this.g = g; this.i = i;
    this.legL = q(".leg.l"); this.legR = q(".leg.r"); this.top = q(".top"); this.eyes = q(".eyes"); this.pupils = q(".pupils"); this.waves = q(".waves");
    this.armL = q(".arm.l"); this.armR = q(".arm.r");
    this.pLegL = piv(this.legL); this.pLegR = piv(this.legR); this.pArmL = piv(this.armL); this.pArmR = piv(this.armR);
    this.eyeY = +piv(this.eyes).split(" ")[1];
    this.freeL = this.armL && !this.armL.hasAttribute("data-still"); this.freeR = this.armR && !this.armR.hasAttribute("data-still");
    this.mouths = {};
    var ms = g.querySelectorAll(".mouth");
    for (var m = 0; m < ms.length; m++) this.mouths[ms[m].getAttribute("data-m")] = ms[m];
    this.own = h.mouth || "smile"; this.shown = this.own;
    this.half = h.w / 2; this.tall = h.h + 56;   // standing height: the body and the legs
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0; this.dir = 1;
    this.phase = rand(0, 6); this.sq = 0; this.sqv = 0; this.lean = 0;
    this.mode = "enter"; this.goal = null; this.wait = 0; this.stun = 0; this.then = null;
    this.gaze = null; this.gazeT = 0; this.face = null; this.faceT = 0; this.chomp = 0;
    this.hops = 0; this.wave = 0; this.shout = 0; this.blasted = false; this.peer = 0; this.blinkIn = rand(1, 4); this.blink = 0;
    this.score = 0; this.cube = null; this.tx = 0;
    this.tag = mk("g", { class: "tag" }, tagsG);
    this.tagName = mk("text", { class: "tag-name", "text-anchor": "middle" }, this.tag); this.tagName.textContent = h.name;
    this.tagJob = mk("text", { class: "tag-job", "text-anchor": "middle" }, this.tag);
    this.sizeTag(); this.label();
  }
  Actor.prototype.sizeTag = function () {
    var namePx = clamp(el.clientWidth * 0.021, 15, 28), jobPx = small ? 11 : 13;
    this.tagName.setAttribute("font-size", namePx / PX); this.tagName.setAttribute("y", (namePx * 1.25) / PX);
    this.tagJob.setAttribute("font-size", jobPx / PX); this.tagJob.setAttribute("y", (namePx * 1.25 + jobPx * 1.6) / PX);
  };
  Actor.prototype.label = function () {
    this.tagJob.textContent = this.score ? this.score + " SUGAR" : (small ? "" : this.h.job.toLowerCase());
  };
  Actor.prototype.jump = function (power) {
    if (this.y > 0) return;
    this.vy = this.k.jump * (power || 1); this.y = 0.01; this.sq = 0.16; this.sqv = 0;
  };
  Actor.prototype.look = function (target, seconds) { this.gaze = target; this.gazeT = seconds || 1; };
  Actor.prototype.say = function (mouth, seconds) { this.face = mouth; this.faceT = seconds || 0.6; };
  Actor.prototype.runTo = function (x, then) { this.goal = clamp(x, this.half + 80, W - this.half - 80); this.mode = "go"; this.then = then || null; };
  Actor.prototype.apex = function () { return this.k.jump * this.k.jump / (2 * G); };

  function nearest(a, list, ok) {
    var best = null, bd = 1e9;
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (b === a || (ok && !ok(b))) continue;
      var d = Math.abs(b.x - a.x);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  // what a brownie does when there is no cube to chase
  function idle(a) {
    var r = Math.random(), other = nearest(a, actors);
    if (r < 0.46) {
      // run somewhere with room
      var x = rand(160, W - 160);
      for (var t = 0; t < 4; t++) { var b = nearest({ x: x }, actors, function (o) { return o !== a; }); if (b && Math.abs(b.x - x) < 260) x = rand(160, W - 160); else break; }
      a.runTo(x);
    } else if (r < 0.6) {
      a.jump(rand(0.6, 0.85)); a.wait = rand(0.9, 1.6);
    } else if (a.h.id === "fudge" && other) {
      a.dir = sign(other.x - a.x); a.shout = 1; a.blasted = false; a.say("open", 1); a.wait = 1.5;
    } else if (a.h.id === "nib" && other) {
      var side = sign(a.x - other.x) || 1;
      a.runTo(other.x + side * (other.half + a.half + 46), function () {
        a.dir = -side; a.peer = 1.4; a.look(other, 1.4); a.wait = 1.8;
        other.look(a, 1.4); other.say("o", 0.9);
        if (other.mode === "idle") other.wait = Math.max(other.wait, 1.3);
      });
    } else if (a.h.id === "crumb") {
      a.hops = 2; a.wave = 1.6; a.jump(0.7); a.say("open", 1.2); a.wait = 2;
    } else {
      a.wave = 1.5; a.jump(0.55); a.wait = 1.8;
    }
  }

  function eat(a, c) {
    c.gone = true; cubesG.removeChild(c.node);
    a.score++; a.label(); a.chomp = 0.55; a.hops = 2; a.wave = 1.4; a.mode = "idle"; a.goal = null; a.wait = rand(1.2, 2);
    if (a.y <= 0) a.jump(0.6);
    for (var n = 0; n < 7; n++) spark(c.x, c.y, rand(-380, 380), rand(-620, -120), rand(4, 8), rand(0.5, 0.9));
    var sad = nearest(a, actors);
    for (var i = 0; i < actors.length; i++) {
      var b = actors[i];
      if (b === a) continue;
      b.look(a, 1.1);
      if (b === sad) { b.say("o", 0.8); b.sq = Math.min(b.sq, -0.1); }
    }
  }

  function spark(x, y, vx, vy, r, life) {
    bits.push({ x: x, y: y, vx: vx, vy: vy, life: life, all: life, node: mk("circle", { r: r, fill: M.colors.INK }, bitsG) });
  }

  function drop(x, y) {
    if (closing || cubes.length >= 5) return;
    var c = { x: clamp(x, 70, W - 70), y: Math.min(y, FLOOR - 240), vy: 0, rot: rand(-30, 30), spin: rand(-140, 140), rest: false, gone: false };
    c.node = mk("g", { class: "cube" }, cubesG);
    mk("rect", { x: -32, y: -32, width: 64, height: 64, rx: 11, fill: "#fff", stroke: M.colors.INK, "stroke-width": 8 }, c.node);
    mk("rect", { x: -17, y: -17, width: 14, height: 14, rx: 4, fill: M.colors.BONE }, c.node);
    cubes.push(c); lastDrop = time;
    // the two nearest free brownies race for it; the others watch
    for (var n = 0; n < 2; n++) {
      var racer = nearest(c, actors, function (o) { return !o.cube && o.mode !== "enter"; });
      if (racer) racer.cube = c;
    }
    for (var i = 0; i < actors.length; i++) actors[i].look(c, 9);
    var first = nearest(c, actors, function (o) { return o.cube === c; });
    if (first && first.y <= 0 && first.stun <= 0) { first.jump(0.32); first.say("o", 0.4); }
  }

  // ---- one step of the world ----
  function step(dt) {
    time += dt;
    var i, j, a, b, c;

    // cubes fall, then rest on the floor
    for (i = cubes.length - 1; i >= 0; i--) {
      c = cubes[i];
      if (c.gone) { cubes.splice(i, 1); continue; }
      if (!c.rest) {
        c.vy = Math.min(c.vy + 900 * dt, 600); c.y += c.vy * dt; c.rot += c.spin * dt;
        if (c.y >= FLOOR - 34) { c.y = FLOOR - 34; c.rest = true; c.rot = Math.round(c.rot / 90) * 90; }
      }
      c.node.setAttribute("transform", "translate(" + c.x + " " + c.y + ") rotate(" + c.rot + ")");
    }
    if (!closing && time > nextAuto && !cubes.length && time - lastDrop > 2.2) { drop(rand(W * 0.12, W * 0.88), -70); nextAuto = time + rand(3.4, 5.2); }

    for (i = 0; i < actors.length; i++) {
      a = actors[i];
      var onFloor = a.y <= 0, want = 0;
      if (a.cube && a.cube.gone) a.cube = null;
      if (!a.cube && a.mode !== "enter") {
        // a cube nobody is racing for (its racers were busy, or it fell while everyone was entering)
        for (j = 0; j < cubes.length; j++) {
          var racers = 0;
          for (var r2 = 0; r2 < actors.length; r2++) if (actors[r2].cube === cubes[j]) racers++;
          if (!cubes[j].gone && racers < 2) { a.cube = cubes[j]; break; }
        }
      }
      c = a.cube;

      if (a.stun > 0) {
        a.stun -= dt;
        if (onFloor) a.vx *= Math.max(0, 1 - 5 * dt);
      } else {
        if (c && a.mode !== "enter") { a.mode = "chase"; a.goal = c.x + (a.x < c.x ? -48 : 48); a.then = null; a.shout = 0; a.peer = 0; }
        else if (!c && a.mode === "chase") { a.mode = "idle"; a.goal = null; a.wait = rand(0.3, 1.3); }

        if (a.mode === "idle" && a.goal == null && onFloor) {
          a.wait -= dt;
          if (a.hops > 0 && a.y <= 0 && a.wait < 1.2) { a.hops--; a.jump(0.5); }
          if (a.wait <= 0 && a.shout <= 0 && a.peer <= 0) idle(a);
        }
        if (a.goal != null) {
          var dx = a.goal - a.x;
          if (Math.abs(dx) > 16) { a.dir = sign(dx); want = a.dir * a.k.speed * (a.mode === "chase" ? 1.18 : 1); }
          else if (a.mode !== "chase") {
            var after = a.then;
            a.goal = null; a.then = null; a.mode = "idle"; a.wait = rand(0.7, 2.2);
            if (after) after();
          }
        }
        if (onFloor) a.vx += (want - a.vx) * Math.min(1, dt * 9);

        // jump for a cube that is still in the air above
        if (onFloor && c && !c.rest && Math.abs(c.x - a.x) < 120) {
          var up = (FLOOR - c.y) - a.tall;
          if (up > 20 && up < a.apex() * 0.92) a.jump(clamp(Math.sqrt((up + 90) / a.apex()), 0.5, 1));
        }
        // leap over whoever stands in the way
        if (onFloor && Math.abs(a.vx) > 220 && a.goal != null) {
          for (j = 0; j < actors.length; j++) {
            b = actors[j];
            if (b === a || b.y > 70) continue;
            var ahead = (b.x - a.x) * a.dir;
            if (ahead > 40 && ahead < 150 + b.half && (a.goal - b.x) * a.dir > 50) {
              a.jump(1); b.look(a, 0.7); if (b.y <= 0) b.sq = Math.min(b.sq, -0.12);
              break;
            }
          }
        }
        // two idle brownies do not stand inside each other
        if (onFloor && a.goal == null) {
          for (j = 0; j < actors.length; j++) {
            b = actors[j];
            if (b === a || b.y > 0) continue;
            var gap = a.half + b.half + 34 - Math.abs(a.x - b.x);
            if (gap > 0) a.vx += sign(a.x - b.x || (a.i - b.i)) * gap * 22 * dt;
          }
        }
      }

      // Fudge's shout: the wave leaves the megaphone and whoever is in front jumps
      if (a.shout > 0) {
        a.shout -= dt;
        if (!a.blasted && a.shout < 0.7) {
          a.blasted = true;
          for (j = 0; j < actors.length; j++) {
            b = actors[j];
            var front = (b.x - a.x) * a.dir;
            if (b === a || front < 0 || front > 720 || b.mode === "enter") continue;
            b.stun = 0.6; b.vx = a.dir * 620 * (1 - front / 900); b.goal = null; b.then = null; b.mode = "idle"; b.wait = rand(0.9, 1.6);
            if (b.y <= 0) b.jump(0.52);
            b.say("o", 0.9); b.look(a, 1.2);
          }
        }
      }
      if (a.peer > 0) a.peer -= dt;

      // move
      a.x += a.vx * dt;
      if (!onFloor) {
        a.vy -= G * dt; a.y += a.vy * dt;
        if (a.y <= 0) {
          var hit = -a.vy;
          a.y = 0; a.vy = 0; a.sq = -clamp(hit / 5200, 0.08, 0.26); a.sqv = 0;
          if (hit > 900) { spark(a.x - a.half * 0.7, FLOOR - 6, rand(-260, -120), rand(-220, -90), rand(4, 7), 0.4); spark(a.x + a.half * 0.7, FLOOR - 6, rand(120, 260), rand(-220, -90), rand(4, 7), 0.4); }
        }
      }
      if (a.mode === "enter") { if (a.x > 130 && a.x < W - 130) a.mode = "go"; }
      else a.x = clamp(a.x, a.half + 70, W - a.half - 70);

      // a cube within reach of the mouth is eaten
      for (j = 0; j < cubes.length; j++) {
        c = cubes[j];
        if (c.gone || a.stun > 0) continue;
        if (Math.abs(c.x - a.x) < a.half + 44 && Math.abs((FLOOR - c.y) - (a.y + a.tall * 0.55)) < a.tall * 0.5 + 44) eat(a, c);
      }

      pose(a, dt);
    }

    // the name tags follow their brownies but never sit on top of each other
    for (i = 0; i < order.length - 1; i++) if (order[i].x > order[i + 1].x + 50) { var sw = order[i]; order[i] = order[i + 1]; order[i + 1] = sw; }
    var room = (small ? 66 : 128) / PX, want2 = order.map(function (o) { return o.x; });
    for (var pass = 0; pass < 8; pass++) {
      for (i = 1; i < order.length; i++) {
        var lack = room - (want2[i] - want2[i - 1]);
        if (lack > 0) { want2[i - 1] -= lack / 2; want2[i] += lack / 2; }
      }
      want2[0] = Math.max(want2[0], room / 2); want2[order.length - 1] = Math.min(want2[order.length - 1], W - room / 2);
    }
    for (i = 0; i < order.length; i++) {
      a = order[i];
      a.tx = a.tx ? a.tx + (want2[i] - a.tx) * Math.min(1, dt * 14) : want2[i];
      a.tag.setAttribute("transform", "translate(" + a.tx + " " + FLOOR + ")");
    }

    for (i = bits.length - 1; i >= 0; i--) {
      var p = bits[i];
      p.life -= dt; p.vy += 1900 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.life <= 0 || p.y > FLOOR + 20) { bitsG.removeChild(p.node); bits.splice(i, 1); continue; }
      p.node.setAttribute("cx", p.x); p.node.setAttribute("cy", p.y); p.node.setAttribute("opacity", clamp(p.life / p.all * 1.6, 0, 1));
    }
  }

  // ---- how a brownie looks this frame ----
  function pose(a, dt) {
    var f = a.k.front, flip = a.dir * f, onFloor = a.y <= 0, running = onFloor && Math.abs(a.vx) > 40;
    var legL = 0, legR = 0, bob = 0, lean = 0, armL = 0, armR = 0;

    if (running) {
      a.phase += Math.abs(a.vx) * dt * 0.036;
      var s = Math.sin(a.phase);
      legL = s * 38; legR = -s * 38; bob = Math.abs(s) * 9; lean = 9 * clamp(Math.abs(a.vx) / a.k.speed, 0, 1);
      armL = -s * 16; armR = s * 16;
    } else if (!onFloor) {
      var t = clamp(a.vy / a.k.jump, -1, 1);
      legL = (t > 0 ? 44 : 14) * f; legR = (t > 0 ? -30 : -22) * f; lean = 6 * t;
      armL = -22 * t; armR = 22 * t;
    } else {
      a.phase += dt * 2.2;
    }
    if (a.peer > 0) lean = 13;
    if (a.wave > 0) { a.wave -= dt; var wv = Math.sin(time * 17) * 24; armL += wv; armR -= wv; }
    a.lean += (lean - a.lean) * Math.min(1, dt * 12);

    // squash and stretch: a damped spring around 0
    a.sqv += (-420 * a.sq - 24 * a.sqv) * dt; a.sq += a.sqv * dt;
    var breathe = onFloor && !running ? Math.sin(a.phase) * 0.012 : 0;
    var sy = 1 + a.sq + breathe, sx = 1 - a.sq * 0.7;

    a.g.setAttribute("transform", "translate(" + a.x + " " + (FLOOR - a.y) + ") scale(" + flip + " 1)");
    a.top.setAttribute("transform", "translate(0 " + (-bob) + ") rotate(" + (a.lean * f) + " 200 292) translate(200 292) scale(" + sx + " " + sy + ") translate(-200 -292)");
    a.legL.setAttribute("transform", "rotate(" + legL + " " + a.pLegL + ")");
    a.legR.setAttribute("transform", "rotate(" + legR + " " + a.pLegR + ")");
    if (a.freeL) a.armL.setAttribute("transform", "rotate(" + armL + " " + a.pArmL + ")");
    if (a.freeR) a.armR.setAttribute("transform", "rotate(" + armR + " " + a.pArmR + ")");

    // eyes: a blink now and then, and the pupils follow what the brownie is looking at
    a.blinkIn -= dt;
    if (a.blinkIn <= 0) { a.blink = 0.12; a.blinkIn = rand(1.6, 4.5); }
    if (a.blink > 0) { a.blink -= dt; a.eyes.setAttribute("transform", "translate(0 " + a.eyeY + ") scale(1 0.08) translate(0 " + (-a.eyeY) + ")"); }
    else if (a.eyes.hasAttribute("transform")) a.eyes.removeAttribute("transform");
    var gx = 0, gy = 0;
    if (a.gazeT > 0 && a.gaze && !a.gaze.gone) {
      a.gazeT -= dt;
      var ty = a.gaze.tall ? FLOOR - a.gaze.y - a.gaze.tall * 0.6 : a.gaze.y;
      var ddx = (a.gaze.x - a.x) * flip, ddy = ty - (FLOOR - a.y - a.tall * 0.62), d = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
      gx = ddx / d * 7 - a.h.look[0] * 0.6; gy = ddy / d * 7 - a.h.look[1] * 0.6;
    }
    a.pupils.setAttribute("transform", "translate(" + gx + " " + gy + ")");

    // mouth: chewing, a face asked for by the scene, or its own
    var mouth = a.own;
    if (a.chomp > 0) { a.chomp -= dt; mouth = Math.floor(a.chomp / 0.09) % 2 ? "open" : "smile"; }
    else if (a.faceT > 0) { a.faceT -= dt; mouth = a.face; }
    else if (a.mode === "chase" && !onFloor) mouth = "open";
    if (mouth !== a.shown && a.mouths[mouth]) { a.mouths[a.shown].setAttribute("display", "none"); a.mouths[mouth].removeAttribute("display"); a.shown = mouth; }

    if (a.waves) {
      var loud = a.shout > 0 && a.shout < 0.85;
      if (loud) { a.waves.removeAttribute("display"); a.waves.setAttribute("opacity", 0.55 + 0.45 * Math.sin(time * 40)); }
      else if (!a.waves.hasAttribute("display")) a.waves.setAttribute("display", "none");
    }
  }

  // ---- start ----
  for (var n = 0; n < M.team.length; n++) actors.push(new Actor(M.team[n], n));
  measure();
  order = actors.slice();
  var spots = [0.2, 0.42, 0.63, 0.83], fromLeft = [true, true, false, false], lag = [0, 420, 380, 0];
  actors.forEach(function (a, i) {
    a.x = fromLeft[i] ? -260 - lag[i] : W + 260 + lag[i];
    a.dir = fromLeft[i] ? 1 : -1; a.goal = W * spots[i]; a.wait = rand(0.6, 1.4);
  });

  var last = 0, running = true;
  function frame(now) {
    if (!running) return;
    var dt = last ? Math.min((now - last) / 1000, 0.034) : 0.016;
    last = now;
    step(dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  window.addEventListener("resize", measure);

  // ---- the visitor ----
  var hint = doc.getElementById("introHint"), enter = doc.getElementById("introEnter");
  var coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  if (hint) hint.textContent = (coarse ? "Tap" : "Click") + " anywhere to drop SUGAR.";
  var behind = doc.querySelectorAll("body > header, body > main, body > footer");
  for (var k = 0; k < behind.length; k++) behind[k].inert = true;

  var downY = null;
  el.addEventListener("pointerdown", function (e) {
    if (e.target.closest && e.target.closest("button, a")) return;
    downY = e.clientY;
    var r = el.getBoundingClientRect();
    drop((e.clientX - r.left) / PX, (e.clientY - r.top) / PX);
  });
  el.addEventListener("pointerup", function (e) { if (downY != null && downY - e.clientY > 80) close(); downY = null; });
  el.addEventListener("wheel", function (e) { if (e.deltaY > 12) close(); }, { passive: true });
  doc.addEventListener("keydown", onKey);
  function onKey(e) { if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); close(); } }
  if (enter) enter.addEventListener("click", close);

  // the curtain goes up: the intro slides away and the page under it is live again
  function close() {
    if (closing) return;
    closing = true;
    try { sessionStorage.setItem("browniesIntro", "1"); } catch (e) {}
    doc.removeEventListener("keydown", onKey);
    for (var i = 0; i < actors.length; i++) { actors[i].stun = 0; actors[i].jump(0.7); actors[i].wave = 1; }
    for (var j = 0; j < behind.length; j++) behind[j].inert = false;
    el.classList.add("out");
    html.classList.remove("intro-on");
    var done = function () { running = false; window.removeEventListener("resize", measure); if (el.parentNode) el.parentNode.removeChild(el); };
    el.addEventListener("transitionend", function (e) { if (e.target === el) done(); });
    setTimeout(done, 1100);
  }

  // for the browser tests
  window.BrowniesIntro = { drop: function (fx) { drop(W * fx, -70); }, close: close, state: function () { return { actors: actors.map(function (a) { return { id: a.h.id, x: Math.round(a.x), y: Math.round(a.y), score: a.score, mode: a.mode }; }), cubes: cubes.length, w: Math.round(W) }; } };
})();
