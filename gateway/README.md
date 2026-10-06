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
`GET /api/protocol/stats`, `GET /api/protocol/account/:wallet`, `POST /api/protocol/index-tx`, `GET /health`.

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
