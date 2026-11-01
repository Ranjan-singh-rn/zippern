# Zipper CRM: page-by-page inventory

Source: `zipper-crm/app/**/page.tsx`. There are **89 pages** (`find zipper-crm/app -name page.tsx | wc -l` = 89). The five dynamic routes (`/agencies/[id]`, `/agencies/[id]/salary`, `/approvals/[id]`, `/sellers/[id]`, `/users/[uid]`) are 7-line wrappers; their code is in `Client.tsx` and sibling files in the same directory.

This is a read-only inventory and no repo file was modified.

**Conventions**
- All `lib/api*.ts` paths are prefixed with `/api`, so `get('/cards/inbox')` is `GET /api/cards/inbox`.
- `canAccess(user, roles)` is true for `superadmin` or `roles.includes(user.role)`. It checks the primary `role` only, never `roles[]`.
- `hasPermission(user, p)` is true for `superadmin` or when `p` is in the *stored* `crmUsers.permissions` array.
- "API role" means `apiUser.role` from `GET /api/auth/me`, a backend `Role`. `owner` corresponds to CRM `superadmin`; `observer` has no CRM equivalent.

---

## 0. How access is enforced (applies to every page)

`zipper-crm/app/layout.tsx` (`AppShell`, `Sidebar`, `ObserverShell`, `resolveRedirect`):

1. **Public pages: no auth gate, no sidebar.** These are `/login`, `/observer`, `/agency-signup`, `/seller-signup` and `/appeal`.
2. **Pending pages: no sidebar, but a signed-in user is required.** These are `/agency-pending/*` and `/seller-pending/*`.
3. **Observer.** An API session with `role === 'observer'` and no `crmUsers` doc gets `ObserverShell`.
   - Content renders only when the path starts with one of `OBSERVER_ROUTES`: `/inbox`, `/board`, `/audit`, `/team-access`, `/partners`, `/reports`, `/finance`, `/alerts`, `/tech/email`, `/tech/jobs`.
   - Any other path shows "Not available to the observer".
4. **Signed out.** `lib/sessionGate.ts` decides this, and the user is redirected to `/login`.
5. **Partners** (`role` or `roles[]` contains `agency` or `seller`). `lib/partnerRouting.ts::resolvePartnerRedirect` restricts where they can be:
   - Each held capability allows its pending page (`/agency-pending`, `/seller-pending`).
   - Once `roleStatus[cap]` (or legacy `status`) is `approved`, its home is also allowed (`/agency-dashboard`, `/seller-dashboard`).
   - `/profile` is shared by all partners.
   - Any other path redirects to `partnerLanding`.
6. **Staff (superadmin and the 12 department roles): there is no hard route guard in the layout.**
   - The sidebar only hides links: `navLinks.filter(l => canAccess(crmUser, l.roles))`.
   - Any staff user can type any URL. Real enforcement is (a) the per-page guards listed below, (b) the API, and (c) `firestore.rules`.
   - Strict links: `/agency-dashboard` and `/seller-dashboard` are shown only to approved holders of that capability, with no superadmin bypass. Dual-role partners get `PartnerRoleSwitcher` instead.

Role sets used in the nav (`layout.tsx`):
- `STAFF_ROLES` = superadmin, app_admin, app_member, ops_admin, ops_member, finance_admin, finance_member, tech_admin, tech_member, support_admin, support_member, marketing_admin, marketing_member.
- `OVERSIGHT_ROLES` = superadmin, finance_admin, app_admin, ops_admin, tech_admin, support_admin, marketing_admin.

---

## 1. Dashboard and oversight

### / : `zipper-crm/app/page.tsx`
- **Roles:**
  - Nav is STAFF_ROLES. There is no page deny.
  - The page renders AgencyView if `partnerRolesOf(crmUser)[0]` is `agency`, SellerView if it is `seller`, and the staff dashboard otherwise.
  - Finance insight tiles and revenue panels need `canAccess(['superadmin','finance_admin','finance_member'])`.
  - Quick-action tiles are filtered per entry with `canAccess`.
  - Observer: no.
- **Reads (Firestore only, no API):**
  - `getStats()` (lib/firestore.ts:1070) runs count aggregations on:
    - `users`: all, isHost, isSeller, isSeller+isOnline, isBanned.
    - `liveRooms` where isActive.
    - `kycSubmissions` with status pending, `agencies` with status pending, `supportTickets` with status open.
    - `platformRevenue` and `appConfig/economy`.
  - `liveRooms` (`getActiveLiveRooms`).
  - Finance roles also read `platformRevenue`, collectionGroup `diamondTransactions` (type credit, limit 2000) and collectionGroup `beanTransactions` (limit 3000).
  - AgencyView reads `agencies where crmUid==uid`.
  - SellerView reads `sellers where crmUid==uid`, then `rechargeRequests where sellerUid==`.
- **Actions:** none. Navigation only.
- **Filters:** none. The top 5 live rooms are shown, newest first.
- **Purpose:** Home dashboard with KPIs, alerts, live rooms and finance insights, or a partner self-view.

### /inbox : `zipper-crm/app/inbox/page.tsx`
- **Roles:**
  - Nav is STAFF_ROLES.
  - The KYC/review block needs `canAccess(['superadmin','app_admin','ops_admin'])`.
  - The approvals count needs superadmin.
  - The signature queue needs API role `owner`.
  - Observer: yes (API parts only).
- **Reads:**
  - `GET /api/auth/me`, `GET /api/cards/inbox`, `GET /api/cards/awaiting-signature` (owner only).
  - `loadReviewQueues()` calls `GET /api/partner-ops/partners?kind=agency|sub_agency|seller&limit=…` and reads Firestore `agencies`, `sellers` and `hostApplications`.
  - Count of `approvalRequests` with status pending.
- **Actions:** Refresh. Everything else links out to /board, /kyc or /approvals.
- **Filters:** none.
- **Purpose:** Personal "waiting on you" summary.

### /board : `zipper-crm/app/board/page.tsx`
- **Roles:** Nav is STAFF_ROLES. Gating is by API role:
  - Sign, bulk-sign and execute are owner only. You cannot sign a card you raised or verified.
  - Verify and Reject are available to any non-observer.
  - Observer: yes, read-only.
- **Reads:**
  - `GET /api/cards?limit=300` and `GET /api/auth/me`.
  - Firestore identity lookups on `users`, `agencies` and `sellers` (documentId in).
- **Actions:**
  - Verify: `POST /api/cards/{id}/verify {note}`
  - Sign: `POST /api/cards/{id}/sign {note}`
  - Reject: `POST /api/cards/{id}/reject {reason}`
  - Bulk sign: `POST /api/cards/sign-bulk`
  - Execute balance card: `POST /api/users/balance-cards/{id}/execute`
- **Filters:** Kanban columns by stage. "Select all signable" option. No paging (300 cap).
- **Purpose:** Money-card maker/checker/owner sign-off board.

### /analytics : `zipper-crm/app/analytics/page.tsx`
- **Roles:**
  - Nav and page guard are both superadmin, app_admin, app_member, finance_admin, finance_member, ops_admin, ops_member.
  - Failing the guard runs `router.replace('/')`.
  - Observer: no.
- **Reads (Firestore only):**
  - Counts on `users` (isHost, isSeller, isAgent) and on `liveRooms`.
  - `platformRevenue`.
  - `users` orderBy createdAt, limit 500.
  - Top hosts: `users` isHost, orderBy beans, limit 10.
  - `appConfig/economy`.
- **Actions:** Refresh.
- **Filters:** none. Windows are fixed.
- **Purpose:** Growth, revenue, top-host and role-mix charts.

### /reports : `zipper-crm/app/reports/page.tsx`
- **Roles:**
  - Nav is OVERSIGHT_ROLES.
  - The page allows observer, or `canAccess(REPORT_ROLES)` where REPORT_ROLES = superadmin, finance_admin, **finance_member**, app_admin, ops_admin, tech_admin, support_admin, marketing_admin.
  - The API returns 403 per report card where access is narrower.
  - Observer: yes.
- **Reads:** all with since/until.
  - `GET /api/reports/cash-position`, `GET /api/reports/revenue?group_by=day`, `GET /api/reports/margin`
  - `GET /api/reports/channels`, `GET /api/reports/liabilities`, `GET /api/reports/team-throughput`
  - `GET /api/reports/definitions`, `GET /api/reports/partners/summary?kind=agency`, `GET /api/reports/audit-summary`
- **Actions:** CSV download for each report, using the same path with `&format=csv`.
- **Filters:** one date range.
- **Purpose:** Business reporting hub.

### /reports/weekly : `zipper-crm/app/reports/weekly/page.tsx`
- **Roles:**
  - Nav is OVERSIGHT_ROLES.
  - Read needs API role owner, observer or `*_admin`.
  - Re-run needs owner or `*_admin`.
  - Observer: yes, read-only.
- **Reads:** `GET /api/reports/weekly-business/{week}`.
- **Actions:**
  - Re-run: `POST /api/reports/jobs/weekly-business {week, force, top_n}`. The reason typed into the modal is not sent.
  - CSV for each section is built client-side.
- **Filters:** week picker (prev/next), revision picker, DataTable search/sort/paging (25 rows).
- **Purpose:** The stored weekly business report, with re-generation.

### /alerts : `zipper-crm/app/alerts/page.tsx`
- **Roles:**
  - Nav is OVERSIGHT_ROLES.
  - Read needs API role owner, observer or `*_admin`.
  - Release needs owner.
  - Observer: yes.
- **Reads:** `GET /api/notifications/alerts/open`, `GET /api/notifications/alerts/raised?limit=500`, `GET /api/notifications/alerts`.
- **Actions:** Release: `DELETE /api/notifications/alerts/raised/{key}` (owner only). Refresh.
- **Filters:** tabs open/raised/catalogue; detector, severity and status filters; date range (raised tab); DataTable search and paging.
- **Purpose:** Exception and alert log.

### /tickets : `zipper-crm/app/tickets/page.tsx`
- **Roles:**
  - Nav: superadmin, support_admin, support_member, tech_admin.
  - Page guard PAGE_ROLES: support_admin, support_member, tech_admin, **tech_member**, plus superadmin.
  - `isAdmin` (superadmin or support_admin) gets status, priority, assign and route.
  - support_member sees only tickets assigned to them.
  - Tech roles get a read-only escalated view.
  - Observer: no.
- **Reads (Firestore):**
  - `supportTickets` orderBy createdAt, limit 200, or `where assignedTo==uid` for support_member.
  - `crmUsers where role in [support_admin, support_member]`.
  - `crmUsers where role in [{team}_admin, {team}_member]`.
- **Actions (all direct Firestore writes):**
  - Reply: `supportTickets` update `{adminReply, status:'replied', repliedAt, updatedAt}`, plus addDoc `users/{uid}/notifications`.
  - Status / Priority / Assign: `supportTickets` updates.
  - Route to team: addDoc `techTickets`, then update `supportTickets {escalatedToTech, escalatedTeam, escalatedAt, escalationNote, linkedTeamTicketId}`.
  - Close: inline update `{status:'closed', closeReason, closedAt, closedByName}`.
- **Filters:** text search; priority, category and assignee filters; Kanban by status; overdue flags.
- **Purpose:** App support-ticket triage.

### /throughput : `zipper-crm/app/throughput/page.tsx`
- **Roles:**
  - Nav and page guard are STAFF_ROLES.
  - Superadmin and API owner/observer see all teams; everyone else is locked to their own team.
  - Observer: no (not on its prefix list).
