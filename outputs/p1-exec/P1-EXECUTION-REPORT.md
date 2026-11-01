# ZIPPER Phase 1 — Team Governance and Role Fixes: Execution Report

Date: 24 Oct 2026 · Branch `v5-scratch` (unchanged) · **Nothing was committed, pushed or deployed. No production database, Firebase project or Cloud Run service was read or written.**

## 1. Status by package

| Pkg | Decision | Status | Verified by |
|---|---|---|---|
| A1 | Internal tickets staff-only; seller list scoping | **Done** | Rules tests written. Emulator run **pending on your Mac** |
| A2 | Rules aligned with backend permissions | **Analysed, not applied.** Matrix + proposal for approval | `A2-isAdmin-matrix.md` (55 grants, 24 on financial paths) |
| A3 | Server-enforced Owner MFA; gate answers removed | **Done** (one residual gap, §5) | `test_p1_owner_mfa` 68/68; tsc 0 |
| B1 | Deactivation leaves the personal app account alone | **Done** | `test_staff_revocation` |
| B2 | Reactivation with mandatory reason + audit | **Done** | `test_staff_revocation` |
| B3 | Reversible suspension | **Done** | `test_staff_revocation` |
| B4 | Refuse invites while partner records conflict | **Done** | `test_staff_revocation` (all 5 held statuses) |
| C | Identity linking for phone-login staff | **Requirements only.** Blocked by the financial scope limit (§6) | n/a |
| D | Server-authoritative tickets, audit, in-app notices | **Done** | `test_p1_tickets` 46/46; tsc 0; rules tests pending |
| E | Staff contacts least privilege | **Done** | `test_p1_directory_privacy` 16/16; rules tests pending |
| F | Email + in-app notices on role/access changes | **Done** (in B) | `test_staff_revocation` |
| G | Legacy role survey + plan | **Survey script + plan.** Nothing removed (needs approval) | `P1-G-LEGACY-ROLE-PLAN.md` |
| H | Audited Observer break-glass | **Requirements only** (§7) | n/a |
| I | All-role verification | **Partial.** Backend + tsc green; rules/Android need your Mac (§9) | §8 |

## 2. Files changed

Pre-change copies of every file I edited are under `outputs/p1-exec/before/`.

**Backend**
- `app/core/`: `audit.py`, `account_state.py`, `deps.py`, `security.py`
- `app/config.py`, `app/db/mongo.py`, `app/main.py`
- `app/routers/`: `staff.py`, `auth.py`, `tickets.py` *(new)*
- `app/services/`: `staff.py`, `crm_directory.py`, `tickets.py` *(new)*, `owner_mfa.py` *(new)*
- `tests/`: `fakes.py`, `harness.py` *(both additive)*, `test_staff_revocation.py`, `test_permissions.py`, `test_partner_session.py`
- `tests/` *(new)*: `test_p1_tickets.py`, `test_p1_owner_mfa.py`, `test_p1_directory_privacy.py`
- `scripts/` *(new; none of them run)*: `remove_gate_answers.py`, `backfill_staff_roster.py`, `survey_legacy_roles.py`

**Rules**
- `firestore.rules`, `firestore.indexes.json` (one index added)
- `tests/firestore.p1gov.rules.test.mjs` *(new)*, `tests/firestore.phase1a.rules.test.mjs`, `tests/package.json`

**CRM**
- `lib/`: `api.ts`, `auth.ts`, `tech.ts`, `firestore.ts`, `operations.ts`
- `app/`: `login/page.tsx`, `team/page.tsx`, `team-access/page.tsx`, `tech/tickets/page.tsx`, `tickets/page.tsx`, `feedback/page.tsx`, `operations/feedback/page.tsx`

**Android**
- `data/work/ModulesOps.kt`, `data/api/ApiClient.kt`, test `data/work/WorkModulesTest.kt`

## 3. API and schema changes

**New routes**
- **Staff:**
  - `POST /api/staff/{uid}/suspend`
  - `POST /api/staff/{uid}/reactivate`
  - `POST /api/staff/owners/{uid}/suspend` and `/reactivate` (Observer only)
- **Tickets** (all `require_write`):
  - `POST /api/tickets/team`
  - `POST /api/tickets/{team|feedback|support}/{id}/update` with body `{changes, reason, request_id}`
  - `POST /api/tickets/support/{id}/route`
- **Owner MFA:**
  - `GET /api/auth/mfa/status`
  - `POST /api/auth/mfa/enrol/start`, `/enrol/confirm`, `/verify`, `/recovery-codes`
  - `POST /api/auth/mfa/owners/{uid}/reset` (Observer only)

