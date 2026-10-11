// The website check's plumbing: a request names a site, the proof of ownership (the file or the DNS record with
// the wallet that pays), the passive checks over a fake site, the findings they give by themselves, the table.
import test from "node:test";
import assert from "node:assert/strict";
import { parseSiteRequest, proofUrl, proofText, proves, ownership, checkSite, siteFindings, checksText, EXPOSED, HEADERS } from "../lib/sitecheck.mjs";

const PAYER = "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12";

/// A fake site: the home page with a few sins, an exposed .env, a dead link, a listing, no HSTS.
function fakeSite({ proof = PAYER, hsts = false, exposeEnv = true } = {}) {
  const calls = [];
  const HOME = `<!doctype html><html><head><title>Shop</title><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/assets/site.css"><script src="https://cdn.example.net/jquery-1.12.4.min.js"></script><script>var x = 1;</script></head><body><h1>Shop</h1><img src="/a.png"><img src="http://img.example.com/b.png" alt="b"><form action="http://api.example.com/login"><input type="password"></form><a href="/about">About</a><a href="/gone">Gone</a><a href="https://other.example/x">Other</a><a href="/privacy">Privacy</a><a href="team.html">Team</a><a href="mailto:x@y.z">Mail</a><a href="site.css">Style</a></body></html>`;
  const fetch = async (url, init = {}) => {
    const u = String(url), method = init.method || "GET";
    calls.push(`${method} ${u}`);
    const res = (status, text = "", headers = {}, setCookie = []) => ({ ok: status >= 200 && status < 300, status, url: u, headers: new Map(Object.entries(headers)), text: async () => text, });
    const withCookies = (r, cookies) => { r.headers.getSetCookie = () => cookies; return r; };
    if (u === "http://example.com/") return res(301, "", { location: "https://example.com/" });
    if (u === "https://example.com/" || u === "https://example.com") return withCookies(res(200, HOME, { "content-type": "text/html", server: "nginx", "x-powered-by": "PHP/8.1", ...(hsts ? { "strict-transport-security": "max-age=31536000" } : {}), "x-content-type-options": "nosniff" }), ["session=abc; Path=/", "theme=dark; Secure; HttpOnly; SameSite=Lax"]);
    if (u === "https://example.com/.well-known/brownies.txt") return proof ? res(200, `brownies=${proof}\n`) : res(404);
    if (u === "https://example.com/.env") return exposeEnv ? res(200, "DB_PASSWORD=hunter2\nAPI_KEY=abc\n") : res(404);
    if (u === "https://example.com/config.json") return res(200, "<html>not really</html>");
    if (u === "https://example.com/robots.txt") return res(200, "User-agent: *\nAllow: /");
    if (u === "https://example.com/sitemap.xml") return res(404);
    if (u === "https://example.com/.well-known/security.txt") return res(404);
    if (u === "https://example.com/assets/") return res(200, "<html><title>Index of /assets/</title></html>");
    if (u === "https://example.com/about" || u === "https://example.com/team.html") return res(200);
    if (u === "https://example.com/gone") return res(404);
    if (u === "https://example.com/privacy") return res(200);
    return res(404);
  };
  return { fetch, calls };
}

