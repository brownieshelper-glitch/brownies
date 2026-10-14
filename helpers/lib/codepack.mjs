// The code review's plumbing, the part that is not secret: how a request names a repository, the shell that
// packs a repository's source into one file inside the sandbox (sandbox/server.mjs), how the toolchain is told
// from the file list (the image, the install step with network, the test command without), and the limits.
// Biscotti (a hidden brownie) runs the panel over the packed code; this module only prepares and reads.

export const MAX_LINES = 5000; // the review covers up to this many lines of source; more is refused before money moves
export const MAX_FILES = 400;

/// "https://github.com/a/b main: look at the payment flow" -> { url, ref, notes }. null when there is no https git url.
/// "only src/payments/" (or "folder", "path", "dir" before a path with a slash), or a github /tree/<ref>/<path> link,
/// adds focus: the one folder to review; the rest of the repository is still there for the tests to run.
export function parseCodeRequest(text) {
  const t = String(text || "").trim();
  const m = /https:\/\/[\w.-]+\/[\w./-]+?(?:\.git)?(?=[\s)>,;]|$)/.exec(t);
  if (!m) return null;
  let url = m[0].replace(/\.git$/, "").replace(/\/+$/, "");
  let ref = null;
  // github.com/a/b/tree/<ref>/... names the branch inside the url
  const tree = /^(https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+)\/tree\/([\w./-]+)$/.exec(url);
  let focus = null;
  if (tree) { const parts = tree[2].split("/"); url = tree[1]; ref = parts[0]; if (parts.length > 1) focus = parts.slice(1).join("/"); }
  const rest = (t.slice(0, m.index) + " " + t.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
  let notes = rest;
  // "branch develop" anywhere, else a leading word that looks like a branch: main, develop, v2, a commit hash
  const named = /\b(?:branch|ref|tag|commit)\s+([\w./-]{1,80}?)(?=[\s,.;:]|$)/i.exec(rest);
  const lead = /^@?([\w.-]{1,80})(?=\s*[:,.]|\s|$)/.exec(rest);
  if (!ref && named) { ref = named[1]; notes = rest.slice(0, named.index) + rest.slice(named.index + named[0].length); }
  else if (!ref && lead && /^(main|master|dev|develop|staging|release|v\d|[a-f0-9]{7,40}$)/i.test(lead[1])) { ref = lead[1]; notes = rest.slice(lead[0].length); }
  const only = /\b(?:only|folder|path|dir|directory)\s+\.?\/?([\w.-]+\/[\w./-]*?)\/?(?=[\s,;:]|\.?$)/i.exec(notes);
  if (only && !only[1].includes("..")) { focus = only[1].replace(/\/+$/, ""); notes = notes.slice(0, only.index) + notes.slice(only.index + only[0].length); }
  if (focus) focus = focus.replace(/^\.\/+/, "");
  if (focus && (focus.includes("..") || !/^[\w.-][\w./-]{0,160}$/.test(focus))) focus = null;
  notes = notes.replace(/\s+([,.;:])/g, "$1").replace(/([,.;:])[,.;:\s]*(?=[,.;:])/g, "$1").replace(/^[\s,.;:]+/, "").replace(/\s+/g, " ").trim();
  return focus ? { url, ref, notes: notes.slice(0, 500), focus } : { url, ref, notes: notes.slice(0, 500) };
}

const SOURCE = ["*.js", "*.mjs", "*.cjs", "*.ts", "*.tsx", "*.jsx", "*.py", "*.sol", "*.vy", "*.go", "*.rs", "*.java", "*.kt", "*.rb", "*.php", "*.sh", "*.sql", "*.move", "README.md", "package.json", "foundry.toml", "pyproject.toml", "requirements.txt", "hardhat.config.*", "Cargo.toml", "go.mod"];
const PRUNE = ["./node_modules", "./*/node_modules", "./.git", "./dist", "./build", "./out", "./target", "./vendor", "./.next", "./coverage", "./__review", "./__home", "./lib/forge-std", "./lib/openzeppelin-contracts"];
const names = (list) => list.map((n) => `-name '${n}'`).join(" -o ");

/// The shell that packs the source: the file list, the lines, the tree, one file with every source file in it.
/// Runs inside the box, with no network, over /work. Writes under __review/.
export const packCommand = (focus = null) => [
  "mkdir -p __review",
  `find ${focus ? `'./${String(focus).replace(/^\.?\/+|\/+$/g, "")}'` : "."} \\( ${PRUNE.map((p) => `-path '${p}'`).join(" -o ")} -o -name '__pycache__' \\) -prune -o -type f -size -200k \\( ${names(SOURCE)} \\) ! -name '*.min.js' ! -name '*.lock' ! -name '*-lock.json' -print | sort | head -${MAX_FILES} > __review/files.txt`,
  "tr '\\n' '\\0' < __review/files.txt | xargs -0 cat 2>/dev/null | wc -l | tr -d ' ' > __review/lines.txt",
  "find . \\( -path ./node_modules -o -path ./.git -o -path ./__review -o -path ./__home \\) -prune -o -print | sort | head -300 > __review/tree.txt",
  ": > __review/code.txt; while IFS= read -r f; do printf '\\n===== %s\\n' \"$f\" >> __review/code.txt; cat \"$f\" >> __review/code.txt; done < __review/files.txt",
  "ls -1A . > __review/top.txt",
].join(" && ");
export const PACK_COMMAND = packCommand();

