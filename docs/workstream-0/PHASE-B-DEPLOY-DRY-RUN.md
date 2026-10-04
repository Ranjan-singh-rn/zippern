# ZIPPER — Firebase Phase-B Deployment Dry Run

**Nothing deployed. No rules, no indexes, no functions, no production data touched.
`ENFORCE_MOBILE_SESSION` untouched. No Android or business-logic change.**

---

## RESULT

> ## BLOCKED — but only on two checks you can clear in about ten minutes

The Phase-B code itself is deploy-ready: 86 functions resolve cleanly from the
build artifact, all 9 Phase-B functions are correctly defined/exported/regioned,
every Phase-B query has an index, and the four new rule blocks are closed
correctly.

What blocks it is that **two questions cannot be answered from this machine, and
both can destroy things if guessed wrong**:

| # | Blocker | Why it blocks | How you clear it |
|---|---|---|---|
| **D1** | **The delete set is unknown.** An unfiltered `firebase deploy --only functions` deletes every deployed function missing from the new source. I cannot see the deployed project, and git holds **no record** of the previously deployed surface. | Phase B removed three Quick Login callables. If they are live, they get deleted — and anything still calling them breaks. | Run the two read-only commands in §7 Step 1. |
| **D2** | **9 functions are 2nd-gen.** Firebase **cannot** change a function's generation in place. If any of those 9 names is deployed as 1st-gen today, the deploy **fails mid-flight** — after some functions have already updated. | `settleGift`, `startCall`, `acceptCall`, `endCall`, `tickCall`, `declineCall` are money-path functions, very likely already deployed and plausibly originally v1. | Same two commands. |

Neither is a defect in Phase B. Both are "look before you leap", and the first
deploy is safe once you have looked.

**The debug APK can test most of Phase B, with two real limits — see §6.**

---

## 1. Dry run — what could actually be executed

**No real Firebase preview was possible here.**

```
firebase CLI     NOT INSTALLED
gcloud           NOT INSTALLED
npx firebase     npm error 403 Forbidden (registry blocked)
CLI credentials  none
network          firebase.googleapis.com -> 000 (no route)
```

Attempted and failed: `firebase deploy --only functions --dry-run`,
`firebase deploy --only firestore:rules --dry-run`.

Local deployment-state evidence amounts to two **hosting** caches from 30 Sep.
`.firebaserc` `etags` is empty. No `firebase-debug.log`. **Nothing records the
deployed Functions, rules or index state.**

So everything below is derived from the **build artifact itself** —
`functions/lib/index.js`, loaded and inspected, which is literally what gets
uploaded — plus the config files. That is authoritative about what *would be
sent*. It is silent about what is *already there*.

---

## 2. Configuration inspected

| File | Finding |
|---|---|
| `firebase.json` | Functions source `functions`, codebase `default`, `predeploy` runs `npm run build` (so stale `lib/` cannot ship). `ignore` excludes `node_modules`, `entry-lotties`, `entry-video`, `entry-thumbnails`, `scripts` — upload payload **≈2.3 MB**. Emulator ports configured. |
| `.firebaserc` | **Single project `zipper-83816`** for everything. No staging. |
| `firestore.rules` | 3,015 lines, 98 `match` blocks, 55 helper functions. |
| `firestore.indexes.json` | 43 composite indexes, 3 `fieldOverrides`. Valid JSON. |
| `functions/package.json` | `main: lib/index.js`, `engines.node: 22`, `firebase-functions 4.9.0`, `firebase-admin 12.7.0`, TypeScript 5.9.3. |
| `functions/src/index.ts` | Re-exports everything; **0 functions defined-but-not-exported**, 0 duplicates, 0 exports referencing deleted code. |
| `storage.rules` | 443 lines. **Two findings — see §3 production-data risk.** |

---

## 3. What would be deployed

### 3.1 Functions — 86 total, read from the deploy artifact

| Generation / kind | Count |
|---|---|
| v1 callable | 40 |
| v1 event (Firestore triggers) | 21 |
| v1 scheduled | 16 |
| **v2 callable (2nd gen)** | **9** |
| **Total** | **86** |

**Would be CREATED** — new in Phase B, certain, because the name did not exist
before:

```
submitAccountAppeal     v1 callable   asia-south1    ← A5, brand new
quickLoginChallenge     v1 callable   asia-south1    ← Phase B, brand new
```

