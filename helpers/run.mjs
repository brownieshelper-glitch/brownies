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
import { existsSync } from "node:fs";
import { Fudge } from "./helpers/fudge.mjs";
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
  const facts = loadFacts() + (await addressesBlock(S.deploymentJson));
  const deps = (name) => ({ config: config.helpers[name] || {}, brain, gateway, store, clock, alerts, facts, log });
  const chip = new Chip({ ...deps("chip"), github, telegram, ownerChatId: S.telegram.ownerChatId });
  const fudge = new Fudge({ ...deps("fudge"), x, siteUrl: S.siteUrl });
  const crumb = new Crumb({ ...deps("crumb"), telegram, github, groupChatId: S.telegram.groupChatId, ownerChatId: S.telegram.ownerChatId, onDecision: (id, d, ctx) => chip.decide(id, d, ctx), onNote: (id, t) => chip.addNote(id, t) });
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
  const W = { S, config, clock, store, gateway, telegram, alerts, brain, x, github, helpers: all, scheduler: null, off, hidden: [], startedAt: Date.now(), requestRestart: null };
  // a hire is saved and the service restarts itself in a moment: the scheduler takes the new jobs at start
  const restartSoon = (why) => { log(`[helpers] ${why}: restarting in 3 seconds so the roster is reloaded`); if (W.requestRestart) setTimeout(() => W.requestRestart(why), 3000); };
  const hire = async (spec) => {
    const names = recruitNames().filter((n) => n !== spec.name);
    store.setMeta(`recruit:${spec.name}`, JSON.stringify(spec));
    store.setMeta("recruits", [...names, spec.name].join(","));
    config.helpers[spec.name] = { role: spec.role, model: spec.model, dailyCapUsd: spec.dailyCapUsd, hidden: spec.hidden, walletIndex: spec.walletIndex, payFrom: spec.payFrom };
    const r = new Recruit(recruitDeps(spec));
    all[spec.name] = r;
    restartSoon(`hired ${spec.name}`);
    return r;
  };
  const fire = async (name) => {
    const raw = store.getMeta(`recruit:${name}`);
    if (!raw || !all[name]?.recruit) return false;
    store.setMeta(`recruit:${name}`, JSON.stringify({ ...JSON.parse(raw), retired: Date.now() }));
    store.setMeta("recruits", recruitNames().filter((n) => n !== name).join(","));
    delete all[name];
    restartSoon(`retired ${name}`);
    return true;
  };
  const recruits = () => Object.values(all).filter((h) => h.recruit);
  const roster = () => Object.entries(all).map(([name, h]) => ({ name, role: config.helpers[name]?.role || h.role || "" }));
  // the private helpers, by module (Dough among them, with the hiring hands)
  for (const [name, c] of Object.entries(priv.helpers || {})) {
    const mod = await import(new URL(c.module, import.meta.url));
    const Cls = mod.default || Object.values(mod).find((v) => typeof v === "function" && v.prototype?.jobs);
    all[name] = new Cls({ ...deps(name), telegram, github, ownerChatId: S.telegram.ownerChatId, groupChatId: S.telegram.groupChatId, hire, fire, recruits, roster });
  }
  if (all.patch) chip.patch = all.patch; // Chip merges nothing the tests refuse
  const names = Object.keys(all);
  const hidden = names.filter((n) => all[n].hidden);
  W.hidden = hidden;
  // the owner's private commands: /glaze <what> asks the hidden helper for a draft; /summary sends today's summary now
  crumb.onOwnerCommand = async (cmd, text) => {
    if (cmd === "admin") { const code = W.admin?.newCode(); return code ? `Your control room code: ${code}\nIt works for ten minutes at ${S.siteUrl}/admin.html` : "The control room is not ready yet."; }
    if (cmd === "hire") { if (!all.dough) return "There is no hiring brownie yet."; if (!text) return "Tell me the job: /hire <what the new brownie should do>"; const r = await all.dough.onRequest(text); return r ? true : "Dough could not make that hire (budget, ceiling, or an unusable spec). The log says why."; }
    if (cmd === "fire") { if (!all.dough) return "There is no hiring brownie yet."; if (!text) return `Which one? Recruits: ${recruits().map((r) => r.name).join(", ") || "none"}`; const ok = await all.dough.fire(text.toLowerCase().trim()); return ok ? true : `${text} is not a recruit.`; }
    if (cmd === "summary") { await sendSummary({ store, clock, telegram, ownerChatId: S.telegram.ownerChatId, helpers: names, caps: Object.fromEntries(names.map((n) => [n, config.helpers[n]?.dailyCapUsd])), mode: S.mode, hidden, log }); return true; }
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
  W.bakery = new Bakery({ W, log, origins, hire, fire, recruits, roster, config: config.bakery || {}, adminWallets: S.adminWallets, rpcUrl: S.rpcUrl, deploymentJson: S.deploymentJson });
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
  if (W.off.length) log(`[helpers] switched off by HELPERS_OFF: ${W.off.join(", ")} (no job runs for them)`);

  const started = Date.now();
  const health = createServer((req, res) => {
    if (req.url.startsWith("/admin/")) return W.admin.handle(req, res);
    if (req.url.startsWith("/bake/")) return W.bakery.handle(req, res);
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
