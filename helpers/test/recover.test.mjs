// When a video did not come out: the cause read from the error, whether another try can help, what the writer is
// asked about a refused scene, and the line the owner gets. Each error text here is one the service really sent.
import test from "node:test";
import assert from "node:assert/strict";
import { RECOVER, clipFailure, curable, FILTER_TRAPS, RESCENE_RULES, resceneAsk, cleanRescene, lessonsBrief, recoveryText } from "../lib/recover.mjs";

const err = (message, extra = {}) => Object.assign(new Error(message), extra);

test("the cause of a failed clip, and whether to try again: rewrite for the filter, wait for a service that is slow or down, nothing for money or a login", () => {
  // 2026-10-12, clip 19: the request came back with the status nsfw
  assert.deepEqual(clipFailure(err("Higgsfield moderated the request (nsfw): nothing was made", { status: "nsfw" })), { cause: "filter", again: "rewrite" });
  // 2026-10-09: a failed status, the filter named in the detail
  assert.deepEqual(clipFailure(err("Higgsfield failed: The generated result was blocked by content safety checks. Try a different prompt", { status: "failed" })), { cause: "filter", again: "rewrite" });
  // 2026-10-08: the balance, also as a failed status
  assert.deepEqual(clipFailure(err("Higgsfield failed: Your credit balance is too low to complete this request. Please top up your balance", { status: "failed" })), { cause: "money", again: null });
  assert.deepEqual(clipFailure(err("the Higgsfield balance is empty", { budget: true })), { cause: "money", again: null });
  assert.deepEqual(clipFailure(err("Higgsfield refused the key (403)", { credentials: true })), { cause: "login", again: null });
  assert.deepEqual(clipFailure(err("Higgsfield rate limit", { rateLimited: true })), { cause: "busy", again: "wait" });
  assert.deepEqual(clipFailure(err("Higgsfield did not finish within 12 minutes (last status in_progress)", { timeout: true })), { cause: "down", again: "wait" });
  assert.deepEqual(clipFailure(err("fetch failed")), { cause: "down", again: "wait" });
  assert.deepEqual(clipFailure(err("Higgsfield answered 502 on POST /bytedance/seedance-2.5/text-to-video: bad gateway")), { cause: "down", again: "wait" });
  assert.deepEqual(clipFailure(err("Higgsfield failed: no detail", { status: "failed" })), { cause: "down", again: "wait" });
  assert.deepEqual(clipFailure(err("Higgsfield completed the request but gave no file url: {}")), { cause: "down", again: "wait" });
  // a request the service will not take is the same request a minute later
  assert.deepEqual(clipFailure(err("Higgsfield answered 422 on POST /bytedance/seedance-2.5/text-to-video: duration must be 4 to 30")), { cause: "asked", again: null });
  assert.deepEqual(clipFailure(err("Higgsfield canceled: no detail", { status: "canceled" })), { cause: "stopped", again: null });
  assert.deepEqual(clipFailure(null), { cause: "down", again: "wait" });
  assert.deepEqual(["filter", "busy", "down", "money", "login", "asked", "stopped"].filter(curable), ["filter", "busy", "down"], "what a later try can cure");
  assert.deepEqual([RECOVER.tries, RECOVER.waitSeconds, RECOVER.laterMinutes, RECOVER.laterTries], [3, 60, 90, 1]);
});

