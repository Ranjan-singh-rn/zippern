#!/bin/bash
# TRACK B RULES RUN (release/trackb-20261104, 2026-11-04) — every Firestore / Storage rules suite of the RC2 run
# (tests/run-rc2-rules-tests.command, unchanged here) PLUS the Track B live suite tests/firestore.b12live.rules.test.mjs,
# against the repository's rules on the LOCAL emulators. bash 3.2 (macOS) safe.
#
# Why a second runner: tests/run-rc2-rules-tests.command refuses every run once firestore.b12live.rules.test.mjs is in
# tests/ (its preflight allows no projectId but 'demo-zipper', and b12live pins 'demo-zipper-b12'), and it does not run
# b12live. This runner is that runner with b12live added (run as local-stack.command's `rules b12` job runs it: its own
# Firestore emulator on 8085, project demo-zipper-b12) and 'demo-zipper-b12' allowed for that one suite. Ports 8080,
# 9199 and 8085 must be free: stop the local test copy (Ctrl-C in its window) before running this. Its results are what 31-deploy-rules-rc2.command and
# 41-deploy-storage-rules.command of release/trackb-20261104 read.
#
# NOT COVERED by any emulator suite (static review only): the Track B blocks for gameHistory, gameMatches, gameLedger,
# gameIdempotency, promoCredits, leaderboards, leaderboardSettlements, musicTracks, partySubscriptions,
# subscriptionPayments, subscriptionIdempotency, sellerTrades, party accessLog/pinMisses and the Owner-only appConfig
# documents (games, leaderboards, partySubscription).
#
# Files under test (no override — these are the files 31-deploy-rules-rc2 and 41 release): <repo>/firestore.rules,
# <repo>/storage.rules, and (static checks)
# <repo>/firestore.indexes.json. Every suite runs in its own
#     firebase emulators:exec --only firestore,storage --project demo-zipper "node tests/<suite>"
# with ZIPPER_RULES_FILE / ZIPPER_STORAGE_RULES_FILE / ZIPPER_INDEXES_FILE
# pointing at those files and ZIPPER_RULES_LINEAGE=rc2.
#
#   MUST PASS   rc2              tests/firestore.rc2.rules.test.mjs   (new: A–E, D1–D13, S static)
#               rc2:storage      tests/storage.rc2.rules.test.mjs     (new: S1, S2, R-7)
#               hotfix1          tests/firestore.hotfix1.rules.test.mjs (rc2 lineage, see below)
#               hotfix1:storage  tests/storage.hotfix1.rules.test.mjs
#               storage          tests/storage.rules.test.mjs
#               p1mfa:storage    tests/storage.p1mfa.rules.test.mjs   (reads ../storage.rules + ../firestore.rules = the RC2 files)
#               firestore        tests/firestore.rules.test.mjs
#               phase1a          tests/firestore.phase1a.rules.test.mjs (NO known-failure allowlist on RC2)
#               ugp, fx, gov, rc tests/firestore.{ugp,fx,gov,rc}.rules.test.mjs
#               p1gov            tests/firestore.p1gov.rules.test.mjs
#               p1mfa            tests/firestore.p1mfa.rules.test.mjs
#               overlap, claims  tests/storage-rule-overlap.mjs, tests/verify-production-claims.mjs
#                                (static, node only, read ../storage.rules)
#   NOT RUN     auth.p1mfa.emulator.test.mjs — needs the Auth emulator (not part of
#               --only firestore,storage) and tests the backend's custom-token flow,
#               which RC2 does not change; tests/run-p1mfa-verify.command runs it.
#               appeal-wiring.test.mjs and tests/crosssys/* are not rules suites.
#
# EXPECTED TO FAIL AGAINST RC2 BY DESIGN: NONE. Every existing suite is MUST PASS.
#   * Evidence: the rc2 Mac validation of 2026-10-28 (zipper-release/mfa-release-
#     rc2-20261027T230620Z/tools/mac-validation-20261028T064807Z/SUMMARY.txt) passed
#     firestore 114, phase1a 255, ugp 22, fx 60, gov 74, rc 58, p1mfa 175 and
#     storage.p1mfa 60 against the MFA candidate 93453763 — the same test bytes as
#     today except firestore.rules.test.mjs (crmUid back-link; RC2 does not touch
#     agencies/rechargeRequests/hostApplications/sellers). RC2's further hunks
#     (techTickets / feedbackTickets / supportTickets / crmUsers reads / staffRoster /
#     hostPayouts / salaryRequests actor / users ban+hold fields / gender / notifications /
#     paymentCredentials reads / hostKyc reads / followers / giftsReceived / rateLimits /
#     party PIN secret) were checked against every check of every suite (2026-11-01):
#     only p1gov, p1mfa and hotfix1 touch them, and they agree with RC2.
#   * The suites that DO fail by design are failing on the OTHER lineages and pass here:
#     phase1a fails 3 gateAnswers checks on DEPLOYED / hotfix-1 (hotfix/rules-20261101/
#     phase1a-known-failures.txt) — RC2 removes the first-login gate, so they pass;
#     p1mfa, p1mfa:storage (and auth.p1mfa) fail on DEPLOYED / hotfix-1 (no Owner MFA)
#     — RC2 carries it; p1gov fails on DEPLOYED / hotfix-1 (no P1-D/E hunks) — RC2
#     carries them; rc2 and rc2:storage fail on DEPLOYED / hotfix-1 (their subject).
#   * hotfix1 pins hotfix-1's interim techTickets form (staff may still file and move
#     tickets from the browser, because the tickets API is not deployed). Against RC2
#     (P1-D form, `create, update: if false`) those three checks would fail by design;
#     the suite therefore switches lineage on the RC2 header (forced here with
#     ZIPPER_RULES_LINEAGE=rc2) and expects them REFUSED. Every other hotfix1 check is
#     the same on both lineages.
#
# Safety:
#   * refuses unless both rules files carry the RC2 header, and if any rules suite
#     pins a projectId other than demo-zipper;
#   * demo- project: emulator only, no login, no real project; GOOGLE_APPLICATION_
#     CREDENTIALS, FIREBASE_TOKEN and the gcloud/GCP project variables are unset;
#   * refuses if something already listens on 8080 (Firestore) or 9199 (Storage);
#   * no deploy, no git writes (only `git rev-parse` / `git status` for provenance),
#     no network beyond 127.0.0.1 — except that firebase-tools may download the
#     emulator JARs on its very first use on this Mac.
#
# Output: release/trackb-20261104/rules-results/results-<UTC>/ (git-ignored by that folder's .gitignore)
#   SUMMARY.txt   what ran, the sha256 of every file under test, one line per suite
#   suites.tsv    suite, mode, exit code, verdict, firestore/storage rules sha256 used, log
#   RESULT.txt    PASS | FAIL | REFUSED   (read by release/trackb-20261104/31-… and 41-…)
#   <suite>.log   the full output of each suite
# Exit: 0 = every MUST suite passed, hashes unchanged · 1 = a failure · 2 = refused

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"            # …/release/trackb-20261104/tools
REL="$(cd "$HERE/.." && pwd)"                      # …/release/trackb-20261104
ROOT="$(cd "$REL/../.." && pwd)"                   # the repository
cd "$ROOT" || exit 2
unset GOOGLE_APPLICATION_CREDENTIALS FIREBASE_TOKEN GOOGLE_CLOUD_PROJECT GCLOUD_PROJECT CLOUDSDK_CORE_PROJECT

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$REL/rules-results/results-$STAMP"
while [ -e "$OUT" ]; do sleep 1; STAMP="$(date -u +%Y%m%dT%H%M%SZ)"; OUT="$REL/rules-results/results-$STAMP"; done
mkdir -p "$OUT" && chmod 700 "$REL/rules-results" 2>/dev/null; [ -d "$OUT" ] || exit 2
SUMMARY="$OUT/SUMMARY.txt"
RESULT="$OUT/RESULT.txt"
TSV="$OUT/suites.tsv"

