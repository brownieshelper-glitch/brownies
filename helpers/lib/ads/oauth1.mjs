// OAuth 1.0a request signing (HMAC-SHA1), the way X's Ads API still wants it: the Authorization header for one
// request from the consumer pair and the user's token pair. RFC 5849; nothing else in here.
import { createHmac, randomBytes } from "node:crypto";

const enc = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/// The header value. params: the body or query parameters that take part in the signature (form-encoded ones).
export function oauth1Header({ consumerKey, consumerSecret, accessToken, accessSecret, method, url, params = {}, nonce = null, timestamp = null }) {
  const u = new URL(url);
  const base = `${u.protocol}//${u.host}${u.pathname}`;
  const oauth = { oauth_consumer_key: consumerKey, oauth_nonce: nonce || randomBytes(16).toString("hex"), oauth_signature_method: "HMAC-SHA1", oauth_timestamp: String(timestamp || Math.floor(Date.now() / 1000)), oauth_token: accessToken, oauth_version: "1.0" };
  const all = [];
  for (const [k, v] of u.searchParams) all.push([enc(k), enc(v)]);
  for (const [k, v] of Object.entries(params)) all.push([enc(k), enc(v)]);
  for (const [k, v] of Object.entries(oauth)) all.push([enc(k), enc(v)]);
  all.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const paramString = all.map(([k, v]) => `${k}=${v}`).join("&");
  const baseString = `${method.toUpperCase()}&${enc(base)}&${enc(paramString)}`;
  const key = `${enc(consumerSecret)}&${enc(accessSecret)}`;
  const signature = createHmac("sha1", key).update(baseString).digest("base64");
  const head = { ...oauth, oauth_signature: signature };
  return "OAuth " + Object.keys(head).sort().map((k) => `${enc(k)}="${enc(head[k])}"`).join(", ");
}
