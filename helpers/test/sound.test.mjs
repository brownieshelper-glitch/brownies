// A trend that lives on a sound: the sound's shape, the owner's request by hand, what the writer is told (a silent
// film that reads as the trend, our own performance of it), and what the owner is told about adding the sound in
// the app. The track itself is never ours to put in the file.
import test from "node:test";
import assert from "node:assert/strict";
import { SOUND_PLACES, SOUND_RULES, SOUND_STYLE, COPY_RULES, cleanSound, soundName, splitSound, soundBrief, soundSteps, soundCard, linkInfo, copyAsk, cleanCopy } from "../lib/sound.mjs";

test("a clip made for a sound is a performance, not a sketch: its own orders and its own look", () => {
  // 2026-10-12: the first one came out as a kitchen joke in pixel art with three captions and a punchline
  assert.match(SOUND_RULES, /"duration": 8 to 15, "captions": \[\]/);
  assert.match(SOUND_RULES, /It is a performance, not a sketch: no joke ending, no twist, no prop gag, nothing falling or breaking\./);
  assert.match(SOUND_RULES, /captions: an empty list, or one line under 40 characters/);
  // the same evening the first /sprinkle copy stopped at the writing: a dance word read as coin talk, twice
  assert.match(SOUND_RULES, /Words the scene must not use, because here they read as talk about coins even when a dance is meant: pump, pumping, launch, chain,/);
  // clip 21 (2026-10-12) had the look right and no dance: hundreds of brownies standing on steps, the same picture
  // at second 1 and at second 9, because the scene was written in jolts and freezes under a fixed camera
  assert.match(SOUND_RULES, /The movement IS the video\. It starts within the first second and never stops until the last frame/);
  assert.match(SOUND_RULES, /For the crowd never write freeze, still, hold, pause, lock or stop; only one single figure may stand still/);
  assert.match(SOUND_RULES, /two or three rows, about twenty brownies, large in the frame\. Not hundreds, not a stadium\./);
  assert.match(SOUND_RULES, /The camera moves too, all the way through: a steady push-in, or a slow handheld drift\. Never a fixed frame\./);
  // our own performance: nobody's outfit, no institution, the movement in our own words
  const brief = soundBrief(cleanSound("Storm II by GENER8ION"));
  assert.match(brief, /The brownies wear nothing they do not always wear: no uniforms, no blazers, no outfit taken from the videos of the trend\./);
  assert.match(brief, /never by an institution or a named place \(no school, no church, no stadium by name\), and write the movement in your own words as a simple routine a crowd can do together\./);
  assert.match(SOUND_RULES, /as one continuous shot unless the format is known for its cuts/);
  assert.equal(SOUND_STYLE, "photoreal");
});

