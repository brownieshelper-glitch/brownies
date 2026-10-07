// The cartoon series: episodes come in order from the season and go on after it, the model's brief carries the
// show and the beat, the validator throws out every coin word and keeps the comedy, the captions and descriptions
// never mention the coin, Sprinkle makes the next episode each day and the counter moves on, the owner can ask
// for an episode by number, and the voices carry the service's own pitch and rate.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeWorld } from "./mock.mjs";
import { Telegram } from "../lib/telegram.mjs";
import { Sprinkle, tiktokCaption, videoDescription } from "../helpers/sprinkle.mjs";
import { SEASON, episodeFor, seriesBrief, seriesCaption, seriesDescription } from "../video/season.mjs";
import { KINDS, DAILY, COIN_WORDS, scriptPrompt, validateScript, fallbackScript, pickKind, pickEpisode } from "../video/scripts.mjs";
import { VOICES } from "../video/audio.mjs";

const quickRender = async (script, o) => { writeFileSync(o.out, Buffer.alloc(600, 7)); writeFileSync(o.poster, Buffer.alloc(100, 1)); return { file: o.out, poster: o.poster, seconds: script.shots.reduce((n, s) => n + s.seconds, 0), frames: 10, width: 1080, height: 1920, bytes: 600 }; };
function sprinkleIn(W, { reply, dir }) {
  W.or.reply = reply || (() => "not json");
  const fetch = async (url, init = {}) => { if (String(url).includes("/sendVideo")) return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) }; return W.fetch(url, init); };
  const telegram = new Telegram({ token: W.tg.token, fetch });
  const cfg = { role: "video", model: "test/big", dailyCapUsd: 1.5, hidden: true, hour: 11, formats: ["vertical"] };
  W.brain.helpers.sprinkle = cfg;
  return new Sprinkle({ config: cfg, brain: W.brain, gateway: W.gateway, store: W.store, clock: W.clock, alerts: W.alerts, facts: "- Every trade pays a 2% tax.", log: () => {}, telegram, ownerChatId: "999", videosDir: dir, render: quickRender, video: { width: 96, encoder: async () => {} }, audio: null });
}

