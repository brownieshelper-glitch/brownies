// A public address for one of our files, for a while: Instagram fetches a reel or an image from a URL, so a finished
// clip in the videos folder gets a link like <gateway>/clips/<token>.mp4 that works for ninety minutes. The token
// is unguessable; only files inside the videos folder are ever served; Range requests are honoured, as the
// platforms' fetchers want.
//
// The reel (2026-10-14, the owner: "every 60 minutes show all our videos on the screen"): the videos the owner
// approved are listed at <gateway>/clips/reel.json and served at /clips/reel/<n>.mp4, for the kitchen cam's hourly
// show (web/room.js in live mode). What is served is a light copy made once with ffmpeg (no sound, 960 pixels tall
// at most): the stream server plays it beside its own encoder, and the stream carries the kitchen's music only.
// A video that is waiting, rejected, or has lost its file is not in the list and is not served.
import { createReadStream, statSync, realpathSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { extname, resolve, sep, join } from "node:path";

const TYPES = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
/// What the light copy is made with: the picture only, inside 720 by 960, 24 frames a second.
export const REEL_ARGS = (src, out) => ["-y", "-loglevel", "error", "-i", src, "-an", "-vf", "scale=w=720:h=960:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=24", "-c:v", "libx264", "-preset", "veryfast", "-crf", "27", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", out];

export class Clips {
  constructor({ store, clock, baseUrl = "", dir = "/var/lib/brownies/videos", log = () => {}, spawn = nodeSpawn, ffmpeg = "ffmpeg" } = {}) {
    Object.assign(this, { store, clock, baseUrl: String(baseUrl).replace(/\/$/, ""), dir: resolve(dir), log, spawn, ffmpeg });
    this.making = null; this.failed = new Set(); // the light copy being made now, and the ones ffmpeg refused (until a restart)
  }
  now() { return this.clock ? this.clock.now() : Date.now(); }

  /// A link that serves the file for `minutes` (90 by default). The file must sit inside the videos folder.
  url(file, { minutes = 90 } = {}) {
    const abs = resolve(file);
    if (!(abs === this.dir || abs.startsWith(this.dir + sep))) throw new Error("only files in the videos folder can be shared");
    statSync(abs); // it must exist now
    const token = randomBytes(18).toString("base64url");
    this.store.setMeta(`clip:${token}`, JSON.stringify({ file: abs, expiresAt: this.now() + minutes * 60_000 }));
    return `${this.baseUrl}/clips/${token}${extname(abs).toLowerCase()}`;
  }

  // ---- the reel ----

  /// The record of video n when the owner approved it and its file is still in the videos folder, or null.
  approved(n) {
    let rec = null; try { rec = JSON.parse(this.store.getMeta(`sprinkle:video:${n}`) || "null"); } catch { rec = null; }
    if (!rec || rec.review !== "approved") return null;
    const src = (rec.files || []).map((f) => resolve(String(f))).find((f) => f.startsWith(this.dir + sep) && existsSync(f));
    return src ? { n, src, title: String(rec.title || "").replace(/^Trend:\s*/i, "").slice(0, 90), kind: rec.kind || "clip", seconds: Number(rec.seconds) || 0 } : null;
  }
  lightFile(n) { return join(this.dir, "reel", `${n}.mp4`); }
  /// The approved videos whose light copy is ready, oldest first. Asking also sets the missing copies going.
  reel() {
    const count = Number(this.store.getMeta("sprinkle:videos", 0)) || 0, out = [], todo = [];
    for (let n = 1; n <= count; n++) {
      const v = this.approved(n);
      if (!v) continue;
      if (existsSync(this.lightFile(n))) out.push({ n, title: v.title, kind: v.kind, seconds: v.seconds, url: `${this.baseUrl}/clips/reel/${n}.mp4` });
      else if (!this.failed.has(n)) todo.push(v);
    }
    if (todo.length && !this.making) this.makeLight(todo);
    return out;
  }
  /// Makes the light copies one at a time (this server has one processor), each into a temporary name first.
  makeLight(list) {
    const v = list.shift();
    if (!v) { this.making = null; return; }
    this.making = v.n;
    const out = this.lightFile(v.n), tmp = out + ".part";
    const next = (ok, why = "") => {
      if (ok) { try { renameSync(tmp, out); this.log(`[clips] the reel has video ${v.n}`); } catch (e) { ok = false; why = e.message; } }
      if (!ok) { this.failed.add(v.n); try { rmSync(tmp, { force: true }); } catch { /* nothing to remove */ } this.log(`[clips] no light copy of video ${v.n}: ${why}`); }
      this.makeLight(list);
    };
    try {
      mkdirSync(join(this.dir, "reel"), { recursive: true });
      const p = this.spawn(this.ffmpeg, REEL_ARGS(v.src, tmp), { stdio: ["ignore", "ignore", "pipe"] });
      let err = ""; p.stderr?.on("data", (d) => { err = (err + d).slice(-300); });
      p.on("error", (e) => next(false, e.message));
      p.on("exit", (code) => next(code === 0, `ffmpeg ended with ${code}: ${err.trim()}`));
    } catch (e) { next(false, e.message); }
  }

  /// Sends a file, whole or the range asked for.
  send(req, res, real, cache, extra = {}) {
    let size;
    try { size = statSync(real).size; } catch { res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" }); return res.end("the file is gone"); }
    const type = TYPES[extname(real).toLowerCase()] || "application/octet-stream";
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    let start = 0, end = size - 1, status = 200;
    if (range && (range[1] || range[2])) {
      if (range[1]) { start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1; }
      else { const tail = Number(range[2]); start = Math.max(0, size - tail); }
      if (start > end || start >= size) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
      status = 206;
    }
    const headers = { "content-type": type, "content-length": String(end - start + 1), "accept-ranges": "bytes", "cache-control": cache, ...extra };
    if (status === 206) headers["content-range"] = `bytes ${start}-${end}/${size}`;
    res.writeHead(status, headers);
    if (req.method === "HEAD") return res.end();
    createReadStream(real, { start, end }).on("error", () => { try { res.destroy(); } catch { /* gone */ } }).pipe(res);
  }

  /// GET or HEAD /clips/<token>.<ext>, /clips/reel.json, /clips/reel/<n>.mp4
  handle(req, res) {
    const gone = (status, text) => { res.writeHead(status, { "content-type": "text/plain", "cache-control": "no-store" }); res.end(text); };
    if (req.method !== "GET" && req.method !== "HEAD") return gone(404, "not here");
    const path = String(req.url || "").split("?")[0];
    if (path === "/clips/reel.json") {
      const body = JSON.stringify({ at: this.now(), videos: this.reel() });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
      return res.end(req.method === "HEAD" ? undefined : body);
    }
    const r = /^\/clips\/reel\/(\d{1,5})\.mp4$/.exec(path);
    if (r) {
      const n = Number(r[1]);
      if (!this.approved(n) || !existsSync(this.lightFile(n))) return gone(404, "not in the reel");
      return this.send(req, res, this.lightFile(n), "public, max-age=86400", { "access-control-allow-origin": "*" });
    }
    const m = /^\/clips\/([A-Za-z0-9_-]{16,40})(\.[a-z0-9]+)?$/.exec(path);
    if (!m) return gone(404, "not here");
    let rec = null;
    try { rec = JSON.parse(this.store.getMeta(`clip:${m[1]}`) || "null"); } catch { rec = null; }
    if (!rec || this.now() > rec.expiresAt) return gone(404, "this link has ended");
    let real;
    try { real = realpathSync(rec.file); } catch { return gone(404, "the file is gone"); }
    if (!(real === this.dir || real.startsWith(this.dir + sep))) return gone(404, "not here");
    return this.send(req, res, real, "private, max-age=300");
  }
}
