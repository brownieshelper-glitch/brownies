// Patch, quality. Before Chip merges a pull request, Patch waits for the repository's checks (the GitHub Actions
// workflow in .github/workflows/tests.yml runs the test suites on every pull request) and gives a verdict:
// passed, failed, or none when the repository has no checks. A failed verdict blocks the merge, is written on
// the pull request, and sends the change to the owner. Patch itself runs no code: the machine does, in CI.
import { Helper } from "./helper.mjs";
import { cut } from "./text.mjs";

export class Patch extends Helper {
  constructor(deps) {
    super("patch", deps);
    this.github = deps.github || null;
    this.waitMs = this.config.waitMinutes ? this.config.waitMinutes * 60_000 : 12 * 60_000; // how long checks may take
    this.graceMs = this.config.graceMinutes ? this.config.graceMinutes * 60_000 : 3 * 60_000; // how long to wait for the first check to appear
    this.pollMs = this.config.pollSeconds ? this.config.pollSeconds * 1000 : 20_000;
    this.sleep = deps.sleep || ((ms) => this.clock.sleep(ms)); // the tests pass a sleep that moves their fake clock
  }

  jobs() { return []; } // Patch works when Chip calls it, not on a clock

  /// The verdict on a pull request: { state: "passed" | "failed" | "none", checks: [{ name, conclusion }] }.
  async verify(pr) {
    if (!this.github?.configured) return { state: "none", checks: [] };
    const started = this.clock.now();
    const sha = pr.head?.sha || (await this.github.pr(pr.number)).head?.sha;
    if (!sha) return { state: "none", checks: [] };
    let runs = [];
    for (;;) {
      runs = await this.github.checkRuns(sha).catch(() => []);
      const waited = this.clock.now() - started;
      if (!runs.length) { if (waited >= this.graceMs) break; await this.sleep(this.pollMs); continue; }
      if (runs.every((r) => r.status === "completed")) break;
      if (waited >= this.waitMs) break;
      await this.sleep(this.pollMs);
    }
    const checks = runs.map((r) => ({ name: r.name, conclusion: r.status === "completed" ? r.conclusion : "timed out" }));
    const state = !runs.length ? "none" : checks.every((c) => ["success", "neutral", "skipped"].includes(c.conclusion)) ? "passed" : "failed";
    const names = checks.filter((c) => !["success", "neutral", "skipped"].includes(c.conclusion)).map((c) => `${c.name} (${c.conclusion})`);
    if (state === "failed") {
      await this.github.comment(pr.number, `Patch: the checks did not pass, so this is not merged by itself: ${names.join(", ")}. Fix the tests or let the owner decide.`).catch(() => {});
      await this.report("note", `Tests failed on #${pr.number}: ${cut(names.join(", "), 120)}`, { url: pr.html_url || pr.url, place: "github" });
    } else if (state === "passed") {
      await this.report("note", `Tests passed on #${pr.number} (${checks.length} check${checks.length === 1 ? "" : "s"})`, { url: pr.html_url || pr.url, place: "github" });
    } else this.log(`[patch] no checks on #${pr.number}: the repository has no workflow yet`);
    return { state, checks };
  }
}
