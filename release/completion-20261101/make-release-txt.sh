#!/bin/bash
# ZIPPER completion release — write ./RELEASE.txt for the reviewed commit. LOCAL ONLY: reads git, writes RELEASE.txt
# (git-ignored) and an evidence folder; contacts nothing and changes nothing in production or in git.
# Usage: ./make-release-txt.sh [BASE_COMMIT]
#   BASE_COMMIT = the Functions rollback base: the functions/ tree 29 redeploys. DEFAULT (no argument): the exact
#   production Functions tree, branch prod-live-20261030 (4e21b7f "Production as live since 30 Oct 2026: 20 Oct baseline
#   + SendGrid wave A"; tag prod-live-20261030-tag), resolved ONLY by its full ref refs/heads/prod-live-20261030 (a tag
#   and a branch with the same base name made the short name ambiguous before) and only while it is still the reviewed
#   commit PROD_FN_COMMIT (rel_common.sh). It is not an ancestor of HEAD and need not be. An explicit BASE_COMMIT must
#   be a commit id. REFUSED: f1af30a ("functions: port the SendGrid patch …") — NOT production: its functions/ carries
#   the unshipped Owner-MFA gate (src/ownerMfa.ts, profiles.ts, storageClaims.ts).
# RELEASE.txt holds: HEAD=<full commit id>, BASE_COMMIT=<full id>, BASE_REF=<the full ref it is, or none>, and sha256
# tree hashes (sha256 over the sorted "<sha256-of-file>  <path>" lines of every COMMITTED file; node_modules/, .next/
# and zipper-crm/out/ never count) of
#   TREE backend | functions | functions/src | zipper-crm
#   FILE firestore.rules | storage.rules | firestore.indexes.json | zipper-app/app/build.gradle.kts | firebase.json |
#        .firebaserc | deploy-crm.command
# Every production script recomputes all of them from HEAD (require_release) and refuses on any difference, a dirty
# tree, or a HEAD that is not this one. Refuses here: a dirty tree, an unknown BASE_COMMIT, HEAD itself, f1af30a, a
# production branch that moved off the reviewed commit, and a base without functions/package-lock.json or without a
# functions section in firebase.json (29 could not deploy it). An existing RELEASE.txt is moved into the evidence
# folder first (shown as a diff).
# Results: ./production/make-release-txt-<UTC>/
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
verify_scripts
new_out make-release-txt
need_tools git python3 shasum

BASE="${1:-$PROD_FN_REF}"
say "ZIPPER completion release — make RELEASE.txt   $TS"
if [ "$BASE" != "$PROD_FN_REF" ]; then
  printf '%s' "$BASE" | grep -Eq '^[0-9a-f]{7,40}$' || stop "BASE_COMMIT must be a commit id (7-40 hex characters); without an argument the base is $PROD_FN_REF"
fi
require_clean_tree
BASE_FULL="$(git -C "$REPO" rev-parse --verify --quiet "$BASE^{commit}" 2>>"$ERR")" || stop "BASE_COMMIT $BASE is not a commit in $REPO"
PROD_NOW="$(git -C "$REPO" rev-parse --verify --quiet "$PROD_FN_REF^{commit}" 2>>"$ERR")"
if [ "$BASE" = "$PROD_FN_REF" ]; then
  [ "$BASE_FULL" = "$PROD_FN_COMMIT" ] || stop "$PROD_FN_REF is $BASE_FULL, not the reviewed production tree $PROD_FN_COMMIT — the branch moved; review it before changing PROD_FN_COMMIT in rel_common.sh"
else
  case "$BASE_FULL" in "$BASE"*) ;; *) stop "BASE_COMMIT $BASE resolved to $BASE_FULL, which is not that commit id (a ref of that name?)";; esac
fi
[ "$BASE_FULL" != "$NOT_PROD_FN_COMMIT" ] || stop "BASE_COMMIT $(printf '%s' "$BASE_FULL" | cut -c1-12) (f1af30a) is NOT production: its functions/ carries the unshipped Owner-MFA gate (src/ownerMfa.ts, profiles.ts, storageClaims.ts). The production Functions tree is $PROD_FN_REF ($(printf '%s' "$PROD_FN_COMMIT" | cut -c1-12)): run ./make-release-txt.sh without an argument"
HEAD_FULL="$(git -C "$REPO" rev-parse HEAD)"
[ "$BASE_FULL" != "$HEAD_FULL" ] || stop "BASE_COMMIT is HEAD itself"
git -C "$REPO" cat-file -e "$BASE_FULL:functions/package-lock.json" 2>>"$ERR" \
  && git -C "$REPO" show "$BASE_FULL:firebase.json" 2>>"$ERR" | python3 -I -c 'import json, sys; sys.exit(0 if json.load(sys.stdin).get("functions") else 1)' 2>>"$ERR" \
  || stop "BASE_COMMIT $(printf '%s' "$BASE_FULL" | cut -c1-12) has no functions/package-lock.json or no functions section in firebase.json (29 could not deploy it)"
if [ -n "$PROD_NOW" ] && [ "$BASE_FULL" = "$PROD_NOW" ]; then BASE_REF="$PROD_FN_REF"; else BASE_REF="none"; fi
check ok "clean tree; HEAD $(printf '%s' "$HEAD_FULL" | cut -c1-12) on $(git -C "$REPO" rev-parse --abbrev-ref HEAD); BASE_COMMIT $(printf '%s' "$BASE_FULL" | cut -c1-12) = $BASE_REF"
[ "$BASE_REF" = none ] && say "   NOTE: BASE_COMMIT is not $PROD_FN_REF ($(printf '%s' "$PROD_FN_COMMIT" | cut -c1-12)) — 29 would roll back to this explicit commit, not to the production tree"
say "   functions/ files that differ between BASE_COMMIT and HEAD (what 29 would roll back):"
git -C "$REPO" diff --name-status "$BASE_FULL" "$HEAD_FULL" -- functions 2>>"$ERR" | cut -c1-110 | sed 's/^/      /' | tee -a "$OUT/SUMMARY.txt"

$H release-txt "$REPO" "$HEAD_FULL" "$BASE_FULL" "$BASE_REF" > "$OUT/RELEASE.txt" 2>>"$ERR" || stop "could not compute the release hashes (stderr.log)"
$H release-check "$OUT/RELEASE.txt" "$REPO" > "$OUT/release-check.txt" 2>>"$ERR"
grep -q '^RELEASE ok$' "$OUT/release-check.txt" || stop "the new RELEASE.txt does not verify (release-check.txt)"
sed 's/^/   /' "$OUT/RELEASE.txt" | tee -a "$OUT/SUMMARY.txt"
if [ -f "$RELEASE_TXT" ]; then
  cp "$RELEASE_TXT" "$OUT/RELEASE.txt.previous"
  diff "$OUT/RELEASE.txt.previous" "$OUT/RELEASE.txt" > "$OUT/RELEASE.diff" && say "   (identical to the previous RELEASE.txt)" || sed 's/^/   diff: /' "$OUT/RELEASE.diff" | tee -a "$OUT/SUMMARY.txt"
fi
cp "$OUT/RELEASE.txt" "$RELEASE_TXT" && chmod 600 "$RELEASE_TXT" || stop "could not write $RELEASE_TXT"
check ok "RELEASE.txt written for HEAD $(printf '%s' "$HEAD_FULL" | cut -c1-12) (sha256 $(shasum -a 256 "$RELEASE_TXT" | cut -c1-16)…)"
finish
