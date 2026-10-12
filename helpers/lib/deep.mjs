// The full-power reviews, the part that is not secret: what is added when a review is made at full depth. The web
// is searched from several angles BEFORE the panel answers, so the models judge with evidence in hand; after the
// first answers comes a SECOND READING, where every model reads the others and says where they are wrong and what
// nobody said; open questions get a second search; specialists write the plan, the money and the build; an editor
// checks the page against its sources before it leaves. A brainstorm is shortlisted, voted on by every model on
// four criteria, checked against what exists, and its three best ideas get a one-page start sheet. A code review
// gets hunters (the strongest models, each with one lens, looking for what the panel missed), a second reading of
// every finding against the code, reproductions tried twice, and for each bug shown in the box a FIX that is itself
// proven there: the project's tests still pass and the script no longer shows the bug. Biscotti (a hidden brownie)
// runs the models and the box; this module holds the prompts, the shapes and the arithmetic.
import { cut } from "./text.mjs";

export const HIGH = { effort: "high" };
const str = (v, n = 400) => cut(String(v ?? "").replace(/\s+/g, " ").trim(), n);
const strs = (v, n = 8, len = 300) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => (typeof x === "string" ? x : JSON.stringify(x))).map((x) => str(x, len)).filter(Boolean).slice(0, n);
const num = (v, lo = 0, hi = 10) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n * 10) / 10)) : null; };
const http = (u) => (/^https?:\/\/\S+$/.test(String(u || "")) ? String(u) : null);
const text = (s, n) => String(s ?? "").replace(/\r\n/g, "\n").trim().slice(0, n);

// ---- the web, before the panel ----
export const ANGLES = {
  review: [
    { key: "competitors", ask: "the closest existing products and companies: who they are, what they charge, how big they are, and how each differs from the idea" },
    { key: "demand", ask: "the evidence of demand and its size: market numbers with their year, growth, what people pay for this today, recent funding and recent shutdowns in this space" },
    { key: "risks", ask: "what killed or hurt similar attempts, the laws and the platform rules that apply to it, and what it costs to run something like it" },
  ],
  brainstorm: [
    { key: "existing", ask: "what already exists in this space: the products, the companies, who leads, what they charge" },
    { key: "moves", ask: "what changed in this space in the last twelve months (launches, shutdowns, new rules, new tools, prices) and the gaps that people complain about" },
  ],
};
export const SEARCH_SYSTEM = `You have a web search tool. A person paid for a serious piece of work on the text below, and you cover ONE angle of the research for it. Search several times, with different words, and read what you find. Answer with JSON only:
{"found": [{"name": "the product, company, law or source", "url": "https://...", "what": "what it is, in one clause", "detail": "the price, the size, the date or the fact that matters here"}], "facts": [{"claim": "a number or a fact, with its year", "source": "https://..."}], "notes": "three or four plain sentences on what this angle shows"}
Rules: only what you actually found, each with its link; at most 8 found and 8 facts; an empty list is a fine answer and better than a guess; plain ASCII; no markdown.`;
export const searchPrompt = (input, angle) => `THE TEXT:\n${cut(input, 3500)}\n\nYOUR ANGLE: ${angle.ask}.\n\nSearch now and answer as JSON.`;
export const searchShape = (j) => ({
  found: (Array.isArray(j?.found) ? j.found : []).map((c) => ({ name: str(c?.name, 90), url: http(c?.url), what: str(c?.what, 200), detail: str(c?.detail, 240) })).filter((c) => c.name).slice(0, 8),
  facts: (Array.isArray(j?.facts) ? j.facts : []).map((m) => ({ claim: str(m?.claim, 260), source: http(m?.source) })).filter((m) => m.claim).slice(0, 8),
  notes: str(j?.notes, 700),
});
/// Several angles into one piece of research: { found, facts, notes: { angle: text }, failed: [angles that did not answer] }.
export function mergeResearch(parts) {
  const found = [], facts = [], notes = {}, failed = [];
  const key = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  for (const p of parts) {
    if (!p?.answer) { failed.push(p?.angle); continue; }
    for (const f of p.answer.found) if (!found.some((x) => (f.url && x.url === f.url) || key(x.name) === key(f.name))) found.push({ ...f, angle: p.angle });
    for (const f of p.answer.facts) if (!facts.some((x) => key(x.claim) === key(f.claim))) facts.push(f);
    if (p.answer.notes) notes[p.angle] = p.answer.notes;
  }
  return { found: found.slice(0, 18), facts: facts.slice(0, 18), notes, failed: failed.filter(Boolean) };
}

