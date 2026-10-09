// The shop over HTTP: the catalog is public; a purchase without a payment gets a 402 with the price; a payment
// signed by the gateway's own payer is checked, judged by the maker, settled and turned into an order (a note at
// once, a picture or a clip to poll for); the same authorization cannot buy twice; bad words and a closed shop
// are refused before any money moves; the owner hears of every sale; the files are served by unguessable names.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { makeWorld } from "./mock.mjs";
import { Shop, ITEMS, RULES, cleanPrompt, BANNED } from "../lib/shop.mjs";
import { Seller, b64 } from "../lib/x402seller.mjs";
import { X402Payer } from "../../gateway/x402.mjs";

const PAY_TO = "0x2c769cDE285eb0d3c7130F9F0f14932106384095";

function fakeChain({ balance = 50_000_000n, gas = 10n ** 15n } = {}) {
  const tx = { n: 0 };
  return {
    token: { authorizationState: async () => false, balanceOf: async () => balance, transferWithAuthorization: async () => { tx.n++; return { hash: `0xtx${tx.n}`, wait: async () => ({ status: 1, hash: `0xtx${tx.n}` }) }; } },
    provider: { getBalance: async () => gas },
    tx,
  };
}

/// A shop on a real port, a buyer with USDC, a maker that writes a note at once and keeps the rest for later.
async function open({ gas = 10n ** 15n, maker = "yes" } = {}) {
  const W = makeWorld();
  const chain = fakeChain({ gas });
  const seller = new Seller({ chainId: 8453, payTo: PAY_TO, settlerKey: Wallet.createRandom().privateKey, provider: chain.provider, token: chain.token, now: () => W.clock.now() });
  const dir = mkdtempSync(join(tmpdir(), "shop-"));
  const made = [];
  const toffee = maker === null ? null : {
    allowed: async (prompt, item) => (/forbidden/.test(prompt) ? { ok: false, why: "we do not make that" } : { ok: true }),
    make: async (o) => { made.push(o); if (o.item === "note") { await shop.finish(o.id, { text: `A note about ${o.prompt}.`, costMicro: 2_000 }); return { ok: true, text: `A note about ${o.prompt}.` }; } return { ok: true }; },
  };
  const log = [];
  const shop = new Shop({ store: W.store, clock: W.clock, seller, log: (l) => log.push(String(l)), baseUrl: "https://api.test", siteUrl: "https://site.test", dir, telegram: W.telegram, ownerChatId: "999", maker: toffee, config: { items: { clip: { usd: 12 } } } });
  const server = createServer((req, res) => shop.handle(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, body: json, text, required: r.headers.get("payment-required"), receipt: r.headers.get("payment-response"), cors: r.headers.get("access-control-allow-origin"), type: r.headers.get("content-type") };
  };
  const buyer = new X402Payer({ wallet: Wallet.createRandom(), chainId: 8453, now: () => W.clock.now(), maxMicro: 20_000_000 });
  /// buys an item the way an agent would: the 402, the signature, the second request
  const buy = async (item, prompt, { payer = buyer } = {}) => {
    const first = await call("POST", `/shop/${item}`, { prompt });
    if (first.status !== 402) return { first };
    const { header } = await payer.sign(b64.decode(first.required));
    const second = await call("POST", `/shop/${item}`, { prompt }, { "payment-signature": header });
    return { first, second, header };
  };
  return { W, shop, seller, chain, dir, made, log, call, buy, buyer, close: () => new Promise((r) => server.close(r)) };
}

