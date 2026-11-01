#!/bin/bash
# ZIPPER credential rotation (FINAL PHASE, prepared) — 90: DISABLE one replaced secret version, after the rollback
# window. Usage: [ROT_WINDOW_DAYS=7] rot-90-disable-old-version.command <SECRET> <VERSION>
# Production change (after you type DISABLE), exactly:
#   gcloud secrets versions disable <VERSION> --secret <SECRET> --project zipper-83816
# Reversible (91, ENABLE). NEVER destroys: a destroyed version cannot come back, and no script here destroys one.
# Refuses if: the version is not ENABLED; the service template, a zipper-api revision WITH traffic, or a function
# references <SECRET>:<VERSION>; this folder rotated <SECRET> less than ROT_WINDOW_DAYS ago (default 7; 0 for a leaked
# value once its replacement is verified). If <VERSION> is the NEWEST enabled one (retiring a secret, e.g. the old
# SENDGRID_API_KEY), nothing with traffic, not the template and no function may reference <SECRET> at ANY version.
# Revisions at 0% that still reference it are listed — they would not start afterwards (rollback targets lose that
# path; accepted in the final phase).
# Disabling a version does NOT revoke the credential at its issuer (SendGrid, Agora, Atlas): ROTATION-RUNBOOK.md.
# Results: ./production/r90-<SECRET>-v<VERSION>-<UTC>/
set -u
umask 077
[ -f "$(dirname "$0")/FINAL-PHASE-APPROVED" ] || { echo "REFUSING: final phase not approved — no FINAL-PHASE-APPROVED in $(dirname "$0") (ROTATION-RUNBOOK.md §0)" >&2; exit 2; }
. "$(dirname "$0")/rot_common.sh"
verify_scripts
SECRET="${1:-}"; VER="${2:-}"
case " $ALL_SECRETS " in *" $SECRET "*) [ -n "$SECRET" ] ;; *) false ;; esac && case "$VER" in ''|*[!0-9]*) false ;; *) true ;; esac \
  || { echo "Usage: $0 <SECRET> <VERSION>   SECRET one of: $ALL_SECRETS" >&2; exit 2; }
new_out "r90-$SECRET-v$VER"
need_tools gcloud python3 git

say "ZIPPER credential rotation — 90 disable $SECRET version $VER   $TS"
who
require_clean
LATEST="$(latest_enabled "$SECRET")"
sed 's/^/   /' "$OUT/versions-$SECRET.txt" | tee -a "$OUT/SUMMARY.txt"
grep -q "^VERSION $VER ENABLED " "$OUT/versions-$SECRET.txt" || stop "$SECRET version $VER is not ENABLED"
if [ "$LATEST" -gt "$VER" ] 2>/dev/null; then
  REF="$SECRET:$VER"; REFD="$REF"; REFV="$VER"; check ok "$VER is ENABLED and a newer version ($LATEST) is ENABLED"
else
  REF="$SECRET:[^ ]*"; REFD="$SECRET (any version)"; REFV="$VER latest"; say "   $VER is the newest ENABLED version: RETIRING $SECRET — nothing in use may reference it at any version"
fi

service_state "$OUT/service.txt"
grep -q "^ENV [^ ]* <- secret $REF\$" "$OUT/service.txt" && stop "the zipper-api template still maps $REFD"
for r in $(sed -n 's/^TRAFFIC status //p' "$OUT/service.txt" | tr ',' '\n' | sed 's/=.*//'); do
  printf '%s' "$r" | grep -Eq '^zipper-api-[0-9]{5}-[a-z0-9]{3}$' || stop "unexpected traffic target '$r'"
  revision_state "$OUT/revision-$r.txt" "$r"
  grep -q "^ENV [^ ]* <- secret $REF\$" "$OUT/revision-$r.txt" && stop "$r (with traffic) maps $REFD"
done
check ok "no zipper-api revision with traffic, and not the template, maps $REFD"
gcloud run revisions list --service "$SERVICE" --project "$P" --region "$REGION" --format=json 2>>"$ERR" | $H rev-refs - "$SECRET" $REFV > "$OUT/rev-refs.txt"  #RO
grep '^REF ' "$OUT/rev-refs.txt" | sed 's/^REF /   at 0%, would not start afterwards: /' | tee -a "$OUT/SUMMARY.txt"
fn_index "$OUT/functions-index.txt"
grep -E "secrets=([^ ]*,)?$REF(,| )" "$OUT/functions-index.txt" | awk '{print "   still pinned: " $2}' | tee -a "$OUT/SUMMARY.txt"
grep -Eq "secrets=([^ ]*,)?$REF(,| )" "$OUT/functions-index.txt" && stop "functions above still pin $REFD (rot-85 first)"
check ok "no function pins $REFD"

NEWEST=""
for f in $(grep -l "^secret=$SECRET\$" "$HERE"/production/r80-*-last.txt 2>/dev/null); do NEWEST="$NEWEST $(sed -n 's/^recorded=//p' "$f")"; done
for d in "$HERE"/production/r85-"$SECRET"-*Z; do [ -d "$d" ] && NEWEST="$NEWEST ${d##*-}"; done
NEWEST="$(printf '%s\n' $NEWEST | grep -E '^[0-9]{8}T[0-9]{6}Z$' | LC_ALL=C sort | tail -1)"
if [ -n "$NEWEST" ]; then
  AGE="$($H age-days "$NEWEST")"
  [ "$AGE" -ge "$ROT_WINDOW_DAYS" ] 2>/dev/null || stop "$SECRET was rotated here $AGE day(s) ago ($NEWEST) — inside the $ROT_WINDOW_DAYS-day rollback window"
  check ok "last rotation of $SECRET here: $NEWEST ($AGE day(s) ago, window $ROT_WINDOW_DAYS)"
else
  say "   note: no rotation of $SECRET by this folder on record (replaced elsewhere, e.g. by the completion release)"
fi

confirm DISABLE "disable version $VER of $SECRET (reversible with rot-91 ENABLE; never destroyed; the issuer-side key is revoked separately)"
gcloud secrets versions disable "$VER" --secret "$SECRET" --project zipper-83816 --format=none 2>>"$ERR"  #MUT-R90-DISABLE
say "exit code: $?"
latest_enabled "$SECRET" > /dev/null
grep -q "^VERSION $VER DISABLED " "$OUT/versions-$SECRET.txt" && check ok "$SECRET version $VER DISABLED" || check "see versions-$SECRET.txt" "$SECRET version $VER DISABLED"
finish