FS_RULES="$ROOT/firestore.rules"
ST_RULES="$ROOT/storage.rules"
INDEXES="$ROOT/firestore.indexes.json"
export ZIPPER_RULES_FILE="$FS_RULES"
export ZIPPER_STORAGE_RULES_FILE="$ST_RULES"
export ZIPPER_INDEXES_FILE="$INDEXES"
export ZIPPER_RULES_LINEAGE=rc2

sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }
say() { echo "$*" | tee -a "$SUMMARY"; }
refuse() { say "REFUSING: $*"; echo "REFUSED" > "$RESULT"; exit 2; }

# ── Preflight: refuse, never guess ──────────────────────────────────────────
for f in "$FS_RULES" "$ST_RULES" "$INDEXES"; do [ -f "$f" ] || refuse "$f is missing"; done
grep -q "ZIPPER FIRESTORE RULES — RELEASE CANDIDATE 2" "$FS_RULES" || refuse "firestore.rules is not the RC2 text (header missing)"
grep -q "ZIPPER STORAGE RULES — RELEASE CANDIDATE 2" "$ST_RULES" || refuse "storage.rules is not the RC2 text (header missing)"
SUITES_ALL="firestore.rc2.rules.test.mjs storage.rc2.rules.test.mjs firestore.hotfix1.rules.test.mjs storage.hotfix1.rules.test.mjs
storage.rules.test.mjs storage.p1mfa.rules.test.mjs firestore.rules.test.mjs firestore.phase1a.rules.test.mjs
firestore.ugp.rules.test.mjs firestore.fx.rules.test.mjs firestore.gov.rules.test.mjs firestore.rc.rules.test.mjs
firestore.p1gov.rules.test.mjs firestore.p1mfa.rules.test.mjs storage-rule-overlap.mjs verify-production-claims.mjs
firestore.b12live.rules.test.mjs"
for f in $SUITES_ALL; do [ -f "tests/$f" ] || refuse "tests/$f is missing"; done
# Every rules suite pins a demo- project: demo-zipper, except b12live, which pins demo-zipper-b12 (no other).
if grep -n "projectId: '" tests/*.rules.test.mjs | grep -v "projectId: 'demo-zipper'" \
   | grep -v "^tests/firestore\.b12live\.rules\.test\.mjs:[0-9]*:  projectId: 'demo-zipper-b12',\$"; then
  refuse "a rules test does not pin projectId demo-zipper (or demo-zipper-b12 for b12live)"
fi
command -v firebase >/dev/null || refuse "firebase CLI not found on PATH (npm i -g firebase-tools)"
command -v java >/dev/null || refuse "java not found (the emulators need a JDK; 21 recommended)"
command -v node >/dev/null || refuse "node not found"
command -v shasum >/dev/null || refuse "shasum not found"
for pkg in "@firebase/rules-unit-testing" "firebase"; do
  [ -f "tests/node_modules/$pkg/package.json" ] || refuse "tests/node_modules/$pkg is not installed (cd tests && npm ci)"
done
if command -v lsof >/dev/null; then
  for port in 8080 9199 8085; do
    lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1 && refuse "port $port is in use (stop the running emulators first — e.g. the local test copy: Ctrl-C in its window)"
  done
fi
JAVA_VER="$(java -version 2>&1 | head -1)"
JAVA_MAJOR="$(echo "$JAVA_VER" | sed -E 's/^[^"]*"([0-9]+).*/\1/')"

