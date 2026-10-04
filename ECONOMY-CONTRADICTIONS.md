# Money bugs found in the Android app

> ## DECIDED — 10 September 2026
>
> The owner has settled the four open questions. **Read this first; several
> conclusions further down were written before these answers and are corrected
> here.**
>
> ### 1. Beans and diamonds — NOT a contradiction
>
> Two separate mechanisms that I originally read as one:
>
> * **Internally, 1 diamond == 1 bean.** That is the accounting unit, and
>   `EconomyEngine`'s header comment saying so is correct.
> * **Earning:** when a gift is received, the receiver is credited a percentage
>   of the gift's diamond cost as beans. The percentage comes from the CRM, per
>   gift category — normal, exclusive, lucky, and any others configured. A 100
>   diamond gift at a normal rate of 50% credits **50 beans** to the receiver;
>   the other 50 is Zipper's. Calls credit beans the same way.
> * **Converting back:** **20 beans = 1 diamond.**
>
> The 20:1 is deliberate friction, not a bug. Without it, gift → convert →
> re-gift is a closed loop that manufactures diamonds nobody paid for.
>
> **Conversion is available to anyone who receives gifts, not only hosts.** For
> a non-host it is the only way to get value out, which is why the rate can be
> punitive without being unfair.
>
> **What IS wrong:** `zipper-crm/lib/rates.ts:67` defaults `beanToDiamond` to
> **0.5**. It should be **20**. The editor at `app/economy/config/page.tsx:354`
> also enforces `min={1}`, so the shipped default cannot be re-entered. Fix the
> default, then have the app read it instead of
> `BeanConversionRepository.BEANS_PER_DIAMOND`.
>
> ### 2. Agency commission is paid by Zipper, not the host
>
> The host is paid in full. Zipper pays the agency separately.
>
> So `util/Extensions.kt:62` — `AGENCY_CUT_PERCENT = 5`, commented "5% of host
> earnings go to agency" — is **wrong and must go**. The backend's progressive
> slab model, billed to Zipper, is correct.
>
> ### 3. The Convert button stays
>
> Both buttons remain. **Beans converted to diamonds are removed from the
> payout-eligible balance** — the two paths are mutually exclusive per bean, so
> nobody is paid twice for the same bean.
>
> Still open, and worth doing: a **host** sees both options, and the two are not
> close in value. 1,00,000 beans is ₹1,000 withdrawn, or 5,000 diamonds worth
> roughly ₹115 at retail. That is a real choice a host should make with their
> eyes open, so the convert screen should state what it costs relative to
> withdrawing. A non-host needs no such warning — conversion is their only exit.
>
> ### 4. Games ship later, gated by level
>
> Not in this release. Visible once a user or host reaches at least level 1.
>
> So: **keep** `GamingBetRepository`, do **not** build the provider-callback
> backend yet, and gate the entry point on level. The `settleBet` hole still has
> to be closed before it ships — it currently credits a winnings figure passed
> from the phone — but that is not this release's problem.
>
> Indian gaming counsel before any of it goes live still stands.

---


Found while redesigning the 41 screens. Nobody went looking for these — they
surfaced because you cannot draw a screen showing a balance without first
working out what the number means, and in several places the app cannot answer
that question consistently.

**Every line reference below has been verified by reading the file, not
inferred.** Nothing here is a design opinion. These are arithmetic disagreements
between files that all ship in the same APK.

Ordered by how much money is at risk.

---

## 1. The seller's margin is zero

Your coin sellers buy diamonds from you wholesale and resell at retail, keeping
the spread. That is the whole reason a seller exists.

| Who | File | Line | Pays | Gets |
|---|---|---|---|---|
| **Seller** | `ui/screens/seller/BuyCoinScreen.kt` | 85 | ₹2,290 | 1,00,000 coins |
| **User** | `ui/screens/diamond/DiamondShopScreen.kt` | 68 | ₹2,290 | 90,000 + 10,000 bonus = 1,00,000 diamonds |

Identical rupees, identical quantity. A seller who buys a lakh and sells a lakh
at the app's own displayed price earns **nothing**. `data/model/DiamondPack.kt`
says sellers mark up "typically 15–25%" and `APP_KNOWLEDGE.md:43` claims ₹290
commission — neither is achievable at these numbers.

The backend already knows better. `sellerWholesalePriceInr` exists, is editable
in the CRM, and is what `_expected_purchase_minor()` charges against. **The
Android app never reads it.** `COIN_PACKAGES` is a hardcoded list, and unlike
`DiamondShopScreen` — which at least has a Firestore override — `BuyCoinScreen`
has no remote override at all. It loads bank credentials from Firestore but not
prices, which is the exact inversion of what should be configurable.

**Consequence:** you cannot change what a seller pays without shipping a new APK
through Play review. And until you do, every seller working from in-app prices
is working for free.

---

## 2. Four different bean-to-diamond rates ship at once

| Source | File | Line | Says |
|---|---|---|---|
| Gifting | `util/Extensions.kt` | 61 | `DIAMOND_TO_BEAN_RATE = 0.5` — 1 diamond gifted → 0.5 beans |
| Gifting | `util/EconomyEngine.kt` | 14 | receiver gets 50% of diamond cost as beans |
| **Converting back** | `data/repository/BeanConversionRepository.kt` | 17 | `BEANS_PER_DIAMOND = 20` |
| Header comment | `util/EconomyEngine.kt` | 8 | "1 Diamond == 1 Bean (1:1 parity)" |
| CRM config | `zipper-crm/lib/rates.ts` | 67 | `beanToDiamond: 0.5` |

