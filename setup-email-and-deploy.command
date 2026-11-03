#!/bin/bash
# Zipper — Full Deploy
# Double-click this in Finder.
#
# Deploys, in dependency order:
#   1. Firestore rules, indexes, storage rules
#   2. Cloud Functions
#   3. Python API to Cloud Run          (skipped if gcloud is not installed)
#   4. CRM to Firebase Hosting
#
# Safe to run repeatedly. Each step reports clearly and the script stops on the
# first real failure rather than continuing into a broken state.

set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_ROOT"

PROJECT_ID="zipper-83816"
DESIRED_SITE="zipper"          # want https://zipper.web.app
API_SERVICE="zipper-api"
API_REGION="asia-south1"

# ── P0-10 (OPS-B): QUARANTINED ────────────────────────────────────────────────
# One double-click used to ship EVERYTHING to production: rules, all functions
# with `--force` (which DELETES every deployed function missing from the local
# build), the API with its environment and secret lists REPLACED (dropping any
# variable or secret not named here), and Hosting. A release is a reviewed,
# step-by-step operation now — see the release report. This refuses to run
# unless the target project is typed for this one invocation:
#
#     ZIPPER_CONFIRM_DEPLOY=setup-email-and-deploy:<project-id> ./setup-email-and-deploy.command
#
# and even then it no longer force-deletes functions, and it merges (does not
# replace) the API's environment variables and secrets.
if [ "${ZIPPER_CONFIRM_DEPLOY:-}" != "setup-email-and-deploy:${PROJECT_ID}" ]; then
  echo ""
  echo "  setup-email-and-deploy: refusing — quarantined (P0-10)."
  echo "  Use the reviewed release commands. To run this script anyway, for this one"
  echo "  invocation:  ZIPPER_CONFIRM_DEPLOY=setup-email-and-deploy:<project-id>"
  echo ""
  read -r -p "Press Enter to close..." || true
  exit 2
fi

bar()  { echo ""; echo "──────────────────────────────────────────────"; echo "$1"; echo "──────────────────────────────────────────────"; }
ok()   { echo "  ✅ $1"; }
warn() { echo "  ⚠️  $1"; }
die()  { echo ""; echo "  ❌ $1"; echo ""; read -r -p "Press Enter to close..."; exit 1; }

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   Zipper — Full Deploy                            ║"
echo "╚══════════════════════════════════════════════════╝"

# ── Preflight ─────────────────────────────────────────────────────────────────
bar "STEP 0: Checking tools"

command -v firebase >/dev/null 2>&1 || die "Firebase CLI not found.
   Install:  npm install -g firebase-tools
   Sign in:  firebase login"
ok "firebase $(firebase --version 2>/dev/null | head -1)"

firebase projects:list >/dev/null 2>&1 || die "Not signed in to Firebase.
   Run:  firebase login"
ok "signed in"

command -v node >/dev/null 2>&1 || die "Node.js not found. Install from nodejs.org"
ok "node $(node --version)"

HAVE_GCLOUD=0
if command -v gcloud >/dev/null 2>&1; then
  HAVE_GCLOUD=1
  ok "gcloud $(gcloud --version 2>/dev/null | head -1 | awk '{print $NF}')"
else
  warn "gcloud not found — the Python API step will be skipped."
  warn "Install: https://cloud.google.com/sdk/docs/install"
fi

# ── Hosting site ──────────────────────────────────────────────────────────────
bar "STEP 1: Hosting site"

SITE_TO_USE="$PROJECT_ID"
EXISTING_SITES="$(firebase hosting:sites:list --project "$PROJECT_ID" 2>/dev/null || true)"

if echo "$EXISTING_SITES" | grep -q "\b${DESIRED_SITE}\b"; then
  SITE_TO_USE="$DESIRED_SITE"
  ok "site '${DESIRED_SITE}' already exists"
else
  echo "  Attempting to create site '${DESIRED_SITE}'..."
  if firebase hosting:sites:create "$DESIRED_SITE" --project "$PROJECT_ID" >/dev/null 2>&1; then
    SITE_TO_USE="$DESIRED_SITE"
    ok "created — https://${DESIRED_SITE}.web.app"
  else
    warn "could not create '${DESIRED_SITE}'."
    warn "Site names are globally unique across all of Firebase, so it is"
    warn "probably taken. Deploying to the default site instead."
    warn "To try another name, edit DESIRED_SITE at the top of this script."
    warn "Suggestions: zipper-app, zipperlive, getzipper, zipper-live"
  fi
fi

firebase target:apply hosting production "$SITE_TO_USE" --project "$PROJECT_ID" >/dev/null 2>&1 \
  && ok "deploy target → ${SITE_TO_USE}" \
  || warn "could not apply hosting target; will deploy to default"

# ── Rules and indexes ─────────────────────────────────────────────────────────
bar "STEP 2: Firestore rules, indexes, storage rules"
echo "  Note: new indexes can take minutes to build. Queries that need them"
echo "  will fail until the build finishes — check the Firebase console."
echo ""
firebase deploy --only firestore:rules,firestore:indexes,storage --project "$PROJECT_ID"
ok "rules, indexes and storage rules deployed"

# ── Cloud Functions ───────────────────────────────────────────────────────────
bar "STEP 3: Cloud Functions"

cd "$PROJECT_ROOT/functions"
if [ -f .env ] && grep -q '^SG_MAIL_KEY=' .env 2>/dev/null; then
  ok "SendGrid key present in functions/.env"
