// The sandbox, from the helpers' side (the server is sandbox/server.mjs on the stream server): a job in, the
// output out. A job carries the code (a public git URL, or a small gzip tarball as base64), an install step that
// runs with network, the command that runs without, and the files to bring back. Nothing is run here; a
// sandbox that is not set up (SANDBOX_URL, SANDBOX_TOKEN empty) makes `configured` false and run() throw.
export class Sandbox {
  constructor({ url = "", token = "", fetch = globalThis.fetch, log = () => {} } = {}) {
    this.url = String(url || "").replace(/\/$/, "");
    this.token = String(token || "");
    this.fetch = fetch;
    this.log = log;
  }
  get configured() { return Boolean(this.url && this.token); }

  async health() {
    if (!this.configured) throw new Error("the sandbox is not set up (SANDBOX_URL, SANDBOX_TOKEN)");
    const r = await this.fetch(`${this.url}/health`, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`the sandbox answered ${r.status}`);
    return r.json();
  }

  /// { ok, id, image, mb, install: { exit, timedOut, stdout, stderr } | null, exit, timedOut, seconds, stdout, stderr, files, totalSeconds }.
  /// Throws with the sandbox's own words when it refuses the job (a bad url, too big, busy).
  /// files: { "path": "content" } laid over the code after the clone (a reproduction script), a few and small.
  async run({ image = "node", git = null, tar = null, install = "", command, timeoutSeconds = 300, installTimeoutSeconds = 180, collect = [], files = null } = {}) {
    if (!this.configured) throw new Error("the sandbox is not set up (SANDBOX_URL, SANDBOX_TOKEN)");
    if (!command) throw new Error("a command is needed");
    const body = { image, command, timeoutSeconds, installTimeoutSeconds, collect };
    if (git) body.git = git; else if (tar) body.tar = Buffer.isBuffer(tar) ? tar.toString("base64") : String(tar);
    if (install) body.install = install;
    if (files && Object.keys(files).length) body.files = files;
    const wait = (timeoutSeconds + (install ? installTimeoutSeconds : 0) + 240) * 1000; // the clone, the queue, the pulls
    const r = await this.fetch(`${this.url}/run`, { method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(wait) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.ok) throw new Error(`the sandbox refused the job: ${j?.error || `status ${r.status}`}`);
    this.log(`[sandbox] job ${j.id}: ${j.image}, exit ${j.exit}${j.timedOut ? " (timed out)" : ""}, ${j.totalSeconds} s`);
    return j;
  }
}
