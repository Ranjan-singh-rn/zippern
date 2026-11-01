#!/bin/bash
# ZIPPER completion release — 60: publish APK 20 (1.2.6) — the `prod` build type built on this Mac from the release
# HEAD (./gradlew :app:assembleProd → zipper-app/app/build/outputs/apk/prod/app-<abi>-prod.apk), signed with the
# DEBUG key — to the "debug" channel of the in-app updater, with minSupportedVersionCode 20.
# Production change (after you type PUBLISH), exactly what backend/scripts/publish_apk.py does with
#   --channel debug --apk-dir <evidence>/apk --min-supported 20 --notes "<APK_NOTES>" --apply
# (run from backend/ with the backend's own interpreter, no .env read): uploads app-arm64-v8a and app-armeabi-v7a to
# gs://zipper-83816.firebasestorage.app/appBuilds/debug/<abi>/zipper-1.2.6-20.apk (public, sha256 in the record) and
# writes appConfig/androidUpdate.debug = versionCode 20, minSupportedVersionCode 20. From then on the sign-in gate
# refuses APK 19 sessions and every phone is offered APK 20. The "release" channel is untouched.
# publish_apk.py looks for app-<abi>-debug.apk, so the two prod APKs are COPIED under that name into the evidence
# folder (the build output is never renamed or modified).
# Refuses if: the tree is dirty or not at RELEASE.txt's HEAD; build.gradle.kts at HEAD does not say versionCode 20 /
# versionName 1.2.6; an APK is missing, older than the HEAD commit, not package com.zipper.app, not versionCode 20,
# debuggable, or not signed with the FLEET's certificate: `apksigner verify` must exit 0 (signature validity; its output
# is kept as apksigner-<abi>.txt, never parsed) and the APK Signing Block (tools/apk_cert.py) must hold exactly one
# certificate, CN=Android Debug, SHA-256 = FLEET_CERT_SHA256 (rel_common.sh: the key that signed APK 19); the published
# debug record is already >= 20; the dry run of publish_apk.py does not agree. The previous androidUpdate document is
# SAVED first (android-update-before.json + .sha256) — 61-withdraw-apk.command restores it.
# Results: ./production/60-publish-apk-<UTC>/
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
verify_scripts
new_out 60-publish-apk
need_tools python3 git shasum

say "ZIPPER completion release — 60 publish APK $APK_VERSION_CODE ($APK_VERSION_NAME) to channel $APK_CHANNEL   $TS"
require_release
GRADLE="$REPO/zipper-app/app/build.gradle.kts"
grep -Eq "^[[:space:]]*versionCode = $APK_VERSION_CODE\$" "$GRADLE" && grep -Eq "^[[:space:]]*versionName = \"$APK_VERSION_NAME\"\$" "$GRADLE" \
  && check ok "build.gradle.kts at HEAD: versionCode $APK_VERSION_CODE, versionName $APK_VERSION_NAME" || stop "build.gradle.kts at HEAD is not versionCode $APK_VERSION_CODE / $APK_VERSION_NAME"
grep -q 'create("prod")' "$GRADLE" || stop "build.gradle.kts has no prod build type"

# Android SDK build-tools (newest): aapt2/aapt and apksigner — the same tools publish_apk.py uses.
BT=""
for root in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
  [ -n "$root" ] && [ -d "$root/build-tools" ] || continue
  v="$(ls "$root/build-tools" 2>/dev/null | grep -E '^[0-9]+(\.[0-9]+)*' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)"
  [ -n "$v" ] && { BT="$root/build-tools/$v"; break; }
done
[ -n "$BT" ] || stop "Android SDK build-tools not found (needed for aapt2 and apksigner)"
AAPT="$BT/aapt2"; [ -x "$AAPT" ] || AAPT="$BT/aapt"
SIGNER="$BT/apksigner"
[ -x "$AAPT" ] && [ -x "$SIGNER" ] || stop "aapt2/aapt or apksigner missing in $BT"
say "   build-tools: $BT"

