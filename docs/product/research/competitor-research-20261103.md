# Competitor research: live, 1-to-1 video and party-room apps (India focus)

**Research date:** 3 November 2026. Every source in section 8 was opened on this date.
**Prepared for:** ZIPPER product team.
**Method:** desk research of public sources only: Google Play and App Store listings, official websites and help centres, official policy and terms pages, government releases, and news or legal analysis. No app was installed, no account was created, and nothing behind a login or a block was accessed.

**How to read this file**

- Tags such as `[C5]` point to the numbered source list in section 8. Each entry there gives the URL and the date checked.
- `†` marks a claim that comes only from an unofficial source, such as an agency or reseller website, a third-party guide, or a user review. Treat it as unverified.
- "Not publicly documented" means we looked and found no public statement. It does **not** mean the feature is missing from the app.
- Store numbers (installs, rating, review count, content-rating label, "top grossing" rank) are as shown on the store page we fetched, which was the English/US storefront. They change by region and over time.
- Prices and reward figures appear only where a public source states them. We did not estimate any figure.
- This is not legal advice.

## Contents

1. Executive summary
2. Which apps we mean
3. Per-app findings
4. India regulatory notes (games and app blocking)
5. Feature matrix
6. Features worth implementing in ZIPPER
7. Possible unique ZIPPER features
8. Sources
9. Gaps and fetch problems

---

## 1. Executive summary

- **Public documentation is very uneven.** Chamet, Tango and Bigo Live publish detailed official help pages. HiClub, Recho, Crush and Zing publish little beyond store listings. Most numbers about those four come from agency websites that call themselves "official" but are not run by the developer (marked †).
- **Chamet's published rules are the closest public template for ZIPPER's 1-to-1 model.** The caller pays per minute at a price the host sets. A 90-second free trial call comes from limited "free cards". New users get welcome coins and daily tasks. A 10% spend rebate is paid back after 30 days, with games excluded. Hosts cash out at 10,000 beans = US$1 from US$10, settle weekly, and need no agency to start [C5][C6][C7][C9][C10].
- **Chamet's paid tiers are public in structure but not in price.** Chamet Plus gives 48,000 diamonds up front, 300 a day for 30 days, and access to private albums; the price is localised and not published. SVIP tiers need Level 10+ and a monthly recharge of at least 100M, 300M or 1,000M diamonds [C9][C12][C15].
- **Tango publishes real VIP prices and a formal reseller programme.** Its 13 loyalty levels run from US$9.99 to US$30,000 per 30 days. Verified resellers are tiered by monthly investment: up to US$150K, US$150K–300K, and over US$300K [T2][T3].
- **Recho's own site advertises the most aggressive host and agency incentives.** Hosts: fixed pay up to US$6/day, up to US$100/week extra, up to 70% of gifts, and a chat rate up to US$1/min. Agents: up to 30% commission, sub-agent "ratio-difference" rewards and a 20% base "regional subsidy". Referrals: US$108 [R2].
- **Chance games paid with app currency are common.** Chamet runs number, wheel and race rounds in party rooms, and the room host earns a share whoever wins [C8]. Tango runs in-stream roulette with bets and published bet-linked cashback for an India tournament [T7][T8]. Crush's App Store page lists "Loot Boxes" [K2]. Bigo's Play page says purchases include random items [B1].
- **India's Promotion and Regulation of Online Gaming Act, 2025 applies now.** Its Rules came into force on 1 May 2026. It bans online money games whatever the mix of skill and chance, and it counts virtual coins bought with money as "stakes" [L1][L2]. Any ZIPPER game, lucky gift or cashback that lets paid currency win more currency needs legal review.
- **Bigo Live is the best public reference for room mechanics.** It documents 4/6/9/12-seat rooms, closing seats, mute and remove, admins, room level, room boost, fan clubs and families [B2][B3][B4][B5]. But Bigo Live was one of 59 apps blocked in India on 29 June 2020 [L4].
- **India has blocked this category before.** In February 2025 MeitY reportedly ordered 119 apps blocked, mostly video and voice-chat apps linked to developers in China and Hong Kong [L5][L6].
- **Account and agency rules are strict.** Chamet allows one face-verified account per person, and a host cannot leave their upper agency once joined [C10][C13]. Recho's terms ban multiple accounts [R2].

---

## 2. Which apps we mean

| Name in brief | App profiled | Package / developer | Store snapshot (3 Nov 2026) | Why this one | Public docs |
|---|---|---|---|---|---|
| Chamet | Chamet – Live Chat & Party | `com.hkfuliao.chamet` / Fuliao Hong Kong Limited ("Chamet Team") | Play: 50M+ installs, 4.0★ (about 0.52M reviews), label "Mature 17+", #8 top grossing in Social [C1] | Only app with this name | Good: official help centre |
| HiClub | HiiclubChat: Easy Expression | `com.hiiclub.live` / "Ailfaerior Studio", address in Jakarta, Indonesia | Play: 10M+, 4.5★ (about 104K reviews), 18+, category Lifestyle [H1] | India "Hiiclub" agency sites send hosts to www.hiiclub.live and agencies to oms.hiiclub.live. www.hiiclub.live redirects to hiiclublive.xyz, which is the website named on this listing [H4][H5][H7][H1]. Medium confidence | Poor |
| Recho | Recho-Live, Video Chat & Room | `com.godhkvexa.recho` / Vexa Limited, Hong Kong | Play: 1M+, 4.1★ (about 9.2K reviews), label "Rated for 12+" although the description says 18+ only [R1] | Only live/video app named Recho that we found | Poor to fair: the official site gives headline numbers |
| Crush | Crush Live | `com.starlink.crushlive` / STARLINK NETWORK TECHNOLOGY PTE. LTD., Singapore | Play: 1M+, 4.2★ (about 7.9K reviews), "Rated for 12+"; App Store: 18+ [K1][K2] | Other "Crush" apps we found are dating apps | Poor to fair: App Store text and version history |
| Zing | Zing – Fast Call & Video Chat | `com.bigdot.zing` / "Big Dot Group", address in Bangladesh | Play: 100K+, 3.6★ (about 900 reviews), 18+ [Z1] | User reviews mention call rates, party rooms and levels, which is closest to ZIPPER. Low confidence | Very poor |
| (comparable) | Tango: Live Stream, Video Chat | `com.sgiggle.production` / Tangome, Inc., USA | Play: 100M+, 4.5★ (about 4.97M reviews), 18+, #7 top grossing in Social [T1] | Best documented; runs India events | Good |
| (comparable) | Bigo Live – Live Stream, Go Live | `sg.bigo.live` / Bigo Technology Pte. Ltd., Singapore | Play: 500M+, 4.5★ (about 6.49M reviews), 18+, #6 top grossing in Social, "In-app purchases (includes random items)" [B1] | Best documentation of rooms and families | Good |

**Look-alikes we did not profile**

- **Hiiclub Pro: Live Video Chat** (`com.hiiclub`, AMNESTED APPS, UK; 1M+) is a different random 1-to-1 video-chat app [H2].
- **Zing: Dating App & Chat** (`com.hiorbye.app.zing`, an individual developer in Gujarat; 10K+) is a dating app. It sells coins at US$4.99 per 100 for gifts and profile boosts and says it has no subscription [Z2].

**Considered but not profiled:** Poppo Live, MICO, LivU, StarMaker, HelloYo and FRND. Our searches found only coin-seller blogs and store listings for them, not official help or policy pages, so they could not be documented to the standard used here. For reference, HelloYo's Play listing shows 50M+ installs and a Singapore developer, Hello Yo Pte. Ltd., but gives almost no feature detail [O1].

---

## 3. Per-app findings

