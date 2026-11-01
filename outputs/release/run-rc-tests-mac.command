#!/bin/bash
# ZIPPER — local tests for the Owner-MFA backend release candidate. Nothing touches a real project.
#
# Part A  Firestore rules, on the emulator (project demo-zipper), each suite run TWICE:
#         against the DEPLOYED rules (baseline/firestore.rules.DEPLOYED) and against the
#         CANDIDATE rules (candidate/firestore.rules). The comparison shows exactly what the
#         MFA rules change. Suites: firestore, phase1a, ugp, fx, gov, rc, p1mfa, p1mfa-auth.
#         (p1gov tests P1-A1/D/E rules that are NOT in this release; storage suites: Storage deferred.)
# Part B  Backend test modules under Python 3.12 (the production runtime), baseline and candidate,
#         with the backend's requirements installed (the project venv, backend/.venv).
#
# Everything runs in a throwaway folder outside the repository (deleted at the end):
#   * copies of the test files and rules; the repo's tests/node_modules and functions/node_modules
#     are linked read-only (functions/.env is never linked or copied);
#   * no .firebaserc, project id demo-zipper only; the suites refuse non-local emulator hosts.
# Needs: Java 11+, the Firebase CLI (`firebase`), Node; for part B a Python 3.12 with requirements.txt
# installed (backend/.venv). Ports 8080, 9099 free.
# Results: <release>/verification/tests-<UTC>/SUMMARY.txt plus one log per run.
set -u
cd "$(dirname "$0")/../.." || { echo "Cannot reach the repository root."; exit 1; }
REPO="$(pwd -P)"
for d in /opt/homebrew/bin /usr/local/bin "$HOME/.npm-global/bin" /opt/homebrew/opt/openjdk/bin \
         /usr/local/opt/openjdk/bin "$HOME/.volta/bin"; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
if [ -d "$HOME/.nvm/versions/node" ]; then
  NVMBIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"; [ -n "$NVMBIN" ] && PATH="$NVMBIN:$PATH"
fi
export PATH

RC="$HOME/zipper-release/mfa-backend-rc1-20261025T131629Z"
[ -f "$RC/candidate/firestore.rules" ] || { echo "Release candidate not found: $RC"; exit 1; }
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUTD="$RC/verification/tests-$TS"
mkdir -p "$OUTD" && chmod 700 "$RC/verification" "$OUTD"
WS="$(mktemp -d "${TMPDIR:-/tmp}/zipper-rc-tests.XXXXXX")" || exit 1
trap 'rm -rf "$WS"' EXIT
trap 'rm -rf "$WS"; exit 130' INT TERM HUP
SUMMARY="$OUTD/SUMMARY.txt"
say() { echo "$*" | tee -a "$SUMMARY"; }

say "ZIPPER MFA release candidate — local tests   $TS"
say "release candidate: $RC"
say "candidate rules sha256: $(shasum -a 256 "$RC/candidate/firestore.rules" | cut -c1-64)"
say "deployed  rules sha256: $(shasum -a 256 "$RC/baseline/firestore.rules.DEPLOYED" | cut -c1-64)"
say ""

# ───────────────────────────── Part A: Firestore rules on the emulator ─────────────────────────────
SUITES="firestore:firestore.rules.test.mjs:firestore
phase1a:firestore.phase1a.rules.test.mjs:firestore
ugp:firestore.ugp.rules.test.mjs:firestore
fx:firestore.fx.rules.test.mjs:firestore
gov:firestore.gov.rules.test.mjs:firestore
rc:firestore.rc.rules.test.mjs:firestore
p1mfa:firestore.p1mfa.rules.test.mjs:firestore
p1mfa-auth:auth.p1mfa.emulator.test.mjs:auth,firestore"

A_OK=1
command -v firebase >/dev/null 2>&1 || { say "PART A SKIPPED: the Firebase CLI (firebase) is not on PATH. Install: npm install -g firebase-tools"; A_OK=0; }
command -v java >/dev/null 2>&1 && java -version >/dev/null 2>&1 || { say "PART A SKIPPED: Java is not available (the emulator needs Java 11+). Install: brew install openjdk"; A_OK=0; }
command -v node >/dev/null 2>&1 || { say "PART A SKIPPED: Node is not on PATH."; A_OK=0; }
[ -d "$REPO/tests/node_modules/@firebase/rules-unit-testing" ] || { say "PART A SKIPPED: tests/node_modules is missing (run npm install in tests/)."; A_OK=0; }
[ -d "$REPO/functions/node_modules/firebase-admin" ] || { say "PART A SKIPPED: functions/node_modules/firebase-admin is missing."; A_OK=0; }
for port in 8080 9099; do
  if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then say "PART A SKIPPED: port $port is in use (stop the other emulator or server first)."; A_OK=0; fi
done

