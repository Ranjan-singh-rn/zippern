# What the app and the CRM disagree about

Everything below was verified by reading the files, not inferred.

---

## The headline: the app reads 1 of your 36 CRM economy settings

Your CRM exposes 36 economy knobs. I checked each one against the Kotlin to see
whether the app ever reads it from Firestore.

**Read: 1** — `minHostLevel`.

**Ignored: 35** —

```
beanToDiamondRate        callRateBeansPerMin      diamondPackPriceInr
diamondPackPriceUsd      diamondPerLakhInr        diamondPerLakhUsd
exclusiveReceiverPctMax  exclusiveReceiverPctMin  luckyReceiverPct
luckyReturnMax           luckyReturnMin           maxHostCallRate
minHostCallRate          minPayoutInr             minUserLevel
minWeeklyBeans           normalReceiverPct        sellerWholesalePriceInr
sellerWholesalePerLakhInr usdToInrRate            beanToInrRate
binanceFeePercent        govtTaxPercent           hostEntriesPerHour
userEntriesPerGift       weeklyMinBeans           weeklyMinPayoutBeans
weeklyMinPayoutInr       weeklyMinPayoutUsd       minPayoutInr
…and the rest
```

The CRM is a control panel wired to almost nothing. Every number your team
edits there is overridden by a `const` compiled into the APK.

**This is the single biggest structural problem in the product.** It means every
price change, every rate change, every payout threshold requires a Play Store
release and a 1–7 day review. It also means the CRM shows your partners and
your observer numbers that are not the numbers the app is using.

---

## The gender economics exist only in the APK

`util/EconomyEngine.kt` hardcodes this:

**User ↔ user calls** — fixed 1,600 diamonds/min:

| Caller → Receiver | Receiver earns |
|---|---|
| Male → Female | **50%** (800 beans) |
| Female → Male | **40%** (640 beans) |
| Same gender | **30%** (480 beans) |

**Calls involving a host** — cost derived from the host's own bean rate:

| Situation | Host earns |
|---|---|
| Female host | **50%** |
| Male host | **40%** |
| Host ↔ host, same gender | **30%** |

`hostRewardPercent()` at line 247 and `userRewardPercent()` at line 258.

**The CRM has no gender fields at all.** Its config offers a single
`normalReceiverPct`, plus `exclusiveReceiverPctMin/Max` and `luckyReceiverPct`.
Nothing that can express "female 50 / male 40 / same 30".

---

## DECIDED — Option A, and a correction to what is written below

The owner has settled this. **Host income is fixed in the CRM; the caller's
price is derived from it.** CRM sets host income per minute (e.g. 750 beans).
The gender percentage says what fraction of the caller's payment that represents,
so the caller's rate is `hostIncome ÷ pct`:

| Pairing | Host share | Host earns | Caller pays |
|---|---|---|---|
| Opposite gender, female host | 50% | 750 beans | 1,500 💎/min |
| Opposite gender, male host | 40% | 750 beans | 1,875 💎/min |
| Same gender | 30% | 750 beans | 2,500 💎/min |

**Correction to the equal-pay note further down:** on the host-call path every
host earns the same 750 beans regardless of gender. The percentage changes what
the *caller* pays, not what the host is paid. That is a pricing rule, not a pay
rule, and the concern raised below does not apply to it.

It does still apply to **user ↔ user calls**, which are built the opposite way:
`EconomyEngine` fixes the price at 1,600 💎/min and varies the *receiver's*
earnings 50/40/30 by gender. That is the one place a real gender pay gap exists.
Recommend restructuring it to match the host model — fix the receiver's income,
derive the price.

### Who sets the host's income, and when

Three stages. The code already has this shape — it is the inputs that are wrong.

1. **At registration, the agency operator sets it.** `hostApplications.callRate`,
   entered in `zipper-crm/app/agency-dashboard/page.tsx`.
2. **As the host levels up, the host adjusts it themselves.**
   `EditProfileScreen.kt:105-114` already caps the slider by `hostLevel`
   (700 / 2,000 / 5,000 / 12,000 beans at levels <3 / 3 / 5 / 7) and hides it
   entirely below level 3. That design is correct.
3. **The caller's price is derived**, never set: `hostIncome ÷ genderPct`.

So `callRateBeans` being a host-set field is right. Three things break it:

- **`hostLevel` is written once as `0` at `AuthRepository.kt:210` and never
  updated.** Every host is therefore permanently below level 3, the slider is
  hidden from all of them, and the ceiling is stuck at 700. This is the blocking
  bug — nothing else in the progression works until it is fixed.
- **The ceiling table is hardcoded** in `EditProfileScreen`. It belongs in
  `levelConfig/host/levels/{n}.maxCallRateBeans`, editable in the CRM.
- **`minHostCallRate` / `maxHostCallRate` already exist in the CRM and are
  ignored.** They should bound the whole range, with the per-level ceiling
  sitting inside them.

### What Option A requires

The formula is already correct in the app. `callCostFromHostBeanRate()`
(EconomyEngine.kt:233) computes `hostBeanRate ÷ pct` with a ceiling. Only the
inputs are wrong:

1. **Add to CRM economy config:** `hostIncomeBeansPerMin`,
   `receiverPctOppositeFemale` (50), `receiverPctOppositeMale` (40),
   `receiverPctSameGender` (30). Same four for the user↔user path if it is kept.
2. **Make the app read them** instead of `user.callRateBeans` and the hardcoded
   `hostRewardPercent()` table.
3. **Show the caller the derived diamond rate**, and show the host their fixed
   bean income. Both screens are drawn this way in Figma already.
4. `minHostCallRate` / `maxHostCallRate` become the bounds on the CRM-set host
   income, not on a host-editable field.

