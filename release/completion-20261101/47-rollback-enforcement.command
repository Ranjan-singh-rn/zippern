#!/bin/bash
# ZIPPER completion release — 47: ROLLBACK of Owner MFA enforcement. Pins 100% of zipper-api traffic back BY NAME to BASE
# of ./production/enforce-revision.txt — the completion revision (OWNER_MFA_REQUIRED=false). Enforcement stops
# immediately; nothing else changes: the same image keeps serving, and the CRM, the rules, the MFA enrolments and the
# enforcement revision (kept at 0% for a later return with 46) stay as they are.
# Production change (after you type ROLLBACK), exactly:
#   gcloud run services update-traffic zipper-api --project zipper-83816 --region asia-south1 --to-revisions "$BASE=100"
# Refuses when the enforcement revision has no traffic: then enforcement is not live and there is nothing to roll back
# here (19-rollback-backend.command is the rollback of the whole backend). Never --to-latest.
# Results: ./production/47-rollback-enforcement-<UTC>/
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
verify_scripts
new_out 47-rollback-enforcement
need_tools gcloud python3 git

say "ZIPPER completion release — 47 Owner MFA enforcement ROLLBACK (pin BASE=100)   $TS"
who
require_release
enforce_state
NOW="$(split_now status)"; say "current split: $NOW"
[ "$NOW" = "$BASE=100" ] && say "traffic is already 100% on $BASE — enforcement is off; nothing to do" && finish
printf '%s' "$NOW" | grep -Eq "(^|,)$NEW=[0-9]+" || stop "$NEW has no traffic ($NOW): enforcement is not live, nothing to roll back here (the whole backend: 19-rollback-backend.command)"
confirm ROLLBACK "pin 100% of zipper-api traffic to $BASE (OWNER_MFA_REQUIRED=false: Owner MFA enforcement stops immediately; $NEW stays at 0%)"
gcloud run services update-traffic zipper-api --project zipper-83816 --region asia-south1 --to-revisions "$BASE=100" > "$OUT/rollback-output.txt" 2>&1  #MUT-ENFORCE-ROLLBACK
say "exit code: $?"
AFTER="$(split_now status)"; SPEC="$(split_now spec)"
[ "$AFTER" = "$BASE=100" ] && [ "$SPEC" = "$BASE=100" ] && check ok "100% on $BASE (spec and status): Owner MFA enforcement is off" || check "status $AFTER spec $SPEC" "100% on $BASE"
finish