FS_SHA="$(sha256_of "$FS_RULES")"
ST_SHA="$(sha256_of "$ST_RULES")"
IX_SHA="$(sha256_of "$INDEXES")"
{
  echo "TRACK B RULES tests (RC2 suites + b12live)  $STAMP"
  echo "repo:            $ROOT"
  echo "git HEAD:        $(git rev-parse --short HEAD 2>/dev/null || echo '?')  (working-tree state of the files: $(git status --porcelain -- firestore.rules storage.rules firestore.indexes.json 2>/dev/null | tr '\n' ' '))"
  echo "firestore rules: $FS_RULES"
  echo "  sha256:        $FS_SHA"
  echo "storage rules:   $ST_RULES"
  echo "  sha256:        $ST_SHA"
  echo "indexes:         $INDEXES"
  echo "  sha256:        $IX_SHA"
  echo "firebase:        $(firebase --version 2>/dev/null | head -1)"
  echo "node:            $(node --version 2>/dev/null)"
  echo "java:            $JAVA_VER"
  echo "project:         demo-zipper (emulator only)"
  echo ""
} | tee "$SUMMARY"
case "$JAVA_MAJOR" in
  ''|*[!0-9]*) say "note: could not read the Java major version" ;;
  *) [ "$JAVA_MAJOR" -lt 21 ] && say "WARNING: Java $JAVA_MAJOR — current firebase-tools emulators want JDK 21; a start-up failure below is likely this" ;;
