# ZIPPER Track B release 20261104 — shared settings and helpers for the scripts in this folder (sourced, never run).
# Adapted from release/completion-20261101 (steps 0-6 of that release are live: backend zipper-api-00057-xiq at 100%,
# Functions wave 2a from cf64145, CRM Hosting bf4066501e5f593a, hotfix-1 rules + 1 Nov indexes). Its steps 7-11 were
# never run; this release supersedes them (APK 21 instead of APK 20, the RC2 rules carry the Track B hunks).
# bash 3.2 compatible (macOS). Defines no command that changes production; each script holds its own change lines.
P="zipper-83816"
REGION="asia-south1"
SERVICE="zipper-api"
EXPECT_SERVING="zipper-api-00057-xiq"       # serving 100% when this release was prepared: the completion revision (2 Nov)
EXPECT_TEMPLATE="zipper-api-00057-xiq"      # the service template = that same revision (no revision was created after it)
RETIRED_REV="zipper-api-00048-pit"          # rc1 revision 3 code: must never receive traffic
# Never deleted by anything here (nothing here deletes a revision): 00046-siw (20 Oct code), 00047-9cj (Owner-MFA key
# template), 00057-xiq (completion revision = this release's BASE, the backend rollback target of 19).
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
OLD_CRM_VERSION="bf4066501e5f593a"          # Hosting version live since 2 Nov (completion CRM at cf64145; console rollback target)
WEEKLY="weeklyPayoutReportGenerator"
WEEKLY_REGION="us-central1"

