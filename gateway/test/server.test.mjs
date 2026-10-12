// The gateway itself, end to end: the real server.mjs in a child process, a fake upstream in this one.
// Written after the code review of 2026-10-12; each test names the behaviour that must hold on the wire.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet } from "ethers";
import { Ledger } from "../ledger.mjs";
import { walletToBeneficiary, keyMessage, keyFromSignature } from "../auth.mjs";

const SUGAR = "0x" + "5".repeat(40);
const seen = []; // every chat body the fake upstream received
const open = []; // the answers the fake upstream left open on purpose
let upstream, up, gateway, port, base, dbPath, log = "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODELS = { data: [
  { id: "test/model", pricing: { prompt: "0.000001", completion: "0.000002" } }, // 1 and 2 USD per million tokens
  { id: "test/router", pricing: { prompt: "-1", completion: "-1" } }, // a router states no fixed price
] };
const sse = (lines) => lines.map((l) => `data: ${typeof l === "string" ? l : JSON.stringify(l)}`).join("\n\n");
const delta = (text, id = "gen-1") => ({ id, choices: [{ delta: { content: text } }] });
const whole = (cost) => JSON.stringify({ id: "gen-1", choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost } });

/// The real server, on the same port and the same books each time it is started.
async function startGateway() {
  // every secret is set to empty here: the child must never read a real key, pay, bridge or send anything
  gateway = spawn(process.execPath, [fileURLToPath(new URL("../server.mjs", import.meta.url))], {
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, OPENROUTER_URL: up, OPENROUTER_API_KEY: "test", SUGAR_ADDRESS: SUGAR, RPC_URL: up, CHAIN_ID: "1",
      BROWNIES_GATEWAY_ENV: "", PANTRY_PRIVATE_KEY: "", KEEPER_PRIVATE_KEY: "", TEAM_LOG_KEY: "", HARVESTER_ADDRESS: "", LEDGER_ADDRESS: "", TEAM_VAULT_ADDRESS: "", PRICE_MULTIPLIER: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  gateway.stdout.on("data", (d) => (log += d));
  gateway.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the gateway did not start:\n${log}`);
}

before(async () => {
  upstream = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const jsonOut = (status, text) => { res.writeHead(status, { "content-type": "application/json" }); res.end(text); };
      if (req.url === "/models") return jsonOut(200, JSON.stringify(MODELS));
      // the upstream's own record of a call, by id: what the call that was cut really cost
      if (req.url.startsWith("/generation")) return jsonOut(200, JSON.stringify({ data: { id: "gen-slow", total_cost: 0.0031 } }));
      if (req.url === "/chat/completions") {
        const body = JSON.parse(raw); seen.push(body);
        const how = body.messages[0].content;
        if (how === "fail") return jsonOut(500, JSON.stringify({ error: { message: "boom" } }));
        if (how === "plain") return jsonOut(200, whole(0.00015));
        if (how === "dear") return jsonOut(200, whole(0.5)); // half a dollar for a call whose hold was a fraction of a cent
        res.writeHead(200, { "content-type": "text/event-stream" });
        // the usage is the last line and nothing follows it, not even a newline
        if (how === "stream") return res.end(sse([delta("hel"), delta("lo"), { id: "gen-1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00018 } }]));
        // a stream that ends with no usage line at all
        if (how === "nousage") return res.end(sse([delta("x".repeat(500)), delta("y".repeat(500))]) + "\n\n");
        // a stream that says its first words and then stays open
        if (how === "slow") { open.push(res); return res.write(sse([delta("partial", "gen-slow")]) + "\n\n"); }
        return res.end(sse(["[DONE]"]));
      }
      // the chain: just enough JSON-RPC for the indexer to find nothing
      let rpc = {};
      try { rpc = JSON.parse(raw); } catch { /* not JSON */ }
      const one = (q) => ({ jsonrpc: "2.0", id: q.id, result: q.method === "eth_chainId" ? "0x1" : q.method === "eth_blockNumber" ? "0x10" : q.method === "eth_getLogs" ? [] : "0x" });
      jsonOut(200, JSON.stringify(Array.isArray(rpc) ? rpc.map(one) : one(rpc)));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  up = `http://127.0.0.1:${upstream.address().port}`;
  port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  dbPath = join(mkdtempSync(join(tmpdir(), "brownies-gw-")), "g.sqlite");
  await startGateway();
});
after(() => { gateway?.kill(); for (const r of open) r.destroy(); upstream?.closeAllConnections?.(); upstream?.close(); });

// a wallet with money: the activation is written straight into the gateway's own database
let nextId = 1;
async function funded(micro) {
  const w = Wallet.createRandom();
  if (micro > 0) {
    const l = new Ledger(dbPath);
    l.recordActivation({ id: nextId++, beneficiary: walletToBeneficiary(w.address), sender: w.address, atoms: micro, block: 1, tx: "0x" + String(nextId).padStart(64, "0") });
    l.db.close();
  }
  return { w, key: keyFromSignature(await w.signMessage(keyMessage(1, 0)), 0) };
}
const chat = (key, body, headers = {}) => fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const account = async (key) => (await fetch(`${base}/v1/key`, { headers: { authorization: `Bearer ${key}` } })).json();
const used = async (key) => Math.round(Number((await account(key)).balance.used) * 1e6);
const ask = (how, extra = {}) => ({ model: "test/model", messages: [{ role: "user", content: how }], max_tokens: 100, ...extra });

test("a plain call is charged what the upstream said it cost, and the hold is let go", async () => {
  const { key } = await funded(1_000_000);
  const r = await chat(key, ask("plain"));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.brownies.charged_usd, "0.000150");
  assert.equal(await used(key), 150);
  assert.equal((await account(key)).balance.available, "0.999850", "nothing stays held after the call");
});

