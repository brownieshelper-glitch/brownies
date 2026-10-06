// Zero dependency local server for the Brownies site: static files from this folder.
//   node web/serve.mjs            -> http://127.0.0.1:8788
//   PORT=3000 node web/serve.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8788);
const mime = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".webp": "image/webp", ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8", ".woff2": "font/woff2",
};

http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  let file = decodeURIComponent(u.pathname);
  if (file === "/" || file === "") file = "/index.html";
  const abs = path.normalize(path.join(root, file));
  if (!abs.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(abs, (err, data) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); }
    res.writeHead(200, { "content-type": mime[path.extname(abs).toLowerCase()] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  });
}).listen(port, "127.0.0.1", () => console.log(`Brownies site on http://127.0.0.1:${port}  (Ctrl+C stops it)`));
