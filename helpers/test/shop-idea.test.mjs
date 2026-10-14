// The idea item in the shop: a longer prompt with its lines kept, the softer ban list, the 402 at 50 USDC, an order
// to poll for, the HTML and Markdown files served, and the quote route after a review (no money, the owner told).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { makeWorld } from "./mock.mjs";
import { Shop, ITEMS, cleanPrompt, BANNED, BANNED_IDEA, RULES } from "../lib/shop.mjs";
import { Seller, b64 } from "../lib/x402seller.mjs";
import { X402Payer } from "../../gateway/x402.mjs";

const PAY_TO = "0x2c769cDE285eb0d3c7130F9F0f14932106384095";

async function open() {
  const W = makeWorld();
  const tx = { n: 0 };
  const token = { authorizationState: async () => false, balanceOf: async () => 60_000_000n, transferWithAuthorization: async () => { tx.n++; return { hash: `0xtx${tx.n}`, wait: async () => ({ status: 1, hash: `0xtx${tx.n}` }) }; } };
  const seller = new Seller({ chainId: 8453, payTo: PAY_TO, settlerKey: Wallet.createRandom().privateKey, provider: { getBalance: async () => 10n ** 15n }, token, now: () => W.clock.now() });
  const dir = mkdtempSync(join(tmpdir(), "shop-idea-"));
  const judged = [];
  const maker = { allowed: async (prompt, item) => { judged.push([item, prompt]); return { ok: true }; }, make: async () => ({ ok: true }) };
  const shop = new Shop({ store: W.store, clock: W.clock, seller, baseUrl: "https://api.test", siteUrl: "https://site.test", dir, telegram: W.telegram, ownerChatId: "999", maker });
  const server = createServer((req, res) => shop.handle(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body == null ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, body: json, text, required: r.headers.get("payment-required"), type: r.headers.get("content-type") };
  };
  const buyer = new X402Payer({ wallet: Wallet.createRandom(), chainId: 8453, now: () => W.clock.now(), maxMicro: 60_000_000, allowTo: [PAY_TO] });
  const buy = async (item, prompt) => {
    const first = await call("POST", `/shop/${item}`, { prompt });
    if (first.status !== 402) return { first };
    const { header } = await buyer.sign(b64.decode(first.required));
    return { first, second: await call("POST", `/shop/${item}`, { prompt }, { "payment-signature": header }) };
  };
  return { W, shop, dir, judged, call, buy, close: () => new Promise((r) => server.close(r)) };
}

test("the words: an idea keeps its lines up to 4,000 characters; the ban list for ideas is the hard part only", () => {
  assert.equal(ITEMS.idea.usd, 50); assert.equal(ITEMS.idea.maxChars, 4000); assert.equal(ITEMS.idea.sync, false); assert.equal(ITEMS.idea.judge, "idea");
  const idea = "The problem:\r\n  people abroad miss pastry.\n\n\n\nThe money: 29 euros a month,\tguaranteed delivery.";
  assert.equal(cleanPrompt(idea, { max: 4000, keepLines: true }), "The problem:\npeople abroad miss pastry.\n\nThe money: 29 euros a month, guaranteed delivery.");
  assert.equal(cleanPrompt(idea), "The problem: people abroad miss pastry. The money: 29 euros a month, guaranteed delivery.", "the old way: one line");
  assert.equal(cleanPrompt("x".repeat(700)), null); assert.equal(cleanPrompt("x".repeat(700), { max: 4000 }), "x".repeat(700)); assert.equal(cleanPrompt("x".repeat(4001), { max: 4000 }), null);
  assert.ok(BANNED.test("guaranteed returns")); assert.ok(!BANNED_IDEA.test("guaranteed returns, 100x, to the moon"), "business talk is the model's to judge in an idea");
  assert.ok(BANNED_IDEA.test("send me your seed phrase")); assert.ok(BANNED_IDEA.test("a porn site"));
  assert.ok(RULES.some((r) => /An idea review takes up to 4,000 characters/.test(r)));
});