// ---- the second reading of an idea ----
export const SECOND_REVIEW_SYSTEM = `You are one reviewer on a panel of several AI models from different labs. You reviewed an idea alone. Now you read what every other reviewer wrote (each one named) and the web research, and you answer once more, with JSON only:
{"score": 0 to 10, your score now (10 = build it now), "moved": "one sentence: why your score moved, or why it did not", "agree": ["up to four points the panel shares and you stand behind, each one concrete"], "disagree": [{"with": "the reviewer's name exactly as given", "point": "what they said", "why": "why it is wrong or thin, concretely"}], "missed": ["up to three things that matter for the decision and that no reviewer said"], "kill": "the single strongest reason not to build this", "save": "the single change that would most improve its odds"}
Rules: do not be polite and do not converge for the sake of it; change your mind only for a reason you can state; when a reviewer said something wrong, unsupported by the research, or vague, name them in disagree; plain ASCII; no markdown; never invent numbers or names.`;
export const secondReviewPrompt = (input, research, answered, me) => `THE IDEA:\n${input}\n\nTHE WEB RESEARCH:\n${JSON.stringify(research)}\n\nYOUR OWN FIRST REVIEW (${me.name}):\n${JSON.stringify(me.answer)}\n\nTHE OTHER REVIEWERS:\n${answered.filter((p) => p.name !== me.name).map((p) => `### ${p.name} (score ${p.answer.score ?? "none"})\n${JSON.stringify(p.answer)}`).join("\n\n")}\n\nYour second reading, as JSON.`;
export const secondReviewShape = (j) => (j && typeof j === "object" && (j.kill || j.moved || j.score != null) ? {
  score: num(j.score), moved: str(j.moved, 300), agree: strs(j.agree, 4, 260),
  disagree: (Array.isArray(j.disagree) ? j.disagree : []).map((d) => ({ with: str(d?.with, 60), point: str(d?.point, 260), why: str(d?.why, 320) })).filter((d) => d.with && d.why).slice(0, 5),
  missed: strs(j.missed, 3, 300), kill: str(j.kill, 400), save: str(j.save, 400),
} : null);

// ---- the open questions, searched ----
export const OPEN_SYSTEM = `You have a web search tool. A panel of AI models reviewed an idea and left open questions. Pick the six that matter most for the decision and that a search can answer, search for each, and answer with JSON only:
{"answers": [{"question": "the question, in a few words", "answer": "two or three plain sentences with what you found", "sources": ["https://..."]}], "only_you": ["up to five questions that only the founder can answer, as the panel put them"]}
Rules: an answer needs at least one source you actually opened; when the search shows nothing, say "nothing found" as the answer; plain ASCII; no markdown; never invent a number or a link.`;
export const openPrompt = (input, questions) => `THE IDEA:\n${cut(input, 3000)}\n\nTHE OPEN QUESTIONS OF THE PANEL:\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\nSearch now and answer as JSON.`;
export const openShape = (j) => ({
  answers: (Array.isArray(j?.answers) ? j.answers : []).map((a) => ({ question: str(a?.question, 200), answer: str(a?.answer, 600), sources: (Array.isArray(a?.sources) ? a.sources : []).map(http).filter(Boolean).slice(0, 4) })).filter((a) => a.question && a.answer).slice(0, 6),
  only_you: strs(j?.only_you, 5, 240),
});
/// The questions worth a search: the reviewers' own, what they could not judge, what the second reading says was missed.
export function openQuestions(answered, second) {
  const seen = new Set(), out = [];
  const add = (q) => { const s = str(q, 240); const k = s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 8).join(" "); if (s && !seen.has(k)) { seen.add(k); out.push(s); } };
  for (const p of second) for (const m of p.answer.missed) add(m);
  for (const p of answered) for (const q of p.answer.questions || []) add(q);
  for (const p of answered) for (const q of p.answer.unknowns || []) add(q);
  return out.slice(0, 24);
}

// ---- the specialists of an idea review ----
export const SPECIALISTS = [
  { key: "plan", heading: "The first 30 days", ask: `Write THE FIRST 30 DAYS for this idea: week by week, the smallest thing to build or to do, how the first ten users or customers are found (the channel, the words, the place), what is measured, and the decision on day 30 with its numbers (go on, change, stop). One short paragraph of setup, then four lines starting "Week 1:", "Week 2:", "Week 3:", "Week 4:", then one line starting "Day 30:".` },
  { key: "money", heading: "The money", ask: `Write THE MONEY for this idea: who pays and for what, the first price to test and why that one, what it costs to run (each cost as a range, with the assumption behind it), and what must be true for it to pay for itself. Mark every number: "(from the research: link)" when it comes from the research, "(an assumption)" when it is yours. Never present an assumption as a fact.` },
  { key: "build", heading: "The build", ask: `Write THE BUILD for the first version of this idea: the tools and the parts, what to buy or reuse and what to make, the riskiest part and the cheap test that proves or kills it first, and a rough time for each part for one person. Name real tools only when you are sure they exist.` },
];
export const SPECIALIST_SYSTEM = `You are a specialist called in by a panel of AI models that reviewed an idea for a founder who paid for it. You get the idea, the panel's reviews, their second reading and the web research. You write ONE part of the report, in plain Markdown: short paragraphs and lines, no heading of your own, no tables, no HTML, 250 to 400 words. Speak to the founder as "you". Short sentences, one idea each. Plain ASCII only, no em dashes, no emoji. Be specific to this idea: a plan that would fit any idea is worthless. Never invent a number, a name or a link.`;
export const specialistPrompt = (input, research, answered, second, s) => `THE IDEA:\n${input}\n\nTHE WEB RESEARCH:\n${JSON.stringify(research)}\n\nTHE PANEL (${answered.length} reviewers):\n${answered.map((p) => `### ${p.name} (score ${p.answer.score ?? "none"})\n${JSON.stringify({ verdict: p.answer.verdict, risks: p.answer.risks, build_first: p.answer.build_first, drop: p.answer.drop })}`).join("\n\n")}\n\nTHE SECOND READING:\n${second.map((p) => `### ${p.name}\n${JSON.stringify({ kill: p.answer.kill, save: p.answer.save, missed: p.answer.missed })}`).join("\n\n")}\n\nYOUR PART: ${s.ask}`;

