# ZIPPER completion release 20261101 — shared settings and helpers for the scripts in this folder (sourced, never run).
# bash 3.2 compatible (macOS). Defines no command that changes production; each script holds its own change lines.
P="zipper-83816"
REGION="asia-south1"
SERVICE="zipper-api"
EXPECT_SERVING="zipper-api-00046-siw"       # serving 100% when this release was prepared (production code of 20 Oct)
EXPECT_TEMPLATE="zipper-api-00047-9cj"      # the service template = the Owner-MFA key revision; deploys build on it
RETIRED_REV="zipper-api-00048-pit"          # rc1 revision 3 code: must never receive traffic
SG_SECRET="ZIPPER_SENDGRID_API_KEY"
OLD_SG_SECRET="SENDGRID_API_KEY"
MFA_SECRET="OWNER_MFA_ENCRYPTION_KEY"
FN_SA="zipper-83816@appspot.gserviceaccount.com"
BACKEND_SA="239458555881-compute@developer.gserviceaccount.com"
STORAGE_AGENT="service-239458555881@gcp-sa-firebasestorage.iam.gserviceaccount.com"
STORAGE_ROLE="roles/firebaserules.firestoreServiceAgent"
BUCKET="zipper-83816.firebasestorage.app"
HOSTING_SITE="zipperlive"
HOSTING_HOST="zipperlive.web.app"
OLD_CRM_VERSION="ba740f4158292308"          # Hosting version live since 20 Oct (console rollback target)
WEEKLY="weeklyPayoutReportGenerator"
WEEKLY_REGION="us-central1"

# Functions, by name. Wave 2a has no client dependency; wave 2b needs APK 20 on the phones first (RUNBOOK.md step 8).
# Names from the §12 mail commit and the hygiene commits go into the two EXTRA lists once those commits are on the
# release HEAD; then regenerate SCRIPTS.sha256 with tools/write-scripts-sha256.command (reviewed procedure), commit,
# and regenerate RELEASE.txt (make-release-txt.sh).
WAVE_2A_CORE="releaseBeansForWeek weeklyPayoutReportGenerator syncPublicProfile backfillPublicProfiles startMobileSession"
WAVE_2A_MAIL=""      # the 8 e-mail functions (requestEmailBindCode ... onSellerResendEmail) only if mail.ts/index.ts changed what they send
WAVE_2A_HYGIENE=""   # e.g. purgeDeletedAccounts requestAccountDeletion onApprovalApproved claimDailyReward pushLiveStarted dailyPlatformStatsAggregator
WAVE_2A="$WAVE_2A_CORE $WAVE_2A_MAIL $WAVE_2A_HYGIENE"
WAVE_2B="generateAgoraToken settleGift startCall acceptCall tickCall endCall declineCall sweepStaleCalls"
EMAIL_FNS="requestEmailBindCode requestLoginEmailCode onAgencyApproved onAgencyRegistered onSellerRegistered onSellerApproved onAgencyResendEmail onSellerResendEmail"

# Functions rollback base (make-release-txt.sh -> RELEASE.txt BASE_COMMIT -> 29): the exact production Functions tree,
# branch prod-live-20261030 = the 20 Oct baseline + the SendGrid wave-A files live since 30 Oct (tag
# prod-live-20261030-tag). Resolved ONLY by its full ref (a tag and a branch with the same base name once made the
# short name ambiguous) and only while it is still the reviewed commit. f1af30a is NOT production: its functions/
# carries the unshipped Owner-MFA gate (src/ownerMfa.ts, profiles.ts, storageClaims.ts) — refused by both scripts.
PROD_FN_REF="refs/heads/prod-live-20261030"
PROD_FN_COMMIT="4e21b7f14f7cafb01b8aacaf35368695a17d13e0"
NOT_PROD_FN_COMMIT="f1af30a1d64fb8f20403fd6e7da5633cfab1234c"

# Android (60/61): the prod build type, signed with the debug key, published to the "debug" channel (build.gradle.kts).
APK_VERSION_CODE=20
APK_VERSION_NAME="1.2.6"
APK_MIN_SUPPORTED=20
APK_CHANNEL="debug"
APK_NOTES="ZIPPER 1.2.6: per-minute calls, lucky combo gifts, faster sign-up photos, call and live fixes. This update is required."

# Backend (11): exactly these settings are added to the service template; everything else is inherited.
BACKEND_ENV_ADD="EMAIL_PROVIDER=sendgrid,SENDGRID_FROM_EMAIL=no-reply@zipperlive.org,SENDGRID_FROM_NAME=ZIPPER Live"

HERE="$(cd "$(dirname "$0")" && pwd -P)"            # …/zippern/release/completion-20261101  (or its tools/ parent)
case "$HERE" in */tools) HERE="$(cd "$HERE/.." && pwd -P)";; esac
REPO="$(cd "$HERE/../.." && pwd -P)"                # …/zippern
RELEASE_TXT="$HERE/RELEASE.txt"
STATE_BACKEND="$HERE/production/backend-revision.txt"
STATE_CRM="$HERE/production/crm-live.txt"
FN_ENV="$REPO/functions/.env"                       # copied into deploy trees, never displayed, never opened by a script
H="python3 -I $HERE/rel_helpers.py"

