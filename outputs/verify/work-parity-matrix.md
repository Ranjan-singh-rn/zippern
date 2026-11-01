| Screen | CRM | Owner | Observer | App admin | Ops member | Finance admin | Support member | Agency | Coin seller | Pending partner |
|---|---|---|---|---|---|---|---|---|---|---|
| Commission statement (`agency.statement`) | /agency-dashboard (statement), /partners (agency tab) | R | R | R | R | R | R | R | — | — |
| Host earnings (`agency.hosts`) | /agency-dashboard (hosts), /agencies/[id] (hosts tab) | R | R | R | R | R | R | R | — | — |
| Sub-agencies (`agency.subs`) | /agency-dashboard (sub-agencies), /agencies/[id] (subs tab) | R | R | R | R | R | R | R | — | — |
| Reports on my hosts (`agency.reports`) | /agency-dashboard (HostReports) | R | R | R | R | R | R | R | — | — |
| Appeals for my hosts (`agency.appeals`) | /agency-dashboard (appeals) | R | R | R | R | R | R | R | — | — |
| Sub-agency payouts (`agency.subPayouts`) | /agency-dashboard, /agencies/[id], /agencies | R+1 | R | R | R | R+1 | R | R | — | — |
| Seller statement (`seller.statement`) | /seller-dashboard (statement), /partners (seller tab), /sellers/[id] | R+1 | R | R | R | R+1 | R | — | R+1 | — |
| Seller history (`seller.history`) | /seller-dashboard (history), /sellers/[id] (transactions) | R | R | R | R | R | R | — | R | — |
| Money cards (`partner.cards`) | /seller-dashboard (cards), /board | — | — | — | — | — | — | R | R | — |
| My partner records (`partner.records`) | /profile, /agency-pending, /seller-pending | — | — | — | — | — | — | R | R | R |
| Contact verification (`partner.verification`) | /agency-pending, /seller-pending (ContactVerificationPanel) | — | — | — | — | — | — | R+1 | R+1 | R+1 |
| Waiting on me (`cards.inbox`) | /inbox | R | R | R | R | R | R | — | — | — |
| Money board (`cards.board`) | /board, /coin-purchases, /finance/withdrawals (execute), /finance/costs (pay), /finance/capital (settle) | R+15 | R | R+3 | R+3 | R+3 | R+3 | — | — | — |
| Awaiting my signature (`cards.toSign`) | /inbox (signature queue), /board | R+2 | — | — | — | — | — | — | — | — |
| Coin purchases (`cards.coinPurchases`) | /coin-purchases | R+15 | R | — | — | R+3 | — | — | — | — |
| Reinstatement requests (`roleAppeals`) | /role-appeals | R+2 | — | — | — | — | — | — | — | — |
| Transfers (`transfers`) | /transfers, /users/[uid] (transfer), /agencies/[id] (transfer) | R+2 | — | — | — | — | — | — | — | — |
| Frozen money (`frozenMoney`) | /frozen-money | R+1 | — | — | — | — | — | — | — | — |
| Host face verification (`hostVerification`) | /hosts/verification | R+1 | — | — | — | — | — | — | — | — |
| Ban & suspension appeals (`accountAppeals`) | /operations/appeals | R+1 | R | R+1 | R | R | R | — | — | — |
| User reports (`userReports`) | /operations/reports, /moderation | R+1 | R | R+1 | R | R+1 | R+1 | — | — | — |
| Device bans (`deviceBans`) | /operations/bans | R+2 | R | R+2 | R | R | R | — | — | — |
| Find a user (`users.search`) | /users | R | — | R | R | R | R | — | — | — |
| User record (`users.record`) | /users/[uid] | R+12 | R | R+6 | R | R+2 | R+1 | — | — | — |
| Account history (`users.history`) | /users/[uid] (activity) | R | R | R | R | R | R | — | — | — |
| Warnings (`users.warnings`) | /users/[uid] (warnings) | R | R | R | R | R | R | — | — | — |
| Host applications (`hosts.applications`) | /kyc (hosts), /hosts (invited) | R+2 | — | R | R | R | R | — | — | — |
| Live rooms (`live.rooms`) | /live | R+4 | — | R+2 | R+2 | R+1 | R+1 | — | — | — |
| Agencies & sellers (`partners.directory`) | /agencies, /sellers, /kyc (partners), /onboarding | R+14 | R | R | R | R+5 | — | — | — | — |
| Partner record (`partners.one`) | /agencies/[id], /sellers/[id] | R+14 | R | R | R | R+5 | — | — | — | — |
| Recharges (`recharges`) | /recharges, /seller-dashboard (recharges) | R+4 | R | R | R | R+2 | — | — | R | — |
| Coin sales (`sales`) | /sales, /seller-dashboard (file a sale) | R+2 | R | R+1 | R+1 | R+1 | — | — | R+1 | — |
| Seller credit (`credit.overdue`) | /lending, /partners (exposure) | R | R | R | R | R | R | — | — | — |
| Coin purchase requests (legacy) (`coinRequests`) | /coin-purchases (Firestore requests) | R+1 | — | — | — | R+1 | — | — | — | — |
| Host withdrawals (`withdrawals`) | /finance/withdrawals | R+3 | — | R | — | R+3 | — | — | — | — |
| Agency salary requests (`salaryRequests`) | /agencies/[id]/salary, /agency-dashboard (salary) | R+3 | — | R | — | R+3 | — | — | — | — |
| Weekly payout reports (`payoutReports`) | /finance/payouts | R+2 | — | R | — | R+2 | — | — | — | — |
| Operating costs (`expenses`) | /finance/costs | R+17 | R | R+5 | R+5 | R+5 | R+5 | — | — | — |
| Owners' capital (`capital`) | /finance/capital | R+1 | R | R+1 | R+1 | R+1 | R+1 | — | — | — |
| Business dashboard (`reports.dashboard`) | / (staff dashboard), /analytics | R | R | R | R | R | R | — | — | — |
| Cash position (`reports.cash`) | /finance/cash, /finance, /reports | R | R | R | — | R | — | — | — | — |
| Revenue (`reports.revenue`) | /finance/profit, /reports | R | R | R | — | R | — | — | — | — |
| Payouts (`reports.payouts`) | /finance/payouts, /finance/withdrawals | R | R | R | — | R | — | — | — | — |
| Margin (`reports.margin`) | /finance/profit, /reports | R | R | R | — | R | — | — | — | — |
| Channels (`reports.channels`) | /finance/profit, /reports | R | R | R | — | R | — | — | — | — |
| Liabilities (`reports.liabilities`) | /finance/liabilities, /finance | R | R | R | — | R | — | — | — | — |
| Partner summary (`reports.partners`) | /finance/reports, /reports | R | R | R | — | R | — | — | — | — |
| Agency statement (report) (`reports.agencyStatement`) | /agencies/[id] | R | R | R | — | R | — | — | — | — |
| Seller statement (report) (`reports.sellerStatement`) | /sellers/[id] | R | R | R | — | R | — | — | — | — |
| Team throughput (`reports.throughput`) | /throughput, /reports | R | R | R | R | R | R | — | — | — |
| Audit summary (`reports.auditSummary`) | /reports | R | R | R | — | R | — | — | — | — |
| Chance revenue (`reports.chanceRevenue`) | /chance/money | R | R | R | — | R | — | — | — | — |
| Chance margin (`reports.chanceMargin`) | /chance/money | R | R | R | — | R | — | — | — | — |
| Cannibalisation (`reports.cannibalisation`) | /chance/money | R | R | R | — | R | — | — | — | — |
| Weekly business report (`reports.weekly`) | /reports/weekly | R+1 | R | R+1 | — | R+1 | — | — | — | — |
| Report definitions (`reports.definitions`) | /reports (definitions) | R | R | R | R | R | R | — | — | — |
| Two-step sign-in (`owner.mfa`) | /login (two-step sign-in) | R+3 | — | — | — | — | — | — | — | — |
| Feedback tickets (`feedback.triage`) | /feedback, /operations/feedback | R+4 | — | R+4 | R+4 | R+4 | R+4 | — | — | — |
| Support tickets (`support.tickets`) | /tickets | R+3 | — | — | — | — | R+3 | — | — | — |
| Team tickets (`team.tickets`) | /tech/tickets | R+2 | — | R+2 | R+2 | R+2 | R+2 | — | — | — |
| In-app announcements (`broadcasts.inapp`) | /broadcasts | R+1 | — | R+1 | R | R+1 | R | — | — | — |
| Email broadcast (`broadcasts.email`) | /broadcasts/email | R+1 | — | R+1 | R+1 | R+1 | R+1 | — | — | — |
| Policies & FAQ (`policies`) | /policies | R+2 | — | R+2 | — | — | — | — | — | — |
| Approval requests (`approvals`) | /approvals, /approvals/[id] | R+2 | — | — | — | — | — | — | — | — |
| Alerts (`alerts`) | /alerts | R | R | R | — | R | — | — | — | — |
| Alert log (`alerts.raised`) | /alerts (raised) | R+1 | R | R | — | R | — | — | — | — |
| Scheduled jobs (`jobs`) | /tech/jobs | R+3 | R | R+3 | — | R+3 | — | — | — | — |
| Email delivery log (`email.log`) | /tech/email | R | R | R | — | R | — | — | — | — |
| Audit log (`audit`) | /audit, /moderation (actions) | R | R | R | R | R | R | — | — | — |
| Team (`staff`) | /team, /team-access | R+6 | R | R+5 | R | R+5 | R | — | — | — |
| Chance mechanics (`chance.mechanics`) | /chance, /chance/configure (read), /chance/exposure | R+2 | — | R+1 | R | R+1 | R | — | — | — |
| Responsible-play queue (`chance.protection`) | /chance/protection | R+3 | — | R+3 | R | R+3 | R | — | — | — |
| Chance exceptions (`chance.exceptions`) | /chance/monitoring | R | — | R | R | R | R | — | — | — |
| Economy configuration (`config.economy`) | /economy, /economy/config | R | — | — | — | R | — | — | — | — |
| App control (`config.control`) | /tech/appcontrol | R | — | — | — | — | — | — | — | — |
| Daily rewards (`config.dailyRewards`) | /app-config/daily-rewards | R | — | — | — | — | — | — | — | — |
| Profile options (`config.profileOptions`) | /app-config/profile-options | R | — | — | — | — | — | — | — | — |
| Gift catalogue (`config.gifts`) | /gifts, /tech/content (gifts) | R+1 | — | R+1 | R+1 | R | R | — | — | — |
| Payment methods by country (`config.paymentMethods`) | /tech/payments | R | — | R | R | R | R | — | — | — |
