// The research-to-code loop: every "Chip: ..." line in Nib's note becomes a GitHub issue labelled chip, at most two
// a day, never the same suggestion twice; Chip then takes it like any issue.
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./mock.mjs";

const NOTE = "## What changed\nNothing much.\n\n## What to do\nFudge: post about the Kitchen.\nChip: add a FAQ link to the docs page footer.\n- Chip: fix the typo in web/docs.html, 'recieve'.\nChip: a third one that is over the limit.\nCrumb: answer about SUGAR.";

test("Nib files Chip's lines as issues, two at most, labelled chip, with the note's link", async () => {
  const W = makeWorld({ reply: () => NOTE });
  const r = await W.nib.note();
  assert.equal(r.issues.length, 2);
  assert.deepEqual(r.issues.map((i) => i.task), ["add a FAQ link to the docs page footer.", "fix the typo in web/docs.html, 'recieve'."]);
  assert.equal(W.ghm.issues.length, 2);
  assert.equal(W.ghm.issues[0].title, "add a FAQ link to the docs page footer");
  assert.deepEqual(W.ghm.issues[0].labels, ["chip"]);
  assert.match(W.ghm.issues[0].body, /From Nib's research note of \d{4}-\d{2}-\d{2} \(https:\/\/github\.com\/.*notes\/.*\.md\)/);
  assert.match(W.ghm.issues[0].body, /> Chip: add a FAQ link/);
  // Chip sees them as its next tasks
  const next = await W.chip.nextTask();
  assert.equal(next.kind, "issue");
  assert.equal(next.number, 200);
});

test("the same suggestion the next day is not filed again; the loop can be switched off", async () => {
  const W = makeWorld({ reply: () => NOTE });
  await W.nib.note();
  W.clock.advance(86_400_000);
  const r2 = await W.nib.note();
  assert.equal(r2.issues.length, 1, "the two already filed are skipped; the third, held back by the daily limit, is filed now");
  assert.equal(r2.issues[0].task, "a third one that is over the limit.");
  assert.equal(W.ghm.issues.length, 3);
  W.clock.advance(86_400_000);
  assert.equal((await W.nib.note()).issues.length, 0, "nothing new on the third day");
  const W2 = makeWorld({ reply: () => NOTE, config: { nib: { chipIssues: false } } });
  const r3 = await W2.nib.note();
  assert.equal(r3.issues.length, 0);
  assert.equal(W2.ghm.issues.length, 0);
});
