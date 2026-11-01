# ZIPPER completion release 20261101 — shared Functions deploy preparation and verification (sourced by 20/21/29).
# bash 3.2 compatible. Holds NO deploy command: each script runs its own, exactly as written in it.

# fn_only <names...>: the --only argument for firebase deploy, from a space-separated list of function names.
fn_only() {
  local out="" f
  for f in "$@"; do out="$out${out:+,}functions:$f"; done
  printf '%s' "$out"
}

# build_fn_tree <commit>: a fresh deploy folder = the repository exactly as committed at <commit> (git archive: the
# working tree is never deployed), plus a firebase.json holding only the functions section of the repository's
# firebase.json at that commit (its predeploy build and ignore list, verbatim). The whole commit is unpacked because the
# functions tests read files outside functions/ (firestore.rules, setup-email-and-deploy.command, an Android source) —
# the 1 Nov run with functions/ alone failed 4 of them. Only functions/ is deployed (firebase.json names it; the CLI
# packages that folder alone). Sets DEPLOY. Records the tree hash of functions/.
build_fn_tree() {
  local commit="$1"
  DEPLOY="$OUT/deploy"; mkdir -p "$DEPLOY" || stop "cannot create $DEPLOY"
  ( git -C "$REPO" archive --format=tar "$commit" | tar -x -C "$DEPLOY" ) 2>>"$ERR" || stop "git archive of $commit failed"
  [ -f "$DEPLOY/firestore.rules" ] || stop "the unpacked commit has no firestore.rules (the functions tests read it)"
  [ -f "$DEPLOY/functions/package.json" ] && [ -f "$DEPLOY/functions/package-lock.json" ] || stop "the unpacked functions/ tree has no package.json / package-lock.json"
  git -C "$REPO" show "$commit:firebase.json" 2>>"$ERR" | python3 -I -c '
import json, sys
j = json.load(sys.stdin)
fn = j.get("functions")
if not fn:
    sys.exit("firebase.json has no functions section")
json.dump({"functions": fn}, sys.stdout, indent=2)
print()
' > "$DEPLOY/firebase.json" || stop "could not derive the functions section of firebase.json at $commit"
  $H tree-sha "$REPO" "$commit" functions > "$OUT/deploy-tree.txt"
  sed 's/^/   /' "$OUT/deploy-tree.txt" | tee -a "$OUT/SUMMARY.txt"
  check ok "deploy folder unpacked from commit $(printf '%s' "$commit" | cut -c1-12): $DEPLOY"
}

# install_build_test: npm ci (exact lockfile), tsc, then EVERY test file on the exact deploy tree. Refuses on any failure.
install_build_test() {
  ( cd "$DEPLOY/functions" && npm ci --no-audit --no-fund > "$OUT/npm-ci.log" 2>&1 ) || stop "npm ci failed (npm-ci.log)"
  check ok "npm ci (package-lock.json)"
  ( cd "$DEPLOY/functions" && npm run build > "$OUT/build.log" 2>&1 ) || stop "npm run build failed (build.log)"
  check ok "npm run build (tsc)"
  local rc tests pass fail
  ( cd "$DEPLOY/functions" && env -i PATH="$PATH" HOME="$OUT/home" TZ=UTC node --test --test-reporter=tap "test/**/*.test.js" > "$OUT/tests.log" 2>&1 ); rc=$?
  tests="$(grep -E '^# tests ' "$OUT/tests.log" | tail -1 | awk '{print $3}')"
  pass="$(grep -E '^# pass ' "$OUT/tests.log" | tail -1 | awk '{print $3}')"
  fail="$(grep -E '^# fail ' "$OUT/tests.log" | tail -1 | awk '{print $3}')"
  [ "$rc" = 0 ] && [ "$fail" = 0 ] && [ -n "$pass" ] && check ok "node --test on the exact tree: $pass/$tests" || check "exit $rc, fail ${fail:-?}" "node --test on the exact tree"
  [ "$FAILS" = 0 ] || stop "a test failed on the exact deploy tree — not deploying (tests.log)"
}