- **Reads:** `GET /api/reports/team-throughput?since&until&team`.
- **Actions:** CSV export via the same path with `&format=csv`.
- **Filters:** date range, team select, DataTable search and paging.
- **Purpose:** Card throughput per team.

---

## 2. Users and hosts

### /users : `zipper-crm/app/users/page.tsx`
- **Roles:**
  - Nav: superadmin, app_admin, app_member, ops_admin, finance_admin, support_admin, support_member, tech_admin.
  - Page guard VIEW_ROLES is the same list plus **ops_member**.
  - Row buttons come from `userRowActionKeys` (lib/crmRoles.ts:153). Internal CRM accounts and yourself get no buttons.
  - Observer: no.
- **Reads (Firestore):**
  - `users` paged: where/orderBy/startAfter, limit 25.
  - Count queries on `users`.
  - `searchUsers`: prefix queries on name, email and phoneNumber, plus `getDoc(users/{term})`.
- **Actions:**
  - Ban: `POST /api/users/{uid}/ban`
  - Unban: `POST /api/users/{uid}/unban`
  - Suspend: `POST /api/users/{uid}/suspend {reason, days}`
  - Resume: `POST /api/users/{uid}/resume`
  - Client-side CSV export.
- **Filters:** chips (All, Hosts, Sellers, Banned, Active); server orderBy on createdAt, diamonds or beans; debounced search; cursor "Load more".
- **Purpose:** Browse, search and moderate app users.

### /users/[uid] : `zipper-crm/app/users/[uid]/{Client,HostRecord,PartnerApplications,UserActions}.tsx`
- **Roles:**
  - No nav link. Same VIEW_ROLES as /users.
  - Actions show only for an ordinary target (not an internal account, not yourself).
  - Warn with a deduction needs `can_adjust_balance`.
  - Role restore is owner only (API role).
  - Partner-application decisions need `can_approve_kyc` or `can_approve_seller`.
  - Observer: no.
- **Reads (Firestore):** `users/{uid}`; `users/{uid}/diamondTransactions` and `beanTransactions` (limit 50); `hostApplications` (activatedByUid / applicantUid); identity lookups on `agencies` and `sellers`.
- **Reads (API):**
  - `GET /api/users/{uid}/history?limit=200`, `GET /api/users/{uid}/warnings?limit=100`, `GET /api/users/{uid}/roles`
  - `GET /api/partner-ops/applications/of/{uid}`, `GET /api/documents/host/{appId}`
  - `GET /api/partner-ops/partners?kind=agency|sub_agency&status=approved&limit=500`
- **Actions:**
  - Ban, unban, suspend, resume: `POST /api/users/{uid}/{action}`
  - Warn: `POST /api/users/{uid}/warn {reason, request_id, deduction?}`
  - Adjust balance: `POST /api/users/{uid}/balance-request` (raises a card)
  - Host role: `POST /api/users/{uid}/revoke-host`, `POST /api/users/{uid}/restore-host`
  - Other roles: `POST /api/partner-ops/partners/{id}/revoke`, `POST /api/partner-ops/partners/{id}/reactivate`
  - Transfer: `POST /api/partner-ops/transfers {kind:'host',…}`
  - Application decision: `POST /api/users/host-applications/{id}/decide`, or `POST /api/partner-ops/partners/{id}/approve|reject`
- **Filters:** tabs Activity, Warnings, Diamonds and Beans, each with DataTable search.
- **Purpose:** Full single-user record and every moderation and role action.

### /hosts : `zipper-crm/app/hosts/page.tsx`
- **Roles:**
  - Nav: superadmin, app_admin, app_member, ops_admin, ops_member.
  - There is **no page deny**.
  - The Actions column needs `canAccess` with those same 5 roles.
  - Direct application edits need `role==='superadmin'`; everyone else's edit becomes a proposal.
  - Observer: no.
- **Reads:**
  - Firestore `users` where isHost (limit 500).
  - `hostApplications` where status in [pending, approved] and isActivated==false (limit 300).
  - `agencies` names.
  - `GET /api/documents/host/{appId}`.
- **Actions:**
  - Ban: `POST /api/users/{uid}/ban`
  - Unban: `POST /api/users/{uid}/unban`
  - Edit application: Firestore `hostApplications` update. This is a direct patch or a `pendingChanges` proposal via `submitPartnerUpdate` (lib/pendingChanges.ts:386/404/426).
- **Filters:** tabs All, Active, Banned and Invited; client-side search. No paging (caps 500/300).
- **Purpose:** Host and invited-host list, with ban and fact correction.

### /hosts/verification : `zipper-crm/app/hosts/verification/page.tsx`
- **Roles:**
  - Nav and guard: superadmin, app_admin, app_member, ops_admin, ops_member.
  - The observer is explicitly refused.
- **Reads:** `GET /api/host-verification/pending?limit=50`, `GET /api/host-verification/{uid}`, `agencies` names.
- **Actions:** Verify or Reject: `POST /api/host-verification/{uid}/review {verdict, reason}`.
- **Filters:** DataTable search. Queue is oldest first.
- **Purpose:** Face-photo identity verification that makes a host payable.

### /onboarding : `zipper-crm/app/onboarding/page.tsx`
- **Roles:**
  - Nav and guard are STAFF_ROLES.
  - Per-link gating:
    - `/agencies/register`: superadmin, app_admin.
    - `/sellers/register`: superadmin, app_admin, ops_admin, ops_member.
    - `/kyc`: superadmin, app_admin, ops_admin.
  - Observer: no.
- **Reads:** `GET /api/partner-ops/partners?kind=agency|sub_agency|seller&limit=500`; Firestore `agencies` and `sellers` with status pending (limit 200), used to count "stranded" signups.
- **Actions:** copy the public `/agency-signup` and `/seller-signup` URLs; links. No writes.
- **Filters:** none.
- **Purpose:** Partner-onboarding hub.

### /partners : `zipper-crm/app/partners/page.tsx`
- **Roles:**
  - Nav is STAFF_ROLES. There is no page role check; the API scopes the data.
  - Observer: yes.
- **Reads:**
  - `GET /api/partners/agencies/{id}/statement?since&until`, `GET /api/partners/agencies/{id}/hosts`
  - `GET /api/partners/sellers/{id}/statement`
  - `GET /api/partners/credit/exposure`, `GET /api/partners/credit/overdue`
  - `users` identity lookup.
- **Actions:** look-up only, plus Refresh. No writes.
- **Filters:** tabs agency, seller and exposure. Manual partner ID entry.
- **Purpose:** Agency and seller statements, plus the seller credit exposure/overdue report.

---

## 3. Partners: sellers, coins, sales

### /sellers : `zipper-crm/app/sellers/page.tsx`
- **Roles:**
  - Nav: superadmin, app_admin, ops_admin, ops_member.
  - Page guard: the same list plus **finance_admin and finance_member**.
  - Every row button needs `hasPermission('can_approve_seller')`. By default that is superadmin and ops_admin.
  - Observer: no.
- **Reads:**
  - `GET /api/partner-ops/partners?kind=seller&limit=500`, `GET /api/partners/credit/overdue?limit=200`, and `GET /api/partners/sellers/{id}/statement` once per seller.
  - Firestore `sellers` orderBy createdAt; `sellers where source=='second_role'`; `sellers where partnerRecordFailed==true`.
- **Actions:**
  - Approve, Reject, Deactivate: `POST /api/partner-ops/partners/{id}/approve|reject|deactivate {reason}`
  - Resend email: Firestore `sellers/{id}` update `{_resendEmail}`
  - Second-role file: `POST /api/partner-ops/partners/{heldId}/second-role`
  - Failed-registration retry: `POST /api/partner-ops/partners {partner_id, reason}`
- **Filters:** search; status and credit filters; default sort is overdue first, then outstanding; CSV export.
- **Purpose:** Coin-seller roster, credit standing and the application queue.

### /sellers/[id] : `zipper-crm/app/sellers/[id]/Client.tsx`
- **Roles:**
  - No nav link. Guard: superadmin, app_admin, ops_admin, ops_member, finance_admin, finance_member.
  - Decision buttons are not permission-gated in the UI (shown by status). The server enforces.
  - Restore of a revoked record and execute need API owner.
  - Issue virtual account needs owner or `*_admin`.
  - Observer: no.
- **Reads (API):**
  - `GET /api/partner-ops/partners/{id}`, `GET /api/users/{owner_crm_uid}/roles`, `GET /api/partners/sellers/{id}/statement`
  - `GET /api/cards?limit=400`, `GET /api/partners/sellers/{id}/can-take-inventory`
  - `GET /api/partners/sellers/{id}/history`, `GET /api/documents/seller/{id}`
- **Reads (Firestore):** `sellers/{id}`; identity lookups on `users`, `publicProfiles`, `agencies` and `sellers`.
- **Actions:**
  - Lifecycle: `POST /api/partner-ops/partners/{id}/activate|approve|reject|deactivate|reactivate|revoke`
  - Grant agency capability: `POST /api/partner-ops/partners/{id}/grant-capability`
  - Issue virtual account: `POST /api/partner-ops/partners/{id}/virtual-account`
  - Lend: `POST /api/partner-ops/sellers/{id}/lending`
  - Repay: `POST /api/partner-ops/sellers/{id}/repayments`
  - Recover: `POST /api/partner-ops/sellers/{id}/recoveries`
  - Write off: `POST /api/partner-ops/partners/{id}/write-off`
  - Execute (owner only): `POST /api/partner-ops/{coin-purchases|lending|repayments|recoveries|write-offs}/{card}/execute`
- **Filters:** tabs Transactions (date range), Ledger, Cards and Profile.
- **Purpose:** One seller's lifecycle, credit and ledger.

### /sellers/register : `zipper-crm/app/sellers/register/page.tsx`
- **Roles:**
  - No nav link. Guard: superadmin, app_admin, ops_admin, ops_member.
  - Superadmin creates the seller directly; others file an approval request.
  - Observer: no.
- **Reads:** `GET /api/partner-ops/registration/availability?email&phone`, `GET /api/partner-ops/payment-references/{utr}`, Firestore `sellers where email==`.
- **Actions (Submit):**
  1. Firebase Auth creates the user on a secondary app (rolled back on failure).
  2. Superadmin path:
     - addDoc `sellers`.
     - setDoc `crmUsers/{uid}` (role seller, status pending).
     - update `sellers/{id} {crmUid}`.
     - If there are opening coins: `POST /api/partner-ops/sellers/{id}/coin-purchases`.
  3. Others: addDoc `approvalRequests` (type `create_seller`).
  4. Storage uploads to `sellerPaymentProofs/` and `sellerDocs/crm/`.
- **Filters:** none (form).
- **Purpose:** Staff-side seller creation.

### /coin-purchases : `zipper-crm/app/coin-purchases/page.tsx`
- **Roles:**
  - Nav and guard: superadmin, finance_admin, finance_member.
  - Credit (execute) needs API owner.
  - Verify and Reject are gated by card stage only.
  - Observer: no.
- **Reads:**
  - `GET /api/cards?limit=400`, `GET /api/partner-ops/partners?kind=seller&limit=500`
  - `GET /api/partner-ops/payment-references/{ref}`, `GET /api/documents/{kind}/{id}`
  - Firestore `coinPurchaseRequests` with status pending, `diamondPacks`, `appConfig/economy`.
- **Actions:**
  - Raise, or convert a Firestore request: `POST /api/partner-ops/sellers/{sellerId}/coin-purchases`, with a Storage upload to `evidence/coinPurchases/`
  - Verify: `POST /api/cards/{id}/verify`
  - Reject: `POST /api/cards/{id}/reject`
  - Credit: `POST /api/partner-ops/coin-purchases/{id}/execute`