/// The project's own tests, run after the pack: the output and the exit code end up in __review/tests.txt.
export const testCommand = (test) => (test ? `(${test}) > __review/tests.txt 2>&1; echo "exit:$?" >> __review/tests.txt; true` : "echo 'no test command for this project' > __review/tests.txt");

/// The image, the install step (with network) and the test command (without), from the file list.
export function toolchain(files, { packageJson = null, topList = null } = {}) {
  const has = (n) => files.some((f) => f === `./${n}` || f.endsWith(`/${n}`) && !f.includes("/node_modules/"));
  const top = (n) => (topList?.length ? topList.includes(n) : files.includes(`./${n}`));
  if (top("foundry.toml")) return { image: "foundry", install: "forge build", test: "forge test -vv --no-match-path 'lib/*'", kind: "foundry" };
  if (top("package.json")) {
    let script = null;
    try { script = packageJson ? JSON.parse(packageJson).scripts?.test || null : null; } catch { script = null; }
    const hasTest = script && !/no test specified/i.test(script);
    return { image: "node", install: "npm ci --ignore-scripts --no-audit --no-fund 2>/dev/null || npm install --ignore-scripts --no-audit --no-fund", test: hasTest ? "npm test --silent" : null, kind: "node", testScript: script };
  }
  if (top("pyproject.toml") || top("requirements.txt")) {
    const req = top("requirements.txt") ? "pip install --user -q -r requirements.txt; " : "";
    const proj = top("pyproject.toml") ? "pip install --user -q -e . 2>/dev/null; " : "";
    const hasTests = files.some((f) => /(^|\/)(tests?|test_[^/]+\.py|[^/]+_test\.py)/.test(f));
    return { image: "python", install: `${req}${proj}pip install --user -q pytest`, test: hasTests ? "python -m pytest -q -x --maxfail=20" : null, kind: "python" };
  }
  if (top("Cargo.toml")) return { image: "node", install: "", test: null, kind: "rust", note: "no Rust toolchain in the box yet: the tests were not run" };
  if (top("go.mod")) return { image: "node", install: "", test: null, kind: "go", note: "no Go toolchain in the box yet: the tests were not run" };
  if (has("hardhat.config.js") || has("hardhat.config.ts")) return { image: "node", install: "npm ci --ignore-scripts --no-audit --no-fund 2>/dev/null || npm install --ignore-scripts --no-audit --no-fund", test: "npx hardhat test", kind: "hardhat" };
  return { image: "node", install: "", test: null, kind: "unknown", note: "no package.json, foundry.toml or pyproject.toml at the top: the tests were not run" };
}

