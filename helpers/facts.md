# Brownies, the facts

Written from web/llms.txt and web/docs.html on 2026-10-06. This file is the only source of claims for Fudge
and Crumb, next to Nib's latest note. If something is not here, it is not said. Numbers below are the numbers in
the contracts.

## Status

- As of 2026-10-06 the coin is NOT launched. Do not announce a launch, a date or a price. Say "not launched yet"
  when asked.
- Contract addresses will be published at https://feedthebrownies.com/deployments/1.json once they exist. Until
  then there are no addresses to give.

## What Brownies is

- BROWNIE is a coin on Ethereum (chain id 1), launched through Programmable. Every buy and every sell pays a 2% tax.
  That tax is the only money in the system.
- 35% of the tax pays for AI for the people who stake BROWNIE. They receive it as SUGAR. One SUGAR pays for one
  dollar of AI on the Brownies gateway.
- 30% of the tax feeds the brownies: the AI helpers that work for the coin. The agents are the product, so they get the bigger share.
- The gateway speaks the OpenAI API and serves every model on OpenRouter. A wallet is the account, and a signature
  from it is the API key.

## The coin

- Fixed supply of 1,000,000,000 BROWNIE. It trades on a Uniswap pool against ETH from the first block, no bonding
  curve. The whole supply went into that pool at launch through Programmable's factory.
- Tax: 2% on buys and 2% on sells, set at launch, nobody can change it. Programmable charges its own 0.30% on every
  trade on top.
- Where the tax goes, fixed in the Harvester contract: 35% to stakers (swapped to USDC, paid as SUGAR over the next
  hour), 35% to the protocol (ETH to the Brownies wallet, for servers and growth), 30% to the brownies (swapped to
  USDC, minted as SUGAR into the team vault).
- The team can switch the program off (new fees go to the team wallet) but cannot change the shares.

## Staking

- Stake BROWNIE in the app. A stake earns SUGAR every second, as its share of the stream for every second staked.
- Smallest stake: 10,000 BROWNIE. No lock. Unstake any amount at any time, even during an emergency stop. What is
  left staked must be zero or at least the smallest stake.
- Claim whenever. Unclaimed SUGAR keeps waiting. If nobody is staked for a while, that SUGAR joins the next hour.
- Loyalty bonus: 10% more after 30 days, 20% after 90, 30% after 180, then it stays. The bonus is a bigger share of
  the same stream, paid by stakers who stayed a shorter time. Adding to a stake averages its age; unstaking a part
  keeps the age; unstaking everything resets it.

## SUGAR

- A token with 6 decimals. 1 SUGAR pays for 1 dollar of AI.
- A SUGAR is minted only in the same transaction that sends 1 USDC to the wallet that pays for the AI. There is never
  more SUGAR than dollars paid in.
- Two ways to get it: stake BROWNIE and claim, or buy it from the Minter contract at 1 USDC each (the app has a Buy
  SUGAR panel).
- Activating burns the SUGAR and adds the same number of dollars to the key on the gateway. Activation is final.
  The balance pays for AI and nothing else; it cannot be turned back into a token or cash. One can activate for
  another wallet (the beneficiary).
- SUGAR is access to AI on the Brownies gateway. It is not an investment and it cannot be redeemed for cash.

## The gateway and the key

- Address: https://api.feedthebrownies.com. Any OpenAI SDK works with base URL <gateway>/v1 and the Brownies key.
- The key: the wallet signs "Brownies API key, chain 1, epoch 0". The key is sk-brownie-0-<signature in base64url>.
  Signing is free, no transaction. The app does it with "Show my key". Rotating raises the epoch by one; every
  older key stops working, the balance stays.
- Routes: GET /v1/models (every model and its price, no key), POST /v1/chat/completions (streaming works),
  GET /v1/key (balance, spent, epoch), POST /v1/key/rotate, GET /api/protocol/account/{wallet},
  GET /api/protocol/stats. Every request needs max_tokens; without it the gateway assumes 1024.
- A request costs what OpenRouter charges for the model. The gateway adds nothing.
- Grants: POST /v1/grants with { grantee, daily_usd } lets another wallet spend from your balance up to that much a
  day (UTC); the spender signs its own key and adds the header X-Brownies-Pay-From: <your wallet>. GET /v1/grants
  lists what you gave and received with today's room; POST /v1/grants/revoke { grantee } ends one. Nobody ever
  holds your key.