### 3.1 Chamet

Official sources: the chamet.com website and help centre, and the Play listing.

**Live streaming**

- Adults can open a Live Room from account Level 1. Viewers comment in real time, follow creators and send gifts paid in diamonds [C3][C5].
- PK comes in one-to-one and team formats. The store listing presents it as a challenge with a forfeit for the loser [C1][C3].
- Creators can bring other live users into their room when the format allows. No seat count is published [C3].
- The camera offers adjustable beauty effects, filters and stickers [C1].
- Moderation: AI moderation runs around the clock and can cut a connection on a violation. Hosts get an alert when their face is not visible. Nudity, sexual gestures and minors on camera are banned, and accounts that look underage can be penalised [C16][C17].
- Viewers get real-time translation. The app's languages include Hindi [C1][C2].

**1-to-1 calls**

- The caller pays diamonds per minute at the rate set by the person being called. Currency and coin prices are set automatically from IP and profile region, and users cannot change them [C9].
- Hosts earn beans for call duration multiplied by their displayed price. They can see their last 7 days of performance and their base price, and change the price in settings [C5][C20]. A new Level-1 account cannot take video calls [C5].
- Free start: a 90-second free trial call through "free cards" in random match, welcome coins, and daily tasks [C6][C7][C17]. Free cards are limited, so hosts compete for random calls [C17].
- The "consumption rebate" returns 10% of diamonds spent on calls and gifts after 30 days. Users claim it manually, and games are excluded [C7].
- Random calls that fail because of a system error are normally refunded automatically [C18]. An auto-answer mode exists, and a call can be ended within its first 15 seconds [C17].
- Payout: 10,000 beans = US$1. Hosts withdraw from US$10 to MetWallet, Chamet's own wallet app, with no Chamet fee, then on to a local bank or e-wallet [C5]. Host earnings settle weekly, usually on Thursday [C10].
- Chamet recommends recharging through its official web portal for the best rates [C22].
- † An agency site says host prices typically run from 1,200 to 12,000 beans per minute [C21].

**Party rooms**

- Party Rooms come as video rooms, voice rooms and Game Rooms [C4]. The store listing says group video works with up to 5 people [C1].
- Users can create a room from account Level 6. The creator picks the room type, title and cover, and host controls cover welcoming people, managing mic positions and handling disruptive users [C4].
- People can listen without taking a mic, then take an empty mic position [C4].
- The room host earns beans from gifts in the room, plus an automatic share of eligible game activity whoever wins [C4][C8].
- An SVIP perk called "Room Pin Packet" pins a party room to the top of the list [C14].
- Not publicly documented: seat locking, password rooms, room themes or backgrounds, room music, admin roles, room levels, room membership.

**Gifts**

- Gifts include animated, festival and event gifts [C1], and they work in live rooms, calls and party rooms [C5].
- Received-gift records cannot be hidden. Senders can switch to anonymous in gift rankings [C10].
- SVIP users can request custom gifts and effects through a dedicated service contact [C14].
- Not publicly documented: lucky gifts, gift wall, combo sending, gift animations that travel to the receiver.

**Rankings and events**

- "Charm Queen" is an event ranking for hosts. To qualify a host needs valid face verification, a valid poster, a score of at least 75 and location permission, and only one account per device can rank [C19].
- Gift rankings exist, with an option for senders to appear anonymously [C10].
- Event reward figures are not publicly documented.

**Profiles and social**

- Users can follow creators [C3], post to a Feed & Moments section [C2] and create group chats [C10].
- A user's avatar card has a report action. Users can maintain a block list, and they can report scams by long-pressing chat messages [C13][C16].
- One face can verify only one account. A phone number that was bound once cannot be bound to a new account, even after the first account is deleted. Region is fixed by IP and phone-number country. Accounts sync across phone and web. Deleted accounts can be recovered for 14 days. If several accounts are detected, daily tasks appear on only one [C10][C13].
- Account switching inside the app is not publicly documented.

**Business model**

- Hosting needs no application, no approval and no agency [C5].
- Agencies get a back-office portal. Hosts and sub-agencies join through the agency's invitation link. The commission ratio depends on the last 30 days' total, made up of host commission plus sub-agent commission. Commission is paid to MetWallet automatically once it reaches US$10. A member cannot change or leave their upper agency once joined [C10][C11].
- No official coin-seller page was found. † An independent agency site says a "Diamond Seller" panel opens for agents with at least a 15% agency ratio after a first purchase of 50,000,000 diamonds for US$8,000 [C21].
- Chamet Plus is an optional monthly subscription. It renews automatically, and renewals are not refundable. It gives 48,000 diamonds at purchase plus 300 a day for 30 days and unlocks every user's private album. The price is localised and not published [C9][C12].
- SVIP ("Diamond VIP") needs Level 10 or higher and a monthly recharge of at least 100M diamonds (Pink), 300M (Blue) or 1,000M (Purple) in any of the last 3 months. Benefits last 3 months, with downgrade and expiry rules. Perks: an extra 5% rebate, invisible mode with no room-entry notice, Room Pin Packet, custom gifts and effects, a badge, dedicated service, and a "Mystery Man" incognito mode [C14][C15].
- Female users can mark photos and videos as private. Viewers need Chamet Plus to see them, and eligible hosts earn beans from qualifying views [C5][C10].

**Games**

- Selected Party Rooms offer Chamet Race, Top Race, Lucky 28 (number rounds), Top Wheel (wheel rounds) and Apple Master. Players join with diamonds and see round information before joining [C8].
- The room host gets an automatic bean share from eligible game activity whoever wins [C8]. The 10% rebate excludes games [C7].
- Ludo and Teen Patti are not in Chamet's published game list [C8]. Chamet does not publicly describe how its games are treated in India (see section 4).

**Retention**

- Welcome coins and daily tasks [C7].
- Male users level up by recharging and spending. Female users' levels depend on beans earned in the month [C13]. If a user's diamond balance falls below 2,000 (Level 0), level perks such as the profile frame and entry effect pause [C13].
- Entry vehicles ("entry-driving machine") and medals [C1]; an SVIP badge [C14].

### 3.2 HiClub (HiiclubChat)

- Official information is minimal. The Play listing describes worldwide real-time conversation, interactive virtual gifts and privacy protection, with no prices, rules or help centre [H1]. The website is an empty JavaScript page [H7].
- † India agency sites, which are not the developer, say:
  - Only women aged 18 or over can be hosts [H3][H4].
  - Hosts earn from 1-to-1 video calls paid by call duration, live streaming, gifts, messages and activity bonuses, with weekly withdrawals [H4].
  - Agencies earn a weekly commission on their hosts' performance, can build sub-agencies and get a dashboard [H5]. One site claims commission of "up to 25%" a week [H6].
  - Agency sign-up uses a link on oms.hiiclub.live that carries a parent invite code, which suggests a multi-level agency tree [H5].
- † A Play review from May 2026 mentions coin spending and a recommendation-based matcher [H1].
- Not publicly documented: per-minute prices, free trial calls, party rooms, PK, rankings, VIP, coin sellers, games, levels, frames, entrance effects.

### 3.3 Recho

