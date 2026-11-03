# Zipper — Deployment

Everything ships through Firebase. The Python API runs on Cloud Run behind a
Firebase Hosting rewrite, so it shares the same domain and there is no CORS to
manage in production.

> **Moving to a different Firebase project? Read [`MIGRATION.md`](MIGRATION.md)
> first, not this file.**
>
> This document deploys *into* whichever project the repo is currently pointed
> at. It assumes the project already exists, is on Blaze, has Firestore in the
> right region, has the Auth providers turned on and has the Hosting site
> created — and it will happily deploy into the wrong one if the repo is still
> pointed there.
>
> `MIGRATION.md` covers all of that, then hands back here for § 4 onwards. The
> project id below is not a permanent fact about Zipper: it is whatever
> `backend/scripts/retarget_project.py` last wrote, and it changes wholesale
> when the project does.

---

## 1. Getting `zipper.web.app`

> If you came here from `MIGRATION.md`, this section is already done —
> its § 3 created the site and its § 4 wired `firebase.json` and `.firebaserc`
> to it. Skip to § 2. What follows is the explanation, kept because it is the
> reason the setup looks the way it does.

### The constraint

The default URL is `zipperlive.web.app` because that is the **project
ID**, and a Firebase project ID **cannot be changed after creation**. There is
no rename. Moving to a new project gets you a new project id, not a nicer URL —
the Hosting site below is what gets you the URL, and it works in any project.

### The fix — add a Hosting site

A project can host several sites. Each new site gets its own subdomain, and the
project ID is irrelevant to it.

```bash
firebase hosting:sites:create zipper
```

Success gives you both:
- `https://zipper.web.app`
- `https://zipper.firebaseapp.com`

**Requirements:** Blaze plan. The site ID must be a valid hostname label,
30 characters or fewer, and **globally unique across all of Firebase** — not
just unique in your project.

### If `zipper` is taken

It is a common word, so expect it might be. The command fails immediately if so.
Try in order:

```bash
firebase hosting:sites:create zipper-app
firebase hosting:sites:create zipperlive
firebase hosting:sites:create getzipper
firebase hosting:sites:create zipper-live
```

### Wire the site to your build

Give the site a target name, then point `firebase.json` at it:

```bash
firebase target:apply hosting production zipper
```

In `firebase.json`, change the `hosting` block from an object to an array and
add the target:

```json
"hosting": [
  {
    "target": "production",
    "public": "zipper-crm/out",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "rewrites": [
      { "source": "/api/**", "run": { "serviceId": "zipper-api", "region": "asia-south1" } },
      { "source": "/agencies/*/salary", "destination": "/agencies/_/salary/index.html" },
      { "source": "/agencies/**",       "destination": "/agencies/_/index.html" },
      { "source": "/sellers/**",        "destination": "/sellers/_/index.html" },
      { "source": "/approvals/**",      "destination": "/approvals/_/index.html" },
      { "source": "/users/**",          "destination": "/users/_/index.html" },
      { "source": "**",                 "destination": "/index.html" }
    ]
  }
]
```

Then deploy to the target:

```bash
cd zipper-crm && npm run build && cd ..
firebase deploy --only hosting
```

The default `zipperlive.web.app` keeps working. Both point at the same
project; you can retire the default one later or leave it.

Everything else in this file — the CORS list in `backend/app/main.py`,
`ZIPPER_API_BASE_URL` in `functions/.env`, the login links in the report emails,
the "CRM is live at" lines in the deploy scripts — is written against the site's
hostname, not the project's. `retarget_project.py` keeps the two apart: it sends
`.web.app` and `.firebaseapp.com` URLs to the site name and sends `authDomain`,
which is genuinely project-scoped, to the project id.

### What you actually want eventually

`zipper.web.app` is fine for now, but a real product wants its own domain —
`zipper.app`, `zipperlive.in`, whatever you buy. Firebase Hosting connects
custom domains and issues the TLS certificate free:

```bash
firebase hosting:sites:list
# then in the console: Hosting → your site → Add custom domain
```

Do that when you buy the domain. Nothing else changes.

---

## 2. MongoDB Atlas

1. Create a cluster in **`ap-south-1` (Mumbai)** — closest to your users.
2. It must be a **replica set**. Any Atlas cluster including the free M0 tier
   already is, so nothing to configure. A standalone `mongod` cannot run
   transactions and the money core requires them.
3. Create a database user, and allow access from Cloud Run's egress.
4. Copy the connection string — it goes into `MONGO_URI`.

---

## 3. Secrets

Never in the repo. Put them in Secret Manager:

**You need `roles/owner` on the project, or `roles/secretmanager.admin`
specifically.** Basic `roles/editor` does *not* include Secret Manager — it has
its own role family exactly so that a broad project role does not confer access
to secrets. Every command in this section fails with `PERMISSION_DENIED` if all
you hold is Editor.

```bash
gcloud config set project zipper-83816

echo -n "mongodb+srv://..."        | gcloud secrets create MONGO_URI       --data-file=-
echo -n "$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')" \
                                    | gcloud secrets create JWT_SECRET     --data-file=-
echo -n "SG.xxxxx"                  | gcloud secrets create SENDGRID_API_KEY --data-file=-
```

Two more secrets are minted by a script rather than typed, and each has its own
section:

- **`SERVICE_KEY_WEEKLY_ACCRUAL`** — § 8. Without it the Sunday job generates
  the payout report and accrues nothing.
- **`SERVICE_KEY_REPORTING`** — § 9. Without it nothing is scheduled at all: no
  daily report, no weekly report, no partner statement, no monthly pack and no
  exception alert.

They hold **different values**. Do not generate one and use it twice.

Grant the Cloud Run service account read access to each:

```bash
PROJECT_NUMBER=$(gcloud projects describe zipper-83816 --format='value(projectNumber)')
for S in MONGO_URI JWT_SECRET SENDGRID_API_KEY; do
  gcloud secrets add-iam-policy-binding $S \
    --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done
```

---

## 4. Deploy the API to Cloud Run

**Prefer `./deploy.sh` from the repo root.** It runs this command with the full
env and secret lists, checks every secret exists *before* spending minutes on a
container build, refuses to ship if the backend tests fail, and health-checks
the result. Use `./deploy.sh --api-only` for just this step. The raw command is
kept below for reference and for when you need to vary something.

`backend/Dockerfile` is already in place. From the repo root:

```bash
cd backend

gcloud run deploy zipper-api \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --set-env-vars "ENVIRONMENT=production,MONGO_DB=zipper,FIREBASE_PROJECT_ID=zipper-83816,OBSERVER_EMAIL=314zipper@gmail.com,OBSERVER_OTP_DELIVERY_EMAIL=soumyars675@gmail.com,MAIL_FROM=no-reply@zipperlive.org,MAIL_FROM_NAME=Zipper,REPORT_TIMEZONE=Asia/Kolkata,PORTAL_URL=https://zipperlive.web.app,UNSUBSCRIBE_EMAIL=support@zipperlive.org" \
  --set-secrets "MONGO_URI=MONGO_URI:latest,JWT_SECRET=JWT_SECRET:latest,SENDGRID_API_KEY=SENDGRID_API_KEY:latest,SERVICE_KEY_WEEKLY_ACCRUAL=SERVICE_KEY_WEEKLY_ACCRUAL:latest,SERVICE_KEY_REPORTING=SERVICE_KEY_REPORTING:latest,SERVICE_KEY_PARTNER_REGISTRATION=SERVICE_KEY_PARTNER_REGISTRATION:latest" \
  --min-instances 0 \
  --max-instances 10 \
  --memory 512Mi
```

`--set-secrets` **replaces** the whole list, so all six have to be named every
time; dropping one silently turns that machine identity off — every Sunday
accrual refused, or every scheduled report and alert refused, with no error
until someone notices the email never came. The right-hand side is a Secret
Manager *reference* — `NAME:latest` names the secret to fetch at boot. No key
value is ever written into a deploy command.

**`SERVICE_KEY_PARTNER_REGISTRATION` was missing from this command** until it
was corrected, and it is the one whose absence is hardest to spot. The Firestore
trigger that fires on every public agency or seller signup presents it to
`POST /api/partner-ops/partners`. Empty on the API, the call is refused, and the
applicant is written to Firestore only — where no staff screen reads them. The
approval queue stays empty, nothing errors, and the only signal is a partner
saying they applied days ago. Recovery is
`cd backend && python -m scripts.backfill_partners --confirm`.

Each of the three service credentials has to be set **on both sides with the
same value** — Cloud Run holds one half, Cloud Functions the other:

| Purpose | Cloud Run secret | Cloud Functions secret |
|---|---|---|
| Sunday commission accrual | `SERVICE_KEY_WEEKLY_ACCRUAL` | `ZIPPER_ACCRUAL_KEY` |
| Scheduled reports and alerts | `SERVICE_KEY_REPORTING` | `ZIPPER_REPORTING_KEY` |
| Public partner signup | `SERVICE_KEY_PARTNER_REGISTRATION` | `ZIPPER_PARTNER_REGISTRATION_KEY` |

Set the Functions half with `firebase functions:secrets:set ZIPPER_…`. Setting
one side only fails at call time, days later, inside a scheduler nobody is
watching. `./deploy.sh` warns when a half is missing.