# Functions, by name. 157 exports at the release HEAD = the 104 production functions + 53 NEW ones. Every export is in
# exactly ONE of WAVE_2A (this release's "wave A"), WAVE_2B ("wave B"), NOT_REDEPLOYED; 20/21 enumerate the exports of the
# built deploy tree and refuse any other split (check_exports in rel_deploy_lib.sh). The internal names WAVE_2A/WAVE_2B
# and the 29 arguments 2a/2b are kept from the completion release; the evidence folders say which release ran them.
# What production runs today (4 Nov): the completion wave 2a (95 names) from cf64145 (2 Nov, 20-functions-2a-
# 20261102T120152Z); the completion wave 2b (8 names) and onHostInvitationWithdrawn from prod-live-20261030 (20 Oct).
# "Changed" = a file of the function's module import closure differs between the tree production runs and HEAD
# (git diff cf64145 / 4e21b7f -- functions/src, followed through the relative imports; index.ts counts for the functions
# defined in it). After a reviewed change here: tools/write-scripts-sha256.command, commit, make-release-txt.sh.
#
# WAVE A (20) — no new-client dependency:
#   changed since cf64145 (81): emailOtp/identity (#30 e-mail bind rescue), hosts/hostEligibility (#51/#49), mail
#   (#47 identities), quickLogin (B10 per-device cap of 5, forgetQuickLogin, restriction notice), party (B7 Party Pro
#   gate on PRIVATE rooms, PIN lockout, access log, official access, themes), wallet (B2 daily-reward history id),
#   profiles (B12 server start mark and duration), index.ts (e-mail support address, emulator-only loopback, the new
#   exports). An APK 19 keeps working: refusals are new error codes it shows as text; nothing it sends is rejected.
WAVE_2A_CHANGED="weeklyPayoutReportGenerator syncPublicProfile backfillPublicProfiles startMobileSession requestEmailBindCode \
requestLoginEmailCode onAgencyApproved onAgencyRegistered onSellerRegistered onSellerApproved onAgencyResendEmail \
onSellerResendEmail activateHost adoptEmailAccount bindVerifiedIdentity cancelPartySeatRequest \
checkPartnerActivation checkReferralCode claimDailyReward claimGuestIdentity convertBeans createPartyRoom \
dailyPlatformStatsAggregator decidePartySeatRequest endMobileSession endPartyRoom equipBagItem expireCosmetics \
findExistingAccount getHostHome invitePartySeat leavePartyRoom leavePartySeat mintQuickLoginToken \
myPartnerApplications myRoleAppeals onAgencyPhotoReplaced onApprovalApproved onPayoutApproved onRechargeApproved \
partnerEligibility partnerParents partnerVerificationState purchaseBagItem quickLoginChallenge redeemQuickLogin \
registerAgencyPartner registerSellerPartner reportContactConflict requestPartySeat resolveIdentity \
respondPartySeatInvite revokeQuickLogin revokeQuickLoginOnRestriction scheduledAlertScan scheduledDailyReports \
scheduledMonthlyReports scheduledPartnerStatements scheduledReconciliation scheduledTransactionalSweep \
scheduledWeeklyBusinessReport setCallRate setPartyAdmin setPartySeatLock setPartySeatMute submitAccountAppeal \
submitHostApplication submitHostCapture submitPartnerApplication submitRechargeRequest submitRoleAppeal \
sweepHostLevels sweepQuickLoginTokens syncLivePresence syncPhoneKey syncPublicSeller syncStorageRoleClaim \
takePartySeat updatePartyRoom verifyEmailBindCode verifyLoginEmailCode"
#   NEW (53): old apps never call them — games (OFF until the Owner switches a game on in appConfig/games), Party Pro
#   subscription, leaderboards settlement, live (viewer recount, sweep with a 12 h fuse for rooms without a heartbeat,
#   PK callables), party heartbeat and music, the account switcher's forgetQuickLogin and the restriction notice.
WAVE_2A_NEW="partyHeartbeat setPartyMusic gameCatalog createGameMatch joinGameMatch quickGameMatch ludoAction claimGameTimeout \
leaveGameMatch sweepGameMatches rematchGameMatch teenPattiAction teenPattiMyCards carromShot snakesRoll \
fourRowDrop playPlinko spinSlots castFishing chickenStart chickenStep chickenCashout crashStart crashPoll \
crashCashout gameFairness rotateGameSeed playDice tossCoin spinWheel playKeno playLimbo spinRoulette \
playDragonTiger playAndarBahar hiloStart hiloGuess hiloCashout minesStart minesReveal minesCashout \
privateRoomSubscriptionStatus subscribePrivateRooms cancelPrivateRoomSubscription renewPrivateRoomSubscriptions \
settleLeaderboards liveViewerCount sweepLiveRooms pkMatch pkRespond pkEnd quickLoginRestriction forgetQuickLogin"
WAVE_2A="$WAVE_2A_CHANGED $WAVE_2A_NEW"
# WAVE B (21) — needs APK 21 on the phones (60 publishes it with minSupportedVersionCode 21 first):
#   the completion wave 2b (8, still 20 Oct code): the new generateAgoraToken signs for a derived uid (APK 19 joins with
#   uid 0 and would be refused) and refuses viewers the host blocked; settleGift refuses a lucky gift without a combo
#   (APK 19 sends none), accrues rankings and PK scores; per-minute call billing belongs with the APK 21 call screen;
#   joinPartyRoom + sweepEmptyPartyRooms (B2a): the new join stamps lastSeenAt on the listener row and the new sweep
#   removes a listener whose lastSeenAt is 3 minutes old — APK 19 never sends the party heartbeat, so with BOTH live
#   every APK 19 listener would be dropped from the room after 3 minutes. Either one alone is harmless to APK 19.
WAVE_2B="generateAgoraToken settleGift startCall acceptCall tickCall endCall declineCall sweepStaleCalls joinPartyRoom sweepEmptyPartyRooms"
# Not redeployed (13): their code is unchanged since the tree production runs (accounts.ts, payouts.ts, push.ts,
# social.ts: unchanged since cf64145; invitationCleanup.ts: unchanged since the 20 Oct tree).
NOT_REDEPLOYED="releaseBeansForWeek getPayoutStatus purgeDeletedAccounts purgeMyAccountNow pushCallStatus pushChatMessage \
pushIncomingCall pushLiveStarted recoverAccount requestAccountDeletion syncMyRoles toggleLike \
onHostInvitationWithdrawn"
# Rollback bases (29), per function — what each one runs TODAY:
#   FN_BASE_LIVE: the 83 completion-wave-2a names this release redeploys -> back to LIVE_FN_COMMIT (cf64145)
#   FN_BASE_PROD: the 8 completion-wave-2b names -> back to PROD_FN_COMMIT (prod-live-20261030)
#   WAVE_2A_NEW: new in this release -> NOT rolled back (no older code exists; left in place, never deleted here)
FN_BASE_LIVE="weeklyPayoutReportGenerator syncPublicProfile backfillPublicProfiles startMobileSession requestEmailBindCode \
requestLoginEmailCode onAgencyApproved onAgencyRegistered onSellerRegistered onSellerApproved onAgencyResendEmail \
onSellerResendEmail activateHost adoptEmailAccount bindVerifiedIdentity cancelPartySeatRequest \
checkPartnerActivation checkReferralCode claimDailyReward claimGuestIdentity convertBeans createPartyRoom \
dailyPlatformStatsAggregator decidePartySeatRequest endMobileSession endPartyRoom equipBagItem expireCosmetics \
findExistingAccount getHostHome invitePartySeat joinPartyRoom leavePartyRoom leavePartySeat mintQuickLoginToken \
myPartnerApplications myRoleAppeals onAgencyPhotoReplaced onApprovalApproved onPayoutApproved onRechargeApproved \
partnerEligibility partnerParents partnerVerificationState purchaseBagItem quickLoginChallenge redeemQuickLogin \
registerAgencyPartner registerSellerPartner reportContactConflict requestPartySeat resolveIdentity \
respondPartySeatInvite revokeQuickLogin revokeQuickLoginOnRestriction scheduledAlertScan scheduledDailyReports \
scheduledMonthlyReports scheduledPartnerStatements scheduledReconciliation scheduledTransactionalSweep \
scheduledWeeklyBusinessReport setCallRate setPartyAdmin setPartySeatLock setPartySeatMute submitAccountAppeal \
submitHostApplication submitHostCapture submitPartnerApplication submitRechargeRequest submitRoleAppeal \
sweepEmptyPartyRooms sweepHostLevels sweepQuickLoginTokens syncLivePresence syncPhoneKey syncPublicSeller \
syncStorageRoleClaim takePartySeat updatePartyRoom verifyEmailBindCode verifyLoginEmailCode"
FN_BASE_PROD="generateAgoraToken settleGift startCall acceptCall tickCall endCall declineCall sweepStaleCalls"
EMAIL_FNS="requestEmailBindCode requestLoginEmailCode onAgencyApproved onAgencyRegistered onSellerRegistered onSellerApproved onAgencyResendEmail onSellerResendEmail"
# Functions declared without .region() run in us-central1 (Firebase's default region): the weekly report and the eight
# reporting schedulers. Every other function runs in asia-south1. fn_state / fn_env_drift describe each one in its
# region; 20/21 refuse if the compiled code declares another region for any function (check_exports).
FN_US_CENTRAL1="weeklyPayoutReportGenerator dailyPlatformStatsAggregator scheduledTransactionalSweep scheduledAlertScan \
scheduledReconciliation scheduledDailyReports scheduledWeeklyBusinessReport scheduledPartnerStatements scheduledMonthlyReports"

