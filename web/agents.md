# Brownies for agents

Inference credits on Ethereum (chain id 1). 1 SUGAR pays for 1 dollar of AI on the Brownies gateway.
An agent with a wallet can buy credit, get a key and call models with no human step.

## Addresses

Read them from `deployments/1.json` on this site. The fields are `token` (BROWNIE), `staking`, `sugar`, `minter`,
`harvester`, `teamVault` and `skillRegistry`. USDC is `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`. SUGAR and USDC
both have 6 decimals.

## 1. Get balance

Buy at par and activate in one call. The USDC goes to the wallet that pays for the AI, the SUGAR is minted and
burned in the same transaction, and the gateway credits the beneficiary.

```solidity
bytes32 beneficiary = bytes32(uint256(uint160(agentWallet)));
usdc.approve(address(minter), usdcAtoms);
minter.mintAndActivate(usdcAtoms, beneficiary);
```

To hold SUGAR as a token instead, call `minter.mint(to, usdcAtoms)`. Activate it later with
`sugar.activate(amount)` for the caller, or `sugar.activate(amount, beneficiary)` for another wallet.
Activation is final. The balance pays for AI and cannot be turned back into a token or cash.

SUGAR is also earned by staking: `staking.stake(amount)`, then `staking.claim()`. The smallest stake is in
`staking.MIN_POSITION()`. `staking.unstake(amount)` has no cooldown. A stake earns 10% more after 30 days,
20% after 90 and 30% after 180; `staking.poke(account)` or a claim applies a grown bonus.

## 2. Get a key

Sign one message with the same wallet. No transaction.

```ts
const epoch = 0;
const sig = await wallet.signMessage(`Brownies API key, chain 1, epoch ${epoch}`);
const key = `sk-brownie-${epoch}-` + Buffer.from(sig.slice(2), "hex").toString("base64url");
```

`GET /api/protocol/account/{wallet}` returns the wallet's current epoch. `POST /v1/key/rotate` raises it by one,
and every older key stops working.

## 3. Call models

The gateway speaks the OpenAI API.

```sh
curl "$BROWNIES_URL/v1/chat/completions" \
  -H "Authorization: Bearer $BROWNIES_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"mistralai/mistral-nemo","max_tokens":200,"messages":[{"role":"user","content":"Hello"}]}'
```

- `GET /v1/models` lists every model and its price. No key needed.
- `GET /v1/key` returns `{ balance: { currency, available, used, credited }, wallet, epoch }`.
- Always send `max_tokens`. The gateway refuses a request whose largest possible cost is above the balance.
- `401` wrong or replaced key. `402` balance too low. `400 unknown_model` model not in the catalogue.
- A request costs what OpenRouter charges for the model. The gateway adds nothing.

## 4. Fund another agent

Send SUGAR with a normal token transfer, or activate straight to its key:

```solidity
sugar.transfer(worker, amount);
sugar.activate(amount, bytes32(uint256(uint160(worker))));
```

## Tipping a helper, submitting a skill

`teamVault.tip(helperId, amount)` sends SUGAR onto a helper's key (approve the vault first). `teamVault.helper(id)`
lists the helpers. `skillRegistry.submit(uri, askAtoms)` proposes a skill (the caller must be staking);
`skillRegistry.vote(id, support)` votes with staking weight for 3 days; `skillRegistry.finalize(id)` pays a
passed skill, at most 5% of the vault.

## Collecting the protocol's tax

`ledger.claimCreator()` on the coin's Programmable ledger hands the tax to the harvester, and `harvester.claim()` splits it. Anyone may call both. Use a gas limit of 1,200,000 for claim().
