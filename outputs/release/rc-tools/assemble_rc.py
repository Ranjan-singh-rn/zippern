#!/usr/bin/env python3
"""Assemble the Owner-MFA backend release candidate (sandbox side). Run with `python3 -I`.

Inputs (read only):
  * the exact production backend extracted from the Cloud Run source archive
  * the deployed Firestore ruleset text
  * the reviewed MFA-only patches (outputs/release/proposed-mfa-patches)
Output: a NEW directory (refuses to overwrite) under ~/zipper-release/.
Nothing here touches the repository, production, or any network.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys

ID = 'mfa-backend-rc1-20261025T131629Z'
MNT = '/sessions/upbeat-zen-lovelace/mnt'
BASE_DIR = MNT + '/zipper-baseline/20261025T090632Z'
BASE_SRC = BASE_DIR + '/cloudrun-src'
INDEX = MNT + '/zipper-baseline/20261025T085009Z/cloudrun-source.INDEX.txt'
PROP = MNT + '/zippern/outputs/release/proposed-mfa-patches'
BUILDER_OUT = '/tmp/p2/mfa'
RC = MNT + '/zipper-release/' + ID
REPORT = '/tmp/p2/rc/assembly.json'

EXCLUDED = {
    'storage.rules': 'Storage rules deferred (needs an IAM decision)',
    'backend/scripts/remove_gate_answers.py': 'data migration (post-rollout); migrations excluded',
    'functions/test/ownerMfa.test.js': 'Functions deferred',
}


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 16), b''):
            h.update(b)
    return h.hexdigest()


def die(msg):
    print('STOP: ' + msg)
    sys.exit(1)


def walk_files(root):
    out = {}
    for d, dirs, files in os.walk(root, followlinks=False):
        dirs.sort()
        for n in dirs:
            if os.path.islink(os.path.join(d, n)):
                die('symlink directory in ' + d)
        for n in sorted(files):
            p = os.path.join(d, n)
            if os.path.islink(p) or not os.path.isfile(p):
                die('not a regular file: ' + p)
            out[os.path.relpath(p, root)] = p
    return out


def main():
    rep = {'id': ID, 'steps': []}
    if os.path.exists(RC):
        die('release directory already exists (refusing to overwrite): ' + RC)

    # ---- 1. baseline inventory vs the archive's central-directory index (names + sizes)
    index = {}
    for line in open(INDEX, encoding='utf-8'):
        line = line.rstrip('\n')
        if not line.strip():
            continue
        size, name = line.split(None, 1)
        if not name.endswith('/'):
            index[name] = int(size)
    src = walk_files(BASE_SRC)
    secret_like = sorted(n for n in index if os.path.basename(n).startswith('.env'))
    missing = sorted(set(index) - set(src) - set(secret_like))
    extra = sorted(set(src) - set(index))
    size_mismatch = sorted(n for n in src if n in index and os.path.getsize(src[n]) != index[n])
    if missing or extra or size_mismatch:
        die('baseline does not match the archive index: missing=%s extra=%s size=%s' % (missing, extra, size_mismatch))
    rep['baseline_index'] = {'archive_file_entries': len(index), 'extracted': len(src),
                             'not_extracted_secret_like_names': secret_like, 'name_and_size_mismatches': 0}

    # ---- 2. proposed patch manifest: choose the reviewed backend/tests/rules patches
    pm = json.load(open(PROP + '/MANIFEST.json'))
    chosen, excluded = [], []
    for e in pm:
        if e['component'] in ('functions', 'crm'):
            excluded.append({'file': e['file'], 'patch': e['patch'], 'reason': e['component'] + ' deferred'})
        elif e['file'] in EXCLUDED:
            excluded.append({'file': e['file'], 'patch': e['patch'], 'reason': EXCLUDED[e['file']]})
        else:
            chosen.append(e)
    rep['excluded_patches'] = excluded

    # ---- 3. lay out the directory (new, mode 700 at the top)
    os.makedirs(RC)
    os.chmod(RC, 0o700)
    for sub in ('baseline/backend', 'patches/backend', 'patches/tests', 'patches/rules', 'candidate'):
        os.makedirs(os.path.join(RC, sub), exist_ok=True)

    base_rows = {}
    for rel, p in src.items():
        dst = os.path.join(RC, 'baseline/backend', rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(p, dst)
        a, b = sha(p), sha(dst)
        if a != b:
            die('copy mismatch ' + rel)
        base_rows[rel] = {'sha256': a, 'bytes': os.path.getsize(dst)}
    rules_src = BASE_DIR + '/firestore.rules.DEPLOYED'
    rules_dst = os.path.join(RC, 'baseline/firestore.rules.DEPLOYED')
    shutil.copyfile(rules_src, rules_dst)
    if sha(rules_src) != sha(rules_dst):
        die('rules copy mismatch')
    rep['baseline_rules_sha256'] = sha(rules_dst)

    # ---- 4. copy patches, verify each base against the recorded base hash
    patch_rows = []
    for e in chosen:
        sub = {'backend': 'backend', 'tests': 'tests', 'rules': 'rules'}[e['component']]
        pdst = os.path.join(RC, 'patches', sub, os.path.basename(e['patch']))
        shutil.copyfile(os.path.join(PROP, e['patch']), pdst)
        if e['file'] == 'firestore.rules':
            base_path = rules_dst
        else:
            rel = e['file'][len('backend/'):]
            base_path = os.path.join(RC, 'baseline/backend', rel)
        if e['base_sha256_16'] is None:
            if os.path.exists(base_path):
                die('new-file patch but the base exists: ' + e['file'])
            base_ok = 'new file (absent in baseline: confirmed)'
        else:
            got = sha(base_path)[:16]
            if got != e['base_sha256_16']:
                die('base hash mismatch for %s: %s != %s' % (e['file'], got, e['base_sha256_16']))
            base_ok = 'matches recorded base sha256/16 ' + e['base_sha256_16']
        patch_rows.append({'file': e['file'], 'component': e['component'],
                           'patch': os.path.relpath(pdst, RC), 'patch_sha256': sha(pdst),
                           'lines': e['lines'], 'base': e['base'], 'confidence': e['confidence'],
                           'base_check': base_ok, 'recorded_base_sha256_16': e['base_sha256_16'],
                           'recorded_result_sha256_16': e['mfa_sha256_16'],
                           'included': e['included'], 'excluded_hunks': e['excluded'], 'note': e['note']})

    # ---- 5. candidate = baseline + patches, applied strictly (no fuzz, no offset, no rejects)
    shutil.copytree(os.path.join(RC, 'baseline/backend'), os.path.join(RC, 'candidate/backend'))
    shutil.copyfile(rules_dst, os.path.join(RC, 'candidate/firestore.rules'))
    cand = os.path.join(RC, 'candidate')
    logs = []
    for dry in (True, False):
        for row in patch_rows:
            cmd = ['patch', '--batch', '--forward', '--fuzz=0', '--no-backup-if-mismatch',
                   '--reject-file=-', '-p1', '-d', cand, '-i', os.path.join(RC, row['patch'])]
            if dry:
                cmd.insert(1, '--dry-run')
            r = subprocess.run(cmd, capture_output=True, text=True)
            out = (r.stdout + r.stderr).strip()
            bad = [w for w in ('offset', 'fuzz', 'FAILED', 'Reversed', 'reject', 'malformed', 'garbage')
                   if w.lower() in out.lower()]
            if r.returncode != 0 or bad:
                die('patch %s (%s): rc=%d flags=%s\n%s' % (row['patch'], 'dry-run' if dry else 'apply', r.returncode, bad, out))
            if not dry:
                logs.append(out)
    rep['patch_log'] = logs

    # ---- 6. verify every patched file against the recorded result hash and the builder output
    for row in patch_rows:
        f = row['file']
        res = os.path.join(cand, f if f == 'firestore.rules' else f)
        if not os.path.exists(res):
            die('patched file missing ' + f)
        h = sha(res)
        if h[:16] != row['recorded_result_sha256_16']:
            die('result hash mismatch %s: %s != %s' % (f, h[:16], row['recorded_result_sha256_16']))
        bo = os.path.join(BUILDER_OUT, f)
        row['result_sha256'] = h
        row['result_check'] = 'matches recorded result sha256/16'
        if os.path.exists(bo):
            if sha(bo) != h:
                die('candidate differs from the builder output for ' + f)
            row['result_check'] += ' and the reviewed builder output (full sha256)'

    # ---- 7. no stray files: candidate backend differs from baseline in exactly the patched files
    cb = walk_files(os.path.join(cand, 'backend'))
    patched = {r['file'][len('backend/'):] for r in patch_rows if r['file'].startswith('backend/')}
    changed = sorted(n for n in cb if n not in base_rows or sha(cb[n]) != base_rows[n]['sha256'])
    removed = sorted(set(base_rows) - set(cb))
    if set(changed) != patched or removed:
        die('unexpected candidate delta: changed=%s patched=%s removed=%s' % (changed, sorted(patched), removed))
    rep['candidate_delta'] = changed

    # ---- 8. defensive upload filter for `gcloud run deploy --source` (ignores itself; not part of the app)
    gi = os.path.join(cand, 'backend', '.gcloudignore')
    with open(gi, 'w') as fh:
        fh.write('# Added by the release candidate. gcloud uploads nothing listed here (including this file).\n'
                 '.gcloudignore\n.git\n.gitignore\n.env\n.env.*\n.venv/\n__pycache__/\n**/__pycache__/\n*.pyc\n'
                 '.pytest_cache/\n.DS_Store\n**/.DS_Store\nbackups/\n')

    # ---- 9. modes: files 644, dirs 755 inside; the top directory stays 700
    for d, dirs, files in os.walk(RC):
        for n in dirs:
            os.chmod(os.path.join(d, n), 0o755)
        for n in files:
            os.chmod(os.path.join(d, n), 0o644)
    os.chmod(RC, 0o700)

    rep['baseline_files'] = base_rows
    rep['patches'] = patch_rows
    rep['candidate_rules_sha256'] = sha(os.path.join(cand, 'firestore.rules'))
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    json.dump(rep, open(REPORT, 'w'), indent=1, sort_keys=True)
    print('OK: assembled', RC)
    print('baseline files:', len(base_rows), '| patches:', len(patch_rows), '| excluded patches:', len(excluded))
    print('candidate delta (%d):' % len(changed), ', '.join(changed))
    print('candidate firestore.rules sha256:', rep['candidate_rules_sha256'])


if __name__ == '__main__':
    main()
