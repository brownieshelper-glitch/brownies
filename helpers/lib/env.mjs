// The settings. They come from the file named by HELPERS_ENV (default /etc/brownies/helpers.env), one KEY=VALUE a
// line, the way the gateway reads its own file. A name already set in the process environment wins over the file.
//
// Nothing here ever prints a value. describe() says which names are set and which are empty, and that is all a log
// may show. Lines saved by Notepad (CRLF) are fine; comment lines and empty lines are skipped.
import { readFileSync, existsSync } from "node:fs";

export const NAMES = [
  "MODE", "OPENROUTER_API_KEY", "OPENROUTER_URL", "GATEWAY_URL", "TEAM_LOG_KEY",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_OWNER_CHAT_ID", "TELEGRAM_GROUP_CHAT_ID",
  "X_CLIENT_ID", "X_CLIENT_SECRET", "X_ACCESS_TOKEN", "X_REFRESH_TOKEN", "X_TOKEN_FILE", "X_USERNAME",
  "GITHUB_TOKEN", "GITHUB_REPO",
  "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN", "YOUTUBE_CHANNEL_ID",
  "TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET",
  "FUDGE_PRIVATE_KEY", "CRUMB_PRIVATE_KEY", "NIB_PRIVATE_KEY", "CHIP_PRIVATE_KEY", "GLAZE_PRIVATE_KEY", "SWIRL_PRIVATE_KEY", "SPRINKLE_PRIVATE_KEY", "HELPERS_MNEMONIC", "VIDEOS_DIR", "FFMPEG_PATH",
  "SITE_URL", "DB_PATH", "RPC_URL", "DEPLOYMENT_JSON", "HELPERS_PORT", "HELPERS_CONFIG", "HELPERS_OFF", "ADMIN_WALLETS", "ADMIN_ORIGINS",
];

/// The helpers switched off for now, from HELPERS_OFF="fudge,chip" (names, any case, spaces allowed). A helper
/// that is off is built and shown in the health line, but none of its jobs run and it does not listen.
export function offList(env = process.env) {
  return String(env.HELPERS_OFF || "").toLowerCase().split(/[\s,;]+/).filter((s) => ["fudge", "crumb", "nib", "chip"].includes(s));
}

/// Reads the file into `env` (names not already set). Returns the number of names read. A missing file reads nothing.
export function readEnvFile(file, env = process.env) {
  if (!file || !existsSync(file)) return 0;
  let n = 0;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.replace(/\r$/, "");
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trimStart().startsWith("#")) continue;
    const value = m[2].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (env[m[1]] === undefined && value !== "") { env[m[1]] = value; n++; }
  }
  return n;
}

/// "MODE set, OPENROUTER_API_KEY set, X_CLIENT_ID empty, ..." for the start-up log. Never a value.
export function describe(env = process.env) {
  return NAMES.map((k) => `${k} ${env[k] ? "set" : "empty"}`).join(", ");
}

const need = (env, k) => { if (!env[k]) throw new Error(`Setting ${k} is empty. Fill it in the helpers env file.`); return env[k]; };

/// The typed settings the runtime needs. Throws a plain sentence naming the missing setting (never its value).
export function settings(env = process.env) {
  const mode = env.MODE || "prelaunch";
  if (!["prelaunch", "live"].includes(mode)) throw new Error("MODE must be prelaunch or live.");
  const s = {
    mode,
    openrouterKey: env.OPENROUTER_API_KEY || "",
    openrouterUrl: (env.OPENROUTER_URL || "https://openrouter.ai/api/v1").replace(/\/$/, ""),
    gatewayUrl: need(env, "GATEWAY_URL").replace(/\/$/, ""),
    teamLogKey: need(env, "TEAM_LOG_KEY"),
    telegram: { token: env.TELEGRAM_BOT_TOKEN || "", ownerChatId: env.TELEGRAM_OWNER_CHAT_ID || "", groupChatId: env.TELEGRAM_GROUP_CHAT_ID || "" },
    x: {
      clientId: env.X_CLIENT_ID || "", clientSecret: env.X_CLIENT_SECRET || "",
      accessToken: env.X_ACCESS_TOKEN || "", refreshToken: env.X_REFRESH_TOKEN || "",
      tokenFile: env.X_TOKEN_FILE || "/var/lib/brownies/x-token.json",
      username: env.X_USERNAME || "Feedthebrownies",
    },
    github: { token: env.GITHUB_TOKEN || "", repo: env.GITHUB_REPO || "" },
    tiktok: { clientKey: env.TIKTOK_CLIENT_KEY || "", clientSecret: env.TIKTOK_CLIENT_SECRET || "" }, // the developer app; the account tokens live in the store once the owner allows it
    keys: { fudge: env.FUDGE_PRIVATE_KEY || "", crumb: env.CRUMB_PRIVATE_KEY || "", nib: env.NIB_PRIVATE_KEY || "", chip: env.CHIP_PRIVATE_KEY || "", glaze: env.GLAZE_PRIVATE_KEY || "", swirl: env.SWIRL_PRIVATE_KEY || "", sprinkle: env.SPRINKLE_PRIVATE_KEY || "" },
    mnemonic: env.HELPERS_MNEMONIC || "", // the seed of the baked brownies' wallets (lib/bakery.mjs), derived by index, MODE=live only
    siteUrl: (env.SITE_URL || "https://feedthebrownies.com").replace(/\/$/, ""),
    dbPath: env.DB_PATH || "/var/lib/brownies/helpers.sqlite",
    rpcUrl: env.RPC_URL || "https://ethereum-rpc.publicnode.com",
    deploymentJson: env.DEPLOYMENT_JSON || (env.SITE_URL || "https://feedthebrownies.com").replace(/\/$/, "") + "/deployments/1.json",
    port: Number(env.HELPERS_PORT || 8791),
    configFile: env.HELPERS_CONFIG || "", // another brownies.json, for example one kept outside the code folder
    adminWallets: String(env.ADMIN_WALLETS || "").split(/[\s,]+/).filter(Boolean), // wallets that may log into the control room with a signature
    adminOrigins: String(env.ADMIN_ORIGINS || "").split(/[\s,]+/).filter(Boolean), // extra page origins allowed to call /admin (the site's own is always allowed)
  };
  if (mode === "prelaunch") need(env, "OPENROUTER_API_KEY");
  if (mode === "live") for (const k of ["FUDGE_PRIVATE_KEY", "CRUMB_PRIVATE_KEY", "NIB_PRIVATE_KEY", "CHIP_PRIVATE_KEY"]) need(env, k);
  if (s.github.repo && !/^[\w.-]+\/[\w.-]+$/.test(s.github.repo)) throw new Error("GITHUB_REPO must be owner/name.");
  return s;
}
