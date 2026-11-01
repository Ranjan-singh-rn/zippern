#!/bin/bash
# ZIPPER credential rotation (FINAL PHASE, prepared) — 85: redeploy the functions that hold a rotated credential, with
# UNCHANGED code (functions/ exactly as committed at the released HEAD, via git archive).
# Usage: rot-85-functions-redeploy.command <ZIPPER_SENDGRID_API_KEY|ZIPPER_ACCRUAL_KEY|ZIPPER_REPORTING_KEY|ZIPPER_PARTNER_REGISTRATION_KEY|AGORA>
#   <SECRET> — every function that references the secret TODAY (found read-only) is redeployed, so Firebase pins the
#              newest ENABLED version you added in the console (MANUAL). Refuses unless such a newer version exists.
#              Every environment name and value must equal functions/.env (compared as hashes, never shown).
#   AGORA    — generateAgoraToken only, after you changed AGORA_APP_CERTIFICATE in functions/.env by hand (MANUAL).
#              That one value must DIFFER from what the function runs with; every other name and value must be equal.
#              Needs the completion release's wave 2b (21-functions-2b evidence with RESULT: PASS).
# Production change (after you type REDEPLOY), exactly:
#   firebase deploy --only functions:<names> --project zipper-83816 --non-interactive
# from a fresh folder: functions/ of HEAD (tree hash = RELEASE.txt) + firebase.json's functions section + a copy of
# functions/.env (never displayed; removed on exit). npm ci + build run first (the release already ran the tests).
# After: only those functions changed (scope), all ACTIVE, the new secret version pinned / environment equal to .env.
# Rollback: fix forward (Firebase pins the newest ENABLED version; ROTATION-RUNBOOK.md). Results: ./production/r85-<mode>-<UTC>/
set -u
umask 077
[ -f "$(dirname "$0")/FINAL-PHASE-APPROVED" ] || { echo "REFUSING: final phase not approved — no FINAL-PHASE-APPROVED in $(dirname "$0") (ROTATION-RUNBOOK.md §0)" >&2; exit 2; }
. "$(dirname "$0")/rot_common.sh"
verify_scripts
MODE="${1:-}"
case " $FN_SECRETS AGORA " in *" $MODE "*) [ -n "$MODE" ] ;; *) false ;; esac || { echo "Usage: $0 <$(echo $FN_SECRETS | tr ' ' '|')|AGORA>" >&2; exit 2; }
new_out "r85-$MODE"
DEPLOY="$OUT/deploy"
trap 'rm -f "$DEPLOY/functions/.env"; rm -rf "$DEPLOY/functions/node_modules"' EXIT
need_tools gcloud firebase npm python3 git tar

say "ZIPPER credential rotation — 85 functions redeploy ($MODE)   $TS"
who
require_clean
sunday_guard

fn_index "$OUT/index-before.txt"
if [ "$MODE" = AGORA ]; then
  L21="$(ls -d "$REPO/release/completion-20261101/production/21-functions-2b-"*Z 2>/dev/null | LC_ALL=C sort | tail -1)"
  [ -n "$L21" ] && grep -q '^RESULT: PASS' "$L21/SUMMARY.txt" 2>/dev/null || stop "wave 2b of the completion release has no PASS evidence (21-functions-2b) — rotate Agora only after it"
  check ok "wave 2b live ($(basename "$L21"))"
  grep "^IDX $AGORA_FN " "$OUT/index-before.txt" > "$OUT/targets.txt" || stop "$AGORA_FN not found"
else
  V="$(latest_enabled "$MODE")"
  sed 's/^/   /' "$OUT/versions-$MODE.txt" | tee -a "$OUT/SUMMARY.txt"
  [ "$V" != none ] || stop "$MODE has no ENABLED version"
  grep -E "^IDX [^ ]+ [^ ]+ secrets=([^ ]*,)?$MODE:" "$OUT/index-before.txt" > "$OUT/targets.txt" || stop "no function references $MODE"
  grep -Eq "secrets=([^ ]*,)?$MODE:$V(,| )" "$OUT/targets.txt" && ! grep -Evq "secrets=([^ ]*,)?$MODE:$V(,| )" "$OUT/targets.txt" \
    && { say "every function referencing $MODE already pins version $V — nothing to do"; finish; }
fi
NAMES="$(awk '{print $2}' "$OUT/targets.txt" | tr '\n' ' ')"
say "   targets: $NAMES"

