// A page made self-contained for the box: stylesheets, fonts, scripts and images inlined; what cannot be fetched stays
// a link; the Latin faces only from a Google sheet; the preconnects and the base gone.
import test from "node:test";
import assert from "node:assert/strict";
import { inlinePage, latinFaces } from "../lib/inline.mjs";

const PAGE = `<!doctype html><html><head><base href="https://x.test/"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Rubik&display=swap" rel="stylesheet"><link rel="stylesheet" href="styles.css"><style>.hero{background:url(hero.png)}</style><script src="mascot.js" defer></script></head><body><img src="assets/mark.svg" alt="mark" srcset="assets/mark.svg 2x" sizes="40px"><div style="background:url('bg.png')"></div><img src="missing.png" alt="gone"><img src="data:image/gif;base64,R0lGOD" alt="inline"></body></html>`;
const GOOGLE = `/* latin-ext */\n@font-face { font-family: 'Rubik'; src: url(https://fonts.gstatic.com/s/rubik/ext.woff2) format('woff2'); unicode-range: U+0100-02BA; }\n/* latin */\n@font-face { font-family: 'Rubik'; src: url(https://fonts.gstatic.com/s/rubik/lat.woff2) format('woff2'); unicode-range: U+0000-00FF, U+0131; }`;
function fakeFetch(seen) {
  return async (url, init) => {
    seen.push(url);
    const ok = (body, type) => ({ ok: true, status: 200, headers: new Map([["content-type", type]]), arrayBuffer: async () => Buffer.from(body) });
    assert.match(init.headers["user-agent"], url.startsWith("https://fonts.") ? /Chrome/ : /BrowniesSiteCheck/);
    if (url === "https://fonts.googleapis.com/css2?family=Rubik&display=swap") return ok(GOOGLE, "text/css");
    if (url === "https://fonts.gstatic.com/s/rubik/lat.woff2") return ok("LATINFONT", "font/woff2");
    if (url === "https://x.test/styles.css") return ok(`@import url("more.css");\nbody{color:#2A1710;background:url("paper.png")}`, "text/css");
    if (url === "https://x.test/more.css") return ok(`h1{font-weight:700;content:"$&$1"}`, "text/css");
    if (url === "https://x.test/paper.png") return ok("PNGBYTES", "image/png");
    if (url === "https://x.test/hero.png") return ok("HEROBYTES", "image/png");
    if (url === "https://x.test/bg.png") return ok("BGBYTES", "image/png");
    if (url === "https://x.test/mascot.js") return ok(`window.Mascot = { fill() {} }; // </script> inside`, "text/javascript");
    if (url === "https://x.test/assets/mark.svg") return ok("<svg/>", "image/svg+xml");
    return { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => Buffer.alloc(0) };
  };
}

test("inlinePage: sheets with their imports and url() assets, the Google sheet's Latin faces only, scripts, images, style attributes; the base and the preconnects gone; what fails stays a link", async () => {
  const seen = [];
  const r = await inlinePage(PAGE, "https://x.test/", fakeFetch(seen));
  assert.ok(!/<base/.test(r.html)); assert.ok(!/preconnect/.test(r.html));
  assert.match(r.html, /<style data-from="https:\/\/fonts\.googleapis\.com\/css2\?family=Rubik&amp;display=swap">/); assert.match(r.html, /url\("data:font\/woff2;base64,TEFUSU5GT05U"\)/); assert.ok(!/ext\.woff2/.test(r.html), "the latin-ext face is dropped");
  assert.ok(r.html.includes(`<style data-from="https://x.test/styles.css">\nh1{font-weight:700;content:"$&$1"}\nbody{color:#2A1710;background:url("data:image/png;base64,UE5HQllURVM=")}`), "the code goes in as it is, dollar signs and all");
  assert.match(r.html, /\.hero\{background:url\("data:image\/png;base64,SEVST0JZVEVT"\)\}/);
  assert.match(r.html, /style="background:url\('data:image\/png;base64,QkdCWVRFUw=='\)"/);
  assert.ok(r.html.includes(`<script src="data:text/javascript;base64,${Buffer.from("window.Mascot = { fill() {} }; // </script> inside").toString("base64")}" data-from="https://x.test/mascot.js" defer></script>`), "a script keeps its place and its defer; its code is in the src");
  assert.match(r.html, /<img src="data:image\/svg\+xml;base64,PHN2Zy8\+" alt="mark">/); assert.ok(!/srcset|sizes=/.test(r.html));
  assert.match(r.html, /<img src="missing\.png" alt="gone">/, "a missing image stays a link"); assert.match(r.html, /src="data:image\/gif;base64,R0lGOD"/, "a data image is left alone");
  assert.deepEqual(r.failed, ["https://x.test/missing.png"]); assert.equal(r.assets, 6, "the font, three pictures in CSS, the script, the image"); assert.ok(r.bytes > 0);
  assert.equal(seen.filter((u) => u === "https://x.test/paper.png").length, 1, "each asset is fetched once");
  const cache = new Map();
  await inlinePage(PAGE, "https://x.test/", fakeFetch(seen), { cache });
  const before = seen.length;
  await inlinePage(PAGE, "https://x.test/", fakeFetch(seen), { cache });
  assert.equal(seen.length, before, "a shared cache makes the second page free");
});

test("limits: an asset over perAsset or beyond maxBytes stays a link; latinFaces leaves a sheet without ranges alone", async () => {
  const r = await inlinePage(`<img src="big.png" alt="big"><img src="small.png" alt="small">`, "https://x.test/", async (url) => ({ ok: true, status: 200, headers: new Map([["content-type", "image/png"]]), arrayBuffer: async () => Buffer.alloc(url.includes("big") ? 50 : 10) }), { perAsset: 20, maxBytes: 15 });
  assert.match(r.html, /src="big\.png"/); assert.match(r.html, /src="data:image\/png;base64,/); assert.deepEqual(r.failed, ["https://x.test/big.png"]);
  assert.equal(latinFaces("body{color:red}"), "body{color:red}");
  assert.equal(latinFaces("@font-face { src: url(a.woff2); unicode-range: U+0400-045F; } @font-face { src: url(b.woff2); }").trim(), "@font-face { src: url(b.woff2); }");
});
