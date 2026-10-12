// When a video did not come out: why, whether another try can help, and how that try is made. The brownie that
// films (the video maker) calls these; the reasons and the words live here, with nothing secret in them.
//
// Written after 2026-10-12: the video model's safety filter refused a harmless episode, the second time in nineteen
// clips, and the video maker wrote one line in the log and made nothing until the next day. The owner: "next time
// he doesn't work let's be sure an agent checks why, and finds a solution to make him realize the video".
//
// What is done about each cause:
//   filter  the scene is read again by the writer, who says what probably tripped the filter and writes the scene
//           without it (taken out, never disguised); the last try is a plainer scene in the place that always passed
//   busy    the service asked us to slow down: a wait, then the same scene
//   down    the service did not finish (a timeout, a network error, a failed render with no word on the scene):
//           a wait, then the same scene; a video that was only slow is waited for again, never asked for twice
//   money, login, asked (the request itself was not accepted), stopped (somebody cancelled it): no second try,
//           the owner is told what to do
// When every try of the moment failed for a cause that time can cure, one more is owed later in the day.

export const RECOVER = {
  tries: 3,          // tries at filming one clip, the first one included
  waitSeconds: 60,   // before the same scene is sent again (twice as long after a rate limit)
  laterMinutes: 90,  // when the tries of the moment all failed: one more try this much later
  laterTries: 1,
  owedHours: 12,     // a clip owed for longer than this is dropped (the next day's job makes the episode)
  lessons: 6,        // how many past causes the writer is reminded of
};

/// Why a clip was not made, from the error the video service threw.
/// { cause: filter | busy | down | money | login | asked | stopped, again: "rewrite" | "wait" | null }
export function clipFailure(e) {
  const m = String(e?.message || e || "");
  const status = String(e?.status || "").toLowerCase();
  if (e?.credentials || /refused the (key|credentials)|\b401\b|unauthori[sz]ed/i.test(m)) return { cause: "login", again: null };
  if (e?.budget || /credit balance is too low|top up your balance|balance is empty|insufficient (credit|balance|funds)/i.test(m)) return { cause: "money", again: null };
  if (status === "nsfw" || status === "moderated" || /moderated the request|content safety|safety (check|filter|system)|\bnsfw\b|content policy|sensitive content|try a different prompt/i.test(m)) return { cause: "filter", again: "rewrite" };
  if (e?.rateLimited || /rate limit|\b429\b|too many requests/i.test(m)) return { cause: "busy", again: "wait" };
  if (status === "canceled" || status === "cancelled") return { cause: "stopped", again: null };
  if (/answered 4\d\d\b/.test(m)) return { cause: "asked", again: null };
  return { cause: "down", again: "wait" };
}

/// Can time alone cure it? (Then a later try is worth owing.)
export const curable = (cause) => cause === "filter" || cause === "busy" || cause === "down";

const WHY = {
  filter: "the video model's safety filter refused the scene",
  busy: "Higgsfield asked us to slow down",
  down: "Higgsfield did not finish the video",
  money: "the Higgsfield balance ran out",
  login: "Higgsfield refused our login",
  asked: "Higgsfield did not accept the request",
  stopped: "the request was cancelled at Higgsfield",
};
const TODO = {
  money: "Top up at higgsfield.ai, then tell me the new balance: /refill <usd>.",
  login: "Check the Higgsfield key in the helpers env file on the server.",
  asked: "That is ours to fix in the code, not yours.",
};

/// What such filters are known to take badly, even in a harmless cartoon. The writer reads this when it looks for
/// the cause; nothing here is a way around a filter, it is a list of things to take out.
export const FILTER_TRAPS = "anything that can read as violence or injury (hitting, smashing, crashing, exploding, shooting, fighting, a hard fall, weapons, blood, fire, screaming); fear and darkness (a blackout, a pitch-dark room, flashing or strobing light); anything that can read as a body or undressing (bare, naked, stripping, a bed, a shower, a bath, licking, touching; swimwear, a pool or a beach with bodies in it, a gym or sport body); anything medical (a wound, a needle, a hospital); anything that can read as children (kids, boys, girls, babies, a school, a classroom, a playground); real people, brands, logos, songs; drugs, alcohol, smoking";

/// The writer's standing orders for a second scene.
export const RESCENE_RULES = `Your task now: an AI video model refused one of our scenes. Find the likely cause and write the scene again. Answer with JSON, nothing else around it: {"cause": "...", "scene": "..."}.
- cause: one plain sentence, under 160 characters, naming what in the scene most likely tripped the filter. Name the thing itself ("the room going dark while Fudge shouts"), not a category.
- scene: the scene again, with that thing taken out or replaced by something plainly harmless. Never disguise it, never hint at it, never use a clever synonym for it: if it is gone, it is gone. Keep the same beats in the same order and the same length, so the captions written for the first scene still fit. The four brownies are the actors (their look is given to the model separately, do not repeat it). Nothing written in the picture. No real person, no brand, no logo.`;