APKDIR="$REPO/zipper-app/app/build/outputs/apk/prod"
STAGE="$OUT/apk"; mkdir -p "$STAGE" || exit 2
HEAD_CT="$(git -C "$REPO" log -1 --format=%ct HEAD)"
printf '%s' "${FLEET_CERT_SHA256:-}" | grep -Eq '^[0-9a-f]{64}$' || stop "FLEET_CERT_SHA256 in rel_common.sh is not a SHA-256"
for abi in arm64-v8a armeabi-v7a; do
  f="$APKDIR/app-$abi-prod.apk"
  [ -f "$f" ] || stop "$f not found — build it first: cd zipper-app && ./gradlew :app:assembleProd"
  [ "$($H mtime-after "$f" "$HEAD_CT")" = yes ] || stop "$(basename "$f") is older than the HEAD commit — rebuild it from the release HEAD"
  "$AAPT" dump badging "$f" > "$OUT/badging-$abi.txt" 2>>"$ERR"
  [ -s "$OUT/badging-$abi.txt" ] || stop "aapt printed nothing for $abi (stderr.log)"
  $H apk-badging "$OUT/badging-$abi.txt" "$APK_VERSION_CODE" "$APK_VERSION_NAME" > "$OUT/apk-check-$abi.txt"
  # Signature validity = apksigner's exit code; its output (public certificate data) is kept as evidence, never parsed.
  "$SIGNER" verify --print-certs "$f" > "$OUT/apksigner-$abi.txt" 2>&1
  SRC=$?
  # The signer = the certificate(s) in the APK Signing Block itself.
  python3 -I "$HERE/tools/apk_cert.py" "$f" > "$OUT/apk-cert-$abi.txt" 2>>"$ERR"
  $H apk-cert-check "$OUT/apk-cert-$abi.txt" "$SRC" "$FLEET_CERT_SHA256" >> "$OUT/apk-check-$abi.txt"
  SHA="$(shasum -a 256 "$f" | cut -c1-64)"
  echo "SHA256 $SHA" >> "$OUT/apk-check-$abi.txt"
  sed "s/^/   $abi: /" "$OUT/apk-check-$abi.txt" | tee -a "$OUT/SUMMARY.txt"
  grep -q '^APK-CHECK ok$' "$OUT/apk-check-$abi.txt" || stop "$abi APK is not com.zipper.app $APK_VERSION_CODE/$APK_VERSION_NAME non-debuggable"
  grep -q '^SIGNER-CHECK ok$' "$OUT/apk-check-$abi.txt" || stop "$abi APK is not signed with the fleet's certificate (CN=Android Debug, SHA-256 $FLEET_CERT_SHA256, the key that signed APK 19) — every phone would refuse it as an update: $(sed -n 's/^SIGNER-CHECK FAIL: //p' "$OUT/apk-check-$abi.txt")"
  cp "$f" "$STAGE/app-$abi-debug.apk" || stop "could not stage $abi"
  [ "$(shasum -a 256 "$STAGE/app-$abi-debug.apk" | cut -c1-64)" = "$SHA" ] || stop "staged copy differs"
  check ok "$abi: com.zipper.app $APK_VERSION_CODE ($APK_VERSION_NAME), not debuggable, signed by the fleet certificate (CN=Android Debug, SHA-256 $(printf '%.16s' "$FLEET_CERT_SHA256")… = FLEET_CERT_SHA256), built after HEAD"
done

venv_env
[ -x "$VENV_PY" ] || stop "$VENV_PY not found (publish_apk.py runs with the backend's interpreter)"
( cd "$REPO/backend" && $VENV_ENV "$VENV_PY" "$HERE/tools/android_update_doc.py" get "$OUT/android-update-before.json" ) > "$OUT/android-get-before.log" 2>>"$ERR" || stop "could not read appConfig/androidUpdate"  #RO
printf '%s  %s\n' "$(shasum -a 256 "$OUT/android-update-before.json" | cut -c1-64)" android-update-before.json > "$OUT/android-update-before.json.sha256"
$H android-doc-check "$OUT/android-update-before.json" "$APK_CHANNEL" 0 | sed 's/^/   before: /' | tee -a "$OUT/SUMMARY.txt"
NOWCODE="$(sed -n "s/^ANDROID $APK_CHANNEL versionCode=\([0-9]*\) .*/\1/p" "$OUT/android-get-before.log")"
[ "${NOWCODE:-0}" -lt "$APK_VERSION_CODE" ] 2>/dev/null || stop "channel $APK_CHANNEL already publishes versionCode ${NOWCODE:-?} (>= $APK_VERSION_CODE)"
check ok "previous record saved (android-update-before.json — 61 restores it)"

