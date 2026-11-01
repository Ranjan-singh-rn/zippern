#!/bin/bash
# ZIPPER completion release — 13: READ-ONLY canary monitor. Usage: 13-canary-monitor-readonly.command [minutes]
# Production effect: none (logging reads and describes only; no token, no secret, no request to the service).
# It compares the completion revision NEW with its BASE (from ./production/backend-revision.txt) over the last N
# minutes (default 60; 1 to 43200 = 30 days, the default retention of the _Default log bucket) and prints, per
# revision, COUNTS ONLY: requests, 5xx, 4xx on /api/auth/signin and /api/auth/refresh, p95 latency, ERROR-severity
# application entries, and ERROR entries mentioning the watched modules (owner_mfa, deps, staff, money, email,
# observer). Log rows are aggregated in memory as they stream in; no URL, query string, IP, user agent, address or
# log text is written anywhere. Also counted on NEW: e-mails accepted / FAILED, balance-sync failures.
# Verdict: STOP (pin back: 19-rollback-backend.command or `12 back`), CONTINUE, or WAIT (too few requests yet).
# Thresholds (environment variables, defaults in brackets): MIN_REQ [200] requests on NEW before a rate is judged;
# RATE_X [2.0] NEW 5xx rate vs BASE; MIN_5XX [3]; AUTH_X [2.0] signin/refresh 4xx rate vs BASE with at least
# AUTH_MIN [5] such 4xx; LAT_X [1.5] p95 vs BASE (with at least 50 latency samples each); any ERROR from a watched
# module on NEW is a STOP. A log read that reaches its --limit leaves part of the window unread: never CONTINUE.
# 12 requires the newest run of this script to say CONTINUE before the 50% and 100% steps.
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
verify_scripts
MIN="${1:-60}"
case "$MIN" in ''|*[!0123456789]*|0*) MIN_OK=no ;; *) MIN_OK=yes ;; esac
{ [ "$MIN_OK" = yes ] && [ "${#MIN}" -le 5 ] && [ "$MIN" -le 43200 ]; } || { echo "Usage: $0 [minutes, 1-43200]" >&2; exit 2; }
new_out 13-monitor
need_tools gcloud python3 git

say "ZIPPER completion release — 13 canary monitor   $TS   window: last $MIN min"
require_release
[ -f "$STATE_BACKEND" ] || stop "$STATE_BACKEND does not exist (run 11 first)"
NEW="$(sed -n 's/^name=//p' "$STATE_BACKEND" | head -1)"; BASE="$(sed -n 's/^base=//p' "$STATE_BACKEND" | head -1)"
printf '%s\n%s\n' "$NEW" "$BASE" | grep -Evq '^zipper-api-[0-9]{5}-[a-z0-9]{3}$' && stop "bad revision names in backend-revision.txt"
say "NEW=$NEW  BASE=$BASE"
say "   live traffic: $(split_now status)"

gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\" AND logName=\"projects/$P/logs/run.googleapis.com%2Frequests\" AND (resource.labels.revision_name=\"$NEW\" OR resource.labels.revision_name=\"$BASE\")" \
  --project "$P" --freshness="${MIN}m" --limit 50000 --format='json(resource.labels.revision_name,httpRequest.status,httpRequest.latency,httpRequest.requestUrl)' 2>>"$ERR" \
  | $H agg-requests "$NEW" "$BASE" - > "$OUT/agg-requests.json"  #RO
gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\" AND severity>=ERROR AND NOT logName=\"projects/$P/logs/run.googleapis.com%2Frequests\" AND (resource.labels.revision_name=\"$NEW\" OR resource.labels.revision_name=\"$BASE\")" \
  --project "$P" --freshness="${MIN}m" --limit 5000 --format='json(resource.labels.revision_name,textPayload,jsonPayload.message)' 2>>"$ERR" \
  | $H agg-errors "$NEW" "$BASE" - > "$OUT/agg-errors.json"  #RO
$H monitor-verdict "$NEW" "$BASE" "$OUT/agg-requests.json" "$OUT/agg-errors.json" | tee -a "$OUT/SUMMARY.txt"

say ""; say "== NEW only, counts (content not read)"
for what in 'accepted (' 'FAILED (HTTP' 'not sent' 'balance sync failed' 'alert.replica_drift'; do
  n="$(gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.revision_name=\"$NEW\" AND textPayload:\"$what\"" --project "$P" --freshness="${MIN}m" --limit 500 --format='value(timestamp)' 2>>"$ERR" | grep -c .)"  #RO
  say "   '$what': $n"
done
say "Saved: $OUT"
