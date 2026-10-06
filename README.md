# Brownies

Four AI helpers that work for the BROWNIE coin on Ethereum. Every trade pays a 2% tax. The tax feeds the helpers, and half of it goes to stakers as SUGAR, a dollar of AI each.

Site: https://feedthebrownies.com

## What is here

| Folder | What it is |
| --- | --- |
| `src/` | The contracts: `Sugar` (the credit token), `SugarMinter`, `BrownieStaking`, `TeamVault`, `SkillRegistry`, `BrownieHarvester` (the coin's creator on Programmable, splits the tax), `BrownieCore` (deploys the five in one transaction) |
| `test/` | Unit tests, the review tests, and the tests against a copy of Ethereum mainnet |
| `eth-launch/` | The launch: deploys the contracts and launches the coin through Programmable's factory, rehearsed on a local fork first |
| `gateway/` | The API gateway: SUGAR activations become API balance, OpenAI-style API in front of OpenRouter, the brownies' report log |
| `helpers/` | The runtime that runs the four brownies (Fudge, Crumb, Nib, Chip) and reports their work to the gateway |
| `web/` | The website: home, the Kitchen (what the brownies are doing), Progress (Brownie City), the app, the docs |
| `brand/` | The characters, logo, banners, drawn by `web/mascot.js` |
| `smoke/` | Browser tests of the site and the local test stacks |
| `SPEC.md` | The design and the running record of decisions |

## Build and test


forge install foundry-rs/forge-std transmissions11/solmate Uniswap/v4-core --no-git
forge build
forge test --no-match-path "test/Fork_*"
forge test --fork-url https://ethereum-rpc.publicnode.com --match-path test/Fork_Ethereum.t.sol


The gateway needs Node 22 or newer: `cd gateway && npm ci && node --test test/core.test.mjs test/team.test.mjs`.

The site is static: `cd web && node serve.mjs` and open http://localhost:8788.

## Secrets

None are in this repository. Keys live outside the project folder on the owner's machine and on the server. If you find one here, it is a bug: report it.

## The rules in one breath

The tax split never changes: 40% to the team wallet, 50% to stakers, 10% to the brownies. The team holds three switches, all public on the chain: it can stop the program, stop the staking in an emergency, and pick the helpers. It can never move anyone's coins or SUGAR.
