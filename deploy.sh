#!/bin/bash
# Zippern Full Deploy Script
# Run from: ~/Documents/Projects/zippern/
# Usage: chmod +x deploy.sh && ./deploy.sh
#
#   ./deploy.sh              everything: Firebase + the Python API on Cloud Run
#   ./deploy.sh --skip-api   Firebase only (rules, functions, CRM) — no Cloud Run
#   ./deploy.sh --api-only   Cloud Run only — no Firebase
#
# "The backend" is TWO deployments, not one, and they go to different clouds:
#
#   * Cloud Functions (functions/, TypeScript) — Firestore triggers and
#     schedulers. Deployed by `firebase deploy --only functions`.
#   * The Python API (backend/, FastAPI) — the ledger, the money board, the
#     audit trail. Deployed by `gcloud run deploy` and NOT by anything the
#     Firebase CLI does.
#
# This script used to do only the first, which meant a run that printed "ALL
# DEPLOYMENTS COMPLETE" could leave the API untouched on old code. It now does
# both.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"

# ── Configuration ────────────────────────────────────────────────────────────
GCP_PROJECT="zipper-83816"
REGION="asia-south1"
SERVICE="zipper-api"
CRM_URL="https://zipperlive.web.app"

# Every secret the API needs, as `ENV_NAME=SecretManagerName`.
#
# `gcloud run deploy --set-secrets` REPLACES the whole list rather than merging
# into it. Drop one name here and that machine identity silently switches off:
# no error, no log line, just a credential that is now the empty string and an
# API that refuses every call presenting it. Add to this array — never hand-edit
# a shorter list into the deploy command.
API_SECRETS=(
  "MONGO_URI=MONGO_URI"
  "JWT_SECRET=JWT_SECRET"
  "SENDGRID_API_KEY=SENDGRID_API_KEY"
  "SERVICE_KEY_WEEKLY_ACCRUAL=SERVICE_KEY_WEEKLY_ACCRUAL"
  "SERVICE_KEY_REPORTING=SERVICE_KEY_REPORTING"
  # Was missing from the documented deploy command, and its absence is a
  # *silent* failure with a known symptom: the Firestore trigger that fires on
  # every public agency/seller signup calls POST /api/partner-ops/partners with
  # this key, the API compares it against an empty string, refuses, and the
  # applicant is written to Firestore where no staff screen reads them. Nothing
  # appears in the approval queue and nothing appears in the logs. That is
  # exactly the "new agency or seller join, their approval never comes" bug —
  # recovering needs `python -m scripts.backfill_partners --confirm`.
  "SERVICE_KEY_PARTNER_REGISTRATION=SERVICE_KEY_PARTNER_REGISTRATION"
)

# Non-secret configuration. Same replace-not-merge rule as above.
API_ENV=(
  "ENVIRONMENT=production"
  "MONGO_DB=zipper"
  "FIREBASE_PROJECT_ID=${GCP_PROJECT}"
  "OBSERVER_EMAIL=314zipper@gmail.com"
  "OBSERVER_OTP_DELIVERY_EMAIL=soumyars675@gmail.com"
  # QA #47 (owner decision, 3 Nov 2026): the official automated sender, on the
  # SendGrid-authenticated domain zipperlive.org. An unauthenticated From gets a
  # 403 and every email fails silently — including the observer's sign-in code.
  "MAIL_FROM=no-reply@zipperlive.org"
  "MAIL_FROM_NAME=Zipper"
  "REPORT_TIMEZONE=Asia/Kolkata"
  # Defaults to https://zipper.web.app, which is not this site. Every link in
  # every email — sign-in codes, approvals, report links — would point at a
  # domain you do not control.
  "PORTAL_URL=${CRM_URL}"
  # QA #47: the support mailbox (it must receive mail — see DEPLOYMENT.md
  # § 11.8). Bulk mail without a working unsubscribe is what pushes a sender
  # into spam folders.
  "UNSUBSCRIBE_EMAIL=support@zipperlive.org"
  "CONTACT_SUPPORT_EMAIL=support@zipperlive.org"
  "CONTACT_INFO_EMAIL=info@zipperlive.org"
)

