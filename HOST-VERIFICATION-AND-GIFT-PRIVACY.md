# Host verification and gift privacy

Two decisions taken 10 September 2026, and the model that implements them.

---

## Part 1 — Host identity verification

### What changes

Verification is **host-only**. Today `FaceVerificationScreen` sits in the signup
flow for everyone — Splash and ProfileSetup both route into it — so ordinary
users are asked for a liveness check they have no reason to do. That comes out.

### The flow

1. **Agency registers a host** and uploads the host's photograph, alongside the
   KYC documents already collected.
2. **Host completes a live capture** in the app, once.
3. **AI compares** the live capture against the agency's upload.
4. **Pass** → verified badge, immediately.
5. **Fail** → queued for **manual review in the CRM**, where a staff member sees
   both images side by side and decides.
6. **Manual fail** → the host stays **unverified**, and is shown: *"Get verified —
   ask your agency to re-upload your original photo."* The agency re-uploads and
   the check runs again.

Verification is a state a host can leave and re-enter, not a one-time gate.

### What unverified hosts lose

The rule I applied: **an unverified host can earn, but cannot scale, cannot be
featured, and cannot be paid out.**

| | Unverified | Verified |
|---|---|---|
| Go live | ✅ | ✅ |
| Take calls | ✅ at base rate only | ✅ up to their level ceiling |
| Receive gifts | ✅ | ✅ |
| Verified badge | ❌ | ✅ |
| Appear in Hot / featured / recommended | ❌ | ✅ |
| PK battles | ❌ | ✅ |
| Rankings, leaderboards, Top Charm | ❌ | ✅ |
| Raise their own call rate | ❌ | ✅ |
| Events and campaigns | ❌ | ✅ |
| **Withdraw earnings** | ❌ — accrues and is held | ✅ |

**The payout restriction is the important one, and not only as an incentive.**
Sending real money to an identity nobody has confirmed is precisely the exposure
India's AML rules exist to prevent. Earnings still accrue in full and are paid
the moment verification passes, so nobody loses money — they just cannot take it
out while unidentified.

Everything else follows one principle: *featured means vouched for*. A host on
the Hot tab, in a PK battle, or on a leaderboard is one the platform is
recommending. Recommending an unverified face is the risk not worth taking.

Base-rate-only is deliberate too — it removes the incentive to onboard a fake
host and immediately set a high rate.

### Data model

```
hostVerification/{uid}
  status            pending_capture | pending_ai | pending_manual | verified | rejected
  agencyPhotoUrl    uploaded by the agency at registration
  agencyId          who uploaded it
  captureUrl        the host's live capture
  capturedAt
  aiScore           0..1 similarity, null until the AI runs
  aiThreshold       the threshold in force when it ran — store it, thresholds move
  aiProvider        which service produced the score
  aiRanAt
  manualReviewedBy  staff uid, when it went to manual
  manualReviewedAt
  manualNote        why, in the reviewer's words
  attemptCount      how many times this host has tried
  lastRejectedAt
  verifiedAt
  expiresAt         optional re-verification date
```

`users/{uid}` gains a single derived flag, `isVerifiedHost`, written **only** by
the Cloud Function. It is a cache of `hostVerification.status == verified`, so
every read path can gate on one boolean without a join.

### The AI vendor is still open

Face **detection** ships in the app already (ML Kit). Face **comparison** — "are
these two photographs the same person" — does not, and ML Kit does not do it.

Realistic options, all paid:

- **AWS Rekognition `CompareFaces`** — the usual choice, priced per comparison,
  returns a similarity score. New vendor relationship.
- **Azure Face API** — comparable. Microsoft now gates face recognition behind an
  approval process, which adds lead time.
- **On-device embedding model** via the TFLite dependency already present —
  no per-call cost and nothing leaves the phone, but materially less accurate and
  a much larger build.

**This needs a decision, and it carries a privacy weight beyond cost.** Face
images are biometric data. Under India's DPDP Act that means explicit consent,
a stated retention period, and a deletion path — worth putting to counsel
alongside the gaming question, since the same review can cover both.

