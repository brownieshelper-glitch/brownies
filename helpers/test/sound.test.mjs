// A trend that lives on a sound: the sound's shape, the owner's request by hand, what the writer is told (a silent
// film that reads as the trend, our own performance of it), and what the owner is told about adding the sound in
// the app. The track itself is never ours to put in the file.
import test from "node:test";
import assert from "node:assert/strict";
import { SOUND_PLACES, cleanSound, soundName, splitSound, soundBrief, soundSteps, soundCard } from "../lib/sound.mjs";

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
