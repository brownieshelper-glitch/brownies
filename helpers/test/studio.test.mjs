// The studio intake: the offer is readable, a good request lands on the board once and the owner is told, a robot
// that fills the hidden field is ignored politely, bad fields are refused with the reason, and one address cannot
// flood the form.
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./mock.mjs";
import { Studio, DEFAULT_STUDIO } from "../lib/studio.mjs";

function studioIn(W, config = {}) {
  const log = [];
  const s = new Studio({ store: W.store, clock: W.clock, telegram: W.telegram, ownerChatId: "999", config, siteUrl: "https://feedthebrownies.com", log: (l) => log.push(String(l)) });
  const call = (method, url, body = null, ip = "1.2.3.4") => new Promise((resolve) => {
    const req = { method, url, headers: { "x-forwarded-for": ip }, socket: { remoteAddress: ip }, handlers: {}, on(ev, fn) { this.handlers[ev] = fn; return this; } };
    let status = 0, out = "";
    const res = { writeHead: (st) => { status = st; }, end: (b) => { out += b || ""; resolve({ status, body: out ? JSON.parse(out) : null }); } };
    s.handle(req, res);
    if (method === "POST") setImmediate(() => { if (!req.handlers.end) return; if (body != null) req.handlers.data(JSON.stringify(body)); req.handlers.end(); });
  });
  return { s, call, log };
}

test("the offer; a good request lands on the board once and the owner is told", async () => {
  const W = makeWorld();
  const { s, call, log } = studioIn(W, { priceEth: 0.25 });
  let r = await call("GET", "/studio/info");
  assert.equal(r.status, 200);
  assert.equal(r.body.priceEth, 0.25); assert.equal(r.body.feeSliceBps, 1000); assert.equal(r.body.feeSlicePct, 10);
  assert.deepEqual(r.body.includes, DEFAULT_STUDIO.includes); assert.match(r.body.contract, /^StudioSplitter/);
  const form = { name: "Moon Cat", idea: "A cat coin for the Base community with a daily cartoon, we have 3,000 followers already.", contact: "@mooncat on Telegram", link: "https://x.com/mooncat" };
  r = await call("POST", "/studio/apply", form);
  assert.deepEqual(r, { status: 200, body: { ok: true, id: 1, duplicate: false } });
  const job = W.store.moneyJob(1);
  assert.equal(job.kind, "studio"); assert.equal(job.state, "found"); assert.equal(job.source, "studio-form"); assert.equal(job.title, "Studio request: Moon Cat");
  assert.equal(job.url, "https://x.com/mooncat"); assert.equal(job.effort, "high");
  assert.match(job.summary, /^A cat coin for the Base community.*\nContact: @mooncat on Telegram\nLink: https:\/\/x\.com\/mooncat$/);
  assert.equal(job.nextStep, "Reply to @mooncat on Telegram with the proposal: 0.25 ETH plus 10% of the creator fee through the splitter.");
  assert.equal(job.log[0].text, "asked through the studio form");
  const msg = W.tg.sent.at(-1);
  assert.equal(msg.chat_id, "999");
  assert.match(msg.text, /^New studio request from Moon Cat \(@mooncat on Telegram\):\nA cat coin for the Base community.*\nhttps:\/\/x\.com\/mooncat\n\nIt is job 1 on the board\. \/zest pick 1 makes Glaze write the proposal; the board: https:\/\/feedthebrownies\.com\/jobs\.html$/s);
  assert.ok(log.some((l) => /\[studio\] request 1 from Moon Cat/.test(l)));
  // the same request again: the same job, nothing new, nobody told twice
  const sent = W.tg.sent.length;
  r = await call("POST", "/studio/apply", form);
  assert.deepEqual(r.body, { ok: true, id: 1, duplicate: true });
  assert.equal(W.store.moneyJobs().length, 1); assert.equal(W.tg.sent.length, sent);
  assert.equal(s.info().contact, "https://t.me/feedthebrownies");
});

test("robots, bad fields and floods", async () => {
  const W = makeWorld();
  const { call } = studioIn(W);
  const good = { name: "Moon Cat", idea: "A cat coin for the Base community with a daily cartoon.", contact: "@mooncat" };
  let r = await call("POST", "/studio/apply", { ...good, website: "http://spam.example" });
  assert.deepEqual(r.body, { ok: true, id: 0 }, "the honeypot: a polite yes, nothing kept");
  assert.equal(W.store.moneyJobs().length, 0); assert.equal(W.tg.sent.length, 0);
  // every try counts against the address, so each check comes from its own
  r = await call("POST", "/studio/apply", { ...good, name: "M" }, "5.0.0.1"); assert.equal(r.status, 400); assert.equal(r.body.error, "name is too short");
  r = await call("POST", "/studio/apply", { ...good, idea: "short" }, "5.0.0.2"); assert.equal(r.body.error, "idea is too short");
  r = await call("POST", "/studio/apply", { ...good, idea: "x".repeat(1501) }, "5.0.0.3"); assert.equal(r.body.error, "idea is too long (1500 characters at most)");
  r = await call("POST", "/studio/apply", { ...good, contact: "" }, "5.0.0.4"); assert.equal(r.body.error, "contact is too short");
  r = await call("POST", "/studio/apply", { ...good, link: "mooncat.example" }, "5.0.0.5"); assert.equal(r.body.error, "link must start with http");
  r = await call("POST", "/studio/apply", { ...good, link: "" }, "5.0.0.6"); assert.equal(r.status, 200, "no link is fine");
  r = await call("GET", "/studio/nothing"); assert.equal(r.status, 404);
  r = await call("OPTIONS", "/studio/apply"); assert.equal(r.status, 204);
  for (let i = 0; i < 5; i++) await call("POST", "/studio/apply", { ...good, name: `Cat ${i}` }, "9.9.9.9");
  r = await call("POST", "/studio/apply", { ...good, name: "Cat 9" }, "9.9.9.9");
  assert.equal(r.status, 429);
  r = await call("POST", "/studio/apply", { ...good, name: "Cat 9" }, "8.8.8.8");
  assert.equal(r.status, 200, "another address is not blocked");
});
