# Firestore Setup Guide — Zippern

This document lists every manual step required in Firebase Console before the app works correctly.

---

## 1. Create `platformStats/global` document

**Path:** `platformStats` → document ID `global`

This document must exist before any call settles or gift is sent. `FieldValue.increment` will create missing fields automatically but will fail if the document itself doesn't exist.

Go to Firebase Console → Firestore → Start collection → `platformStats` → Document ID: `global`

Add these fields (all **number**, value **0**):

| Field | Type | Initial Value |
|---|---|---|
| `totalRevenueDiamonds` | number | 0 |
| `callRevenueDiamonds` | number | 0 |
| `giftRevenueDiamonds` | number | 0 |
| `normalGiftRevenue` | number | 0 |
| `luckyGiftRevenue` | number | 0 |
| `luckyGiftDiamondsBack` | number | 0 |
| `specialGiftRevenue` | number | 0 |
| `totalCallsSettled` | number | 0 |
| `totalGiftsSent` | number | 0 |
| `totalBetsPlaced` | number | 0 |
| `totalBetsSettled` | number | 0 |
| `totalBetDiamonds` | number | 0 |
| `totalBetPayouts` | number | 0 |
| `gamingRevenueDiamonds` | number | 0 |

---

## 2. Collections created automatically by the app

These collections are created on first write — no manual setup needed:

| Collection | Created when |
|---|---|
| `users` | User registers |
| `callHistory` | First call settles |
| `giftEvents` | First gift is sent |
| `platformRevenue` | First call or gift transaction |
| `gamingBets` | First bet placed |

---

## 3. Required fields on every `users` document

These fields must exist on a user's Firestore document for the economy engine to work. They are set during registration / profile setup.

| Field | Type | Notes |
|---|---|---|
| `uid` | string | Firebase Auth UID |
| `gender` | string | `"male"` / `"female"` / `"transgender"` |
| `isHost` | boolean | `false` by default; set to `true` by admin when host is approved |
| `diamonds` | number | Start at `0`; topped up offline via coin sellers |
| `beans` | number | Start at `0`; incremented by call/gift rewards |
| `callRateBeans` | number | **Hosts only.** Beans/min they want to earn. Default `800` for female host, `800` for male host (cost to caller differs by gender — see EconomyEngine). Leave `0` or omit for regular users. |
| `totalGiftsReceived` | number | Start at `0` |
| `totalGiftsSent` | number | Start at `0` |
| `totalXp` | number | Start at `0` — cumulative diamond spend (user level XP) |
| `totalBeansEarned` | number | Start at `0` — cumulative beans earned, never decreases (host level XP) |

---

## 4. `gifts` collection — seed the gift catalogue

Gifts are fetched from Firestore, not hardcoded. Add each gift as a document in the `gifts` collection.

| Field | Type | Example |
|---|---|---|
| `name` | string | `"Rose"` |
| `costDiamonds` | number | `10` |
| `isLucky` | boolean | `false` |
| `animationUrl` | string | Firebase Storage URL to Lottie/SVGA file |
| `category` | string | `"normal"` / `"lucky"` / `"special"` |

---

## 5. Firestore Security Rules (minimum)

Add these rules in Firebase Console → Firestore → Rules:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Users can read/write their own document
    match /users/{uid} {
      allow read: if request.auth != null;
      allow write: if request.auth.uid == uid;
    }

    // Gift events: authenticated users can read and write
    // (written via batched transaction from app — same batch as diamond deduction)
    match /giftEvents/{id} {
      allow read: if request.auth != null;
      allow write: if request.auth != null;
    }

    // Call history: users can read their own records; app writes via batch
    match /callHistory/{id} {
      allow read: if request.auth != null
                  && (resource.data.callerUid == request.auth.uid
                   || resource.data.receiverUid == request.auth.uid);
      allow write: if request.auth != null;
    }

    // Platform revenue log — written by app batch on every call/gift transaction.
    // READ is blocked from client entirely; superadmin CRM reads via Firebase Admin SDK
    // (service account bypasses all security rules).
    match /platformRevenue/{id} {
      allow read: if false;
      allow write: if request.auth != null;
    }

    // Platform stats (running totals for CRM dashboard) — same as above.
    match /platformStats/{id} {
      allow read: if false;
      allow write: if request.auth != null;
    }

    // Gifts catalogue: everyone authenticated can read, no client writes
    match /gifts/{id} {
      allow read: if request.auth != null;
      allow write: if false;
    }
  }
}
```

> **Why platformRevenue/platformStats allow client writes:**
> Revenue documents are written inside the same atomic Firestore batch as the diamond deduction and bean credit. If you block these writes, the entire batch fails and calls/gifts stop working. The data is safe because it comes from your app's own transaction logic — users cannot craft arbitrary writes since the values (platformCut, grossDiamonds, etc.) are computed server-side in the batch.
>
> **How superadmin CRM reads this data:**
> Your CRM backend must use the **Firebase Admin SDK** with a service account. Admin SDK bypasses all security rules, so `allow read: if false` on the client side does not block your CRM. Never expose the service account key in the Android app.
>
> **Future hardening:** Once you move revenue writes to Cloud Functions, change `allow write: if request.auth != null` back to `allow write: if false` on both collections.

---

## 6. Indexes needed

Firestore will prompt you in Logcat the first time a query fails due to a missing index. The ones we know are needed:

| Collection | Fields | Order |
|---|---|---|
| `callHistory` | `callerUid` ASC, `timestamp` DESC | For call history screen |
| `callHistory` | `receiverUid` ASC, `timestamp` DESC | For call history screen |
| `giftEvents` | `roomId` ASC, `timestamp` DESC | For live room gift feed |
| `platformRevenue` | `type` ASC, `timestamp` DESC | For admin dashboard |
| `gamingBets` | `uid` ASC, `placedAt` DESC | For user's bet history |
| `gamingBets` | `gameId` ASC, `placedAt` DESC | For per-game analytics |
