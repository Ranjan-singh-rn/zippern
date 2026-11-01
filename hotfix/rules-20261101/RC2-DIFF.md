# Rules release candidate 2 (RC2) — change list, indexes, deploy order, rollback

Prepared 2026-11-01 on branch `v5-scratch` (HEAD `97204de`), working tree. **Nothing here is deployed.**
RC2 = the repository's top-level `firestore.rules`, `storage.rules` and `firestore.indexes.json`.

| File | sha256 (at time of writing) | Lines |
|---|---|---|
| `firestore.rules` (RC2) | `520b883dc73a9b7726bddb2af9d47b30b98a12c1b7c9911f8fab681a11bd4dd0` | 4,497 |
| `storage.rules` (RC2) | `2fd706a67381c5e9e385a6d4d2615da5cca3833bab8bfb16b6c861f400639dd8` | 993 |
| `firestore.indexes.json` (RC2) | `6c4dbc36139214d797e7c937424659c410643ba848dd6084298a0091b28dc5a5` | 66 composite + 3 field overrides |
| DEPLOYED Firestore (live since 20 Oct, ruleset `b2104a12…`) | `17b8ffee1383716bb784292271c162e22e1e99d860d35d351d0c72ee93694d45` | 4,049 |
| DEPLOYED Storage (live since 20 Oct, ruleset `27a73af8…`) | `9899c24aed8699abe153b16da72db0695571fdff4713adee03463643c56b112a` | 911 |
| hotfix-1 Firestore (`hotfix/rules-20261101/firestore.rules`) | `2729eaa78ff6f3e3edec45e73722db38798384c20a655c3c6a94df46ee75e109` | |
| hotfix-1 Storage (`hotfix/rules-20261101/storage.rules`) | `3f5b61c70343c3b35ab29c418a0a2d3d9aa42eae68a768de1ff200a02bcd046d` | |
| Owner-MFA candidate Firestore / Storage | `93453763…` / `395693b0…` | |

DEPLOYED texts: `~/zipper-release/mfa-release-rc2-20261027T230620Z/baseline/{firestore,storage}.rules.DEPLOYED`.
Lineage: DEPLOYED → MFA candidate → working-tree P1-A1/D/E hunks (= `HEAD:firestore.rules`, `26dac8f5…`) → hotfix-1 hunks → the D items below.
Each file's header comment repeats this list with the dependency of every item.

## 1. Firestore changes vs DEPLOYED (`17b8ffee…`)

Line numbers are in the RC2 file. "Needs" = what must be live before the rule is released.