**Would be UPDATED** — same name, changed behaviour:

```
redeemQuickLogin        v1 callable   asia-south1    ← signature now REQUIRED
mintQuickLoginToken     v1 callable   asia-south1    ← publicKey now REQUIRED
revokeQuickLogin        v1 callable   asia-south1    ← allDevices added
startMobileSession      v1 callable   asia-south1    ← stamps credentialsValidAfter, revokes displaced
endMobileSession        v1 callable   asia-south1
revokeQuickLoginOnRestriction  v1 firestore users/{uid} onWrite  ← now DELETION-ONLY
sweepQuickLoginTokens   v1 scheduled  asia-south1  30 4 * * *   ← now sweeps 3 collections
```

Plus the other 77, updated or unchanged depending on deployed state.

**Would be DELETED — UNKNOWN. This is blocker D1.**

Phase B removed three Quick Login callables from `identity.ts`. If they are live,
an unfiltered deploy deletes them. I could not recover their names:

- `functions/` was **never tracked** before the baseline commit, so git has no
  prior version of the export list;
- the June Android app made **zero** `getHttpsCallable` calls, so the client
  gives no clue either;
- `functions/lib` mirrors `src` exactly — no orphaned compiled files;
- the `archive/v4-production` branch is a different generation (`index.js`).

Only the live project knows. §7 Step 1 asks it.

### 3.2 Firestore rules

**Changes cannot be diffed** — `firestore.rules` was untracked until the baseline
commit, so there is no previous version to compare against, and the deployed
ruleset is unreadable from here.

What the file contains for Phase B, verified by brace-balanced extraction (not
substring matching):

```
match /quickLoginTokens/{tokenHash}      allow read, write: if false;
match /quickLoginChallenges/{challengeId} allow read, write: if false;
match /quickLoginRate/{bindingHash}      allow read, write: if false;
match /authEvents/{eventId}              allow read: if isStaff();
                                         allow write: if false;
```

All four are correct: credentials, challenges and rate counters are **completely
closed to clients** (only the Admin SDK touches them, which bypasses rules by
design); `authEvents` is staff-readable and client-unwritable.

The Phase-A session gate:

```
sessionCurrent()   auth_time >= users/{uid}.credentialsValidAfter   (default 0)
isActiveAppUser()  isAppUser() && notBanned() && sessionCurrent()
```

`credentialsValidAfter` appears **3 times** — once in the gate and on both
protected-field lists, so an account cannot zero its own cut-off.

**Deploying rules is atomic and overwrites the live ruleset.** The previous
ruleset is retained in Firebase's rules history and can be rolled back from the
console. **No rule in this repo has ever been compiled** — there is no emulator
here — so the deploy itself is the first compile. A syntax error would be
rejected by the server before taking effect, but a *semantic* mistake would not.

### 3.3 Firestore indexes

43 composite indexes declared. Phase-B-relevant:

```
appeals           subjectUid ASC, createdAt DESC     ← NEW (A5)
quickLoginTokens  uid ASC, deviceId ASC              ← pre-existing, still needed
```

**Index coverage verified against every Phase-B server query:**

| Query | Index needed | Present |
|---|---|---|
| `quickLoginTokens where uid== and deviceId==` (`retireOthers`, displacement revoke) | composite | ✓ |
| `quickLoginTokens where uid==` limit 100 (revoke allDevices) | single-field | ✓ auto |
| `quickLoginTokens where expiresAt<=` (sweeper) | single-field | ✓ auto |
| `quickLoginChallenges where expiresAt<=` (sweeper) | single-field | ✓ auto |
| `quickLoginRate where updatedAt<=` (sweeper) | single-field | ✓ auto |
| `appeals where subjectUid== and status==` (dedupe) | equality-only → merged single-field | ✓ auto |
| `appeals where subjectUid== orderBy createdAt desc` | **composite** | ✓ **the new one** |
| everything else | `.doc(id)` gets | n/a |

**No missing index.** Nothing in Phase B will throw `FAILED_PRECONDITION` for a
missing index.

### 3.4 Destructive operations