- **Filters:** stage tabs, text search; 400 cap.
- **Purpose:** Seller inventory money-in queue.

### /sales : `zipper-crm/app/sales/page.tsx`
- **Roles:**
  - Nav and guard: superadmin, ops_admin, ops_member, finance_admin, finance_member.
  - Approve needs API owner.
  - Buyer contacts need `can_view_users`.
  - Observer: no.
- **Reads:**
  - `GET /api/partner-ops/sales?limit=500`, `GET /api/partner-ops/partners?kind=seller&limit=500`
  - `GET /api/auth/me`, `GET /api/partners/sellers/{id}/statement`
  - Firestore `users` and `publicProfiles` (identity and buyer picker).
- **Actions:** File a sale: `POST /api/partner-ops/sales`. Approve: `POST /api/partner-ops/sales/{id}/approve`.
- **Filters:** date range, status and seller filters, search; limit 500.
- **Purpose:** Seller-to-buyer coin sales.

### /recharges : `zipper-crm/app/recharges/page.tsx`
- **Roles:**
  - Nav and guard: superadmin, ops_admin, ops_member, finance_admin, finance_member.
  - The actions column needs `hasPermission('can_coin_operations')`.
  - Approve and refund-decide also need `crmUser.role==='superadmin'`.
  - Observer: no.
- **Reads:** `GET /api/partner-ops/recharges?status=<tab>`; Firestore `users` identity lookups.
- **Actions:** `POST /api/partner-ops/recharges/{id}/approve|reject|refund`, `POST /api/partner-ops/recharges/{id}/refund/decide {approve, reason}`.
- **Filters:** status tabs, DataTable search.
- **Purpose:** Verify off-app buyer payments and handle refunds.

---

## 4. Partners: agencies, KYC, governance

### /agencies : `zipper-crm/app/agencies/page.tsx`
- **Roles:**
  - Nav: superadmin, app_admin, ops_admin.
  - Page guard: the same plus **finance_admin and finance_member**.
  - Row actions need `hasPermission('can_approve_kyc')`.
  - Observer: no.
- **Reads:**
  - `GET /api/partner-ops/partners?kind=agency|sub_agency&limit=500`, `GET /api/partner-ops/subagency-payouts/open`, and `GET /api/partners/agencies/{id}/statement` per agency.
  - Firestore `agencies` (limit 500); `users` and `hostApplications` where agencyId== (roster); second-role and failed-registration queries on `agencies`.
- **Actions:**
  - Approve, Reject, Deactivate: `POST /api/partner-ops/partners/{id}/approve|reject|deactivate`
  - Resend email: Firestore `agencies/{id}` update `{_resendEmail}`
  - Second role: `POST /api/partner-ops/partners/{heldId}/second-role`
  - Retry: `POST /api/partner-ops/partners`
- **Filters:** status and type filters, search, sort by commission outstanding; CSV export.
- **Purpose:** Agency and sub-agency roster and decisions.

### /agencies/[id] : `zipper-crm/app/agencies/[id]/Client.tsx`
- **Roles:**
  - No nav link. Guard: the same 5 roles as /agencies.
  - Decision buttons are not gated in the UI; the API returns 403.
  - Restore and execute need API owner.
  - Transfer recommendation needs owner or `can_approve_kyc`.
  - Observer: no.
- **Reads (API):**
  - `GET /api/partner-ops/partners/{id}`, `GET /api/users/{owner_crm_uid}/roles`
  - `GET /api/partners/agencies/{id}/statement`, `GET /api/partners/agencies/{id}/hosts`, `GET /api/partners/agencies/{id}/sub-agencies`
  - `GET /api/partner-ops/subagency-payouts/open`, `GET /api/cards?limit=N`, `GET /api/documents/agency/{id}`
- **Reads (Firestore):** `agencies/{id}`, `users` and `hostApplications` (roster).
- **Actions:**
  - Lifecycle: `POST /api/partner-ops/partners/{id}/activate|approve|reject|deactivate|reactivate|revoke`
  - Commission payout: `POST /api/partner-ops/agencies/{id}/commission-payouts`
  - Sub-agency payout: `POST /api/partner-ops/subagency-payouts`
  - Execute: `POST /api/partner-ops/commission-payouts/{card}/execute`, `POST /api/partner-ops/subagency-payouts/{card}/execute`
  - Confirm leg: `POST /api/partner-ops/subagency-payouts/{id}/confirm-leg`
  - Transfer: `POST /api/partner-ops/transfers`
- **Filters:** tabs statement, hosts, subs and profile.
- **Purpose:** Full agency record and payouts.

### /agencies/[id]/salary : `zipper-crm/app/agencies/[id]/salary/Client.tsx`
- **Roles:**
  - No nav link. Guard: superadmin, app_admin.
  - Buttons need `canAccess(['finance_admin','superadmin'])`, so in practice only superadmin can act.
  - Observer: no.
- **Reads:** Firestore `agencies/{id}`; `salaryRequests where agencyId==`.
- **Actions:**
  - Approve: Firestore `salaryRequests/{id}` update `{status:'approved', approvedAt}`.
  - Raise card: `POST /api/partner-ops/hosts/{hostUid}/withdrawals {beans, reason, request_collection:'salaryRequests', request_id}`.
  - Reject is defined but not wired to any button.
- **Filters:** status tabs.
- **Purpose:** Review agency host-salary requests.

### /agencies/register : `zipper-crm/app/agencies/register/page.tsx`
- **Roles:**
  - No nav link. Guard: superadmin, app_admin.
  - Superadmin creates directly; others file an approval request.
  - Observer: no.
- **Reads:** `agencies/{parentId}`, `GET /api/partner-ops/registration/availability`, `agencies where ownerEmail==`.
- **Actions:**
  - Storage upload to `kyc/agencies/temp/`.
  - Auth user on a secondary app.
  - Superadmin path: addDoc `agencies`, setDoc `crmUsers/{uid}` (role agency, pending), update `agencies/{id} {crmUid}`.
  - Others: addDoc `approvalRequests` (`create_agency`).
- **Filters:** none (wizard).
- **Purpose:** Register a main or sub agency.

### /kyc : `zipper-crm/app/kyc/page.tsx`
- **Roles:**
  - Nav and guard: superadmin, app_admin, ops_admin.
  - Decisions need `can_approve_kyc`.
  - Observer: no.
- **Reads:** `GET /api/partner-ops/partners?kind=…&limit=500`; Firestore `agencies` (400), `sellers` (400), `hostApplications` (500); failed-registration queries; `GET /api/documents/{kind}/{id}`.
- **Actions:**
  - Partner decision: `POST /api/partner-ops/partners/{id}/approve|reject`
  - Host decision: `POST /api/users/host-applications/{id}/decide`
  - Host re-approval: `POST /api/users/host-applications/{id}/pending-changes/decide`
  - Partner re-approval: `POST /api/partner-ops/partners/{id}/pending-changes/decide`
  - Register: `POST /api/partner-ops/partners`
- **Filters:** category tabs, status filter, search, sort (pending first, oldest).
- **Purpose:** The unified KYC queue.

### /role-appeals : `zipper-crm/app/role-appeals/page.tsx`
- **Roles:**
  - Nav: superadmin, ops_admin. Guard: the same, or API owner.
  - Recommend needs owner or `can_approve_kyc` (`can_approve_seller` for seller appeals).
  - Decide is owner only.
  - Observer: no.
- **Reads:** `GET /api/partner-ops/role-appeals?status=open|all`; identity lookups.
- **Actions:** `POST /api/partner-ops/role-appeals/{id}/recommend`, `POST /api/partner-ops/role-appeals/{id}/decide`.
- **Filters:** tabs open and all.
- **Purpose:** Reinstatement requests for revoked roles.

### /transfers : `zipper-crm/app/transfers/page.tsx`
- **Roles:**
  - Nav: superadmin, ops_admin. Guard: the same, or API owner.
  - Decide is owner only.
  - Observer: no.
- **Reads:** `GET /api/partner-ops/transfers?status=open|all`; `agencies` and `users` lookups.
- **Actions:** `POST /api/partner-ops/transfers/{id}/decide {approve, note}`.
- **Filters:** tabs open and all.
- **Purpose:** Owner decides host and sub-agency moves.

### /frozen-money : `zipper-crm/app/frozen-money/page.tsx`
- **Roles:** Nav and guard: superadmin only. Observer: no.
- **Reads:** `GET /api/partner-ops/frozen-money?status=frozen|withheld`; identity lookups.
- **Actions:** Release, Withhold, Adjust: `POST /api/partner-ops/frozen-money/{key}/decide`.
- **Filters:** status tabs.
- **Purpose:** Decide what happens to money frozen on suspension or revocation.

### /approvals : `zipper-crm/app/approvals/page.tsx`
- **Roles:**
  - Nav: superadmin. Guard: superadmin (otherwise `router.push('/')`).
  - Observer: no.
- **Reads:** Firestore `approvalRequests` orderBy requestedAt (limit 300) and the pending count; embedded KycApprovals (same reads as /kyc).
- **Actions:**
  - Approve or Reject: Firestore `approvalRequests/{id}` update `{status, reviewedBy, reviewedAt, reviewNotes}`.
  - KycApprovals: same API calls as /kyc.
- **Filters:** status tabs, type category.
- **Purpose:** Superadmin approval-request queue.

### /approvals/[id] : `zipper-crm/app/approvals/[id]/Client.tsx`
- **Roles:** superadmin only. Observer: no.
- **Reads:** `approvalRequests/{id}`, `hostApplications/{targetDocId}`, `GET /api/documents/host/{id}`.
- **Actions:** Approve or Reject: Firestore `approvalRequests/{id}` update.
- **Filters:** none.
- **Purpose:** Approval request detail.

---

## 5. Finance

All `/finance/*` pages use `FINANCE_ROLES = ['superadmin','finance_admin']` with `allowed = isObserver || canAccess(...)`. Nav lists the same roles. **finance_member is refused on purpose.** The observer is allowed on all of them.

### /finance : `zipper-crm/app/finance/page.tsx`
- **Roles:** see above.
- **Reads:**
  - `GET /api/reports/cash-position`, `GET /api/reports/liabilities`, `GET /api/reports/definitions`
  - `GET /api/cards/inbox`, `GET /api/cards?stage=approved&limit=200`, `GET /api/partners/credit/overdue`
- **Actions:** CSV for cash-position and liabilities (`&format=csv`).
- **Filters:** date range, table search.
- **Purpose:** Finance hub.

### /finance/cash : `zipper-crm/app/finance/cash/page.tsx`
- **Reads:** `GET /api/reports/cash-position`.
- **Actions:** CSV.
- **Filters:** date range, search.
- **Purpose:** Cash in and out by channel.

### /finance/liabilities : `zipper-crm/app/finance/liabilities/page.tsx`
- **Reads:** `GET /api/reports/liabilities`.
- **Actions:** CSV, Refresh.
- **Filters:** search.
- **Purpose:** Point-in-time liabilities.

### /finance/payouts : `zipper-crm/app/finance/payouts/page.tsx`
- **Roles:** Approve and Reject need `!isObserver && canAccess(FINANCE_ROLES)`. The Firestore read is skipped for the observer.
- **Reads:** `GET /api/reports/payouts`, `GET /api/cards?stage=approved&limit=200`; Firestore `weeklyPayoutReports` (limit 200) and `hostPayouts where reportId==`.
- **Actions:**
  - Approve: `weeklyPayoutReports/{id}` update `{status:'approved', approvedBy, approvedAt}`.
  - Reject: `weeklyPayoutReports/{id}` update `{status:'rejected', rejectedReason, …}`.
  - CSV.
