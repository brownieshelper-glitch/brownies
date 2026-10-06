// Nib writes its daily note through the GitHub API, in one commit, and reports it with the file's link.
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./mock.mjs";

const NOTE = "## What changed\n\nThe gateway counts 3 activations (gateway stats). Orbio's page says the protocol takes 10% of fees (Orbio).\n\n## What to do\n\n- Fudge: one post on the loyalty bonus.\n- Crumb: point people to the docs for the key.\n- Chip: add the notes folder readme.";

test("the note is written to notes/YYYY-MM-DD.md, reported as research, and kept for Fudge and Crumb", async () => {
  const W = makeWorld({ reply: () => NOTE, cost: 0.004 });
  const r = await W.nib.note();
  assert.equal(r.date, "2026-10-07");
  assert.equal(r.url, "https://github.com/brownieshelper-glitch/brownies/blob/main/notes/2026-10-07.md");
  const puts = W.fetch.callsTo("/contents/notes%2F2026-10-07.md", "PUT").concat(W.fetch.callsTo("/contents/notes/2026-10-07.md", "PUT"));
  assert.equal(puts.length, 1, "one commit");
  assert.equal(puts[0].body.branch, "main");
  assert.equal(puts[0].body.message, "Nib: research note 2026-10-07");
  assert.equal(puts[0].body.sha, undefined, "a new file carries no sha");
  const saved = W.ghm.files.main["notes/2026-10-07.md"];
  assert.match(saved, /^# Research note 2026-10-07\n/);
  assert.ok(saved.includes("## What to do"));
  const rep = W.gw.of("nib", "research");
  assert.equal(rep.length, 1);
  assert.equal(rep[0].url, r.url);
  assert.equal(rep[0].place, "github");
  assert.equal(rep[0].cost_micro, 4000);
  assert.match(rep[0].title, /^Research note 2026-10-07: The gateway counts 3 activations/);
  assert.deepEqual(W.gw.of("nib", "status").map((s) => s.title), ["Reading the chain, the site and the competitors", "Writing today's research note"]);
  assert.equal(W.store.latestNote.text, NOTE);
  // the prompt carried the material: stats, the site, the competitor as text (no script), no previous note
  const prompt = W.or.lastUser(1);
  assert.match(prompt, /"activations":3/);
  assert.match(prompt, /Inference credits on Ethereum/);
  assert.match(prompt, /Agents on chain\. The protocol takes 10% of fees\./);
  assert.doesNotMatch(prompt, /secretScript/);
  assert.match(prompt, /PREVIOUS NOTE: none/);
  // Fudge's and Crumb's prompts now carry the note
  assert.match(W.fudge.system(), /LATEST RESEARCH NOTE, written by Nib\n2026-10-07: ## What changed/);
  assert.equal(await W.nib.note(), null, "one note a day");
  assert.equal(W.or.calls.length, 1);
});

test("a competitor page that fails is said so in the prompt; the next day's note updates nothing twice and sees the previous note", async () => {
  const W = makeWorld({ reply: () => NOTE });
  W.fetch.on("GET", "https://down.test/", () => ({ status: 503, text: "nope" }));
  W.nib.competitors = [{ name: "Down", url: "https://down.test/" }];
  await W.nib.note();
  assert.match(W.or.lastUser(1), /\[https:\/\/down\.test\/ answered 503\]/);
  await W.clock.advance(24 * 3_600_000);
  const r2 = await W.nib.note();
  assert.equal(r2.date, "2026-10-08");
  assert.match(W.or.lastUser(2), /PREVIOUS NOTE \(2026-10-07\)/);
  assert.equal(Object.keys(W.ghm.files.main).filter((p) => p.startsWith("notes/")).length, 2);
});

test("without GitHub the note stays in the store and is still reported, without a link", async () => {
  const W = makeWorld({ reply: () => NOTE });
  W.github.token = "";
  const r = await W.nib.note();
  assert.equal(r.url, null);
  assert.equal(W.gw.of("nib", "research")[0].url, undefined);
  assert.equal(W.store.latestNote.date, "2026-10-07");
});
