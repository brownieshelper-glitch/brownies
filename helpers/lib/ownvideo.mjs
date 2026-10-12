// A video the owner made himself and sends to the bot in the private chat, with the text of the post as its
// caption: the video maker saves it, shows a card, and on Approve posts it with those words, unchanged.
// This file holds what is public about it: which message is a video, how the caption is read, the fetch of the
// file from Telegram, and the words of the card. The posting itself is the video maker's.
//
// The owner, 2026-10-12: "I want one of my agents uploading them after I send the video with the bio in the
// Telegram chat."
import { writeFileSync } from "node:fs";
import { xHardProblems } from "./xrules.mjs";

/// Telegram gives a bot files up to 20 MB (getFile); a larger one has to be sent smaller.
export const TG_MAX_BYTES = 20 * 1024 * 1024;
/// Where an own video goes when the caption names no place: every network, X among them (the owner, the same
/// evening: "I also want him to post on Twitter").
export const OWN_PLACES = ["youtube", "tiktok", "instagram", "facebook", "x"];
/// What a post on X takes.
export const X_MAX = 280;

/// Why the owner's text cannot go on X as he wrote it ([] when it can): longer than a post there, or something X
/// itself acts on (a link, an address, bait, money talk it calls a scam, a request for private information).
/// Then the brownie that posts on X writes a shorter post from his text instead, inside the same rules.
export function ownXProblems(text) {
  const t = String(text ?? "").trim();
  const out = [];
  const len = [...t].reduce((a, ch) => a + (ch.codePointAt(0) > 0xffff ? 2 : 1), 0);
  if (len > X_MAX) out.push(`it is ${len} characters and a post on X takes ${X_MAX}`);
  out.push(...xHardProblems(t, { kind: "post" }));
  return out;
}

const mb = (bytes) => (Number(bytes) / 1048576).toFixed(1);

/// The video in a Telegram message, or null: a video, or a file whose type or name says it is one.
/// { fileId, bytes, seconds, width, height, name }
export function pickVideo(m) {
  const v = m?.video || m?.animation || null;
  if (v?.file_id) return { fileId: v.file_id, bytes: Number(v.file_size) || 0, seconds: Number(v.duration) || 0, width: Number(v.width) || 0, height: Number(v.height) || 0, name: String(v.file_name || "") };
  const d = m?.document || null;
  if (d?.file_id && (/^video\//i.test(String(d.mime_type || "")) || /\.(mp4|mov|m4v|webm)$/i.test(String(d.file_name || "")))) return { fileId: d.file_id, bytes: Number(d.file_size) || 0, seconds: 0, width: 0, height: 0, name: String(d.file_name || "") };
  return null;
}

/// The caption the owner wrote under the video. A first or last line "on tiktok, instagram" names the places
/// (`parsePlaces` turns the words into places); everything else is the text of the post, kept as he wrote it.
/// { text, places (null when none named), title (the first line of the text, for where a title is needed) }
export function readCaption(caption, parsePlaces = () => []) {
  const lines = String(caption ?? "").replace(/\r/g, "").split("\n");
  let places = null;
  const take = (i) => {
    const m = /^\s*(?:post\s+)?on\s*:?\s+(.+?)\s*$/i.exec(lines[i] || "");
    if (!m) return false;
    const p = parsePlaces(m[1]);
    if (!p.length || m[1].trim().split(/[\s,;/+]+|\band\b/).filter(Boolean).length > p.length + 1) return false; // a sentence that only starts with "on" is text
    places = p; lines.splice(i, 1); return true;
  };
  if (!take(0) && lines.length > 1) take(lines.length - 1);
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const first = (text.split("\n").find((l) => l.trim()) || "").replace(/\s+#[A-Za-z0-9_]+/g, "").trim();
  return { text, places, title: first.length > 90 ? `${first.slice(0, 87).trimEnd()}...` : first };
}

/// The hashtags in a text, as tags for a place that takes them apart from the text.
export const tagsIn = (text) => [...new Set((String(text ?? "").match(/#[A-Za-z0-9_]{2,40}/g) || []).map((t) => t.slice(1)))].slice(0, 15);

/// The file fetched from Telegram and written to `dest`. The address carries the bot's token, so no error here
/// ever repeats it. Returns the byte count.
export async function telegramFile(tg, fileId, dest, { maxBytes = TG_MAX_BYTES } = {}) {
  const f = await tg.call("getFile", { file_id: fileId });
  if (!f?.file_path) throw new Error("Telegram gave no path for the file");
  if (Number(f.file_size) > maxBytes) throw Object.assign(new Error(`the file is ${mb(f.file_size)} MB and Telegram gives a bot at most ${mb(maxBytes)} MB`), { tooBig: true });
  let r;
  try { r = await tg.fetch(`https://api.telegram.org/file/bot${tg.token}/${f.file_path}`, typeof AbortSignal?.timeout === "function" ? { signal: AbortSignal.timeout(180_000) } : {}); }
  catch { throw new Error("the file could not be fetched from Telegram"); }
  if (!r.ok) throw new Error(`the file could not be fetched from Telegram (${r.status})`);
  const bytes = Buffer.from(await r.arrayBuffer());
  if (!bytes.length) throw new Error("Telegram sent an empty file");
  if (bytes.length > maxBytes) throw Object.assign(new Error(`the file is ${mb(bytes.length)} MB and Telegram gives a bot at most ${mb(maxBytes)} MB`), { tooBig: true });
  writeFileSync(dest, bytes);
  return bytes.length;
}

const NAMES = { x: "X", instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", youtube: "YouTube" };
const list = (places) => { const n = (places || []).map((p) => NAMES[p] || p); return n.length <= 1 ? n.join("") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`; };

/// What the owner is told when the video cannot be taken, in words he can act on.
export const OWN_SAYS = {
  tooBig: (bytes) => `That video is ${mb(bytes)} MB. Telegram lets a bot fetch at most ${mb(TG_MAX_BYTES)} MB, so I cannot take it. Send a smaller copy: 720p is enough for every network.`,
  noText: "I have the video, but there is no text with it. Send it again with the text of the post as its caption (the words you want under the video). To choose the places, add a last line like: on tiktok, instagram",
  failed: (why) => `I could not take that video: ${why}. Send it again.`,
};

/// The card the owner approves. `tiktokDraft`: TikTok takes it as a draft in the inbox, finished in the app.
export function ownCard({ n, seconds = 0, bytes = 0, text, places, tiktokDraft = true, xWhy = null }) {
  if (xWhy === null) xWhy = places.includes("x") ? ownXProblems(text) : [];
  const size = [seconds ? `${Math.round(seconds)} s` : "", bytes ? `${mb(bytes)} MB` : ""].filter(Boolean).join(", ");
  const notes = [];
  if (places.includes("tiktok") && tiktokDraft) notes.push("On TikTok it lands in your inbox as a draft: you add the sound there and post.");
  if (places.includes("x")) notes.push(xWhy.length ? `On X your text cannot go as it is (${xWhy.join("; ")}), so Fudge writes a shorter post from it, inside X's rules.` : "On X it goes out with your words as they are.");
  if (places.some((p) => p !== "tiktok")) notes.push("It goes out with the sound that is in the file: a network's own sounds can only be added in its app.");
  return `Your video is saved as video ${n}${size ? ` (${size})` : ""}. The text, as you wrote it:\n\n${text}\n\nPost it? Approve sends it to ${list(places)}; Reject keeps it in the folder.${notes.length ? `\n${notes.join("\n")}` : ""}`;
}
