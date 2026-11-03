#!/bin/bash
# ZIPPER Track B release — 50: publish the CRM (zipper-crm at the release HEAD) to Hosting site zipperlive by
# running the repository's own guarded deploy-crm.command, after checking that it and zipper-crm are exactly the
# RELEASE.txt text. Production change (after you type CRM here AND DEPLOY in deploy-crm.command), exactly what
# deploy-crm.command does: npm ci, typecheck, tests, build, verify:out, then
#   firebase deploy --project zipper-83816 --only hosting:production      (hosting only; never rules or functions)
# Preconditions (checked): clean tree at RELEASE.txt's HEAD (deploy-crm.command, zipper-crm/, firebase.json and
# .firebaserc are hashed there); the backend of this release serves 100% (the new CRM calls routes the completion
# backend does not have: coin-seller business, games reports); ./production/crm-live.txt does not exist yet. deploy-crm.command reads zipper-crm/.env.local
# itself (key presence only); this script never opens it.
# After: the live Hosting version must have changed; it is recorded in ./production/crm-live.txt (31 and 41 require
# it). Rollback: Firebase console > Hosting > zipperlive > Release history > bf4066501e5f593a > Rollback
# (APPROVAL-COMMANDS.txt H-CRM-ROLLBACK), coordinated with 19 (RUNBOOK.md). Results: ./production/50-deploy-crm-<UTC>/
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
. "$HERE/rel_rules_lib.sh"
verify_scripts
new_out 50-deploy-crm
need_tools firebase node npm python3 git shasum

say "ZIPPER Track B release — 50 CRM (Hosting $HOSTING_SITE)   $TS"
who
say "firebase $(firebase --version 2>>"$ERR" | head -1)   node $(node --version)   npm $(npm --version)"  #RO
require_release
[ -e "$STATE_CRM" ] && stop "$STATE_CRM already exists (the CRM of this release was published). Review it; move it aside only on purpose."
for f in deploy-crm.command firebase.json .firebaserc; do
  grep -q "^FILE $f $(shasum -a 256 "$REPO/$f" | cut -c1-64)\$" "$RELEASE_TXT" || stop "$f is not the RELEASE.txt text"
done
grep -q '^TREE zipper-crm ok$' "$OUT/release-check.txt" || stop "zipper-crm is not the RELEASE.txt tree"
check ok "deploy-crm.command, firebase.json, .firebaserc and zipper-crm/ = RELEASE.txt"
grep -q -- '--only "hosting:$HOSTING_TARGET"' "$REPO/deploy-crm.command" && grep -q '^HOSTING_TARGET="production"$' "$REPO/deploy-crm.command" \
  && check ok "deploy-crm.command deploys hosting:production only" || stop "deploy-crm.command does not look like the guarded hosting-only script"
require_backend_serving_new
hosting_live "$OUT/hosting-before.txt"
sed 's/^/   before: /' "$OUT/hosting-before.txt" | tee -a "$OUT/SUMMARY.txt"
BEFORE="$(sed -n 's/.* version=\([^ ]*\) .*/\1/p' "$OUT/hosting-before.txt")"
[ -n "$BEFORE" ] && [ "$BEFORE" != none ] || stop "the live Hosting version is not readable"

confirm CRM "run deploy-crm.command: build zipper-crm at HEAD $HEAD_SHORT and publish it to Hosting $HOSTING_SITE (live now: $BEFORE). It asks for DEPLOY itself."
( cd "$REPO" && /bin/bash ./deploy-crm.command ) 2>&1 | tee "$OUT/deploy-crm.log"  #MUT-CRM
rc=${PIPESTATUS[0]}
say "deploy-crm.command exit code: $rc"

say ""; say "== After"
hosting_live "$OUT/hosting-after.txt"
sed 's/^/   after: /' "$OUT/hosting-after.txt" | tee -a "$OUT/SUMMARY.txt"
AFTER="$(sed -n 's/.* version=\([^ ]*\) .*/\1/p' "$OUT/hosting-after.txt")"
if [ -n "$AFTER" ] && [ "$AFTER" != none ] && [ "$AFTER" != "$BEFORE" ] && [ "$AFTER" != "$OLD_CRM_VERSION" ]; then
  check ok "Hosting $HOSTING_SITE now serves version $AFTER (was $BEFORE)"
  printf 'version=%s\nprevious=%s\nhead=%s\nrecorded=%s\n' "$AFTER" "$BEFORE" "$HEAD_SHA" "$TS" > "$STATE_CRM"
  say "recorded: $STATE_CRM"
  say "   now: open https://$HOSTING_HOST, sign in as an Owner (MFA step or the 'MFA unavailable' notice), Observer TOTP, one money screen read-only"
else
  check "live version still $AFTER" "a new Hosting version is live"
  say "NOT recorded: the deploy was aborted or failed (nothing to roll back if the version is unchanged)"
fi
finish "Hosting rollback: console > zipperlive > Release history > $BEFORE > Rollback"
