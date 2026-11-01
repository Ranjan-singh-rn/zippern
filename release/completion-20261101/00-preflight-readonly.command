#!/bin/bash
# ZIPPER completion release — 00: READ-ONLY preflight. Run it before step 1 and again whenever you want the state.
# Reads: CLI versions and the (masked) gcloud account; the clean-tree / RELEASE.txt gate; Cloud Run traffic, tags,
# template identity and environment NAMES of the serving revision and the template; a hash of the Functions list
# (name, update time, status, generation of all functions); metadata of the three secrets (versions, IAM — never a
# value); the project roles of the two runtime identities and the Storage service agent; the LIVE Firestore and
# Storage rules hashes against the repository and hotfix texts; the live Hosting version; the published Android
# record (versionCode, minSupportedVersionCode). Changes nothing. Writes only ./production/00-preflight-<UTC>/.
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
verify_scripts
new_out 00-preflight
need_tools gcloud firebase python3 git shasum

say "ZIPPER completion release — 00 read-only preflight   $TS"
who
say "firebase: $(firebase --version 2>>"$ERR" | head -1)   node: $(node --version 2>/dev/null || echo none)   npm: $(npm --version 2>/dev/null || echo none)"  #RO

say ""; say "== Release identity (clean tree at the recorded HEAD)"
require_release

say ""; say "== Cloud Run $SERVICE"
service_state "$OUT/service.txt"
grep -vE '^ENV ' "$OUT/service.txt" | sed 's/^/   /' | tee -a "$OUT/SUMMARY.txt"
SPLIT="$(sed -n 's/^TRAFFIC status //p' "$OUT/service.txt")"
[ "$SPLIT" = "$EXPECT_SERVING=100" ] && check ok "traffic is 100% on $EXPECT_SERVING" || check "$SPLIT" "traffic is 100% on $EXPECT_SERVING"
grep -q '^TRAFFIC spec LATEST-TARGET-PRESENT' "$OUT/service.txt" && check "latestRevision target present" "no latestRevision traffic target" || check ok "no latestRevision traffic target"
LATEST="$(sed -n 's/^LATEST created=\([^ ]*\) .*/\1/p' "$OUT/service.txt")"
[ "$LATEST" = "$EXPECT_TEMPLATE" ] && check ok "latest created revision is the template $EXPECT_TEMPLATE" || check "$LATEST" "latest created revision is $EXPECT_TEMPLATE (a newer one exists: review before deploying)"
grep -q "^TEMPLATE sa=$BACKEND_SA " "$OUT/service.txt" && check ok "template runs as $BACKEND_SA" || check "differs" "template runs as $BACKEND_SA"
revision_state "$OUT/revision-serving.txt" "$EXPECT_SERVING"
grep '^ENV ' "$OUT/service.txt" > "$OUT/env-template.txt"
grep '^ENV ' "$OUT/revision-serving.txt" > "$OUT/env-serving.txt"
say "   environment names: serving $(grep -c . "$OUT/env-serving.txt"), template $(grep -c . "$OUT/env-template.txt") (names only; env-*.txt)"
$H env-diff "$OUT/env-serving.txt" "$OUT/env-template.txt" > "$OUT/env-diff-template.txt"
sed 's/^/   template vs serving: /' "$OUT/env-diff-template.txt" | tee -a "$OUT/SUMMARY.txt"
EXTRA="$(grep -vE '^(\+ ENV OWNER_MFA_REQUIRED \(plain\)|\+ ENV OWNER_MFA_ENCRYPTION_KEY <- secret OWNER_MFA_ENCRYPTION_KEY:1|DIFF )' "$OUT/env-diff-template.txt" | grep -c .)"
[ "$EXTRA" = 0 ] && check ok "template differs from the serving revision only by the two Owner-MFA names" || check "$EXTRA other line(s)" "template differs from the serving revision only by the two Owner-MFA names"
grep -q "$RETIRED_REV=" "$OUT/service.txt" && check "retired revision has traffic" "$RETIRED_REV has no traffic" || check ok "$RETIRED_REV has no traffic"

say ""; say "== Functions (list hash = sha256 of name/updateTime/status/generation lines)"
all_functions "$OUT/all-functions.tsv"
NFN="$(grep -c . "$OUT/all-functions.tsv")"
say "   $NFN functions   list sha256 $(shasum -a 256 "$OUT/all-functions.tsv" | cut -c1-64)"
[ "$NFN" -ge 100 ] 2>/dev/null && check ok "function list readable ($NFN)" || check "$NFN" "function list readable"
fn_state "$OUT/functions-waves.txt" $WAVE_2A $WAVE_2B
sed 's/^/   /' "$OUT/functions-waves.txt" | tee -a "$OUT/SUMMARY.txt"