if [ "$A_OK" = 1 ]; then
  say "Part A — tools: firebase $(firebase --version 2>/dev/null | tail -1), node $(node --version), $(java -version 2>&1 | head -1)"
  say "test files (sha256/16):"
  while IFS=: read -r name file emus; do
    say "   $(shasum -a 256 "$REPO/tests/$file" | cut -c1-16)  tests/$file"
  done <<< "$SUITES"
  for variant in baseline candidate; do
    W="$WS/rules-$variant"; mkdir -p "$W/tests" "$W/functions"
    if [ "$variant" = baseline ]; then cp "$RC/baseline/firestore.rules.DEPLOYED" "$W/firestore.rules"
    else cp "$RC/candidate/firestore.rules" "$W/firestore.rules"; fi
    cp "$REPO/tests/package.json" "$W/tests/"
    while IFS=: read -r name file emus; do cp "$REPO/tests/$file" "$W/tests/"; done <<< "$SUITES"
    ln -s "$REPO/tests/node_modules" "$W/tests/node_modules"
    ln -s "$REPO/functions/package.json" "$W/functions/package.json"
    ln -s "$REPO/functions/node_modules" "$W/functions/node_modules"
    printf '%s\n' '{"firestore":{"rules":"firestore.rules"},"emulators":{"auth":{"port":9099},"firestore":{"port":8080},"ui":{"enabled":false},"singleProjectMode":true}}' > "$W/firebase.json"
    while IFS=: read -r name file emus; do
      LOG="$OUTD/rules-$variant-$name.log"
      echo "   running $name against the $variant rules ..."
      ( cd "$W" && ZIPPER_RULES_FILE="$W/firestore.rules" \
          firebase emulators:exec --only "$emus" --project demo-zipper "node tests/$file" ) > "$LOG" 2>&1
      echo "rc=$?" >> "$LOG"
    done <<< "$SUITES"
  done
  say ""
  say "Part A — results (FAIL lines compared between the two runs of each suite)"
  python3 -I - "$OUTD" <<'PY' | tee -a "$SUMMARY"
import os, re, sys
out = sys.argv[1]
names = ['firestore', 'phase1a', 'ugp', 'fx', 'gov', 'rc', 'p1mfa', 'p1mfa-auth']
must_pass = {'p1mfa', 'p1mfa-auth'}
bad = False
def read(v, n):
    p = os.path.join(out, 'rules-%s-%s.log' % (v, n))
    t = open(p, encoding='utf-8', errors='replace').read() if os.path.exists(p) else ''
    rc = re.findall(r'^rc=(\d+)\s*$', t, re.M)
    fails = set(re.sub(r'\s+', ' ', m).strip() for m in re.findall(r'^\s*FAIL\s+(.*)$', t, re.M))
    summ = [l.strip() for l in t.splitlines() if re.search(r'(checks passed|checks FAILED|-RESULT )', l)]
    return (int(rc[-1]) if rc else None), fails, (summ[-1] if summ else '(no summary line - see the log)')
print('%-11s %-9s %-9s %-6s %-6s %s' % ('suite', 'deployed', 'candidate', 'new', 'fixed', 'candidate summary'))
for n in names:
    rb, fb, sb = read('baseline', n)
    rcand, fc, sc = read('candidate', n)
    new, fixed = fc - fb, fb - fc
    st = lambda rc: 'pass' if rc == 0 else ('FAIL' if rc is not None else 'n/a')
    print('%-11s %-9s %-9s %-6d %-6d %s' % (n, st(rb), st(rcand), len(new), len(fixed), sc[:90]))
    for x in sorted(new):
        print('      NEW on candidate: %s' % x[:160])
    if n in must_pass and rcand != 0:
        bad = True
    if n not in must_pass and new:
        bad = True
print()
print('PART A RESULT:', 'NOT ACCEPTABLE - see NEW failures / MFA suites above' if bad else
      'ACCEPTABLE - the MFA suites pass on the candidate and no other suite gained a failure')
PY
fi

# ───────────────────────────── Part B: backend tests under Python 3.12 ─────────────────────────────
say ""
# The suites stub pymongo, motor, Firebase, jose and FastAPI, but NOT cryptography: the MFA suite seals
# TOTP secrets with a real Fernet key, as production does (python-jose[cryptography] in requirements.txt).
# So Part B needs a Python 3.12 that has the backend's requirements installed. The project's own venv
# (backend/.venv, built from requirements.txt) comes first. A 3.12 without cryptography is refused up
# front: its results would be neither a pass nor a verdict on the code.
PY312=""; PY312_NO_DEPS=""
for c in "$REPO/backend/.venv/bin/python" /opt/homebrew/bin/python3.12 /usr/local/bin/python3.12 /Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12; do
  if [ -x "$c" ] && "$c" -c 'import sys; sys.exit(0 if sys.version_info[:2] == (3, 12) else 1)' 2>/dev/null; then
    if "$c" -c 'import cryptography.fernet' >/dev/null 2>&1; then PY312="$c"; break; fi
    PY312_NO_DEPS="$PY312_NO_DEPS $c"
  fi
