#!/bin/bash
# ZIPPER completion release — 10 (E1): grant the BACKEND runtime identity access to ZIPPER_SENDGRID_API_KEY.
# Production change (after you type GRANT), exactly:
#   gcloud secrets add-iam-policy-binding ZIPPER_SENDGRID_API_KEY --project zipper-83816
#     --member=serviceAccount:239458555881-compute@developer.gserviceaccount.com
#     --role=roles/secretmanager.secretAccessor --condition=None
# Per-secret grant, this secret only, no project-wide access. The Functions grant (Phase C) stays. No value is read.
# Preconditions: the secret has an enabled version; the serving revision still runs as the compute identity.
# Rollback: the exact remove-iam-policy-binding in APPROVAL-COMMANDS.txt (E1-REVERT, a separate approval); harmless
# to leave in place while unused. Results: ./production/10-grant-<UTC>/
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
verify_scripts
new_out 10-grant
need_tools gcloud python3 git

say "ZIPPER completion release — 10 backend grant on $SG_SECRET   $TS"
who
require_release

gcloud secrets versions list "$SG_SECRET" --project "$P" --format=json 2>>"$ERR" | $H versions - > "$OUT/secret-versions.txt"  #RO
sed 's/^/   /' "$OUT/secret-versions.txt" | tee -a "$OUT/SUMMARY.txt"
[ "$(sed -n 's/^ENABLED //p' "$OUT/secret-versions.txt")" -ge 1 ] 2>/dev/null || stop "$SG_SECRET has no enabled version"
check ok "$SG_SECRET has an enabled version (its value was not read)"

revision_state "$OUT/revision-serving.txt" "$EXPECT_SERVING"
grep -q "^REV name=$EXPECT_SERVING .* sa=$BACKEND_SA\$" "$OUT/revision-serving.txt" || stop "$EXPECT_SERVING does not run as $BACKEND_SA (see revision-serving.txt)"
check ok "the backend runs as $BACKEND_SA"

gcloud secrets get-iam-policy "$SG_SECRET" --project "$P" --format=json 2>>"$ERR" | $H iam - > "$OUT/iam-before.txt"  #RO
sed 's/^/   before: /' "$OUT/iam-before.txt" | tee -a "$OUT/SUMMARY.txt"
if grep -q "^BINDING roles/secretmanager.secretAccessor serviceAccount:$BACKEND_SA\$" "$OUT/iam-before.txt"; then
  say "The backend identity already has secretAccessor on $SG_SECRET — no change made."
else
  confirm GRANT "grant roles/secretmanager.secretAccessor on $SG_SECRET (this secret only) to serviceAccount:$BACKEND_SA"
  gcloud secrets add-iam-policy-binding ZIPPER_SENDGRID_API_KEY --project zipper-83816 --member=serviceAccount:239458555881-compute@developer.gserviceaccount.com --role=roles/secretmanager.secretAccessor --condition=None --format=none 2>>"$ERR"  #MUT-GRANT-BACKEND
  rc=$?; [ $rc -eq 0 ] || stop "add-iam-policy-binding exited $rc (see stderr.log)"
fi
gcloud secrets get-iam-policy "$SG_SECRET" --project "$P" --format=json 2>>"$ERR" | $H iam - > "$OUT/iam-after.txt"  #RO
sed 's/^/   after:  /' "$OUT/iam-after.txt" | tee -a "$OUT/SUMMARY.txt"
grep -q "^BINDING roles/secretmanager.secretAccessor serviceAccount:$BACKEND_SA\$" "$OUT/iam-after.txt" \
  && check ok "backend identity can read $SG_SECRET" || check "binding not found" "backend identity can read $SG_SECRET"
grep -q "^BINDING roles/secretmanager.secretAccessor serviceAccount:$FN_SA\$" "$OUT/iam-after.txt" \
  && check ok "Functions grant still present" || check "missing" "Functions grant still present"
extra="$(grep '^BINDING ' "$OUT/iam-after.txt" | grep -vE "^BINDING roles/secretmanager.secretAccessor serviceAccount:($FN_SA|$BACKEND_SA)\$" | grep -c .)"
[ "$extra" = 0 ] && check ok "no other binding on the secret" || check "$extra other binding(s)" "no other binding on the secret"

finish
