# Brownies helpers

The runtime that runs the four brownies, the AI helpers paid by the coin's trading tax. One Node process, a
scheduler, and one module per helper. Every finished job is reported to the gateway (`POST /api/team/log`) and the
Kitchen page shows it as a brick in Brownie City.

| Brownie | Job | When | Where it shows |
| --- | --- | --- | --- |
| Fudge | writes posts in the project's voice, answers mentions that ask something | 3 posts a day at 9, 13, 18 (Rome); mentions every 20 minutes | X, @Feedthebrownies, and the site's Posts page at the same time (the post still goes out on the site when X refuses) |
| Crumb | answers people with the facts and the live numbers; writes down the day's questions | Telegram long polling, within a minute; the questions digest once a day at 20 | the Telegram group and private chats; `notes/questions/YYYY-MM-DD.md` |
| Nib | reads the gateway's figures, the site, the competitors and the coins launched through Programmable on Ethereum (from the chain), writes a note: what changed, what to do | once a day at 8 | `notes/YYYY-MM-DD.md` in the repository |
| Chip | changes code as pull requests; small ones merge after three reviews, bigger ones wait for the owner | checks its tasks every 30 minutes | pull requests on GitHub |

Nothing here is a simulation. When the service runs, Fudge posts, Crumb answers, Nib commits and Chip merges. The
only mocks are in `test/`.

## How it works

- `run.mjs` reads the settings, builds the parts and starts the scheduler, Crumb's polling loop and a small health
  server on `127.0.0.1:8791`.
- `lib/scheduler.mjs` fires jobs at local hours (`daily`) or on an interval (`every`), one job per helper at a time.
  A daily slot missed while the service was down runs once at start; a flag in the store keeps it from running twice.
- `lib/brain.mjs` is the one chat client. `MODE=prelaunch` calls OpenRouter with `OPENROUTER_API_KEY`, reads
  `usage.cost` and stops a helper at its `dailyCapUsd`. `MODE=live` calls the gateway `/v1/chat/completions` with the
  helper's own key (its wallet signs `Brownies API key, chain 1, epoch N`, see `gateway/auth.mjs`) and stops when
  `GET /v1/key` says the balance is under 5 cents. Both modes count every call and report `cost_micro`.
- `lib/store.mjs` is the memory (node:sqlite at `DB_PATH`): jobs done, posts made (never the same text twice),
  the last turns of each chat, the Telegram offset, spend per helper per day, approvals, alert times, Nib's latest note.
- `lib/voice.mjs` holds the voice rules and the checks on the way out: ASCII only, no promise of price or returns,
  no boilerplate, no hashtag storm. A draft that fails is rewritten; after three tries nothing goes out.
- `facts.md` is the only source of claims for Fudge and Crumb, next to Nib's latest note. Edit it when the facts change.
- `lib/alerts.mjs` tells the owner on Telegram when a helper is out of budget, a service refuses the credentials,
  a job keeps failing, or the service restarted. One alert per topic per hour at most.
