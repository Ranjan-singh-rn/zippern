# Stage 0 + Stage 1 — Owner MFA boundary: implementation report

24 Oct 2026 · branch `v5-scratch` · nothing deployed, committed or pushed · no production read or write.

Labels:
- **[RAN]**: I executed it and saw the result.
- **[NOT RUN]**: written and syntax-checked only.

## Stage 0 — rules suites made emulator-only (`demo-zipper`)

| File | Change |
|---|---|
| `tests/package.json` | `test:firestore`, `test:phase1a`: `--project demo-zipper`. `test:storage`: adds `--project demo-zipper` (it previously had no flag, so it fell back to `.firebaserc`'s `zipper-83816`) |
| `tests/firestore.rules.test.mjs`, `tests/firestore.phase1a.rules.test.mjs`, `tests/storage.rules.test.mjs` | `projectId: 'demo-zipper'` (plus the matching run-command comments) |

**Checks [RAN]:**
- `grep -rn zipper-83816 tests/` finds nothing in the three suites.
- One match remains, in `tests/run-phase1a-validation.sh`, a separate runner not used by the npm suites. Left unchanged, pending your call.
- Every harness pins `127.0.0.1` and uses only `initializeTestEnvironment`.
- No API key, real endpoint or service-account reference appears.
- `.firebaserc` is untouched.

## The `auth_time` collision, and how it is resolved

Firebase ID tokens carry **no per-session id**. The most specific thing the rules can see is `auth_time` (fixed at sign-in and unchanged by token refresh) plus `firebase.sign_in_provider`. So the design separates the authority record from the rules-facing key:

- **Authority record: one per API session.** `ownerMfaSessions/{uid}.bindings.<random bindingId>` holds `{authTime, provider, client, apiJti, expiresAt, createdAt}`. The binding id is stored on that API session's record (`sessions.mfa_binding_id`), so the Firebase authentication event and its API session stay linked across renewals.
- **Rules key: derived.** `active.<auth_time:provider>` holds the latest `expiresAt` among the live bindings with that key. It is recomputed from `bindings` on every change, inside a Firestore transaction. The rules check only that key: it must exist and not be expired.
- **Independence:**
  - CRM and Android sign-ins differ in `auth_time` and usually in provider, so each gets its own key.
  - Two sessions that share `auth_time` and provider each get their **own binding** and share one key.
  - Signing out removes only that session's binding (matched on `apiJti`), so the shared key survives while any other binding holds it.
- **Residual, inherent to Firebase:** a second, unverified sign-in of the same account with exactly the same `auth_time` second and provider looks identical to the rules. It would also need the password, and would have to start within that same second of a sign-in that then passes MFA.

## Every privileged path that trusts `crmUsers.role` / `permissions` / Owner claims [RAN: code search]

| Path | Status |
|---|---|
| `firestore.rules` `crmRole()`, the only read of the caller's role. It feeds `isSuperAdmin`, `isAdmin`, `isApp`/`isOps`/`isTech`/`isFinance`/`isSupport`/`isMarketing`, `isStaff` and `canDecideCoinOps` | **Protected:** returns `superadmin_mfa_pending` unless bound |
| `firestore.rules` `hasPerm()`, which reads `crmUsers.permissions` (every permission for an Owner) | **Protected:** refuses `superadmin_mfa_pending` before the array is read |
| Other caller-document reads (`agencyId`, `sellerId`, `roles`, `roleStatus`, `dept`, existence) | Partner and department fields. They grant an Owner nothing. Unchanged |
| `isOwner(uid)` self-access | Unchanged by design: a pending Owner still reads their own `crmUsers` document |
| `storage.rules` `roleClaim()`, the only read of the `role` claim | **Protected:** `owner` counts only when bound (cross-service Firestore read). Other claims unchanged |
| `functions` `backfillPublicProfiles` (callable) | **Protected:** requires a live binding for `context.auth.token` |
| `functions` `approverRefusal` / approval trigger | **Covered by the rules:** approving is a client write to `approvalRequests` gated by `isSuperAdmin()` |
| `functions` `syncMyRoles`, `identity.ts`, `index.ts:1352` | Display flags and a mail-address lookup only; they grant no authority |
| Backend API | Already MFA-enforced (`deps._refuse_owner_without_mfa`) |

## Files changed in Stage 1

Pre-change copies are in `outputs/p1-exec/before/mfa-stage1/`.

**Rules**
- **`firestore.rules`:** `crmRole()` (with `let`) plus the new `ownerMfaKey()` and `ownerMfaOk()`; `hasPerm()` gated; a new `ownerMfaSessions/{uid}` block that denies all access.
- **`storage.rules`:** `rawRoleClaim()`, `ownerMfaKey()`, `ownerMfaOk()` (cross-service) and `roleClaim()` gated for `owner`.

**Backend**
- **`app/services/owner_mfa.py`:**
  - `bind_firebase_session` checks, in order, before writing anything: token present; Owner role; the token verifies (`check_revoked=True`); its uid matches; it has an `auth_time`; the staff row is an active Owner; the API session is live, MFA-verified and the caller's own. Every refusal is audited, writes nothing and returns a state.
  - `carry_binding` (renewal), `unbind_session` (sign-out), `clear_all_bindings`, all transactional.
  - The Observer reset clears every binding.
- **`app/routers/auth.py`:**
  - `firebase_id_token` and `client` added on verify and enrol-confirm;
  - `user.mfa.firestore_binding` is returned;
  - sign-out unbinds only its own session;
  - new `POST /api/auth/mfa/bind` (retry; verified sessions only).
- **`app/core/security.py`:**
  - a valid renewal carries and extends the binding;
  - `_session_expiry` helper.
- **`app/services/staff.py`:**
  - suspending or deactivating an Owner clears its bindings;
  - role change away from Owner clears them too (defensive: the service already refuses Owner role changes).
- **`app/core/audit.py`:** `owner_mfa.bound`, `owner_mfa.bind_failed`, `owner_mfa.unbound`.

**Functions**
- New `src/ownerMfa.ts`.
- `src/profiles.ts`: `backfillPublicProfiles` now checks the binding.

**CRM**
- **`lib/api.ts`:** sends the current Firebase ID token on verify and enrol-confirm; adds `mfaBind()`, `FirestoreBinding` and `firestoreBindingOf`.
- **`app/login/page.tsx`:** a new `unbound` stage. It says Firestore and Storage are locked and offers **Retry unlock** or **Continue anyway**; it never claims success.

**Android**
- **`data/api/ApiClient.kt`:** `withFirebaseSignIn` adds `firebase_id_token` and `client: "android"` on the two MFA paths only, including the 401 retry; adds `ownerFirestoreBinding()`.
- **`data/work/ModulesOps.kt`:** comment only.

**Tests**
- **New:**
  - `backend/tests/test_p1_owner_mfa_binding.py`
  - `functions/test/ownerMfa.test.js`
  - `tests/firestore.p1mfa.rules.test.mjs`
  - `tests/storage.p1mfa.rules.test.mjs`
  - `tests/run-p1mfa-verify.command` (emulator runner with demo-project guards)
- **Updated:**
  - `backend/tests/test_staff_revocation.py` (suspend, deactivate and reactivate clear or keep bindings, tested functionally);
  - `test_money_permissions.py` (the `hasPerm` pin);
  - `test_partner_session.py` (the new route inventory);
  - `WorkModulesTest.kt` (token injection).
- **Owner fixtures in existing rules suites:** each suite's Owner is now seeded as MFA-bound (`OWNER_MFA_BOUND`; key `0:custom` is the mock token's default). Applies to `fx`, `gov`, `p1gov`, `phase1a`, `rc` and `firestore`. `storage.rules.test.mjs` also runs the Firestore emulator and binds `own1`.
- **`tests/package.json`:** `test:storage` → `--only storage,firestore`; new `test:p1mfa` and `test:p1mfa:storage` added to `test`.