- **Product (Play listing):** users share live moments and replay past clips, video chat with verified people, and join party rooms for themed talk and interactive games. The listing mentions gifts and claims strict moderation [R1]. The update of 2 Nov 2026 added background music in rooms [R1].
- **Official site (rechox.com):** lists face-to-face chat, a party voice room and "Star Rankings", and promises a sign-up bonus of up to US$108 [R2].
  - Hosts: fixed pay up to US$6 a day; extra pay up to US$100 a week; up to 70% of gifts; a chat rate up to US$1 a minute; random rewards for text replies; a PK winning bonus; self-withdrawal at 10,000 coins = US$1 [R2].
  - Agents: commission up to a 30% ratio; "ratio-difference" rewards from sub-agents; a regional subsidy starting from a 20% base ratio; US$108 per referred user [R2].
  - Terms (Vexa Limited): virtual goods, called "Ruby", are licensed rather than sold, and sales are final. Multiple accounts and selling or transferring accounts are banned. Hong Kong law and arbitration apply. The terms ban users under 18 but also mention 13–17-year-olds with parental consent, which is inconsistent [R2].
  - Privacy: some features need face authentication. When a chat partner reports abuse, chat data from their device may be sent for review [R2].
- **† Agency sites** (recho.live and rechoagent.com, which call themselves official agencies):
  - Host levels unlock features: Level 10 opens the Party Room; Level 30 allows video-call prices up to 1,800 coins a minute; Level 40 up to 3,000 coins a minute and a 70% gift share; Level 50 up to 4,200; Level 60 up to 6,000 [R4].
  - New hosts get daily pay of up to US$2, which conflicts with the official US$6. Weekly pay goes up to US$100. An invitation task pays up to US$108 for each invited user who tops up and wins required Rubies in in-app games [R4].
  - Withdrawals go only through Epay, with a US$10 (100,000-point) minimum. One page quotes 1–3 business days for processing and another quotes 7 days [R3][R4].
  - Hosts who keep missing incoming calls can lose their salary or be removed. One account per user or device is allowed [R4][R5]. Agency commission runs from 4% to 30%, with a dashboard of host and sub-agent earnings [R3][R5]. The app is described as popular in India and Bangladesh [R3].
- **† User reviews (Play, July–September 2026):** complaints that call prices went up, and that "gameplay" and complaint handling were unfair [R1].
- Not publicly documented: seat counts, seat locks, password rooms, admins, VIP or noble tiers, coin sellers, lucky gifts, frames, entrance effects.

### 3.4 Crush Live

- **Product (Play and App Store):** talent live streams, bullet-chat comments, real-time translation, multi-person interest parties and casual games [K1]. The App Store adds gift animations, PK, face-to-face video chat with hosts, voice parties where users switch their own camera and mic on or off, and a moments feed [K2]. The app has 31 languages, including Hindi, Bengali, Urdu and Nepali [K2].
- **Recent releases (App Store version history):** room sharing, chat during PK and room stickers (December 2025); a Fan Club (August 2026); a "LiveHouse" feature (releases from 31 August to 12 October 2026) [K2].
- **Prices (US App Store):** 6,000 Gold Coins for US$0.99; 16,800 for US$1.99; 24,800 for US$3.99; 35,000 for US$4.99; 63,000 for US$9.99; 192,000 for US$29.99; 390,000 for US$59.99; a "Medium gift pack" for US$9.99 [K2]. The age-rating details list "Loot Boxes" [K2].
- **1-to-1 calls:** video chat with hosts is described, but per-minute pricing is not publicly documented [K2].
- **† Agency site** (crushfunlive.com, "Crush Live Agency"): hosts get 70% of gifts across live, party and chat; rewards for 7-day tasks; a lucky-gift bonus; Charm, Wealth and Game rankings by hour, day, week and month; "Golden Host" tasks with base pay; daily withdrawals. Agents get a "20% daily commission". Host rules: 18+, face authentication must match the streamer, no recording, and no two live accounts at once [K3][K4].
- **† User reviews (App Store, 2026):** one user's account was frozen for review and the user was pointed to an external coin reseller. Others asked for locked or password-protected rooms, which suggests there were none at the time [K2].
- Not publicly documented: seat counts, admins, VIP or noble tiers, user levels, frames, entrance effects, daily check-in for users.

### 3.5 Zing (Fast Call)

- **Product (Play listing):** one-tap random video calls called "Fast Call", voice chat, and privacy claims [Z1]. The same developer also lists the CallU, Zuno, Wavoo and Diki video-call apps [Z1]. The privacy policy sits on a JavaScript-only page (zing.dikilive.com) that returned no content.
- **† User reviews:** mention call rates, "a lot of party room features" (April 2026), and a profile stuck at level 0 after spending (August 2026) [Z1].
- Everything else is not publicly documented.

### 3.6 Tango

- **Product (Play listing):** audio rooms; Tango Match; 1-to-1 or group video chat with up to 9 people; face filters; vlogs; gaming streams; real-time translation; gift challenges; media packs [T1].
- **Live tools and moderation:** a broadcaster can make a follower an admin who can remove viewers [T10]. Broadcasts can be audio-only, and users can join a Live Party with audio only [T12]. Premium broadcasts are moderated automatically for nudity and minors, and a stream ends if the streamer is absent for 2–4 minutes [T6]. A warning system exists [T14].
- **Private rooms:** "Premium Live" is invite-only, with an entry-fee gift. Starting one needs a balance above 500 diamonds [T6].
- **PK ("battles"):**
  - India's Partner Battle 2026 (August 2026): 64 broadcasters in a one-on-one knockout. Early rounds last 15 minutes and later rounds 30 minutes. The broadcaster with the most diamonds wins. Each time the lead changes in the last 20 seconds, 20 seconds of overtime are added. Supporting yourself from a second account is banned. Battles run from 9:30 to 11:30 PM IST [T8].
  - "Battle Power Up" (29 September–1 October 2026): the winner of a battle that collected 150K–299K coins got 1,000 diamonds; 300K–499K, 3,000; 500K–999K, 5,000; 1M or more, 10,000; at most one reward a day [T9].
- **Subscriptions to a host:** a monthly subscription at a price the broadcaster sets, in three tiers: Fan, Super Fan and Exclusive Fan. Tiers unlock exclusive posts, and Exclusive Fans also enter premium broadcasts without the entry fee. Subscribers' names are highlighted with a star frame, and they can message the host even if the host does not follow them back. Renewal coins can be taken up to 3 days before the period ends [T11].
- **VIP ("Loyalty"):** 13 public levels plus 2 invite-only ones. Each status lasts 30 days and is kept by meeting a monthly purchase level: Rookie US$9.99, Pro US$30, Bronze US$99.99, Silver US$250, Gold US$600, Premium US$1,100, Platinum US$1,500, Elite US$2,500, Royal US$5,000, Diamond US$10,000, Black Diamond US$20,000, and Legend US$30,000 plus a 20-crown ribbon (lifetime spend above US$100K). Perks grow with level: animated status, a 3D avatar gift, a profile frame, invisible mode (from Pro), monthly custom gifts (from Bronze), a weekly and then daily free status gift, coin coupons (from Premium), a VIP manager in chat (from Royal), a personal manager (Elite) and a concierge (Black Diamond) [T2]. "VIP Boost" offers and a lifetime "Crowns" programme also exist [T13].
- **Games:** Live Roulette runs inside streams from the Games tab, and fans place bets. While it runs, the creator earns an extra 5% on gifts, 5% of each round's bets, and 25% of what fans win each round [T7]. In India's Partner Battle, users who bet on and gift winning creators get 2%, 3% or 5% cashback depending on the round [T8].
- **Earnings:** 5,000 diamonds = US$25, and a single redemption can be up to 400,000 diamonds [T5]. An undated partner (agency) policy PDF says: no minimum targets; each partner gets a tracking link; broadcasters cash out from US$25 and are paid within 48 hours; partners are paid monthly, 30 days after month end, through Payoneer, with a US$25 minimum; partners earn 5% of the earnings of partners they refer [T4]. Tango lists many payout methods, including Payoneer, Paxum, Tipalti, crypto and local bank transfers in several countries [T14].
- **Resellers:** the Reseller Benefits Program 2025 started on 1 March 2025. It has three tiers by monthly investment: Reseller (up to US$150K), Premier (US$150K–300K) and Executive (over US$300K). Perks grow by tier: an animated ribbon with 1–3 stars, free chat with buyers, an entrance animation, marketing campaigns, priority support, 10%, 15% or 20% of coins for personal use, monthly "mega coupons", the right for Executives to sell to other resellers, and a monthly custom gift [T3]. Users can also buy coins with crypto [T13].
- **Events:** frequent "Gift Rush" events [T13], plus India-specific tournaments and an India community page [T8][T14].
- Not publicly documented: per-minute billing for 1-to-1 calls, free trial calls, seat locking, lucky gifts, daily check-in.