- Chip's rules are in `helpers/chip.mjs`: it never touches `src/`, `eth-launch/`, `gateway/auth`, deploy scripts,
  env files, package files or anything that looks like a key. A small change is text, docs, styles or tests under
  about 60 changed lines; it merges itself after Fudge, Crumb and Nib each say yes (each review is a `note` report
  in the reviewer's name). Anything else, or any no, goes to the owner on Telegram with Approve and Reject buttons.
  Reject closes the pull request; a reply to that message becomes a comment on it.

## Settings

The file named by `HELPERS_ENV` (default `/etc/brownies/helpers.env`), one `NAME=value` per line. A name already
set in the environment wins. The log says which names are set and which are empty, never a value.

| Name | What |
| --- | --- |
| `MODE` | `prelaunch` or `live` |
| `OPENROUTER_API_KEY` | prelaunch only: the key the helpers think with |
| `OPENROUTER_URL` | optional, default `https://openrouter.ai/api/v1` |
| `GATEWAY_URL`, `TEAM_LOG_KEY` | the gateway and the key the brownies report with (the same `TEAM_LOG_KEY` as the gateway's env) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`, `TELEGRAM_GROUP_CHAT_ID` | Crumb and the alerts. Empty token: Crumb is off, no alerts. Empty group id: Crumb adopts the first group the bot is added to (or hears a message in) and remembers it in the store |
| `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_ACCESS_TOKEN`, `X_REFRESH_TOKEN` | Fudge's OAuth 2.0 user tokens (scopes `tweet.read tweet.write users.read offline.access`). Empty: Fudge is off |
| `X_TOKEN_FILE` | where the rotated token pair is kept (default `/var/lib/brownies/x-token.json`). The refresh token changes at every renewal; the file is written atomically and wins over the env pair |
| `X_USERNAME` | optional, default `Feedthebrownies`, for the links in the reports |
| `GITHUB_TOKEN`, `GITHUB_REPO` | Nib's notes and Chip's pull requests (`owner/name`). Empty: Nib keeps notes in the store only, Chip is off |
| `FUDGE_PRIVATE_KEY`, `CRUMB_PRIVATE_KEY`, `NIB_PRIVATE_KEY`, `CHIP_PRIVATE_KEY` | live only: each helper's wallet. Its address is the helper's key in the team vault |
| `SITE_URL` | default `https://feedthebrownies.com` (Nib reads `/llms.txt`) |
| `DB_PATH` | default `/var/lib/brownies/helpers.sqlite` |
| `RPC_URL` | an Ethereum RPC, kept for chain reads (not used yet: the numbers come from the gateway) |
| `DEPLOYMENT_JSON` | path or URL of `deployments/1.json`; the addresses in it are added to the facts |
| `HELPERS_PORT` | the health server, default `8791` |
| `HELPERS_CONFIG` | optional: another `brownies.json` |
| `HELPERS_OFF` | optional: helpers kept quiet for now, for example `fudge` or `fudge,chip`. They are built and shown in the health line, but none of their jobs run. Remove the name and restart to switch one on |

`brownies.json` has the rest: the timezone, and for each helper its role, model (an OpenRouter id), daily cap, hours,
Fudge's topics and caps, Nib's competitor pages, Chip's reviewers and standing tasks.

## Run the tests

```
cd helpers
npm ci
npm test            # or: node --test "test/**/*.test.mjs"
```

Node 22.13 or newer (node:sqlite). The tests mock X, Telegram, GitHub, OpenRouter and the gateway with a small fetch
stub (`test/mock.mjs`); nothing reaches the network, and no account is needed.

## Run it

```
HELPERS_ENV=/path/to/helpers.env node run.mjs
```

It posts for real. On the server: `bash helpers/deploy-server.sh` from `agent-company/` copies the code to
`/srv/brownies/helpers`, installs, writes `/etc/systemd/system/brownies-helpers.service` with
`EnvironmentFile=/etc/brownies/helpers.env`, restarts it and prints the health line. The first run writes the env
file template into the local secrets folder and stops so the owner can fill the accounts.

Health: `curl http://127.0.0.1:8791/health` on the server. Logs: `journalctl -u brownies-helpers -f`.

## The first day in MODE=prelaunch

On start the owner gets "The brownies restarted (MODE=prelaunch)". Then, with every account configured: Nib writes
the first note at 8:00 and commits it; Fudge posts at 9:00, 13:00 and 18:00 and answers mentions every 20 minutes;
Crumb answers the group and private chats and reports "Answered N questions" once an hour per chat; Chip takes the
first standing task from `brownies.json` (a `notes/README.md`), opens a pull request, gets three reviews and merges
it, then the next standing task on its next round. Each helper stops for the day at its `dailyCapUsd`, and the owner
is told once.

## Add a fifth brownie

1. Give it a wallet (any new key; keep it in the env file as `NAME_PRIVATE_KEY`) and, after launch, add its address
   to the team vault as a helper.
2. Add it to `brownies.json` under `helpers` with `role`, `model`, `dailyCapUsd` and its own settings.
3. Write `helpers/<name>.mjs`: a class that extends `Helper` (`lib/helper.mjs`), with `jobs()` returning its
   scheduler jobs and a method per job. Use `this.status()` when a job starts, `this.think()` to call the model,
   `this.report(kind, title, { url, place, cost_micro })` when it is done, and `this.guard()` around a job body.
4. In `run.mjs`, build it in `build()` with `deps(name)` and add it to the list the scheduler reads. In
   `lib/env.mjs`, add its key name to `NAMES` and to `settings().keys`.
5. Add a test under `test/` with `makeWorld()`.

## What is not here

The social accounts themselves (the owner signs up; the brownies post through the official APIs), video making,
and the chain reads for Nib (the gateway's stats carry the on-chain totals once the coin is live).
