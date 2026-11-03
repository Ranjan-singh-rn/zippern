#!/bin/bash
# ZIPPER Track B release — 49: ROLLBACK of the Storage rules: re-release the live text that 41 (RC2) SAVED before it
# changed anything (hotfix-1, 3f5b61c7…, live since 1 Nov), then — optionally, with its own word — revert the IAM
# role of 40.
# Usage: 49-rollback-storage.command <evidence-folder-of-41>   (production/41-storage-rules-<UTC>; it holds
#        live-storage-before.rules + .sha256 written by save_live_rules)
# Production changes, each only after you type its word:
#   ROLLBACK — firebase deploy --only storage --project zipper-83816 --non-interactive
#              from a temp folder holding ONLY the saved text (checked against its recorded sha256) as storage.rules
#              and a generated firebase.json {"storage":{"rules":"storage.rules"}} (default bucket only).
#   REVOKE   — gcloud projects remove-iam-policy-binding zipper-83816
#                --member=serviceAccount:service-239458555881@gcp-sa-firebasestorage.iam.gserviceaccount.com
#                --role=roles/firebaserules.firestoreServiceAgent --condition=None
#              offered ONLY when the live Storage text is the saved one (the old rules make no cross-service read, so
#              the role is unused). KEEP leaves it (harmless). Never revoked while the RC2 text could still be live.
# After a rollback of 41, Owner Storage access no longer depends on MFA.
# Results: ./production/49-rollback-storage-<UTC>/
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
. "$HERE/rel_rules_lib.sh"
verify_scripts
new_out 49-rollback-storage
need_tools gcloud firebase python3 git shasum

DEPLOYED_20OCT="9899c24aed8699abe153b16da72db0695571fdff4713adee03463643c56b112a"
SRC_DIR="${1:-}"
say "ZIPPER Track B release — 49 Storage rules ROLLBACK   $TS"
who
require_release
[ -n "$SRC_DIR" ] && [ -d "$SRC_DIR" ] || stop "usage: $0 <evidence folder of 41 holding live-storage-before.rules>"
case "$(basename "$SRC_DIR")" in
  41-storage-rules-*Z)   say "   evidence of 41 (RC2 Storage rules): $(basename "$SRC_DIR")";;
  *) stop "$(basename "$SRC_DIR") is not an evidence folder of 41 (41-storage-rules-<UTC>)";;
esac
SAVED="$SRC_DIR/live-storage-before.rules"
[ -f "$SAVED" ] && [ -f "$SAVED.sha256" ] || stop "$SAVED (and .sha256) not found"
WANT="$(awk '{print $1}' "$SAVED.sha256")"; GOT="$(shasum -a 256 "$SAVED" | cut -c1-64)"
[ "$WANT" = "$GOT" ] && check ok "saved text matches its recorded sha256 ($GOT)" || stop "the saved text does not match its recorded sha256"
case "$GOT" in
  "$DEPLOYED_20OCT") say "   saved text = the 20 Oct DEPLOYED Storage rules";;
  "$(shasum -a 256 "$REPO/hotfix/rules-20261101/storage.rules" | cut -c1-64)") say "   saved text = hotfix-1 storage.rules";;
  *) say "   saved text is neither the 20 Oct DEPLOYED text nor hotfix-1 (it is what was live when 41 ran)";;
esac
say "   saved from: $(sed -n 's/^LIVE-RULESET /ruleset /p' "$SRC_DIR/live-storage-before.txt" 2>/dev/null) updated $(sed -n 's/^LIVE-UPDATED //p' "$SRC_DIR/live-storage-before.txt" 2>/dev/null)"
save_live_rules storage "$OUT/live-storage-now"
if [ "$LIVE_SHA" = "$GOT" ]; then
  say "the saved text is already live — no rules change"
else
  rules_workdir '{"storage":{"rules":"storage.rules"}}' "$SAVED"
  mv "$WS/live-storage-before.rules" "$WS/storage.rules"
  confirm ROLLBACK "re-release the saved Storage rules text ($GOT) over the live ruleset $LIVE_SHA (default bucket $BUCKET)"
  ( cd "$WS" && firebase deploy --only storage --project zipper-83816 --non-interactive ) > "$OUT/firebase-deploy.log" 2>&1  #MUT-STORAGE-ROLLBACK
  rc=$?
  tail -15 "$OUT/firebase-deploy.log" | sed 's/^/   | /' | tee -a "$OUT/SUMMARY.txt"
  [ $rc -eq 0 ] && grep -qi 'released rules' "$OUT/firebase-deploy.log" && check ok "firebase deploy: released rules" || check "exit $rc" "firebase deploy: released rules"
  verify_live_rules storage "$WS/storage.rules"
fi
[ "$FAILS" = 0 ] || finish "the IAM role was NOT touched"

# Optional IAM revert — only once the live text is the saved one (checked above).
roles() { gcloud projects get-iam-policy "$P" --format=json 2>>"$ERR" | $H project-sa-roles - "$STORAGE_AGENT" | sed 's/^PROJECT-ROLES [^ ]* //'; }  #RO
BEFORE="$(roles)"; say "   agent roles: ${BEFORE:-none}"
if ! printf '%s' "$BEFORE" | grep -q "$STORAGE_ROLE"; then
  say "the Storage service agent does not hold $STORAGE_ROLE — nothing to revert"; finish
fi
say ""; say "ABOUT TO (optional): remove $STORAGE_ROLE from serviceAccount:$STORAGE_AGENT (unused by the live rules)"
printf 'Type REVOKE to remove it, KEEP to leave it (anything else stops): '
ans=""; read -r ans
if [ "$ans" = KEEP ]; then say "IAM role kept by you (KEEP) — harmless while unused"; finish; fi
[ "$ans" = REVOKE ] || { say "Not confirmed (REVOKE was not typed). The IAM role was not changed."; exit 4; }
say "Confirmed by typing REVOKE at $(date -u +%FT%TZ)"
gcloud projects remove-iam-policy-binding zipper-83816 --member=serviceAccount:service-239458555881@gcp-sa-firebasestorage.iam.gserviceaccount.com --role=roles/firebaserules.firestoreServiceAgent --condition=None --format=none > /dev/null 2>"$OUT/revoke-stderr.txt"  #MUT-STORAGE-IAM-REVERT
say "revoke exit code: $?"
AFTER="$(roles)"; say "   agent roles after: ${AFTER:-none}"
printf '%s' "$AFTER" | grep -q "$STORAGE_ROLE" && check "still present" "role removed" || check ok "$STORAGE_ROLE removed from the Storage service agent"
finish