### 3.7 Bigo Live

- **India status:** Bigo Live was on the list of 59 apps blocked by MeitY on 29 June 2020 [L4]. We found no public record that it was unblocked, so its current availability in India is unverified.
- **Live formats:** video, Game, Audio and Multi-guest live [B1]; avatar-based "Virtual Live"; AI coaching prompts while live; a "Nearby" feed [B3].
- **Multi-guest rooms:** rooms have 4, 6, 9 or 12 seats including the host. Viewers request an empty seat or are invited. Settings cover an announcement, administrators and the room level. The host toolkit includes beauty effects and games such as Truth or Dare and Draw & Guess. "Boost my room" promotes a room. Hosts can mute or remove guests and close empty seats. A room can require an account level, family membership or phone verification to join. A popularity list ranks rooms by hour, day and week. Each participant's gift total is shown [B2][B5].
- **Guest Live (2 or 3 people on camera):** it happens inside a public live room, is free, does not require gifts, and is not private. Users can join with audio only [B5]. No paid per-minute private calls are documented [B5].
- **PK:** split screen, scored by gifts, on a timer. Last-second "snipes" are a known tactic, and the store listing mentions penalties for the losing side [B1][B3].
- **Fan clubs:** joining costs about 10 diamonds and gives a badge. "Intimacy" points come from daily check-in, small gifts or watch time. A Super Fan Club adds a full-screen entrance animation and its own leaderboards [B3].
- **Gifts:** the gift panel has tabs for Popular, Multi (many units in one tap), Activities, VIP-only gifts and Backpack (free gifts from tasks and events). Sending gifts earns experience points. A weekly gift ranking for each broadcaster shows how much a user needs to pass the person above them. Broadcasters receive beans that convert to money [B6].
- **Families:** a founder needs at least 5 members in one region and a phone number registered on WhatsApp. The family must keep at least 10 members for 30 days and join at least 5 family events a month. Family gifts earn "combat points" (1 bean received or 1 diamond sent = 1 point). Families and members have levels, a monthly prestige ranking that resets, and monthly targets. Higher family levels unlock special video frames and audio circles in multi-guest rooms [B4].
- **Audio Live:** a mixer offers background music, voice effects and an equaliser [B7].
- **Privacy and safety:** users can hide location, online status, device model and last active time; block strangers' messages or collapse them into a separate inbox; and block or report users from a profile, a message thread or the room tools. The app is 18+ only [B10].
- **Admins:** † admin limits by broadcaster level (2 admins at Lv1–10, 5 at Lv11–15, 8 at Lv16–19, 20 at Lv20+) appear in a search-engine snippet of an official Bigo activity page that would not load for us [B9].
- **VIP:** paid with diamonds, which are not refundable. A user's VIP membership level depends on their user level. An optional monthly auto-renewal is deducted in the last 48 hours of each 30-day period. Prices are not published [B8].
- **Retention:** a Task Center with daily and weekly challenges pays coins, temporary VIP, entrance effects and sometimes diamonds. Platform events have leaderboards, limited gifts and frames [B3].
- Not publicly documented: paid per-minute calls, agency programme terms, a reseller programme (third-party claims only), password rooms, lucky-gift details, account switching.

### 3.8 Public economics benchmarks (as published; not converted)

| App | User-side price points | Host / agency cash-out | Source |
|---|---|---|---|
| Chamet | Localised; not published | 10,000 beans = US$1; US$10 minimum; agency commission paid from US$10 | [C5][C9][C10] |
| Recho | Not published | 10,000 coins = US$1 (official); † US$10 = 100,000 points minimum | [R2][R4] |
| Crush Live | 6,000 coins US$0.99 up to 390,000 coins US$59.99 (US App Store) | † 70% of gifts | [K2][K4] |
| Tango | VIP status US$9.99–30,000 per 30 days | 5,000 diamonds = US$25; US$25 minimum | [T2][T4][T5] |
| Bigo Live | Not published | Beans convert to money; rate not published | [B6] |
| HiClub, Zing | Not published | Not published | — |

---

## 4. India regulatory notes (games and app blocking)

**The law.** The Promotion and Regulation of Online Gaming Act, 2025 (Act No. 32 of 2025) bans offering, advertising and processing payments for "online money games", whether they rely on skill, chance or both [L1].

- Offering such games can bring up to 3 years in prison and/or a ₹1 crore fine. Advertising them can bring up to 2 years and/or ₹50 lakh. Repeat offences carry higher minimums [L1][L2].
- Offences under sections 5 (offering) and 7 (payments) are cognizable and non-bailable [L1].

**Key definitions** [L1]:

- An "online money game" is one where the user pays a fee or deposits money or other stakes expecting to win money or other enrichment.
- "Other stakes" means anything equal to or convertible into money. The Act names credits, coins, tokens and objects, real or virtual, bought with money directly, indirectly or in connection with an online game.
- An "online social game" involves no stakes and no expectation of monetary gain. A subscription or one-time access fee is allowed if it is not a stake.

**The 2026 Rules** came into force on 1 May 2026 [L2][L3].

- They created the Online Gaming Authority of India (OGAI).
- OGAI decides whether a game is a money game, after an application, on its own initiative, or after a government notification. It looks at stakes at any stage, expectation of winnings, the revenue model, and whether in-game items can be turned into value outside the game. Decisions are due within about 90 days and apply only to the provider that applied.
- Registration is needed only where the government requires it by notification.
- Providers must offer user-safety features such as age-gating, time limits, parental controls, reporting and counselling. They must also run a grievance process, with appeal to OGAI within 30 days [L2][L3].

**Litigation.** The Supreme Court has reportedly taken up the petitions challenging the Act. Unless the Act is stayed, it is treated as in force [L3].

**What this may mean for features in this report.** This is our reading only; get legal advice.

- **Highest risk:** rounds joined with paid currency that can return more currency. This covers number, wheel and race games, roulette bets, and "lucky" gifts that pay out diamonds. The risk is greater when that currency can end up as host beans that are withdrawn as cash.
- **Also risky:** referral rewards that depend on invited users winning currency in games, as an agency site describes for Recho (†), and cashback tied to betting on battle results, as Tango documents for an India tournament. The Act also bans advertising or inducing participation in money games [L1].
- **Lower risk:** social games with no paid entry and no winnings that convert to value, such as Draw & Guess or Truth or Dare.
- **Payments:** coin-seller and reseller flows are payment channels. Section 7 bars anyone from facilitating payments for online money gaming services [L1].

**App blocking precedent**

- 29 June 2020: 59 apps, including Bigo Live and Hago, were blocked under section 69A of the IT Act [L4].
- 20 February 2025: reports said MeitY had ordered 119 apps blocked, mostly video and voice-chat apps linked to developers in China and Hong Kong, plus some from Singapore, the US, the UK and Australia. Only 15 had been blocked at that point [L5][L6].

**Ludo and Teen Patti:** none of the seven apps publicly lists Ludo or Teen Patti among its in-app games.

