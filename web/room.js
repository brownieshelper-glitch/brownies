/* The room: the four brownies at work, live.

   A kitchen at night drawn in SVG: the wall screen with the day's numbers and the last two weeks of work, the
   rules board, the clock, the jobs board, four stations (Fudge's megaphone desk, Crumb's headset desk, Nib's lab
   bench, Chip's workbench by the oven), a sofa, plants and the sugar jars. The brownies are the drawings from
   mascot.js (Mascot.rig) moved by one requestAnimationFrame loop, like the intro: they walk to their stations when
   the gateway says they are working, wander and chat when they rest, and when a new report lands its brownie walks
   to the wall, data lines run from it to the screen and a speech bubble reads the report.

   Data: GET /api/team/summary (what each brownie is doing, today's and total reports), /api/team/activity (the
   reports), /api/team/towers (the bricks) and /jobs/totals (the board), all public. ?demo=1 runs on made-up data
   with a report every few seconds, for a look without waiting for the brownies.

   The visitor: click a brownie or its card to read its day; click the floor to drop a sugar cube (the nearest free
   brownie fetches it); Lights turns the night room into a day room; Ring the bell calls everyone to the sofa. */
(async () => {
  const B = window.Brownies, M = window.Mascot;
  if (!B || !M) return;
  const $ = (id) => document.getElementById(id);
  const stageEl = $("stage"), svg = $("scene");
  if (!stageEl || !svg) return;
  const params = new URLSearchParams(location.search);
  const demo = params.get("demo") === "1";
  const reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const S = await B.load();

  // ---------- the world ----------
  const W = 1600, H = 900, WALL = 520;                 // the wall ends and the floor starts at y = 520
  const SVG = "http://www.w3.org/2000/svg";
  const mk = (tag, attrs, parent) => { const n = document.createElementNS(SVG, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); if (parent) parent.appendChild(n); return n; };
  const text = (x, y, s, cls, parent, attrs = {}) => { const t = mk("text", { x, y, class: cls, ...attrs }, parent); t.textContent = s; return t; };
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const sign = (v) => (v < 0 ? -1 : 1);
  const depth = (y) => 0.30 + 0.17 * clamp((y - 560) / 320, 0, 1);   // how big a brownie is at that floor line
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
  svg.classList.add("scene");

  const L = {};                                       // the layers, back to front
  for (const name of ["back", "wall", "furniture", "flows", "cubes", "actors", "bubbles", "hits"]) L[name] = mk("g", { class: "layer-" + name }, svg);

  // ---------- the back wall and the floor ----------
  mk("rect", { class: "wall", x: 0, y: 0, width: W, height: WALL }, L.back);
  mk("rect", { class: "wall-dark", x: 0, y: 0, width: W, height: 70 }, L.back);
  mk("rect", { class: "skirting", x: 0, y: WALL - 14, width: W, height: 16 }, L.back);
  mk("rect", { class: "floor", x: 0, y: WALL, width: W, height: H - WALL }, L.back);
  for (let i = 1; i < 10; i++) {                      // the boards of the floor run to the back
    const xb = (i / 10) * W, xt = 800 + (xb - 800) * 0.62;
    mk("line", { class: "floor-line", x1: xb, y1: H, x2: xt, y2: WALL }, L.back);
  }
  for (let t = 0.12; t < 1; t += 0.14) mk("line", { class: "floor-line", x1: 0, y1: WALL + (H - WALL) * Math.pow(t, 1.5), x2: W, y2: WALL + (H - WALL) * Math.pow(t, 1.5) }, L.back);

  // ---------- the wall screen ----------
  const SCREEN = { x: 470, y: 46, w: 660, h: 262 };
  const screenG = mk("g", { class: "screen-g" }, L.wall);
  mk("rect", { class: "screen", x: SCREEN.x, y: SCREEN.y, width: SCREEN.w, height: SCREEN.h, rx: 14 }, screenG);
  const screenArea = mk("path", { class: "screen-area", d: "" }, screenG);
  const screenLine = mk("path", { class: "screen-line", d: "" }, screenG);
  const screenTop = text(SCREEN.x + 22, SCREEN.y + 34, "", "screen-label", screenG);
  const screenBig = text(SCREEN.x + 22, SCREEN.y + 96, "", "screen-big", screenG);
  const screenSub = text(SCREEN.x + 22, SCREEN.y + 124, "", "screen-text", screenG);
  const screenRight = text(SCREEN.x + SCREEN.w - 22, SCREEN.y + 96, "", "screen-big", screenG, { "text-anchor": "end" });
  const screenRightSub = text(SCREEN.x + SCREEN.w - 22, SCREEN.y + 124, "", "screen-text", screenG, { "text-anchor": "end" });
  const screenFoot = text(SCREEN.x + 22, SCREEN.y + SCREEN.h - 18, "", "screen-label", screenG);
  const screenFlash = mk("rect", { x: SCREEN.x, y: SCREEN.y, width: SCREEN.w, height: SCREEN.h, rx: 14, fill: "#FF5A1F", opacity: 0, "pointer-events": "none" }, screenG);
  // a banner either side, like a kitchen's pennants
  for (const bx of [410, 1170]) { mk("path", { d: `M${bx} 40 h40 v120 l-20 24 l-20 -24 z`, fill: "#FF5A1F", stroke: "#2A1710", "stroke-width": 4 }, L.wall); }

  // ---------- the clock ----------
  const clockG = mk("g", {}, L.wall);
  mk("circle", { class: "clock-face", cx: 1330, cy: 118, r: 46 }, clockG);
  const hourHand = mk("line", { class: "clock-hand", x1: 1330, y1: 118, x2: 1330, y2: 92 }, clockG);
  const minHand = mk("line", { class: "clock-hand", x1: 1330, y1: 118, x2: 1330, y2: 84 }, clockG);
  mk("circle", { cx: 1330, cy: 118, r: 5, fill: "#2A1710" }, clockG);
  mk("rect", { class: "plate", x: 1276, y: 174, width: 108, height: 24, rx: 6 }, clockG);
  text(1330, 191, "LOCAL TIME", "plate-text", clockG, { "text-anchor": "middle" });
  function tickClock() {
    const d = new Date(), h = d.getHours() % 12 + d.getMinutes() / 60, m = d.getMinutes();
    const ha = h / 12 * Math.PI * 2, ma = m / 60 * Math.PI * 2;
    hourHand.setAttribute("x2", 1330 + Math.sin(ha) * 26); hourHand.setAttribute("y2", 118 - Math.cos(ha) * 26);
    minHand.setAttribute("x2", 1330 + Math.sin(ma) * 36); minHand.setAttribute("y2", 118 - Math.cos(ma) * 36);
  }
  tickClock(); setInterval(tickClock, 30000);

  // ---------- the rules board ----------
  const rulesG = mk("g", {}, L.wall);
  mk("rect", { class: "rules-board", x: 1216, y: 226, width: 344, height: 250, rx: 10 }, rulesG);
  text(1236, 254, "THE RULES, FIXED IN CODE", "rules-head", rulesG);
  ["2% tax on every trade", "35% to stakers, as SUGAR", "35% to the protocol", "30% to the brownies", "1 SUGAR pays for 1 dollar of AI", "1/30 of the vault a day", "3 days of voting on a skill"].forEach((s, i) => text(1236, 286 + i * 27, s, "rules-text", rulesG));

  // ---------- the jobs board and the sugar jars ----------
  const boardG = mk("g", {}, L.wall);
  mk("rect", { class: "board", x: 60, y: 60, width: 330, height: 236, rx: 10 }, boardG);
  mk("rect", { class: "plate", x: 60, y: 300, width: 330, height: 26, rx: 6 }, boardG);
  const boardLabel = text(225, 318, "THE BOARD", "plate-text", boardG, { "text-anchor": "middle" });
  const notesG = mk("g", {}, boardG);
  function drawNotes(n) {
    notesG.replaceChildren();
    const count = clamp(n, 0, 12);
    for (let i = 0; i < count; i++) {
      const col = i % 4, row = Math.floor(i / 4), x = 80 + col * 78 + (i % 2) * 4, y = 80 + row * 70 + ((i * 7) % 3) * 3;
      mk("rect", { class: "note", x, y, width: 62, height: 54, rx: 3, transform: `rotate(${((i * 13) % 7) - 3} ${x + 31} ${y + 27})` }, notesG);
      mk("circle", { class: "pin", cx: x + 31, cy: y + 7, r: 5 }, notesG);
      for (let k = 0; k < 3; k++) mk("rect", { x: x + 10, y: y + 20 + k * 9, width: 42 - k * 8, height: 3, rx: 1.5, fill: "#D8CAB3" }, notesG);
    }
    boardLabel.textContent = count ? `THE BOARD  ${n} OPEN` : "THE BOARD  EMPTY";
  }
  drawNotes(0);
  const shelfG = mk("g", {}, L.wall);
  mk("rect", { x: 60, y: 420, width: 330, height: 12, rx: 4, fill: "#2A1710" }, shelfG);
  for (let i = 0; i < 4; i++) {
    const x = 92 + i * 80;
    mk("rect", { class: "jar", x, y: 356, width: 50, height: 64, rx: 8 }, shelfG);
    mk("rect", { class: "jar-lid", x: x - 4, y: 348, width: 58, height: 14, rx: 5 }, shelfG);
    for (let k = 0; k < 5; k++) mk("rect", { class: "sugar", x: x + 7 + (k % 3) * 13, y: 392 + Math.floor(k / 3) * 12 - (i % 2) * 6, width: 10, height: 10, rx: 2 }, shelfG);
  }
  text(225, 452, "SUGAR", "plate-text", shelfG, { "text-anchor": "middle", fill: "#C9B8A8" });

  // ---------- the furniture on the floor ----------
  // a station: a desk with a monitor, a name plate, and a spot in front where its brownie stands
  const STATIONS = {
    fudge: { x: 330, y: 650, label: "POSTS", flip: 1 },
    crumb: { x: 1270, y: 650, label: "ANSWERS", flip: -1 },
    nib: { x: 440, y: 820, label: "NOTES", flip: 1 },
    chip: { x: 1130, y: 820, label: "BUILDS", flip: -1 },
  };
  const monitors = {};
  function desk(id, st) {
    const s = depth(st.y) / 0.47, w = 260 * s, h = 92 * s, x = st.x - w / 2, y = st.y - h;
    const g = mk("g", { class: "station", "data-id": id }, L.furniture);
    mk("ellipse", { class: "lamp-light", cx: st.x, cy: st.y - 120 * s, rx: 230 * s, ry: 150 * s }, g);
    mk("rect", { class: "desk-dark", x: x + 14 * s, y: y + 20 * s, width: 18 * s, height: h - 14 * s, rx: 4, stroke: "#2A1710", "stroke-width": 4 }, g);
    mk("rect", { class: "desk-dark", x: x + w - 32 * s, y: y + 20 * s, width: 18 * s, height: h - 14 * s, rx: 4, stroke: "#2A1710", "stroke-width": 4 }, g);
    mk("rect", { class: "desk", x, y, width: w, height: 24 * s, rx: 8 }, g);
    const mw = 150 * s, mh = 96 * s, mx = st.x - mw / 2, my = y - mh - 10 * s;
    mk("rect", { class: "monitor", x: st.x - 10 * s, y: y - 12 * s, width: 20 * s, height: 14 * s }, g);
    mk("rect", { class: "monitor", x: mx, y: my, width: mw, height: mh, rx: 10 }, g);
    const label = text(mx + 12 * s, my + 20 * s, st.label, "monitor-text", g, { "font-size": 11 * s, "letter-spacing": "0.08em" });
    const big = text(mx + 12 * s, my + 72 * s, "0", "screen-big", g, { "font-size": 40 * s });
    const bars = [];
    for (let i = 0; i < 7; i++) bars.push(mk("rect", { class: "monitor-bar", x: mx + mw - 12 * s - (7 - i) * 11 * s, y: my + mh - 14 * s, width: 7 * s, height: 4 * s, rx: 1.5 }, g));
    mk("rect", { class: "plate", x: st.x - 46 * s, y: y + 30 * s, width: 92 * s, height: 20 * s, rx: 5 }, g);
    text(st.x, y + 44 * s, id.toUpperCase(), "plate-text", g, { "text-anchor": "middle", "font-size": 12 * s });
    const hit = mk("rect", { class: "hit", x: x - 10, y: my - 10, width: w + 20, height: st.y - my + 20 }, L.hits);
    hit.addEventListener("click", () => openDrawer(id));
    monitors[id] = { big, bars, s, label };
  }
  for (const [id, st] of Object.entries(STATIONS)) desk(id, st);
  // the oven by Chip's bench
  (function oven() {
    const g = mk("g", {}, L.furniture), x = 1380, y = 840, s = 0.9;
    mk("rect", { class: "oven", x: x + 70 * s, y: y - 300 * s, width: 40 * s, height: 90 * s, rx: 8 }, g);
    mk("rect", { class: "oven", x, y: y - 220 * s, width: 260 * s, height: 220 * s, rx: 24 }, g);
    mk("rect", { class: "oven-door", x: x + 38 * s, y: y - 164 * s, width: 184 * s, height: 110 * s, rx: 16 }, g);
    mk("rect", { class: "oven-window", x: x + 92 * s, y: y - 132 * s, width: 76 * s, height: 50 * s, rx: 6 }, g);
    for (let k = 0; k < 3; k++) mk("circle", { class: "oven-light", cx: x + 54 * s + k * 34 * s, cy: y - 190 * s, r: 8 * s }, g);
    mk("rect", { class: "plate", x: x + 84 * s, y: y - 32 * s, width: 92 * s, height: 20 * s, rx: 5 }, g);
    text(x + 130 * s, y - 18 * s, "THE OVEN", "plate-text", g, { "text-anchor": "middle", "font-size": 11 });
  })();
  // the sofa, front and centre
  (function sofa() {
    const g = mk("g", {}, L.furniture), x = 660, y = 884;
    mk("rect", { class: "sofa-dark", x: x + 10, y: y - 92, width: 260, height: 50, rx: 14, stroke: "#2A1710", "stroke-width": 5 }, g);
    mk("rect", { class: "sofa", x: x - 10, y: y - 56, width: 300, height: 44, rx: 14 }, g);
    mk("rect", { class: "sofa", x: x - 24, y: y - 76, width: 34, height: 64, rx: 12 }, g);
    mk("rect", { class: "sofa", x: x + 270, y: y - 76, width: 34, height: 64, rx: 12 }, g);
  })();
  function plant(x, y, s) {
    const g = mk("g", {}, L.furniture);
    for (const [dx, dy, rot] of [[-26, -70, -30], [0, -92, 0], [26, -70, 30], [-10, -50, -10], [12, -52, 12]]) mk("ellipse", { class: "leaf", cx: x + dx * s, cy: y + dy * s, rx: 16 * s, ry: 30 * s, transform: `rotate(${rot} ${x + dx * s} ${y + dy * s})` }, g);
    mk("path", { class: "plant-pot", d: `M${x - 30 * s} ${y - 36 * s} h${60 * s} l${-8 * s} ${36 * s} h${-44 * s} z` }, g);
  }
  plant(120, 870, 1.1); plant(1560, 760, 0.85); plant(930, 700, 0.75);

  // ---------- the brownies ----------
  const actors = [], byId = {};
  function Actor(h, i) {
    const g = mk("g", { class: "actor", "data-id": h.id }, L.actors);
    g.innerHTML = M.rig(h);
    const q = (sel) => g.querySelector(sel), piv = (n) => (n ? n.getAttribute("data-pivot") : "0 0");
    this.h = h; this.i = i; this.g = g;
    this.legL = q(".leg.l"); this.legR = q(".leg.r"); this.top = q(".top"); this.eyes = q(".eyes"); this.pupils = q(".pupils"); this.waves = q(".waves");
    this.armL = q(".arm.l"); this.armR = q(".arm.r");
    this.pLegL = piv(this.legL); this.pLegR = piv(this.legR); this.pArmL = piv(this.armL); this.pArmR = piv(this.armR);
    this.eyeY = +piv(this.eyes).split(" ")[1];
    this.freeL = this.armL && !this.armL.hasAttribute("data-still"); this.freeR = this.armR && !this.armR.hasAttribute("data-still");
    this.mouths = {}; for (const m of g.querySelectorAll(".mouth")) this.mouths[m.getAttribute("data-m")] = m;
    this.own = h.mouth || "smile"; this.shown = this.own;
    this.front = { fudge: -1, crumb: 1, nib: 1, chip: 1 }[h.id] || 1;
    this.half = h.w / 2; this.tall = h.h + 56;
    const st = STATIONS[h.id];
    this.x = st.x + (st.flip > 0 ? 70 : -70); this.y = st.y + 26; this.z = 0; this.vz = 0;
    this.goal = null; this.then = null; this.dir = -st.flip; this.phase = rand(0, 6); this.sq = 0; this.sqv = 0; this.lean = 0;
    this.mode = "work"; this.working = true; this.wait = rand(2, 5); this.wave = 0; this.type = 0; this.chomp = 0; this.faceT = 0; this.face = null;
    this.blinkIn = rand(1, 4); this.blink = 0; this.gaze = null; this.gazeT = 0;
    this.status = ""; this.last = null; this.today = 0; this.total = 0; this.cost = 0; this.lastAt = 0; this.sugar = 0; this.cube = null;
    this.queue = []; this.bubble = null; this.speed = 150;
    g.addEventListener("click", (e) => { e.stopPropagation(); openDrawer(h.id); });
    // a wide invisible body makes the brownie easy to click
    this.hit = mk("rect", { x: -this.half - 30, y: -this.tall - 40, width: this.half * 2 + 60, height: this.tall + 60, fill: "transparent" }, g);
  }
  Actor.prototype.goTo = function (x, y, then) { this.goal = { x: clamp(x, 60, W - 60), y: clamp(y, 560, 884) }; this.then = then || null; };
  Actor.prototype.hop = function (power) { if (this.z > 0) return; this.vz = 900 * (power || 1); this.z = 0.01; this.sq = 0.14; };
  Actor.prototype.say = function (mouth, seconds) { this.face = mouth; this.faceT = seconds || 0.6; };
  Actor.prototype.look = function (target, seconds) { this.gaze = target; this.gazeT = seconds || 1.5; };
  Actor.prototype.stationSpot = function () { const st = STATIONS[this.h.id]; return { x: st.x + (st.flip > 0 ? 70 : -70), y: st.y + 26, dir: -st.flip }; };

  for (let i = 0; i < M.team.length; i++) { const a = new Actor(M.team[i], i); actors.push(a); byId[a.h.id] = a; }

  // where a resting brownie goes: the sofa, a plant, the jars, a friend's desk
  const SPOTS = [{ x: 720, y: 880 }, { x: 860, y: 880 }, { x: 200, y: 800 }, { x: 1000, y: 740 }, { x: 600, y: 620 }, { x: 1480, y: 870 }, { x: 180, y: 600 }];
  function wander(a) {
    const r = Math.random();
    if (r < 0.5) { const s = SPOTS[Math.floor(Math.random() * SPOTS.length)]; a.goTo(s.x + rand(-40, 40), s.y + rand(-10, 10), () => { a.wait = rand(4, 9); }); }
    else if (r < 0.65) { const other = actors[Math.floor(Math.random() * actors.length)]; if (other !== a) a.goTo(other.x + sign(a.x - other.x) * 110, other.y + rand(-8, 8), () => { a.look(other, 2); a.wait = rand(3, 6); if (a.h.id === "nib") { a.say("o", 1); } }); else a.wait = 2; }
    else if (r < 0.8) { a.hop(rand(0.6, 0.9)); a.wait = rand(2, 4); }
    else if (a.h.id === "crumb") { a.wave = 1.6; a.hop(0.7); a.say("open", 1); a.wait = rand(3, 5); }
    else if (a.h.id === "fudge") { a.shout = 1.1; a.say("open", 1); a.wait = rand(3, 5); }
    else { a.wave = 1.4; a.wait = rand(3, 6); }
  }

  // ---------- speech bubbles ----------
  function wrap(s, max) {
    const words = String(s).split(/\s+/), lines = [""];
    for (const w of words) { const cur = lines[lines.length - 1]; if (cur && (cur + " " + w).length > max) { if (lines.length >= 2) { lines[1] = lines[1].replace(/\s*\S*$/, "") + "..."; return lines; } lines.push(w); } else lines[lines.length - 1] = cur ? cur + " " + w : w; }
    return lines;
  }
  function speak(a, line, who, seconds) {
    if (a.bubble) { L.bubbles.removeChild(a.bubble.g); a.bubble = null; }
    const lines = wrap(line, 34), g = mk("g", { class: "bubble-g" }, L.bubbles);
    const wdt = Math.max(140, Math.max(...lines.map((l) => l.length)) * 10.4 + 36), hgt = 24 + lines.length * 24 + (who ? 18 : 0);
    const box = mk("rect", { class: "bubble", x: -wdt / 2, y: -hgt, width: wdt, height: hgt, rx: 14 }, g);
    mk("path", { class: "bubble", d: `M-12 ${-1} L0 16 L12 ${-1} Z`, "stroke-linejoin": "round" }, g);
    mk("rect", { x: -14, y: -4, width: 28, height: 6, fill: "#FFFBF4" }, g);   // hides the tail's top edge
    if (who) text(-wdt / 2 + 16, -hgt + 20, who.toUpperCase(), "bubble-who", g);
    lines.forEach((l, i) => text(-wdt / 2 + 16, -hgt + (who ? 40 : 26) + i * 24, l, "bubble-text", g));
    a.bubble = { g, box, w: wdt, h: hgt, t: seconds || 5 };
  }

  // ---------- data lines from a brownie to the wall screen ----------
  const flows = [];
  function flow(a) {
    const s = depth(a.y), sx = a.x, sy = a.y - a.z - a.tall * s * 0.7;
    for (let k = 0; k < 4; k++) {
      const ex = SCREEN.x + 40 + Math.random() * (SCREEN.w - 80), ey = SCREEN.y + 40 + Math.random() * (SCREEN.h - 80);
      const mx = (sx + ex) / 2 + rand(-120, 120), my = Math.min(sy, ey) - rand(20, 140);
      const d = `M${sx} ${sy} Q${mx} ${my} ${ex} ${ey}`;
      const p = mk("path", { class: "flow", d }, L.flows);
      const len = p.getTotalLength();
      p.style.strokeDasharray = `${len}`; p.style.strokeDashoffset = `${len}`;
      const dot = mk("circle", { class: "flow-dot", r: 6 }, L.flows);
      const node = mk("circle", { class: "flow-dot", r: 7, cx: ex, cy: ey, opacity: 0 }, L.flows);
      flows.push({ p, dot, node, len, t: -k * 0.12, life: 1.9 });
    }
    screenFlash.setAttribute("opacity", 0.35);
  }
  function stepFlows(dt) {
    for (let i = flows.length - 1; i >= 0; i--) {
      const f = flows[i]; f.t += dt;
      if (f.t < 0) continue;
      const k = clamp(f.t / 0.9, 0, 1);
      f.p.style.strokeDashoffset = `${f.len * (1 - k)}`;
      const at = f.p.getPointAtLength(f.len * k);
      f.dot.setAttribute("cx", at.x); f.dot.setAttribute("cy", at.y);
      if (k >= 1) { f.node.setAttribute("opacity", 1); f.dot.setAttribute("opacity", 0); }
      if (f.t > f.life - 0.6) { const o = clamp((f.life - f.t) / 0.6, 0, 1); f.p.setAttribute("opacity", o); f.node.setAttribute("opacity", o); }
      if (f.t > f.life) { L.flows.removeChild(f.p); L.flows.removeChild(f.dot); L.flows.removeChild(f.node); flows.splice(i, 1); }
    }
    const fo = Number(screenFlash.getAttribute("opacity")) || 0;
    if (fo > 0) screenFlash.setAttribute("opacity", Math.max(0, fo - dt * 0.6));
  }

  // ---------- sugar cubes on the floor ----------
  const cubes = [];
  function dropCube(x, y) {
    if (cubes.length >= 4) return;
    const c = { x: clamp(x, 60, W - 60), floor: clamp(y, 570, 884), yy: Math.min(y, 300), vy: 0, rest: false, gone: false, rot: rand(-25, 25), spin: rand(-120, 120) };
    c.g = mk("g", { class: "cube" }, L.cubes);
    mk("rect", { class: "cube-body", x: -24, y: -24, width: 48, height: 48, rx: 9 }, c.g);
    mk("rect", { class: "cube-dot", x: -12, y: -12, width: 10, height: 10, rx: 3 }, c.g);
    cubes.push(c);
    let best = null, bd = 1e9;
    for (const a of actors) { if (a.cube || a.mode === "report") continue; const d = Math.hypot(a.x - c.x, a.y - c.floor); if (d < bd) { bd = d; best = a; } }
    if (best) { best.cube = c; best.mode = "fetch"; best.goTo(c.x + sign(best.x - c.x) * 40, c.floor); best.look(c, 6); best.say("o", 0.5); }
    for (const a of actors) if (a !== best) a.look(c, 3);
  }
  function eat(a, c) {
    c.gone = true; L.cubes.removeChild(c.g); a.cube = null; a.sugar++; sugarEaten++;
    a.chomp = 0.7; a.hop(0.6); a.wave = 1.2; a.mode = a.working ? "work" : "wander"; a.goal = null; a.wait = rand(1.5, 3);
    speak(a, a.sugar === 1 ? "Sugar!" : `Sugar! That is ${a.sugar} for me.`, null, 2.5);
    renderKitchenCard();
  }

  // ---------- one step of the world ----------
  let time = 0, bell = 0, sugarEaten = 0;
  function step(dt) {
    time += dt;
    // cubes fall
    for (let i = cubes.length - 1; i >= 0; i--) {
      const c = cubes[i];
      if (c.gone) { cubes.splice(i, 1); continue; }
      if (!c.rest) { c.vy = Math.min(c.vy + 1400 * dt, 900); c.yy += c.vy * dt; c.rot += c.spin * dt; if (c.yy >= c.floor - 20) { c.yy = c.floor - 20; c.rest = true; c.rot = Math.round(c.rot / 90) * 90; } }
      const s = depth(c.floor);
      c.g.setAttribute("transform", `translate(${c.x} ${c.yy}) scale(${s * 1.4}) rotate(${c.rot})`);
    }
    for (const a of actors) {
      const s = depth(a.y);
      a.speed = 150 + 120 * s;
      // what to do next
      if (a.goal == null && a.z <= 0) {
        a.wait -= dt;
        if (a.wait <= 0) {
          if (a.mode === "report") { /* handled by the report flow */ }
          else if (a.mode === "fetch") { if (!a.cube || a.cube.gone) { a.mode = a.working ? "work" : "wander"; a.cube = null; } else a.goTo(a.cube.x + sign(a.x - a.cube.x) * 40, a.cube.floor); a.wait = 1; }
          else if (a.mode === "sofa") { a.wait = rand(2, 4); if (Math.random() < 0.4) a.hop(0.6); }
          else if (a.working) {
            const sp = a.stationSpot();
            if (Math.hypot(a.x - sp.x, a.y - sp.y) > 30) a.goTo(sp.x, sp.y, () => { a.dir = sp.dir; a.wait = rand(6, 12); });
            else { a.dir = sp.dir; a.type = rand(3, 6); a.wait = rand(8, 16); if (a.status && Math.random() < 0.5) speak(a, a.status, null, 5); }
          } else {
            if (Math.random() < 0.25 && a.last) speak(a, a.last, "last report", 5);
            wander(a);
          }
        }
      }
      // walk toward the goal
      let vx = 0, vy = 0;
      if (a.goal) {
        const dx = a.goal.x - a.x, dy = a.goal.y - a.y, d = Math.hypot(dx, dy);
        if (d > 8) { vx = dx / d * a.speed; vy = dy / d * a.speed * 0.6; a.dir = Math.abs(dx) > 20 ? sign(dx) : a.dir; a.x += vx * dt; a.y += vy * dt; }
        else { const after = a.then; a.goal = null; a.then = null; if (after) after(); }
      }
      // a cube within reach is eaten
      if (a.cube && !a.cube.gone && a.cube.rest && Math.hypot(a.x - a.cube.x, a.y - a.cube.floor) < 70) eat(a, a.cube);
      // hops
      if (a.z > 0 || a.vz > 0) { a.vz -= 2600 * dt; a.z += a.vz * dt; if (a.z <= 0) { a.z = 0; a.vz = 0; a.sq = -0.14; } }
      // bubbles
      if (a.bubble) { a.bubble.t -= dt; if (a.bubble.t <= 0) { L.bubbles.removeChild(a.bubble.g); a.bubble = null; } }
      pose(a, dt, vx, vy, s);
    }
    // the brownies do not stand inside each other
    for (let i = 0; i < actors.length; i++) for (let j = i + 1; j < actors.length; j++) {
      const a = actors[i], b = actors[j], dx = a.x - b.x, dy = a.y - b.y, dist = Math.hypot(dx, dy * 2), min = 110;
      if (dist < min && dist > 0.1) { const push = (min - dist) * 2.2 * dt, nx = dx / dist, ny = dy / dist; a.x += nx * push; b.x -= nx * push; a.y += ny * push * 0.4; b.y -= ny * push * 0.4; }
    }
    // the drawing order follows the floor line: the brownie lower on the screen is in front
    const sorted = actors.slice().sort((p, q) => p.y - q.y);
    for (let i = 0; i < sorted.length; i++) if (L.actors.children[i] !== sorted[i].g) L.actors.appendChild(sorted[i].g);
    for (const a of actors) if (a.bubble) {
      const bs = depth(a.y), bx = clamp(a.x, a.bubble.w / 2 + 10, W - a.bubble.w / 2 - 10), by = a.y - a.z - a.tall * bs - 14;
      a.bubble.g.setAttribute("transform", `translate(${bx} ${Math.max(a.bubble.h + 8, by)})`);
      // the tail points at the brownie even when the box was pushed in from the edge
      const tail = a.bubble.g.children[1]; tail.setAttribute("transform", `translate(${clamp(a.x - bx, -a.bubble.w / 2 + 24, a.bubble.w / 2 - 24)} 0)`);
    }
    stepFlows(dt);
    if (bell > 0) { bell -= dt; if (bell <= 0) for (const a of actors) { a.mode = a.working ? "work" : "wander"; a.goal = null; a.wait = rand(0.5, 2); } }
  }

  // how a brownie looks this frame: walking legs, a bob, a lean, typing hands, a hop, the blink and the gaze
  function pose(a, dt, vx, vy, s) {
    const f = a.front, flip = a.dir * f, moving = Math.hypot(vx, vy) > 20;
    let legL = 0, legR = 0, bob = 0, lean = 0, armL = 0, armR = 0;
    if (moving) { a.phase += Math.hypot(vx, vy) * dt * 0.055; const sn = Math.sin(a.phase); legL = sn * 36; legR = -sn * 36; bob = Math.abs(sn) * 8; lean = 7; armL = -sn * 14; armR = sn * 14; }
    else if (a.z > 0) { legL = 30 * f; legR = -24 * f; lean = 4; }
    else { a.phase += dt * 2.2; }
    if (a.type > 0 && !moving) { a.type -= dt; const tp = Math.sin(time * 22) * 9; armL += tp; armR -= tp; }
    if (a.wave > 0) { a.wave -= dt; const wv = Math.sin(time * 17) * 24; armL += wv; armR -= wv; }
    if (a.shout > 0) a.shout -= dt;
    a.lean += (lean - a.lean) * Math.min(1, dt * 12);
    a.sqv += (-420 * a.sq - 24 * a.sqv) * dt; a.sq += a.sqv * dt;
    const breathe = !moving && a.z <= 0 ? Math.sin(a.phase) * 0.012 : 0;
    const sy = 1 + a.sq + breathe, sx = 1 - a.sq * 0.7;
    a.g.setAttribute("transform", `translate(${a.x} ${a.y - a.z}) scale(${flip * s} ${s})`);
    a.top.setAttribute("transform", `translate(0 ${-bob}) rotate(${a.lean * f} 200 292) translate(200 292) scale(${sx} ${sy}) translate(-200 -292)`);
    a.legL.setAttribute("transform", `rotate(${legL} ${a.pLegL})`);
    a.legR.setAttribute("transform", `rotate(${legR} ${a.pLegR})`);
    if (a.freeL) a.armL.setAttribute("transform", `rotate(${armL} ${a.pArmL})`);
    if (a.freeR) a.armR.setAttribute("transform", `rotate(${armR} ${a.pArmR})`);
    a.blinkIn -= dt;
    if (a.blinkIn <= 0) { a.blink = 0.12; a.blinkIn = rand(1.6, 4.5); }
    if (a.blink > 0) { a.blink -= dt; a.eyes.setAttribute("transform", `translate(0 ${a.eyeY}) scale(1 0.08) translate(0 ${-a.eyeY})`); }
    else if (a.eyes.hasAttribute("transform")) a.eyes.removeAttribute("transform");
    let gx = 0, gy = 0;
    if (a.gazeT > 0 && a.gaze && !a.gaze.gone) {
      a.gazeT -= dt;
      const tx = a.gaze.x, ty = a.gaze.floor != null ? a.gaze.yy : (a.gaze.y - (a.gaze.tall || 0) * depth(a.gaze.y) * 0.6);
      const ddx = (tx - a.x) * flip, ddy = ty - (a.y - a.tall * s * 0.62), d = Math.hypot(ddx, ddy) || 1;
      gx = ddx / d * 7 - a.h.look[0] * 0.6; gy = ddy / d * 7 - a.h.look[1] * 0.6;
    }
    a.pupils.setAttribute("transform", `translate(${gx} ${gy})`);
    let mouth = a.own;
    if (a.chomp > 0) { a.chomp -= dt; mouth = Math.floor(a.chomp / 0.09) % 2 ? "open" : "smile"; }
    else if (a.faceT > 0) { a.faceT -= dt; mouth = a.face; }
    if (mouth !== a.shown && a.mouths[mouth]) { a.mouths[a.shown].setAttribute("display", "none"); a.mouths[mouth].removeAttribute("display"); a.shown = mouth; }
    if (a.waves) { if (a.shout > 0 && a.shout < 0.9) { a.waves.removeAttribute("display"); a.waves.setAttribute("opacity", 0.55 + 0.45 * Math.sin(time * 40)); } else if (!a.waves.hasAttribute("display")) a.waves.setAttribute("display", "none"); }
  }

  // ---------- a report lands ----------
  const KIND_WORD = { post: "posted", reply: "answered", note: "wrote a note", research: "researched", build: "built", status: "says", review: "reviewed", hire: "hired" };
  const KIND_PLURAL = { post: "posts", reply: "answers", note: "notes", research: "research notes", build: "builds", review: "reviews", hire: "hires" };
  function report(entry) {
    const a = byId[entry.helper];
    if (!a) return;
    const run = () => {
      a.mode = "report"; a.cube = null; a.wait = 99;
      const side = a.x < 800 ? -1 : 1;
      a.goTo(800 + side * rand(60, 160), 600, () => {
        a.dir = -side; flow(a); a.hop(0.5);
        speak(a, entry.title || entry.body || KIND_WORD[entry.kind] || "a report", `${a.h.name} ${KIND_WORD[entry.kind] || "reports"}`, 7);
        setTimeout(() => { if (a.mode === "report") { a.mode = a.working ? "work" : "wander"; a.wait = 0.5; } next(a); }, 7500);
      });
    };
    if (a.mode === "report") a.queue.push(run); else run();
  }
  function next(a) { const r = a.queue.shift(); if (r) r(); }

  // ---------- the cards, the drawer, the log, the screen ----------
  const cardsEl = $("cards"), cards = {};
  const ROLE = { fudge: "marketing", crumb: "community", nib: "research", chip: "builder" };
  function makeCards() {
    for (const h of M.team) {
      const b = document.createElement("button"); b.type = "button"; b.className = "crew-card"; b.dataset.id = h.id;
      b.innerHTML = `<span class="state"></span><div class="top"><span class="face"></span><div><div class="name"></div><div class="role"></div></div></div><div class="metric"><b>0</b><span>reports today</span></div><div class="bar"><i></i></div><p class="quote"></p>`;
      b.querySelector(".face").innerHTML = M.face(h);
      b.querySelector(".name").textContent = h.name; b.querySelector(".role").textContent = ROLE[h.id] || h.job;
      b.addEventListener("click", () => openDrawer(h.id));
      cardsEl.appendChild(b); cards[h.id] = b;
    }
    const k = document.createElement("div"); k.className = "crew-card kitchen"; k.id = "kitchenCard";
    k.innerHTML = `<div class="top"><span class="face"></span><div><div class="name">The kitchen</div><div class="role">all four</div></div></div><div class="metric"><b id="kTotal">0</b><span>reports so far</span></div><div class="bar"><i id="kBar"></i></div><p class="quote" id="kQuote"></p>`;
    k.querySelector(".face").innerHTML = M.coin({ shape: "round" });
    cardsEl.appendChild(k);
  }
  makeCards();
  const WORKING_FOR = 3 * 3600_000;
  let towers = [], jobsOpen = 0, week = {}, totalReports = 0;
  function renderCard(a) {
    const c = cards[a.h.id]; if (!c) return;
    c.classList.toggle("working", a.working);
    c.querySelector(".metric b").textContent = String(a.today);
    const top = Math.max(3, ...actors.map((x) => x.today));
    c.querySelector(".bar i").style.width = `${Math.round(a.today / top * 100)}%`;
    c.querySelector(".quote").textContent = a.working && a.status ? a.status : a.last ? `Last: ${a.last}` : a.h.line;
    const mon = monitors[a.h.id];
    if (mon) { mon.big.textContent = String(a.today); mon.bars.forEach((r, i) => { const hgt = (4 + ((a.total * 7 + i * 13) % 5) * 5) * mon.s; r.setAttribute("height", hgt); r.setAttribute("y", Number(r.getAttribute("y")) + 0 ); }); }
  }
  function renderKitchenCard() {
    const t = towers[towers.length - 1], bricks = t ? t.count : 0, n = towers.length || 1;
    $("kTotal").textContent = String(totalReports);
    $("kBar").style.width = `${bricks}%`;
    $("kQuote").textContent = `Tower ${n}: ${bricks} of 100 bricks. ${jobsOpen} job${jobsOpen === 1 ? "" : "s"} on the board.${sugarEaten ? ` ${sugarEaten} sugar cube${sugarEaten === 1 ? "" : "s"} eaten this visit.` : ""}`;
  }
  const drawer = $("drawer"), logEl = $("log");
  let open = null, activity = [];
  function openDrawer(id) {
    const a = byId[id]; if (!a) return;
    open = id;
    for (const [k, c] of Object.entries(cards)) c.classList.toggle("on", k === id);
    $("drawerFace").innerHTML = M.face(a.h);
    $("drawerName").textContent = a.h.name; $("drawerJob").textContent = (ROLE[id] || a.h.job) + "  |  " + a.h.line;
    const now = $("drawerNow");
    now.textContent = a.working && a.status ? "Now: " + a.status : a.lastAt ? `Resting. Last report ${B.ago(a.lastAt, Date.now())}.` : "Nothing reported yet.";
    now.classList.toggle("rest", !(a.working && a.status));
    const st = $("drawerStats"); st.replaceChildren();
    for (const [k, v] of [["Reports today", String(a.today)], ["Reports so far", String(a.total)], ["AI used today", "$" + (a.cost / 1e6).toFixed(2)], ["Sugar cubes eaten", String(a.sugar)]]) {
      const d = document.createElement("div"); const dt = document.createElement("dt"); dt.textContent = k; const dd = document.createElement("dd"); dd.textContent = v; d.append(dt, dd); st.appendChild(d);
    }
    const list = $("drawerList"); list.replaceChildren();
    for (const e of activity.filter((x) => x.helper === id).slice(0, 5)) {
      const li = document.createElement("li");
      const when = document.createElement("span"); when.className = "when"; when.textContent = `${B.ago(e.at, Date.now())}, ${KIND_WORD[e.kind] || e.kind}`;
      const what = document.createElement("div"); what.textContent = e.title || e.body || "";
      li.append(when, what);
      if (e.url && /^https:\/\//.test(e.url)) { const link = document.createElement("a"); link.href = e.url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "See it"; li.append(" ", link); }
      list.appendChild(li);
    }
    if (!list.childElementCount) { const li = document.createElement("li"); li.textContent = "No reports yet."; list.appendChild(li); }
    $("drawerWatch").href = `team.html#${id}`;
    $("drawerTip").href = "app.html#hTip";
    drawer.hidden = false;
    a.look({ x: 800, y: 300 }, 2); a.hop(0.5);
  }
  $("drawerClose").addEventListener("click", () => { drawer.hidden = true; open = null; for (const c of Object.values(cards)) c.classList.remove("on"); });
  function renderLog(fresh) {
    logEl.replaceChildren();
    for (const e of activity.slice(0, 12)) {
      const li = document.createElement("li"); if (fresh && fresh.has(e.id)) li.className = "fresh";
      const when = document.createElement("span"); when.className = "when"; when.textContent = B.ago(e.at, Date.now());
      const who = document.createElement("span"); who.className = "who"; who.textContent = e.helper;
      const what = document.createElement("span"); what.className = "what"; what.textContent = `${KIND_WORD[e.kind] || e.kind}: ${e.title || e.body || ""}`;
      if (e.url && /^https:\/\//.test(e.url)) { const a = document.createElement("a"); a.href = e.url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = "see it"; what.append(" ", a); }
      li.append(when, who, what); logEl.appendChild(li);
    }
    $("logEmpty").hidden = activity.length > 0;
  }
  // the wall screen: today's numbers and the last two weeks of work as a line
  let screenMode = "days";
  function renderScreen() {
    const todayN = actors.reduce((s, a) => s + a.today, 0), t = towers[towers.length - 1];
    screenTop.textContent = `BROWNIES   REPORTS TODAY ${todayN}   JOBS ON THE BOARD ${jobsOpen}   ${new Date().toUTCString().slice(5, 16).toUpperCase()}`;
    screenBig.textContent = String(totalReports);
    screenSub.textContent = "jobs done, one brick each";
    screenRight.textContent = t ? `${t.count} / 100` : "0 / 100";
    screenRightSub.textContent = `tower ${towers.length || 1}`;
    const days = 14, counts = new Array(days).fill(0), now = Date.now(), day = 86400_000;
    for (const e of activity) { const d = Math.floor((now - e.at) / day); if (d >= 0 && d < days) counts[days - 1 - d]++; }
    const max = Math.max(3, ...counts), x0 = SCREEN.x + 22, x1 = SCREEN.x + SCREEN.w - 22, y0 = SCREEN.y + 150, y1 = SCREEN.y + SCREEN.h - 34;
    const pts = counts.map((c, i) => [x0 + (x1 - x0) * i / (days - 1), y1 - (y1 - y0) * c / max]);
    screenLine.setAttribute("d", pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" "));
    screenArea.setAttribute("d", `M${x0} ${y1} ` + pts.map((p) => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ") + ` L${x1} ${y1} Z`);
    const best = Math.max(...counts);
    screenFoot.textContent = `LAST 14 DAYS: ${counts.reduce((s, c) => s + c, 0)} REPORTS, BUSIEST DAY ${best}`;
  }
  const ticker = $("ticker");
  function renderTicker() {
    const todayN = actors.reduce((s, a) => s + a.today, 0), latest = activity[0];
    const parts = [`REPORTS TODAY ${todayN}`, `JOBS DONE ${totalReports}`, `ON THE BOARD ${jobsOpen}`];
    const wk = Object.entries(week).map(([k, v]) => `${v} ${v === 1 ? (KIND_PLURAL[k] || k).replace(/s$/, "") : (KIND_PLURAL[k] || k)}`).join(", ");
    if (wk) parts.push(`THIS WEEK: ${wk.toUpperCase()}`);
    for (const a of actors) parts.push(`${a.h.name.toUpperCase()}: ${a.working && a.status ? a.status : a.lastAt ? "resting" : "quiet"}`);
    if (latest) parts.push(`LATEST, ${latest.helper.toUpperCase()}: ${latest.title || latest.body || ""}`);
    ticker.replaceChildren(); const span = document.createElement("span"); span.textContent = parts.join("      "); ticker.appendChild(span);
  }

  // ---------- the data ----------
  const api = async (path) => demo ? demoApi(path) : B.gw(S, path);
  let lastSeenId = null, demoClock = Date.now();
  async function summary() {
    const r = await api("/api/team/summary");
    if (!r.ok || !r.body) return;
    const now = r.body.now || Date.now();
    for (const h of r.body.helpers || []) {
      const a = byId[h.helper]; if (!a) continue;
      const fresh = h.status && now - h.status.at < WORKING_FOR;
      const was = a.working;
      a.working = !!fresh; a.status = fresh ? h.status.title : ""; a.today = h.today || 0; a.total = h.total || 0; a.cost = h.costTodayMicro || 0; a.lastAt = h.lastAt || 0;
      if (was !== a.working && a.mode !== "report" && a.mode !== "fetch") { a.mode = a.working ? "work" : "wander"; a.goal = null; a.wait = rand(0.5, 2); }
      renderCard(a);
    }
    week = r.body.week || {}; totalReports = r.body.total || 0;
    renderKitchenCard(); renderScreen(); renderTicker();
    if (open) openDrawer(open);
  }
  async function loadActivity(first) {
    const r = await api(`/api/team/activity?limit=${first ? 120 : 40}`);
    if (!r.ok || !r.body || !Array.isArray(r.body.entries)) return;
    const rows = r.body.entries;
    const fresh = new Set();
    if (!first && lastSeenId != null) for (const e of rows) if (e.id > lastSeenId) fresh.add(e.id);
    const seen = new Set(activity.map((e) => e.id));
    for (const e of rows) if (!seen.has(e.id)) activity.push(e);
    activity.sort((p, q) => q.at - p.at); activity = activity.slice(0, 300);
    for (const a of actors) { const mine = activity.find((e) => e.helper === a.h.id && (e.title || e.body)); a.last = mine ? (mine.title || mine.body) : null; }
    if (rows.length) lastSeenId = Math.max(lastSeenId || 0, ...rows.map((e) => e.id));
    renderLog(fresh); renderScreen(); renderTicker();
    if (!first) for (const e of rows.filter((x) => fresh.has(x.id)).sort((p, q) => p.at - q.at)) report(e);
    if (open) openDrawer(open);
  }
  async function extras() {
    const [t, j] = await Promise.all([api("/api/team/towers"), api("/jobs/totals")]);
    if (t.ok && t.body && Array.isArray(t.body.towers)) towers = t.body.towers;
    if (j.ok && j.body) { const by = j.body.byState || j.body.states || j.body; let n = 0; for (const k of ["found", "picked", "preparing", "waiting_owner", "submitted", "working"]) n += Number((by[k] && (by[k].n ?? by[k])) || 0); jobsOpen = n; }
    drawNotes(jobsOpen); renderKitchenCard(); renderScreen();
  }

  // made-up data for ?demo=1: busy brownies and a report every few seconds
  const DEMO_TITLES = { fudge: ["Posted: the brownies met a pumpkin head today", "Posted: four brownies, one kitchen, zero sleep", "Posted: Nib found a chart that looks like a cat"], crumb: ["Answered 3 questions in the group", "Answered the owner", "Answered 2 questions for a holder"], nib: ["Research note: our numbers have not moved", "Research note: two new launches today", "Research note: the competition posted a roadmap"], chip: ["Built: the README lists the helpers", "Built: a test for the board", "Reviewed Nib's change: yes"] };
  const DEMO_KIND = { fudge: "post", crumb: "reply", nib: "research", chip: "build" };
  let demoEntries = null, demoId = 500;
  function demoApi(path) {
    const now = Date.now();
    if (!demoEntries) { demoEntries = []; for (let i = 0; i < 60; i++) { const id = M.team[i % 4].id; demoEntries.push({ id: 400 - i, at: now - i * 3.1 * 3600_000 - 60000, helper: id, kind: DEMO_KIND[id], title: DEMO_TITLES[id][i % 3], body: null, url: i % 3 ? "https://x.com/Feedthebrownies" : null }); } }
    if (path.startsWith("/api/team/summary")) return { ok: true, body: { now, total: 21 + demoEntries.filter((e) => e.id > 400).length, week: { post: 5, reply: 4, note: 7, research: 3, build: 2 }, helpers: M.team.map((h, i) => ({ helper: h.id, total: 7 - i, today: [2, 3, 1, 0][i], costTodayMicro: [9986, 4000, 12000, 0][i], lastAt: now - (i + 1) * 3600_000, status: i < 3 ? { title: ["Writing today's second post", "Listening on Telegram", "Writing today's research note", ""][i], at: now - 600_000 } : null })) } };
    if (path.startsWith("/api/team/activity")) {
      // after the first look, a new report every so often
      if (now - demoClock > 6500) { demoClock = now; const h = M.team[Math.floor(Math.random() * 4)]; demoEntries.unshift({ id: ++demoId, at: now, helper: h.id, kind: DEMO_KIND[h.id], title: DEMO_TITLES[h.id][demoId % 3], body: null, url: "https://x.com/Feedthebrownies" }); }
      return { ok: true, body: { entries: demoEntries.slice(0, 120) } };
    }
    if (path.startsWith("/api/team/towers")) return { ok: true, body: { towers: [{ tower: 0, count: 100 }, { tower: 1, count: 37 }] } };
    if (path.startsWith("/jobs/totals")) return { ok: true, body: { found: { n: 2 }, picked: { n: 1 }, waiting_owner: { n: 1 } } };
    return { ok: false, body: null };
  }

  // ---------- the visitor ----------
  svg.addEventListener("click", (e) => {
    if (e.target.closest(".actor") || e.target.closest(".hit")) return;
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    if (p.y > WALL + 40) dropCube(p.x, p.y);
    else if (p.x > SCREEN.x && p.x < SCREEN.x + SCREEN.w && p.y > SCREEN.y && p.y < SCREEN.y + SCREEN.h) { screenFlash.setAttribute("opacity", 0.3); renderScreen(); }
  });
  $("lightsBtn").addEventListener("click", (e) => { const on = !stageEl.classList.contains("lit"); stageEl.classList.toggle("lit", on); e.currentTarget.setAttribute("aria-pressed", String(on)); for (const a of actors) a.say("o", 0.8); });
  $("bellBtn").addEventListener("click", () => {
    bell = 7;
    actors.forEach((a, i) => { if (a.mode === "report") return; a.mode = "sofa"; a.cube = null; a.goTo(690 + i * 70, 880, () => { a.dir = 1; a.hop(0.7); a.say("open", 0.8); a.wait = rand(1, 3); }); });
    speak(actors[1], "Bell! Everyone to the sofa.", null, 3);
  });

  // ---------- start ----------
  await Promise.all([summary(), loadActivity(true), extras()]);
  for (const a of actors) { if (!a.working) { a.mode = "wander"; const s = SPOTS[a.i % SPOTS.length]; a.x = s.x; a.y = s.y; } renderCard(a); }
  renderKitchenCard(); renderScreen(); renderTicker();
  let last = 0;
  if (!reduce) requestAnimationFrame(function frame(now) { const dt = last ? Math.min((now - last) / 1000, 0.034) : 0.016; last = now; step(dt); requestAnimationFrame(frame); });
  else { for (const a of actors) pose(a, 0.016, 0, 0, depth(a.y)); }
  setInterval(() => { if (!document.hidden) summary(); }, demo ? 10000 : 30000);
  setInterval(() => { if (!document.hidden) loadActivity(false); }, demo ? 4000 : 20000);
  setInterval(() => { if (!document.hidden) extras(); }, 300000);
  window.BrowniesRoom = { state: () => ({ actors: actors.map((a) => ({ id: a.h.id, x: Math.round(a.x), y: Math.round(a.y), mode: a.mode, working: a.working })), cubes: cubes.length, flows: flows.length, log: activity.length, bubbles: L.bubbles.childElementCount }), drop: dropCube, report, bell: () => $("bellBtn").click() };
})();
