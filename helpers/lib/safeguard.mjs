// The safeguard's arithmetic and its words (helpers/crust.mjs reads the numbers and sends the lines).
// Three things are watched during the day: the money the brownies think with (the OpenRouter credit, and the key's
// own limit, whichever is less), the money the videos cost (the Higgsfield balance the owner set, less the clips
// made since), and the shop (open, and able to make what it sells). Once in the evening: which brownie's day went
// wrong, said in words the owner can act on. Nothing here asks a model anything.
//
// Written after 2026-10-12, when the key reached its limit with credit still on the account, every brownie stopped,
// and the first the owner heard of it was a line that said "OpenRouter answered 403".

export const DEFAULTS = {
  lowUsd: 40, criticalUsd: 15,      // the AI credit: under these many dollars
  lowDays: 3, criticalDays: 1,      // or under these many days at the week's pace
  videoLowClips: 3, videoCriticalClips: 1, clipUsd: 3, // the video credit, counted in clips; a clip's price until three were made
  smallestJobUsd: 12,               // the room the cheapest paid review asks for (Biscotti's website check)
};
const ORDER = ["ok", "low", "critical", "empty"];
/// Is level a worse than level b? An unknown level is neither.
export const worse = (a, b) => ORDER.indexOf(a) > ORDER.indexOf(b);
const usd = (n) => Number(n).toFixed(2);
const whole = (n) => (Number(n) % 1 === 0 ? String(Number(n)) : usd(n));
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/// What a day of thinking cost on average, in dollars: the days from the first one with any spend to yesterday,
/// within the days given (oldest first, today last and left out). null with fewer than three such days, since a
/// pace from one day says nothing. rows: the store's spend table lines { day, micro }.
export function pace(rows, dayKeys) {
  const days = dayKeys.slice(0, -1);
  const of = (k) => rows.filter((r) => r.day === k).reduce((a, r) => a + Number(r.micro || 0), 0);
  const first = days.findIndex((k) => of(k) > 0);
  if (first < 0) return null;
  const span = days.slice(first);
  if (span.length < 3) return null;
  return span.reduce((a, k) => a + of(k), 0) / span.length / 1e6;
}

/// The money the brownies think with. account: the brain's reading { leftUsd, limitUsd, limitLeftUsd } or null.
/// { level: ok | low | critical | empty | unknown, roomUsd, binds: "limit" | "credit", days, text }.
export function thinkingMoney(account, paceUsd = null, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  if (!account || !Number.isFinite(Number(account.leftUsd))) return { level: "unknown", text: "The AI credit could not be read." };
  const left = Math.max(0, Number(account.leftUsd));
  const hasLimit = account.limitUsd != null && account.limitLeftUsd != null;
  const limit = hasLimit ? Number(account.limitUsd) : null, limitLeft = hasLimit ? Math.max(0, Number(account.limitLeftUsd)) : null;
  const room = hasLimit ? Math.min(left, limitLeft) : left;
  const binds = hasLimit && limitLeft < left ? "limit" : "credit";
  const days = paceUsd > 0 ? room / paceUsd : null;
  const level = room < 1 ? "empty" : room < c.criticalUsd || (days !== null && days < c.criticalDays) ? "critical" : room < c.lowUsd || (days !== null && days < c.lowDays) ? "low" : "ok";
  const where = binds === "limit" ? `the key's own limit has ${usd(limitLeft)} of ${whole(limit)} left, the account has ${usd(left)}` : hasLimit ? `the account's credit; the key's own limit still has ${usd(limitLeft)}` : "the account's credit";
  const lasts = days === null ? "" : days < 1 ? ` At this week's pace of ${usd(paceUsd)} USD a day that is less than a day.` : ` At this week's pace of ${usd(paceUsd)} USD a day that is about ${plural(Math.floor(days), "day")}.`;
  const fix = binds === "limit" ? "Raise the key's limit at openrouter.ai: Settings, API Keys, edit the key." : "Add credit at openrouter.ai: Settings, Credits.";
  const text = level === "empty" ? `No brownie can think right now: ${binds === "limit" ? `the OpenRouter key has used up its own limit of ${whole(limit)} USD` : "the OpenRouter credit is used up"}. ${fix} Until then the paid reviews are turned away before any money moves.`
    : level === "critical" ? `The AI credit is almost gone: ${usd(room)} USD (${where}).${lasts} ${fix}`
    : level === "low" ? `The AI credit is getting low: ${usd(room)} USD (${where}).${lasts} ${fix}`
    : `The AI credit is fine: ${usd(room)} USD${days === null ? "" : `, about ${plural(Math.floor(days), "day")} at this week's pace`}.`;
  return { level, roomUsd: room, leftUsd: left, limitUsd: limit, limitLeftUsd: limitLeft, binds, days, paceUsd: paceUsd > 0 ? paceUsd : null, text };
}

