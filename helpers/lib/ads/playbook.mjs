// Butterscotch's knowledge: the playbook (helpers/ads/playbook.md) read into memory, the rules a creative or a
// caption must pass before it is paid for, the two lanes we advertise, and the KPIs with their starting
// thresholds. The "Learned" notes the weekly study adds live in the store and are appended when the playbook
// is read, so a prompt always sees the whole of it.
import { readFileSync, existsSync } from "node:fs";
import { htmlToText } from "../text.mjs";

export const PLAYBOOK_FILE = new URL("../../ads/playbook.md", import.meta.url);

// The two lanes, in the owner's words (2026-10-11): "no reference to be crypto related"; the services are "agents
// able to manage alone socials and all the jobs they do, and services available through us".
export const LANES = {
  stories: { title: "The stories", what: "the cartoon series, the daily episodes, the kitchen cam, the Room", ask: "watch, follow, subscribe, join the group", landing: "/room.html", objective: { meta: "video views", tiktok: "video views", x: "video views" } },
  services: { title: "The services", what: "four AI agents that run their own socials and do all their jobs alone, all day, and the services available through them: a cartoon clip of the four brownies about your idea, a meme, a research note, bought per request; an API an agent can call on its own", ask: "order one clip, try the API", landing: "/shop.html", objective: { meta: "landing page views", tiktok: "website conversions", x: "website traffic" } },
};
export const PLATFORMS = ["meta", "tiktok", "x"];

/// Words that must never appear in an ad, a caption, a thumbnail or anywhere on a landing page reached from an ad
/// (section 1): the trading words, and every word that says "crypto" at all, since the owner wants no reference.
export const AD_BANNED = /\b(buy|buys|buying|stake|stakes|staking|stakers|earn|earns|earning|yield|returns?|profits?|price|prices|pump|pumps|moon|mooning|airdrops?|presale|pre-sale|launch(?:ed|ing)?|chart|charts|wallets?|not financial advice|nfa|dyor|ticker|contract address|ico|token sale|guaranteed|100x|1000x|crypto|cryptocurrency|cryptocurrencies|tokens?|tokenomics|coins?|memecoins?|blockchain|on-?chain|on chain|ethereum|eth|web3|defi|nfts?|usdc|stablecoins?|hodl|degen|mcap|market cap|liquidity|dex|swaps?|mints?|minted|minting|holders?|tax|taxes|trading|traders?|smart contracts?|contracts?|x402)\b|\$[A-Za-z]{2,10}\b|0x[0-9a-fA-F]{40}/i;
/// The names that are coin words only in capitals: the ticker and the credit. "a sugar cube" is a cartoon; "SUGAR" is a token.
export const AD_BANNED_CAPS = /\b(BROWNIE|SUGAR)\b/;

/// The thresholds of section 4 and 5, by placement where it matters.
export const KPI = {
  hookRate: { reels: 0.30, tiktok: 0.30, feed: 0.20, x: 0.15 },
  holdRate: 0.25,
  killAtTimesTarget: 3, holdAtTimesTarget: 2, holdDays: 3,
  scaleStepPct: 20, scaleEveryDays: 2, fatigueFrequency: 3, fatigueCtrDrop: 0.30,
  overPacePct: 15, underPacePct: 30, underPaceDays: 2,
  testSharePct: 30,
  minimums: { tiktok: { campaignDailyUsd: 50, adgroupDailyUsd: 20 }, meta: { adsetDailyUsd: 10 }, x: { campaignDailyUsd: 10 } },
  benchmarks: { meta: { cpm: [3, 9], cpc: [0.3, 1.3], ctr: [0.005, 0.02] }, tiktok: { cpm: [2, 8], cpc: [0.3, 1.5], ctr: [0.004, 0.012] }, x: { cpm: [5, 15], cpc: [0.2, 0.9], ctr: [0.006, 0.012] } },
};

/// The playbook's text, with the learned notes from the store (meta "ads:learned", a JSON list of { at, text, source }).
export function playbookText(store = null, { maxLearned = 20 } = {}) {
  const base = existsSync(PLAYBOOK_FILE) ? readFileSync(PLAYBOOK_FILE, "utf8") : "# Butterscotch's playbook\n(the file is missing)\n";
  const learned = learnedNotes(store).slice(-maxLearned);
  if (!learned.length) return base;
  return `${base.trimEnd()}\n\n${learned.map((n) => `- ${new Date(n.at).toISOString().slice(0, 10)}: ${n.text}${n.source ? ` (${n.source})` : ""}`).join("\n")}\n`;
}
export function learnedNotes(store) {
  if (!store) return [];
  try { const v = JSON.parse(store.getMeta("ads:learned") || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function addLearned(store, { at, text, source = null }) {
  const list = learnedNotes(store);
  list.push({ at, text: String(text).replace(/\s+/g, " ").trim().slice(0, 600), source: source ? String(source).slice(0, 200) : null });
  store.setMeta("ads:learned", JSON.stringify(list.slice(-60)));
  return list.length;
}

/// One section of the playbook by its number ("2" gives the platforms table), or "" when there is none.
export function section(n, text = playbookText()) {
  const m = new RegExp(`^## ${n}\\. [^\\n]*\\n([\\s\\S]*?)(?=^## |\\Z)`, "m").exec(text);
  return m ? m[0].trim() : "";
}

/// What is wrong with a line of ad copy, a caption or a landing headline: [] when it may go out.
export function adProblems(text) {
  const out = [];
  const t = String(text || "");
  const bad = t.match(AD_BANNED) || t.match(AD_BANNED_CAPS);
  if (bad) out.push(`the word "${bad[0]}" (section 1: never in an ad)`);
  if (/https?:\/\/|www\./i.test(t) && !/utm_source=/.test(t)) out.push("a link without the UTM tags (section 4)");
  if (/[^\x20-\x7E\n]/.test(t)) out.push("characters that are not plain ASCII");
  if (t.length > 280) out.push("longer than 280 characters");
  return out;
}

/// A landing page against the word list: the coin words anywhere in its readable text (each once, in the order
/// found), and those inside the first screen (the first `firstScreen` characters). An ad reviewer reads the whole page.
export function landingProblems(html, { firstScreen = 700 } = {}) {
  const text = htmlToText(html, 200_000);
  const found = (s) => {
    const out = new Set();
    for (const m of s.matchAll(new RegExp(AD_BANNED.source, "gi"))) out.add(m[0].toLowerCase());
    for (const m of s.matchAll(new RegExp(AD_BANNED_CAPS.source, "g"))) out.add(m[0]);
    return [...out];
  };
  return { words: found(text), firstScreen: found(text.slice(0, firstScreen)), chars: text.length };
}

/// A plain summary of what a platform allows and what it needs, from section 2, for the owner.
export function rulesFor(platform, text = playbookText()) {
  const row = section(2, text).split("\n").find((l) => l.startsWith("| ") && l.toLowerCase().includes(`| ${platform === "x" ? "x " : platform}`));
  if (!row) return `No rule row for ${platform}.`;
  const [, name, allowed, not, access] = row.split("|").map((s) => s.trim());
  return `${name}. Allowed for us: ${allowed} Not allowed: ${not} API access: ${access}`;
}
