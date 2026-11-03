#!/bin/bash
# ZIPPER Track B release — 29: ROLLBACK of a Functions wave of THIS release.
# Usage: 29-rollback-functions.command <2a|2b> [<evidence folder of 20 (2a) or 21 (2b)>]
#   2a = wave A (20), 2b = wave B (21) — the internal names of the completion release are kept.
# Without a folder: every function of the wave that exists. With the folder of a 20/21 run (production/20-functions-2a-
# <UTC> or production/21-functions-2b-<UTC>): EXACTLY the functions that run updated — its updated.txt (updateTime
# changed), e.g. after a deploy that stopped part-way on the write quota; its not-updated.txt ones are left alone.
# Each function goes back to the code it ran BEFORE this release (rel_common.sh), so the selection is split by base:
#   FN_BASE_LIVE -> the functions/ tree of LIVE_FN_COMMIT (RELEASE.txt; cf64145 = what the completion wave 2a runs
#                   since 2 Nov)
#   FN_BASE_PROD -> the functions/ tree of BASE_COMMIT (RELEASE.txt; by default branch prod-live-20261030 = 4e21b7f, the
#                   20 Oct baseline + the SendGrid wave-A files: what the completion wave 2b ran until this release)
#   WAVE_2A_NEW  -> NOT rolled back: new in this release, no older code exists. They stay deployed (never deleted here);
#                   old apps never call them. Listed in the output.
# Refuses a BASE_COMMIT or LIVE_FN_COMMIT of f1af30a: NOT production — its functions/ carries the unshipped Owner-MFA
# gate (src/ownerMfa.ts, profiles.ts, storageClaims.ts); regenerate RELEASE.txt with ./make-release-txt.sh.
# How each previous tree is obtained: `git worktree add --detach <evidence>/worktree-<base> <commit>` (a read-only
# checkout of that commit next to the evidence; removed afterwards; the working tree you edit is never touched or
# deployed), then functions/ is copied out of it and its hash is checked against `git ls-tree` of the same commit.
# npm ci, tsc and every test run on that tree first.
# Both groups are prepared and tested first; then, after you type ROLLBACK once, per group, exactly:
#   firebase deploy --only functions:<the group's names> --project zipper-83816 --non-interactive
# (the LIVE group first, then the PROD group; a LIVE group that does not verify stops the run before the PROD deploy;
# a rollback that itself ends non-zero is reported like 20: SCOPE PARTIAL, updated-<g>.txt / not-updated-<g>.txt).
# When the SendGrid base hash file is present, this script reports per source file of the PROD tree whether it equals
# the 20 Oct deployed text (only the three wave-A files may differ). Not changed: secrets, grants, every other
# function, rules, hosting, Cloud Run.
# Results: ./production/29-rollback-functions-<wave>-<UTC>/
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
. "$HERE/rel_deploy_lib.sh"
verify_scripts
WAVE_ID="${1:-}"; SRC_DIR="${2:-}"
case "$WAVE_ID" in
  2a) WAVE="$WAVE_2A"; EVIDENCE_GLOB='20-functions-2a-*Z';;
  2b) WAVE="$WAVE_2B"; EVIDENCE_GLOB='21-functions-2b-*Z';;
  *) echo "Usage: $0 <2a|2b> [<evidence folder of 20 or 21>]" >&2; exit 2;;
esac
new_out "29-rollback-functions-$WAVE_ID"
cleanup() {
  local g
  for g in live prod; do
    rm -f "$OUT/deploy-$g/functions/.env"; rm -rf "$OUT/deploy-$g/functions/node_modules"
    [ -d "$OUT/worktree-$g" ] && git -C "$REPO" worktree remove --force "$OUT/worktree-$g" >/dev/null 2>&1  #LOCAL-GIT
  done
}
trap cleanup EXIT
need_tools gcloud firebase node npm python3 git shasum tar

