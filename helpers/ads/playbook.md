# Butterscotch's playbook: paid ads for the brownies

Written 2026-10-11 from the platform policies and the practitioner literature read that day (the sources are
listed at the end), and from the owner's own direction: we advertise an AI agent studio with a cartoon, not a
coin. The owner confirmed it the same day in his words: "we avoid all type of ads related to saying brownies is
a token or a crypto project, we stay away from all that crap, no reference to be crypto related"; both lanes go;
the services lane is "agents able to manage alone socials and all the jobs they do, and services available
through us". Butterscotch reads this before every plan, every morning decision and every report, and adds to the
"Learned" section at the end after each weekly study. Numbers in here are starting points; the account's own
history replaces them once there is one.

## 1. What we advertise, and what we never advertise

Two lanes, each its own campaign with its own landing page and its own creatives.

- **Lane A, the stories.** The cartoon series: the four brownies at work, the daily episodes, the kitchen cam, the
  Room. Entertainment. The ask is to watch, follow, subscribe, join the Telegram group. Landing pages: the YouTube
  channel, the TikTok profile, and a page of our own (see "The landing pages" below).
- **Lane B, the services.** Four AI agents that run their own socials and do all their jobs alone, all day (the
  posts going out with nobody typing, the board of the day's jobs filling), and the services available through
  them: a cartoon clip of the four brownies about your idea, a meme, a research note, bought per request; an API
  an agent can call on its own. Software and creative services. The ask is to order one clip or try the API.
  Landing page: a page of our own about the agents at work and what they make, whose order button leads to the
  shop. Note: the shop takes USDC only today, so a person coming from an ad cannot order with a card; until a
  card checkout exists (a new money flow, the owner's call) lane B sells the API to agents and shows the work to
  people, whose ask is to watch and follow.

Never in an ad, a headline, a caption, a thumbnail or ANYWHERE on a landing page reached from an ad: the coin's
ticker or address, the names BROWNIE and SUGAR in capitals, "buy", "stake", "earn", "yield", "returns", "price",
"pump", "moon", "airdrop", "presale", "launch", charts, wallets, "not financial advice", and every word that says
crypto at all: crypto, token, coin, memecoin, blockchain, on-chain, Ethereum, ETH, web3, DeFi, NFT, USDC,
stablecoin, holders, tax, trading, liquidity, swap, mint, contracts, x402. The full list is AD_BANNED in
lib/ads/playbook.mjs; /butterscotch check <text> applies it to a line, /butterscotch landing to the lanes'
landing pages. Not because the coin is a secret (the site's Docs say everything) but because the owner wants no
reference, a paid ad that promotes a token is prohibited on every platform we use, and a page that reads like a
token sale gets the account flagged. The ad reviewers judge the landing page too, the whole of it.

**The landing pages, checked live on 2026-10-11.** room.html carries contracts, tax, buy, stakers and SUGAR (the
SUGAR tip button in the first screen); shop.html carries USDC, x402, buy, price, Ethereum, returns, wallet,
contracts and SUGAR (three of them in the first screen). Neither may receive an ad. Each lane gets a page of its
own, with a trimmed header and footer (no Docs, Bakery or Contracts links), nothing from the list anywhere on it,
and the visits beacon: lane A a watch page (the newest episodes, the kitchen cam, the follow buttons), lane B a
page about the agents at work and what they make. Until those exist, /butterscotch landing says NOT clean and no
plan passes its checks.

Why this is the right strategy and not only the compliant one: the people who would like the brownies are
people who like cartoons and people who need cheap creative work, and both groups are far larger than crypto
Twitter. The coin finds its holders through the Docs page and the community once the stories have brought
people in.

## 2. The platforms and their rules (read 2026-10-11; re-check at account time)

| Platform | What is allowed for us | What is not | Access for the API |
| --- | --- | --- | --- |
| Meta (Instagram, Facebook) | Entertainment and software ads with no crypto category. Crypto news, education and events need no permission. | Memecoin promotion is effectively unavailable; ICOs and token sales are prohibited; exchanges, staking and swap products need written permission with a licence. Ads may not target under 18 (some sources say under 25 for crypto). | A Meta app with ads_read and ads_management on our own ad account (Standard access); a system user token from Business Manager; Business Verification may be asked. Graph API, check the current version at account time. |
| TikTok | Entertainment and software ads. | Crypto is "restricted": needs a TikTok sales representative's approval, licences, no returns claims, 18+; ICOs and DeFi are off limits; the US and Canada are the open markets, the EU runs under MiCA. | A developer app on business-api.tiktok.com, OAuth to the advertiser account, app review for production; Marketing API v1.3 (/campaign/get/, /report/integrated/get/, status and budget updates); Smart+ is the current campaign type. |
| X | Promoted video and posts for entertainment and software. Financial categories need a certification request per category and run through managed advertisers. | Token sales, ICOs, mining hardware are prohibited; crypto is excluded entirely in Belgium, Greece, Qatar, Russia, Singapore, Slovenia, Ukraine; paid partnerships (influencer posts) ban crypto in the EU, UK and Australia since March 2026. | Ads API v12 (ads-api.x.com/12/) needs a separate approval per developer app ("Ads API Standard Access"), OAuth 1.0a tokens regenerated after approval; calls answer 403 until then. |

The EU: MiCA's Article 7 governs marketing of crypto-assets (fair, clear, not misleading, identifiable
as marketing, consistent with the white paper); a national regulator warned finfluencers
in January 2026 that "this is not investment advice" protects nobody. Our two lanes stay out of that article by
not marketing the asset. If the owner ever wants an ad about the coin, it is a legal question first, not an ads
question, and Butterscotch does not plan it.

## 3. The creative system

- **Format.** Vertical 9:16, 15 to 30 seconds, captions burnt in (most of the feed is watched muted), one message
  per ad, the brand (the four brownies) in the first second, a clear end card with one line and one action.
- **The first three seconds decide.** Open in the middle of the action, with a visible problem or a result, never
  a slow brand reveal. Three openers that keep working: a bold claim, a mid-action scene, a direct address.
  Produce several openings for the same body and test only the opening.
- **Variants.** For every concept: 3 to 5 hooks, 2 end cards, 2 caption styles. Test cells hold one concept each.
  About one creative in twenty becomes a winner, so volume matters: at least 6 distinct creatives at launch and 3
  to 5 new ones a week on TikTok (12 a month to avoid fatigue), a weekly refresh on Meta, one new promoted
  video a week on X.
- **Sources of creative.** The episodes Sprinkle already makes (cut to 15 to 30 seconds with a new opening), the
  kitchen cam (a real moment, captioned), the memes, the shop's samples (lane B: "we made this in 15 minutes
  for 9 dollars"). TikTok: our best organic posts as Spark Ads, which keep the likes and comments.
- **Lane B specifics.** Open on the agents at work with nobody at the keyboard (a post leaving the kitchen at 3 in
  the morning, the board of the day's jobs filling, a brownie carrying a finished job to the wall); then the thing
  they make and the result side by side; say the number plainly ("nine dollars, fifteen minutes"); one concrete use
  ("a clip for your product's first day", "a meme for your group"); an agent-facing variant that reads like
  documentation ("one HTTP call, pay per request, no key, no sign-up"). Never the word for how it is paid.
- **What every creative passes before it is uploaded.** No coin words (the list in section 1), no claims of
  gains, nothing adult or violent, no other brand's logo, music that is ours (the engine's) or the platform's
  commercial library, captions in plain ASCII, the brownies' look unchanged.

## 4. Measurement

- **UTMs on every link, one convention**: utm_source = meta | tiktok | x; utm_medium = paid; utm_campaign =
  stories | services; utm_content = the creative's id (clip number and hook letter, like ep12-h2); utm_term unused.
- **First-party visits.** The site reports a visit with those tags to our own gateway (no cookies, no personal
  data, one count per page view) so cost per visit is ours to compute even when the platforms' pixels are blocked
  (30 to 50 percent of browsers block them). Platform pixels and server-side conversions come later, with matching
  event ids so nothing is counted twice.
- **Our KPIs by lane.** Lane A: cost per 3-second view (hook rate >= 30 percent on Reels and TikTok, >= 20 on
  Feed), hold rate (15-second plays over 3-second plays, >= 25 percent), cost per visit to the landing page, new
  subscribers and Telegram joins per 100 visits. Lane B: cost per visit, cost per shop order, orders per 100
  visits. Across both: CPM and CTR only to spot broken delivery.
- **Benchmarks to start from (entertainment, 2026, rough and vendor-reported):** Meta CPM 3 to 9 USD, CPC 0.3 to
  1.3, CTR 0.5 to 2 percent; TikTok CPM 2 to 8, median CTR 0.6 percent; X CPM 5 to 15, CPC 0.2 to 0.9, CTR about
  1 percent, video the best format. Our own first week replaces all of this.
- **Data maturity.** Yesterday's numbers are incomplete early in the morning: the morning report runs after 9:00
  CET and labels the last day as provisional.

## 5. Budgets, tests, kills and scaling

- **The owner sets a weekly cap; Butterscotch never spends above it and never raises it.** A plan splits the cap:
  70 percent to the lane that is winning (stories first, until lane B has data), 30 percent to tests. A
  platform's share follows its cost per result after the first week.
- **Test cells.** One concept per cell, broad targeting (the platforms' own optimization beats hand-built
  audiences for a new account), the platform's minimums respected (TikTok: 20 USD a day per ad group, 50 a day
  per campaign; Meta: enough for about 50 optimization events a week per ad set, else optimize for a cheaper
  event such as 3-second views or landing page views; X: no floor but under 10 USD a day learns nothing).
- **Kill rules, written before the campaign starts.** Kill a creative at 3 times the target cost per result
  with zero results; hold 48 to 72 hours at 2 times with one result; day-one and day-two spikes are noise, not
  signals. Judge on results, not on days.
- **Scaling.** Raise a winning cell's daily budget by 20 percent every 2 to 3 days, once it is out of learning and
  stable; for bigger steps duplicate the cell instead of resetting its learning. Every raise is a card for the
  owner unless he switched auto-scale on, and even then never past the weekly cap.
- **Pacing.** Spend to date against the week's pace every six hours: over pace by more than 15 percent, pause
  the worst cell first; under pace by more than 30 percent for two days, say so, do not chase.
- **Fatigue.** When frequency passes 3 in a week or a creative's CTR falls 30 percent from its best, retire it
  and ask Sprinkle for the next cut.

## 6. Platform set-ups

- **Meta.** One campaign per lane, Advantage+ campaign budget on (the 2026 default), 2 to 3 ad sets at launch
  (broad; one interest set for cartoons and animation as a control), placements Reels and Stories first, Feed
  as a control; objective: video views for lane A, landing page views then conversions for lane B. Existing
  customers excluded from the scale campaign once there is a list.
- **TikTok.** Smart+ with at least six creatives and 2 to 5 headlines, the best organic posts added as Spark
  Ads, 3 to 5 fresh creatives a week; judge nothing before seven days (Smart+ learns longer).
- **X.** Promoted video with the video-views objective for lane A and website traffic for lane B; the account's
  own posts promoted (no new "ad" look); targeting by interests (animation, AI, startups) and lookalikes of our
  followers; only the markets where the categories are allowed, and nothing in the seven excluded countries.

## 7. The daily and weekly rhythm

- 09:15 CET, every day: read every platform, compute the KPIs per cell and per creative, apply the kill rules,
  propose the scales, write the morning report (spend yesterday and week to date against the cap, per platform
  and per cell: results, cost per result, hook and hold rates, the winners, the losers, the actions taken and
  the actions waiting for the owner, what Sprinkle should cut next).
- Every 6 hours: pacing against the cap.
- Sunday 11:00: the weekly study (section 8), a note to the owner with what changed in the playbook.

## 8. The weekly study

Three searches a week with the web tool: platform policy changes for crypto and for entertainment ads; new
creative practice for short-form ads (hooks, formats, lengths, what the platforms now favour); new figures
(benchmarks, platform features such as Smart+ or Advantage+ changes). What is new and relevant is written as
one paragraph under "Learned" with the date and the source, never as a rewrite of the sections above; a change
that would alter a rule above is proposed to the owner, not applied.

## 9. Before the first dollar

What has to exist, in order: the two landing pages of our own, clean by /butterscotch landing (section 1); the
ad accounts (Meta Ads with a Page and the Instagram account, TikTok Ads Manager under a Business Center, X Ads
on the brownies' handle) with a card attached and a weekly cap set in each; the API access for each (section 2);
the UTM convention and the first-party visits route live (they are); at least six creatives per lane cut by
Sprinkle with the site's own engine and checked against the list; the kill rules and the cap written in the plan
the owner approved.

## Sources read on 2026-10-11

Meta: transparency.meta.com cryptocurrency products and services policy as summarised by blockchain-ads.com,
auditsocials.com, thekollab.io, stackmatix.com; socialmediatoday.com on the 2021 widening. TikTok: tikadtools.com,
tikadsuite.com, benly.ai, megadigital.ai, the CoinDesk sponsored piece. X: business.x.com/en/help/ads-policies
financial services page, legalnodes.com, the March 2026 paid-partnership reports (Yahoo Finance, cryptonomist,
spendnode). MiCA: esma.europa.eu Article 7, taylorwessing.com, sedric.ai, cointelegraph.com on
a regulator's January 2026 notice, mondaq.com and klgates.com on the national decree. Creative and testing:
stackmatix.com, adlibrary.com, taylorsicard.com, getkoro.app, motionapp.com, finsi.ai, jetfuel.agency, adnova.ai,
madgicx.com, segwise.ai; TikTok's own Smart+ playbook and Spark Ads pages; benchmarks from emplifi.io (Q2 2026
entertainment), hubfluence.io, focus-digital.co, admanage.ai, whatagraph.com, webtonic.io. APIs: developers.
facebook.com, business-api.tiktok.com (v1.3), docs.x.com (Ads API v12). Attribution: cometly.com.

## Learned
