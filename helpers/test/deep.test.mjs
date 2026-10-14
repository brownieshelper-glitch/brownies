// The full-power reviews, the arithmetic and the shapes: several searches into one piece of research, the second
// reading of an idea, the open questions, a shortlist and its votes, the second reading of findings, a fix's shape,
// the findings and the patches as text.
import test from "node:test";
import assert from "node:assert/strict";
import { ANGLES, searchShape, mergeResearch, secondReviewShape, secondReviewPrompt, openQuestions, openShape, SPECIALISTS, REVIEW_SECTIONS, REVIEW_WRITE_SYSTEM, editorShape, ideasShape, shortlistShape, shortlistFallback, voteIdeasShape, rankIdeas, ideasBlock, existsShape, IDEAS_SECTIONS, LENSES, huntPrompt, judgeShape, tallyVerdicts, secondLine, fixShape, boxLine, codeFindingsBlock, patchesText, lightFindings, CODE_SECTIONS } from "../lib/deep.mjs";

test("the web before the panel: the angles of each kind, one search read, several merged with the duplicates folded and the failed angles named", () => {
  assert.deepEqual(ANGLES.review.map((a) => a.key), ["competitors", "demand", "risks"]); assert.deepEqual(ANGLES.brainstorm.map((a) => a.key), ["existing", "moves"]);
  const a = searchShape({ found: [{ name: "Boxy", url: "https://boxy.example", what: "pastry boxes", detail: "29 USD a month" }, { name: "NoLink", url: "boxy", what: "x" }, { what: "no name" }], facts: [{ claim: "Boxes grew 10% in 2025", source: "https://r.example" }, { claim: "", source: "https://x" }], notes: "Two exist." });
  assert.deepEqual(a.found, [{ name: "Boxy", url: "https://boxy.example", what: "pastry boxes", detail: "29 USD a month" }, { name: "NoLink", url: null, what: "x", detail: "" }]); assert.deepEqual(a.facts, [{ claim: "Boxes grew 10% in 2025", source: "https://r.example" }]);
  const m = mergeResearch([{ angle: "competitors", answer: a }, { angle: "demand", answer: searchShape({ found: [{ name: "boxy!", url: "https://other.example", what: "the same one" }, { name: "Dolce", url: "https://dolce.example", what: "kits" }], facts: [{ claim: "Boxes grew 10% in 2025", source: "https://dup.example" }, { claim: "Spain exports rose in 2024", source: "https://i.example" }], notes: "Demand is there." }) }, { angle: "risks", answer: null }]);
  assert.deepEqual(m.found.map((f) => [f.name, f.angle]), [["Boxy", "competitors"], ["NoLink", "competitors"], ["Dolce", "demand"]], "the same name is one entry");
  assert.equal(m.facts.length, 2); assert.deepEqual(m.notes, { competitors: "Two exist.", demand: "Demand is there." }); assert.deepEqual(m.failed, ["risks"]);
  assert.deepEqual(mergeResearch([]), { found: [], facts: [], notes: {}, failed: [] });
});

