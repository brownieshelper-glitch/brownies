// The code review's plumbing: a request names a repository (with its branch and notes), the pack command is
// one shell line the box can run, the toolchain is told from the file list, the pack is read back.
import test from "node:test";
import assert from "node:assert/strict";
import { parseCodeRequest, PACK_COMMAND, testCommand, toolchain, readPack, testsLine, MAX_LINES, REPRO, MAX_REPROS, reproCommand, readRepro } from "../lib/codepack.mjs";

test("a request: the url, the branch, the notes; tree urls; no url is null", () => {
  assert.deepEqual(parseCodeRequest("https://github.com/a/b"), { url: "https://github.com/a/b", ref: null, notes: "" });
  assert.deepEqual(parseCodeRequest("https://github.com/a/b.git main: look at the payment flow"), { url: "https://github.com/a/b", ref: "main", notes: "look at the payment flow" });
  const r = parseCodeRequest("Please review https://gitlab.com/x/y/z, branch develop. The auth part.");
  assert.equal(r.url, "https://gitlab.com/x/y/z"); assert.equal(r.ref, "develop"); assert.match(r.notes, /^Please review.*The auth part\.$/);
  assert.equal(parseCodeRequest("https://github.com/a/b on commit 0a1b2c3d4e").ref, "0a1b2c3d4e");
  assert.deepEqual(parseCodeRequest("https://github.com/a/b/tree/feature-x/src is the folder"), { url: "https://github.com/a/b", ref: "feature-x", notes: "is the folder" });
  assert.deepEqual(parseCodeRequest("https://github.com/a/b focus on the parser"), { url: "https://github.com/a/b", ref: null, notes: "focus on the parser" }, "a word that is not a branch name stays in the notes");
  assert.equal(parseCodeRequest("review my code please"), null);
  assert.equal(parseCodeRequest("http://github.com/a/b"), null, "https only");
  assert.equal(MAX_LINES, 5000);
});

test("the pack command and the test command are one shell line each; the toolchain from the files; the pack read back", () => {
  assert.match(PACK_COMMAND, /^mkdir -p __review && find \. /); assert.match(PACK_COMMAND, /-name '\*\.sol'/); assert.match(PACK_COMMAND, /-path '\.\/node_modules'/); assert.match(PACK_COMMAND, /> __review\/code\.txt/);
  assert.ok(!PACK_COMMAND.includes("\n"));
  assert.equal(testCommand("npm test"), `(npm test) > __review/tests.txt 2>&1; echo "exit:$?" >> __review/tests.txt; true`);
  assert.match(testCommand(null), /no test command/);
  const node = toolchain(["./package.json", "./src/a.js", "./test/a.test.js"], { packageJson: JSON.stringify({ scripts: { test: "node --test" } }) });
  assert.equal(node.image, "node"); assert.match(node.install, /^npm ci --ignore-scripts/); assert.equal(node.test, "npm test --silent"); assert.equal(node.kind, "node");
  assert.equal(toolchain(["./package.json"], { packageJson: JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }).test, null);
  assert.equal(toolchain(["./package.json"], { packageJson: "not json" }).test, null);
  const f = toolchain(["./foundry.toml", "./src/A.sol", "./package.json"]);
  assert.equal(f.image, "foundry"); assert.equal(f.install, "forge build"); assert.match(f.test, /^forge test/);
  const py = toolchain(["./requirements.txt", "./app/main.py", "./tests/test_main.py"]);
  assert.equal(py.image, "python"); assert.match(py.install, /pip install --user -q -r requirements.txt; pip install --user -q pytest/); assert.match(py.test, /pytest/);
  assert.equal(toolchain(["./pyproject.toml", "./pkg/x.py"]).test, null, "no tests folder");
  assert.match(toolchain(["./Cargo.toml", "./src/main.rs"]).note, /no Rust toolchain/);
  assert.equal(toolchain(["./hardhat.config.js", "./contracts/A.sol"]).test, "npx hardhat test");
  assert.match(toolchain(["./README.md"]).note, /no package\.json, foundry\.toml or pyproject\.toml/);
  const pack = readPack({ "__review/files.txt": "./a.js\n./b.js\n", "__review/lines.txt": "120\n", "__review/tree.txt": ".\n./a.js", "__review/code.txt": "\n===== ./a.js\nlet a;\n", "__review/tests.txt": "1 passing\nexit:0\n" });
  assert.deepEqual(pack.files, ["./a.js", "./b.js"]); assert.equal(pack.lines, 120); assert.equal(pack.tests, "1 passing"); assert.equal(pack.testsExit, 0); assert.match(pack.code, /===== \.\/a\.js/);
  assert.equal(testsLine(pack, { test: "npm test" }), "The project's own tests passed in the box.");
  assert.equal(testsLine(readPack({ "__review/tests.txt": "2 failing\nexit:1" }), { test: "npm test" }), "The project's own tests FAILED in the box (exit 1).");
  assert.match(testsLine(readPack({}), { test: "npm test" }), /did not finish/);
  assert.match(testsLine(readPack({}), { test: null, note: "no Rust toolchain" }), /^no Rust toolchain$/);
  assert.match(testsLine(readPack({}), { test: null }), /^No test command was found/);
  assert.deepEqual(readPack({}).files, []);
});

test("the reproductions: a script path and a run per toolchain, one shell line for all of them, the results read back by their markers", () => {
  assert.equal(REPRO.node.file(3), "__review/repro-3.mjs"); assert.equal(REPRO.node.run(3), "node __review/repro-3.mjs");
  assert.equal(REPRO.python.file(1), "__review/repro_1.py"); assert.equal(REPRO.foundry.file(2), "test/__Repro2.t.sol"); assert.match(REPRO.foundry.run(2), /^forge test --match-path 'test\/__Repro2\.t\.sol' -vv$/);
  assert.equal(REPRO.rust, null); assert.equal(REPRO.unknown, null);
  assert.equal(reproCommand({ kind: "node" }, [1, 2]), `: > __review/repro.txt; printf '##### repro %s\\n' 1 >> __review/repro.txt; (timeout 120 node __review/repro-1.mjs) >> __review/repro.txt 2>&1; echo "exit:$?" >> __review/repro.txt; printf '##### repro %s\\n' 2 >> __review/repro.txt; (timeout 120 node __review/repro-2.mjs) >> __review/repro.txt 2>&1; echo "exit:$?" >> __review/repro.txt; true`);
  assert.match(reproCommand({ kind: "rust" }, [1]), /^echo 'no reproductions'/); assert.match(reproCommand({ kind: "node" }, []), /^echo 'no reproductions'/);
  const r = readRepro("##### repro 1\nBUG REPRODUCED: balance -40\nexit:0\n##### repro 2\nsome noise\nNOT REPRODUCED: fine\nexit:2\n##### repro 3\nSyntaxError: Unexpected token\nexit:1\n##### repro 4\nexit:124\n");
  assert.deepEqual(r, { 1: { status: "confirmed", exit: 0, output: "BUG REPRODUCED: balance -40" }, 2: { status: "not reproduced", exit: 2, output: "some noise\nNOT REPRODUCED: fine" }, 3: { status: "could not run", exit: 1, output: "SyntaxError: Unexpected token" }, 4: { status: "could not run", exit: 124, output: "" } });
  assert.deepEqual(readRepro(""), {}); assert.equal(MAX_REPROS, 8);
});
