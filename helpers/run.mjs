// The brownies' runtime: one long-running process that runs the four helpers on their schedule.
//
//   node run.mjs                                   settings from HELPERS_ENV (default /etc/brownies/helpers.env)
//
//   Fudge  posts on X at the configured hours, checks mentions every 20 minutes
//   Crumb  listens on Telegram (long polling), answers within a minute, reports once an hour per chat
//   Nib    writes one research note a day into the repository (notes/YYYY-MM-DD.md)
//   Chip   checks its tasks every 30 minutes, opens pull requests, merges small ones after three reviews
//
// Every finished job is reported to the gateway (POST /api/team/log) and the Kitchen shows it. The owner gets a
// Telegram alert when a helper is out of budget, a service refuses the credentials, or the service restarts.
// MODE=prelaunch thinks through OpenRouter with a daily cap per helper; MODE=live thinks through the gateway with
// each helper's own wallet key and SUGAR balance. There is no dry mode: what runs here posts for real.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readEnvFile, settings, describe, offList } from "./lib/env.mjs";
import { RealClock } from "./lib/clock.mjs";
import { Store } from "./lib/store.mjs";
import { Scheduler } from "./lib/scheduler.mjs";
import { Gateway } from "./lib/gateway.mjs";
import { Brain } from "./lib/brain.mjs";
import { XClient } from "./lib/xapi.mjs";
import { Telegram } from "./lib/telegram.mjs";
import { GitHub } from "./lib/github.mjs";
import { Alerts } from "./lib/alerts.mjs";
import { loadFacts, HELPERS } from "./lib/facts.mjs";
import { sendSummary } from "./lib/summary.mjs";
import { Admin } from "./lib/admin.mjs";
import { Recruit } from "./lib/recruit.mjs";
import { Bakery } from "./lib/bakery.mjs";
import { JobsApi, totalsView, money as moneyFmt, OPEN as OPEN_JOB_STATES, STATE_LABEL as JOB_STATE } from "./lib/moneyjobs.mjs";
import { Studio } from "./lib/studio.mjs";
import { youtubeFromEnv } from "./lib/youtube.mjs";
import { TikTok, TikTokAuth } from "./lib/tiktok.mjs";
import { Instagram } from "./lib/instagram.mjs";
import { LinkedIn } from "./lib/linkedin.mjs";
import { Connect } from "./lib/connect.mjs";
import { Clips } from "./lib/clips.mjs";
import { existsSync } from "node:fs";
import { Fudge } from "./helpers/fudge.mjs";
import { listText as suggestionsList } from "./lib/suggestions.mjs";
import { Crumb } from "./helpers/crumb.mjs";
import { Nib } from "./helpers/nib.mjs";
import { Chip } from "./helpers/chip.mjs";

// every log line also goes into a ring the control room can read
export const RING = [];
const log = (...a) => { const line = [new Date().toISOString(), ...a.map((x) => (typeof x === "string" ? x : JSON.stringify(x)))].join(" "); console.log(line); RING.push(line); if (RING.length > 400) RING.shift(); };

/// The contract addresses, from a file or a URL, as a block for the facts. "" when there is no deployment yet.
async function addressesBlock(src) {
  try {
    const j = /^https?:/.test(src) ? await (await fetch(src)).json() : JSON.parse(readFileSync(src, "utf8"));
    const names = ["token", "staking", "sugar", "minter", "harvester", "teamVault", "skillRegistry"];
    const rows = names.filter((k) => /^0x[0-9a-fA-F]{40}$/.test(j[k] || "")).map((k) => `- ${k}: ${j[k]}`);
    return rows.length ? `\n## Addresses (Ethereum, from deployments/1.json)\n\n${rows.join("\n")}\n` : "";
  } catch (e) {
    log(`[helpers] no deployment addresses yet (${e.message.slice(0, 60)})`);
    return "";
  }
}

