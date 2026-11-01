#!/bin/bash
# ZIPPER credential rotation (FINAL PHASE, prepared) — 00: READ-ONLY inventory. Run before and after every rotation.
# Prints METADATA ONLY, never a value: per secret its versions (number, state, created) and accessors (people masked);
# which zipper-api revision WITH TRAFFIC and the service template map which secret:version; which functions pin which
# secret:version; on how many functions the .env names AGORA_APP_CERTIFICATE / SG_MAIL_KEY are set; Firebase web API
# keys and their restrictions (no key string); user-managed service-account keys (id prefix, times); how many people
# hold each project role. Changes nothing. Refuses without FINAL-PHASE-APPROVED. Results: ./production/r00-inventory-<UTC>/
set -u
umask 077
[ -f "$(dirname "$0")/FINAL-PHASE-APPROVED" ] || { echo "REFUSING: final phase not approved — no FINAL-PHASE-APPROVED in $(dirname "$0") (ROTATION-RUNBOOK.md §0)" >&2; exit 2; }
. "$(dirname "$0")/rot_common.sh"
verify_scripts
new_out r00-inventory
need_tools gcloud python3 git

say "ZIPPER credential rotation — 00 read-only inventory   $TS"
who
require_clean

say ""; say "== Secret Manager (metadata only)"
for s in $ALL_SECRETS; do
  gcloud secrets describe "$s" --project "$P" --format=json 2>>"$ERR" | $H secret-meta - > "$OUT/meta-$s.txt"  #RO
  gcloud secrets versions list "$s" --project "$P" --format=json 2>>"$ERR" | $H versions - > "$OUT/versions-$s.txt"  #RO
  gcloud secrets get-iam-policy "$s" --project "$P" --format=json 2>>"$ERR" | $H iam - > "$OUT/iam-$s.txt"  #RO
  say "   $s: exists=$(sed -n 's/^EXISTS //p' "$OUT/meta-$s.txt") enabled=$(sed -n 's/^ENABLED //p' "$OUT/versions-$s.txt") latest-enabled=$(sed -n 's/^LATEST-ENABLED //p' "$OUT/versions-$s.txt") versions=[$(awk '/^VERSION /{printf "%s%s:%s", sep, $2, $3; sep=" "}' "$OUT/versions-$s.txt")] accessors=$(grep -c '^BINDING ' "$OUT/iam-$s.txt")"
done

say ""; say "== zipper-api (names and secret references only)"
service_state "$OUT/service.txt"
say "   traffic: $(sed -n 's/^TRAFFIC status //p' "$OUT/service.txt")   latest created: $(sed -n 's/^LATEST created=\([^ ]*\) .*/\1/p' "$OUT/service.txt")"
grep '^ENV .* <- secret ' "$OUT/service.txt" | sed 's/^ENV /   template: /' | tee -a "$OUT/SUMMARY.txt"
for r in $(sed -n 's/^TRAFFIC status //p' "$OUT/service.txt" | tr ',' '\n' | sed 's/=.*//'); do
  printf '%s' "$r" | grep -Eq '^zipper-api-[0-9]{5}-[a-z0-9]{3}$' || continue
  revision_state "$OUT/revision-$r.txt" "$r"
  grep '^ENV .* <- secret ' "$OUT/revision-$r.txt" | sed "s/^ENV /   $r: /" | tee -a "$OUT/SUMMARY.txt"
done

say ""; say "== Functions (secret pins and env NAMES only)"
fn_index "$OUT/functions-index.txt"
say "   $(grep -c '^IDX ' "$OUT/functions-index.txt") functions"
for s in $FN_SECRETS; do
  say "   $s: $(grep '^IDX ' "$OUT/functions-index.txt" | tr ' ,=' '\n\n\n' | grep "^$s:" | sort | uniq -c | awk '{printf "%s x%s  ", $2, $1}')"
done
for n in AGORA_APP_CERTIFICATE SG_MAIL_KEY; do
  say "   .env name $n set on $(grep '^IDX ' "$OUT/functions-index.txt" | grep -Ec "envnames=([^ ]*,)?$n(,|\$)") function(s)"
done

say ""; say "== Firebase web API keys (restrictions only; no key string is read)"
gcloud services api-keys list --project "$P" --format=json 2>>"$ERR" | $H api-keys - | sed 's/^/   /' | tee -a "$OUT/SUMMARY.txt"  #RO

say ""; say "== User-managed service-account keys (id prefix and times only)"
for sa in $(gcloud iam service-accounts list --project "$P" --format='value(email)' 2>>"$ERR"); do  #RO
  gcloud iam service-accounts keys list --iam-account "$sa" --managed-by=user --project "$P" --format=json 2>>"$ERR" | $H sa-keys - "$sa" | sed 's/^/   /' | tee -a "$OUT/SUMMARY.txt"  #RO
done

say ""; say "== People per project role (counts only; check 2-Step Verification for each)"
gcloud projects get-iam-policy "$P" --format=json 2>>"$ERR" | $H human-roles - | sed 's/^/   /' | tee -a "$OUT/SUMMARY.txt"  #RO

say ""; say "MANUAL (not in Google Cloud): Agora certificates (Agora console), SendGrid API key names + last used"
say "(SendGrid console), Atlas database users (Atlas), Android debug keystore (offline backup) — ROTATION-RUNBOOK.md §1."
finish