/// The reproductions: one script per finding, written by a model, run one after the other in the box after the
/// install; each prints BUG REPRODUCED or NOT REPRODUCED, anything else is a script that could not run.
export const MAX_REPROS = 8;
export const REPRO = {
  node: { file: (id) => `__review/repro-${id}.mjs`, run: (id) => `node __review/repro-${id}.mjs`, how: "an ES module (.mjs) run with node from the repository's root; import the code with relative paths from that root (for example import { f } from '../src/f.js'); when the package is CommonJS use createRequire; no test framework, plain asserts" },
  python: { file: (id) => `__review/repro_${id}.py`, run: (id) => `python __review/repro_${id}.py`, how: "a Python script run with python from the repository's root; import the code as the project does (sys.path.insert(0, '.') first); plain asserts, no pytest" },
  foundry: { file: (id) => `test/__Repro${id}.t.sol`, run: (id) => `forge test --match-path 'test/__Repro${id}.t.sol' -vv`, how: "a Foundry test contract (forge-std's Test) in test/, one test function; console.log the marker lines; the test must PASS when the bug is there" },
  hardhat: null, rust: null, go: null, unknown: null,
};
export const reproCommand = (chain, ids) => {
  const R = REPRO[chain.kind];
  if (!R || !ids.length) return "echo 'no reproductions' > __review/repro.txt";
  return [": > __review/repro.txt", ...ids.map((id) => `printf '##### repro %s\\n' ${id} >> __review/repro.txt; (timeout 120 ${R.run(id)}) >> __review/repro.txt 2>&1; echo "exit:$?" >> __review/repro.txt`)].join("; ") + "; true";
};
/// __review/repro.txt read back: { [id]: { status: "confirmed" | "not reproduced" | "could not run", exit, output } }.
export function readRepro(text) {
  const out = {};
  for (const m of String(text || "").matchAll(/##### repro (\d+)\n([\s\S]*?)exit:(\d+)\n?/g)) {
    const id = Number(m[1]), output = m[2].trim(), exit = Number(m[3]);
    const status = /BUG REPRODUCED/.test(output) ? "confirmed" : /NOT REPRODUCED/.test(output) ? "not reproduced" : "could not run";
    out[id] = { status, exit, output: output.slice(0, 1500) };
  }
  return out;
}

/// One file's whole text out of the packed code ("===== path" sections), with the path as the repository has it (no
/// leading "./"). null when the file is not in the pack.
export function wholeFile(code, file) {
  const want = String(file || "").replace(/^\.\//, "");
  if (!want) return null;
  const re = /^===== (.+)$/gm; let m; const sections = [];
  while ((m = re.exec(code))) sections.push({ name: m[1].replace(/^\.\//, ""), at: m.index + m[0].length + 1, head: m.index });
  for (let i = 0; i < sections.length; i++) {
    const x = sections[i];
    if (x.name === want || x.name.endsWith("/" + want) || want.endsWith("/" + x.name)) return { path: x.name, text: code.slice(x.at, i + 1 < sections.length ? sections[i + 1].head - 1 : code.length) };
  }
  return null;
}

/// The fix of one finding, tried in the box: the fixed files wait under __review/fix-<id>/, are compared with the
/// originals (that is the patch), are put in place, then the project's own tests and the reproduction script run again.
export const fixCommand = (chain, id, paths) => {
  const R = REPRO[chain.kind];
  if (!R) return "echo 'no way to try a fix for this project' > __review/fix-repro.txt";
  const q = (p) => `'${p}'`;
  const test = chain.kind === "foundry" ? "forge test -vv --no-match-path 'test/__Repro*'" : chain.test;
  return [
    `: > __review/fix-${id}.patch`,
    ...paths.map((p) => `(diff -uN ${q(p)} ${q(`__review/fix-${id}/${p}`)} >> __review/fix-${id}.patch; true)`),
    ...paths.map((p) => `mkdir -p "$(dirname ${q(p)})"; cp ${q(`__review/fix-${id}/${p}`)} ${q(p)}`),
    test ? `(${test}) > __review/fix-tests.txt 2>&1; echo "exit:$?" >> __review/fix-tests.txt` : "echo 'no test command for this project' > __review/fix-tests.txt",
    `(timeout 120 ${R.run(id)}) > __review/fix-repro.txt 2>&1; echo "exit:$?" >> __review/fix-repro.txt`,
  ].join("; ") + "; true";
};
/// What the box said of a fix: "proven" (the project's tests ended as well as before it and the script no longer shows
/// the bug), "bug still shows", "tests broke", "could not run". baselineExit: how the tests ended before any fix.
export function readFix(files = {}, id, baselineExit = 0) {
  const tests = String(files["__review/fix-tests.txt"] || ""), repro = String(files["__review/fix-repro.txt"] || "");
  const t = /exit:(\d+)\s*$/.exec(tests);
  const testsExit = t ? Number(t[1]) : null, noTests = /^no test command/.test(tests.trim());
  const out = repro.replace(/\s*exit:\d+\s*$/, "").trim();
  const testsOk = noTests || (testsExit != null && (testsExit === 0 || testsExit === baselineExit));
  const status = /BUG REPRODUCED/.test(out) ? "bug still shows" : !/NOT REPRODUCED/.test(out) ? "could not run" : !testsOk ? "tests broke" : "proven";
  return { status, testsExit, noTests, patch: String(files[`__review/fix-${id}.patch`] || ""), repro: out.slice(0, 800), tests: tests.slice(-1500) };
}

/// What the sandbox brought back, read: the files, the line count, the test output, the code.
export function readPack(files = {}) {
  const list = String(files["__review/files.txt"] || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const lines = Number(String(files["__review/lines.txt"] || "0").trim()) || 0;
  const tests = String(files["__review/tests.txt"] || "");
  const exit = /exit:(\d+)\s*$/.exec(tests);
  return { files: list, lines, top: String(files["__review/top.txt"] || "").split("\n").map((x) => x.trim()).filter(Boolean), tree: String(files["__review/tree.txt"] || ""), code: String(files["__review/code.txt"] || ""), tests: tests.replace(/\s*exit:\d+\s*$/, ""), testsExit: exit ? Number(exit[1]) : null };
}

/// The test output in a few words for the page: passed, failed, not run.
export function testsLine(pack, chain) {
  if (!chain.test) return chain.note || "No test command was found, so the project's tests were not run.";
  if (pack.testsExit === 0) return "The project's own tests passed in the box.";
  if (pack.testsExit == null) return "The project's own tests did not finish in the box.";
  return `The project's own tests FAILED in the box (exit ${pack.testsExit}).`;
}
