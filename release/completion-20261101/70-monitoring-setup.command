#!/bin/bash
# ZIPPER completion release — 70: monitoring. Idempotent: creates only what is missing, matched by display name.
#   channel  "ZIPPER release alerts"  e-mail notification channel; the address is TYPED by you here (never printed,
#                                     never saved — only masked); an existing channel of that name is reused
#   uptime   "zipper-api-health"      https://zipperlive.web.app/api/health every 5 min, body must contain "status":"ok"
#                                     (Hosting /api/** → Cloud Run zipper-api: the path the app and CRM use)
#   policy   "ZIPPER api health uptime failed"   the uptime check failing for 5 min
#   policy   "ZIPPER backend 5xx (log)"          any zipper-api request answered 5xx (log match, max 1 mail / 5 min)
#   policy   "ZIPPER functions errors (log)"     any Cloud Function log entry ERROR or worse (log match, 1 / 5 min)
# Production change (after you type MONITOR), exactly these, each only if missing:
#   gcloud beta monitoring channels create --project zipper-83816 --display-name="ZIPPER release alerts" --type=email --channel-labels=email_address=<typed>
#   gcloud monitoring uptime create zipper-api-health --project zipper-83816 --resource-type=uptime-url --resource-labels=host=zipperlive.web.app,project_id=zipper-83816 --protocol=https --path=/api/health --period=5 --timeout=10 --matcher-content='"status":"ok"' --matcher-type=contains-string
#   gcloud alpha monitoring policies create --project zipper-83816 --policy-from-file=<evidence>/policy-<kind>.json   (rel_helpers.py policy-json)
# Nothing is changed in the service, Functions, rules or IAM. Needs the gcloud alpha and beta components.
# Rollback (separate approval): delete the created objects in the console or with APPROVAL-COMMANDS.txt MONITOR-REMOVE.
# Results: ./production/70-monitoring-<UTC>/ (the typed address is never written there)
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
verify_scripts
new_out 70-monitoring
need_tools gcloud python3 git

CH_DISPLAY="ZIPPER release alerts"; UP_DISPLAY="zipper-api-health"
POL_UPTIME="ZIPPER api health uptime failed"; POL_5XX="ZIPPER backend 5xx (log)"; POL_FN="ZIPPER functions errors (log)"
say "ZIPPER completion release — 70 monitoring setup   $TS"
who
require_release

read_state() {  # read_state <suffix>: channels, uptime checks and policies (masked, tab-separated)
  gcloud alpha monitoring policies list --project "$P" --format=json 2>>"$ERR" | $H mon-policies - > "$OUT/policies-$1.tsv"  #RO
  PRC=${PIPESTATUS[0]}
  gcloud beta monitoring channels list --project "$P" --format=json 2>>"$ERR" | $H mon-channels - > "$OUT/channels-$1.tsv"  #RO
  CRC=${PIPESTATUS[0]}
  gcloud monitoring uptime list-configs --project "$P" --format=json 2>>"$ERR" | $H mon-uptime - > "$OUT/uptime-$1.tsv"  #RO
  URC=${PIPESTATUS[0]}
  [ "$PRC$CRC$URC" = 000 ] || stop "Monitoring not readable (policies $PRC, channels $CRC, uptime $URC) — install the Cloud SDK alpha and beta components, or check that the Monitoring API is enabled"
  CH_NAME="$(awk -F'\t' -v d="$CH_DISPLAY" '$1=="CHANNEL" && $3=="email" && $4==d {print $2; exit}' "$OUT/channels-$1.tsv")"
  UP_NAME="$(awk -F'\t' -v d="$UP_DISPLAY" '$1=="UPTIME" && $3==d {print $2; exit}' "$OUT/uptime-$1.tsv")"
}
has_policy() { awk -F'\t' -v d="$1" '$1=="POLICY" && $3==d {f=1} END {exit !f}' "$OUT/policies-$2.tsv"; }
read_state before
say "   channel '$CH_DISPLAY': ${CH_NAME:-missing}   uptime '$UP_DISPLAY': ${UP_NAME:-missing}"
PLAN=""
[ -n "$CH_NAME" ] || PLAN="$PLAN channel"
[ -n "$UP_NAME" ] || PLAN="$PLAN uptime"
for k in uptime backend-5xx functions-errors; do
  case $k in uptime) d="$POL_UPTIME";; backend-5xx) d="$POL_5XX";; functions-errors) d="$POL_FN";; esac
  has_policy "$d" before && say "   policy '$d': present" || { say "   policy '$d': missing"; PLAN="$PLAN policy:$k"; }
