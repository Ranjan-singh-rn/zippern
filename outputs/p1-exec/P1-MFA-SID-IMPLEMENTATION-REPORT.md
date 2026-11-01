# Owner MFA — per-session `mfa_sid`: implementation report

25 Oct 2026 · branch `v5-scratch`.

Nothing was deployed, committed, pushed, reset, cleaned, stashed or reverted. No production read or write. No IAM or cloud configuration was changed.

Evidence labels:
- **[RAN]**: I executed it and saw the result.
- **[NOT RUN]**: written and syntax-checked only; it needs the emulators, Gradle or a device on your Mac.

## 1. What changed in the design

The `auth_time:provider` key is gone. In its place:

**1. Mint.** On MFA verify, enrol-confirm, or Retry unlock (`/api/auth/mfa/bind`), the backend checks:
- the Owner role;
- the caller's live, MFA-verified API session;
- an active Owner staff row;
- the caller's current Firebase ID token (signature plus revocation, same uid).

It then writes `ownerMfaSessions/{uid}.bindings.<sid>` = `{state: "minted", apiJti, client, issuedFromAuthTime, expiresAt, createdAt}`. The `sid` is random, 128 bits. It also mints a Firebase custom token with the developer claim `mfa_sid = sid`.
- If minting fails (for example `signBlob` is denied), the binding is removed.
- A retry replaces this session's previous binding.

**2. Redeem.**
- **CRM:** `signInWithCustomToken` on its default auth, replacing the password or Google session (same uid).
- **Android:** the separate `ownerWork` Firebase app. The personal phone sign-in is never touched.

**3. Confirm** (`POST /api/auth/mfa/bind/confirm`, verified sessions only). The backend requires all of the following:
- a valid ID token (signature, revocation) for the same uid;
- provider `custom`;
- `mfa_sid` equal to the binding owned by **this** API session's `jti`;
- state `minted`.

It then sets `state: "active"` and `authTime` to that token's `auth_time`. Re-confirming the same sign-in is idempotent. Any other `auth_time` is treated as a **replay** and refused.

**4. Rules, Storage and Functions** accept Owner authority only when all of these hold:
- `mfa_sid` is non-empty;
- the provider is `custom`;
- the binding exists and its state is `active`;
- its `authTime` equals this token's `auth_time`;
- it has not expired.

**5. Lifecycle:**
- **Renewal** moves the binding to the new `jti` and extends it. On **any** failure it **revokes** the binding and reports `failed`. A removed binding is never resurrected.
- **Sign-out** removes only that session's `sid`.
- **Observer reset, suspension, deactivation and role change** remove all of the Owner's bindings.
- **Android** discards `ownerWork` at every cold start, on sign-out, and when the personal account changes.

**6. Account-wide claim writers strip `mfa_sid`:** backend `storage_claims._apply` and Functions `syncClaim`.

**7. Logging:** no custom token, ID token or full `sid` is logged or audited. The audit records a 6-character tag; a mint failure logs the exception type only.

## 2. Files changed in this stage

Pre-change copies are in `outputs/p1-exec/before/mfa-sid/`.

| Area | File | Change |
|---|---|---|
| Rules | `firestore.rules` | `ownerMfaOk()` and `ownerMfaBindingLive()` on `mfa_sid`; `ownerMfaKey` removed. `crmRole`, `hasPerm` and the deny-all `ownerMfaSessions` block are unchanged from Stage 1 |
| Rules | `storage.rules` | the same, via `firestore.exists`/`get` |
| Backend | `app/services/owner_mfa.py` | `mint_owner_session`, `confirm_owner_session`; `carry_binding` (revoke on failure); `unbind_session`; `clear_all_bindings`; prune (expired, unconfirmed past 1h, cap 10) |
| Backend | `app/routers/auth.py` | verify and enrol-confirm mint; `/mfa/bind` re-mints; **new** `POST /mfa/bind/confirm` |
| Backend | `app/db/firebase.py` | `create_custom_token` wrapper, appended at the end of the file so existing line pins stay put |
| Backend | `app/services/storage_claims.py` | strips `mfa_sid` |
| Backend | `app/core/audit.py` | `owner_mfa.minted` |
| Functions | `src/ownerMfa.ts` | `mfa_sid` check |
| Functions | `src/storageClaims.ts` | strips `mfa_sid` |
| CRM | `lib/api.ts` | `redeemOwnerBinding` (`signInWithCustomToken` → confirm); `settleBinding`; the custom token is never kept; Retry re-mints. `login/page.tsx` is unchanged: its locked state and Retry already handle non-`bound` |
| Android | `data/work/OwnerWorkFirebase.kt` (**new**) | the `ownerWork` FirebaseApp, auth and Firestore; cold-start sign-out; `WorkFirestore` selector |
| Android | `data/work/WorkRepository.kt` | Firestore resolved per call through `WorkFirestore` |
| Android | `data/api/ApiClient.kt` | redeem into `ownerWork`, confirm, strip the custom token from returned bodies; `ownerWork.signOut()` on sign-out and account change; `MFA_BIND` / `MFA_BIND_CONFIRM` |
| Android | `data/work/ModulesOps.kt` | **Retry unlock** action |
| Tests | `backend/tests/test_p1_owner_mfa_binding.py` | rewritten (50 checks) |
| Tests | `backend/tests/test_partner_session.py` | route inventory + `/mfa/bind/confirm` |
| Tests | `backend/tests/test_staff_revocation.py` | fixture format |
| Tests | `functions/test/ownerMfa.test.js` | rewritten (15) |
| Tests | `tests/firestore.p1mfa.rules.test.mjs`, `tests/storage.p1mfa.rules.test.mjs` | full denial matrix |
| Tests | **new** `tests/auth.p1mfa.emulator.test.mjs` | real tokens, Auth + Firestore emulators |
| Tests | Owner fixtures in `fx`, `gov`, `p1gov`, `phase1a`, `rc`, `firestore`, `storage` | Owners now present `mfa_sid` + provider `custom` with an active binding |
| Tests | `tests/package.json`, `tests/run-p1mfa-verify.command` | add `test:p1mfa:auth` |
| Tests | `zipper-app/.../WorkModulesTest.kt` | `ownerWork` selection and source pins |