- **Filters:** date range, status, search, 25 per page.
- **Purpose:** Weekly agency payout reports.

### /finance/withdrawals : `zipper-crm/app/finance/withdrawals/page.tsx`
- **Roles:** Approve, Reject and Raise need a non-observer crmUser. Execute needs API owner.
- **Reads:** `GET /api/reports/payouts`, `GET /api/cards?stage=approved&limit=200`; Firestore `withdrawalRequests` (limit 100), plus `agencies` and `sellers` lookups.
- **Actions:**
  - Approve: `withdrawalRequests/{id}` update `{status:'approved', processedAt, processedBy}`.
  - Reject: `withdrawalRequests/{id}` update `{status:'rejected', rejectionReason, …}`.
  - Raise card: `POST /api/partner-ops/hosts/{hostUid}/withdrawals`.
  - Execute: `POST /api/partner-ops/host-withdrawals/{cardId}/execute {payment_ref}`.
  - CSV.
- **Filters:** date range, status, search.
- **Purpose:** Host withdrawal queue and execution.

### /finance/profit : `zipper-crm/app/finance/profit/page.tsx`
- **Reads:** `GET /api/reports/margin`, `GET /api/reports/revenue?group_by`, `GET /api/reports/channels`.
- **Actions:** CSV ×3.
- **Filters:** date range, group-by, search, 30 per page.
- **Purpose:** Revenue, margin and channel P&L.

### /finance/costs : `zipper-crm/app/finance/costs/page.tsx`
- **Roles:** Write needs a non-observer apiUser. Mark paid needs API owner.
- **Reads:** `GET /api/expenses?period`, `GET /api/expenses/recurring-due?period`.
- **Actions:**
  - New expense: `POST /api/expenses`
  - Repeat: `POST /api/expenses/{id}/repeat`
  - Mark paid: `POST /api/expenses/{id}/pay`
  - Storage upload to `evidence/expenses/`.
- **Filters:** month picker, grouped by category.
- **Purpose:** Operating-cost register.

### /finance/capital : `zipper-crm/app/finance/capital/page.tsx`
- **Roles:** Record needs a non-observer. Settle needs API owner.
- **Reads:** `GET /api/capital`, `GET /api/cards?limit=300`.
- **Actions:** Record movement: `POST /api/capital`. Settle: `POST /api/capital/{cardId}/settle`.
- **Filters:** none.
- **Purpose:** Owners' capital account.

### /finance/reports : `zipper-crm/app/finance/reports/page.tsx`
- **Reads:** `GET /api/reports/partners/summary?kind=agency`, `GET /api/partners/agencies/{id}/hosts?since`; `users` lookups.
- **Actions:** CSV.
- **Filters:** date range (presets), search, 50 per page.
- **Purpose:** Weekly agency payout run.

### /lending : `zipper-crm/app/lending/page.tsx`
- **Roles:**
  - Nav and guard: superadmin, finance_admin, finance_member, ops_admin.
  - No per-button gating.
  - Observer: no.
- **Reads:**
  - `GET /api/partner-ops/partners?kind=seller&limit=500`, `GET /api/partners/credit/exposure`
  - `GET /api/partners/credit/overdue?limit=200`, `GET /api/partner-ops/partners/{id}`
- **Actions:**
  - Lend: `POST /api/partner-ops/sellers/{id}/lending`
  - Repay: `POST /api/partner-ops/sellers/{id}/repayments`
  - Recover: `POST /api/partner-ops/sellers/{id}/recoveries`
  - Write off: `POST /api/partner-ops/partners/{id}/write-off`
  - All of these raise cards.
- **Filters:** standing filter, search, sort by standing and outstanding.
- **Purpose:** Seller credit book.

---

## 6. Tech, content, economy

### /tech : `zipper-crm/app/tech/page.tsx`
- **Roles:** Nav and guard: superadmin, tech_admin, tech_member. Observer: no.
- **Reads:** Firestore `techTickets`, `gifts`, `contentConfig/levels/items`.
- **Actions:** none.
- **Filters:** none.
- **Purpose:** Tech overview counts.

### /tech/content : `zipper-crm/app/tech/content/page.tsx`
- **Roles:** Nav and guard: tech roles. No per-button gating.
- **Reads:** `gifts`, `bagItems`, `appConfig/economy`.
- **Actions:**
  - Gift add, edit, toggle: `gifts` addDoc and update.
  - Bag item add, edit, toggle: `bagItems` addDoc and update.
  - Storage uploads to `contentAssets/gifts/…` and `contentAssets/bag_items/…`.
- **Filters:** 6 tabs, filtered by category.
- **Purpose:** Gift and cosmetic catalogue.

### /tech/payments : `zipper-crm/app/tech/payments/page.tsx`
- **Roles:** tech roles.
- **Reads:** `paymentConfig`.
- **Actions:** Toggle method or add country: setDoc (merge) `paymentConfig/{cc}` `{methods, updatedAt}`.
- **Filters:** sorted by country.
- **Purpose:** Payment methods per country.

### /tech/appcontrol : `zipper-crm/app/tech/appcontrol/page.tsx`
- **Roles:**
  - No nav link. Guard: tech roles (otherwise `router.push('/')`).
  - Superadmin writes directly; others file an approval request.
- **Reads:** `appConfig/control`.
- **Actions:**
  - Superadmin Save: setDoc `appConfig/control` `{maintenanceMode, maintenanceMessage, forceUpdate, minVersion, featureFlags, updatedAt, updatedBy}`.
  - Others: addDoc `approvalRequests` (`update_config`).
- **Filters:** none.
- **Purpose:** Maintenance mode, force update and feature flags.

### /tech/jobs : `zipper-crm/app/tech/jobs/page.tsx`
- **Roles:**
  - Nav is OVERSIGHT_ROLES.
  - Read needs API owner, observer or `*_admin`. Trigger needs owner or `*_admin`.
  - Observer: yes.
- **Reads:** `GET /api/notifications/runs/last`, `GET /api/notifications/schedule`, `GET /api/notifications/runs?limit=100`.
- **Actions:**
  - `POST /api/notifications/jobs/daily`
  - `POST /api/notifications/jobs/monthly?with_statements=true`
  - `POST /api/notifications/jobs/partner-statements?…`
  - `POST /api/notifications/jobs/alerts`
  - `POST /api/notifications/jobs/transactional-sweep`
  - The reason typed into the modal is not sent.
- **Filters:** run history per job.
- **Purpose:** Scheduled-job health and re-runs.

### /tech/email : `zipper-crm/app/tech/email/page.tsx`
- **Roles:** Nav is OVERSIGHT_ROLES. Read needs API owner, observer or `*_admin`. Observer: yes.
- **Reads:**
  - `GET /api/notifications/deliveries/summary?hours`
  - `GET /api/notifications/deliveries/failures?hours&limit=500`
  - `GET /api/notifications/deliveries?since&limit=500&outcome&kind&to`
- **Actions:** none.
- **Filters:** hours, outcome, kind and to (URL params and server-side); failures toggle.
- **Purpose:** Email delivery log.

### /tech/tickets : `zipper-crm/app/tech/tickets/page.tsx`
- **Roles:**
  - Nav and guard: STAFF_ROLES.
  - The team filter defaults to the user's own department.
  - Observer: no.
- **Reads:** `techTickets`; `crmUsers where role in [{dept}_admin, {dept}_member]`.
- **Actions:**
  - Create: addDoc `techTickets`.
  - Move status, reassign, set or clear blocker: `techTickets/{id}` update.
- **Filters:** search; team, priority, category, assignee and blocked filters; Kanban.
- **Purpose:** Cross-department team ticket board.

### /gifts : `zipper-crm/app/gifts/page.tsx`
- **Roles:**
  - Nav: superadmin, app_admin, ops_admin. There is **no page guard**.
  - Edit needs `canAccess(['superadmin','app_admin','ops_admin','ops_member'])`.
  - Observer: no.
- **Reads:** `gifts`, `appConfig/economy`.
- **Actions:**
  - Add or Seed: `gifts` addDoc. Edit or toggle: update. Delete: deleteDoc.
  - Storage upload to `contentAssets/gifts/`.
- **Filters:** category filter, name search.
- **Purpose:** Gift price and earning-rate catalogue.

### /economy : `zipper-crm/app/economy/page.tsx`
- **Roles:** Nav and guard: superadmin, finance_admin, finance_member, ops_admin. Observer: no.
- **Reads:** `appConfig/economy`.
- **Actions:** none.
- **Filters:** a commission-preview input.
- **Purpose:** Economy explainer.

### /economy/config : `zipper-crm/app/economy/config/page.tsx`
- **Roles:**
  - Nav and guard: superadmin, finance_admin.
  - Superadmin saves directly; finance_admin files an approval request.
- **Reads:** `appConfig/economy`.
- **Actions:**
  - Superadmin: setDoc (merge) `appConfig/economy` (gift rates, call pricing and split, pack prices, payout thresholds, commission slabs, FX, plus `deleteField` on legacy fields).
  - finance_admin: addDoc `approvalRequests` (`update_config`).
- **Filters:** none.
- **Purpose:** Master economy config.

### /economy/currency : `zipper-crm/app/economy/currency/page.tsx`
- **Roles:** Nav and guard: superadmin, finance_admin, finance_member. Observer: no.
- **Reads:** `users` (limit 500), `sellers` (limit 200), exact-match queries, `users/{uid}/beanTransactions|diamondTransactions`, `sellers/{id}/diamondLending`.
- **Actions:**
  - Balance change: `POST /api/users/{uid}/balance-request`
  - Lend: `POST /api/partner-ops/sellers/{id}/lending`
  - Repay: `POST /api/partner-ops/sellers/{id}/repayments`
  - Recover: `POST /api/partner-ops/sellers/{id}/recoveries`
- **Filters:** user/seller toggle, search, 20 per page.
- **Purpose:** Balance lookup and money cards.

---

## 7. Chance, live, feedback, broadcasts

The chance role sets are in `lib/apiChance.ts`:
- `CHANCE_READ_ROLES` = the 13 staff roles.
- `CHANCE_TEAM_ADMIN_ROLES` = superadmin and the 6 `*_admin` roles.
- `CHANCE_OWNER_ROLES` = superadmin.
- `CHANCE_FREEZE_ROLES` = superadmin, ops_admin.
- `CHANCE_MONEY_ROLES` = superadmin, finance_admin.

The page code accepts the observer, but `/chance` is not in `OBSERVER_ROUTES`, so the layout blocks it.

### /chance : `zipper-crm/app/chance/page.tsx`
- **Roles:** Read: CHANCE_READ_ROLES. New mechanic: team admins. Money tile: money roles.
- **Reads:** `GET /api/chance/mechanics`.
- **Actions:** `POST /api/chance/mechanics {mechanic_id, kind, name, reason}`.
- **Filters:** none.
- **Purpose:** Register of chance mechanics.

### /chance/configure : `zipper-crm/app/chance/configure/page.tsx`
- **Roles:** Edit and propose: team admins. Activate and withdraw: superadmin.
- **Reads:** `GET /api/chance/mechanics`, `GET /api/chance/mechanics/{id}`, `GET /api/cards?limit=200`.
- **Actions:**
  - Preview: `POST /api/chance/configs/preview`
  - Propose: `POST /api/chance/mechanics/{id}/configs`
  - Activate: `POST /api/chance/configs/{cardId}/activate`
  - Withdraw a country: `POST /api/chance/mechanics/{id}/withdraw-country`
