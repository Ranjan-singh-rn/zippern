# ZIPPER — Business and financial flow

Updated 4 Nov 2026. How money and value move through ZIPPER, where each movement is recorded, and how the records
reconcile. Every claim points at the code that does it. Nothing here was deployed in this phase.

## 1. The four currencies

| Currency | Who holds it | What it is | Ledger of record |
|---|---|---|---|
| **Diamonds** | users | the spending currency (calls, gifts, games, Party Pro) | Firestore wallet `users/{uid}.diamonds` + `users/{uid}/diamondTransactions`; backend movements in MongoDB (`services/money.py`, `Currency.DIAMONDS`) |
| **Beans** | hosts | the earning currency (gift and call shares, ranking rewards) | `users/{uid}.beans`, `weeklyEarnings`, payout reports; MongoDB `Currency.BEANS` |
| **Coins** | coin sellers | seller inventory, sold to users as diamonds | MongoDB `Currency.COINS` (`HolderType.SELLER`) + Firestore seller mirror |
| **Agency commission** | agencies | paise owed to agencies | MongoDB (minor units) + `agencies.commissionBalance` |

Rule: **no client writes a balance**. Every balance moves in a server transaction (Cloud Function or backend) that
writes a ledger row with a deterministic id or idempotency key in the same commit.

## 2. Flows

### 2.1 Buying diamonds
* From a **coin seller**: the user files a purchase request; the seller approves; the backend moves the seller's
  coins and credits the user's diamonds in one `apply_movement` with an idempotency key, then syncs Firestore
  (`services/recharges.py`). Refused at filing and at approval when the buyer is the seller (B2b).
* The seller's "Total sold" now reaches Firestore (B9 bug fix).

### 2.2 Coin-seller business (B9)
* **Zipper → seller**: owner-signed cards (`_raise` → `_card_ready` → `_move_once`); a tiered seller is checked at
  the tier's ₹-per-lakh price (`appConfig/economy.sellerTiers`).
* **Seller → seller trades**: the buyer files with a payment reference; the selling seller may dispute; Finance
  rejects or the Owner approves; only then `strade:{id}:debit` / `strade:{id}:credit`, once. Refused: self, same
  person's second record, circular within 7 days, reused UTR, overdue buyer.
* **Borrowing**: Owner sets a credit limit; a seller requests within headroom for ≤ 30 days → an owner-signed lending
  card; recovery / write-off as before; a new loan never pushes back an earlier due date.
* **Self-use** (Owner switch, default off): coins to the seller's own wallet — never counted as a sale.
* **Profit**: purchase cost, revenue (recharges, sales, trades), cost of sold at average cost, gross profit.

### 2.3 Spending
| Spend | Callable | Debit | Credit | Rows |
|---|---|---|---|---|
| Video call | call billing (`calls.ts`) | caller diamonds per started minute (first at connect, then every 60 s) | host beans (call rate share) | call ledger rows, `weeklyEarnings`, rankings accrual (B8) |
| Free-call card | same | none — the card pays the first minute | host paid; Zipper's cost recorded as a promo | `promoCredits/{id}` (B2c) |
| Gift | `settleGift` (`gifts.ts`) | sender diamonds `unit × qty` | receiver beans `floor(cost × pct / 100)` (gift `earningRate`, else category rate, else 50) | `giftTransactions`, both histories, `giftEvents`, room mirror, revenue, rankings accrual, **PK score** (B12) |
| Game entry / stake | `games/*` | player diamonds | — | `diamondTransactions` + `gameLedger` (B3) |
| Party Pro | `subscribePrivateRooms` | diamonds at the economy's diamond price for ₹200 | Zipper revenue | `subscriptionPayments`, revenue row, idempotent (B7) |

A live gift is refused, with nothing moved, when the room has ended, the receiver is not on screen, or the sender
was removed or blocked by the host (B12).

### 2.4 Earning and payout (hosts)
Beans accrue per gift and per call minute into the IST week (`users/{uid}/weeklyEarnings`); the weekly release and
payout reports move them to payable (existing payout pipeline, verified in Track A).

### 2.5 Promotions — the cost Zipper carries (B2c, B8)
Daily check-in diamonds, free-call cards and ranking rewards are **not purchases**, so they used to vanish from
Finance's view. Each now writes `promoCredits/{deterministicId}` in the same transaction as the credit; the backend
`GET /api/reports/promotions` totals them (diamonds; host beans valued at the bean rate) and the CRM shows them.

### 2.6 Games (B3–B6)
Multiplayer: entries are held by the match; at the end the pool less the platform fee goes to the winner(s)
(100 + 100 → winner 150, Zipper 50 at 25 %). Instant: stake debited, win credited (no row for a loss); the return to
player is `1 − house edge`. Details in `ZIPPER-GAME-ECONOMY-AND-LEDGER.md`.

### 2.7 Rankings (B8)
At 00:15 IST the closed periods are settled once (`leaderboardSettlements/{id}`); each reward is an `lb_{id}`
diamond or bean row plus a `promoCredits` row; restricted/excluded accounts are skipped and recorded.

## 3. Reconciliation

| Check | Where | Status |
|---|---|---|
| Every game match: Σ entries = Σ payouts + fee (+ refunds) | `checkSettlement` before any settlement write; CRM games report per-match | unit-tested |
| Gift: sender debit = Σ(receiver credit + platform margin) | `settleGift` rows tied by one transaction id | unit-tested (`settleGiftNormal`) |
| Promotions visible to Finance | `promoCredits` ↔ promotions report | unit-tested (backend `test_b2c_promotions`) |
| Seller trades and lending | MongoDB movements with deterministic keys; Firestore mirrors | unit-tested (`test_b9_seller_business`) |
| MongoDB ledger ↔ Firestore balances | movements commit in MongoDB first, then mirror to Firestore | existing; a full-stack reconciliation run is part of the B11 emulator E2E (pending) |

**Never** is a balance edited to make a report match: a mismatch is reported, not corrected silently.
