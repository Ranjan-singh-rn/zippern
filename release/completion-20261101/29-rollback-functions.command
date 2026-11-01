#!/bin/bash
# ZIPPER completion release — 29: ROLLBACK of a Functions wave. Usage: 29-rollback-functions.command <2a|2b>
# Redeploys the SAME function names from the functions/ tree of BASE_COMMIT (RELEASE.txt) — by default the commit of
# branch prod-live-20261030 (4e21b7f, tag prod-live-20261030-tag; make-release-txt.sh resolves refs/heads/…): the
# exact production Functions tree, i.e. the 20 Oct baseline plus the SendGrid wave-A files (src/index.ts, src/mail.ts,
# src/emailOtp.ts) live since 30 Oct, so a rollback restores the byte-exact production code of the wave. Refuses a
# BASE_COMMIT of f1af30a: NOT production — its functions/ carries the unshipped Owner-MFA gate (src/ownerMfa.ts,
# profiles.ts, storageClaims.ts); regenerate RELEASE.txt with ./make-release-txt.sh. How the previous tree is
# obtained: `git worktree add --detach <evidence>/worktree <BASE_COMMIT>` (a read-only checkout of that commit next to
# the evidence; removed afterwards; the working tree you edit is never touched or deployed), then functions/ is copied
# out of it and its hash is checked against `git ls-tree` of the same commit. npm ci, tsc and every test run on that
# tree first.
# Production change (after you type ROLLBACK), exactly:
#   firebase deploy --only functions:<the wave's names> --project zipper-83816 --non-interactive
# When the SendGrid base hash file is present, this script reports per source file whether the rollback text equals
# the 20 Oct deployed text (only the three wave-A files may differ). Not changed: secrets, grants, every other
# function, rules, hosting, Cloud Run.
# Results: ./production/29-rollback-functions-<wave>-<UTC>/
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
. "$HERE/rel_deploy_lib.sh"
verify_scripts
WAVE_ID="${1:-}"
case "$WAVE_ID" in 2a) WAVE="$WAVE_2A";; 2b) WAVE="$WAVE_2B";; *) echo "Usage: $0 <2a|2b>" >&2; exit 2;; esac
new_out "29-rollback-functions-$WAVE_ID"
WT="$OUT/worktree"
cleanup() {
  rm -f "$OUT/deploy/functions/.env"; rm -rf "$OUT/deploy/functions/node_modules"
  [ -d "$WT" ] && git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1  #LOCAL-GIT
}
trap cleanup EXIT
need_tools gcloud firebase node npm python3 git shasum tar

say "ZIPPER completion release — 29 ROLLBACK of Functions wave $WAVE_ID   $TS"
who
require_release
[ "$BASE_COMMIT" != "$NOT_PROD_FN_COMMIT" ] || stop "BASE_COMMIT in RELEASE.txt is $(printf '%s' "$BASE_COMMIT" | cut -c1-12) (f1af30a) — NOT production: its functions/ carries the unshipped Owner-MFA gate. Regenerate RELEASE.txt with ./make-release-txt.sh (default: the production tree $PROD_FN_REF)"
if [ "$BASE_COMMIT" = "$PROD_FN_COMMIT" ]; then BASE_DESC="the production Functions tree $PROD_FN_REF"
else BASE_DESC="an explicit BASE_COMMIT, NOT the production tree $PROD_FN_REF ($(printf '%s' "$PROD_FN_COMMIT" | cut -c1-12))"; fi
say "wave $WAVE_ID: $WAVE"
say "rollback source: functions/ at BASE_COMMIT $(printf '%s' "$BASE_COMMIT" | cut -c1-12) = $BASE_DESC"

fn_state "$OUT/functions-before.txt" $WAVE
sed 's/^/   before: /' "$OUT/functions-before.txt" | tee -a "$OUT/SUMMARY.txt"
EXISTING="$(existing_of $WAVE)"
[ -n "$EXISTING" ] || stop "none of the wave's functions exists; nothing to roll back"
for f in $WAVE; do case " $EXISTING " in *" $f "*) ;; *) say "   note: $f does not exist in production; a rollback to BASE_COMMIT cannot create it and it is left out";; esac; done
ROLL="$EXISTING"