- **Filters:** `?mechanic=` URL param.
- **Purpose:** Probability and payout tables, RTP.

### /chance/exposure : `zipper-crm/app/chance/exposure/page.tsx`
- **Roles:** Suspend: team admins. Resume: superadmin.
- **Reads:** `GET /api/chance/exposure`.
- **Actions:** `POST /api/chance/mechanics/{id}/suspend`, `POST /api/chance/mechanics/{id}/resume`.
- **Filters:** none.
- **Purpose:** Exposure vs reserve.

### /chance/monitoring : `zipper-crm/app/chance/monitoring/page.tsx`
- **Roles:** Freeze: superadmin, ops_admin.
- **Reads:** `GET /api/chance/mechanics`, `GET /api/chance/mechanics/{id}/rtp?days`, `GET /api/chance/exceptions?hours`, `GET /api/chance/players/{uid}/anomalies?hours`.
- **Actions:** `POST /api/chance/players/{uid}/freeze`, `POST /api/chance/players/{uid}/unfreeze`.
- **Filters:** mechanic, days, hours, `?player=`.
- **Purpose:** RTP divergence and anomaly monitoring.

### /chance/protection : `zipper-crm/app/chance/protection/page.tsx`
- **Roles:** Decide: team admins.
- **Reads:** `GET /api/chance/protection/flags?status&limit=200`, `GET /api/chance/protection/players/{uid}`.
- **Actions:**
  - `POST /api/chance/protection/flags/{flagId}/review`
  - `POST /api/chance/protection/players/{uid}/limits`
  - `POST /api/chance/protection/players/{uid}/self-exclusion/decide`
- **Filters:** status, `?player=`.
- **Purpose:** Responsible-gaming queue.

### /chance/money : `zipper-crm/app/chance/money/page.tsx`
- **Roles:** Nav and guard: superadmin, finance_admin.
- **Reads:** `GET /api/reports/chance-revenue?since`, `GET /api/reports/chance-margin?since`, `GET /api/reports/cannibalisation?since`.
- **Actions:** none.
- **Filters:** 7, 30 or 90 day window.
- **Purpose:** Chance GGR and margin.

### /live : `zipper-crm/app/live/page.tsx`
- **Roles:**
  - Nav: superadmin, app_admin, app_member, ops_admin, ops_member, tech_admin, tech_member, support_admin. The page guard is the same.
  - Warn and ban: app_admin, app_member, ops_admin, ops_member.
  - Mute and end: **API role** owner, ops_admin or ops_member.
  - Observer: no.
- **Reads:** Firestore `liveRooms` where isActive (limit 300), polled.
- **Actions:**
  - Warn: `POST /api/users/{hostUid}/warn`
  - Ban: `POST /api/users/{hostUid}/ban`
  - End: `POST /api/users/live-rooms/{roomId}/end`
  - Mute: `POST /api/users/live-rooms/{roomId}/mute`
  - Watch: callable `generateAgoraToken` (asia-south1).
- **Filters:** poll interval; flagged rooms first, then by viewers.
- **Purpose:** Live-room monitor and moderation.

### /feedback : `zipper-crm/app/feedback/page.tsx`
- **Roles:**
  - Nav: superadmin, app_admin, support_admin, support_member, tech_admin, ops_admin.
  - Page guard: the same plus **app_member**.
  - Observer: no.
- **Reads:** `feedbackTickets` (limit 200).
- **Actions:** Firestore `feedbackTickets/{id}` updates for assign-to-me, priority, status (with note), send response and close.
- **Filters:** search; status, category, priority and assignee filters; overdue flags.
- **Purpose:** Feedback triage (support view).

### /broadcasts : `zipper-crm/app/broadcasts/page.tsx`
- **Roles:** Nav and guard: superadmin, marketing_admin, marketing_member. Observer: no.
- **Reads:** `broadcasts` (limit 100).
- **Actions:** Send: addDoc `broadcasts` `{title, body, senderName, imageUrl:'', targetGender:'all', createdAt, type:'admin'}`.
- **Filters:** none.
- **Purpose:** In-app announcements.

### /broadcasts/email : `zipper-crm/app/broadcasts/email/page.tsx`
- **Roles:**
  - Nav: superadmin, marketing_admin, marketing_member, support_admin, ops_admin, app_admin, finance_admin, tech_admin.
  - The page needs an apiUser and shows Denied if no audience has `may_send`. The API decides each audience.
- **Reads:** `GET /api/broadcasts/audiences`, `GET /api/broadcasts/audience?audience&sample=25`.
- **Actions:** `POST /api/broadcasts/email {audience, subject, body, reason, identity?, attachments, confirm_recipients?}`.
- **Filters:** audience and sender pickers.
- **Purpose:** Email broadcast composer.

---

## 8. Operations, moderation, app config

### /operations : `zipper-crm/app/operations/page.tsx`
- **Roles:** Nav and guard: superadmin, ops_admin, ops_member (otherwise `router.push('/')`). Observer: no.
- **Reads:** Firestore `reports` (200), `bannedDevices`, `opsTickets` (200), `feedbackTickets` (200).
- **Actions:** none (links only).
- **Filters:** none.
- **Purpose:** Ops overview counts.

### /operations/appeals : `zipper-crm/app/operations/appeals/page.tsx`
- **Roles:**
  - No sidebar link.
  - Guard: superadmin, ops_admin, ops_member, app_admin, app_member, support_admin.
  - No per-button gating.
- **Reads:** `GET /api/users/appeals?limit=200&status`, `GET /api/users/appeals/{id}/evidence`.
- **Actions:** `POST /api/users/appeals/{id}/decide {verdict, reason}`.
- **Filters:** status tabs (server-side).
- **Purpose:** Ban and suspension appeals.

### /operations/bans : `zipper-crm/app/operations/bans/page.tsx`
- **Roles:** Nav: superadmin, ops_admin, ops_member. Guard: the same plus app_admin and app_member.
- **Reads:** `GET /api/users/devices/bans?limit=500`; `users` lookups.
- **Actions:** `POST /api/users/devices/bans`, `POST /api/users/devices/bans/{deviceId}/unban`.
- **Filters:** device lookup, search.
- **Purpose:** Device bans.

### /operations/feedback : `zipper-crm/app/operations/feedback/page.tsx`
- **Roles:** Nav and guard: superadmin, ops_admin, ops_member, support_admin, support_member.
- **Reads:** `feedbackTickets` (200).
- **Actions:** Status change: `feedbackTickets/{id}` update `{status, statusNote, statusChangedAt, statusChangedByName, resolvedAt?}`.
- **Filters:** status tabs, type, priority, search.
- **Purpose:** Feedback triage (ops view).

### /operations/reports : `zipper-crm/app/operations/reports/page.tsx`
- **Roles:** Nav: ops roles. Guard: superadmin, ops_admin, ops_member, app_admin, app_member, support_admin.
- **Reads:** `GET /api/users/reports?limit=200&status`.
- **Actions:** `POST /api/users/reports/{id}/action {action: ban|suspend|deduct|warn|dismiss, reason, days?, beans?}`.
- **Filters:** status tabs, search, sort.
- **Purpose:** User-report queue.

### /moderation : `zipper-crm/app/moderation/page.tsx`
- **Roles:** Nav: superadmin, ops_admin, ops_member, app_admin, support_admin. Guard: the same plus app_member.
- **Reads:** `GET /api/users/reports?limit=100&status=pending`, `GET /api/users/devices/bans?limit=100`, and `GET /api/audit?action=user.banned|suspended|resumed|warned&subject_type=user&limit=100`.
- **Actions:** none.
- **Filters:** kind filter, search.
- **Purpose:** Merged moderation feed.

### /app-config : `zipper-crm/app/app-config/page.tsx`
- **Roles:** superadmin only (nav and guard).
- **Reads, actions:** none (links).
- **Purpose:** Landing page for the config sections.

### /app-config/bag-items : `zipper-crm/app/app-config/bag-items/page.tsx`
- **Roles:** superadmin.
- **Reads:** `bagItems`; `users` (exclusive-user picker).
- **Actions:**
  - Save or Save all: setDoc `bagItems/{id}`.
  - Toggle: update.
  - Seed defaults: setDoc.
  - Storage upload to `contentAssets/bag_items/`.
- **Filters:** category tabs.
- **Purpose:** Cosmetic catalogue.

### /app-config/packages : `zipper-crm/app/app-config/packages/page.tsx`
- **Roles:** superadmin.
- **Reads:** `rechargePackages`, `diamondPacks`, `appConfig/economy`, and the external `open.er-api.com` FX feed.
- **Actions:** setDoc and deleteDoc on `rechargePackages/{id}` and `diamondPacks/{id}`.
- **Filters:** tabs.
- **Purpose:** Recharge and wholesale packs.

### /app-config/daily-rewards : `zipper-crm/app/app-config/daily-rewards/page.tsx`
- **Roles:** superadmin.
- **Reads:** `appConfig/dailyRewards`.
- **Actions:** setDoc `{schedule, updatedAt}`.
- **Purpose:** 7-day login rewards.

### /app-config/profile-options : `zipper-crm/app/app-config/profile-options/page.tsx`
- **Roles:** superadmin.
- **Reads:** `appConfig/profileOptions`.
- **Actions:** setDoc `{hobbies, likes, liveCategories, supportCategories, maxLanguages, updatedAt}`.
- **Purpose:** Profile tag lists.

### /app-config/levels : `zipper-crm/app/app-config/levels/page.tsx`
- **Roles:** superadmin.
- **Reads:** `levelConfig/user/levels`, `levelConfig/host/levels`.
- **Actions:** setDoc on `levelConfig/user/levels/{n}` and `levelConfig/host/levels/{n}` (merge), plus Seed all.
- **Filters:** user and host tabs.
- **Purpose:** XP and host levels.

### /app-config/payment-creds : `zipper-crm/app/app-config/payment-creds/page.tsx`
- **Roles:** superadmin.
- **Reads:** `appConfig/paymentCredentials`.
- **Actions:** setDoc `{binanceUid, bankName, bankIfsc, bankAccount, bankHolder, bankBranch, updatedAt}`.
- **Purpose:** Bank and Binance details shown on the app's buy-coins screen.

---

## 9. Account, team, partner portals

### /profile : `zipper-crm/app/profile/page.tsx`
- **Roles:**
  - Nav is STAFF_ROLES. It is also the partner shared path.
  - There is no guard. The page branches by `primaryPartnerRole`, and dual-role partners get a switcher.
  - Observer: no.
- **Reads:** staff: `GET /api/staff/me`; agency: `agencies/{id}`; seller: `sellers/{id}`.
- **Actions:**
  - Save contact: `crmUsers/{uid}` update `{displayName, phone, personalEmail, address, photoUrl}`.
  - Partner business fields: `agencies` or `sellers` update, either direct or as a `pendingChanges` proposal (`submitPartnerUpdate`).
  - Storage upload to `crmProfilePhotos/`.
  - Firebase Auth `linkWithPopup` (Google) and `sendEmailVerification`.
- **Filters:** none.
- **Purpose:** Self-service profile.

### /audit : `zipper-crm/app/audit/page.tsx`
- **Roles:**
  - Nav is STAFF_ROLES. No guard.
  - The API scopes the rows: owner and observer see all, `*_admin` see their team, others see themselves.
  - Observer: yes.
- **Reads:** `GET /api/audit?limit=300`, `GET /api/auth/me`; identity lookups on `users`, `publicProfiles`, `agencies` and `sellers`.
- **Actions:** Refresh.
- **Filters:** action-group chips, text search. No paging.
- **Purpose:** Audit trail.

