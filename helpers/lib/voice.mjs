// The voice of the brownies, and the checks that keep a model's text inside it. Plain sentences, one idea per
// sentence, ASCII only, no promise of price or returns, no boilerplate, no hashtag storm. The same rules are
// written in the system prompt and checked again on the way out, because a model does not always listen.

const PUNCT = { "‘": "'", "’": "'", "‚": "'", "“": '"', "”": '"', "„": '"', "–": "-", "—": "-", "−": "-", "…": "...", " ": " ", "·": "-", "•": "-" };

/// Smart punctuation becomes plain punctuation; every other non-ASCII character (emoji included) is dropped.
export function toAscii(s) {
  return String(s ?? "").replace(/[‘’‚“”„–—−… ·•]/g, (c) => PUNCT[c]).replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "");
}

/// A model's answer, made plain: ASCII, no wrapping quotes, no code fences, one space between words, trimmed.
export function tidy(s) {
  let t = toAscii(s).replace(/\r/g, "").replace(/^```[a-z]*\n?|```$/g, "").trim();
  if (/^".*"$/s.test(t) || /^'.*'$/s.test(t)) t = t.slice(1, -1).trim();
  return t.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Words that promise a price or a gain, or that tell people to buy. None of them belongs in a brownie's mouth.
export const PROMISES = /\b(to the moon|moon(ing|shot|ed)?|\d+x\b|guaranteed?|will go up|will rise|will pump|price target|pumps?|pumping|hidden gem|get rich|easy money|can('|no)?t lose|cannot lose|wagmi|lfg|ape in|buy now|buy the dip|last chance|don'?t miss|do not miss|(guaranteed|high|big|safe|passive) (returns?|income|profits?)|\d+ ?% (returns?|apy|apr|gains?))\b/i;
export const BOILERPLATE = /\b(not financial advice|nfa|dyor|do your own research|this is not advice|no financial advice|financial advice)\b/i;

/// What is wrong with a text, as a list of short reasons. An empty list means it can go out.
export function problems(text, { maxLen = 280, maxHashtags = 1 } = {}) {
  const out = [];
  const t = String(text ?? "");
  if (!t.trim()) out.push("empty");
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(t)) out.push("non-ascii characters");
  if (t.length > maxLen) out.push(`longer than ${maxLen} characters`);
  if ((t.match(/(^|\s)#\w+/g) || []).length > maxHashtags) out.push("too many hashtags");
  const p = t.match(PROMISES);
  if (p) out.push(`promise words: ${p[0]}`);
  if (BOILERPLATE.test(t)) out.push("boilerplate");
  if ((t.match(/\$[A-Z]{2,10}\b/g) || []).length > 2) out.push("ticker spam");
  if (/\b(private key|seed phrase|mnemonic|password)\b/i.test(t)) out.push("talks about secrets");
  return out;
}

export const RULES = `How you write:
- Plain sentences. One idea per sentence. Short words where they exist.
- ASCII only. No emoji, no smart quotes, no long dashes.
- Never promise a price, a gain or a return. Never tell anyone to buy or sell.
- No "not financial advice", no "DYOR", no boilerplate of any kind.
- No hashtag storm. One hashtag at most, and usually none.
- Facts only, and only from the facts you were given. If you do not know a number, do not invent one: say where it can be read.
- Never ask for or mention private keys, seed phrases or passwords.
- Do not sign your messages and do not add a title unless asked.`;

/// The system prompt every brownie starts from. `extra` is the helper's own instructions.
export function systemPrompt({ name, role, facts = "", note = "", extra = "" }) {
  return [
    `You are ${name}, one of the four brownies: the AI helpers that work for the BROWNIE coin on Ethereum. Your job: ${role}.`,
    `The site is https://feedthebrownies.com and the gateway is https://api.feedthebrownies.com.`,
    RULES,
    facts ? `FACTS (the only source of numbers and claims)\n${facts}` : "",
    note ? `LATEST RESEARCH NOTE, written by Nib\n${note}` : "",
    extra,
  ].filter(Boolean).join("\n\n");
}