test("a call that cost more than was held is charged what was held: the balance and a grant's day were checked against that, not against more", async () => {
  const { key } = await funded(1_000_000);
  const j = await (await chat(key, ask("dear"))).json();
  const micro = await used(key);
  // the hold: about forty tokens of prompt at 1 USD a million and 100 of output at 2
  assert.ok(micro > 200 && micro < 400, `charged ${micro} micro`);
  assert.equal(j.brownies.charged_usd, (micro / 1e6).toFixed(6), "and the answer says what was charged, not what the upstream asked");
  assert.match(log, /the call cost 0\.500000 USD and 0\.000\d+ was held/, "the part that is ours is written in the log");
});

test("a stream whose usage is the very last line, with no newline after it, is still charged", async () => {
  const { key } = await funded(1_000_000);
  const r = await chat(key, ask("stream", { stream: true }));
  const text = await r.text();
  assert.match(text, /hel/);
  assert.match(text, /"cost":0.00018/);
  assert.equal(await used(key), 180);
});

test("a stream that ends with no usage line is charged the prompt and the text that went out, not nothing", async () => {
  const { key } = await funded(1_000_000);
  const r = await chat(key, ask("nousage", { stream: true, max_tokens: 1_000 }));
  assert.equal((await r.text()).includes("x".repeat(500)), true);
  const micro = await used(key);
  // 1000 characters delivered at 2.5 bytes a token is 400 tokens at 2 USD a million: 800 micro, plus the prompt
  assert.ok(micro >= 800 && micro < 1_000, `charged ${micro} micro`);
});

test("a model with no fixed price (a router) is refused before any hold: its negative price cannot become balance", async () => {
  const { key } = await funded(1_000_000);
  const n = seen.length;
  const r = await chat(key, { model: "test/router", messages: [{ role: "user", content: "plain" }], max_tokens: 1_000_000 });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, "unpriced_model");
  assert.equal(seen.length, n, "the upstream was never called");
  assert.deepEqual([(await account(key)).balance.available, await used(key)], ["1.000000", 0]);
});

test("the call that is priced is the call that is made: other models, a route, paid extras and a count of answers are taken out, and no dearer provider may serve it", async () => {
  const { key } = await funded(1_000_000);
  await (await chat(key, ask("plain", { models: ["expensive/model"], route: "fallback", plugins: [{ id: "web" }], web_search_options: { search_context_size: "high" }, n: 4, provider: { data_collection: "deny", order: ["Dear Inc"] } }))).json();
  const sent = seen[seen.length - 1];
  assert.equal(sent.model, "test/model");
  for (const k of ["models", "route", "plugins", "web_search_options", "n"]) assert.equal(k in sent, false, k);
  assert.deepEqual(sent.provider, { data_collection: "deny", order: ["Dear Inc"], max_price: { prompt: 1, completion: 2 } }, "the caller's own choices stay; the price ceiling is the catalogue's");
});