**Changed behaviour**
- **Sessions:**
  - An Owner session from `/signin` carries `mfa=false`. Until it passes MFA it can reach only `/auth/me`, `/auth/signout` and the MFA routes. Everything else answers **403 + `X-Zipper-MFA-Required: 1`**, which CORS exposes.
  - `verify_session` trusts `mfa` only when the session *record* agrees with the token.
  - Renewal carries the MFA state forward.
- **Sign-in responses:** an Owner's `/signin` and `/refresh` responses include `user.mfa`.
- **Deactivation** no longer disables or revokes the Firebase account. Responses report `personal_app_account: unchanged`.
- **Staff status:** `staff.status` ∈ `active | suspended | deactivated`, with `status_reason`, `status_changed_at` and `status_changed_by`.

**New storage**
- Mongo `owner_mfa`: Fernet-encrypted secret, salted-hash recovery codes, `last_step`, failure count and lock time.
- Firestore `staffRoster/{uid}`: `uid, name, role, dept, isActive, updatedAt`.

**New settings**
- `OWNER_MFA_REQUIRED` (default true)
- `OWNER_MFA_ENCRYPTION_KEY`
- `OWNER_MFA_ISSUER`, `_MAX_FAILURES`, `_LOCK_MINUTES`, `_ENROL_MINUTES`

**Audit actions added**
- `staff.suspended`, `staff.reactivated`, `staff.notice_failed`
- `ticket.created`, `ticket.updated`, `ticket.routed`, `ticket.update_failed`
- `owner_mfa.{enrolled, verified, failed, locked, recovery_code_used, recovery_codes_regenerated, reset}`

## 4. Security changes

**Tickets**
- `techTickets`: no client create or update. `feedbackTickets` / `supportTickets`: no client update or delete. App users still create and read their own.
- The server derives the actor name from the Mongo staff row; the client-typed `statusChangedByName` / `assignedToName` / `closedByName` / `reportedBy` are gone.
- The audit entry is written *before* the ticket write, and `ticket.update_failed` is recorded if the write fails.
- `request_id` makes a retried request a no-op.

**Owner gate → TOTP**
- RFC 6238 is implemented in stdlib and checked against the RFC test vectors. There is no new dependency.
- Replay guard (`last_step`) and a ±1 step window.
- Lock after 5 failures, audited, with an email and in-app notice.
- Recovery codes are stored hashed and work once each.
- Enrolment cannot be restarted once done, so a stolen password can't swap the authenticator. Only the Observer can reset, with a reason; a reset revokes every session of that Owner and notifies them.
- The gate is removed from the CRM code and from the rules. The arm that let an Owner write their own `gateAnswers` is deleted, and `gateAnswers` is now refused on every client write.

**Staff contacts**
- `crmUsers` is readable by its holder, an Owner, and a department admin for their own department's *members*. Before, every staff member could read every colleague's and every partner's phone and email.
- Pickers now read `staffRoster`, which carries names only and is written only by the server.

**Ticket fixes found along the way**
- An "Unassign" on support tickets would have assigned the caller; fixed.
- Support priorities had diverged (`critical` vs `urgent`); aligned per screen.
- The never-read `users/{uid}/notifications` write is replaced with a real in-app notice.

## 5. Residual risks

1. **An Owner's Firebase login can still reach Firestore directly without MFA.** Server enforcement covers the API only. Rules grant `isSuperAdmin()` from `crmUsers.role`. The proposed fix:
   - Set a custom claim (e.g. `owner_mfa_until`) on verify. It must be merged with the existing Storage `role` claim.
   - Require it in `isSuperAdmin()`.
   - Clear it on reset.

   This changes every Owner Firestore read and how claims are managed, so it needs your approval.
2. A Storage role claim can live up to about 1h in already-issued ID tokens after deactivation (carried over from B).
3. The ticket service does read → validate → write with no transaction, so two simultaneous edits can interleave. Each edit is still audited.
4. Android Owners keep their sessions in memory, so they enter a code once per app launch. Enrolment happens on the CRM only.
5. There is no QR code on the enrolment screen, because no QR library is installed. It shows the setup key and an `otpauth://` link instead.
6. Legacy `admin` documents still carry every department's rules authority until G is approved (see the plan).

## 6. WP-C requirements (blocked)

**Case:** a staff member's phone number is on a separate app account (uid P), not on their CRM account (uid E). Firebase allows a phone number on one account only.