The first two agree. The rest do not, and the file that calls itself the single
source of truth contradicts the constant sitting two files away.

**The CRM value is orphaned.** Grepping the Kotlin for `beanToDiamondRate`
returns zero hits. You can edit that number in the CRM all day; the app will
never read it.

### What this does to a host, in real numbers

A user spends **40 diamonds** on gifts. The host receives **20 beans** (50%).
The host converts those 20 beans back: **1 diamond**.

Forty diamonds of spending becomes one diamond. That is a **97.5% haircut**, and
no screen says so.

### The convert button is a trap

Two exits exist for beans, and they are not close:

| Path | Rate | 1,00,000 beans becomes |
|---|---|---|
| **Withdraw** | 100 beans = ₹1 (`Extensions.kt:64`) | **₹1,000** |
| **Convert to diamonds** | 20 beans = 1 diamond → 5,000 diamonds, worth ₹2,290/lakh | **≈ ₹115** |

A host who taps Convert instead of Withdraw destroys about **89% of their
earnings**, and the app presents both as equal choices. This is the single most
damaging thing in the list, because the person harmed is the person earning you
money, and they will conclude they were cheated.

---

## 3. The app takes agency commission out of the host's pocket

`util/Extensions.kt:62`:

```kotlin
const val AGENCY_CUT_PERCENT = 5   // 5% of host earnings go to agency
```

The backend model we built is the opposite: **Zipper** pays the agency a
progressive commission (5–25% by slab), and the **host is paid in full**.

These are not two versions of one policy. They are opposite economics with
opposite losers. Whichever is correct, the other is currently lying to somebody
— either hosts are being under-paid by 5%, or agencies are being paid twice.

---

## 4. Agency commission: progressive in the maths, "flat" in the docs

`backend/app/services/commission.py:12-15` still says "flat rate by band, not
progressive". The `RULE` string actually returned to clients (line 349-356) says
"progressive by band, like income tax". The arithmetic at 438-466 is
progressive. `functions/src/index.ts:70-73` still asserts flat.

Worse, `zipper-crm/lib/commission.ts:111-125` (`describeBreakdown`) renders only
`rate_percent` — the **top band crossed**, not the effective rate. An agency
billing ₹4.12 lakh sees **"Rate: 14%"** on a commission that actually works out
to about **9.4%**.

That number goes in front of partners. It is wrong in a way that makes you look
like you are underpaying them, which is the worst direction for it to be wrong.

The design fix is in the Figma — the agency dashboard now shows both, labelled
`TOP BAND` and `EFFECTIVE`. The code fix is still open.

---

## 5. Gift and lucky-gift numbers disagree with config

- App pays the receiver **50%** (`EconomyEngine.kt:120-127`); `economyConfig.ts:144`
  configures **30%**.
- Lucky-gift multipliers run to **200×** in the app against a configured ceiling
  of **20×**.
- The lucky-gift RNG **runs on the phone**, with a comment in the file saying it
  must move server-side.

A client-side RNG that mints diamonds is a payout function anyone with a rooted
device can call. This one is also squarely in scope for India's Promotion and
Regulation of Online Gaming Act 2025 — worth raising with Indian gaming counsel
before it goes live, which I have flagged before.

---

## 6. Balance writes that bypass the card board

`SellerDashboardScreen.kt:395-407` approves a recharge with a bare
`.update("status", "approved")` — no amount verification, no re-read, no
transaction, no idempotency key. A Cloud Function then mints real diamonds.

Both approve and reject swallow every exception:

```kotlin
catch (_: Exception) { /* best-effort */ }
```

So a permission-denied looks exactly like success. The seller believes they
credited a customer; nothing happened.

`BeanConversionRepository.convertBeans` (29-39) is read-then-batch rather than a
transaction — two concurrent conversions both pass the balance check and drive
the balance negative.

`firestore.rules:549-552` self-documents the rest:

> the owner clause permits a user to raise their OWN diamonds, because the app
> credits daily rewards, bean conversion, gaming winnings and lucky-gift
> paybacks client-side

That is an accurate comment. It is also a description of a user being able to
credit themselves. Closing it means moving those four flows to Cloud Functions.

This is the same class of hole the backend rework closed on the CRM side. The
Android app still has nine client-side balance-write paths, three of which are
pure minting.

---

## What I would do, in order

1. **Make `BuyCoinScreen` read the wholesale price from Firestore.** Smallest
   change, and until it lands you cannot price your own product without a Play
   release.
2. **Pick one bean-to-diamond rate** and delete the other three. Whatever you
   pick, make the app read it from config rather than a `const`.
3. **Either remove the Convert button or price it honestly.** As it stands it
   costs a host 89% of their earnings and looks like a normal option.
4. **Settle who pays agency commission** — you or the host. One line, big
   consequences.
5. **Fix `describeBreakdown` to show the effective rate.** Partners are reading
   a wrong number today.
6. Move the nine client-side balance writes behind Cloud Functions, starting
   with the three that mint.

Items 1–5 are hours of work each. Item 6 is the real project, and it is the same
job the backend already went through.

---

## One thing that is not a bug but will read as one

`CallHistoryScreen` renders `typeLabel = "Missed"` and `formatDuration(0) =
"Missed"` on the same row, so a missed call shows **"Missed Missed"**. And
`ChatScreen.kt:167` computes an `isMe` value that is discarded on line 171 in
favour of a different expression. Both are cosmetic. Mentioned so they do not
get lost.