// ---- the page of a full idea review ----
export const REVIEW_SECTIONS = ["The verdict", "Where the panel agrees", "Where the panel disagrees", "The second reading", "The strongest objection", "What to build first", "What to drop", "Who else does this", "The numbers", "Answers to the open questions", "Questions only you can answer", "The first 30 days", "The money", "The build", "Next steps"];
export const REVIEW_WRITE_SYSTEM = `You are Biscotti, the review brownie of the Brownies studio. You write the final report of an idea review that a founder paid for. You get the idea, the web research made before the panel answered, the reviews of a panel of AI models (each one named), their second reading (after each one read the others), and the answers a second search gave to the panel's open questions. Write the report in Markdown with exactly these fifteen sections, in this order, each as a "## " heading with exactly this text:
${REVIEW_SECTIONS.map((s) => `## ${s}`).join("\n")}
Rules: "The verdict" is four to six sentences and names the lowest, the highest and the median score out of 10 AFTER the second reading, and says how the scores moved; "Where the panel disagrees" names the models and the reason of each side; "The second reading" says who changed their mind and why, what the panel says nobody had seen, and quotes the sharpest disagreement with the two names; "The strongest objection" is the one reason not to build it that the most reviewers gave, and the change that would answer it; "Who else does this" and "The numbers" come ONLY from the research and the answers, each line with its link, and you say plainly when nothing was found; "Answers to the open questions" is the list of questions with the answer and its link; "Questions only you can answer" is a short list; under "The first 30 days", "The money" and "The build" write NOTHING, not one word: specialists wrote those and the system puts them there; "Next steps" is three short lines, then one line: the brownies can build the first version, the landing page with a waitlist, a bot or a contract on a quote, through the shop. Speak to the founder as "you". Short sentences, one idea each. Plain ASCII only, no em dashes, no emoji, no tables, no HTML. Do not repeat the idea back at length. Never invent a number, a name, a link or a model's opinion. About 1,200 to 1,700 words in your own sections.`;
export const reviewWritePrompt = (input, research, answered, second, open) => `THE IDEA:\n${input}\n\nTHE WEB RESEARCH (before the panel):\n${JSON.stringify(research)}\n\nTHE PANEL, FIRST REVIEWS (${answered.length} models):\n${answered.map((p) => `### ${p.name} (score ${p.answer.score ?? "none"})\n${JSON.stringify(p.answer)}`).join("\n\n")}\n\nTHE SECOND READING (${second.length} models):\n${second.map((p) => `### ${p.name} (score now ${p.answer.score ?? "none"})\n${JSON.stringify(p.answer)}`).join("\n\n")}\n\nTHE ANSWERS TO THE OPEN QUESTIONS:\n${JSON.stringify(open)}\n\nWrite the report now.`;

// ---- the editor ----
export const EDITOR_SYSTEM = `You are the last reader of a report before it goes to a paying customer. You get the report and everything it was written from. Find what must not go out, and answer with JSON only:
{"problems": [{"quote": "the exact words on the page, a short span", "why": "what is wrong: no source in the material, contradicts the material, a model is misquoted, a number is presented as fact but is an assumption, or the sentence says nothing"}]}
Rules: at most 12 problems, the worst first; only real ones: a claim that the material supports is not a problem; an empty list is the right answer for a clean page; plain ASCII; no markdown.`;
export const editorPrompt = (page, material) => `THE REPORT:\n${page}\n\nTHE MATERIAL IT WAS WRITTEN FROM:\n${material}\n\nYour list, as JSON.`;
export const editorShape = (j) => (Array.isArray(j?.problems) ? j.problems : []).map((p) => ({ quote: str(p?.quote, 240), why: str(p?.why, 300) })).filter((p) => p.quote && p.why).slice(0, 12);
export const REWRITE_SYSTEM = `You wrote a report and the last reader found problems in it. Fix every one: correct the claim from the material, or remove it; never replace it with another unsupported claim. Keep every "## " heading exactly as it is and in the same order, keep the sections that must stay empty empty, keep everything that was not named. Answer with the WHOLE report in Markdown and nothing else.`;
export const rewritePrompt = (page, problems, material) => `YOUR REPORT:\n${page}\n\nTHE PROBLEMS:\n${problems.map((p, i) => `${i + 1}. "${p.quote}": ${p.why}`).join("\n")}\n\nTHE MATERIAL:\n${material}\n\nThe whole report again, fixed.`;

