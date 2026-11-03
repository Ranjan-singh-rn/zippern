#!/bin/bash
# ZIPPER Track B release (NOT part of this release's deploy order — a separate Owner decision) — 46: Owner MFA ENFORCEMENT, part 2 of 2 — move 100% of zipper-api traffic BY NAME from the
# completion revision (BASE) to the enforcement revision 45 created (NEW: the same image, OWNER_MFA_REQUIRED=true).
# No canary: same image, one environment flag. From then on an Owner API session that has not passed MFA reaches only
# `me`, sign-out and the MFA routes; every other Owner request gets 403 with X-Zipper-MFA-Required.
# Production change (after you type ENFORCE), exactly:
#   gcloud run services update-traffic zipper-api --project zipper-83816 --region asia-south1 --to-revisions "$NEW=100"
# Verification, up to 120 s: the split is NEW=100 in spec and status; NEW is Ready, Active and ResourcesAvailable; on the
# service URL an unauthenticated GET /api/health answers 200 "ok" and GET /api/auth/mfa/status answers 401.
# Automatic rollback: if that is not all true within 120 s, traffic is pinned back to BASE=100 by name (the second
# allowed line). Manual rollback at any time: 47-rollback-enforcement.command (ROLLBACK).
# Preconditions, re-checked here because time passes after 45: ALL_OWNERS_ENROLLED=yes (you set it knowingly);
# production/enforce-revision.txt (45) written for this HEAD, BASE = the completion revision of backend-revision.txt;
# NEW carries the recorded image digest; BASE serves exactly 100%; the RC2 Firestore rules and the MFA CRM still live.
# Run as:  ALL_OWNERS_ENROLLED=yes ./46-move-traffic-enforce.command      Never --to-latest; never zipper-api-00048-pit.
# Results: ./production/46-enforce-traffic-<UTC>/
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
. "$HERE/rel_rules_lib.sh"
verify_scripts
new_out 46-enforce-traffic
need_tools gcloud firebase curl python3 git shasum

say "ZIPPER Track B release — 46 Owner MFA enforcement: traffic to the enforcement revision   $TS"
who
require_release
[ "${ALL_OWNERS_ENROLLED:-}" = yes ] || stop "ALL_OWNERS_ENROLLED=yes is not set — set it only when every active Owner has bound MFA in the CRM (RUNBOOK.md step 9b)"
say "operator confirmed: every active Owner has bound MFA in the CRM (ALL_OWNERS_ENROLLED=yes)"
enforce_state
[ "$(sed -n 's/^head=//p' "$STATE_ENFORCE" | head -1)" = "$HEAD_SHA" ] || stop "enforce-revision.txt was written for another HEAD than RELEASE.txt"
[ "$BASE" = "$(sed -n 's/^name=//p' "$STATE_BACKEND" 2>/dev/null | head -1)" ] || stop "enforce-revision.txt base= is not the completion revision of backend-revision.txt"

LIVE_DIG="$(gcloud run revisions describe "$NEW" --project "$P" --region "$REGION" --format='value(status.imageDigest)' 2>>"$ERR")"; LIVE_DIG="${LIVE_DIG##*@}"  #RO
[ "$LIVE_DIG" = "$WANT_DIG" ] || stop "$NEW image digest is not the recorded one. Nothing changed."
check ok "$NEW carries the recorded image digest"
NOW_STATUS="$(split_now status)"; NOW_SPEC="$(split_now spec)"
say "current split: status $NOW_STATUS | spec $NOW_SPEC"
if [ "$NOW_STATUS" = "$NEW=100" ] && [ "$NOW_SPEC" = "$NEW=100" ]; then say "enforcement is already live (100% on $NEW) — nothing to do"; finish; fi
[ "$NOW_STATUS" = "$BASE=100" ] && [ "$NOW_SPEC" = "$BASE=100" ] || stop "the current split is not exactly $BASE=100. Nothing changed."
check ok "the completion revision $BASE serves exactly 100%"
require_rc2_rules_live
require_crm_live
service_state "$OUT/service-before.txt"
SVC_URL="$(sed -n 's/^URL //p' "$OUT/service-before.txt")"
printf '%s' "$SVC_URL" | grep -Eq '^https://[A-Za-z0-9.-]+$' || stop "the service URL is not readable ($SVC_URL)"
say "   service URL: $SVC_URL"

# The single pin-back line, used by the automatic rollback when verification fails.
pin_back() {
  gcloud run services update-traffic zipper-api --project zipper-83816 --region asia-south1 --to-revisions "$BASE=100" > "$OUT/pin-back.txt" 2>&1  #MUT-ENFORCE-PIN-BACK
  say "pin-back exit code: $?"
}

confirm ENFORCE "move 100% of zipper-api traffic from $BASE to $NEW (same image, OWNER_MFA_REQUIRED=true) by revision name; pinned back to $BASE automatically if not live within 120 s"
say "== setting $NEW=100 (started $(date -u +%H:%M:%SZ))"
gcloud run services update-traffic zipper-api --project zipper-83816 --region asia-south1 --to-revisions "$NEW=100" > "$OUT/set-traffic.txt" 2>&1  #MUT-ENFORCE-TRAFFIC
say "update-traffic exit code: $?"

say ""; say "== verification (up to 120 s): split exact in spec and status; $NEW Ready, Active, ResourcesAvailable; /api/health ok; /api/auth/mfa/status 401"
OK=no
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  S1="$(split_now status)"; S2="$(split_now spec)"
  C="$(gcloud run revisions describe "$NEW" --project "$P" --region "$REGION" --format='json(status.conditions)' 2>>"$ERR" | $H rev-cond -)"  #RO
  HC="-"; MC="-"
  if [ "$S1" = "$NEW=100" ] && [ "$S2" = "$NEW=100" ] && [ "$C" = ok ]; then
    HC="$(curl -sS --max-time 30 -o "$OUT/health.txt" -w '%{http_code}' "$SVC_URL/api/health" 2>>"$ERR")"  #RO
    MC="$(curl -sS --max-time 30 -o "$OUT/mfa-status.txt" -w '%{http_code}' "$SVC_URL/api/auth/mfa/status" 2>>"$ERR")"  #RO
  fi
  say "   check $i: status $S1 | spec $S2 | $NEW: $C | GET /api/health $HC | GET /api/auth/mfa/status (no token) $MC"
  if [ "$HC" = 200 ] && grep -q '"status":"ok"' "$OUT/health.txt" && [ "$MC" = 401 ]; then OK=yes; break; fi
  sleep 10
done
if [ "$OK" = yes ]; then
  check ok "OWNER MFA ENFORCEMENT LIVE: 100% on $NEW; /api/health ok; unauthenticated /api/auth/mfa/status 401"
  say "   now verify (RUNBOOK.md step 9b): an Owner session WITHOUT MFA gets 403 + X-Zipper-MFA-Required on an Owner route; with MFA it works"
else
  check "not live within 120 s" "Owner MFA enforcement live on $NEW"
  say "pinning traffic back to $BASE=100"
  pin_back
  say "after pin-back: status $(split_now status) | spec $(split_now spec)"
fi
finish "rollback at any time: 47-rollback-enforcement.command"