# The three service credentials, as `CloudRunSecret:FunctionsSecret`. Both sides
# must hold the SAME value or the call is refused — one side is not enough.
PAIRED_KEYS=(
  "SERVICE_KEY_WEEKLY_ACCRUAL:ZIPPER_ACCRUAL_KEY"
  "SERVICE_KEY_REPORTING:ZIPPER_REPORTING_KEY"
  "SERVICE_KEY_PARTNER_REGISTRATION:ZIPPER_PARTNER_REGISTRATION_KEY"
)

# ── Argument parsing ─────────────────────────────────────────────────────────
DO_FIREBASE=true
DO_API=true
for arg in "$@"; do
  case "$arg" in
    --skip-api) DO_API=false ;;
    --api-only) DO_FIREBASE=false ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)"; exit 1 ;;
  esac
done

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║     Zippern Full Deploy                           ║"
echo "╚══════════════════════════════════════════════════╝"
echo "Project root: $PROJECT_ROOT"
echo "Firebase:     $DO_FIREBASE"
echo "Cloud Run:    $DO_API"
echo ""

# ── Preflight ────────────────────────────────────────────────────────────────
# Checked BEFORE anything deploys. A half-deployed stack — new CRM against an
# old API, or an API whose credential list just lost an entry — is worse than
# not having started, so every tool and secret is verified up front.
echo "──────────────────────────────────"
echo "PREFLIGHT"
echo "──────────────────────────────────"

if $DO_FIREBASE; then
  if ! command -v firebase &>/dev/null; then
    echo "❌ Firebase CLI not found:  npm install -g firebase-tools && firebase login"
    exit 1
  fi
  echo "✅ firebase $(firebase --version)"

  ACTIVE="$(firebase use 2>/dev/null | head -1 || true)"
  case "$ACTIVE" in
    *"$GCP_PROJECT"*) echo "✅ firebase project: $GCP_PROJECT" ;;
    *) echo "❌ Firebase CLI is not pointed at $GCP_PROJECT (got: ${ACTIVE:-none})."
       echo "   Deploying rules to the wrong project has happened before."
       echo "   Fix:  firebase use $GCP_PROJECT"
       exit 1 ;;
  esac
fi

