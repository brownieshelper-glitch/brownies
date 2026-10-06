// Keys. A wallet key is the wallet's signature of a fixed message: no account, no secret to mint, nothing to store.
//   message  "Brownies API key, chain 4663, epoch N"
//   key      sk-brownie-<epoch>-<base64url(signature)>
// The gateway recovers the signer, checks the epoch against the account's current epoch (rotating bumps it and every
// older key dies on the next request), and bills the wallet's beneficiary id: bytes32(uint256(uint160(wallet))).
import { verifyMessage, getAddress, zeroPadValue } from "ethers";

export const KEY_PREFIX = "sk-brownie-";

export function keyMessage(chainId, epoch) {
  return `Brownies API key, chain ${chainId}, epoch ${epoch}`;
}

export function walletToBeneficiary(wallet) {
  return zeroPadValue(getAddress(wallet), 32).toLowerCase();
}

export function beneficiaryToWallet(b) {
  const hex = b.toLowerCase();
  if (!/^0x0{24}[0-9a-f]{40}$/.test(hex)) return null; // not a wallet-shaped beneficiary
  return getAddress("0x" + hex.slice(26));
}

function b64urlToHex(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return "0x" + Buffer.from(b64, "base64").toString("hex");
}

export function hexToB64url(hex) {
  return Buffer.from(hex.replace(/^0x/, ""), "hex").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/// Build a key from a signature (what the site does in the browser after the wallet signs).
export function keyFromSignature(signature, epoch) {
  return `${KEY_PREFIX}${epoch}-${hexToB64url(signature)}`;
}

/// Parse and verify a bearer key. Returns { wallet, beneficiary, epoch } or throws an Error with .status.
export function verifyKey(bearer, chainId) {
  if (!bearer || !bearer.startsWith(KEY_PREFIX)) throw err(401, "missing_api_key", `Send Authorization: Bearer ${KEY_PREFIX}<epoch>-<signature>.`);
  const rest = bearer.slice(KEY_PREFIX.length);
  const dash = rest.indexOf("-");
  if (dash <= 0) throw err(401, "invalid_api_key", "Malformed key.");
  const epoch = Number(rest.slice(0, dash));
  if (!Number.isInteger(epoch) || epoch < 0) throw err(401, "invalid_api_key", "Malformed epoch.");
  let sig;
  try {
    sig = b64urlToHex(rest.slice(dash + 1));
    if (!/^0x[0-9a-f]{130}$/.test(sig)) throw new Error("len");
  } catch {
    throw err(401, "invalid_api_key", "Malformed signature.");
  }
  let wallet;
  try {
    wallet = verifyMessage(keyMessage(chainId, epoch), sig);
  } catch {
    throw err(401, "invalid_api_key", "Signature does not verify.");
  }
  return { wallet, beneficiary: walletToBeneficiary(wallet), epoch };
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