done
[ -n "$PLAN" ] || { check ok "every monitoring object is present — nothing to create"; finish; }

EMAIL=""; MASKED=""
if [ -z "$CH_NAME" ]; then
  printf 'Type the e-mail address that should receive the alerts (it is not printed or saved): '
  read -r EMAIL
  printf '%s' "$EMAIL" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' || stop "that is not an e-mail address"
  MASKED="$(printf '%s' "$EMAIL" | sed -E 's/^(.)[^@]*@/\1***@/')"
fi
confirm MONITOR "create in $P:$PLAN${MASKED:+ (channel address $MASKED)}"

if [ -z "$CH_NAME" ]; then
  CH_NAME="$(gcloud beta monitoring channels create --project zipper-83816 --display-name="ZIPPER release alerts" --type=email --channel-labels="email_address=$EMAIL" --format=json 2>>"$ERR" | $H first-name -)"  #MUT-MON-CHANNEL
  EMAIL=""
  printf '%s' "$CH_NAME" | grep -q '/notificationChannels/' && check ok "channel created: $CH_NAME ($MASKED)" || stop "the channel was not created (stderr.log); nothing else was created"
fi
if [ -z "$UP_NAME" ]; then
  UP_NAME="$(gcloud monitoring uptime create zipper-api-health --project zipper-83816 --resource-type=uptime-url --resource-labels=host=zipperlive.web.app,project_id=zipper-83816 --protocol=https --path=/api/health --period=5 --timeout=10 --matcher-content='"status":"ok"' --matcher-type=contains-string --format=json 2>>"$ERR" | $H first-name -)"  #MUT-MON-UPTIME
  printf '%s' "$UP_NAME" | grep -q '/uptimeCheckConfigs/' && check ok "uptime check created: $UP_NAME" || stop "the uptime check was not created (stderr.log)"
fi
CHECK_ID="${UP_NAME##*/}"
for k in $PLAN; do
  case $k in policy:*) ;; *) continue;; esac
  kind="${k#policy:}"
  $H policy-json "$kind" "$CH_NAME" "$CHECK_ID" > "$OUT/policy-$kind.json" || stop "policy-json $kind failed"
  gcloud alpha monitoring policies create --project zipper-83816 --policy-from-file="$OUT/policy-$kind.json" --format=none 2>>"$ERR"  #MUT-MON-POLICY
  rc=$?; [ $rc -eq 0 ] && check ok "policy created: $kind" || check "exit $rc" "policy created: $kind"
done

say ""; say "== After"
read_state after
[ -n "$CH_NAME" ] && check ok "channel '$CH_DISPLAY' present ($(awk -F'\t' -v n="$CH_NAME" '$2==n {print $6}' "$OUT/channels-after.tsv"))" || check missing "channel present"
awk -F'\t' -v d="$UP_DISPLAY" '$1=="UPTIME" && $3==d && $4=="zipperlive.web.app" && $5=="/api/health" {f=1} END {exit !f}' "$OUT/uptime-after.tsv" \
  && check ok "uptime check $UP_DISPLAY → https://zipperlive.web.app/api/health" || check "see uptime-after.tsv" "uptime check present"
for d in "$POL_UPTIME" "$POL_5XX" "$POL_FN"; do
  awk -F'\t' -v d="$d" '$1=="POLICY" && $3==d && $4=="True" {f=1} END {exit !f}' "$OUT/policies-after.tsv" \
    && check ok "policy '$d' present and enabled" || check "see policies-after.tsv" "policy '$d' present and enabled"
done
say "   confirm delivery once: Monitoring > Alerting > Edit notification channels > '$CH_DISPLAY' (test notification, if offered)"
finish