---

Original analysis follows.

So one of two things has to happen, and it is your call:

**Option A — teach the CRM about gender.** Add `receiverPctFemaleHost`,
`receiverPctMaleHost`, `receiverPctSameGender`, and the three user↔user
equivalents. Then make the app read them. Keeps the current economics, makes
them tunable.

**Option B — drop gender from the maths.** Use the CRM's single
`normalReceiverPct` for everyone and let the host's own call rate do the
differentiating. Simpler, one number to reason about, and it removes the issue
below.

### One thing to weigh, since you are opening hosting to all genders

HiClub can price by gender because only women can host there — the rate is
effectively "the host rate". The moment any gender can be a host, a rule that
pays a female host 50% and a male host 40% for the same minute of the same work
is a **25% pay difference based on sex**.

India's Code on Wages 2019 prohibits gender discrimination in remuneration for
the same or similar work. Whether it binds you depends on whether hosts are
contractors or workers — that classification is itself contested in the creator
economy and is not something I can settle. I am not your lawyer and this is not
legal advice. But it is worth a specific question to counsel *before* you
publish rate cards to hosts, because the rates are the thing you would have to
walk back publicly.

Option B makes the question go away.

---

## Per-system: what matches, what doesn't

| System | CRM | App | Match? |
|---|---|---|---|
| Diamond pack prices | `diamondPackPriceInr`, editable | Hardcoded in **3 separate tables** | ❌ |
| Seller wholesale price | `sellerWholesalePriceInr`, editable | Hardcoded ₹2,290, no override path | ❌ |
| Bean → diamond | `beanToDiamondRate` = 0.5 | `const BEANS_PER_DIAMOND = 20` | ❌ 40× apart |
| Bean → rupee payout | `beanToInrRate` | `const BEANS_PER_RUPEE = 100` | ❌ |
| Payout threshold | `weeklyMinPayoutBeans` | `const MIN_WITHDRAWAL_BEANS = 100_000` | ❌ |
| Host call rate limits | `minHostCallRate`, `maxHostCallRate` | Host sets freely, unbounded | ❌ |
| Gift receiver share | `normalReceiverPct` = 30 | 50% hardcoded | ❌ |
| Lucky gift returns | `luckyReturnMin/Max`, ceiling 20× | Up to **200×**, RNG on device | ❌ |
| Chance governance | 6 screens: RTP, exposure, monitoring, protection | Zero references — `chanceConfig`, `houseEdge`, `rtp` all absent | ❌ |
| Agency commission | Progressive, 5–25% by slab, paid by Zipper | `AGENCY_CUT_PERCENT = 5`, flat, taken from host | ❌ Opposite |
| Min host level | `minHostLevel` | Read from Firestore | ✅ |

---

## What the CRM itself still has wrong

### 1. The commission docstring contradicts the commission code

`backend/app/services/commission.py:10-18` says:

> The band's rate applies to the **whole** billing figure. This is a flat rate
> by band, not a progressive/marginal calculation

The `RULE` string in the same file (349-357), which is what clients actually
receive, says:

> Progressive by band, like income tax… No single rate is ever applied to the
> whole amount.

The arithmetic at 438-466 is progressive. The docstring is stale and will
mislead the next person who reads it — including a future you.

### 2. Partners are shown the wrong commission rate

`zipper-crm/lib/commission.ts:118` renders `Rate: ${b.rate_percent}%` — a single
figure. On a progressive calculation that number is the **top band crossed**,
not what the agency actually earned. An agency billing ₹4.12 lakh sees "14%" on
a commission that works out to about 9.4%.

Wrong in the direction that makes you look like you are shortchanging them. Add
an effective-rate row. The Figma agency dashboard already shows both, labelled
`TOP BAND` and `EFFECTIVE`.

### 3. The bean→diamond input cannot accept its own default

`lib/rates.ts:67` defaults `beanToDiamond` to **0.5**. The editor at
`app/economy/config/page.tsx:354` sets `min={1} step={1}`.

So the shipped default is a value the form refuses to accept. Whoever opens that
screen and saves will silently change the rate to 1 without meaning to.

### 4. No config exists for the systems you are about to build

| Missing | Needed for |
|---|---|
| Games catalog, URLs, providers, bet limits, per-game RTP | Games Center |
| Campaign builder — schedule, prize tiers, qualifying actions, leaderboard rules, fulfilment | Pop Superstar-style events |
| Leaderboard definitions, reset cadence, reward tables | Hourly / weekly / Monthly CP |
| Cosmetics with durations and pricing | Timed avatar frames, entrance effects |
| Subscription plans | SVIP / Monthly Card |
| Intimacy and CP thresholds | Close Friends, couple rankings |

### 5. Still open from earlier

- `weekly_money_in` reports seller recharges at the **buyer's** price. That is a
  demand metric, not Zipper's cash.
- Seller coin float is valued at retail rather than wholesale.
- Operating costs are still not entered, so profit reads as an upper bound.
- Emails land in spam because gmail.com cannot pass DMARC. Buy a domain.

---

## The order I would fix this in

1. **Make the app read the CRM.** Start with prices (`diamondPackPriceInr`,
   `sellerWholesalePriceInr`) because those cost you money every day they are
   frozen, then payout rates, then the chance config. This single change is
   worth more than any feature on the roadmap — it converts your CRM from
   decoration into control.
2. **Pick one bean→diamond rate.** Fix the `min={1}` validation at the same time.
3. **Decide Option A or B on gender**, then wire it.
4. **Fix `describeBreakdown`** to show the effective rate. Partners are reading
   a wrong number today.
5. Delete the stale commission docstring.
6. Only then start on games, events and rankings config — building new knobs on
   a CRM the app ignores just adds more decoration.