test("what the writer is asked about a refused scene: the scene, what the service said, what to look for; taken out, never disguised", () => {
  const ask = resceneAsk({ scene: "The lights go out. Fudge shouts and the room flashes white.", lookText: "Four small brownie characters. The scene is set in an old library.", error: "Higgsfield moderated the request (nsfw):\n nothing was made" });
  assert.match(ask, /^The video model refused this scene\. All it said: "Higgsfield moderated the request \(nsfw\): nothing was made"\./);
  assert.match(ask, /WHAT WENT BEFORE THE SCENE \(the look and the place, the same in every video\): Four small brownie characters\. The scene is set in an old library\./);
  assert.match(ask, /THE SCENE IT REFUSED:\nThe lights go out\. Fudge shouts and the room flashes white\./);
  assert.ok(ask.includes(FILTER_TRAPS)); assert.match(ask, /Answer with the JSON only\.$/);
  assert.ok(!/ALREADY TRIED|last try/.test(ask));
  // the second rewrite knows what the first one guessed; the last one goes plain, in the place that always passed
  const second = resceneAsk({ scene: "A scene.", error: "nsfw", guesses: ["the room going dark while Fudge shouts"], plain: true, place: "the brownies' tiny kitchen" });
  assert.match(second, /ALREADY TRIED, AND REFUSED AGAIN: the scene was rewritten after these guesses, so look elsewhere:\n- the room going dark while Fudge shouts/);
  assert.match(second, /This is the last try, so make it plain: the scene now takes place in the brownies' tiny kitchen, in bright daylight, calm and cheerful\./);
  // the standing orders say it is a removal, not a way around
  assert.match(RESCENE_RULES, /Never disguise it, never hint at it, never use a clever synonym for it: if it is gone, it is gone\./);
  assert.match(RESCENE_RULES, /\{"cause": "\.\.\.", "scene": "\.\.\."\}/);
  // the answer, checked
  assert.deepEqual(cleanRescene({ cause: "the room going dark while Fudge shouts.", scene: "The lamps glow warm. Fudge hums and the room lights up, one lamp at a time." }), { cause: "the room going dark while Fudge shouts", scene: "The lamps glow warm. Fudge hums and the room lights up, one lamp at a time." });
  assert.equal(cleanRescene({ cause: "x", scene: "too short" }), null); assert.equal(cleanRescene(null), null); assert.equal(cleanRescene("text"), null);
  assert.equal(cleanRescene({ scene: "A scene with no cause given, long enough to film." }).cause, "");
});

test("the lessons: what was taken out before a scene went through, newest kept, said to the writer before it writes", () => {
  assert.equal(lessonsBrief([]), ""); assert.equal(lessonsBrief(null), "");
  assert.equal(lessonsBrief([{ cause: "the room going dark while Fudge shouts" }, { cause: "Chip smashing the wall with the wrench" }, { cause: "the room going dark while Fudge shouts" }]),
    "THE VIDEO MODEL'S FILTER has refused harmless scenes of ours. Each time, taking this out let the scene through:\n- the room going dark while Fudge shouts\n- Chip smashing the wall with the wrench\nKeep clear of those from the first line.");
  assert.equal(lessonsBrief(Array.from({ length: 9 }, (_, i) => ({ cause: `cause ${i}` })), 3).split("\n").filter((l) => l.startsWith("- ")).join(" "), "- cause 6 - cause 7 - cause 8");
});

test("the owner's line: a clip that took more than one try, a clip that was not made and is owed a later try, and one with nothing more to try", () => {
  const what = 'episode 6, "Night Shift"';
  const refused = { attempt: 1, cause: "filter", error: "Higgsfield moderated the request (nsfw): nothing was made", guess: "the room going dark while Fudge shouts", did: "rewrite" };
  // made on the second try
  assert.equal(recoveryText({ n: 19, what, tried: [refused], made: true }),
    'Clip 19, episode 6, "Night Shift", took 2 tries and is made.\nTry 1: the video model\'s safety filter refused the scene. Sprinkle\'s guess at why: the room going dark while Fudge shouts. It wrote the scene again without that.\nThe second try was filmed.');
  // a service that did not finish, then did
  assert.equal(recoveryText({ n: 20, what: 'the trend clip "Storm"', tried: [{ attempt: 1, cause: "down", error: "Higgsfield did not finish within 12 minutes (last status in_progress)", did: "wait" }], made: true }),
    'Clip 20, the trend clip "Storm", took 2 tries and is made.\nTry 1: Higgsfield did not finish the video ("Higgsfield did not finish within 12 minutes (last status in_progress)"). It waited and sent the same scene again.\nThe second try was filmed.');
  // three refusals: one more try is owed
  const three = [refused, { attempt: 2, cause: "filter", error: "nsfw", guess: "Fudge shouting into the megaphone", did: "plain" }, { attempt: 3, cause: "filter", error: "nsfw", guess: "", did: null }];
  assert.equal(recoveryText({ n: 19, what, tried: three, made: false, laterMinutes: 90, again: "/sprinkle next makes it now." }),
    'Sprinkle could not make episode 6, "Night Shift".\nTry 1: the video model\'s safety filter refused the scene. Sprinkle\'s guess at why: the room going dark while Fudge shouts. It wrote the scene again without that.\nTry 2: the video model\'s safety filter refused the scene. Sprinkle\'s guess at why: Fudge shouting into the megaphone. It wrote a plainer scene, set in the kitchen in daylight.\nTry 3: the video model\'s safety filter refused the scene.\nIt tries once more in about 90 minutes, with a scene written from scratch. /sprinkle next makes it now. /sprinkle why shows the scenes that were refused.');
  // the later try failed too
  assert.equal(recoveryText({ n: 19, what, tried: [{ attempt: 1, cause: "down", error: "fetch failed", did: null }], made: false, wasLater: true, again: "/sprinkle next makes it now." }),
    'Sprinkle tried episode 6, "Night Shift" again and it failed again.\nTry 1: Higgsfield did not finish the video ("fetch failed").\nIt will not try again by itself today. /sprinkle next makes it now.');
  // no money: what to do, and no second try promised
  assert.equal(recoveryText({ n: 19, what, tried: [{ attempt: 1, cause: "money", error: "Higgsfield failed: Your credit balance is too low to complete this request. Please top up your balance", did: null }], made: false }),
    'Sprinkle could not make episode 6, "Night Shift".\nTry 1: the Higgsfield balance ran out ("Higgsfield failed: Your credit balance is too low to complete this request. Please top up your balance").\nTop up at higgsfield.ai, then tell me the new balance: /refill <usd>.');
});
