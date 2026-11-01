# Stage 1 — Owner MFA boundary fix: proposed implementation and test plan

**Status: proposal only.** No code changed. Awaiting approval of §2 (design choice) and §6 (open decisions).

## 1. What the fix must close (re-verified in the working tree today)

| Path | How a password-only Owner gets in | Evidence |
|---|---|---|
| Firestore rules | `crmRole()` returns `superadmin`, which every staff helper honours; ≥119 grants | `firestore.rules:43-45`, `207-260` |
| Firestore rules, second door | `hasPerm(p)` also passes on the caller's `crmUsers.permissions` array, which holds **every** permission for an Owner. Gating `crmRole()` alone would leave this open. | `firestore.rules:296-312` |
| Storage rules | `roleClaim() == 'owner'` → `isGovernance()` → every read tier (KYC, seller documents, money evidence) | `storage.rules:52-80` |
| Cloud Function | `backfillPublicProfiles` (callable) checks only `crmUsers.role == superadmin` | `functions/src/profiles.ts:~290-330` |
| Cloud Function (indirect) | `approverRefusal` trusts the approver's `crmUsers.role`. The approval itself is a client write to `approvalRequests`, so the rules fix closes it. No function change is needed. | `functions/src/index.ts:~3060-3090` |
| Backend API | already closed (P1-A3) | `deps._refuse_owner_without_mfa` |

`crmRole()` is the only place the rules read the caller's role (one match for `crmUsers/$(request.auth.uid)).data.get('role'`), so it is a true choke point. `hasPerm` is the one other caller-authority read.

## 2. Design choice (recommendation: B)

**A — custom claim** `mfa_at` on the Firebase account (my earlier proposal)
- Pro: no extra rules read.
- Con: claims refresh only with the ID token, so reset, sign-out and suspension take **up to 1h** to bite.
- Con: one claim per *account*, so the CRM and the Android app (different sign-ins) need a list.
- Con: it races with the Storage-claim writers, because both do a non-atomic read-modify-write.
- Con: it needs a forced token refresh after verify.

**B — server-only Firestore document `ownerMfaSessions/{uid}`** (recommended)
- **What it holds:**
  ```
  { sessions: { "<firebase auth_time>": { jti, client: "crm"|"android", expiresAt } },
    updatedAt }
  ```
  It is written only by the backend (Admin SDK). The rules deny every client read and write, Owners included.
- **How the rules check it:** an Owner's authority holds only if `string(request.auth.token.auth_time)` is a key and that entry has not expired. This is the same `auth_time` idea the rules already use in `sessionCurrent()` (`firestore.rules:574-598`).
- **Pro: revocation is immediate.** The rules read the document live, so reset, sign-out, suspension and deactivation bite on the next request, with no token-refresh dependency and no 1-hour staleness.
- **Pro: no claim writes, so no race.** Storage claims are untouched by construction.
- **Pro:** CRM and Android sign-ins coexist as separate entries.
- **Pro:** a new password sign-in gets a new `auth_time`, so an older verified entry is useless to it.
- **Con: one extra document read per Owner request.** Non-Owners never evaluate it, because the check short-circuits. Reads of the same document within one request are counted once.
- **Con: Storage needs a cross-service read** (`firestore.exists/get` in `storage.rules`). It must be enabled once at deploy (Firebase prompts for the IAM grant), and the Storage tests must run the Firestore emulator alongside.

**Fallback if you reject cross-service reads for Storage:** use B for Firestore and functions, and A (claim) for Storage only. Accept ≤1h Storage staleness after a reset.

## 3. Implementation (design B), file by file

**Backend**
- **`services/owner_mfa.py`:**
  - add `bind_firebase_session(user, id_token, client)`;
  - `firebase.verify_id_token(token)` already uses `check_revoked=True`;
  - require `decoded.uid == session uid` and an Owner role;
  - write `sessions[str(auth_time)] = {jti: <new API jti>, client, expiresAt: <API session expiry>}`, pruning expired entries and capping at 10;
  - add `unbind(uid, auth_time)` and `clear_all(uid)`.
