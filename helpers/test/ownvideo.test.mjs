// A video the owner made himself and sends to the bot: which message is a video, how its caption is read (the
// text of the post, and the places when he names them), the fetch of the file from Telegram, the card he approves,
// and the handing over in his chat only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeWorld } from "./mock.mjs";
import { TG_MAX_BYTES, OWN_PLACES, OWN_SAYS, X_MAX, pickVideo, readCaption, tagsIn, telegramFile, ownCard, ownXProblems } from "../lib/ownvideo.mjs";
import { Fudge } from "../helpers/fudge.mjs";

const PLACES = ["x", "instagram", "facebook", "tiktok", "youtube"];
const ALIASES = { twitter: "x", ig: "instagram", insta: "instagram", fb: "facebook", yt: "youtube", tt: "tiktok" };
/// the same reading of places as the social brownie's, written out here so this test needs nothing hidden
const parsePlaces = (text) => { const w = String(text || "").toLowerCase().split(/[\s,;/+]+|\band\b/).map((x) => x.trim()).filter(Boolean); if (w.includes("all") || w.includes("everywhere")) return [...PLACES]; return [...new Set(w.map((x) => ALIASES[x] || x).filter((x) => PLACES.includes(x)))]; };

test("which message is a video: a video, a clip sent as a file, not a picture or a text file", () => {
  assert.deepEqual(pickVideo({ video: { file_id: "v1", file_size: 5_300_000, duration: 12, width: 720, height: 1280, file_name: "storm.mp4" } }), { fileId: "v1", bytes: 5_300_000, seconds: 12, width: 720, height: 1280, name: "storm.mp4" });
  assert.deepEqual(pickVideo({ document: { file_id: "d1", file_size: 9_000_000, mime_type: "video/mp4", file_name: "clip.mp4" } }), { fileId: "d1", bytes: 9_000_000, seconds: 0, width: 0, height: 0, name: "clip.mp4" });
  assert.equal(pickVideo({ document: { file_id: "d2", mime_type: "application/octet-stream", file_name: "clip.MOV" } }).fileId, "d2", "told by its name");
  assert.equal(pickVideo({ document: { file_id: "d3", mime_type: "application/pdf", file_name: "report.pdf" } }), null);
  assert.equal(pickVideo({ photo: [{ file_id: "p1" }] }), null); assert.equal(pickVideo({ text: "hello" }), null); assert.equal(pickVideo(null), null);
});

test("the caption is the text of the post, kept as he wrote it; a first or last line names the places", () => {
  assert.deepEqual(readCaption("Four brownies, one storm.\n\n#brownies #dance", parsePlaces), { text: "Four brownies, one storm.\n\n#brownies #dance", places: null, title: "Four brownies, one storm." });
  assert.deepEqual(readCaption("Four brownies, one storm. #brownies\non tiktok, instagram", parsePlaces), { text: "Four brownies, one storm. #brownies", places: ["tiktok", "instagram"], title: "Four brownies, one storm." });
  assert.deepEqual(readCaption("on: yt and fb\nMonday in the kitchen", parsePlaces), { text: "Monday in the kitchen", places: ["youtube", "facebook"], title: "Monday in the kitchen" });
  assert.deepEqual(readCaption("post on all\nA new one", parsePlaces).places, PLACES);
  // a sentence that only starts with "on" is text, not a list of places
  assert.deepEqual(readCaption("On Monday the brownies went to the beach", parsePlaces), { text: "On Monday the brownies went to the beach", places: null, title: "On Monday the brownies went to the beach" });
  assert.equal(readCaption("on instagram we trust the algorithm today", parsePlaces).places, null);
  // nothing written
  assert.deepEqual(readCaption("", parsePlaces), { text: "", places: null, title: "" }); assert.equal(readCaption(undefined, parsePlaces).text, "");
  assert.equal(readCaption("on tiktok", parsePlaces).text, "", "places alone are not a post");
  assert.equal(readCaption("x".repeat(200), parsePlaces).title.length, 90);
  assert.deepEqual(tagsIn("One storm #brownies #dance and #brownies again"), ["brownies", "dance"]);
  assert.deepEqual(OWN_PLACES, ["youtube", "tiktok", "instagram", "facebook", "x"], "every network, X among them");
  // on X his words go as they are when X can take them
  assert.deepEqual(ownXProblems("Four brownies, one storm.\n\n#brownies #dance"), [], "two hashtags are his to choose");
  assert.deepEqual(ownXProblems("x".repeat(281)), ["it is 281 characters and a post on X takes 280"]);
  assert.deepEqual(ownXProblems("x".repeat(280)), []);
  assert.deepEqual(ownXProblems(`${"x".repeat(278)}\u{1F525}`), [], "an emoji counts for two: 280");
  assert.deepEqual(ownXProblems(`${"x".repeat(279)}\u{1F525}`), ["it is 281 characters and a post on X takes 280"]);
  assert.match(ownXProblems("The new clip is here https://example.com/watch")[0], /^a link/);
  assert.equal(X_MAX, 280);
});

