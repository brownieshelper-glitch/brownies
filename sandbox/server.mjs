// The sandbox: a stranger's code run in a box, for the code reviews the shop sells. One small HTTP server on the
// stream server (port 8799, a bearer token, only the helpers' droplet may reach it). A job brings its code (a
// public git URL cloned on the host, or a small tarball), an optional install step that runs WITH network
// (npm ci --ignore-scripts, pip install, forge install) and the command itself, which runs with NO network at
// all. Every run is a fresh Docker container: one CPU, a slice of memory, a pid limit, no capabilities, a
// read-only root, a job folder that is wiped after. One job at a time, a short queue, hard timeouts. Nothing
// here knows any secret but its own token. Node 18 is enough: no modern-only module is used.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";

const PORT = Number(process.env.PORT || 8799);
const TOKEN = String(process.env.SANDBOX_TOKEN || "");
if (!TOKEN) { console.error("SANDBOX_TOKEN is empty: refusing to start"); process.exit(1); }
const JOBS = process.env.JOBS_DIR || "/var/lib/sandbox/jobs";
const IMAGES = { node: "node:22-bookworm-slim", python: "python:3.12-slim", foundry: "ghcr.io/foundry-rs/foundry:latest" };
const CPUS = process.env.CPUS || "1", MEMORY = process.env.MEMORY || "1500m";
const RUNTIME = String(process.env.RUNTIME || ""); // "runsc" = gVisor, a second kernel under every container; empty = Docker's own
const MAX_SECONDS = 600, MAX_INSTALL_SECONDS = 300, MAX_OUT = 200_000, MAX_CLONE_MB = 300, MAX_TAR_BYTES = 8 * 1024 * 1024, MAX_COLLECT = 5, MAX_COLLECT_BYTES = 1_000_000, QUEUE_MAX = 4;
let running = 0, queued = 0, done = 0;
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
const clip = (s) => (s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n[cut after ${MAX_OUT} characters]` : s);

/// Runs a program, captures its output, kills it after `seconds`. { exit, stdout, stderr, timedOut, seconds }.
function exec(cmd, args, { seconds = 60, cwd } = {}) {
  return new Promise((res) => {
    const started = Date.now();
    let out = "", err = "", timedOut = false;
    const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const t = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, seconds * 1000);
    p.stdout.on("data", (d) => { if (out.length < MAX_OUT * 2) out += d; });
    p.stderr.on("data", (d) => { if (err.length < MAX_OUT * 2) err += d; });
    p.on("close", (code) => { clearTimeout(t); res({ exit: code, stdout: clip(out), stderr: clip(err), timedOut, seconds: Math.round((Date.now() - started) / 10) / 100 }); });
    p.on("error", (e) => { clearTimeout(t); res({ exit: null, stdout: out, stderr: `${err}\n${e.message}`, timedOut, seconds: 0 }); });
  });
}

/// One container run over the job folder. network: "none" for the command, "bridge" for the install step only.
async function box(id, dir, image, command, { network = "none", seconds = 60 } = {}) {
  const name = `sb-${id}-${network === "none" ? "run" : "install"}`;
  const args = ["run", "--rm", "--name", name, ...(RUNTIME ? ["--runtime", RUNTIME] : []), "--network", network, "--cpus", CPUS, "--memory", MEMORY, "--memory-swap", MEMORY, "--pids-limit", "512", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--read-only", "--tmpfs", "/tmp:rw,exec,size=512m", "-e", "HOME=/work/__home", "-e", "CI=1", "-e", "npm_config_update_notifier=false",
    "-v", `${dir}:/work`, "-w", "/work", "-u", "1000:1000", image, "sh", "-lc", command];
  const r = await exec("docker", args, { seconds });
  if (r.timedOut) await exec("docker", ["rm", "-f", name], { seconds: 20 });
  return r;
}

/// The code into the job folder: a public https git URL (shallow, size-capped) or a base64 gzip tarball.
async function fetchCode(dir, { git, tar }) {
  if (git?.url) {
    if (!/^https:\/\/[\w.-]+\/[\w./-]+$/.test(String(git.url))) throw new Error("the git url must be https and plain");
    const args = ["clone", "--depth", "1", "--no-tags", "--single-branch", "--recurse-submodules", "--shallow-submodules"];
    if (git.ref && /^[\w./-]{1,100}$/.test(String(git.ref))) args.push("--branch", String(git.ref));
    args.push(String(git.url), dir);
    const r = await exec("git", args, { seconds: 90 });
    if (r.exit !== 0) throw new Error(`git clone failed: ${(r.stderr || r.stdout).trim().split("\n").pop() || "no detail"}`);
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    await exec("sh", ["-c", `find "${dir}" -name .git -prune -exec rm -rf {} + 2>/dev/null; true`], { seconds: 30 }); // the submodules' own .git too
  } else if (tar) {
    const buf = Buffer.from(String(tar), "base64");
    if (!buf.length || buf.length > MAX_TAR_BYTES) throw new Error(`the tarball must be 1 byte to ${MAX_TAR_BYTES} bytes`);
    const file = join(dir, "..", `${randomBytes(4).toString("hex")}.tgz`);
    writeFileSync(file, buf);
    const r = await exec("tar", ["--no-same-owner", "--no-same-permissions", "-xzf", file, "-C", dir], { seconds: 60 });
    rmSync(file, { force: true });
    if (r.exit !== 0) throw new Error(`the tarball did not unpack: ${r.stderr.trim().split("\n").pop() || "no detail"}`);
  } else throw new Error("send git { url, ref } or tar (base64 gzip)");
  const du = await exec("du", ["-sm", dir], { seconds: 30 });
  const mb = Number((du.stdout || "0").split(/\s/)[0]) || 0;
  if (mb > MAX_CLONE_MB) throw new Error(`the code is ${mb} MB; the limit is ${MAX_CLONE_MB}`);
  mkdirSync(join(dir, "__home"), { recursive: true }); // the home of the box: the npm, pip and solc caches live across the install and the run
  await exec("chown", ["-R", "1000:1000", dir], { seconds: 60 });
  return mb;
}

/// A whole job: the code, the install step with network, the command without, the files asked for.
async function runJob(body) {
  const id = randomBytes(6).toString("hex");
  const image = IMAGES[String(body.image || "node")];
  if (!image) throw new Error(`image must be one of ${Object.keys(IMAGES).join(", ")}`);
  const command = String(body.command || "").trim();
  if (!command || command.length > 2000) throw new Error("command: 1 to 2000 characters");
  const install = body.install ? String(body.install).trim().slice(0, 2000) : "";
  const seconds = Math.min(MAX_SECONDS, Math.max(5, Number(body.timeoutSeconds) || 300));
  const installSeconds = Math.min(MAX_INSTALL_SECONDS, Math.max(5, Number(body.installTimeoutSeconds) || 180));
  const collect = (Array.isArray(body.collect) ? body.collect : []).map(String).filter((p) => /^[\w./-]{1,200}$/.test(p) && !p.includes("..")).slice(0, MAX_COLLECT);
  const dir = join(JOBS, id);
  mkdirSync(dir, { recursive: true });
  const started = Date.now();
  try {
    const mb = await fetchCode(dir, body);
    // extra files laid over the code after the clone (a reproduction script, a test): a few, small, inside the folder
    if (body.files && typeof body.files === "object") {
      let total = 0;
      for (const [p, c] of Object.entries(body.files).slice(0, 32)) {
        if (!/^[\w./-]{1,200}$/.test(p) || p.includes("..")) continue;
        const text = String(c ?? ""); total += text.length; if (total > 200_000) break;
        const f = resolve(dir, p);
        if (!f.startsWith(dir + "/")) continue;
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, text);
      }
      await exec("chown", ["-R", "1000:1000", dir], { seconds: 60 });
    }
    let inst = null;
    if (install) inst = await box(id, dir, image, install, { network: "bridge", seconds: installSeconds });
    const run = await box(id, dir, image, command, { network: "none", seconds });
    const files = {};
    for (const p of collect) {
      const f = resolve(dir, p);
      if (!f.startsWith(dir + "/") || !existsSync(f)) continue;
      const st = statSync(f);
      if (st.isFile() && st.size <= MAX_COLLECT_BYTES) files[p] = readFileSync(f, "utf8");
    }
    const out = { ok: true, id, image, mb, install: inst ? { exit: inst.exit, timedOut: inst.timedOut, seconds: inst.seconds, stdout: inst.stdout, stderr: inst.stderr } : null, exit: run.exit, timedOut: run.timedOut, seconds: run.seconds, stdout: run.stdout, stderr: run.stderr, files, totalSeconds: Math.round((Date.now() - started) / 1000) };
    log(`job ${id}: ${image} ${mb} MB, install ${inst ? inst.exit : "none"}, run exit ${run.exit}${run.timedOut ? " (timed out)" : ""} in ${out.totalSeconds} s`);
    return out;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/// One at a time; a short queue; the rest refused.
let chain = Promise.resolve();
function enqueue(body) {
  if (queued >= QUEUE_MAX) return Promise.reject(Object.assign(new Error("the sandbox is busy; try again in a few minutes"), { status: 429 }));
  queued++;
  const p = chain.then(async () => { queued--; running++; try { return await runJob(body); } finally { running--; done++; } });
  chain = p.catch(() => {});
  return p;
}

const server = http.createServer(async (req, res) => {
  const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  try {
    if ((req.headers.authorization || "") !== `Bearer ${TOKEN}`) return json(401, { error: "no" });
    if (req.method === "GET" && req.url === "/health") return json(200, { ok: true, running, queued, done, images: Object.keys(IMAGES), cpus: CPUS, memory: MEMORY });
    if (req.method === "POST" && req.url === "/run") {
      let s = "";
      await new Promise((ok, no) => { req.on("data", (d) => { s += d; if (s.length > MAX_TAR_BYTES * 1.4 + 10_000) { no(new Error("too large")); req.destroy(); } }); req.on("end", ok); req.on("error", no); });
      let body; try { body = JSON.parse(s || "{}"); } catch { return json(400, { error: "the body must be JSON" }); }
      try { return json(200, await enqueue(body)); } catch (e) { return json(e.status || 400, { error: e.message }); }
    }
    return json(404, { error: "GET /health or POST /run" });
  } catch (e) { log(`request failed: ${e.message}`); return json(500, { error: "the sandbox stumbled" }); }
});
server.listen(PORT, "0.0.0.0", () => log(`sandbox on :${PORT}, runtime ${RUNTIME || "docker's own"}, images ${Object.values(IMAGES).join(", ")}, ${CPUS} cpu, ${MEMORY}`));