# The Functions tree the completion wave 2a runs (make-release-txt.sh -> RELEASE.txt LIVE_FN_COMMIT -> 29 for FN_BASE_LIVE):
# commit cf64145 (the completion release HEAD, deployed by 20-functions-2a-20261102T120152Z). Must be an ancestor of HEAD.
LIVE_FN_COMMIT="cf64145525c4e425da50abceac90be8f1717b403"
# Functions rollback base (make-release-txt.sh -> RELEASE.txt BASE_COMMIT -> 29 for FN_BASE_PROD): the exact production Functions tree,
# branch prod-live-20261030 = the 20 Oct baseline + the SendGrid wave-A files live since 30 Oct (tag
# prod-live-20261030-tag). Resolved ONLY by its full ref (a tag and a branch with the same base name once made the
# short name ambiguous) and only while it is still the reviewed commit. f1af30a is NOT production: its functions/
# carries the unshipped Owner-MFA gate (src/ownerMfa.ts, profiles.ts, storageClaims.ts) — refused by both scripts.
PROD_FN_REF="refs/heads/prod-live-20261030"
PROD_FN_COMMIT="4e21b7f14f7cafb01b8aacaf35368695a17d13e0"
NOT_PROD_FN_COMMIT="f1af30a1d64fb8f20403fd6e7da5633cfab1234c"

# Android (60/61): the prod build type, signed with the debug key, published to the "debug" channel (build.gradle.kts).
# APK 20 (1.2.6) was built but never published; APK 21 supersedes it. minSupportedVersionCode 21: the sign-in gate then
# refuses APK 19 and 20 sessions, and every phone is offered 21.
APK_VERSION_CODE=21
APK_VERSION_NAME="1.2.7"
APK_MIN_SUPPORTED=21
APK_CHANNEL="debug"
# The fleet's signing certificate: SHA-256 of its DER encoding (CN=Android Debug, O=Android, C=US), as tools/apk_cert.py
# reads it from the APK Signing Block. It is the key that signed APK 19 (1.2.5), i.e. the fleet's update identity: a phone
# installs an update only if it carries the installed app's certificate, so an APK signed with another Mac's debug key
# (also "CN=Android Debug") would be refused by every phone. 60 and LOCAL-VERIFY 6b (which reads this line with sed)
# refuse any other certificate.
FLEET_CERT_SHA256="4878a35fa2b4d8a0a6bcab84f22b66312385fe02523603ea23d3e190fc1948af"
APK_NOTES="ZIPPER 1.2.7: games lobby, live streaming upgrades with PK battles, coin seller tools, switch between your accounts, party room upgrades and animated gifts. This update is required."

# Backend (11): exactly these settings are added to the service template; everything else is inherited.
BACKEND_ENV_ADD="EMAIL_PROVIDER=sendgrid,SENDGRID_FROM_EMAIL=no-reply@zipperlive.org,SENDGRID_FROM_NAME=ZIPPER Live"

