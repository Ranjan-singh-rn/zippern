# ZIPPER credential rotation — FINAL PHASE, PREPARED ONLY. Shared settings and helpers for rot-*.command (sourced,
# never run). bash 3.2 compatible (macOS). Defines no command that changes production: each script holds its own
# change lines. Every rot-*.command checks FINAL-PHASE-APPROVED itself, before sourcing this file.
P="zipper-83816"
REGION="asia-south1"
SERVICE="zipper-api"
RETIRED_REV="zipper-api-00048-pit"          # must never receive traffic
WEEKLY="weeklyPayoutReportGenerator"
AGORA_FN="generateAgoraToken"               # the only reader of AGORA_APP_CERTIFICATE (functions/.env)
AGORA_ENV="AGORA_APP_CERTIFICATE"
ROT_WINDOW_DAYS="${ROT_WINDOW_DAYS:-7}"     # rollback window before rot-90 may disable an old version

# Backend (zipper-api) environment variable -> the Secret Manager secret it must map (rot-80). Nothing else.
backend_secret_of() {
  case "$1" in
    JWT_SECRET|MONGO_URI|SERVICE_KEY_WEEKLY_ACCRUAL|SERVICE_KEY_REPORTING|SERVICE_KEY_PARTNER_REGISTRATION|OWNER_MFA_ENCRYPTION_KEY) echo "$1" ;;
    SENDGRID_API_KEY) echo "ZIPPER_SENDGRID_API_KEY" ;;
    *) echo "" ;;
  esac
}
# Functions-side Secret Manager secrets (rot-85): Firebase pins the newest ENABLED version at deploy time.
FN_SECRETS="ZIPPER_SENDGRID_API_KEY ZIPPER_ACCRUAL_KEY ZIPPER_REPORTING_KEY ZIPPER_PARTNER_REGISTRATION_KEY"
# Every secret rot-00 lists and rot-90/91 may disable/enable. SENDGRID_API_KEY = the OLD backend SendGrid secret.
ALL_SECRETS="ZIPPER_SENDGRID_API_KEY SENDGRID_API_KEY JWT_SECRET MONGO_URI SERVICE_KEY_WEEKLY_ACCRUAL SERVICE_KEY_REPORTING SERVICE_KEY_PARTNER_REGISTRATION ZIPPER_ACCRUAL_KEY ZIPPER_REPORTING_KEY ZIPPER_PARTNER_REGISTRATION_KEY OWNER_MFA_ENCRYPTION_KEY"

HERE="$(cd "$(dirname "$0")" && pwd -P)"            # …/zippern/release/rotation-prepared
case "$HERE" in */tools) HERE="$(cd "$HERE/.." && pwd -P)";; esac
REPO="$(cd "$HERE/../.." && pwd -P)"                # …/zippern
RELEASE_TXT="$REPO/release/completion-20261101/RELEASE.txt"   # the released commit; rotation deploys no other code
FN_ENV="$REPO/functions/.env"                       # copied into deploy trees only; never displayed or opened here
H="python3 -I $HERE/rot_helpers.py"

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
  mkdir -p "$HERE/production" && chmod 700 "$HERE/production" 2>/dev/null
  mkdir -p "$OUT" && chmod 700 "$OUT" || exit 2
  ERR="$OUT/stderr.log"; : > "$ERR"
}

need_tools() { for t in "$@"; do command -v "$t" >/dev/null 2>&1 || stop "$t is not on PATH"; done; }

who() {
  say "gcloud: $(gcloud --version 2>>"$ERR" | head -1)   project: $(gcloud config get-value project 2>/dev/null)   account: $(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>>"$ERR" | sed -E 's/^(.).*@/\1***@/')"  #RO
}

# require_clean: nothing modified or untracked, and HEAD = the commit recorded in the completion release's RELEASE.txt.
require_clean() {
  [ -f "$RELEASE_TXT" ] || stop "$RELEASE_TXT not found (rotation redeploys only the released commit)"
  need_tools git
  local dirty want
  dirty="$(git -C "$REPO" status --porcelain --untracked-files=normal 2>>"$ERR" | grep -c .)"
  if [ "$dirty" != 0 ]; then
    git -C "$REPO" status --short --untracked-files=normal 2>>"$ERR" | head -20 | sed 's/^/   /' | tee -a "$OUT/SUMMARY.txt"
    stop "the working tree has $dirty modified or untracked path(s) — rotation changes no code"
  fi
  HEAD_SHA="$(git -C "$REPO" rev-parse HEAD 2>>"$ERR")"
  want="$(sed -n 's/^HEAD=//p' "$RELEASE_TXT" | head -1)"
  [ -n "$want" ] && [ "$HEAD_SHA" = "$want" ] || stop "HEAD ${HEAD_SHA:0:12} is not the released commit ${want:0:12} (RELEASE.txt)"
  check ok "clean working tree at the released commit ${HEAD_SHA:0:12}"
}

# sunday_guard: no rotation within 2 hours of the Sunday financial runs (18:29 report / 19:00 release, UTC).
sunday_guard() {
  local dow hm; dow="$(date -u +%u)"; hm="$(date -u +%H%M)"
  if [ "$dow" = 7 ] && [ "$hm" -ge 1629 ] && [ "$hm" -le 2100 ]; then stop "within 2 hours of the Sunday financial runs — try later"; fi
}

service_state() {
  gcloud run services describe "$SERVICE" --project "$P" --region "$REGION" --format=json 2>>"$ERR" | $H run-service - > "$1"  #RO
}
revision_state() {
  gcloud run revisions describe "$2" --project "$P" --region "$REGION" --format=json 2>>"$ERR" | $H run-revision - > "$1"  #RO
}
split_now() {
  gcloud run services describe "$SERVICE" --project "$P" --region "$REGION" --format=json 2>>"$ERR" | $H traffic-split "$1" -  #RO
}
# latest_enabled <secret>: the highest ENABLED version number ("none" if there is none). Metadata only.
latest_enabled() {
  gcloud secrets versions list "$1" --project "$P" --format=json 2>>"$ERR" | $H versions - > "$OUT/versions-$1.txt"  #RO
  sed -n 's/^LATEST-ENABLED //p' "$OUT/versions-$1.txt"
}
# fn_index <file>: one IDX line per function: name, region, secrets (KEY:VERSION), env NAMES. Values never saved.
fn_index() {
  gcloud functions list --project "$P" --format=json 2>>"$ERR" | $H fn-index - > "$1"  #RO
}
fn_list() {
  gcloud functions list --project "$P" --format=json 2>>"$ERR" | $H fn-list - > "$1"  #RO
}
# fn_describe <region> <name> [dotenv]: FN line (+ ENV verdicts against the dotenv, hashed, never shown).
fn_describe() {
  gcloud functions describe "$2" --region "$1" --project "$P" --format=json 2>>"$ERR" < /dev/null | $H fn-describe - "$2" ${3:+"$3"}  #RO
}

finish() {
  say ""
  say "stderr lines: $(grep -c . "$ERR") (see stderr.log; it may name the operator account — do not share it)"
  if [ "$FAILS" = 0 ]; then say "RESULT: PASS"; else say "RESULT: $FAILS CHECK(S) FAILED${1:+ — $1}"; fi
  say "Saved: $OUT"
  [ "$FAILS" = 0 ] || exit 1
  exit 0
}