/// The money the videos cost. higgsfield: the bill's reading { refillUsd, spentUsd, leftUsd, clips } or null when
/// the owner never said what the balance is (Higgsfield has no way to ask it).
export function videoMoney(higgsfield, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  if (!higgsfield || !(Number(higgsfield.refillUsd) > 0)) return { level: "unknown", text: "The Higgsfield balance is not set. After a top-up tell me the balance: /refill <usd>." };
  const left = Math.max(0, Number(higgsfield.leftUsd) || 0), made = Number(higgsfield.clips) || 0;
  const clipUsd = made >= 3 && Number(higgsfield.spentUsd) > 0 ? Number(higgsfield.spentUsd) / made : c.clipUsd;
  const clips = Math.floor(left / clipUsd);
  const level = clips < 1 ? "empty" : clips <= c.videoCriticalClips ? "critical" : clips <= c.videoLowClips ? "low" : "ok";
  const fix = "Top up at higgsfield.ai, then tell me the new balance: /refill <usd>.";
  const text = level === "empty" ? `Sprinkle cannot make a clip: about ${usd(left)} USD is left at Higgsfield and a clip costs about ${usd(clipUsd)}. ${fix}`
    : level === "ok" ? `The video credit is fine: about ${usd(left)} USD at Higgsfield, enough for ${plural(clips, "clip")}.`
    : `The video credit is ${level === "critical" ? "almost gone" : "getting low"}: about ${usd(left)} USD at Higgsfield, enough for ${plural(clips, "more clip")} at about ${usd(clipUsd)} each. ${fix}`;
  return { level, leftUsd: left, clipUsd, clips, text };
}

/// The shop: the catalogue it serves (GET /shop) against the money there is to make what it sells.
/// level: ok | starved (open, and no review could be made) | closed | unknown.
export function shopState(catalog, ai, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  if (!catalog || typeof catalog !== "object") return { level: "unknown", text: "The shop did not answer." };
  if (catalog.open === false) return { level: "closed", text: `The shop is closed: ${String(catalog.closedBecause || "it gives no reason").slice(0, 160)}.` };
  if (ai && ai.level !== "unknown" && ai.roomUsd < c.smallestJobUsd) return { level: "starved", text: `The shop is open, but there is ${usd(ai.roomUsd)} USD of AI credit and the smallest review needs ${whole(c.smallestJobUsd)}. Biscotti turns those orders away before any money moves.` };
  return { level: "ok", text: "The shop is open." };
}

/// What a failure note means, in plain words. The note is what the brownie wrote down when the job failed.
export function plainFailure(note) {
  const n = String(note || "");
  if (/moderated the request|content safety|blocked by .*safety|\bnsfw\b/i.test(n)) return "The video model's safety filter refused the scene. It does that to harmless scenes now and then. Nothing was made.";
  if (/credit balance is too low|top up your balance/i.test(n)) return "The Higgsfield balance ran out.";
  if (/key limit|spending limit|limit exceeded/i.test(n)) return "The AI key had reached its spending limit.";
  if (/balance is empty|insufficient|out of budget|402\b/i.test(n)) return "There was no money for it.";
  if (/rate limit|429\b|too many requests/i.test(n)) return "The service asked us to slow down.";
  if (/refused the (key|credentials)|401\b|403\b|unauthor/i.test(n)) return "The service refused our login.";
  if (/timed? ?out|did not answer|ECONN|ENOTFOUND|fetch failed|network/i.test(n)) return "The service did not answer.";
  const t = n.replace(/\s+/g, " ").trim();
  return t ? `It said: ${t.slice(0, 160)}${/[.!?]$/.test(t.slice(0, 160)) ? "" : "."}` : "It left no reason.";
}

/// The evening's account of the day. helpers: [{ name, today: [{ at, job, ok, note }] oldest first, expected }],
/// where expected says the brownie has a job every day. A line for each brownie whose tries failed, and for each
/// expected one that did nothing at all. hints: { name: { failed, silent } }, what the owner can do, added to the line.
/// { lines, text } with text "" when the day went as planned.
export function dayReport(helpers, { hints = {} } = {}) {
  const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
  const lines = [];
  const hint = (h, kind) => (hints[h.name]?.[kind] ? ` ${hints[h.name][kind]}` : "");
  for (const h of helpers) {
    const today = h.today || [];
    const fails = today.filter((j) => !j.ok), oks = today.filter((j) => j.ok);
    if (fails.length) {
      const last = fails[fails.length - 1];
      const after = oks.filter((j) => j.at > last.at).length;
      const tail = after ? `, and it made ${plural(after, "thing")} after that` : oks.length ? ", and nothing worked after it" : ", and it made nothing today";
      lines.push(`${cap(h.name)}: ${fails.length === 1 ? "one try failed" : `${fails.length} tries failed`}${tail}. ${plainFailure(last.note)}${hint(h, "failed")}`);
    } else if (h.expected && !today.length) {
      lines.push(`${cap(h.name)} did nothing today, and it has a job every day.${hint(h, "silent")}`);
    }
  }
  const text = lines.length ? `Today ${lines.length === 1 ? "one thing" : `${lines.length} things`} did not go as planned.\n${lines.map((l) => `- ${l}`).join("\n")}` : "";
  return { lines, text };
}
