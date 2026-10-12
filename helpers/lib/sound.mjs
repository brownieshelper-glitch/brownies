// A trend that lives on a sound: a dance or a movement everybody does to the same track. Our version has to carry
// that same sound or it is not the trend. The sound is the network's to give: every network that has trends keeps a
// library of sounds it holds the rights to, and a video that uses one is listed under it, which is how a trend
// spreads. So the film is made SILENT and the sound is added from that library when the clip is posted. A network's
// posting API cannot pick a sound (TikTok's and Instagram's cannot), so the clip lands as a draft and the owner
// adds the sound in the app: two taps. The track is never copied into our own file: it is not ours, a copy is not
// listed under the sound, and it is what gets a video muted or taken down.
//
// The owner, 2026-10-12: "I want in the video also the music that the trend was using, that is what is missing in
// most of our videos ... in musical videos where there are funny dances we should recreate them with the brownies
// using the same sound as the original video of the trend."
//
// This file holds the shape of a sound, the words for the writer and the words for the owner. No secret in it.

const plain = (v, max) => String(v ?? "").replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

/// Where a clip made for a sound goes when the owner named no place: only where the sound can be added by hand.
export const SOUND_PLACES = ["tiktok"];

/// A sound as a trend card carries it, checked: { name, by, url } or null. Accepts the object, or "Name by Artist".
export function cleanSound(s) {
  if (!s) return null;
  if (typeof s === "string") {
    const m = /^(.+?)\s+by\s+(.+)$/i.exec(plain(s, 160));
    return cleanSound(m ? { name: m[1], by: m[2] } : { name: s });
  }
  if (typeof s !== "object") return null;
  const name = plain(s.name, 80).replace(/^["']+|["']+$/g, "");
  if (name.length < 2) return null;
  const url = String(s.url || "").trim();
  return { name, by: plain(s.by, 60), url: /^https?:\/\/\S+$/i.test(url) ? url : null };
}

/// "Storm II" by GENER8ION
export const soundName = (sound) => (sound ? `"${sound.name}"${sound.by ? ` by ${sound.by}` : ""}` : "");

/// The owner's request by hand: "<what happens> sound: <name> by <artist>" -> { idea, sound }. Without "sound:" the
/// whole text is the idea.
export function splitSound(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  const m = /^(.*?)[\s|,;]*\bsound\s*:\s*(.+)$/i.exec(t);
  if (!m) return { idea: t, sound: null };
  const sound = cleanSound(m[2].replace(/[.\s]+$/, ""));
  return { idea: m[1].trim(), sound };
}

/// What the writer is told when the trend lives on a sound.
export function soundBrief(sound) {
  if (!sound) return "";
  return `THIS TREND LIVES ON A SOUND (${soundName(sound)}): a dance or a movement everybody does to the same track. The track is added from the network's own library when the clip is posted, so the film itself is SILENT: write no music, no song title, no artist and no sung or spoken words into the scene, and no dialogue.
Make it read as the trend at first sight: the same kind of place and line-up, the same kind of movement and energy, the same camera idea and pacing that the format is known for, performed by the brownies in their own way. If the format needs a crowd, more plain brownies (the same little cubes, no tools in their hands) may fill the rows behind the four. It is our performance of the format: no real person, nobody's costume or logo, no shot copied from anyone's video.
The movement sits on a steady beat from the first second to the last and loops well; no cutaway joke in the middle of it. Captions: none, or one short line that does not get in the way of the dance.`;
}

/// What the owner is told about adding the sound to a clip in a network's app. `place`: "tiktok" (the clip is a
/// draft in the inbox) or "instagram" (posted by hand from the phone).
export function soundSteps(sound, place = "tiktok") {
  const s = soundName(sound);
  if (place === "instagram") return `On Instagram the sound cannot be attached for you either: save the clip from this chat, start a Reel with it, tap Audio, search ${s} and post.`;
  return `Before you post it: in the TikTok draft tap "Add sound", search ${s}, pick it, and check that it starts where the dance starts.${sound?.url ? ` The sound's page: ${sound.url}` : ""} Tip: open any video of the trend, tap the sound's name and "Add to Favorites"; then it is the first one under Favorites.`;
}

/// One line for the card the owner approves: the sound, why the clip is silent, and where it would go out silent.
/// `places`: where Approve sends it.
export function soundCard(sound, places = SOUND_PLACES) {
  const NAMES = { x: "X", instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", youtube: "YouTube" };
  const mute = (places || []).filter((p) => p !== "tiktok").map((p) => NAMES[p] || p);
  const list = mute.length <= 1 ? mute.join("") : `${mute.slice(0, -1).join(", ")} and ${mute[mute.length - 1]}`;
  return `Sound: ${soundName(sound)}. The clip is silent on purpose: a network's own sound can only be added inside its app.${mute.length ? ` On ${list} it would go out silent.` : ""}`;
}
