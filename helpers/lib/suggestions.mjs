// Suggestions from the public: what people on X and Telegram ask the brownies to post, add, list, look at or
// partner with. The brownies never act on them. Each one is kept in the owner's list in the control room, with
// flags for what is bait: a link, a wallet or contract address, another coin's ticker, drainer words. The owner
// reads the list and marks each one "listen" or "ignore"; only the ones he marked "listen" ever reach a brownie's
// prompt, and even then as a thing to consider, never a promise, never a link or an address to pass on.
import { LINK, ADDRESS, HANDLE } from "./xrules.mjs";
import { cut } from "./text.mjs";

/// The tickers that are ours or plain money; any other $TICKER is another project's.
export const OUR_TICKERS = new Set(["BROWNIE", "BROWNIES", "SUGAR", "ETH", "BTC", "USDC", "USDT", "USD", "EUR"]);
export const TICKER = /\$([A-Za-z][A-Za-z0-9]{1,9})\b/g;
/// A Solana-style address or any base58 run of that length.
export const BASE58 = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
/// The words of a drainer, a presale, a shill or a "launch" pitch.
export const DRAINER = /\b(connect (your )?wallet|claim (your|the|it|now|rewards?)|verify (your )?wallet|sign (this|the) (message|transaction)|approve (the|this) (token|contract)|mint (now|live)|free mint|presale|pre-sale|whitelist|airdrop|wallet drainer|seed phrase|private key|giveaway|double your|pump\.fun|bonk\.fun|launch(ed|ing)? (on|at|today|soon)|new (coin|token|launch|gem)|our (token|coin|project|launch)|listing|partnership|collab(oration)?|cross[- ]promot\w*|shill)\b/i;
/// A message that proposes something to the brownies.
export const SUGGESTS = /\b(you should|u should|should (post|add|list|try|look|check|do|make|consider|follow|support)|suggest\w*|idea|why don'?t you|why not|consider|please (add|post|list|check|look|try|make|follow|retweet|repost|share)|can you (add|post|list|check|look|try|make|share|promote|follow|retweet|repost)|could you|would you|let'?s|would be (nice|cool|great|good)|feature request|check out|take a look|look at|look into|have a look|add (support|this)|list (on|this|it)|partner|promote|post about|tweet about|talk about|mention (us|them|this|it|my))\b/i;

/// What a message carries that a brownie must never pass on, as short words. Empty means plain words.
export function flags(text) {
  const t = String(text || "");
  const out = [];
  if (LINK.test(t)) out.push("link");
  if (ADDRESS.test(t) || /0x[0-9a-fA-F]{40}/.test(t) || BASE58.test(t)) out.push("address");
  const tickers = [...t.matchAll(TICKER)].map((m) => m[1].toUpperCase()).filter((s) => !OUR_TICKERS.has(s));
  if (tickers.length) out.push("ticker");
  if (DRAINER.test(t)) out.push("drainer words");
  return out;
}

/// True for a message that proposes something, or that carries a link, an address, a ticker or drainer words.
export function isSuggestion(text) {
  const t = String(text || "").replace(HANDLE, " ");
  return SUGGESTS.test(t) || flags(t).length > 0;
}

/// The text made safe to read: a link cannot be clicked or pasted by mistake (hxxps://, example[.]com).
export function defang(text) {
  return String(text || "")
    .replace(/\bhttps?:\/\//gi, (m) => m.slice(0, 1) + "xx" + m.slice(3))
    .replace(/\b([a-z0-9-]+)\.(com|io|xyz|fun|net|org|app|gg|finance|co|me|fi|eth|sol|link|site|dev|ai|so|to|ly|info|tv|club|cash|money|exchange|market|tech|network)\b/gi, "$1[.]$2");
}

/// The fixed answers. Plain suggestions get the first; anything with a link, an address, a ticker or drainer
/// words gets the second (in a private chat) or nothing at all (on X and in the group), so bait is never amplified.
export const SUGGEST_LINE = "Noted. The owner reads every suggestion himself and decides; the brownies cannot promise anything.";
export const FLAGGED_LINE = "The brownies never open links or addresses sent to them, and never pass them on. The owner reads every suggestion himself and decides.";

/// A note for the owner's Telegram, once an hour at most (the alert topic "suggestions" is rate limited).
export function noticeText(store, now, siteUrl) {
  const today = store.suggestionsSince(store.dayStart(now));
  const risky = today.filter((s) => s.flags.length).length;
  return `New suggestions from the public are in your control room: ${today.length} today${risky ? `, ${risky} with a link, an address, another coin or drainer words` : ""}. Nothing was done with them. Read and decide at ${siteUrl}/admin.html, or /suggestions here.`;
}

/// The block for a brownie's prompt: the suggestions the owner marked "listen", at most ten, defanged.
export function acceptedSuggestionsText(store) {
  if (!store?.suggestions) return "";
  const rows = store.suggestions({ state: "listen", limit: 10 });
  if (!rows.length) return "";
  return rows.map((s) => `- ${s.who ? "@" + s.who : "someone"} on ${s.place === "x" ? "X" : "Telegram"}${s.note ? ` (the owner says: ${cut(s.note, 160)})` : ""}: ${cut(defang(s.text).replace(/\s+/g, " "), 300)}`).join("\n");
}

/// A few lines for /suggestions on Telegram: the newest ones waiting for the owner, defanged.
export function listText(store, siteUrl, n = 10) {
  const rows = store.suggestions({ state: "new", limit: n });
  if (!rows.length) return `No suggestion waits for you. The list lives at ${siteUrl}/admin.html.`;
  const lines = rows.map((s) => `${s.id}. [${s.place === "x" ? "X" : "Telegram"}${s.who ? ", @" + s.who : ""}${s.flags.length ? ", " + s.flags.join(", ") : ""}] ${cut(defang(s.text).replace(/\s+/g, " "), 200)}`);
  return `${rows.length} suggestion${rows.length === 1 ? "" : "s"} waiting for you (the brownies did nothing with them). Decide at ${siteUrl}/admin.html.\n\n${lines.join("\n")}`;
}