**Required flow**
1. The staff member, signed in as P in the app, proves E with E's email and password (or Google).
2. The server confirms the Mongo staff row names E, and that E is active.
3. **Before any provider is moved**, the server decides what happens to P's app data.
4. Then: unlink the phone from P, link it to E, audit it, and notify both addresses.

**Blocker:** step 3 means moving or merging P's diamonds, beans, gifts and history, which is financial work you scoped out of this phase.

**Safe interim:** the existing `crm_directory._attach_app_identity` already puts the staff row's phone on E at invite time when the number is free. Use it for new staff, and use `scripts/link_owner_identities.py` for Owners. **Needs from you:** a decision on P's data (merge, keep separate, or refuse).

## 7. WP-H requirements (Observer break-glass)

**Goal:** recover Observer access if the code mailbox is lost, without a second permanent Observer.

**Requirements**
1. **Request:** any Owner may file a break-glass request with a reason (`POST /api/observer/break-glass`).
2. **Co-sign:** a *different* Owner co-signs within 24h, after a 15-minute cooling-off period. The requester can never self-approve.
3. **Effect:**
   - The server sends a one-time Observer code to a new mailbox named in the request.
   - The address is shown to both Owners before they sign.
   - The grant is valid for one session of at most 12h. It never changes the permanent Observer record.
   - Rotating the mailbox permanently is a separate co-signed action.
4. **Audit and notice:** every step is audited (`observer.break_glass_{requested, approved, used, expired}`), and every Owner, plus the old Observer mailbox, is emailed at each step.
5. **Limits:** one active request at a time. Requests expire after 24h, with an expired request also audited.

**Needs from you:** confirm the two-Owner rule and the 12h limit. This reuses the existing card or approval machinery if you prefer.

## 8. Test results (actual runs)

| Suite | Result |
|---|---|
| Backend, all modules (`python3 -m tests.<module>`, sandbox) | **85 / 85 modules pass** |
| └ `test_p1_tickets` | 46/46 |
| └ `test_p1_owner_mfa` | 68/68 (incl. RFC vectors, renewal, forged-claim refusal) |
| └ `test_p1_directory_privacy` | 16/16 |
| └ `test_partner_session` / `test_permissions` / `test_session_lifetime` | 541/541 · 250/250 · 247/247 |
| CRM `npx tsc --noEmit` | exit 0, no output |
| Firestore rules (p1gov, phase1a) | **NOT RUN.** There is no Java or emulator in the sandbox. Syntax checked with `node --check` only |
| Android unit tests + `assembleDebug` | **NOT RUN since D/A3/E.** Last green run: 305 tests, before these packages |

## 9. Please run on your Mac

```
cd tests && npm run test:p1gov            # demo-zipper; expect P1GOV-RESULT … failures=0
cd zipper-app && ./work-verify.command    # gradle exit 0, unit tests, assembleDebug
```

**`test:phase1a` uses `--project zipper-83816`** (pre-existing, hard-coded at `firestore.phase1a.rules.test.mjs:65`, and the same for `test:firestore`). It talks only to the local emulator, but it is not a `demo-` id. I did not change it. If you approve, I'll switch both to `demo-zipper`. Until then, run it knowingly or skip it.

Send me the result lines. A failure there is real and I will fix it; neither suite has been verified yet.

## 10. Rollout prerequisites (in order; none done)

1. Generate and set `OWNER_MFA_ENCRYPTION_KEY` (Secret Manager → Cloud Run). **Without it, Owners cannot finish signing in.** Enrolment fails closed.
2. Deploy the backend, then the CRM (the CRM needs the new routes).
3. Run `scripts/backfill_staff_roster.py --apply --project <id>`, then deploy the `staffRoster` index.
4. Deploy `firestore.rules` **after** step 3. Otherwise ticket writes from an old CRM tab, and roster pickers, fail until reload or backfill.
5. Owners enrol at their next sign-in and **save their recovery codes**.
6. After Owners have enrolled: `scripts/remove_gate_answers.py --apply --project <id>`.
7. Ship the Android build (ticket actions moved to the API; Owner MFA module).

## 11. Preservation

- No reset, clean, stash, revert, commit or push.
- 481 existing uncommitted or untracked paths remain as they were. Every file I edited was copied to `outputs/p1-exec/before/` first.
- `setup-email-and-deploy.command` shows as modified, but its last change is from 16 Oct, before this work; I did not open it.
- `run-release-validation-mac.sh` is untouched.
- No secrets files were opened.
- `ENFORCE_MOBILE_SESSION` is untouched.
- Financial logic is untouched.
