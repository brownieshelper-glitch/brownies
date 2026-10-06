// The channel from the owner's PC, with the tokens tools/youtube-auth.mjs saved. Nothing prints a token.
//
//   node tools/youtube-channel.mjs status                         the channel, its subscribers, its uploads
//   node tools/youtube-channel.mjs banner "<png 2560x1440>"       sets the banner
//   node tools/youtube-channel.mjs bio                            writes the description and keywords below
//   node tools/youtube-channel.mjs upload "<mp4>" --title "..." [--description-file f] [--tags a,b] [--privacy unlisted|public|private] [--thumbnail png]
//   node tools/youtube-channel.mjs privacy <videoId> public|unlisted|private
import { readFileSync } from "node:fs";
import { readEnvFile } from "../helpers/lib/env.mjs";
import { youtubeFromEnv } from "../helpers/lib/youtube.mjs";

const S = process.env.SECRETS_DIR || "C:/Users/andrea/helix-secrets";
readEnvFile(`${S}/brownies-youtube.env`);
const yt = youtubeFromEnv(process.env, { log: console.log });
if (!yt.configured) { console.log(`No tokens yet: run node tools/youtube-auth.mjs first (writes ${S}/brownies-youtube.env).`); process.exit(1); }

/// The channel's description: plain words, the facts the site states, every place where the project lives.
export const BIO = `Brownies is a coin on Ethereum with four little AI helpers working for it. Fudge writes the posts, Crumb answers everyone on Telegram, Nib reads the chain and the competition, Chip builds the site. Every buy and every sell of BROWNIE pays a 2% tax: 35% of it buys AI for the people who stake, paid in SUGAR (one SUGAR pays for one dollar of AI on our gateway), 30% feeds the brownies, 35% goes to the team. Every job the brownies finish is a brick in the Kitchen, live on the site.

Here: short cartoon episodes of the brownies at work, explainers, and the numbers, told by the brownies themselves.

Site: https://feedthebrownies.com
The Kitchen, what the brownies did today: https://feedthebrownies.com/team.html
X: https://x.com/Feedthebrownies
Telegram: https://t.me/feedthebrownies
Code: https://github.com/brownieshelper-glitch/brownies
API: https://api.feedthebrownies.com

Not launched yet. SUGAR is access to AI, not an investment, and nothing here is financial advice.`;
export const KEYWORDS = ["Brownies", "BROWNIE", "SUGAR", "Ethereum", "AI helpers", "AI agents", "crypto cartoon", "memecoin", "feedthebrownies"];

const args = process.argv.slice(2);
const cmd = args[0] || "status";
const opt = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };

try {
  if (cmd === "status") {
    const ch = await yt.channel();
    console.log(`channel "${ch.snippet.title}" (${ch.id}), ${ch.statistics?.subscriberCount ?? "?"} subscribers, ${ch.statistics?.videoCount ?? "0"} videos`);
    console.log(`description: ${(ch.brandingSettings?.channel?.description || "(empty)").split("\n")[0].slice(0, 120)}`);
    console.log(`keywords: ${ch.brandingSettings?.channel?.keywords || "(none)"}`);
    console.log(`banner: ${ch.brandingSettings?.image?.bannerExternalUrl ? "set" : "not set"}`);
    for (const v of await yt.uploads(10)) console.log(`  ${v.publishedAt?.slice(0, 10) || "unpublished"}  ${v.url}  ${v.title}`);
  } else if (cmd === "banner") {
    const r = await yt.setBanner(args[1]);
    console.log(`banner set (${(r.bytes / 1e6).toFixed(2)} MB)`);
  } else if (cmd === "bio") {
    const b = await yt.updateBranding({ description: BIO, keywords: KEYWORDS });
    console.log(`description written (${b.channel.description.length} characters), keywords: ${b.channel.keywords}`);
  } else if (cmd === "upload") {
    const file = args[1];
    const title = opt("title");
    if (!file || !title) { console.log("upload needs a file and --title"); process.exit(1); }
    const description = opt("description-file") ? readFileSync(opt("description-file"), "utf8") : opt("description", "");
    const tags = (opt("tags", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const v = await yt.upload({ file, title, description, tags, privacy: opt("privacy", "unlisted") });
    console.log(`${v.privacy}: ${v.url}`);
    if (opt("thumbnail")) { try { await yt.setThumbnail(v.id, opt("thumbnail")); console.log("thumbnail set"); } catch (e) { console.log(`thumbnail not set: ${e.message}`); } }
  } else if (cmd === "privacy") {
    const s = await yt.setPrivacy(args[1], args[2]);
    console.log(`video ${args[1]} is now ${s.privacyStatus}`);
  } else console.log("commands: status, banner <png>, bio, upload <mp4> --title ..., privacy <videoId> <public|unlisted|private>");
} catch (e) {
  console.log(`failed: ${e.message}`);
  process.exit(1);
}