else
  warn "SG_MAIL_KEY not found in functions/.env — outbound email will not work."
fi

npm install --silent
npm run build
ok "functions built"

cd "$PROJECT_ROOT"
# P0-10: no `--force` — a function missing locally is never deleted silently.
firebase deploy --only functions --project "$PROJECT_ID"
ok "functions deployed"

# ── Python API ────────────────────────────────────────────────────────────────
bar "STEP 4: Python API (Cloud Run)"

if [ "$HAVE_GCLOUD" -eq 0 ]; then
  warn "skipped — gcloud not installed"
  warn "The CRM will load but every /api/ call will fail until this is deployed."
elif [ ! -d "$PROJECT_ROOT/backend" ]; then
  warn "skipped — backend/ directory not found"
else
  MISSING=""
  for S in MONGO_URI JWT_SECRET SENDGRID_API_KEY; do
    gcloud secrets describe "$S" --project "$PROJECT_ID" >/dev/null 2>&1 || MISSING="$MISSING $S"
  done

  if [ -n "$MISSING" ]; then
    warn "skipped — these secrets do not exist yet:$MISSING"
    echo ""
    echo "  Create them once, then re-run this script:"
    echo ""
    echo "    gcloud config set project $PROJECT_ID"
    echo "    echo -n 'mongodb+srv://...' | gcloud secrets create MONGO_URI --data-file=-"
    echo "    echo -n \"\$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')\" | gcloud secrets create JWT_SECRET --data-file=-"
    echo "    echo -n 'SG.xxxxx' | gcloud secrets create SENDGRID_API_KEY --data-file=-"
    echo ""
    echo "  See DEPLOYMENT.md for granting Cloud Run access to them."
  else
    ok "secrets found"
    cd "$PROJECT_ROOT/backend"
    gcloud run deploy "$API_SERVICE" \
      --source . \
      --project "$PROJECT_ID" \
      --region "$API_REGION" \
      --allow-unauthenticated \
      --quiet \
      --update-env-vars "ENVIRONMENT=production,MONGO_DB=zipper,FIREBASE_PROJECT_ID=${PROJECT_ID},OBSERVER_EMAIL=314zipper@gmail.com,OBSERVER_OTP_DELIVERY_EMAIL=soumyars675@gmail.com,MAIL_FROM=no-reply@zipperlive.org,MAIL_FROM_NAME=Zipper" \
      --update-secrets "MONGO_URI=MONGO_URI:latest,JWT_SECRET=JWT_SECRET:latest,SENDGRID_API_KEY=SENDGRID_API_KEY:latest" \
      --min-instances 0 --max-instances 10 --memory 512Mi
    ok "API deployed to ${API_REGION}"
    cd "$PROJECT_ROOT"
  fi
fi

# ── CRM ───────────────────────────────────────────────────────────────────────
bar "STEP 5: CRM"

cd "$PROJECT_ROOT/zipper-crm"
npm install --silent
npm run build
ok "CRM built"

cd "$PROJECT_ROOT"
# `target:apply` records the site alias in .firebaserc, which is what makes the
# chosen site the one this project deploys to. It does NOT make
# `--only hosting:production` valid: that additionally needs a "target" key
# inside firebase.json's hosting block, which there isn't. Deploying the target
# by name here failed with "hosting target production not detected" — as the
# last step, after everything else had already shipped.
#
# `--only hosting` deploys the hosting config regardless, and keeps working
# whether or not a target is ever configured.
firebase target:apply hosting production "$SITE_TO_USE" --project "$PROJECT_ID" >/dev/null 2>&1 || true
firebase deploy --only hosting --project "$PROJECT_ID"
ok "CRM deployed"

# ── Verify ────────────────────────────────────────────────────────────────────
bar "STEP 6: Checking it came up"

if [ "$SITE_TO_USE" = "$DESIRED_SITE" ]; then
  BASE="https://${DESIRED_SITE}.web.app"
else
  BASE="https://${PROJECT_ID}.web.app"
fi

echo "  Checking ${BASE} ..."
if curl -fsS -o /dev/null -w '%{http_code}' "$BASE" 2>/dev/null | grep -q '^2'; then
  ok "CRM is responding"
else
  warn "CRM did not respond yet — Hosting can take a minute to propagate"
fi

echo "  Checking ${BASE}/api/health ..."
API_BODY="$(curl -fsS "${BASE}/api/health" 2>/dev/null || true)"
if echo "$API_BODY" | grep -q '"status"'; then
  ok "API is responding: $API_BODY"
else
  warn "API not responding."
  warn "Expected if step 4 was skipped. If it ran, check:"
  warn "  gcloud run services logs read ${API_SERVICE} --region ${API_REGION}"
fi

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  ✅ DEPLOY COMPLETE                                ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "  CRM:     ${BASE}"
echo "  API:     ${BASE}/api/health"
echo "  Console: https://console.firebase.google.com/project/${PROJECT_ID}"
echo ""
if [ "$SITE_TO_USE" != "$DESIRED_SITE" ]; then
  echo "  Still on the old URL. To get zipper.web.app, edit DESIRED_SITE at the"
  echo "  top of this script to an available name and run it again."
  echo ""
fi
echo "  First time only — create the owner and observer accounts:"
echo "    cd backend && source .venv/bin/activate && python -m scripts.seed_accounts"
echo ""

read -r -p "Press Enter to close..."