| Operation | Destructive? | Notes |
|---|---|---|
| Function create/update | No | New revision; traffic shifts atomically per function |
| **Function delete** | **YES** | Permanent. Triggered by removed exports. **D1.** |
| **v1→v2 generation change** | **YES — fails the deploy** | Firebase refuses in place; requires deleting the v1 function first. **D2.** |
| Rules deploy | Overwrites, reversible | Old ruleset kept in rules history |
| Index create | No | Additive, background build |
| **Index delete** | **Possible** | Recent CLI versions prompt to delete indexes present in the project but absent from the file. 43 declared; the live set is unknown. Answer **"no"** on the first pass. |
| Storage rules deploy | Overwrites | **Not needed for Phase B — do not include it.** |

### 3.5 Production-data risk

**No Phase-B function writes to or migrates existing production data.** New
collections only (`quickLoginChallenges`, `quickLoginRate`, `authEvents`), plus
appends to `appeals` and one new field on `users/{uid}`
(`credentialsValidAfter`) written at sign-in.

Legacy credentials need **no migration**: they are classified `legacy`, refused,
and cleared from the device (14/14 checks verified, executed in the runtime
suite). Accounts with no `credentialsValidAfter` default to 0 and are unaffected
— no flag day, no mass lockout.

**Three real risks, in order:**

1. **The debug APK talks to production.** `zipper-83816` is the only project.
   Testing on your phone creates real `users` documents, real `authEvents`, real
   `quickLoginTokens`, and **will displace your own live session** if you sign in
   as an account that is signed in elsewhere. Use a throwaway test account.

2. **`sweepQuickLoginTokens` deletes on a schedule** (04:30 Asia/Kolkata). It is
   bounded (400/batch, 10 passes) and only touches expired documents — but it
   now sweeps three collections instead of one. First run after deploy will
   clear accumulated expired credentials. Expected, not a defect.

3. **Pre-existing, unrelated to Phase B, and worth your attention:**
   `storage.rules` makes **KYC identity documents world-readable** —

   ```
   match /kyc/agencies/signup/{fileName}   allow read: if true;
                                           allow write: if isDocument() && maxSize(10);
   match /sellerDocs/signup/{fileName}     allow read: if true;
                                           allow write: if isDocument() && maxSize(10);
   ```

   The rule documents its reasoning (an unauthenticated uploader needs
   `getDownloadURL`, and Storage rules apply to that call) and offers
   "filenames include timestamps — not guessable by outsiders" as mitigation.
   That is security by obscurity over identity documents, and the **unauthenticated
   `write`** is an open upload primitive (storage-cost abuse, arbitrary file
   hosting under your bucket).

   **Not changed** — out of scope, and storage rules are not part of this
   deployment. The conventional fix is a server-issued signed URL, or an
   unguessable server-generated path token, so public read is unnecessary.
   `/appBuilds/{path=**}` being publicly readable is fine — that is the OTA
   download.

---

## 4. Special attention

| Area | Status |
|---|---|
| **Quick Login functions** | `quickLoginChallenge` (new), `mintQuickLoginToken`, `redeemQuickLogin`, `revokeQuickLogin` — all v1 callable, `asia-south1`. Consumption is now atomic (transaction); 69 runtime tests pass against the real handlers. |
| **Mobile session functions** | `startMobileSession`, `endMobileSession` — v1 callable, `asia-south1`. `startMobileSession` stamps `credentialsValidAfter` from the caller's own `auth_time` and revokes the displaced device's credentials. |
| **`submitAccountAppeal`** | **New.** v1 callable, `asia-south1`. Unauthenticated by design, authenticated by device signature. Writes `appeals` with `status: 'pending'` using exactly the `appealFields()` allowlist. Never mints a session (verified by execution). |
| **Credential/session revocation** | `revokeQuickLoginOnRestriction` (v1 Firestore `users/{uid}` onWrite) is now **deletion-only** — ban and suspension keep the credential as the A5 appeal proof. `revokeQuickLogin` checks ownership. |
| **Existing callable exports** | 86 resolve; **0** defined-but-unexported, **0** duplicates, **0** stale references. Region: 77 `asia-south1`, 9 unset. |
| **Phase-B rules** | All four blocks verified closed/staff-only as shown in §3.2. |

### One pre-existing inconsistency found, not Phase B

**9 scheduled functions have no explicit region** and would deploy to
`us-central1` while all data lives in `asia-south1`:
`dailyPlatformStatsAggregator`, `scheduledAlertScan`, `scheduledDailyReports`,
`scheduledMonthlyReports`, `scheduledPartnerStatements`,
`scheduledReconciliation`, `scheduledTransactionalSweep`,
`scheduledWeeklyBusinessReport`, `weeklyPayoutReportGenerator`.