/// Builds the whole thing from the settings and the config. Returned so a test or a REPL can hold the parts.
export async function build({ env = process.env, configFile = null } = {}) {
  const S = settings(env);
  const config = JSON.parse(readFileSync(configFile || S.configFile || new URL("./brownies.json", import.meta.url), "utf8"));
  // helpers that are not public yet live in private.json (gitignored): same shape, plus "module" and "hidden"
  const privateFile = S.privateFile || new URL("./private.json", import.meta.url);
  const priv = existsSync(privateFile) ? JSON.parse(readFileSync(privateFile, "utf8")) : { helpers: {} };
  for (const [name, c] of Object.entries(priv.helpers || {})) config.helpers[name] = c;
  const clock = new RealClock();
  const store = new Store(S.dbPath, { tz: config.timezone || "UTC" });
  const gateway = new Gateway({ url: S.gatewayUrl, teamKey: S.teamLogKey, log });
  const telegram = new Telegram({ token: S.telegram.token, log });
  const alerts = new Alerts({ telegram, ownerChatId: S.telegram.ownerChatId, store, clock, mode: S.mode, log });
  const brain = new Brain({ mode: S.mode, openrouterKey: S.openrouterKey, openrouterUrl: S.openrouterUrl, gateway, keys: S.keys, mnemonic: S.mnemonic, chainId: config.chainId || 1, helpers: config.helpers, store, clock, alerts, log });
  const x = new XClient({ ...S.x, clock, log });
  const github = new GitHub({ token: S.github.token, repo: S.github.repo, log });
  const youtube = youtubeFromEnv(env, { log }); // the project's channel (lib/youtube.mjs); Sprinkle uploads there when it is configured
  const tiktok = new TikTok({ clientKey: S.tiktok.clientKey, clientSecret: S.tiktok.clientSecret, redirectUri: `${S.gatewayUrl}/tiktok/callback`, store, clock, log }); // lib/tiktok.mjs; connected by the owner with /tiktok
  // Instagram and LinkedIn, connected by the owner with /instagram and /linkedin; the clip links give Instagram a public address for a finished video
  const instagram = new Instagram({ appId: S.instagram.appId, appSecret: S.instagram.appSecret, login: S.instagram.login, redirectUri: `${S.gatewayUrl}/instagram/callback`, store, clock, log });
  const linkedin = new LinkedIn({ clientId: S.linkedin.clientId, clientSecret: S.linkedin.clientSecret, version: S.linkedin.version, redirectUri: `${S.gatewayUrl}/linkedin/callback`, store, clock, log });
  const clips = new Clips({ store, clock, baseUrl: S.gatewayUrl, dir: priv.helpers?.sprinkle?.videosDir || env.VIDEOS_DIR || "/var/lib/brownies/videos", log });
  const facts = loadFacts() + (await addressesBlock(S.deploymentJson));
  const deps = (name) => ({ config: config.helpers[name] || {}, brain, gateway, store, clock, alerts, facts, log });
  const chip = new Chip({ ...deps("chip"), github, telegram, ownerChatId: S.telegram.ownerChatId });
  const fudge = new Fudge({ ...deps("fudge"), x, siteUrl: S.siteUrl, telegram, ownerChatId: S.telegram.ownerChatId });
  const crumb = new Crumb({ ...deps("crumb"), telegram, github, siteUrl: S.siteUrl, groupChatId: S.telegram.groupChatId, ownerChatId: S.telegram.ownerChatId, onDecision: (id, d, ctx) => { const a = store.approval(id); const h = a ? all[a.helper] : null; return (h && typeof h.decide === "function" ? h : chip).decide(id, d, ctx); }, onNote: (id, t) => chip.addNote(id, t), onButton: (data, ctx) => { const h = all[String(data).split(":")[0]]; return h && typeof h.onButton === "function" ? h.onButton(data, ctx) : null; } });
  const nib = new Nib({ ...deps("nib"), github, siteUrl: S.siteUrl, rpcUrl: S.rpcUrl });
  // the recruits: brownies hired at runtime by Dough (lib/hiring.mjs), kept as specs in the store, never as code
  const all = { fudge, crumb, nib, chip };
  const recruitNames = () => String(store.getMeta("recruits", "")).split(",").filter(Boolean);
  const recruitDeps = (spec) => ({ ...deps(spec.name), telegram, github, ownerChatId: S.telegram.ownerChatId, groupChatId: S.telegram.groupChatId, spec });
  for (const name of recruitNames()) {
    const raw = store.getMeta(`recruit:${name}`);
    if (!raw) continue;
    const spec = JSON.parse(raw);
    if (spec.retired) continue;
    config.helpers[name] = { role: spec.role, model: spec.model, dailyCapUsd: spec.dailyCapUsd, hidden: spec.hidden, walletIndex: spec.walletIndex, payFrom: spec.payFrom };
    all[name] = new Recruit(recruitDeps(spec));
  }
  const off = offList(env); // HELPERS_OFF="fudge" keeps a helper quiet for now: built, shown in the health line, but no job runs
  const W = { S, config, clock, store, gateway, telegram, alerts, brain, x, github, youtube, tiktok, instagram, linkedin, clips, helpers: all, scheduler: null, off, hidden: [], startedAt: Date.now(), requestRestart: null };
  // a hire or a retirement changes the schedule in place: the retired brownie's jobs are dropped, a new one's are
  // added, and the scheduler is started again, which recomputes every next run (the day's flags keep a slot that
  // already ran from running twice). No process restart, so the pages and the bot keep answering.
  const reschedule = (why, { drop = null } = {}) => {
    const s = W.scheduler; if (!s) return;
    const running = !s.stopped;
    if (running) s.stop();
    if (drop) s.jobs = s.jobs.filter((j) => j.helper !== drop);
    for (const h of Object.values(all)) if (h.recruit && !s.jobs.some((j) => j.helper === h.name)) for (const j of h.jobs()) s.add(j);
    if (running) s.start();
    log(`[helpers] ${why}: schedule reloaded, ${s.jobs.length} jobs`);
  };
  const hire = async (spec) => {
    const names = recruitNames().filter((n) => n !== spec.name);
    store.setMeta(`recruit:${spec.name}`, JSON.stringify(spec));
    store.setMeta("recruits", [...names, spec.name].join(","));
    config.helpers[spec.name] = { role: spec.role, model: spec.model, dailyCapUsd: spec.dailyCapUsd, hidden: spec.hidden, walletIndex: spec.walletIndex, payFrom: spec.payFrom };
    const r = new Recruit(recruitDeps(spec));
    all[spec.name] = r;
    reschedule(`hired ${spec.name}`);
    return r;
  };
  const fire = async (name) => {
    const raw = store.getMeta(`recruit:${name}`);
    if (!raw || !all[name]?.recruit) return false;
    store.setMeta(`recruit:${name}`, JSON.stringify({ ...JSON.parse(raw), retired: Date.now() }));
    store.setMeta("recruits", recruitNames().filter((n) => n !== name).join(","));
    delete all[name];
    reschedule(`retired ${name}`, { drop: name });
    return true;
  };
  const recruits = () => Object.values(all).filter((h) => h.recruit);
  const roster = () => Object.entries(all).map(([name, h]) => ({ name, role: config.helpers[name]?.role || h.role || "" }));
  // the private helpers, by module (Dough among them, with the hiring hands)
  for (const [name, c] of Object.entries(priv.helpers || {})) {
    const mod = await import(new URL(c.module, import.meta.url));
    const Cls = mod.default || Object.values(mod).find((v) => typeof v === "function" && v.prototype?.jobs);
    all[name] = new Cls({ ...deps(name), telegram, github, youtube, tiktok, instagram, linkedin, clips, hfCredentials: S.hfCredentials, ownerChatId: S.telegram.ownerChatId, groupChatId: S.telegram.groupChatId, hire, fire, recruits, roster });
  }
  if (all.patch) chip.patch = all.patch; // Chip merges nothing the tests refuse
  if (all.zest) all.zest.team = all; // a picked opening reaches the brownie that prepares it
  if (all.swirl) all.swirl.team = all; // a trend's version is made by Sprinkle or Fudge
  if (all.sprinkle) all.sprinkle.team = all; // a clip approved by the owner goes to X through Fudge
  // bounties, hackathons and audit contests (helpers/contests.mjs, hidden with Zest): Chip prepares the entries, the owner approves
  const contestsFile = new URL("./helpers/contests.mjs", import.meta.url);
  if (existsSync(contestsFile)) { const { Contests } = await import(contestsFile); chip.contests = new Contests({ chip, github, store, clock, telegram, ownerChatId: S.telegram.ownerChatId, log, siteUrl: S.siteUrl }); }
  const names = Object.keys(all);
  const hidden = names.filter((n) => all[n].hidden);
  W.hidden = hidden;
  // the owner's private commands: /glaze <what> asks the hidden helper for a draft; /summary sends today's summary now
  crumb.onOwnerCommand = async (cmd, text) => {
    if (cmd === "admin") { const code = W.admin?.newCode(); return code ? `Your control room code: ${code}\nIt works for ten minutes at ${S.siteUrl}/admin.html` : "The control room is not ready yet."; }
    if (cmd === "hire") { if (!all.dough) return "There is no hiring brownie yet."; if (!text) return "Tell me the job: /hire <what the new brownie should do>"; const r = await all.dough.onRequest(text); return r ? true : "Dough could not make that hire (budget, ceiling, or an unusable spec). The log says why."; }
    if (cmd === "fire") { if (!all.dough) return "There is no hiring brownie yet."; if (!text) return `Which one? Recruits: ${recruits().map((r) => r.name).join(", ") || "none"}`; const ok = await all.dough.fire(text.toLowerCase().trim()); return ok ? true : `${text} is not a recruit.`; }
    if (cmd === "tiktok") {
      if (!W.tiktok.configured) return "TikTok is not set up: TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET are empty in the helpers env.";
      const sub = text.trim().toLowerCase();
      if (sub === "status" || (!sub && W.tiktok.connected)) { let t = W.tiktok.tokens(); if (t && !t.display_name) { try { const me = await W.tiktok.me(); W.tiktok.saveTokens({ ...t, display_name: me.display_name || null }); t = W.tiktok.tokens(); } catch { /* shown by id */ } } return t ? `TikTok is connected (${t.display_name || t.username || t.open_id}).\nScopes: ${t.scope}.\n/tiktok test puts the latest video in your inbox as a draft. /tiktok link connects again.` : "TikTok is not connected. Send /tiktok link."; }
      if (sub === "test") { if (!all.sprinkle?.tiktokLatest) return "There is no video brownie here."; const r = await all.sprinkle.tiktokLatest(); return r ? true : "No finished video to send, or TikTok refused it. Check the log."; }
      return `Open this link, log in to TikTok with the Brownies account and allow the app:\n${W.tiktokAuth.link()}\nIt works once, for ten minutes.`;
    }
    if (cmd === "instagram") {
      if (!W.instagram.configured) return "Instagram is not set up: INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET are empty in the helpers env.";
      const sub = text.trim().toLowerCase();
      if (sub === "status" || (!sub && W.instagram.connected)) { const t = W.instagram.tokens(); return t ? `Instagram is connected (@${t.username || t.user_id}, ${t.account_type || "professional"} account), ${W.instagram.daysLeft() == null ? "through the Brownies Page, no expiry" : W.instagram.daysLeft() + " days of access left, renewed by itself"}.\nEvery cartoon episode and trend clip that goes to TikTok goes up as a reel too; memes go up as pictures. /instagram test posts the latest clip now. /instagram link connects again.` : "Instagram is not connected. Send /instagram link."; }
      if (sub === "test") { if (!all.sprinkle?.instagramLatest) return "There is no video brownie here."; const r = await all.sprinkle.instagramLatest(); return r ? `Posted on Instagram${r.url ? ": " + r.url : ""}.` : "No finished clip to send, or Instagram refused it. Check the log."; }
      return W.instagram.facebook
        ? `Open this link, log in to Facebook with your own account (the one that manages the Brownies Page), tick the Brownies Page and the Brownies Instagram account when asked, and allow:\n${W.instagramAuth.link()}\nIt works once, for ten minutes.`
        : `Open this link, log in to Instagram with the Brownies account (a business or creator account) and allow the app:\n${W.instagramAuth.link()}\nIt works once, for ten minutes.`;
    }
    if (cmd === "linkedin") {
      if (!W.linkedin.configured) return "LinkedIn is not set up: LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET are empty in the helpers env.";
      const sub = text.trim().toLowerCase();
      if (sub === "status" || (!sub && W.linkedin.connected)) { const t = W.linkedin.tokens(); return t ? `LinkedIn is connected (${t.name || "the profile"}), ${W.linkedin.daysLeft()} days of access left (LinkedIn gives 60; Truffle asks for a new link in time).\n/truffle shows the posting. /linkedin link connects again.` : "LinkedIn is not connected. Send /linkedin link."; }
      return `Open this link, log in to LinkedIn with your own profile and allow the app:\n${W.linkedinAuth.link()}\nIt works once, for ten minutes.`;
    }
    if (cmd === "truffle") { if (!all.truffle) return "There is no LinkedIn brownie here."; const r = await all.truffle.onRequest(text); return r === true ? true : (r || "Truffle could not do that now; check the log."); }
    if (cmd === "zest") { if (!all.zest) return "There is no scout here."; const r = await all.zest.onRequest(text || "hunt"); return r ? true : "Zest could not scout now (budget or an error). Check the log."; }
    if (cmd === "jobs") {
      const t = totalsView(store);
      const open = store.moneyJobs({ limit: 300 }).filter((j) => j.state === "found" || OPEN_JOB_STATES.has(j.state)).slice(0, 12);
      return [`The board: ${t.found} found and not picked, ${t.open} in progress, ${t.won} won, ${t.paid} paid, ${moneyFmt(t.earnedUsd)} earned.`, ...open.map((j) => `${j.id}. [${JOB_STATE[j.state]}] ${j.title}${j.expectedUsd ? `, up to ${moneyFmt(j.expectedUsd)}` : ""}${j.ownerAction ? ` -> you: ${j.ownerAction}` : ""}`), `Pick: /zest pick <number>. Everything: ${S.siteUrl}/jobs.html`].join("\n");
    }
    if (cmd === "cap") {
      const [who = "", usd = ""] = text.split(/\s+/);
      if (!all[who.toLowerCase()]) return `Which brownie? /cap <name> <usd a day>. Names: ${names.join(", ")}.`;
      const r = await W.admin.command({ helper: who.toLowerCase(), action: "cap", value: usd });
      return r.ok ? `${who[0].toUpperCase() + who.slice(1).toLowerCase()}'s cap is now ${r.capUsd} USD a day.` : r.error;
    }
    if (cmd === "summary") { await sendSummary({ store, clock, telegram, ownerChatId: S.telegram.ownerChatId, helpers: names, caps: Object.fromEntries(names.map((n) => [n, config.helpers[n]?.dailyCapUsd])), mode: S.mode, hidden, log }); return true; }
    if (cmd === "suggestions") return suggestionsList(store, S.siteUrl);
    if (cmd === "fudge") { if (!text) return `Tell Fudge what to post: /fudge <what>. Or /fudge replies auto|approve|off|status for the answers on X (now: ${fudge.repliesMode()}).`; const r = await fudge.onRequest(text); return typeof r === "string" ? r : r ? true : "Fudge could not write that one now (budget, the cap, or an error). Check the log."; }
    if (all[cmd]?.onRequest) { if (!text) return `Tell ${cmd} what to draft: /${cmd} <what>`; const r = await all[cmd].onRequest(text); return r ? true : `${cmd} could not write that one now (budget or an error). Check the log.`; }
    return undefined; // not a command of ours: Crumb answers it like any message
  };
  const scheduler = new Scheduler({ clock, tz: config.timezone || "UTC", flags: store, log });
  scheduler.add({ id: "team-summary", helper: "team", daily: { hours: [config.summaryHour ?? 22], minute: 0 }, run: () => sendSummary({ store, clock, telegram, ownerChatId: S.telegram.ownerChatId, helpers: names, caps: Object.fromEntries(names.map((n) => [n, config.helpers[n]?.dailyCapUsd])), mode: S.mode, hidden, log }).catch((e) => log(`[summary] failed: ${e.message}`)) });
  for (const h of Object.values(all)) if (!off.includes(h.name)) for (const j of h.jobs()) scheduler.add(j);
  W.scheduler = scheduler;
  // the control room: the owner's page talks to it through /admin/*; a paused helper skips its scheduled runs
  const summaryNow = () => sendSummary({ store, clock, telegram, ownerChatId: S.telegram.ownerChatId, helpers: names, caps: Object.fromEntries(names.map((n) => [n, config.helpers[n]?.dailyCapUsd])), mode: S.mode, hidden, log });
  const origins = [S.siteUrl, "https://feedthebrownies.com", "https://www.feedthebrownies.com", /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/, ...S.adminOrigins];
  W.admin = new Admin({ W, ring: RING, log, wallets: S.adminWallets, origins, sendSummary: summaryNow });
  // the Bakery: holders bake their own brownies through /bake/* (lib/bakery.mjs); before the launch only the admin wallets may, to test it
  W.jobs = new JobsApi({ store, log }); // the money jobs board, read by the public page through /jobs/*
  W.studio = new Studio({ store, clock, telegram, ownerChatId: S.telegram.ownerChatId, config: config.studio || {}, siteUrl: S.siteUrl, log }); // the studio's intake, /studio/*
  if (all.zest) all.zest.studio = W.studio; // a studio job's proposal quotes the offer
  W.bakery = new Bakery({ W, log, origins, hire, fire, recruits, roster, config: config.bakery || {}, adminWallets: S.adminWallets, rpcUrl: S.rpcUrl, deploymentJson: S.deploymentJson });
  crumb.onHolderCommand = (cmd, rest, ctx) => W.bakery.holderCommand(cmd, rest, ctx); // /link and /mybrownie from holders' private chats
  // TikTok: /tiktok in the owner's chat gives a one-time link; the browser comes back to /tiktok/callback with the code
  W.tiktokAuth = new TikTokAuth({ tiktok, store, clock, log, baseUrl: S.gatewayUrl, onConnected: async (me) => { if (telegram.configured && S.telegram.ownerChatId) await telegram.sendMessage(S.telegram.ownerChatId, `TikTok is connected (${me.name}). From now on the vertical copy of every finished video lands in your TikTok inbox as a draft to post from the app. /tiktok test sends the latest one now.`).catch(() => {}); } });
  W.instagramAuth = new Connect({ name: "instagram", client: instagram, store, clock, log, baseUrl: S.gatewayUrl, onConnected: async (me) => { if (telegram.configured && S.telegram.ownerChatId) await telegram.sendMessage(S.telegram.ownerChatId, `Instagram is connected (${me.name}${me.account_type ? ", " + me.account_type.toLowerCase() + " account" : ""}). From now on every cartoon episode and trend clip that goes to TikTok goes up as a reel too, and memes as pictures. /instagram test posts the latest clip now.`).catch(() => {}); } });
  W.linkedinAuth = new Connect({ name: "linkedin", client: linkedin, store, clock, log, baseUrl: S.gatewayUrl, onConnected: async (me) => { if (telegram.configured && S.telegram.ownerChatId) await telegram.sendMessage(S.telegram.ownerChatId, `LinkedIn is connected (${me.name}). Truffle writes one post a day about the business for your Approve; /truffle post writes one now, /truffle profile drafts your headline and About, /truffle learn and /truffle study teach it the voice you like.`).catch(() => {}); } });
  scheduler.isOff = (name) => W.admin.isPaused(name);
  return W;
}

