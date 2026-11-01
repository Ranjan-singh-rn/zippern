#!/bin/bash
# ZIPPER credential rotation (FINAL PHASE, prepared) — 80: point ONE zipper-api environment variable at a PINNED
# Secret Manager version, as a NEW revision at 0%, then move traffic to it BY NAME.
# Usage: rot-80-backend-secret.command <ENV_NAME> <pin|switch|back>
#   ENV_NAME: JWT_SECRET MONGO_URI SERVICE_KEY_WEEKLY_ACCRUAL SERVICE_KEY_REPORTING SERVICE_KEY_PARTNER_REGISTRATION
#             OWNER_MFA_ENCRYPTION_KEY, or SENDGRID_API_KEY (must map ZIPPER_SENDGRID_API_KEY)
#   pin    — ENV_NAME maps SECRET:latest today: pin it to the newest ENABLED version (the value it already has), so a
#            version you add later changes nothing until `switch`, and `back` really restores the old value.
#   switch — ENV_NAME is pinned to N and you added a newer ENABLED version M in the console (MANUAL): pin it to M.
#   back   — traffic back to the revision that served before the last pin/switch of ENV_NAME (recorded).
# Production changes, each only after its word:
#   PIN / NEWREV  gcloud run services update zipper-api --project zipper-83816 --region asia-south1 --no-traffic
#                   --update-secrets ENV_NAME=SECRET:<version>   (new revision from the current template, 0%)
#   SHIFT         update-traffic --to-revisions <new>=100 (the word is SIGNOUT for a JWT_SECRET switch: every API
#                 session ends; REENROL for an OWNER_MFA_ENCRYPTION_KEY switch: every Owner and the Observer re-enrol)
#   BACK          update-traffic --to-revisions <previous>=100 — also automatic if, within 120 s of SHIFT, the new
#                 revision is not Ready+Active or /api/health is not 200.
# Refuses: no FINAL-PHASE-APPROVED; SCRIPTS.sha256 mismatch; dirty tree or HEAD ≠ RELEASE.txt; Sunday run window;
# traffic not 100% on one revision; template image or environment differs from the serving revision by anything but
# ENV_NAME; ENV_NAME maps another secret. Traffic moves by revision NAME only; no value is ever read.
# Results: ./production/r80-<ENV_NAME>-<phase>-<UTC>/ and ./production/r80-<ENV_NAME>-last.txt (for `back`).
set -u
umask 077
[ -f "$(dirname "$0")/FINAL-PHASE-APPROVED" ] || { echo "REFUSING: final phase not approved — no FINAL-PHASE-APPROVED in $(dirname "$0") (ROTATION-RUNBOOK.md §0)" >&2; exit 2; }
. "$(dirname "$0")/rot_common.sh"
verify_scripts
ENV_NAME="${1:-}"; PHASE="${2:-}"
SECRET="$(backend_secret_of "$ENV_NAME")"
case "$PHASE" in pin|switch|back) ;; *) SECRET="" ;; esac
[ -n "$SECRET" ] || { echo "Usage: $0 <ENV_NAME> <pin|switch|back>   (ROTATION-RUNBOOK.md §2)" >&2; exit 2; }
new_out "r80-$ENV_NAME-$PHASE"
need_tools gcloud python3 git curl
STATE="$HERE/production/r80-$ENV_NAME-last.txt"
NAME_RE='^zipper-api-[0-9]{5}-[a-z0-9]{3}$'

say "ZIPPER credential rotation — 80 backend $ENV_NAME -> $SECRET ($PHASE)   $TS"
who
require_clean
sunday_guard

service_state "$OUT/service-before.txt"
SPLIT="$(sed -n 's/^TRAFFIC status //p' "$OUT/service-before.txt")"; SERVING="${SPLIT%=100}"
printf '%s' "$SERVING" | grep -Eq "$NAME_RE" && [ "$SPLIT" = "$SERVING=100" ] || stop "traffic is not exactly 100% on one revision ($SPLIT)"
[ "$(sed -n 's/^TRAFFIC spec //p' "$OUT/service-before.txt")" = "$SPLIT" ] || stop "spec traffic differs from status traffic"
[ "$SERVING" != "$RETIRED_REV" ] || stop "$RETIRED_REV is serving"
check ok "traffic 100% on $SERVING (by name)"