Functionally harmless — Cloud Scheduler invokes them, no client calls them — but
it costs cross-region latency and egress on every run. `sweepQuickLoginTokens`
is correctly `asia-south1`. Worth tidying later; **not a blocker**.

---

## 5. Not done

No function deployed. No rules deployed. No indexes deployed. No production data
modified. `ENFORCE_MOBILE_SESSION` not enabled and not present in any `.env`. No
Android code touched. No business logic touched.

---

## 6. Can the debug APK test Phase B?

> ### Mostly yes — with two limits you need to know before you start

### It will authenticate

| Check | Result |
|---|---|
| `applicationId` | `com.zipper.app`, **no `applicationIdSuffix`** — debug and release share the package name, matching `google-services.json` |
| Project | `zipper-83816` — the same project the functions deploy to |
| Registered Android cert hashes | **2**, and **both are documented in `FINGERPRINTS.md`** — one labelled debug, one release/upload |
| Web OAuth client | present (`client_type: 3`) → Google Sign-In workable |
| Auth providers used | Phone OTP, Google, anonymous, custom token — all available |

**One thing to verify first.** `FINGERPRINTS.md` documents **four** SHA-1s but
only **two** are registered. If your machine's debug keystore is one of the two
*unregistered* ones, Google Sign-In fails with `ApiException: 10`. Confirm:

```bash
keytool -list -v -keystore ~/.android/debug.keystore \
        -alias androiddebugkey -storepass android -keypass android | grep SHA1
```

and check it matches a hash in `zipper-app/app/google-services.json`. Phone OTP
is unaffected either way.

### What it can test, once functions are deployed

- **Normal logout → Quick Login.** Note the ordering: a fresh install holds no
  credential, so it must be sign in → sign out (which mints it) → Quick Login.
- **Rotation and replay** — the old credential dies on use.
- **Device transfer refusal** — needs a second handset or a cloned install.
- **Ban / suspension screens and the A5 appeal**, via the CRM to set state.
- **Device-ban message**, distinct from the account-ban message.
- **Account switching** after a block.

### Limit 1 — displacement is only half-testable

`ENFORCE_MOBILE_SESSION` is unset, so the presented-session check runs in
tolerant mode: a caller sending **no** session id is allowed through and the
omission is logged.

What **does** work today, because it does not depend on the flag:
`startMobileSession` overwriting `activeMobileSession`, revoking the displaced
device's quick-login credentials, and stamping `credentialsValidAfter` — which
the **rules** then use to refuse the displaced device's direct Firestore writes.
So Phone A → Phone B displacement is observable. What is *not* exercised is the
callable-level refusal.

### Limit 2 — the client does not yet send `sessionId`, and this changes your rollout

Four callables enforce the presented session:

```
startCall   settleGift   convertBeans   purchaseBagItem
```

The Android client sends `sessionId` to **exactly one** callable —
`endMobileSession` — which is **not one of those four**. Verified across all 24
wrapped callables in `MoneyFunctions.kt`.

From the shipped `sessionVerdict`:

```
recorded=A  presented=(none)  enforcing=false  ->  missing_tolerated   (today: allowed)
recorded=A  presented=(none)  enforcing=true   ->  missing_refused     (would REFUSE)
```

**So enabling `ENFORCE_MOBILE_SESSION=true` with the current Phase-B build would
break gifting, calls, bean conversion and cosmetic purchases platform-wide.**

This means **rollout step 6 — "Confirm `sessionId` is sent by supported
clients" — is NOT satisfied by this build.** The Android client must include
`sessionId` in those four payloads before the flag can ever be turned on. That
is an Android change, which this task forbids, so it is reported rather than
made. It does not affect today's testing: the flag stays off and the four
callables keep working.

---

## 7. Exact command sequence for the next step

**Not executed.** Run from the repo root with `firebase login` already done.

### Step 1 — answer D1 and D2 (read-only, nothing changes)

```bash
firebase --version
firebase projects:list
firebase functions:list --project zipper-83816
```

`functions:list` prints every deployed function with its **generation** and
region. From it:

