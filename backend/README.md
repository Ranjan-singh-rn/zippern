# Zipper API

The business record and money core. Python, FastAPI, MongoDB.

See `ARCHITECTURE.md` for why the system is split this way, and
`../CRM-FLOW.md` for the operating specification this implements.

---

## Running locally

**Use Python 3.12.** Not 3.13, not 3.14.

`pydantic-core` ships prebuilt wheels only up to 3.13, and its Rust bindings
reject anything newer. On 3.14 pip falls back to compiling from source and
fails. 3.12 is also what the Docker image deploys with, so local matches
production.

```bash
cd backend

# If your default python3 is newer than 3.12:
brew install python@3.12
/opt/homebrew/bin/python3.12 -m venv .venv      # /usr/local/... on Intel Macs

# Otherwise:
python3 -m venv .venv

source .venv/bin/activate
python --version                                 # confirm 3.12.x
pip install -r requirements.txt
cp .env.example .env                             # then fill it in
uvicorn app.main:app --reload --port 8080
```

Interactive API docs: <http://localhost:8080/docs>

### MongoDB must be a replica set

Transactions are used for every money movement, and a standalone `mongod`
cannot start one. Either use Atlas, or run a single-node replica set locally:

```bash
docker run -d -p 27017:27017 --name zipper-mongo mongo:7 --replSet rs0
docker exec zipper-mongo mongosh --eval 'rs.initiate()'
```

### First run

```bash
python -m scripts.seed_accounts
```

Creates the three owner accounts and the observer record. Edit the `OWNERS`
list in that file first.

---

## Signing in

### Owners, staff and partners

Firebase Auth. The client signs in with Firebase, then exchanges the ID token:

```
POST /api/auth/signin        { "id_token": "<firebase id token>" }
  → { token, expires_at, user }
```

Send the returned token as `Authorization: Bearer <token>` on every request.

### Observer

No password is stored anywhere. Every sign-in issues a fresh one-time code.

```
POST /api/auth/observer/request-code
  → emails a 6-digit code, returns only where it was sent (masked)

POST /api/auth/observer/verify-code   { "code": "123456" }
  → { token, expires_at, user }
```

The account address and the delivery address are deliberately different:

| | |
|---|---|
| Signs in as | `314zipper@gmail.com` |
| Code delivered to | `soumyars675@gmail.com` |

So possession of the observer address is not sufficient to sign in — access to
the second mailbox is required as well.

Codes are stored hashed with a per-code salt, expire after 10 minutes, are
single-use, allow 5 attempts, and are rate limited to one per 60 seconds.
Requesting a new code voids any outstanding one. Both success and failure are
written to the audit log.

### The weekly accrual job — a machine, not a person

The Sunday Cloud Function that generates the payout report also accrues each
agency's commission, with nobody watching. It holds a **service credential**: a
standing key, no session, no JWT, no role.

```
POST /api/partner-ops/agencies/{agency_id}/commission-accruals
GET  /api/partner-ops/agencies/{agency_id}/commission-preview?period=2026-W33
  X-Service-Key: <the key>
```

Those two routes are the only ones in the API that read `X-Service-Key`. The
credential is defined once, in `app/core/security.py` → `SERVICE_CREDENTIALS`,
and carries an explicit allowlist of two operations — `commission.accrue` and
`commission.preview`. It is not a role and it does not widen when a route is
added; only editing that tuple widens it.

| | |
|---|---|
| Key comes from | `SERVICE_KEY_WEEKLY_ACCRUAL`, a Cloud Run secret |
| Minted by | `python3 -m scripts.generate_service_key` |
| Resolves to | `system:weekly-accrual`, role `system` |
| May do | accrue commission, preview commission |
| May **not** do | anything else, including every `/execute` and `/approve` |

Empty, or shorter than 32 characters, means no machine may call anything — and
an unconfigured server is refused identically to a wrong key, so neither is
observable from outside. Accrual creates a liability; paying one is
`/commission-payouts/{card}/execute`, which still requires an owner's signature.

Unattended accrual takes a stricter path than a team admin's: it previews first,
refuses a figure computed from a provisional slab table, refuses a total above
`SERVICE_ACCRUAL_MAX_MINOR`, and reports a zero week as a zero rather than an
error. Deployment is DEPLOYMENT.md § 8; the tests are
`tests/test_service_credential.py`.

---

## What the observer can do

Read everything. Write nothing. `require_write` rejects the observer role on
every mutating endpoint, so this holds regardless of which route is added later.

---

## The money rule

**No client ever writes a balance.** Not the CRM browser, not the Android app.

Every movement goes through `app/services/money.py::apply_movement`, which in a
single MongoDB transaction:

1. reads the current balance
2. refuses a debit that would go negative, unless explicitly permitted
3. writes the new balance
4. writes a ledger entry
5. writes an audit entry with who, when, before → after, and why

All five commit together or none do. Afterwards the new balance is pushed to
Firestore for the app to read. If that push fails the ledger is still correct —
Firestore is a replica, never the source of truth.

An `idempotency_key` is enforced by a unique index, so the same operation can
never be applied twice.

---

## The audit log

Append-only. `app/core/audit.py` has no update and no delete function, and the
database user should not be granted those rights on that collection either —
including for owners.

A reason is mandatory. `record()` raises without one.

Visibility follows spec 6.3: observer and owners see everything, a team admin
sees their team, a member sees themselves.

---

## Layout

