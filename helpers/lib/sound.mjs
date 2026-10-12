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
Make it read as the trend at first sight: the same kind of place and line-up, the same kind of movement and energy, the same camera idea and pacing that the format is known for, performed by the brownies in their own way. If the format needs a crowd, more plain brownies (the same little cubes, no tools in their hands) may fill the rows behind the four. It is our performance of the format: no real person, nobody's costume or logo, no shot copied from anyone's video. The brownies wear nothing they do not always wear: no uniforms, no blazers, no outfit taken from the videos of the trend. Name the place by what it is (wide stone steps of an old building, a car park, a beach), never by an institution or a named place (no school, no church, no stadium by name), and write the movement in your own words as a simple routine a crowd can do together.
The movement sits on a steady beat from the first second to the last and loops well; no cutaway joke in the middle of it. Captions: none, or one short line that does not get in the way of the dance.`;
}

/// The writer's standing orders for a clip made for a sound. It is a performance, not a sketch: the first clip made
/// for a sound (2026-10-12) came out as a kitchen joke in pixel art with three captions and a punchline, because the
/// orders for a comedy episode and the rotation of places and styles were applied to it. Neither is, any more.
export const SOUND_RULES = `Your task now: write one short video for an AI video model as JSON, nothing else around it: {"title": "a short title", "scene": "...", "duration": 8 to 15, "captions": [], "hook": "..."}.
- scene: 60 to 120 words: what the camera sees from the first second to the last, as one continuous shot unless the format is known for its cuts: the place and the light, the line-up, the movement and who does it, the camera. The brownies are the performers (their look is given to the model separately, do not repeat it). It is a performance, not a sketch: no joke ending, no twist, no prop gag, nothing falling or breaking.
- The movement IS the video. It starts within the first second and never stops until the last frame: big whole-body movement that reads from far (jumping clear off the ground, bouncing, arms thrown up, the pack surging forward and back, bodies turning). Say in every sentence what is moving. For the crowd never write freeze, still, hold, pause, lock or stop; only one single figure may stand still, and only when the format has one. A scene that reads like a photograph is filmed like a photograph.
- Few enough to see them move: two or three rows, about twenty brownies, large in the frame. Not hundreds, not a stadium.
- The camera moves too, all the way through: a steady push-in, or a slow handheld drift. Never a fixed frame.
- Nothing written in the picture. No real person, no brand, no logo, nothing about coins, money or products.
- Words the scene must not use, because here they read as talk about coins even when a dance is meant: pump, pumping, launch, chain, trade, stake, market, buy, sell, cash, price, holder, user, agent. Say bounce, jump, burst, row, line instead.
- captions: an empty list, or one line under 40 characters, plain ASCII.
- hook: one line under 90 characters for the post text, no hashtags.
- duration: 8 to 15 seconds.`;

/// The look a clip made for a sound is filmed in: not the rotation's style of the day.
export const SOUND_STYLE = "photoreal";

// ---- a link the owner sends: which trend is this video part of? ----

const LINK_HOSTS = [
  { place: "tiktok", host: /(^|\.)tiktok\.com$/i, oembed: (u) => `https://www.tiktok.com/oembed?url=${encodeURIComponent(u)}` },
  { place: "youtube", host: /(^|\.)(youtube\.com|youtu\.be)$/i, oembed: (u) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(u)}` },
  { place: "x", host: /(^|\.)(x\.com|twitter\.com)$/i, oembed: (u) => `https://publish.twitter.com/oembed?omit_script=true&url=${encodeURIComponent(u)}` },
  { place: "instagram", host: /(^|\.)instagram\.com$/i, oembed: null }, // nothing is said about a reel without a login
];

