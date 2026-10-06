// Chip opens a pull request, merges a small one after three yes reviews, asks the owner for a big one, and never
// touches a protected path or writes a secret.
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./mock.mjs";
import { isProtected, isSmallKind } from "../helpers/chip.mjs";

const README = "# Brownies\n\nFour AI helpers.\n\n| Folder | What it is |\n| --- | --- |\n| `src/` | The contracts |\n| `web/` | The website |\n";
const FILES = { "README.md": README, "web/app.js": "// the app\nconst a = 1;\n", "web/docs.html": "<p>Docs</p>\n", "src/Sugar.sol": "contract Sugar {}\n", "test/Core.t.sol": "// tests\n" };

/// A model that answers Chip's three kinds of question: which files, the change, and the reviews.
function model({ change, reviews = { fudge: "YES. Plain and small.", crumb: "YES. Nothing promised.", nib: "YES. The facts hold." }, pick = { files: ["README.md"] } }) {
  return (body) => {
    const user = body.messages.filter((m) => m.role === "user").pop().content;
    const system = body.messages[0].content;
    if (/Is it safe and correct to merge/.test(user)) { const who = /You are (\w+),/.exec(system)[1].toLowerCase(); return reviews[who]; }
    if (/Which files do you need to read/.test(user)) return JSON.stringify(pick);
    if (/Write the change/.test(user)) return JSON.stringify(typeof change === "function" ? change(user) : change);
    return "YES";
  };
}
const smallChange = { title: "List helpers/ in the README table", description: "Adds one row for the helpers folder to the table in the README. Nothing else changes.", files: [{ path: "README.md", content: README.replace("| `web/` | The website |\n", "| `web/` | The website |\n| `helpers/` | The runtime of the four brownies |\n") }] };

test("a small change: branch, commits, pull request, three yes reviews, merged alone, reported as build", async () => {
  const W = makeWorld({ reply: model({ change: smallChange }), github: { files: FILES }, config: { chip: { standingTasks: [{ id: "readme-row", title: "List helpers/ in the root README", text: "Add a row for helpers/ to the table." }] } } });
  const r = await W.chip.work();
  assert.equal(r.merged, true);
  assert.equal(r.small, true);
  assert.equal(r.changed, 1);
  assert.equal(W.ghm.prs.length, 1);
  const pr = W.ghm.prs[0];
  assert.match(pr.head.ref, /^chip\/list-helpers-in-the-readme-table-2026-10-07$/);
  assert.equal(pr.base, "main");
  assert.match(pr.body, /Standing task: readme-row\./);
  assert.match(pr.body, /Small change: it merges itself/);
  assert.deepEqual(W.ghm.merged, [pr.number]);
  assert.ok(W.ghm.files.main["README.md"].includes("| `helpers/` |"), "the change reached main");
  assert.equal(W.ghm.commits.length, 1, "one commit per changed file");
  const build = W.gw.of("chip", "build");
  assert.equal(build.length, 1);
  assert.equal(build[0].url, pr.html_url);
  assert.equal(build[0].title, smallChange.title);
  assert.equal(build[0].place, "github");
  assert.equal(build[0].cost_micro, 2000, "Chip's two thoughts");
  const notes = W.gw.reports.filter((x) => x.kind === "note");
  assert.deepEqual(notes.map((n) => [n.helper, n.title]), [["fudge", `Reviewed Chip's change #${pr.number}: yes`], ["crumb", `Reviewed Chip's change #${pr.number}: yes`], ["nib", `Reviewed Chip's change #${pr.number}: yes`]]);
  assert.ok(W.ghm.comments.some((c) => c.number === pr.number && /Reviews by the other brownies/.test(c.body)));
  assert.deepEqual(W.gw.of("chip", "status").map((s) => s.title), ["Working on: List helpers/ in the root README"]);
  assert.equal(W.tg.sent.length, 0, "the owner was not bothered");
  assert.equal(await W.chip.work(), null, "the standing task is done, nothing left");
});

