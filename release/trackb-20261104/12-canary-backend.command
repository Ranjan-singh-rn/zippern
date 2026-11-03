#!/bin/bash
# ZIPPER Track B release — 12: move ONE canary step of production traffic to the Track B revision, BY NAME.
# Usage:  12-canary-backend.command <10|50|100|back>
# NEW and BASE come from ./production/backend-revision.txt (written by 11): NEW = the Track B revision, BASE = the
# revision that was serving 100% when 11 ran (the completion revision zipper-api-00057-xiq). Production effect: the split of zipper-api becomes NEW=10/BASE=90,
# NEW=50/BASE=50 or NEW=100, in that order only (each step requires the previous one to be live and, for 50 and 100,
# a 13-canary-monitor-readonly.command run that said CONTINUE after the previous step), or `back`: BASE=100 from
# any split that gives NEW traffic. Nothing else changes. Words: CANARY10, CANARY50, CANARY100, BACK.
# Automatic rollback: if within 120 s the split is not exactly as requested or NEW is not Ready, Active and
# ResourcesAvailable, traffic is pinned back to BASE=100 (the second allowed line). Manual rollback at any time:
# 19-rollback-backend.command or `back`. Never --to-latest. Results: ./production/12-canary-<pct>-<UTC>/
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
verify_scripts
PCT="${1:-}"
case "$PCT" in 10|50|100|back) ;; *) echo "Usage: $0 <10|50|100|back>" >&2; exit 2 ;; esac
new_out "12-canary-$PCT"
need_tools gcloud python3 git

say "ZIPPER Track B release — 12 canary step $PCT   $TS"
who
require_release
[ -f "$STATE_BACKEND" ] || stop "$STATE_BACKEND does not exist (run 11 first)"
NEW="$(sed -n 's/^name=//p' "$STATE_BACKEND" | head -1)"; WANT_DIG="$(sed -n 's/^digest=//p' "$STATE_BACKEND" | head -1)"; BASE="$(sed -n 's/^base=//p' "$STATE_BACKEND" | head -1)"
NAME_RE='^zipper-api-[0-9]{5}-[a-z0-9]{3}$'
printf '%s' "$NEW" | grep -Eq "$NAME_RE" && printf '%s' "$BASE" | grep -Eq "$NAME_RE" || stop "bad revision names in backend-revision.txt"
printf '%s' "$WANT_DIG" | grep -Eq '^sha256:[0-9a-f]{64}$' || stop "bad digest in backend-revision.txt"
[ "$NEW" != "$RETIRED_REV" ] && [ "$BASE" != "$RETIRED_REV" ] && [ "$NEW" != "$BASE" ] || stop "$RETIRED_REV must never receive traffic, and NEW must differ from BASE"
REC_HEAD="$(sed -n 's/^head=//p' "$STATE_BACKEND" | head -1)"
backend_record_ok "$REC_HEAD" || stop "backend-revision.txt was written for $(printf '%s' "$REC_HEAD" | cut -c1-12): not RELEASE.txt's HEAD, nor an ancestor of it with the same backend/ tree"
[ "$REC_HEAD" = "$HEAD_SHA" ] || say "   note: backend-revision.txt was written at $(printf '%s' "$REC_HEAD" | cut -c1-7); HEAD $HEAD_SHORT has the same backend/ tree"
say "NEW=$NEW (digest ${WANT_DIG:0:19}…)  BASE=$BASE"

LIVE_DIG="$(gcloud run revisions describe "$NEW" --project "$P" --region "$REGION" --format='value(status.imageDigest)' 2>>"$ERR")"; LIVE_DIG="${LIVE_DIG##*@}"  #RO
[ "$LIVE_DIG" = "$WANT_DIG" ] || stop "$NEW image digest is not the recorded one. Nothing changed."
check ok "$NEW carries the recorded image digest"

sorted_split() { printf '%s\n' "$@" | LC_ALL=C sort | paste -sd, -; }
case "$PCT" in
  10)  PREV="$(sorted_split "$BASE=100")";           WANT="$(sorted_split "$NEW=10" "$BASE=90")";  WORD=CANARY10 ;;
  50)  PREV="$(sorted_split "$NEW=10" "$BASE=90")";  WANT="$(sorted_split "$NEW=50" "$BASE=50")";  WORD=CANARY50 ;;
  100) PREV="$(sorted_split "$NEW=50" "$BASE=50")";  WANT="$(sorted_split "$NEW=100")";            WORD=CANARY100 ;;
  back) PREV="any split giving $NEW traffic";       WANT="$(sorted_split "$BASE=100")";           WORD=BACK ;;