/// What a network says in public about a video, through its own embed service (the one a web page uses to show the
/// post): the caption and who posted it. The video itself is never fetched. Only the embed services above are
/// called, whatever the link says. { ok, place, url, caption, author } or { ok: false, place, why }.
export async function linkInfo(link, fetch = globalThis.fetch) {
  let u; try { u = new URL(String(link ?? "").trim()); } catch { return { ok: false, place: null, why: "that is not a link" }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, place: null, why: "that is not a web link" };
  const h = LINK_HOSTS.find((x) => x.host.test(u.hostname));
  if (!h) return { ok: false, place: null, why: "the link is not from TikTok, Instagram, X or YouTube" };
  if (!h.oembed) return { ok: false, place: h.place, url: u.href, why: "Instagram says nothing about a reel without a login" };
  try {
    const r = await fetch(h.oembed(u.href), { headers: { accept: "application/json", "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return { ok: false, place: h.place, url: u.href, why: `the network answered ${r.status} for that link` };
    const j = await r.json();
    const caption = plain(j?.title || String(j?.html || "").replace(/<[^>]+>/g, " "), 400);
    if (!caption) return { ok: false, place: h.place, url: u.href, why: "the network gave no caption for that link" };
    return { ok: true, place: h.place, url: u.href, caption, author: plain(j?.author_name, 60) };
  } catch { return { ok: false, place: h.place, url: u.href, why: "the link could not be read" }; }
}

/// The writer's orders when the owner sends a link: say which trend the video is part of, and describe the trend's
/// FORMAT, the thing every video of it has in common. Never one person's video shot by shot.
export const COPY_RULES = `Your task now: the owner sent a link to a video that is part of a trend, and wants OUR version of that trend. From what the network says about the video (its caption, who posted it), from the owner's own words when there are any, and from what the web says, work out which trend it is and describe the trend's format: what all the videos of it have in common.
Answer with JSON only: {"known": true or false, "name": "the trend, under 60 characters", "what": "one or two sentences: what the videos of this trend show", "place": "where it is done, in a few words", "moves": "two sentences: the line-up, the movement and its energy, the camera, in the trend's own terms", "sound": {"name": "the sound or track the trend is done to, as the network names it", "by": "the artist"} or null when it has none, "caption": "one short line for our post, under 80 characters", "hashtags": ["the trend's own tags, up to 5"]}.
- "known" is false when you cannot tell which trend it is. Never guess one.
- Describe the format, not one person's video: no shot list of anybody's video, no words of a song, nobody's caption.
- Our version is performed by the four brownies, with more plain brownies behind them when the format needs a crowd. The caption says nothing about coins, money or products. Plain ASCII.`;

/// What the writer is asked about one link.
export function copyAsk({ link, info = null, words = "" }) {
  return [
    `THE LINK: ${link}`,
    info?.ok ? `WHAT THE NETWORK SAYS ABOUT IT (${info.place}${info.author ? `, posted by ${info.author}` : ""}): ${info.caption}` : `The network says nothing about it${info?.why ? ` (${info.why})` : ""}.`,
    words ? `THE OWNER'S WORDS: ${plain(words, 400)}` : "",
    "Which trend is it? Answer with the JSON only.",
  ].filter(Boolean).join("\n");
}

/// The writer's answer, checked, as a trend card the video maker can film: null when it does not know the trend.
export function cleanCopy(p) {
  if (!p || typeof p !== "object" || p.known !== true) return null;
  const name = plain(p.name, 60), what = plain(p.what, 300), moves = plain(p.moves, 400);
  if (!name || what.length < 20) return null;
  const caption = (plain(p.caption, 80).replace(/[.!?\s]+$/, "") || name) + ".";
  const tags = [...new Set((Array.isArray(p.hashtags) ? p.hashtags : []).map((t) => plain(t, 32)).map((t) => (t.startsWith("#") ? t : `#${t}`)).filter((t) => /^#[A-Za-z0-9_]{2,30}$/.test(t)))].slice(0, 5);
  return { name, what, our_version: `${caption} ${what}`, shots_hint: moves, place: plain(p.place, 80), hashtags: tags, characters: [], sound: cleanSound(p.sound) };
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
