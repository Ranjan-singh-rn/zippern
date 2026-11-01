# Proposed Owner-MFA-only patches (for review — nothing here has been applied)

Each `.patch` is a unified diff from the **production base** of one file to its **MFA-only** version, meaning only the P1-A3/A3b Owner-MFA hunks. `MANIFEST.json` records, for every file:
- its base and the base's confidence;
- the sha256 prefixes of the base and the MFA-only version;
- the hunks that were included and those that were excluded.

The repository, the working tree and production are unchanged. Generator: `p2test/build_mfa_patches.py` (session scratch).

## Base confidence

*Updated 25 Oct, after the backend archive was downloaded.*

| Label | Meaning | Files |
|---|---|---|
| **exact** | The deployed text itself, retrieved from production | **Rules:** `firestore.rules`, `storage.rules`. **All backend files** (`config.py`, `db/mongo.py`, `core/deps.py`, `core/security.py`, `db/firebase.py`, `services/storage_claims.py`, `routers/auth.py`, `core/audit.py`, `main.py`, `services/staff.py`). **All backend test bases** (`fakes.py`, `harness.py`, `test_money_permissions.py`, `test_partner_session.py`). Backend bases come from the Cloud Run source archive (sha256 `36227060…`) |
| **head** | Unchanged since HEAD before P1; the CRM's 20 Oct source is not recoverable, see `P2-PROVENANCE-REPORT.md` | CRM `app/login/page.tsx`, `app/team/page.tsx` |
| **probable** | The pre-P1 copy was last modified before the 20 Oct deploy | CRM `lib/api.ts` |
| **uncertain** | May contain changes made after the deploy | `functions/src/profiles.ts`, `functions/src/storageClaims.ts` (Functions archive not downloaded), CRM `lib/auth.ts` |
| **new** | Not in production | `owner_mfa.py`, `remove_gate_answers.py`, `ownerMfa.ts`, MFA tests |

**`routers/auth.py` was rebased.** Production runs HEAD's file. The earlier proposal used the pre-P1 copy, which carries a post-deploy, non-P1 change: the mobile `capability_profile` keys on `/auth/me`. That change is now excluded. The patch adds exactly the 213 P1 MFA lines (+213/−3) to production's file.

**Still open.** The Functions bases need the Functions archive, which needs your approval. The CRM needs its 20 Oct baseline.

## What is in, and what is deliberately out

**Firestore rules.**
- In:
  - the `crmRole()` → `superadmin_mfa_pending` gate, with `ownerMfaOk()` and `ownerMfaBindingLive()`;
  - the `hasPerm()` refusal;
  - the `ownerMfaSessions` deny-all block;
  - removal of the Owner `gateAnswers` write arm. **Ship this only after the MFA CRM is live.**
- Out: P1-E (`callerDept`, `staffRoster`, `crmUsers` read narrowing), P1-A1 and P1-D.

**Storage rules.** The whole P1 delta is MFA. **It is blocked on an IAM decision:** the new cross-service read needs `roles/firebaserules.firestoreServiceAgent` on the Storage service agent.

**Backend.**
- Included: `owner_mfa.py` plus its wiring:
  - routes, session claim and renewal carry;
  - the `deps` gate;
  - settings and the collection name;
  - audit actions;
  - `create_custom_token`;
  - the CORS expose header;
  - the `mfa_sid` strip.
- Also included: the `change_role()` hook, and the **narrow `deactivate()` hook** (new).
- Out: everything from P1-B (staff lifecycle), P1-D (tickets) and P1-E (directory).

**Functions.** `ownerMfa.ts`; the `backfillPublicProfiles` binding gate; the `mfa_sid` strip in the deployed `syncStorageRoleClaim`.

**CRM.**
- Included:
  - the MFA login;
  - the MFA API client;
  - removal of the gate answers;
  - an Observer-only **Reset two-step sign-in** control. This is a narrow adaptation that uses the page's own `Modal`/`Field`/`Footer`, not P1-B's `AccessPanel`.
- Out: P1-B suspend/reactivate, P1-D tickets, P1-E `staffRoster`.

**Tests.** The MFA backend tests, the new `test_p2_owner_deactivate_mfa.py`, the test infrastructure they need, the MFA rows of the route inventory, and the Functions `ownerMfa` test.

## Verified in session scratch only (`/tmp`, deleted with the session)

**Re-run on the exact production backend** (the extracted Cloud Run archive) with these patches overlaid:
- 80 of 82 test modules pass, including the new deactivation test (20/20), `test_p1_owner_mfa` (68), `test_p1_owner_mfa_binding` (50), `test_staff_revocation` (38), `test_partner_session` (531) and `test_permissions` (246).
- Both failures are environmental: `test_local_isolation` needs `.env.example`, which is never extracted; `test_commission` needs a local `backend/backups/…` file that is not in the archive.

The earlier run below used a probable-production tree.

**Backend:**
- Every module compiles, and all `app.*` imports resolve.
- **84 of 85** test modules pass, including:
  - the new deactivation test (20/20);
  - `test_p1_owner_mfa` (68);
  - `test_p1_owner_mfa_binding` (50);
  - the pre-P1 `test_staff_revocation` (38);
  - `test_partner_session` (531);
  - `test_permissions` (246).
- The 85th, `test_local_isolation`, reads `backend/.env.example`, which is not copied or opened.

**Mutation checks:**
- With the `deactivate()` hook removed, the new test fails 12 of 20 checks, including every "reinstatement cannot revive" check.
- With the failure hidden from `fully_revoked`, it fails 1 check.

**CRM.** `tsc --noEmit` passes, and `npm test` passes all 20 suites (hooks lint included).

**Rules (structural).**
- Owner-gate bypass audit: 0.
- Braces balanced.
- No `staffRoster`, `callerDept` or P1-A1/D/E content.
- The difference from the working tree is exactly the excluded P1-A1/D/E hunks.

**Rules emulator suites.** Not run here (no emulator). In the release folder, run all suites except `p1gov`, which tests the excluded P1-A1/D/E rules. Only `p1mfa` accepts `ZIPPER_RULES_FILE`.