// ---- the brainstorm at full depth ----
export const IDEAS_SYSTEM = `You are one of several AI models from different labs brainstorming for a person who paid for it. They give a topic, a market, a skill, a problem or a wish, with any limits they have (money, time, place, team). You also get web research on what already exists there. Propose exactly ten ideas for them, each a thing they could actually start, as JSON only:
{"ideas": [{"name": "three to six words", "what": "one or two sentences: what it is and for whom", "who_pays": "who pays and for what", "why_now": "why this could work now", "first_step": "the first thing to do in a week, with no code if possible", "risk": "the thing most likely to kill it", "score": 0 to 10, how strong you think it is}]}
Rules: specific to the input; nothing generic ("build an app for X" is not an idea); do not propose what the research shows already exists unless you say the twist; a mix of safe and bold, at least two bold ones; stay inside the limits they gave; short sentences; plain ASCII; no markdown; never invent numbers.`;
export const ideasPrompt = (input, research) => `THE INPUT:\n${input}\n\nTHE WEB RESEARCH ON THE SPACE:\n${JSON.stringify(research)}\n\nYour ten ideas, as JSON.`;
export const ideasShape = (j) => {
  const ideas = (Array.isArray(j?.ideas) ? j.ideas : []).map((i) => ({ name: str(i?.name, 80), what: str(i?.what, 340), who_pays: str(i?.who_pays, 180), why_now: str(i?.why_now, 220), first_step: str(i?.first_step, 220), risk: str(i?.risk, 180), score: num(i?.score) })).filter((i) => i.name && i.what).slice(0, 10);
  return ideas.length >= 3 ? { ideas } : null;
};
export const SHORTLIST_SYSTEM = `You get the ideas of a panel of AI models for one person's brainstorm, each model named. Merge them into one shortlist, as JSON only:
{"candidates": [{"id": 1, "name": "three to six words", "what": "one or two sentences: what it is and for whom", "who_pays": "who pays and for what", "first_step": "the first thing to do in a week", "risk": "the thing most likely to kill it", "proposed_by": ["the models' names as given, every one that had this idea or something close"]}]}
Rules: the same idea from several models becomes ONE candidate with the clearest wording among them and every proposer named; keep the distinct ones, and keep a bold idea even when one model alone had it; between 12 and 20 candidates, ids 1 to n; do not add ideas of your own; plain ASCII; no markdown.`;
export const shortlistPrompt = (input, answered) => `THE INPUT:\n${cut(input, 2500)}\n\nTHE PANEL (${answered.length} models, ${answered.reduce((a, p) => a + p.answer.ideas.length, 0)} ideas):\n${answered.map((p) => `### ${p.name}\n${JSON.stringify(p.answer.ideas)}`).join("\n\n")}\n\nThe shortlist, as JSON.`;
export const shortlistShape = (j) => {
  const c = (Array.isArray(j?.candidates) ? j.candidates : []).map((x) => ({ name: str(x?.name, 80), what: str(x?.what, 340), who_pays: str(x?.who_pays, 180), first_step: str(x?.first_step, 220), risk: str(x?.risk, 180), proposed_by: strs(x?.proposed_by, 12, 60) })).filter((x) => x.name && x.what).slice(0, 20).map((x, i) => ({ id: i + 1, ...x }));
  return c.length >= 5 ? c : null;
};
/// When the shortlist does not come back: every idea of every model, the same name folded, the most proposed first.
export function shortlistFallback(answered) {
  const by = new Map();
  for (const p of answered) for (const i of p.answer.ideas) {
    const k = i.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const had = by.get(k);
    if (had) { if (!had.proposed_by.includes(p.name)) had.proposed_by.push(p.name); had.sum += i.score ?? 5; }
    else by.set(k, { name: i.name, what: i.what, who_pays: i.who_pays, first_step: i.first_step, risk: i.risk, proposed_by: [p.name], sum: i.score ?? 5 });
  }
  return [...by.values()].sort((a, b) => b.proposed_by.length - a.proposed_by.length || b.sum - a.sum).slice(0, 20).map(({ sum, ...x }, i) => ({ id: i + 1, ...x }));
}
export const CRITERIA = ["demand", "start", "edge", "money"];
export const VOTE_IDEAS_SYSTEM = `You are one of several AI models from different labs judging a shortlist of ideas for a person who paid for a brainstorm. You get their input, the web research and the shortlist. Score EVERY candidate on four things, each 0 to 10, and answer with JSON only:
{"votes": [{"id": 1, "demand": 0 to 10 (do people want this enough to pay), "start": 0 to 10 (can THIS person start it with what they said they have), "edge": 0 to 10 (is there a reason they win against what exists), "money": 0 to 10 (paying customers within a year)}], "top": [the ids of your three best, the best first], "wild": the id of the boldest one worth a try, "why": "one sentence on your first pick"}
Rules: score against the person's own limits, not in general; an idea the research shows is already crowded scores low on edge unless its twist is real; use the whole range, most ideas are 3 to 7; plain ASCII; no markdown.`;
export const voteIdeasPrompt = (input, research, candidates) => `THE INPUT:\n${cut(input, 2500)}\n\nTHE WEB RESEARCH:\n${JSON.stringify(research)}\n\nTHE SHORTLIST:\n${JSON.stringify(candidates.map(({ proposed_by, ...c }) => c))}\n\nYour votes, as JSON.`;
export const voteIdeasShape = (j) => {
  const votes = (Array.isArray(j?.votes) ? j.votes : []).map((v) => ({ id: Number(v?.id), demand: num(v?.demand), start: num(v?.start), edge: num(v?.edge), money: num(v?.money) })).filter((v) => Number.isInteger(v.id) && CRITERIA.every((c) => v[c] != null));
  return votes.length ? { votes, top: (Array.isArray(j?.top) ? j.top : []).map(Number).filter(Number.isInteger).slice(0, 3), wild: Number.isInteger(Number(j?.wild)) ? Number(j.wild) : null, why: str(j?.why, 260) } : null;
};
/// The votes summed: every candidate with its mean on each criterion, its total out of 40, how many models put it in
/// their three best (and first), how many called it the wild one, and the spread of its totals (how much they argued).
export function rankIdeas(candidates, voters) {
  const round = (n) => Math.round(n * 10) / 10;
  const out = candidates.map((c) => {
    const mine = voters.map((v) => v.answer.votes.find((x) => x.id === c.id)).filter(Boolean);
    const mean = Object.fromEntries(CRITERIA.map((k) => [k, mine.length ? round(mine.reduce((a, v) => a + v[k], 0) / mine.length) : 0]));
    const totals = mine.map((v) => CRITERIA.reduce((a, k) => a + v[k], 0));
    return { ...c, ...mean, total: mine.length ? round(totals.reduce((a, b) => a + b, 0) / mine.length) : 0, voters: mine.length, top3: voters.filter((v) => v.answer.top.includes(c.id)).length, first: voters.filter((v) => v.answer.top[0] === c.id).length, wild: voters.filter((v) => v.answer.wild === c.id).length, spread: totals.length ? round(Math.max(...totals) - Math.min(...totals)) : 0, firstBy: voters.filter((v) => v.answer.top[0] === c.id).map((v) => ({ name: v.name, why: v.answer.why })) };
  });
  return out.sort((a, b) => b.total - a.total || b.top3 - a.top3 || b.first - a.first);
}
export const EXISTS_SYSTEM = `You have a web search tool. For each idea below, search for the closest thing that already exists, and answer with JSON only:
{"checks": [{"id": the idea's id, "exists": [{"name": "...", "url": "https://...", "what": "what it does in one clause", "price": "its price when you found one, else empty"}], "note": "one sentence: crowded, a few players, or nothing close found"}]}
Rules: only what you actually found, each with its link; at most three per idea; "exists": [] when nothing close shows up; plain ASCII; no markdown.`;
export const existsPrompt = (input, ideas) => `THE PERSON'S INPUT (for context):\n${cut(input, 1200)}\n\nTHE IDEAS:\n${JSON.stringify(ideas.map((c) => ({ id: c.id, name: c.name, what: c.what })))}\n\nSearch now and answer as JSON.`;
export const existsShape = (j) => (Array.isArray(j?.checks) ? j.checks : []).map((c) => ({ id: Number(c?.id), exists: (Array.isArray(c?.exists) ? c.exists : []).map((e) => ({ name: str(e?.name, 80), url: http(e?.url), what: str(e?.what, 200), price: str(e?.price, 80) })).filter((e) => e.name && e.url).slice(0, 3), note: str(c?.note, 200) })).filter((c) => Number.isInteger(c.id));
export const SHEET_SYSTEM = `You write the start sheet of ONE idea for a person who paid for a brainstorm. You get their input, the idea as the panel shortlisted it, how the panel voted, and what already exists close to it. Write plain Markdown, no heading of your own, exactly these seven lines, each starting with its label in bold, each one to three sentences:
**First customer:** who exactly, and where to find five of them this week.
**The offer and the price to test:** what they get, the first price and why that one.
**Week one:** what to do, with no code if possible.
**Month one:** what must be true by day 30 to go on.
**What it costs to start:** the real costs as ranges, each marked "(an assumption)" unless the material gives it.
**Numbers to watch:** two or three.
**What kills it, and the cheap test:** the one risk and how to check it before spending.
Rules: specific to this person and their limits; speak to them as "you"; short sentences; plain ASCII only, no em dashes, no emoji; never invent a name, a link or a number presented as fact.`;
export const sheetPrompt = (input, idea, check) => `THE PERSON'S INPUT:\n${cut(input, 2500)}\n\nTHE IDEA:\n${JSON.stringify({ name: idea.name, what: idea.what, who_pays: idea.who_pays, first_step: idea.first_step, risk: idea.risk })}\n\nTHE PANEL'S VOTE: ${idea.total} out of 40 (demand ${idea.demand}, can start ${idea.start}, edge ${idea.edge}, money ${idea.money}); ${idea.top3} of ${idea.voters} models put it in their three best.\n\nWHAT EXISTS CLOSE TO IT:\n${JSON.stringify(check || { exists: [], note: "not searched" })}\n\nThe sheet now.`;
export const IDEAS_SECTIONS = ["The brief", "The ten ideas", "The three to start with", "The wild cards", "Where the panel argued", "What to do next"];
export const IDEAS_WRITE_SYSTEM = `You are Biscotti, the review brownie of the Brownies studio. You write the page of a brainstorm a person paid for. A panel of AI models proposed ideas; they were merged into a shortlist; every model scored every candidate on four things; the best ten were searched on the web and the best three got a start sheet. You get the input, the research on the space, the ranked shortlist with its votes, and the checks. Write Markdown with exactly these six sections, in this order, each as a "## " heading with exactly this text:
${IDEAS_SECTIONS.map((s) => `## ${s}`).join("\n")}
Rules: "The brief" is one short paragraph: what you understood of the input and its limits, and two sentences on what the research says about the space, with a link when the research has one; under "The ten ideas" and under "The three to start with" write NOTHING, not one word: the system puts the ranked list and the sheets there; "The wild cards" are the two candidates the most models named as the bold one worth a try, with why they might work and what would have to be true, by their names; "Where the panel argued" names the two or three candidates with the widest spread between the models' totals and says what the fight is about; "What to do next" is three short lines, then one line: pick one idea and the brownies review it with the same panel in the shop, as "An idea review". Speak to the person as "you". Short sentences. Plain ASCII only, no em dashes, no emoji, no tables, no HTML. Never invent a number, a name or a link. About 350 to 550 words.`;
export const ideasWritePrompt = (input, research, ranked, checks) => `THE INPUT:\n${input}\n\nTHE RESEARCH ON THE SPACE:\n${JSON.stringify(research)}\n\nTHE SHORTLIST, RANKED BY THE PANEL'S VOTES (total out of 40; top3 = how many models put it in their three best; wild = how many called it the bold one; spread = the gap between the highest and the lowest total a model gave it):\n${JSON.stringify(ranked.map(({ firstBy, ...c }) => c))}\n\nTHE CHECKS OF THE BEST TEN:\n${JSON.stringify(checks)}\n\nWrite the page now.`;
/// The ten ideas as Markdown, in the panel's order: what it is, who pays, the vote, who proposed it, what exists, the first step.
export function ideasBlock(ranked, checks, voters) {
  return ranked.slice(0, 10).map((c, i) => {
    const check = checks.find((x) => x.id === c.id);
    const exists = check?.exists?.length ? check.exists.map((e) => `[${e.name}](${e.url})${e.price ? ` (${e.price})` : ""}: ${e.what}`).join("; ") : check ? `nothing close was found${check.note ? ` (${check.note})` : ""}` : "not searched";
    return `${i + 1}. **${c.name}.** ${c.what} ${c.who_pays ? `Who pays: ${c.who_pays}` : ""}\n   The panel: ${c.total} out of 40 (demand ${c.demand}, can start ${c.start}, edge ${c.edge}, money ${c.money}). ${c.top3} of ${voters} models put it in their three best${c.first ? `, ${c.first} put it first` : ""}.\n   Proposed by: ${c.proposed_by.join(", ") || "the panel"}.\n   Already out there: ${exists}.\n   First step: ${c.first_step}\n   The risk: ${c.risk}`;
  }).join("\n\n");
}

