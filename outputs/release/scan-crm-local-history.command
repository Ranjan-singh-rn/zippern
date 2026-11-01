#!/bin/bash
# ZIPPER — READ-ONLY search for earlier copies of the 21 CRM files changed on 22 Oct,
# in editor local history and Time Machine. Nothing is modified, deployed or uploaded.
#
# Reads only:
#   * VS Code-family local-history indexes (Code, Cursor, Windsurf, Antigravity, VSCodium, ...):
#       ~/Library/Application Support/<editor>/User/History/*/entries.json
#     Only an index whose file path ends in zipper-crm/<one of the 21 files> is used. Every other
#     index is skipped without recording which file it belongs to.
#   * the history snapshots of those 21 files (copied, never executed or printed);
#   * JetBrains / Android Studio local history: whether it exists, its size and date (not opened);
#   * Time Machine: the lists from `tmutil` and, inside a listed backup, only the 21 paths.
#     Backups need the backup disk connected; reading them may need Full Disk Access for Terminal.
# Writes only: ~/zipper-baseline/crm-history-<UTC>/ (mode 700): REPORT.txt, MATCHES.tsv, copies/...
set -u
cd "$(dirname "$0")/../.." || { echo "Cannot reach the repository root."; exit 1; }
REPO="$(pwd -P)"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$HOME/zipper-baseline/crm-history-$TS"
mkdir -p "$OUT" && chmod 700 "$HOME/zipper-baseline" "$OUT"

{
  echo "== Time Machine (lists only)"
  echo "-- tmutil destinationinfo (kind and mount point only)"; tmutil destinationinfo 2>&1 | grep -E '^(Kind|Mount Point)|No destinations|=====|rror'
  echo "-- tmutil latestbackup"; tmutil latestbackup 2>&1 | head -3
  echo "-- tmutil listbackups"; tmutil listbackups 2>&1 | head -200
  echo "-- tmutil listlocalsnapshots /"; tmutil listlocalsnapshots / 2>&1 | head -50
} > "$OUT/.tm.txt" 2>&1

python3 -I - "$REPO" "$OUT" "$OUT/.tm.txt" <<'PY'
import datetime as dt, glob, hashlib, json, os, re, shutil, subprocess, sys, urllib.parse
REPO, OUT, TM = sys.argv[1:4]
FILES = [
    'app/agencies/[id]/Client.tsx', 'app/agency-dashboard/AgencyMoney.tsx',
    'app/agency-dashboard/CommissionDerivation.tsx', 'app/agency-dashboard/CommissionLedger.tsx',
    'app/audit/page.tsx', 'app/board/page.tsx', 'app/coin-purchases/page.tsx', 'app/finance/reports/page.tsx',
    'app/finance/withdrawals/page.tsx', 'app/hosts/verification/page.tsx', 'app/operations/bans/page.tsx',
    'app/partners/page.tsx', 'app/recharges/page.tsx', 'app/role-appeals/page.tsx', 'app/sales/page.tsx',
    'app/seller-dashboard/page.tsx', 'app/transfers/page.tsx', 'app/users/[uid]/Client.tsx',
    'app/users/[uid]/PartnerApplications.tsx', 'components/SellerHistoryPanel.tsx', 'package.json',
]
UTC = dt.timezone.utc
COPY = dt.datetime(2026, 10, 20, 8, 50, 2, tzinfo=UTC)     # release run (rc-20261020T085002Z)
LIVE = dt.datetime(2026, 10, 20, 8, 55, 13, tzinfo=UTC)    # CRM Hosting version ba740f4158292308 released
B1 = dt.datetime(2026, 10, 22, 8, 32, 0, tzinfo=UTC)       # first 22 Oct edit of these files
HOME = os.path.expanduser('~')
SUFFIX = {('/zipper-crm/' + f).lower(): f for f in FILES}


def sha(b):
    return hashlib.sha256(b).hexdigest()