( cd "$REPO/backend" && $VENV_ENV "$VENV_PY" -m scripts.publish_apk --channel "$APK_CHANNEL" --apk-dir "$STAGE" --min-supported "$APK_MIN_SUPPORTED" --notes "$APK_NOTES" ) > "$OUT/publish-dry-run.txt" 2>&1  #RO
# publish_apk.py names the signer from apksigner's TEXT (debug if it contains CN=Android Debug); the signer was decided
# above from the APK Signing Block, so its reading must only not contradict it: debug, or "unrecognised certificate"
# when it cannot read that text. A "release" reading stops publish_apk.py itself before its "publishing" line.
DRY_AS="$(sed -n 's/^[[:space:]]*signed as  //p' "$OUT/publish-dry-run.txt" | tr '\n' '/' | sed 's#/$##')"
grep -q 'DRY RUN' "$OUT/publish-dry-run.txt" && grep -q "publishing .*$APK_VERSION_NAME ($APK_VERSION_CODE)" "$OUT/publish-dry-run.txt" && [ "$(grep -cE 'signed as  (debug|unrecognised certificate)$' "$OUT/publish-dry-run.txt")" = 2 ] \
  && check ok "publish_apk.py dry run: $APK_VERSION_NAME ($APK_VERSION_CODE), both ABIs; its own reading of apksigner's text: ${DRY_AS:-?} (no contradiction)" || { tail -15 "$OUT/publish-dry-run.txt" | sed 's/^/   | /' | tee -a "$OUT/SUMMARY.txt"; stop "the publish_apk.py dry run did not agree (publish-dry-run.txt)"; }

confirm PUBLISH "upload APK $APK_VERSION_CODE ($APK_VERSION_NAME, 2 ABIs) to gs://$BUCKET/appBuilds/$APK_CHANNEL/ and set appConfig/androidUpdate.$APK_CHANNEL = versionCode $APK_VERSION_CODE, minSupportedVersionCode $APK_MIN_SUPPORTED (APK 19 sessions are then refused at sign-in)"
( cd "$REPO/backend" && $VENV_ENV "$VENV_PY" -m scripts.publish_apk --channel "$APK_CHANNEL" --apk-dir "$STAGE" --min-supported "$APK_MIN_SUPPORTED" --notes "$APK_NOTES" --apply ) > "$OUT/publish-output.txt" 2>&1  #MUT-PUBLISH-APK
rc=$?
tail -12 "$OUT/publish-output.txt" | sed 's/^/   | /' | tee -a "$OUT/SUMMARY.txt"
[ $rc -eq 0 ] && check ok "publish_apk.py --apply exit 0" || check "exit $rc" "publish_apk.py --apply"

say ""; say "== After"
( cd "$REPO/backend" && $VENV_ENV "$VENV_PY" "$HERE/tools/android_update_doc.py" get "$OUT/android-update-after.json" ) > "$OUT/android-get-after.log" 2>>"$ERR"  #RO
$H android-doc-check "$OUT/android-update-after.json" "$APK_CHANNEL" "$APK_MIN_SUPPORTED" > "$OUT/android-check-after.txt"
sed 's/^/   /' "$OUT/android-check-after.txt" | tee -a "$OUT/SUMMARY.txt"
grep -q '^ANDROID-CHECK ok' "$OUT/android-check-after.txt" && grep -q "versionCode=$APK_VERSION_CODE " "$OUT/android-check-after.txt" \
  && check ok "appConfig/androidUpdate.$APK_CHANNEL: versionCode $APK_VERSION_CODE, minSupportedVersionCode >= $APK_MIN_SUPPORTED" || check "see android-check-after.txt" "published record"
$H android-doc-abis "$OUT/android-update-after.json" "$APK_CHANNEL" > "$OUT/abis-after.txt"
for abi in arm64-v8a armeabi-v7a; do
  grep -q "^ABI $abi sha256=$(sed -n 's/^SHA256 //p' "$OUT/apk-check-$abi.txt") " "$OUT/abis-after.txt" \
    && check ok "$abi record carries the sha256 of the verified APK" || check "differs" "$abi record sha256"
done
finish "to withdraw: 61-withdraw-apk.command $OUT"
