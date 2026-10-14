// The code review's plumbing: a request names a repository (with its branch and notes), the pack command is
// one shell line the box can run, the toolchain is told from the file list, the pack is read back.
import test from "node:test";
import assert from "node:assert/strict";
import { parseCodeRequest, PACK_COMMAND, packCommand, testCommand, toolchain, readPack, testsLine, MAX_LINES, REPRO, MAX_REPROS, reproCommand, readRepro, fixCommand, readFix, wholeFile } from "../lib/codepack.mjs";

test("a request: the url, the branch, the notes; tree urls; no url is null", () => {
  assert.deepEqual(parseCodeRequest("https://github.com/a/b"), { url: "https://github.com/a/b", ref: null, notes: "" });
  assert.deepEqual(parseCodeRequest("https://github.com/a/b.git main: look at the payment flow"), { url: "https://github.com/a/b", ref: "main", notes: "look at the payment flow" });
  const r = parseCodeRequest("Please review https://gitlab.com/x/y/z, branch develop. The auth part.");
  assert.equal(r.url, "https://gitlab.com/x/y/z"); assert.equal(r.ref, "develop"); assert.match(r.notes, /^Please review.*The auth part\.$/);
  assert.equal(parseCodeRequest("https://github.com/a/b on commit 0a1b2c3d4e").ref, "0a1b2c3d4e");
  assert.deepEqual(parseCodeRequest("https://github.com/a/b/tree/feature-x/src is the folder"), { url: "https://github.com/a/b", ref: "feature-x", notes: "is the folder", focus: "src" });
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

test("one folder to review: named in words or in a tree link, never outside the repository; the pack starts there and the toolchain is still told from the top", () => {
  assert.deepEqual(parseCodeRequest("https://github.com/a/b only src/payments/ and check the refunds"), { url: "https://github.com/a/b", ref: null, notes: "and check the refunds", focus: "src/payments" });
  assert.deepEqual(parseCodeRequest("https://github.com/a/b main folder lib/"), { url: "https://github.com/a/b", ref: "main", notes: "", focus: "lib" });
  assert.equal(parseCodeRequest("https://github.com/a/b/tree/main/packages/core").focus, "packages/core");
  assert.equal(parseCodeRequest("https://github.com/a/b only look at the payment flow").focus, undefined, "a word with no slash is not a folder");
  assert.equal(parseCodeRequest("https://github.com/a/b review the folder structure").focus, undefined);
  assert.ok(!String(parseCodeRequest("https://github.com/a/b only ../etc/").focus || "").includes(".."), "no way out of the repository");
  assert.equal(PACK_COMMAND, packCommand()); assert.ok(PACK_COMMAND.includes("&& find . \\( -path")); assert.ok(packCommand("src/payments").includes("&& find './src/payments' \\( -path")); assert.ok(packCommand("./lib/").includes("&& find './lib' \\( -path")); assert.ok(PACK_COMMAND.endsWith("&& ls -1A . > __review/top.txt"));
  const pack = readPack({ "__review/files.txt": "./lib/a.mjs\n./lib/b.mjs\n", "__review/lines.txt": "120", "__review/top.txt": "lib\npackage.json\ntest\n" });
  assert.deepEqual(pack.top, ["lib", "package.json", "test"]);
  assert.equal(toolchain(pack.files, { packageJson: '{"scripts":{"test":"node --test"}}', topList: pack.top }).kind, "node", "the folder has no package.json of its own, the top has");
  assert.equal(toolchain(pack.files, {}).kind, "unknown");
});

test("a fix tried in the box: the patch against the original, the file put in place, the tests and the script again; a whole file out of the pack", () => {
  const cmd = fixCommand({ kind: "node", test: "npm test --silent" }, 3, ["lib/b.js"]);
  assert.equal(cmd, `: > __review/fix-3.patch; (diff -uN 'lib/b.js' '__review/fix-3/lib/b.js' >> __review/fix-3.patch; true); mkdir -p "$(dirname 'lib/b.js')"; cp '__review/fix-3/lib/b.js' 'lib/b.js'; (npm test --silent) > __review/fix-tests.txt 2>&1; echo "exit:$?" >> __review/fix-tests.txt; (timeout 120 node __review/repro-3.mjs) > __review/fix-repro.txt 2>&1; echo "exit:$?" >> __review/fix-repro.txt; true`);
  assert.match(fixCommand({ kind: "foundry", test: "forge test -vv --no-match-path 'lib/*'" }, 2, ["src/A.sol"]), /\(forge test -vv --no-match-path 'test\/__Repro\*'\) > __review\/fix-tests\.txt/, "the project's tests without the reproduction, which passes only while the bug is there");
  assert.match(fixCommand({ kind: "node", test: null }, 1, ["a.js"]), /echo 'no test command for this project' > __review\/fix-tests\.txt/);
  assert.match(fixCommand({ kind: "rust" }, 1, ["a.rs"]), /^echo 'no way to try a fix/);
  const files = (tests, repro) => ({ "__review/fix-tests.txt": tests, "__review/fix-repro.txt": repro, "__review/fix-3.patch": "--- lib/b.js\n+++ __review/fix-3/lib/b.js\n@@ -1 +1 @@\n-a\n+b\n" });
  const ok = readFix(files("ok\nexit:0\n", "NOT REPRODUCED: the total is right\nexit:2\n"), 3, 0);
  assert.equal(ok.status, "proven"); assert.equal(ok.testsExit, 0); assert.match(ok.patch, /^--- lib\/b\.js/); assert.equal(ok.repro, "NOT REPRODUCED: the total is right");
  assert.equal(readFix(files("ok\nexit:0\n", "BUG REPRODUCED: still 3\nexit:0\n"), 3, 0).status, "bug still shows");
  assert.equal(readFix(files("1 failing\nexit:1\n", "NOT REPRODUCED: fine\nexit:2\n"), 3, 0).status, "tests broke");
  assert.equal(readFix(files("1 failing\nexit:1\n", "NOT REPRODUCED: fine\nexit:2\n"), 3, 1).status, "proven", "tests that already failed before the fix and end the same way");
  assert.equal(readFix(files("ok\nexit:0\n", "SyntaxError: bad\nexit:1\n"), 3, 0).status, "could not run");
  assert.equal(readFix(files("no test command for this project\n", "NOT REPRODUCED: fine\nexit:2\n"), 3, 0).status, "proven");
  assert.equal(readFix({}, 3, 0).status, "could not run");
  const code = "\n===== ./a.js\nconst a = 1;\n\n===== ./lib/b.js\nexport const b = 2;\n";
  assert.deepEqual(wholeFile(code, "a.js"), { path: "a.js", text: "const a = 1;\n" }); assert.deepEqual(wholeFile(code, "./lib/b.js"), { path: "lib/b.js", text: "export const b = 2;\n" }); assert.deepEqual(wholeFile(code, "b.js"), { path: "lib/b.js", text: "export const b = 2;\n" }); assert.equal(wholeFile(code, "c.js"), null); assert.equal(wholeFile(code, ""), null);
});
