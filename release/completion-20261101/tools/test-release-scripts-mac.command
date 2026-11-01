#!/bin/bash
# ZIPPER completion release — the production scripts' local test on this Mac (bash 3.2, the shell Terminal uses).
# LOCAL ONLY: gcloud, firebase, npm, node, curl, sleep, the backend venv python, aapt2 and apksigner are replaced by
# stubs inside a throwaway git repository; outbound network is denied by sandbox-exec except to this Mac itself.
# Nothing in Google Cloud, Firebase, SendGrid or this repository is contacted or changed (the throwaway copy lives
# in a temporary folder and is deleted afterwards). Reads this folder only.
# Results: ./scripts-mac-<UTC>/ next to this script (git-ignored).
set -u
umask 077
BAD='(^|[^#]*[[:space:];|&(])(gcloud|gsutil|curl|wget|git|ssh|scp|sudo|pip|pip3|npm|npx|firebase)[[:space:]]'  #GUARD
if [ "$(grep -vE '^[[:space:]]*#|#GUARD$' "$0" | grep -cE "$BAD")" != 0 ]; then echo "REFUSING TO RUN: guard failed." >&2; exit 2; fi  #GUARD
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REL="$(cd "$HERE/.." && pwd -P)"
TS="$(date -u +%Y%m%dT%H%M%SZ)"; OUT="$HERE/scripts-mac-$TS"
mkdir -p "$OUT" && chmod 700 "$OUT" || exit 2
echo "ZIPPER completion release — production scripts, local test on this Mac   $TS" | tee "$OUT/SUMMARY.txt"
echo "bash $(/bin/bash -c 'echo $BASH_VERSION')   python $(/usr/bin/python3 --version 2>&1)" | tee -a "$OUT/SUMMARY.txt"
PROFILE='(version 1) (allow default) (deny network-outbound (remote ip "*:*")) (allow network-outbound (remote ip "localhost:*"))'
sandbox-exec -p "$PROFILE" /usr/bin/python3 -I "$HERE/test_release_scripts.py" "$REL" > "$OUT/result.txt" 2>&1
rc=$?
grep -E '^FAIL' "$OUT/result.txt" | head -30 | tee -a "$OUT/SUMMARY.txt"
tail -2 "$OUT/result.txt" | tee -a "$OUT/SUMMARY.txt"
echo "RESULT: $([ $rc -eq 0 ] && echo PASS || echo "FAIL (exit $rc)")" | tee -a "$OUT/SUMMARY.txt"
echo "Saved: $OUT"
echo "== finished $(date)"