/// What the writer is asked about one refused scene. `guesses`: the causes it named on the earlier tries of this
/// same clip (they did not help). `plain`: the last try, a plainer scene in `place`.
export function resceneAsk({ scene, lookText = "", error = "", guesses = [], plain = false, place = "" }) {
  return [
    `The video model refused this scene. All it said: "${String(error).replace(/\s+/g, " ").trim().slice(0, 200)}".`,
    lookText ? `WHAT WENT BEFORE THE SCENE (the look and the place, the same in every video): ${lookText}` : "",
    `THE SCENE IT REFUSED:\n${scene}`,
    guesses.length ? `ALREADY TRIED, AND REFUSED AGAIN: the scene was rewritten after these guesses, so look elsewhere:\n${guesses.map((g) => `- ${g}`).join("\n")}` : "",
    `Such filters refuse harmless cartoons over a single word or picture. What they are known to take badly: ${FILTER_TRAPS}.`,
    plain ? `This is the last try, so make it plain: the scene now takes place in ${place || "the brownies' tiny kitchen"}, in bright daylight, calm and cheerful. Keep the joke's beats, drop every picture that could be misread, and say so in the cause.` : "",
    "Answer with the JSON only.",
  ].filter(Boolean).join("\n\n");
}

/// The writer's answer, checked: { cause, scene } or null. The scene's own rules (length, coin words) are the
/// video maker's to check; here only the shape.
export function cleanRescene(p) {
  if (!p || typeof p !== "object") return null;
  const plain = (t, max) => String(t || "").replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
  const scene = plain(p.scene, 1000);
  if (scene.length < 20) return null;
  return { cause: plain(p.cause, 200).replace(/[.]+$/, ""), scene };
}

/// What the writer is told before it writes a new scene: what was taken out of refused scenes before they passed.
/// lessons: [{ cause }] newest last.
export function lessonsBrief(lessons = [], max = RECOVER.lessons) {
  const list = [...new Set((Array.isArray(lessons) ? lessons : []).map((l) => String(l?.cause || "").trim()).filter(Boolean))].slice(-max);
  if (!list.length) return "";
  return `THE VIDEO MODEL'S FILTER has refused harmless scenes of ours. Each time, taking this out let the scene through:\n${list.map((c) => `- ${c}`).join("\n")}\nKeep clear of those from the first line.`;
}

const ORD = ["", "first", "second", "third", "fourth", "fifth"];
const ord = (n) => ORD[n] || `${n}th`;

/// One try, said plainly: what went wrong and what was done about it.
function tryLine(t) {
  const why = WHY[t.cause] || "something went wrong at Higgsfield";
  const said = t.cause === "filter" || !t.error ? "" : ` ("${String(t.error).replace(/\s+/g, " ").trim().slice(0, 110)}")`;
  const guess = t.guess ? ` Sprinkle's guess at why: ${t.guess}.` : "";
  const did = t.did === "rewrite" ? " It wrote the scene again without that." : t.did === "plain" ? " It wrote a plainer scene, set in the kitchen in daylight." : t.did === "wait" ? " It waited and sent the same scene again." : t.did === "resume" ? " It went on waiting for the same video." : "";
  return `Try ${t.attempt}: ${why}${said}.${guess}${did}`;
}

/// The line the owner gets when a clip needed more than one try, or was not made.
///   what: 'episode 6, "Night Shift"'; tried: [{ attempt, cause, error, guess, did }] (the failed tries, in order);
///   made: was it filmed in the end; laterMinutes: when one more try is owed (0: none); wasLater: this WAS the later
///   try; again: what the owner can type to have it made now ("" when there is nothing to type).
export function recoveryText({ n = null, what, tried = [], made, laterMinutes = 0, wasLater = false, again = "" }) {
  const lines = tried.map(tryLine);
  if (made) {
    const total = tried.length + 1;
    return [`Clip ${n}, ${what}, took ${total} tries and is made.`, ...lines, `The ${ord(total)} try was filmed.`].join("\n");
  }
  const last = tried[tried.length - 1] || {};
  const head = wasLater ? `Sprinkle tried ${what} again and it failed again.` : `Sprinkle could not make ${what}.`;
  const next = laterMinutes > 0 ? `It tries once more in about ${laterMinutes} minutes, with a scene written from scratch.`
    : TODO[last.cause] ? TODO[last.cause]
    : "It will not try again by itself today.";
  const tail = [next, again, tried.some((t) => t.cause === "filter") ? "/sprinkle why shows the scenes that were refused." : ""].filter(Boolean).join(" ");
  return [head, ...lines, tail].join("\n");
}