| # | Change | RC2 lines | Needs |
|---|---|---|---|
| A1 | `crmRole()` reads an Owner as `superadmin_mfa_pending` unless `ownerMfaOk()` (custom-token session with an active, unexpired `ownerMfaSessions/{uid}.bindings[mfa_sid]` for this `auth_time`); `hasPerm()` refuses the pending role | 183–215 | backend MFA revision at 100% **and** the MFA CRM live (otherwise every Owner loses every staff grant) |
| A2 | `ownerMfaSessions/{uid}` deny-all | 1117 | none |
| A3 | `crmUsers` update: first-login `gateAnswers` arm removed, `gateAnswers` refused | `crmUsers` block from 1131 | MFA CRM (the old `/login` gate writes `gateAnswers`) |
| B1 | hotfix-1 A-1 `ownerContactWriteOk()`: empty email/phone over an absent/empty one = no change | 2169–2207 | none |
| B2 | hotfix-1 R-3 `calls` and `callHistory`: `allow write: if false` | 3233, 3860 | none (Functions write them) |
| B3 | hotfix-1 A-5 `appConfig/androidUpdate`: no client writer | 4019 | none (`publish_apk.py`, Admin SDK) |
| B4 | hotfix-1 R-2 / P1-A1 `coinPurchaseRequests` list scoped to the caller's own seller record | 4324 | none (the dashboard filters on `sellerUid`) |
| B5 | hotfix-1 R-5 / P1-A1 `techTickets` read `isStaff()` (partners refused) | 2738 | none |
| C1 | P1-E `staffRoster/{uid}` (staff read, no client write) + `crmUsers` read narrowed to self / Owner / same-department admin for a member (`callerDept()`) | 1121, 1131 | roster backfill (`backend/scripts/backfill_staff_roster.py`, writer `crm_directory.write_roster`), the `staffRoster(role, isActive)` index READY, the CRM that reads names from `staffRoster` |
| C2 | P1-D `techTickets` create/update `if false` | 2738 | backend tickets API (`backend/app/routers/tickets.py`) at 100% and the CRM that calls it |
| C3 | P1-D `feedbackTickets` / `supportTickets`: user creates in own name and reads own; ops/admins/support read; staff update through the tickets API only → client update/delete `if false` | 3310, 3320 | as C2 |
| D1 | `weeklyPayoutReports/{id}/hostPayouts/{payoutId}`: read Finance / admins / the report's agency owner (caller's `crmUsers.agencyId` == row `agencyId`, query must filter on it); write `if false` | 2838 | none (CRM `lib/finance.ts` already reads it, falls back when refused) |
| D2 | legacy top-level `hostPayouts`: the `agencyOwnerUid` any-field update arm closed (R-11) | 2854–2866 | none (nothing updates it) |
| D3 | `salaryRequests` update: Finance/Owner may write the actor key **`approvedBy`** (the key `zipper-crm/app/agencies/[id]/salary/Client.tsx` names in its C-8 note and `lib/finance.ts` / `lib/coinPurchases.ts` already write), only equal to the caller's uid; no other actor spelling | 4169–4195 | none (today's write without it still passes) |
| D4 | `users`: `banScope`, `banCategory`, `banEvidence`, `payoutHoldReason`, `payoutHoldAt` added to `ownerProtectedFields()` and `staffProtectedFields()`; `credentialsValidAfter` was already in both | 2118, 2291 (2071, 2302) | none (backend writes them, Admin SDK) |
| D5 | `users`: `gender` set once (owner arm; staff arm unchanged) — audit A-10, not in the 1 Nov brief, kept from the previous pass | 2400 | none (only profile setup writes gender) |
| D6 | top-level `notifications`: read by the addressee only (admin read removed), client write `if false` | 3927 | none (backend `notices.py` and Functions write; no client writes or admin-reads) |
| D7 | R-6 `appConfig/paymentCredentials` read: staff; a CRM seller whose seller role started; an app seller with a verified contact on the token and a started seller record (BuyCoinScreen). Never a guest / ordinary user / pending applicant. Other `appConfig` docs unchanged | 3932 ff. | none (BuyCoinScreen and CRM BuyInventoryDialog are the only readers) |
| D8 | R-8 `hostKyc/{hostUid}` read: admins and the host only | 2607 | none (no agency reader exists) |
| D9 | R-10 `users/{uid}/followers/{followerUid}` write only by the follower; `users/{uid}/giftsReceived` create `if false` | 2502, 2576 | none (`ProfileRepository` writes `followers/{me}`; nothing writes `giftsReceived`) |
| D10 | `appConfig/luckyGifts`: covered by the existing appConfig rule — no change | — | — |
| D11 | `publicProfiles`: no change | — | — |
| D12 | `rateLimits/{bucket}` explicit deny-all (`functions/src/rateLimit.ts`, Admin SDK) — same answer as the catch-all | 1038 | none |
| D13 | `partyRooms/{roomId}/private/{docId}` explicit deny-all — the PIN secret `functions/src/party.ts` keeps at `private/secret`; no rule ever admitted it | 3639 | none |
| — | Withheld from RC2 as from hotfix-1: C-1 (self-signup logins born inactive) — the CRM still writes `isActive: true` and would break live self-signup | — | — |

## 2. Firestore: RC2 vs hotfix-1 (`2729eaa7…`)

* Identical in both: B1, B2, B3, B4, and the `techTickets` **read** (B5).
* RC2 differs from hotfix-1 on purpose: `techTickets` **create/update** — hotfix-1 keeps `isStaff()` (the browser still files and moves tickets because the tickets API is not deployed); RC2 has `if false` (C2). `feedbackTickets` / `supportTickets` update/delete — hotfix-1 = DEPLOYED (`isOps() || isAdmin() || isSupport()`); RC2 `if false` (C3).
* RC2 only: A1–A3, C1, C2, C3, D1–D9, D12, D13, the header block.
* hotfix-1 only: nothing. C-1 is withheld from both (`firestore.rules.C-1.NOT-APPLIED.patch`).

## 3. Storage

