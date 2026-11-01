# Owner MFA — per-session `mfa_sid` architecture (proposal, NOT implemented)

25 Oct 2026. **For approval. No code changed for this design.**

## 1. Current state (inspected)

**CRM** — `zipper-crm/lib/firebase.ts`
- **One default Firebase app** serves `db`, `auth` and `storage`.
- **Sign-in:** `crmSignIn` (email/password, `lib/auth.ts:520`) or Google (`crmSignInWithGoogle`, `:741`).
- **API exchange:** `AuthProvider` exchanges the Firebase ID token at `/api/auth/signin` only when no API token is stored (`components/AuthProvider.tsx:552-568`). A uid-mismatch effect re-exchanges if the stored API session belongs to another uid (`:491-503`).
- **MFA:** `/api/auth/mfa/verify` and `/enrol/confirm` now send the current Firebase ID token.

**Android**
- **One default `FirebaseApp`**, provided by Hilt (`di/FirebaseModule.kt:21-40`).
- **Personal sign-in:** phone OTP. Several flows already use `signInWithCustomToken` on the default auth (`AuthRepository.kt:545, 1202, 1341, 1840`; quick login mints via `functions/src/quickLogin.ts:477`).
- **API session:** `ApiClient` exchanges the default user's ID token (in memory only).
- **Work layer:** `WorkRepository` reads and writes Firestore through the injected default `FirebaseFirestore` (`data/work/WorkRepository.kt:28-30`). It does not use Storage.

**Rules**
- `sessionCurrent()` (`firestore.rules:631`) compares `auth_time` with `users/{uid}.credentialsValidAfter`, stamped by `startMobileSession`.
- It is used only through `isActiveAppUser()` on app-user paths: comments, conversations, messages, viewers, and `users` self-writes. **No staff or Owner path uses it.**
- `phone_number` and `email_verified` are read only in the app-user and partner contact-proof helpers (`firestore.rules:454-465`, partner bindings).

**Claims**
- Account-wide custom claims are only `role` and `aid` (`backend/app/services/storage_claims.py:110`, `functions/src/storageClaims.ts:246-254`).
- Both writers merge, preserving any other keys.

**Current binding**
- `ownerMfaSessions/{uid}` holds `bindings` (per API session) plus a derived `active["auth_time:provider"]` index. This is the same-second weakness.

**Minting precedent and IAM**
- `deploy.sh:276-281` grants `roles/iam.serviceAccountTokenCreator` to the Functions account, for `createCustomToken`.
- `deploy.sh:366-371` grants the same role to the **Cloud Run runtime account on itself** (for signed URLs).
- I have **not verified** that either grant is actually present in production.

## 2. Proposed design

### 2.1 Token and binding

- **The session id.** On a successful MFA verify or enrol-confirm, the backend creates `sid` = 128-bit random (`secrets.token_urlsafe(16)`) and a binding:
  ```
  ownerMfaSessions/{uid}.bindings.<sid> = {
    state: "minted",   apiJti, client: "crm"|"android",
    issuedFromAuthTime: <auth_time of the token that passed MFA>,
    expiresAt: <API session token expiry>, createdAt }
  ```
  It mints a Firebase **custom token**: `auth.create_custom_token(uid, {"mfa_sid": sid})`.
- **Developer claims** persist in every ID token of the Firebase session that redeems the token, refresh included, and in no other session.
- **Response:** `{session, mfa_custom_token, firestore_binding: {state: "minted"}}`.
- **Client redemption.** The client signs in with the custom token:
  - **CRM:** the default auth, replacing the password or Google session (same uid).
  - **Android:** a **separate** `FirebaseApp` (`"ownerWork"`), leaving the personal session untouched.
- **Confirmation.** The client calls `POST /api/auth/mfa/bind/confirm {firebase_id_token}` with the ID token of the redeemed session. The backend:
  - verifies it with `check_revoked=True`;
  - requires `uid` = session uid, `firebase.sign_in_provider == "custom"`, `mfa_sid` = the binding owned by **this** API session's `jti`, `state == "minted"`, and not expired;
  - then sets `state: "active"` and `authTime: <redeemed token auth_time>`.

  Confirmation happens **once**.
- **Rules** (Firestore `ownerMfaOk()`, and the same in Storage via `firestore.get`, and in Functions):
  ```
  let sid = request.auth.token.get('mfa_sid', '');
  let b   = get(ownerMfaSessions/uid).data.bindings.get(sid, {});
  sid != '' && provider == 'custom' && b.state == 'active'
    && b.authTime == request.auth.token.auth_time && b.expiresAt > request.time
  ```
  The `active` index and the `auth_time:provider` key are removed.

### 2.2 Why this closes the same-second bypass