# Appended, never prepended: the PATH you already have decides which gcloud/firebase/npm/node run; these folders are
# only a fallback when Terminal's PATH lacks them.
for d in /opt/homebrew/bin /usr/local/bin "$HOME/google-cloud-sdk/bin" /opt/homebrew/share/google-cloud-sdk/bin \
         /usr/local/share/google-cloud-sdk/bin /opt/homebrew/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin; do
  case ":$PATH:" in *":$d:"*) ;; *) [ -d "$d" ] && PATH="$PATH:$d";; esac
done
export PATH
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

FAILS=0
say() { echo "$*" | tee -a "$OUT/SUMMARY.txt"; }
check() { if [ "$1" = ok ]; then say "PASS  $2"; else say "FAIL  $2  ($1)"; FAILS=$((FAILS + 1)); fi; }
stop() { say "STOP: $*"; say "Nothing further was run."; exit 3; }

# Every file listed in SCRIPTS.sha256 must match it (written after review), or nothing runs.
verify_scripts() {
  ( cd "$HERE" && shasum -a 256 -c SCRIPTS.sha256 >/dev/null 2>&1 ) || {
    echo "REFUSING TO RUN: a file in $HERE does not match SCRIPTS.sha256" >&2; exit 2; }
}

# confirm WORD "what will happen" — you type WORD, or nothing happens (exit 4).
confirm() {
  local word="$1"; shift
  say ""; say "ABOUT TO: $*"
  printf 'Type %s and press Return to proceed (anything else stops): ' "$word"
  local answer=""; read -r answer
  if [ "$answer" != "$word" ]; then say "Not confirmed ($word was not typed). Nothing was changed by this step."; exit 4; fi
  say "Confirmed by typing $word at $(date -u +%FT%TZ)"
}

new_out() {  # new_out <id>: a fresh evidence folder production/<id>-<UTC>/ (git-ignored by ./.gitignore)
  TS="$(date -u +%Y%m%dT%H%M%SZ)"; OUT="$HERE/production/$1-$TS"
  while [ -e "$OUT" ]; do sleep 1; TS="$(date -u +%Y%m%dT%H%M%SZ)"; OUT="$HERE/production/$1-$TS"; done
  mkdir -p "$HERE/production" && chmod 700 "$HERE/production" 2>/dev/null
  mkdir -p "$OUT" && chmod 700 "$OUT" || exit 2
  ERR="$OUT/stderr.log"; : > "$ERR"
}

need_tools() {
  for t in "$@"; do command -v "$t" >/dev/null 2>&1 || stop "$t is not on PATH"; done
}

# require_clean_tree: nothing modified, nothing untracked. The ONLY untracked paths tolerated are the emulator
# results folders the rules gates read (hotfix/rules-20261101/results-<UTC>/, tests/results-rc2-<UTC>/); this
# folder's own production/ and RELEASE.txt are git-ignored (./.gitignore).
TOLERATED_UNTRACKED='^[?][?] (hotfix/rules-20261101/results-[0-9]{8}T[0-9]{6}Z/|tests/results-rc2-[0-9]{8}T[0-9]{6}Z/)$'
require_clean_tree() {
  need_tools git python3
  git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>>"$ERR" || stop "$REPO is not a git repository"
  local dirty
  git -C "$REPO" status --porcelain --untracked-files=normal > "$OUT/git-status.txt" 2>>"$ERR" || stop "git status failed"
  dirty="$(grep -vE "$TOLERATED_UNTRACKED" "$OUT/git-status.txt" | grep -c .)"
  if [ "$dirty" != 0 ]; then
    grep -vE "$TOLERATED_UNTRACKED" "$OUT/git-status.txt" | head -20 | sed 's/^/   /' | tee -a "$OUT/SUMMARY.txt"
    stop "the working tree has $dirty modified or untracked path(s); commit or stash them — only committed code is released"
  fi
  grep -qE "$TOLERATED_UNTRACKED" "$OUT/git-status.txt" && say "   (untracked emulator results folders tolerated: $(grep -cE "$TOLERATED_UNTRACKED" "$OUT/git-status.txt"))"
  return 0
}

# require_release: a clean working tree, HEAD equal to RELEASE.txt, and every TREE/FILE hash recorded there
# recomputed from HEAD. Sets HEAD_SHA, HEAD_SHORT, BASE_COMMIT. Copies RELEASE.txt into the evidence folder.
# Only committed code is ever deployed.
require_release() {
  [ -f "$RELEASE_TXT" ] || stop "RELEASE.txt not found — run ./make-release-txt.sh at the reviewed commit first"
  require_clean_tree
  $H release-check "$RELEASE_TXT" "$REPO" > "$OUT/release-check.txt" 2>>"$ERR" || stop "release-check failed (see stderr.log)"
  sed 's/^/   /' "$OUT/release-check.txt" | tee -a "$OUT/SUMMARY.txt"
  grep -q '^RELEASE ok$' "$OUT/release-check.txt" || stop "HEAD or a recorded tree differs from RELEASE.txt — regenerate it at the commit you mean to release, after review"
  cp "$RELEASE_TXT" "$OUT/RELEASE.txt"
  HEAD_SHA="$(sed -n 's/^HEAD=//p' "$RELEASE_TXT" | head -1)"
  HEAD_SHORT="$(printf '%s' "$HEAD_SHA" | cut -c1-7)"
  BASE_COMMIT="$(sed -n 's/^BASE_COMMIT=//p' "$RELEASE_TXT" | head -1)"
  check ok "clean working tree at HEAD $HEAD_SHORT = RELEASE.txt (branch $(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null))"
}