- **`routers/auth.py`:**
  - `/mfa/verify` and `/mfa/enrol/confirm` accept an optional `firebase_id_token`. If present, bind it to the upgraded session.
  - The response adds `firestore_bound: bool`. Without a token, the API session is upgraded, Firestore stays locked, and the response says so.
  - `/signout` unbinds that session's `auth_time`.
- **`core/security.py`:**
  - the session record gains `firebase_auth_time` (written at bind);
  - `renew_session` carries it forward and extends that entry's `expiresAt`;
  - a renewal of an unbound session changes nothing.
- **`services/staff.py` `_change_status`** (suspend, deactivate) and `change_role` (away from Owner): call `clear_all`. Reactivation does not re-create entries; the Owner re-verifies.
- **`owner_mfa.reset_by_observer`:** call `clear_all`.
- **`db` registry:** constant `OWNER_MFA_SESSIONS = "ownerMfaSessions"` (Firestore).

**`firestore.rules`**
- **New helper:** `ownerMfaOk()` = the `ownerMfaSessions/{uid}` document exists, has `string(auth_time)` in `sessions`, and that entry's `expiresAt > request.time`.
- **`crmRole()`:**
  ```
  let r = get(crmUsers/uid).data.get('role','');
  return (r != 'superadmin' || ownerMfaOk()) ? r : 'superadmin_mfa_pending';
  ```
- **`hasPerm(p)`:** additionally require `crmRole() != 'superadmin_mfa_pending'`.
- **New block:** `match /ownerMfaSessions/{uid} { allow read, write: if false; }`.
- **No other grant is edited.** `isOwner(uid)` stays uid-based, so an Owner can still read their own `crmUsers` document; the login screen needs it.

**`storage.rules`**
- `roleClaim()` returns `owner` only when `firestore.exists(...)` passes **and** the session entry is valid. Otherwise it returns `''`.
- Every other claim value is unchanged.

**functions**
- `backfillPublicProfiles`: require a valid `ownerMfaSessions` entry for `context.auth.token.auth_time`, via a shared helper `ownerMfaVerified(uid, authTime)`.

**CRM**
- `api.auth.mfaVerify` / `mfaEnrolConfirm` send `firebase_id_token: await getAuth().currentUser?.getIdToken()`.
- No claim, so no forced refresh is needed.
- If the response has `firestore_bound: false`, show "Firestore screens are locked; sign in again".

**Android**
- `ApiClient.call`: for `MFA_VERIFY` / `MFA_ENROL_CONFIRM`, inject `firebase_id_token` (`auth.currentUser.getIdToken(false)`) into the body. It carries over the adoption already in place.
- The owner MFA module's note mentions that Firestore screens unlock after the code.
- The personal app (users, hosts, rooms) is unaffected: those rules use `isOwner`/`isAppUser`, not `superadmin`.

## 4. Stage 0 (prerequisite, test configuration only)

