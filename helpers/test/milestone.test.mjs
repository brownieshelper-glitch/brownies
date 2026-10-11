// Milestone clips: the four scenes are shapes the engine draws (a frame comes out), the caption is two short
// lines with the person's name, and a name is used only when it is plain; else the short address.
import test from "node:test";
import assert from "node:assert/strict";
import { milestoneScene, safeName, shortAddress, MILESTONES } from "../video/milestone.mjs";
import { framePng } from "../video/render.mjs";

test("every milestone draws: a five-second shot, the four brownies, a two-line caption with the name", () => {
  for (const kind of Object.keys(MILESTONES)) {
    const s = milestoneScene({ kind, name: "ann.eth", detail: kind === "bake" ? "Pip" : kind === "loyalty" ? "+10% loyalty bonus" : "" });
    assert.equal(s.shots.length, 1); assert.equal(s.shots[0].seconds, 5);
    assert.deepEqual(s.shots[0].actors.map((a) => a.who), ["fudge", "crumb", "nib", "chip"]);
    const lines = s.shots[0].caption.split("\n");
    assert.ok(lines.length <= 2 && lines.every((l) => l.length <= 26), s.shots[0].caption);
    assert.ok(s.shots[0].caption.includes("ann.eth"), kind);
    const png = framePng(s, { format: "vertical", t: 2.5, width: 270 });
    assert.ok(png.length > 1000, `${kind} renders a frame`);
    assert.ok(/^A (brownie baked|first stake|loyalty step)|^The first SUGAR/.test(s.title));
  }
  assert.equal(milestoneScene({ kind: "bake", name: "ann.eth", detail: "Pip" }).shots[0].caption, "ann.eth baked\nPip");
  assert.equal(milestoneScene({ kind: "stake", name: "0x1234...abcd" }).shots[0].caption, "Welcome in,\n0x1234...abcd");
  assert.equal(milestoneScene({ kind: "sugar", name: "bob" }).shots[0].props[0].kind, "sugar");
  assert.equal(milestoneScene({ kind: "stake", name: "bob" }).shots[0].props[0].kind, "coin");
  assert.equal(milestoneScene({ kind: "loyalty", name: "a-name-of-thirty-characters-xx", detail: "+10% loyalty bonus" }).shots[0].caption.split("\n")[0].length, 26, "a long line is cut");
  assert.throws(() => milestoneScene({ kind: "party", name: "x" }), /no milestone called "party"/);
  assert.match(MILESTONES.stake.said("ann.eth", "", "https://x/y.mp4"), /^Welcome in, ann\.eth\. .* https:\/\/x\/y\.mp4$/);
});

test("a name goes in only when it is plain", () => {
  const fb = shortAddress("0x1234567890abcdef1234567890abcdef12345678");
  assert.equal(fb, "0x1234...5678");
  assert.equal(safeName("ann.eth", fb), "ann.eth");
  assert.equal(safeName("vitalik.eth", fb), "vitalik.eth");
  assert.equal(safeName("my-name_1", fb), "my-name_1");
  for (const bad of [null, "", "ab", "a".repeat(21), "ann eth", "ann<b>.eth", "nsfw.eth", "100x.eth", ".eth", "émile.eth"]) assert.equal(safeName(bad, fb), fb, String(bad));
});