// ---- the code review at full depth ----
export const LENSES = [
  { key: "security", name: "security and money", ask: "who can call what and with whose authority, missing checks on inputs and on callers, injections, secrets and keys, replays and double spends, races on balances and on state, arithmetic and rounding that loses or creates value, anything a stranger can break or steal" },
  { key: "failure", name: "failure and concurrency", ask: "what happens when a call fails half way, on a timeout, on a retry, on a restart or with two requests at once: partial writes, state left wrong, errors swallowed, locks and queues, resources that leak, lists and files that grow without bound" },
  { key: "logic", name: "logic and edges", ask: "wrong results on boundary values and empty inputs, off-by-one, wrong assumptions between two modules, defaults that are unsafe, time and time zones, text encodings, tests that assert nothing or cannot fail" },
];
export const HUNT_SYSTEM = `You are a hunter on a code review that a developer paid for. A panel of AI models already reviewed this code and their findings are listed. Your job is to find what they MISSED, through one lens only. You get the request, the tree, the output of the project's own tests and the source files, each one after a line "===== path". Read the code line by line through your lens and answer with JSON only, in this shape:
{"summary": "one sentence on the state of the code through your lens", "score": 0 to 10 (10 = nothing to find), "tests": "", "strengths": [], "findings": [{"title": "five to ten words", "severity": "critical" | "high" | "medium" | "low", "file": "the path as given", "line": the line number or null, "what": "what is wrong, in plain words", "why_it_matters": "what it costs: money, data, a crash, a wrong answer", "failure_case": "the concrete input or state that triggers it and what goes wrong, step by step", "fix": "what to change, concretely"}]}
Rules: do NOT repeat a finding of the panel; at most 10 findings, the worst first; only things you can point to in the code, with a failure case concrete enough to turn into a script; trace each one through the code before you write it, and drop it if the code handles it somewhere; an empty list is the right answer for clean code; critical = money or data lost or anyone can break it, high = wrong results or a crash on normal use, medium = a bug on an edge, low = a weakness; plain ASCII; no markdown; never invent a line that is not there.`;
export const huntPrompt = (input, lens, already) => `YOUR LENS: ${lens.name}: ${lens.ask}.\n\nWHAT THE PANEL ALREADY FOUND (do not repeat):\n${already.length ? already.map((f) => `- ${f.title} (${f.file || "no file"}${f.line ? `:${f.line}` : ""})`).join("\n") : "- nothing"}\n\n${input}`;
export const JUDGE_SYSTEM = `You are on the second reading of a code review a developer paid for. A panel of AI models reported findings and they were merged into one list. For EACH finding, open the code it points to, trace the failure case, and judge it. You get the source files, each one after a line "===== path", and the findings. Answer with JSON only:
{"verdicts": [{"id": the finding's id, "verdict": "real" | "not real" | "unsure", "why": "one or two sentences that point at the code: the line that fails, or the line that already handles it"}]}
Rules: "real" only when you traced the failure case and it happens as written; "not real" only when you can name the code that prevents it; "unsure" when it depends on something outside the code you were given; a verdict for every id; do not be swayed by how many models reported it; plain ASCII; no markdown.`;
export const judgePrompt = (input, findings) => `THE FINDINGS:\n${JSON.stringify(findings.map((f) => ({ id: f.id, title: f.title, severity: f.severity, file: f.file, line: f.line, what: f.what, failure_case: f.failure_case })))}\n\n${input}\n\nYour verdicts, as JSON.`;
export const judgeShape = (j) => (Array.isArray(j?.verdicts) ? j.verdicts : []).map((v) => ({ id: Number(v?.id), verdict: ["real", "not real", "unsure"].includes(String(v?.verdict || "").toLowerCase()) ? String(v.verdict).toLowerCase() : "unsure", why: str(v?.why, 320) })).filter((v) => Number.isInteger(v.id));
/// The second reading on each finding: f.second = { real, not_real, unsure, notes }, and f.disputed when more readers
/// (two at least) say the code handles it than say it is real.
export function tallyVerdicts(findings, readers) {
  for (const f of findings) {
    const mine = readers.map((r) => ({ name: r.name, v: r.verdicts.find((x) => x.id === f.id) })).filter((x) => x.v);
    const n = (k) => mine.filter((x) => x.v.verdict === k).length;
    f.second = { real: n("real"), not_real: n("not real"), unsure: n("unsure"), readers: mine.length, notes: mine.filter((x) => x.v.why).map((x) => `${x.name} (${x.v.verdict}): ${x.v.why}`) };
    f.disputed = f.second.not_real >= 2 && f.second.not_real > f.second.real;
  }
  return findings;
}
export const secondLine = (f) => (f.second?.readers ? `${f.second.real} of ${f.second.readers} readers say it is real${f.second.not_real ? `, ${f.second.not_real} say the code handles it` : ""}${f.second.unsure ? `, ${f.second.unsure} unsure` : ""}.` : "not read a second time");
export const RETRY_SYSTEM = `Your reproduction script for a finding of a code review did not show the bug. You get the finding, the file it points to, your script, and what the box printed when it ran. Either the script is wrong (a bad import, a wrong path, a case that does not match the finding) or the code is right. Answer with JSON only: {"content": "the whole corrected script"} or {"concede": "one or two sentences: the code is right on this case, and the line that shows it"}.
The script's contract is unchanged: it prints a line starting with BUG REPRODUCED: and exits 0 when the bug shows, a line starting with NOT REPRODUCED: and exits 2 when the code behaves correctly; it never modifies the repository's files, never uses the network, finishes in under 60 seconds, catches its own errors. Under 80 lines, plain ASCII, no markdown fences. Do not bend the script until it prints the marker: a script that fakes the bug is worse than no script.`;
export const retryPrompt = (how, path, f, file, script, output) => `THE PROJECT: the script is ${how}; its path is ${path}.\n\nTHE FINDING:\n${JSON.stringify({ title: f.title, file: f.file, line: f.line, what: f.what, failure_case: f.failure_case })}\n\nTHE FILE ${f.file}:\n${file}\n\nYOUR SCRIPT:\n${script}\n\nWHAT THE BOX PRINTED:\n${cut(output, 2500)}\n\nAnswer now, as JSON.`;
export const FIX_SYSTEM = `You fix ONE finding of a code review in a repository. A script run in a box showed the bug. You get the finding, that script, and the whole content of the file to change. Answer with JSON only:
{"files": [{"path": "the path exactly as given", "content": "the WHOLE new content of the file"}], "note": "two sentences: what you changed and why it removes the bug"}
Rules: the smallest change that removes the bug and keeps every other behaviour; do not reformat, rename or tidy anything else; keep the file's own style, indentation and line endings; change only the file you were given; never change a test to make it pass; your fix is applied in the box, where the project's own tests must still pass and the script must stop showing the bug. When no safe small fix exists inside that one file, answer {"files": [], "note": "why"}.`;
export const fixPrompt = (f, path, content, script) => `THE FINDING:\n${JSON.stringify({ title: f.title, severity: f.severity, file: f.file, line: f.line, what: f.what, failure_case: f.failure_case, fix: f.fix })}\n\nTHE SCRIPT THAT SHOWS IT:\n${script}\n\nTHE FILE ${path} (whole):\n${content}\n\nYour fix, as JSON.`;
export const fixShape = (j, allowed) => {
  const files = (Array.isArray(j?.files) ? j.files : []).map((x) => ({ path: String(x?.path || "").replace(/^\.\//, ""), content: typeof x?.content === "string" ? x.content : "" })).filter((x) => /^[\w./-]{1,200}$/.test(x.path) && !x.path.includes("..") && x.content.length > 0 && (!allowed || allowed.includes(x.path))).slice(0, 2);
  return { files, note: str(j?.note, 400) };
};
/// The findings of a full code review as Markdown: what the panel said, the second reading, the box, the fix and its proof.
export function codeFindingsBlock(F, panelSize, { box, patchesHref = null } = {}) {
  if (!F.length) return "The panel found nothing it could point to with a concrete failure case.";
  const fix = (f) => { const x = f.fix_result; if (!x) return null; if (x.status === "proven") return `YES. With the patch applied in the box the project's tests ${x.testsExit === 0 ? "pass" : "end as before"} and the script no longer shows the bug. ${x.note}${patchesHref ? ` [The patch](${patchesHref}#fix-${f.id}).` : ""}`; if (x.status === "bug still shows") return `a patch was tried and the script still showed the bug, so no patch is given. ${x.note}`; if (x.status === "tests broke") return `a patch was tried and it broke the project's tests, so no patch is given. ${x.note}`; if (x.status === "no patch") return `no automatic patch: ${x.note}`; return `the patch could not be tried in the box: ${x.note}`; };
  return F.map((f) => [`### ${f.id}. ${f.title} (${f.severity})`, `**Where:** ${f.file || "not given"}${f.line ? `, line ${f.line}` : ""}`, f.what, `**Why it matters:** ${f.why_it_matters}`, `**How it fails:** ${f.failure_case}`, `**The second reading:** ${secondLine(f)}`, box ? `**Reproduced in the box:** ${box(f)}` : null, fix(f) ? `**Fix proven in the box:** ${fix(f)}` : null, `**Fix:** ${f.fix}`, `**Found by:** ${f.found_by.join(", ")} (${f.found_by.length} of ${panelSize})`].filter(Boolean).join("\n\n")).join("\n\n");
}
/// What the box said of a finding's script, in a line for the page.
export function boxLine(f) {
  const r = f.reproduced;
  if (!r) return "not tried";
  const line = (re) => cut(r.output.split("\n").find((l) => re.test(l)) || r.output, 240);
  if (r.status === "confirmed") return `YES, a script in the box showed it${r.tries > 1 ? " (on the second try)" : ""}: ${line(/BUG REPRODUCED/)}`;
  if (r.status === "not reproduced") return `NO, the script found the code behaving correctly on this case: ${line(/NOT REPRODUCED/)}. The finding stays as the panel's claim.`;
  if (r.status === "no script") return `no script: ${r.output}`;
  return `the script could not run: ${cut(r.output.split("\n").filter(Boolean).pop() || "no output", 200)}`;
}
/// The sections of a full code review page, and what is added to the writer's rules for them.
export const CODE_SECTIONS = ["The verdict", "The findings", "Disputed on the second reading", "What the tests say", "Where the panel disagrees", "What to fix first", "Next steps"];
export const CODE_WRITE_MORE = `\nThis review was made at full depth, so there is more to say. The page has one more section, "## Disputed on the second reading", right after "## The findings"; under it too write NOTHING: the system lists there the findings that most second readers say the code already handles. Each finding carries "second" (how many readers, after reading the code again, say it is real, say the code handles it, or are unsure), "reproduced" (the box) and "fix" (proven: a patch was applied in the box, the project's tests still passed and the script stopped showing the bug). In "The verdict" also say how many findings the second reading holds real and how many it disputes, and how many fixes were proven in the box. In "Where the panel disagrees" use the second readers' reasons. In "What to fix first" put first the findings that are reproduced and have a proven fix. About 500 to 750 words.`;
export const lightFindings = (F) => F.map((f) => ({ id: f.id, title: f.title, severity: f.severity, file: f.file, line: f.line, what: f.what, found_by: f.found_by, second: f.second ? { real: f.second.real, handles_it: f.second.not_real, unsure: f.second.unsure, reasons: f.second.notes.slice(0, 4) } : null, disputed: Boolean(f.disputed), reproduced: f.reproduced?.status || "not tried", fix: f.fix_result?.status || "none" }));
/// The patches as one Markdown file: each under a heading with an anchor the page links to.
export function patchesText(F) {
  const proven = F.filter((f) => f.fix_result?.status === "proven" && f.fix_result.patch);
  if (!proven.length) return "";
  return [`# The patches`, "", `Each one was applied in the box: the project's own tests still passed and the script that showed the bug stopped showing it. Read each before you apply it; apply with "git apply" or by hand.`, "", ...proven.flatMap((f) => [`<a id="fix-${f.id}"></a>`, "", `## ${f.id}. ${f.title}`, "", f.fix_result.note, "", "```diff", text(f.fix_result.patch, 60_000), "```", ""])].join("\n");
}
