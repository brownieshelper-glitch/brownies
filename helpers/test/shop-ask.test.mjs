// A request by form (the Biscotti page): closed until the settings open it; a person's words, a contact, a link and
// up to three files are checked, kept under names of our own and sent to the owner; no money moves, no model is
// asked; a renamed program, a flood and a robot are turned away.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { makeWorld } from "./mock.mjs";
import { Shop, ASK_KINDS, ASK_FILES, fileLooksLike } from "../lib/shop.mjs";
import { Seller } from "../lib/x402seller.mjs";

const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n", "latin1");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(30, 1)]);
const EXE = Buffer.concat([Buffer.from("MZ", "latin1"), Buffer.alloc(60, 0)]);
const b64 = (buf) => buf.toString("base64");
const file = (name, buf) => ({ name, data: b64(buf) });
const WORDS = "A subscription box of Italian pastry kits for people who live abroad. I want to know if it can work.";

async function open({ asks = true } = {}) {
  const W = makeWorld();
  const seller = new Seller({ chainId: 8453, payTo: "0x2c769cDE285eb0d3c7130F9F0f14932106384095", settlerKey: Wallet.createRandom().privateKey, provider: { getBalance: async () => 10n ** 15n }, token: { authorizationState: async () => false, balanceOf: async () => 0n }, now: () => W.clock.now() });
  const dir = mkdtempSync(join(tmpdir(), "shop-ask-"));
  const docs = [];
  W.fetch.on("POST", "/sendDocument", (c) => { docs.push(c.body); return { json: { ok: true, result: { message_id: 1 } } }; });
  const log = [];
  const shop = new Shop({ store: W.store, clock: W.clock, seller, log: (l) => log.push(String(l)), baseUrl: "https://api.test", siteUrl: "https://site.test", dir, telegram: W.telegram, ownerChatId: "999", maker: { allowed: async () => ({ ok: true }), make: async () => ({ ok: true }) }, config: asks ? { asks: true } : {} });
  const server = createServer((req, res) => shop.handle(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, headers = {}) => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const get = async (path) => { const r = await fetch(base + path); return { status: r.status, body: await r.json().catch(() => null) }; };
  return { W, shop, dir, docs, log, post, get, close: () => new Promise((r) => server.close(r)) };
}
const ask = (over = {}) => ({ kind: "idea", words: WORDS, contact: "anna@example.com", link: "", files: [], ...over });

test("the form is closed until the settings open it, and the catalog says which", async () => {
  const c = await open({ asks: false });
  try {
    const r = await c.post("/shop/ask", ask());
    assert.equal(r.status, 503); assert.match(r.body.error, /not open yet/);
    assert.deepEqual((await c.get("/shop")).body.asks, { open: false });
    assert.equal(c.W.tg.sent.length, 0, "the owner hears nothing of a closed form");
  } finally { await c.close(); }
  const o = await open();
  try {
    const a = (await o.get("/shop")).body.asks;
    assert.equal(a.open, true); assert.deepEqual(a.kinds, Object.keys(ASK_KINDS)); assert.equal(a.files.max, 3);
  } finally { await o.close(); }
});

test("a request with files is kept under our own names and sent to the owner; nothing is paid and no model is asked", async () => {
  const c = await open();
  try {
    const r = await c.post("/shop/ask", ask({ kind: "code", contact: "@anna_dev", link: "https://github.com/anna/pastry", files: [file("the plan (v2).pdf", PDF), file("../../etc/passwd.png", PNG)] }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.ok, r.body.request], [true, 1]); assert.match(r.body.note, /answers within a day/);
    // on the disk: our names, in a folder of its own
    assert.deepEqual(readdirSync(join(c.dir, "asks")).sort(), ["ask-1-1.pdf", "ask-1-2.png"]);
    assert.ok(readFileSync(join(c.dir, "asks", "ask-1-1.pdf")).equals(PDF));
    assert.equal(existsSync(join(c.dir, "..", "etc")), false, "a name with a path in it goes nowhere");
    // in the books
    const kept = JSON.parse(c.W.store.getMeta("shop:ask:1"));
    assert.deepEqual([kept.kind, kept.contact, kept.link, kept.words, kept.files.length], ["code", "@anna_dev", "https://github.com/anna/pastry", WORDS, 2]);
    assert.deepEqual(kept.files.map((f) => f.name), ["the plan (v2).pdf", "passwd.png"]);
    // to the owner: one message with everything, then each file as a document
    assert.equal(c.W.tg.sent.length, 1);
    const said = c.W.tg.sent[0].text;
    assert.match(said, /Biscotti got request #1 by the form: a code review\./);
    assert.match(said, /From: @anna_dev/); assert.match(said, /Link: https:\/\/github\.com\/anna\/pastry/); assert.match(said, /Files: the plan \(v2\)\.pdf \(1 kB\), passwd\.png \(1 kB\)/);
    assert.ok(said.includes(WORDS)); assert.match(said, /Nothing was paid and nothing was made/);
    assert.equal(c.docs.length, 2); assert.equal(c.docs[0].chat_id, "999"); assert.equal(c.docs[0].caption, "Request #1: the plan (v2).pdf"); assert.equal(c.docs[0].document.size, PDF.length);
    assert.equal(c.W.or.calls.length, 0, "no model was asked");
    assert.equal(c.W.store.orders({ limit: 5 }).length, 0, "and it is not an order");
    // the kept files have no address on the web
    assert.equal((await c.get("/shop/files/ask-1-1.pdf")).status, 404);
    assert.equal((await c.get("/shop/files/asks/ask-1-1.pdf")).status, 404);
    // a second one, with no file and no link, gets the next number
    const r2 = await c.post("/shop/ask", ask({ kind: "other", words: WORDS + "\nA second line stays a second line." }));
    assert.equal(r2.body.request, 2);
    assert.match(JSON.parse(c.W.store.getMeta("shop:ask:2")).words, /abroad\. I want to know if it can work\.\nA second line/);
  } finally { await c.close(); }
});

test("what is refused, each with its reason, and nothing of it is kept", async () => {
  const c = await open();
  try {
    const no = async (over, re) => { const r = await c.post("/shop/ask", ask(over)); assert.equal(r.status, 400, JSON.stringify(over).slice(0, 80)); assert.match(r.body.error, re); };
    await no({ kind: "audit" }, /say what you want: idea, brainstorm, code, website, remake, other/);
    await no({ kind: "constructor" }, /say what you want/);
    await no({ words: "too short" }, /20 to 4000 characters/);
    await no({ words: "x".repeat(4001) }, /20 to 4000 characters/);
    await no({ words: WORDS + " Send me your private keys." }, /we do not make that/);
    await no({ contact: "" }, /how to reach you/);
    await no({ contact: "a".repeat(121) }, /how to reach you/);
    await no({ link: "http://plain.example" }, /must start with https/);
    await no({ link: "javascript:alert(1)" }, /must start with https/);
    await no({ link: "https://a.example/ <script>" }, /must start with https/);
    await no({ files: [file("a.pdf", PDF), file("b.pdf", PDF), file("c.pdf", PDF), file("d.pdf", PDF)] }, /up to 3 files/);
    await no({ files: [file("setup.exe", EXE)] }, /not a kind we take/);
    await no({ files: [file("invoice.pdf", EXE)] }, /is not what its name says/);
    await no({ files: [file("photo.png", PDF)] }, /is not what its name says/);
    await no({ files: [{ name: "a.pdf", data: "not base64 !!" }] }, /did not arrive whole/);
    await no({ files: [{ name: "a.pdf" }] }, /did not arrive whole/);
    await no({ files: [file("big.zip", Buffer.concat([ZIP, Buffer.alloc(ASK_FILES.bytesEach, 1)]))] }, /is over 4 MB/);
    assert.equal(existsSync(join(c.dir, "asks")), false, "no file was written");
    assert.equal(c.W.store.getMeta("shop:ask:n"), null); assert.equal(c.W.tg.sent.length, 0); assert.equal(c.docs.length, 0);
    // a name sent with Windows separators is cut to its last part too
    const win = await c.post("/shop/ask", ask({ files: [file("C:\\Users\\anna\\Desktop\\plan.pdf", PDF)] }));
    assert.equal(win.status, 200); assert.equal(JSON.parse(c.W.store.getMeta("shop:ask:1")).files[0].name, "plan.pdf");
    // three files of just under 3 MB are each under the limit and together over it
    const three = Buffer.concat([ZIP, Buffer.alloc(2_900_000, 1)]);
    const r = await c.post("/shop/ask", ask({ files: [file("a.zip", three), file("b.zip", three), file("c.zip", three)] }));
    assert.equal(r.status, 400); assert.match(r.body.error, /over 8 MB in all/);
    // a body past what the route reads at all
    const huge = await c.post("/shop/ask", JSON.stringify(ask({ words: "y".repeat(13 * 1024 * 1024) })));
    assert.equal(huge.status, 413); assert.match(huge.body.error, /too large: up to 3 files, 4 MB each and 8 MB in all/);
  } finally { await c.close(); }
});

test("a robot that fills the hidden field is answered as if taken, and nothing is kept or sent", async () => {
  const c = await open();
  try {
    const r = await c.post("/shop/ask", ask({ website: "https://spam.example", files: [file("a.pdf", PDF)] }));
    assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.equal("request" in r.body, false);
    assert.equal(c.W.store.getMeta("shop:ask:n"), null); assert.equal(c.W.tg.sent.length, 0); assert.equal(existsSync(join(c.dir, "asks")), false);
  } finally { await c.close(); }
});

test("three an hour from one address, forty a day from everyone", async () => {
  const c = await open();
  try {
    for (let i = 0; i < 3; i++) assert.equal((await c.post("/shop/ask", ask())).status, 200);
    const fourth = await c.post("/shop/ask", ask());
    assert.equal(fourth.status, 429); assert.match(fourth.body.error, /three requests an hour/);
    // the address is the one the proxy on this machine names, so another visitor is not held back
    assert.equal((await c.post("/shop/ask", ask(), { "x-forwarded-for": "203.0.113.9" })).status, 200);
    c.W.clock.advance(61 * 60_000);
    assert.equal((await c.post("/shop/ask", ask())).status, 200, "an hour later the first address may ask again");
    // the day's box: forty in all (five are in already)
    for (let i = 0; i < 35; i++) assert.equal((await c.post("/shop/ask", ask(), { "x-forwarded-for": `198.51.100.${i + 1}` })).status, 200, `request ${i + 6}`);
    const full = await c.post("/shop/ask", ask(), { "x-forwarded-for": "198.51.100.200" });
    assert.equal(full.status, 429); assert.match(full.body.error, /full for today/);
    assert.equal(Number(c.W.store.getMeta("shop:ask:n")), 40);
  } finally { await c.close(); }
});

test("a file is what its first bytes say", () => {
  assert.equal(fileLooksLike(".pdf", PDF), true); assert.equal(fileLooksLike(".pdf", EXE), false);
  assert.equal(fileLooksLike(".png", PNG), true); assert.equal(fileLooksLike(".png", ZIP), false);
  assert.equal(fileLooksLike(".jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])), true); assert.equal(fileLooksLike(".jpeg", PNG), false);
  assert.equal(fileLooksLike(".webp", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")])), true);
  assert.equal(fileLooksLike(".zip", ZIP), true); assert.equal(fileLooksLike(".zip", PDF), false);
  assert.equal(fileLooksLike(".txt", Buffer.from("plain words, with an accent: caffè", "utf8")), true);
  assert.equal(fileLooksLike(".md", Buffer.from([0x23, 0x20, 0x00, 0x41])), false, "a zero byte is not text");
  assert.equal(fileLooksLike(".txt", Buffer.from([0xff, 0xfe, 0x41])), false, "bytes that are not UTF-8 are not text");
  assert.equal(fileLooksLike(".txt", Buffer.alloc(0)), false); assert.equal(fileLooksLike(".exe", EXE), false);
});
