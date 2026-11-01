#!/bin/bash
# ZIPPER credential rotation — local test of the rot-*.command skeletons on this Mac (bash 3.2, the shell Terminal uses).
# LOCAL ONLY: gcloud, firebase, npm, curl and date are stubs in a throwaway folder with its own throwaway git
# repository; outbound network is denied by sandbox-exec except to this Mac itself. Nothing in Google Cloud, Firebase,
# SendGrid, Agora or Atlas is contacted or changed, and the real repository is only read (the folder is copied).
# Needs no FINAL-PHASE-APPROVED: it runs nothing against production. Results: ../production/test-rotation-<UTC>/
set -u
umask 077
BAD='(^|[^#]*[[:space:];|&(])(gcloud|gsutil|curl|wget|git|ssh|scp|sudo|pip|pip3|npm|npx|firebase)[[:space:]]'  #GUARD
if [ "$(grep -vE '^[[:space:]]*#|#GUARD$' "$0" | grep -cE "$BAD")" != 0 ]; then echo "REFUSING TO RUN: guard failed." >&2; exit 2; fi  #GUARD
HERE="$(cd "$(dirname "$0")" && pwd -P)"
ROT="$(cd "$HERE/.." && pwd -P)"
TS="$(date -u +%Y%m%dT%H%M%SZ)"; OUT="$ROT/production/test-rotation-$TS"
mkdir -p "$OUT" && chmod 700 "$ROT/production" "$OUT" || exit 2
for d in /opt/homebrew/bin /usr/local/bin; do [ -d "$d" ] && PATH="$PATH:$d"; done; export PATH
echo "ZIPPER credential rotation — rot-*.command local test on this Mac   $TS" | tee "$OUT/SUMMARY.txt"
echo "bash $(/bin/bash -c 'echo $BASH_VERSION')   python $(python3 --version 2>&1)" | tee -a "$OUT/SUMMARY.txt"
PROFILE='(version 1) (allow default) (deny network-outbound (remote ip "*:*")) (allow network-outbound (remote ip "localhost:*"))'
sandbox-exec -p "$PROFILE" python3 -I "$HERE/test_rotation_scripts.py" "$ROT" > "$OUT/result.txt" 2>&1
rc=$?
grep -E '^FAIL' "$OUT/result.txt" | head -20 | tee -a "$OUT/SUMMARY.txt"
tail -2 "$OUT/result.txt" | tee -a "$OUT/SUMMARY.txt"
echo "RESULT: $([ $rc -eq 0 ] && echo PASS || echo "FAIL (exit $rc)")" | tee -a "$OUT/SUMMARY.txt"
echo "Saved: $OUT"
echo "== finished $(date)"
