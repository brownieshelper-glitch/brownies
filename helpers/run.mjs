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
import { Fudge } from "./helpers/fudge.mjs";
import { Crumb } from "./helpers/crumb.mjs";
import { Nib } from "./helpers/nib.mjs";
import { Chip } from "./helpers/chip.mjs";

const log = (...a) => console.log(new Date().toISOString(), ...a);

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
  const clock = new RealClock();
  const store = new Store(S.dbPath, { tz: config.timezone || "UTC" });
  const gateway = new Gateway({ url: S.gatewayUrl, teamKey: S.teamLogKey, log });
  const telegram = new Telegram({ token: S.telegram.token, log });
  const alerts = new Alerts({ telegram, ownerChatId: S.telegram.ownerChatId, store, clock, mode: S.mode, log });
  const brain = new Brain({ mode: S.mode, openrouterKey: S.openrouterKey, openrouterUrl: S.openrouterUrl, gateway, keys: S.keys, chainId: config.chainId || 1, helpers: config.helpers, store, clock, alerts, log });
  const x = new XClient({ ...S.x, clock, log });
  const github = new GitHub({ token: S.github.token, repo: S.github.repo, log });
  const facts = loadFacts() + (await addressesBlock(S.deploymentJson));
  const deps = (name) => ({ config: config.helpers[name] || {}, brain, gateway, store, clock, alerts, facts, log });
  const chip = new Chip({ ...deps("chip"), github, telegram, ownerChatId: S.telegram.ownerChatId });
  const fudge = new Fudge({ ...deps("fudge"), x });
  const crumb = new Crumb({ ...deps("crumb"), telegram, groupChatId: S.telegram.groupChatId, ownerChatId: S.telegram.ownerChatId, onDecision: (id, d, ctx) => chip.decide(id, d, ctx), onNote: (id, t) => chip.addNote(id, t) });
  const nib = new Nib({ ...deps("nib"), github, siteUrl: S.siteUrl });
  const scheduler = new Scheduler({ clock, tz: config.timezone || "UTC", flags: store, log });
  // HELPERS_OFF="fudge" keeps a helper quiet for now: built, shown in the health line, but no job runs
  const off = offList(env);
  for (const h of [fudge, crumb, nib, chip]) if (!off.includes(h.name)) for (const j of h.jobs()) scheduler.add(j);
  return { S, config, clock, store, gateway, telegram, alerts, brain, x, github, helpers: { fudge, crumb, nib, chip }, scheduler, off };
}

async function main() {
  readEnvFile(process.env.HELPERS_ENV || "/etc/brownies/helpers.env");
  const W = await build();
  const { S, store, gateway, brain, scheduler, helpers, alerts } = W;
  log(`[helpers] MODE=${S.mode}, gateway ${S.gatewayUrl}, db ${S.dbPath}`);
  log(`[helpers] settings: ${describe()}`);
  if (S.mode === "live") for (const h of HELPERS) log(`[helpers] ${h} wallet ${brain.address(h)} (add it to the team vault)`);
  if (!W.x.configured) log("[helpers] X is not configured: Fudge will not post");
  if (!W.telegram.configured) log("[helpers] Telegram is not configured: Crumb will not listen and no alerts go out");
  if (!W.github.configured) log("[helpers] GitHub is not configured: Nib keeps its notes in the store, Chip has no tasks");
  if (W.off.length) log(`[helpers] switched off by HELPERS_OFF: ${W.off.join(", ")} (no job runs for them)`);

  const started = Date.now();
  const health = createServer((req, res) => {
    const now = Date.now();
    const body = {
      ok: true, mode: S.mode, uptimeSeconds: Math.round((now - started) / 1000), reports: gateway.reports, thoughts: brain.calls,
      helpers: Object.fromEntries(HELPERS.map((h) => [h, { spentTodayUsd: (store.spentToday(h, now).micro / 1e6).toFixed(4), capUsd: (brain.capMicro(h) / 1e6).toFixed(2), lastJob: store.lastJob(h) }])),
      pendingApprovals: store.pendingApprovals().length,
      off: W.off,
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  health.listen(S.port, "127.0.0.1", () => log(`[helpers] health on http://127.0.0.1:${S.port}/health`));

  await alerts.restarted();
  scheduler.start();
  if (!W.off.includes("crumb")) await helpers.crumb.start();
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
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("unhandledRejection", (e) => log(`[helpers] unhandled: ${e?.message || e}`));
}

// run main() only when this file is the one started (`node run.mjs`), not when a test imports build()
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`[helpers] cannot start: ${e.message}`); process.exit(1); });
}