**Whitespace:** `git diff --check` on these files exits 0; no trailing whitespace; final newlines present; `node --check` passes for every `tests/*.mjs` [RAN].

## 3. Tests

| Suite | Command | Result |
|---|---|---|
| Backend, all modules | `python3 -m tests.<module>` ×87 | [RAN] 86/87 on the first run; the failure was `test_moderation` ("the session cut-off moves past now"), a **pre-existing time-dependent check in an untouched module**. It passed 3/3 on rerun (264/264) |
| └ owner MFA binding (new design) | | [RAN] **50/50** |
| └ owner MFA / sessions / staff revocation | | [RAN] 68/68 · 247/247 · 81/81 |
| └ partner sessions / permissions / money permissions / contact verification | | [RAN] 543 · 250 · 270 · 154, all pass |
| Functions | `tsc` + `node --test test/*.test.js` (full-repo mirror; `functions/lib` untouched) | [RAN] tsc exit 0; **1518/1518** |
| CRM | `npx tsc --noEmit`; `npm test` | [RAN] exit 0 / exit 0 (19 spec suites + hooks lint) |
| Rules, 10 suites + new real-token suite | `tests/run-p1mfa-verify.command` | **[NOT RUN]** No Firebase CLI or emulator JARs in the sandbox |
| `run-phase1a-validation.sh` | | **[NOT RUN]** |
| Android unit + build | `zipper-app/work-verify.command` | **[NOT RUN]** Kotlin was reviewed but not compiled |
| CRM smoke (MFA → custom-token redemption → confirm → Owner Firestore read → sign-out) | | **[NOT RUN]** Needs a browser and the local stack |
| Android device smoke | | **[NOT RUN]** |

**Run on your Mac:**
```
tests/run-p1mfa-verify.command          # 11 suites incl. auth.p1mfa (real tokens); prints FACT lines
bash zipper-app/work-verify.command     # Android compile + 300+ unit tests
bash tests/run-phase1a-validation.sh    # repaired runner
```

**CRM smoke, local stack:**
1. `backend/scripts/start_local_emulators.sh` (demo project), the backend against the emulators, and `start-crm-dev.command`.
2. Sign in as a seeded Owner, enrol or verify. Expect the CRM to enter with no "locked" step.
3. Check that an Owner Firestore screen (e.g. `/finance/withdrawals`) loads.
4. Sign out, sign in again with the password only, stop at the code screen, and confirm Owner Firestore reads are refused.

**Android smoke:**
1. Personal phone login; then the Owner work, Two-step sign-in code; confirm that an Owner Firestore work screen loads.
2. Check that personal chat and messages still work.
3. Kill the app, relaunch, and confirm that Owner work requires the code again while personal use stays signed in.

## 4. IAM: read-only inspection (I cannot run gcloud; please run these)

```
SA=$(gcloud run services describe zipper-api --region asia-south1 --project zipper-83816 \
      --format='value(spec.template.spec.serviceAccountName)')
[ -z "$SA" ] && SA="$(gcloud projects describe zipper-83816 --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
gcloud iam service-accounts get-iam-policy "$SA" --project zipper-83816 --format=json \
  | grep -B2 -A4 serviceAccountTokenCreator          # expect member serviceAccount:$SA
gcloud services list --enabled --project zipper-83816 --filter='name:iamcredentials.googleapis.com'
```

**Required:**
- the runtime service account holds `roles/iam.serviceAccountTokenCreator` **on itself**;
- `iamcredentials.googleapis.com` is enabled.

**Without them,** minting fails. That fails closed: Owners keep API access, and Firestore and Storage stay locked with a `failed` state.

## 5. Unresolved risks

1. **Not yet executed against the real emulator.** That covers the rules syntax (`sid is string`, `map.get(sid, {})`, the Storage cross-service read) and the real-token assumptions. In particular: the claim surviving refresh, `auth_time` stability, and whether `email`, `email_verified` and `phone_number` are present in custom-token sessions. The latter is reported as a `FACT` line, not assumed.
2. **The Kotlin is not compiled.**
3. **The custom token is a bearer credential for up to 1h.** Theft plus redemption within the same second as the confirmed session would be indistinguishable. That is session theft, not a same-second login.
4. **If Firestore is unavailable during a renewal,** the revoke itself can fail. The binding then lapses at its original expiry.
5. **CRM Firebase session replacement:** the session becomes `custom`. The provider list on `/profile` comes from the user record, so it's unaffected.

## 6. Release isolation (unchanged blocker; see `P1-RELEASE-ISOLATION.md`)

Still blocked, for the same reasons: the deploy scripts ship whole directories, the production baseline is unknown, and git doesn't contain what the MFA path imports.

**New in this stage** (dependency map additions):
- **Android:** `OwnerWorkFirebase.kt` (new). `WorkRepository.kt` is part of the untracked B3 work layer.
- **Backend:** `services/storage_claims.py` (untracked) is now part of the MFA set. `db/firebase.py` (modified) gains `create_custom_token`.
- **Functions:** `src/storageClaims.ts` is part of the set.

No branch, commit, worktree or release copy was created.
