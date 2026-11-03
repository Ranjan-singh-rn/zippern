# ZIPPER (India): regulatory desk research on online gaming, virtual currency, payments, privacy and Google Play

| | |
|---|---|
| Prepared | 3 November 2026 |
| Purpose | Background for briefing Indian counsel and a chartered accountant. **This is not legal advice.** It does not say whether any feature is legal or illegal. Those decisions belong to counsel. |
| Sourcing | Every factual statement carries a tag such as [S3]. Section 9 lists each source with its URL, whether it is primary or secondary, and the date it was checked. **All web sources were checked on 3 Nov 2026.** Facts taken from this repository are tagged [R#]. |
| Labels | **Primary**: read in the statute, gazette, court document, regulator page or platform policy page itself. **Secondary**: a law-firm note or news report. **Unverified**: I could not confirm it, so treat it as a lead, not a fact. |

### Risk scale

These ratings are research judgements meant to help counsel prioritise. They are not legal conclusions.

- **Very high**: On the most natural reading of the statute and the 2026 Rules factors, the feature looks like an "online money game" or gambling. Offences under PROGA ss.5 and 7 are cognizable and non-bailable [S1]. There is also a clear conflict with Google Play policy.
- **High**: There are credible arguments both ways, or there is a clear platform-policy conflict that is likely to lead to removal, or the design element makes other risks worse.
- **Medium**: The feature is not an online game on its face, but it carries material exposure under payment, platform, tax, consumer or privacy rules. Or PROGA exposure depends on design details.
- **Low**: The feature is unlikely to fall under PROGA's prohibitions. Ordinary compliance duties still apply.

---

## 1. Executive summary

1. **India's national ban on online money games is in force.** The Promotion and Regulation of Online Gaming Act, 2025 ("PROGA", Act 32 of 2025) received assent on 22 Aug 2025. It came into force on **1 May 2026** under S.O. 1994(E) dated 22 Apr 2026. The Promotion and Regulation of Online Gaming Rules, 2026 (G.S.R. 303(E), 22 Apr 2026) came into force the same day. The Rules set up the **Online Gaming Authority of India (OGAI)** as an attached office of MeitY [S1][S2][S3][S4].
2. **The definitions reach purchased virtual currency, and skill versus chance does not matter.** An "online money game" is a game, "irrespective of whether such game is based on skill, chance, or both", played by paying fees or depositing "money or other stakes in expectation of winning which entails monetary and other enrichment". "Other stakes" expressly includes "credits, coins, token … whether it is real or virtual, which is purchased by paying money directly or by indirect means" [S1]. Rule 9 tells OGAI to ask whether stakes are placed "in expectation of winning monetary or other stakes" and how in-game assets "may be transferred, redeemed, monetised or used outside the game environment" [S3].
3. **The penalties are criminal.** Offering an online money game carries up to 3 years in prison and/or a fine of up to ₹1 crore. Advertising one carries up to 2 years and/or up to ₹50 lakh. Facilitating payments carries up to 3 years and/or up to ₹1 crore. Repeat offences carry minimum terms. Company officers are personally liable, and investigators can search and arrest without a warrant [S1].
4. **The Act has not been stayed, and the challenge is still pending.** The constitutional challenge (T.C.(C) No. 133/2025) is before a bench led by CJI Surya Kant. On 5 Aug 2026 the Court agreed to give it a final hearing. It also agreed to hear a PIL against gambling apps said to operate "under the guise of social and e-sports games" [S23][S45]. **I found no judgment as of 3 Nov 2026.** A reported final hearing on 6–7 Oct 2026 could not be verified [S43].
5. **Two related Supreme Court rulings went against the industry.** On **27 May 2026** the Court held in *State of Tamil Nadu v Junglee Games* (2026 INSC 594) that States may prohibit betting on games of skill. Review petitions were dismissed on 15 Oct 2026. In *DGGI v Gameskraft* (2026 INSC 595) the Court upheld GST on the full value of stakes [S24][S25][S42][S43][S44].
6. **Enforcement is active and reaches the whole supply chain.** An advisory dated 29 Jul 2026, issued through OGAI, told app stores, cloud providers, telecom operators and ISPs, banks, social media, OTT platforms and ad agencies to disable online money games, stop hosting them, block payments to them and stop advertising them. This is reported by secondary sources only [S48][S49]. As of 1 Sep 2026, OGAI had registered no game and had received 201 complaints [S47].
7. **ZIPPER's highest-risk items are rated Very high.** They are:
   - every proposed staking game: Aviator/Crash, Slots, Teen Patti, Chicken Road, Plinko and Fishing;
   - entry-fee Ludo and Carrom with a pooled prize and a platform cut (two players pay 100 each, the winner gets 150, the platform keeps 50);
   - lucky gifts, if they are switched back on.

   On a plausible reading, each of these is an "online money game". Users buy diamonds with money, either in the app or through resellers, and stake them. Winnings can then be spent outside the game on services with real-money value: calls with hosts, and gifts that become host "beans" which hosts withdraw as cash [S1][S3][R1][R3].
8. **"Winnings stay in the app" is probably not a safe harbour.** The Act does not require that winnings can be cashed out. Rule 9 asks about winning "other stakes" and about use "outside the game environment" [S3]. OGAI's own application form lists "In-game assets" and "Services" as kinds of "enrichment" [S8]. Law-firm commentary warns that tokens which cannot be cashed out, but can buy things otherwise sold for real money, may still be "other stakes" [S52][S53]. ZIPPER's own economy lets anyone who receives gifts convert beans to diamonds, and lets verified hosts withdraw cash [R1][R2]. A narrower reading ("monetary *and* other enrichment" requires money) exists, but it looks weaker on ZIPPER's facts (see §4.1). Counsel must decide.
9. **Calls, gifts and the subscription are not games, but they are not risk-free.** Paid calls, gifts and the ₹200/month private room are not "online games" on their face, so PROGA risk is Low. They do raise questions under Google Play Billing, content and age rules, consumer protection, tax, and RBI rules on prepaid instruments. The RBI question arises because diamonds are spent on the services of independent hosts [S31][S32][S35][S36][S19].
10. **The coin-seller channel is high-risk.** The app's in-app "Verified resellers" screen shows each reseller's UPI ID and QR code, and the code models these payment methods: `upi | qr | binance | bank | international` [R3]. In an app distributed on Play, this conflicts with Play's rule against steering users to payment methods other than Play Billing [S31][S32]. If games go live, buying diamonds from resellers is also buying "other stakes" by "indirect means", and the sale could amount to "facilitating" payments under s.7 [S1].
11. **Google Play does not allow real-money gaming in India.** India is not on Play's list of countries where gambling apps are allowed. The grace period for the India rummy/DFS pilot ended on **22 Jan 2026**. Play prohibits staking "real money (including in-app items purchased with money)" for prizes of real-world value. Diamonds and subscriptions must be sold through Play Billing or India's alternative billing programme. Loot-box odds must be disclosed [S28][S29][S30][S31][S33].
12. **Distributing the APK outside Play changes less than it seems.** It removes Play's billing and content rules. It does **not** remove PROGA (which covers services offered in India or from abroad), State law, blocking, the ban on payment facilitation, GST/TDS or DPDP. Google's developer verification also extends to sideloaded apps worldwide in 2027; the India date is unverified [S1][S40].
13. **Tax: GST rose to 40% and TDS moved to a new section.**
    - GST on "specified actionable claims", which include online money gaming, rose from 28% to **40% from 22 Sep 2025**. It is charged on the full amount deposited, and it applies "whether … permissible or otherwise under any other law" [S10][S11][S25][S54].
    - TDS at 30% on net online-game winnings moved from s.194BA of the Income-tax Act, 1961 to **s.393** of the Income-tax Act, 2025 from 1 Apr 2026. This is from secondary sources; the exact sub-item is unverified [S12][S56].
14. **Face verification data is biometric data under current rules.** The face images used to verify hosts count as biometric sensitive personal data under the SPDI Rules, 2011. Those Rules require written consent, purpose limitation, retention only as long as needed, a security standard, and conditions on transfers [S16]. Most DPDP Act and DPDP Rules duties start on **12/13 May 2027**. Rule 4, on consent managers, starts on 12/13 Nov 2026 [S13][S57].

**Suggested first questions for counsel (not advice):**
1. Can any staking or entry-fee game be offered at all?
2. Should lucky gifts stay disabled?
3. What is the right Play Billing posture, and can the reseller channel continue?
4. Does the bean cash-out path change the "other stakes" analysis?
5. How should consent and retention work for biometric host verification?

---

## 2. Risk table by ZIPPER mechanic

| # | Mechanic | PROGA / gambling-law risk | Other material exposure | Question for counsel (or CA) | Sources |
|---|---|---|---|---|---|
| 1 | **Paid 1-to-1 video calls with hosts** (paid in diamonds; host earns beans, withdrawable as cash) | **Low.** A call is not an "online game" under s.2(1)(f). Risk rises if calls become prizes or are linked to game outcomes. | **Medium.**<br>• Play Billing applies to diamonds. Play's carve-out for 1:1 services appears not to fit, because calls are paid in in-app currency and ZIPPER keeps a share. Confirm with counsel or Google.<br>• Play bans content "intended to be sexually gratifying" and paid solicitation of sexual acts.<br>• Apps whose core feature is random communication with strangers must block minors.<br>• IT Rules duty of reasonable efforts against obscene content.<br>• RBI condition that closed-system PPIs "cannot be used for payment or settlement for third party services".<br>• Tax on host payouts (CA question; not researched here). | (1) Are diamonds a closed-system PPI when they are spent on calls with independent hosts who are paid out in cash? (2) Is ZIPPER the supplier of the call service, with hosts as contractors, or an intermediary? What TDS and GST follow? (3) What minimum age and age-assurance standard? | [S1][S9][S19][S31][S32][S35][S36] |
| 2 | **Virtual gifts** (fixed price, non-random) | **Low** on their own. But gifts are how diamonds, including any game winnings, reach a host who can withdraw cash (see row 17). | **Medium.**<br>• Play Billing applies. Play's "tips" exemption needs 100% to go to the creator and no digital item to be granted. ZIPPER keeps a share and gifts are digital items.<br>• Same PPI question as row 1.<br>• Host share and conversion rates should be disclosed clearly (dark-patterns guidelines). | Does the gift → beans → cash path make diamonds "recognised as equivalent or convertible to money" (s.2(1)(j)), for games as well? | [S1][S18][S19][S32][R1] |
| 3 | **Lucky gifts** (random diamond payback to the sender). Currently disabled. | **Very high if switched on.** A paid stake (diamonds) earns a chance-based return in diamonds that can be used outside any game. The repository records multipliers up to 200× in app code against 20× in config, and an RNG that runs on the phone. | • Play requires loot-box odds to be shown before purchase.<br>• Play's real-money gaming prohibition applies if the payback has real-world value.<br>• GST at 40% if treated as online money gaming.<br>• State gambling laws. | Is a paid gift with a random payback an "online game" or "online money game", or a lottery or gambling under State law? Would any variant avoid the combination of stake, chance and enrichment (for example a fixed payback, or cosmetic-only rewards)? | [S1][S3][S11][S28][S31][R1] |
| 4 | **Leaderboards with rewards** paid in diamonds | **Medium; depends on design.**<br>• **High** if ranking is driven by spending and prizes are diamonds. The current weekly leaderboard ranks exactly this: recharges, gifts received and lucky-gift spend. It has no prizes today; prize tiers are planned in the CRM.<br>• **Low** if prizes are cosmetic or non-transferable, or if ranking is based on unpaid activity. | • Play's "gamified loyalty" rules. Game apps may not multiply rewards by chance or game performance. Non-game apps need published rules, odds or selection method, and a fixed number of winners.<br>• Law-firm commentary says "loyalty-based leaderboards" need re-evaluation. | Is a spend-ranked leaderboard with diamond prizes "paying fees … in expectation of winning … other enrichment"? Is ZIPPER a "game" or a "non-game" app for Play's loyalty rules? | [S1][S3][S28][S50][R4] |
| 5 | **Aviator / Crash** (stake diamonds; a multiplier climbs until a random crash) | **Very high.** Purchased diamonds are staked on a chance outcome for more diamonds that can be used outside the game. On a plausible reading this matches s.2(1)(g) and (j) and Rule 9(a)–(e). State laws are also squarely aimed at chance-based staking. | • Play's real-money gaming ban; India is not an allowed country.<br>• Payment facilitation barred (s.7); advertising barred (s.6); blocking (s.14).<br>• GST at 40%; TDS on net winnings. | Could any configuration fall outside s.2(1)(g)? For example: game-only tokens that cannot be bought or transferred, have no use outside the game, and win nothing of value. Or should chance-staking formats be dropped entirely? | [S1][S3][S11][S24][S28][S30] |
| 6 | **Slots** | **Very high**, for the same reasons as row 5. Outcomes are random reel results on a diamond stake. | As row 5. Play's ads policy also names "virtual slot machines" as simulated gambling. | As row 5. | [S1][S3][S28] |
| 7 | **Teen Patti** (card game played for diamond stakes) | **Very high.** PROGA makes skill irrelevant. Separately, the Supreme Court has held that States may prohibit betting even on games of skill. | As row 5. The State laws reviewed give no statutory skill protection to card formats. TN's law lists rummy and poker, and Telangana's says rummy is "not a skill game". | As row 5. Also: which State laws would apply even if PROGA were struck down? | [S1][S24][S59] |
| 8 | **Chicken Road** (step-and-cash-out multiplier on a stake) | **Very high**, as row 5. | As row 5. | As row 5. | [S1][S3] |
| 9 | **Plinko** (random multiplier slots on a stake) | **Very high**, as row 5. | As row 5. | As row 5. | [S1][S3] |
| 10 | **Fishing** (assuming each shot costs diamonds and catches pay random multipliers) | **Very high**, as row 5, if that is the mechanic. | As row 5. | Confirm the actual cost and payout mechanic, then apply row 5. | [S1][S3] |
| 11 | **Ludo with entry fee** (each player pays 100; the winner gets 150; the platform keeps 50) | **Very high.**<br>• PROGA makes skill irrelevant, and the entry fees are "fees … in expectation of winning" diamonds.<br>• A pooled pot minus a rake is the structure the Supreme Court described as betting: the prize is linked to the players' stakes. A fixed fee with a predetermined prize is different. | • The e-sport carve-out needs recognition under the National Sports Governance Act, OGAI registration and no stakes. It is not realistic here.<br>• Play's real-money gaming ban.<br>• GST at 40% on entry fees if treated as online money gaming. | Can any entry-fee format survive s.2(1)(g), for example a fixed access fee, prizes not linked to fees, or non-monetary rewards? Does the *Junglee* "entry fee versus stake" distinction matter under PROGA at all? | [S1][S3][S24][S41][S28] |
| 12 | **Carrom with entry fee** (assuming the same pooled structure) | **Very high**, as row 11. | As row 11. | As row 11. Confirm the actual fee and prize structure for Carrom. | [S1][S3][S24] |
| 13 | **Free-to-play games** (no stake; no purchase affects the outcome) | **Low.** These fit "online social game": no staking, and access may be free or for a subscription or access fee that is not a stake. | • Must not award diamond prizes of real value, or sell boosts that work as stakes.<br>• If casino-themed: rate the app correctly and never target children. Play's Families policy bans real or simulated gambling in apps for children.<br>• OGAI can require determination or registration if the Government notifies a category. | If free games award diamonds as prizes with no entry fee, is there a prize-competition or promotion issue? Do casino-themed free games risk being seen as "social casino" by OGAI or Play? | [S1][S3][S28][S37] |
| 14 | **Private-room subscription, ₹200/month** | **Low.** Not an online game. s.2(1)(i)(ii) itself contemplates subscription fees for social games. | **Medium if billed outside Play.**<br>• Play Billing is required for subscriptions, or India alternative billing.<br>• Play's subscription disclosure and cancellation rules.<br>• CCPA dark-patterns guidelines ("subscription trap", "drip pricing").<br>• GST.<br>• The repository notes that "no subscription billing integration exists". | Will the subscription be sold through Play Billing or alternative billing? Does live 1:1 or small-group video in private rooms create extra content or age duties? | [S1][S18][S31][S34][R5] |
| 15 | **Coin-seller resale**: in-app "Verified resellers" list with UPI ID, QR and `binance`/`bank`/`international` methods; user taps "I have paid" and staff credit diamonds | **High if games exist.** Diamonds bought from resellers are "purchased … by indirect means" (s.2(1)(j)). Resellers, and possibly ZIPPER, could be "facilitating … authorisation of funds towards payment for" an online money gaming service (s.7). | **High under Play.**<br>• Play bans in-app steering to payment methods other than Play Billing unless an approved programme applies. India alternative billing needs PCI-DSS certification and transaction reporting within 24 hours.<br>• KYC/AML, mule-account, and crypto/FEMA exposure.<br>• GST on reseller margins. | Can a reseller model coexist with Play distribution? Who is the GST "supplier" of diamonds? Should the Binance and international options be paused pending advice on virtual-digital-asset and FEMA rules? | [S1][S31][S32][S33][R1][R3] |
| 16 | **Host face verification** (live capture compared with a photo the agency uploads; AI vendor not yet chosen) | Not a gaming issue. | **Medium.**<br>• **SPDI Rules 2011 apply now.** "Facial patterns" are biometrics. They require prior written consent, purpose limitation, retention no longer than needed, ISO 27001-type security, transfers only to recipients with equal protection, and a grievance officer.<br>• **DPDP Act and Rules from 12/13 May 2027:** notice, security safeguards, breach notification, erasure, children.<br>• DPDP penalties go up to ₹250 crore for security failures. | (1) What lawful basis and consent wording apply to biometric capture? (2) What is the agency's role: who collects the data, and who is fiduciary or processor? (3) Where is the vendor located (AWS/Azure regions), and on what transfer terms? (4) How long is data kept after verification? | [S13][S14][S15][S16][S57][R2] |
| 17 | **Beans → cash withdrawal** (verified hosts) **and beans → diamonds** (anyone who receives gifts, 20:1). This cuts across all features. | **High, as an aggravating factor.** This is the bridge that makes diamonds indirectly convertible to cash. It undermines "winnings cannot be cashed out" for every game. | • AML/KYC on payouts.<br>• PPI analysis.<br>• Tax. | Does indirect convertibility via gifts and hosts make diamonds "other stakes" and game winnings "monetary … enrichment"? What controls would counsel require (for example, game-won diamonds cannot be gifted; a separate ledger)? | [S1][S3][R1][R2] |

---

## 3. PROGA and the 2026 Rules

### 3.1 Status timeline

| Date | Event | Source |
|---|---|---|
| 21 Aug 2025 | Parliament passes the Bill | [S23] |
| 22 Aug 2025 | Presidential assent; published as Act No. 32 of 2025 | [S1] |
| 28 Aug 2025 | Corrigenda published (for example, s.6 now ends "online money game", not "gaming") | [S1] |
| 8 Sep 2025 | Supreme Court allows the Union's transfer petitions. Challenges pending in the Karnataka, Delhi and MP High Courts move to the Supreme Court. | [S23][S27] |
| 2 Oct 2025 | MeitY publishes draft PROG Rules, 2025 for comment, with comments due by 31 Oct 2025 | [S6][S7] |
| 11 Dec 2025 | CJI Surya Kant signals a three-judge bench and a January listing. No early relief is given. | [S46] |
| 22 Apr 2026 | S.O. 1994(E) appoints 1 May 2026 as the commencement date. The Rules are notified as G.S.R. 303(E) (Gazette CG-DL-E-22042026-271974). OGAI is constituted. | [S2][S3][S4][S47] |
| 1 May 2026 | The Act and the Rules come into force | [S2][S3] |
| 27 May 2026 | Supreme Court decides *Junglee* (2026 INSC 594) and *Gameskraft* (2026 INSC 595) | [S24][S25][S42] |
| Jun 2026 | OGAI publishes its application form for determination and registration | [S8] |
| 29 Jul 2026 | Advisory issued through OGAI to app stores, cloud providers, banks, ad agencies, OTT platforms and others (secondary sources) | [S48][S49] |
| 5 Aug 2026 | Supreme Court agrees to a final hearing, asks parties to complete pleadings, and agrees to hear the CASC PIL | [S45] |
| 1 Sep 2026 | MeitY tells the CIC that no game is registered with OGAI and 201 complaints have been received | [S47] |
| 6–7 Oct 2026 | Final-hearing dates reported by ET, as cited by MediaNama. **Unverified.** | [S43] |
| 15 Oct 2026 | *Junglee* review petitions dismissed without an oral hearing | [S43][S44][S26] |

### 3.2 Definitions (s.2(1), verbatim from the India Code text) [S1]

- **(f) "online game"**: "any game, which is played on an electronic or a digital device and is managed and operated as a software through the internet or any other kind of technology facilitating electronic communication".
- **(g) "online money game"**: "an online game, irrespective of whether such game is based on skill, chance, or both, played by a user by paying fees, depositing money or other stakes in expectation of winning which entails **monetary and other enrichment** in return of money or other stakes; but shall not include any e-sports".
- **(h) "online money gaming service"**: "a service offered by a person for entering or playing the online money game".
- **(i) "online social game"** is an online game which:
  - "(i) does not involve staking of money or other stakes or participation with the expectation of winning by way of monetary gain in return of money or other stakes;
  - (ii) may allow access through payment of a subscription fee or one-time access fee, provided that such payment is not in the nature of a stake or wager;
  - (iii) is offered solely for entertainment, recreation or skill-development purposes; and
  - (iv) is not an online money game or e-sport".
- **(j) "other stakes"**: "anything recognised as equivalent or convertible to money and includes credits, coins, token or objects or any other similar thing, by whatever name called and whether it is real or virtual, which is purchased by paying money directly or by indirect means or as part of, or in relation to, an online game".
- **(c) "e-sport"**, in summary, is an online game which:
  - is played as part of multi-sports events;
  - involves organised multiplayer competition;
  - is "duly recognised under the National Sports Governance Act, 2025 … and registered";
  - has an outcome "determined solely by" skill;
  - may charge registration or participation fees "solely" for entry or administrative costs and may pay "performance-based prize money";
  - "shall not involve the placing of bets, wagers or any other stakes by any person".
- **"Monetary and other enrichment"** is not defined. The Act says "monetary **and** other enrichment" in s.2(1)(g). Rule 9(b) says "monetary **or** other enrichment" [S3]. OGAI's form lists the "Nature of expected winnings/enrichment" as "Money / Monetary equivalent / In-game assets / Goods / Services / Other" [S8]. Whether the Act's wording is conjunctive or disjunctive is a central question for counsel (see §4.1).
- Words defined in the IT Act, 2000 and not defined in PROGA take their IT Act meaning (s.2(2)) [S1].

### 3.3 Prohibitions, penalties and enforcement powers [S1]

**Section 5 (offering).** "No person shall offer, aid, abet, induce or otherwise indulge or engage in the offering of online money game and online money gaming service."

**Section 6 (advertising).** No person shall make, or be involved in, "any advertisement, in any media including electronic means of communication, which directly or indirectly promotes or induces any person to play any online money game or indulge in any activity promoting online money game". "Advertisement" takes its meaning from the Consumer Protection Act, 2019 (s.2(1)(a)).

**Section 7 (payments).** "No bank, financial institution, or any other person facilitating financial transactions or authorisation of funds shall engage in, permit, aid, abet, induce or otherwise facilitate any transaction or authorisation of funds towards payment for any online money gaming service."

| Provision | Penalty (as enacted) |
|---|---|
| s.9(1): offering in breach of s.5 | Imprisonment up to 3 years, or fine up to ₹1 crore, or both |
| s.9(2): advertising in breach of s.6 | Up to 2 years, or up to ₹50 lakh, or both |
| s.9(3): transactions in breach of s.7 | Up to 3 years, or up to ₹1 crore, or both |
| s.9(4): repeat offence under (1) or (3) | 3 to 5 years **and** a fine of ₹1 crore to ₹2 crore |
| s.9(5): repeat offence under (2) | 2 to 3 years **and** a fine of ₹50 lakh to ₹1 crore |
| s.10 | Offences under ss.5 and 7 are **cognizable and non-bailable** |
| s.11 | Offences by companies: the company and the persons in charge are liable. Persons can defend themselves by proving lack of knowledge or due diligence. Directors are liable for consent, connivance or neglect. Independent or non-executive directors not involved in decision-making are excluded. |
| s.12 | Failure to follow directions under s.8(3): penalty up to ₹10 lakh, and/or suspension or cancellation of registration, and/or a prohibition on offering, after a hearing |
| s.14 | Blocking of online-money-gaming information under the IT Act s.69A procedure |
| s.15 / s.16 | Authorised officers may investigate, and may search and **arrest without warrant**. "Any place" includes "virtual digital space", and officers may override access controls. |
| s.18 | The Act is "in addition to, and not in derogation of" other laws, and overrides them where they conflict |
| s.1(2) | The Act applies to online money gaming services "offered within the territory of India or operated from outside" |

PIB's backgrounder says State and UT cyber-cell officers, at police-station, district and commissionerate levels, are empowered to investigate [S5].

### 3.4 The Authority (OGAI) and the 2026 Rules [S3][S4][S5]

- **Constitution (Part II, rules 3–7).** OGAI is an attached office of MeitY, based in Delhi, and works as a "digital office". Its chair is the Additional Secretary, MeitY. Its members are Joint Secretaries from MHA, the Department of Financial Services, MIB, Youth Affairs & Sports, and Legal Affairs.
- **Functions (rule 6).** OGAI:
  - keeps and publishes a **list of online money games** (rule 26);
  - inquires into complaints;
  - issues directions to anyone "offering, organising or facilitating any online game", including on advertisements and financial transactions;
  - may issue codes for social games and e-sports covering user verification, deposits and payment routing, data retention, fair play, cybersecurity and user safety.
- **Appeals (rule 7).** Appeals against OGAI decisions go to the **Secretary, MeitY** within 30 days.
- **When determination happens (rule 8).** A game is determined only if:
  - OGAI directs it suo motu;
  - the provider wants to offer it as an e-sport; or
  - the Government notifies a category of online social games.

  OGAI's June 2026 form says: "Only e-sport is required to be determined. However, you may voluntarily apply for determination of any online game" [S8].
- **Rule 9 factors (verbatim).** OGAI "shall have due regard to all or any of" the following:
  - "(a) whether the online game involves payment of fees, deposit of money or other stakes, by whatever name called, at any stage of participation in the online game;
  - (b) whether users have an expectation of winning monetary or other enrichment in return for such money or other stakes deposited by them;
  - (c) whether the payment of fees or deposits is used, (i) [as entry fees or administrative costs for a competitive multiplayer event, or for performance-based prize money]; (ii) in all other cases, as payment for accessing the online game as subscription fee or one-time access fee; or (iii) as a bet, wager or any other stake in expectation of winning monetary or other stakes, including any winning out of such bets, wagers or any other stakes;
  - (d) the structure and operation of the revenue model of the online game;
  - (e) the manner in which rewards, benefits or in-game assets may be transferred, redeemed, monetised or used outside the game environment."
- **Procedure (rules 10–11).**
  - OGAI may examine "technical architecture, gameplay mechanics, revenue model, user interface", and should decide within about 90 days.
  - A determination applies only to that game and that provider.
  - A provider whose game is cleared as a social game must tell OGAI about changes to payment facilitation before rolling them out.
  - A determination lasts until such changes are made.
- **Registration (rules 12–15).**
  - Registration is required only when the Government notifies a game or category, or when a game is offered as an e-sport. The notification factors include risk to children, scale, financial transactions and **country of origin**.
  - An online money game cannot be registered as an e-sport.
  - Certificates last up to 10 years.
  - Providers must not present a game as determined or registered unless it is.
- **Other duties for social-game and e-sport providers (rules 16–20).**
  - nominate a point of contact (rule 16);
  - retain data on computer resources in India as directed (rule 17);
  - follow payment directions (rule 18);
  - run a grievance mechanism; users can escalate to OGAI within 30 days, and then to the Appellate Authority (rule 20).
- **Banks (rule 19).** Banks must verify a determination order or registration certificate as directed before facilitating payments, and must act at once on OGAI directions about determined online money games.
- **Penalties (rules 21–22).** Rule 21 sets the inquiry procedure for s.12 penalties, to be concluded within 90 days. Penalties are credited to the Consolidated Fund (rule 22).
- **Application contents (rule 23).** Applications must cover the revenue model, user safety features, target age groups and the grievance mechanism.
- **User safety features (rule 2(1)(i)).** These include "age verification or age gating mechanisms, time restrictions, parental controls, user reporting and grievance redressal mechanisms, counselling support, and fair-play and integrity monitoring tools". Khaitan reads the Rules as not imposing these as a general duty on every game; they must be described when applying [S50].
- **Notifications found.** I found **no Government notification** requiring social-game categories to be determined or registered as of 3 Nov 2026. This is unverified: it rests on not finding one, and on OGAI's own form [S8].

### 3.5 Court challenges (status as of 3 Nov 2026)

- **The PROGA challenge** is *Head Digital Works v Union of India*, T.C.(C) No. 133/2025.
  - The petitioners include Head Digital Works (A23), Clubboom 11, Bagheera Carrom OPC, K.A. Paul and others.
  - The issues are: Article 19(1)(g); Article 14 (removing the skill/chance distinction); State competence under Entry 34, List II; Article 21; and excessive delegation.
  - The bench is CJI Surya Kant with Bagchi and Pancholi JJ. SCO's page, last updated 2 Jul 2026, showed the next hearing as 5 Aug 2026 [S23].
  - On 5 Aug 2026 the Court agreed to a final hearing and asked parties to complete pleadings [S45]. MediaNama, citing ET, reported final-hearing dates of 6–7 Oct 2026 but could not verify them [S43].
  - **No judgment and no stay found.** The Act has been in force since 1 May 2026 [S2].
- **The CASC PIL** (Centre for Accountability and Systemic Change) seeks directions against betting and gambling apps "operating under the guise of social and e-sports games". Counsel said about 2,000 such apps had been listed. The Court will hear it alongside the PROGA petitions [S45]. **This matters for ZIPPER**, because a social app with stake-based games is exactly the format the PIL targets.
- ***State of Tamil Nadu v Junglee Games*** (2026 INSC 594, 27 May 2026, Pardiwala and Mahadevan JJ) [S24][S41]:
  - The Court set aside the Madras HC (2021, 2023) and Karnataka HC (2022) rulings.
  - It held that "betting" under Entry 34 covers games of skill played for stakes: "it is not correct to say that even 'betting' on games of skill would be out of the competence of the State Legislature" [S41].
  - It treated betting and gambling as *res extra commercium*, so no Article 19(1)(g) right arises [S41][S43].
  - SCO's analysis says the Court contrasted a fixed entry fee with a predetermined prize against a prize pool built from players' contributions, which "cannot" escape being characterised as betting [S41].
  - Review petitions were dismissed on 15 Oct 2026 (R.P.(C) No. 10491/2026, as reported) [S43][S44].
  - Secondary sources say the practical effect is that the Tamil Nadu and Karnataka bans on online games played for stakes stand [S43][S44].
- ***DGGI v Gameskraft*** (2026 INSC 595; the Supreme Court's file name is dated 27 May 2026) [S25][S42]:
  - GST is validly levied on actionable claims in betting and gambling, including pooled-stake online formats.
  - The taxable value is the **entire stake**.
  - The 2023 amendments are clarificatory and apply retrospectively.
  - Platforms are suppliers, not intermediaries.
  - SCO reads the case as holding that the skill/chance distinction matters only where a legislature has chosen to protect skill games [S41].

### 3.6 Enforcement signals since commencement

- **The 29 Jul 2026 advisory** (reported). It was addressed to OTT platforms, ad agencies, social media intermediaries, **app stores, cloud service providers**, telecom operators, ISPs, banks and financial institutions. It told them to disable access to online money gaming apps, stop hosting them, block related transactions, stop carrying ads that directly or indirectly promote them, and put compliance systems in place. It warned of blocking under s.14 and prosecution under s.9 [S48][S49]. I did not see the advisory itself; this is secondary.
- **Blocking.** About 8,400 betting and gambling URLs had been blocked in total, more than 4,800 of them after the Act passed, according to figures the ministry gave Parliament on 1 Apr 2026. This is trade press, citing ThePrint, and is unverified at primary level [S49].
- **Registrations.** None as of 1 Sep 2026 [S47]. MeitY also told the CIC that the online-gaming provisions of the IT Rules "remained unenforceable" [S47].

---

## 4. How the definitions might apply to ZIPPER

This section sets out plausible readings and the questions counsel must decide. It does not reach conclusions.

### 4.0 Facts that drive the analysis

These come from the brief and from the repository on 3 Nov 2026.

- **How diamonds are bought.** Users buy diamonds with money. The in-app Recharge path shows "Verified resellers" with their UPI IDs and QR codes. The modelled payment methods are `upi | qr | binance | bank | international`. The user taps "I have paid", which "files a recharge request for staff to verify" [R3].
- **No billing integration found.** I found no Google Play Billing or payment-SDK integration in the Android sources (text search). A design-state file notes "no subscription billing integration exists" [R5].
- **Beans and diamonds.** These figures come from an internal decision record of 10 Sep 2026 [R1]:
  - Gift receivers are credited a share of the gift's diamond cost as beans, for example 50%.
  - Verified hosts can **withdraw** beans at 100 beans = ₹1. Unverified hosts' earnings are held until verification [R2].
  - **Anyone who receives gifts** can **convert** beans to diamonds at 20:1.
- **Planned games.** Games are planned, gated by level, with a third-party provider-callback design and a bet-settlement function. The note records that Indian gaming counsel must review them before launch [R1].
- **Lucky gifts.** The app code has multipliers up to 200×, against 20× in config, and the RNG runs on the phone [R1].
- **Leaderboards.** Today's weekly leaderboards rank "Recharges, gifts received, lucky-gift spend" and award **no prizes** [R4]. The CRM roadmap lists "prize tiers" and "reward tables" [R4].

The value chain, in short:

> **₹** → diamonds (reseller UPI/QR/Binance, or Play Billing if added) → staked in a game → diamonds won → spent on host calls or gifts → host **beans** → **₹ withdrawal** (verified host), or beans → diamonds (any recipient).

The last two steps are what make "winnings stay inside the app" questionable as a factual premise.

### 4.1 (a) Purchased virtual currency is staked; winnings cannot be withdrawn but can buy services with real-money value

**Reading A (broad): the game is an online money game.**
- Diamonds are "credits, coins, token … virtual … purchased by paying money directly or by indirect means" (s.2(1)(j)). Buying from a reseller is "indirect means" [S1].
- Rule 9(c)(iii) expressly covers a stake "in expectation of winning monetary **or other stakes**, including any winning out of such bets". Winning more diamonds is winning "other stakes" [S3].
- Rule 9(e) looks at whether rewards or in-game assets can be "used outside the game environment". ZIPPER's diamonds buy host calls and gifts, and gifts turn into withdrawable host beans [S3][R1][R2].
- OGAI's form treats "In-game assets" and "Services" as forms of "enrichment", and "Virtual Currency, Anything equivalent or convertible to money" as a means of payment [S8].
- The Supreme Court's 2026 rulings focus on money, or money's worth, staked on an uncertain outcome, whatever the skill involved. Those rulings are in the State-competence and GST contexts [S41][S42].
- Commentary agrees:
  - Nishith Desai's Aaron Kamath says tokens that "cannot be cashed out but can be used to play other games or purchase items otherwise available for real money may still constitute 'other stakes'" [S53].
  - Trilegal says the ban "may possibly also extend … to cover … certain types of in-game purchases, and loot boxes" [S52].
  - Khaitan advises re-evaluating "mini games, gamified contests, loyalty-based leaderboards" [S50].

**Reading B (narrow): the game is not an online money game.**
- s.2(1)(j) opens with "anything recognised as equivalent or convertible to money". One could argue that diamonds which a player cannot redeem for cash are not "convertible to money" [S1].
- s.2(1)(g) requires "monetary **and** other enrichment". One could argue this needs some monetary gain, and that more diamonds alone are not enough [S1].

**Weaknesses of Reading B on ZIPPER's facts.**
- Diamonds have a fixed rupee price, which arguably makes them "recognised as equivalent" to money.
- They can be used outside the game.
- They become indirectly cash-convertible through gifts to hosts who withdraw [R1][R2].
- Rule 9(b) and the OGAI form use "or" [S3][S8].

**Two consequences either way.**
- Even if a game is *not* an online money game, staking "other stakes" probably stops it from being an "online social game" (s.2(1)(i)(i)) [S1]. That leaves a residual, untested category. OGAI can pick any game for suo motu determination (rule 8(1)(a)) [S3].
- Tax law may treat the same activity as "online money gaming" independently. The CGST definition covers "money or money's worth, including virtual digital assets", "whether the same is permissible or otherwise" [S10].

**For counsel to decide:** which reading applies; whether keeping game-won diamonds out of the gift and call economy (a separate ledger, no gifting) changes the outcome; and whether to seek a voluntary OGAI determination [S8].

**Risk: Very high** for the games as described.

### 4.2 (b) Skill games with entry fees versus chance games

- **Skill does not help under PROGA.** The definition applies "irrespective of whether such game is based on skill, chance, or both" [S1].
- **The e-sport route** needs all of the following: recognition under the National Sports Governance Act, 2025; OGAI registration; organised multi-sport events; outcome "solely" by skill; and no stakes "by any person" [S1][S3][S8]. A two-player diamond Ludo table does not obviously fit.
- **Entry fee versus stake.**
  - Under *Junglee*, SCO reports that the Court contrasted a fixed fee with a predetermined prize against a pot built from players' stakes [S41].
  - ZIPPER's Ludo and Carrom pay the winner out of the pooled entries (150 of 200), with a 50 rake. That is the pooled-stake pattern.
  - Whether the fixed-fee/fixed-prize distinction has any role under PROGA, rather than under State law, is a question for counsel.
- **Chance games** (Aviator/Crash, Slots, Teen Patti, Chicken Road, Plinko, Fishing) are caught by PROGA in the same way. They are also the core target of State gaming laws. After *Junglee*, State law can also reach betting on skill games [S24].
- **Risk: Very high for both kinds.** Even if PROGA were struck down for want of Union competence, State laws would remain (see §5.2).

### 4.3 (c) Free-to-play games with no stake

- These fit "online social game": no staking, and offered for entertainment. A subscription or one-time access fee is allowed if it is "not in the nature of a stake or wager" [S1].
- Rule 9(c)(ii) treats access fees as a separate category from stakes [S3].
- OGAI could still require determination or registration if the Government notifies a category (rules 8 and 12) [S3].

**Conditions that keep the risk low** (questions for counsel, not advice):
- no diamond prizes of real value;
- no paid boosts or "continues" that work as stakes;
- no conversion of in-game results into diamonds;
- if casino-themed, do not target children. Play's Families policy treats "real or simulated gambling" as a violation [S37].

**Risk: Low.**

### 4.4 (d) "Lucky gifts" and other random rewards bought with currency

- **Lucky gifts.** The sender pays diamonds and gets a random diamond payback, with multipliers up to 200× in the code [R1]. This contains:
  - a purchased stake (s.2(1)(j));
  - a chance outcome;
  - an expectation of "winning … other stakes" (Rule 9(c)(iii));
  - use outside any game (Rule 9(e)) [S1][S3].

  A threshold question is whether a gift mechanic is an "online game" at all; s.2(1)(f) says "any game".
- **Loot boxes.** Trilegal flags them as possibly caught [S52]. Play requires odds disclosure "in advance of, and in close and timely proximity to, that purchase" [S31]. If the reward has real-world value, Play's real-money gaming rule applies [S28].
- **Risk.**
  - **Very high** for lucky gifts as configured.
  - **High** for any paid random reward that returns diamonds or other transferable value.
  - **Low to Medium** for paid random *cosmetic* items with no transfer or resale value. Odds disclosure still applies.

### 4.5 (e) Leaderboard rewards paid in virtual currency

- **If ranking depends on spending** (recharges, gifts, lucky-gift spend) and the top ranks win diamonds, users are paying money with an expectation of winning enrichment that depends on others' spending, which is uncertain. That fits s.2(1)(g) and Rule 9(a)–(b) [S1][S3]. Khaitan flags "loyalty-based leaderboards" [S50].
- **If prizes are cosmetic** (badges, frames) and cannot be transferred, or ranking is on non-monetary activity, the stake and enrichment elements are weaker.
- **Play's "Gamified Loyalty Programs" rules** [S28]:
  - **Game apps:** rewards must be earned and redeemed "on a fixed ratio basis" and "may **not** be wagered, awarded or exponentiated by game performance or chance-based outcomes".
  - **Non-game apps:** chance-based loyalty is allowed with published rules, disclosed odds or selection method, and a fixed number of winners and deadlines.
  - ZIPPER's Play category, game or non-game, therefore matters.
- **Risk: Medium; depends on design.** Spend-ranked leaderboards with diamond prizes are **High**.

### 4.6 Non-game features (calls, gifts, subscription)

PROGA prohibits only online money games, so these features are not caught directly. Two links remain:
- they are the channel through which game winnings acquire real-money value (§4.1); and
- OGAI's s.8(3) directions can reach anyone "offering, organising or facilitating any online game" once games exist [S1][S3].

Their main exposures are covered in §§5–6: Play Billing and content rules, the PPI question, consumer protection, tax, and IT Rules due diligence.

---

## 5. Other Indian rules

### 5.1 IT Rules 2021: online-gaming amendments (April 2023). Superseded?

- **Still in the text.** MeitY's consolidated IT Rules ("updated as on 10.02.2026") still contain the 2023 provisions:
  - "online real money game" is defined as one where "a user makes a deposit in cash or kind with the expectation of earning winnings", with "winnings" meaning any prize "in cash or kind";
  - "permissible online real money game" means one verified by a self-regulatory body under rule 4A;
  - intermediaries must make reasonable efforts not to host "an online game that is not verified as a permissible online game" (rule 3(1)(b)(ix)) or advertise one (3(1)(b)(x)) [S9].
- **Never operational.** No self-regulatory body was ever designated. In 2026 MeitY told the CIC that the IT Rules' online-gaming provisions "remained unenforceable" [S47]. Khaitan describes PROGA as having replaced, to the extent of any conflict, the 2023 regime that relied on self-regulatory bodies [S50]. PROGA s.18 gives PROGA overriding effect where they conflict [S1].
- **Status.** Superseded in practice for real-money games. **I found no gazette notification formally removing rules 4A–4C. Unverified.**
- **Still relevant to ZIPPER.** The general due-diligence duties of intermediaries still apply to user content in live and party rooms, chats and calls. Rule 3(1)(b)(ii) covers content that is "obscene, pornographic … or encouraging money laundering or gambling" [S9]. The consolidated text was amended again on 10 Feb 2026; commentary says this concerns synthetically generated content. That amendment is not analysed here [S9].

### 5.2 State gambling laws (relevant examples)

- **Combined effect.** PROGA operates "in addition to, and not in derogation of" other laws (s.18) [S1]. State law therefore adds to PROGA, and would remain if PROGA fell.
- **Tamil Nadu.**
  - The Tamil Nadu Prohibition of Online Gambling and Regulation of Online Games Act, 2022 (Act 9 of 2023) and the 2021 amendment to the Tamil Nadu Gaming Act, 1930 were the subject of *Junglee*. The Supreme Court set aside the Madras HC rulings, including the 2023 ruling that had struck down the Schedule listing rummy and poker [S24].
  - Separately, the Madras HC on 3 Jun 2025 reportedly upheld the TN Online Gaming Authority (Real Money Games) Regulations, 2025: a night-time block on play and Aadhaar-based KYC (secondary) [S58].
- **Karnataka.** The Karnataka Police (Amendment) Act, 2021 banned online games involving betting, including skill games. The HC struck it down in 2022. The Supreme Court set that judgment aside on 27 May 2026 [S24][S41]. Reports mention a 2025 Karnataka proposal for a gaming and betting regulator; its status is **unverified**.
- **Telangana.** The 2017 amendments to the Telangana State Gaming Act, 1974:
  - brought online gaming within the Act;
  - widened "instruments of gaming" to include digital records;
  - added explanations that a game depending partly on chance is not a skill game and "Rummy is not a skill game" (Khaitan, 2017) [S59].

  The current status of the High Court challenges is **unverified**.
- **Andhra Pradesh.** The AP Gaming (Amendment) Ordinance/Act, 2020 prohibits real-money online gaming (secondary) [S60]. Litigation status **unverified**.
- **Statutory text not reviewed.** I did not review the exact current State definitions, for example whether "stakes" includes "money's worth" or virtual currency. That is **unverified**, and counsel should check each State where ZIPPER has users.
- **Organised-crime overlay.** Bharatiya Nyaya Sanhita s.112 ("petty organised crime") includes "unauthorised betting or gambling" committed by a member of a group or gang. The punishment is one to seven years and a fine. This is from a PIB explainer seen at search-extract level [S22].

### 5.3 GST

- **Definitions from 1 Oct 2023.** The CGST (Amendment) Act, 2023 (No. 30 of 2023) added these definitions [S10]:
  - "online gaming";
  - "online money gaming": players "pay or deposit money or money's worth, including virtual digital assets, in the expectation of winning money or money's worth … whether or not its outcome … is based on skill, chance or both and **whether the same is permissible or otherwise under any other law**";
  - "specified actionable claim".

  It also deemed platform operators to be the suppliers, and required offshore suppliers of online money gaming to register (s.24(xia)).
- **Rate.**
  - 28% on the full deposit value from 1 Oct 2023, with valuation under Rule 31B on the "total amount paid, payable or deposited" (secondary) [S54].
  - The **56th GST Council** (3 Sep 2025) moved all "specified actionable claims including betting, casinos, gambling, horse racing, lottery and online money gaming" to **40% from 22 Sep 2025** [S11]. TaxGuru gives the notification as 9/2025-CT(Rate) of 17 Sep 2025 (secondary) [S54].
- **Validity.** *Gameskraft* (27 May 2026) upheld the levy on the full stake, with retrospective effect for the 2023 amendments [S25][S42].
- **57th GST Council (8 Oct 2026).** Trilegal's summary shows procedural reforms and no change to gaming rates. Not checked against the official release [S55].
- **For ZIPPER (CA questions):**
  1. Could diamond purchases or deposits used for games be valued as consideration for online money gaming at 40% on the full amount, even though the activity is prohibited?
  2. What is the rate and supply classification for ordinary diamond, gift and subscription sales? Secondary sources commonly cite 18% for digital services. **Unverified** for ZIPPER's exact supplies.
  3. Who is the supplier in reseller sales?

### 5.4 Income tax and TDS on winnings

- **1961 Act.** Under s.115BBJ, net winnings from online games are taxed at 30% "irrespective of whether it is a game of skill or chance". Under s.194BA, TDS of 30% is deducted on net winnings at withdrawal or at the end of the year. Net winnings are computed under Rule 133. Where winnings are paid **in kind** or outside the gaming account, "an equivalent money value is assumed" [S12].
- **From 1 Apr 2026.** The Income-tax Act, 2025 applies. Secondary sources map s.194BA to **s.393** of the 2025 Act. The exact sub-item is **unverified** [S56].
- **Relevance (CA question).** If any game paid "winnings" in diamonds with money value, would TDS on net winnings apply even though the winnings cannot be withdrawn? This matters only if counsel concludes the games can lawfully exist. Host payouts raise separate TDS questions, which are not researched here.

### 5.5 Consumer protection and advertising

- **PROGA s.6.** It bans ads that "directly or indirectly" promote online money games. "Advertisement" takes its Consumer Protection Act meaning [S1]. The 29 Jul 2026 advisory reportedly targeted ad agencies, social media and OTT platforms [S48]. In-app banners, influencer content and referral campaigns for staking games would therefore be in scope. This is an interpretive point for counsel.
- **CCPA Misleading Advertisements Guidelines, 2022** (notified June 2022). They define bait, surrogate and "free claim" ads and set disclaimer rules. Penalties go up to ₹10 lakh, or ₹50 lakh for repeat breaches, and endorsers can be barred [S17].
- **CCPA Dark Patterns Guidelines, 2023.** These list 13 patterns, including "Subscription trap", "Drip Pricing", "False urgency", "Basket Sneaking" and "Confirm shaming" [S18]. They are relevant to the ₹200/month subscription, recharge flows and gift-conversion screens. The CCPA's guidelines page also lists a self-audit advisory to e-commerce platforms dated 05.06.2025 (search-extract level) [S21].
- **ASCI (Dec 2020).** ASCI's real-money gaming ad guidelines required the disclaimer "This game involves an element of financial risk and may be addictive…". This is secondary [S61]. Ads for online money games are now banned outright, so ASCI disclaimers cannot make such ads lawful.

### 5.6 DPDP Act 2023, DPDP Rules 2025, and SPDI Rules 2011 (host face verification)

- **DPDP Rules 2025.** Notified as G.S.R. 846(E) dated 13 Nov 2025 (PIB says notified 14 Nov) [S13][S14]. Commencement under rule 1 [S13]:
  - rules 1, 2 and 17–21 on publication;
  - **rule 4 (consent managers) one year later**;
  - **rules 3, 5–16, 22 and 23 eighteen months later**. These cover notice, security safeguards, breach intimation, retention and erasure, verifiable parental consent, and cross-border transfer.
- **DPDP Act sections** commence in the same three stages. Sections 3–17 and most others start after 18 months. AZB gives the dates as 12 Nov 2026 and 12 May 2027; other sources say the 13th, so **counsel to confirm** [S57].
- **Penalties (PIB).** Up to ₹250 crore for failing to keep reasonable security safeguards; up to ₹200 crore for failing to notify breaches, or for breaches of duties on children's data; up to ₹50 crore for other breaches [S15].
- **Children.** Verifiable consent of a parent or guardian is needed to process children's data [S14][S15].
- **Third Schedule.** It sets retention and erasure periods for named classes, including an online gaming intermediary with at least 50 lakh registered users in India. That entry was read in the Hindi gazette text and should be confirmed in English. ZIPPER is probably below this threshold (unverified) [S13].
- **Today's binding rules for biometrics: SPDI Rules 2011** (G.S.R. 313(E), under IT Act s.43A) [S16]:
  - "Biometrics" include "facial patterns", and "Biometric information" is sensitive personal data (rules 2–3).
  - Consent must be obtained "in writing through letter or Fax or email" before collection, and only for a lawful, necessary purpose (rule 5(1)–(2)).
  - Data must not be kept longer than required (rule 5(4)), and must be used only for the stated purpose (rule 5(5)).
  - Users must be told about collection, purpose and recipients, and can withdraw consent (rule 5(3), 5(7)).
  - A grievance officer must resolve complaints within one month (rule 5(9)).
  - Disclosure needs prior permission (rule 6).
  - Transfers may go only to recipients that ensure the same level of protection (rule 7).
  - Reasonable security practices, for example IS/ISO/IEC 27001 (rule 8).

  The DPDP Act's s.44(2), which amends the IT Act, is in the 18-month batch [S57]. Until then, the SPDI Rules remain the main binding standard (counsel to confirm).
- **ZIPPER's design facts (counsel input).** Agencies upload the host's photo and KYC documents. The host completes a live capture. A comparison vendor (AWS Rekognition, Azure Face, or an on-device model) is still undecided. Failures go to manual CRM review [R2]. Questions: who is the data fiduciary for agency uploads; where vendors process data; how long templates and images are kept; and how deletion works.

### 5.7 RBI and payments

- **PROGA.** Section 7 bars banks, financial institutions and "any other person facilitating financial transactions" from processing payments for online money gaming services [S1]. Rule 19 makes banks verify determination orders or certificates as directed, and act on OGAI directions [S3]. The 29 Jul 2026 advisory reportedly told banks and financial institutions to block related transactions [S48].
- **Payment aggregators.** The RBI's Regulation of Payment Aggregators Directions, 2025 were issued on 15 Sep 2025. Commentators describe mandatory merchant due diligence. I read only secondary summaries; the RBI page redirected [S20]. **No RBI circular specifically implementing PROGA was found** (unverified).
- **Prepaid payment instruments (PPI).** The RBI FAQ (updated 22 Nov 2022) on the 2021 PPI Master Directions says closed-system PPIs "are issued by an entity for facilitating the purchase of goods and services from that entity only. Cash withdrawals are not permitted. **These instruments cannot be used for payment or settlement for third party services.** The issuance … is not classified as a payment system requiring approval / authorisation by RBI" [S19]. Search results also showed a **draft 2026 PPI Master Direction**; its status is unverified.
- **Counsel question.** Diamonds pay for calls with independent hosts, who are paid out in cash. Are diamonds still a closed-system PPI, or would ZIPPER need to be structured as the seller of call time with hosts as its contractors?
- **Reseller rails (flags only, not researched in depth).** Payments go to individuals' UPI IDs and bank accounts, which raises mule-account and AML risk. A `binance` method raises virtual-digital-asset and TDS issues. `international` methods raise FEMA issues [R3].

---

## 6. Google Play policies (as checked on 3 Nov 2026)

### 6.1 Real-money gambling and games in India

- **The general rule.** Play allows gambling apps only from licensed or approved operators in listed countries. Such apps must not use Play In-app Billing, must be rated AO or equivalent, and must block minors and unlicensed locations [S28]. **India is not in the country-allowance list** [S30].
- **Everything else.** "We don't allow content or services that enable or facilitate users' ability to wager, stake, or participate using real money (**including in-app items purchased with money**) to obtain a prize of real world monetary value." One example of a violation is "Apps that accept or manage wagers, **in-app currencies, winnings**, or deposits in order to gamble for, or obtain a physical or monetary prize" [S28].
- **India pilot.** The DFS/rummy pilot ended on 28 Sep 2023. "As of January 22, 2026, the pilot grace period is no longer in effect", and former pilot apps may remain only if they remove real-money functionality [S29].
- **Age restriction.** Apps that facilitate real-money gambling must use Play Console tools to block minors [S35].

### 6.2 "Social casino" and simulated gambling

- **No blanket ban found.** I did not find a blanket Play ban on simulated gambling. Simulated gambling is restricted in several ways:
  - Apps targeting children must not include "real or simulated gambling" [S37].
  - Apps that show gambling ads must not "provide simulated gambling content (for example, social casino apps; apps with virtual slot machines)" [S28].
  - Pay-to-play social casino games that reward NFTs are a violation [S39].
- **The real issue for ZIPPER.** A casino-style game played with purchased currency becomes a real-money issue when its prizes have **real-world value**. ZIPPER's diamonds arguably do: they are sold for rupees, they buy paid human services, and they convert to hosts' cash (§4.0). That points towards §6.1, not towards "social casino".

### 6.3 Purchasable virtual currency with winnings that cannot be cashed out

- **Play Billing.** In-app virtual currency must be sold through Play Billing [S31][S32].
- **Use within the app.** It "must only be used within the app or game title for which they were purchased" (Payments policy, item 5) [S31].
- **Real-world value.** Whether non-cashable winnings are a "prize of real world monetary value" depends on what the currency can buy. ZIPPER's link to paid hosts' services and cash payouts is the risk factor [S28][R1].

### 6.4 Loot boxes and random items

- Apps "offering mechanisms to receive randomized virtual items from a purchase … 'loot boxes' must clearly disclose the odds of receiving those items in advance of, and in close and timely proximity to, that purchase" (Payments policy, item 7) [S31].
- Gamified loyalty rules also apply to leaderboards and rewards: see §4.5 [S28].

### 6.5 Play Billing for diamonds, gifts, calls and the ₹200/month private room

- **What needs Play Billing.** In Play-distributed apps, Play Billing is required for "virtual currencies" and for "subscription services (such as … dating, … video … )" [S31][S32].
- **No steering.** Apps may not lead users to other payment methods through "in-app webviews, buttons, links, messaging … or other calls to action" (Payments policy, item 4), except under the alternative-billing and external-offers programmes [S31][S32].
  - The in-app reseller list, with UPI and QR codes and "I have paid", appears to be exactly this kind of steering [R3].
  - Outside the app, developers may tell users about other ways to buy [S32].
- **India alternative billing.** Developers may offer an alternative billing system alongside Play's. The service fee is 4 percentage points lower. Requirements include PCI-DSS certification, a way to report fraud, and reporting transactions within 24 hours through the APIs [S32][S33]. Whether individual resellers' UPI accounts could ever qualify as an "alternative billing system" is doubtful but unverified; ask counsel and Google.
- **Exemptions that probably do not fit ZIPPER** [S32]:
  - **Tips:** Play Billing is not needed only if "100% of the tip … goes to the creator **and** the payment does not grant access to any digital content … (including stickers, badges, special emojis)". ZIPPER keeps a share, and gifts are digital items.
  - **1:1 online paid services:** exempt if "between two individuals" and not available for replay. ZIPPER's calls are bought with in-app currency. The FAQ separately says that if "points (or other types of virtual currency) are sold in-app, Google Play's billing system must be used". **Counsel or Google support should confirm** whether a per-call charge, without virtual currency, could fit the 1:1 exemption.
- **Subscriptions** [S34]:
  - clear disclosure of price, billing frequency and auto-renewal;
  - an easy online cancellation path, for example a link to Play's Subscription Center;
  - a subscription must provide "sustained or recurring value". Lump-sum currency is not allowed as a subscription.

  The ₹200/month private room fits a subscription product if the benefits recur. The repository says no subscription billing integration exists yet [R5].
- **Payments for gambling** must not use Play Billing at all (Payments policy, item 3.3) [S31].

### 6.6 Other Play policies that matter for ZIPPER

- **Age-restricted functionality.** Apps whose core is dating, "randomly connecting users to spontaneously communicate with people they do not know", or anonymous communication must use Play Console tools to block minors [S35]. Families policy: such apps "must not target children" [S37].
- **Sexual content.** Play bans "content or services intended to be sexually gratifying", content that "appear[s] to promote or solicit a sexual act in exchange for compensation", and "sugar dating" arrangements [S36]. This is a known enforcement area for paid 1:1 video apps.
- **User-generated content.** Apps with UGC "must implement robust, effective, and ongoing UGC moderation" [S39].
- **Code loaded at run time.** A Play app may not download executable code from outside Play. Interpreted code loaded at run time (JavaScript, for example HTML5 games in a webview) "must not allow potential violations of Google Play policies" [S38]. This matters if games come from a third-party provider and load at run time. Switching features on from the server after review does not change the policy analysis.

### 6.7 Distributing the APK outside Play

**What changes:**
- Play's billing, content and age policies no longer bind ZIPPER contractually. Google's FAQ says "you can distribute your app however you like … without using Google Play's billing system" [S32].
- **Android developer verification** starts on **30 Sep 2026** for installs from participating stores in Brazil, Indonesia, Singapore and Thailand on certified devices running Android 7 or later. It "will be expanded globally for all apps on certified Android devices in 2027", with an "advanced flow" for power users [S40]. The India date is **unverified**. A sideloaded ZIPPER APK will probably need a verified developer identity from 2027.

**What does not change:**
- PROGA applies to online money gaming services offered in India or operated from abroad [S1].
- State gambling laws [S24].
- Blocking under s.14 and the IT Act s.69A procedure [S1].
- The payment-rail prohibition in s.7, and the reported advisory to banks, cloud providers, ISPs and app stores [S1][S48].
- GST, TDS, DPDP, SPDI and consumer law [S10][S12][S13][S16][S17].

Off-Play distribution also removes Play's age-gating and moderation scaffolding, so ZIPPER would need its own equivalents.

---

## 7. Consolidated questions for counsel and the CA

1. **Definitions.** Does staking diamonds bought from ZIPPER or resellers, to win more diamonds usable for host calls and gifts, meet s.2(1)(g) read with s.2(1)(j) and Rule 9(c)(iii) and (e)? Is "monetary and other enrichment" conjunctive or disjunctive? (§4.1)
2. **Convertibility.** Does the gift → beans → cash (verified host) or → diamonds (20:1) path make diamonds "recognised as equivalent or convertible to money"? Would ring-fencing game-won diamonds (no gifting, no call spend) change the answer? (§4.0, §4.1)
3. **Entry-fee skill games.** Can any Ludo or Carrom format with an entry fee survive PROGA? Does *Junglee*'s distinction between a fixed fee with a fixed prize and pooled stakes matter under PROGA? Is the e-sport route realistic? (§4.2)
4. **Lucky gifts.** Are they an "online game" at all? If so, are they an online money game? Do they also engage State lottery or gambling law? Should they remain disabled? (§4.4)
5. **Leaderboards.** Under what design, if any, may leaderboards pay diamonds? What is ZIPPER's Play category for the gamified-loyalty rules? (§4.5)
6. **Voluntary determination.** Should ZIPPER apply voluntarily to OGAI for a determination of any game? What are the risks of disclosure, given that suo motu determination is available? (§3.4)
7. **Litigation watch.** What is the current state of T.C.(C) No. 133/2025 and the CASC PIL? Were there hearings in October 2026? (§3.5)
8. **State law.** What is the position in each State with material users, including whether "stakes" covers money's worth or virtual currency? (§5.2)
9. **GST (CA).** What is the classification and rate for diamond, gift and subscription sales? What is the exposure at 40% if any feature is treated as online money gaming? Who supplies in the reseller channel? (§5.3)
10. **TDS (CA).** How are in-kind winnings and host payouts treated under the Income-tax Act, 2025? (§5.4)
11. **RBI PPI.** Can diamonds remain a closed-system PPI when spent on independent hosts' services? (§5.7)
12. **Resellers.** Can resellers continue alongside Play distribution? What are the KYC/AML duties? Should the Binance and international options be paused? (§5.7, §6.5)
13. **Play Billing.** Does any exemption cover calls or gifts? Should ZIPPER adopt Play Billing or India alternative billing for diamonds and the ₹200 subscription? (§6.5)
14. **Biometrics.** What consent wording, retention period, vendor location and transfer terms, and agency role apply under the SPDI Rules now and DPDP from May 2027? (§5.6)
15. **Age.** What minimum age and age-assurance standard should apply, given Play's age-restricted functionality policy, DPDP's children's provisions, and PROGA's "user safety features" concept? (§3.4, §5.6, §6.6)
16. **Advertising.** Which in-app and influencer promotions could count as "directly or indirectly" promoting online money games under s.6? (§5.5)

---

## 8. Discrepancies, gaps and unverified items

- **PROGA commencement.** An SCO analysis piece says PROGA "came into force on 1 October 2025" [S41]. That conflicts with the primary S.O. 1994(E), which appoints **1 May 2026** [S2], and with Storyboard18's report that the Act was still un-notified in January 2026. I rely on S.O. 1994(E).
- **Act year.** A PTI headline calls the law the "Online Gaming Act, 2026" [S45]. The Act is of **2025** [S1].
- ***Gameskraft* date.** IBFD and the Supreme Court PDF file name give 27 May 2026 [S25][S42]. SCO says it was delivered "the next day" after *Junglee* [S41]. I use 27 May 2026.
- **Final hearing.** The 6–7 Oct 2026 PROGA final-hearing dates come from ET as cited by MediaNama. I could not verify them, and I found no later report [S43].
- **Advisory and blocking figures.** The 29 Jul 2026 advisory and the ~8,400 blocked URLs come from secondary sources only. I did not see the advisory itself [S48][S49].
- **IT Rules.** No formal omission of IT Rules 4A–4C was found [S9].
- **Tax references.**
  - Income-tax Act 2025 section mapping for TDS on winnings: s.393, from secondary sources [S56].
  - GST notification number 9/2025-CT(Rate): secondary [S54].
  - 18% GST on ordinary digital sales: not verified for ZIPPER.
- **DPDP dates.** AZB gives 12 Nov 2026 and 12 May 2027; other sources say the 13th [S57]. The breach-reporting deadline under DPDP rule 7 (some sources say 72 hours) is **unverified**.
- **State laws.** Current status of the Telangana, Andhra Pradesh and Karnataka-2025 measures is unverified. Exact State definitions were not reviewed [S59][S60].
- **RBI.** The PA Directions 2025 details are secondary [S20]. The status of the draft 2026 PPI Master Direction is unverified. No PROGA-specific RBI circular was found.
- **Android verification.** The India date for developer verification is unverified [S40].
- **Low-reliability source.** A Licentium post (4 Sep 2026) describing the hearings contained apparent errors, for example calling Union List Entry 42 "lotteries". **It was not relied on.**
- **Absence findings.** No OGAI list of online money games, no MeitY FAQ on virtual currency, and no notified social-game category was found. These are findings from not locating something, not confirmed absences.

---

## 9. Source list

All URLs were opened or searched on **3 November 2026**. "Search extract" means I relied on a search-engine extract of the page and did not read the full page.

### A. Statutes, rules, gazette and government (primary unless stated)

| Tag | Source | URL | Notes |
|---|---|---|---|
| S1 | Promotion and Regulation of Online Gaming Act, 2025 (Act 32 of 2025), India Code consolidated text "as on the 5th May, 2026" | https://www.indiacode.nic.in/bitstream/123456789/22148/1/a2025-32.pdf | Primary. Definitions; ss.5–20; corrigenda footnotes; commencement footnote |
| S2 | MeitY notification S.O. 1994(E), 22 Apr 2026: commencement on 1 May 2026 (Gazette CG-DL-E-22042026-271977) | https://www.meity.gov.in/static/uploads/2026/04/089ca9904b13f019b41a391584ab10ea.pdf | Primary |
| S3 | Promotion and Regulation of Online Gaming Rules, 2026, G.S.R. 303(E), 22 Apr 2026 (Gazette CG-DL-E-22042026-271974) | https://www.meity.gov.in/static/uploads/2026/04/7e0b02d37fd07f81fa48578a9996aa85.pdf | Primary. English text read for rules 1–15(a); rules 15–26 read in the Hindi text of the same gazette |
| S4 | PIB, "Promotion and Regulation of Online Gaming Rules, 2026", 22 Apr 2026 (PRID 2254606) | https://www.pib.gov.in/PressReleasePage.aspx?PRID=2254606&reg=3&lang=1 | Primary (government release) |
| S5 | PIB backgrounder, "A New Era of Online Gaming Governance", 30 Apr 2026 | https://static.pib.gov.in/WriteReadData/specificdocs/documents/2026/apr/doc2026430859401.pdf | Primary (government) |
| S6 | MeitY notice inviting comments on draft PROG Rules, 2025, 2 Oct 2025 | https://www.meity.gov.in/static/uploads/2025/10/275f784cc6401f46214a02107e941b91.pdf | Primary |
| S7 | MeitY explanatory note on draft PROG Rules (Oct 2025) | https://www.meity.gov.in/static/uploads/2025/10/85fbcf755d765740d9552694bf34fa02.pdf | Primary (draft stage; superseded by S3) |
| S8 | OGAI "Application form for determination of online games and registration of e-sport" (MeitY upload, Jun 2026) | https://www.meity.gov.in/static/uploads/2026/06/862347a266283015b2ed41a93381d176.pdf | Primary |
| S9 | IT (Intermediary Guidelines and Digital Media Ethics Code) Rules, 2021, consolidated "updated as on 10.02.2026" | https://www.meity.gov.in/static/uploads/2026/03/0b576f2071694b52e4cd6bb1b6dfab1e.pdf | Primary |
| S10 | Central Goods and Services Tax (Amendment) Act, 2023 (No. 30 of 2023), Gazette copy hosted by PRS | https://prsindia.org/files/bills_acts/bills_parliament/2023/The%20Central%20Goods%20and%20Services%20Tax%20(Amendment)%20Act,%202023.pdf | Primary text (third-party host) |
| S11 | PIB, FAQs on decisions of the 56th GST Council, 3 Sep 2025 (PRID 2163560): Q1 (effective 22 Sep 2025) and Q73 (40% on specified actionable claims) | https://www.pib.gov.in/PressReleasePage.aspx?PRID=2163560&reg=48&lang=2 | Primary (government) |
| S12 | Income Tax Department, "Winnings From Online Games" (s.115BBJ, s.194BA, Rule 133) | https://www.incometaxindia.gov.in/w/winnings-from-online-games | Primary (government); reflects the 1961 Act |
| S13 | Digital Personal Data Protection Rules, 2025, G.S.R. 846(E), 13 Nov 2025 | https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf | Primary. Rule 1 commencement read in English; Third Schedule read in Hindi |
| S14 | PIB, "Government notifies DPDP Rules…", 14 Nov 2025 (PRID 2190014) | https://www.pib.gov.in/PressReleasePage.aspx?PRID=2190014&reg=3&lang=2 | Primary (government) |
| S15 | PIB backgrounder, "DPDP Rules, 2025 Notified", 17 Nov 2025 (penalty ceilings) | https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf | Primary (government) |
| S16 | IT (Reasonable security practices and procedures and sensitive personal data or information) Rules, 2011, G.S.R. 313(E), 11 Apr 2011, Gazette copy hosted by PRS | https://prsindia.org/files/bills_acts/bills_parliament/2011/IT_Rules_2011.pdf | Primary text (third-party host) |
| S17 | PIB, CCPA "Guidelines for Prevention of Misleading Advertisements and Endorsements…, 2022", 10 Jun 2022 (PRID 1832906) | https://www.pib.gov.in/PressReleasePage.aspx?PRID=1832906&reg=48&lang=2 | Primary (government) |
| S18 | PIB, 22 Dec 2024 (PRID 2086980): lists the 13 dark patterns under the CCPA Dark Patterns Guidelines, 2023 | https://www.pib.gov.in/PressReleseDetailm.aspx?PRID=2086980&reg=48&lang=2 | Primary (government) |
| S19 | RBI FAQ, "Prepaid Payment Instruments (PPIs)", updated 22 Nov 2022 (closed-system PPI definition; MD-PPIs of 27 Aug 2021) | https://www.rbi.org.in/commonman/english/scripts/FAQs.aspx?Id=2812 | Primary (regulator) |
| S20 | RBI press release, "RBI issues the Reserve Bank of India (Regulation of Payment Aggregators) Directions, 2025" (15 Sep 2025) | https://website.rbi.org.in/web/rbi/-/press-releases/rbi-issues-the-reserve-bank-of-india-regulation-of-payment-aggregators-directions-2025 | Page redirected to RBI home when checked. Details from search extracts and secondary summaries only |
| S21 | CCPA "Guidelines and Advisories" page (Dark Patterns Guidelines 2023; self-audit advisory 05.06.2025) | https://ccpa.doca.gov.in/guidelines.php | Search extract only |
| S22 | PIB explainer on the new criminal laws (May 2024), quoting BNS s.112 | https://static.pib.gov.in/WriteReadData/specificdocs/documents/2024/may/doc2024522337701.pdf | Search extract only |

### B. Courts

| Tag | Source | URL | Notes |
|---|---|---|---|
| S23 | Supreme Court Observer, "Challenge to the Promotion and Regulation of Online Gaming Act, 2025" (T.C.(C) No. 133/2025; last updated 2 Jul 2026) | https://www.scobserver.in/cases/challenge-to-the-promotion-and-regulation-of-online-gaming-act-2025/ | Secondary (court tracker) |
| S24 | SCO.LR, *State of Tamil Nadu v Junglee Games India Pvt Ltd*, 2026 INSC 594, judgment 27 May 2026 (includes judgment text) | https://www.scobserver.in/supreme-court-observer-law-reports-scolr/betting-and-gambling-in-games-of-skill-state-of-tamil-nadu-v-junglee-games-india/ | Judgment text as reproduced by SCO. The page was truncated, so the operative conclusion was read via S41, S43 and S44 |
| S25 | Supreme Court of India, *DGGI (HQs) v Gameskraft Technologies Pvt Ltd*, C.A. Nos. 8241–8244 of 2026, 2026 INSC 595 (file dated 27 May 2026) | https://api.sci.gov.in/supremecourt/2023/30797/30797_2023_7_1505_71652_Judgement_27-May-2026.pdf | Primary. Only the opening pages were read; holdings taken from S41 and S42 |
| S26 | Supreme Court order dismissing *Junglee* review petitions, 15 Oct 2026 | https://api.sci.gov.in/supremecourt/2026/41238/41238_2026_5_1002_75472_Order_15-Oct-2026.pdf | Linked by S44; not opened by me |
| S27 | Supreme Court order on transfer petitions, 8 Sep 2025 | https://api.sci.gov.in/supremecourt/2025/50424/50424_2025_7_70_63973_Order_08-Sep-2025.pdf | Linked by S41; not opened by me |

### C. Google (platform policy, primary)

| Tag | Source | URL |
|---|---|---|
| S28 | Play policy: Real-Money Gambling, Games, and Contests (includes Gamified Loyalty Programs and the gambling-ads conditions) | https://support.google.com/googleplay/android-developer/answer/9877032?hl=en |
| S29 | Play: "Overview: Real-money gaming pilots in selected regions" (effective 4 Jun 2026; India grace period ended 22 Jan 2026) | https://support.google.com/googleplay/android-developer/answer/12918670?hl=en |
| S30 | Play: "Country/region allowances for gambling apps" (India not listed) | https://support.google.com/googleplay/android-developer/answer/12256011?hl=en |
| S31 | Play policy: Payments | https://support.google.com/googleplay/android-developer/answer/9858738?hl=en |
| S32 | Play: "Understanding Google Play's Payments policy" (FAQ: tips, 1:1 services, virtual currency, India, off-Play distribution) | https://support.google.com/googleplay/android-developer/answer/10281818?hl=en |
| S33 | Play: "Changes to Google Play's billing requirements for developers serving users in India" (alternative billing) | https://support.google.com/googleplay/android-developer/answer/13306652?hl=en |
| S34 | Play policy: Subscriptions | https://support.google.com/googleplay/android-developer/answer/9900533?hl=en |
| S35 | Play policy: Age-Restricted Content and Functionality | https://support.google.com/googleplay/android-developer/answer/16302250?hl=en |
| S36 | Play policy: Inappropriate Content (Sexual Content and Profanity) | https://support.google.com/googleplay/android-developer/answer/9878810?hl=en |
| S37 | Play: Google Play Families Policies | https://support.google.com/googleplay/android-developer/answer/9893335?hl=en |
| S38 | Play policy: Device and Network Abuse (redirects to answer 16559646) | https://support.google.com/googleplay/android-developer/answer/9888379?hl=en |
| S39 | Play: Developer Program Policy (effective 15 Jul 2026; UGC moderation; NFT social-casino example) | https://support.google.com/googleplay/android-developer/answer/17190352?hl=en |
| S40 | Android Developers: "Android developer verification" (timeline) | https://developer.android.com/developer-verification |

### D. Secondary (law-firm notes and news)

| Tag | Source | URL |
|---|---|---|
| S41 | Supreme Court Observer, "From Skill to Stakes: How Junglee Games and Gameskraft reshape India's online gaming laws" (18 Jun 2026) | https://www.scobserver.in/journal/from-skill-to-stakes-how-junglee-games-and-gameskraft-reshape-indias-online-gaming-laws/ |
| S42 | IBFD, "Supreme Court Upholds Retrospective GST on Online Gaming and Gambling" (9 Jun 2026) | https://www.ibfd.org/news/supreme-court-upholds-retrospective-gst-online-gaming-and-gambling |
| S43 | MediaNama, "Supreme Court rejects Junglee Games' review plea…" (27 Oct 2026) | https://www.medianama.com/2026/10/223-supreme-court-junglee-games-review-plea/ |
| S44 | Gambling.com, "India Supreme Court Rejects Junglee Review Pleas On Gaming Bans" (28 Oct 2026) | https://www.gambling.com/news/india-supreme-court-rejects-junglee-review-pleas-on-gaming-bans |
| S45 | Telangana Today (PTI), "Supreme Court to hear challenges against Online Gaming Act; PIL seeks ban on gambling apps" (5 Aug 2026) | https://telanganatoday.com/supreme-court-to-hear-challenges-against-online-gaming-act-pil-seeks-ban-on-gambling-apps |
| S46 | Storyboard18, "SC flags need for three judge bench, pushes Online Gaming Law challenge to January" (11 Dec 2025) | https://www.storyboard18.com/gaming-news/breaking-sc-flags-need-for-three-judge-bench-pushes-online-gaming-law-challenge-to-january-85676.htm |
| S47 | Business Standard (PTI), "No online game registered under new law, 201 complaints received: Meity" (18 Sep 2026) | https://www.business-standard.com/technology/tech-news/no-online-game-registered-under-new-law-201-complaints-received-meity-126091801080_1.html |
| S48 | Indiantelevision.com, "MeitY warns digital platforms to comply with online gaming law" (4 Aug 2026; advisory dated 29 Jul 2026) | https://indiantelevision.com/iworld/meity-warns-digital-platforms-to-comply-with-online-gaming-law/ |
| S49 | Gambling.com India, "India Orders App Stores And Banks To Cut Off Online Money Games As Site Blocks Near 8,400" (6 Aug 2026) | https://www.gambling.com/in/news/india-orders-app-stores-and-banks-to-cut-off-online-money-games-as-site-blocks-near-8-400 |
| S50 | Khaitan & Co ERGO, "Online Gaming Rules 2026" (29 Apr 2026) | https://www.khaitanco.com/sites/default/files/2026-04/29%20April%202026_ERGO_Online%20Gaming%20Rules_2026.pdf |
| S51 | Legal 500 / Shardul Amarchand Mangaldas, "Statutory Update: New Legal Framework For Online Gaming From 1st May 2026" (11 May 2026) | https://www.legal500.com/intelligence/india/media-telecoms-it-entertainment/statutory-update-new-legal-framework-for-online-gaming-from-1st-may-2026 |
| S52 | Trilegal, "The Promotion and Regulation of Online Gaming Act, 2025 – Redrawing India's online gaming landscape" (9 Sep 2025) | https://trilegal.com/knowledge-repository/trilegal-update-the-promotion-and-regulation-of-online-gaming-act-2025-redrawing-indias-online-gaming-landscape/ |
| S53 | iGaming Business, "Does the PROG Act & Rules 2026 deliver a clear reset for online gaming in India?" (9 Oct 2026; quotes Aaron Kamath, Nishith Desai Associates) | https://igamingbusiness.com/casino-games/does-prog-act-deliver-clear-reset-for-online-gaming-india/ |
| S54 | TaxGuru, "GST on Online Gaming: 40% Rate, Gameskraft Ruling and Prohibition" | https://taxguru.in/income-tax/gst-online-gaming-40-percent-rate-gameskraft-ruling-prohibition.html |
| S55 | Trilegal, "Key Recommendations of the 57th GST Council Meeting" (15 Oct 2026) | https://trilegal.com/knowledge-repository/analysis/key-recommendations-of-the-57th-gst-council-meeting/ |
| S56 | ClearTax, "Section 393 of Income Tax Act, 2025" | https://cleartax.in/s/section-393-of-income-tax-act |
| S57 | AZB & Partners, "India's DPDP Act: Phased Rollout and Key Compliance Milestones" (14 Nov 2025) | https://www.azbpartners.com/bank/indias-digital-personal-data-protection-act-phased-rollout-and-key-compliance-milestones/ |
| S58 | LiveLaw, "Madras High Court Upholds Night Ban, Mandatory KYC For Online Real Money Games" (June 2025) | https://www.livelaw.in/amp/high-court/madras-high-court/madras-high-court-upholds-tn-regulation-night-ban-mandatory-kyc-online-real-money-games-294105 (search extract only) |
| S59 | Mondaq (Khaitan & Co), "Salient Features Of The Telangana State Gaming (Amendment) Ordinance, 2017" (3 Jul 2017) | https://www.mondaq.com/india/gaming/607360/salient-features-of-the-telangana-state-gaming-amendment-ordinance-2017 |
| S60 | Khaitan & Co, "End of play – Andhra Pradesh Outlaws Real Money Gaming" (2020) | https://khaitanco.com/thought-leaderships/End-of-play-Andhra-Pradesh-Outlaws-Real-Money-Gaming (search extract only) |
| S61 | MediaNama, ASCI guidelines on real-money gaming ads (Nov 2020) | https://www.medianama.com/2020/11/223-asci-guidelines-real-money-gaming-ads/ (search extract only) |

### E. Repository facts (observed 3 Nov 2026)

| Tag | File | What it shows |
|---|---|---|
| R1 | `/Users/soumyaranjansingh/Documents/Projects/zippern/ECONOMY-CONTRADICTIONS.md` ("DECIDED — 10 September 2026" block; §5) | Bean/diamond accounting; withdrawal at 100 beans = ₹1; conversion at 20:1 open to any gift recipient; games planned and gated by level with a provider callback and bet settlement; lucky-gift multipliers up to 200× in the app vs 20× in config; RNG on the phone; resellers buy wholesale |
| R2 | `/Users/soumyaranjansingh/Documents/Projects/zippern/HOST-VERIFICATION-AND-GIFT-PRIVACY.md` (Part 1) | Host-only face verification; photo uploaded by the agency; AI vendor undecided (AWS/Azure/on-device); unverified hosts cannot withdraw |
| R3 | `/Users/soumyaranjansingh/Documents/Projects/zippern/zipper-app/app/src/main/java/com/zipper/app/ui/screens/diamond/ResellerListScreen.kt` (lines 46–53, 69–70) | In-app reseller payment details (`upiId`, `upiQrUrl`, `binanceUid`; `upi \| qr \| binance \| bank \| international`); "I have paid" files a recharge request |
| R4 | `/Users/soumyaranjansingh/Documents/Projects/zippern/docs/phase-0/ZIPPER-Phase-0-Documentation.md` (line 2439) and `/Users/soumyaranjansingh/Documents/Projects/zippern/APP-CRM-MISMATCH.md` (lines 227–228) | Weekly leaderboards rank recharges, gifts and lucky-gift spend, with no prizes today; the CRM plans prize tiers and reward tables |
| R5 | `/Users/soumyaranjansingh/Documents/Projects/zippern/zipper-app/DESIGN-SYSTEM-STATE.json` (line 315), plus a text search of `zipper-app` for billing SDKs | "no subscription billing integration exists"; no Play Billing or payment-SDK usage found in the Android sources |

*End of document. This is research for counsel, not legal advice.*