- **A password, Google or phone sign-in** in the same second, same provider or not, carries **no `mfa_sid`**. Denied.
- **Any other custom-token sign-in** (quick login and the like) carries no `mfa_sid`. Denied.
- **A forged claim.** `mfa_sid` exists only in tokens Firebase issued from a custom token **signed by our service account**. A client cannot add claims to a Firebase-issued ID token.
- **A guessed sid.** 128-bit random, and it must also match a binding of that uid.
- **A second redemption of the same custom token** at a different second fails `authTime`.
  - The residual is redemption in the **same second as the confirmed one**. That needs **theft of the custom token itself**, a bearer credential delivered only to the verified client. It is equivalent to stealing a session, not "logging in at the same time".
  - The custom token is valid for 1h. Confirmation is single-use. An unconfirmed binding grants nothing.
- **Account-wide claims can never carry `mfa_sid`.** Both claim writers drop the key, which a backend test pins. The rules also require `provider == 'custom'`.

### 2.3 Lifecycle (all fail-closed)

| Event | Effect |
|---|---|
| Mint fails (signBlob/IAM) | No `minted` binding is left behind (deleted on error). The API session is still upgraded; the response says `firestore_binding.state = "failed"`. Firestore and Storage stay locked |
| Confirm fails or never happens | The binding stays `minted`, which rules deny. It is pruned at expiry |
| Renewal | Carries `sid` to the new `jti` and extends `expiresAt` (same transaction as today). **On any failure the binding is deleted**, not left on the old `jti`. The Owner taps Retry unlock. A removed binding is never re-created |
| Sign-out (CRM / Android) | The API `/signout` deletes **that session's `sid` only**; then the client signs out of the Firebase session (CRM default auth / Android `ownerWork`). Other sessions are untouched |
| Observer reset, suspension, deactivation, role change | Delete every binding (the document). Effective on the next request |
| Expiry | `expiresAt` = API token expiry (7 days), extended only by a successful renewal |
| CRM reload | The Firebase custom session persists, the API session persists, and the binding is still live, so there's no re-MFA within the session lifetime (as today) |
| Android cold start | The API session is in memory only, so the app **signs out `ownerWork` at process start** and the Owner verifies again. The old binding has no holder; it expires and is pruned |

### 2.4 Android `ownerWork` instance

- **Initialisation:** `FirebaseApp.initializeApp(ctx, FirebaseApp.getInstance().options, "ownerWork")`, giving its own `FirebaseAuth` and `FirebaseFirestore` (with its own cache).
- **`WorkRepository` dependency:** it takes a `WorkFirestore` provider instead of a raw `FirebaseFirestore`:
  - for an Owner whose `ownerWork` user exists, has the same uid as the default user and is confirmed `active`, the provider returns the `ownerWork` Firestore;
  - otherwise it returns the default instance, which the rules deny for an unbound Owner.

  Non-Owner staff always use the default instance (unchanged).
- **`ApiClient`:**
  - after `MFA_VERIFY` or `MFA_ENROL_CONFIRM` returns `mfa_custom_token`, it calls `ownerWorkAuth.signInWithCustomToken`, then `bind/confirm` with that session's ID token;
  - on a default-user change or sign-out it signs `ownerWork` out and calls `/signout`.
- **`ownerWork` never calls `startMobileSession`.** The personal phone session, `credentialsValidAfter`, `sessionCurrent()`, quick login and every app-user rule are unaffected.

### 2.5 IAM and infrastructure

- **Required:**
  - the Cloud Run **runtime service account** needs `iam.serviceAccounts.signBlob` **on itself** (role `roles/iam.serviceAccountTokenCreator`);
  - the **IAM Service Account Credentials API** (`iamcredentials.googleapis.com`) must be enabled.
- **Status:** `deploy.sh` already attempts that exact grant (`:366-371`) for signed URLs. Before release, you confirm it read-only:
  ```
  gcloud iam service-accounts get-iam-policy <runtime SA>
  ```
- **Firebase Admin on Cloud Run** discovers the service account from the metadata server. If discovery fails, set `serviceAccountId` explicitly (config, no code change).
- **No new Functions IAM.** Functions do not mint.
- **Storage → Firestore cross-service read:** unchanged from the current design. Review the prompt's grant at deploy.

### 2.6 Files affected