pin_back() {  # the single BACK line: `back`, and the automatic rollback after a failed SHIFT
  gcloud run services update-traffic zipper-api --project zipper-83816 --region asia-south1 --to-revisions "$1=100" > "$OUT/back-output.txt" 2>&1  #MUT-R80-BACK
  say "update-traffic exit code: $?   now: $(split_now status)"
}

if [ "$PHASE" = back ]; then
  [ -f "$STATE" ] || stop "no recorded pin/switch of $ENV_NAME ($STATE)"
  PREV="$(sed -n 's/^prev=//p' "$STATE" | head -1)"; NEW="$(sed -n 's/^new=//p' "$STATE" | head -1)"
  printf '%s\n%s\n' "$PREV" "$NEW" | grep -Evq "$NAME_RE" && stop "bad revision names in $STATE"
  [ "$PREV" != "$RETIRED_REV" ] || stop "$RETIRED_REV must never receive traffic"
  [ "$SERVING" = "$NEW" ] || stop "the serving revision is $SERVING, not the recorded $NEW — nothing to roll back"
  confirm BACK "pin 100% of zipper-api traffic back to $PREV ($ENV_NAME -> $(sed -n 's/^prev_ref=//p' "$STATE")); $NEW stays at 0%"
  pin_back "$PREV"
  [ "$(split_now status)" = "$PREV=100" ] && check ok "100% on $PREV" || check "see back-output.txt" "100% on $PREV"
  finish
fi

# The new revision is built from the service template: it must equal the serving revision but for ENV_NAME.
revision_state "$OUT/revision-serving.txt" "$SERVING"
TEMPLATE_BEFORE="$(sed -n 's/^LATEST created=\([^ ]*\) .*/\1/p' "$OUT/service-before.txt")"
grep '^ENV ' "$OUT/service-before.txt" | grep -v "^ENV $ENV_NAME " | sort > "$OUT/env-template-others.txt"
grep '^ENV ' "$OUT/revision-serving.txt" | grep -v "^ENV $ENV_NAME " | sort > "$OUT/env-serving-others.txt"
cmp -s "$OUT/env-template-others.txt" "$OUT/env-serving-others.txt" || stop "the service template differs from $SERVING by more than $ENV_NAME (env-*-others.txt, names only)"
[ "$(sed -n 's/^TEMPLATE sa=[^ ]* image=//p' "$OUT/service-before.txt")" = "$(sed -n 's/^IMAGE //p' "$OUT/revision-serving.txt")" ] || stop "the template image differs from the serving revision's"
check ok "template = serving revision except $ENV_NAME (image and other names/references)"
CUR="$(sed -n "s/^ENV $ENV_NAME <- secret //p" "$OUT/revision-serving.txt")"
[ "${CUR%%:*}" = "$SECRET" ] || stop "$ENV_NAME on $SERVING maps '${CUR:-no secret}', not $SECRET"
CURV="${CUR##*:}"
LATEST="$(latest_enabled "$SECRET")"
sed 's/^/   /' "$OUT/versions-$SECRET.txt" | tee -a "$OUT/SUMMARY.txt"
WORD1=NEWREV; WORD2=SHIFT; NOTE=""
if [ "$PHASE" = pin ]; then
  [ "$CURV" = latest ] || { say "$ENV_NAME is already pinned to $SECRET:$CURV — nothing to pin"; finish; }
  [ "$LATEST" != none ] || stop "$SECRET has no ENABLED version"
  WORD1=PIN; NOTE=" (the value it already uses: no behaviour change)"
else
  [ "$CURV" != latest ] || stop "$ENV_NAME still maps $SECRET:latest — run '$0 $ENV_NAME pin' first"
  [ "$LATEST" -gt "$CURV" ] 2>/dev/null || stop "no ENABLED version of $SECRET newer than $CURV — add it in the console first (MANUAL, ROTATION-RUNBOOK.md)"
  case "$ENV_NAME" in
    JWT_SECRET) WORD2=SIGNOUT; NOTE=" — EVERY API session (CRM, app work screens, Observer) ends; everyone signs in again" ;;
    OWNER_MFA_ENCRYPTION_KEY) WORD2=REENROL; NOTE=" — every stored TOTP enrolment becomes unreadable; every Owner and the Observer re-enrol" ;;
    SERVICE_KEY_*) NOTE=" — run rot-85 for the paired function secret RIGHT AFTER (machine calls fail until both sides match)" ;;
    MONGO_URI) NOTE=" — the API connects as the new database user" ;;
  esac
