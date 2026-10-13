// Keys. A key is a random secret the gateway makes after a sign-in and keeps only as a hash:
//   1. POST /v1/auth/challenge { wallet }       -> the sign-in message for that wallet
//   2. the wallet signs the message
//   3. POST /v1/auth/key { nonce, signature }   -> { key: "sk-brownie-k1.<43 characters>", expires_at }
// The message is a "Sign-In with Ethereum" one (EIP-4361): it names the site it is good on, so a wallet that knows
// the format warns when another site asks for it; it carries a number that works once; it runs out in five minutes.
// The key runs out too (30 days unless asked otherwise), and rotating ends every key of the wallet at once.
//
// Until 2026-10-13 a key WAS the wallet's signature of a fixed sentence ("Brownies API key, chain 1, epoch N").
// Any page that got a wallet to sign that sentence held the key until it was rotated, without ever talking to us
// (finding 23 of the gateway's own review). Those keys are refused now, with a line that says how to get a new one.
// The gateway bills the wallet's beneficiary id: bytes32(uint256(uint160(wallet))).
import { createHash, randomBytes } from "node:crypto";
import { verifyMessage, getAddress, zeroPadValue } from "ethers";

export const KEY_PREFIX = "sk-brownie-";
export const KEY_KIND = "k1.";
export const SIGNIN_TTL_MS = 5 * 60_000;
export const SIGNIN_STATEMENT = "Sign in to get your Brownies API key. This moves no money. Sign it only on the site named in the first line.";

export function walletToBeneficiary(wallet) {
  return zeroPadValue(getAddress(wallet), 32).toLowerCase();
}

export function beneficiaryToWallet(b) {
  const hex = b.toLowerCase();
  if (!/^0x0{24}[0-9a-f]{40}$/.test(hex)) return null; // not a wallet-shaped beneficiary
  return getAddress("0x" + hex.slice(26));
}

/// A number that works once: 32 hex characters.
export const newNonce = () => randomBytes(16).toString("hex");

/// The sign-in message, word for word as EIP-4361 lays it out. `origin` is the page that asks (https://site), and
/// `domain` its host: the first line is what a person, and a wallet, reads to know who is asking.
export function signInMessage({ domain, origin = `https://${domain}`, wallet, chainId, nonce, issuedAt, expiresAt }) {
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    getAddress(wallet),
    "",
    SIGNIN_STATEMENT,
    "",
    `URI: ${origin}`,
    "Version: 1",
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date(issuedAt).toISOString()}`,
    `Expiration Time: ${new Date(expiresAt).toISOString()}`,
  ].join("\n");
}

/// Which site a sign-in is for. A browser says where it is (the Origin header): that host must be on the list, and
/// it is the one the message names, so a page elsewhere cannot get a message for itself. A program has no Origin: it
/// may name a site on the list, or gets the first. Returns { domain, origin }; throws 403 for a site off the list.
export function signInSite(allowed, { originHeader = "", asked = "" } = {}) {
  const list = allowed.map((d) => String(d).trim().toLowerCase()).filter(Boolean);
  if (!list.length) throw err(503, "signin_unconfigured", "This gateway names no site to sign in on.");
  if (originHeader) {
    let u; try { u = new URL(originHeader); } catch { throw err(403, "bad_origin", "The Origin of this request is not a site."); }
    if (!list.includes(u.host.toLowerCase())) throw err(403, "site_not_allowed", `Keys are made on ${list[0]} only, not on ${u.host}.`);
    return { domain: u.host.toLowerCase(), origin: u.origin };
  }
  const d = String(asked || "").trim().toLowerCase();
  if (d && !list.includes(d)) throw err(403, "site_not_allowed", `Keys are made on ${list[0]} only, not on ${d}.`);
  const domain = d || list[0];
  return { domain, origin: `${/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(domain) ? "http" : "https"}://${domain}` };
}

/// Who signed a message, or null when the signature is not one.
export function signerOf(message, signature) {
  try { return getAddress(verifyMessage(message, signature)); } catch { return null; }
}

const hashOf = (key) => createHash("sha256").update(key).digest("hex");

/// A new key and the hash it is kept as. The key itself is shown to its owner once and never stored.
export function mintKey() {
  const key = `${KEY_PREFIX}${KEY_KIND}${randomBytes(32).toString("base64url")}`;
  return { key, hash: hashOf(key) };
}

/// The hash a bearer key is looked up by; throws an Error with .status when it is not a key at all, and says so
/// plainly when it is one of the old kind (a signature), which nobody can make safely any more.
export function keyHash(bearer) {
  const how = "Get a key by signing in: POST /v1/auth/challenge { wallet }, sign the message, POST /v1/auth/key { nonce, signature }.";
  if (!bearer || !bearer.startsWith(KEY_PREFIX)) throw err(401, "missing_api_key", `Send Authorization: Bearer ${KEY_PREFIX}${KEY_KIND}<key>. ${how}`);
  const rest = bearer.slice(KEY_PREFIX.length);
  if (/^\d+-[A-Za-z0-9_-]{20,}$/.test(rest)) throw err(401, "key_retired", `Keys that were a wallet's signature of a fixed sentence are no longer taken. ${how}`);
  if (!rest.startsWith(KEY_KIND) || !/^[A-Za-z0-9_-]{43}$/.test(rest.slice(KEY_KIND.length))) throw err(401, "invalid_api_key", `Malformed key. ${how}`);
  return hashOf(bearer);
}

/// A wallet address from a header or a body field: checksummed, or null when empty; throws 400 when malformed.
export function parseWallet(value, what = "wallet") {
  const v = String(value ?? "").trim();
  if (!v) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw err(400, "bad_wallet", `${what} must be an address.`);
  return getAddress(v);
}

export function err(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}