if $DO_API; then
  if ! command -v gcloud &>/dev/null; then
    echo "❌ gcloud not found. The Python API cannot deploy without it."
    echo "   Install the SDK, then:  gcloud auth login && gcloud config set project $GCP_PROJECT"
    exit 1
  fi
  echo "✅ gcloud $(gcloud --version 2>/dev/null | head -1 | awk '{print $NF}')"

  if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | grep -q .; then
    echo "❌ No active gcloud account.  gcloud auth login"
    exit 1
  fi
  echo "✅ gcloud account: $(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1)"

  # Every secret must already exist. `gcloud run deploy` fails on a missing
  # secret, but it fails AFTER a container build of several minutes — so check
  # cheaply here instead.
  echo "   Checking Secret Manager…"
  MISSING=()
  for pair in "${API_SECRETS[@]}"; do
    name="${pair#*=}"
    gcloud secrets describe "$name" --project "$GCP_PROJECT" &>/dev/null \
      || MISSING+=("$name")
  done
  if [ ${#MISSING[@]} -gt 0 ]; then
    echo "❌ Missing secrets in Secret Manager: ${MISSING[*]}"
    echo "   Create with:  printf %s \"\$VALUE\" | gcloud secrets create NAME --data-file=- --project $GCP_PROJECT"
    echo "   Generate a service key with:  cd backend && python -m scripts.generate_service_key"
    exit 1
  fi
  echo "✅ all ${#API_SECRETS[@]} secrets exist"
fi

# Both halves of each shared credential must be present. A key set on Cloud Run
# but not on Functions (or vice versa) produces a refusal at call time, days
# later, from a scheduler nobody is watching.
if $DO_FIREBASE && $DO_API; then
  echo "   Checking paired service credentials…"
  # Functions secrets live in Secret Manager too, under the name you gave
  # `firebase functions:secrets:set`, so one listing covers both sides.
  FN_LIST="$(gcloud secrets list --project "$GCP_PROJECT" --format='value(name)' 2>/dev/null || true)"
  for pair in "${PAIRED_KEYS[@]}"; do
    fn_name="${pair#*:}"
    if ! grep -qx "$fn_name" <<<"$FN_LIST"; then
      echo "⚠️  $fn_name is not set on Cloud Functions."
      echo "    ${pair%%:*} will be live on the API, but the Function that"
      echo "    presents it holds nothing, so those calls will be refused."
      echo "    Fix:  firebase functions:secrets:set $fn_name"
      echo "    Use the SAME value as the Cloud Run secret ${pair%%:*}."
    fi
  done
fi
echo ""

# ── Firebase ─────────────────────────────────────────────────────────────────
if $DO_FIREBASE; then
  echo "──────────────────────────────────"
  echo "STEP 1: Building Cloud Functions"
  echo "──────────────────────────────────"
  cd "$PROJECT_ROOT/functions"
  npm install
  npm run build
  echo "✅ Functions built"

  # Guard the money math, the same way STEP 6 guards the ledger.
  #
  # `npm test` is `tsc && node --test` — Node's own runner, no framework, so it
  # works on a fresh checkout. What it covers is the arithmetic that can be
  # WRONG WITHOUT THROWING: the 3x3 call split table, the who-pays rule, and the
  # seat-count clamps that stop a room being configured past what a phone can
  # decode. None of those fail loudly in production; they just quietly underpay
  # one gender of host, or bill the wrong side of a call.
  #
  # It also covers `decideGuestClaim`, which is the same kind of hazard wearing
  # different clothes: every wrong answer there either hands somebody else's
  # account to a stranger or quietly mints a second guest account and strands the
  # first one's balance. Neither throws.
  if [ -d test ]; then
    echo "Running functions tests…"
    if ! npm test --silent; then
      echo "❌ Functions tests failed — not deploying."
      echo "   Run: cd functions && npm test"
      exit 1
    fi
    echo "✅ Functions tests passed"
  fi
  echo ""

  cd "$PROJECT_ROOT"
  echo "──────────────────────────────────"
  echo "STEP 2: Firestore rules"
  echo "──────────────────────────────────"
  firebase deploy --only firestore:rules
  echo ""

  echo "──────────────────────────────────"
  echo "STEP 3: Firestore indexes"
  echo "──────────────────────────────────"
  firebase deploy --only firestore:indexes
  echo ""

  echo "──────────────────────────────────"
  echo "STEP 4: Storage rules"
  echo "──────────────────────────────────"
  firebase deploy --only storage
  echo ""

  echo "──────────────────────────────────"
  echo "STEP 5: Cloud Functions"
  echo "──────────────────────────────────"
  firebase deploy --only functions

  # ── createCustomToken needs to be able to sign ─────────────────────────────
  #
  # `redeemQuickLogin` calls `admin.auth().createCustomToken(uid)`, and that
  # mints a signed JWT. The functions runtime holds a bearer token, not an RSA
  # private key, so the Admin SDK signs through IAM's signBlob API instead —
  # which requires the runtime account to be able to impersonate ITSELF.
  #
  # Without the grant, `createCustomToken` throws something that is not an
  # HttpsError, so the callable framework wraps it as the opaque code INTERNAL.
  # The visible symptom is the whole of quick sign-in failing with the word
  # "INTERNAL" on the login screen, with nothing to say what is wrong — and for
  # a GUEST that is not a cosmetic failure: an anonymous credential cannot be
  # recovered by SMS or by a Google picker, so the custom token is the only
  # route back to their account and their balance.
  #
  # This is a DIFFERENT service account from the Cloud Run one granted below.
  # Granting one has never granted the other, which is why the API's signed
  # image URLs worked while quick login did not.
  #
  # ASKED, not assumed. 1st-gen functions historically default to
  # `<project>@appspot.gserviceaccount.com`, but that is a default and not a
  # guarantee — the gen, the CLI version and an explicit `serviceAccount` in
  # firebase.json can all change it, and granting the wrong account looks
  # exactly like success while fixing nothing. The fallback is only used when
  # the describe fails outright.
  #
  # Idempotent: re-granting an existing binding changes nothing.
  FUNCTIONS_SA="$(gcloud functions describe redeemQuickLogin \
                  --project "$GCP_PROJECT" --region "$REGION" \
                  --format='value(serviceAccountEmail)' 2>/dev/null || true)"
  [ -z "$FUNCTIONS_SA" ] && FUNCTIONS_SA="${GCP_PROJECT}@appspot.gserviceaccount.com"
  echo "Granting signBlob to $FUNCTIONS_SA (createCustomToken / quick sign-in)"
  gcloud iam service-accounts add-iam-policy-binding "$FUNCTIONS_SA" \
    --project "$GCP_PROJECT" \
    --member "serviceAccount:$FUNCTIONS_SA" \
    --role "roles/iam.serviceAccountTokenCreator" \
    --quiet >/dev/null 2>&1 \
    || echo "  ! Could not grant it — quick sign-in will fail with INTERNAL until it is granted."
  echo ""
fi

# ── Cloud Run ────────────────────────────────────────────────────────────────
# Deliberately BEFORE the CRM. The new CRM calls endpoints the old API may not
# have; shipping the frontend first gives users 404s on any screen that moved
# ahead of the backend. API first, frontend second — that ordering degrades to
# "an endpoint nobody calls yet", which is harmless.
if $DO_API; then
  echo "──────────────────────────────────"
  echo "STEP 6: Python API → Cloud Run"
  echo "──────────────────────────────────"
  cd "$PROJECT_ROOT/backend"

  # Guard the ledger: never ship an API whose own tests do not pass.
  if [ -d tests ]; then
    echo "Running backend tests…"
    PY="python3"; [ -x .venv/bin/python ] && PY=".venv/bin/python"
    echo "  interpreter: $PY"
    failed=0
    FAILLOG="$(mktemp)"
    for t in tests/test_*.py; do
      name="$(basename "$t" .py)"
      # Output is captured rather than discarded. Throwing it away meant a
      # failure printed only the test's name, which says nothing about the
      # cause — the first time this gate fired it reported "FAIL test_delivery"
      # and stopped, and finding out why needed a separate manual run.
      if ! "$PY" -m "tests.$name" >"$FAILLOG" 2>&1; then
        echo "  ❌ FAIL $name"
        echo "  ── last 20 lines ─────────────────────────────"
        tail -20 "$FAILLOG" | sed 's/^/  /'
        echo "  ──────────────────────────────────────────────"
        failed=1
      fi
    done
    rm -f "$FAILLOG"
    if [ "$failed" -ne 0 ]; then
      echo "❌ Backend tests failed — not deploying."
      echo "   Re-run one on its own with:  cd backend && $PY -m tests.<name>"
      exit 1
    fi
    echo "✅ backend tests pass"
  fi

  ENV_JOINED="$(IFS=,; echo "${API_ENV[*]}")"
  SECRETS_JOINED="$(IFS=,; echo "${API_SECRETS[*]/%/:latest}")"

  gcloud run deploy "$SERVICE" \
    --source . \
    --project "$GCP_PROJECT" \
    --region "$REGION" \
    --allow-unauthenticated \
    --set-env-vars "$ENV_JOINED" \
    --set-secrets "$SECRETS_JOINED" \
    --min-instances 0 \
    --max-instances 10 \
    --memory 512Mi

  # ── Let the API sign a face image for review ───────────────────────────────
  #
  # Host verification shows the reviewer two photographs through short-lived
  # signed URLs. Signing needs an RSA private key, and the container has none:
  # the Dockerfile copies `app` and `scripts` only, so the API runs on the
  # Cloud Run runtime service account, whose credentials are a bearer token.
  # `generate_signed_url` raised "you need a private key to sign credentials"
  # for every image, and the review queue could not display a single face.
  #
  # The fix is to sign through IAM's signBlob API, which requires the runtime
  # account to be able to impersonate ITSELF. Granted here rather than
  # documented in a README, because a manual step that the deploy depends on is
  # a step somebody will not know about the next time this is deployed.
  #
  # Idempotent: re-granting an existing binding changes nothing.
  RUNTIME_SA="$(gcloud run services describe "$SERVICE" --project "$GCP_PROJECT" \
                --region "$REGION" --format='value(spec.template.spec.serviceAccountName)' \
                2>/dev/null || true)"
  if [ -z "$RUNTIME_SA" ]; then
    # Cloud Run leaves this blank when the service uses the default compute
    # account, which is the case here. Derive it from the project number.
    PROJECT_NUMBER="$(gcloud projects describe "$GCP_PROJECT" --format='value(projectNumber)' 2>/dev/null || true)"
    [ -n "$PROJECT_NUMBER" ] && RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
  fi
  if [ -n "$RUNTIME_SA" ]; then
    echo "Granting signBlob to $RUNTIME_SA (host verification images)"
    gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
      --project "$GCP_PROJECT" \
      --member "serviceAccount:$RUNTIME_SA" \
      --role "roles/iam.serviceAccountTokenCreator" \
      --quiet >/dev/null || echo "  ! Could not grant it — face images will not display until it is granted."
  else
    echo "  ! Runtime service account not resolved — skipping the signBlob grant."
  fi

  API_URL="$(gcloud run services describe "$SERVICE" --project "$GCP_PROJECT" \
             --region "$REGION" --format='value(status.url)' 2>/dev/null || true)"
  if [ -n "$API_URL" ]; then
    # The path is /api/health, not /health. Every route in app/main.py is
    # mounted under /api — `app.include_router(..., prefix="/api")` — because
    # firebase.json rewrites /api/** to this service so the CRM and the API
    # share one origin and there is no CORS. Checking /health reported a
    # perfectly healthy deploy as broken.
    echo "Health check: $API_URL/api/health"
    BODY="$(curl -fsS --max-time 30 "$API_URL/api/health" 2>/dev/null || true)"
    if [ -n "$BODY" ]; then
      echo "  $BODY"
      case "$BODY" in
        *'"status":"ok"'*) echo "✅ API healthy" ;;
        *) echo "⚠️  API answered but not with status ok — check the body above." ;;
      esac
    else
      echo "❌ API deployed but /api/health did not answer — check the logs:"
      echo "   gcloud run services logs read $SERVICE --region $REGION --project $GCP_PROJECT"
      exit 1
    fi
  fi
  echo ""