test("the whole body is held for, not the messages alone: a large tool schema that the balance cannot cover is refused", async () => {
  const { key } = await funded(20_000); // two cents
  const n = seen.length;
  // 100 kB of tool schema is about 40,000 prompt tokens: four cents at 1 USD a million
  const r = await chat(key, ask("plain", { tools: [{ type: "function", function: { name: "f", description: "d".repeat(100_000) } }] }));
  assert.equal(r.status, 402);
  assert.equal(seen.length, n, "the upstream was never called");
  assert.equal(await used(key), 0);
});

test("calls at once cannot all spend the same money: one is refused while the others hold it", async () => {
  const { key } = await funded(30_000); // three cents; one call with 7000 tokens of output may cost 1.4 cents
  const rs = await Promise.all([1, 2, 3].map(() => chat(key, ask("plain", { max_tokens: 7_000 }))));
  const codes = rs.map((r) => r.status).sort();
  await Promise.all(rs.map((r) => r.text()));
  assert.ok(codes.includes(402), `statuses ${codes}`);
  assert.ok(codes.includes(200), `statuses ${codes}`);
  assert.ok((await used(key)) <= 30_000, "never more than the balance");
});

test("an upstream error costs nothing and holds nothing", async () => {
  const { key } = await funded(1_000_000);
  const r = await chat(key, ask("fail"));
  assert.equal(r.status, 500);
  await r.text();
  assert.deepEqual([(await account(key)).balance.available, await used(key)], ["1.000000", 0]);
});

test("rotating the key ends the grants the wallet gave, and says so", async () => {
  const { key, w } = await funded(5_000_000);
  const brownie = await funded(0);
  const auth = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  assert.equal((await fetch(`${base}/v1/grants`, { method: "POST", headers: auth, body: JSON.stringify({ grantee: brownie.w.address, daily_usd: 1 }) })).status, 200);
  const from = { "x-brownies-pay-from": w.address };
  assert.equal((await chat(brownie.key, ask("plain"), from)).status, 200, "the grant pays while it stands");
  const rot = await (await fetch(`${base}/v1/key/rotate`, { method: "POST", headers: auth })).json();
  assert.deepEqual(rot.grants_ended.map((a) => a.toLowerCase()), [brownie.w.address.toLowerCase()]);
  assert.equal((await chat(brownie.key, ask("plain"), from)).status, 403, "and no longer after the rotation");
  assert.equal((await fetch(`${base}/v1/key`, { headers: auth })).status, 401, "the old key is dead too");
});

test("a request target that is not a path gets a 400 and the gateway stays up", async () => {
  const answer = await new Promise((resolve, reject) => {
    const s = connect(port, "127.0.0.1", () => s.write("GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
    let out = "";
    s.on("data", (d) => (out += d));
    s.on("end", () => resolve(out));
    s.on("error", reject);
  });
  assert.match(answer, /^HTTP\/1\.1 400 /);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal(gateway.exitCode, null, `the gateway is still running\n${log}`);
});

// the last test: it kills the gateway and starts another on the same books
test("a call cut by a crash is not free: the next process books the prompt at once, then what the upstream's own record says the call cost", async () => {
  const { key } = await funded(1_000_000);
  const idle = await funded(1_000_000);
  const r = await chat(key, ask("slow", { stream: true, max_tokens: 5_000 })); // held: a cent and a little
  const reader = r.body.getReader();
  await reader.read(); // the first words are here: the upstream took the call and named it
  assert.equal(Number((await account(key)).balance.available) < 0.991, true, "the hold stands while the call runs");
  gateway.kill("SIGKILL"); // the process dies with the call in flight
  await new Promise((done) => gateway.once("exit", done));
  await reader.cancel().catch(() => {});
  await startGateway();
  let micro = 0;
  for (let i = 0; i < 80 && micro !== 3_100; i++) { await sleep(100); micro = await used(key); }
  assert.equal(micro, 3_100, `the upstream's record said 0.0031 USD\n${log}`);
  assert.equal((await account(key)).balance.available, "0.996900", "and nothing is still held");
  assert.deepEqual([(await account(idle.key)).balance.available, await used(idle.key)], ["1.000000", 0], "a wallet with nothing in flight is untouched");
  assert.match(log, /1 call\(s\) were in flight when the last process stopped: 1 booked/);
});
