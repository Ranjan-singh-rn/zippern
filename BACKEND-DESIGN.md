# Zipper backend — design

Written 11 September 2026, before implementation, so the shape can be argued
with rather than discovered.

---

## 1. The one principle

**No client writes a balance.**

Everything below follows from that. The app asks for an outcome; the server
decides what it costs, whether it is allowed, and what to record. A client that
can write its own balance is a client that can mint currency — `firestore.rules`
has said so in its own comments for months, and the nine client-side balance
paths are the reason this document exists.

Second principle, learned from the chargeback problem: **every movement writes a
ledger row.** Not for a history screen — for the day a bank asks you to prove a
user consumed what they bought.

---

## 2. Where things live

Two backends already exist and the split is sound. Keep it.

| | Cloud Functions (TypeScript) | FastAPI (Python) |
|---|---|---|
| **Serves** | the app | the CRM |
| **Data** | Firestore | MongoDB + Firestore |
| **Auth** | Firebase ID token | staff session |
| **Owns** | live money movement | the business record: cards, audit, payouts, partners, reports |
| **Region** | `asia-south1` (must match Firestore) | Cloud Run |

The rule of thumb: **if a user action moves money, it is a Cloud Function.
If a staff member decides something, it is FastAPI.**

A Firestore trigger in the wrong region deploys, reports success, and never
fires. `index.ts` already carries that scar from the project move. Every new
trigger goes in `asia-south1`.

---

## 3. The API surface

### 3.1 Money movement — Cloud Functions, callable

| Function | Replaces | Status |
|---|---|---|
| `settleGift` | `GiftRepository.sendGift` client batch | **built** |
| `startCall` | `CallEconomyRepository` affordability check | to build |
| `tickCall` | `CallRepository` per-tick client deduction | to build |
| `endCall` | client-side settlement | to build |
| `convertBeans` | `BeanConversionRepository` read-then-batch | to build |
| `claimDailyReward` | `ProfileRepository` client credit | to build |
| `purchaseBagItem` | `BagRepository` client debit | to build |
| `placeBet` / `settleBet` | `GamingBetRepository` | deferred — games ship later |

Every one takes the same shape:

```
input   what the user wants, and an idempotencyKey
server  reads the price, the config, the balances
        validates, computes, writes atomically
output  what happened, or a typed error
```

**Nothing accepts an amount from the client.** `settleGift` takes a `giftId` and
a quantity; the price comes from `gifts/{id}`. `tickCall` takes a `callId`; the
rate comes from the host's record and the CRM's split.

### 3.2 Calls need a server clock

Calls are the hard one, because they charge over time and the client cannot be
the timekeeper — a modified app simply stops ticking.

```
startCall(peerUid, idempotencyKey)
  → validates: both exist, caller can afford one minute, host accepts calls,
    verified-host gating, not blocked
  → derives the rate: hostIncome / genderPct  (or the flat user↔user price)
  → creates activeCalls/{callId} with startedAt, ratePerMin, participants
  → returns callId + the rate, so the app can show the cost before connecting

tickCall(callId)                     called by the app every 10s
  → the SERVER computes elapsed from startedAt, not from anything sent
  → charges only for whole ticks not yet charged (tickIndex on the doc)
  → if balance runs out: marks the call for termination and returns endNow
  → idempotent on (callId, tickIndex): a replayed tick charges nothing

endCall(callId)
  → final partial tick, settles, writes ledger rows both sides,
    moves the doc to callHistory
```

`tickIndex` is what makes this safe. A dropped response replays the same tick;
the server sees it is already charged and returns the same answer.

**A watchdog matters here.** If the app dies mid-call, nothing calls `endCall`
and the row sits open. A scheduled function sweeps `activeCalls` older than
their last tick + grace and closes them. Without it, a force-quit is a free call.

### 3.3 Host verification

```
submitHostCapture(captureUrl)         host, once
  → writes hostVerification/{uid}, status pending_ai

onHostCaptureSubmitted                Firestore trigger
  → runs the face comparison
  → score >= threshold  → verified,   users/{uid}.isVerifiedHost = true
  → score <  threshold  → pending_manual, queued for the CRM
  → provider error      → pending_manual (never auto-reject on a failure
                          that is ours, not the host's)

reviewHostVerification(uid, verdict)  CRM, staff only
  → verified | rejected, with a reason recorded against the reviewer
```

The comparison sits behind an interface with two implementations: an on-device
TFLite embedding model now, AWS Rekognition later. The function does not know
which is in use.