| # | Change vs DEPLOYED (`9899c24a…`) | In hotfix-1? | Needs |
|---|---|---|---|
| S1 | `roleClaim()` counts an `owner` claim only when `ownerMfaOk()` (cross-service `firestore.exists/get` of `ownerMfaSessions/{uid}`) | no (RC2 only) | **IAM**: Storage service agent `service-239458555881@gcp-sa-firebasestorage.iam.gserviceaccount.com` granted `roles/firebaserules.firestoreServiceAgent` **before** the deploy (`release/completion-20261101/40-storage-iam-grant.command`), else every Owner Storage request fails closed; plus the MFA backend + CRM as for A1 |
| S2 | `profileMedia/{uid}/{fileName}` image cap 5 → 15 MB (videos 50 MB, owner-only write/delete unchanged) | yes (identical) | none |
| R-7 | documented, **not changed**: `kyc/agencies/signup/*`, `sellerDocs/signup/*` keep public `get` + anonymous write-once ≤ 10 MB create; not listable | — | CRM change (create the user before step 2) |

## 4. Indexes (`firestore.indexes.json`) vs `BASE/firestore.indexes.DEPLOYED.json` (58 composite)

Added (8; all `COLLECTION` scope; no deletions):

| Collection | Fields | Why |
|---|---|---|
| `staffRoster` | `role ASC, isActive ASC` | C1 roster pickers (`where role in […] && isActive`) — in HEAD already |
| `salaryRequests` | `status ASC, createdAt DESC` | Owner work hub (APK ≥ 20), `ModulesMoney.kt` |
| `supportTickets` | `status ASC, createdAt DESC` | work hub, `ModulesOps.kt` |
| `techTickets` | `status ASC, createdAt DESC` | work hub, `ModulesOps.kt` |
| `hostApplications` | `status ASC, createdAt DESC` | work hub, `ModulesPeople.kt` |
| `publicProfiles` ×3 | `isListed, [country,] isVerifiedHost, [languageCodes CONTAINS,] presenceRank DESC, lastSeen DESC` | `DiscoverRepository.feed` filter combinations (were already in the working tree; additive) |

The deployed `agents(referralCode, status, __name__)` and `diamondResellers(status, order, __name__)` entries equal the file's entries (implicit `__name__ ASC`). Field overrides: the same three collection-group overrides (`beanTransactions.type`, `beanTransactions.reason`, `diamondTransactions.type`; the export's `__default__` entry is not an override). A `firebase deploy --only firestore:indexes` therefore only creates; never use `--force` or accept a deletion prompt.

## 5. Deploy order

1. **Now — hotfix-1, on top of DEPLOYED** (no client dependency): run `hotfix/rules-20261101/run-hotfix1-rules-tests.command` → PASS, then `release/completion-20261101/30-deploy-rules-hotfix1.command`. hotfix-1 `storage.rules` (S2) is equally independent; no script in `release/completion-20261101` deploys it yet (see open questions).
2. **RC2 prerequisites — all live first:** (a) the completion backend revision at 100% (owner-MFA routes + key, tickets API, roster writer, notices); (b) `backfill_staff_roster.py` run; (c) the 8 indexes deployed and READY (31 deploys them in the same command as the rules — prefer an indexes-only deploy first and wait for READY); (d) the MFA CRM live on Hosting (50); (e) for Storage only: the IAM grant (40).
3. **RC2 tests on the Mac:** `bash tests/run-rc2-rules-tests.command` → `tests/results-rc2-<UTC>/RESULT.txt` = PASS, `SUMMARY.txt` naming the sha256 of the exact files.
4. **RC2 Firestore rules + indexes:** `release/completion-20261101/31-deploy-rules-rc2.command tests/results-rc2-<UTC>` (checks backend 100% and CRM live itself), within minutes of the CRM.
5. **RC2 Storage rules:** only after 40 and after 4; the release folder has no Storage-rules script yet (`rel_rules_lib.sh` refers to 41/49).
6. APK ≥ 20 (work hub) needs only the indexes, not the rules.

## 6. Rollback

