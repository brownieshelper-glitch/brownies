// The website check's plumbing, the part that is not secret: how a request names a site, how the buyer proves
// the site is theirs (a file under .well-known or a DNS record with the wallet that pays), the passive checks
// (plain GETs of the home page, a few well-known paths and the links on the page: nothing is sent, nothing is
// tried against a login, nothing runs on their server) and the findings those checks give by themselves.
// Biscotti (a hidden brownie) runs the panel over the report; this module only looks and reads.
import tls from "node:tls";
import dns from "node:dns";

export const MAX_HTML = 2 * 1024 * 1024; // what is read of a page
export const KEEP_HTML = 80_000; // what the panel gets to read of the home page

/// The certificate's end date and issuer, by opening one TLS connection and closing it. Rejects when the handshake fails.
export function tlsInfo(host) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: 8000 }, () => {
      const c = s.getPeerCertificate();
      resolve({ validTo: c?.valid_to ? Date.parse(c.valid_to) : null, issuer: c?.issuer?.O || null, authorized: s.authorized });
      s.end();
    });
    s.on("timeout", () => { s.destroy(); reject(new Error("the TLS handshake timed out")); });
    s.on("error", (e) => reject(new Error(e.code || e.message)));
  });
}
/// The host's TXT records, flattened. Rejects when there are none.
export const lookupTxt = async (host) => (await dns.promises.resolveTxt(host)).map((parts) => parts.join(""));
export const MAX_LINKS = 30; // internal links tried for a 404
export const EXPOSED = ["/.env", "/.git/config", "/.git/HEAD", "/.DS_Store", "/wp-config.php.bak", "/backup.zip", "/backup.sql", "/config.json", "/.htpasswd", "/phpinfo.php", "/server-status", "/.svn/entries", "/composer.json", "/package.json"];
export const HEADERS = ["strict-transport-security", "content-security-policy", "x-content-type-options", "x-frame-options", "referrer-policy", "permissions-policy"];

