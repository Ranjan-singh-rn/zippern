# B1 — Readable Identity Display: implementation report (2026-10-22)

## 1. Initial state and preservation
- Branch `v5-scratch`, HEAD `1194e55`. The tree already held about 440 modified/untracked paths from earlier work. All of them were preserved: no reset, clean, stash, revert, checkout, commit or push.
- Pre-existing B1 files (`lib/identity.ts`, `lib/identityLookup.ts`, `lib/useIdentities.ts`, `components/ui/Identity.tsx`, `app/frozen-money/page.tsx`) were kept and built on.
- Before-copies of the two Kotlin screens and `package.json` are in the session scratch folder.

## 2. Verified findings (checked against the current code)
- **Agency title.** The app read `agencies/{id}.name`, but every writer stores the name as `agencyName`. The title therefore fell back to the raw agency id.
- **Referral code.** The app read `users/{uid}.referralCode`, which nothing writes. The backend issues the code on the agency record (`partner_ops.py` / `partner_applications.py` → `agencies/{id}.referralCode`).
- **Counts.** The app read `totalHosts` and `subAgenciesCount`. `totalHosts` is only ever written as 0 and is never incremented. `subAgenciesCount` has no writer at all. Both stats always showed 0.
- **Roster names.** Roster rows `agencies/{id}/agencyHosts/{uid}` carry `uid` and `name` (`users.py::_host_roster_row`, `functions/src/hosts.ts`), but the app showed only the word "Host" and the uid.
- **Seller dashboard buyers.** The API mirror (`recharges.py`) writes `buyerUid` but no `buyerName`, so rows showed "Unknown buyer". Any signed-in user may read `publicProfiles`, which holds names and photos only.
- **Seller history statuses.** History asked only for approved/rejected. Refund-pending, refunded and reversed requests (statuses the API mirrors) disappeared from it.

## 3. Files changed
### CRM
- `lib/identity.ts`: `subjectTarget` added; `Array.from` fix.
- The pages, all using the shared IdentityBlock/IdentityInline/useIdentities:
  - role-appeals, transfers, sales, recharges, board, operations/bans, audit;
  - finance/reports, partners, agencies/[id];
  - finance/withdrawals, hosts/verification, users/[uid] (Client and PartnerApplications);
  - coin-purchases, feedback;
  - agency-dashboard (CommissionDerivation, AgencyMoney, CommissionLedger);
  - components/SellerHistoryPanel, seller-dashboard.
- Contacts are shown only when the viewer has `can_view_users`. Partner-facing screens use `publicProfiles` names only. Every decision workflow is unchanged.
- New: `lib/identity.spec.ts`, plus a `test:identity` entry in `package.json` (added to the `test` chain before `test:hooks`).

### App
- New `util/AgencyIdentity.kt` and `util/RechargeDisplay.kt`: pure helpers with no Android or Firebase dependencies.
- `ui/screens/agency/AgencyDashboardScreen.kt`:
  - the title is `agencyName` (falling back to `name`), with a labelled "Agency ID" line;
  - the referral code is read from the agency record, showing "—" and "Not issued yet" when blank;
  - host rows show the roster name, a labelled "Host ID", and an avatar letter taken from the name;
  - Hosts = the current roster size (de-duplicated);
  - Sub-agencies shows "—" instead of a fabricated 0;
  - role rules and the payout submit are unchanged.
- `ui/screens/seller/SellerDashboardScreen.kt`:
  - buyer names come from `publicProfiles`, in batches of 30, best effort;
  - each row shows "Buyer ID" and "Request ID";
  - History now includes refund_pending, refunded and reversed, with accurate labels;
  - still read-only on requests; nothing about pricing, ledger or approval changed.
- New test `app/src/test/java/com/zipper/app/util/AgencyIdentityTest.kt`: 10 tests.

## 4. Backend
None. The seller buyer name uses the existing `publicProfiles` read rule; no endpoint, rule or schema was changed.

## 5. Tests
| Command | Result |
|---|---|
| `cd zipper-crm && node node_modules/typescript/bin/tsc --noEmit` | exit 0 |
| `cd zipper-crm && npm run test:identity` | 70/70 passed |
| `cd zipper-crm && npm test` (19 spec suites + `test:hooks` eslint) | exit 0. All 19 suites passed, including identity 70 and routing 8664. Hooks lint was clean. |
| CRM full lint | **Not run.** `package.json` has no `lint` script; only the hooks lint exists. |
| Android unit tests and build | **Not run.** The sandbox has no Android SDK and cannot download Kotlin or Gradle, because the network is blocked by the allowlist. Run on the Mac: `cd zipper-app && ./gradlew :app:testDebugUnitTest :app:assembleDebug` |
| Backend tests | Not needed (backend unchanged). |

## 6. Blocked items (documented, not invented)
- **App sub-agency count.** No field the app may read holds this count. A Firestore list query on `parentAgencyId` would only be allowed when the agency id equals the owner's uid, and the app has no API session for `GET /api/partners/agencies/{id}/sub-agencies`.
  - Smallest safe fix: have the server that registers or removes a sub-agency maintain `agencies/{id}.totalSubAgencies`, or add the count to an existing owner-authenticated app endpoint.
- **Roster host level, beans and verified chip.** These are not on the roster row; they would need a server-side projection.
- **Agency dashboard host contacts.** Not shown. The owner is not authorised to see them.

## 7. Confirmation
No production writes, deploys, commits, pushes, configuration changes or `--force` were used. Stopped after B1.
