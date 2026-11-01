#!/bin/bash
# ZIPPER completion release — 45: Owner MFA ENFORCEMENT, part 1 of 2 — a NEW zipper-api revision with
# OWNER_MFA_REQUIRED=true at 0% traffic (spec §8: MFA enforced on every login path). The completion revision (11)
# inherits OWNER_MFA_REQUIRED=false from the template and nothing else turns it on. Port of the reviewed rc2
# 60-enable-enforcement.command (stage G3) into this folder's conventions.
# Production change (after you type ENFORCE-NEW), exactly one template change of zipper-api:
#   gcloud run services update zipper-api --project zipper-83816 --region asia-south1 --update-env-vars OWNER_MFA_REQUIRED=true --no-traffic
# = a new revision from the SAME image and the same settings plus OWNER_MFA_REQUIRED=true, at 0% traffic: no effect
# until 46 moves traffic to it.
#   (auto) if traffic moved at all, it is pinned straight back to the completion revision by NAME.
# Preconditions — you set the first one knowingly, then every one is checked:
#   ALL_OWNERS_ENROLLED=yes   every active Owner has bound MFA in the MFA CRM (GET /api/auth/mfa/status -> verified)
#   the RC2 Firestore rules are live (31's PASS evidence; the live rules sha256 = the repository's firestore.rules);
#   the MFA CRM is live (production/crm-live.txt = the live Hosting version); the completion revision (name= of
#   production/backend-revision.txt) serves exactly 100% (spec and status) with its recorded image digest,
#   OWNER_MFA_REQUIRED=false and OWNER_MFA_ENCRYPTION_KEY:1, and no revision was created after it (the template is its
#   configuration); production/enforce-revision.txt does not exist yet.
# After: the new revision is Ready, has OWNER_MFA_REQUIRED=true and otherwise the completion revision's environment
# (names and secret versions compared; values never printed), the same image digest and identity, no ERROR log and
# "Zipper API ready"; then production/enforce-revision.txt is written in backend-revision.txt's format: name= the
# enforcement revision (NEW), base= the completion revision (BASE), digest=, head=. Next: 46-move-traffic-enforce.command.
# Rollback: nothing to undo here (0% traffic). Never --to-latest; never zipper-api-00048-pit.
# Run as:  ALL_OWNERS_ENROLLED=yes ./45-enable-owner-mfa-enforcement.command
# Results: ./production/45-enforce-new-<UTC>/
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
. "$HERE/rel_rules_lib.sh"
verify_scripts
new_out 45-enforce-new
need_tools gcloud firebase python3 git shasum

say "ZIPPER completion release — 45 Owner MFA enforcement: new revision at 0%   $TS"
who
require_release
[ "${ALL_OWNERS_ENROLLED:-}" = yes ] || stop "ALL_OWNERS_ENROLLED=yes is not set — set it only when every active Owner has bound MFA in the CRM (RUNBOOK.md step 9b)"
say "operator confirmed: every active Owner has bound MFA in the CRM (ALL_OWNERS_ENROLLED=yes)"
[ -e "$STATE_ENFORCE" ] && stop "$STATE_ENFORCE already exists (an enforcement revision of this release). Review it; move it aside only on purpose."
[ -f "$STATE_BACKEND" ] || stop "$STATE_BACKEND does not exist (the completion backend is not deployed)"
BASE="$(sed -n 's/^name=//p' "$STATE_BACKEND" | head -1)"; WANT_DIG="$(sed -n 's/^digest=//p' "$STATE_BACKEND" | head -1)"
NAME_RE='^zipper-api-[0-9]{5}-[a-z0-9]{3}$'
printf '%s' "$BASE" | grep -Eq "$NAME_RE" || stop "bad revision name in backend-revision.txt"
printf '%s' "$WANT_DIG" | grep -Eq '^sha256:[0-9a-f]{64}$' || stop "bad digest in backend-revision.txt"
[ "$BASE" != "$RETIRED_REV" ] || stop "$RETIRED_REV must never receive traffic"
[ "$(sed -n 's/^head=//p' "$STATE_BACKEND" | head -1)" = "$HEAD_SHA" ] || stop "backend-revision.txt was written for another HEAD than RELEASE.txt"
say "BASE = $BASE (the completion revision)"