test("a bigger change waits for the owner: Telegram buttons, status 'Waiting for the owner', no merge; Approve merges it", async () => {
  const change = { title: "Add a chart to the app", description: "Adds a chart of SUGAR paid per day to the app page.", files: [{ path: "web/app.js", content: "// the app\nconst a = 1;\n" + "chart();\n".repeat(5) }] };
  const W = makeWorld({ reply: model({ change, pick: { files: ["web/app.js"] } }), github: { files: FILES, issues: [{ number: 7, title: "Add a chart", body: "A chart of SUGAR paid per day.", labels: ["chip"] }] } });
  const r = await W.chip.work();
  assert.equal(r.merged, false);
  assert.equal(r.small, false, "a .js file is not a small kind");
  assert.equal(W.ghm.merged.length, 0);
  const pr = W.ghm.prs[0];
  assert.match(pr.body, /Closes #7\./);
  assert.match(pr.body, /Bigger change: the other brownies review it, then the owner decides/);
  assert.equal(W.tg.sent.length, 1);
  const msg = W.tg.sent[0];
  assert.equal(String(msg.chat_id), "999");
  assert.match(msg.text, /^A bigger change: Add a chart to the app/);
  assert.deepEqual(msg.reply_markup.inline_keyboard, [[{ text: "Approve", callback_data: `approve:${r.approvalId}` }, { text: "Reject", callback_data: `reject:${r.approvalId}` }]]);
  assert.equal(W.gw.of("chip", "status").at(-1).title, "Waiting for the owner: Add a chart to the app");
  assert.equal(W.gw.of("chip", "build").length, 0);
  assert.equal(W.store.approval(r.approvalId).message_id, String(msg.message_id));
  assert.equal(await W.chip.work(), null, "nothing new while a pull request waits");
  await W.chip.decide(r.approvalId, "approve", { chatId: "999", messageId: msg.message_id });
  assert.deepEqual(W.ghm.merged, [pr.number]);
  assert.equal(W.gw.of("chip", "build")[0].url, pr.html_url);
  assert.ok(W.ghm.files.main["web/app.js"].includes("chart();"));
});

test("one no among the reviews blocks a small change and sends it to the owner", async () => {
  const W = makeWorld({ reply: model({ change: smallChange, reviews: { fudge: "YES. Fine.", crumb: "NO. The row says runtime but the folder is not in the repository yet.", nib: "yes, correct" } }), github: { files: FILES }, config: { chip: { standingTasks: [{ id: "t", title: "Row", text: "" }] } } });
  const r = await W.chip.work();
  assert.equal(r.merged, false);
  assert.deepEqual(r.reviews.map((x) => x.yes), [true, false, true]);
  assert.match(W.tg.sent[0].text, /^A reviewer said no: /);
  assert.match(W.gw.reports.find((x) => x.helper === "crumb" && x.kind === "note").title, /: no$/);
  await W.chip.decide(r.approvalId, "reject");
  assert.deepEqual(W.ghm.closed, [W.ghm.prs[0].number]);
  assert.match(W.gw.of("chip", "note")[0].title, /^Closed by the owner: /);
});

test("a protected path or a secret in the content means no pull request at all", async () => {
  const bad = (user) => (/CURRENT FILES/.test(user) ? { title: "x", description: "y", files: [{ path: "src/Sugar.sol", content: "contract Sugar { uint a; }" }] } : {});
  const W = makeWorld({ reply: model({ change: bad, pick: { files: [] } }), github: { files: FILES, issues: [{ number: 9, title: "Change the token", body: "" }] } });
  const r = await W.chip.work();
  assert.equal(r.done, false);
  assert.match(r.reason, /protected/);
  assert.equal(W.ghm.prs.length, 0);
  assert.ok(W.ghm.comments.some((c) => c.number === 9 && /could not do this safely/.test(c.body)));
  assert.equal(W.gw.of("chip", "status").at(-1).title, "Could not make a safe change for: Change the token");
  // a token-shaped string in a docs file is refused too
  const W2 = makeWorld({ reply: model({ change: { title: "x", description: "y", files: [{ path: "web/docs.html", content: "<p>Key: 0x" + "ab".repeat(32) + "</p>" }] } }), github: { files: FILES }, config: { chip: { standingTasks: [{ id: "k", title: "Docs", text: "" }] } } });
  const r2 = await W2.chip.work();
  assert.match(r2.reason, /looks like it holds a key/);
  assert.equal(W2.ghm.prs.length, 0);
  // the tree given to the model never lists protected files
  assert.doesNotMatch(W.or.lastUser(1), /src\/Sugar\.sol/);
  assert.match(W.or.lastUser(1), /web\/docs\.html/);
});

test("issues come before standing tasks, each task is taken once, and pull requests are not mistaken for issues", async () => {
  const W = makeWorld({ reply: model({ change: smallChange }), github: { files: FILES, issues: [{ number: 3, title: "Fix the README", body: "" }, { number: 4, title: "A PR", body: "", pull_request: true }] }, config: { chip: { standingTasks: [{ id: "s1", title: "Standing", text: "" }] } } });
  const a = await W.chip.work();
  assert.match(W.ghm.prs[0].body, /Closes #3\./);
  assert.ok(a.merged);
  W.ghm.files.main["README.md"] = README; // put the file back so the same change is a change again
  const b = await W.chip.work();
  assert.match(W.ghm.prs[1].body, /Standing task: s1\./);
  assert.ok(b.merged);
  assert.equal(await W.chip.work(), null);
  assert.equal(W.ghm.prs.length, 2);
});

test("a waiting pull request that the owner merged on GitHub itself unblocks Chip and is reported as build", async () => {
  const W = makeWorld({ reply: model({ change: smallChange }), github: { files: FILES }, config: { chip: { standingTasks: [{ id: "t", title: "Row", text: "" }] } } });
  const r = await W.fetch("https://api.github.com/repos/brownieshelper-glitch/brownies/pulls", { method: "POST", body: JSON.stringify({ title: "Old change", body: "", head: "chip/old", base: "main" }) });
  const pr = await r.json();
  W.ghm.files["chip/old"] = { ...W.ghm.files.main };
  const id = W.store.addApproval({ at: W.clock.now(), helper: "chip", kind: "pr", ref: pr.number, title: "Old change", url: pr.html_url });
  W.ghm.prs[0].state = "closed"; W.ghm.prs[0].merged = true; // the owner pressed merge on GitHub
  const out = await W.chip.work();
  assert.equal(W.store.approval(id).state, "approved");
  assert.deepEqual(W.gw.of("chip", "build").map((b) => b.title), ["Old change", smallChange.title], "the old one is reported, then the new task ran");
  assert.ok(out.merged);
});

test("the path rules", () => {
  for (const p of ["src/Sugar.sol", "eth-launch/launch.mjs", "gateway/auth.mjs", "gateway/deploy-server.sh", "helpers/deploy-server.sh", ".github/workflows/ci.yml", "gateway/.env.example", "helpers/lib/brain.mjs", "web/wallet.js", "package.json", "notes/private-key.md"]) assert.equal(isProtected(p), true, p);
  for (const p of ["README.md", "web/docs.html", "web/styles.css", "notes/2026-10-07.md", "helpers/facts.md", "test/Core.t.sol", "gateway/test/team.test.mjs"]) assert.equal(isProtected(p), false, p);
  for (const p of ["README.md", "web/docs.html", "web/styles.css", "test/Core.t.sol", "gateway/test/team.test.mjs", "helpers/test/chip.test.mjs"]) assert.equal(isSmallKind(p), true, p);
  for (const p of ["web/app.js", "gateway/server.mjs", "helpers/brownies.json", "foundry.toml"]) assert.equal(isSmallKind(p), false, p);
});