- **D1:** anything deployed but absent from §3.1's 86 is in the delete set.
  Expect the three removed Quick Login callables.
- **D2:** check `settleGift`, `startCall`, `acceptCall`, `declineCall`, `endCall`,
  `tickCall`, `recoverAccount`, `requestAccountDeletion`, `purgeMyAccountNow`.
  **If any shows as 1st gen, stop** — delete it explicitly before deploying, or
  the deploy fails part-way.

```bash
firebase firestore:indexes --project zipper-83816 > /tmp/live-indexes.json
diff <(jq -S '.indexes' /tmp/live-indexes.json) <(jq -S '.indexes' firestore.indexes.json)
```

### Step 2 — deploy ONLY the Phase-B functions, by name

Explicit filters mean **no deletion prompt can fire** and no unrelated function
is touched.

```bash
firebase deploy --project zipper-83816 --only \
functions:quickLoginChallenge,\
functions:mintQuickLoginToken,\
functions:redeemQuickLogin,\
functions:revokeQuickLogin,\
functions:submitAccountAppeal,\
functions:startMobileSession,\
functions:endMobileSession,\
functions:revokeQuickLoginOnRestriction,\
functions:sweepQuickLoginTokens
```

### Step 3 — the appeals index (additive, background build)

```bash
firebase deploy --only firestore:indexes --project zipper-83816
```

If prompted to **delete** indexes not in the file, answer **no** and reconcile
using the Step 1 diff first.

### Step 4 — rules (atomic overwrite; note the current ruleset ID first)

```bash
# record the rollback point from the console:
#   Firestore -> Rules -> History
firebase deploy --only firestore:rules --project zipper-83816
```

### Step 5 — test on the phone

```bash
cd zipper-app && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb logcat -c && adb logcat | grep -iE "zipper|quicklogin|firebase"
```

Sequence: sign in → sign out → Quick Login → confirm rotation →
(second device) displacement → CRM-set suspension → appeal.

### Step 6 — watch the server

```bash
firebase functions:log --only redeemQuickLogin,submitAccountAppeal,startMobileSession \
  --project zipper-83816
```

Then inspect `authEvents` in the console for `QUICK_LOGIN_SUCCESS`,
`QUICK_LOGIN_ROTATED`, `QUICK_LOGIN_RACE_LOST`, `ACCOUNT_APPEAL_SUBMITTED`.

### Do NOT run yet

```bash
# NOT in this pass — breaks gifting/calls/wallet until the client sends sessionId
#   ENFORCE_MOBILE_SESSION=true
# NOT needed for Phase B, and would ship the KYC public-read rules as-is
#   firebase deploy --only storage
# NEVER as the first deploy — this is what deletes functions
#   firebase deploy --only functions
```

### Rollback

```bash
# Rules: Firestore -> Rules -> History -> restore the recorded ruleset
# Functions: redeploy the previous source, or
firebase functions:delete submitAccountAppeal quickLoginChallenge \
  --project zipper-83816 --region asia-south1
# Indexes: delete from the console; index deletion is safe and non-destructive to data
```

---

## 8. Summary

| | |
|---|---|
| **Verdict** | **BLOCKED** on D1 (unknown delete set) and D2 (v1→v2 generation change) |
| Both clear via | `firebase functions:list` — read-only, one command |
| Functions that would be created | `submitAccountAppeal`, `quickLoginChallenge` |
| Functions that would be updated | 7 Phase-B/auth functions (+ up to 77 others) |
| Functions that would be deleted | **UNKNOWN — D1.** Expect the 3 removed Quick Login callables |
| Rules changes | 4 new closed blocks + the Phase-A session gate; **cannot be diffed**, never compiled |
| Indexes to create | `appeals (subjectUid ASC, createdAt DESC)`; 42 others already declared |
| Missing indexes | **None** — every Phase-B query is covered |
| Destructive operations | function deletion (D1), generation change (D2), possible index-delete prompt |
| Production-data risk from Phase B | **None** — no migration, legacy credentials refused safely |
| Other production risk | Debug APK hits production; **KYC documents world-readable in `storage.rules`** (pre-existing) |
| Debug APK can test Phase B | **Yes**, minus callable-level displacement; verify your debug SHA-1 first |
| Tests | Functions **425/425**, 0 fail, 0 todo; backend **8,433** checks, 0 fail; tsc + build clean |