Until it is chosen, the Cloud Function is written with the provider behind an
interface and a stub that always routes to manual review. Nothing is blocked;
the app can ship with human review and switch on the AI later.

---

## Part 2 — Gift privacy

### The rule

- **Only the two parties** to a gift can see the counterparty. The sender knows
  who they sent to; the receiver knows who sent it. Nobody else sees either.
- **Everyone else** sees the gift showcase as anonymous totals — `Rose ×3`,
  `Crown ×1`. The item and the multiplier, nothing more.
- **Top Fans stays**, naming the biggest supporters and their total spend. That
  is an aggregate of *how much*, never *which gift* or *when*.

So a profile visitor learns that this host has received three roses, and that
Arjun is their top supporter. They cannot learn that Arjun sent the roses.

### What each viewer sees

Every profile shows **two tabs: Gifts Sent and Gifts Received.** Both tabs exist
for everyone — visitor and owner alike. What differs is the detail behind them.

| | Profile owner | Any visitor |
|---|---|---|
| Gift and count (`Rose ×3`) | ✅ | ✅ |
| Who each gift went to / came from | ✅ | ❌ |
| **Their own exchanges with this person, highlighted** | — | ✅ |

That last row is the useful part. When I open Priya's profile I see her showcase
anonymously — but any gift **I** have personally exchanged with her is marked
differently, with my own count: *"you sent this 2×"*, *"you received this 2×"*.

I learn nothing about anyone else's gifting. I only ever see my own side of a
relationship I was already part of.

### Data model

Four shapes, because one collection cannot serve four visibilities:

```
giftTransactions/{txId}              PRIVATE — the parties only
  senderUid, receiverUid, giftId, quantity,
  diamondCost, beansCredited, receiverPct, category,
  roomId, context (live|call|dm|party), createdAt

users/{uid}/giftShowcase/{giftId}    PUBLIC — anonymous aggregate
  giftId, displayName, iconUrl,
  receivedCount, sentCount
  (no uids, no timestamps, nothing that identifies a counterparty)

users/{uid}/topFans/{fanUid}         PUBLIC — named aggregate
  fanUid, displayName, photoUrl,
  totalDiamonds, rank, periodKey
  (how much, never which gift)

giftPairs/{pairId}/gifts/{giftId}    PAIRWISE — the two parties only
  pairId = the two uids sorted and joined, so one document per relationship
  giftId, aToBCount, bToACount, lastAt
  (this is what powers the "you sent this 2x" highlight)
```

`giftPairs` is the only addition needed for the highlight, and it is readable
**only by the two uids in the pair**. So opening someone's profile tells you
about your own history with them and nothing about anybody else's — the
highlight is computed from a document you were always entitled to read.

Both public shapes are written **only** by a Cloud Function on gift settlement.
Neither is derivable by a client, which is what makes the privacy hold.

### Why aggregates rather than filtered queries

Firestore rules filter *documents*, not *fields*. A rule permitting a visitor to
read `giftTransactions` at all would hand them `senderUid` too. The only way to
show a public total without the counterparty is to compute it server-side into a
document that never contained one.

This also fixes an existing gap: `GiftSummaryItem` carries a count but no
`diamondValue`, so the gift showcase has nothing to rank by. `giftShowcase`
carries both.

### Rules

```
match /giftTransactions/{txId} {
  allow read: if request.auth != null
              && (request.auth.uid == resource.data.senderUid
               || request.auth.uid == resource.data.receiverUid);
  allow write: if false;          // Cloud Functions only, via Admin SDK
}

match /users/{uid}/giftShowcase/{giftId} {
  allow read:  if request.auth != null;
  allow write: if false;
}

match /users/{uid}/topFans/{fanUid} {
  allow read:  if request.auth != null;
  allow write: if false;
}
```

`allow write: if false` on all three. Every one is money-derived, and the
existing `firestore.rules` comment already concedes that a client which can
write its own balance is a client that can mint currency.

---

---

## Three rule bugs found while implementing this

Not theoretical — all three were live in `firestore.rules`.