test("a request names a site; the proof is the wallet in the file or the DNS record", async () => {
  assert.deepEqual(parseSiteRequest("https://Example.com"), { url: "https://example.com", host: "example.com", notes: "" });
  assert.deepEqual(parseSiteRequest("Check https://example.com/shop/, mainly the checkout."), { url: "https://example.com/shop", host: "example.com", notes: "Check, mainly the checkout" });
  assert.equal(parseSiteRequest("http://example.com"), null); assert.equal(parseSiteRequest("my site please"), null);
  assert.equal(proofUrl("example.com"), "https://example.com/.well-known/brownies.txt"); assert.equal(proofText(PAYER), `brownies=${PAYER.toLowerCase()}`);
  assert.equal(proves(`brownies=${PAYER}`, PAYER), true); assert.equal(proves(PAYER.toUpperCase(), PAYER), true); assert.equal(proves("brownies=0x0000000000000000000000000000000000000000", PAYER), false); assert.equal(proves("anything", ""), false);
  const site = fakeSite();
  assert.deepEqual(await ownership("example.com", PAYER, { fetch: site.fetch }), { ok: true, how: "the file" });
  const none = fakeSite({ proof: null });
  const o = await ownership("example.com", PAYER, { fetch: none.fetch, lookupTxt: async () => ["v=spf1 -all", `brownies=${PAYER.toLowerCase()}`] });
  assert.deepEqual(o, { ok: true, how: "the DNS record" });
  const no = await ownership("example.com", PAYER, { fetch: none.fetch, lookupTxt: async () => { throw new Error("ENODATA"); } });
  assert.equal(no.ok, false); assert.match(no.why, /^prove the site is yours first: put a file at https:\/\/example\.com\/\.well-known\/brownies\.txt containing the wallet you pay with \(0xabcdef/);
  assert.equal((await ownership("example.com", "", { fetch: site.fetch })).ok, false);
});

test("the checks over a fake site: the redirect, the headers, the cookies, the exposed file, the listing, the page basics, the dead link; the findings; the table", async () => {
  const site = fakeSite();
  const R = await checkSite("https://example.com", { fetch: site.fetch, tlsInfo: async () => ({ validTo: Date.now() + 5 * 86_400_000, issuer: "Let's Encrypt", authorized: true }) });
  assert.equal(R.home.status, 200); assert.equal(R.http.toHttps, true); assert.equal(R.headers["strict-transport-security"], null); assert.equal(R.headers["x-content-type-options"], "nosniff");
  assert.deepEqual(R.cookies, [{ name: "session", secure: false, httpOnly: false, sameSite: false }, { name: "theme", secure: true, httpOnly: true, sameSite: true }]);
  assert.deepEqual(R.exposed, ["/.env"], "config.json answered HTML, not a config"); assert.deepEqual(R.listing, ["/assets/"]);
  assert.equal(R.html.title, "Shop"); assert.equal(R.html.description, null); assert.equal(R.html.viewport, true); assert.equal(R.html.lang, null); assert.equal(R.html.h1, 1); assert.equal(R.html.images, 2); assert.equal(R.html.imagesNoAlt, 1);
  assert.equal(R.html.scripts, 2); assert.equal(R.html.inlineScripts, 1); assert.deepEqual(R.html.externalScriptHosts, ["cdn.example.net"]); assert.deepEqual(R.html.mixed, ["http://img.example.com/b.png"], "the form to http is counted apart"); assert.equal(R.html.formsToHttp, 1); assert.equal(R.html.passwordFields, 1);
  assert.deepEqual(R.html.libraries, ["jquery 1.12.4"]); assert.equal(R.html.privacyLink, true); assert.equal(R.html.termsLink, false);
  assert.equal(R.robots, "present"); assert.equal(R.sitemap, "absent"); assert.equal(R.securityTxt, "absent");
  assert.deepEqual(R.broken, ["https://example.com/gone"]); assert.equal(R.linksTried, 4, "about, gone, privacy and the relative team.html; the other host, the mailto and the stylesheet are not links to try");
  assert.equal(R.server.poweredBy, "PHP/8.1"); assert.ok(R.htmlText.startsWith("<!doctype html>"));
  assert.ok(site.calls.includes("HEAD http://example.com/")); assert.ok(site.calls.includes("GET https://example.com/.git/config")); assert.ok(!site.calls.some((c) => /POST/.test(c)), "nothing is ever sent");
  const F = siteFindings(R);
  const titles = F.map((f) => `${f.severity}: ${f.title}`);
  assert.deepEqual(titles, [
    "critical: /.env is readable by anyone", "medium: Directory listing at /assets/", "high: The certificate expires soon", "medium: No Strict-Transport-Security header", "low: No Content-Security-Policy header", "low: The page can be framed by any site",
    "medium: Cookie session without Secure", "medium: Mixed content: http resources on an https page", "high: A form posts to http", "medium: A login form without HSTS", "low: Broken link: /gone", "low: No meta description", "low: No language on the html element", "low: 1 image without alt text", "low: The server names its software",
  ]);
  assert.equal(F[0].failure_case, "GET https://example.com/.env returns 200 with the file."); assert.match(F[0].fix, /rotate any secret/);
  const text = checksText(R);
  assert.match(text, /^- Home page: 200, 1 KB of HTML\n- http redirects to https: yes\n- Certificate: valid until \d{4}-\d{2}-\d{2}, by Let's Encrypt\n- Security headers: strict transport security NO; content security policy NO; x content type options yes/);
  assert.match(text, /- Files that should not be public: EXPOSED \/\.env\n- Directory listing: ON at \/assets\/\n- Mixed content: 1; forms to http: 1; password fields: 1/);
  assert.match(text, /- Links on the home page tried: 4, broken: 1\n- Server: nginx, x-powered-by PHP\/8\.1$/);
  // a site that does not answer at all
  const dead = await checkSite("https://example.com", { fetch: async () => { throw Object.assign(new Error("fail"), { cause: { code: "ENOTFOUND" } }); } });
  assert.equal(dead.home.error, "ENOTFOUND"); assert.equal(siteFindings(dead)[0].title, "The site did not answer over https"); assert.equal(siteFindings(dead)[0].severity, "critical");
  assert.match(checksText(dead), /^- Home page: no answer \(ENOTFOUND\)/);
  assert.equal(EXPOSED.length, 14); assert.equal(HEADERS.length, 6);
});