# The previous tree: a detached worktree of BASE_COMMIT next to the evidence, copied out, hash-checked, removed on exit.
git -C "$REPO" worktree add --detach "$WT" "$BASE_COMMIT" > "$OUT/worktree.log" 2>&1 || stop "git worktree add failed (worktree.log)"  #LOCAL-GIT
[ -d "$WT/functions/src" ] || stop "the worktree has no functions/src"
DEPLOY="$OUT/deploy"; mkdir -p "$DEPLOY" || exit 2
( cd "$WT" && tar -cf - functions ) | ( cd "$DEPLOY" && tar -xf - ) || stop "copying functions/ out of the worktree failed"
rm -rf "$DEPLOY/functions/node_modules" "$DEPLOY/functions/lib" "$DEPLOY/functions/.env" "$DEPLOY/functions/.env."* 2>/dev/null
WANT_TREE="$($H tree-sha "$REPO" "$BASE_COMMIT" functions)"
GOT_TREE="$(cd "$DEPLOY" && find functions -type f ! -path '*/node_modules/*' -print0 | LC_ALL=C sort -z | xargs -0 -n1 sh -c 'printf "%s  %s\n" "$(shasum -a 256 "$1" | cut -c1-64)" "$1"' sh | shasum -a 256 | cut -c1-64)"
say "   $WANT_TREE"
say "   copied tree sha256 $GOT_TREE ($(cd "$DEPLOY" && find functions -type f | grep -c .) files)"
[ "$(printf '%s' "$WANT_TREE" | awk '{print $3}')" = "$GOT_TREE" ] && check ok "copied functions/ equals git ls-tree of BASE_COMMIT" || stop "the copied tree does not match BASE_COMMIT (worktree carried extra files?)"
git -C "$REPO" show "$BASE_COMMIT:firebase.json" 2>>"$ERR" | python3 -I -c '
import json, sys
j = json.load(sys.stdin)
json.dump({"functions": j["functions"]}, sys.stdout, indent=2); print()
' > "$DEPLOY/firebase.json" || stop "could not derive firebase.json at BASE_COMMIT"
SGBASE="$HOME/zipper-release/sendgrid-email-20261030T204905Z/base/functions-deployed-tree.sha256"
if [ -f "$SGBASE" ]; then
  say "   per source file vs the 20 Oct deployed text (informational; only the wave-A files may differ):"
  for src in calls gifts luckyGifts payouts time profiles storageClaims identity index mail emailOtp agoraUid; do
    f="$DEPLOY/functions/src/$src.ts"; [ -f "$f" ] || continue
    h="$(shasum -a 256 "$f" | cut -c1-64)"
    if grep -q "^$h  ./src/$src.ts\$" "$SGBASE"; then say "      src/$src.ts = 20 Oct deployed text"
    else case " index mail emailOtp " in
      *" $src "*) say "      src/$src.ts differs from the 20 Oct deployed text (SendGrid wave-A file, live since 30 Oct)";;
      *) say "      src/$src.ts differs from the 20 Oct deployed text — NOT a wave-A file: check BASE_COMMIT";;
    esac; fi
  done
fi
install_build_test
add_env
env_drift $ROLL

all_functions "$OUT/all-before.tsv"
ONLY="$(fn_only $ROLL)"; CSV="$(echo $ROLL | tr ' ' ',')"
say "   --only $ONLY"
confirm ROLLBACK "redeploy $ROLL from the functions/ tree of BASE_COMMIT $(printf '%s' "$BASE_COMMIT" | cut -c1-12) ($BASE_DESC; nothing else)"
( cd "$DEPLOY" && firebase deploy --only "$ONLY" --project zipper-83816 --non-interactive ) > "$OUT/firebase-deploy.log" 2>&1  #MUT-ROLLBACK-FN
rc=$?
tail -25 "$OUT/firebase-deploy.log" | sed 's/^/   | /' | tee -a "$OUT/SUMMARY.txt"
[ $rc -eq 0 ] && check ok "firebase deploy exit 0" || check "exit $rc" "firebase deploy"

say ""; say "== After"
verify_after "$CSV" $ROLL
finish