# ── 1. Read-only gate ───────────────────────────────────────────────────────────────────────────────
say ""; say "== 1. Preconditions (read-only)"
require_rc2_rules_live
require_crm_live
service_state "$OUT/service-before.txt"
grep -vE '^ENV ' "$OUT/service-before.txt" | sed 's/^/   /' | tee -a "$OUT/SUMMARY.txt"
SPLIT="$(sed -n 's/^TRAFFIC status //p' "$OUT/service-before.txt")"
[ "$SPLIT" = "$BASE=100" ] && [ "$(sed -n 's/^TRAFFIC spec //p' "$OUT/service-before.txt")" = "$BASE=100" ] || stop "traffic is not exactly 100% on the completion revision $BASE (status $SPLIT) — finish step 4 first"
check ok "the completion revision $BASE serves exactly 100% (spec and status, by name)"
LATEST="$(sed -n 's/^LATEST created=\([^ ]*\) .*/\1/p' "$OUT/service-before.txt")"
[ "$LATEST" = "$BASE" ] || stop "the latest created revision is $LATEST, not $BASE: the service template may differ from the completion revision — review first"
check ok "no revision was created after $BASE (the template is its configuration)"
revision_state "$OUT/revision-base.txt" "$BASE" OWNER_MFA_REQUIRED=false
BASELINE="$(grep '^REV ' "$OUT/revision-base.txt")"
[ "$(printf '%s' "$BASELINE" | sed -n 's/.* digest=\([^ ]*\) .*/\1/p')" = "$WANT_DIG" ] || stop "$BASE does not carry the recorded image digest"
grep -q '^VALUE OWNER_MFA_REQUIRED expected$' "$OUT/revision-base.txt" || stop "OWNER_MFA_REQUIRED on $BASE is not false ($(sed -n 's/^VALUE OWNER_MFA_REQUIRED //p' "$OUT/revision-base.txt")) — review first"
grep -q "^ENV OWNER_MFA_ENCRYPTION_KEY <- secret $MFA_SECRET:1\$" "$OUT/revision-base.txt" || stop "$BASE does not carry $MFA_SECRET:1"
check ok "$BASE: the recorded image digest, OWNER_MFA_REQUIRED=false, $MFA_SECRET:1"
[ "$FAILS" = 0 ] || stop "$FAILS gate check(s) failed. Nothing was changed."

# ── 2. The reviewed change ──────────────────────────────────────────────────────────────────────────
confirm ENFORCE-NEW "create a NEW zipper-api revision from the image of $BASE with OWNER_MFA_REQUIRED=true at 0% traffic (--no-traffic); $BASE keeps 100%"
say "== 2. Enforcement revision (started $(date -u +%H:%M:%SZ))"
gcloud run services update zipper-api --project zipper-83816 --region asia-south1 --update-env-vars OWNER_MFA_REQUIRED=true --no-traffic > "$OUT/update-output.txt" 2>&1  #MUT-ENFORCE-NEW
UPD_RC=$?
tail -8 "$OUT/update-output.txt" | sed 's/^/   | /' | tee -a "$OUT/SUMMARY.txt"
say "update exit code: $UPD_RC (finished $(date -u +%H:%M:%SZ))"

# ── 3. Traffic safety net ───────────────────────────────────────────────────────────────────────────
say ""; say "== 3. Traffic"
service_state "$OUT/service-after.txt"
AFTER="$(sed -n 's/^TRAFFIC status //p' "$OUT/service-after.txt")"
if [ "$AFTER" != "$BASE=100" ]; then
  say "TRAFFIC MOVED ($AFTER): pinning back to $BASE=100 now"
  gcloud run services update-traffic zipper-api --project zipper-83816 --region asia-south1 --to-revisions "$BASE=100" > "$OUT/pin-back.txt" 2>&1  #MUT-ENFORCE-NEW-PIN-BACK
  say "pin-back exit code: $?"
  service_state "$OUT/service-after.txt"
  check "traffic had moved; pinned back" "production traffic stayed on $BASE"
else
  check ok "production traffic unchanged: $AFTER"
fi
[ $UPD_RC -eq 0 ] && check ok "gcloud run services update exit 0" || check "exit $UPD_RC" "gcloud run services update"
ENF="$(sed -n 's/^LATEST created=\([^ ]*\) .*/\1/p' "$OUT/service-after.txt")"
if ! printf '%s' "$ENF" | grep -Eq "$NAME_RE" || [ "$ENF" = "$BASE" ] || [ "$ENF" = "$RETIRED_REV" ]; then
  check "no new revision (${ENF:-none})" "a new revision was created"
  finish "nothing to roll back: traffic unchanged"