---

## 5. Feature matrix

**Legend**

- **Yes**: an official source documents it.
- **Partial**: only part of the feature, or a limited version, is documented.
- **No**: an official source shows it is absent or works differently.
- **Unknown**: not publicly documented.
- **†**: only an unofficial source supports the cell, so it is unverified.
- Tags refer to section 8.

| Feature | Chamet | HiClub | Recho | Crush Live | Zing | Tango | Bigo Live |
|---|---|---|---|---|---|---|---|
| India presence documented | Yes [C1][C2] | Partial† [H3] | Partial† [R3] | Partial: Hindi UI [K2] | Unknown | Yes [T8] | No: blocked 2020 [L4] |
| **1. Live streaming** | | | | | | | |
| Solo video live | Yes [C3] | Partial† [H4] | Yes [R1][R2] | Yes [K1][K2] | Unknown | Yes [T1] | Yes [B1] |
| PK battles | Yes [C1][C3] | Unknown | Yes [R2] | Yes [K2] | Unknown | Yes [T8][T9] | Yes [B1][B3] |
| Co-host / guest seats in a live | Partial [C3] | Unknown | Partial† [R3] | Partial [K1][K2] | Unknown | Yes [T1][T12] | Yes [B2][B5] |
| Beauty filters / effects | Yes [C1] | Unknown | Unknown | Partial† [K4] | Unknown | Yes [T1] | Yes [B2][B3] |
| Moderation tools (AI, admins, kick/mute) | Yes [C16][C17] | Unknown | Partial [R1][R2] | Partial [K1] | Unknown | Yes [T6][T10] | Yes [B2][B5] |
| Real-time translation | Yes [C1][C2] | Unknown | Unknown | Yes [K1][K2] | Unknown | Yes [T1] | Unknown |
| **2. 1-to-1 calls** | | | | | | | |
| Paid 1-to-1 video calls per minute | Yes [C5][C9] | Partial† [H4] | Yes [R2] | Partial [K2] | Partial [Z1] | Partial [T1][T6] | No [B5] |
| Host sets own price | Yes [C9][C20] | Unknown | Partial†: capped by level [R4] | Unknown | Unknown | Partial: entry fee, subscription [T6][T11] | No [B5] |
| Free trial call / free-call cards | Yes: 90 s [C6][C17] | Unknown | Unknown | Unknown | Unknown | Unknown | No: calls are free [B5] |
| Refund on failed call | Yes [C18] | Unknown | Unknown | Unknown | Unknown | Unknown | No: calls are free [B5] |
| Published cash-out rate | Yes [C5] | Unknown | Yes [R2] | Unknown | Unknown | Yes [T4][T5] | Partial [B6] |
| **3. Party / voice rooms** | | | | | | | |
| Voice rooms | Yes [C1][C4] | Unknown | Yes [R2] | Yes [K2] | Unknown | Yes [T1][T12] | Yes [B1][B7] |
| Multi-seat video rooms | Yes [C1][C4] | Unknown | Partial† [R3] | Partial [K1] | Partial† [Z1] | Yes [T1] | Yes [B2] |
| Seat count published | Partial: video up to 5 [C1] | Unknown | Unknown | Unknown | Unknown | Yes: up to 9 [T1] | Yes: 4/6/9/12 [B2][B5] |
| Seat locking / closing | Partial [C4] | Unknown | Unknown | Unknown | Unknown | Unknown | Yes [B5] |
| Mic control (mute / remove) | Partial [C4] | Unknown | Unknown | Partial: own mic [K2] | Unknown | Partial: remove viewers [T10] | Yes [B2][B5] |
| Private / invite-only / password rooms | Unknown | Unknown | Unknown | Unknown: users ask for it† [K2] | Unknown | Yes: invite-only, entry fee [T6] | Unknown |
| Room themes / backgrounds / decoration | Partial: title, cover [C4] | Unknown | Unknown | Partial: stickers [K2] | Unknown | Unknown | Partial [B3][B4] |
| Room music | Unknown | Unknown | Yes [R1] | Unknown | Unknown | Unknown | Yes [B7] |
| Room admin roles | Unknown | Unknown | Unknown | Unknown | Unknown | Yes [T10] | Yes [B2] |
| Room levels / creation gating | Partial: Lv6 to create [C4] | Unknown | Partial†: host Lv10 [R4] | Unknown | Unknown | Partial: >500 diamonds for premium [T6] | Yes [B2][B5] |
| Membership / fan club / subscription | Unknown | Unknown | Unknown | Yes [K2] | Unknown | Yes [T11] | Yes [B3] |
| Room promotion (pin / boost) | Yes: SVIP pin [C14] | Unknown | Unknown | Unknown | Unknown | Unknown | Yes [B2] |
| **4. Gifts** | | | | | | | |
| Animated gifts | Yes [C1] | Partial [H1] | Partial [R1] | Yes [K2] | Unknown | Yes [T2] | Yes [B6] |
| Full-screen or "travelling to receiver" gift animation | Unknown | Unknown | Unknown | Unknown | Unknown | Unknown | Unknown |
| Lucky gifts / random items | Unknown | Unknown | Unknown | Partial [K2], † [K4] | Unknown | Unknown | Partial [B1] |
| Gift wall / gift records | Partial [C10] | Unknown | Unknown | Unknown | Unknown | Unknown | Partial [B6] |
| Combo / multi-send | Unknown | Unknown | Unknown | Unknown | Unknown | Unknown | Yes [B6] |
| Custom (personal) gifts | Yes: SVIP [C14] | Unknown | Unknown | Unknown | Unknown | Yes [T2] | Unknown |
| **5. Rankings & events** | | | | | | | |
| Host leaderboards (periodic) | Partial [C19] | Unknown | Partial [R2] | Partial† [K4] | Unknown | Yes [T4][T8] | Yes [B2][B4] |
| Top-supporter / "rich" lists | Partial [C10] | Unknown | Unknown | Partial† [K4] | Unknown | Unknown | Yes [B6] |
| Lucky-gift / game lists | Unknown | Unknown | Unknown | Partial† [K4] | Unknown | Unknown | Unknown |
| Public event reward tiers | Unknown | Unknown | Partial: host bonus caps only [R2] | Unknown | Unknown | Yes [T8][T9] | Unknown |
| **6. Profiles & social** | | | | | | | |
| Profile card in rooms | Partial [C16] | Unknown | Unknown | Unknown | Unknown | Partial [T10] | Yes [B5] |
| Follow | Yes [C3] | Unknown | Unknown | Unknown | Unknown | Yes [T11] | Yes [B3] |
| Block / report | Yes [C13][C16] | Unknown | Partial: report [R2] | Unknown | Unknown | Partial: report [T13] | Yes [B10] |
| Multiple-account policy published | Yes: 1 face = 1 account [C13] | Unknown | Yes: banned [R2] | Partial† [K4] | Unknown | Partial [T8] | Unknown |
| Account switching feature | Unknown | Unknown | Unknown | Unknown | Unknown | Unknown | Unknown |
| Invisible / incognito mode | Yes: SVIP [C14] | Unknown | Unknown | Unknown | Unknown | Yes [T2] | Partial: hide status [B10] |
| **7. Business models** | | | | | | | |
| Host programme with public terms | Yes [C5] | Partial† [H4] | Yes [R2] | Partial† [K4] | Unknown | Yes [T4][T5] | Partial [B6] |
| Agency + sub-agency | Yes [C10][C11] | Partial† [H5] | Yes [R2] | Partial† [K3] | Unknown | Yes [T4] | Unknown |
| Coin seller / reseller | Partial† [C21] | Unknown | Unknown | Partial† [K2] | Unknown | Yes [T3] | Unknown |
| VIP / noble / subscription | Yes [C12][C14][C15] | Unknown | Unknown | Partial: fan club [K2] | Unknown | Yes [T2][T11] | Partial [B8] |
| VIP prices published | Partial [C9][C12][C15] | Unknown | Unknown | Unknown | Unknown | Yes [T2] | No [B8] |
| **8. Games** | | | | | | | |
| In-app games | Yes [C8] | Unknown | Yes [R1] | Yes [K1][K2] | Unknown | Yes [T7] | Yes [B2] |
| Chance games joined with paid currency | Yes [C8] | Unknown | Partial† [R4] | Partial [K2] | Unknown | Yes [T7][T8] | Unknown |
| Ludo / Teen Patti | No: not listed [C8] | Unknown | Unknown | Unknown | Unknown | Unknown | Unknown |
| **9. Retention** | | | | | | | |
| Daily check-in / tasks | Yes [C7] | Partial† [H4] | Partial†: host daily pay tasks [R4] | Partial† [K4] | Unknown | Partial [T1][T2] | Yes [B3] |
| User levels | Yes [C13] | Unknown | Partial† [R4] | Unknown | Partial† [Z1] | Yes [T2] | Yes [B6][B8] |
| Badges / medals | Yes [C1][C14] | Unknown | Unknown | Unknown | Unknown | Yes [T2][T3] | Yes [B3][B4] |
| Profile frames | Yes [C13] | Unknown | Unknown | Unknown | Unknown | Yes [T2] | Partial [B3] |
| Entrance effects | Yes [C1][C13] | Unknown | Unknown | Unknown | Unknown | Partial [T3] | Yes [B3] |
| Spend rebate / cashback | Yes: 10% [C7] | Unknown | Unknown | Unknown | Unknown | Partial: bet-linked [T8] | Unknown |

