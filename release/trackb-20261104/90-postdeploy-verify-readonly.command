#!/bin/bash
# ZIPPER Track B release — 90: READ-ONLY post-deploy verification. Usage: 90-postdeploy-verify-readonly.command [minutes]
# Production effect: none (describes, lists, the read-only rules/Android readers, and log COUNTS — no log text is read
# or saved). Prints one table (also TABLE.txt):
#   Cloud Run   traffic 100% by name (spec and status) on the release revision (11) — after a later step 9b on the
#               Owner-MFA enforcement revision of ./production/enforce-revision.txt — no latestRevision target, no tag,
#               the retired revision without traffic, the revision Ready with the recorded image digest; Owner MFA
#               enforcement (OWNER_MFA_REQUIRED=true) is checked only once enforce-revision.txt exists (45/46 are a
#               separate decision, not part of this release: an INFO row until then)
#   Functions   every wave A/B function ACTIVE, its version, and whether it is the version 20/21 recorded
#   Secrets/IAM ZIPPER_SENDGRID_API_KEY enabled with the backend and Functions grants; the Storage agent role
#   Rules       live Firestore and Storage sha256 = firestore.rules / storage.rules of RELEASE.txt
#   Hosting     the live version = ./production/crm-live.txt
#   Android     appConfig/androidUpdate.debug versionCode >= 21 and minSupportedVersionCode >= 21
#   Monitoring  the channel, the uptime check and the three policies of 70 (if the alpha/beta components exist)
#   Logs        last N minutes (default 1440, max 43200): backend ERROR entries and 5xx answers, Functions ERROR entries,
#               mail accepted / failed (backend), mail sent / failed (Functions), replica_drift alert mails
# PASS/FAIL rows decide the RESULT; INFO rows are counts, REVIEW rows are non-zero failure counts to look at.
# Results: ./production/90-verify-<UTC>/
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
verify_scripts
MIN="${1:-1440}"
case "$MIN" in ''|*[!0123456789]*|0*) MIN_OK=no ;; *) MIN_OK=yes ;; esac
{ [ "$MIN_OK" = yes ] && [ "${#MIN}" -le 5 ] && [ "$MIN" -le 43200 ]; } || { echo "Usage: $0 [minutes, 1-43200]" >&2; exit 2; }
new_out 90-verify
need_tools gcloud firebase python3 git shasum

say "ZIPPER Track B release — 90 post-deploy verification (read-only)   $TS   log window: last $MIN min"
who
require_release
TABLE="$OUT/TABLE.txt"; : > "$TABLE"
row() {  # row <PASS|FAIL|INFO|REVIEW> <what> <expected> <actual>
  printf '%-6s  %-46s  %-30s  %s\n' "$1" "$2" "$3" "$4" >> "$TABLE"
  [ "$1" = FAIL ] && FAILS=$((FAILS + 1))
  return 0
}
cmp_row() { if [ "$2" = "$3" ]; then row PASS "$1" "$2" "$3"; else row FAIL "$1" "$2" "${3:-none}"; fi; }  # cmp_row <what> <expected> <actual>

# ── Cloud Run ──
NEW=""; WANT_DIG=""
[ -f "$STATE_BACKEND" ] && { NEW="$(sed -n 's/^name=//p' "$STATE_BACKEND" | head -1)"; WANT_DIG="$(sed -n 's/^digest=//p' "$STATE_BACKEND" | head -1)"; }
# after step 9b: the enforcement revision (45: the completion revision's image + OWNER_MFA_REQUIRED=true) serves instead
[ -f "$STATE_ENFORCE" ] && { NEW="$(sed -n 's/^name=//p' "$STATE_ENFORCE" | head -1)"; WANT_DIG="$(sed -n 's/^digest=//p' "$STATE_ENFORCE" | head -1)"; }
service_state "$OUT/service.txt"
cmp_row "run: traffic (status)" "${NEW:-<backend-revision.txt>}=100" "$(sed -n 's/^TRAFFIC status //p' "$OUT/service.txt")"
cmp_row "run: traffic (spec)" "${NEW:-<backend-revision.txt>}=100" "$(sed -n 's/^TRAFFIC spec //p' "$OUT/service.txt")"
cmp_row "run: tags" "none" "$(sed -n 's/^TAGS //p' "$OUT/service.txt")"
grep -q "$RETIRED_REV=" "$OUT/service.txt" && row FAIL "run: $RETIRED_REV traffic" "none" "HAS TRAFFIC" || row PASS "run: $RETIRED_REV traffic" "none" "none"
if [ -n "$NEW" ]; then
  revision_state "$OUT/revision-new.txt" "$NEW" OWNER_MFA_REQUIRED=true
  REVLINE="$(grep '^REV ' "$OUT/revision-new.txt")"
  case "$REVLINE" in *" ready=True active=True "*) row PASS "run: $NEW ready/active" "True/True" "True/True";; *) row FAIL "run: $NEW ready/active" "True/True" "see revision-new.txt";; esac
  cmp_row "run: $NEW image digest" "$(printf '%s' "$WANT_DIG" | cut -c1-19)…" "$(printf '%s' "$REVLINE" | sed -n 's/.* digest=\([^ ]*\) .*/\1/p' | cut -c1-19)…"
  if [ -f "$STATE_ENFORCE" ]; then
    grep -q '^VALUE OWNER_MFA_REQUIRED expected$' "$OUT/revision-new.txt" && row PASS "run: Owner MFA enforced (OWNER_MFA_REQUIRED)" "true" "true" \
      || row FAIL "run: Owner MFA enforced (OWNER_MFA_REQUIRED)" "true (45/46 ran)" "$(sed -n 's/^VALUE OWNER_MFA_REQUIRED //p' "$OUT/revision-new.txt")"
  else
    row INFO "run: Owner MFA enforcement (45/46)" "separate decision" "not enforced ($(sed -n 's/^VALUE OWNER_MFA_REQUIRED //p' "$OUT/revision-new.txt"))"
  fi