fi
check ok "new revision $ENF"

# ── 4. Read-only verification of the enforcement revision ───────────────────────────────────────────
say ""; say "== 4. Verification (read-only)"
revision_state "$OUT/revision-enforce.txt" "$ENF" OWNER_MFA_REQUIRED=true
grep -vE '^ENV ' "$OUT/revision-enforce.txt" | sed 's/^/   /' | tee -a "$OUT/SUMMARY.txt"
REVLINE="$(grep '^REV ' "$OUT/revision-enforce.txt")"
case "$REVLINE" in *" ready=True "*) check ok "$ENF Ready";; *) check "see revision-enforce.txt" "$ENF Ready";; esac
case "$REVLINE" in *" sa=$BACKEND_SA") check ok "service account unchanged ($BACKEND_SA)";; *) check "differs" "service account unchanged";; esac
DIG="$(printf '%s' "$REVLINE" | sed -n 's/.* digest=\([^ ]*\) .*/\1/p')"
[ "$DIG" = "$WANT_DIG" ] && check ok "same image as $BASE (digest $(printf '%s' "$DIG" | cut -c1-19)…)" || check "digest $DIG" "same image digest as $BASE"
grep -q '^VALUE OWNER_MFA_REQUIRED expected$' "$OUT/revision-enforce.txt" && check ok "OWNER_MFA_REQUIRED = true" || check "$(sed -n 's/^VALUE OWNER_MFA_REQUIRED //p' "$OUT/revision-enforce.txt")" "OWNER_MFA_REQUIRED = true"
grep '^ENV ' "$OUT/revision-base.txt" | sort > "$OUT/env-base.txt"
grep '^ENV ' "$OUT/revision-enforce.txt" | sort > "$OUT/env-enforce.txt"
if diff "$OUT/env-base.txt" "$OUT/env-enforce.txt" > "$OUT/env-diff.txt"; then
  check ok "environment names and secret versions identical to $BASE ($(grep -c . "$OUT/env-enforce.txt") names; values not shown)"
else
  sed 's/^/   env: /' "$OUT/env-diff.txt" | tee -a "$OUT/SUMMARY.txt"; check "see env-diff.txt" "environment names identical to $BASE"
fi
say "   waiting 45 s for start-up logs"; sleep 45
gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\" AND resource.labels.revision_name=\"$ENF\" AND NOT logName:\"run.googleapis.com%2Frequests\"" --project "$P" --freshness=2h --limit 300 --order=asc --format='value(timestamp,severity,textPayload)' > "$OUT/startup-logs.txt" 2>>"$ERR"  #RO
gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\" AND resource.labels.revision_name=\"$ENF\" AND severity>=ERROR" --project "$P" --freshness=2h --limit 100 --format='value(timestamp,severity)' > "$OUT/error-logs.txt" 2>>"$ERR"  #RO
say "   start-up log lines: $(grep -c . "$OUT/startup-logs.txt"); ERROR entries: $(grep -c . "$OUT/error-logs.txt")"
[ "$(grep -c . "$OUT/error-logs.txt")" = 0 ] && check ok "no ERROR-or-higher log entry for $ENF" || check "$(grep -c . "$OUT/error-logs.txt") entries" "no ERROR logs"
grep -q "Zipper API ready" "$OUT/startup-logs.txt" && check ok "start-up log: 'Zipper API ready'" || check "not seen" "start-up log: 'Zipper API ready'"

if [ "$FAILS" = 0 ]; then
  printf 'name=%s\ndigest=%s\nbase=%s\nhead=%s\nrecorded=%s\n' "$ENF" "$DIG" "$BASE" "$HEAD_SHA" "$TS" > "$STATE_ENFORCE"
  say "recorded: $STATE_ENFORCE (NEW=$ENF with OWNER_MFA_REQUIRED=true, BASE=$BASE)"
  say "   next: ALL_OWNERS_ENROLLED=yes ./46-move-traffic-enforce.command (moves 100% to $ENF by name)"
else
  say "NOT recorded in enforce-revision.txt because a check failed. Review before anything else; the revision has 0% traffic."
fi
finish "the enforcement revision has 0% traffic; nothing to roll back"