# The deploy tree: committed functions/ at HEAD, hash-checked against RELEASE.txt, plus the functions section only.
mkdir -p "$DEPLOY" || exit 2
( git -C "$REPO" archive --format=tar HEAD functions | tar -x -C "$DEPLOY" ) 2>>"$ERR" || stop "git archive of functions/ failed"
git -C "$REPO" show HEAD:firebase.json 2>>"$ERR" | python3 -I -c 'import json,sys; j=json.load(sys.stdin); json.dump({"functions": j["functions"]}, sys.stdout, indent=2)' > "$DEPLOY/firebase.json" || stop "no functions section in firebase.json"
WANT_TREE="$(grep '^TREE functions ' "$RELEASE_TXT" | head -1)"
[ -n "$WANT_TREE" ] && [ "$($H tree-sha "$REPO" HEAD functions)" = "$WANT_TREE" ] && check ok "deploy tree = RELEASE.txt functions tree" || stop "functions/ at HEAD does not match RELEASE.txt's TREE functions line"
( cd "$DEPLOY/functions" && npm ci --no-audit --no-fund > "$OUT/npm-ci.log" 2>&1 && npm run build > "$OUT/build.log" 2>&1 ) || stop "npm ci / build failed (npm-ci.log, build.log)"
check ok "npm ci + build on the exact tree"
[ -f "$FN_ENV" ] || stop "$FN_ENV not found"
cp "$FN_ENV" "$DEPLOY/functions/.env" && chmod 600 "$DEPLOY/functions/.env" || stop "could not copy functions/.env"

: > "$OUT/env-drift.txt"
while read -r _ f region _; do fn_describe "$region" "$f" "$DEPLOY/functions/.env" | grep '^ENV ' >> "$OUT/env-drift.txt"; done < "$OUT/targets.txt"
awk '{print $4}' "$OUT/env-drift.txt" | sort | uniq -c | sed 's/^/   verdicts: /' | tee -a "$OUT/SUMMARY.txt"
grep -E ' (DIFFERENT|only-deployed)$' "$OUT/env-drift.txt" | sed 's/^/   /' | tee -a "$OUT/SUMMARY.txt"
if [ "$MODE" = AGORA ]; then
  grep -q "^ENV $AGORA_FN $AGORA_ENV DIFFERENT\$" "$OUT/env-drift.txt" || stop "$AGORA_ENV in functions/.env equals what $AGORA_FN runs with — put the NEW certificate in functions/.env first (MANUAL)"
  grep -E ' (DIFFERENT|only-deployed)$' "$OUT/env-drift.txt" | grep -vq "^ENV $AGORA_FN $AGORA_ENV DIFFERENT\$" && stop "functions/.env differs by more than $AGORA_ENV (names above; values not shown)"
  check ok "functions/.env differs from the deployed environment only by $AGORA_ENV"
else
  grep -qE ' (DIFFERENT|only-deployed)$' "$OUT/env-drift.txt" && stop "functions/.env differs from what these functions run with (names above; values not shown)"
  check ok "environment unchanged by this redeploy (same names, same values)"
fi

fn_list "$OUT/all-before.tsv"
ONLY=""; for f in $NAMES; do ONLY="$ONLY${ONLY:+,}functions:$f"; done
confirm REDEPLOY "redeploy $NAMES with unchanged code$( [ "$MODE" = AGORA ] && echo " and the new $AGORA_ENV" || echo " so they pin $MODE version $V" ) (nothing else)"
( cd "$DEPLOY" && firebase deploy --only "$ONLY" --project zipper-83816 --non-interactive ) > "$OUT/firebase-deploy.log" 2>&1  #MUT-R85-DEPLOY
rc=$?
tail -15 "$OUT/firebase-deploy.log" | sed 's/^/   | /' | tee -a "$OUT/SUMMARY.txt"
[ $rc -eq 0 ] && check ok "deploy exit 0" || check "exit $rc" "deploy"

say ""; say "== After"
fn_list "$OUT/all-after.tsv"
$H compare-lists "$OUT/all-before.tsv" "$OUT/all-after.tsv" "$(echo $NAMES | tr ' ' ',')" > "$OUT/scope.txt"
sed 's/^/   /' "$OUT/scope.txt" | tee -a "$OUT/SUMMARY.txt"
grep -q '^SCOPE PASS' "$OUT/scope.txt" && check ok "only the target functions changed" || check "see scope.txt" "only the target functions changed"
: > "$OUT/env-drift-after.txt"
while read -r _ f region _; do
  line="$(fn_describe "$region" "$f" "$DEPLOY/functions/.env" | tee -a "$OUT/env-drift-after.txt" | grep '^FN ')"
  case "$line" in *" status=ACTIVE "*) check ok "$f ACTIVE";; *) check "not ACTIVE" "$f ACTIVE";; esac
  if [ "$MODE" != AGORA ]; then
    printf '%s' "$line" | grep -Eq "secrets=([^ ]*,)?$MODE:$V(,| )" && check ok "$f pins $MODE:$V" || check "not pinned" "$f pins $MODE:$V"
  fi
done < "$OUT/targets.txt"
grep -qE '^ENV .* (DIFFERENT|only-deployed|only-in-.env)$' "$OUT/env-drift-after.txt" && check "see env-drift-after.txt" "deployed environment equals functions/.env" || check ok "deployed environment equals functions/.env"
for f in $NAMES; do
  n="$(gcloud logging read "severity>=ERROR AND resource.labels.function_name=\"$f\"" --project "$P" --freshness=15m --limit 100 --format='value(timestamp)' 2>>"$ERR" | grep -c .)"  #RO
  say "   ERROR entries of $f in the last 15 min: $n"
done
finish
