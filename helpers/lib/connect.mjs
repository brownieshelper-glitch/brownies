// Connecting an account the official way, the same for every platform: the owner asks the bot for a link, the link
// works once for ten minutes and sends the browser to <gateway>/<name>/start, which sends it on to the platform's
// login with a state; the platform comes back to <gateway>/<name>/callback, the state is checked, the code becomes
// tokens through the platform's client, and the owner is told. Nothing here logs a token.
//
// A client gives: configured (the developer app's id and secret are set), authUrl(state), exchange(code) -> { name }.
import { createHash, randomBytes } from "node:crypto";

export class Connect {
  constructor({ name, client, store, clock, log = () => {}, onConnected = null, baseUrl = "", command = null }) {
    Object.assign(this, { name, client, store, clock, log, onConnected, baseUrl });
    this.command = command || `/${name}`;
  }
  now() { return this.clock ? this.clock.now() : Date.now(); }

  /// The link the owner opens (ten minutes, once).
  link() {
    const ticket = randomBytes(16).toString("hex");
    this.store.setMeta(`${this.name}:ticket`, JSON.stringify({ hash: sha(ticket), expiresAt: this.now() + 10 * 60_000 }));
    return `${this.baseUrl}/${this.name}/start?t=${ticket}`;
  }
  _ticketOk(t) {
    const raw = this.store.getMeta(`${this.name}:ticket`);
    if (!raw || !t) return false;
    const c = JSON.parse(raw);
    if (this.now() > c.expiresAt || sha(t) !== c.hash) return false;
    this.store.setMeta(`${this.name}:ticket`, null);
    return true;
  }

  async handle(req, res) {
    const url = new URL(req.url, "http://x");
    const label = this.client.label || this.name;
    const page = (status, title, text) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><body style="font-family:sans-serif;padding:40px;max-width:560px;background:#2A1710;color:#F6EFE2"><h2>${title}</h2><p>${text}</p></body>`); };
    try {
      if (req.method === "GET" && url.pathname === `/${this.name}/start`) {
        if (!this.client.configured) return page(503, `${label} is not set up`, "The developer app's id and secret are missing on the server.");
        if (!this._ticketOk(url.searchParams.get("t"))) return page(403, "This link is not valid", `Ask the bot for a new one with ${this.command}. A link works once, for ten minutes.`);
        const state = randomBytes(16).toString("hex");
        this.store.setMeta(`${this.name}:state`, JSON.stringify({ state, expiresAt: this.now() + 10 * 60_000 }));
        res.writeHead(302, { location: this.client.authUrl(state), "cache-control": "no-store" });
        return res.end();
      }
      if (req.method === "GET" && url.pathname === `/${this.name}/callback`) {
        const raw = this.store.getMeta(`${this.name}:state`);
        const s = raw ? JSON.parse(raw) : null;
        if (!s || this.now() > s.expiresAt || url.searchParams.get("state") !== s.state) return page(400, "Something went wrong", `The answer from ${label} did not match the request. Ask the bot for a new link with ${this.command}.`);
        this.store.setMeta(`${this.name}:state`, null); // matched: it was good for one answer
        if (url.searchParams.get("error")) return page(400, `${label} said no`, `${url.searchParams.get("error")}: ${url.searchParams.get("error_description") || url.searchParams.get("error_reason") || ""}`);
        const me = await this.client.exchange(String(url.searchParams.get("code") || "").replace(/#_$/, ""));
        this.log(`[${this.name}] connected as ${me.name}`);
        if (this.onConnected) { try { await this.onConnected(me); } catch (e) { this.log(`[${this.name}] the welcome failed: ${e.message}`); } }
        return page(200, `${label} is connected`, `Brownies can now post to ${me.name || "this account"}. You can close this tab.`);
      }
      return page(404, "Not here", "Nothing at this address.");
    } catch (e) {
      this.log(`[${this.name}] ${url.pathname} failed: ${e.message}`);
      return page(500, "Something went wrong", e.message);
    }
  }
}

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