### /team-access : `zipper-crm/app/team-access/page.tsx`
- **Roles:**
  - Nav is STAFF_ROLES.
  - Invite shows only if `GET /api/staff/assignable-roles` returns roles.
  - Observer: yes.
- **Reads:** `GET /api/staff?include_inactive=false`, `GET /api/staff/assignable-roles`, `GET /api/auth/me`.
- **Actions:** Invite: `POST /api/staff {email, name, role, phone}`. Revoke: `POST /api/staff/{uid}/deactivate`.
- **Filters:** grouped by team.
- **Purpose:** Staff invite and revoke. This is the screen the code says to keep.

### /policies : `zipper-crm/app/policies/page.tsx`
- **Roles:** Nav and guard: superadmin, app_admin. Observer: no.
- **Reads:** `policies/{privacy_policy|terms_of_service|faq}`.
- **Actions:**
  - Save draft: setDoc or update `policies/{docType}` `{content, version++, lastUpdatedBy, …}`.
  - Publish: update `{isPublished:true, publishedAt}`.
- **Filters:** 3 tabs.
- **Purpose:** Legal and FAQ texts shown in the app.

### /team : `zipper-crm/app/team/page.tsx`
- **Roles:**
  - Nav is STAFF_ROLES.
  - Invite shows if assignable roles are returned.
  - Change role needs API owner.
  - Revoke is not offered on yourself or on an owner.
  - Observer: no.
- **Reads:** `GET /api/staff?include_inactive=true`, `GET /api/staff/assignable-roles`, `GET /api/auth/me`.
- **Actions:**
  - Invite: `POST /api/staff`
  - Change role: `PATCH /api/staff/{uid}/role`
  - Revoke: `POST /api/staff/{uid}/deactivate`
  - Reset password: Firebase Auth `sendPasswordResetEmail`
- **Filters:** search, grouping.
- **Purpose:** Staff directory and role changes (duplicate of /team-access).

### /agency-dashboard : `zipper-crm/app/agency-dashboard/page.tsx` (+ `HostReports.tsx`)
- **Roles:**
  - Strict nav link for an approved `agency`; partnerRouting enforces it.
  - Page guard: `partnerRolesOf(crmUser).includes('agency')`.
  - Add sub-agency is hidden for `type==='sub'`.
  - Observer: no.
- **Reads (Firestore):**
  - `agencies/{agencyId}`, `agencies/{id}/agencyHosts`, then `users/{uid}`.
  - `hostApplications where agencyId==`, `salaryRequests where agencyId==`, `agencies where parentAgencyId==`.
  - `appeals where agencyId==`, `appConfig/economy`.
- **Reads (API):**
  - `GET /api/partners/agencies/{id}/sub-agencies`, `GET /api/partner-ops/subagency-payouts/open`
  - `GET /api/partners/agencies/{id}/statement`, `GET /api/partners/agencies/{id}/hosts`
  - `GET /api/partner-ops/partners/{agency_id}`, `GET /api/partners/agencies/{id}/host-reports?limit=200`
  - `GET /api/documents/host/{id}`, `GET /api/documents/batch`
- **Actions:**
  - Invite host: setDoc `hostApplications/{sha}` (addDoc fallback), plus Storage uploads to `hostPhotos/` and `kyc/{agencyId}/applications/`.
  - Withdraw invite: deleteDoc `hostApplications/{id}`.
  - New salary request: addDoc `salaryRequests`.
  - Mark distributed: update `salaryRequests/{id}`.
  - KYC and payout details: `agencies/{id}` update, direct or as a proposal.
  - Add sub-agency:
    - secondary-app Auth user, addDoc `agencies`, setDoc `crmUsers/{newUid}`, update `agencies/{id} {crmUid}`;
    - if the email is already in use: `POST /api/partner-ops/agencies/{parentId}/sub-agencies/reapply`.
  - Contest host report: setDoc `appeals/{id}`.
  - SecondRoleCard: addDoc `sellers`, then update `crmUsers/{uid} {roles, roleStatus.seller, sellerId}`.
- **Filters:** application split, period picker.
- **Purpose:** Agency owner portal.

### /seller-dashboard : `zipper-crm/app/seller-dashboard/page.tsx`
- **Roles:**
  - Strict nav link for `seller`. Guard: `partnerRolesOf(crmUser).includes('seller')`.
  - Buy is gated by can-take-inventory.
  - Filing a sale needs the partner to be approved and active.
  - Observer: no.
- **Reads (API):**
  - `GET /api/partner-ops/partners/me`, `GET /api/partners/sellers/{id}/statement`, `GET /api/partners/sellers/{id}/can-take-inventory`
  - `GET /api/cards?limit=200`, `GET /api/partner-ops/sales?limit=100`, `GET /api/partners/sellers/{id}/history`
- **Reads (Firestore):** `sellers/{id}`, `rechargeRequests`, `coinPurchaseRequests` (legacy), `publicProfiles`.
- **Actions:**
  - Buy inventory: `POST /api/partner-ops/sellers/{id}/coin-purchases`, with Storage upload to `coinPurchases/{sellerId}/` and a check via `GET /api/partner-ops/payment-references/{ref}`.
  - File sale: `GET /api/partner-ops/buyers/lookup?q`, then `POST /api/partner-ops/sales`.
  - Online toggle: `sellers/{id}` update `{isOnline}`.
  - SecondRoleCard: addDoc `agencies`, then update `crmUsers/{uid}`.
- **Filters:** tabs, history date range.
- **Purpose:** Coin-seller portal.

---

## 10. Public, signup and pending pages

### /login : `zipper-crm/app/login/page.tsx` **[PUBLIC]**
- **Roles:**
  - Anyone. All `crmUsers` roles can sign in.
  - Superadmin must pass a 3-question gate.
  - The observer email is refused and pointed to /observer.
- **Reads:** `crmUsers/{uid}`. Then AuthProvider calls `POST /api/auth/signin {id_token}` and `GET /api/auth/me`.
- **Actions:**
  - Email/password sign-in, Google popup, link Google, resend verification, password reset (all Firebase Auth).
  - `crmUsers/{uid}` update `{lastLoginAt}`.
  - First-time superadmin: `crmUsers/{uid}` update `{gateAnswers}`.
- **Purpose:** CRM sign-in.

### /observer : `zipper-crm/app/observer/page.tsx` **[PUBLIC]**
- **Roles:** backend `observer` only. There is no Firebase account or `crmUsers` doc.
- **Actions:** `POST /api/auth/observer/request-code`, `POST /api/auth/observer/verify-code {code}`, then `GET /api/auth/me`, then go to /inbox.
- **Purpose:** One-time-code read-only sign-in.

### /agency-signup : `zipper-crm/app/agency-signup/page.tsx` **[PUBLIC]**
- **Reads:** `GET /api/partner-ops/registration/availability` (no auth); `agencies where ownerEmail==` (own verified email).
- **Actions:**
  1. Optional Google popup.
  2. Storage upload to `kyc/agencies/signup/`.
  3. `createUserWithEmailAndPassword`, then email verification.
  4. addDoc `agencies` (source `self_signup`, status pending).
  5. setDoc `crmUsers/{uid}` (role agency, pending).
  6. Update `agencies/{id} {crmUid}`.
  7. On failure: `deleteUser` rollback.
- **Purpose:** Public agency application.

### /seller-signup : `zipper-crm/app/seller-signup/page.tsx` **[PUBLIC]**
- **Reads:** `GET /api/partner-ops/registration/availability?…&kind=seller`.
- **Actions:**
  1. Storage upload to `sellerDocs/signup/`.
  2. Auth user creation and email verification.
  3. addDoc `sellers` (self_signup).
  4. setDoc `crmUsers/{uid}` (role seller).
  5. Update `sellers/{id} {crmUid}`.
- **Purpose:** Public coin-seller application.

### /appeal : `zipper-crm/app/appeal/page.tsx` **[PUBLIC]**
- **Actions:** `POST /api/public/appeals/lookup {account_id, display_name}`, then `POST /api/public/appeals` (multipart, up to 3 files). No auth, no Firestore.
- **Purpose:** Appeal a ban or suspension without signing in.

### /agency-pending : `zipper-crm/app/agency-pending/page.tsx` **[PENDING, signed-in]**
- **Roles:** an agency capability with status `pending` or `awaiting_verification`.
- **Reads:** `GET /api/partner-ops/me/verification` (ContactVerificationPanel).
- **Actions:**
  - Callables `requestLoginEmailCode` and `verifyLoginEmailCode` (asia-south1).
  - Phone: `linkWithPhoneNumber`.
  - `POST /api/partner-ops/me/verification/check`, `POST /api/partner-ops/me/verification/conflict`.
  - Sign out.
- **Purpose:** Waiting room, then contact verification after approval.

### /seller-pending : `zipper-crm/app/seller-pending/page.tsx` **[PENDING, signed-in]**
Identical to /agency-pending, for the seller capability.

---

## 11. Direct Firestore writes from the CRM

Every browser write and the `firestore.rules` clause that admits it. Line numbers refer to repo-root `firestore.rules`.

Rule helpers used below (`firestore.rules` lines 35-750):
- `isCrmUser()`: a `crmUsers/{uid}` doc exists and `isActive != false`.
- `isSuperAdmin()`: role == 'superadmin'.
- `isAdmin()`: role in [superadmin, admin] or role matches `.*_admin`. This means **every department admin**.
- Department helpers: `isApp`, `isOps`, `isTech`, `isFinance`, `isSupport` each match superadmin, the legacy `admin`, the legacy department name, `<dept>_admin` and `<dept>_member`. `isMarketing` matches superadmin, marketing_admin and marketing_member.
- `isStaff()`: superadmin, admin, the 12 department roles and the legacy names. **It excludes agency and seller.**
- `isAgencyCrmWriter()`: holds agency (via role or `roles[]`), `agencyRoleLive`, and `accountRestricted != true`.
- `proposesChangeOnly()`: only `pendingChanges`, `kycStatus:'submitted'` and `kycSubmittedAt` change.
- `adminPartnerEditSafe()`: must not touch status, isActive, isApproved, approval fields, coin balances, parent or type, kycStatus, commissionRate or createdByUid; `crmUid` may only be set once.
- `partnerCreateSafe()`: the new record is pending, inactive and unapproved, and its uid fields are either blank or the caller.

