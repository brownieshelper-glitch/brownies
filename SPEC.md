# BROWNIE. Inference credits, agent companies and holder agents on Robinhood Chain

SPEC v0.4, 2026-10-02. Replaces v0.3 (launchpad split changed to Orbio's shape: 50 / 30 / 12 / 8). Folder "agent-company" until renamed. Domain candidate: brownies.fun.
Studied: Kairence (memory kairence-agent-launchpad-research), Orbio and Moonlet (memory orbio-credit-moonlet-research).
Owner's framing, 2026-10-02: "we are gonna be a competitor of orbio, so we have to offer all the functions orbio offers".

## STATUS, 2026-10-05 (after the rebrand)

Built and tested, nothing deployed.

REBRAND 2026-10-05, chosen by the owner: the project is BROWNIES. The coin is Brownies / BROWNIE. The credit token
is Brownie Sugar / SUGAR (was SPARK; confirmed by the owner). The four AI helpers are
the brownies: Fudge (marketing, megaphone), Crumb (community, headset), Nib (research, magnifier), Chip (builder,
wrench). Colours stay orange, black, white. Everything was renamed: contracts, tests, scripts, gateway, site, docs.
The secrets files keep their old names (helix-secrets/synapse.env and synapse-gateway.env).

Brand (brand/ and web/mascot.js): one drawing file, web/mascot.js, makes every brownie, the row of four, and the
coin logo. brand/team.html, banner.html, og.html and logo.html are screenshot sources; brand/make-assets.mjs writes
web/assets/mark.svg and favicon.svg. Rendered: brand/team.png, banner.png (1500 x 500), og.png, logo-512/1024.png.

Contracts (src/), all immutable except the owner role of the team vault:
- Sugar, SugarMinter, BrownieStaking, BrownieHarvester, BrownieCore (one-transaction deployer), PonsPredict,
  TeamVault, SkillRegistry. The harvester is child 5 of the core.
- BrownieStaking has the loyalty boost (1.10 after 30 days, 1.20 after 90, 1.30 after 180). TeamVault releases
  balance / 30 a day to the helpers by weight, takes tips, and pays skills through a payer capped at 20% of the vault
  per 30 days. SkillRegistry: stakers vote 3 days, quorum 5%, at most 5% of the vault per skill, team veto.

Tests: test/Core.t.sol 42 unit tests; test/Fork_Harvester.t.sol 8 tests against real Pons and the real WETH/USDG
pool; gateway 8 tests; smoke/site-e2e.mjs drives the site in a real browser, 83 of 83 (app, intro, kitchen and
progress, screenshots of 5 pages at 4 widths).
The local test stack now uses port 8556 for its chain (8546 was taken by another project).

Site (web/): home rebuilt around the brownies (the four stand on the edge of the hero, a team section with one card
each), app, docs (the part "The brownies" names the four and the rules for posts and code), agents.md, llms.txt.

Intro (2026-10-05, asked for by the owner): web/intro.js plays a full-screen scene over the home page on the first
visit of a session. The four brownies run in, race for falling SUGAR cubes (one falls now and then, and one wherever
the visitor clicks), leap over each other, and react: Fudge shouts and the others jump, Nib inspects a neighbour.
"Enter the site", Enter, Escape, a scroll or a swipe up lifts it. Skipped for reduced motion, for #links and with
?intro=0; ?intro=1 replays it. Checked by smoke/site-e2e.mjs intro (13 checks). SUGAR is confirmed by the owner.

Kitchen and Progress (2026-10-05, asked for by the owner: "a page ... the helpers that are working and a view of
what they are doing", "a page where all the progress made by the coin are shown"):
- gateway/teamlog.mjs: the team log. The brownies report with POST /api/team/log (the key TEAM_LOG_KEY, 1 to 20
  entries: helper, kind = status | post | reply | research | build | deal | milestone | note, title, body, https url,
  place, cost_micro). Public reads: GET /api/team/activity and GET /api/team/summary. Every field is checked and cut
  to size; the site prints report text as plain text (tested with markup in a report).
- web/team.html (nav name "Kitchen"): one card per brownie (its task now, reports today and so far, AI used today,
  SUGAR fed by the vault, tips) and the list of reports with a filter per brownie and links to the proof.
- web/progress.html: the numbers since launch from the contracts, the last 7 days of reports by kind, the milestones.
- Both pages stand with nothing behind them (no deployment, no gateway): cards and plain empty lines, no empty blocks.
- smoke/seed-team.mjs fills the test gateway with sample reports; smoke/site-e2e.mjs pages checks both (13 checks).
- The phone header now has two rows: logo and button, then the page links.

Brownie City (2026-10-05, asked for by the owner: the Kitchen should move and be interactive, and the work should be
shown as the brownies building something that grows, a new building every 100 tasks, slowly a whole city):
- Every reported job is one brick. 100 bricks make a tower (three tower shapes), a finished tower gets icing and a
  numbered flag, then the next tower starts. web/city.js draws both views.
- Kitchen (web/team.html): a building site on top. The brownies carry bricks from the oven and throw them into
  place in order; on load the last 5 bricks are laid again so a visitor sees work happen; new reports are fetched
  every 30 seconds and laid the same way. Pointing at a brick shows the job behind it; a click on a brownie shows
  what it is doing. The camera is close while the tower is low and backs away as it grows. Older and newer towers
  can be opened. Under it: the cards and the full list of reports. On a phone there is no oven (no room).
- Progress (web/progress.html): the city on top, every tower so far side by side with empty lots after them; a
  tower links to the Kitchen opened on that tower (?tower=N).
- Gateway: GET /api/team/activity takes order=asc and offset; GET /api/team/towers lists the towers.
- The first version of the Kitchen (cards and a list only) is kept in versions/kitchen-v1-2026-10-05/ with the
  whole site of that moment (whole-site.tgz) and pictures.
- Tests: gateway 9, site e2e 94 of 94.

REVIEW, 2026-10-05 (three independent reviewers, one per area; every fix has a test in test/Review.t.sol):
- FIXED, was critical: a skill vote could be won with coins held for one transaction. A stake's age is an average,
  so an old dust stake kept the age old while borrowed coins joined it. Now staking records lastStakeAt (the last
  time coins were added) and a vote needs lastStakeAt at least 1 day before the proposal. Confirmed by running the
  reviewer's proof before the fix (it was paid 50 SUGAR) and after (StakeTooYoung).
- FIXED, was high: the vault owner could name itself payer and pay itself 20% of the vault at once. Now the first
  payer is set at launch and any later payer waits 7 days in public (setPayer proposes, acceptPayer installs);
  switching payouts off stays immediate.
- FIXED, medium: quorum was read at finalize and could be moved by staking around the count; it is now the staking
  weight at submit. The pay cap now follows a vault that shrank (20% of the smaller of the window's opening balance
  and the balance now plus the window's payouts). Windows still chain: up to 36% across a boundary, said in the code.
- FIXED, low: a passed proposal is never settled for 0 (it waits); one open proposal per author and a 1-day-old
  stake to submit; a helper's key can be replaced (setKey); fund() takes at least 1 dollar and not from the
  funding wallet; a stake older than 180 days no longer lends its bonus to new coins; stake() counts what arrived.
- NOT FIXED, carried into the Ethereum version of the harvester (it is being rewritten for that chain anyway):
  a failed swap also blocks the 40% payout (run the swap in a try); no cap on swap size (add MAX_SWAP); no check of
  the pool's oracle cardinality; deploy.sh must broadcast with --slow and check on chain that the harvester has code
  and is the fee recipient before any buy; the dry run must not overwrite the deployment record; the vault's owner
  should move from the hot deploy key to a cold wallet; the first buy needs a minimum out.
- Known and accepted: a staker with 5% that nobody opposes can pass skills up to the cap (the team veto is the
  answer); a forced settle can cost a staker under one millionth of a dollar; releases that are missed do not catch up.
- Tests after the fixes: 53 unit (42 + 11 review), 8 fork.

CHAIN, 2026-10-05: the owner said the project will launch on ETHEREUM, not Robinhood Chain. Everything so far was
built for Robinhood Chain and Pons. Chain-independent and kept: Sugar, SugarMinter, BrownieStaking, TeamVault,
SkillRegistry, the gateway, the site. To redo for Ethereum: the harvester's pull from the launchpad (Pons does not
exist there; HELIX used Programmable Classic, whose fee vault pays the payout wallet when that wallet calls claim),
the dollar token and its pool (USDC and the WETH/USDC v3 pool are the natural choice; WETH is token1 there), the
deployer and deploy script, the fork tests, the chain settings of the site, gateway and test stack. Gas on Ethereum
was 0.3 gwei that day.
DECIDED 2026-10-06 by the owner: (1) launch tool "probably" Programmable, in its new module mode on Ethereum
(https://programmable.market/launch/modules/foundation?chainId=1), facts being checked; (2) the stakers' and the
brownies' share is converted to USDC automatically, inside the contract, the moment the tax is claimed ("so we are
sure to keep that peg 1:1"). The team's 40% stays in ETH. So the swap stays in the contract, with the review's
fixes: a failed swap must not block the 40%, a cap on swap size, a check of the pool's oracle.

ETHEREUM PORT, step 1 done 2026-10-06: src/BrownieHarvester.sol rewritten for Ethereum and Programmable Foundation.
- The harvester IS the coin's creator (Programmable fixes it forever; nobody can redirect). Fees arrive as WETH when
  anyone calls the launch ledger's claimCreator(); claim() here wraps loose ETH, books 40% for the main wallet (paid
  as ETH) and 60% for the swap, swaps WETH->USDC on the v3 0.05% pool (USDC token0) within 1% of the 30-minute
  average, 5/6 to staking.fund, 1/6 minted as SUGAR to the vault. Review fixes in: the swap runs in its own call
  (try) so a bad price never blocks the 40%; MAX_SWAP 20 ETH per claim; MIN_SWAP 0.03 ETH; the pool must have at
  least 100 observations; a gas floor (700k) only when a swap is due.
- THE SWITCH, asked by the owner ("i should be able to switch the program on and off whenever i want"): owner-only
  setProgram(bool), instant, with an event. Off = every new fee to the main wallet; what was already booked for the
  swap is still swapped and paid; SUGAR already minted is unaffected. Owner = Config.teamOwner (same as the vault),
  two-step transfer. The site must say "the split is fixed, but the team can stop the program at any time".
- BrownieCore: no Pons; Config = token, weth, usdc, wethUsdcPool, mainWallet, fundingWallet, teamOwner, minPosition.
- Tests: 53 unit (the Pons mocks gone) + test/Fork_Ethereum.t.sol, 8 tests on a mainnet fork (real WETH, USDC,
  pool): split, switch, bad price waits, cap, gas floor, callback, plain ETH.
- Pons version kept in versions/robinhood-pons-2026-10-06/ (harvester, core, PonsPredict, IPonsV2, Deploy.s.sol,
  deploy.sh, Fork_Harvester). Programmable's verified sources, ABIs, creation bytecodes and the salt derivation
  (derive.mjs) are in eth-launch/programmable/ (from the 2026-10-06 research).
- LAUNCH TOOLING DONE 2026-10-06 (eth-launch/): launch.mjs (plan | fork | broadcast --i-am-the-owner with LAUNCH_IT=1), programmable.mjs (addresses, ABIs, bytecodes, salt and address algebra, hook salt miner, tick for a dollar market cap), check-derivation.mjs (recomputes 9 real Programmable launches from their inputs: all match in every field), rehearse-fees.mjs + rehearse.sh (anvil fork on 8557: deploy core + registry + setPayer, deployGraph UNSTAMPED with launchWallet = harvester, 15 post-launch checks, buys and a sell through the real Universal Router, claimCreator by a stranger, harvester.claim by a stranger). Rehearsal run by me: fee 0.102652 WETH -> 0.041061 ETH to the main wallet (40.00%), 166.61 USDC to the funding wallet (138.84 via staking.fund, 27.77 as SUGAR in the vault). brownies.json: 2%/2%, start cap 5,000 USD, wallet cap 2% for 3 min, no first buy. Fork runs write web/deployments/1.fork.json (never 1.json). Total gas about 14M.
- STILL TO DO for the port: (deploy script done, see above) (deploy the core, then launch the coin through Programmable's graph
  deployer 0xB012... directly with launchWallet = harvester, token address computed first with derive.mjs, no first
  buy through the launch); the keeper calling ledger.claimCreator() + claim() from 0.05 ETH and vault.release()
  daily; a Sourcify verify script; USDG -> USDC naming sweep; chain settings of site (chain 1, Etherscan, USDC
  0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48), gateway and test stack (Ethereum fork + a test launch); site copy
  (Robinhood Chain -> Ethereum, Pons -> Programmable, the switch disclosure); the deploy wallet needs about 0.05 ETH
  on Ethereum (it has 0).

EMERGENCY STOP 2026-10-06 (owner asked: "a command by the dev wallet that can close the staking at any moment for emergency reasons"): BrownieStaking now has owner (= Config.teamOwner, two-step transfer) and setStopped(bool). Stopped = stake(), fund() and claim() revert; unstake() and exit() ALWAYS work (exit returns the coins and leaves the earned SUGAR booked); restart resumes claims. Tests: test_stop_* and three test_attack_* in test/Review.t.sol (57 unit tests, 8 fork tests pass). Site copy updated: three team switches (program on/off, emergency stop, vault), never anyone's coins or SUGAR. Site republished.

GATEWAY ONLINE 2026-10-06: on the HELIX droplet 142.93.168.190 (ssh -i ~/.ssh/helix_keeper root@...), code in /srv/brownies/gateway, env /etc/brownies/gateway.env (copy of helix-secrets/brownies-gateway.env: OPENROUTER key, KEEPER_PRIVATE_KEY, TEAM_LOG_KEY, SUGAR/HARVESTER/LEDGER/TEAM_VAULT addresses EMPTY until launch), systemd brownies-gateway, Caddy 2.6 reverse proxy api.feedthebrownies.com -> :8790 (DNS A at Vercel and Porkbun; CAA letsencrypt.org added at Vercel). The gateway now starts without SUGAR_ADDRESS: reports work, /v1 answers 503 not_launched. Deploy again with bash gateway/deploy-server.sh. Site config.js gateway = https://api.feedthebrownies.com.

APP PAGE 2026-10-06: two new sections, "Tip a brownie" (select a helper from the vault, approve + tip) and "Skills" (list of proposals with yes/no/bar, vote and settle buttons, a propose form). ABI for the registry added to common.js with plain error sentences. Checked by smoke/eth-site-check.sh (anvil fork of Ethereum, the real launch flow, four helpers, one proposal): 7 of 7. The old site-stack.sh is Robinhood-based and does not work any more; the Ethereum stack for the full browser flow is still to be rebuilt on eth-launch.

KEEPER ON ETHEREUM 2026-10-06: gateway/chain.mjs now does the keeper's three duties every CLAIM_EVERY_SECONDS (300): ledger.claimCreator() on Programmable's fee ledger once CLAIM_MIN_ETH (0.05) of creator fee waits, harvester.claim() once that much fresh WETH sits in the harvester or a swap waits or the main wallet is owed, TeamVault.release() once a day when the budget is worth RELEASE_MIN_SUGAR (1). Every call is simulated first; a failing simulation is logged once an hour and skipped; under KEEPER_FLOOR_ETH (0.01) nothing is sent and the log asks for a refill. Settings LEDGER_ADDRESS and TEAM_VAULT_ADDRESS join the env (empty until launch). Tests: gateway/test/keeper.test.mjs (8, fake contracts; 17 gateway tests in all) and smoke/eth-keeper-check.sh (mainnet fork, the real launch flow, fees traded and claimed, four helpers; 17 checks: the first release hands out one thirtieth to the four keys, a fresh 0.1 ETH fee pays exactly 40% to the main wallet and funds the stakers in USDC, nothing is sent when nothing is due). /api/protocol/stats now reports creatorUnclaimedWei, freshWei, pendingRestWei, mainOwedWei, programOn and the vault's next release.

POST-LAUNCH TOOLING 2026-10-06: eth-launch/add-helpers.mjs (plan | fork | broadcast --i-am-the-owner, LAUNCH_IT=1) puts the four brownies on the TeamVault payroll with key = bytes32 of the helper wallet (the gateway's beneficiary id), weight from <NAME>_WEIGHT (1), skips wallets already there, refuses a second helper with the same name, simulates from the owner first; tried on a fork (plan, add four, re-run adds nothing, broadcast refused without the gate). eth-launch/verify.sh publishes the seven contracts' sources on Sourcify (always) and Etherscan (when helix-secrets/etherscan.env has a key), constructor arguments written out from web/deployments/1.json because six of the seven were created inside BrownieCore's constructor; DRY=1 prints the commands with the key hidden.

API ONLINE 2026-10-06: https://api.feedthebrownies.com answers with a Let's Encrypt certificate. Two things had blocked it: the registry still lists Porkbun's nameservers (the switch to Vercel's did not take), so DNS is served by Porkbun's zone (A api -> 142.93.168.190, A apex -> 76.76.21.21, CNAME www -> cname.vercel-dns.com; the same records exist at Vercel for when the nameservers move), and the droplet's ufw only allowed port 22 (80 and 443 opened). feedthebrownies.com, www and api all answer.

THE BROWNIES RUNTIME, LIVE 2026-10-06 (helpers/, 46 tests, owner's rule "no dry mode"): one Node service, brownies-helpers on the droplet next to the gateway (/srv/brownies/helpers, env /etc/brownies/helpers.env copied from helix-secrets/brownies-helpers.env, redeploy = bash helpers/deploy-server.sh). Fudge posts on X at 9, 13, 18 Rome and answers mentions every 20 minutes; Crumb answers Telegram (group and private) within a minute and reports once an hour per chat; Nib writes one research note a day into notes/YYYY-MM-DD.md; Chip works GitHub issues labelled "chip" and standing tasks as pull requests: small text/docs/style/test changes merge alone after Fudge, Crumb and Nib each say yes, anything else or any no goes to the owner on Telegram with Approve and Reject. Every job is a report in the Kitchen. MODE=prelaunch thinks through OpenRouter with daily caps (1.5 / 2 / 1 / 3 USD), models claude-haiku-4.5 (Fudge, Crumb) and claude-sonnet-5.5 (Nib, Chip); MODE=live after the launch pays through the gateway with each helper's wallet key. HELPERS_OFF=fudge keeps Fudge quiet until the owner wants the first post. Facts the helpers may state are in helpers/facts.md (the coin is NOT launched, no addresses yet). First day: Nib's note committed, Chip's PR #1 (notes/README.md) reviewed yes/yes/no and waiting for the owner. Two fixes from that first run: Claude 5 models spend hidden thinking tokens inside max_tokens and OpenRouter refuses to turn it off (the first note was cut), so lib/brain.mjs adds 800 tokens of headroom and warns on finish_reason length; a review without a reason is asked once more.

E2E STACK ON ETHEREUM 2026-10-06: smoke/site-stack.sh rebuilt on an anvil fork of mainnet (:8563) with the real launch flow (launch.mjs fork, rehearse-fees, add-helpers fork), the gateway live on the fork (:8792) behind a stand-in OpenRouter (smoke/mock-upstream.mjs :8793), the site (:8791), sample reports; `bash smoke/site-stack.sh once` runs smoke/site-e2e.mjs all (114 checks, now including tip, propose, vote and settle) and stops only its own PIDs. The first run found a real site bug: the SUGAR ABI in web/common.js had no allowance/approve, so the Tip button failed; fixed and republished. The old Robinhood stack is in versions/robinhood-pons-2026-10-06/site-stack.sh.

FIRST TASKS + POSTS ON THE SITE 2026-10-06 (owner: "yes perfect" to the suggested first tasks; then "if the twitter account gets banned ... we post at the same time on the twitter but also at the same time in a section of the website"):
- Fudge posts to X and to the site at once: every post is a "post" report, the home page band "What Fudge is saying" (#saying) shows the latest five and web/posts.html all of them (web/posts.js reads /api/team/activity?helper=fudge&kind=post). When X refuses (banned account, dead token) or X is not configured, the post still goes out with place "site" and the owner is told; site-only posts count toward the three a day and the no-repeat check. Fudge's post prompt now carries TODAY'S WORK from the team summary, so a post about the Kitchen says what really happened.
- Crumb finds its group by itself: with TELEGRAM_GROUP_CHAT_ID empty it adopts the first group the bot is added to (my_chat_member) or hears a message in, remembers it in the store (tg:group:auto), forgets it when removed. (The owner's link t.me/feedthebrownies is the Safeguard CHANNEL, not the group; the group has no public link.) Crumb also writes the day's questions digest at 20:00 Rome into notes/questions/YYYY-MM-DD.md (Q and A per distinct question, "not in the facts yet" marks gaps), reported as a note.
- Nib lists the coins launched through Programmable on Ethereum in the last 24 hours, read from the chain (helpers/lib/launches.mjs: the graph deployer's ProgrammableCreate2GraphDeployed logs, then each receipt's FoundationLaunchedV3, then name/symbol). The public RPC publicnode refuses a day of eth_getLogs ("archive request"), rpc.mevblocker.io serves it in 5 s: the RPC list is in brownies.json (nib.launches.rpcUrls) with a fallback. 16 launches found on 2026-10-06.
- GitHub: label "chip" made, issue #2 "Add a FAQ page from the questions people ask" (Chip builds web/faq.html from notes/questions/*.md; a bigger change, so the owner decides). The other suggestions were already standing tasks or topics.
- Runtime tests: 54. Deployed to the droplet.

ROUND 3, 2026-10-06 evening (owner: Telegram link confirmed = https://t.me/feedthebrownies, X link on the site, daily owner summary, /stats, the chat page, a hidden fifth brownie):
- Links: Telegram and X in every page footer (app.html has no footer; its key section links the Chat page); facts.md names both.
- Daily owner summary (helpers/lib/summary.mjs): at 22:00 Rome one Telegram message to the owner: per brownie the day's jobs by kind, spend against the cap, the last job; totals; what waits for a decision; what failed. /summary in the owner's private chat sends it now. No model call.
- /stats (Crumb, helpers/crumb.mjs statsText): in the group and in private, the live numbers from the gateway only, once a minute per chat, no model call. Pre-launch: "not launched yet" plus the Kitchen counts.
- The Chat page (web/chat.html, chat.js): connect a wallet (wallet.js), sign the key message, see the balance from /v1/key, pick a model from /v1/models, talk with streaming through /v1/chat/completions; 402 and 401 explained in a sentence; the conversation lives in the tab only. Before the launch the gateway's /health says live=false and the page shows "The gateway opens with the launch".
- The fifth brownie is GLAZE (business development), HIDDEN: it lives in helpers/private.json + helpers/helpers/glaze.mjs (+ test), all gitignored, deployed by the tar of deploy-server.sh; run.mjs loads private.json and imports its module; a hidden helper never reports to the Kitchen (base class), only to the owner on Telegram. Glaze drafts, in full, what a human must send: the Programmable indexing request, DexScreener/Etherscan/GMGN token info, CoinGecko and CoinMarketCap applications, three partnership messages to coins launched on Programmable, a press blurb; one a day at 10:00 Rome, a line "Glaze: ..." in Nib's note comes first, /glaze <what> from the owner at once. Wallet 0x4c50A8f08D834648B245a950A053f2db48D9075e (key in brownies-wallets.env + brownies-helpers.env as GLAZE_PRIVATE_KEY). To announce it: move its files into the repository, add it to the vault with add-helpers (HELPERS=...,Glaze GLAZE_ADDRESS=...), set hidden false, draw its mascot. 62 runtime tests. Deployed.

ROUND 4, 2026-10-06 night (owner: "Sprinkle for sure", before launch, hidden; plus a social-media agent that scouts and manages Instagram, TikTok, LinkedIn, Snapchat "if possible"):
- SWIRL, the social-media brownie, HIDDEN (helpers/helpers/swirl.mjs + test, gitignored; config in private.json): a weekly plan every Monday 9:00 Rome (where to be, what to post, accounts to open, what worked) and one account prepared a day at 15:00 (three handles, name, bio, picture, link, first three posts, the sign-up steps and how to connect official posting access), all to the owner on Telegram; /swirl plan, /swirl <platform>, /swirl <question>. It NEVER signs up by itself (the platforms forbid it and ban the handle). What official access allows (PLATFORMS in swirl.mjs): YouTube Shorts (Data API), Instagram reels/images (Meta Graph API, professional account + app review), TikTok (Content Posting API, private until the app is audited), LinkedIn personal profile (w_member_social; company page needs partner approval), Threads, Farcaster, Reddit; Snapchat has NO posting API (Swirl prepares, the owner posts by hand). Posting adapters come per platform once the owner has the account and the access. Wallet 0xcf828AaE561332B6A7242d7B8D441f258BA3735a. First job done: YouTube account prepared, sent to the owner.
- SPRINKLE, the video brownie, HIDDEN, being built by a subagent (helpers/video/ engine + render with @resvg/resvg-js + ffmpeg, helpers/helpers/sprinkle.mjs; all gitignored): no browser on the 1-CPU/1 GB droplet, so frames are SVG from web/mascot.js rasterised in Node and encoded by ffmpeg (installed on the server 2026-10-06, version 6.1.1). Kinds: explainer (30-45 s, facts only), episode (15-30 s cartoon of the brownies working together, captions), number (10-15 s, one figure). Vertical 1080x1920 and wide 1920x1080. One video a day at 11:00 Rome to the owner on Telegram (sendVideo) + /sprinkle <what>. Wallet 0x708545e4e24D5942edC966AC5dd6Ff36187e7a4e. Posting to YouTube/TikTok/Instagram comes through Swirl's adapters once the accounts exist.
- SPRINKLE DEPLOYED 2026-10-06 18:32 UTC. The first render was KILLED BY THE OOM GUARD (node at 810 MB on the 1 GB droplet: the rasteriser's pixels live outside the JS heap, so the collector never ran). Fix: the render runs in a child process (helpers/video/render-child.mjs, spawned by renderVideoInChild with --expose-gc --max-old-space-size=192, gc every 15 frames); a crash or a kill ends the child, never the service; the job file and frames folder are removed either way. 83 runtime tests (one renders a real 1-second clip through the child with the local static ffmpeg).
- Research-to-code loop: every "Chip: ..." line in Nib's note becomes a GitHub issue labelled chip (at most 2 a day, never the same twice; nib.chipIssues=false switches it off). github.mjs createIssue. 67 runtime tests.

VIDEOS, 2026-10-06 night (owner: "make sprinkle already working at 2 videos at least": an introduction of the whole project and episode 1 of the cartoon):
- New kind "pilot" (50-80 s, one scene per brownie at its job, a mishap, all four together) with a finished fallback script "A day in the life"; the explainer may run to 60 s; pickKind: introduction words win over "their jobs". helpers/video/request.mjs asks Sprinkle by hand on the server (same code path as /sprinkle).
- Finding: on the long script prompt Sonnet 5.5 spent ALL 3800 tokens thinking and returned nothing (the fallback script was used). OpenRouter refuses reasoning.enabled=false but accepts reasoning.effort "low", measured at zero thinking tokens with the full answer: it is now the brain's default for every call (lib/brain.mjs DEFAULT_REASONING; a call may override). Sprinkle's script call gets 4500 tokens.
- Video 2 "Meet the Brownies" (explainer, model-written, 12 shots, 56 s, every caption a fact) sent to the owner in both formats; video 3 = episode 1 (pilot) followed. 86 runtime tests.

NOT BUILT YET:
- (Built 2026-10-06, see THE BROWNIES RUNTIME.) Still open there: the Telegram group (Crumb answers private chats
  only until TELEGRAM_GROUP_CHAT_ID is set), Fudge's first post (HELPERS_OFF=fudge until the owner says so),
  MODE=live after the launch.
- A tip button in the app. The home page says anyone can tip a brownie; today that is only a contract call.
- Checked 2026-10-05 (the owner asked what is left on the tech side): the app has no page to propose or vote on a
  skill either (built 2026-10-06, see APP PAGE); the keeper only called harvester.claim() (fixed 2026-10-06, see KEEPER
  ON ETHEREUM); the verify script and the add-helpers script are done (see POST-LAUNCH TOOLING); the contracts had
  their review round (see REVIEW). Still open from that list: nothing.
- Social accounts. Owner wish 2026-10-05: the brownies get the project Gmail and X, and open more accounts
  (LinkedIn, Snapchat, Instagram, TikTok) to post videos and news. Decided position: the brownies do NOT sign up by
  robot (the platforms forbid it, check for it, and ban the handle). A brownie asks for an account with the name, bio
  and picture ready; the owner signs up in a few minutes; the brownie then posts through the platform's official
  posting access. Passwords and tokens stay in a keyring on the server and are never shown to a model.
- Short videos for TikTok, Instagram and X made from the brownie animations (needs a video encoder on the server).
- A way to spend SUGAR without code (a chat page), so the reward is useful to buyers who are not developers.

Still needed before launch (2026-10-06): the deploy wallet funded with
about 0.05 ETH (owner), a test coin launched the same way first (owner's wish), then "launch it"; after the launch:
verify.sh, add-helpers.mjs broadcast, the four addresses + START_BLOCK into the gateway env and restart, Programmable
indexes the coin by hand. The domain, https, site, keeper wallet are done. Owner decisions open: first buy (none, by
the plan), smallest stake (10,000 BROWNIE in brownies.json).

## 0. One paragraph

BROWNIE is a coin launched on Pons with a 2% tax on every buy and sell. The tax is the protocol's revenue. 40% of it is
the protocol's cut; the rest pays for inference: it is turned into dollars that fund a gateway to every AI model, and
into SUGAR, a token where 1 SUGAR buys 1 dollar of inference on that gateway. People who stake BROWNIE earn SUGAR every
hour. Anyone can launch an agent coin on Pons through Brownies. Its fees follow Orbio's shape with better numbers:
50% is staked in BROWNIE for the agent, 30% is minted as SUGAR, 12% is activated so the agent thinks the same hour,
and 8% goes to the protocol where Orbio takes 10%. The agent's principal is locked for three weeks; after that the
launcher can withdraw it, paying a fee to the Brownies main wallet. Holders of any coin can create home-baked brownies, small
agents paid in SUGAR that work for the coin, with every run receipted on chain. Everything on chain is immutable and
verified, which is the one thing Orbio does not offer.

## 1. The competitor, measured

Orbio (orbio.so), live on Robinhood Chain. ORBIO is itself a Pons v2 launch (paired with NVDA, 0.8% creator tax) whose
fee recipient is its own staking contract. Numbers read on 2026-10-02: market cap about 82M USD, 16M USD daily volume,
290M ORBIO staked (30.6% of supply), 239k USD of fees collected all time, 227k USD of inference generated, 605k gateway
requests. Their agent launchpad went live on 2026-09-25 with four agent coins so far (TANK, OTIS, ORDESK, ERRAND), all
paired with ORBIO, taxes 0 to 1.5%. Every Orbio contract is an upgradeable proxy with admin, keeper and pauser roles,
and their launch terms "apply to every agent from the harvest it is changed in". The launchpad vault
(0x0E1651aEC67B2a049a4FA6aEb6C1c305aabfc35b) has an UNVERIFIED implementation on Sourcify, and each agent coin's fee
recipient is a 524 byte forwarder contract. Their public API: /api/protocol/agents (list, one agent, chart, terms,
analytics), a TypeScript SDK (@orbiodotso/sdk) with tools, balances, launch and claim, and a harvest every 5 minutes.

## 2. Function for function: what Orbio offers, what Brownies offers

| Orbio | Brownies | Our difference | Phase |
|---|---|---|---|
| ORBIO on Pons, NVDA pair, 0.8% tax | BROWNIE on Pons, ETH pair, 2% tax | more revenue per trade, ETH pair | 1 |
| Hold 1,000+ ORBIO, credits accrue hourly off chain; or stake on chain | Stake BROWNIE on chain, SUGAR accrues hourly, time weighted | on chain only, no dashboard ledger to trust | 1 |
| CREDIT token, 1 = 1 USD inference, activate burns to API balance, admin-set activation fee | SUGAR token, same rule, activation fee fixed at deploy | immutable | 1 |
| Gateway api.orbio.so/api/v1, OpenAI style, wallet-signature keys, GET /key, OpenRouter models | Gateway api.brownies.fun/v1, same shape, same key trick, OpenRouter models | drop-in replacement for an Orbio key | 1 |
| Exchange: order book CREDIT/USDG, buy, sell, buyAndActivate, holders auto-list | v1: SUGAR/USDG Uniswap v4 pool plus a buyAndActivate router. v2: order book | ship fast, then match | 1 then 4 |
| Agent launchpad: launch on Pons paired with ORBIO; fees 50% staked ORBIO, 30% CREDIT, 10% balance, 10% treasury; owner withdraws any time | Agent coins on Pons, ETH pair, 2% tax; 50% staked BROWNIE, 30% SUGAR, 12% balance, 8% protocol; principal locked 3 weeks, then the launcher withdraws with a fee | 2 points more to the agent, the lock protects buyers | 2 |
| Harvest every 5 minutes by their keeper; agent wallet may call it | Permissionless claim, our keeper calls it; anyone may | nothing waits on us | 2 |
| Tools catalogue metered in CREDIT at cost plus 10%: X reads, web search and scrape, chain reads, posting | Same catalogue, same pricing rule, same providers where possible | parity | 3 |
| MCP server, Claude Code plugin, OAuth "Sign in with Orbio", developer registration | MCP server, Claude Code plugin, OAuth "Sign in with Brownies" | parity | 3 |
| Moonlet, a third party app: holders' agents paid in CREDIT | Home-baked brownies, built in: holders' agents that work for the coin, approval queue, receipts anchored, Fuel, the sky | first party, team structure | 3 |
| Public analytics, dashboard, whitepaper, agents.md, llms.txt, API reference | Same pages, same machine-readable docs | parity | 2 and 3 |
| Public JSON reads (/api/protocol/agents, terms, analytics, minute charts) and a TypeScript SDK | Same reads at api.brownies.fun, an npm SDK with tools, balances, launch and claim | parity, plus every number also readable straight from immutable contracts | 2 and 3 |
| Buy credits at a discount from holders, card purchases via reservations, affiliates 1.5% via Whop | Discount buys through the pool and later the order book; cards and affiliates need a payment processor and a company | later, needs a legal entity | 4 |
| Build Week grants, starter kit, jobs page | Grants in BROWNIE and SUGAR, starter kit, jobs page | parity | 4 |
| Private inference ("incognito") | Not planned for v1 | skip | later |

## 3. The money

### 3.1 BROWNIE's own fees (the 2% tax Pons pays to the Harvester, in ETH)

| Row | Default share | Goes to | OPEN |
|---|---|---|---|
| Protocol cut | 40% | Brownies main wallet | fixed by the owner |
| Stakers' SUGAR | 50% | swapped to USDG, sent to the inference funding wallet; the same amount of SUGAR is minted into the hourly rewards budget for stakers | share open |
| Brownies' own agent | 10% | SUGAR activated to the Brownies agent's key, so the protocol's own agent thinks and posts | share open |

Against Orbio: they keep 50% of ORBIO's 1.5% fee and give holders 50%, which is 0.75% of volume. Our stakers' row is
50% of a 2% tax, 1.0% of volume, and the protocol keeps 40% instead of 50%.

Rule copied from Orbio because it is right: a SUGAR is minted only when a dollar has just gone to the wallet that buys
the inference. Issuance never outruns funding.

### 3.2 Agent coins launched through Brownies (their 2% tax, in ETH)

Orbio's split is 50 / 30 / 10 / 10. Ours is the same shape with the protocol row cut from 10 to 8 and both points
given to the agent (owner's rule, 2026-10-02: "if they take 10 we take 8").

| Row | Share | Orbio | Goes to |
|---|---|---|---|
| Staked | 50% | 50% | swapped to USDG, USDG to BROWNIE on its own Pons pool, staked in BrownieStaking for the agent; it earns SUGAR every hour and every launch is buy pressure on BROWNIE |
| SUGAR | 30% | 30% | swapped to USDG, sent to the inference funding wallet, the same amount of SUGAR minted into the agent's Treasury |
| Balance | 12% | 10% | swapped to USDG, sent to the inference funding wallet, the same amount activated to the agent's key the same hour |
| Protocol | 8% | 10% | the Brownies main wallet |

Orbio's idle rule, copied: once the agent's gateway balance holds 5,000 USD, the balance row is minted as SUGAR into
the Treasury instead, until the balance is spent below that line. A small ETH float, 2% of the agent's share, stays in
the agent Wallet for gas. There is no separate dollar pocket: the SUGAR in the Treasury is the agent's stable reserve.

### 3.3 The lock and the exit (owner's decision 2026-10-02)
- lockEnd = launch + 21 days, written on chain and shown on the coin's page.
- Before lockEnd nothing leaves the Treasury except SUGAR, earned by the stake or minted from the SUGAR row, and only
  by activation to the agent's key.
- After lockEnd the wallet that launched the coin may withdraw principal: unstake the BROWNIE and take the SUGAR not
  yet activated. Orbio lets the owner do this from day one; the three weeks are the one term stricter than theirs. A withdrawal fee goes to the Brownies main wallet. Default 10% of what is withdrawn
  (OPEN: the owner names the percent). The fee is a constant of the factory.
- Nothing about a coin's terms can change after launch. Orbio's terms can.

### 3.4 The claim, step by step (anyone may call it, our keeper calls it every 5 minutes like Orbio)
1. splitter.claim(): pulls the Pons escrow balance, books the rows, sends the protocol rows to their pull ledgers.
2. Swaps ETH to USDG through the Uniswap v3 WETH/USDG pool (0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca, about 29M USD
   deep), output within 1% of its 30 minute TWAP, only when at least 0.01 ETH is waiting.
3. Buys BROWNIE for the staked row on BROWNIE's own Pons pool with the same TWAP band and stakes it in BrownieStaking
   on the agent's behalf.
4. Sends the SUGAR row's USDG to the inference funding wallet and mints the same amount of SUGAR into the Treasury.
5. Sends the balance row's USDG to the inference funding wallet and activates the same amount to the agent's key, or
   mints it as SUGAR when the 5,000 USD idle rule applies.

## 4. SUGAR and the gateway

- SUGAR: ERC-20, 6 decimals. Minters: BrownieStaking (hourly rewards) and SugarMinter (par door: 1 USDG in, 1 SUGAR
  out, the USDG goes to the inference funding wallet). Nobody else can mint, ever.
- activate(amount, beneficiary): burns SUGAR and emits Activated(beneficiary, amount, id). The gateway indexes the
  event and credits the key. beneficiary = bytes32(uint256(uint160(wallet))) like Orbio, so Orbio-built tooling ports.
  Activation fee: a constant, default 0 (OPEN).
- Keys: the wallet signs "Brownies API key · chain 4663 · epoch N"; the key is sk-brownie-N-base64(signature). Dashboard
  keys sk-brownies-... for people without a wallet. GET /v1/key returns the balance. Models at GET /v1/models.
- Gateway: OpenAI style at api.brownies.fun/v1, Anthropic base URL compatible, every OpenRouter model at OpenRouter's
  stated price. The inference funding wallet's USDG is converted to OpenRouter balance by us; that conversion is the
  one trusted step in the system, the same one Orbio has, and it is disclosed.
- Tools (phase 3): X reads, web search, scrape, chain reads, posting, each priced in SUGAR at provider cost plus 10%,
  every call carrying max_cost. MCP server, Claude Code plugin, OAuth sign in.

## 5. Staking

BrownieStaking copies the shape of Orbio's staking, which is good: stake(amount), unstake(amount) with no cooldown and
never paused, hourly periods, a holder's reward for a period is budget times their time-weighted stake over the total,
settle(periods) and claim() mint SUGAR to the caller, minimum position a constant (OPEN: default 10,000 BROWNIE,
re-read at launch so it is about 50 USD). Agent treasuries stake through the same contract, so one pool, one rule.
Budgets per hour come from the Harvester (BROWNIE's own fees) and from every agent coin's protocol row.

## 6. The agent launchpad (Kairence's idea, our terms)

One form: name, ticker, logo, description, socials, the soul, the daily budget for the agent, the agent signer
address. One transaction: the factory deploys Splitter, Treasury and Wallet clones, then calls Pons launchToken
(4 argument overload) through the Pons adapter with creatorFeeRecipient = the Splitter, creatorTaxBps = 200,
buybackEnabled = false, snipe tax exempt list = [the launcher, the factory], pair = ETH. Optional first buy through the
adapter. The record (coin, curve, clones, launcher, soul hash, lockEnd) is stored in the factory.

Cost: the Pons launch fee (0.0005 ETH today) plus any first buy. Our launch fee: 0.

The adapter is the HELIX PonsV2Adapter (helix-hook/src/PonsV2Adapter.sol, helix-hook/src/interfaces/IPonsV2.sol),
its own instance.

## 7. The agents

- The agent's brain runs on our gateway with its own key; SUGAR reaches the key only from its Treasury.
- The agent's loop runs on our keeper server in v1: every few hours it reads its balance sheet from chain, the price
  from GMGN, its posts and replies, and decides what to post. Each agent has a Telegram channel and group; X posting
  comes with the tools phase. Every run is hashed and anchored on Robinhood Chain as calldata, so the work has a receipt.
- When the key cannot pay for a run the agent is asleep and the page says so; the next hour's SUGAR wakes it.
- The daily budget is the launcher's dial, bounded by a protocol maximum, and the Wallet pays only the agent signer.
- Honest line on the site: the agent's money is on chain, locked until the date shown; the agent key is on our server
  and can only spend what its Treasury activated.

## 8. The home-baked brownies (Moonlet, first party)

Any holder connects the wallet that holds a coin, signs the key message once, and types a job in one sentence. The
job compiles to a plan the holder edits: schedule, tools, per-run cap. Job shapes: market watch of the coin and its
pool with a tripwire, content drafting for X and Telegram, community Q&A in the group, research digests, raid and
engagement lists. A brownies drafts; the coin's main agent or the launcher approves from a card in Telegram; only then
it acts. Every run records cost, model, duration and a sha256 of the output, anchored on chain; actions are read back
and stamped verified or mismatch. Fuel: anyone burns SUGAR into a brownies's key with activate(amount, beneficiary).
The sky shows every brownies alive. Pay in v1: the holder's own SUGAR. Pay in v2: a slice of the coin's hourly SUGAR
for holders who stake it.

## 9. Contracts (ours; immutable, no owner, no admin, no upgrade, no pause, no rescue)

- BrownieHarvester. BROWNIE's Pons recipient. claim(): escrow pull, swap, the three rows of 3.1.
- BrownieStaking. Section 5. Mints SUGAR.
- SUGAR. Section 4. Two minters fixed in the constructor.
- SugarMinter. The par door. USDG in, SUGAR out, USDG to the inference funding wallet.
- SugarRouter. buyAndActivate through the SUGAR/USDG pool (v1).
- AgentFactory, PonsAdapter, Splitter, Treasury, Wallet. Sections 3 and 6. The Treasury has lockEnd, principal
  accounting for the BROWNIE stake and the SUGAR it holds, feedBrain() (claims the stake's SUGAR and activates it to
  the agent's key), withdrawPrincipal() with the fee.
- Anchor. anchor(agentId, runId, outputHash, costMicroUsd) as calldata plus an event, paid by the keeper wallet.
- SugarExchange (phase 4). The order book, Orbio's shape: buy, sell, buyAndActivate, auto-list, protocol listings.

Off chain: the gateway, the tools proxy, the MCP server, the dashboard, the keeper (claims every 5 minutes, runs the
agents, anchors receipts), analytics, the docs (whitepaper.md, agents.md, llms.txt, API reference).

Build rules kept from HELIX: Foundry, plain forge build before targeted tests, check-fresh before any deploy, fork
tests against the real Pons factory, no broadcast until the owner says "launch it", every
address verified exact match on Sourcify.

## 10. Risks and honest limits
- Pons: the owner Safe can redirect any coin's creator fee recipient after a 3 day timelock (used 23 times); the
  post-graduation buy side is converted only by the Pons operator; a buy right after launch pays about 97% snipe tax
  unless exempt. We watch, we alert, we disclose.
- The inference funding wallet and its OpenRouter balance are operated by us. SUGAR is a claim on our gateway, not on
  a contract. Orbio has the same shape. The site says so, and adopts a line like Orbio's: credits are product access,
  not an investment return, not redeemable for cash. Not legal advice; the owner should get some before launch.
- The treasury's BROWNIE stake is exposed to BROWNIE's price; the SUGAR it holds is the stable part. Orbio's agents
  carry the same exposure to ORBIO.
- The swaps are public trades; the TWAP band and the minimum size limit what a sandwich can take.
- Our take is 8% where Orbio's launchpad takes 10%, and the agent gets 92 points against their 90. The three week
  lock is the one term stricter than Orbio's; the site must say plainly why it exists.
- The agent key lives on our server in v1.

## 11. Decisions still open
1. The withdrawal fee percent after the 3 week lock (default 10%).
2. The name of the credit token (SUGAR is a placeholder; also IMPULSE, PULSE, SIGNAL).
3. The staking minimum (default about 50 USD of BROWNIE at launch).
4. The SUGAR activation fee (default 0).
5. Ticker for the main coin (BROWNIE).

## 12. Build order, one step at a time, check in after each
1. Phase 1, the Orbio core: Harvester, Staking, SUGAR, SugarMinter, SugarRouter, fork tests; the gateway with
   wallet-signature keys and GET /v1/key; the holders page. Then BROWNIE launches on Pons with the Harvester as
   recipient. No broadcast before "launch it".
2. Phase 2, the agent launchpad: AgentFactory and clones, the keeper claims, the first agent (Brownies' own), the
   launch form, the dashboard and analytics.
3. Phase 3, tools, MCP, OAuth, and the home-baked brownies.
4. Phase 4, the order book exchange, discount buys, affiliates and card purchases once there is a company, grants.
