// GitHub REST API for one repository (GITHUB_REPO = owner/name). Nib saves its notes with it, Chip reads files,
// makes branches, opens, merges and closes pull requests and reads the issues labelled "chip".
import { CredentialsError } from "./xapi.mjs";

export const GITHUB_API = "https://api.github.com";

export class GitHub {
  constructor({ token, repo, fetch = globalThis.fetch, log = () => {} }) {
    if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("GITHUB_REPO must be owner/name");
    this.token = token; this.repo = repo; this.fetch = fetch; this.log = log; this.info = null;
  }
  get configured() { return Boolean(this.token && this.repo); }

  /// One call. Returns the parsed body; null for a 404 when `allow404`. Throws a plain sentence otherwise.
  async api(method, path, body = null, { allow404 = false } = {}) {
    const r = await this.fetch(`${GITHUB_API}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "brownies-helpers", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 204) return {};
    const j = await r.json().catch(() => ({}));
    if (r.status === 404 && allow404) return null;
    if (r.status === 401 || (r.status === 403 && /credentials|token/i.test(j.message || ""))) throw new CredentialsError("github", `GitHub refused the token (${r.status})`);
    if (!r.ok) throw new Error(`GitHub ${method} ${path} answered ${r.status}: ${j.message || "no detail"}`.slice(0, 240));
    return j;
  }
  R(path = "") { return `/repos/${this.repo}${path}`; }
  get owner() { return String(this.repo || "").split("/")[0]; }
  get name() { return String(this.repo || "").split("/")[1] || ""; }
  /// The same token and fetch, another repository (a bounty's upstream, our fork of it).
  forRepo(repo) { return new GitHub({ token: this.token, repo, fetch: this.fetch, log: this.log }); }
  /// Whether the repository answers (a fork that is not there yet does not).
  async exists() { return Boolean(await this.api("GET", this.R(), null, { allow404: true })); }
  /// Forks this repository under the token's account. GitHub makes the fork in the background: poll exists() on it.
  async fork() { const j = await this.api("POST", this.R("/forks"), {}); return { fullName: j.full_name, url: j.html_url }; }
  /// Brings a fork's branch level with its upstream. Ignored when GitHub refuses (an unrelated history, nothing to do).
  async mergeUpstream(branch) { return this.api("POST", this.R("/merge-upstream"), { branch }).catch(() => null); }
  /// One issue: title, body, labels, state, url.
  async issue(number) { const i = await this.api("GET", this.R(`/issues/${number}`)); return { number: i.number, title: i.title, body: i.body || "", state: i.state, url: i.html_url, labels: (i.labels || []).map((l) => (typeof l === "string" ? l : l.name)) }; }

  async defaultBranch() {
    if (!this.info) this.info = await this.api("GET", this.R());
    return this.info.default_branch || "main";
  }
  async branchSha(branch) { const j = await this.api("GET", this.R(`/git/ref/heads/${encodeURIComponent(branch)}`)); return j.object.sha; }
  async branchExists(branch) { return Boolean(await this.api("GET", this.R(`/git/ref/heads/${encodeURIComponent(branch)}`), null, { allow404: true })); }
  createBranch(name, fromSha) { return this.api("POST", this.R("/git/refs"), { ref: `refs/heads/${name}`, sha: fromSha }); }

  /// A text file: { content, sha } or null when it does not exist.
  async getFile(path, ref = null) {
    const j = await this.api("GET", this.R(`/contents/${path.split("/").map(encodeURIComponent).join("/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`), null, { allow404: true });
    if (!j || Array.isArray(j) || j.type !== "file") return null;
    return { content: Buffer.from(String(j.content || "").replace(/\n/g, ""), "base64").toString("utf8"), sha: j.sha, path: j.path };
  }

  /// Creates or updates one file in one commit. `sha` is the current blob sha when updating.
  putFile(path, content, message, { branch, sha = null } = {}) {
    const body = { message, content: Buffer.from(content, "utf8").toString("base64"), branch };
    if (sha) body.sha = sha;
    return this.api("PUT", this.R(`/contents/${path.split("/").map(encodeURIComponent).join("/")}`), body);
  }

  /// Every path in the tree at `ref`: [{ path, type, size }].
  async tree(ref) {
    const j = await this.api("GET", this.R(`/git/trees/${encodeURIComponent(ref)}?recursive=1`));
    return (j.tree || []).map((t) => ({ path: t.path, type: t.type, size: t.size || 0 }));
  }

  /// Open issues with a label. Pull requests are issues too on GitHub; they are left out here.
  async issues({ labels = "", state = "open" } = {}) {
    const j = await this.api("GET", this.R(`/issues?state=${state}&per_page=30${labels ? `&labels=${encodeURIComponent(labels)}` : ""}`));
    return (j || []).filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, body: i.body || "", url: i.html_url, labels: (i.labels || []).map((l) => l.name) }));
  }

  async createPR({ title, body, head, base }) {
    const j = await this.api("POST", this.R("/pulls"), { title, body, head, base });
    return { number: j.number, url: j.html_url };
  }
  pr(number) { return this.api("GET", this.R(`/pulls/${number}`)); }
  async mergePR(number, { title = null } = {}) {
    const j = await this.api("PUT", this.R(`/pulls/${number}/merge`), { merge_method: "squash", ...(title ? { commit_title: title } : {}) });
    return { merged: Boolean(j.merged), sha: j.sha || null };
  }
  closePR(number) { return this.api("PATCH", this.R(`/pulls/${number}`), { state: "closed" }); }
  comment(number, body) { return this.api("POST", this.R(`/issues/${number}/comments`), { body }); }
  closeIssue(number) { return this.api("PATCH", this.R(`/issues/${number}`), { state: "closed" }); }

  fileUrl(path, branch) { return `https://github.com/${this.repo}/blob/${branch}/${path}`; }

  /// The check runs (CI) on a commit: [{ name, status, conclusion }]. Empty when the repository has no checks.
  async checkRuns(sha) {
    const j = await this.api("GET", this.R(`/commits/${sha}/check-runs?per_page=50`));
    return (j.check_runs || []).map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion }));
  }

  /// Opens an issue. Returns { number, url }.
  async createIssue({ title, body = "", labels = [] }) {
    const j = await this.api("POST", this.R("/issues"), { title: String(title).slice(0, 200), body, labels });
    return { number: j.number, url: j.html_url };
  }
}