| Area | Files |
|---|---|
| Backend | `app/services/owner_mfa.py` (mint, confirm, sid bindings; drop the `active` index); `app/routers/auth.py` (new `POST /api/auth/mfa/bind/confirm`; verify, enrol-confirm and `/mfa/bind` return `mfa_custom_token`; `MFA_PENDING_ROUTES` unchanged; `bind/confirm` requires a verified session); `app/core/security.py` (renewal: delete-on-failure); `app/services/storage_claims.py` (never write `mfa_sid`); `app/db/firebase.py` (`create_custom_token` wrapper) |
| Rules | `firestore.rules` `ownerMfaOk()`; `storage.rules` `ownerMfaOk()` |
| Functions | `src/ownerMfa.ts` (sid check); `src/storageClaims.ts` (strip `mfa_sid`) |
| CRM | `lib/api.ts` (redeem plus confirm, using `signInWithCustomToken(auth, token)`); `app/login/page.tsx` (states: minted, confirming, failed, Retry unlock) |
| Android | `di/FirebaseModule.kt` (`ownerWork` app, auth, Firestore); new `data/work/WorkFirestore.kt`; `data/work/WorkRepository.kt` (use the provider); `data/api/ApiClient.kt` (redeem, confirm, sign-out, cold start) |
| Tests | `tests/firestore.p1mfa.rules.test.mjs` and `tests/storage.p1mfa.rules.test.mjs` (rewritten for `mfa_sid`); the six suites' Owner fixtures (seed an `active` sid binding plus `mfa_sid` tokens); **new** `tests/auth.p1mfa.emulator.test.mjs`; `backend/tests/test_p1_owner_mfa_binding.py` (rewritten); `functions/test/ownerMfa.test.js`; `WorkModulesTest` plus a new `WorkFirestoreTest` |

### 2.7 Migration

- **Nothing deployed uses the current binding,** so there is no production data migration.
- **At rollout,** every Owner verifies MFA once in the CRM, and once in the Android app per launch.
- **Old CRM tabs** stay locked, because their sessions carry no `mfa_sid`. Safe.
- **Old Android builds** are the same: Owner Firestore screens are locked, and personal use is unaffected.

## 3. Regression-test plan

**A. Real-token proof** (new; Auth plus Firestore emulators, `demo-zipper`): `tests/auth.p1mfa.emulator.test.mjs`
- Admin SDK `createCustomToken(uid, {mfa_sid})`, then client `signInWithCustomToken`, then `getIdTokenResult` must show:
  - `mfa_sid`;
  - `firebase.sign_in_provider == 'custom'`;
  - `auth_time`;
  - `email`, `email_verified` and `phone_number` preserved (asserted, not assumed);
  - the claim surviving `getIdToken(true)`.
- A password sign-in of the same user in parallel has **no** `mfa_sid`.
- That real token is then evaluated against the real rules: allowed when bound, denied otherwise.

**B. Firestore rules** (`tokens` with `mfa_sid`, `auth_time`, `firebase.sign_in_provider`)

*Denied, every helper family:*
- no `mfa_sid` (password, phone, Google) at the **same `auth_time`** as a bound session;
- quick-login custom token without `mfa_sid`;
- unknown `sid`;
- `sid` of another uid;
- `minted` but not confirmed;
- confirmed but a different `auth_time` (redemption replay);
- `provider != 'custom'` carrying `mfa_sid`;
- expired;
- deleted (sign-out);
- whole document removed (reset or suspension).

*Allowed:*
- a bound `sid`;
- two `sid`s coexisting (CRM and Android). Signing out one leaves the other.
- the Owner's own `crmUsers` and personal app reads while pending.

*Unchanged:*
- department roles, partners and app users;
- no client reads or writes `ownerMfaSessions`.

**C. Storage rules:** the same matrix (subset) via cross-service.

**D. Backend**
- mint only after: TOTP passed, current pending session, active Owner, and a Firebase token verified with matching uid;
- a mint failure leaves no binding and returns `failed`;
- confirm refuses each of: wrong uid, wrong `sid`, `sid` owned by another API session, already active, provider not custom, expired, revoked token;
- renewal carries the binding; a renewal failure deletes it;
- sign-out deletes only its own `sid`;
- reset, suspend, deactivate and role change delete all;
- `storage_claims` never writes `mfa_sid`;
- audit entries contain no token or `sid` in full.

**E. Functions**
- `backfillPublicProfiles` with and without a valid `sid`;
- `storageClaims` strips `mfa_sid`.

**F. CRM**
- `tsc`, `npm test`;
- emulator smoke: password sign-in → TOTP → custom-token redemption → confirm → an Owner Firestore read succeeds;
- sign-out, then the same read fails;
- Retry unlock after a forced confirm failure.

**G. Android**
- unit: `WorkFirestore` selects `ownerWork` only for a confirmed Owner, and the default otherwise;
- `ApiClient` redeem, confirm and sign-out wiring;
- the default `FirebaseAuth` is never touched by the MFA path (source pin);
- device smoke: personal phone login, then Owner MFA, then an Owner work screen loads; the personal chat still works (`sessionCurrent()`); sign out of Owner work leaves the personal session signed in.

**H. Existing suites:** all ten rules suites, backend (87), Functions (1516) and Android (307) still pass.

## 4. Decisions needed

1. Approve this design, including that the CRM's Firebase session is replaced by the custom-token session after MFA.
2. Confirm the Android behaviour: re-verify Owner MFA on each cold start.
3. Confirm the IAM prerequisite (runtime SA `serviceAccountTokenCreator` on itself, and the IAM Credentials API enabled), to be verified read-only by you before release.