test("the file is fetched from Telegram and written; too large or missing is said in plain words, and the address with the token is never repeated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ownvideo-"));
  const calls = [];
  const tg = (file, { status = 200, size = null, bytes = Buffer.alloc(1500, 7) } = {}) => ({ token: "123:SECRETTOKEN", call: async (method, params) => { calls.push([method, params]); return file === null ? {} : { file_path: file, file_size: size ?? bytes.length }; }, fetch: async (url) => { calls.push(String(url)); return { ok: status === 200, status, arrayBuffer: async () => bytes }; } });
  const dest = join(dir, "a.mp4");
  assert.equal(await telegramFile(tg("videos/file_7.mp4"), "v1", dest), 1500);
  assert.deepEqual(calls[0], ["getFile", { file_id: "v1" }]); assert.equal(calls[1], "https://api.telegram.org/file/bot123:SECRETTOKEN/videos/file_7.mp4");
  assert.equal(readFileSync(dest).length, 1500);
  const no = async (t, re) => { await assert.rejects(() => telegramFile(t, "v1", join(dir, "b.mp4")), (e) => { assert.match(e.message, re); assert.ok(!/SECRETTOKEN|api\.telegram\.org/.test(e.message), "no address, no token"); return true; }); };
  await no(tg(null), /Telegram gave no path for the file/);
  await no(tg("videos/big.mp4", { size: TG_MAX_BYTES + 1 }), /the file is 20\.0 MB and Telegram gives a bot at most 20\.0 MB/);
  await no(tg("videos/gone.mp4", { status: 404 }), /the file could not be fetched from Telegram \(404\)/);
  await no(tg("videos/empty.mp4", { bytes: Buffer.alloc(0), size: 10 }), /Telegram sent an empty file/);
  await no({ token: "123:SECRETTOKEN", call: async () => ({ file_path: "v.mp4", file_size: 10 }), fetch: async () => { throw new Error("connect ECONNRESET https://api.telegram.org/file/bot123:SECRETTOKEN/v.mp4"); } }, /^the file could not be fetched from Telegram$/);
  assert.ok(!existsSync(join(dir, "b.mp4")), "nothing is written when it fails");
});