/// "https://example.com, look at the checkout" -> { url, host, notes }. null when there is no https url.
export function parseSiteRequest(text) {
  const t = String(text || "").trim();
  const m = /https:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?(\/[^\s)>,;"']*)?/i.exec(t);
  if (!m) return null;
  const host = m[1].toLowerCase();
  const url = `https://${host}${m[2] && m[2] !== "/" ? m[2].replace(/\/+$/, "") : ""}`;
  const notes = (t.slice(0, m.index) + " " + t.slice(m.index + m[0].length)).replace(/\s+/g, " ").replace(/\s+([,.;:])/g, "$1").replace(/([,.;:])[,.;:\s]*(?=[,.;:])/g, "$1").replace(/^[\s,.;:]+|[\s,.;:]+$/g, "").trim();
  return { url, host, notes: notes.slice(0, 500) };
}

/// Where the proof lives, and what it must say: the wallet that pays, anywhere in the file (or in a DNS TXT record "brownies=0x...").
export const proofUrl = (host) => `https://${host}/.well-known/brownies.txt`;
export const proofText = (payer) => `brownies=${String(payer || "").toLowerCase()}`;
export function proves(text, payer) {
  const want = String(payer || "").toLowerCase();
  return Boolean(want && /^0x[0-9a-f]{40}$/.test(want) && String(text || "").toLowerCase().includes(want));
}
/// The buyer's wallet in the file or in the DNS record, else what to do. lookupTxt(host) -> [strings].
export async function ownership(host, payer, { fetch = globalThis.fetch, lookupTxt = null } = {}) {
  let file = null;
  try { const r = await fetch(proofUrl(host), { redirect: "follow", signal: AbortSignal.timeout(10_000) }); if (r.ok) file = (await r.text()).slice(0, 4000); } catch { file = null; }
  if (file != null && proves(file, payer)) return { ok: true, how: "the file" };
  if (lookupTxt) {
    try { const recs = await lookupTxt(host); if (recs.some((t) => proves(t, payer))) return { ok: true, how: "the DNS record" }; } catch { /* no record */ }
  }
  return { ok: false, why: `prove the site is yours first: put a file at ${proofUrl(host)} containing the wallet you pay with (${String(payer || "0x...").toLowerCase()}), or a DNS TXT record on ${host} with ${proofText(payer)}; then buy again` };
}

const grab = (html, re) => { const m = re.exec(html); return m ? m[1].replace(/\s+/g, " ").trim() : null; };
const count = (html, re) => (html.match(re) || []).length;
const sameHost = (u, host) => { try { const x = new URL(u); return x.hostname === host || x.hostname === `www.${host}` || host === `www.${x.hostname}`; } catch { return false; } };

/// The passive checks. fetch: a fetch; tlsInfo(host) -> { validTo (ms), issuer } or null. Returns the report.
export async function checkSite(url, { fetch = globalThis.fetch, tlsInfo = null, log = () => {} } = {}) {
  const host = new URL(url).hostname;
  const R = { url, host, at: Date.now(), home: null, http: null, tls: null, headers: {}, cookies: [], html: {}, exposed: [], listing: [], broken: [], robots: null, sitemap: null, securityTxt: null, notes: [] };
  const get = async (u, { method = "GET", redirect = "follow", max = MAX_HTML, timeout = 15_000 } = {}) => {
    try {
      const r = await fetch(u, { method, redirect, signal: AbortSignal.timeout(timeout), headers: { "user-agent": "Mozilla/5.0 (compatible; BrowniesSiteCheck/1.0; +https://feedthebrownies.com/shop.html)" } });
      const text = method === "GET" ? (await r.text()).slice(0, max) : "";
      const headers = {}; for (const [k, v] of r.headers) headers[k.toLowerCase()] = v;
      return { ok: r.ok, status: r.status, url: r.url || u, headers, text, setCookie: typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [] };
    } catch (e) { return { ok: false, status: 0, url: u, headers: {}, text: "", setCookie: [], error: e?.cause?.code || e?.name || e?.message || "failed" }; }
  };
  // 1. the home page over https
  const home = await get(url);
  R.home = { status: home.status, finalUrl: home.url, bytes: home.text.length, error: home.error || null, contentType: home.headers["content-type"] || null };
  R.headers = Object.fromEntries(HEADERS.map((h) => [h, home.headers[h] || null]));
  R.server = { server: home.headers.server || null, poweredBy: home.headers["x-powered-by"] || null };
  R.cookies = home.setCookie.map((c) => { const name = c.split("=")[0].trim(); const l = c.toLowerCase(); return { name, secure: /;\s*secure/.test(l), httpOnly: /;\s*httponly/.test(l), sameSite: /;\s*samesite=/.test(l) }; });
  // 2. http -> https
  const http = await get(`http://${host}/`, { redirect: "manual", method: "HEAD", timeout: 8000 });
  R.http = { status: http.status, location: http.headers.location || null, toHttps: /^https:/i.test(http.headers.location || "") || (http.status === 0 && home.ok) };
  // 3. the certificate
  if (tlsInfo) { try { R.tls = await tlsInfo(host); } catch (e) { R.tls = { error: e.message }; } }
  // 4. the page itself
  const html = home.text;
  R.htmlText = html.slice(0, KEEP_HTML); // for the panel; the JSON and the page keep the numbers only
  const title = grab(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const h = R.html = {
    title, description: grab(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || grab(html, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i),
    lang: grab(html, /<html[^>]+lang=["']([^"']+)["']/i), viewport: /<meta[^>]+name=["']viewport["']/i.test(html), canonical: grab(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i),
    og: /<meta[^>]+property=["']og:(title|image)["']/i.test(html), h1: count(html, /<h1[\s>]/gi), images: count(html, /<img[\s>]/gi), imagesNoAlt: count(html, /<img(?![^>]*\balt=)[^>]*>/gi),
    scripts: count(html, /<script[\s>]/gi), inlineScripts: count(html, /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi), styles: count(html, /<link[^>]+rel=["']stylesheet["']/gi),
    externalScriptHosts: [...new Set([...html.matchAll(/<script[^>]+src=["'](https?:\/\/[^/"']+)/gi)].map((m) => m[1].replace(/^https?:\/\//, "")).filter((x) => !sameHost(`https://${x}`, host)))].slice(0, 20),
    mixed: [...new Set([...html.matchAll(/(?:src|href)=["'](http:\/\/[^"']+)["']/gi)].map((m) => m[1]))].slice(0, 20),
    formsToHttp: count(html, /<form[^>]+action=["']http:\/\//gi), forms: count(html, /<form[\s>]/gi), passwordFields: count(html, /type=["']password["']/gi),
    libraries: [...new Set([...html.matchAll(/(jquery|bootstrap|angular|react|vue|lodash|moment)[.-]?(\d+\.\d+(?:\.\d+)?)/gi)].map((m) => `${m[1].toLowerCase()} ${m[2]}`))].slice(0, 10),
    privacyLink: /href=["'][^"']*(privacy|cookie)[^"']*["']/i.test(html), termsLink: /href=["'][^"']*(terms|conditions)[^"']*["']/i.test(html), contact: /mailto:|href=["'][^"']*contact/i.test(html),
  };
  // 5. robots, sitemap, security.txt
  const robots = await get(`https://${host}/robots.txt`, { timeout: 8000 }); R.robots = robots.ok && /user-agent/i.test(robots.text) ? "present" : "absent";
  const sitemap = await get(`https://${host}/sitemap.xml`, { method: "HEAD", timeout: 8000 }); R.sitemap = sitemap.ok ? "present" : "absent";
  const sec = await get(`https://${host}/.well-known/security.txt`, { timeout: 8000 }); R.securityTxt = sec.ok && /contact:/i.test(sec.text) ? "present" : "absent";
  // 6. files that should not be reachable (a 200 with the kind of content expected is a finding)
  for (const p of EXPOSED) {
    const r = await get(`https://${host}${p}`, { max: 4000, timeout: 8000 });
    if (!r.ok) continue;
    const t = r.text;
    const looks = p === "/.env" ? /^[A-Z_]+=.+/m.test(t) : p.startsWith("/.git") ? /\[core\]|ref: refs\//.test(t) : p === "/phpinfo.php" ? /phpinfo|PHP Version/i.test(t) : p === "/server-status" ? /Apache Server Status/i.test(t) : /\.(zip|sql)$/.test(p) ? !/<html/i.test(t) : p === "/.DS_Store" ? t.startsWith("\u0000\u0000\u0000\u0001") : p === "/.htpasswd" ? /^[^:\s]+:\$?[\w$./]+$/m.test(t) : /\{|\[/.test(t) && !/<html/i.test(t);
    if (looks) R.exposed.push(p);
  }
  // 7. a directory listing where the page's own assets live
  const dirs = [...new Set([...html.matchAll(/(?:src|href)=["'](\/[^"']+\/)[^"'/]+\.(?:js|css|png|jpg|svg)["']/gi)].map((m) => m[1]))].slice(0, 3);
  for (const d of dirs) { const r = await get(`https://${host}${d}`, { max: 4000, timeout: 8000 }); if (r.ok && /<title>Index of/i.test(r.text)) R.listing.push(d); }
  // 8. broken links on the page, the site's own
  const links = [...new Set([...html.matchAll(/href=["'](\/[^"'#?]*|https?:\/\/[^"'#?]+)["']/gi)].map((m) => m[1]).map((l) => (l.startsWith("/") ? `https://${host}${l}` : l)).filter((l) => sameHost(l, host) && !/\.(png|jpg|svg|css|js|pdf|zip|mp4)$/i.test(l)))].slice(0, MAX_LINKS);
  for (const l of links) { const r = await get(l, { method: "HEAD", timeout: 8000 }); if (r.status === 404 || r.status === 410) R.broken.push(l); }
  R.linksTried = links.length;
  return R;
}

/// The findings the checks give by themselves, in the review's shape (severity, where, what, why, failure case, fix).
export function siteFindings(R) {
  const F = [];
  const add = (severity, title, where, what, why, failure_case, fix) => F.push({ title, severity, file: where, line: null, what, why_it_matters: why, failure_case, fix });
  if (R.home?.error || !R.home || R.home.status === 0) add("critical", "The site did not answer over https", R.url, `The home page could not be fetched (${R.home?.error || "no answer"}).`, "Nobody can use a site that does not load.", `GET ${R.url} fails with ${R.home?.error || "no answer"}.`, "Check the server, the DNS and the certificate.");
  else if (R.home.status >= 400) add("high", `The home page answers ${R.home.status}`, R.url, `The home page returned status ${R.home.status}.`, "Visitors see an error.", `GET ${R.url} returns ${R.home.status}.`, "Fix the page or the server configuration.");
  for (const p of R.exposed || []) add(/\.env|\.git|htpasswd|\.sql|backup/.test(p) ? "critical" : "high", `${p} is readable by anyone`, `https://${R.host}${p}`, `The file ${p} answers with its contents.`, p === "/.env" ? "Secrets and keys in it are public." : p.startsWith("/.git") ? "The whole source history can be downloaded." : "Internal files leak.", `GET https://${R.host}${p} returns 200 with the file.`, "Block the path on the server, remove the file from the web root, rotate any secret it held.");
  for (const d of R.listing || []) add("medium", `Directory listing at ${d}`, `https://${R.host}${d}`, "The folder shows its file list.", "Every file in it is discoverable, including ones not linked.", `GET https://${R.host}${d} returns an index page.`, "Switch directory listing off on the server.");
  if (R.http && !R.http.toHttps) add("high", "http does not redirect to https", `http://${R.host}/`, `A plain http request ${R.http.status ? `answers ${R.http.status}` : "goes nowhere"} instead of redirecting to https.`, "Visitors typing the address without https land on an insecure page or nothing.", `curl -I http://${R.host}/ shows ${R.http.status || "no answer"} and ${R.http.location ? `location ${R.http.location}` : "no https location"}.`, "Redirect every http request to https with a 301.");
  if (R.tls?.validTo && R.tls.validTo - Date.now() < 14 * 86_400_000) add("high", "The certificate expires soon", `https://${R.host}/`, `The TLS certificate expires on ${new Date(R.tls.validTo).toISOString().slice(0, 10)}.`, "After that date browsers block the site.", `Check the certificate's dates with openssl s_client -connect ${R.host}:443.`, "Renew it, or set up automatic renewal.");
  if (R.headers && !R.headers["strict-transport-security"]) add("medium", "No Strict-Transport-Security header", `https://${R.host}/`, "The site does not tell browsers to use https only.", "A first visit over http can be intercepted.", `The response to GET ${R.url} has no strict-transport-security header.`, "Add: Strict-Transport-Security: max-age=31536000; includeSubDomains");
  if (R.headers && !R.headers["content-security-policy"]) add("low", "No Content-Security-Policy header", `https://${R.host}/`, "Scripts from any origin may run on the page.", "An injected script has free rein.", `The response to GET ${R.url} has no content-security-policy header.`, "Add a policy that names the script and style origins the site uses.");
  if (R.headers && !R.headers["x-content-type-options"]) add("low", "No X-Content-Type-Options header", `https://${R.host}/`, "Browsers may sniff content types.", "A file served as text can be run as a script.", "The response has no x-content-type-options header.", "Add: X-Content-Type-Options: nosniff");
  if (R.headers && !R.headers["x-frame-options"] && !/frame-ancestors/i.test(R.headers["content-security-policy"] || "")) add("low", "The page can be framed by any site", `https://${R.host}/`, "No X-Frame-Options header and no frame-ancestors rule.", "Clickjacking: the page inside an invisible frame on another site.", "The response has no x-frame-options and no frame-ancestors.", "Add: X-Frame-Options: DENY, or frame-ancestors 'self' in the policy.");
  for (const c of R.cookies || []) if (!c.secure || !c.httpOnly) add("medium", `Cookie ${c.name} without ${!c.secure ? "Secure" : "HttpOnly"}`, `https://${R.host}/`, `The cookie ${c.name} is set ${!c.secure ? "without the Secure flag" : "without the HttpOnly flag"}.`, !c.secure ? "It can be sent over plain http." : "A script on the page can read it.", `The Set-Cookie header for ${c.name} lacks ${!c.secure ? "Secure" : "HttpOnly"}.`, "Add the flag when setting the cookie.");
  if (R.html?.mixed?.length) add("medium", "Mixed content: http resources on an https page", R.url, `${R.html.mixed.length} resource${R.html.mixed.length === 1 ? "" : "s"} load over http, for example ${R.html.mixed[0]}.`, "Browsers block or warn, and the resource can be tampered with.", `The page's HTML references ${R.html.mixed[0]}.`, "Serve every resource over https.");
  if (R.html?.formsToHttp) add("high", "A form posts to http", R.url, `${R.html.formsToHttp} form${R.html.formsToHttp === 1 ? "" : "s"} send to an http address.`, "What the visitor types travels in the clear.", "The form's action starts with http://.", "Point the form at https.");
  if (R.html?.passwordFields && !R.headers?.["strict-transport-security"]) add("medium", "A login form without HSTS", R.url, "The page has a password field and the site does not force https.", "A password typed after an http first visit can be read on the way.", "The page has type=password and the response has no strict-transport-security header.", "Add the HSTS header.");
  for (const l of R.broken || []) add("low", `Broken link: ${l.replace(`https://${R.host}`, "") || "/"}`, l, "A link on the home page answers 404.", "Visitors hit a dead end; search engines count it against the site.", `HEAD ${l} returns 404.`, "Fix or remove the link.");
  if (R.html && !R.html.title) add("low", "The page has no title", R.url, "The HTML has no title element.", "Tabs, bookmarks and search results show nothing useful.", "The HTML has no <title>.", "Add a title.");
  if (R.html && !R.html.description) add("low", "No meta description", R.url, "The page has no description for search results.", "Search engines pick a random sentence.", "The HTML has no meta description.", "Add one sentence that says what the site is.");
  if (R.html && !R.html.viewport) add("medium", "No viewport meta tag", R.url, "The page does not set the viewport for phones.", "On a phone the page shows tiny, zoomed out.", "The HTML has no meta viewport.", 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.');
  if (R.html && !R.html.lang) add("low", "No language on the html element", R.url, "The html element has no lang attribute.", "Screen readers and translators guess.", "The HTML starts without lang.", 'Add lang="en" (or the site\'s language).');
  if (R.html?.imagesNoAlt) add("low", `${R.html.imagesNoAlt} image${R.html.imagesNoAlt === 1 ? "" : "s"} without alt text`, R.url, "Images on the page have no alt attribute.", "Blind visitors and search engines get nothing from them.", "img elements without alt.", "Add an alt text to each image, empty for decoration.");
  if (R.html && R.html.h1 === 0) add("low", "No h1 heading", R.url, "The page has no h1.", "The page has no stated subject for readers and search engines.", "No h1 in the HTML.", "Give the page one h1.");
  if (R.html && !R.html.privacyLink) add("low", "No privacy page linked", R.url, "No link to a privacy or cookie page was found on the home page.", "In the EU a site that stores anything about a visitor needs one.", "No href containing privacy or cookie on the home page.", "Add a privacy page and link it from the footer.");
  if (R.server?.poweredBy) add("low", "The server names its software", `https://${R.host}/`, `The response says x-powered-by: ${R.server.poweredBy}.`, "Attackers learn the stack and its version for free.", "The x-powered-by header is present.", "Remove the x-powered-by header.");
  return F;
}

/// The checks as a short table for the page: one line each, in Markdown.
export function checksText(R) {
  const yes = (v) => (v ? "yes" : "NO");
  const lines = [
    `- Home page: ${R.home?.status || "no answer"}${R.home?.error ? ` (${R.home.error})` : ""}, ${Math.round((R.home?.bytes || 0) / 1024)} KB of HTML`,
    `- http redirects to https: ${yes(R.http?.toHttps)}`,
    `- Certificate: ${R.tls?.validTo ? `valid until ${new Date(R.tls.validTo).toISOString().slice(0, 10)}${R.tls.issuer ? `, by ${R.tls.issuer}` : ""}` : R.tls?.error ? `could not be read (${R.tls.error})` : "not checked"}`,
    `- Security headers: ${HEADERS.map((h) => `${h.replace(/-/g, " ")} ${yes(R.headers?.[h])}`).join("; ")}`,
    `- Cookies on the home page: ${R.cookies?.length ? R.cookies.map((c) => `${c.name} (secure ${yes(c.secure)}, httponly ${yes(c.httpOnly)}, samesite ${yes(c.sameSite)})`).join(", ") : "none"}`,
    `- Files that should not be public: ${R.exposed?.length ? `EXPOSED ${R.exposed.join(", ")}` : `none of ${EXPOSED.length} tried`}`,
    `- Directory listing: ${R.listing?.length ? `ON at ${R.listing.join(", ")}` : "off"}`,
    `- Mixed content: ${R.html?.mixed?.length || 0}; forms to http: ${R.html?.formsToHttp || 0}; password fields: ${R.html?.passwordFields || 0}`,
    `- Page basics: title ${yes(R.html?.title)}, description ${yes(R.html?.description)}, viewport ${yes(R.html?.viewport)}, lang ${yes(R.html?.lang)}, canonical ${yes(R.html?.canonical)}, open graph ${yes(R.html?.og)}, h1 ${R.html?.h1 ?? 0}, images ${R.html?.images ?? 0} (${R.html?.imagesNoAlt ?? 0} without alt)`,
    `- Scripts: ${R.html?.scripts ?? 0} (${R.html?.inlineScripts ?? 0} inline), styles ${R.html?.styles ?? 0}, outside hosts: ${R.html?.externalScriptHosts?.length ? R.html.externalScriptHosts.join(", ") : "none"}; libraries seen: ${R.html?.libraries?.length ? R.html.libraries.join(", ") : "none"}`,
    `- robots.txt ${R.robots || "?"}, sitemap.xml ${R.sitemap || "?"}, security.txt ${R.securityTxt || "?"}; privacy page linked ${yes(R.html?.privacyLink)}, terms ${yes(R.html?.termsLink)}, a contact ${yes(R.html?.contact)}`,
    `- Links on the home page tried: ${R.linksTried ?? 0}, broken: ${R.broken?.length || 0}`,
    `- Server: ${R.server?.server || "not named"}${R.server?.poweredBy ? `, x-powered-by ${R.server.poweredBy}` : ""}`,
  ];
  return lines.join("\n");
}