test("the season: twelve episodes in order, then fresh ones in the same kitchen; the brief carries the show and the beat; the words stay off the coin", () => {
  assert.equal(SEASON.length, 12);
  assert.equal(episodeFor(1).title, "The Bell");
  assert.equal(episodeFor(12).title, "The Big Day");
  const later = episodeFor(13);
  assert.equal(later.n, 13); assert.equal(later.fresh, true); assert.match(later.beat, /fresh small mishap/);
  const brief = seriesBrief(episodeFor(2));
  assert.match(brief, /THE SHOW: "Brownies"/); assert.match(brief, /Hear ye!/); assert.match(brief, /THIS EPISODE: number 2, "One More Brick"/); assert.match(brief, /Beat: Chip's tower/);
  for (const text of [brief, seriesCaption(episodeFor(3), "Too Loud"), seriesDescription(episodeFor(3), "Too Loud")]) {
    const words = text.replace(/Nothing about coins, tokens, crypto, money, prices, buying, selling, taxes, staking, markets, chains, wallets, launches, AI or products\./, "");
    assert.ok(!COIN_WORDS.test(words), "no coin words in: " + text.slice(0, 60));
    assert.ok([...text].every((c) => c.charCodeAt(0) <= 126), "plain characters");
  }
  assert.equal(seriesCaption(episodeFor(3), "Too Loud"), "Ep. 3: Too Loud. Four little brownies, one tiny kitchen, too many ideas. #brownies #cartoon #animation");
  assert.ok(!seriesCaption(episodeFor(3), "x").includes("feedthebrownies"), "no site on TikTok yet");
  assert.equal(DAILY, "series");
  assert.deepEqual(KINDS.series.seconds, [15, 35]);
});

test("the validator in cartoon mode: coin words drop a line or a caption, counting to a hundred is fine, an episode needs its lines, the fallback carries the episode's title", () => {
  const { extra, prompt } = scriptPrompt({ kind: "series", episode: episodeFor(4), formats: ["vertical", "wide"] });
  assert.match(extra, /THIS EPISODE: number 4, "The Question"/); assert.match(extra, /HOW AN EPISODE IS BUILT/); assert.match(prompt, /^Write episode 4, "The Question", now/);
  const raw = { title: "The Question", shots: [
    { bg: "bone", seconds: 4, caption: "RING.", actors: [{ who: "crumb", x: 0.5, actions: [{ do: "hop", t: 0.5 }] }], lines: [{ who: "crumb", say: "Hello? Yes, I can help." }, { who: "fudge", say: "Buy the coin now!" }] },
    { bg: "ink", seconds: 4, caption: "Every trade pays a 2% tax.", actors: [{ who: "nib", x: 0.3, actions: [] }], lines: [{ who: "nib", say: "I count a hundred bricks. No, 99." }] },
    { bg: "bone", seconds: 3, props: [{ kind: "wordmark", t: 0.2 }] },
  ] };
  const v = validateScript(raw, "series", { facts: "" });
  assert.ok(v.script);
  assert.deepEqual(v.script.shots[0].lines, [{ who: "crumb", say: "Hello? Yes, I can help." }]);
  assert.ok(v.dropped.some((d) => /coin words: "Buy the coin now!"/.test(d)));
  assert.equal(v.script.shots[1].caption, null, "a caption with tax words is dropped");
  assert.deepEqual(v.script.shots[1].lines, [{ who: "nib", say: "I count a hundred bricks. No, 99." }], "numbers up to a hundred are allowed in a cartoon");
  const silent = validateScript({ title: "x", shots: [{ seconds: 5, actors: [], lines: [] }] }, "series", {});
  assert.equal(silent.script, null); assert.ok(silent.dropped.includes("an episode needs its lines"));
  const fb = fallbackScript("series", { episode: episodeFor(9) });
  assert.equal(fb.title, "Quiet Day"); assert.equal(fb.kind, "series"); assert.ok(fb.shots.some((s) => s.lines.length));
  assert.ok(fb.shots.every((s) => s.lines.every((l) => !COIN_WORDS.test(l.say))));
  assert.equal(pickKind("next"), "series"); assert.equal(pickKind("episode 7"), "series"); assert.equal(pickKind("an explainer about the project"), "explainer");
  assert.equal(pickEpisode("episode 7"), 7); assert.equal(pickEpisode("Ep. 12 please"), 12); assert.equal(pickEpisode("next"), null);
});

test("Sprinkle makes the next episode each day and the counter moves on; captions and descriptions are the cartoon's; the owner can ask for an episode by number", async () => {
  const dir = mkdtempSync(join(tmpdir(), "season-"));
  const W = makeWorld();
  const s = sprinkleIn(W, { dir });
  assert.equal(s.nextEpisode, 1);
  const r1 = await s.daily();
  assert.equal(r1.kind, "series"); assert.equal(r1.episode, 1); assert.equal(r1.title, "Ep. 1: The Bell");
  assert.equal(s.nextEpisode, 2);
  const r2 = await s.daily();
  assert.equal(r2.title, "Ep. 2: One More Brick"); assert.equal(s.nextEpisode, 3);
  assert.match(W.tg.sent.at(-1)?.text || "", /^$|Sprinkle/); // the videos go by sendVideo; no stray text
  assert.equal(JSON.parse(W.store.getMeta("sprinkle:video:2")).episode, 2);
  const again = await s.onRequest("episode 2");
  assert.equal(again.title, "Ep. 2: One More Brick"); assert.equal(s.nextEpisode, 3, "an old episode again does not move the season");
  const next = await s.onRequest("next");
  assert.equal(next.episode, 3); assert.equal(s.nextEpisode, 4);
  const cap = tiktokCaption({ title: next.title, kind: next.kind, episode: episodeFor(next.episode) });
  assert.equal(cap, "Ep. 3: Too Loud. Four little brownies, one tiny kitchen, too many ideas. #brownies #cartoon #animation");
  const desc = videoDescription({ title: next.title, kind: next.kind, episode: episodeFor(next.episode) });
  assert.ok(desc.startsWith("Ep. 3: Too Loud. Episode 3 of Brownies, a cartoon"));
  assert.ok(!COIN_WORDS.test(desc) && !COIN_WORDS.test(cap));
  const ex = await s.onRequest("an explainer about the project");
  assert.equal(ex.kind, "explainer"); assert.equal(s.nextEpisode, 4, "an explainer does not touch the season");
  // the model's script is used when it passes the cartoon rules
  const W2 = makeWorld();
  const s2 = sprinkleIn(W2, { dir: mkdtempSync(join(tmpdir(), "season-")), reply: () => JSON.stringify({ title: "The Bell Rings", shots: [
    { bg: "bone", seconds: 4, caption: "RING.", actors: [{ who: "fudge", x: 0.3, actions: [{ do: "shout", t: 0.5 }] }, { who: "nib", x: 0.7, actions: [] }], lines: [{ who: "fudge", say: "Hear ye! A job!" }, { who: "nib", say: "What is a job?" }] },
    { bg: "ink", seconds: 4, actors: [{ who: "crumb", x: 0.5, actions: [{ do: "hop", t: 1 }] }], lines: [{ who: "crumb", say: "Hello? Yes, I can help." }] },
    { bg: "bone", seconds: 2, props: [{ kind: "wordmark", t: 0.2 }] },
  ] }) });
  const m = await s2.daily();
  assert.equal(m.source, "model"); assert.equal(m.title, "Ep. 1: The Bell Rings");
  assert.ok(W2.or.system().includes("THE SHOW: \"Brownies\"") && W2.or.system().includes("The Bell"), "the model got the bible and the beat");
});

test("the voices: each brownie has an Edge voice with its own pitch and rate", () => {
  for (const who of ["fudge", "crumb", "nib", "chip"]) {
    const v = VOICES[who];
    assert.match(v.voice, /^en-(US|GB)-\w+Neural$/);
    assert.match(v.prosody.pitch, /^[+-]\d+%$/); assert.match(v.prosody.rate, /^[+-]\d+%$/);
    assert.ok(v.pitch > 0.8 && v.pitch < 1.3 && v.rate / v.pitch > 0.5 && v.rate / v.pitch < 2, "ffmpeg's atempo stays in range");
  }
  assert.notEqual(VOICES.fudge.voice, VOICES.chip.voice);
});