esac
printf 'suite\tmode\texit\tverdict\tfirestore_rules_sha256\tstorage_rules_sha256\tlog\n' > "$TSV"

# ── Helpers ─────────────────────────────────────────────────────────────────
first_after() {   # log, line-prefix → the rest of the first line that starts with it
  grep -E "^$2" "$1" | head -1 | sed -E "s/^$2//" | tr -d '\r'
}

FAILED=0
run() {   # name, kind (emu|static), test file, mode (must|info)
  local name="$1" kind="$2" file="$3" mode="$4"
  local log="$OUT/$(echo "$name" | tr ':' '-').log" rc verdict fs_used st_used p s
  say "=== $name ($kind) [$mode] ==="
  if [ "$kind" = emu ] && [ "$name" = b12live ]; then
    # b12live connects to 127.0.0.1:$B12_FIRESTORE_PORT itself with project demo-zipper-b12 — run it exactly as
    # local-stack.command's `rules b12` job does (40/40 on the Mac, 4 Nov): its own Firestore emulator on 8085 from a
    # generated config (singleProjectMode false, no UI), project demo-zipper-b12.
    local W
    W="$(mktemp -d "${TMPDIR:-/tmp}/zqa-trackb-b12.XXXXXX")" || { echo "mktemp failed" > "$log"; return 1; }
    printf '%s\n' '{ "emulators": { "singleProjectMode": false, "firestore": { "host": "127.0.0.1", "port": 8085 }, "ui": { "enabled": false } } }' > "$W/firebase.json"
    ( cd "$W" && firebase emulators:exec --project demo-zipper-b12 --only firestore --config "$W/firebase.json" \
        "cd '$ROOT' && B12_FIRESTORE_PORT=8085 node tests/$file" ) > "$log" 2>&1
    rm -rf "$W"
  elif [ "$kind" = emu ]; then
    firebase emulators:exec --only firestore,storage --project demo-zipper "node tests/$file" > "$log" 2>&1
  else
    node "tests/$file" > "$log" 2>&1
  fi
  rc=$?
  verdict="exit=$rc"

  # Which Firestore rules did the suite load? Its own sha line, else its path line,
  # else (suites that read ../firestore.rules directly) the RC2 file by construction.
  fs_used="$FS_SHA"; st_used="$ST_SHA"
  s="$(first_after "$log" 'rules sha256: ' | tr -d '[:space:]')"
  if [ -n "$s" ]; then
    fs_used="$s"
    [ "$s" = "$FS_SHA" ] || { verdict="$verdict SHA-MISMATCH(firestore)"; rc=99; }
  fi
  p="$(first_after "$log" 'rules under test: ')"
  if [ -n "$p" ] && [ "$p" != "$FS_RULES" ]; then verdict="$verdict WRONG-FILE(firestore:$p)"; rc=99; fi
  p="$(first_after "$log" 'firestore rules loaded: ')"
  if [ -n "$p" ] && [ "$p" != "$FS_RULES" ]; then verdict="$verdict WRONG-FILE(firestore:$p)"; rc=99; fi
  p="$(first_after "$log" 'indexes under test: ')"
  if [ -n "$p" ] && [ "$p" != "$INDEXES" ]; then verdict="$verdict WRONG-FILE(indexes:$p)"; rc=99; fi
  s="$(first_after "$log" 'storage rules sha256: ' | tr -d '[:space:]')"
  if [ -n "$s" ]; then
    st_used="$s"
    [ "$s" = "$ST_SHA" ] || { verdict="$verdict SHA-MISMATCH(storage)"; rc=99; }
  fi
  p="$(first_after "$log" 'storage rules under test: ')"
  if [ -n "$p" ] && [ "$p" != "$ST_RULES" ]; then verdict="$verdict WRONG-FILE(storage:$p)"; rc=99; fi
  case "$name" in hotfix1)
    grep -q '^rules lineage: rc2' "$log" || { verdict="$verdict LINEAGE-NOT-RC2"; rc=99; } ;;
  esac
  # A Storage-only suite still records the Firestore text the emulator was given.
  case "$kind:$file" in static:*) fs_used="-" ;; esac

  if [ $rc -eq 0 ]; then
    verdict="$verdict → PASS"
  elif [ "$mode" = must ]; then
    verdict="$verdict → FAIL"; FAILED=1
  else
    verdict="$verdict → FAIL (info only)"
  fi
  grep -E "RESULT|checks passed|checks FAILED|assertions hold|recognise all|^ABORTED" "$log" | sed 's/^/    /' | tee -a "$SUMMARY"
  # b12live prints its rules hash on its result line (rules_sha256=…): it must be the file under test.
  case "$name" in b12live)
    s="$(grep -E '^B12-RESULT ' "$log" | head -1 | sed -n 's/.*rules_sha256=\([0-9a-f]*\).*/\1/p')"
    if [ -z "$s" ]; then verdict="$verdict NO-B12-RESULT"; [ "$mode" = must ] && FAILED=1
    elif [ "$s" != "$FS_SHA" ]; then verdict="$verdict SHA-MISMATCH(b12live)"; FAILED=1; fi ;;
  esac
  say "$name $verdict   firestore=$fs_used storage=$st_used"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$mode" "$(echo "$verdict" | sed -E 's/^exit=([0-9]+).*/\1/')" \
    "$(echo "$verdict" | sed -E 's/^exit=[0-9]+ ?//')" "$fs_used" "$st_used" "$(basename "$log")" >> "$TSV"
}