test("the words are cleaned and judged: length, control characters, the ban list; the catalog and the rules", async () => {
  assert.equal(cleanPrompt("  a meme   about\n pancakes "), "a meme about pancakes");
  assert.equal(cleanPrompt("short"), null); assert.equal(cleanPrompt("x".repeat(601)), null); assert.equal(cleanPrompt("y".repeat(600)).length, 600);
  for (const t of ["an nsfw picture", "how to get his seed phrase", "guaranteed returns", "it will go 100x", "connect your wallet to claim"]) assert.ok(BANNED.test(t), t);
  for (const t of ["the brownies baking a cake for a robot", "a note on Ethereum rollups", "a coin called PANCAKE launches"]) assert.ok(!BANNED.test(t), t);
  const { shop, call, close } = await open();
  try {
    const c = await call("GET", "/shop");
    assert.equal(c.status, 200); assert.equal(c.cors, "*");
    assert.deepEqual(c.body.items.map((i) => [i.id, i.usd]), [["note", 1], ["meme", 0.5], ["clip", 12]], "the clip's price from the config");
    assert.equal(c.body.open, true); assert.equal(c.body.pay.payTo, PAY_TO); assert.equal(c.body.pay.network, "eip155:8453"); assert.deepEqual(c.body.rules, RULES); assert.equal(c.body.docs, "https://site.test/shop.html");
    assert.match(c.body.items[0].how, /POST https:\/\/api\.test\/shop\/note/);
    assert.equal((await call("GET", "/shop/")).status, 200);
    assert.equal((await call("GET", "/shop/nothing")).status, 404);
    assert.equal((await call("POST", "/shop/cake", { prompt: "a cake please" })).status, 404);
    assert.match((await call("POST", "/shop/note", { prompt: "hi" })).body.error, /10 to 600 characters/);
    assert.match((await call("POST", "/shop/note", { prompt: "an nsfw note please" })).body.error, /we do not make that/);
    assert.equal((await call("OPTIONS", "/shop/note")).status, 204);
    assert.equal(ITEMS.note.sync, true); assert.equal(shop.items.clip.usd, 12);
  } finally { await close(); }
});