say "ZIPPER Track B release — 29 ROLLBACK of Functions wave $WAVE_ID   $TS"
who
require_release
[ "$BASE_COMMIT" != "$NOT_PROD_FN_COMMIT" ] || stop "BASE_COMMIT in RELEASE.txt is $(printf '%s' "$BASE_COMMIT" | cut -c1-12) (f1af30a) — NOT production: its functions/ carries the unshipped Owner-MFA gate. Regenerate RELEASE.txt with ./make-release-txt.sh (default: the production tree $PROD_FN_REF)"
LIVE_COMMIT="$(sed -n 's/^LIVE_FN_COMMIT=//p' "$RELEASE_TXT" | head -1)"
[ -n "$LIVE_COMMIT" ] || stop "RELEASE.txt has no LIVE_FN_COMMIT line — regenerate it with ./make-release-txt.sh"
[ "$LIVE_COMMIT" = "$LIVE_FN_COMMIT" ] || stop "RELEASE.txt LIVE_FN_COMMIT $(printf '%s' "$LIVE_COMMIT" | cut -c1-12) is not rel_common.sh's $(printf '%s' "$LIVE_FN_COMMIT" | cut -c1-12)"
[ "$LIVE_COMMIT" != "$NOT_PROD_FN_COMMIT" ] || stop "LIVE_FN_COMMIT is f1af30a — NOT production"
if [ "$BASE_COMMIT" = "$PROD_FN_COMMIT" ]; then BASE_DESC="the production Functions tree $PROD_FN_REF"
else BASE_DESC="an explicit BASE_COMMIT, NOT the production tree $PROD_FN_REF ($(printf '%s' "$PROD_FN_COMMIT" | cut -c1-12))"; fi
if [ -n "$SRC_DIR" ]; then
  [ -d "$SRC_DIR" ] || stop "evidence folder not found: $SRC_DIR"
  case "$(basename "$SRC_DIR")" in $EVIDENCE_GLOB) ;; *) stop "$(basename "$SRC_DIR") is not an evidence folder of wave $WAVE_ID ($EVIDENCE_GLOB)";; esac
  [ -f "$SRC_DIR/updated.txt" ] || stop "$SRC_DIR has no updated.txt (an older run): roll back the whole wave (no folder argument)"
  SEL=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    printf '%s' "$f" | grep -Eq '^[A-Za-z][A-Za-z0-9_]*$' || stop "$(basename "$SRC_DIR")/updated.txt holds a line that is not a function name"
    case " $WAVE " in *" $f "*) SEL="$SEL $f";; *) stop "$(basename "$SRC_DIR")/updated.txt names $f, which is not in wave $WAVE_ID";; esac
  done < "$SRC_DIR/updated.txt"
  [ -n "$SEL" ] || stop "$(basename "$SRC_DIR") updated no function (updated.txt is empty) — nothing to roll back"
  say "rolling back EXACTLY the $(echo $SEL | wc -w | tr -d ' ') function(s) $(basename "$SRC_DIR") updated (updated.txt); the $(cat "$SRC_DIR/not-updated.txt" 2>/dev/null | grep -c .) in its not-updated.txt are left as they are"
  WAVE="$(echo $SEL)"
fi
say "wave $WAVE_ID: $WAVE"

fn_state "$OUT/functions-before.txt" $WAVE
sed 's/^/   before: /' "$OUT/functions-before.txt" | tee -a "$OUT/SUMMARY.txt"
EXISTING="$(existing_of $WAVE)"
[ -n "$EXISTING" ] || stop "none of the wave's functions exists; nothing to roll back"
for f in $WAVE; do case " $EXISTING " in *" $f "*) ;; *) say "   note: $f does not exist in production; nothing to roll back for it";; esac; done
ROLL_LIVE=""; ROLL_PROD=""; LEFT_NEW=""
for f in $EXISTING; do
  case " $FN_BASE_LIVE " in *" $f "*) ROLL_LIVE="$ROLL_LIVE $f"; continue;; esac
  case " $FN_BASE_PROD " in *" $f "*) ROLL_PROD="$ROLL_PROD $f"; continue;; esac
  case " $WAVE_2A_NEW " in *" $f "*) LEFT_NEW="$LEFT_NEW $f"; continue;; esac
  stop "$f has no rollback base in rel_common.sh (FN_BASE_LIVE, FN_BASE_PROD or WAVE_2A_NEW) — nothing was rolled back"
done
ROLL_LIVE="$(echo $ROLL_LIVE)"; ROLL_PROD="$(echo $ROLL_PROD)"; LEFT_NEW="$(echo $LEFT_NEW)"
say "   to LIVE_FN_COMMIT $(printf '%s' "$LIVE_COMMIT" | cut -c1-12) (cf64145, the tree they ran before this release): ${ROLL_LIVE:-none}"
say "   to BASE_COMMIT $(printf '%s' "$BASE_COMMIT" | cut -c1-12) ($BASE_DESC): ${ROLL_PROD:-none}"
[ -n "$LEFT_NEW" ] && say "   NOT rolled back — new in this release, no older code exists; they stay deployed (old apps never call them): $LEFT_NEW"
[ -n "$ROLL_LIVE$ROLL_PROD" ] || { say "nothing to roll back: every selected function is new in this release"; finish; }