HERE="$(cd "$(dirname "$0")" && pwd -P)"            # …/zippern/release/trackb-20261104  (or its tools/ parent)
case "$HERE" in */tools) HERE="$(cd "$HERE/.." && pwd -P)";; esac
REPO="$(cd "$HERE/../.." && pwd -P)"                # …/zippern
RELEASE_TXT="$HERE/RELEASE.txt"
STATE_BACKEND="$HERE/production/backend-revision.txt"
STATE_CRM="$HERE/production/crm-live.txt"
STATE_ENFORCE="$HERE/production/enforce-revision.txt"   # 45: the Owner-MFA enforcement revision (name=) and its base=
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

# backend_record_ok <head= of backend-revision.txt>: the recorded revision was built for this release — the recorded
# commit is RELEASE.txt's HEAD, or an ancestor of it whose backend/ tree is identical (a later commit that changed no
# backend file, e.g. the 2 Nov deploy-crm.command fix, leaves the deployed revision the release's backend). After
# require_release. Prints nothing; returns 1 otherwise.
backend_record_ok() {
  local rec="$1" t_rec t_head
  [ -n "$rec" ] || return 1
  [ "$rec" = "$HEAD_SHA" ] && return 0
  git -C "$REPO" merge-base --is-ancestor "$rec" "$HEAD_SHA" 2>/dev/null || return 1
  t_rec="$(git -C "$REPO" rev-parse "$rec:backend" 2>/dev/null)"; t_head="$(git -C "$REPO" rev-parse "$HEAD_SHA:backend" 2>/dev/null)"
  [ -n "$t_head" ] && [ "$t_rec" = "$t_head" ]
}

# gcloud identity, masked (the account is a person's address).
who() {
  say "gcloud: $(gcloud --version 2>>"$ERR" | head -1)   project: $(gcloud config get-value project 2>/dev/null)   account: $(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>>"$ERR" | sed -E 's/^(.).*@/\1***@/')"  #RO
}

# fn_region <fn>: the region the function runs in (FN_US_CENTRAL1 above: us-central1; every other one: asia-south1).
fn_region() {
  case " $FN_US_CENTRAL1 " in *" $1 "*) printf '%s' "$WEEKLY_REGION";; *) printf '%s' "$REGION";; esac
}

# fn_state <file> <fn...>: one line per function (describe piped straight into the parser; never saved).
fn_state() {
  local file="$1"; shift; : > "$file"
  for f in "$@"; do
    gcloud functions describe "$f" --region "$(fn_region "$f")" --project "$P" --format=json 2>>"$ERR" | $H fn-describe - "$f" >> "$file"  #RO
  done
}

# fn_env_drift <file> <dotenv> <fn...>: same/DIFFERENT per environment variable name; values never shown.
fn_env_drift() {
  local file="$1" dotenv="$2"; shift 2; : > "$file"
  for f in "$@"; do
    gcloud functions describe "$f" --region "$(fn_region "$f")" --project "$P" --format=json 2>>"$ERR" | $H fn-describe - "$f" "$dotenv" | grep '^ENV ' >> "$file"  #RO
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

# enforce_state: NEW (the Owner-MFA enforcement revision), BASE (the release revision of 11 it was made from) and WANT_DIG
# from production/enforce-revision.txt (written by 45), validated: revision names, never the retired revision, NEW != BASE.
enforce_state() {
  [ -f "$STATE_ENFORCE" ] || stop "$STATE_ENFORCE does not exist (run 45 first)"
  NEW="$(sed -n 's/^name=//p' "$STATE_ENFORCE" | head -1)"; BASE="$(sed -n 's/^base=//p' "$STATE_ENFORCE" | head -1)"
  WANT_DIG="$(sed -n 's/^digest=//p' "$STATE_ENFORCE" | head -1)"
  printf '%s\n%s\n' "$NEW" "$BASE" | grep -Evq '^zipper-api-[0-9]{5}-[a-z0-9]{3}$' && stop "bad revision names in enforce-revision.txt"
  printf '%s' "$WANT_DIG" | grep -Eq '^sha256:[0-9a-f]{64}$' || stop "bad digest in enforce-revision.txt"
  [ "$NEW" != "$RETIRED_REV" ] && [ "$BASE" != "$RETIRED_REV" ] && [ "$NEW" != "$BASE" ] || stop "$RETIRED_REV must never receive traffic, and NEW must differ from BASE"
  say "NEW=$NEW (Owner MFA enforcement: OWNER_MFA_REQUIRED=true)  BASE=$BASE (release revision)"
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