test("the card he approves, and what he is told when the video cannot be taken", () => {
  assert.equal(ownCard({ n: 22, seconds: 12, bytes: 5_300_000, text: "Four brownies, one storm.\n#brownies", places: ["youtube", "tiktok", "instagram", "facebook"] }),
    "Your video is saved as video 22 (12 s, 5.1 MB). The text, as you wrote it:\n\nFour brownies, one storm.\n#brownies\n\nPost it? Approve sends it to YouTube, TikTok, Instagram and Facebook; Reject keeps it in the folder.\nOn TikTok it lands in your inbox as a draft: you add the sound there and post.\nIt goes out with the sound that is in the file: a network's own sounds can only be added in its app.");
  assert.equal(ownCard({ n: 23, text: "A walk", places: ["tiktok"] }), "Your video is saved as video 23. The text, as you wrote it:\n\nA walk\n\nPost it? Approve sends it to TikTok; Reject keeps it in the folder.\nOn TikTok it lands in your inbox as a draft: you add the sound there and post.");
  // X: his words as they are when they fit, and the card says so; when they do not, it says why and what happens instead
  assert.match(ownCard({ n: 24, text: "A walk", places: ["x", "youtube"], tiktokDraft: false }), /Approve sends it to X and YouTube; Reject keeps it in the folder\.\nOn X it goes out with your words as they are\.\nIt goes out with the sound that is in the file/);
  assert.match(ownCard({ n: 25, text: "y".repeat(300), places: ["x"] }), /\nOn X your text cannot go as it is \(it is 300 characters and a post on X takes 280\), so Fudge writes a shorter post from it, inside X's rules\.\n/);
  assert.equal(OWN_SAYS.tooBig(31_457_280), "That video is 30.0 MB. Telegram lets a bot fetch at most 20.0 MB, so I cannot take it. Send a smaller copy: 720p is enough for every network.");
  assert.match(OWN_SAYS.noText, /^I have the video, but there is no text with it\. Send it again with the text of the post as its caption/);
  assert.equal(OWN_SAYS.failed("the file could not be fetched from Telegram (404)"), "I could not take that video: the file could not be fetched from Telegram (404). Send it again.");
});

test("on X the owner's words go out as he wrote them, with his video, and no model writes anything; words X cannot take are sent back, not posted", async () => {
  const W = makeWorld();
  const dir = mkdtempSync(join(tmpdir(), "ownvideo-x-"));
  const mp4 = join(dir, "own.mp4"); (await import("node:fs")).writeFileSync(mp4, Buffer.alloc(900, 2));
  assert.equal(await W.fudge.postOwn({ text: "Four brownies, one storm.", files: [mp4] }), null, "posts with files are off until the owner turns them on");
  const on = new Fudge({ config: { ...W.helpersCfg.fudge, media: true }, brain: W.brain, gateway: W.gateway, store: W.store, clock: W.clock, alerts: W.alerts, facts: "- facts", log: () => {}, x: W.x, siteUrl: "https://feedthebrownies.com" });
  W.brain.helpers.fudge = { ...W.helpersCfg.fudge, media: true };
  let inits = 0;
  W.fetch.on("POST", "api.x.com/2/media/upload/initialize", () => { inits++; return { json: { data: { id: "m9" } } }; });
  W.fetch.on("POST", /media\/upload\/m9\/append$/, () => ({ status: 204 }));
  W.fetch.on("POST", /media\/upload\/m9\/finalize$/, () => ({ json: { data: { id: "m9" } } }));
  const text = "Four brownies, one storm.\n\n#brownies #dance";
  const r = await on.postOwn({ text, files: [mp4] });
  assert.ok(r.url); assert.equal(r.text, text); assert.equal(r.place, "x");
  assert.equal(W.xm.posts.at(-1).text, text, "his words, unchanged"); assert.deepEqual(W.xm.posts.at(-1).media, { media_ids: ["m9"] });
  assert.equal(W.or.calls.length, 0, "no model was asked");
  // too long, or with a link: nothing is uploaded, nothing is posted, the reason comes back
  const before = W.xm.posts.length;
  assert.deepEqual(await on.postOwn({ text: "z".repeat(300), files: [mp4] }), { refused: ["it is 300 characters and a post on X takes 280"] });
  assert.match((await on.postOwn({ text: "watch it here https://example.com/v", files: [mp4] })).refused[0], /^a link/);
  assert.equal(W.xm.posts.length, before); assert.equal(inits, 1);
  assert.equal(await on.postOwn({ text, files: [] }), null, "no file, no post");
});

test("Crumb hands a video over only when it comes from the owner in his own chat; anybody else's video is not looked at", async () => {
  const W = makeWorld();
  const got = [];
  W.crumb.onOwnerMedia = async (m) => { got.push(m); return got.length === 1 ? true : "I could not take that video: it is too large. Send it again."; };
  const video = (chatId, extra = {}) => { const u = { update_id: ++W.tg.updateSeq, message: { message_id: ++W.tg.msgSeq, date: 0, chat: { id: Number(chatId), type: "private" }, from: { id: Number(chatId) }, video: { file_id: "v1", file_size: 5_000_000, duration: 12 }, caption: "Four brownies, one storm.", ...extra } }; W.tg.queue.push(u); return u; };
  video("999");
  assert.equal(await W.crumb.pollOnce(), 1);
  assert.equal(got.length, 1); assert.equal(got[0].caption, "Four brownies, one storm."); assert.equal(W.tg.sent.length, 0, "taken: nothing more is said by Crumb");
  // a sentence back is said in the chat, as a reply to the video
  const second = video("999");
  await W.crumb.pollOnce();
  assert.equal(W.tg.sent.at(-1).text, "I could not take that video: it is too large. Send it again."); assert.equal(W.tg.sent.at(-1).reply_parameters.message_id, second.message.message_id);
  // a stranger's video, and a video in the group: not handed over, not answered, no model asked
  video("555"); video("-100", { chat: { id: -100, type: "supergroup" } });
  const before = W.tg.sent.length;
  assert.equal(await W.crumb.pollOnce(), 2);
  assert.equal(got.length, 2); assert.equal(W.tg.sent.length, before); assert.equal(W.or.calls.length, 0);
  // with nobody to take it, the owner's video is passed by as before
  W.crumb.onOwnerMedia = null;
  video("999");
  assert.equal(await W.crumb.pollOnce(), 1); assert.equal(W.tg.sent.length, before);
});
