# Zipper Backend — Architecture

## The split

Three systems, each doing what it is genuinely best at. The boundary is deliberate.

| System | Owns | Why |
|---|---|---|
| **Firebase Auth** | Identity for everyone — app users, CRM staff, partners | Already works, handles phone/Google/email, token verification is solved |
| **Firestore** | App runtime state — live rooms, chat, presence, profiles, and the balances the app *reads* | Real-time listeners, offline sync, low latency to the app |
| **MongoDB + FastAPI** | The business record — ledger, audit log, approval cards, partner records, reporting | Transactions across documents, aggregation, ad-hoc queries, append-only guarantees |

## Source of truth for money

**MongoDB is the ledger. Firestore is a read replica of balances.**

1. A money mutation calls the Python API.
2. The API runs one **MongoDB transaction**: apply the balance change *and* write the audit entry. Both commit or neither does.
3. The API then syncs the new balance to Firestore so the app sees it.
4. If the sync fails, the ledger is still correct and a reconciliation job repairs Firestore. The reverse — Firestore correct, ledger missing — is never possible.

This is what makes the audit log binding rather than advisory. There is no code path that moves money without writing history.

## The rule

**No client ever writes money.** Not the CRM browser, not the Android app. They call the API. Firestore rules deny balance writes to everyone except the service account.

## Why not stay entirely on Cloud Functions

Cloud Functions would work for the money core. Mongo is added because the *business record* half of the product needs things Firestore genuinely cannot do:

- Aggregation for reporting — P&L, channel margin, partner statements — without shipping documents to a client
- Substring search on users and partners
- Ad-hoc queries without pre-declaring an index for every filter combination
- Append-only collections with real transactional guarantees across documents

Firestore stays for what it is genuinely better at: real-time app state.

## What runs where

```
Android app ──────► Firebase Auth (login)
            ├─────► Firestore (live rooms, chat, presence, read balances)
            └─────► Python API (all money, all rewards, all game outcomes)

CRM browser ──────► Firebase Auth (login)
            ├─────► Firestore (read-only app state where useful)
            └─────► Python API (everything else — cards, ledger, audit, reports)

Python API ───────► MongoDB (ledger, audit, cards, partners, reporting)
           ├──────► Firestore (sync balances, push app-facing config)
           └──────► Firebase Auth Admin (verify tokens, manage accounts)
```

## Deployment

- **Python API** → Cloud Run. Containerised, scales to zero, sits behind a Firebase Hosting rewrite at `/api/**` so it shares the domain.
- **MongoDB** → Atlas, region matching the app's users (`ap-south-1`, Mumbai).
- **CRM** → Firebase Hosting, unchanged.
- **Existing Cloud Functions** → retained for Firestore triggers and scheduled jobs that belong close to Firestore.

## Note on region

Firestore currently sits in `asia-east1` (Taiwan) while users are in India — roughly 150 ms per round trip. Mongo Atlas should be provisioned in Mumbai. Moving Firestore to `asia-south1` is a separate task and worth doing while there is no live data.