# gcloud identity, masked (the account is a person's address).
who() {
  say "gcloud: $(gcloud --version 2>>"$ERR" | head -1)   project: $(gcloud config get-value project 2>/dev/null)   account: $(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>>"$ERR" | sed -E 's/^(.).*@/\1***@/')"  #RO
}

# fn_state <file> <fn...>: one line per function (describe piped straight into the parser; never saved).
fn_state() {
  local file="$1"; shift; : > "$file"
  for f in "$@"; do
    local region="$REGION"; [ "$f" = "$WEEKLY" ] && region="$WEEKLY_REGION"
    gcloud functions describe "$f" --region "$region" --project "$P" --format=json 2>>"$ERR" | $H fn-describe - "$f" >> "$file"  #RO
  done
}

# fn_env_drift <file> <dotenv> <fn...>: same/DIFFERENT per environment variable name; values never shown.
fn_env_drift() {
  local file="$1" dotenv="$2"; shift 2; : > "$file"
  for f in "$@"; do
    local region="$REGION"; [ "$f" = "$WEEKLY" ] && region="$WEEKLY_REGION"
    gcloud functions describe "$f" --region "$region" --project "$P" --format=json 2>>"$ERR" | $H fn-describe - "$f" "$dotenv" | grep '^ENV ' >> "$file"  #RO
  done
}

# all_functions <file>: name, updateTime, status, generation of every function in the project.
all_functions() {
  gcloud functions list --project "$P" --format=json 2>>"$ERR" | $H fn-list - > "$1"  #RO
}

# service_state <file>: names, split, tags, template identity and env NAMES of zipper-api (values never saved).
service_state() {
  gcloud run services describe "$SERVICE" --project "$P" --region "$REGION" --format=json 2>>"$ERR" | $H run-service - > "$1"  #RO
}

# revision_state <file> <revision> [NAME=VALUE ...]: identity, conditions, env NAMES, value verdicts (values never saved).
revision_state() {
  local file="$1" rev="$2"; shift 2
  gcloud run revisions describe "$rev" --project "$P" --region "$REGION" --format=json 2>>"$ERR" | $H run-revision - "$@" > "$file"  #RO
}

# split_now <status|spec>: "NAME=PCT,..." of the live service, or LATEST-TARGET-PRESENT.
split_now() {
  gcloud run services describe "$SERVICE" --project "$P" --region "$REGION" --format='json(spec.traffic,status.traffic)' 2>>"$ERR" | $H traffic-split "$1" -  #RO
}

# hosting_live <file>: the live Hosting version of the CRM site (people's addresses in the JSON are never saved).
hosting_live() {
  ( cd "$REPO" && firebase hosting:channel:list --project "$P" --site "$HOSTING_SITE" --json 2>>"$ERR" ) | $H hosting-live - > "$1"  #RO
}

# since_utc <minutes>: an RFC3339 timestamp N minutes ago.
since_utc() {
  python3 -I -c "import datetime,sys; print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(minutes=int(sys.argv[1]))).strftime('%Y-%m-%dT%H:%M:%SZ'))" "$1"
}

# venv_py: the backend's own interpreter, run from backend/ with NO .env file read (ZIPPER_ENV_FILE points at an empty
# file), in production mode with the explicit acknowledgement app/core/isolation.py requires. The Firebase Admin
# credential is the key file the backend scripts already use (never opened or printed by any script here).
VENV_PY="$REPO/backend/.venv/bin/python"
venv_env() {
  EMPTY_ENV="$OUT/empty.env"; : > "$EMPTY_ENV"
  VENV_ENV="env ZIPPER_ENV_FILE=$EMPTY_ENV ENVIRONMENT=production FIREBASE_PROJECT_ID=$P ZIPPER_ALLOW_PRODUCTION_ACCESS=$P PYTHONPATH=. PYTHONDONTWRITEBYTECODE=1"
}

finish() {  # finish [hint-on-failure]
  say ""
  say "stderr lines: $(grep -c . "$ERR") (see stderr.log; it may name the operator account — do not share it)"
  if [ "$FAILS" = 0 ]; then say "RESULT: PASS"; else say "RESULT: $FAILS CHECK(S) FAILED${1:+ — $1}"; fi
  say "Saved: $OUT"
  [ "$FAILS" = 0 ] || exit 1
  exit 0   # always the end of the script: a "nothing to do" branch must never fall through to a confirm
}