* **Firestore:** `release/completion-20261101/39-rollback-rules.command <31's output folder>` re-releases the live text 31 saved (hotfix-1 `2729eaa7…` if step 1 ran, else DEPLOYED `17b8ffee…`). hotfix-1 is strictly more permissive than RC2 for every client RC2 serves (staff ticket writes from the browser, wider `crmUsers` reads, Owners without MFA), so the new backend/CRM keep working on it. If the Owner-MFA release itself is rolled back, roll the CRM back to Hosting `ba740f4158292308` together with the rules (RUNBOOK §9).
* **Storage:** re-release the saved live text (hotfix-1 `3f5b61c7…` or DEPLOYED `9899c24a…`); revert the IAM grant (`G5-STORAGE-IAM-REVERT`) only after no deployed Storage rule calls `firestore.get`.
* **Indexes:** additive — leave them. **Data:** RC2 writes nothing; the roster backfill is additive.

## 7. Tests

`tests/run-rc2-rules-tests.command` (bash 3.2, `demo-zipper`, credentials unset, one `firebase emulators:exec --only firestore,storage` per suite) runs against the RC2 files: `rc2`, `rc2:storage` (new), `hotfix1`, `hotfix1:storage`, `storage`, `p1mfa:storage`, `firestore`, `phase1a`, `ugp`, `fx`, `gov`, `rc`, `p1gov`, `p1mfa` (emulator), `overlap`, `claims` (static). Not run: `auth.p1mfa` (Auth emulator; `tests/run-p1mfa-verify.command`).

**Existing suites expected to fail against RC2 by design: none.**
* 2026-10-28 Mac validation against the MFA candidate (`…/tools/mac-validation-20261028T064807Z/SUMMARY.txt`): firestore 114, phase1a 255, ugp 22, fx 60, gov 74, rc 58, p1mfa 175, storage.p1mfa 60 — all PASS, same test bytes as today except `firestore.rules.test.mjs` (crmUid back-link, untouched by RC2). RC2's further hunks were checked against every check of every suite: only `p1gov`, `p1mfa`, `hotfix1` touch them, and they agree with RC2.
* The suites that fail by design do so on the **other** lineages: `phase1a` (3 `gateAnswers` checks, `phase1a-known-failures.txt`), `p1mfa` / `p1mfa:storage` / `auth.p1mfa` (no Owner MFA), `p1gov` (no P1-D/E hunks), `rc2` / `rc2:storage` (their subject) fail on DEPLOYED / hotfix-1 and pass on RC2.
* `hotfix1` pins hotfix-1's interim `techTickets` form (staff browser writes allowed); against RC2 those 3 checks would fail by design, so the suite switches lineage on the RC2 header (the runner forces `ZIPPER_RULES_LINEAGE=rc2`) and expects them refused. All other hotfix1 checks are lineage-independent.
* Sandbox results (no emulator: no network, Java 11): `node --check` passes for all 18 `tests/*.mjs`; `ZIPPER_STATIC_ONLY=1 node tests/firestore.rc2.rules.test.mjs` → 28/28 static checks pass on RC2 (13 fail on DEPLOYED and on hotfix-1, as designed); `storage-rule-overlap.mjs` (54 assertions) and `verify-production-claims.mjs` pass on RC2 `storage.rules`; the runner's parsing was exercised with a stub `firebase` (PASS path and a forced sha/path mismatch). **The emulator suites have not been run on RC2.**

**Checksum note.** `hotfix/rules-20261101/SHA256SUMS` certifies `tests/firestore.hotfix1.rules.test.mjs` at `ddcc1012…` (the committed file). The working tree adds the RC2 lineage switch (`643f036f…`); its hotfix-1 branch is the committed checks unchanged. `shasum -c SHA256SUMS` reports that one line until the bundle sums are regenerated; `30-deploy-rules-hotfix1.command` checks only the `firestore.rules` line and is not affected.

## 8. Open questions

1. `feedbackTickets` "staff read/update": RC2 implements staff update **through the tickets API only** (P1-D, client update `if false`), as the CRM and the APK-20 work hub do. A browser staff update would need the DEPLOYED arm back.
2. D1 readers are Finance / admins / the agency owner only; the legacy path's host-self arm was not copied (no app reader). Add it only if a host screen appears.
3. D3: `Client.tsx` still writes no actor — the CRM change to add `approvedBy: <uid>` is separate.
4. D5 (gender set once) is in RC2 from the previous pass but was not in the 1 Nov brief — keep or drop?
5. No script deploys Storage rules (hotfix-1 S2 or RC2 S1/S2) in `release/completion-20261101` yet.
6. The APK-20 work hub gates `feedback.triage` to `app_member` too, but the rules (unchanged) admit only ops / admins / support to read `feedbackTickets`; an `app_member` sees an empty list.