fi
V="$LATEST"
check ok "$ENV_NAME: $SECRET:$CURV -> $SECRET:$V"

confirm "$WORD1" "create a NEW zipper-api revision from the template with $ENV_NAME=$SECRET:$V at 0% traffic (nothing else changes)$NOTE"
gcloud run services update zipper-api --project zipper-83816 --region asia-south1 --no-traffic --update-secrets "$ENV_NAME=$SECRET:$V" > "$OUT/update-output.txt" 2>&1  #MUT-R80-NEWREV
RC=$?
service_state "$OUT/service-after.txt"
if [ "$(sed -n 's/^TRAFFIC status //p' "$OUT/service-after.txt")" != "$SPLIT" ]; then
  say "TRAFFIC MOVED — pinning back to $SERVING"; pin_back "$SERVING"; stop "traffic moved during the update; pinned back"
fi
NEW="$(sed -n 's/^LATEST created=\([^ ]*\) .*/\1/p' "$OUT/service-after.txt")"
[ "$RC" = 0 ] && printf '%s' "$NEW" | grep -Eq "$NAME_RE" && [ "$NEW" != "$SERVING" ] && [ "$NEW" != "$TEMPLATE_BEFORE" ] || stop "no new revision (exit $RC; update-output.txt). Traffic unchanged."
revision_state "$OUT/revision-new.txt" "$NEW"
grep -q "^ENV $ENV_NAME <- secret $SECRET:$V\$" "$OUT/revision-new.txt" && check ok "$NEW maps $ENV_NAME -> $SECRET:$V" || stop "$NEW does not map $SECRET:$V (revision-new.txt). Traffic unchanged."
grep '^ENV ' "$OUT/revision-new.txt" | grep -v "^ENV $ENV_NAME " | sort | cmp -s - "$OUT/env-serving-others.txt" || stop "$NEW differs from $SERVING by more than $ENV_NAME. Traffic unchanged."
check ok "every other name/reference of $NEW equals $SERVING"
printf 'prev=%s\nprev_ref=%s\nnew=%s\nnew_ref=%s:%s\nsecret=%s\nphase=%s\nrecorded=%s\n' "$SERVING" "$CUR" "$NEW" "$SECRET" "$V" "$SECRET" "$PHASE" "$TS" > "$STATE"

confirm "$WORD2" "move 100% of zipper-api traffic to $NEW ($ENV_NAME -> $SECRET:$V) BY NAME; $SERVING stays at 0% for BACK$NOTE"
gcloud run services update-traffic zipper-api --project zipper-83816 --region asia-south1 --to-revisions "$NEW=100" > "$OUT/shift-output.txt" 2>&1  #MUT-R80-SHIFT
say "update-traffic exit code: $?"
URL="$(sed -n 's/^URL //p' "$OUT/service-after.txt")"
OK=no
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  S1="$(split_now status)"; S2="$(split_now spec)"
  C="$(gcloud run revisions describe "$NEW" --project "$P" --region "$REGION" --format=json 2>>"$ERR" | $H rev-cond -)"  #RO
  HC="$(curl -sS --max-time 20 -o "$OUT/health.txt" -w '%{http_code}' "$URL/api/health" 2>>"$ERR")"  #RO
  say "   check $i: status $S1 | spec $S2 | $NEW: $C | /api/health $HC"
  if [ "$S1" = "$NEW=100" ] && [ "$S2" = "$NEW=100" ] && [ "$C" = ok ] && [ "$HC" = 200 ]; then OK=yes; break; fi
  sleep 10
done
if [ "$OK" = yes ]; then
  check ok "$NEW serves 100% with $ENV_NAME -> $SECRET:$V; BACK: '$0 $ENV_NAME back'"
else
  check "not healthy within 120 s" "$NEW serving and healthy"; say "pinning traffic back to $SERVING"; pin_back "$SERVING"
fi
finish