## Tests

| Suite | Command | Result |
|---|---|---|
| Backend, all modules | `python3 -m tests.<module>` (×87) | **[RAN] 87/87 pass** |
| └ `test_p1_owner_mfa_binding` | refusals, CRM/Android, collision, sign-out, renewal, Observer reset, prune and cap, wiring | **[RAN] 46/46** |
| └ `test_staff_revocation` | adds Owner suspend, deactivate and reactivate binding checks | **[RAN] 81/81** |
| └ `test_p1_owner_mfa`, `test_session_lifetime`, `test_partner_session`, `test_money_permissions` | regression | **[RAN] 68 · 247 · 542 · 270, all pass** |
| Functions, full | `tsc` + `node --test test/*.test.js` in a full-repo mirror (built into `/tmp`; `functions/lib` not touched) | **[RAN] before: 1503/1503 · after: 1516/1516** (+13 `ownerMfa`) |
| CRM | `npx tsc --noEmit` | **[RAN] exit 0** |
| Rules: p1mfa, p1mfa:storage, storage, firestore, phase1a, ugp, p1gov, fx, gov, rc | `tests/run-p1mfa-verify.command` | **[NOT RUN]** The sandbox has Java but no Firebase CLI or emulator JARs, and the npm registry is unreachable. `node --check` passes for every file |
| Android | `zipper-app/work-verify.command` | **[NOT RUN]** Gradle needs your Mac |

**Not yet proven, because the emulator hasn't run:** the new rules constructs:
- `let` in functions;
- `timestamp.value(0)`;
- `map.get(key, default)`;
- the Storage cross-service `firestore.exists`/`get`.

If any of them is rejected, every rules suite fails at load, loudly, not partially.

## Remaining risks

1. **The same-second, same-provider collision** is indistinguishable to the rules (see above).
2. **Storage cross-service reads** need a one-time IAM grant at deploy (the Firebase CLI prompts for it). They count toward per-request access limits and are billed as Firestore reads; they are evaluated only for `owner` claims.
3. **Renewal is best-effort.** If the binding write fails during a renewal, the binding is not extended: it expires at the old time, and the state is reported as `failed` on refresh. The Owner then uses **Retry unlock**.
4. **Old CRM tabs and old Android builds** don't send a token. They get API access, while Firestore and Storage stay locked (`missing_token`). This is safe, by design.
5. **Expired bindings are pruned only on the next write.** The rules check expiry, so a stale entry grants nothing.

## Deployment prerequisites (none done)

1. **Backend, CRM and Android first.** They send and bind the token, and are harmless before the rules change.
2. **Functions** (`backfillPublicProfiles`).
3. **`firestore.rules` and `storage.rules` last,** accepting the cross-service IAM prompt.
4. **Every Owner then re-verifies MFA** once in the CRM, and once in the Android app if they use Owner work screens.

## Product decision still open

`tests/run-phase1a-validation.sh` still passes `--project zipper-83816`. Switch it to `demo-zipper`, or leave it unused?
