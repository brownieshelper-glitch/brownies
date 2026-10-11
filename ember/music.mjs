// The kitchen cam's music bed: the videos' own synthesized music (helpers/video/audio.mjs, nothing licensed
// from anyone), eight tunes of forty-five seconds with different seeds, one after another, as one WAV the
// stream loops. Run on the owner's PC: node ember/music.mjs; it writes ember/music.wav (about 17 MB).
import { writeFileSync } from "node:fs";
import { music, wavBytes, RATE } from "../helpers/video/audio.mjs";

const SEEDS = [3, 11, 19, 27, 35, 43, 51, 59];
const SECONDS = 45, GAP = 1.5;
const total = SEEDS.length * (SECONDS + GAP);
const pcm = new Float32Array(Math.round(total * RATE));
let at = 0;
for (const seed of SEEDS) {
  const part = music(SECONDS, seed, { bpm: 96 + (seed % 5) * 4, gain: 0.14 });
  const n = Math.min(part.length, pcm.length - at);
  const fade = Math.round(RATE * 1.2);
  for (let i = 0; i < n; i++) { const g = i < fade ? i / fade : i > n - fade ? (n - i) / fade : 1; pcm[at + i] += part[i] * g; }
  at += Math.round((SECONDS + GAP) * RATE);
}
writeFileSync(new URL("./music.wav", import.meta.url), wavBytes(pcm, RATE));
console.log(`music.wav: ${total.toFixed(0)} s, ${SEEDS.length} tunes, ${RATE} Hz`);