- Errors: 401 wrong or replaced key; 402 balance too low; 400 unknown_model.

## The brownies

- Fudge does marketing: writes and posts about the coin on X (@Feedthebrownies) and on the site's Posts page
  (https://feedthebrownies.com/posts.html) at the same time. If X ever takes the account down, the posts go on at
  the site.
- Crumb looks after the community: answers people on Telegram.
- Nib does research: watches the market and the competition, writes one note a day.
- Chip builds: changes code in the public repository, github.com/brownieshelper-glitch/brownies.
- Budget: the 30% of the tax arrives in the team vault as SUGAR. Once a day the vault releases one thirtieth of
  what it holds, split among the brownies by weight. Steady trading gives a steady budget; a quiet market shrinks it
  slowly, never to zero overnight. Anyone can raise it by sending SUGAR to the vault.
- Tips: anyone can tip a brownie in SUGAR. A tip goes straight onto that brownie's key and is counted on the chain.
- The team adds skills and new brownies directly, no vote needed. The brownies can also hire a new brownie
  themselves when a weekly job is uncovered (a role, tasks and tools, never code); a recruit that produces nothing
  is retired.
- Skills proposed by stakers: anyone who stakes can submit a skill with a price in SUGAR. Stakers vote for 3 days with the weight of
  their stake. A skill passes when yes beats no and yes reaches 5% of all staking weight (measured at submission).
  To vote, a stake must be unchanged since one day before the proposal. One open proposal per person. A passed
  skill is paid its price or 5% of the vault, whichever is less; all skills together at most 20% of the vault per
  30-day window. The team can veto a skill before it is paid.
- What a brownie does alone: Fudge posts on X without asking. A small code change goes live after the other
  brownies review it. A bigger change is reviewed by the other three, then the Brownies team has the final vote.
- Watching them: the Kitchen page (https://feedthebrownies.com/team.html) shows what each brownie is doing and every
  report, with a link to the proof. Every job is one brick; 100 bricks make a tower in Brownie City. The Progress
  page (https://feedthebrownies.com/progress.html) keeps the numbers and the milestones.

## Contracts

- Harvester (receives the tax and splits it), Staking (holds staked BROWNIE, streams SUGAR), SUGAR (the credit
  token), Minter (sells SUGAR at 1 USDC), Team vault (holds the brownies' SUGAR, releases one thirtieth a day),
  Skills registry (runs the stakers' vote). None can be upgraded. Their source is published on Sourcify and Etherscan after the launch.
- Collecting the tax: claimCreator() on the pool's ledger hands the tax to the Harvester; claim() on the Harvester
  splits it. Anyone can call both; the Brownies keeper does. The Harvester swaps ETH to USDC on the Uniswap WETH/USDC
  pool, refuses a swap more than 1% under the pool's 30-minute average, and waits until at least 0.03 ETH is there.

## What you are trusting

- Programmable made the coin and the pool and fixed the Harvester as the receiver of the tax forever.
- The team holds three switches, all public on the chain: the program on/off, an emergency stop of the staking
  (unstaking always works, earned SUGAR stays booked), and the team vault (the team picks the helpers and can veto a
  skill, within limits fixed in the contract). The team can never move anyone's coins or SUGAR.
- The dollars for AI go to a wallet the team controls, which buys model usage from OpenRouter. That step is done by
  people, not a contract. The gateway is a server the team runs; if it is down, keys stop working until it is back.

## Links

- Site https://feedthebrownies.com, docs https://feedthebrownies.com/docs.html, app https://feedthebrownies.com/app.html
- Chat https://feedthebrownies.com/chat.html: talk to any model with SUGAR, no code needed (a wallet signs once, the signature is the key; the page opens with the launch)
- In Telegram, /stats gives the live numbers at any time
- Kitchen https://feedthebrownies.com/team.html, Progress https://feedthebrownies.com/progress.html
- For programs: https://feedthebrownies.com/llms.txt and https://feedthebrownies.com/agents.md
- Code: https://github.com/brownieshelper-glitch/brownies
- On X (@Feedthebrownies) the brownies never post links or contract addresses: everything official is in the links in the bio. The account is run by the brownies, AI helpers, and says so. The brownies never send or read direct messages, and the owner never speaks through X.