def git_head(f):
    r = subprocess.run(['git', '-C', REPO, 'show', 'HEAD:zipper-crm/' + f], capture_output=True)
    return sha(r.stdout) if r.returncode == 0 else None


def match(path):
    low = path.lower()
    for suf, f in SUFFIX.items():
        if low.endswith(suf):
            return f, path[:len(path) - len(suf)]          # file, checkout root
    return None, None


def safe_name(s):
    return re.sub(r'[^A-Za-z0-9._-]', '_', s)


rows, notes = [], []
# 1. VS Code-family local history
for hist in sorted(glob.glob(os.path.join(HOME, 'Library/Application Support/*/User/History'))):
    editor = hist.split('/Application Support/')[1].split('/User/History')[0]
    n_idx = n_hit = 0
    try:
        entries = list(os.scandir(hist))
    except OSError as e:
        notes.append('%s: history not readable (%s)' % (editor, e.__class__.__name__)); continue
    for d in entries:
        ej = os.path.join(d.path, 'entries.json')
        if not d.is_dir() or not os.path.isfile(ej):
            continue
        n_idx += 1
        try:
            data = json.load(open(ej, encoding='utf-8'))
            u = urllib.parse.urlparse(data.get('resource', ''))
        except Exception:
            continue
        if u.scheme != 'file':
            continue
        f, root = match(urllib.parse.unquote(u.path))
        if not f:
            continue                                        # some other file: not recorded
        for e in data.get('entries', []):
            src = os.path.join(d.path, os.path.basename(str(e.get('id', ''))))
            if not os.path.isfile(src):
                continue
            when = dt.datetime.fromtimestamp(int(e.get('timestamp', 0)) / 1000, UTC)
            body = open(src, 'rb').read()
            dst = os.path.join(OUT, 'copies', 'editor-' + safe_name(editor), f, when.strftime('%Y%m%dT%H%M%SZ') + '__' + safe_name(os.path.basename(src)))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            open(dst, 'wb').write(body)
            n_hit += 1
            rows.append({'file': f, 'source': 'editor:' + editor, 'when': when, 'sha256': sha(body), 'bytes': len(body),
                         'origin': str(e.get('source', '')), 'checkout': root, 'copy': os.path.relpath(dst, OUT)})
    notes.append('%s: %d history indexes scanned, %d snapshots of the 21 files' % (editor, n_idx, n_hit))
if not glob.glob(os.path.join(HOME, 'Library/Application Support/*/User/History')):
    notes.append('No VS Code-family local history folder found.')

# 2. JetBrains / Android Studio local history: presence only
for lh in sorted(glob.glob(os.path.join(HOME, 'Library/Caches/JetBrains/*/LocalHistory')) +
                 glob.glob(os.path.join(HOME, 'Library/Caches/Google/AndroidStudio*/LocalHistory'))):
    size, newest = 0, 0.0
    for d, _, fs in os.walk(lh):
        for x in fs:
            try:
                st = os.stat(os.path.join(d, x)); size += st.st_size; newest = max(newest, st.st_mtime)
            except OSError:
                pass
    notes.append('JetBrains-format local history (not opened; binary): %s  %.1f MB, newest %s'
                 % (lh.replace(HOME, '~'), size / 1e6, dt.datetime.fromtimestamp(newest, UTC).isoformat() if newest else '-'))

# 3. Time Machine: the 21 paths inside each listed backup
tm = open(TM, encoding='utf-8', errors='replace').read()
backups = [ln.strip() for ln in tm.split('-- tmutil listbackups', 1)[-1].split('-- tmutil listlocalsnapshots', 1)[0].splitlines()
           if ln.strip().startswith('/')]
