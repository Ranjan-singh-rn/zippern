#!/bin/bash
# ZIPPER completion release — 21: Functions WAVE 2b — the functions whose new behaviour needs APK 20 on the phones:
#   generateAgoraToken settleGift startCall acceptCall tickCall endCall declineCall sweepStaleCalls
# WHY AFTER THE APK (RUNBOOK.md step 8): the new generateAgoraToken signs the token for a uid it derives and returns;
# APK 19 joins with uid 0 and would be refused by Agora, while APK 20 tolerates the OLD function (no uid in the
# answer → joins with 0). The new settleGift refuses a lucky gift without a combo (APK 19 sends none) and APK 20
# gets a clean refusal from the old settleGift (no quantity). Per-minute call billing and the APK 20 call screen
# belong together. So: 60 publishes APK 20 with minSupportedVersionCode 20 (the sign-in gate then refuses APK 19
# sessions), the fleet updates, THEN this wave goes live. Precondition checked here: appConfig/androidUpdate.debug
# has versionCode >= 20 and minSupportedVersionCode >= 20 (read-only, with the backend's own credential).
# Production change (after you type DEPLOY2B), exactly:
#   firebase deploy --only functions:generateAgoraToken,functions:settleGift,functions:startCall,functions:acceptCall,functions:tickCall,functions:endCall,functions:declineCall,functions:sweepStaleCalls --project zipper-83816 --non-interactive
# from the same kind of fresh tree as 20 (committed HEAD, tests first, functions/.env copied never displayed).
# settleGift and the call functions are MONEY functions: the scope check and env-drift check protect them the same
# way. Rollback: 29-rollback-functions.command 2b. Results: ./production/21-functions-2b-<UTC>/
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
. "$HERE/rel_deploy_lib.sh"
verify_scripts
new_out 21-functions-2b
trap 'rm -f "$OUT/deploy/functions/.env"; rm -rf "$OUT/deploy/functions/node_modules"' EXIT
need_tools gcloud firebase node npm python3 git shasum tar

say "ZIPPER completion release — 21 Functions wave 2b   $TS"
who
say "firebase $(firebase --version 2>>"$ERR" | head -1)   node $(node --version)   npm $(npm --version)"  #RO
require_release
say "wave 2b: $WAVE_2B"

venv_env
[ -x "$VENV_PY" ] || stop "$VENV_PY not found (needed to read the Android update record)"
( cd "$REPO/backend" && $VENV_ENV "$VENV_PY" "$HERE/tools/android_update_doc.py" get "$OUT/android-update.json" ) > "$OUT/android-get.log" 2>>"$ERR" || stop "could not read appConfig/androidUpdate (android-get.log)"  #RO
$H android-doc-check "$OUT/android-update.json" "$APK_CHANNEL" "$APK_VERSION_CODE" > "$OUT/android-check.txt"
sed 's/^/   /' "$OUT/android-check.txt" | tee -a "$OUT/SUMMARY.txt"
grep -q '^ANDROID-CHECK ok' "$OUT/android-check.txt" || stop "APK $APK_VERSION_CODE is not published with minSupportedVersionCode $APK_MIN_SUPPORTED on channel $APK_CHANNEL (run 60 first, then let the fleet update)"
check ok "APK $APK_VERSION_CODE published, minSupportedVersionCode >= $APK_MIN_SUPPORTED"
LAST60="$(ls -d "$HERE/production/60-publish-apk-"*Z 2>/dev/null | LC_ALL=C sort | tail -1)"
[ -n "$LAST60" ] && say "   last publish evidence: $(basename "$LAST60")" || say "   note: no 60-publish-apk evidence folder here (published elsewhere?)"

fn_state "$OUT/functions-before.txt" $WAVE_2B
sed 's/^/   before: /' "$OUT/functions-before.txt" | tee -a "$OUT/SUMMARY.txt"
EXISTING="$(existing_of $WAVE_2B)"
for f in $WAVE_2B; do grep -q "^FN $f status=ACTIVE " "$OUT/functions-before.txt" || stop "$f is not ACTIVE now (every wave-2b function exists today)"; done
check ok "all wave-2b functions are ACTIVE"

build_fn_tree HEAD
grep -q "^$(grep '^TREE functions ' "$RELEASE_TXT")\$" "$OUT/deploy-tree.txt" && check ok "deploy tree = RELEASE.txt functions tree" || stop "the unpacked functions tree does not match RELEASE.txt"
install_build_test
add_env
env_drift $EXISTING

all_functions "$OUT/all-before.tsv"
say "   $(grep -c . "$OUT/all-before.tsv") functions in the project before the deploy"
ONLY="$(fn_only $WAVE_2B)"; CSV="$(echo $WAVE_2B | tr ' ' ',')"
say "   --only $ONLY"

confirm DEPLOY2B "deploy Functions wave 2b to $P: $WAVE_2B (MONEY functions; nothing else)"
( cd "$DEPLOY" && firebase deploy --only "$ONLY" --project zipper-83816 --non-interactive ) > "$OUT/firebase-deploy.log" 2>&1  #MUT-DEPLOY-2B
rc=$?
tail -25 "$OUT/firebase-deploy.log" | sed 's/^/   | /' | tee -a "$OUT/SUMMARY.txt"
[ $rc -eq 0 ] && check ok "firebase deploy exit 0" || check "exit $rc" "firebase deploy"

say ""; say "== After"
verify_after "$CSV" $WAVE_2B
finish "consider 29-rollback-functions.command 2b"