---

## 6. Features worth implementing in ZIPPER

A quick keyword search of the ZIPPER code (`zipper-app/`, `functions/`, `backend/`) on 3 Nov 2026 found code for PK invites, party-seat locking, lucky gifts, free call cards in daily rewards, entrance effects and leaderboards. It found nothing for password rooms, spend rebates, fan clubs, families or clans, real-time translation, or games such as Ludo, Teen Patti or wheel games. This is a hint, not a feature audit; check before planning.

1. **Standard free-trial call with a price prompt when it ends** (seen in Chamet: 90 s via free cards [C6][C17])
   - User value: a new user can check that a host is real and friendly before spending.
   - Risk: free cards get farmed with extra accounts and hosts receive many unpaid calls, so tie cards to face or device checks and a daily cap.
2. **Show the price before every call; hosts set their own rate within caps and see their last 7 days of performance** (Chamet [C9][C20]; Recho level caps† [R4])
   - User value: fewer billing surprises for callers, more control for hosts.
   - Risk: prices creep up and calls drop, as Recho users complain [R1]; cap rates by level and limit how often they change.
3. **Automatic refund for calls that fail on our side, with itemised call receipts** (Chamet [C18])
   - User value: trust in per-minute billing.
   - Risk: users disconnect on purpose to get refunds, so decide refunds from server-side session evidence.
4. **Delayed spend rebate, for example a percentage back after N days, claimed manually, with games excluded** (Chamet 10% after 30 days [C7])
   - User value: rewards loyal spenders without cutting coin-pack prices.
   - Risk: creates a deferred liability, and anything tied to games could look like "enrichment" under the gaming law (section 4).
5. **Fan club or subscription to a host, with tiers and a badge** (Bigo [B3], Tango [T11], Crush [K2])
   - User value: steady income for hosts and a sense of belonging for fans.
   - Risk: Play billing and subscription-policy compliance, refunds, and hosts setting abusive prices.
6. **Better PK: team PK, anti-snipe overtime (+20 s when the lead changes in the last 20 s) and published event rules** (Tango [T8]; Chamet team PK [C3])
   - User value: fairer, more exciting battles.
   - Risk: more pressure to spend; never attach bets or outcome cashback in India.
7. **Fuller party-room controls: 4/6/9/12 layouts, close seat, mute or remove, room announcement, admins with limits by level, room level and room boost** (Bigo [B2][B5]; admin limits† [B9])
   - User value: flexible rooms, and hosts can hand off moderation.
   - Risk: more moderation work and admin abuse, so keep audit logs of admin actions.
8. **Families or clans with family gifts, a monthly prestige ranking and monthly targets** (Bigo [B4])
   - User value: social ties beyond agencies and team goals that bring people back.
   - Risk: overlaps with the agency hierarchy, and fake-member farms; define who earns what.
9. **Room background music and a voice-effects mixer** (Recho [R1], Bigo [B7])
   - User value: atmosphere in voice rooms.
   - Risk: music licensing in India; needs a licensed catalogue or strict upload rules.
10. **Real-time translation, starting with chat and moving to call subtitles** (Chamet [C1], Crush [K1], Tango [T1])
    - User value: matches across Indian languages, such as Hindi with Tamil, Telugu or Bengali.
    - Risk: cost per minute, mistranslation, and translated text still needs moderation.
11. **Privacy options for spenders: invisible room entry and anonymous gift ranking** (Chamet [C10][C14]; Tango [T2])
    - User value: high spenders can stay private.
    - Risk: weaker accountability; keep internal attribution for fraud and anti-money-laundering checks.
12. **Verified reseller tiers with a public badge and rules on reselling to other resellers** (Tango [T3])
    - User value: buyers can tell real coin sellers from scammers.
    - Risk: KYC, GST and payment compliance, plus reseller fraud and chargebacks, and payment-facilitation exposure if any game is ever classed as a money game [L1].
13. **Gift-panel tabs for multi-send, a backpack of free gifts, event gifts and VIP-only gifts** (Bigo [B6])
    - User value: faster gifting and visible rewards.
    - Risk: a cluttered panel; VIP-only gifts can feel exclusionary.
14. **Published, dated rules and reward tiers for every event** (Tango [T8][T9])
    - User value: trust, and fewer disputes with hosts and agencies.
    - Risk: public promises must be kept, and people will try to game the rules.

---

## 7. Possible unique ZIPPER features

We did not find these in the public documentation of the seven apps reviewed.

1. **An "India-safe games" policy:** only no-stake social games with no paid entry and no winnings that convert to value, plus an OGAI determination where useful [L1][L2].
   - User value: games without legal worry, which builds trust with users and their families.
   - Risk: less game revenue than rivals that sell chance games.
2. **Spend controls in rupees:** optional daily or weekly diamond limits, a monthly spend summary, and a cool-off or self-exclusion option.
   - User value: users feel in control, which makes the app easier to accept for them and their families.
   - Risk: lower spend per paying user and more product complexity.
3. **Rupee-first payout transparency:** a published bean-to-rupee rate, UPI payouts, and monthly tax-ready statements for hosts and agencies. Competitors publish rates in US dollars [C5][R2][T5].
   - User value: Indian hosts know exactly what they will be paid.
   - Risk: tax and TDS obligations and exchange-rate changes become visible public commitments; get advice first.
4. **An agency fairness charter:** hosts can see their agency's commission ratio and move to another agency after a notice period. Chamet locks hosts to their upper agency [C10].
   - User value: hosts are protected and more likely to stay on the platform.
   - Risk: pushback from agencies and disputes over poaching.
5. **The same pay rules for hosts of any gender**, which addresses the gender-pay concern recorded in `APP-CRM-MISMATCH.md`. † HiClub agencies recruit women only [H3][H4].
   - User value: fairness, and lower legal risk if hosts are ever treated as workers.
   - Risk: market habits differ, and the mix of hosts may change.
