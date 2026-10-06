// Connects the project's YouTube channel once, on this machine, without a secret ever passing through a chat.
//
// 1. The owner makes an OAuth client in Google Cloud (Desktop app) and saves its JSON into the secrets folder as
//    C:\Users\andrea\helix-secrets\youtube-client.json
// 2. node tools/youtube-auth.mjs            prints one link; the owner opens it, signs in with the project's
//    Google account, allows; Google sends the browser back to this script on 127.0.0.1, which trades the code for
//    tokens and writes C:\Users\andrea\helix-secrets\brownies-youtube.env (CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN,
//    CHANNEL_ID). Nothing is printed but the link, the channel's title and "done".
//
// Scopes: upload videos, and manage the channel's branding (banner, description). Read-only otherwise.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

const S = process.env.SECRETS_DIR || "C:/Users/andrea/helix-secrets";
const clientFile = `${S}/youtube-client.json`;
const outFile = `${S}/brownies-youtube.env`;
if (!existsSync(clientFile)) { console.log(`Save the OAuth client JSON from Google Cloud as ${clientFile}, then run this again.`); process.exit(1); }
const raw = JSON.parse(readFileSync(clientFile, "utf8"));
const c = raw.installed || raw.web || raw;
if (!c.client_id || !c.client_secret) { console.log("The JSON has no client_id and client_secret. It must be an OAuth client of type Desktop app."); process.exit(1); }
const SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube"];
const PORT = 8731;
const redirect = `http://127.0.0.1:${PORT}/done`;
const state = randomBytes(12).toString("hex");

const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname !== "/done") { res.writeHead(404); return res.end(); }
  const ok = (text) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px"><h2>${text}</h2><p>You can close this tab.</p></body>`); };
  try {
    if (u.searchParams.get("state") !== state) throw new Error("the state does not match; start again");
    if (u.searchParams.get("error")) throw new Error(u.searchParams.get("error"));
    const code = u.searchParams.get("code");
    const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: c.client_id, client_secret: c.client_secret, redirect_uri: redirect, grant_type: "authorization_code" }) });
    const t = await r.json();
    if (!t.refresh_token) throw new Error("Google gave no refresh token: remove the app's access at myaccount.google.com/permissions and run again");
    const ch = await (await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: { authorization: `Bearer ${t.access_token}` } })).json();
    const channel = ch.items?.[0];
    const lines = ["# The project's YouTube channel, connected " + new Date().toISOString().slice(0, 10) + ". Never copy values into chat.", `YOUTUBE_CLIENT_ID=${c.client_id}`, `YOUTUBE_CLIENT_SECRET=${c.client_secret}`, `YOUTUBE_REFRESH_TOKEN=${t.refresh_token}`, `YOUTUBE_CHANNEL_ID=${channel?.id || ""}`, `YOUTUBE_CHANNEL_TITLE=${(channel?.snippet?.title || "").replace(/[\r\n]/g, " ")}`, ""];
    writeFileSync(outFile, lines.join("\n"));
    console.log(`done: connected the channel "${channel?.snippet?.title || "?"}" (${channel?.id || "?"}); tokens saved to brownies-youtube.env`);
    ok("Brownies is connected to this YouTube channel.");
  } catch (e) {
    console.log("failed: " + e.message);
    ok("Something went wrong: " + e.message);
  } finally {
    setTimeout(() => { server.close(); process.exit(0); }, 500);
  }
});
server.listen(PORT, "127.0.0.1", () => {
  const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({ client_id: c.client_id, redirect_uri: redirect, response_type: "code", scope: SCOPES.join(" "), access_type: "offline", prompt: "consent", state });
  console.log("Open this link in your browser, sign in with the project's Google account, and allow:\n\n" + url + "\n\nWaiting...");
});
