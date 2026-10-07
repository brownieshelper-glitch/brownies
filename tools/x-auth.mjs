// Connects the project's X account once more, on this machine, with the permissions the brownies need now:
// read and write posts, read the user, stay connected (offline.access) and UPLOAD MEDIA (media.write), so Fudge
// can post images and videos. No secret ever passes through a chat.
//
// 1. In the X developer portal, the app's "User authentication settings": App permissions "Read and write",
//    Type of App "Web App, Automated App or Bot" (or "Native App"), and this callback URI added:
//        http://127.0.0.1:8732/callback
// 2. node tools/x-auth.mjs            prints one link; the owner opens it, logs in as the project's X account,
//    allows; X sends the browser back to this script on 127.0.0.1, which trades the code for tokens and writes
//    them into C:\Users\andrea\helix-secrets\brownies-helpers.env (X_ACCESS_TOKEN, X_REFRESH_TOKEN) and
//    brownies-x.env. Nothing is printed but the link, the scopes granted and "done".
// 3. Deploy the helpers (bash helpers/deploy-server.sh) and remove the server's saved pair
//    (/var/lib/brownies/x-token.json), so the new tokens are the ones in use.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";

const S = process.env.SECRETS_DIR || "C:/Users/andrea/helix-secrets";
const HELPERS_ENV = `${S}/brownies-helpers.env`, X_ENV = `${S}/brownies-x.env`;
const SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"];
const PORT = 8732;
const redirect = `http://127.0.0.1:${PORT}/callback`;

const readEnv = (file) => Object.fromEntries((existsSync(file) ? readFileSync(file, "utf8") : "").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
const env = { ...readEnv(X_ENV), ...readEnv(HELPERS_ENV) };
const clientId = env.X_CLIENT_ID, clientSecret = env.X_CLIENT_SECRET || "";
if (!clientId) { console.log(`X_CLIENT_ID is not in ${HELPERS_ENV} or ${X_ENV}. Save the app's OAuth 2.0 client id there first.`); process.exit(1); }

/// Puts KEY=value lines into an env file: replaced when the key is there, appended when it is not.
function setEnv(file, pairs) {
  let text = existsSync(file) ? readFileSync(file, "utf8") : "";
  for (const [k, v] of Object.entries(pairs)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text.replace(/\n*$/, "\n")}${k}=${v}\n`;
  }
  writeFileSync(file, text);
}

const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(12).toString("hex");

const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname !== "/callback") { res.writeHead(404); return res.end(); }
  const page = (text) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px"><h2>${text}</h2><p>You can close this tab.</p></body>`); };
  try {
    if (u.searchParams.get("state") !== state) throw new Error("the state does not match; start again");
    if (u.searchParams.get("error")) throw new Error(`${u.searchParams.get("error")}: ${u.searchParams.get("error_description") || ""}`);
    const code = u.searchParams.get("code");
    const headers = { "content-type": "application/x-www-form-urlencoded" };
    if (clientSecret) headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`; // a confidential (Web App) client
    const r = await fetch("https://api.x.com/2/oauth2/token", { method: "POST", headers, body: new URLSearchParams({ code, grant_type: "authorization_code", client_id: clientId, redirect_uri: redirect, code_verifier: verifier }) });
    const t = await r.json();
    if (!r.ok || !t.access_token) throw new Error(`X answered ${r.status}: ${t.error_description || t.error || JSON.stringify(t).slice(0, 160)}`);
    if (!t.refresh_token) throw new Error("X gave no refresh token: make sure offline.access is allowed and run again");
    const me = await (await fetch("https://api.x.com/2/users/me", { headers: { authorization: `Bearer ${t.access_token}` } })).json();
    const stamp = new Date().toISOString();
    setEnv(HELPERS_ENV, { X_ACCESS_TOKEN: t.access_token, X_REFRESH_TOKEN: t.refresh_token });
    setEnv(X_ENV, { X_CLIENT_ID: clientId, X_ACCESS_TOKEN: t.access_token, X_REFRESH_TOKEN: t.refresh_token, X_TOKEN_SAVED_AT: stamp });
    console.log(`done: connected @${me.data?.username || "?"} with scopes ${t.scope || SCOPES.join(" ")}; tokens saved to brownies-helpers.env and brownies-x.env.`);
    console.log("Next: bash helpers/deploy-server.sh, then remove /var/lib/brownies/x-token.json on the server so the new pair is used.");
    page(`Brownies is connected to @${me.data?.username || "the X account"} with media upload.`);
  } catch (e) {
    console.log("failed: " + e.message);
    page("Something went wrong: " + e.message);
  } finally {
    setTimeout(() => { server.close(); process.exit(0); }, 500);
  }
});
server.listen(PORT, "127.0.0.1", () => {
  const url = "https://x.com/i/oauth2/authorize?" + new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, scope: SCOPES.join(" "), state, code_challenge: challenge, code_challenge_method: "S256" });
  console.log("Open this link in your browser, log in as the project's X account (@Feedthebrownies), and allow:\n\n" + url + "\n\nWaiting...");
});
