// A public address for one of our files, for a while: Instagram fetches a reel or an image from a URL, so a finished
// clip in the videos folder gets a link like <gateway>/clips/<token>.mp4 that works for ninety minutes. The token
// is unguessable; only files inside the videos folder are ever served; Range requests are honoured, as the
// platforms' fetchers want.
import { createReadStream, statSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { extname, resolve, sep } from "node:path";

const TYPES = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

export class Clips {
  constructor({ store, clock, baseUrl = "", dir = "/var/lib/brownies/videos", log = () => {} } = {}) {
    Object.assign(this, { store, clock, baseUrl: String(baseUrl).replace(/\/$/, ""), dir: resolve(dir), log });
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

  /// GET or HEAD /clips/<token>.<ext>
  handle(req, res) {
    const m = /^\/clips\/([A-Za-z0-9_-]{16,40})(\.[a-z0-9]+)?(?:\?.*)?$/.exec(req.url || "");
    const gone = (status, text) => { res.writeHead(status, { "content-type": "text/plain", "cache-control": "no-store" }); res.end(text); };
    if (!m || (req.method !== "GET" && req.method !== "HEAD")) return gone(404, "not here");
    let rec = null;
    try { rec = JSON.parse(this.store.getMeta(`clip:${m[1]}`) || "null"); } catch { rec = null; }
    if (!rec || this.now() > rec.expiresAt) return gone(404, "this link has ended");
    let real;
    try { real = realpathSync(rec.file); } catch { return gone(404, "the file is gone"); }
    if (!(real === this.dir || real.startsWith(this.dir + sep))) return gone(404, "not here");
    let size;
    try { size = statSync(real).size; } catch { return gone(404, "the file is gone"); }
    const type = TYPES[extname(real).toLowerCase()] || "application/octet-stream";
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    let start = 0, end = size - 1, status = 200;
    if (range && (range[1] || range[2])) {
      if (range[1]) { start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1; }
      else { const tail = Number(range[2]); start = Math.max(0, size - tail); }
      if (start > end || start >= size) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
      status = 206;
    }
    const headers = { "content-type": type, "content-length": String(end - start + 1), "accept-ranges": "bytes", "cache-control": "private, max-age=300" };
    if (status === 206) headers["content-range"] = `bytes ${start}-${end}/${size}`;
    res.writeHead(status, headers);
    if (req.method === "HEAD") return res.end();
    createReadStream(real, { start, end }).on("error", () => { try { res.destroy(); } catch { /* gone */ } }).pipe(res);
  }
}