6. **A host safety kit:** one tap to end and report a call, a "safe word" that does the same, a screenshot or recording deterrent, and recording with consent for disputes.
   - User value: a safer service for women hosts.
   - Risk: false reports, and recordings raise privacy duties under India's data-protection law.
7. **Open lucky mechanics, or none:** if any random reward stays, publish the odds and caps, never pay out in value that can be withdrawn, and keep the store's "random items" disclosure, as Bigo's listing does [B1].
   - User value: users can trust the odds they see.
   - Risk: the gaming-law classification risk remains if rewards convert to value [L1]; get a legal review.
8. **Regional and festival room formats:** Antakshari or karaoke rooms with a licensed catalogue, regional-language rooms, and festival or cricket-season events. Of the apps reviewed, only Tango documents India-specific events, and those are battles [T8].
   - User value: rooms that fit Indian culture.
   - Risk: licensing costs and moderation in many languages.

---

## 8. Sources

All sources were checked on **2026-11-03**. "Official" means published by the developer or the government. "Unofficial" means an agency, reseller, third party or user review.

**Chamet**

- [C1] Chamet – Google Play listing (official store) — https://play.google.com/store/apps/details?id=com.hkfuliao.chamet — checked 2026-11-03
- [C2] Chamet home page (official) — https://www.chamet.com/ — checked 2026-11-03
- [C3] Chamet live streaming page (official) — https://www.chamet.com/live-streaming — checked 2026-11-03
- [C4] Chamet party rooms page (official) — https://www.chamet.com/chat-room — checked 2026-11-03
- [C5] Chamet host earnings page (official) — https://www.chamet.com/host-earnings — checked 2026-11-03
- [C6] Chamet free video call page (official) — https://www.chamet.com/free-video-call — checked 2026-11-03
- [C7] Chamet free coins page (official; reviewed July 2026) — https://www.chamet.com/free-coins — checked 2026-11-03
- [C8] Chamet party room games page (official) — https://www.chamet.com/party-room-games — checked 2026-11-03
- [C9] "How much does Chamet cost?" (official; updated July 2026) — https://www.chamet.com/compare/chamet-cost — checked 2026-11-03
- [C10] Chamet Help: Agency & Hosts (official) — https://www.chamet.com/help/agency-and-hosts — checked 2026-11-03
- [C11] Chamet Help: agency commission ratio (official; 29 Jun 2026) — https://www.chamet.com/help/how-is-my-commission-ratio-calculated-when-i-help-users-talk-to-strangers — checked 2026-11-03
- [C12] Chamet Help: Chamet Plus (official; 29 Jun 2026) — https://www.chamet.com/help/what-is-chamet-plus-for-online-video-chat-users — checked 2026-11-03
- [C13] Chamet Help: Account & Login (official) — https://www.chamet.com/help/chamet-account-and-login — checked 2026-11-03
- [C14] Chamet Help: SVIP privileges (official; 18 Jun 2026) — https://www.chamet.com/help/what-are-the-specific-svip-privileges-in-the-chamet-app — checked 2026-11-03
- [C15] Chamet Help: Diamond VIP (SVIP) requirements (official; 18 Jun 2026) — https://www.chamet.com/help/what-are-the-level-requirements-for-diamond-vip-svip-on-this-video-chat-app — checked 2026-11-03
- [C16] Chamet Help: Report Content & Safe Live Talk (official) — https://www.chamet.com/help/report-content-and-safe-live-talk — checked 2026-11-03
- [C17] Chamet Help: Free Video Chat Features (official) — https://www.chamet.com/help/free-video-chat-features — checked 2026-11-03
- [C18] Chamet Help: Video Call App Recharge (official) — https://www.chamet.com/help/video-call-app-recharge — checked 2026-11-03
- [C19] Chamet Help: Charm Queen event ranking (official; 29 Jun 2026) — https://www.chamet.com/help/why-not-on-charm-queen-event-ranking-for-videochat-random — checked 2026-11-03
- [C20] Chamet Help: adjusting 1v1 price (official; 18 Jun 2026) — https://www.chamet.com/help/how-do-i-adjust-my-1v1-video-chat-price-on-chamet — checked 2026-11-03
- [C21] chamet-agency.com, "Chamet Diamond Selling" (UNOFFICIAL; the site says it is not affiliated with Chamet) — https://www.chamet-agency.com/chamet-diamond-selling/ — checked 2026-11-03
- [C22] Chamet Help: paying for calls and the web portal (official; 29 Jun 2026) — https://www.chamet.com/help/how-do-i-pay-for-a-premium-online-video-call — checked 2026-11-03

**HiClub**

- [H1] HiiclubChat: Easy Expression – Google Play listing (official store) — https://play.google.com/store/apps/details?id=com.hiiclub.live — checked 2026-11-03
- [H2] Hiiclub Pro: Live Video Chat – Google Play listing (a different app) — https://play.google.com/store/apps/details?id=com.hiiclub — checked 2026-11-03
- [H3] hiiclubofficial.in home page (UNOFFICIAL agency site) — https://hiiclubofficial.in/ — checked 2026-11-03
- [H4] hiiclubofficial.in host page (UNOFFICIAL) — https://hiiclubofficial.in/hiiclub-host.html — checked 2026-11-03
- [H5] hiiclubofficial.in agency page (UNOFFICIAL; links to the oms.hiiclub.live sign-up) — https://hiiclubofficial.in/hiiclub-agency.html — checked 2026-11-03
- [H6] hiiclubpremium.com (UNOFFICIAL agency site) — https://hiiclubpremium.com/ — checked 2026-11-03
- [H7] www.hiiclub.live, which redirects to www.hiiclublive.xyz (an empty JavaScript page) — https://www.hiiclub.live/ — checked 2026-11-03

**Recho**

- [R1] Recho-Live, Video Chat & Room – Google Play listing (official store) — https://play.google.com/store/apps/details?id=com.godhkvexa.recho — checked 2026-11-03
- [R2] rechox.com (official site linked from Play; includes Terms and Privacy Policy dated 23 Jul 2025) — https://rechox.com — checked 2026-11-03
- [R3] recho.live (UNOFFICIAL; "official agency" site) — https://recho.live/ — checked 2026-11-03
- [R4] recho.live host programme page (UNOFFICIAL) — https://recho.live/become-a-host/ — checked 2026-11-03
- [R5] rechoagent.com (UNOFFICIAL agency site) — https://rechoagent.com/ — checked 2026-11-03

**Crush Live**

- [K1] Crush Live – Google Play listing (official store) — https://play.google.com/store/apps/details?id=com.starlink.crushlive — checked 2026-11-03
- [K2] Crush Live – App Store listing, with version history, in-app purchase list and user reviews (official store) — https://apps.apple.com/us/app/crush-live/id6745060350 — checked 2026-11-03
- [K3] crushfunlive.com home page (UNOFFICIAL; "Crush Live Agency") — https://crushfunlive.com/ — checked 2026-11-03
- [K4] crushfunlive.com host page (UNOFFICIAL) — https://crushfunlive.com/host — checked 2026-11-03

**Zing**

- [Z1] Zing – Fast Call & Video Chat – Google Play listing (official store) — https://play.google.com/store/apps/details?id=com.bigdot.zing — checked 2026-11-03
- [Z2] Zing: Dating App & Chat – Google Play listing (a different app) — https://play.google.com/store/apps/details?id=com.hiorbye.app.zing — checked 2026-11-03

**Tango**

