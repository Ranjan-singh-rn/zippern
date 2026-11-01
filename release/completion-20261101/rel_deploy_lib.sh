# ZIPPER completion release 20261101 — shared Functions deploy preparation and verification (sourced by 20/21/29).
# bash 3.2 compatible. Holds NO deploy command: each script runs its own, exactly as written in it.

# fn_only <names...>: the --only argument for firebase deploy, from a space-separated list of function names.
fn_only() {
  local out="" f
  for f in "$@"; do out="$out${out:+,}functions:$f"; done
  printf '%s' "$out"
}

# build_fn_tree <commit>: a fresh deploy folder = functions/ exactly as committed at <commit> (git archive: the working
# tree is never deployed), plus a firebase.json holding only the functions section of the repository's firebase.json at
# that commit (its predeploy build and ignore list, verbatim). Sets DEPLOY. Records the tree hash of what was unpacked.
build_fn_tree() {
  local commit="$1"
  DEPLOY="$OUT/deploy"; mkdir -p "$DEPLOY" || stop "cannot create $DEPLOY"
  ( git -C "$REPO" archive --format=tar "$commit" functions | tar -x -C "$DEPLOY" ) 2>>"$ERR" || stop "git archive of functions/ at $commit failed"
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

# verify_after <changed-csv> <fn...>: scope (only the named functions changed; new names allowed), each ACTIVE, same
# runtime identity, environment equal to functions/.env, and the SendGrid secret where it is expected.
verify_after() {
  local changed="$1"; shift
  all_functions "$OUT/all-after.tsv"
  $H compare-lists "$OUT/all-before.tsv" "$OUT/all-after.tsv" "$changed" > "$OUT/scope.txt"
  sed 's/^/   /' "$OUT/scope.txt" | tee -a "$OUT/SUMMARY.txt"
  grep -q '^SCOPE PASS' "$OUT/scope.txt" && check ok "only the intended functions changed" || check "see scope.txt" "only the intended functions changed"
  fn_state "$OUT/functions-after.txt" "$@"
  sed 's/^/   /' "$OUT/functions-after.txt" | tee -a "$OUT/SUMMARY.txt"
  local f line
  for f in "$@"; do
    line="$(grep "^FN $f " "$OUT/functions-after.txt")"
    case "$line" in *" status=ACTIVE "*) check ok "$f ACTIVE";; *) check "not ACTIVE" "$f ACTIVE";; esac
    case "$line" in *" sa=$FN_SA "*) check ok "$f runs as the Functions identity";; *) check "identity differs" "$f runs as the Functions identity";; esac
    case " $WEEKLY $EMAIL_FNS " in
      *" $f "*) case "$line" in *"$SG_SECRET:"*) check ok "$f has $SG_SECRET";; *) check "secret missing" "$f has $SG_SECRET";; esac;;
    esac
    [ "$f" = "$WEEKLY" ] && { case "$line" in *"ZIPPER_ACCRUAL_KEY:"*) check ok "$WEEKLY keeps ZIPPER_ACCRUAL_KEY";; *) check "missing" "$WEEKLY keeps ZIPPER_ACCRUAL_KEY";; esac; }
  done
  fn_env_drift "$OUT/env-drift-after.txt" "$DEPLOY/functions/.env" "$@"
  grep -qE ' (DIFFERENT|only-deployed|only-in-.env)$' "$OUT/env-drift-after.txt" \
    && check "see env-drift-after.txt" "deployed environment equals functions/.env" || check ok "deployed environment equals functions/.env"
}