fi

# ── CRM ──────────────────────────────────────────────────────────────────────
if $DO_FIREBASE; then
  echo "──────────────────────────────────"
  echo "STEP 7: Building CRM (Next.js)"
  echo "──────────────────────────────────"
  cd "$PROJECT_ROOT/zipper-crm"
  npm install
  npx tsc --noEmit
  echo "✅ types clean"
  # A stale out/ is invisible rather than loud: firebase.json rewrites every
  # unmatched path to /index.html, so a route that exists in source but was
  # never built serves the dashboard instead of 404ing.
  rm -rf out
  npm run build
  echo "✅ CRM built → zipper-crm/out/"
  echo ""

  cd "$PROJECT_ROOT"
  echo "──────────────────────────────────"
  echo "STEP 8: CRM → Firebase Hosting"
  echo "──────────────────────────────────"
  firebase deploy --only hosting
  echo ""
fi

echo "╔══════════════════════════════════════════════════╗"
echo "║  ✅ DEPLOY COMPLETE                               ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
$DO_FIREBASE && echo "CRM:  $CRM_URL"
$DO_API && echo "API:  ${API_URL:-$SERVICE @ $REGION}"
echo ""
echo "Dev server (local testing):"
echo "  Double-click start-crm-dev.command  →  http://localhost:3000"
echo ""