say ""; say "== Secrets (metadata only)"
for s in "$SG_SECRET" "$OLD_SG_SECRET" "$MFA_SECRET"; do
  say "   $s:"
  gcloud secrets describe "$s" --project "$P" --format=json 2>>"$ERR" | $H secret-meta - | sed 's/^/      /' | tee -a "$OUT/SUMMARY.txt"  #RO
  gcloud secrets versions list "$s" --project "$P" --format=json 2>>"$ERR" | $H versions - | sed 's/^/      /' | tee -a "$OUT/SUMMARY.txt"  #RO
  gcloud secrets get-iam-policy "$s" --project "$P" --format=json 2>>"$ERR" | $H iam - | tee "$OUT/iam-$s.txt" | sed 's/^/      /' | tee -a "$OUT/SUMMARY.txt"  #RO
done
grep -q "^BINDING roles/secretmanager.secretAccessor serviceAccount:$FN_SA\$" "$OUT/iam-$SG_SECRET.txt" && check ok "Functions identity granted on $SG_SECRET (Phase C)" || check "missing" "Functions identity granted on $SG_SECRET"
grep -q "^BINDING roles/secretmanager.secretAccessor serviceAccount:$BACKEND_SA\$" "$OUT/iam-$SG_SECRET.txt" && say "   backend identity already granted on $SG_SECRET (step 10 will have nothing to do)" || say "   backend identity NOT yet granted on $SG_SECRET (step 10)"
grep -q "^BINDING roles/secretmanager.secretAccessor serviceAccount:$BACKEND_SA\$" "$OUT/iam-$MFA_SECRET.txt" && check ok "backend identity granted on $MFA_SECRET" || check "missing" "backend identity granted on $MFA_SECRET"

say ""; say "== Project-level roles (other members not shown)"
gcloud projects get-iam-policy "$P" --format=json 2>>"$ERR" | $H project-sa-roles - "$FN_SA" "$BACKEND_SA" "$STORAGE_AGENT" | tee "$OUT/project-roles.txt" | sed 's/^/   /' | tee -a "$OUT/SUMMARY.txt"  #RO
grep "^PROJECT-ROLES $STORAGE_AGENT " "$OUT/project-roles.txt" | grep -q "$STORAGE_ROLE" && say "   Storage service agent already holds $STORAGE_ROLE (step 40 will have nothing to do)" || say "   Storage service agent lacks $STORAGE_ROLE (step 40 before the rc2 Storage rules)"

say ""; say "== Live rules (hashes only; fetched read-only with the backend's own verifier credential)"
venv_env
if [ -x "$VENV_PY" ]; then
  for kind in firestore storage; do
    ( cd "$REPO/backend" && $VENV_ENV "$VENV_PY" "$HERE/tools/live_rules.py" get "$kind" "$OUT/live-$kind.rules" ) > "$OUT/live-$kind.txt" 2>>"$ERR"  #RO
    LIVE="$(sed -n 's/^LIVE-SHA //p' "$OUT/live-$kind.txt")"
    say "   $kind live sha256 ${LIVE:-unreadable}   $(sed -n 's/^LIVE-RULESET /ruleset /p' "$OUT/live-$kind.txt")"
    for cand in "$REPO/$kind.rules" "$REPO/hotfix/rules-20261101/$kind.rules"; do
      [ "$(shasum -a 256 "$cand" | cut -c1-64)" = "$LIVE" ] && say "      = $cand"
    done
  done
else
  say "   backend/.venv/bin/python not found — live rules not read (compare in the console instead)"
fi
say "   repository firestore.rules  $(shasum -a 256 "$REPO/firestore.rules" | cut -c1-64)"
say "   repository storage.rules    $(shasum -a 256 "$REPO/storage.rules" | cut -c1-64)"
say "   hotfix-1 firestore.rules    $(shasum -a 256 "$REPO/hotfix/rules-20261101/firestore.rules" | cut -c1-64)"
say "   hotfix-1 storage.rules      $(shasum -a 256 "$REPO/hotfix/rules-20261101/storage.rules" | cut -c1-64)"

say ""; say "== Hosting (CRM)"
hosting_live "$OUT/hosting.txt"
sed 's/^/   /' "$OUT/hosting.txt" | tee -a "$OUT/SUMMARY.txt"
grep -q "version=$OLD_CRM_VERSION" "$OUT/hosting.txt" && say "   the 20 Oct CRM is live (step 50 pending)" || say "   a newer CRM version is live"

say ""; say "== Android update record (published versions only)"
if [ -x "$VENV_PY" ]; then
  ( cd "$REPO/backend" && $VENV_ENV "$VENV_PY" "$HERE/tools/android_update_doc.py" get "$OUT/android-update.json" ) >> "$OUT/android-get.log" 2>>"$ERR"  #RO
  $H android-doc-check "$OUT/android-update.json" "$APK_CHANNEL" 0 | sed 's/^/   /' | tee -a "$OUT/SUMMARY.txt"
fi

finish