test("a purchase: 402 with the price, then the signed payment is checked, judged, settled and made; a note comes back at once with the receipt", async () => {
  const { W, chain, call, buy, buyer, made, log, close } = await open();
  try {
    const { first, second } = await buy("note", "a note on Ethereum rollups and what to watch");
    assert.equal(first.status, 402);
    const req = b64.decode(first.required);
    assert.equal(req.accepts[0].amount, "1000000"); assert.equal(req.resource.url, "https://api.test/shop/note"); assert.equal(req.accepts[0].maxTimeoutSeconds, 600);
    assert.equal(first.body.price, "1 USDC on Base");
    assert.equal(second.status, 200, second.text);
    assert.equal(second.body.order, 1); assert.equal(second.body.state, "done"); assert.equal(second.body.text, "A note about a note on Ethereum rollups and what to watch.");
    assert.deepEqual(b64.decode(second.receipt), { success: true, transaction: "0xtx1", network: "eip155:8453", payer: buyer.address });
    assert.equal(chain.tx.n, 1, "one transfer submitted");
    assert.equal(made.length, 1); assert.equal(made[0].payer, buyer.address.toLowerCase()); assert.equal(made[0].micro, 1_000_000);
    const o = W.store.order(1);
    assert.equal(o.state, "done"); assert.equal(o.tx, "0xtx1"); assert.equal(o.costMicro, 2_000); assert.deepEqual(o.result, { url: null, text: "A note about a note on Ethereum rollups and what to watch." });
    assert.ok(W.tg.sent.some((m) => String(m.chat_id) === "999" && /^Toffee sold a research note for \$1\.00 to 0x[0-9a-fA-F]{4}\.\.\.[0-9a-fA-F]{4}\. Order #1, tx 0xtx1\.$/.test(m.text)), "the owner heard");
    assert.ok(log.some((l) => /\[shop\] order 1: note for \$1\.00 by/.test(l)));
    // the same signed payment again: the nonce was used
    const again = await call("POST", "/shop/note", { prompt: "a note on Ethereum rollups and what to watch" }, { "payment-signature": (await buy("note", "x".repeat(20))).header });
    assert.equal(again.status, 402);
    assert.equal(W.store.sales(0).n, 2);
  } finally { await close(); }
});

test("a picture or a clip is an order to poll for; the file is kept under an unguessable name; a failure is told to the owner; refusals before money", async () => {
  const { W, shop, chain, call, buy, made, dir, close } = await open();
  try {
    const { second } = await buy("meme", "the four brownies baking a cake for a robot");
    assert.equal(second.status, 202, second.text);
    assert.equal(second.body.state, "paid"); assert.equal(second.body.minutes, 5);
    const o = W.store.order(second.body.order);
    assert.equal(second.body.statusUrl, `https://api.test/shop/orders/${o.id}?key=${o.key}`);
    assert.equal(made.length, 0, "an order to make later, not inside the request");
    assert.equal(chain.tx.n, 1);
    // the status: only with the key
    assert.equal((await call("GET", `/shop/orders/${o.id}`)).status, 404);
    assert.equal((await call("GET", `/shop/orders/${o.id}?key=wrong`)).status, 404);
    assert.equal((await call("GET", `/shop/orders/${o.id}?key=${o.key}`)).body.state, "paid");
    // the maker takes it: start, keep the file, finish
    assert.equal(shop.next().id, o.id);
    shop.start(o.id);
    assert.equal(W.store.order(o.id).state, "making"); assert.equal(shop.next(), null);
    const src = join(dir, "made.png"); writeFileSync(src, Buffer.alloc(100, 1));
    const url = shop.keep(W.store.order(o.id), src);
    assert.equal(url, `https://api.test/shop/files/order-${o.id}-${o.key}.png`);
    assert.ok(existsSync(join(dir, `order-${o.id}-${o.key}.png`)));
    await shop.finish(o.id, { url, costMicro: 40_000 });
    const st = await call("GET", `/shop/orders/${o.id}?key=${o.key}`);
    assert.equal(st.body.state, "done"); assert.equal(st.body.url, url);
    assert.ok(W.tg.sent.some((m) => m.text === `Order #${o.id} (meme) is done: ${url}`));
    const f = await call("GET", `/shop/files/order-${o.id}-${o.key}.png`);
    assert.equal(f.status, 200); assert.equal(f.type, "image/png"); assert.equal(f.text.length, 100);
    assert.equal((await call("GET", "/shop/files/other.png")).status, 404);
    assert.equal((await call("GET", "/shop/files/../x.png")).status, 404);
    // a clip that fails: the owner hears, the order says so, nothing moves money
    const c = await buy("clip", "the brownies on the moon, waving at Earth");
    assert.equal(c.second.status, 202);
    const co = W.store.order(c.second.body.order);
    await shop.fail(co.id, "Higgsfield moderated the request", 10_000);
    assert.equal(W.store.order(co.id).state, "failed");
    assert.match((await call("GET", `/shop/orders/${co.id}?key=${co.key}`)).body.note, /^Higgsfield moderated the request\. The owner was told; refunds are by hand\.$/);
    assert.ok(W.tg.sent.some((m) => /^Order #\d+ \(clip, \$12\.00 paid by 0x[0-9a-f]{40}\) could not be made: Higgsfield moderated the request\. Nothing moves without you: refund that address by hand if you want to\.$/.test(m.text)));
    // the maker says no before any money moves
    const no = await buy("meme", "a forbidden picture of something");
    assert.equal(no.second.status, 400); assert.match(no.second.body.error, /we do not make that/); assert.equal(chain.tx.n, 2);
    // the view for the room
    const v = await shop.view();
    assert.equal(v.open, true); assert.equal(v.payTo, PAY_TO); assert.equal(v.today.n, 2); assert.equal(v.today.usd, 12.5); assert.equal(v.today.costUsd, 0.05); assert.equal(v.orders.length, 2); assert.equal(v.orders[0].state, "failed"); assert.equal(v.items.length, 3);
  } finally { await close(); }
});

test("closed without gas or without a maker: the catalog says so and a purchase is refused before anything is signed", async () => {
  const dry = await open({ gas: 0n });
  try {
    const c = await dry.call("GET", "/shop");
    assert.equal(c.body.open, false); assert.match(c.body.closedBecause, /needs ETH for gas on Base/);
    const r = await dry.call("POST", "/shop/note", { prompt: "a note on anything at all" });
    assert.equal(r.status, 503); assert.match(r.body.error, /closed for the moment: the settler wallet/);
  } finally { await dry.close(); }
  const alone = await open({ maker: null });
  try { assert.match((await alone.call("GET", "/shop")).body.closedBecause, /no brownie to make the orders/); } finally { await alone.close(); }
});