```
app/
  main.py            application entry
  config.py          settings from environment
  core/
    roles.py         roles and authority — the only place this is defined
    security.py      sign-in, sessions, observer one-time codes
    deps.py          request guards (require_write, require_owner, …)
    audit.py         append-only history
  db/
    mongo.py         connection, collections, indexes
    firebase.py      token verification, Firestore balance sync
  routers/
    auth.py          sign-in endpoints
  services/
    money.py         the money core — every balance movement
    email.py         outbound mail
scripts/
  seed_accounts.py   create owners and observer
```

---

## Deploying

Container to Cloud Run, fronted by a Firebase Hosting rewrite so it shares the
domain:

```json
{ "source": "/api/**", "run": { "serviceId": "zipper-api", "region": "asia-south1" } }
```

Provision MongoDB Atlas in Mumbai (`ap-south-1`) to sit close to your users.
Firestore is currently in `asia-east1` (Taiwan) — worth moving to `asia-south1`
while there is no live data.

---

## Built so far — 85 endpoints across 8 routers

| Router | Endpoints | Covers |
|---|---|---|
| `/auth` | 5 | Firebase sign-in, observer one-time code, sessions |
| `/cards` | 9 | The five-stage money board, inbox, bulk sign |
| `/audit` | 2 | Append-only log, scoped by role; per-record history |
| `/staff` | 6 | Invite, list, role change, deactivate |
| `/users` | 16 | Ban, warn, host, seller flag, balance requests, device bans, report queue |
| `/partners` | 7 | Agency and seller statements, credit exposure |
| `/partner-ops` | 27 | Onboarding, inventory, lending, recovery, sales, commission, sub-agency |
| `/reports` | 13 | Cash position, revenue, margin, liabilities, throughput, CSV export |

Key guarantees:

- **No client writes money.** Every movement goes through `apply_movement`, in one
  Mongo transaction with its ledger and audit entry, keyed for idempotency.
- **Every action records a real actor.** No more the literal string "Admin".
- **Balance changes are cards**, never direct writes — raised, verified, signed by
  an owner, then executed as a separate step.
- **One definition per figure.** Revenue, payout and margin mean the same thing in
  every report; `/reports/definitions` publishes them.
- **Every export is audited** — who exported what, when.

## Tests

No database and no network. Run each from `backend/`:

```bash
python3 -m tests.test_authority
python3 -m tests.test_commission
python3 -m tests.test_partner_create
python3 -m tests.test_partner_session
python3 -m tests.test_attach_login
python3 -m tests.test_service_credential
python3 -m tests.test_reporting
python3 -m tests.test_alerts
python3 -m tests.test_delivery
python3 -m tests.test_broadcast
python3 -m tests.test_weekly_business
```

- **test_authority** — who may write, who may sign money, who may verify whose
  cards, how far each role sees into the audit log. Pure functions.
- **test_commission** — the slab engine, against the real slab table read out of
  `backups/`, not against bands invented for the test.
- **test_partner_create** — what `partners` records are written, and the shape
  every later money flow reads back.
- **test_partner_session** — how an agency or a coin seller is resolved to a
  session, and **every route in the API enumerated from the router source** and
  put in front of the real dependency with a real external session. Each one is
  either on the partner allowlist or refused, and the table is printed.
- **test_attach_login** — attaching a login to a partner record that has none:
  what it writes, that it approves nothing and moves nothing, and each refusal —
  none of which may create a Firebase account, a document or an audit entry.
- **test_service_credential** — both service credentials: what each unlocks,
  what each is refused, that their allowlists are disjoint, that a re-run
  credits nothing twice, and that no key value is anywhere in the repository.
- **test_reporting** — the scheduled reports: which days each period covers in
  the business timezone, that a section which cannot be computed prints as a
  failure and never a zero, that re-firing a job sends nothing twice, and that
  a job which raises leaves a `failed` row in the run log rather than silence.
- **test_alerts** — every numbered condition in 8A.4 has a detector, a
  threshold and an audience; each fires once and stays quiet on the next scan.
- **test_delivery** — every send leaves a record, including the ones that
  failed, and the API key is in none of them.
- **test_broadcast** — the composed email (8A.7.2): each audience resolving
  from the source that owns it, a partial resolution refusing rather than
  half-sending, an unsubscribed address staying out of every audience,
  attachments going through the one shared preparation, who may write to how
  many people, and the audit entry naming the audience it actually resolved to
  rather than the label it was asked for. Prints the authority table.
- **test_weekly_business** — the owner's weekly report, including that
  regenerating a week stores nothing twice and moves no figure.

## What runs unattended

Two credentials, two schedules, and nothing else in the system runs without a
person:

| | Fires | Holds | Does |
|---|---|---|---|
| `weeklyPayoutReportGenerator` | Sun 18:29 UTC | `SERVICE_KEY_WEEKLY_ACCRUAL` | The Firestore payout report, and accrues agency commission |
| Six `scheduled*` functions | see below, **IST** | `SERVICE_KEY_REPORTING` | Reports, alerts, statements, transactional email |

The six are every 15 min (transactional sweep), every 30 min (alert scan), 07:00
daily (daily reports), 07:30 Monday (weekly business report), 09:00 Monday
(partner statements) and 08:00 on the 1st (monthly pack) — all Asia/Kolkata,
which is also the calendar every period is cut in (`REPORT_TIMEZONE`). The live
table is `GET /api/notifications/schedule`; whether each actually ran is
`GET /api/notifications/runs/last`. Deployment is DEPLOYMENT.md § 8 and § 9.

## Next

- [ ] Staff management — invite, roles, reports-to
- [ ] Collections: virtual accounts, reconciliation
- [ ] Wire the CRM front end to this API