| Collection | Op | Written from | Fields | Rule condition |
|---|---|---|---|---|
| `crmUsers/{uid}` | create (setDoc) | /agency-signup, /seller-signup (self); /agencies/register, /sellers/register (superadmin); /agency-dashboard (sub-agency, secondary app) | uid, email, name, phone, role agency or seller, permissions, agencyId or sellerId, isActive, status:'pending', createdBy, createdAt, lastLoginAt | 989-1019. Three branches: **(a)** `isSuperAdmin`, target ≠ self, role in [agency, seller], status pending, no roles/roleStatus. **(b)** `partnerSelfRegistration(uid)` (caller == uid, pending, no existing doc), role agency, createdBy in [self_signup, agency_created], `agencyNamesCaller(agencyId)`. **(c)** The same for seller with `sellerNamesCaller(sellerId)`. |
| `crmUsers/{uid}` | update | /login (`lastLoginAt`; legacy role normalise) | lastLoginAt | 1025-1160 branch (2): self, hasOnly [lastLoginAt]. A legacy `{role, dept}` rewrite falls under branch (1), which excludes role, so it is effectively denied. |
| `crmUsers/{uid}` | update | /login (superadmin gate) | gateAnswers | Branch (3): `isSuperAdmin` self, gateAnswers currently null. |
| `crmUsers/{uid}` | update | /profile | displayName, phone, personalEmail, address, photoUrl | Branch (4): `isOwner(uid)` hasOnly those 5 keys. |
| `crmUsers/{uid}` | update | /agency-dashboard, /seller-dashboard (SecondRoleCard, lib/partnerRoles.ts:278) | roles, roleStatus.<role>:'pending', sellerId or agencyId | Branches (5)/(6): owner, unrestricted, hasOnly [roles, roleStatus, sellerId or agencyId], only that role changes to 'pending', link previously empty, record `secondRoleOwnerUid == caller`. |
| `agencies` | create | /agency-signup; /agencies/register (superadmin); /agency-dashboard (sub-agency; second-role agency from /seller-dashboard) | full agency payload (status pending, isActive false, source self_signup, crm, agency_created or second_role) | 1232-1279: `partnerCreateSafe`, source not in [self_app, reapply], and one of: `isStaff()`; or `isAgencyCrmWriter`, `agencyRoleApproved`, type 'sub' under own main agency; or `isCrmUser`, unrestricted, source second_role, secondRoleOwnerUid == crmUid == caller, main; or `hasContactIdentity`, source self_signup, main, kycStatus pending. |
| `agencies/{id}` | update | /agencies (`_resendEmail`); /agencies/register and signup and sub-agency (`crmUid` back-link); /profile, /agency-dashboard (own fields or `pendingChanges` proposal) | `_resendEmail`; crmUid; ownerName, ownerPhone, address, agencyName, KYC and payout fields; or pendingChanges + kycStatus + kycSubmittedAt | 1342-1421: **(1)** `isAdmin` and `adminPartnerEditSafe` and `staffPaymentEditAllowed`. **(2)** `isAgencyCrmWriter` own agency, no status/link fields, and (no sensitive field, or record pending). **(3)** `isAgencyCrmWriter` own agency with `proposesChangeOnly`. **(5)** Verified email == ownerEmail, pending, crmUid empty, hasOnly [crmUid]. **(6)** Sub-agency's own back-link via `subAgencyMadeByItsParent`. |
| `sellers` | create | /seller-signup; /sellers/register (superadmin); /agency-dashboard (second-role seller) | seller payload, coinBalance 0, status pending | 2639-2677: `partnerCreateSafe`, zero coins, and one of: `isStaff()`; or `hasContactIdentity`, ownerUid == caller, self_signup; or `isCrmUser`, unrestricted, second_role, secondRoleOwnerUid == crmUid == caller. |
| `sellers/{id}` | update | /sellers (`_resendEmail`); register and signup (`crmUid`); /profile (own fields or proposal); /seller-dashboard (`isOnline`) | as listed | 2704-2793: **(1)** `isSuperAdmin` or `isFinance` or `isAdmin`, no coin fields, `adminPartnerEditSafe`. **(3)** crmUid == caller, hasOnly [city, description, qrCodeUrl, isOnline, lastSeen], `sellerRoleLive`, unrestricted (going online requires approved). **(4)** crmUid == caller, record pending, no status/coin/link fields. **(5)** `proposesChangeOnly`. **(6)** Verified email == seller.email, crmUid empty, hasOnly [crmUid]. |
| `hostApplications/{id}` | update | /hosts (edit or proposal), /profile n/a, /agency-dashboard (n/a) | hostName, phone, email, age, dob, country, callRate, payout fields; or pendingChanges proposal | 1570-1575: `isAdmin` and decision fields untouched and (no sensitive field, or superadmin); or `isAdmin` with `proposesChangeOnly`; or `isAgencyCrmWriter` own agency with `proposesChangeOnly`. **Note:** /hosts offers edit to app_member and ops_member, which fail `isAdmin`. |
| `hostApplications/{id}` | create (setDoc or addDoc) | /agency-dashboard (invite host) | invitation fields, kycStatus 'submitted', status pending, isActivated false | 1535-1548: (`isStaff`, or `isAgencyCrmWriter` and `agencyRoleApproved` and own agencyId) and `hostAppCodeIsAgencys`, no decision keys, pending. |
| `hostApplications/{id}` | delete | /agency-dashboard (withdraw invite) | n/a | 1628-1635: `isAdmin`; or `isAgencyCrmWriter` own agency, pending, not activated, no applicant, source ≠ self_app. |
| `salaryRequests` | create | /agency-dashboard | agencyId, hostUid, hostName, period, beansEarned, amountInr, notes, status pending | 3718-3757: create pending by `isFinance`/`isAdmin`, or `isAgencyCrmWriter`, `agencyRoleApproved`, own agencyId. |
| `salaryRequests/{id}` | update | /agencies/[id]/salary (approve); /agency-dashboard (mark distributed) | status:'approved', approvedAt; or status:'distributed', distributedAt | `isFinance` or `isSuperAdmin` approve/reject, hasOnly [status, approvedAt, rejectedAt, notes, rejectionReason]; or `isAgencyCrmWriter` own agency, paid → distributed, hasOnly [status, distributedAt]. |
| `appeals/{id}` | create (setDoc) | /agency-dashboard (HostReports, contest a report) | subjectUid, subjectName, raisedBy*, raisedByRole 'agency', agencyId, kind 'report', reportId, statement, evidenceUrls, status pending, createdAt, originalDecidedBy | 3397-3414: `wellFormedAppeal`, `reappealOk`, and `isAgencyCrmWriter`, `agencyRoleApproved`, agencyId == own, `contestIdOk`. Update and delete are `false`. |
| `approvalRequests` | create | /agencies/register, /sellers/register (non-superadmin); /tech/appcontrol (non-superadmin); /economy/config (finance_admin) | type, description, targetLabel, targetCollection, targetDocId, operation, payload, requestedBy, status pending, requestedAt | 3825-3832: `isStaff`, hasOnly those keys, requestedBy.uid == caller, pending. `approvalShapeAllowed()` allows only `update_config` on `appConfig/control|economy`, `create_agency` and `create_seller`. `approvalPayloadSafe()` requires create payloads to be pending, inactive and zero-coin. |
| `approvalRequests/{id}` | update | /approvals, /approvals/[id] | status, reviewedBy, reviewedAt, reviewNotes | 3837-3844: `isSuperAdmin`, pending → approved or rejected, reviewer == caller, not your own request. Delete is `false`. |
| `supportTickets/{id}` | update | /tickets (reply, status, priority, assign, route, close) | as listed | 2975-2980: `isOps` or `isAdmin` or `isSupport`. |
| `users/{uid}/notifications` | create (addDoc) | /tickets (Reply, `respondToTicket`, lib/firestore.ts:873) | type, message, timestamp, read | **No matching rule.** There is no `match /notifications` under `users/{uid}`; only top-level `/notifications` at 3542. The catch-all `/{document=**}` denies it, so a Reply updates the ticket and then throws on the notification. |
| `techTickets` | create / update | /tech/tickets; /tickets (route to team) | ticket fields; status, assignee, blocker fields | 2464-2468: create and update need `isCrmUser()` (any CRM user, **including partners**). Delete needs `isSuperAdmin`. |
| `feedbackTickets/{id}` | update | /feedback; /operations/feedback | status, statusNote, statusChangedAt, statusChangedByName, resolvedAt, response, assignedTo, assignedToName, assignedAt, priority | 2968-2973: `isOps` or `isAdmin` or `isSupport`. **Note:** /feedback admits app_member, which fails all three, so app_member writes are denied. |
| `weeklyPayoutReports/{id}` | update | /finance/payouts | status, approvedBy, approvedAt, rejectedReason | 2505-2517: `isFinance` or `isAdmin` (also agencyOwnerUid generated → submitted). |
| `withdrawalRequests/{id}` | update | /finance/withdrawals | status, processedAt, processedBy, notes, rejectionReason | 3659-3680: `isFinance` or `isSuperAdmin`; pending → approved, or pending/approved → rejected; hasOnly [status, processedAt, processedBy, notes, rejectionReason]. |
| `gifts` | create / update / delete | /gifts, /tech/content | name, emoji, imageUrl, lottieAsset, diamondCost, earningRate, category, isActive, sortOrder | 2366-2369: write needs `isTech` or `isApp` or `isOps`. |
| `bagItems` | create / setDoc / update | /tech/content, /app-config/bag-items | the BagItem fields, isActive | 2390-2393: write needs `isTech` (superadmin is included in `isTech`). |
| `levelConfig/{user,host}/levels/{n}` | setDoc | /app-config/levels | level fields | 2449-2456: write needs `isTech`. |
| `paymentConfig/{cc}` | setDoc (merge) | /tech/payments | methods, updatedAt | 2955-2957: `isTech` or `isSuperAdmin`. |
| `appConfig/control` | setDoc | /tech/appcontrol (superadmin) | maintenance, forceUpdate, minVersion, featureFlags | 3595-3596: docId ≠ paymentCredentials, so `isTech` or `isSuperAdmin`. |
| `appConfig/economy` | setDoc (merge) | /economy/config (superadmin) | economy config | Same as above: `isTech` or `isSuperAdmin`. **Note:** tech roles can write economy directly via the rules, even though the CRM limits the page to superadmin and finance_admin. |
| `appConfig/dailyRewards`, `appConfig/profileOptions` | setDoc | /app-config/daily-rewards, /app-config/profile-options | schedule; tag lists | Same: `isTech` or `isSuperAdmin`. |
| `appConfig/paymentCredentials` | setDoc | /app-config/payment-creds | bank and binance fields | 3595: `isSuperAdmin` only. |
| `rechargePackages/{id}`, `diamondPacks/{id}` | setDoc / delete | /app-config/packages | pack fields | 3945-3952: `isSuperAdmin`. |
| `broadcasts` | create | /broadcasts | title, body, senderName, imageUrl, targetGender, createdAt, type | 3537-3539: `isAdmin` or `isMarketing`. |
| `policies/{docType}` | set / update | /policies | content, version, lastUpdatedBy, lastUpdatedByName, updatedAt, isPublished, publishedAt | 3618-3620: `isSuperAdmin` or `isApp`. |

**Non-Firestore browser writes** (Firebase Storage `uploadBytesResumable`):
- `kyc/agencies/{signup,temp,<agencyId>}/`, `kyc/sub-agencies/`, `kyc/{agencyId}/applications/`
- `hostPhotos/{agencyId}/`, `sellerDocs/{signup,crm}/`, `sellerPaymentProofs/`
- `coinPurchases/{sellerId}/`, `evidence/{coinPurchases,expenses}/`
- `contentAssets/{gifts,bag_items}/`, `crmProfilePhotos/`

Firebase Auth operations: create, delete, link and password reset. Callables: `generateAgoraToken`, `requestLoginEmailCode`, `verifyLoginEmailCode`.

**Pages with no browser Firestore writes:** all pages not listed in the table above. Their mutations go through `/api/*`.

---

## 12. Role model

### 12.1 CRM roles (`zipper-crm/lib/auth.ts`)

`CrmRole` (lines 66-82) has 15 values:
- `superadmin`
- `app_admin`, `app_member`
- `ops_admin`, `ops_member`
- `finance_admin`, `finance_member`
- `tech_admin`, `tech_member`
- `support_admin`, `support_member`
- `marketing_admin`, `marketing_member`
- `agency`, `seller`

There is **no `observer`** in `CrmRole`. The observer exists only as an API role; `ApiRole` in `lib/api.ts:354` includes `owner` and `observer`.

`LEGACY_ROLE_MAP` (lines 89-95): admin→app_admin, ops→ops_member, tech→tech_member, finance→finance_member, support→support_member. It is applied by `normalizeCrmRole`.