fi

# ── Functions ──
fn_state "$OUT/functions.txt" $WAVE_2A $WAVE_2B
LAST20="$(ls -d "$HERE/production/20-functions-2a-"*Z 2>/dev/null | LC_ALL=C sort | tail -1)"
LAST21="$(ls -d "$HERE/production/21-functions-2b-"*Z 2>/dev/null | LC_ALL=C sort | tail -1)"
for f in $WAVE_2A $WAVE_2B; do
  line="$(grep "^FN $f " "$OUT/functions.txt")"
  st="$(printf '%s' "$line" | sed -n 's/.* status=\([^ ]*\) .*/\1/p')"; ver="$(printf '%s' "$line" | sed -n 's/.* version=\([^ ]*\) .*/\1/p')"
  case " $WAVE_2B " in *" $f "*) ev="$LAST21";; *) ev="$LAST20";; esac
  rec="$(grep "^FN $f " "$ev/functions-after.txt" 2>/dev/null | sed -n 's/.* version=\([^ ]*\) .*/\1/p')"
  if [ -z "$rec" ]; then row INFO "fn: $f" "ACTIVE (no 20/21 record)" "${st:-?} v${ver:-?}"
  elif [ "$st" = ACTIVE ] && [ "$ver" = "$rec" ]; then row PASS "fn: $f" "ACTIVE v$rec" "$st v$ver"
  else row FAIL "fn: $f" "ACTIVE v$rec" "${st:-?} v${ver:-?}"; fi
done

# ── Secrets / IAM ──
gcloud secrets versions list "$SG_SECRET" --project "$P" --format=json 2>>"$ERR" | $H versions - > "$OUT/sg-versions.txt"  #RO
row INFO "secret: $SG_SECRET enabled versions" ">= 1" "$(sed -n 's/^ENABLED //p' "$OUT/sg-versions.txt")"
gcloud secrets get-iam-policy "$SG_SECRET" --project "$P" --format=json 2>>"$ERR" | $H iam - > "$OUT/sg-iam.txt"  #RO
for sa in "$BACKEND_SA" "$FN_SA"; do
  grep -q "^BINDING roles/secretmanager.secretAccessor serviceAccount:$sa\$" "$OUT/sg-iam.txt" && row PASS "secret: accessor $(printf '%s' "$sa" | cut -c1-24)…" "granted" "granted" || row FAIL "secret: accessor $(printf '%s' "$sa" | cut -c1-24)…" "granted" "missing"
done
gcloud projects get-iam-policy "$P" --format=json 2>>"$ERR" | $H project-sa-roles - "$STORAGE_AGENT" > "$OUT/agent-roles.txt"  #RO
grep -q "$STORAGE_ROLE" "$OUT/agent-roles.txt" && row PASS "iam: storage agent firestoreServiceAgent" "present" "present" || row FAIL "iam: storage agent firestoreServiceAgent" "present" "missing"

# ── Rules (live text hashes) ──
venv_env
for kind in firestore storage; do
  want="$(sed -n "s/^FILE $kind.rules //p" "$RELEASE_TXT")"; got=""
  if [ -x "$VENV_PY" ]; then
    ( cd "$REPO/backend" && $VENV_ENV "$VENV_PY" "$HERE/tools/live_rules.py" get "$kind" "$OUT/live-$kind.rules" ) > "$OUT/live-$kind.txt" 2>>"$ERR"  #RO
    got="$(sed -n 's/^LIVE-SHA //p' "$OUT/live-$kind.txt")"
  fi
  cmp_row "rules: live $kind sha256" "$(printf '%s' "$want" | cut -c1-16)…" "$(printf '%s' "${got:-unreadable}" | cut -c1-16)…"
done

