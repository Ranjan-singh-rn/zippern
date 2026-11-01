#!/bin/bash
# ZIPPER completion release — 20: Functions WAVE 2a — the functions with NO client dependency, by name:
#   core:    releaseBeansForWeek weeklyPayoutReportGenerator syncPublicProfile backfillPublicProfiles startMobileSession
#   plus:    WAVE_2A_MAIL / WAVE_2A_HYGIENE in rel_common.sh (filled in when those commits are on the release HEAD)
# Production change (after you type DEPLOY2A), exactly:
#   firebase deploy --only functions:<name>,functions:<name>,... --project zipper-83816 --non-interactive
# from a fresh folder = functions/ exactly as committed at the release HEAD (git archive) + a firebase.json holding only
# the repository's functions section + your functions/.env (copied, never displayed). npm ci, tsc and EVERY test file
# run on that exact tree first. Not deployed: wave 2b (needs APK 20), every other function, rules, hosting, Cloud Run.
# weeklyPayoutReportGenerator (FINANCIAL; Phase D of the SendGrid change) and releaseBeansForWeek (FINANCIAL) are in
# this wave: refused within 2 hours of their Sunday runs (18:29 UTC report, 19:00 UTC release), so a deploy can
# never overlap a run. Preconditions checked: clean tree at RELEASE.txt's HEAD; the SendGrid secret has an enabled
# version and the Functions grant; functions/.env equals what the existing functions run with today (names and
# values compared without displaying them). After: only the named functions changed (scope check), all ACTIVE, same
# identity, environment unchanged, the weekly report carries ZIPPER_SENDGRID_API_KEY and ZIPPER_ACCRUAL_KEY.
# Rollback: 29-rollback-functions.command 2a. Results: ./production/20-functions-2a-<UTC>/
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
. "$HERE/rel_deploy_lib.sh"
verify_scripts
new_out 20-functions-2a
trap 'rm -f "$OUT/deploy/functions/.env"; rm -rf "$OUT/deploy/functions/node_modules"' EXIT
need_tools gcloud firebase node npm python3 git shasum tar

say "ZIPPER completion release — 20 Functions wave 2a   $TS"
who
say "firebase $(firebase --version 2>>"$ERR" | head -1)   node $(node --version)   npm $(npm --version)"  #RO
require_release
dow="$(date -u +%u)"; hm="$(date -u +%H%M)"
if [ "$dow" = 7 ] && [ "$hm" -ge 1629 ] && [ "$hm" -le 2100 ]; then stop "within 2 hours of the Sunday financial runs (18:29 / 19:00 UTC) — try later"; fi
check ok "outside the Sunday run window (now $(date -u +%a\ %H:%M) UTC)"
say "wave 2a: $WAVE_2A"

gcloud secrets versions list "$SG_SECRET" --project "$P" --format=json 2>>"$ERR" | $H versions - > "$OUT/secret-versions.txt"  #RO
[ "$(sed -n 's/^ENABLED //p' "$OUT/secret-versions.txt")" -ge 1 ] 2>/dev/null || stop "$SG_SECRET has no enabled version"
gcloud secrets get-iam-policy "$SG_SECRET" --project "$P" --format=json 2>>"$ERR" | $H iam - > "$OUT/secret-iam.txt"  #RO
grep -q "^BINDING roles/secretmanager.secretAccessor serviceAccount:$FN_SA\$" "$OUT/secret-iam.txt" || stop "the Functions identity is not granted on $SG_SECRET"
check ok "$SG_SECRET: enabled version present, Functions identity granted"

fn_state "$OUT/functions-before.txt" $WAVE_2A
sed 's/^/   before: /' "$OUT/functions-before.txt" | tee -a "$OUT/SUMMARY.txt"
EXISTING="$(existing_of $WAVE_2A)"
for f in $WAVE_2A; do case " $EXISTING " in *" $f "*) ;; *) say "   note: $f does not exist yet (new in this release)";; esac; done
for f in $EXISTING; do grep -q "^FN $f status=ACTIVE " "$OUT/functions-before.txt" || stop "$f exists but is not ACTIVE now"; done
check ok "existing wave-2a functions are ACTIVE"

build_fn_tree HEAD
grep -q "^$(grep '^TREE functions ' "$RELEASE_TXT")\$" "$OUT/deploy-tree.txt" && check ok "deploy tree = RELEASE.txt functions tree" || stop "the unpacked functions tree does not match RELEASE.txt"
install_build_test
add_env
[ -n "$EXISTING" ] && env_drift $EXISTING

all_functions "$OUT/all-before.tsv"
say "   $(grep -c . "$OUT/all-before.tsv") functions in the project before the deploy"
ONLY="$(fn_only $WAVE_2A)"; CSV="$(echo $WAVE_2A | tr ' ' ',')"
say "   --only $ONLY"

confirm DEPLOY2A "deploy Functions wave 2a to $P: $WAVE_2A (nothing else)"
( cd "$DEPLOY" && firebase deploy --only "$ONLY" --project zipper-83816 --non-interactive ) > "$OUT/firebase-deploy.log" 2>&1  #MUT-DEPLOY-2A
rc=$?
tail -25 "$OUT/firebase-deploy.log" | sed 's/^/   | /' | tee -a "$OUT/SUMMARY.txt"
[ $rc -eq 0 ] && check ok "firebase deploy exit 0" || check "exit $rc" "firebase deploy"

say ""; say "== After"
verify_after "$CSV" $WAVE_2A
finish "consider 29-rollback-functions.command 2a"