`DEFAULT_PERMISSIONS` (lines 234-334) maps roles onto 20 `Permission` strings:

| Role | Permissions |
|---|---|
| superadmin | all 20 |
| app_admin | view_users, ban_users, adjust_balance, view_agencies, view_sellers, view_finance, app_config, tickets ×3, manage_team, monitor_live |
| app_member | view_users, ban_users, create_tickets, monitor_live |
| ops_admin | view_users, view_agencies, approve_kyc, view_sellers, approve_seller, view_finance, tickets ×3, manage_team |
| ops_member | view_agencies, view_sellers, create_tickets |
| finance_admin | view_users, adjust_balance, view_agencies, view_sellers, coin_operations, view_finance, process_payout, tickets ×3, manage_team |
| finance_member | view_agencies, view_sellers, coin_operations, view_finance, process_payout, create_tickets |
| tech_admin | economy_config, commission_slabs, app_config, tickets ×3, manage_team |
| tech_member | economy_config, commission_slabs, app_config, create_tickets |
| support_admin | view_users, tickets ×3, manage_team |
| support_member | view_users, create_tickets, assign_tickets |
| marketing_admin | send_broadcasts, tickets ×3, manage_team |
| marketing_member | send_broadcasts, create_tickets |
| agency, seller | `[]` |

Access checks:
- `hasPermission` reads the **stored** `crmUsers.permissions`; superadmin always passes.
- `canAccess` compares the primary `role` only; superadmin always passes.

Partner capability fields on `CrmUser`:
- `role` is the primary capability and is what the rules read.
- `roles?: CrmRole[]` and `roleStatus?: {agency|seller: 'pending'|'awaiting_verification'|'approved'|'rejected'}` hold a second capability.
- Other fields: `status`, `isActive`, `accountRestricted`, `agencyId`, `sellerId`.
- `lib/partnerRouting.ts::partnerRolesOf` returns the primary role plus any partner role in `roles[]`.
- `partnerRoleStatus` resolution order:
  1. An explicit `roleStatus[role]` wins.
  2. Otherwise, for the primary role, the legacy `status` decides.
  3. Otherwise the role is pending.

`lib/crmRoles.ts`:
- `INTERNAL_CRM_ROLES` is superadmin, observer and the 12 department roles.
- Internal accounts and your own account are never offered ban or suspend actions.

### 12.2 Exclusive-role rules

**CRM** (`lib/secondRoleRule.ts`):
- One agency-family record (Agency **or** Sub-agency) plus at most one Coin Seller.
- Agency together with Sub-agency is not allowed. Agency or Sub-agency together with Seller is allowed.
- `availableSecondRole` offers the other capability only when all of these hold:
  - the primary capability is approved;
  - the other capability is not already in `roles` or `roleStatus`;
  - there is no live held record.

**Backend `backend/app/services/partner_roles.py`:**
- Families: `{agency: agency, sub_agency: agency, seller: seller}`.
- `allows(held, wanted)` refuses a second role from the same family.
- This is enforced race-safely with a Mongo sentinel in `partner_role_claims` (`_id = "agency:<uid>"`).
- A revoked role keeps its slot, and the caller is told to request reinstatement instead.

**Backend `backend/app/services/partner_applications.py` `_ALLOWS`** (what a holder may still add):

| Currently holds | May add |
|---|---|
| host_under_main | sub_agency (same parent), seller |
| host_under_sub | seller |
| host_unattached | seller |
| agency | seller |
| sub_agency | seller, host (only directly under its own main agency) |
| seller | host, agency, sub_agency |

**Backend `user_roles.py`:** revoke is offered only when 2 or more roles are held (`SINGLE_ROLE_REFUSAL`).

**Staff:**
- Staff can never hold partner roles: `functions/src/crmRoles.ts::hostBlockedBy` ("ZIPPER staff accounts cannot hold partner roles") and `MONGO_ROLE_REFUSED`.
- `AGENCY_HOST_REFUSAL`: an Agency or Sub-agency cannot also be a Host, except a Sub-agency under X becoming a Host under X.

### 12.3 Backend mapping

`backend/app/core/roles.py`:
- `Role` enum: `observer`, `owner`, `app_admin`, `app_member`, `ops_admin`, `ops_member`, `finance_admin`, `finance_member`, `tech_admin`, `tech_member`, `support_admin`, `support_member`, `marketing_admin`, `marketing_member`, `agency`, `seller` (plus `SYSTEM_ROLE = "system"`).
- Groups: `ADMIN_ROLES` (6), `MEMBER_ROLES` (6), `INTERNAL_ROLES` (staff + owner + observer), `EXTERNAL_ROLES` (agency, seller).
- Predicates:
  - `is_team_admin`: the role is in ADMIN_ROLES (owner is not a team admin).
  - `can_write`: role ≠ observer.
  - `can_sign_money`: owner only.
  - `can_verify_money`: owner, finance_admin, or a team admin for its own team's cards.
  - `can_read_all`: {observer, owner}.
- `partner_role_for`: seller→SELLER; agency or sub_agency→AGENCY.

`backend/app/services/crm_directory.py`: `CRM_ROLE` (lines 68-82) maps backend roles to CRM roles; `PARTNER_CRM_ROLE` (line 117) covers partners; `NOT_MIRRORED` (lines 84-99) excludes the observer.

| Backend Role | crmUsers.role |
|---|---|
| owner | superadmin |
| app_admin / app_member | app_admin / app_member |
| ops_admin / ops_member | ops_admin / ops_member |
| finance_admin / finance_member | finance_admin / finance_member |
| tech_admin / tech_member | tech_admin / tech_member |
| support_admin / support_member | support_admin / support_member |
| marketing_admin / marketing_member | marketing_admin / marketing_member |
| agency | agency (`PARTNER_CRM_ROLE`; partners live in Mongo `partners`, not `staff`) |
| seller | seller |
| observer | **none**. It is `NOT_MIRRORED`, because a `crmUsers` doc would grant Firestore writes. |

Other mappings in the same file:
- `MONGO_ROLE` (line 131) is the reverse mapping.
- `MONGO_ROLE_REFUSED` refuses creating superadmin, agency or seller via staff management.
- `PARTNER_LINK_FIELD`: AGENCY→`agencyId`, SELLER→`sellerId`.

### 12.4 How app accounts relate (`users/{uid}` mirror)

`functions/src/crmRoles.ts` is a pure helper. `deriveRoleFlags(...)` returns `{crmRole, isAgent, isSeller, isOfficial, held}`:
- A capability is "held" only when `roleStatus[cap]` (falling back to `status`, then 'approved') equals `approved`.
- `crmRole` is the normalised staff role, or `''` for partners and observers.
- `isOfficial` is true for superadmin or any department role.

It is used by the callable **`syncMyRoles`** (`functions/src/social.ts:128`, exported at `index.ts:4689`, asia-south1):
- The Android app calls it at sign-in and cold start (`AuthRepository.kt` `syncRoles()` → `HostFunctions.kt:230`).
- It reads `crmUsers/{uid}` and `users/{uid}`, then `set(merge)`s `{crmRole, isAgent, isSeller, isOfficial}` onto `users/{uid}`.
- It sets `ownAgencyId` from `crmUsers.agencyId` while `isAgent`, and deletes it otherwise.
- It clears `users.agencyId` when that is the person's own agency and they are not a Host.

The backend pushes the same data (`crm_directory.push_app_role_flags`, `APP_ROLE_FIELDS = isAgent, isSeller, ownAgencyId, agencyId, crmRole`):
- It runs after every partner decision.
- `_attach_app_identity` (around lines 904-958) writes `users/{uid}` with merge.

Custom claims:
- `syncStorageRoleClaim` (`functions/src/index.ts:4797`) is a Firestore onWrite trigger on `crmUsers/{uid}`. It sets `{role:'agency'|'seller', aid}` for partners only.
- Staff claims `{role:<backend Role>, aid:''}` are set by `backend/app/services/storage_claims.py`.

The rules write-protect these mirrored fields on `users/{uid}` against staff: `staffProtectedFields()` covers crmRole, isOfficial, isAgent, isSeller, ownAgencyId, isHost and agencyId.

### 12.5 How the Android app decides roles today

`zipper-app/app/src/main/java/com/zipper/app/data/model/User.kt` has these role fields:
- `isHost` (line 50)
- `agencyId` (line 52): the agency a host works under
- `ownAgencyId` (line 58): the person's own agency or sub-agency
- `isOfficial`, `isAgent`, `isSeller` (lines 65-67)
- `crmRole` (line 83): superadmin or one of the 12 department roles; `''` for partners and everyone else
- `isBanned`, `accountState`, `isSuspended`

How they are used:
- **Staff badge:** `ui/components/Badges.kt:211-240`. `crmRole=='superadmin'` shows "OWNER"; any other non-blank value shows a team label. The verified tick shows for `isVerifiedHost || isOfficial`.
- **Partner entry points:**
  - `MyProfileScreen.kt:272-273` shows the Agency cell when `isAgent` and the Seller cell when `isSeller`.
  - `ZipperNavGraph.kt:791` passes `isAgent`/`isSeller` to Settings.
  - `DiscoverRepository.kt:134` queries `users where isSeller==true`.
- **Agency dashboard:** `AgencyDashboardScreen.kt:92` uses `ownAgencyId`, falling back to `agencyId` only if the user is not a host.
- **Host UI** is driven by `isHost`.
- **Partner hub** (`PartnerHubViewModel.kt:20-29`) deliberately does not use `isAgent`/`isSeller`; it asks the backend eligibility table (`partner_applications.py`).
- **Contact rules:** `crmRole` from `resolveIdentity` (`MoneyFunctions.kt:597`) drives `ContactRules.partnerEntryVisible`; staff are never partners.

In short, every app role flag is a server-written display flag on `users/{uid}`, sourced from `crmUsers/{uid}` via `syncMyRoles` or the backend push. The device itself decides nothing. The app has no concept of the CRM permission list or the API session role (owner/observer).

---

## 13. Notable mismatches found

1. **There is no hard route guard for staff.** About 15 pages rely only on nav hiding, with either no page guard (/gifts, /hosts, /partners, /audit, /profile, /team, /team-access) or API-side scoping.
2. **Page guards are wider than the nav on several pages:**

   | Page | Allowed by the page guard but hidden in the nav |
   |---|---|
   | /users | ops_member |
   | /sellers | finance_admin, finance_member |
   | /agencies | finance_admin, finance_member |
   | /tickets | tech_member |
   | /feedback | app_member |
   | /moderation | app_member |
   | /operations/bans | app_admin, app_member |
   | /reports | finance_member |
   | /gifts (edit) | ops_member |

3. **The rules' `isAdmin()` admits every `*_admin`,** including tech_admin and marketing_admin. They can update `agencies`, `sellers`, `hostApplications` and `broadcasts`.
4. **The rules let tech roles write `appConfig/economy`.** The CRM limits that page to superadmin and finance_admin.
5. **Some UI write paths are denied by the rules:**
   - /tickets Reply's `users/{uid}/notifications` addDoc has no rule.
   - /feedback writes by app_member fail.
   - /hosts edits by app_member and ops_member fail.
6. **The roles that `canAccess` and the rules check come only from `crmUsers.role`.** `roles[]` is consulted only for partner capabilities.
7. **The observer has no `crmUsers` doc,** so all of its access is through the API. Several pages accept the observer in code (/chance/*, /broadcasts/email) but the layout blocks them.
8. **Reasons are collected but not sent:** the re-run reason on /tech/jobs and /reports/weekly is never sent to the API.