# check_exports: the names the COMPILED entry point of the deploy tree exports (lib/index.js, after npm ci + tsc) and the
# region each one declares — node loads the module in an empty environment (no credential; HOME = the evidence folder;
# a demo project id only so the definitions can describe themselves; nothing is called). Refuses unless every exported
# name is in exactly one of WAVE_2A, WAVE_2B, NOT_REDEPLOYED (no duplicate, no unclassified export, no listed name
# missing from the exports) and runs in the region fn_region describes it in. Names and regions only (exports.txt).
check_exports() {
  ( cd "$DEPLOY/functions" && env -i PATH="$PATH" HOME="$OUT/home" TZ=UTC GCLOUD_PROJECT=demo-zipper-exports node -e '
const m = require("./lib/index.js");
for (const k of Object.keys(m)) {
  let r = "?";
  try { const e = m[k] && m[k].__endpoint; if (e) r = (e.region && e.region.length) ? e.region.join(",") : "us-central1"; } catch (x) { r = "?"; }
  console.log("EXPORT " + k + " " + r);
}' ) > "$OUT/exports.txt" 2>"$OUT/exports-stderr.log" || stop "could not list the exports of lib/index.js in the deploy tree (exports-stderr.log)"
  $H fn-classify "$OUT/exports.txt" "$WAVE_2A" "$WAVE_2B" "$NOT_REDEPLOYED" "$REGION" "$WEEKLY_REGION" "$FN_US_CENTRAL1" > "$OUT/exports-check.txt"
  sed 's/^/   /' "$OUT/exports-check.txt" | tee -a "$OUT/SUMMARY.txt"
  grep -q '^CLASSIFY ok$' "$OUT/exports-check.txt" || stop "the functions lib/index.js exports are not exactly WAVE_2A + WAVE_2B + NOT_REDEPLOYED in their regions (above) — review rel_common.sh; nothing was deployed"
  check ok "each of the $(grep -c '^EXPORT ' "$OUT/exports.txt") exported functions is in exactly one of WAVE_2A, WAVE_2B, NOT_REDEPLOYED, in its region"
}

# add_env: copy functions/.env from the repository into the deploy folder — copied, never displayed — and check that
# it defines none of the names the SendGrid change reserves. Prints names only.
add_env() {
  [ -f "$FN_ENV" ] || stop "$FN_ENV not found (the deploy needs the same functions/.env as every deploy)"
  cp "$FN_ENV" "$DEPLOY/functions/.env" && chmod 600 "$DEPLOY/functions/.env" || stop "could not copy functions/.env"
  $H env-names "$DEPLOY/functions/.env" > "$OUT/env-names.txt"
  sed 's/^/   /' "$OUT/env-names.txt" | tee -a "$OUT/SUMMARY.txt"
  grep -q '^RESERVED .* PRESENT' "$OUT/env-names.txt" \
    && stop "functions/.env defines a name this release reserves (listed above) — remove it or decide first" \
    || check ok "functions/.env defines none of the reserved SendGrid names"
}

# env_drift <fn...>: the deployed environment of each EXISTING function against the .env about to be deployed.
# Same names and same values (compared as SHA-256 inside the helper; nothing printed but the verdict).
env_drift() {
  fn_env_drift "$OUT/env-drift.txt" "$DEPLOY/functions/.env" "$@"
  awk '{print $4}' "$OUT/env-drift.txt" | sort | uniq -c | sed 's/^/   verdicts: /' | tee -a "$OUT/SUMMARY.txt"
  grep -E ' (DIFFERENT|only-deployed)$' "$OUT/env-drift.txt" | sed 's/^/   /' | tee -a "$OUT/SUMMARY.txt"
  grep -qE ' (DIFFERENT|only-deployed)$' "$OUT/env-drift.txt" \
    && stop "functions/.env differs from what these functions run with today (names above; values not shown)"
  grep -q ' only-in-.env$' "$OUT/env-drift.txt" && say "   note: names only in .env would be added (listed in env-drift.txt)"
  check ok "environment of the functions unchanged by this deploy (same names, same values)"
}

# existing_of <fn...>: prints the names that exist in production today (a NOT_FOUND function is new in this release).
existing_of() {
  local f
  for f in "$@"; do grep -q "^FN $f status=" "$OUT/functions-before.txt" && printf '%s ' "$f"; done
}

# settle_functions: the after-list (all-after.tsv), taken once no function is still being deployed — read-only, every
# 30 s, up to 10 min. The CLI deploys a long --only list in throttled batches and retries quota errors itself; an update
# still running when it exits must not be judged "not updated".
settle_functions() {
  local i=0 busy
  while :; do
    all_functions "$OUT/all-after.tsv"
    busy="$(awk -F'\t' '$3 == "DEPLOY_IN_PROGRESS" || $3 == "DEPLOYING" {printf "%s ", $1}' "$OUT/all-after.tsv")"
    [ -z "$busy" ] && return 0
    i=$((i + 1))
    if [ "$i" -gt 20 ]; then say "   NOTE: still deploying after 10 min: $busy- judged on the state now"; return 0; fi
    say "   still deploying ($i/20, next look in 30 s): $busy"
    sleep 30
  done
}

# verify_after <changed-csv> <fn...>: scope (only the named functions changed; new names allowed), each ACTIVE, the
# runtime identity it had before, environment equal to functions/.env, and the SendGrid secret where it is expected.
# Writes updated.txt / not-updated.txt: the named functions whose updateTime did / did not change. After a deploy that
# exits non-zero (e.g. the Cloud Functions write quota outlasted the CLI's own retries) the result is SCOPE PARTIAL and
# these two files say which functions run the new code: 29-rollback-functions.command <2a|2b> <this evidence folder>
# rolls back exactly updated.txt.
verify_after() {
  local changed="$1"; shift
  settle_functions
  $H compare-lists "$OUT/all-before.tsv" "$OUT/all-after.tsv" "$changed" > "$OUT/scope.txt"
  grep -vE '^(CHANGED|UPDATED) ' "$OUT/scope.txt" | sed 's/^/   /' | tee -a "$OUT/SUMMARY.txt"
  sed -n 's/^UPDATED //p' "$OUT/scope.txt" > "$OUT/updated.txt"
  sed -n 's/^NOT-UPDATED //p' "$OUT/scope.txt" > "$OUT/not-updated.txt"
  say "   updated (updateTime changed): $(grep -c . "$OUT/updated.txt") -> updated.txt   not updated: $(grep -c . "$OUT/not-updated.txt") -> not-updated.txt"
  if grep -q '^SCOPE PASS' "$OUT/scope.txt"; then check ok "only the intended functions changed, every one of them"
  elif grep -q '^SCOPE PARTIAL' "$OUT/scope.txt"; then check "partial: the NOT-UPDATED functions still run their previous code" "every intended function changed"
  else check "see scope.txt" "only the intended functions changed"; fi
  fn_state "$OUT/functions-after.txt" "$@"
  sed 's/^/   /' "$OUT/functions-after.txt" | tee -a "$OUT/SUMMARY.txt"
  local f line want bad_active="" bad_sa=""
  for f in "$@"; do
    line="$(grep "^FN $f " "$OUT/functions-after.txt")"
    case "$line" in *" status=ACTIVE "*) ;; *) bad_active="$bad_active $f";; esac
    # the identity it ran as before (1st gen: the App Engine identity; 2nd gen: the compute identity); new: by generation
    want="$(sed -n "s/^FN $f .* sa=\([^ ]*\) .*/\1/p" "$OUT/functions-before.txt" 2>/dev/null | head -1)"
    if [ -z "$want" ] || [ "$want" = "?" ]; then case "$line" in *" gen=GEN_2 "*) want="$BACKEND_SA";; *) want="$FN_SA";; esac; fi
    case "$line" in *" sa=$want "*) ;; *) bad_sa="$bad_sa $f";; esac
    case " $WEEKLY $EMAIL_FNS " in
      *" $f "*) case "$line" in *"$SG_SECRET:"*) check ok "$f has $SG_SECRET";; *) check "secret missing" "$f has $SG_SECRET";; esac;;
    esac
    [ "$f" = "$WEEKLY" ] && { case "$line" in *"ZIPPER_ACCRUAL_KEY:"*) check ok "$WEEKLY keeps ZIPPER_ACCRUAL_KEY";; *) check "missing" "$WEEKLY keeps ZIPPER_ACCRUAL_KEY";; esac; }
  done
  [ -z "$bad_active" ] && check ok "all $# functions ACTIVE" || check "not ACTIVE:$bad_active" "every function ACTIVE"
  [ -z "$bad_sa" ] && check ok "all $# functions keep their runtime identity (1st gen $FN_SA, 2nd gen $BACKEND_SA)" || check "differs:$bad_sa" "every function keeps its runtime identity"
  fn_env_drift "$OUT/env-drift-after.txt" "$DEPLOY/functions/.env" "$@"
  grep -qE ' (DIFFERENT|only-deployed|only-in-.env)$' "$OUT/env-drift-after.txt" \
    && check "see env-drift-after.txt" "deployed environment equals functions/.env" || check ok "deployed environment equals functions/.env"
}