async function main() {
  readEnvFile(process.env.HELPERS_ENV || "/etc/brownies/helpers.env");
  const W = await build();
  const { S, store, gateway, brain, scheduler, helpers, alerts } = W;
  log(`[helpers] MODE=${S.mode}, gateway ${S.gatewayUrl}, db ${S.dbPath}`);
  log(`[helpers] settings: ${describe()}`);
  if (S.mode === "live") for (const h of Object.keys(W.helpers)) if (brain.keys[h]) log(`[helpers] ${h} wallet ${brain.address(h)} (add it to the team vault)`);
  if (W.hidden.length) log(`[helpers] hidden (not announced): ${W.hidden.join(", ")}`);
  if (!W.x.configured) log("[helpers] X is not configured: Fudge will not post");
  if (!W.telegram.configured) log("[helpers] Telegram is not configured: Crumb will not listen and no alerts go out");
  if (!W.github.configured) log("[helpers] GitHub is not configured: Nib keeps its notes in the store, Chip has no tasks");
  log(W.youtube?.configured ? "[helpers] YouTube is connected: finished videos go up unlisted, the owner publishes" : "[helpers] YouTube is not configured: videos stay in Telegram");
  log(!W.tiktok.configured ? "[helpers] TikTok is not configured" : W.tiktok.connected ? `[helpers] TikTok is connected (${W.tiktok.tokens()?.display_name || W.tiktok.tokens()?.username || "the Brownies account"}): vertical videos go to the owner's inbox as drafts` : "[helpers] TikTok app is set; the owner connects the account with /tiktok");
  log(!W.instagram.configured ? "[helpers] Instagram is not configured" : W.instagram.connected ? `[helpers] Instagram is connected (@${W.instagram.tokens()?.username || W.instagram.tokens()?.user_id}): cartoon clips go up as reels` : "[helpers] Instagram app is set; the owner connects the account with /instagram");
  log(!W.linkedin.configured ? "[helpers] LinkedIn is not configured" : W.linkedin.connected ? `[helpers] LinkedIn is connected (${W.linkedin.tokens()?.name || "the profile"}), ${W.linkedin.daysLeft()} days left` : "[helpers] LinkedIn app is set; the owner connects the profile with /linkedin");
  if (W.off.length) log(`[helpers] switched off by HELPERS_OFF: ${W.off.join(", ")} (no job runs for them)`);

  const started = Date.now();
  const health = createServer((req, res) => {
    if (req.url.startsWith("/admin/")) return W.admin.handle(req, res);
    if (req.url.startsWith("/bake/")) return W.bakery.handle(req, res);
    if (req.url.startsWith("/jobs/")) return W.jobs.handle(req, res);
    if (req.url.startsWith("/studio/")) return W.studio.handle(req, res);
    if (req.url.startsWith("/tiktok/")) return W.tiktokAuth.handle(req, res);
    if (req.url.startsWith("/instagram/")) return W.instagramAuth.handle(req, res);
    if (req.url.startsWith("/linkedin/")) return W.linkedinAuth.handle(req, res);
    if (req.url.startsWith("/clips/")) return W.clips.handle(req, res);
    const now = Date.now();
    const body = {
      ok: true, mode: S.mode, uptimeSeconds: Math.round((now - started) / 1000), reports: gateway.reports, thoughts: brain.calls,
      helpers: Object.fromEntries(Object.keys(W.helpers).map((h) => [h, { spentTodayUsd: (store.spentToday(h, now).micro / 1e6).toFixed(4), capUsd: (brain.capMicro(h) / 1e6).toFixed(2), lastJob: store.lastJob(h), hidden: W.helpers[h].hidden || undefined }])),
      pendingApprovals: store.pendingApprovals().length,
      off: W.off,
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  health.listen(S.port, "127.0.0.1", () => log(`[helpers] health on http://127.0.0.1:${S.port}/health`));

  await alerts.restarted();
  scheduler.start();
  if (!W.off.includes("crumb") && !W.admin.isPaused("crumb")) await helpers.crumb.start();
  log("[helpers] running");

  let stopping = false;
  const stop = async (sig) => {
    if (stopping) return; stopping = true;
    log(`[helpers] ${sig}, stopping`);
    scheduler.stop();
    await helpers.crumb.stop();
    await Promise.race([scheduler.idle(), new Promise((r) => setTimeout(r, 20_000))]);
    health.close();
    store.close();
    process.exit(0);
  };
  W.requestRestart = (why) => stop(why); // systemd starts the service again (Restart=always): the roster is reloaded
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("unhandledRejection", (e) => log(`[helpers] unhandled: ${e?.message || e}`));
}

// run main() only when this file is the one started (`node run.mjs`), not when a test imports build()
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`[helpers] cannot start: ${e.message}`); process.exit(1); });
}
