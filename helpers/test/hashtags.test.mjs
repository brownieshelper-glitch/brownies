// Hashtags per network: the trend's tags first, the evergreen ones after, each network's limit kept, no coin word
// in a cartoon tag, one brand tag on X, "#Shorts" never doubled on YouTube.
import test from "node:test";
import assert from "node:assert/strict";
import { tagsFor, withTags, cleanTag, LIMITS } from "../lib/hashtags.mjs";

test("the trend's tags come first and the evergreen ones fill up to the network's limit", () => {
  const trend = { hashtags: ["#TellMeWithoutTellingMe", "#storytime", "#crypto", "#tellmewithouttellingme", "bad tag", "#fyp"] };
  assert.deepEqual(tagsFor("tiktok", { trend }), ["#TellMeWithoutTellingMe", "#storytime", "#fyp", "#brownies", "#cartoon"]);
  assert.deepEqual(tagsFor("instagram", { trend }), ["#TellMeWithoutTellingMe", "#storytime", "#fyp", "#brownies", "#cartoon"]);
  assert.deepEqual(tagsFor("youtube", { trend }), ["#TellMeWithoutTellingMe", "#storytime", "#fyp", "#brownies"]);
  assert.deepEqual(tagsFor("facebook", { trend }), ["#TellMeWithoutTellingMe", "#storytime", "#fyp"]);
  assert.deepEqual(tagsFor("x", { trend }), ["#brownies"], "X: the brand tag only, never a trend's");
  assert.deepEqual(tagsFor("tiktok"), ["#brownies", "#cartoon", "#animation", "#funny", "#comedy"], "an episode without a trend");
  assert.deepEqual(tagsFor("youtube", { trend: { hashtags: ["#shorts", "#Shorts"] } }), ["#brownies", "#cartoon", "#animation", "#funny"], "#Shorts is added by the Short itself");
  assert.deepEqual(tagsFor("tiktok", { cartoon: false }), ["#brownies", "#ai", "#ethereum"], "a video about the project keeps its own set");
  for (const [p, n] of Object.entries(LIMITS)) assert.ok(tagsFor(p, { trend }).length <= n, p);
});

test("cleanTag and withTags", () => {
  assert.equal(cleanTag(" #Hello_1 "), "#Hello_1"); assert.equal(cleanTag("##x"), null); assert.equal(cleanTag("#with space"), null); assert.equal(cleanTag("plain"), "#plain");
  assert.equal(withTags("A caption. #old #tags", ["#new", "#ones"]), "A caption.\n\n#new #ones");
  assert.equal(withTags("Just words", []), "Just words");
});
