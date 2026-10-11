// The sandbox client: the request it sends (the token, the code, the install step, the command, the files to
// bring back), the answer it hands over, the refusals in the sandbox's words, and nothing without the settings.
import test from "node:test";
import assert from "node:assert/strict";
import { Sandbox } from "../lib/sandbox.mjs";

test("a job: the token, the body, the answer; a tarball as a Buffer becomes base64; a refusal is the sandbox's own words; unset means not configured", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith("/health")) return { ok: true, status: 200, json: async () => ({ ok: true, running: 0, queued: 0, images: ["node", "python", "foundry"] }) };
    const b = JSON.parse(init.body);
    if (b.command === "boom") return { ok: false, status: 400, json: async () => ({ error: "the git url must be https and plain" }) };
    if (b.command === "busy") return { ok: false, status: 429, json: async () => ({ error: "the sandbox is busy; try again in a few minutes" }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, id: "ab12", image: "node:22-bookworm-slim", mb: 3, install: { exit: 0, timedOut: false, stdout: "", stderr: "" }, exit: 1, timedOut: false, seconds: 4.2, stdout: "1 failing", stderr: "", files: { "out.json": "{}" }, totalSeconds: 9 }) };
  };
  const sb = new Sandbox({ url: "http://sb.test:8799/", token: "tok", fetch });
  assert.equal(sb.configured, true); assert.equal(sb.url, "http://sb.test:8799");
  assert.deepEqual((await sb.health()).images, ["node", "python", "foundry"]);
  assert.equal(calls[0].url, "http://sb.test:8799/health"); assert.equal(calls[0].headers.authorization, "Bearer tok");
  const r = await sb.run({ image: "node", git: { url: "https://github.com/a/b", ref: "main" }, install: "npm ci --ignore-scripts", command: "npm test", timeoutSeconds: 120, collect: ["out.json"] });
  assert.equal(r.exit, 1); assert.equal(r.stdout, "1 failing"); assert.deepEqual(r.files, { "out.json": "{}" });
  assert.deepEqual(calls[1].body, { image: "node", command: "npm test", timeoutSeconds: 120, installTimeoutSeconds: 180, collect: ["out.json"], git: { url: "https://github.com/a/b", ref: "main" }, install: "npm ci --ignore-scripts" });
  assert.equal(calls[1].headers["content-type"], "application/json");
  await sb.run({ tar: Buffer.from("hello"), command: "ls" });
  assert.equal(calls[2].body.tar, Buffer.from("hello").toString("base64")); assert.equal(calls[2].body.git, undefined); assert.equal(calls[2].body.install, undefined);
  await assert.rejects(() => sb.run({ git: { url: "ftp://x" }, command: "boom" }), /^Error: the sandbox refused the job: the git url must be https and plain$/);
  await assert.rejects(() => sb.run({ tar: "AA==", command: "busy" }), /the sandbox is busy/);
  await assert.rejects(() => sb.run({ tar: "AA==" }), /a command is needed/);
  const none = new Sandbox({});
  assert.equal(none.configured, false);
  await assert.rejects(() => none.run({ command: "ls", tar: "AA==" }), /not set up/);
  await assert.rejects(() => none.health(), /not set up/);
});