# prepare_group <live|prod> <commit>: the previous tree of <commit> in deploy-<g> (detached worktree, copied out,
# hash-checked, the whole commit beside it for the tests), npm ci + tsc + every test, functions/.env copied (never
# shown) and compared with what the group's functions run today. Changes nothing in production.
prepare_group() {
  local g="$1" commit="$2" WT want_tree got_tree f h src
  say ""; say "== prepare group $g (tree of $(printf '%s' "$commit" | cut -c1-12))"
  WT="$OUT/worktree-$g"
  git -C "$REPO" worktree add --detach "$WT" "$commit" > "$OUT/worktree-$g.log" 2>&1 || stop "git worktree add failed (worktree-$g.log)"  #LOCAL-GIT
  [ -d "$WT/functions/src" ] || stop "the worktree of $g has no functions/src"
  DEPLOY="$OUT/deploy-$g"; mkdir -p "$DEPLOY" || exit 2
  # The rest of the commit next to functions/: the functions tests read files outside functions/ (firestore.rules,
  # setup-email-and-deploy.command, deleteUsers.js, an Android source). Only functions/ is deployed.
  ( git -C "$REPO" archive --format=tar "$commit" | tar -x -C "$DEPLOY" ) 2>>"$ERR" || stop "git archive of $g ($commit) failed"
  ( cd "$WT" && tar -cf - functions ) | ( cd "$DEPLOY" && tar -xf - ) || stop "copying functions/ out of the $g worktree failed"
  rm -rf "$DEPLOY/functions/node_modules" "$DEPLOY/functions/lib" "$DEPLOY/functions/.env" "$DEPLOY/functions/.env."* 2>/dev/null
  want_tree="$($H tree-sha "$REPO" "$commit" functions)"
  got_tree="$(cd "$DEPLOY" && find functions -type f ! -path '*/node_modules/*' -print0 | LC_ALL=C sort -z | xargs -0 -n1 sh -c 'printf "%s  %s\n" "$(shasum -a 256 "$1" | cut -c1-64)" "$1"' sh | shasum -a 256 | cut -c1-64)"
  say "   $want_tree"
  say "   copied tree sha256 $got_tree ($(cd "$DEPLOY" && find functions -type f | grep -c .) files)"
  [ "$(printf '%s' "$want_tree" | awk '{print $3}')" = "$got_tree" ] && check ok "copied functions/ ($g) equals git ls-tree of $(printf '%s' "$commit" | cut -c1-12)" || stop "the copied $g tree does not match its commit (worktree carried extra files?)"
  git -C "$REPO" show "$commit:firebase.json" 2>>"$ERR" | python3 -I -c '
import json, sys
j = json.load(sys.stdin)
json.dump({"functions": j["functions"]}, sys.stdout, indent=2); print()
' > "$DEPLOY/firebase.json" || stop "could not derive firebase.json at $g ($commit)"
  if [ "$g" = prod ]; then
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
  fi
  install_build_test
  add_env
  shift 2
  env_drift "$@"
  for f in tests.log npm-ci.log build.log env-names.txt env-drift.txt; do
    [ -f "$OUT/$f" ] && mv "$OUT/$f" "$OUT/${f%.*}-$g.${f##*.}"
  done
}

# deploy_group <live|prod> <names...>: ONE deploy from the prepared tree, then the scope/identity/env checks.
deploy_group() {
  local g="$1" rc f; shift
  DEPLOY="$OUT/deploy-$g"
  all_functions "$OUT/all-before.tsv"
  ONLY="$(fn_only "$@")"; CSV="$(echo "$@" | tr ' ' ',')"
  say ""; say "== deploy group $g: --only $ONLY"
  if [ "$g" = live ]; then
    ( cd "$DEPLOY" && firebase deploy --only "$ONLY" --project zipper-83816 --non-interactive ) > "$OUT/firebase-deploy-$g.log" 2>&1  #MUT-ROLLBACK-FN-LIVE
    rc=$?
  else
    ( cd "$DEPLOY" && firebase deploy --only "$ONLY" --project zipper-83816 --non-interactive ) > "$OUT/firebase-deploy-$g.log" 2>&1  #MUT-ROLLBACK-FN-PROD
    rc=$?
  fi
  tail -25 "$OUT/firebase-deploy-$g.log" | sed 's/^/   | /' | tee -a "$OUT/SUMMARY.txt"
  [ $rc -eq 0 ] && check ok "firebase deploy ($g) exit 0" || check "exit $rc" "firebase deploy ($g)"
  say ""; say "== After ($g)"
  verify_after "$CSV" "$@"
  # this group's verdict files under their own names (the other group writes the same ones)
  for f in all-before.tsv all-after.tsv scope.txt updated.txt not-updated.txt functions-after.txt env-drift-after.txt; do
    [ -f "$OUT/$f" ] && mv "$OUT/$f" "$OUT/${f%.*}-$g.${f##*.}"
  done
}

[ -n "$ROLL_LIVE" ] && prepare_group live "$LIVE_COMMIT" $ROLL_LIVE
[ -n "$ROLL_PROD" ] && prepare_group prod "$BASE_COMMIT" $ROLL_PROD
[ "$FAILS" = 0 ] || stop "a check failed while preparing the rollback trees — nothing was deployed"
WHAT=""
[ -n "$ROLL_LIVE" ] && WHAT="$ROLL_LIVE from the tree of $(printf '%s' "$LIVE_COMMIT" | cut -c1-12) (cf64145, what they ran since 2 Nov)"
[ -n "$ROLL_PROD" ] && WHAT="$WHAT${WHAT:+; then }$ROLL_PROD from the tree of $(printf '%s' "$BASE_COMMIT" | cut -c1-12) ($BASE_DESC)"
confirm ROLLBACK "redeploy $WHAT — nothing else${LEFT_NEW:+ (the new functions stay: $LEFT_NEW)}"
[ -n "$ROLL_LIVE" ] && deploy_group live $ROLL_LIVE
[ "$FAILS" = 0 ] || finish "the LIVE group did not verify — the PROD group was NOT deployed${ROLL_PROD:+ ($ROLL_PROD still run the code of this release)}"
[ -n "$ROLL_PROD" ] && deploy_group prod $ROLL_PROD
finish