test("an idea is bought for 50 USDC as an order to poll for, judged as an idea, with its lines; the files are served; the quote route", async () => {
  const { W, shop, dir, judged, call, buy, close } = await open();
  try {
    const idea = "A subscription box of Italian pastry kits.\n\nWe charge 29 euros a month.\n" + "More detail. ".repeat(60);
    assert.ok(idea.length > 600, "longer than a note's limit");
    const r = await buy("idea", idea);
    assert.equal(r.first.status, 402); assert.equal(b64.decode(r.first.required).accepts[0].amount, "50000000"); assert.equal(r.first.body.price, "50 USDC on Base");
    assert.equal(r.second.status, 202); assert.equal(r.second.body.item, "idea"); assert.equal(r.second.body.state, "paid"); assert.equal(r.second.body.minutes, 15); assert.match(r.second.body.statusUrl, /^https:\/\/api\.test\/shop\/orders\/1\?key=[0-9a-f]{16}$/);
    assert.deepEqual(judged[0][0], "idea"); assert.ok(judged[0][1].includes("kits.\n\nWe charge 29 euros"), "the lines reach the judge");
    assert.equal(W.store.order(1).prompt.split("\n").length, 4);
    const c = await call("GET", "/shop");
    assert.equal(c.body.items.find((i) => i.id === "idea").maxChars, 4000);
    assert.equal((await call("POST", "/shop/idea", { prompt: "x".repeat(4001) })).body.error, 'say what you want in 10 to 4000 characters, as {"prompt": "..."}');
    assert.equal((await call("POST", "/shop/idea", { prompt: "an app that sells private keys of others" })).status, 400);
    assert.equal((await call("POST", "/shop/idea", { prompt: "a guaranteed 100x fund" })).status, 402, "business words go to the judge, not the regex");
    // the files: HTML and Markdown are served with their types
    writeFileSync(join(dir, "order-1-abcd.html"), "<p>hi</p>"); writeFileSync(join(dir, "order-1-abcd.md"), "## hi");
    const h = await call("GET", "/shop/files/order-1-abcd.html"); assert.equal(h.status, 200); assert.equal(h.type, "text/html; charset=utf-8"); assert.equal(h.text, "<p>hi</p>");
    assert.equal((await call("GET", "/shop/files/order-1-abcd.md")).type, "text/markdown; charset=utf-8");
    assert.equal((await call("GET", "/shop/files/order-1-abcd.exe")).status, 404);
    // the quote: the order and its key, what, a contact; the owner is told; nothing is charged
    const key = W.store.order(1).key;
    assert.equal((await call("POST", "/shop/quote", { order: 1, key: "wrong", what: "build the landing page" })).status, 404);
    assert.equal((await call("POST", "/shop/quote", { order: 1, key, what: "short" })).status, 400);
    const q = await call("POST", "/shop/quote", { order: 1, key, what: "Build the landing page with a waitlist and the first kit page.", contact: "founder@example.com" });
    assert.equal(q.status, 200); assert.deepEqual(q.body, { ok: true, order: 1, note: "The owner was told. A quote comes back by the contact you gave, or not at all; nothing is charged for asking." });
    assert.deepEqual(JSON.parse(W.store.getMeta("shop:quote:1")), { at: W.clock.now(), what: "Build the landing page with a waitlist and the first kit page.", contact: "founder@example.com" });
    assert.ok(W.tg.sent.some((m) => String(m.chat_id) === "999" && /^A quote was asked on order #1 \(idea, paid by 0x[0-9a-fA-F]{4}\.\.\.[0-9a-fA-F]{4}\): "Build the landing page with a waitlist and the first kit page\."\. Contact: founder@example\.com\. Nothing moves without you/.test(m.text)), "the owner heard");
    const noContact = await call("POST", "/shop/quote", { order: 1, key, what: "A Telegram bot for the orders of the box." });
    assert.equal(noContact.status, 200); assert.ok(W.tg.sent.some((m) => /No contact given; the buyer's wallet is the only address/.test(m.text)));
    assert.equal(shop.sold.count, 1);
  } finally { await close(); }
});
