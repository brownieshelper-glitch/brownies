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

With `KEEPER_PRIVATE_KEY` set, the service also calls `harvester.claim()` every `CLAIM_EVERY_SECONDS` when Pons owes
the harvester anything or enough ETH waits to be swapped. Anyone may call that function; the keeper just makes sure
somebody does.
