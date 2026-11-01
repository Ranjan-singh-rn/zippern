#!/usr/bin/env python3
"""Build a scratch test tree for one backend variant, adding cross-component
fixture files ONLY as the suites ask for them. Run with `python3 -I`.

Usage: make_fixtures.py <variant-root> <backend-src> <rules-file> <out.json>

<variant-root>/backend            copy of <backend-src>
<variant-root>/firestore.rules    copy of <rules-file> (the rules that ship with that backend)
<variant-root>/firestore.indexes.json   the pre-P1 file (its composite indexes equal the deployed set)
<variant-root>/backend/.venv      symlink to the repo's backend/.venv (only the pinned
                                  google-cloud-firestore source is read, by tests/firestore_contention.py)
Anything else a suite opens outside backend/ is taken from git HEAD with `git show`
(committed files only), never from the working tree, and never a secret-bearing name.
Production data (backend/backups/) and backend/.env* are withheld.
"""
import json
import os
import re
import shutil
import subprocess
import sys

REPO = '/sessions/upbeat-zen-lovelace/mnt/zippern'
INDEXES_PRE_P1 = REPO + '/outputs/p1-exec/before/a3/firestore.indexes.json'
RUNNER = '/sessions/upbeat-zen-lovelace/mnt/outputs/p2test/run_backend_tests.py'
FORBIDDEN = re.compile(r'(^|/)(\.env[^/]*|serviceAccountKey\.json|local\.properties|[^/]*\.jks|google-services\.json|'
                       r'firestore-debug\.log|validation-logs|backups)(/|$)')

root, backend_src, rules, out = sys.argv[1:5]
SOURCE = sys.argv[5] if len(sys.argv) > 5 else 'head'      # 'head' (git show HEAD:) or 'worktree' (plain copy)
# Read through Path.exists() by the suites, so a missing one is skipped or fails without a FileNotFoundError.
EXISTS_CHECKED = ['zipper-crm/lib/auth.ts', 'DEPLOYMENT.md']
if os.path.exists(root):
    shutil.rmtree(root)
os.makedirs(root)
shutil.copytree(backend_src, os.path.join(root, 'backend'), ignore=shutil.ignore_patterns('.gcloudignore'))
shutil.copyfile(rules, os.path.join(root, 'firestore.rules'))
shutil.copyfile(INDEXES_PRE_P1, os.path.join(root, 'firestore.indexes.json'))
os.symlink(REPO + '/backend/.venv', os.path.join(root, 'backend', '.venv'))

added, withheld, absent = [], [], []


def fetch(rel):
    if SOURCE == 'head':
        g = subprocess.run(['git', '-C', REPO, 'show', 'HEAD:' + rel], capture_output=True)
        return g.stdout if g.returncode == 0 else None
    p = os.path.join(REPO, rel)
    if os.path.islink(p) or not os.path.isfile(p):
        return None
    return open(p, 'rb').read()


for rel in EXISTS_CHECKED:
    data = fetch(rel)
    if data is None:
        absent.append(rel)
        continue
    dst = os.path.join(root, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    open(dst, 'wb').write(data)
    added.append(rel)

for rnd in range(40):
    tmp = os.path.join(root, '.round.json')
    r = subprocess.run([sys.executable, '-I', RUNNER, os.path.join(root, 'backend'), tmp], capture_output=True, text=True)
    res = json.load(open(tmp))
    os.remove(tmp)
    new = set()
    for m, v in res.items():
        for ln in v['tail']:
            for p in re.findall(r"No such file or directory: '([^']+)'", ln):
                new.add(p)
    progress = False
    for p in sorted(new):
        if not p.startswith(root + '/'):
            continue
        rel = p[len(root) + 1:]
        if rel in added or rel in withheld or rel in absent:
            continue
        if FORBIDDEN.search(rel) or rel.startswith('backend/'):
            withheld.append(rel)
            continue
        data = fetch(rel)
        if data is None:
            absent.append(rel)
            continue
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, 'wb').write(data)
        added.append(rel)
        progress = True
    if not progress:
        break

final = os.path.join(root, 'final.json')
subprocess.run([sys.executable, '-I', RUNNER, os.path.join(root, 'backend'), final], capture_output=True, text=True)
res = json.load(open(final))
json.dump({'fixture_source': SOURCE, 'fixtures': added, 'withheld': withheld, 'absent': absent, 'results': res},
          open(out, 'w'), indent=1, sort_keys=True)
fails = sorted(m for m, v in res.items() if v['rc'] != 0)
print('modules %d | pass %d | fail %d %s' % (len(res), len(res) - len(fails), len(fails), fails))
print('fixtures (%s): %d files' % (SOURCE, len(added)))
print('withheld:', withheld, '| absent:', absent)