esac
NOW_STATUS="$(split_now status)"; NOW_SPEC="$(split_now spec)"
say "current split: status $NOW_STATUS | spec $NOW_SPEC"

# The single pin-back line, used by `back` and by the automatic rollback when verification fails.
pin_back() {
  gcloud run services update-traffic zipper-api --project zipper-83816 --region asia-south1 --to-revisions "$BASE=100" > "$OUT/pin-back.txt" 2>&1  #MUT-CANARY-BACK
  say "pin-back exit code: $?"
}

if [ "$PCT" = back ]; then
  printf '%s' "$NOW_STATUS" | grep -Eq "(^|,)$NEW=[0-9]+" || stop "$NEW has no traffic; nothing to roll back. Nothing changed."
  confirm BACK "pin 100% of zipper-api traffic back to $BASE (NEW $NEW keeps existing at 0%)"
  pin_back
  AFTER="$(split_now status)"
  [ "$AFTER" = "$WANT" ] && check ok "rolled back: $AFTER" || check "$AFTER" "status split is $WANT"
  finish; exit 0
fi
[ "$NOW_STATUS" = "$PREV" ] && [ "$NOW_SPEC" = "$PREV" ] || stop "the current split is not the previous step ($PREV). Nothing changed."
check ok "previous step is live ($PREV)"

# Monitoring gate for 50 and 100: the newest 13 run must be newer than the previous canary step and say CONTINUE.
if [ "$PCT" != 10 ]; then
  case "$PCT" in 50) PREVPCT=10;; 100) PREVPCT=50;; esac
  LAST_STEP="$(ls -d "$HERE/production/12-canary-$PREVPCT-"*Z 2>/dev/null | LC_ALL=C sort | tail -1)"
  LAST_MON="$(ls -d "$HERE/production/13-monitor-"*Z 2>/dev/null | LC_ALL=C sort | tail -1)"
  [ -n "$LAST_STEP" ] && [ -n "$LAST_MON" ] || stop "no 13-canary-monitor-readonly.command run found after the $PREVPCT% step"
  [ "$(basename "$LAST_MON" | sed 's/.*-//')" \> "$(basename "$LAST_STEP" | sed 's/.*-//')" ] || stop "the newest monitor run ($(basename "$LAST_MON")) is older than the $PREVPCT% step ($(basename "$LAST_STEP"))"
  grep -q '^RESULT: CONTINUE' "$LAST_MON/SUMMARY.txt" 2>/dev/null || stop "the newest monitor run did not say CONTINUE ($(grep '^RESULT' "$LAST_MON/SUMMARY.txt" 2>/dev/null | head -1))"
  check ok "monitor $(basename "$LAST_MON") said CONTINUE after the $PREVPCT% step"
fi

confirm "$WORD" "set zipper-api traffic to $WANT (by revision name; never --to-latest)"
say "== setting $WANT (started $(date -u +%H:%M:%SZ))"
case "$PCT" in
  10)  gcloud run services update-traffic zipper-api --project zipper-83816 --region asia-south1 --to-revisions "$NEW=10,$BASE=90" > "$OUT/set-traffic.txt" 2>&1 ;;  #MUT-CANARY-10
  50)  gcloud run services update-traffic zipper-api --project zipper-83816 --region asia-south1 --to-revisions "$NEW=50,$BASE=50" > "$OUT/set-traffic.txt" 2>&1 ;;  #MUT-CANARY-50
  100) gcloud run services update-traffic zipper-api --project zipper-83816 --region asia-south1 --to-revisions "$NEW=100" > "$OUT/set-traffic.txt" 2>&1 ;;  #MUT-CANARY-100
esac
say "update-traffic exit code: $?"

say ""; say "== verification (up to 120 s): split exact in spec and status; $NEW Ready, Active and ResourcesAvailable"
OK=no
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  S1="$(split_now status)"; S2="$(split_now spec)"
  C="$(gcloud run revisions describe "$NEW" --project "$P" --region "$REGION" --format='json(status.conditions)' 2>>"$ERR" | $H rev-cond -)"  #RO
  say "   check $i: status $S1 | spec $S2 | $NEW: $C"
  if [ "$S1" = "$WANT" ] && [ "$S2" = "$WANT" ] && [ "$C" = ok ]; then OK=yes; break; fi
  sleep 10
done
if [ "$OK" = yes ]; then
  check ok "CANARY STEP $PCT% LIVE ($WANT). Start the monitoring window: 13-canary-monitor-readonly.command <minutes>"
else
  check "verification failed within 120 s" "canary step $PCT% live"
  say "pinning traffic back to $BASE=100"
  pin_back
  say "after pin-back: status $(split_now status)"
fi
finish