test("a link the owner sends: what the network says about it in public, through its own embed service; the video is never fetched", async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("https://www.tiktok.com/oembed?url=")) return { ok: true, status: 200, json: async () => ({ title: "Joining the trend \u{1F923} original \"Storm II\" by GENER8ION  #StormII #GENER8ION", author_name: "somebody" }) };
    if (String(url).startsWith("https://www.youtube.com/oembed?")) return { ok: true, status: 200, json: async () => ({ title: "A dance on the steps", author_name: "a channel" }) };
    if (String(url).startsWith("https://publish.twitter.com/oembed?")) return { ok: true, status: 200, json: async () => ({ html: "<blockquote><p>the walk everybody does <a href=\"x\">#walk</a></p>&mdash; someone</blockquote>", author_name: "someone" }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const tt = await linkInfo("https://vm.tiktok.com/ZN8BC4ACB/", fetch);
  assert.deepEqual(tt, { ok: true, place: "tiktok", url: "https://vm.tiktok.com/ZN8BC4ACB/", caption: 'Joining the trend original "Storm II" by GENER8ION #StormII #GENER8ION', author: "somebody" });
  assert.equal(calls[0], "https://www.tiktok.com/oembed?url=https%3A%2F%2Fvm.tiktok.com%2FZN8BC4ACB%2F", "the embed service, not the page");
  assert.equal((await linkInfo("https://youtu.be/abc", fetch)).caption, "A dance on the steps");
  assert.match((await linkInfo("https://x.com/a/status/1", fetch)).caption, /^the walk everybody does #walk/);
  // Instagram says nothing without a login: nothing is fetched at all
  const before = calls.length;
  assert.deepEqual(await linkInfo("https://www.instagram.com/reel/DdM2TrMzD_n/?x=1", fetch), { ok: false, place: "instagram", url: "https://www.instagram.com/reel/DdM2TrMzD_n/?x=1", why: "Instagram says nothing about a reel without a login" });
  assert.equal(calls.length, before);
  // anything else is not fetched either: no other host, no other scheme, no trick with the host name
  for (const bad of ["https://example.com/video", "http://169.254.169.254/latest", "file:///etc/passwd", "https://tiktok.com.evil.test/v/1", "not a link", ""]) { const r = await linkInfo(bad, fetch); assert.equal(r.ok, false, bad); assert.equal(r.place, null, bad); }
  assert.equal(calls.length, before, "nothing but the three embed services was called");
  // a service that fails or says nothing
  assert.equal((await linkInfo("https://www.tiktok.com/@a/video/1", async () => ({ ok: false, status: 429 }))).why, "the network answered 429 for that link");
  assert.equal((await linkInfo("https://www.tiktok.com/@a/video/1", async () => { throw new Error("down"); })).why, "the link could not be read");
  assert.equal((await linkInfo("https://www.tiktok.com/@a/video/1", async () => ({ ok: true, json: async () => ({ title: "" }) }))).why, "the network gave no caption for that link");
});

test("which trend is it: the format is asked for, never one person's video; the answer becomes a card, or nothing when it is not known", () => {
  assert.match(COPY_RULES, /wants OUR version of that trend/);
  assert.match(COPY_RULES, /Describe the format, not one person's video: no shot list of anybody's video, no words of a song, nobody's caption\./);
  assert.match(COPY_RULES, /"known" is false when you cannot tell which trend it is\. Never guess one\./);
  const ask = copyAsk({ link: "https://vm.tiktok.com/ZN8BC4ACB/", info: { ok: true, place: "tiktok", caption: "Joining the trend", author: "somebody" }, words: "the dance on the steps" });
  assert.equal(ask, "THE LINK: https://vm.tiktok.com/ZN8BC4ACB/\nWHAT THE NETWORK SAYS ABOUT IT (tiktok, posted by somebody): Joining the trend\nTHE OWNER'S WORDS: the dance on the steps\nWhich trend is it? Answer with the JSON only.");
  assert.match(copyAsk({ link: "https://www.instagram.com/reel/x/", info: { ok: false, place: "instagram", why: "Instagram says nothing about a reel without a login" } }), /\nThe network says nothing about it \(Instagram says nothing about a reel without a login\)\.\n/);
  const card = cleanCopy({ known: true, name: "Storm dance", what: "Rows of people on wide steps break into one tight dance around a figure who stands still.", place: "wide stone steps outside an old building", moves: "Tight rows like a class photo, then everybody bounces as one pack. One long take, a slow push-in.", sound: { name: "Storm II", by: "GENER8ION" }, caption: "Four brownies, one storm", hashtags: ["StormII", "#GENER8ION", "not a tag!", "#StormII"] });
  assert.deepEqual(card, { name: "Storm dance", what: "Rows of people on wide steps break into one tight dance around a figure who stands still.", our_version: "Four brownies, one storm. Rows of people on wide steps break into one tight dance around a figure who stands still.", shots_hint: "Tight rows like a class photo, then everybody bounces as one pack. One long take, a slow push-in.", place: "wide stone steps outside an old building", hashtags: ["#StormII", "#GENER8ION"], characters: [], sound: { name: "Storm II", by: "GENER8ION", url: null } });
  assert.equal(cleanCopy({ known: false, name: "A guess", what: "Something that might be a trend, described at length." }), null, "not known is not filmed");
  assert.equal(cleanCopy({ known: true, name: "X", what: "short" }), null); assert.equal(cleanCopy(null), null); assert.equal(cleanCopy("text"), null);
  assert.equal(cleanCopy({ known: true, name: "The walk", what: "Everybody does the same slow walk towards the camera.", sound: null }).sound, null);
});

test("a sound, checked: a name, who it is by, a link; from a card or from 'Name by Artist'", () => {
  assert.deepEqual(cleanSound({ name: "Storm II", by: "GENER8ION", url: "https://www.tiktok.com/music/storm-ii-123" }), { name: "Storm II", by: "GENER8ION", url: "https://www.tiktok.com/music/storm-ii-123" });
  assert.deepEqual(cleanSound("Storm II by GENER8ION"), { name: "Storm II", by: "GENER8ION", url: null });
  assert.deepEqual(cleanSound('"Storm II"'), { name: "Storm II", by: "", url: null });
  assert.deepEqual(cleanSound({ name: "  A   sound’s name ", by: null, url: "javascript:alert(1)" }), { name: "A sounds name", by: "", url: null }, "plain characters, and only a web link is a link");
  for (const no of [null, "", "x", {}, { name: "" }, 7, { by: "somebody" }]) assert.equal(cleanSound(no), null);
  assert.equal(soundName(cleanSound("Storm II by GENER8ION")), '"Storm II" by GENER8ION'); assert.equal(soundName(cleanSound("Storm II")), '"Storm II"'); assert.equal(soundName(null), "");
  assert.deepEqual(SOUND_PLACES, ["tiktok"], "with no place named, only where the sound can be added by hand");
});

test("the owner's request by hand: what happens, then 'sound:' and the track", () => {
  assert.deepEqual(splitSound("Four brownies, one storm. Rows on wide steps, then one tight dance around Fudge. sound: Storm II by GENER8ION"),
    { idea: "Four brownies, one storm. Rows on wide steps, then one tight dance around Fudge.", sound: { name: "Storm II", by: "GENER8ION", url: null } });
  assert.deepEqual(splitSound("The brownies do the walk | Sound: Ramalama."), { idea: "The brownies do the walk", sound: { name: "Ramalama", by: "", url: null } });
  assert.deepEqual(splitSound("A scene with no track named"), { idea: "A scene with no track named", sound: null });
  assert.deepEqual(splitSound("They test the sound system. Chip unplugs it."), { idea: "They test the sound system. Chip unplugs it.", sound: null }, "the word alone is not the mark");
  assert.deepEqual(splitSound("A dance. sound:"), { idea: "A dance. sound:", sound: null });
  assert.deepEqual(splitSound(null), { idea: "", sound: null });
});

test("the writer's orders: a silent film, no song in the scene, the trend at first sight, our own performance of it", () => {
  const b = soundBrief(cleanSound("Storm II by GENER8ION"));
  assert.match(b, /^THIS TREND LIVES ON A SOUND \("Storm II" by GENER8ION\): a dance or a movement everybody does to the same track\./);
  assert.match(b, /the film itself is SILENT: write no music, no song title, no artist and no sung or spoken words into the scene, and no dialogue\./);
  assert.match(b, /Make it read as the trend at first sight: the same kind of place and line-up, the same kind of movement and energy, the same camera idea and pacing/);
  assert.match(b, /It is our performance of the format: no real person, nobody's costume or logo, no shot copied from anyone's video\./);
  assert.match(b, /more plain brownies \(the same little cubes, no tools in their hands\) may fill the rows behind the four/);
  assert.match(b, /Captions: none, or one short line/);
  assert.equal(soundBrief(null), "");
});

test("the owner's lines: how to add the sound in the app, and where a clip would go out silent", () => {
  const s = cleanSound({ name: "Storm II", by: "GENER8ION", url: "https://www.tiktok.com/music/storm-ii-123" });
  assert.equal(soundSteps(s), 'Before you post it: in the TikTok draft tap "Add sound", search "Storm II" by GENER8ION, pick it, and check that it starts where the dance starts. The sound\'s page: https://www.tiktok.com/music/storm-ii-123 Tip: open any video of the trend, tap the sound\'s name and "Add to Favorites"; then it is the first one under Favorites.');
  assert.ok(!soundSteps(cleanSound("Storm II")).includes("The sound's page"));
  assert.equal(soundSteps(s, "instagram"), 'On Instagram the sound cannot be attached for you either: save the clip from this chat, start a Reel with it, tap Audio, search "Storm II" by GENER8ION and post.');
  assert.equal(soundCard(s), 'Sound: "Storm II" by GENER8ION. The clip is silent on purpose: a network\'s own sound can only be added inside its app.');
  assert.equal(soundCard(s, ["tiktok", "instagram"]), 'Sound: "Storm II" by GENER8ION. The clip is silent on purpose: a network\'s own sound can only be added inside its app. On Instagram it would go out silent.');
  assert.match(soundCard(s, ["youtube", "tiktok", "x", "facebook"]), /On YouTube, X and Facebook it would go out silent\.$/);
});
