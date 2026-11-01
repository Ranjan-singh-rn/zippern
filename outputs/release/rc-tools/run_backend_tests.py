#!/usr/bin/env python3
"""Run every backend test module of a backend tree, each in its own process.

Usage: python3 -I run_backend_tests.py <backend-dir-copy> <out.json> [module ...]
Runs `python3 -B -m tests.<module>` with cwd=<backend-dir-copy>. The tree must be
a scratch COPY (never the release candidate itself). No network is needed: the
suites stub pymongo/motor/firebase/FastAPI (tests/harness.py, tests/fakes.py).
"""
import json
import os
import re
import subprocess
import sys
import time

root, out = sys.argv[1], sys.argv[2]
mods = sys.argv[3:] or sorted(f[:-3] for f in os.listdir(os.path.join(root, 'tests'))
                              if f.startswith('test_') and f.endswith('.py'))
env = {'PATH': '/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE': '1', 'HOME': '/tmp/p2/home', 'LANG': 'C.UTF-8',
       'TZ': 'UTC'}
os.makedirs(env['HOME'], exist_ok=True)
res = {}
for m in mods:
    t = time.time()
    try:
        r = subprocess.run([sys.executable, '-B', '-m', 'tests.' + m], cwd=root, env=env,
                           capture_output=True, text=True, timeout=900)
        rc, text, so = r.returncode, (r.stdout + '\n' + r.stderr), r.stdout
    except subprocess.TimeoutExpired as e:
        rc, text, so = 'timeout', str(e), ''
    lines = [ln for ln in text.splitlines() if ln.strip()]
    summary = [ln.strip() for ln in so.splitlines()
               if re.search(r'(?i)\b(passed|failed|checks?)\b', ln) and not ln.strip().startswith(('ok ', 'ok\t', '✓'))]
    res[m] = {'rc': rc, 'seconds': round(time.time() - t, 1), 'tail': lines[-6:],
              'summary': summary[-1][:200] if summary else ''}
    print('%-40s %s' % (m, 'PASS' if rc == 0 else 'FAIL rc=%s' % rc), flush=True)
json.dump(res, open(out, 'w'), indent=1, sort_keys=True)
p = sum(1 for v in res.values() if v['rc'] == 0)
print('TOTAL %d modules: %d pass, %d fail' % (len(res), p, len(res) - p))