**Biometric data has rules.** Face images under India's DPDP Act need explicit
consent, a stated retention period and a deletion path. Captures should carry a
TTL and be deleted once a verdict is final — keeping them forever because
storage is cheap is the mistake.

### 3.4 Payout hold — decided: earnings pay one week in arrears

The refund exposure is real: refund the user *after* the host has been paid and
you lose the money twice.

**The design uses the weekly cadence you already have.** Earnings from week N are
paid at the end of week N+1. A gift on Monday waits about 13 days; a gift on
Sunday waits about 7. No new concept — the payout run simply covers the
*previous* completed week rather than the one just ended.

```
users/{uid}
  beans                 spendable / convertible now
  beansPendingPayout    earned, not yet released
  beansAvailable        released, withdrawable

releaseBeansForWeek     scheduled, Monday 00:30 IST
  → moves week N-1 earnings from pending to available
  → skips any host with an open dispute or unresolved verification
```

Three things this gives you at once:

1. Chargebacks land inside the window, so the money is still yours to withhold.
2. Unverified hosts accrue without being paid — the existing hold reuses the
   same field rather than needing its own.
3. A host can see *earned*, *pending* and *available* separately, which is more
   honest than one number that sometimes cannot be withdrawn.

**It must be visible before it is enforced.** Hosts used to weekly money will
read a silent delay as non-payment. The payout screen states the release date
from day one.

### 3.5 The CRM keeps everything

Privacy governs what a *user* sees. Finance and admin read the full record:
every gift with both uids, every call with duration and cost, every ledger row
with a running balance. That is the chargeback file, and it is the whole reason
`giftTransactions` stays readable by `isFinance() || isAdmin()`.

---

## 4. Ledger — the gap that decides disputes

| Path | Balance writes | Ledger rows today |
|---|---|---|
| Gifts | 21 | 1 → now complete via `settleGift` |
| Bean conversion | 2 | 1 |
| Bag purchases | 2 | 1 |
| **Calls** | 11 across two files | **0** |
| **Games** | 10 | **0** |

Calls move diamonds and write nothing. A user who recharges and spends it all on
calls leaves one recharge and an unexplained balance drop — there is no file to
send a bank.

Every row, from every path, carries:

```
type              credit | debit
amount
balanceAfter      so a timeline can be reconstructed, not asserted
reason            machine-readable
reasonLabel       human-readable
relatedUid        NOT just a display name — names change and repeat
context           live | call | dm | party | shop | reward
transactionId     ties the row to its settlement record
timestamp         server time
```

---

## 5. Rules

Closed, all of them:

```
users/{uid}                    balances not client-writable   ← the open hole
giftTransactions               read: parties + finance/admin; write: false
giftEvents                     read: room-scoped or parties;  write: false
giftPairs/{pair}/gifts         read: the two parties;         write: false
users/{uid}/giftShowcase       read: all;                     write: false
users/{uid}/topFans            read: all;                     write: false
activeCalls/{callId}           read: participants;            write: false
hostVerification/{uid}         read: self + staff;            write: false
```

`write: false` everywhere. Cloud Functions use the Admin SDK and bypass rules
entirely, so closing the client's write access costs nothing.

The `users/{uid}` owner clause is the one that matters. It currently permits a
user to raise their own diamonds, and the file says so. **It cannot close until
every path above is server-side** — which is what makes the build order below
an order rather than a list.

---

## 6. Build order

Each step leaves the app working.

1. **`settleGift`** — done. App still writes its own balances; nothing calls the
   function yet.
2. **Point the app at `settleGift`.** `GiftRepository.sendGift` becomes a call.
   Gifts are now server-settled.
3. **Calls: `startCall` / `tickCall` / `endCall` + the watchdog.** The largest
   piece and the biggest ledger gap.
4. **`convertBeans`, `claimDailyReward`, `purchaseBagItem`.** Small, same shape.
5. **Close the `users/{uid}` write rule.** Only now is it safe. This is the step
   that actually stops a user crediting themselves.
6. **Payout hold** — `beansPendingPayout` / `beansAvailable`, the release job,
   and the payout screen showing all three figures.
7. **Verification** — capture, trigger, CRM review queue, and the ten
   unverified restrictions.
8. **Games** — deferred until they ship, gated on level.

Steps 1–5 are the security work. Step 6 is the money-protection work. Step 7 is
the trust work. They are independent enough to reorder if something becomes
urgent, except that **5 cannot precede 2–4**.
