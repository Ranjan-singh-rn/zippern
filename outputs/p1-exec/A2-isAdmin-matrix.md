# WP-A2 — every `isAdmin()` grant in firestore.rules (generated, read-only)

`isAdmin()` = superadmin, legacy `admin`, or ANY `*_admin` (app, ops, finance, tech, support, marketing). The backend instead grants per-capability (`roles.PERMISSIONS`). Each row is a place where e.g. a Marketing or Tech admin gets the same Firestore access as a Finance admin.

| Line | Path | Op | Financial? | CRM files that name the collection |
|---|---|---|---|---|
| 1196 | `/agencies/{agencyId}` | read | **yes** | app/agency-dashboard/page.tsx, app/agency-signup/page.tsx, app/agencies/register/page.tsx, app/agencies/[id]/salary/Client.tsx … |
| 1349 | `/agencies/{agencyId}` | update | **yes** | app/agency-dashboard/page.tsx, app/agency-signup/page.tsx, app/agencies/register/page.tsx, app/agencies/[id]/salary/Client.tsx … |
| 1435 | `/agencyHosts/{hostUid}` | read |  | app/agency-dashboard/page.tsx, lib/agencyDashboardHosts.spec.ts, lib/agencies.ts |
| 1458 | `/commissionLedger/{entryId}` | read | **yes** | lib/agencies.ts |
| 1577 | `/hostApplications/{docId}` | update |  | app/agency-dashboard/page.tsx, app/users/[uid]/HostRecord.tsx, app/hosts/page.tsx, app/approvals/[id]/Client.tsx … |
| 1635 | `/hostApplications/{docId}` | delete |  | app/agency-dashboard/page.tsx, app/users/[uid]/HostRecord.tsx, app/hosts/page.tsx, app/approvals/[id]/Client.tsx … |
| 2197 | `/blocked/{targetUid}` | read, write |  | app/tech/tickets/page.tsx, app/login/page.tsx |
| 2198 | `/liked/{targetUid}` | read, write |  |  |
| 2204 | `/likedBy/{likerUid}` | read |  |  |
| 2226 | `/likedBy/{likerUid}` | write |  |  |
| 2251 | `/following/{followedUid}` | write |  |  |
| 2270 | `/diamondTransactions/{txId}` | read | **yes** | lib/firestore.ts, lib/finance.ts |
| 2315 | `/beanTransactions/{txId}` | read | **yes** | lib/firestore.ts, lib/finance.ts |
| 2318 | `/giftsSent/{docId}` | read, write | **yes** |  |
| 2322 | `/giftsReceived/{docId}` | update, delete | **yes** |  |
| 2330 | `/kycSubmissions/{docId}` | read |  | lib/firestore.ts |
| 2337 | `/kycSubmissions/{docId}` | update |  | lib/firestore.ts |
| 2338 | `/kycSubmissions/{docId}` | delete |  | lib/firestore.ts |
| 2346 | `/hostKyc/{hostUid}` | read |  |  |
| 2357 | `/hostKyc/{hostUid}` | write |  |  |
| 2491 | `/opsTickets/{ticketId}` | read |  | lib/operations.ts |
| 2493 | `/opsTickets/{ticketId}` | update |  | lib/operations.ts |
| 2494 | `/opsTickets/{ticketId}` | delete |  | lib/operations.ts |
| 2508 | `/platformRevenue/{docId}` | read | **yes** | lib/finance.ts |
| 2515 | `/platformStats/{docId}` | delete |  |  |
| 2524 | `/weeklyPayoutReports/{reportId}` | read | **yes** | lib/finance.ts |
| 2527 | `/weeklyPayoutReports/{reportId}` | create | **yes** | lib/finance.ts |
| 2528 | `/weeklyPayoutReports/{reportId}` | update | **yes** | lib/finance.ts |
| 2538 | `/hostPayouts/{payoutId}` | read | **yes** | lib/finance.ts |
| 2541 | `/hostPayouts/{payoutId}` | create | **yes** | lib/finance.ts |
| 2542 | `/hostPayouts/{payoutId}` | update | **yes** | lib/finance.ts |
| 2849 | `/diamondLending/{lendId}` | read | **yes** | lib/economyConfig.ts |
| 2889 | `/rechargeRequests/{reqId}` | read | **yes** | lib/sellers.ts |
| 2922 | `/callHistory/{callId}` | write |  |  |
| 3012 | `/crmSupportTickets/{ticketId}` | update |  |  |
| 3013 | `/crmSupportTickets/{ticketId}` | delete |  |  |
| 3022 | `/pkInvites/{inviteId}` | update |  |  |
| 3023 | `/pkInvites/{inviteId}` | delete |  |  |
| 3095 | `/comments/{commentId}` | update, delete |  |  |
| 3104 | `/gifts/{giftId}` | update, delete | **yes** | app/live/page.tsx, app/tech/content/page.tsx, app/tech/appcontrol/page.tsx, lib/gifts.ts |
| 3263 | `/messages/{messageId}` | update, delete |  |  |
| 3316 | `/reports/{reportId}` | update, delete |  | app/operations/reports/page.tsx, lib/operations.ts |
| 3539 | `/calls/{callId}` | write |  |  |
| 3549 | `/messages/{msgId}` | read |  |  |
| 3552 | `/messages/{msgId}` | update, delete |  |  |
| 3561 | `/broadcasts/{broadcastId}` | write |  | lib/firestore.ts |
| 3567 | `/notifications/{notifId}` | write |  |  |
| 3623 | `/announcements/{docId}` | write |  |  |
| 3657 | `/withdrawalRequests/{reqId}` | read | **yes** | app/finance/withdrawals/page.tsx, lib/firestore.ts, lib/api.ts |
| 3731 | `/salaryRequests/{reqId}` | read | **yes** | app/agency-dashboard/page.tsx, app/agencies/[id]/salary/Client.tsx, lib/api.ts, lib/agencies.ts |
| 3779 | `/salaryRequests/{reqId}` | delete | **yes** | app/agency-dashboard/page.tsx, app/agencies/[id]/salary/Client.tsx, lib/api.ts, lib/agencies.ts |
| 3896 | `/coinPurchaseRequests/{purchaseId}` | get | **yes** | lib/coinPurchases.ts |
| 3906 | `/coinPurchaseRequests/{purchaseId}` | list | **yes** | lib/coinPurchases.ts |
| 4039 | `/{path=**}/diamondTransactions/{txId}` | read | **yes** |  |
| 4043 | `/{path=**}/beanTransactions/{txId}` | read | **yes** |  |

Total grants: 55; on financial paths: 24.