test("the second reading of an idea, and the open questions it leaves", () => {
  const s = secondReviewShape({ score: "6.5", moved: "The customs cost is real.", agree: ["one city first"], disagree: [{ with: "model b", point: "the margin is fine", why: "shipping alone is 12 euros" }, { with: "", why: "no name" }], missed: ["the kits spoil in summer"], kill: "shipping eats the margin", save: "sell in Spain first" });
  assert.equal(s.score, 6.5); assert.deepEqual(s.disagree, [{ with: "model b", point: "the margin is fine", why: "shipping alone is 12 euros" }]); assert.equal(s.kill, "shipping eats the margin");
  assert.equal(secondReviewShape({}), null); assert.equal(secondReviewShape("no"), null);
  const answered = [{ name: "model a", answer: { score: 7, questions: ["Who pays the shipping?", "How long does a kit keep?"], unknowns: ["the margin"] } }, { name: "model b", answer: { score: 5, questions: ["who pays the shipping"], unknowns: [] } }];
  const p = secondReviewPrompt("the idea", { found: [] }, answered, answered[0]);
  assert.match(p, /YOUR OWN FIRST REVIEW \(model a\):/); assert.match(p, /THE OTHER REVIEWERS:\n### model b \(score 5\)/); assert.ok(!/### model a \(score 7\)/.test(p), "a reviewer does not read itself among the others");
  assert.deepEqual(openQuestions(answered, [{ name: "model a", answer: s }]), ["the kits spoil in summer", "Who pays the shipping?", "How long does a kit keep?", "the margin"], "what was missed first, then the reviewers' own, the same question once");
  assert.deepEqual(openShape({ answers: [{ question: "Who pays?", answer: "The buyer, 12 euros.", sources: ["https://a.example", "nope"] }, { question: "", answer: "x" }], only_you: ["your margin"] }), { answers: [{ question: "Who pays?", answer: "The buyer, 12 euros.", sources: ["https://a.example"] }], only_you: ["your margin"] });
  assert.deepEqual(SPECIALISTS.map((x) => x.heading), ["The first 30 days", "The money", "The build"]); for (const x of SPECIALISTS) assert.ok(REVIEW_SECTIONS.includes(x.heading) && REVIEW_WRITE_SYSTEM.includes(`## ${x.heading}`));
  assert.equal(REVIEW_SECTIONS.length, 15);
  assert.deepEqual(editorShape({ problems: [{ quote: "a market of 3 billion", why: "no source" }, { quote: "", why: "x" }] }), [{ quote: "a market of 3 billion", why: "no source" }]); assert.deepEqual(editorShape({}), []);
});

test("a brainstorm's shortlist and its votes: the ranking by the mean total, the picks, the spread; the list as text", () => {
  assert.equal(ideasShape({ ideas: [{ name: "a", what: "x" }] }), null, "fewer than three ideas is no answer"); assert.equal(ideasShape({ ideas: Array.from({ length: 14 }, (_, i) => ({ name: `idea ${i}`, what: "w", score: 12 })) }).ideas.length, 10);
  assert.equal(shortlistShape({ candidates: [{ name: "a", what: "b" }] }), null, "a shortlist of one is no shortlist");
  const answered = [{ name: "model a", answer: { ideas: [{ name: "Cannoli Kits", what: "kits by post", who_pays: "expats", first_step: "sell 20", risk: "customs", score: 8 }, { name: "Pastry Classes", what: "online classes", who_pays: "hobby bakers", first_step: "one class", risk: "free videos", score: 6 }] } }, { name: "model b", answer: { ideas: [{ name: "cannoli kits!", what: "the same", who_pays: "x", first_step: "y", risk: "z", score: 7 }, { name: "Cafe Supply", what: "kits for cafes", who_pays: "cafes", first_step: "call ten", risk: "margins", score: 5 }] } }];
  const list = shortlistFallback(answered);
  assert.deepEqual(list.map((c) => [c.id, c.name, c.proposed_by]), [[1, "Cannoli Kits", ["model a", "model b"]], [2, "Pastry Classes", ["model a"]], [3, "Cafe Supply", ["model b"]]], "the same name folded, the most proposed first");
  assert.equal(voteIdeasShape({ votes: [{ id: 1, demand: 8 }] }), null, "a vote needs its four numbers");
  const vote = (a, b, c, top, wild, why) => ({ votes: [{ id: 1, ...a }, { id: 2, ...b }, { id: 3, ...c }], top, wild, why });
  const voters = [
    { name: "model a", answer: voteIdeasShape(vote({ demand: 8, start: 8, edge: 6, money: 8 }, { demand: 5, start: 9, edge: 3, money: 5 }, { demand: 6, start: 4, edge: 6, money: 7 }, [1, 3, 2], 3, "people already ask for it")) },
    { name: "model b", answer: voteIdeasShape(vote({ demand: 6, start: 6, edge: 4, money: 6 }, { demand: 4, start: 8, edge: 2, money: 4 }, { demand: 9, start: 5, edge: 8, money: 9 }, [3, 1], 3, "cafes pay monthly")) },
  ];
  const ranked = rankIdeas(list, voters);
  assert.deepEqual(ranked.map((c) => [c.name, c.total, c.top3, c.first, c.wild, c.spread]), [["Cannoli Kits", 26, 2, 1, 0, 8], ["Cafe Supply", 27, 2, 1, 2, 8], ["Pastry Classes", 20, 1, 0, 0, 4]].sort((x, y) => y[1] - x[1]));
  assert.equal(ranked[0].name, "Cafe Supply"); assert.deepEqual([ranked[0].demand, ranked[0].start, ranked[0].edge, ranked[0].money], [7.5, 4.5, 7, 8]); assert.deepEqual(ranked[0].firstBy, [{ name: "model b", why: "cafes pay monthly" }]);
  const checks = existsShape({ checks: [{ id: 3, exists: [{ name: "KitCo", url: "https://kitco.example", what: "kits for cafes", price: "90 USD a month" }, { name: "NoLink", url: "x" }], note: "a few players" }, { id: 1, exists: [], note: "nothing close" }] });
  const block = ideasBlock(ranked, checks, voters.length);
  assert.match(block, /^1\. \*\*Cafe Supply\.\*\* kits for cafes Who pays: cafes\n   The panel: 27 out of 40 \(demand 7\.5, can start 4\.5, edge 7, money 8\)\. 2 of 2 models put it in their three best, 1 put it first\.\n   Proposed by: model b\.\n   Already out there: \[KitCo\]\(https:\/\/kitco\.example\) \(90 USD a month\): kits for cafes\.\n   First step: call ten\n   The risk: margins\n\n2\. \*\*Cannoli Kits\.\*\*/);
  assert.match(block, /2\. \*\*Cannoli Kits\.\*\*[^\n]*\n[^\n]*\n   Proposed by: model a, model b\.\n   Already out there: nothing close was found \(nothing close\)\./); assert.match(block, /3\. \*\*Pastry Classes\.\*\*[\s\S]*Already out there: not searched\./);
  assert.deepEqual(IDEAS_SECTIONS, ["The brief", "The ten ideas", "The three to start with", "The wild cards", "Where the panel argued", "What to do next"]);
});

test("the second reading of findings, a fix's shape, and the findings and patches as text", () => {
  assert.deepEqual(LENSES.map((l) => l.key), ["security", "failure", "logic"]);
  assert.match(huntPrompt("THE CODE", LENSES[0], [{ title: "Balance goes negative", file: "./src/pay.js", line: 3 }]), /^YOUR LENS: security and money: [\s\S]*WHAT THE PANEL ALREADY FOUND \(do not repeat\):\n- Balance goes negative \(\.\/src\/pay\.js:3\)\n\nTHE CODE$/);
  assert.deepEqual(judgeShape({ verdicts: [{ id: 1, verdict: "REAL", why: "line 3 subtracts first" }, { id: "2", verdict: "maybe", why: "" }, { verdict: "real" }] }), [{ id: 1, verdict: "real", why: "line 3 subtracts first" }, { id: 2, verdict: "unsure", why: "" }]);
  const F = [{ id: 1, title: "Balance goes negative", severity: "high", file: "./src/pay.js", line: 3, what: "no check", why_it_matters: "money", failure_case: "balance 10, charge 50", fix: "check first", found_by: ["model a", "model b"] }, { id: 2, title: "Negative amount is silent", severity: "medium", file: "./src/pay.js", line: 2, what: "returns nothing", why_it_matters: "callers cannot tell", failure_case: "charge(user, -5)", fix: "throw", found_by: ["model b"] }, { id: 3, title: "Unread", severity: "low", file: "", line: null, what: "w", why_it_matters: "y", failure_case: "c", fix: "f", found_by: ["model c"] }];
  tallyVerdicts(F, [{ name: "model a", verdicts: [{ id: 1, verdict: "real", why: "line 3" }, { id: 2, verdict: "not real", why: "line 2 returns on purpose" }] }, { name: "model b", verdicts: [{ id: 1, verdict: "real", why: "" }, { id: 2, verdict: "not real", why: "the caller checks" }] }, { name: "model c", verdicts: [{ id: 1, verdict: "unsure", why: "depends on the caller" }, { id: 2, verdict: "real", why: "silent" }] }]);
  assert.deepEqual([F[0].second.real, F[0].second.not_real, F[0].second.unsure, F[0].disputed], [2, 0, 1, false]); assert.deepEqual([F[1].second.real, F[1].second.not_real, F[1].disputed], [1, 2, true]); assert.deepEqual([F[2].second.readers, F[2].disputed], [0, false]);
  assert.equal(secondLine(F[0]), "2 of 3 readers say it is real, 1 unsure."); assert.equal(secondLine(F[1]), "1 of 3 readers say it is real, 2 say the code handles it."); assert.equal(secondLine(F[2]), "not read a second time");
  assert.deepEqual(F[0].second.notes, ["model a (real): line 3", "model c (unsure): depends on the caller"]);
  assert.deepEqual(fixShape({ files: [{ path: "./src/pay.js", content: "fixed" }, { path: "../etc/passwd", content: "x" }, { path: "src/other.js", content: "y" }], note: "A check before the subtraction." }, ["src/pay.js"]), { files: [{ path: "src/pay.js", content: "fixed" }], note: "A check before the subtraction." }, "only the file that was given, never a path that climbs");
  assert.deepEqual(fixShape({ files: [], note: "it needs a schema change" }, ["a.js"]), { files: [], note: "it needs a schema change" });
  F[0].reproduced = { status: "confirmed", output: "start\nBUG REPRODUCED: balance is -40\n", tries: 2 }; F[0].fix_result = { status: "proven", note: "A check before the subtraction.", patch: "--- src/pay.js\n+++ fixed\n@@ -3 +3,2 @@\n+  if (cents > user.balance) throw new Error('no');\n", testsExit: 0 };
  F[1].reproduced = { status: "no script", output: "the second reading says the code already handles this, so no script was written", tries: 1 };
  F[2].reproduced = { status: "not reproduced", output: "NOT REPRODUCED: fine", tries: 1 }; F[2].fix_result = { status: "tests broke", note: "It renamed a field." };
  assert.equal(boxLine(F[0]), "YES, a script in the box showed it (on the second try): BUG REPRODUCED: balance is -40"); assert.match(boxLine(F[2]), /^NO, the script found the code behaving correctly on this case: NOT REPRODUCED: fine\./); assert.equal(boxLine({}), "not tried");
  const block = codeFindingsBlock([F[0], F[2]], 4, { box: boxLine, patchesHref: "order-1-k-patches.md" });
  assert.match(block, /^### 1\. Balance goes negative \(high\)\n\n\*\*Where:\*\* \.\/src\/pay\.js, line 3\n\nno check\n\n\*\*Why it matters:\*\* money\n\n\*\*How it fails:\*\* balance 10, charge 50\n\n\*\*The second reading:\*\* 2 of 3 readers say it is real, 1 unsure\.\n\n\*\*Reproduced in the box:\*\* YES, a script in the box showed it \(on the second try\): BUG REPRODUCED: balance is -40\n\n\*\*Fix proven in the box:\*\* YES\. With the patch applied in the box the project's tests pass and the script no longer shows the bug\. A check before the subtraction\. \[The patch\]\(order-1-k-patches\.md#fix-1\)\.\n\n\*\*Fix:\*\* check first\n\n\*\*Found by:\*\* model a, model b \(2 of 4\)\n\n### 3\. Unread \(low\)/);
  assert.match(block, /\*\*Fix proven in the box:\*\* a patch was tried and it broke the project's tests, so no patch is given\. It renamed a field\./);
  assert.equal(codeFindingsBlock([], 4), "The panel found nothing it could point to with a concrete failure case.");
  const patches = patchesText(F);
  assert.match(patches, /^# The patches\n\nEach one was applied in the box/); assert.match(patches, /<a id="fix-1"><\/a>\n\n## 1\. Balance goes negative\n\nA check before the subtraction\.\n\n```diff\n--- src\/pay\.js\n/); assert.ok(!/## 3\./.test(patches)); assert.equal(patchesText([F[1]]), "");
  assert.deepEqual(lightFindings([F[0]])[0], { id: 1, title: "Balance goes negative", severity: "high", file: "./src/pay.js", line: 3, what: "no check", found_by: ["model a", "model b"], second: { real: 2, handles_it: 0, unsure: 1, reasons: ["model a (real): line 3", "model c (unsure): depends on the caller"] }, disputed: false, reproduced: "confirmed", fix: "proven" });
  assert.deepEqual(CODE_SECTIONS, ["The verdict", "The findings", "Disputed on the second reading", "What the tests say", "Where the panel disagrees", "What to fix first", "Next steps"]);
});
