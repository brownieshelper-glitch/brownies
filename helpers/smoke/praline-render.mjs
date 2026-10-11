// One real milestone clip with the site's engine and ffmpeg (run on the droplet, where ffmpeg lives): a stake
// clip for a made-up wallet into a temp folder, the file size and the poster printed. No Telegram, no store on disk.
// usage: node smoke/praline-render.mjs [kind] [name]
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../lib/store.mjs";
import { Praline } from "../helpers/praline.mjs";

const [kind = "stake", name = "ann.eth"] = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(), "praline-smoke-"));
const store = new Store(":memory:");
const clock = { now: () => Date.now() };
const log = (l) => console.log("   ", l);
const p = new Praline({ config: { maxPerDay: 5, ffmpegPath: process.env.FFMPEG_PATH || "/usr/bin/ffmpeg" }, brain: { helpers: {} }, gateway: null, store, clock, alerts: null, facts: "", log, telegram: null, ownerChatId: "", baseUrl: "https://api.feedthebrownies.com", videosDir: dir, bakery: null, fetch: async () => ({ ok: false, status: 404 }), deploymentJson: "", ens: async () => name });
const t0 = Date.now();
const c = await p.make({ kind, wallet: "0x1111111111111111111111111111111111111111", detail: kind === "bake" ? "Pip" : kind === "loyalty" ? "+12% loyalty bonus" : "" });
if (!c) { console.log("no clip made"); process.exitCode = 1; }
else console.log(`clip: ${c.file} (${(statSync(c.file).size / 1e3).toFixed(0)} KB, ${c.seconds} s) poster ${c.poster} (${(statSync(c.poster).size / 1e3).toFixed(0)} KB), in ${((Date.now() - t0) / 1000).toFixed(1)} s, title "${c.title}"`);