- [T1] Tango – Google Play listing (official store) — https://play.google.com/store/apps/details?id=com.sgiggle.production — checked 2026-11-03
- [T2] Tango Help: Loyalty Program (official; 16 Sep 2026) — https://help.tango.me/en/articles/5726547-tango-loyalty-program — checked 2026-11-03
- [T3] Tango Help: Reseller Benefits Program 2025 (official; 12 Feb 2025) — https://help.tango.me/en/articles/10547348-reseller-benefits-program-2025 — checked 2026-11-03
- [T4] Tango Partner Program for Agents, policy PDF (official; undated) — http://resources.tango.me/partners-policy.pdf — checked 2026-11-03
- [T5] Tango Help: value of diamonds in cash (official; 10 Mar 2025) — https://help.tango.me/en/articles/2985216-what-is-the-value-of-my-diamonds-in-cash — checked 2026-11-03
- [T6] Tango Help: Premium Live broadcast (official; 18 Jul 2022) — https://help.tango.me/en/articles/2985209-how-do-i-start-a-premium-live-broadcast-on-tango — checked 2026-11-03
- [T7] Tango Help: Live Roulette in stream (official; 8 Apr 2026) — https://help.tango.me/en/articles/14483936-live-roulette-in-stream-earn-more — checked 2026-11-03
- [T8] Tango Help: India's Partner Battle 2026 (official; 10 Aug 2026) — https://help.tango.me/en/articles/16231801-india-s-partner-battle-2026 — checked 2026-11-03
- [T9] Tango Help: Battle Power Up (official; 29 Sep 2026) — https://help.tango.me/en/articles/14686100-battle-power-up — checked 2026-11-03
- [T10] Tango Help: Set Your Own Admin (official; 26 Dec 2021) — https://help.tango.me/en/articles/3580040-set-your-own-admin — checked 2026-11-03
- [T11] Tango Help: Subscribe to a Broadcaster (official; 11 Jun 2026) — https://help.tango.me/en/articles/4500770-subscribe-to-a-broadcaster — checked 2026-11-03
- [T12] Tango Help: Audio-Only Broadcasts (official; 26 Dec 2021) — https://help.tango.me/en/articles/4744994-audio-only-broadcasts — checked 2026-11-03
- [T13] Tango Help: "For Viewers" collection, listing Gift Rush events, crypto coin purchase, VIP Boost, Crowns and violation reporting (official) — https://help.tango.me/en/collections/2674063-for-viewers — checked 2026-11-03
- [T14] Tango Help: "For Broadcasters" collection, listing the warning system, payout platforms, Ribbons and India events (official) — https://help.tango.me/en/collections/2674073-for-broadcasters — checked 2026-11-03

**Bigo Live**

- [B1] Bigo Live – Google Play listing (official store) — https://play.google.com/store/apps/details?id=sg.bigo.live — checked 2026-11-03
- [B2] Bigo blog: hosting a multi-guest stream (official; updated 4 Feb 2026) — https://www.bigo.tv/blog/bigo-live-multi-guest-room — checked 2026-11-03
- [B3] Bigo blog: app features (official; updated 4 Feb 2026) — https://www.bigo.tv/blog/bigo-live-app-features — checked 2026-11-03
- [B4] Bigo blog: families (official; updated 4 Feb 2026) — https://www.bigo.tv/blog/bigo-live-family — checked 2026-11-03
- [B5] Bigo blog: video calls from 1v1 to groups (official; updated 15 Jul 2026) — https://www.bigo.tv/blog/bigo-live-video-call — checked 2026-11-03
- [B6] Bigo blog: sending gifts (official; updated 4 Feb 2026) — https://www.bigo.tv/blog/bigo-live-virtual-gifts — checked 2026-11-03
- [B7] Bigo blog: Audio Live and voice effects (official; updated 4 Feb 2026) — https://www.bigo.tv/blog/audio-live-bigo-live — checked 2026-11-03
- [B8] BIGOLIVE VIP Service Terms (official; effective from about Jan 2025) — https://activity.bigo.tv/live/act/bigo_vip/agreement.html — checked 2026-11-03
- [B9] Bigo activity rules page; it would not render, so admin limits come from a search-engine snippet (treated as †) — https://activity.bigo.tv/live/act/act_8115/ — checked 2026-11-03
- [B10] Bigo blog: privacy settings checklist (official; 24 Apr 2026) — https://www.bigo.tv/blog/bigo-live-privacy-settings-checklist — checked 2026-11-03

**Other apps**

- [O1] HelloYo – Google Play listing (official store) — https://play.google.com/store/apps/details?id=sg.bigo.hellotalk — checked 2026-11-03

**Legal and regulatory**

- [L1] The Promotion and Regulation of Online Gaming Act, 2025 (Act No. 32 of 2025), MeitY consolidated text (official) — https://www.meity.gov.in/static/uploads/2025/10/8a7f103cefc68ed8aaa2ebc9a2ed7c13.pdf — checked 2026-11-03
- [L2] PIB backgrounder, "A New Era of Online Gaming Governance" (official; 30 Apr 2026) — https://www.pib.gov.in/PressReleasePage.aspx?PRID=2256973 — checked 2026-11-03
- [L3] Legal 500 / Dolce Vita Advisors, analysis of the 2025 Act and 2026 Rules (8 May 2026) — https://www.legal500.com/intelligence/india/media-telecoms-it-entertainment/india%E2%80%99s-new-online-gaming-framework-analysis-of-the-2025-act-and-2026-rules — checked 2026-11-03
- [L4] PIB release of 29 Jun 2020 on blocking 59 apps, mirrored by the Embassy of India, Manila (official) — https://eoimanila.gov.in/news-details/government-of-india-bans-59-mobile-apps-which-are-prejudicial-to-sovereignty-and-integrity-of-india-defence-of-india-security-of-state-and-public-order — checked 2026-11-03
- [L5] Storyboard18, citing Moneycontrol, on the 119-app block order (news) — https://www.storyboard18.com/how-it-works/indias-app-block-order-on-google-play-store-119-targeted-15-down-developers-in-the-dark-57252.htm — checked 2026-11-03
- [L6] Digit.in, "Indian govt to ban 119 apps…" (news; 20 Feb 2025) — https://www.digit.in/news/apps/indian-govt-to-ban-119-apps-linked-to-chinese-developers-raising-national-security-concerns.html — checked 2026-11-03

---

## 9. Gaps and fetch problems

- **Could not fetch, or got empty pages; we did not try to get around this:**
  - hiclub.live and apkcombo.com timed out.
  - Google Play and APKPure search pages came back empty; only app detail pages worked.
  - help.tango.me/hc/en-us timed out, but articles under help.tango.me/en/ worked.
  - www.crushfun.live, www.hiiclublive.xyz (reached through the www.hiiclub.live redirect) and zing.dikilive.com returned empty JavaScript pages.
  - activity.bigo.tv/live/act/act_8115/ returned nothing, so the admin limits come from a search snippet and are marked †.
- **No in-app checking.** Many features, such as seat locks, password rooms and room themes, probably exist in some of these apps but are not publicly documented. The "Unknown" cells reflect what is public, not what is in the apps.
- **Agency sites contradict each other and the developer.** For example, Recho's official site says new hosts get up to US$6 a day, while an agency site says US$2; payout time is quoted as both 1–3 business days and 7 days [R2][R3][R4].
- **App identification is uncertain** for HiClub (medium confidence; based on a chain of domains) and Zing (low confidence; two unrelated apps share the name).
- **Store numbers** come from the US-English storefront, and content-rating labels differ by region; for example, Recho is labelled 12+ on Play while its own text says 18+.
- **No pricing in rupees was published** by any of the seven apps. Chamet says its prices are localised automatically [C9].
- **Not covered in depth because official documentation was not found:** Poppo Live, MICO, LivU, StarMaker, HelloYo and FRND.