done
if [ -z "$PY312" ] && [ -n "$PY312_NO_DEPS" ]; then
  say "PART B NOT RUN: Python 3.12 found (${PY312_NO_DEPS# }) but without cryptography, a production requirement"
  say "  (python-jose[cryptography] in backend/requirements.txt) that tests/test_p1_owner_mfa.py uses."
  say "  Create the project venv:  cd backend && /opt/homebrew/bin/python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt"
elif [ -z "$PY312" ]; then
  say "PART B SKIPPED: no Python 3.12 found (brew install python@3.12)."
else
  say "Part B — $("$PY312" --version 2>&1) ($PY312)"
  FIXTURES="zipper-crm/lib/auth.ts
DEPLOYMENT.md
functions/src/identity.ts
functions/src/index.ts
zipper-crm/app/agencies/[id]/salary/Client.tsx
zipper-crm/app/users/page.tsx
functions/src/mobileSession.ts
zipper-app/app/src/main/java/com/zipper/app/data/repository/ChatRepository.kt
zipper-crm/app/kyc/page.tsx
functions/src/accounts.ts
zipper-app/app/src/main/java/com/zipper/app/ui/screens/messages/MessagesViewModel.kt
zipper-crm/app/seller-signup/page.tsx
functions/src/gifts.ts
functions/src/publicSeller.ts
zipper-app/app/src/main/java/com/zipper/app/ui/screens/messages/MessagesScreen.kt
functions/src/calls.ts
zipper-app/app/src/main/java/com/zipper/app/ui/screens/diamond/ResellerListScreen.kt
functions/src/wallet.ts"
  for variant in baseline candidate; do
    W="$WS/py-$variant"; mkdir -p "$W"
    if [ "$variant" = baseline ]; then
      cp -R "$RC/baseline/backend" "$W/backend"; cp "$RC/baseline/firestore.rules.DEPLOYED" "$W/firestore.rules"
    else
      cp -R "$RC/candidate/backend" "$W/backend"; cp "$RC/candidate/firestore.rules" "$W/firestore.rules"
    fi
    cp "$REPO/outputs/p1-exec/before/a3/firestore.indexes.json" "$W/firestore.indexes.json"
    ln -s "$REPO/backend/.venv" "$W/backend/.venv"
    while IFS= read -r f; do
      [ -f "$REPO/$f" ] || continue
      mkdir -p "$W/$(dirname "$f")"; cp "$REPO/$f" "$W/$f"
    done <<< "$FIXTURES"
    : > "$OUTD/backend-py312-$variant.tsv"
    for t in "$W"/backend/tests/test_*.py; do
      m="$(basename "$t" .py)"
      ( cd "$W/backend" && PYTHONDONTWRITEBYTECODE=1 TZ=UTC "$PY312" -B -m "tests.$m" ) > "$OUTD/backend-py312-$variant-$m.log" 2>&1
      printf '%s\t%s\n' "$m" "$?" >> "$OUTD/backend-py312-$variant.tsv"
    done
  done
  python3 -I - "$OUTD" <<'PY' | tee -a "$SUMMARY"
import os, re, sys
out = sys.argv[1]
def load(v):
    p = os.path.join(out, 'backend-py312-%s.tsv' % v)
    return dict(l.rstrip('\n').split('\t') for l in open(p) if l.strip()) if os.path.exists(p) else {}
def missing_third_party(v, m):
    """'x' when the module stopped on `No module named 'x'` for a package outside app/ and tests/."""
    p = os.path.join(out, 'backend-py312-%s-%s.log' % (v, m))
    t = open(p, encoding='utf-8', errors='replace').read() if os.path.exists(p) else ''
    hit = re.findall(r"ModuleNotFoundError: No module named '([^']+)'", t)
    return hit[-1] if hit and hit[-1].split('.')[0] not in ('app', 'tests') else ''
b, c = load('baseline'), load('candidate')
known_env = {'test_commission': 'needs backend/backups/... (production data backup, withheld)',
             'test_local_isolation': 'needs backend/.env.example (never extracted)'}
fb = sorted(m for m, rc in b.items() if rc != '0'); fc = sorted(m for m, rc in c.items() if rc != '0')
print('baseline : %d modules, %d pass, failing: %s' % (len(b), len(b) - len(fb), fb))
print('candidate: %d modules, %d pass, failing: %s' % (len(c), len(c) - len(fc), fc))
unexplained = [m for m in fc if m not in known_env and m not in fb]
for m in fc:
    dep = missing_third_party('candidate', m)
    print('   %s: %s' % (m, known_env.get(m, 'also fails on the baseline' if m in fb else
          ("DID NOT RUN - this interpreter lacks the third-party package '%s' (environment; not a pass)" % dep) if dep
          else 'NEW on the candidate - see its log')))
print('PART B RESULT:', 'NOT ACCEPTABLE - new failures: %s' % unexplained if unexplained else
      'ACCEPTABLE - no failure beyond the two known environment-dependent ones (and any shared with the baseline)')
PY
fi
say ""
say "Saved: $OUTD"
echo "== finished $(date)"