These suites currently target the production id `zipper-83816` (emulator-only in practice, but you've barred them):

| Suite | Where the id is | Proposed change |
|---|---|---|
| `test:firestore` | `tests/package.json` `--project zipper-83816`; `tests/firestore.rules.test.mjs` `projectId` | `--project demo-zipper`; `projectId: 'demo-zipper'` |
| `test:phase1a` | `package.json`; `tests/firestore.phase1a.rules.test.mjs:65` | same |
| `test:storage` | no `--project` flag (falls back to `.firebaserc` default `zipper-83816`); `tests/storage.rules.test.mjs:64` | add `--project demo-zipper`; `projectId: 'demo-zipper'`. Storage tests also run `--only storage,firestore` (needed for B) |

**Verification before running:**
- `grep -rn zipper-83816 tests/` returns nothing;
- each harness pins `127.0.0.1`.

**Note:** `firebase emulators:exec` with a `demo-` id never needs a login and never contacts a real project. This is what makes the change safe. `.firebaserc` itself is not changed: deploys use it.

## 5. Regression tests

**Rules: `tests/firestore.p1mfa.rules.test.mjs`** (new; `demo-zipper`; contexts made with `authenticatedContext(uid, { auth_time })`)
- **Pending Owner** (no document / wrong `auth_time` / expired entry) is **refused**:
  - another person's `crmUsers` document;
  - `withdrawalRequests` read;
  - collection-group `diamondTransactions`;
  - `agencies` update;
  - `appConfig` write;
  - `broadcasts` write;
  - `kycSubmissions` read;
  - `approvalRequests` update;
  - a `hasPerm('can_coin_operations')` path.
- **Verified Owner:** the same set is **allowed**.
- **Always allowed:** an Owner reading their own `crmUsers` document, pending or not.
- **Two sign-ins:** CRM `auth_time` A and Android `auth_time` B both allowed. Removing A leaves B allowed.
- **Department roles unaffected**, one per helper (app, ops, finance, tech, support, marketing, admin and member): identical before and after the change.
- **`ownerMfaSessions`:** no client may read or write it (Owner, staff, app user, signed out).
- **No regressions:** the existing p1gov (95), firestore, phase1a and ugp suites, after stage 0, all still pass.

**Storage: `tests/storage.p1mfa.rules.test.mjs`** (storage + firestore emulators, `demo-zipper`)
- Owner without an entry: KYC, seller-document and recharge-evidence reads **refused**.
- Owner with an entry: **allowed**.
- Finance, KYC-reviewer and partner claims: unchanged.

**Backend: `tests/test_p1_owner_mfa.py`** (extended)
- verify with a token binds its `auth_time`;
- a token for another uid → 403;
- an invalid or revoked token → 401, and nothing is bound;
- verify without a token → API upgraded, `firestore_bound: false`;
- **refresh** extends the entry and moves its `jti`;
- **sign-out** removes only its own entry;
- a second client's entry coexists;
- **reset / suspend / deactivate / role change away from Owner** remove the document;
- reactivation does not restore it;
- expired entries are pruned; the cap is 10;
- the Observer and department roles never touch the document.

**Functions: `functions/test/ownerMfa.test.js`**
- `backfillPublicProfiles` refuses an Owner without a valid entry;
- it accepts one with a valid entry.

**CRM**
- `tsc` passes;
- a small unit check that `mfaVerify` sends `firebase_id_token`.

**Android: `WorkModulesTest`**
- `ApiClient` injects `firebase_id_token` on both MFA paths (source check, matching the existing pattern);
- `./work-verify.command` passes.

## 6. Decisions needed before I start

1. **Approve design B**, including the Storage cross-service read and its one-time IAM grant at deploy. Or choose the claim fallback for Storage.
2. **Owner Firestore entry lifetime:** I propose it equals the API session expiry and is extended on each renewal (7 days today). A shorter fixed cap (for example 12h, then MFA again) is possible.
3. **Stage 0 approval:** switch the three suites to `demo-zipper` (test files only).

## 7. Rollout impact (documented now, nothing deployed)

- **Every Owner** loses Firestore/Storage authority at deploy until they verify MFA in the CRM (and separately in the Android app). The API already requires this, so the visible change is limited to "Firestore screens before verify".
- **Deploy order:**
  1. backend (bind routes; harmless alone);
  2. CRM and Android (send the token);
  3. functions;
  4. `firestore.rules` + `storage.rules`, which is the moment Owners need a bound session.
- **Residual after the fix:**
  - an Owner who skips sending the token (an old CRM tab) gets API access but no Firestore access, by design;
  - the backend's own Admin SDK paths are already MFA-gated at the API.
