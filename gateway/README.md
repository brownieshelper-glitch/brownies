# Brownies gateway

An OpenAI style API in front of OpenRouter, billed to SUGAR activations on Robinhood Chain.

How money flows:

1. USDG reaches the inference funding wallet (through the harvester, the staking stream or the par door) and the same
   number of SUGAR atoms is minted on chain. One atom is one micro dollar.
2. A holder calls `activate(amount, beneficiary)` on SUGAR. The token burns and the chain emits `Activated`.
3. This service indexes `Activated` and credits the beneficiary. A wallet's beneficiary is its address padded to 32 bytes.
4. The wallet signs `Brownies API key, chain 4663, epoch N` once. The signature, base64url, is the API key:
   `sk-brownie-N-<signature>`. No account, nothing stored, nothing to leak but a key the wallet can rotate.
5. Every request is forwarded to OpenRouter with the gateway's upstream key and charged after the call at the cost
   OpenRouter states, times `PRICE_MULTIPLIER` (1.0 = at cost). The owner buys OpenRouter balance with the USDG from
   step 1. That purchase is the one trusted step, and the site says so.

Run it:

```
cd gateway
npm install
cp .env.example .env     # fill SUGAR_ADDRESS, START_BLOCK, OPENROUTER_API_KEY
npm start
```

Routes: `GET /v1/models`, `GET /v1/key`, `POST /v1/key/rotate`, `POST /v1/chat/completions` (streaming works),
`GET /v1/grants`, `POST /v1/grants`, `POST /v1/grants/revoke`, `GET /api/protocol/stats`, `GET /api/protocol/account/:wallet`,
`POST /api/protocol/index-tx`, `GET /health`.

Grants: `POST /v1/grants {"grantee": "0x...", "daily_usd": 1}` lets another wallet spend from your balance, up to that much
a day (UTC). The grantee signs its own key and adds `X-Brownies-Pay-From: <your wallet>` to `/v1/key` and
`/v1/chat/completions`; the charge lands on you and the spend row says who spent it. `GET /v1/grants` lists what you gave
and received with today's room; `POST /v1/grants/revoke {"grantee"}` ends one. The Bakery's holders fund their brownies this way.

Use it from any OpenAI SDK: base URL `http://host:8790/v1`, API key `sk-brownie-...`. A 401 is a bad or rotated key, a
402 is not enough balance, a 400 `unknown_model` means pick an id from `/v1/models`.

With `KEEPER_PRIVATE_KEY` set, the service is also the keeper. Every `CLAIM_EVERY_SECONDS` it does three duties that
anyone may do; the keeper just makes sure somebody does:

1. `ledger.claimCreator()` on Programmable's fee ledger, once at least `CLAIM_MIN_ETH` of creator fee waits there.
   The WETH lands in the harvester.
2. `harvester.claim()`, once that much fresh WETH sits in the harvester, or a swap is waiting, or the main wallet is
   owed. The harvester books 40% for the main wallet, swaps the rest to USDC, funds the staking and the TeamVault.
3. `vault.release()`, once a day, when the brownies' budget (one thirtieth of the vault) is worth at least
   `RELEASE_MIN_SUGAR`.

Every transaction is simulated first; a failing simulation is logged once an hour and skipped. Under
`KEEPER_FLOOR_ETH` of balance the keeper sends nothing and asks for a refill in the log. Tests: `test/keeper.test.mjs`
(fake contracts) and `bash smoke/eth-keeper-check.sh` (a mainnet fork with the coin launched the real way).

Pantry and Ambient (x402)
-------------------------
With PANTRY_PRIVATE_KEY set, the gateway also offers Ambient's open models (ids starting with `ambient/`, the
alias `ambient/large` kept) and pays each request itself: JumpGate quotes the price (input tokens plus the output
bound), answers 402 with x402 v2 payment requirements, and the pantry signs an EIP-3009 USDC transfer on Base for
exactly that amount (x402.mjs); the facilitator pays the gas. The caller is charged what was paid, times
PRICE_MULTIPLIER. The pantry (pantry.mjs) reads its USDC on Ethereum (where the coin's fees arrive) and on Base
every PANTRY_EVERY_SECONDS and, from PANTRY_BRIDGE_MIN_USDC up with ETH for gas, moves it to Base with Relay
(bridge.mjs, a quote without referrer, approve + deposit, the status polled). X402_MAX_USD_PER_REQUEST caps one
payment. GET /health shows the pantry's address and balances. Nothing is bought ahead and no account exists anywhere.
