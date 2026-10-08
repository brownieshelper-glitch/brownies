// Hashtags per network, from what the platforms and the current guidance said on 2026-10-09:
// - TikTok caps a post at 5 tags in the app and reads them as search words: 3 to 5 that say what the video is.
// - Instagram: 3 to 5 relevant tags at the end of the caption; the words of the caption do the rest of the finding.
// - YouTube: "#Shorts" first in a Short's description, then 2 to 4 topic tags; past 15 tags YouTube ignores them all.
// - X: one tag at most and never a trending one (X's spam rules; the owner's rule). Facebook: 2 or 3.
// A trend's own tags (the ones under its top videos, found by Swirl) come first, so our version shows up in the
// same search; our evergreen cartoon tags fill the rest. A cartoon tag never carries a coin word.
export const LIMITS = { tiktok: 5, instagram: 5, youtube: 4, facebook: 3, x: 1 };
export const EVERGREEN = {
  cartoon: ["#brownies", "#cartoon", "#animation", "#funny", "#comedy", "#memes", "#fyp"],
  coin: ["#brownies", "#ai", "#ethereum"],
};
/// Coin words never go in a cartoon's tags (the cartoon never speaks about the coin).
export const TAG_BAN = /coins?|tokens?|crypto|^#?eth(ereum)?$|ethereum|sugar|buy|sell|pump(?!kin)|moon|invest|price|market|launch|wallet|airdrop|defi|web3|nft|memecoin|altcoin|trading|hodl/i;

/// "#Tag" made plain: ASCII letters, digits, underscores, 2 to 30 of them; null when it is not a tag.
export function cleanTag(t) {
  const s = String(t || "").trim().replace(/^#+/, "");
  return /^[A-Za-z0-9_]{2,30}$/.test(s) ? `#${s}` : null;
}

/// The tags for one network. `trend` brings the tags seen under the trend's top videos; `cartoon` false means a
/// video about the project (the coin set). On X only the brand tag, and only one.
export function tagsFor(platform, { trend = null, cartoon = true } = {}) {
  const lim = LIMITS[platform] ?? 5;
  const out = [], seen = new Set();
  const push = (t) => {
    const c = cleanTag(t);
    if (!c) return;
    const k = c.toLowerCase();
    if (seen.has(k) || (cartoon && TAG_BAN.test(c)) || (platform === "youtube" && k === "#shorts")) return;
    seen.add(k); out.push(c);
  };
  if (platform === "x") { push("#brownies"); return out.slice(0, 1); }
  if (trend) for (const t of Array.isArray(trend.hashtags) ? trend.hashtags : []) push(t);
  for (const t of cartoon ? EVERGREEN.cartoon : EVERGREEN.coin) push(t);
  return out.slice(0, lim);
}

/// A caption with its tags at the end, on their own line.
export function withTags(text, tags) {
  const t = String(text || "").replace(/\s+#[A-Za-z0-9_]+(?=\s|$)/g, "").trim();
  return tags?.length ? `${t}\n\n${tags.join(" ")}` : t;
}
