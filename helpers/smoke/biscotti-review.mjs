// A real idea review on the server, not paid: the runtime is built the way run.mjs builds it (the same settings,
// the same store, the same shop folder), Biscotti runs the panel, the research and the writer against the real
// models, the page is kept by the shop and its public link is printed and sent to the owner. Costs about a dollar
// of OpenRouter. usage, on the server: cd /srv/brownies/helpers && node smoke/biscotti-review.mjs "the idea ..."
import { build } from "../run.mjs";

const idea = process.argv.slice(2).join(" ").trim();
if (idea.length < 10) { console.log("give the idea as the argument"); process.exit(1); }
const W = await build();
const b = W.helpers.biscotti;
if (!b) { console.log("Biscotti is not on this server"); process.exit(1); }
console.log(`panel: ${b.panel.join(", ")}; research: ${b.researcher}; writer: ${b.writer || W.brain.model("biscotti")}`);
const started = Date.now();
const out = await b.onRequest(`test ${idea}`);
console.log(`${Math.round((Date.now() - started) / 1000)} s`);
console.log(out);
if (W.telegram?.configured && W.S.telegram.ownerChatId) await W.telegram.sendMessage(W.S.telegram.ownerChatId, `A sample idea review, made on the server as a test (not paid):\n${out}`).catch((e) => console.log(`Telegram did not take it: ${e.message}`));
process.exitCode = 0;
setTimeout(() => process.exit(0), 500).unref();
