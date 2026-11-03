#!/bin/bash
# ZIPPER Track B release — 19: ROLLBACK of the backend canary. Pins 100% of zipper-api traffic back to the
# revision that was serving before 11 ran (BASE in ./production/backend-revision.txt; expected zipper-api-00057-xiq,
# the completion revision), BY NAME. Use it on any monitor STOP, or whenever traffic is found anywhere it should not be.
# Production change (after you type ROLLBACK), exactly:
#   gcloud run services update-traffic zipper-api --project zipper-83816 --region asia-south1 --to-revisions "$BASE=100"
# Immediate. Tags, revisions, images, environment variables, secrets, IAM and rules stay as they are; the Track B
# revision keeps existing at 0%. BASE carries the same SendGrid settings, so mail is unchanged; no redeploy is needed.
# After 50 (CRM) is live, a backend pin-back must be coordinated with the CRM rollback to Hosting bf4066501e5f593a
# (RUNBOOK.md) — the new CRM calls routes BASE does not have (coin-seller business, games reports). Never --to-latest.
# Results: ./production/19-rollback-backend-<UTC>/
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
verify_scripts
new_out 19-rollback-backend
need_tools gcloud python3 git

say "ZIPPER Track B release — 19 backend ROLLBACK (pin BASE=100)   $TS"
who
require_release
[ -f "$STATE_BACKEND" ] || stop "$STATE_BACKEND does not exist (nothing of this release has traffic)"
NEW="$(sed -n 's/^name=//p' "$STATE_BACKEND" | head -1)"; BASE="$(sed -n 's/^base=//p' "$STATE_BACKEND" | head -1)"
printf '%s\n%s\n' "$NEW" "$BASE" | grep -Evq '^zipper-api-[0-9]{5}-[a-z0-9]{3}$' && stop "bad revision names in backend-revision.txt"
[ "$BASE" != "$RETIRED_REV" ] || stop "$RETIRED_REV must never receive traffic"
say "NEW=$NEW  BASE=$BASE"
NOW="$(split_now status)"; say "current split: $NOW"
[ "$NOW" = "$BASE=100" ] && say "traffic is already 100% on $BASE — nothing to do" && finish
CRM_NOTE=""; [ -f "$STATE_CRM" ] && CRM_NOTE=" — the new CRM is live ($STATE_CRM): roll it back to Hosting $OLD_CRM_VERSION in the console at the same time (RUNBOOK.md)"
confirm ROLLBACK "pin 100% of zipper-api traffic to $BASE (immediate; $NEW stays at 0%)$CRM_NOTE"
gcloud run services update-traffic zipper-api --project zipper-83816 --region asia-south1 --to-revisions "$BASE=100" > "$OUT/rollback-output.txt" 2>&1  #MUT-ROLLBACK-BACKEND
say "exit code: $?"
AFTER="$(split_now status)"; SPEC="$(split_now spec)"
[ "$AFTER" = "$BASE=100" ] && [ "$SPEC" = "$BASE=100" ] && check ok "100% on $BASE (spec and status)" || check "status $AFTER spec $SPEC" "100% on $BASE"
finish
