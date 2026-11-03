#!/bin/bash
# ZIPPER Track B release — 61: WITHDRAW APK 21: restore appConfig/androidUpdate.debug to the record 60 SAVED before
# it published. Usage: 61-withdraw-apk.command <evidence-folder-of-60>
# Production change (after you type WITHDRAW), exactly:
#   (backend/) <venv python> release/trackb-20261104/tools/android_update_doc.py restore <saved.json> debug
# which REPLACES the whole "debug" map with the saved one (update(), not a merge — so minSupportedVersionCode, notes,
# abis and the legacy flat fields all return to the saved values); the "release" channel is untouched.
# Effect: phones are offered the saved build again and the sign-in gate accepts its versionCode again. Phones that
# already installed APK 21 keep it (Android never downgrades). The APK 21 files stay in Storage, unreferenced.
# Refuses if: the tree is dirty or not at RELEASE.txt's HEAD; the saved file does not match its recorded sha256 or
# has no debug map; Functions wave B is live (a 21 deploy newer than the last successful 29 2b rollback) — APK 19
# cannot use the wave-B functions, so roll wave B back FIRST (29-rollback-functions.command 2b).
# Results: ./production/61-withdraw-apk-<UTC>/
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
verify_scripts
new_out 61-withdraw-apk
need_tools python3 git shasum

SRC_DIR="${1:-}"
say "ZIPPER Track B release — 61 WITHDRAW APK $APK_VERSION_CODE (restore the saved $APK_CHANNEL record)   $TS"
require_release
[ -n "$SRC_DIR" ] && [ -d "$SRC_DIR" ] || stop "usage: $0 <evidence folder of 60 holding android-update-before.json>"
SAVED="$SRC_DIR/android-update-before.json"
[ -f "$SAVED" ] && [ -f "$SAVED.sha256" ] || stop "$SAVED (and .sha256) not found"
[ "$(awk '{print $1}' "$SAVED.sha256")" = "$(shasum -a 256 "$SAVED" | cut -c1-64)" ] && check ok "saved record matches its recorded sha256" || stop "the saved record does not match its recorded sha256"
$H android-doc-check "$SAVED" "$APK_CHANNEL" 0 > "$OUT/saved-check.txt"
sed 's/^/   saved:  /' "$OUT/saved-check.txt" | tee -a "$OUT/SUMMARY.txt"
grep -q "^ANDROID $APK_CHANNEL absent" "$OUT/saved-check.txt" && stop "the saved record has no $APK_CHANNEL map (nothing to restore; publish a fixed build instead)"

# Wave 2b must not be live: APK 19 joins calls with uid 0 and sends gifts without a combo (21's header).
newest_with() { for d in $(ls -d "$HERE/production/$1"*Z 2>/dev/null | LC_ALL=C sort); do grep -q "$2" "$d/$3" 2>/dev/null && echo "$d"; done | tail -1; }
LAST21="$(newest_with 21-functions-2b- . firebase-deploy.log)"
LAST29="$(newest_with 29-rollback-functions-2b- '^RESULT: PASS' SUMMARY.txt)"
if [ -n "$LAST21" ] && { [ -z "$LAST29" ] || [ "$(basename "$LAST29" | sed 's/.*-//')" \< "$(basename "$LAST21" | sed 's/.*-//')" ]; }; then
  stop "Functions wave B (2b) was deployed ($(basename "$LAST21")) and not rolled back since — run 29-rollback-functions.command 2b first"
fi
check ok "Functions wave B (2b) is not live from this folder's evidence (21: ${LAST21:+$(basename "$LAST21")}${LAST21:-none}; 29 2b: ${LAST29:+$(basename "$LAST29")}${LAST29:-none})"

venv_env
[ -x "$VENV_PY" ] || stop "$VENV_PY not found"
( cd "$REPO/backend" && $VENV_ENV "$VENV_PY" "$HERE/tools/android_update_doc.py" get "$OUT/android-update-now.json" ) > "$OUT/android-get-now.log" 2>>"$ERR" || stop "could not read appConfig/androidUpdate"  #RO
$H android-doc-check "$OUT/android-update-now.json" "$APK_CHANNEL" 0 | sed 's/^/   now:    /' | tee -a "$OUT/SUMMARY.txt"
$H android-doc-equal "$SAVED" "$OUT/android-update-now.json" "$APK_CHANNEL" > "$OUT/equal-now.txt"
if grep -q '^EQUAL yes' "$OUT/equal-now.txt"; then
  say "the saved $APK_CHANNEL record is already live — nothing to do"; finish
fi
confirm WITHDRAW "replace appConfig/androidUpdate.$APK_CHANNEL with the saved record ($(sed -n "s/^ANDROID $APK_CHANNEL \(versionCode=[0-9]*\) .*\(minSupportedVersionCode=[0-9]*\).*/\1, \2/p" "$OUT/saved-check.txt")); APK 21 installs stay"
( cd "$REPO/backend" && $VENV_ENV "$VENV_PY" "$HERE/tools/android_update_doc.py" restore "$SAVED" "$APK_CHANNEL" ) > "$OUT/restore-output.txt" 2>&1  #MUT-WITHDRAW-APK
rc=$?
sed 's/^/   | /' "$OUT/restore-output.txt" | tee -a "$OUT/SUMMARY.txt"
[ $rc -eq 0 ] && grep -q '^RESTORE done' "$OUT/restore-output.txt" && check ok "restore exit 0" || check "exit $rc" "restore"

( cd "$REPO/backend" && $VENV_ENV "$VENV_PY" "$HERE/tools/android_update_doc.py" get "$OUT/android-update-after.json" ) > "$OUT/android-get-after.log" 2>>"$ERR"  #RO
$H android-doc-equal "$SAVED" "$OUT/android-update-after.json" "$APK_CHANNEL" > "$OUT/equal-after.txt"
sed 's/^/   /' "$OUT/equal-after.txt" | tee -a "$OUT/SUMMARY.txt"
grep -q '^EQUAL yes' "$OUT/equal-after.txt" && check ok "appConfig/androidUpdate.$APK_CHANNEL equals the saved record exactly" || check "see equal-after.txt" "restored record equals the saved one"
finish