# ── The suites ──────────────────────────────────────────────────────────────
run rc2              emu    firestore.rc2.rules.test.mjs        must
run rc2:storage      emu    storage.rc2.rules.test.mjs          must
run hotfix1          emu    firestore.hotfix1.rules.test.mjs    must
run hotfix1:storage  emu    storage.hotfix1.rules.test.mjs      must
run storage          emu    storage.rules.test.mjs              must
run p1mfa:storage    emu    storage.p1mfa.rules.test.mjs        must
run firestore        emu    firestore.rules.test.mjs            must
run phase1a          emu    firestore.phase1a.rules.test.mjs    must
run ugp              emu    firestore.ugp.rules.test.mjs        must
run fx               emu    firestore.fx.rules.test.mjs         must
run gov              emu    firestore.gov.rules.test.mjs        must
run rc               emu    firestore.rc.rules.test.mjs         must
run p1gov            emu    firestore.p1gov.rules.test.mjs      must
run p1mfa            emu    firestore.p1mfa.rules.test.mjs      must
run overlap          static storage-rule-overlap.mjs            must
run claims           static verify-production-claims.mjs        must
run b12live          emu    firestore.b12live.rules.test.mjs    must
say "auth.p1mfa not run (needs the Auth emulator; see the header)"

# ── The files must not have moved while the suites ran ──────────────────────
for pair in "firestore.rules:$FS_SHA" "storage.rules:$ST_SHA" "firestore.indexes.json:$IX_SHA"; do
  f="${pair%%:*}"; want="${pair#*:}"
  got="$(sha256_of "$ROOT/$f")"
  if [ "$got" != "$want" ]; then say "CHANGED DURING THE RUN: $f ($want → $got)"; FAILED=1; fi
done

say ""
say "--- FAIL lines across all logs ---"
grep -H -E "^  FAIL " "$OUT"/*.log 2>/dev/null | sed "s#$OUT/##" | tee -a "$SUMMARY"
say ""
if [ $FAILED -eq 0 ]; then
  say "TRACKB-RULES-RUN: PASS (every suite passed against firestore.rules $FS_SHA / storage.rules $ST_SHA)"
  echo "PASS" > "$RESULT"
else
  say "TRACKB-RULES-RUN: FAIL (see the suite lines above and the logs in $OUT)"
  echo "FAIL" > "$RESULT"
fi
say "Results: $OUT"
exit $FAILED
