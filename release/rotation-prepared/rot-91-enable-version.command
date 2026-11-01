#!/bin/bash
# ZIPPER credential rotation (FINAL PHASE, prepared) — 91: ROLLBACK of 90: re-ENABLE one disabled secret version.
# Usage: rot-91-enable-version.command <SECRET> <VERSION>
# Production change (after you type ENABLE), exactly:
#   gcloud secrets versions enable <VERSION> --secret <SECRET> --project zipper-83816
# Use it when a revision or function that still needs the old version must run again (e.g. before an 80 `back`
# whose previous revision pins it). A DESTROYED version cannot be enabled — none is ever destroyed here.
# Results: ./production/r91-<SECRET>-v<VERSION>-<UTC>/
set -u
umask 077
[ -f "$(dirname "$0")/FINAL-PHASE-APPROVED" ] || { echo "REFUSING: final phase not approved — no FINAL-PHASE-APPROVED in $(dirname "$0") (ROTATION-RUNBOOK.md §0)" >&2; exit 2; }
. "$(dirname "$0")/rot_common.sh"
verify_scripts
SECRET="${1:-}"; VER="${2:-}"
case " $ALL_SECRETS " in *" $SECRET "*) [ -n "$SECRET" ] ;; *) false ;; esac && case "$VER" in ''|*[!0-9]*) false ;; *) true ;; esac \
  || { echo "Usage: $0 <SECRET> <VERSION>   SECRET one of: $ALL_SECRETS" >&2; exit 2; }
new_out "r91-$SECRET-v$VER"
need_tools gcloud python3 git

say "ZIPPER credential rotation — 91 re-enable $SECRET version $VER   $TS"
who
require_clean
latest_enabled "$SECRET" > /dev/null
sed 's/^/   /' "$OUT/versions-$SECRET.txt" | tee -a "$OUT/SUMMARY.txt"
grep -q "^VERSION $VER ENABLED " "$OUT/versions-$SECRET.txt" && { say "$SECRET version $VER is already ENABLED — nothing to do"; finish; }
grep -q "^VERSION $VER DISABLED " "$OUT/versions-$SECRET.txt" || stop "$SECRET version $VER is not DISABLED (destroyed versions cannot come back)"
confirm ENABLE "re-enable version $VER of $SECRET (rollback of rot-90)"
gcloud secrets versions enable "$VER" --secret "$SECRET" --project zipper-83816 --format=none 2>>"$ERR"  #MUT-R91-ENABLE
say "exit code: $?"
latest_enabled "$SECRET" > /dev/null
grep -q "^VERSION $VER ENABLED " "$OUT/versions-$SECRET.txt" && check ok "$SECRET version $VER ENABLED" || check "see versions-$SECRET.txt" "$SECRET version $VER ENABLED"
finish