`PORTAL_URL` and `UNSUBSCRIBE_EMAIL` were also added above. `PORTAL_URL`
defaults to `https://zipper.web.app`, which is not this site — leaving it
unset points every link in every email at a domain you do not own.
`UNSUBSCRIBE_EMAIL` is `support@zipperlive.org`; unset, it now falls back to
the same support address (QA #47) rather than deriving an address nobody created.

**Email identities (owner decision, 3 Nov 2026 — final; see § 11.7).** The
domain is `zipperlive.org`, authenticated in SendGrid. `MAIL_FROM` is
`no-reply@zipperlive.org` and sends every automated message; `support@` and
`info@zipperlive.org` are the contact addresses people are told to write to.
Earlier versions of this guide used a personal Gmail address as `MAIL_FROM`;
that is history (§ 11.0) and must not be reintroduced.

If `SERVICE_KEY_WEEKLY_ACCRUAL` does not exist yet, create it first — § 8. The
deploy fails if the secret is missing.

**On a project created recently, the first `--source` deploy fails on IAM.**
`gcloud run deploy --source .` builds through Cloud Build using
`<PROJECT_NUMBER>-compute@developer.gserviceaccount.com`, and that account no
longer gets build permissions by default. The error is a `PERMISSION_DENIED` on
`storage.objects.get` that does not mention IAM. Once, per project:

```bash
PID=$(gcloud config get-value project)
PN=$(gcloud projects describe $PID --format='value(projectNumber)')
gcloud projects add-iam-policy-binding $PID \
  --member="serviceAccount:${PN}-compute@developer.gserviceaccount.com" \
  --role="roles/cloudbuild.builds.builder"
```

**`--allow-unauthenticated` is correct here.** It means Cloud Run does not
demand a Google identity — your own token check in `app/core/deps.py` is what
guards every route. Without it, Firebase Hosting could not reach the service.

**On the region:** `asia-south1` (Mumbai) is supported for Hosting rewrites and
sits closest to your users and your Mongo cluster. Google's co-location list for
lowest Hosting→Cloud Run latency is `us-*`, `europe-west1` and `asia-east1` —
Mumbai is not on it, but being physically near your users and database matters
more here than the co-location hop.

Cloud Run uses the default service account, which already has Firebase Admin
rights in your project, so no `serviceAccountKey.json` is needed in the
container.

---

## 5. Point Hosting at the API

The rewrite in step 1 sends `/api/**` to Cloud Run. Deploy it:

```bash
firebase deploy --only hosting
```

Now `https://zipper.web.app/api/health` should return `{"status":"ok"}`.

The CRM calls `/api/...` on its own origin. No CORS, no separate API domain,
one TLS certificate.

---

## 6. Seed the governance accounts

Once, against the production database:

```bash
cd backend
source .venv/bin/activate
# point .env at the Atlas cluster first
python -m scripts.seed_accounts
```

Edit `OWNERS` in that file with all three owner emails before running. Each gets
a Firebase account and a set-password email. The observer gets a record but no
password — sign-in is a one-time code every time.

---

## 7. Rules and indexes

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

Deploy indexes **before** hosting when they are new — index builds take minutes
to hours, and queries needing them fail until the build finishes.

---

## 8. The weekly commission accrual

Every Sunday at 18:29 UTC the Cloud Function `weeklyPayoutReportGenerator`
builds the payout report **and** accrues each agency's commission by calling the
API. It computes no commission itself: it previews, checks, then asks the API to
accrue, and the API derives the figure from the ledger.

To do that it needs a **service credential** — one standing key, held by a
machine, that unlocks exactly two operations (`commission.accrue`,
`commission.preview`) and nothing else. It cannot move cash: every `/execute`
and `/approve` route still requires an owner's signature.

**The same key value goes in two places**, and they are two separate Secret
Manager secrets:

| Side | Secret Manager name | Arrives as |
|---|---|---|
| Backend (Cloud Run) | `SERVICE_KEY_WEEKLY_ACCRUAL` | env var of the same name, via `--set-secrets` |
| Cloud Function | `ZIPPER_ACCRUAL_KEY` | env var of the same name, via `runWith({ secrets })` |

They are separate because the two runtimes bind secrets differently. Nothing
keeps them in step but you, so the commands below copy one value into the other
rather than generating it twice. **Never generate the key twice.**

### 8.1 Mint the key

It is printed once, is never written to disk, and must not go into
`backend/.env`, `functions/.env`, a commit, a ticket or a chat.

```bash
cd backend
python3 -m scripts.generate_service_key --quiet \
  | gcloud secrets create SERVICE_KEY_WEEKLY_ACCRUAL --data-file=-
```

That mints 64 characters and pipes them straight into Secret Manager, so the
value never reaches your terminal scrollback. (`python3 -m
scripts.generate_service_key` without `--quiet` prints it for you to copy, if
you would rather see it. You do not need to.)

If the secret already exists, add a new version instead of creating it:

```bash
python3 -m scripts.generate_service_key --quiet \
  | gcloud secrets versions add SERVICE_KEY_WEEKLY_ACCRUAL --data-file=-
```

### 8.2 Let Cloud Run read it

```bash
cd ..
PROJECT_NUMBER=$(gcloud projects describe zipper-83816 --format='value(projectNumber)')
gcloud secrets add-iam-policy-binding SERVICE_KEY_WEEKLY_ACCRUAL \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### 8.3 Give the backend the secret

Redeploy Cloud Run with the fourth secret in the list — the full command is in
§ 4, and the line that matters is:

```
--set-secrets "MONGO_URI=MONGO_URI:latest,JWT_SECRET=JWT_SECRET:latest,SENDGRID_API_KEY=SENDGRID_API_KEY:latest,SERVICE_KEY_WEEKLY_ACCRUAL=SERVICE_KEY_WEEKLY_ACCRUAL:latest"
```

Or, without a full redeploy:

```bash
gcloud run services update zipper-api --region asia-south1 \
  --update-secrets "SERVICE_KEY_WEEKLY_ACCRUAL=SERVICE_KEY_WEEKLY_ACCRUAL:latest"
```

### 8.4 Copy the same value to the Cloud Function

This pipes the secret from one place to the other. The value is never displayed
and never lands in a file:

```bash
gcloud secrets versions access latest --secret=SERVICE_KEY_WEEKLY_ACCRUAL \
  | firebase functions:secrets:set ZIPPER_ACCRUAL_KEY --data-file=-
```

`firebase functions:secrets:set` creates the secret in the same project's Secret
Manager and grants the functions runtime service account access to it.

### 8.5 Tell the function where the API is

`functions/.env` already carries this. Confirm it points at an origin that
serves the API, and change it if not:

```
ZIPPER_API_BASE_URL=https://zipperlive.web.app
```

The Hosting origin works because of the `/api/**` rewrite in `firebase.json`.
The Cloud Run URL works too and skips the Hosting hop:

```bash
gcloud run services describe zipper-api --region asia-south1 --format='value(status.url)'
```

Whichever you use, it must be **https** — the function refuses to send a service
key over plain http — and it must answer:

```bash
curl https://zipperlive.web.app/api/health   # {"status":"ok"}
```

### 8.6 Deploy the function

The secret must exist **before** this, or the deploy fails naming it.

```bash
cd functions && npm run build && cd ..
firebase deploy --only functions:weeklyPayoutReportGenerator
```

`firebase.json` compiles the TypeScript on every functions deploy, so the
explicit `npm run build` is belt and braces — but run it anyway and read its
output. It must exit 0. If it does not, `functions/lib` still holds the previous
build and nothing you changed would have shipped.

### 8.7 Check it, without accruing anything

The preview endpoint credits nothing, so it is safe to call by hand. This puts
the key in a shell variable, uses it, and unsets it — it is never echoed:

```bash
API=https://zipperlive.web.app
AGENCY=<any approved agency's Firestore document id>
PERIOD=$(date -u -v-7d +%G-W%V 2>/dev/null || date -u -d '7 days ago' +%G-W%V)

KEY="$(gcloud secrets versions access latest --secret=SERVICE_KEY_WEEKLY_ACCRUAL)"
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "X-Service-Key: $KEY" \
  "$API/api/partner-ops/agencies/$AGENCY/commission-preview?period=$PERIOD"
unset KEY
```

- `200` — the backend has the key and accepts it. Both sides are correct.
- `401` — the backend does not have this key, or has a different one. § 8.3.
- `404` — that agency id has no partner record. The key is fine.

Then check the function's own copy matches, by watching a real run:

```bash
firebase functions:log --only weeklyPayoutReportGenerator
```

A healthy run logs `Weekly report <week> generated and commission accrued.`
A misconfigured one logs `COMMISSION DID NOT ACCRUE` at error level, and the
email says so in red at the top.

### 8.8 If the two sides drift

Nothing detects drift in advance. What happens if it occurs:

- The function sends the key, the API does not recognise it, every agency comes
  back **401** and **nothing is accrued**. No partial state, no half-credited
  week — the credential is checked before anything is computed.
- The report is still generated and still correct. Only the accrual is missing.
- The email arrives with a red banner naming the problem, and the report
  document records `commissionAccrual.credentialRejected: true`.
- Neither key value appears in the email, the log, the report or the error.

**To fix:** re-run § 8.1 (a new version), then § 8.3 **and** § 8.4 from that same
version, then redeploy both sides. Rotating one side alone is what caused it.

Re-running a week after fixing costs nothing: accrual is idempotent per agency,
host and period, so any agency already accrued answers `already_accrued` and is
credited nothing a second time.

### 8.9 If you skip this section entirely

The report still generates. Every agency line reads `NOT ATTEMPTED`, the email
leads with a red banner saying commission was not accrued and why, and the log
carries an error. Nothing is lost and nothing is wrong — the week simply has to
be accrued once you have done § 8, by re-running the schedule or by a team admin
calling the endpoint by hand.

---

## 9. The scheduled reports, alerts and transactional email

Part 8A — the daily reports, the weekly business report, partner statements, the
monthly pack, the nine exception alerts and the transactional email sweep. All
of it is built and none of it has a clock until you do this section. Skip it and
the API is a set of endpoints nobody calls: no report arrives, no alert fires,
and a rejected agency is never told why.

**What runs, and when.** Every time below is **Asia/Kolkata (IST, UTC+05:30)**,
and so is every period the jobs cover — an owner in Mumbai reading "yesterday"
gets yesterday as they lived it, midnight to midnight, not `[00:00 UTC, 24:00
UTC)`, which for them starts and ends at half past five in the morning.

| Cloud Function | Fires (IST) | Calls | Covers |
|---|---|---|---|
| `scheduledTransactionalSweep` | every 15 min | `POST /api/notifications/jobs/transactional-sweep` | Every transactional email a record says is owed — 8A.2 |
| `scheduledAlertScan` | every 30 min | `POST /api/notifications/jobs/alerts` | The nine exception detectors — 8A.4 |
| `scheduledDailyReports` | 07:00 daily | `POST /api/notifications/jobs/daily` | Yesterday, whole — 8A.3.1–8A.3.3 |
| `scheduledWeeklyBusinessReport` | 07:30 Monday | `POST /api/reports/jobs/weekly-business` | The ISO week that closed at 05:30 IST that morning |
| `scheduledPartnerStatements` | 09:00 Monday | `POST /api/notifications/jobs/partner-statements?cadence=weekly&period=last-week` | Every agency and seller — 8A.3.6 / 8A.3.7 |
| `scheduledMonthlyReports` | 08:00 on the 1st | `POST /api/notifications/jobs/monthly` | Last calendar month — 8A.3.9–8A.3.12 |

The same table is served live at `GET /api/notifications/schedule`, read from
`backend/app/services/scheduling.py::SCHEDULE`, which is where the crons in
`functions/src/index.ts` come from. If the two ever disagree it is a diff in one
file, not a discovery on a quiet Monday.

**Two things are deliberately not Sunday.** The weekly business report fires on
Monday because an ISO week does not end until 00:00 UTC on Monday — a Sunday
evening run is *inside* the week it is trying to report on, and the backend
would correctly hand it the week before that instead. And the statements go out
ninety minutes after the business report, so the owners have seen the week
before the partners are written to about it.

### 9.1 Why a Cloud Function and not Cloud Scheduler straight to Cloud Run

Scheduler → Cloud Run with an OIDC token is the better shape in the abstract:
Google signs the token, Cloud Run verifies it, no shared secret to drift. It is
not available here, because of a decision already made in § 4:

- The CRM reaches the API through the Firebase Hosting rewrite (`/api/**` →
  `zipper-api`). Hosting invokes Cloud Run **anonymously**, so the service has
  to keep `--allow-unauthenticated`. With that set, Cloud Run's IAM invoker
  check is not enforced for anybody — an OIDC token from Scheduler would arrive
  and be ignored. It would look like authentication and be decoration.
- Verifying the token inside FastAPI instead would work, but it puts a second
  machine-authority model next to the one in `app/core/security.py` — one with
  no operation allowlist, where "Google signed this" is the whole check. The
  existing model's central claim is that a credential names the exact operations
  it may perform.

So this is § 8's pattern, deployed a second time with a second key.
`.pubsub.schedule()` **is** Cloud Scheduler — deploying these functions creates
six Scheduler jobs and six Pub/Sub topics for you.

### 9.2 Mint the reporting key

A **different value** from the accrual key. Never reuse it: leaking the ability
to email a report must not also grant the ability to create a commission
liability. It wears the `zpr_rp_` prefix so a value found in a log says which
credential it is.

```bash
cd backend
python3 -m scripts.generate_service_key --credential reporting --quiet \
  | gcloud secrets create SERVICE_KEY_REPORTING --data-file=-
```

If the secret already exists, add a version rather than creating it:

```bash
python3 -m scripts.generate_service_key --credential reporting --quiet \
  | gcloud secrets versions add SERVICE_KEY_REPORTING --data-file=-
```

### 9.3 Let Cloud Run read it

```bash
cd ..
PROJECT_NUMBER=$(gcloud projects describe zipper-83816 --format='value(projectNumber)')
gcloud secrets add-iam-policy-binding SERVICE_KEY_REPORTING \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### 9.4 Give the backend the secret, and the timezone

`--set-secrets` **replaces the whole list**, so all five have to be named. And
`REPORT_TIMEZONE` is what decides where the day is cut — leave it unset and it
defaults to `Asia/Kolkata`, but set it explicitly so it is visible on the
service rather than implied by a default.

```bash
gcloud run services update zipper-api --region asia-south1 \
  --update-secrets "SERVICE_KEY_REPORTING=SERVICE_KEY_REPORTING:latest" \
  --update-env-vars "REPORT_TIMEZONE=Asia/Kolkata"
```

Or, on a full redeploy, the line in § 4 becomes:

```
--set-secrets "MONGO_URI=MONGO_URI:latest,JWT_SECRET=JWT_SECRET:latest,SENDGRID_API_KEY=SENDGRID_API_KEY:latest,SERVICE_KEY_WEEKLY_ACCRUAL=SERVICE_KEY_WEEKLY_ACCRUAL:latest,SERVICE_KEY_REPORTING=SERVICE_KEY_REPORTING:latest"
```

### 9.5 Copy the same value to the Cloud Functions

The value is never displayed and never lands in a file:

```bash
gcloud secrets versions access latest --secret=SERVICE_KEY_REPORTING \
  | firebase functions:secrets:set ZIPPER_REPORTING_KEY --data-file=-
```

`ZIPPER_API_BASE_URL` in `functions/.env` is already set from § 8.5 and is
shared with the accrual job. Nothing else to set.

### 9.6 Deploy the six functions

The secret must exist **before** this, or the deploy fails naming it.

```bash
cd functions && npm run build && cd ..

firebase deploy --only \
functions:scheduledTransactionalSweep,\
functions:scheduledAlertScan,\
functions:scheduledDailyReports,\
functions:scheduledWeeklyBusinessReport,\
functions:scheduledPartnerStatements,\
functions:scheduledMonthlyReports
```

`npm run build` must exit 0. If it does not, `functions/lib` still holds the
previous build and nothing you changed would have shipped.

Deploying these creates the Cloud Scheduler jobs. Confirm all six exist:

```bash
gcloud scheduler jobs list --location=us-central1 \
  --format='table(name, schedule, timeZone, state)' | grep -i schedul
```

Every one must read `Asia/Kolkata` and `ENABLED`. `us-central1` is where v1
`pubsub.schedule` functions land; if the list is empty, look there first before
assuming the deploy failed.

### 9.7 Check it — and how to re-run one by hand

**Is the key right?** A call with the reporting key to a route it holds. This
puts the key in a shell variable, uses it, and unsets it — it is never echoed:

```bash
API=https://zipperlive.web.app
KEY="$(gcloud secrets versions access latest --secret=SERVICE_KEY_REPORTING)"
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "X-Service-Key: $KEY" \
  "$API/api/notifications/jobs/alerts"
unset KEY
```

- `200` — both sides hold the same key. The alert scan just ran; it sent
  nothing new unless something was actually wrong.
- `401` — the backend has a different key, or none. Redo § 9.4 and § 9.5 from
  the *same* secret version.
- `403` — a **valid** key reaching outside its allowlist. You used the accrual
  key by mistake.

**Did each job actually run?** This is the page to bookmark. Sign in as an
owner and open:

```
GET /api/notifications/runs/last
```

Every job, when it last ran, and one of five verdicts:

| | |
|---|---|
| `ok` | ran, everything in it worked |
| `degraded` | ran, delivered what it could, something in it did not — read `problems` |
| `failed` | raised, and sent nothing |
| `never` | no run has ever been recorded. The schedule was never wired up — this is not an empty period |
| `stalled: true` | set independently of the above. The last run was fine and was three weeks ago |

`GET /api/notifications/runs?job=reports.daily` is the full history of one job,
and every row says `trigger` — `schedule` or `person` — and who.

**Re-run one by hand.** Two ways, and they do different things:

```bash
# 1. Fire the Cloud Scheduler job. Exactly what the schedule does.
gcloud scheduler jobs run \
  firebase-schedule-scheduledDailyReports-us-central1 --location=us-central1
```

```bash
# 2. Call the endpoint yourself, as a team admin or an owner with a session.
#    Same authority, and the run log records it as trigger: "person".
curl -X POST -H "Authorization: Bearer $SESSION" \
  "$API/api/notifications/jobs/daily"
```

Either is safe. **Nothing double-sends.** Every scheduled email carries a
`dedupe_key` built from the report, the period and the recipient, and
`email_deliveries.dedupe_key` is unique — a second run for the same period
records `duplicate` and sends nothing. The weekly business report is stronger
still: the document is stored under the week's own id and a second trigger is
answered with the report that already exists, so the figures cannot move.

A re-run that happens *after* a mail outage **does** deliver, because it re-sends
the stored report rather than skipping — that is the case the dedupe is designed
to let through.

To deliberately regenerate a week whose sections failed and have since been
fixed, ask for a new revision. It sits beside the original and never edits it:

```bash
curl -X POST -H "Authorization: Bearer $SESSION" \
  -H 'Content-Type: application/json' \
  -d '{"week":"2026-W33","force":true}' \
  "$API/api/reports/jobs/weekly-business"
```

`GET /api/reports/weekly-business/2026-W33` then returns every revision, oldest
first, with revision 0 — what the Monday job stored — untouched.

### 9.8 What happens when something is wrong

**A job fails.** The function logs an ERROR naming the job and the reason, the
Cloud Scheduler execution is marked failed (so it is visible in the console
without reading logs), and the backend has already written the attempt to
`scheduled_runs` — it appears on `/api/notifications/runs/last` with
`status: "failed"` and the exception on it. Nothing is silently skipped.

**A job runs and something in it does not.** A report section that could not be
computed prints as a failure inside the email, in red, saying in words that it
is not a zero. The run is `degraded`, not `ok`, and `problems` names what. The
daily exception report carries it to a person the next morning.

**The key is missing or wrong.** Missing: the function throws before making any
call, and logs `<job> DID NOT RUN. ZIPPER_REPORTING_KEY is not set on this
function… See DEPLOYMENT.md § 9.` — it names the variable, never a value.
Wrong: the API answers 401, the function logs that the two sides have drifted
and points at § 9.5. Either way nothing is sent and the failure is loud.

**The two sides drift.** Nothing detects it in advance. Re-run § 9.2 for a new
version, then § 9.4 **and** § 9.5 from that same version, then redeploy both
sides. Rotating one side alone is what caused it.

**Nobody is on the staff record.** A report whose audience resolves to nobody is
recorded as an error on the run naming the empty audience — never as a send of
zero emails. Fix it by seeding the accounts (§ 6). Check who an audience
currently resolves to, before a threshold is changed, with
`GET /api/notifications/audiences/owners`.

### 9.9 If you skip this section entirely

The API is complete and nothing calls it. No daily report, no weekly report, no
statement, no monthly pack, and — the one that costs money — no alert. A card
above your signature threshold sits unsigned with nobody told, a duplicate
payment reference goes unnoticed until reconciliation, and a rejected agency
never learns why. `GET /api/notifications/runs/last` shows every job as `never`,
which is exactly what it means.

---

## 10. Partner registration — making a new agency or seller appear for approval

Until this section is done, **a new agency or coin seller appears on no staff
screen at all.** They register, they get a CRM login, they get the "we have your
application" email, they see the holding page — and `/kyc`, `/agencies` and
`/sellers` do not list them, because those queues are built from
`GET /api/partner-ops/partners`, which reads Mongo, and every creation screen in
the CRM writes only a Firestore document.

Two Firestore triggers close that gap. They fire the instant an `agencies` or
`sellers` document is created and register the partner with the API, which
creates the business record **holding nothing** — zero coins, zero credit, zero
commission, zero cash, status `pending`, inactive. Approving it is still a
person's decision on `/kyc`, with a mandatory reason, exactly as before.

| Cloud Function | Fires on | Calls |
|---|---|---|
| `registerAgencyPartner` | a new document in `agencies/` | `POST /api/partner-ops/partners` |
| `registerSellerPartner` | a new document in `sellers/` | `POST /api/partner-ops/partners` |

Between them they cover all five creation paths — `/agency-signup`,
`/seller-signup`, `/agencies/register`, `/sellers/register` and the sub-agency
modal on `/agency-dashboard`. The two staff pages hand a non-superadmin's
submission to the approval queue instead of writing directly; when that request
is approved, `onApprovalApproved` creates the document with `ref.set(...)`,
which is a create, so it lands here too.

To do that the functions need a **third service credential** — its own standing
key, with an allowlist of exactly one operation (`partner.register`) and
therefore exactly one route. It cannot approve anybody, cannot accrue, cannot
load inventory and cannot pay: every `/execute` and `/approve` route still
requires an owner's signature, and approval is still `require_write`.

**It is a different value from the other two, and that is not bookkeeping.**
This key is held by a trigger that fires on every public signup — the most
frequently exercised machine path in the system — so it must not carry the
ability to create a commission liability (§ 8) or to email a business-wide
figure (§ 9). The worst a leaked registration key can do is create empty,
pending records for ids that already name real Firestore documents, which a
reviewer then rejects.

**The same key value goes in two places**, and they are two separate Secret
Manager secrets:

| Side | Secret Manager name | Arrives as |
|---|---|---|
| Backend (Cloud Run) | `SERVICE_KEY_PARTNER_REGISTRATION` | env var of the same name, via `--set-secrets` |
| Cloud Functions | `ZIPPER_PARTNER_REGISTRATION_KEY` | env var of the same name, via `runWith({ secrets })` |

### 10.1 Mint the key

Printed once, never written to disk, and it must not go into `backend/.env`,
`functions/.env`, a commit, a ticket or a chat. It wears the prefix `zpr_reg_`,
so a value found in a log says which secret to replace without anyone comparing
it against the live one.

```bash
cd backend
python3 -m scripts.generate_service_key --credential partner-registration --quiet \
  | gcloud secrets create SERVICE_KEY_PARTNER_REGISTRATION --data-file=-
```

If the secret already exists, add a new version instead of creating it:

```bash
python3 -m scripts.generate_service_key --credential partner-registration --quiet \
  | gcloud secrets versions add SERVICE_KEY_PARTNER_REGISTRATION --data-file=-
```

### 10.2 Let Cloud Run read it

```bash
cd ..
PROJECT_NUMBER=$(gcloud projects describe zipper-83816 --format='value(projectNumber)')
gcloud secrets add-iam-policy-binding SERVICE_KEY_PARTNER_REGISTRATION \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### 10.3 Give the backend the secret

Redeploy Cloud Run with it in the `--set-secrets` list — the full command is in
§ 4, and the line that matters now reads:

```
--set-secrets "MONGO_URI=MONGO_URI:latest,JWT_SECRET=JWT_SECRET:latest,SENDGRID_API_KEY=SENDGRID_API_KEY:latest,SERVICE_KEY_WEEKLY_ACCRUAL=SERVICE_KEY_WEEKLY_ACCRUAL:latest,SERVICE_KEY_REPORTING=SERVICE_KEY_REPORTING:latest,SERVICE_KEY_PARTNER_REGISTRATION=SERVICE_KEY_PARTNER_REGISTRATION:latest"
```

Or, without a full redeploy:

```bash
gcloud run services update zipper-api --region asia-south1 \
  --update-secrets "SERVICE_KEY_PARTNER_REGISTRATION=SERVICE_KEY_PARTNER_REGISTRATION:latest"
```

### 10.4 Copy the same value to the Cloud Functions

This pipes the secret from one place to the other. The value is never displayed
and never lands in a file:

```bash
gcloud secrets versions access latest --secret=SERVICE_KEY_PARTNER_REGISTRATION \
  | firebase functions:secrets:set ZIPPER_PARTNER_REGISTRATION_KEY --data-file=-
```

`ZIPPER_API_BASE_URL` in `functions/.env` is the same one § 8.5 set up and is
already correct if you did that section. It must be **https** — the function
refuses to send a service key over plain http.

### 10.5 Deploy the two functions

The secret must exist **before** this, or the deploy fails naming it.

```bash
cd functions && npm run build && cd ..
firebase deploy --only functions:registerAgencyPartner,functions:registerSellerPartner
```

`npm run build` must exit 0. If it does not, `functions/lib` still holds the
previous build and nothing you changed would have shipped.

These are Firestore triggers in `asia-south1`, the database's region. A trigger
deployed to the wrong region still reports success and then never fires, which
is why the region is pinned in `functions/src/index.ts` rather than left to a
default.

### 10.6 Check it, end to end

The honest check is a real registration, because that is the thing that was
broken:

1. Register a coin seller at `/seller-signup` (or an agency at
   `/agency-signup`) with an address you can read.
2. Open `/kyc` as ops. **The applicant is in the Coin sellers tile, `pending`,
   within a few seconds.** That is the fix.
3. `/audit` shows one `partner.created` entry for them, under **Partner
   registration (automated)**, role `system` — never under a person's name.
4. `GET /api/partner-ops/partners/<the Firestore doc id>` shows
   `status: "pending"`, `is_active: false`, `credit.outstanding: 0`,
   `cash_paid_minor: 0`, `total_coins_sold: 0`.

If you would rather check the credential alone, before any real applicant:

```bash
API=https://zipperlive.web.app
ID=<the Firestore document id of an agency or seller that already exists>

KEY="$(gcloud secrets versions access latest --secret=SERVICE_KEY_PARTNER_REGISTRATION)"
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "X-Service-Key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"partner_id\":\"$ID\",\"reason\":\"Checking the registration credential.\"}" \
  "$API/api/partner-ops/partners"
unset KEY
```

- `201` — both sides are correct. (The record is created, or already existed and
  nothing was changed. Either is a `201`; the body's `created` says which.)
- `401` — the backend does not have this key, or has a different one. § 10.3.
- `400` — that id names no Firestore `agencies` or `sellers` document. The key
  is fine; the id is wrong.

And the functions' own copy, by watching a real registration:

```bash
firebase functions:log --only registerAgencyPartner,registerSellerPartner
```

A healthy run logs `agencies/<id> registered with the API (agency, pending)`.
A broken one logs `WAS NOT REGISTERED` at error level and names the variable.

### 10.7 What happens when something is wrong

**A failure is never silent, and never invisible.** Whatever goes wrong, the
trigger writes the outcome onto the applicant's own Firestore document before it
does anything else:

```
partnerRecordFailed: true
partnerRecord: { status: 'failed', error: '<what went wrong>', httpStatus: 401 }
```

The CRM reads that flag. `/kyc`, `/agencies` and `/sellers` each show a red
panel — *"N applications never reached the queue"* — listing the applicants, the
reason, and a **Put in the queue** button that a team admin can press to create
the record by hand. A partner whose registration failed is worse than one who
never applied, because they have a login and they have been told we have their
application; so this is deliberately louder than an empty queue.

The function then throws, so the invocation is marked failed in Cloud Logging
rather than a lost applicant being reported as a healthy run.

**The key is missing.** The function makes no call at all, logs `WAS NOT
REGISTERED … ZIPPER_PARTNER_REGISTRATION_KEY is not set on this function`, and
records that on the document. It names the variable, never a value.

**The two sides drift.** The API answers 401, nothing is created, and the
recorded error says in words that
`ZIPPER_PARTNER_REGISTRATION_KEY` and `SERVICE_KEY_PARTNER_REGISTRATION` are not
the same value. **To fix:** re-run § 10.1 for a new version, then § 10.3 **and**
§ 10.4 from that same version, then redeploy both sides. Rotating one side alone
is what caused it.

**The API is unreachable or slow.** The call is bounded; a timeout is recorded
as a failure with the reason, exactly like a 401. Nothing is half-created — the
Mongo record either exists or does not.

**It fires twice.** Registration is idempotent. `ensure_partner_record` returns
the record that already exists, untouched, with `created: false`; no second
record, no audit entry, and **no balance reset**. That is also what happens for a
partner `scripts/backfill_partners.py` created earlier, and for the **Put in the
queue** button pressed on something that had already gone through.

**It is a second-capability application.** Documents written with
`source: 'second_role'` — an approved agency applying to also sell coins, or the
reverse — are deliberately **not** registered here. Staff bridge those with
`POST /api/partner-ops/partners/{held}/second-role`, which creates the record
*and* links it to the login. Registering one here first would create it unlinked
and permanently block the second-capability flow for that applicant.

### 10.8 Anything created while this was broken

Every agency and seller registered before this section was deployed is in
Firestore with no business record. They are not lost and nothing about them
changes; they simply have no row in the queue. Create the missing records with:

```bash
cd backend
python -m scripts.backfill_partners              # dry run — writes nothing
python -m scripts.backfill_partners --confirm    # write them
```

It is safe to run at any time and safe to run twice: a partner that already has
a record is skipped entirely, including its balances and its status. Everything
it creates is created **pending** — a backfill creates a record, it does not make
an onboarding decision — and anything Firestore already calls approved is listed
at the end as a mismatch for a person to resolve in the CRM, where the decision
gets a reason and an audit entry.

### 10.9 If you skip this section entirely

Every part of the CRM works except the one thing onboarding is for. Applicants
register, receive their acknowledgement email, hold a pending login and see the
holding page — and appear on no staff screen, so nobody can approve them, and
they cannot be funded, lent to or paid. The only way to bring them into the
queue is § 10.8, run by hand, by somebody who knows to. That is the bug this
section exists to end.

---

## 11. Email deliverability — getting out of the spam folder

Everything Zipper sends currently lands in spam. That is two problems wearing
one coat, and only one of them is code.

**The code half is done.** Every message now carries a plain-text alternative
beside the HTML, scheduled reports carry `List-Unsubscribe` and — once § 11.6 is
configured — `List-Unsubscribe-Post`, mail leaves from three separate sender
identities instead of one, `Reply-To` points at a mailbox a human reads, and no
subject line in the catalogue shouts in capitals. Nothing below asks you to
change any of that.

**The DNS half is yours and only yours**, because it is published against a
domain and a domain is a thing you own. Do § 11.1 to § 11.5 in order. Until
§ 11.1 is done, **nothing else on this list will help**, and that is not a
figure of speech — see § 11.0 for why.

### 11.0 Why a Gmail sender is always treated as spam (history)

*Historical — kept for the reasoning. Production now sends from
`no-reply@zipperlive.org` on an authenticated domain (§ 11.7).*

The backend was once deployed with a personal Gmail address as `MAIL_FROM` (§ 4).
Every report, alert and receipt therefore says it is *from* a Gmail address, and
is *sent by* SendGrid. A receiving mail server checks three things:

| Check | What it asks | What happens today |
|---|---|---|
| **SPF** | did the IP that sent this appear in the sending domain's DNS as permitted? | `gmail.com`'s SPF record lists Google's servers. It does not list SendGrid's, and never will. **Fail.** |
| **DKIM** | is this message signed with a key published in the sending domain's DNS? | The signature would have to verify against a key in `gmail.com`'s DNS. Only Google can publish there. **Fail, or unaligned.** |
| **DMARC** | do the domains that SPF and DKIM authenticated *match* the domain in the visible From? | `gmail.com` publishes `p=none`, so you are not hard-rejected — you are quietly filed as suspicious, every time. **Unaligned.** |

There is no setting, no SendGrid feature, no header and no amount of good
wording that fixes this. **You cannot publish DNS records for a domain you do
not control**, and you do not control `gmail.com`. Sending as a Gmail address
through a third-party provider is, structurally, indistinguishable from someone
forging your Gmail address — which is exactly what the checks exist to catch.

Gmail and Yahoo both tightened this in February 2024: bulk senders must
authenticate their domain, must publish DMARC, must keep spam complaints under
0.3%, and must offer one-click unsubscribe. A Gmail From cannot satisfy the
first two on any terms.

**The only fix is a domain you own.** One domain, one DNS zone, once. Everything
else in this section depends on it.

### 11.1 Buy a domain and decide the sending subdomain

1. Buy a domain. Anything you control — `zipper.in`, `zipperapp.com`. Roughly
   ₹800–₹1,200/year. Registrar does not matter; access to its DNS panel does.
2. Decide the **sending subdomain**: `mail.<yourdomain>`. Use a subdomain, not
   the bare domain. A reputation problem on automated mail then cannot damage
   the domain you send hand-written mail from, and you can throw the subdomain
   away and start again without abandoning the brand.
3. From here, `<yourdomain>` means the domain you just bought and
   `mail.<yourdomain>` means that subdomain.

Do **not** change `MAIL_FROM` yet. Change it in § 11.5, after authentication
verifies — an unverified sender is a hard 403 from SendGrid and stops all mail
dead, and `/tech/email` will say so in the Cause column.

### 11.2 SendGrid domain authentication — the CNAMEs

This is the step that gives you aligned DKIM, and it is the single highest-value
thing on this page.

1. SendGrid → **Settings → Sender Authentication → Authenticate Your Domain**.
2. DNS host: whoever runs your DNS. Domain: `<yourdomain>`.
3. **Advanced settings → "Use a custom return path"** → set the subdomain to
   `mail`. Also switch on **automated security** (SendGrid rotates the DKIM keys
   for you).
4. SendGrid gives you **three CNAME records**. They look like this — *yours will
   have different numbers, use yours*:

   | Type | Host | Value |
   |---|---|---|
   | CNAME | `em1234.<yourdomain>` | `u1234567.wl.sendgrid.net` |
   | CNAME | `s1._domainkey.<yourdomain>` | `s1.domainkey.u1234567.wl.sendgrid.net` |
   | CNAME | `s2._domainkey.<yourdomain>` | `s2.domainkey.u1234567.wl.sendgrid.net` |

5. Publish all three in your registrar's DNS panel. If the panel appends the
   domain automatically, enter only the host part (`em1234`, `s1._domainkey`,
   `s2._domainkey`) — a doubled domain (`em1234.<yourdomain>.<yourdomain>`) is
   the most common mistake here.
6. Wait for propagation — usually minutes, up to 48 hours — then click
   **Verify** in SendGrid. Do not proceed until all three show verified.
7. Check it yourself, independently of SendGrid's own screen:

   ```bash
   dig +short CNAME em1234.<yourdomain>
   dig +short CNAME s1._domainkey.<yourdomain>
   dig +short CNAME s2._domainkey.<yourdomain>
   ```

**What this buys you.** The `s1`/`s2` records let SendGrid sign every message
with a DKIM key that a receiver looks up *in your DNS*. The signature therefore
authenticates `<yourdomain>` — the same domain as your visible From — which is
what "alignment" means and what DMARC actually checks. The `em1234` record makes
SendGrid's bounce path (`Return-Path`) also read `<yourdomain>`, which aligns
SPF as well, so the visible From and the envelope sender stop disagreeing.

It also fixes the `Message-ID`. SendGrid generates one per message using the
return-path domain, so today every Zipper email is stamped with a
`@sendgrid.net`-style identifier that has nothing to do with the From — one more
inconsistency a filter scores. With the custom return path set, the `Message-ID`
domain becomes `<yourdomain>` and stays that way for every message, which is
what threading, deduplication and reputation tracking all key on.

### 11.3 SPF

The custom return path in § 11.2 handles SPF alignment for you. Publish a record
anyway on the sending subdomain, so anyone checking gets a definitive answer
rather than a missing one:

| Type | Host | Value | TTL |
|---|---|---|---|
| TXT | `mail.<yourdomain>` | `v=spf1 include:sendgrid.net ~all` | 3600 |

Rules, and they matter:

* **One SPF record per host.** Two `v=spf1` records is a permanent error and is
  worse than none. If a record already exists, edit it — add
  `include:sendgrid.net` to the existing one.
* **Ten lookups maximum.** Each `include:` costs one. `include:sendgrid.net` is
  one. Stay well under.
* Use `~all` (softfail) to begin with, not `-all`. Move to `-all` only after
  § 11.4's reports show nothing legitimate failing.

Verify: `dig +short TXT mail.<yourdomain>`

### 11.4 DMARC — start at `p=none`, with reporting

Publish this on the **bare domain**, not the subdomain. DMARC is inherited by
subdomains.

| Type | Host | Value | TTL |
|---|---|---|---|
| TXT | `_dmarc.<yourdomain>` | `v=DMARC1; p=none; rua=mailto:dmarc@<yourdomain>; ruf=mailto:dmarc@<yourdomain>; fo=1; adkim=r; aspf=r; pct=100` | 3600 |

Read it left to right:

* `p=none` — **monitor only**. Nothing is rejected. This is deliberately the
  starting point: publish an enforcing policy before you know what you send and
  you will silently destroy your own mail.
* `rua=` — where the daily aggregate reports go. Make `dmarc@<yourdomain>` a
  real mailbox or an alias to one you read. Reports are XML; paste one into any
  free DMARC report viewer.
* `fo=1` — send a failure report when *either* SPF or DKIM fails, not only when
  both do. This is what tells you about a partial misconfiguration.
* `adkim=r` / `aspf=r` — relaxed alignment: a subdomain counts as the domain.
  Required, because you send from `mail.<yourdomain>` and your From reads
  `<yourdomain>`.

**Moving to enforcement — do not skip the wait.**

1. Leave `p=none` for **at least two weeks** of normal sending.
2. Read the `rua` reports. Every source sending as your domain must show `pass`
   for DKIM *and* alignment. Expect to find things you forgot — a form on the
   website, a helpdesk tool, your accountant's invoicing software.
3. When everything legitimate passes, move to quarantine gradually:
   `p=quarantine; pct=25` → wait a week → `pct=50` → `pct=100`.
4. Only after a clean month at `p=quarantine; pct=100`, consider `p=reject`.
5. Never jump straight to `p=reject`. It is not caution, it is arithmetic: any
   sender you forgot has its mail deleted, silently, at the receiver.

Verify: `dig +short TXT _dmarc.<yourdomain>`

### 11.5 Point the backend at the new domain

Only now change the addresses. Three identities, all on the authenticated
domain, so one DKIM key aligns all of them:

```bash
# QA #47 (owner decision, 3 Nov 2026): exactly three addresses on zipperlive.org.
# Do not add others (notifications@, reports@, unsubscribe@ … were examples in
# earlier versions of this guide and are NOT Zipper addresses).
gcloud run services update zipper-api --region asia-south1 \
  --update-env-vars "\
MAIL_FROM=no-reply@zipperlive.org,\
MAIL_FROM_NAME=Zipper,\
CONTACT_SUPPORT_EMAIL=support@zipperlive.org,\
CONTACT_INFO_EMAIL=info@zipperlive.org,\
UNSUBSCRIBE_EMAIL=support@zipperlive.org"
```

*Not run by the QA fix round — the Owner decides when production changes.*

What each one is for:

| Variable | Address | Carries |
|---|---|---|
| `MAIL_FROM` | `no-reply@zipperlive.org` | The SENDER of every automated message — OTPs, verification, password resets, security and system notices, receipts, reports. No `Reply-To` is ever set. |
| `CONTACT_SUPPORT_EMAIL` | `support@zipperlive.org` | Where every email, notice, CRM page and app screen tells a person to write for help (appeals, privacy requests, a figure they question). Never a sender of automated mail. |
| `CONTACT_INFO_EMAIL` | `info@zipperlive.org` | General business information. Never a sender of automated mail. |
| `UNSUBSCRIBE_EMAIL` | `support@zipperlive.org` | The `mailto:` in `List-Unsubscribe`. Must accept mail — Gmail checks that it does not hard-bounce. |

`EMAIL_IDENTITY_INFO_ENABLED` / `EMAIL_IDENTITY_SUPPORT_ENABLED` stay **false**:
automated mail must not appear to come from `info@` or `support@`.
`MAIL_FROM_TRANSACTIONAL`, `MAIL_FROM_BULK` and `MAIL_FROM_SUPPORT` stay unset.

`support@` and `info@` must be **real, monitored mailboxes** before they are
published — see § 11.8: on 3 Nov 2026 `zipperlive.org` had no MX record, so
neither could receive mail yet.

Then confirm from the CRM: `/tech/email` → the Cause column is empty on new
sends, and a delivery row's `sender.aligned` reads `true`. It reads `false` with
a written reason for as long as you are sending as `@gmail.com`, which is the
check that tells you this section actually landed.

### 11.6 One-click unsubscribe (optional, needed above ~5,000 messages/day)

`List-Unsubscribe` is always sent on report mail. The RFC 8058 **one-click POST**
header is only advertised when an endpoint exists to answer it, because a
one-click promise nobody honours damages a domain more than no promise at all.
To switch it on:

```bash
gcloud run services update zipper-api --region asia-south1 \
  --update-env-vars "UNSUBSCRIBE_URL=https://<your api host>/api/notifications/unsubscribe"
```

The route is token-authenticated: the link in each email carries an HMAC over
that one address and that one report, so forwarding the email gives nobody power
over anyone else's subscription. It can mute a scheduled report and nothing
else — it cannot silence an alert (8A.4: an exception is not switchable off) and
it cannot stop a partner's own statement.

### 11.8 zipperlive.org — what DNS said on 3 Nov 2026, and what is still needed

Read from public DNS (Google DNS-over-HTTPS) during the QA fix round. Nothing
was changed; DNS and SendGrid are the Owner's.

| Record | Found | Status |
|---|---|---|
| DKIM `s1._domainkey` / `s2._domainkey` | CNAME → `s1/s2.domainkey.u110246415.wl166.sendgrid.net` | ✓ SendGrid domain authentication is in place (DKIM passed on the controlled send of 1 Nov) |
| SPF | no TXT at the root; SendGrid's return-path subdomain carries it | ✓ for SendGrid mail (SPF passed on the controlled send). Add a root SPF record only when another service (a mailbox host) sends as `@zipperlive.org`, and then include that service. |
| DMARC `_dmarc` | `v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net` | ✓ present (the registrar's default reporting address). Optional: send aggregate reports to a mailbox you read. |
| MX | **none** | ✗ **Nothing at `@zipperlive.org` can receive mail** — `support@` and `info@` (published in the app, the CRM, emails and the privacy policy) bounce until a mailbox or forwarding is set up at the registrar or a mail host. |

Still required, in this order (all Owner actions; none were done in the fix round):

1. Create mailboxes or forwarding for `support@zipperlive.org` and `info@zipperlive.org` (registrar email forwarding or a mail host), which publishes the MX records. Then add that host to a root SPF record if it sends mail.
2. Confirm SendGrid → Settings → Sender Authentication still shows `zipperlive.org` **verified**. The From is `no-reply@zipperlive.org`; with domain authentication no single-sender verification is needed for it.
3. Set the production env to the values in § 11.5 (`UNSUBSCRIBE_EMAIL=support@zipperlive.org`, `CONTACT_*`), and leave the two identity switches off.
4. Send one controlled test to an address you own (never a real user) and check `Authentication-Results`: `spf=pass`, `dkim=pass header.d=zipperlive.org`, `dmarc=pass`.

### 11.7 Warm-up — and the thing that actually kills a domain

A brand-new sending domain has no reputation. Sending 500 messages on its first
day looks exactly like a compromised account, because that is what a compromised
account does.

Ramp over two weeks, roughly doubling, and stay flat if complaints or bounces
rise:

| Day | Cap |
|---|---|
| 1–2 | 50/day |
| 3–4 | 100/day |
| 5–7 | 250/day |
| 8–10 | 500/day |
| 11–14 | 1,000/day |
| 15+ | normal volume |

Zipper's own volume is small — a handful of owners and a few hundred partners —
so in practice you are already inside this. The ramp matters if you ever mail
every registered user at once. Do not.

**What actually destroys a domain's reputation is not volume — it is sending to
people who never open.** Gmail's filter is largely an engagement model. A
hundred messages a day to people who read them builds reputation; a hundred to
addresses that never open teaches Gmail that mail from your domain is ignorable,
and it starts filing *all* of it — including the payout receipt somebody is
waiting for — in spam.

So, concretely:

1. **Never send to an address you have not verified.** A typo'd signup address
   bounces, and bounce rate is scored directly.
2. **Act on bounces.** They already arrive: SendGrid's Event Webhook feeds
   `POST /api/notifications/provider-events` and `/tech/email` shows every
   `bounced` and `dropped` row with the mailbox's own reason. A hard bounce
   means fix or remove the address on the partner record — the same address
   bouncing weekly is a standing negative signal.
3. **Watch spam complaints.** SendGrid → Statistics. Above **0.3%** Gmail
   starts filtering wholesale; above 0.1% you should already be looking. A
   `spam_report` row on `/tech/email` names the recipient.
4. **Turn off reports nobody reads.** `POST /api/notifications/subscriptions`
   with `muted: true` (§ 9). A daily report to somebody who has not opened one
   in a month is actively costing you deliverability on the mail that matters.
5. **Keep the list to people who asked.** Owners, staff, and partners who
   registered. Never a bought or scraped list — one such send can cost a domain
   permanently, and § 11.1 is not free to redo.

### 11.8 If you skip this section entirely

Mail is delivered to SendGrid and filed as spam by the recipient. Every delivery
row reads `sent`, because it was — SendGrid accepted it. Nobody sees any of it.
The daily summary, the exception report, the payout receipt an agency is waiting
on and the approval email a new partner needs are all in a folder nobody opens,
and there is no failure anywhere to look at, because at the protocol level
nothing failed. `/tech/email` will show `sender.aligned: false` with the reason
written out on every row, which is the only warning you get.

---

## Full deploy, in order

```bash
# 1. the THREE service credentials — once, before the first backend deploy.
#    Three different values. Never generate one and use it for two.
#    (§ 8.1, § 9.2, § 10.1)
cd backend
python3 -m scripts.generate_service_key --quiet \
  | gcloud secrets create SERVICE_KEY_WEEKLY_ACCRUAL --data-file=-
python3 -m scripts.generate_service_key --credential reporting --quiet \
  | gcloud secrets create SERVICE_KEY_REPORTING --data-file=-
python3 -m scripts.generate_service_key --credential partner-registration --quiet \
  | gcloud secrets create SERVICE_KEY_PARTNER_REGISTRATION --data-file=-

PROJECT_NUMBER=$(gcloud projects describe zipper-83816 --format='value(projectNumber)')
for S in SERVICE_KEY_WEEKLY_ACCRUAL SERVICE_KEY_REPORTING \
         SERVICE_KEY_PARTNER_REGISTRATION; do
  gcloud secrets add-iam-policy-binding $S \
    --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done

# 2. backend — all three keys in --set-secrets, and the business clock
#    (§ 4, § 9.4, § 10.3)
gcloud run deploy zipper-api --source . --region asia-south1 [flags as in § 4]

# 3. the same three values to the Functions runtime (§ 8.4, § 9.5, § 10.4)
cd ..
gcloud secrets versions access latest --secret=SERVICE_KEY_WEEKLY_ACCRUAL \
  | firebase functions:secrets:set ZIPPER_ACCRUAL_KEY --data-file=-
gcloud secrets versions access latest --secret=SERVICE_KEY_REPORTING \
  | firebase functions:secrets:set ZIPPER_REPORTING_KEY --data-file=-
gcloud secrets versions access latest --secret=SERVICE_KEY_PARTNER_REGISTRATION \
  | firebase functions:secrets:set ZIPPER_PARTNER_REGISTRATION_KEY --data-file=-

# 4. functions — this is what creates the Cloud Scheduler jobs, and what makes
#    a new agency or seller appear for approval at all (§ 10)
cd functions && npm run build && cd ..
firebase deploy --only functions

# 5. rules and indexes
firebase deploy --only firestore:rules,firestore:indexes

# 6. CRM
cd zipper-crm && npm run build && cd ..
firebase deploy --only hosting
```

Steps 1 and 3 are once, not every deploy. Steps 2 and 4 must both happen after
step 1, and step 4 after step 3.

Confirm step 4 actually scheduled anything — a functions deploy that compiled
and shipped nothing looks identical to one that worked:

```bash
gcloud scheduler jobs list --location=us-central1 \
  --format='table(name, schedule, timeZone, state)'
```

Eight jobs, all `ENABLED`:

| | Schedule | Zone |
|---|---|---|
| `scheduledTransactionalSweep` | `*/15 * * * *` | Asia/Kolkata |
| `scheduledAlertScan` | `*/30 * * * *` | Asia/Kolkata |
| `scheduledDailyReports` | `0 7 * * *` | Asia/Kolkata |
| `scheduledWeeklyBusinessReport` | `30 7 * * 1` | Asia/Kolkata |
| `scheduledPartnerStatements` | `0 9 * * 1` | Asia/Kolkata |
| `scheduledMonthlyReports` | `0 8 1 * *` | Asia/Kolkata |
| `weeklyPayoutReportGenerator` (§ 8) | `29 18 * * 0` | UTC |
| `dailyPlatformStatsAggregator` | `0 0 * * *` | UTC |

The last two are pre-existing and are deliberately left on UTC: the accrual runs
on ISO weeks, which end at 00:00 UTC, and the stats aggregator writes a UTC-day
Firestore document. Everything in § 9 is on the owner's clock because everything
in § 9 is read by a person.

---

## Checks after deploying

```bash
curl https://zipper.web.app/api/health
```

Then in the browser:

1. Owner signs in with email and password → lands on the sign-off queue.
2. Observer requests a code at `/observer` → code arrives at
   `soumyars675@gmail.com` → signs in → sees everything, no action buttons.
3. Any money action writes an audit entry with a real name, not "Admin".

And the unattended path, which nothing in the browser exercises:

4. § 8.7's preview call returns `200`.
5. After the first Sunday run, `weeklyPayoutReports/<week>` has
   `commissionAccrual.status: "completed"` and every `agencySummaries[]` entry
   has a `commissionOutcome` other than `pending` or `not_attempted`. The
   report's own `status` field is untouched by the accrual — that is its
   approval lifecycle and still reads `generated` until someone submits it.
6. `/audit` shows the accruals under **Weekly accrual (automated)**, role
   `system` — never under a person's name.

And the scheduled reports and alerts, which also exercise nothing in the browser:

7. § 9.7's `POST /api/notifications/jobs/alerts` with the reporting key returns
   `200`.
8. Within half an hour of deploying, `GET /api/notifications/runs/last` shows
   `alerts` and `transactional-sweep` with a `last_run_at` and a status. Any job
   still reading `never` after its first scheduled time has not fired — check
   `gcloud scheduler jobs list` before assuming the business had a quiet day.
9. The morning after, the daily business summary is in the owners' inboxes with
   a subject naming **yesterday's** date, and its stated period reads
   `00:00` to `00:00` of the following day in IST. If it reads 05:30, the
   backend is not picking up `REPORT_TIMEZONE` — § 9.4.
10. `GET /api/notifications/deliveries?kind=report.daily_business_summary`
    shows one row per recipient with outcome `sent`. A `no_address` or
    `withheld` row names the account and the reason.

And onboarding, which is the one path a real person walks through first:

11. Register a coin seller at `/seller-signup`. Within seconds they are on
    `/kyc` under Coin sellers, `pending` — § 10.6. If they are not, § 10 is not
    deployed and every applicant since is invisible; run § 10.8.
12. `/audit` shows their `partner.created` entry under **Partner registration
    (automated)**, role `system`.
13. None of `/kyc`, `/agencies` or `/sellers` shows the red *"never reached the
    queue"* panel. If one does, it names the applicants and the reason, and the
    button on it creates the record — § 10.7.
14. The seller receives the "Application received" email whether they signed up
    themselves or ops registered them on `/sellers/register`, and the "You're
    approved" email when approved. Both used to be sent only for self-signups.

---

## Costs to expect

| | |
|---|---|
| Cloud Run | Scales to zero. Near nothing until you have traffic. |
| MongoDB Atlas | Free M0 to start; ~$57/month for M10 when you outgrow it. |
| Firebase Hosting | Free tier covers early usage. |
| SendGrid | Free tier is 100 emails/day; paid from there. |
| Blaze plan | Pay-as-you-go, required for multiple Hosting sites and Cloud Run. |

---

# Appendix A — Every setting

Everything above deploys the system. This appendix is the reference: all ninety
settings in `backend/app/config.py`, plus the four that are read from the
environment without passing through it, with what each one actually does and
whether production is wrong without it.

Nothing here changes the sections above — none of these settings has to be set
for a deploy to succeed, because every one of them has a default. That is
exactly why they need writing down: a tunable nobody can find is a tunable
nobody tunes, and several of these change how money behaves.

**Where the names come from.** The API's settings are the fields of
`Settings` in `backend/app/config.py`, read by `pydantic-settings`. The
environment variable is the field name in upper case — `mail_from` is
`MAIL_FROM` — and they are set on the Cloud Run service (`--set-env-vars` or
`--set-secrets`). Four do not come through `Settings` at all. Three are marked
**(Functions)** — set in `functions/.env`, read from `process.env` by
`functions/src/index.ts`, and invisible to the API entirely. The fourth,
`CHANCE_SIGNING_KEYS`, is read straight from the API's own process environment
by `services/chance.py`, which is why grepping `config.py` for it finds nothing.
Anything unrecognised is ignored (`extra="ignore"`), so a misspelt variable
does not fail a deploy — it silently does nothing, which is the failure mode
this appendix exists to make findable.

### Legend

| | |
|---|---|
| **Must-set** | Production is wrong, unsafe or pointing at somebody else's infrastructure until you set it. |
| Tunable | The default is a deliberate working choice. Change it when you have a reason, not on principle. |
| ⚠ **Silent** | The default is valid and nothing errors — and a whole feature simply never happens. Nothing on any screen says so. These are listed together in § A.11. |
| *(inert)* | Declared in `config.py` and read by nothing. Setting it has no effect at all. |

---

## A.1 Session and auth

`backend/app/core/security.py` reads all of these.

| Variable | Default | What it does | Class |
|---|---|---|---|
| `JWT_SECRET` | `change-me` | Signs and verifies every session token. The shipped default is a public string, so a deployment that keeps it will accept a token anybody can mint — it is the single most important value in this file. It is **also** the HMAC key behind one-click unsubscribe links (`email.unsubscribe_token`), so rotating it ends every live session *and* invalidates the unsubscribe link in every email already delivered. § 3 mints it. | **Must-set** |
| `JWT_ISSUER` | `zipper-api` | Written as the `iss` claim and verified on every decode. Changing it on a running deployment invalidates every token already issued — everyone signs in again. | Tunable |
| `SESSION_TTL_MINUTES` | `10080` (7 days) | How long a staff session token is honoured. Paired with `SESSION_RENEW_BEFORE_MINUTES` below, an active user never reaches it: renewal rotates the token, revokes the one it replaced, and re-reads the account from Mongo. Shortening it is the lever if a laptop goes missing. | Tunable |
| `OBSERVER_SESSION_TTL_MINUTES` | `720` (12 h) | The observer's session, deliberately *not* the figure above. The observer signs in with a one-time code to a second mailbox and `renew_session` refuses to renew them, so a long window here would turn a one-time code into a standing credential. | Tunable |
| `SESSION_RENEWAL_GRACE_MINUTES` | `4320` (3 days) | How long after `exp` a token may still be renewed silently. Inside it the CRM renews without a word; outside it the person signs in again. It also sets how long the session *record* outlives its token — `issue_session` reaps at `exp` plus this, so the revocation flag is still readable during the grace period. | Tunable |
| `SESSION_RENEW_BEFORE_MINUTES` | `1440` (1 day) | When the browser should renew. Served on every session response as `renew_at`, so the CRM holds no second copy of this number. The effective lead is `min(this, max(ttl / 2, 1))`, so shortening the TTL pulls the renewal in with it automatically. | Tunable |
| `OBSERVER_EMAIL` | `314zipper@gmail.com` | The observer account's own address — the identity the read-only role signs in as. The default is one specific person's personal mailbox. | **Must-set** |
| `OBSERVER_OTP_DELIVERY_EMAIL` | `soumyars675@gmail.com` | Where the observer's sign-in code is delivered, deliberately a *different* mailbox from the account address, so possession of the account address is not possession of the account. Also a specific personal mailbox by default. | **Must-set** |
| `OTP_TTL_MINUTES` | `10` | How long an observer sign-in code stays valid. Also the figure quoted back to the requester and printed in the code email. | Tunable |
| `OTP_MAX_ATTEMPTS` | `5` | Wrong codes allowed against one issued code before it is burned. The response counts down the remainder. | Tunable |
| `OTP_RESEND_COOLDOWN_SECONDS` | `60` | Minimum gap between two code requests. The refusal quotes this number. | Tunable |

---

## A.2 Email and deliverability

Read by `backend/app/services/email.py`. § 11 is the narrative version of this
group; this is the complete list.

| Variable | Default | What it does | Class |
|---|---|---|---|
| `SENDGRID_API_KEY` | *(empty)* | The provider credential. Empty is **not** silent: every send is still recorded, with outcome `not_configured` and the sentence "SENDGRID_API_KEY is not set in this environment, so nothing was delivered", visible on `/tech/email`. Nothing reaches a recipient. § 3 mints it. | **Must-set** |
| `MAIL_FROM` | `no-reply@zipperlive.org` | The SENDER of every automated message (QA #47, owner decision 3 Nov 2026). On the SendGrid-authenticated domain, so SPF and DKIM align. Never a contact address. | **Must-set** |
| `MAIL_FROM_NAME` | `Zipper` | Display name paired with `MAIL_FROM`, and the fallback for the two per-stream display names. | Tunable |
| `PORTAL_URL` | `https://zipper.web.app` | The link target in partner and staff mail — the "Open your portal" and "Set your password" buttons, and the base of the report-definitions URL. **No figure is derived from it; it is a link and nothing else.** The default does not match the Hosting site this repo actually deploys to — `.firebaserc` targets `zipperlive` and every command in this document uses `https://zipperlive.web.app` — and the § 4 deploy command does not set it. Until you do, every button in every email points at a host that is not yours. | **Must-set** |
| `SUPPORT_EMAIL` | *(empty)* | Legacy. Only used as the From of the `support` identity if `EMAIL_IDENTITY_SUPPORT_ENABLED` were switched on — it stays off (automated mail never leaves from support@). Not a Reply-To: none is ever set. | Leave unset |
| `CONTACT_SUPPORT_EMAIL` | `support@zipperlive.org` | QA #47: where every email footer, notice, CRM page and app screen tells a person to write for help. An override not on the official domain is ignored (`app/core/contacts.py`). | Tunable |
| `CONTACT_INFO_EMAIL` | `info@zipperlive.org` | QA #47: general business information. Same rule. | Tunable |
| `OFFICIAL_EMAIL_DOMAIN` | `zipperlive.org` | QA #47: the domain the contact overrides must be on. | Do not change |
| `MAIL_FROM_TRANSACTIONAL` | *(empty)* | From address for a person's own event — approval, receipt, invitation, sign-in code. Empty falls back to `MAIL_FROM` — and if `MAIL_FROM_BULK` is empty too, both streams collapse onto that one address and a reputation problem on the reports can hold up a payout receipt. Must be on the same authenticated domain as `MAIL_FROM` or SPF/DKIM do not align; `email.sender_alignment()` checks this at send time and records the answer on the delivery row rather than leaving it to be guessed from a spam folder. | Tunable |
| `MAIL_FROM_NAME_TRANSACTIONAL` | *(empty)* | Display name for that stream. Falls back to `MAIL_FROM_NAME`. | Tunable |
| `MAIL_FROM_BULK` | *(empty)* | ⚠ From address for scheduled reports, alerts and every composed broadcast to more than one person — `broadcast.identity_for` forces the bulk identity on any multi-recipient send and tells the sender it did. Empty falls back to `MAIL_FROM`, so the stream keeps no address of its own and, if `MAIL_FROM_TRANSACTIONAL` is also unset, receipts and mailshots leave from one address and share one complaint rate. See § A.11. | ⚠ **Silent** |
| `MAIL_FROM_NAME_BULK` | *(empty)* | Display name for the bulk stream. Falls back to `MAIL_FROM_NAME`. | Tunable |
| `MAIL_FROM_SUPPORT` | *(empty)* | Legacy: the From of the `support` identity when its switch is on (it stays off). Never a `Reply-To` — none is ever set. | Leave unset |
| `UNSUBSCRIBE_EMAIL` | *(empty)* | The mailbox the `mailto:` in `List-Unsubscribe` points at. Empty falls back to `CONTACT_SUPPORT_EMAIL` (QA #47 — it used to derive `unsubscribe@<domain>`, an address nobody created). Set it to `support@zipperlive.org`, and make sure that mailbox receives mail (§ 11.8). | **Must-set** |
| `UNSUBSCRIBE_URL` | *(empty)* | ⚠ The RFC 8058 one-click endpoint. `List-Unsubscribe-Post` is emitted only when this is set — see § A.11. Set it to `https://<api host>/api/notifications/unsubscribe`; the route exists and is token-authenticated. | ⚠ **Silent** |
| `EMAIL_TIMEOUT_SECONDS` | `20` | How long the SendGrid client waits. A timeout is recorded as a failed delivery rather than left hanging. | Tunable |
| `EMAIL_MAX_ATTACHMENT_BYTES` | `5000000` | Per-file ceiling. A report CSV over it is omitted from the message with a stated reason and the mail tells the reader to fetch the whole table from the portal with `?format=csv`. | Tunable |
| `EMAIL_MAX_TOTAL_ATTACHMENT_BYTES` | `20000000` | Ceiling on all attachments of one message, base64 included. SendGrid's documented hard limit is ~30 MB for the whole request; this leaves room for the body and headers. Files past it are omitted, earlier ones kept, and the omission is named in the mail. | Tunable |
| `EMAIL_REPORT_PREVIEW_ROWS` | `12` | How many rows of a report appear in the email body. The attached CSV is always the full table — the body is a preview, never a second version. **`0` removes the in-body table entirely** and leaves only the CSV. | Tunable |
| `SG_MAIL_KEY` **(Functions)** | *(empty)* | ⚠ The SendGrid key used by `functions/src/index.ts` for the Firestore-triggered emails, which is a **separate** credential and a separate code path from the API's. Unset, `sendMail()` logs an error and returns — the recipient gets nothing and no delivery row is written anywhere. Note also that this path's From address is hardcoded in `index.ts`, so § 11's domain work does not apply to it. | ⚠ **Silent** |

---

## A.3 Alerts

Read by `backend/app/services/alerts.py`. Every threshold in that module is one
of these — nobody edits Python to retune an alert. Each detector prints the
setting name and its current value in the mail it sends, so a recipient can see
which knob produced what they are reading.

| Variable | Default | What it does | Class |
|---|---|---|---|
| `ALERT_LARGE_AMOUNT_INR` | `100000` | 8A.4.4 — a card at or above this, still unsigned, emails the owners. Stated in **whole rupees** because that is how an owner thinks about it; converted to paise once, inside `alerts.py`. Compared only against cards in the `commission` currency: a coin count is not a rupee figure and is not compared to one. | Tunable |
| `ALERT_AWAITING_SIGNATURE_HOURS` | `72` | *(inert)* — declared here, described as "a card verified and waiting on a signature this long", and **read by nothing**. The large-card detector fires on amount with no age condition, and queue ageing uses the two settings below. Setting it changes no behaviour. | *(inert)* |
| `ALERT_SIGNED_NOT_EXECUTED_HOURS` | `24` | 8A.4.5 — signed, authorised, and the money still has not moved. One alert per card past this age. | Tunable |
| `ALERT_QUEUE_AGE_HOURS` | `48` | 8A.4.7 — an open queue item older than this breaches its ageing limit and goes to the team admin. | Tunable |
| `ALERT_QUEUE_ESCALATE_HOURS` | `96` | …and past this it stops being the team's problem and becomes the owners'. | Tunable |
| `ALERT_FAILED_LOGIN_THRESHOLD` | `5` | 8A.4.9 — this many failed sign-ins on one staff account inside the window below. | Tunable |
| `ALERT_FAILED_LOGIN_WINDOW_MINUTES` | `60` | The window that count is measured over. | Tunable |
| `ALERT_DUPLICATE_REF_LOOKBACK_DAYS` | `90` | 8A.4.3 — how far back the duplicate-payment-reference sweep looks. The same UTR on two cards is the signal. | Tunable |
| `ALERT_SETTLEMENT_TOLERANCE_MINOR` | `100` (₹1) | 8A.4.6 — how far a gateway settlement may differ from the recorded receipt, **in paise**, before it is a mismatch. Rounding at the aggregator is real; a rupee is not. | Tunable |
| `ALERT_RATE_STALE_HOURS` | `48` | 8A.4.2 — the economy rate feed is stale after this long without a change. | Tunable |
| `ALERT_DELIVERY_FAILURE_LOOKBACK_HOURS` | `24` | 8A.2.15 — how far back the failed-email sweep looks. This is the alert that tells you `SENDGRID_API_KEY` is unset. | Tunable |
| `CREDIT_DUE_NOTICE_DAYS` | `3` | 8A.2.10, in `services/scheduling.py::_sweep_credit_due` rather than `alerts.py` — it is a notice to the seller, not an alert to us. It is the whole width of the sweep window: sellers whose credit falls due inside `[now, now + this]` are emailed. **This is partner money**: raising it warns sellers earlier, and `0` collapses the window to nothing, so the first a seller hears is that they are already overdue. | Tunable |
| `CREDIT_OVERDUE_REPEAT_HOURS` | `72` | 8A.2.11 — how often an already-overdue seller is reminded, and separately how often Finance is. An overdue debt is a standing condition rather than an event, so the seller mail carries no dedupe key and the cadence is enforced by the same suppression state the alerts use. Not one per sweep. | Tunable |
| `ALERT_REPEAT_HOURS` | `24` | Repeat suppression. The same condition, still true, does not email again inside this window. 8A.1.4 — mail that becomes noise gets ignored, and then a real alert gets ignored with it. | Tunable |
| `ALERT_SCAN_MAX_LOOKBACK_HOURS` | `72` | A scan asked to cover "since the last run" never looks further back than this, so a job that has been off for a month does not wake up and send a month of history at once. | Tunable |

---

## A.4 Reports and scheduling

| Variable | Default | What it does | Class |
|---|---|---|---|
| `REPORT_TIMEZONE` | `Asia/Kolkata` | Which calendar day a "daily" report covers. The ledger is stored in UTC and every window in `reports.py` is UTC, which is right for arithmetic and wrong for a report — "yesterday" read at breakfast in Mumbai means the day that ended where the reader is, not `[00:00 UTC, 24:00 UTC)`. Only `services/scheduling.py` reads it, and only to resolve period boundaries and the labels printed on them: **no figure is computed from it**, and the on-demand `/api/reports/*` endpoints are untouched, because a caller who passes explicit `since`/`until` means what they passed. An unrecognised zone name makes `scheduling.business_tz()` refuse rather than guess. Also read by `player_protection.py` for the same purpose. Set in § 9.4. | Tunable |

The three settings that shape report *email* — `EMAIL_REPORT_PREVIEW_ROWS`,
`EMAIL_MAX_ATTACHMENT_BYTES`, `EMAIL_MAX_TOTAL_ATTACHMENT_BYTES` — are in § A.2
with the rest of the mail settings.

---

## A.5 Broadcasts

Read by `backend/app/services/broadcast.py` and `routers/broadcasts.py`. Every
other email this system sends is generated from a record; a broadcast is the one
a person types, and its blast radius is the whole customer base. These are less
tuning knobs than the shape of what one click is allowed to do.

| Variable | Default | What it does | Class |
|---|---|---|---|
| `BROADCAST_MAX_RECIPIENTS` | `2000` | The most recipients one composed send may reach. A larger audience is **refused, not truncated** — half a broadcast is worse than none, because nobody outside can tell which half arrived. The number is arithmetic: `deliver_many` sends serially inside the HTTP request that asked for it, so at ~200 ms a message across `BROADCAST_CONCURRENCY` lanes, 2,000 recipients is roughly 50 s, inside Cloud Run's 300 s request timeout with room to spare. **Raising this without moving the send to a queue is how a broadcast ends up half-delivered by a timeout.** | Tunable |
| `BROADCAST_CONFIRM_ABOVE` | `25` | Above this many resolved recipients the request must echo the exact count back before anything is sent. The count is the last chance to notice the audience is wrong. | Tunable |
| `BROADCAST_BATCH_SIZE` | `25` | Messages per `deliver_many` slice. Small enough that a throttle is noticed within a second or two rather than after a thousand refusals. | Tunable |
| `BROADCAST_CONCURRENCY` | `8` | Slices in flight at once — the real send concurrency against SendGrid. The ceiling that matters is our own thread pool, not SendGrid's documented limit. | Tunable |
| `BROADCAST_WAVE_PAUSE_SECONDS` | `0.5` | Seconds between waves. Deliberate politeness: a broadcast is not urgent, and a sender that paces itself never discovers the throttle. | Tunable |
| `BROADCAST_THROTTLE_WAVES_BEFORE_STOP` | `3` | Consecutive throttled waves (HTTP 429) before the send stops. Stopping names every address never attempted; continuing into a throttle turns a recoverable pause into a thousand recorded failures. | Tunable |

---

## A.6 Chance mechanics

Read by `backend/app/services/chance.py`. **The money limits of a mechanic — its
reserve and its per-round, per-player-per-day and platform-per-day ceilings —
are not here.** They are part of the signed, versioned configuration of the
mechanic itself (8B.2.8 / 8B.4.3), because they are money and money changes on a
card. What is here is the cross-mechanic backstop and the statistics that decide
when a run of bad luck stops being a run of bad luck.

| Variable | Default | What it does | Class |
|---|---|---|---|
| `CHANCE_SIGNING_KEYS` **(process env, not `config.py`)** | *(empty)* | ⚠ Comma-separated `name:secret` pairs. This is the **only** door into playing or settling a round: both the app tier and any third-party provider authenticate as a machine with HMAC-SHA256 over method, path, timestamp and a digest of the body. Empty means no machine may play or settle anything — see § A.11. Never from the database, a request or this repository. | ⚠ **Silent** |
| `CHANCE_PLATFORM_DAILY_PAYOUT_CEILING` | `0` | 8B.4.4, the widest reading — total payout across **every** mechanic per day, above and beyond each mechanic's own signed ceiling. **`0` means no cross-mechanic ceiling**, which is the shipped default and deliberate: with one lucky-gift tier live the per-mechanic ceilings are the whole control, and a second ceiling nobody has sized is a number that gets raised until it means nothing. | Tunable |
| `CHANCE_RESERVE_WARNING_PPM` | `800000` (80%) | How much of a mechanic's reserve may be consumed before an owner is told, **in parts per million of the reserve**. Buys a day's notice before the auto-suspend rather than learning from the suspension. | Tunable |
| `CHANCE_RTP_DAILY_SIGMA_MILLI` | `4000` (4σ) | 8B.5.1 — one day, one mechanic. **Sigmas in thousandths, not a percentage**, and that is the point: a flat "5% above configured" alert fires constantly on a small day and never on a large one, because a sample's spread shrinks with its size. The detector compares observed payout against the exact variance of the signed outcome table and alerts on standard deviations. 4σ two-sided is about one day in 16,000. | Tunable |
| `CHANCE_RTP_WINDOW_SIGMA_MILLI` | `3000` (3σ) | 8B.5.2, the **persistent** gap, pooled over the rolling window below. Pooling buys power, so the bar comes down. One day at 3σ is ignored on purpose; a week sustained at 3σ is a mis-set table, an exploit or a bug. | Tunable |
| `CHANCE_RTP_WINDOW_DAYS` | `7` | The rolling window that pooling covers. | Tunable |
| `CHANCE_RTP_MIN_ROUNDS` | `200` | No mechanic alert below this many rounds however extreme the figure — the normal approximation is invalid in the tail of a heavy-tailed multiplier distribution at small N. Three rounds containing one 50× is a 6σ event and an ordinary evening. The figure is still **reported**; it is not alerted on. | Tunable |
| `CHANCE_PLAYER_SIGMA_MILLI` | `5000` (5σ) | 8B.5.3 — one player's own return against the table's. Higher than the mechanic bar for a reason that has nothing to do with the player: this runs against every active player every day, so the multiple-comparison correction *is* the threshold. About one player in 3.5 million. | Tunable |
| `CHANCE_PLAYER_MIN_ROUNDS` | `30` | The same small-N floor, per player. | Tunable |
| `CHANCE_PLAYER_MAX_ROUNDS_PER_HOUR` | `240` | 8B.5.3 "unusual frequency". A person tapping as fast as a person can tap manages a few a second in bursts and nothing like this sustained. | Tunable |
| `CHANCE_PLAYER_MIN_ROUND_GAP_MS` | `250` | 8B.5.3 "impossible timing" — two settled rounds closer together than this is a script, not a person. | Tunable |
| `CHANCE_PLAYER_MIN_COMMIT_TO_PLAY_MS` | `50` | A round played sooner than this after its own commitment was published. A round played *before* its commitment is flagged whatever these figures say — that is a clock or ordering fault, not a fast player. | Tunable |
| `CHANCE_ANOMALY_LOOKBACK_HOURS` | `24` | How far back the player sweep looks on each scan. | Tunable |

---

## A.7 Player protection

Read by `backend/app/services/player_protection.py` and nothing else. 8B.6.6 —
"these protect the business as much as the player" — is why they sit beside the
alert thresholds rather than in a compliance document: they are operating limits
on how much one account can lose us in a day and how long one person can sit in
a loop. **Every figure is in whole diamonds or whole time units.**

| Variable | Default | What it does | Class |
|---|---|---|---|
| `PROTECTION_DEFAULT_DAILY_LOSS_LIMIT` | `0` | ⚠ The house's own daily loss ceiling, applied to **every** player. `0` means the business sets none and only a player's own limit, or one imposed on a review, applies — see § A.11. It defaults to 0 because a number invented in this file would silently become the product's behaviour in every market on the next deploy, and this is a commercial decision with a regulatory shadow over it (8B.0.3). Once set, `effective_limit` does the rest: the **lowest** limit set by anybody wins, so a house ceiling can never be loosened by a player and a player can always go stricter. | ⚠ **Silent** |
| `PROTECTION_DEFAULT_WEEKLY_LOSS_LIMIT` | `0` | ⚠ The same, over a week. Same rule, same reason. | ⚠ **Silent** |
| `PROTECTION_MAX_LOSS_LIMIT` | `10000000` | The largest loss limit this system will **store**. Not a protection — a sanity bound, so a fat finger cannot write a number that reads as a limit and behaves as none. The refusal quotes it. | Tunable |
| `PROTECTION_LIMIT_INCREASE_DELAY_HOURS` | `24` | How long a **raised** limit waits before taking effect. A reduction is always immediate; only a loosening waits, and the old lower limit is enforced throughout. This is the difference between a limit and a suggestion: a player who reaches their limit and can raise it in the same minute has been asked a question at the worst possible moment. | Tunable |
| `PROTECTION_MIN_SELF_EXCLUSION_DAYS` | `180` (6 months) | The shortest self-exclusion accepted. A self-exclusion that can be set for an hour is a cooling-off period with a frightening name. **Nothing shortens a term once started** — not the player, not support, not an owner. | Tunable |
| `PROTECTION_EXCLUSION_REFLECTION_HOURS` | `72` (3 days) | The gap between a player asking for a served exclusion to be lifted and the earliest moment staff may decide. The moment somebody asks to be let back in is the moment they are least well placed to judge it; the wait *is* the control. | Tunable |
| `PROTECTION_MIN_COOLING_OFF_HOURS` | `24` | Floor on a self-set cooling-off period. Below it, it is a pause between two taps rather than a break. | Tunable |
| `PROTECTION_MAX_COOLING_OFF_DAYS` | `90` | Ceiling on one. Above it the honest tool is a self-exclusion, which unlike this one does not end on its own. | Tunable |
| `PROTECTION_SESSION_REMINDER_MINUTES` | `60` | 8B.6.3 — how many minutes of continuous play before a reminder falls due. | Tunable |
| `PROTECTION_SESSION_GAP_MINUTES` | `30` | How long a break between two rounds ends a session. A session is derived from the round history rather than reported by the app, so this gap is the **whole definition of "continuous"**. | Tunable |
| `PROTECTION_HARM_ESCALATION_ROUNDS` | `5` | 8B.6.4 — consecutive losing rounds with a non-falling stake. | Tunable |
| `PROTECTION_HARM_ESCALATION_MULTIPLE` | `3` | …ending at least this multiple of where the stake started. Both conditions together with the losing run, because each alone is ordinary play. | Tunable |
| `PROTECTION_HARM_SESSION_MINUTES` | `180` (3 h) | A sustained session — continuous play this long is a harm pattern in its own right. | Tunable |
| `PROTECTION_HARM_RAPID_ROUNDS` | `20` | Rapid repeat play — this many rounds inside the window below. Distinct from the session check, which is duration; this one is rate, and it catches somebody tapping without reading at minute nine. | Tunable |
| `PROTECTION_HARM_RAPID_WINDOW_MINUTES` | `10` | That window. | Tunable |

---

## A.8 Virtual accounts

Read by `van_bank_configured()` in `backend/app/services/partner_ops.py`, which
is the single predicate for all four. **All four, or none of it** — a
half-configured bank is not a bank, and with any one blank the predicate answers
`False` and the seller's record says plainly that no number has been issued and
why (`VAN_NO_BANK`).

A VAN is a unique account number the **bank** maps onto one real, KYC-compliant
business current account. HDFC sells this as eCMS, and 8C.8.7 requires the
account underneath to be a business current account, not a personal one — which
is why all four are empty today. Configuring them is necessary but **not
sufficient**: the number itself is allocated by the bank, so an eCMS client must
also be registered through `partner_ops.register_van_allocator`. Configuration
without a client issues nothing and says so, which is the safe direction — a
number this system invented is not an account anyone can pay into.

| Variable | Default | What it does | Class |
|---|---|---|---|
| `VAN_PROVIDER` | *(empty)* | ⚠ The collection provider — `hdfc_ecms` once the current account exists. | ⚠ **Silent** |
| `VAN_IFSC` | *(empty)* | ⚠ The IFSC every VAN under the collection account carries. The bank gives it; it is a fact about the account, not a format we choose. | ⚠ **Silent** |
| `VAN_BENEFICIARY_NAME` | *(empty)* | ⚠ The beneficiary name a payer must see when adding the VAN as a payee. Wrong here and the payment is rejected at the payer's own bank. | ⚠ **Silent** |
| `VAN_COLLECTION_ACCOUNT` | *(empty)* | ⚠ The real current account every VAN maps onto — the VAN is an identifier, not a separate pot (8C.1.3). Recorded on the partner's record so a statement line traces back to the account it landed in. | ⚠ **Silent** |

---

## A.9 Service credentials

A standing key held by a machine, not a person. Read like every other secret so
it arrives from Secret Manager as a Cloud Run environment variable and never
from a file in the repo. `backend/app/core/security.py` holds the allowlist of
what each one unlocks, and it is an explicit list of operations, not a role.

**The three keys hold three different values, deliberately.** Leaking the ability to email
a report must not also grant the ability to create a commission liability.
Minimum length is `security.MIN_SERVICE_KEY_CHARS`; comparison is by digest.
**Empty means no machine may call anything**, which is the default.

| Variable | Default | What it does | Class |
|---|---|---|---|
| `SERVICE_KEY_WEEKLY_ACCRUAL` | *(empty)* | Unlocks the weekly commission accrual and nothing else. Without it the Sunday job still generates the payout report and accrues nothing. § 8 mints it. | **Must-set** |
| `SERVICE_ACCRUAL_MAX_MINOR` | `125000000` (₹12,50,000) | The sanity bound on **one unattended accrual**: the most commission a single agency may be credited for a single period without a person looking. It is 25% — the top rate in the live main-agency table — of ₹50,00,000, the upper bound that table's own top band declares. Above it **nothing is capped or truncated: the accrual is refused whole, loudly**, and a team admin can still accrue it by hand after checking the ledger. In paise. | Tunable |
| `SERVICE_KEY_REPORTING` | *(empty)* | Unlocks exactly seven routes — the six `/api/notifications/jobs/*` and `/provider-events` triggers plus `POST /api/reports/jobs/weekly-business` — and no money operation at all. Without it **nothing is scheduled**: no daily report, no weekly report, no partner statement, no monthly pack, no exception alert. § 9 mints it. | **Must-set** |
| `SERVICE_KEY_PARTNER_REGISTRATION` | *(empty)* | Unlocks one operation, `POST /api/partner-ops/partners`, which creates an **empty** record — zero coins, zero credit, zero commission, `pending`, inactive. Approval stays a human decision. It is held by the Firestore trigger that fires on every public signup, so it is the most frequently exercised machine path there is, which is exactly why it carries no commission or reporting power. Without it a new agency or coin seller exists only in Firestore, invisible to `/kyc`, `/agencies` and `/sellers`, until somebody runs `python -m scripts.backfill_partners --confirm`. § 10 mints it. | **Must-set** |

---

## A.10 Firebase and infrastructure

| Variable | Default | What it does | Class |
|---|---|---|---|
| `ENVIRONMENT` | `development` | Anything in `{production, prod}`, case-insensitively, makes `settings.is_production` true — and that flag does exactly three things, all in code, none of them a feature switch: CORS narrows from `*` to the two Hosting origins listed in `app/main.py` (`scripts/retarget_project.py` rewrites them on a project move); HTML mail templates are cached in memory instead of re-read on every send; and the development fallback that prints an undelivered observer sign-in code into the log is switched **off**, so a valid credential never lands in Cloud Logging. Also echoed by `GET /api/health` — note the `/api` prefix, which every route on this service carries. | **Must-set** |
| `API_PORT` | `8080` | *(inert)* — nothing reads it. The listening port comes from `$PORT` in `backend/Dockerfile` (`uvicorn --port ${PORT}`), which Cloud Run sets. | *(inert)* |
| `MONGO_URI` | `mongodb://localhost:27017/?replicaSet=rs0` | The Atlas connection string. **Must be a replica set**: the ledger writes in transactions and a standalone `mongod` cannot serve them. § 2 and § 3. | **Must-set** |
| `MONGO_DB` | `zipper` | Database name inside that cluster. Used by the async motor client and by the blocking pymongo recorder in `email.py` — both must land in the same database or the delivery log splits in two. | Tunable |
| `FIREBASE_CREDENTIALS_PATH` | `../serviceAccountKey.json` | `db/firebase.py::init` uses this file **if it exists**, and otherwise falls back to Application Default Credentials. On Cloud Run the file does not exist and ADC is the right answer, so leave it alone; locally it points at the key in the repo root. | Tunable |
| `FIREBASE_PROJECT_ID` | *(empty)* | *(inert)* — nothing in the API reads it. The Admin SDK takes the project from the credential. § 4's deploy command sets it; that is harmless and currently decorative. | *(inert)* |
| `AGORA_APP_ID` **(Functions)** | *(empty)* | The Agora application id used by the `generateAgoraToken` callable, which the Android app calls before joining any channel. | **Must-set** |
| `AGORA_APP_CERTIFICATE` **(Functions)** | *(empty)* | The signing certificate for that token, valid one hour. With either of these unset the callable throws `failed-precondition` — "Agora credentials not configured on server" — and **no user can join a call at all**. It is loud rather than silent, but it is total. | **Must-set** |

---

## A.11 The defaults that silently do nothing

Every setting in this list has a valid default, starts cleanly, logs no warning
and shows nothing on any screen — and leaves a whole feature that never happens.
They are the reason this appendix exists.

| Leave the default and… | Settings |
|---|---|
| **No virtual account is ever issued.** Every coin seller's record says a number has not been issued, and payment stays on the reference-and-screenshot path. Nothing is broken and nothing is missing — but the feature is off, and it is off for a bank reason (§ A.8) rather than an oversight. | `VAN_PROVIDER`, `VAN_IFSC`, `VAN_BENEFICIARY_NAME`, `VAN_COLLECTION_ACCOUNT` |
| **A broadcast leaves from the transactional address with no one-click header.** `MAIL_FROM_BULK` empty means the bulk stream — scheduled reports, alerts and every multi-recipient broadcast — has no address of its own and falls back to `MAIL_FROM`. Set `MAIL_FROM_TRANSACTIONAL` without it and the mailshots leave from the base address while the receipts leave from the transactional one; set neither and both are the same address with one shared complaint rate, which is the exact coupling these settings exist to break. `UNSUBSCRIBE_URL` empty means `List-Unsubscribe-Post` is never emitted, so there is no RFC 8058 one-click route — the `mailto:` route still goes out, and above roughly 5,000 messages a day Gmail and Yahoo want the one-click one. Neither omission appears anywhere but in the raw headers. | `MAIL_FROM_BULK`, `UNSUBSCRIBE_URL` |
| **Nothing can be played.** `CHANCE_SIGNING_KEYS` empty means no machine may play or settle a round — neither the app tier nor a third-party provider. Every attempt is refused with "No signing keys are configured", which is the correct default (8B.1.7 starts with nothing live) and is invisible from any deployment screen. | `CHANCE_SIGNING_KEYS` |
| **The house sets no loss ceiling.** Only a player's own limit, or one imposed on a review, applies — there is no business-wide daily or weekly cap on what one account can lose. Deliberate: the figure is a commercial and regulatory decision, not one this file should invent. But until it is set, the feature is not enforcing anything. | `PROTECTION_DEFAULT_DAILY_LOSS_LIMIT`, `PROTECTION_DEFAULT_WEEKLY_LOSS_LIMIT` |
| **No machine may call anything.** Each of the three service credentials, empty, turns off its own path in full: no weekly accrual, nothing scheduled at all, and new agencies and sellers that never reach the approval queue. Each has a section above that says so (§ 8.9, § 9.9, § 10.9); they are repeated here because the shape is identical. | `SERVICE_KEY_WEEKLY_ACCRUAL`, `SERVICE_KEY_REPORTING`, `SERVICE_KEY_PARTNER_REGISTRATION` |
| **Firestore-triggered email is dropped on the floor.** `SG_MAIL_KEY` is the Cloud Functions' own SendGrid credential, separate from the API's. Unset, `sendMail()` logs and returns; no recipient, and no row in the delivery log the API keeps, so `/tech/email` cannot tell you it happened. | `SG_MAIL_KEY` |
| **The unsubscribe and contact mailboxes must receive mail.** `UNSUBSCRIBE_EMAIL` empty falls back to the support address (QA #47), and `support@` / `info@zipperlive.org` are published everywhere — but on 3 Nov 2026 the domain had no MX record (§ 11.8), so mail to them bounces until a mailbox or forwarding exists. Gmail checks that an unsubscribe mailbox does not hard-bounce. | `UNSUBSCRIBE_EMAIL`, MX for `zipperlive.org` |
| **Two settings do nothing at all, whatever you set them to.** `ALERT_AWAITING_SIGNATURE_HOURS` is declared and described and read by no code — the large-card detector has no age condition and queue ageing uses `ALERT_QUEUE_AGE_HOURS`. `API_PORT` and `FIREBASE_PROJECT_ID` are likewise read by nothing. | `ALERT_AWAITING_SIGNATURE_HOURS`, `API_PORT`, `FIREBASE_PROJECT_ID` |

## A.12 The must-set list, in one place

Copy-paste order, matching the § 4 deploy command and the sections that mint the
secrets. Everything not on this list has a default that is a real working
choice.

**Secrets** (`--set-secrets`, from Secret Manager — § 3, § 8.1, § 9.2, § 10.1):

```
MONGO_URI
JWT_SECRET
SENDGRID_API_KEY
SERVICE_KEY_WEEKLY_ACCRUAL
SERVICE_KEY_REPORTING
SERVICE_KEY_PARTNER_REGISTRATION
```

**Environment** (`--set-env-vars` — § 4, § 11.5):

```
ENVIRONMENT=production
OBSERVER_EMAIL=<the observer's own address>
OBSERVER_OTP_DELIVERY_EMAIL=<a different mailbox>
MAIL_FROM=<on your authenticated domain>
PORTAL_URL=<your Hosting site, not the default>
UNSUBSCRIBE_EMAIL=<a real monitored mailbox on your domain>
```

**Cloud Functions** (`functions/.env` — § 8.4, § 9.5, § 10.4):

```
SG_MAIL_KEY
AGORA_APP_ID
AGORA_APP_CERTIFICATE
SERVICE_KEY_WEEKLY_ACCRUAL
SERVICE_KEY_REPORTING
SERVICE_KEY_PARTNER_REGISTRATION
```

`PORTAL_URL` and `UNSUBSCRIBE_EMAIL` are the two on this list that no section
above sets for you.
