// Programmable's CLI (@programmable/launch 4.1.5, verified release tarball, installed outside OneDrive), driven from here.
//
//   pack      offline: launch.json + receipt from programmable-launch.config.json (reads the public /v3/capabilities
//             once to pick the live profile 3.6.0 and its treasury policy)
//   validate  offline recomputation; with --remote also the authenticated preflight (needs the API key)
//   submit    the real request (needs the API key); status polls it
//
// The API key is read from %USERPROFILE%\brownies-secrets\programmable.env (PROGRAMMABLE_API_KEY=...) and handed to the
// CLI process environment only; it is never printed, logged or written anywhere else.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CLI_DIR = process.env.PROGRAMMABLE_CLI || (process.env.USERPROFILE || process.env.HOME || "") + "\\programmable-launch\\4.1.5\\package";
export const CLI_VERSION = "4.1.5";
export const KEY_FILE = process.env.PROGRAMMABLE_KEY_FILE || (process.env.USERPROFILE || process.env.HOME || "") + "\\brownies-secrets\\programmable.env";

export function cliReady() {
  const bin = path.join(CLI_DIR, "bin", "programmable-launch.mjs");
  if (!fs.existsSync(bin)) throw new Error(`Programmable CLI not found at ${CLI_DIR} (install the verified 4.1.5 tarball there or set PROGRAMMABLE_CLI)`);
  const pkg = JSON.parse(fs.readFileSync(path.join(CLI_DIR, "package.json"), "utf8"));
  if (pkg.version !== CLI_VERSION) throw new Error(`Programmable CLI at ${CLI_DIR} is ${pkg.version}, expected ${CLI_VERSION}`);
  return bin;
}

/// The API key, from the secrets file; `{ set: false }` when the file or the line is missing. The value never leaves this process except into the CLI's environment.
export function apiKey() {
  try {
    const text = fs.readFileSync(KEY_FILE, "utf8");
    const m = text.match(/^\s*PROGRAMMABLE_API_KEY\s*=\s*(.+?)\s*$/m);
    if (!m || !m[1]) return { set: false, file: KEY_FILE };
    const v = m[1].replace(/^["']|["']$/g, "");
    return { set: true, file: KEY_FILE, length: v.length, value: v };
  } catch (_) { return { set: false, file: KEY_FILE }; }
}

/// Runs one CLI command. Returns { ok, status, json, stdout, stderr }; `json` is the CLI's JSON result when it printed one.
export function runCli(args, { cwd, withKey = false, log = null } = {}) {
  const bin = cliReady();
  const env = { ...process.env };
  delete env.PROGRAMMABLE_API_KEY;
  if (withKey) {
    const k = apiKey();
    if (!k.set) throw new Error(`no API key: put PROGRAMMABLE_API_KEY=... in ${k.file} (created at programmable.market/developers/api-keys with the launch wallet connected)`);
    env.PROGRAMMABLE_API_KEY = k.value;
  }
  const shim = pathToFileURL(path.join(HERE, "win-fsync-shim.mjs")).href;
  if (log) log(`cli              programmable-launch ${args.join(" ")}${withKey ? "   (with the API key)" : ""}`);
  const r = spawnSync(process.execPath, ["--import", shim, bin, ...args], { cwd, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const stdout = r.stdout || "", stderr = r.stderr || "";
  let json = null;
  const start = stdout.indexOf("{");
  if (start >= 0) { try { json = JSON.parse(stdout.slice(start)); } catch (_) { json = null; } }
  return { ok: r.status === 0, status: r.status, json, stdout, stderr: stderr.trim(), error: r.error ? String(r.error) : null };
}

export function packLaunch({ workdir, log = null }) {
  const r = runCli(["pack", "--config", "programmable-launch.config.json", "--output", "launch.json", "--receipt", "launch.receipt.json"], { cwd: workdir, log });
  if (!r.ok) throw new Error("pack failed: " + (r.stderr || r.stdout || r.error).slice(0, 2000));
  const launch = JSON.parse(fs.readFileSync(path.join(workdir, "launch.json"), "utf8"));
  const receipt = JSON.parse(fs.readFileSync(path.join(workdir, "launch.receipt.json"), "utf8"));
  return { result: r.json, launch, receipt };
}

/// pack, fill the token's domain separator with the predicted token address, pack again; the addresses must not move.
export async function packWithTokenDomain({ workdir, tokenName, log = null }) {
  const { setTokenDomainSeparator } = await import("./build.mjs");
  const first = packLaunch({ workdir, log });
  const addr = (r, id) => r.receipt.predictions.find((p) => p.targetId === id)?.predictedAddress;
  const token1 = addr(first, "token");
  if (!token1) throw new Error("the first pack predicted no token address");
  setTokenDomainSeparator(workdir, tokenName, token1);
  const second = packLaunch({ workdir, log });
  for (const id of ["launcher", "token", "hook"]) if (addr(first, id) !== addr(second, id)) throw new Error(`the ${id} address moved between the two packs (${addr(first, id)} -> ${addr(second, id)}); the work directory is not deterministic`);
  const rt = (r, id) => r.launch.graphBundle.targets.find((t) => t.targetId === id)?.expectedRuntimeCodeHash;
  if (rt(first, "token") === rt(second, "token")) throw new Error("the token's runtime hash did not change with its domain separator");
  if (rt(first, "hook") !== rt(second, "hook") || rt(first, "launcher") !== rt(second, "launcher")) throw new Error("a runtime hash other than the token's changed between the two packs");
  return second;
}

export function validateLaunch({ workdir, remote = false, log = null }) {
  const args = ["validate", "launch.json", "--config", "programmable-launch.config.json", ...(remote ? ["--remote"] : [])];
  const r = runCli(args, { cwd: workdir, withKey: remote, log });
  if (!r.ok) throw new Error(`validate${remote ? " --remote" : ""} failed: ` + (r.stderr || r.stdout || r.error).slice(0, 4000));
  return r.json;
}

export function submitLaunch({ workdir, idempotencyKey, log = null }) {
  const r = runCli(["submit", "launch.json", "--config", "programmable-launch.config.json", "--idempotency-key", idempotencyKey, "--state-dir", path.join(workdir, "cli-state")], { cwd: workdir, withKey: true, log });
  if (!r.ok) throw new Error("submit failed: " + (r.stderr || r.stdout || r.error).slice(0, 4000));
  return r.json;
}

export function statusLaunch({ workdir, requestId, until = null, watch = false, log = null }) {
  const args = ["status", requestId, ...(watch ? ["--watch"] : []), ...(until ? ["--until", until] : [])];
  const r = runCli(args, { cwd: workdir, withKey: true, log });
  if (!r.ok) throw new Error("status failed: " + (r.stderr || r.stdout || r.error).slice(0, 4000));
  return r.json;
}