rel_repo = os.path.relpath(os.path.join(REPO, 'zipper-crm'), '/')
for b in backups:
    m = re.search(r'(\d{4}-\d{2}-\d{2}-\d{6})', b)
    when = dt.datetime.strptime(m.group(1), '%Y-%m-%d-%H%M%S').astimezone(UTC) if m else None
    for f in FILES:
        found = None
        for vol in glob.glob(os.path.join(b, '*')):
            p = os.path.join(vol, rel_repo, f)
            try:
                if os.path.isfile(p):
                    found = p; break
            except OSError:
                pass
        if not found:
            continue
        try:
            body = open(found, 'rb').read()
        except OSError as e:
            notes.append('Time Machine %s: %s not readable (%s; Full Disk Access?)' % (m.group(1) if m else b, f, e.__class__.__name__)); continue
        dst = os.path.join(OUT, 'copies', 'timemachine-' + (m.group(1) if m else 'unknown'), f)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        open(dst, 'wb').write(body)
        rows.append({'file': f, 'source': 'timemachine', 'when': when, 'sha256': sha(body), 'bytes': len(body),
                     'origin': 'backup', 'checkout': REPO, 'copy': os.path.relpath(dst, OUT)})
notes.append('Time Machine backups listed: %d' % len(backups))

# 4. Per file: what was found, and the best pre-22 Oct candidates
head = {f: git_head(f) for f in FILES}
now = {}
for f in FILES:
    p = os.path.join(REPO, 'zipper-crm', f)
    now[f] = sha(open(p, 'rb').read()) if os.path.isfile(p) else None
with open(os.path.join(OUT, 'MATCHES.tsv'), 'w') as fh:
    fh.write('file\tsource\twhen_utc\tsha256\tbytes\torigin\tsame_as_HEAD\tsame_as_today\tcheckout\tcopy\n')
    for r in sorted(rows, key=lambda r: (r['file'], r['when'] or dt.datetime.min.replace(tzinfo=UTC))):
        fh.write('\t'.join([r['file'], r['source'], r['when'].isoformat() if r['when'] else '-', r['sha256'], str(r['bytes']),
                            r['origin'], str(r['sha256'] == head[r['file']]), str(r['sha256'] == now[r['file']]),
                            r['checkout'], r['copy']]) + '\n')
lines = ['ZIPPER CRM local-history search', 'repository: ' + REPO,
         'release copy %s | Hosting live %s | first 22 Oct edit %s' % (COPY.isoformat(), LIVE.isoformat(), B1.isoformat()), '']
lines += notes + ['']
lines.append('%-46s %5s  %-28s %-28s %s' % ('file', 'found', 'last copy at/before release', 'last copy before 22 Oct edit', 'first copy after'))
for f in FILES:
    rs = sorted((r for r in rows if r['file'] == f and r['when']), key=lambda r: r['when'])
    pre = [r for r in rs if r['when'] <= COPY]
    gap = [r for r in rs if COPY < r['when'] < B1]
    post = [r for r in rs if r['when'] >= B1]
    fmt = lambda r: '%s %s' % (r['when'].strftime('%m-%d %H:%M'), r['sha256'][:10]) if r else '-'
    lines.append('%-46s %5d  %-28s %-28s %s' % (f, len(rs), fmt(pre[-1] if pre else None),
                                               fmt((gap or pre)[-1] if (gap or pre) else None), fmt(post[0] if post else None)))
lines += ['', 'A copy "at/before release" is the last SAVED version an editor recorded before the release run;',
          'it is evidence, not proof: changes made outside that editor (scripts, other tools) are not recorded.',
          'Proof needs a rebuild whose content-hashed chunk names match the live Hosting version.']
open(os.path.join(OUT, 'REPORT.txt'), 'w').write('\n'.join(lines) + '\n')
print('\n'.join(lines))
PY
mv "$OUT/.tm.txt" "$OUT/TIMEMACHINE-LISTS.txt" 2>/dev/null
chmod -R go-rwx "$OUT"
echo
echo "Saved to: $OUT"
echo "== finished $(date)"