# ── Hosting ──
hosting_live "$OUT/hosting.txt"
cmp_row "hosting: live $HOSTING_SITE version" "$(sed -n 's/^version=//p' "$STATE_CRM" 2>/dev/null | head -1)" "$(sed -n 's/.* version=\([^ ]*\) .*/\1/p' "$OUT/hosting.txt")"

# ── Android ──
if [ -x "$VENV_PY" ]; then
  ( cd "$REPO/backend" && $VENV_ENV "$VENV_PY" "$HERE/tools/android_update_doc.py" get "$OUT/android-update.json" ) > "$OUT/android-get.log" 2>>"$ERR"  #RO
fi
$H android-doc-check "$OUT/android-update.json" "$APK_CHANNEL" "$APK_MIN_SUPPORTED" > "$OUT/android-check.txt" 2>>"$ERR"
cmp_row "android: $APK_CHANNEL code/min >= $APK_MIN_SUPPORTED" "ok" "$(sed -n 's/^ANDROID-CHECK //p' "$OUT/android-check.txt")"

# ── Monitoring (70) ──
gcloud alpha monitoring policies list --project "$P" --format=json 2>>"$ERR" | $H mon-policies - > "$OUT/policies.tsv"  #RO
PRC=${PIPESTATUS[0]}
gcloud monitoring uptime list-configs --project "$P" --format=json 2>>"$ERR" | $H mon-uptime - > "$OUT/uptime.tsv"  #RO
URC=${PIPESTATUS[0]}
if [ "$PRC$URC" = 00 ]; then
  for d in "ZIPPER api health uptime failed" "ZIPPER backend 5xx (log)" "ZIPPER functions errors (log)"; do
    awk -F'\t' -v d="$d" '$1=="POLICY" && $3==d && $4=="True" {f=1} END {exit !f}' "$OUT/policies.tsv" && row PASS "monitor: $d" "enabled" "enabled" || row FAIL "monitor: $d" "enabled" "missing"
  done
  awk -F'\t' '$1=="UPTIME" && $3=="zipper-api-health" {f=1} END {exit !f}' "$OUT/uptime.tsv" && row PASS "monitor: uptime zipper-api-health" "present" "present" || row FAIL "monitor: uptime zipper-api-health" "present" "missing"
else
  row INFO "monitor: policies/uptime" "readable" "not readable (alpha component?)"
fi

# ── Logs: counts only, last $MIN minutes ──
count() {  # count <filter>: number of matching entries (capped at 1000)
  gcloud logging read "$1" --project "$P" --freshness="${MIN}m" --limit 1000 --format='value(timestamp)' 2>>"$ERR" | grep -c .  #RO
}
info_row() {  # info_row <what> <n> [review-if-nonzero]
  local v="$2"; [ "$v" = 1000 ] && v=">=1000"
  if [ -n "${3:-}" ] && [ "$2" != 0 ]; then row REVIEW "$1" "0" "$v"; else row INFO "$1" "-" "$v"; fi
}
RUN='resource.type="cloud_run_revision" AND resource.labels.service_name="zipper-api"'
FNS='(resource.type="cloud_function" OR (resource.type="cloud_run_revision" AND resource.labels.service_name!="zipper-api"))'
info_row "logs: backend ERROR entries" "$(count "$RUN AND severity>=ERROR AND NOT logName:\"run.googleapis.com%2Frequests\"")" review
info_row "logs: backend 5xx answers" "$(count "$RUN AND httpRequest.status>=500")" review
info_row "logs: functions ERROR entries" "$(count "$FNS AND severity>=ERROR")" review
info_row "logs: backend mail accepted" "$(count "$RUN AND textPayload:\"accepted (\"")"
info_row "logs: backend mail failed/not sent" "$(count "$RUN AND (textPayload:\"FAILED (HTTP\" OR textPayload:\"not sent\")")" review
info_row "logs: functions mail sent" "$(count "$FNS AND (jsonPayload.message:\"transactional mail sent\" OR jsonPayload.message:\"Email sent\" OR textPayload:\"transactional mail sent\")")"
info_row "logs: functions mail failed" "$(count "$FNS AND (jsonPayload.message:\"transactional mail failed\" OR jsonPayload.message:\"SendGrid error\" OR textPayload:\"transactional mail failed\")")" review
info_row "logs: replica_drift alert mails" "$(count "$RUN AND textPayload:\"alert.replica_drift\"")" review

say ""
printf '%-6s  %-46s  %-30s  %s\n' VERDICT CHECK EXPECTED ACTUAL | tee -a "$OUT/SUMMARY.txt"
tee -a "$OUT/SUMMARY.txt" < "$TABLE"
say "   PASS $(grep -c '^PASS' "$TABLE")  FAIL $(grep -c '^FAIL' "$TABLE")  REVIEW $(grep -c '^REVIEW' "$TABLE")  INFO $(grep -c '^INFO' "$TABLE")"
finish "see the FAIL rows; rollbacks per step in RUNBOOK.md"