**1. Nobody could read their own gift history.** The `giftTransactions` rule
gated on `resource.data.senderId` and `receiverId`. Those fields have never
existed: `GiftRepository` writes `senderUid` and `receiverUid`, as
`backend/app/services/reports.py:3402` states outright. So the owner clause was
**always false** and only finance and admin could read a gift record. A user
asking "what did I send last week" got nothing.

**2. Any client could write its own gift record.** Same rule:
`allow create: if request.auth != null`. No amount validation, no sender check
beyond being signed in. A modified app could write a gift transaction claiming
any diamond cost and any bean credit it liked.

**3. The entire gifting graph was public.** `giftEvents` — which carries
`senderUid`, `receiverUid`, `giftId`, `quantity` and `totalCost` — was
`allow read: if request.auth != null`. Any signed-in client could query the
whole collection and reconstruct who had gifted whom, platform-wide. That is the
exact opposite of the privacy rule, and it was one query away from anyone who
looked.

All three are now closed. `giftEvents` reads are scoped to the room: a gift sent
inside a room stays a public announcement there, because the ticker is the point
of it, and everything else is limited to the two parties. Nothing in the app
reads `giftEvents` at all — the live ticker uses `liveRooms/{id}/gifts` — so the
lockdown breaks nothing.

---

---

## Part 3 — Why the CRM keeps everything: chargeback defence

Privacy is about what a **visitor** sees. It is not about what you can prove.

When payment gateways and Play Billing go live, some users will recharge, spend,
and then ask for their money back. The defence is showing the diamonds were
consumed: *recharged 10,000 on the 3rd; sent these gifts to these accounts on
the 4th and 5th; balance now 1,600.* Finance and admin therefore read
`giftTransactions` and the ledgers in full, and that is correct.

**But the ledger currently has holes, and they are in the worst places.**

| Path | Balance writes | Ledger rows |
|---|---|---|
| Gifts | 21 | 1 |
| Bean conversion | 2 | 1 |
| Bag purchases | 2 | 1 |
| **Calls** (`CallRepository`) | 3 | **0** |
| **Call economy** (`CallEconomyRepository`) | 8 | **0** |
| **Games** (`GamingBetRepository`) | 10 | **0** |

Calls and games move diamonds and write **nothing**. So a user who recharges and
spends it all on video calls leaves a trail of: one recharge, then a balance that
fell for no recorded reason. There is nothing to send a bank. That dispute is
lost before it starts, and calls are a primary spend path.

The gift row that does exist was also too thin to use. It stored
`relatedUserName` and no uid — a display name is not an identifier, so the
strongest claim it supported was "he sent it to Priya". `settleGift` now writes
`relatedUid`, `balanceAfter`, `context`, `roomId` and the transaction id on both
sides of every gift.

**Every remaining money path needs the same treatment**, and that is the real
argument for moving calls and games server-side rather than only the security
one.

### The exposure nobody has priced

If a refund is granted **after** the diamonds were spent, you lose twice: you
return the money to the user, and the host has already been credited beans for
the gift — possibly already paid out.

Three options, and this is a business decision rather than a technical one:

1. **Absorb it.** Simplest, and the cost is invisible until it isn't.
2. **Claw back from the host.** Defensible, but a host who has already been paid
   and then sees beans removed will not distinguish it from theft.
3. **Hold host payouts for a window** — 7 to 14 days — past the point where most
   chargebacks arrive. Standard practice in marketplaces, and it costs the host
   patience rather than money.

Option 3 is the usual answer. It also pairs with the verification hold already
described: earnings accrue, and are released once both the identity and the
chargeback window are clear.

---

## Build order

1. Rules and schema (this document).
2. `settleGift` Cloud Function — one transaction writing the private record and
   both public aggregates, so they cannot drift apart.
3. Verification function with the AI provider stubbed to manual review.
4. Remove `FaceVerificationScreen` from the general signup flow; add it to host
   onboarding.
5. Gate the ten unverified restrictions on `users/{uid}.isVerifiedHost`.
6. CRM: manual review queue, and the agency photo upload on host registration.
