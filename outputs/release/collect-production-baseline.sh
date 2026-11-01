#!/bin/bash
# =================================================================================================
# ZIPPER — READ-ONLY production baseline for project zipper-83816            (Phase 2 · Phase B)
# =================================================================================================
# Run from the repository root on your Mac, after `gcloud auth login` with an account that can READ
# the project (project Owner/Editor/Viewer; a Viewer-only account may also need Storage Object
# Viewer for the source archives and Security Reviewer for the IAM policies):
#
#   bash outputs/release/collect-production-baseline.sh                # metadata only, ~1-3 minutes
#   bash outputs/release/collect-production-baseline.sh --list-sources # + the INDEX of each source archive (file
#                                                                      #   names and sizes from the zip's central
#                                                                      #   directory; two byte-range reads, no file data)
#   bash outputs/release/collect-production-baseline.sh --with-sources # + the source archives the live
#                                                                      #   backend and Functions were built from
#        (--with-sources=backend or --with-sources=functions downloads just one of them)
#   bash outputs/release/collect-production-baseline.sh --with-apk     # + newest published APK per channel,
#                                                                      #   scanned for feature markers, then deleted
# Guarantees
#   * READ-ONLY. Only describe / list / get calls, HTTP GET, and `gcloud storage ls | cat | objects list`
#     (downloads). Nothing is deployed, enabled, granted, created, updated or deleted. The guard below
#     refuses to run if an executable line gains a mutating or secret-printing command, or an `rm`
#     outside this run's output folder.
#   * Writes only under ~/zipper-baseline/<UTC time>/ (mode 700), never inside the repository. It reads
#     the repository (git show, git --no-optional-locks status, file hashes and times) and changes nothing.
#   * Prints and stores no secrets. The access token stays in a shell variable and reaches curl through a
#     file descriptor (not argv, not disk). Environment-variable and Secret Manager VALUES are never
#     requested, or are dropped in memory before anything is written (names only). E-mail addresses of
#     people (deployers, IAM members) and every field whose name contains "token" are redacted.
#   * Source archives (--with-sources) can contain secrets (.env, keys). Secret-looking files are counted
#     and named, never extracted, and each archive is deleted as soon as it has been extracted.
#   * Every step is independent and non-fatal. Whatever could not be retrieved is listed in
#     UNAVAILABLE.txt. stderr.log may contain your own account name inside permission errors.
# =================================================================================================

set -u
set +x
set -o pipefail
umask 077
# gcloud offers interactive fixes, e.g. "API … not enabled. Would you like to enable and retry? (y/N)".
# With prompts disabled every prompt takes its default, which for those offers is "no", so nothing
# can be enabled or changed by a keystroke while this runs.
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

P="zipper-83816"; R="asia-south1"; SERVICE="zipper-api"
BUCKET="zipper-83816.firebasestorage.app"; SITES="zipperlive zipper-83816"
FUNCS="backfillPublicProfiles syncStorageRoleClaim settleGift"
WITH_SOURCES=0; WITH_APK=0; SRC_WHICH="backend functions"; LIST_ONLY=0
for a in "$@"; do
  case "$a" in
    --with-sources) WITH_SOURCES=1 ;;
    --with-sources=backend) WITH_SOURCES=1; SRC_WHICH="backend" ;;
    --with-sources=functions) WITH_SOURCES=1; SRC_WHICH="functions" ;;
    --list-sources) WITH_SOURCES=1; LIST_ONLY=1 ;;     # zip index only (names, sizes): no file contents are read
    --with-apk) WITH_APK=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

# ── Guard: the lines ending in #GUARD are the only lines exempt from it ────────────────────────────
BAD='(gcloud|firebase)[^#]*[[:space:]](deploy|create|delete|update|patch|replace|import|submit|rollback|undelete|restore|enable|disable|set|unset|add|remove|apply|clone|cp|mv|rm|rsync|access|login|revoke|set-iam-policy|add-iam-policy-binding|remove-iam-policy-binding|update-traffic|[a-z:-]+:(deploy|delete|set|unset|clone|rollback|apply|create|import|enable|disable|access|destroy|prune))([[:space:]]|$)|gsutil|wget|curl[^#]*[[:space:]](-X[A-Za-z]*|--request|-d|--data[a-z-]*|-T|--upload-file|-F|--form|--json)([[:space:]]|$)|urllib\.request|http\.client|requests\.(post|put|patch|delete)|git[^#]*[[:space:]](add|commit|push|reset|clean|stash|checkout|switch|restore|revert|rm|mv|tag|branch|worktree|apply|merge|rebase|cherry-pick|gc|prune|update-index|config)([[:space:]]|$)|.git.,[[:space:]]*.(add|commit|push|reset|clean|stash|checkout|restore|revert|rm|mv|tag|branch|worktree|apply|config).'  #GUARD
if grep -vE '^[[:space:]]*#|#GUARD$' "$0" | grep -qE "$BAD" \
   || grep -vE '^[[:space:]]*#|#GUARD$' "$0" | grep -E '(^|[;&|(]|[[:space:]])rm[[:space:]]' | grep -qv '"\$OUT/'; then  #GUARD
  echo "REFUSING TO RUN: this script contains a mutating or secret-printing command, or an rm outside its output folder." >&2  #GUARD
  exit 2  #GUARD
fi  #GUARD

[ -f firestore.rules ] && [ -f firebase.json ] && [ -e .git ] || { echo "Run this from the repository root." >&2; exit 2; }
for c in gcloud python3 curl git; do command -v "$c" >/dev/null 2>&1 || { echo "$c is required" >&2; exit 2; }; done
OUT="$HOME/zipper-baseline/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT" && chmod 700 "$OUT" || exit 2
cleanup() { rm -f "$OUT/".*-source.archive "$OUT/.tail" "$OUT/.cd" "$OUT/.apk" "$OUT/.helper.py"; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM HUP
GAPS="$OUT/UNAVAILABLE.txt"; ERR="$OUT/stderr.log"; HELPER="$OUT/.helper.py"; TIMES="$OUT/DEPLOY-TIMES.txt"
: > "$GAPS"; : > "$TIMES"; : > "$ERR"
gap()  { echo "   GAP: $1"; echo "$1" >> "$GAPS"; }
step() { printf '\n== %s\n' "$1"; }

cat > "$HELPER" <<'PY'
import base64, collections, difflib, hashlib, json, os, re, subprocess, sys, tarfile, zipfile
from datetime import datetime, timezone
from urllib.parse import quote

EMAIL = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')
PERSONAL = re.compile(r'(?i)(email|creator|lastmodifier|releaseuser|actor)$')
TOKENISH = re.compile(r'(?i)token')
SECRET = re.compile(r'(^|/)(\.env(\.[^/]*)?|\.secret[^/]*|\.runtimeconfig\.json|[^/]*service-?account[^/]*\.json|'
                    r'[^/]*-firebase-adminsdk-[^/]*\.json|[^/]*\.(pem|p12|pfx|key|jks|keystore)|local\.properties|'
                    r'google-services\.json|credentials[^/]*\.json)$', re.I)
PRE = 'outputs/p1-exec/before/'
PRE_MAP = {
    'backend/app/core/audit.py': 'backend/core/audit.py', 'backend/app/core/account_state.py': 'backend/core/account_state.py',
    'backend/app/core/deps.py': 'backend/core/deps.py', 'backend/app/core/security.py': 'backend/core/security.py',
    'backend/app/main.py': 'backend/main.py', 'backend/app/routers/staff.py': 'backend/routers/staff.py',
    'backend/app/services/staff.py': 'backend/services/staff.py', 'backend/app/services/email.py': 'backend/services/email.py',
    'backend/app/config.py': 'a3/backend/app/config.py', 'backend/app/db/mongo.py': 'a3/backend/app/db/mongo.py',
    'backend/app/routers/auth.py': 'a3/backend/app/routers/auth.py', 'backend/app/services/crm_directory.py': 'a3/crm_directory.py',
    'backend/app/db/firebase.py': 'mfa-sid/backend/app/db/firebase.py',
    'backend/app/services/storage_claims.py': 'mfa-sid/backend/app/services/storage_claims.py',
    'functions/src/profiles.ts': 'mfa-stage1/functions/profiles.ts', 'functions/src/storageClaims.ts': 'mfa-sid/functions/src/storageClaims.ts',
}
MARKERS = (b'/api/auth/signin', b'/api/auth/mfa/verify', b'/api/auth/mfa/bind/confirm', b'ownerWork', b'startMobileSession')


def die(msg):
    print(msg, file=sys.stderr); sys.exit(1)


def load(p):
    with open(p) as f:
        return json.load(f)


def readj(p):
    try:
        return load(p)
    except (OSError, ValueError):
        return None


def stdin_json():
    """JSON from a pipe. Empty or invalid input means the producing command failed (and logged to
    stderr.log): exit 1 quietly so the caller records a gap instead of printing a traceback."""
    data = sys.stdin.read()
    try:
        return json.loads(data) if data.strip() else sys.exit(1)
    except ValueError:
        sys.exit(1)


def readb(p):
    try:
        with open(p, 'rb') as f:
            return f.read()
    except OSError:
        return None


def git_head(path):
    r = subprocess.run(['git', '--no-optional-locks', 'show', 'HEAD:' + path], capture_output=True)
    return r.stdout if r.returncode == 0 else None


def ts(s):
    if not s:
        return None
    s = str(s).strip().replace('Z', '+00:00')
    m = re.match(r'^(.*T\d\d:\d\d:\d\d)(\.\d+)?(.*)$', s)
    if m:
        frac = ('.' + m.group(2)[1:7].ljust(6, '0')) if m.group(2) else ''
        s = m.group(1) + frac + (m.group(3) or '+00:00')
    try:
        return datetime.fromisoformat(s).timestamp()
    except ValueError:
        return None


def mask(s):
    return EMAIL.sub(lambda m: m.group(0) if m.group(0).endswith('gserviceaccount.com') else '<redacted-email>', s)


def redact(o):
    if isinstance(o, dict):
        r = {}
        for k, v in o.items():
            if k in ('environmentVariables', 'buildEnvironmentVariables') and isinstance(v, dict):
                r[k] = sorted(v)                                   # names only; values never written
                continue
            if k == 'env' and isinstance(v, list):
                r[k] = [redact({a: b for a, b in e.items() if a != 'value'}) for e in v if isinstance(e, dict)]
                continue
            if PERSONAL.search(k) and not (isinstance(v, str) and v.endswith('gserviceaccount.com')):
                r[k] = '<redacted>'
                continue
            if TOKENISH.search(k) and k != 'nextPageToken':
                r[k] = '<redacted>'
                continue
            r[k] = redact(v)
        return r
    if isinstance(o, list):
        return [redact(x) for x in o]
    if isinstance(o, str):
        return mask(o)
    return o


def delta(a, b):
    if a is None or b is None:
        return 'n/a'
    A = a.decode('utf-8', 'replace').splitlines(); B = b.decode('utf-8', 'replace').splitlines()
    add = rem = 0
    for l in difflib.unified_diff(A, B, lineterm='', n=0):
        if l.startswith('+') and not l.startswith('+++'):
            add += 1
        elif l.startswith('-') and not l.startswith('---'):
            rem += 1
    return '+%d/-%d' % (add, rem)


# ── commands ──────────────────────────────────────────────────────────────────────────────────────
def c_redact():
    data = sys.stdin.read()
    if not data.strip():
        sys.exit(1)                                      # the failing command already logged to stderr.log
    try:
        o = json.loads(data)
    except ValueError:
        die('input is not JSON')
    json.dump(redact(o), sys.stdout, indent=1, sort_keys=True); print()


def _svc(f):
    d = load(f)
    return d, d.get('status', {}) or {}, (d.get('spec', {}) or {}).get('template', {}) or {}


def c_run_summary(f):
    d, st, tm = _svc(f)
    print('url:', st.get('url'))
    print('latest ready revision:', st.get('latestReadyRevisionName'), '| latest created:', st.get('latestCreatedRevisionName'))
    for t in st.get('traffic', []) or []:
        print('traffic: %3s%%  revision=%s  latestRevision=%s  tag=%s' % (t.get('percent', 0), t.get('revisionName') or '(latest)',
                                                                       t.get('latestRevision', False), t.get('tag', '-')))
    c = ((tm.get('spec', {}) or {}).get('containers') or [{}])[0]
    print('image:', c.get('image'))
    print('runtime service account:', (tm.get('spec', {}) or {}).get('serviceAccountName') or '(not set: default compute SA)')


def c_run_field(f, name):
    d, st, tm = _svc(f)
    if name == 'serving':
        revs = []
        for t in st.get('traffic', []) or []:
            if (t.get('percent') or 0) > 0:
                revs.append(t.get('revisionName') or st.get('latestReadyRevisionName') or '')
        print(' '.join(r for r in dict.fromkeys(revs) if r))
    elif name == 'sa':
        print((tm.get('spec', {}) or {}).get('serviceAccountName', '') or '')


def c_rev_field(f, name):
    d = load(f); md = d.get('metadata', {}) or {}; ann = md.get('annotations', {}) or {}
    if name == 'created':
        print(md.get('creationTimestamp', ''))
    elif name == 'digest':
        dg = (d.get('status', {}) or {}).get('imageDigest', '') or ''
        print(dg.split('@', 1)[1] if '@' in dg else dg)
    elif name == 'build_source':
        v = ann.get('run.googleapis.com/build-source-location', '') or ann.get('run.googleapis.com/source-location', '')
        if v.strip().startswith('{'):                    # gcloud >= 5xx writes {"<container>": "gs://…#gen"}
            try:
                v = next((x for x in json.loads(v).values() if str(x).startswith('gs://')), '')
            except ValueError:
                v = ''
        print(v if v.startswith('gs://') else '')
    elif name == 'build_id':
        b = ann.get('run.googleapis.com/build-id', '') or ann.get('run.googleapis.com/build-name', '')
        print(b.rsplit('/', 1)[-1] if b else '')


def c_env_names():
    d = stdin_json()
    cs = (((d.get('spec', {}) or {}).get('template', {}) or {}).get('spec', {}) or {}).get('containers') or [{}]
    names = []
    for e in cs[0].get('env', []) or []:
        n = e.get('name', '?'); ref = (e.get('valueFrom') or {}).get('secretKeyRef')
        names.append(n)
        print('%-40s %s' % (n, ('<- secret %s:%s' % (ref.get('name', '?'), ref.get('key', '?'))) if ref else '(plain value, not collected)'))
    print()
    for want in ('OWNER_MFA_ENCRYPTION_KEY', 'OWNER_MFA_REQUIRED', 'ENFORCE_MOBILE_SESSION', 'FIREBASE_CREDENTIALS_PATH',
                 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST'):
        print('check %-30s %s' % (want, 'PRESENT' if want in names else 'absent'))


def _fn_source(d):
    bc = d.get('buildConfig') or {}
    ss = (bc.get('source') or {}).get('storageSource') or {}
    if ss.get('bucket') and ss.get('object'):
        return 'gs://%s/%s' % (ss['bucket'], ss['object']) + ('#%s' % ss['generation'] if ss.get('generation') else '')
    rs = (bc.get('sourceProvenance') or {}).get('resolvedStorageSource') or {}
    if rs.get('bucket') and rs.get('object'):
        return 'gs://%s/%s' % (rs['bucket'], rs['object'])
    u = d.get('sourceArchiveUrl', '') or ''
    return u if u.startswith('gs://') else ''


def _fn_build(d):
    b = (d.get('buildConfig') or {}).get('build') or d.get('buildId') or ''
    return b.rsplit('/', 1)[-1] if b else ''


def c_fn_summary(f):
    d = load(f); bc = d.get('buildConfig') or {}; sc = d.get('serviceConfig') or {}
    gen = d.get('environment') or ('GEN_1' if ('versionId' in d or 'sourceArchiveUrl' in d) else '?')
    print('   %s: %s  state=%s  updated=%s  runtime=%s' % ((d.get('name') or '?').rsplit('/', 1)[-1], gen, d.get('state') or d.get('status'),
                                                        d.get('updateTime'), bc.get('runtime') or d.get('runtime')))
    print('      source archive:', _fn_source(d) or '(not exposed; see build)', '| build:', _fn_build(d) or '-')
    if sc.get('service'):
        print('      gen2 Cloud Run service:', sc['service'].rsplit('/', 1)[-1], '| revision:', sc.get('revision'))
    envs = d.get('environmentVariables') or sc.get('environmentVariables') or []
    print('      env var NAMES:', ', '.join(envs) if envs else '(none)')


def c_fn_field(f, name):
    d = load(f)
    print({'source': _fn_source(d), 'build': _fn_build(d), 'updated': d.get('updateTime', ''),
           'version': str(d.get('versionId', '') or ''), 'short': (d.get('name') or '').rsplit('/', 1)[-1]}.get(name, ''))


def c_wrap_list(key):
    """gcloud list output (a JSON array) -> {key: [...]}, the REST page shape indexes-merge expects."""
    o = stdin_json()
    json.dump({key: o if isinstance(o, list) else []}, sys.stdout)


def c_build_source():
    try:
        d = json.load(sys.stdin)
    except ValueError:
        print(''); return
    for k in ('source', 'sourceProvenance'):
        s = (d.get(k) or {})
        s = s.get('storageSource') or s.get('resolvedStorageSource') or {}
        if s.get('bucket') and s.get('object'):
            print('gs://%s/%s' % (s['bucket'], s['object']) + ('#%s' % s['generation'] if s.get('generation') else '')); return
    print('')


def c_rules_list(f):
    for r in load(f).get('releases', []) or []:
        print('   release %-55s ruleset %s  updated %s' % (r.get('name', '').split('/releases/', 1)[-1],
                                                         r.get('rulesetName', '').rsplit('/', 1)[-1], r.get('updateTime')))


def c_rules_release(f, rid):
    for r in load(f).get('releases', []) or []:
        if r.get('name', '').endswith('/releases/' + rid):
            print(r.get('rulesetName', ''), r.get('updateTime', '')); return


def c_ruleset_source(f, out):
    d = load(f); files = (d.get('source') or {}).get('files') or []
    if not files:
        die('no source in ruleset')
    with open(out, 'w') as o:
        o.write(files[0].get('content', ''))
    print('   %s: %d lines (ruleset created %s)' % (os.path.basename(out), len(files[0].get('content', '').splitlines()), d.get('createTime')))


def c_rules_previous(f, out):
    rs = load(f).get('rulesets', []) or []
    rs.sort(key=lambda r: r.get('createTime', ''), reverse=True)
    for kind, service in (('firestore', 'cloud.firestore'), ('storage', 'firebase.storage')):
        cur = (readb('%s/%s.ruleset-name.txt' % (out, kind)) or b'').decode().strip()
        mine = [r for r in rs if service in (((r.get('metadata') or {}).get('services')) or [])]
        if not mine:
            print('   %s: previous ruleset not identifiable (rulesets carry no service metadata); newest overall: %s'
                  % (kind, ', '.join('%s@%s' % (r['name'].rsplit('/', 1)[-1], r.get('createTime', '')) for r in rs[:4]) or 'none'))
            continue
        names = [r['name'] for r in mine]
        prev = mine[names.index(cur) + 1] if cur in names and names.index(cur) + 1 < len(mine) else (None if cur in names else mine[0])
        print('   %s: rollback candidate (ruleset before the live one) = %s' % (kind, ('%s created %s' % (prev['name'].rsplit('/', 1)[-1], prev.get('createTime'))) if prev else 'none listed'))


def c_next_token():
    try:
        t = json.load(sys.stdin).get('nextPageToken', '') or ''
    except ValueError:
        t = ''
    print(quote(t, safe=''))


def c_hosting_live(f):
    rel = load(f).get('releases', []) or []
    if not rel:
        return
    live = rel[0]; lv = (live.get('version') or {}).get('name', '')
    print('LIVE', lv, live.get('releaseTime', ''), live.get('type', ''))
    for r in rel[1:]:
        v = (r.get('version') or {}).get('name', '')
        if v and v != lv:
            print('PREV', v, r.get('releaseTime', ''), r.get('type', '')); break


def c_hosting_merge(out, *pages):
    files = {}
    for p in pages:
        for e in (readj(p) or {}).get('files', []) or []:
            files[e.get('path', '')] = e.get('hash', '')
    with open(out, 'w') as o:
        json.dump(files, o, indent=0, sort_keys=True)
    print('   %d files in the live version -> %s' % (len(files), os.path.basename(out)))


def norm_index(ix):
    cg = ix.get('collectionGroup')
    if not cg:
        m = re.search(r'/collectionGroups/([^/]+)/indexes/', ix.get('name', '')); cg = m.group(1) if m else '?'
    fields = tuple((f.get('fieldPath'), f.get('order') or f.get('arrayConfig') or ('vector' if 'vectorConfig' in f else '?'))
                   for f in ix.get('fields', []) or [] if f.get('fieldPath') != '__name__')
    return (cg, ix.get('queryScope', 'COLLECTION'), fields)


def c_indexes_merge(out, *pages):
    idx, fields = [], []
    for p in pages:
        d = readj(p) or {}
        idx += d.get('indexes', []) or []; fields += d.get('fields', []) or []
    dep = {'indexes': [{'collectionGroup': norm_index(i)[0], 'queryScope': i.get('queryScope'), 'state': i.get('state'),
                        'fields': [f for f in i.get('fields', []) or [] if f.get('fieldPath') != '__name__']} for i in idx],
           'fieldOverrides': [{'name': f.get('name', '').split('/collectionGroups/', 1)[-1], 'indexConfig': f.get('indexConfig'),
                               'ttlConfig': f.get('ttlConfig')} for f in fields]}
    with open(out, 'w') as o:
        json.dump(dep, o, indent=1, sort_keys=True)
    states = collections.Counter(i.get('state') for i in idx)
    print('   deployed composite indexes: %d %s | field overrides: %d' % (len(idx), dict(states), len(fields)))


def _fv(v):
    for k in ('integerValue', 'stringValue', 'booleanValue', 'timestampValue', 'doubleValue'):
        if k in v:
            return v[k]
    if 'mapValue' in v:
        return {k: _fv(x) for k, x in ((v['mapValue'] or {}).get('fields') or {}).items()}
    if 'arrayValue' in v:
        return [_fv(x) for x in (v['arrayValue'] or {}).get('values', []) or []]
    return None


def c_android_doc():
    d = (stdin_json() or {}).get('fields', {}) or {}
    latest = ''
    for ch, v in sorted(d.items()):
        m = _fv(v)
        if not isinstance(m, dict):
            print('%s: %s' % (ch, '<omitted>' if 'url' in ch.lower() else m)); continue
        print('channel %s: versionCode=%s versionName=%s mandatory=%s minSupportedVersionCode=%s publishedAt=%s'
              % (ch, m.get('versionCode'), m.get('versionName'), m.get('mandatory'), m.get('minSupportedVersionCode'), m.get('publishedAt')))
        if (m.get('publishedAt') or '') > latest:
            latest = m.get('publishedAt') or ''
        for abi, a in sorted((m.get('abis') or {}).items()):
            if isinstance(a, dict):
                pt = a.get('patches'); n = len(pt) if isinstance(pt, (dict, list)) else 0
                print('   %s: sha256=%s sizeBytes=%s patches=%d (URLs omitted)' % (abi, a.get('sha256'), a.get('sizeBytes'), n))
    if latest:
        print('LATEST_PUBLISHED', latest)


def _objs(f):
    o = readj(f)
    return o if isinstance(o, list) else ([o] if isinstance(o, dict) else [])


APK_NAME = re.compile(r'appBuilds/([^/]+)/([^/]+)/zipper-(.+)-(\d+)\.apk$')


def c_apk_match(f):
    for o in sorted(_objs(f), key=lambda o: o.get('name', '')):
        n = o.get('name', ''); m = APK_NAME.search(n); md5 = o.get('md5_hash') or o.get('md5Hash')
        verdict = 'no local copy of this build'
        if m:
            local = 'zipper-app/build/published/%s/%s/%s.apk' % (m.group(1), m.group(2), m.group(4))
            if os.path.exists(local) and md5:
                with open(local, 'rb') as fh:
                    lm = base64.b64encode(hashlib.md5(fh.read()).digest()).decode()
                verdict = 'IDENTICAL to %s' % local if lm == md5 else 'DIFFERENT from %s' % local
        print('%-62s %11s  %s  %s' % (n, o.get('size', '?'), o.get('creation_time') or o.get('timeCreated', ''), verdict))


def c_apk_newest(f):
    best = {}
    for o in _objs(f):
        m = APK_NAME.search(o.get('name', ''))
        if not m:
            continue
        key = m.group(1); rank = (m.group(2) == 'arm64-v8a', int(m.group(4)))
        if key not in best or rank > best[key][0]:
            best[key] = (rank, o['name'])
    print(' '.join(v[1] for v in best.values()))


def c_apk_scan(apk):
    z = zipfile.ZipFile(apk)
    dex = b''.join(z.read(n) for n in z.namelist() if re.match(r'^classes\d*\.dex$', n))
    with open(apk, 'rb') as fh:
        print('sha256', hashlib.sha256(fh.read()).hexdigest())
    for m in MARKERS:
        print('marker %-32s %d' % (m.decode(), dex.count(m)))


LIMITS = {'entries': 20000, 'total': 200 * 1024 * 1024, 'entry': 50 * 1024 * 1024}   # refuse anything bigger
SCAN_RULES = (                                   # content checks on EXTRACTED files: rule names only, never values
    ('private-key', re.compile(rb'-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----')),
    ('service-account-json', re.compile(rb'"type"\s*:\s*"service_account"')),
    ('google-api-key', re.compile(rb'AIza[0-9A-Za-z_\-]{35}')),
    ('mongodb-uri-with-password', re.compile(rb'mongodb(?:\+srv)?://[^\s:/@"\'<>]+:[^\s@"\'<>]+@')),
    ('sendgrid-key', re.compile(rb'SG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}')),
    ('aws-access-key', re.compile(rb'AKIA[0-9A-Z]{16}')),
    ('slack-token', re.compile(rb'xox[abposr]-[0-9A-Za-z-]{10,}')),
    ('jwt', re.compile(rb'eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}')),
    ('assigned-secret-literal', re.compile(rb'(?i)(?:secret|password|passwd|api[_-]?key|private[_-]?key|token)\w*\s*[:=]\s*["\'][^"\'\s]{16,}["\']')),
)


def scan_tree(root, out, label):
    hits = []
    for d, _, fs in os.walk(root):
        for f in fs:
            p = os.path.join(d, f)
            for n, line in enumerate((readb(p) or b'').splitlines(), 1):
                for rule, rx in SCAN_RULES:
                    if rx.search(line):
                        hits.append((os.path.relpath(p, root), n, rule))
    with open('%s/SECRET-SCAN.txt' % out, 'a') as fh:
        fh.write('%s: %d possible secrets in extracted files (file:line rule; values are never written)\n' % (label, len(hits)))
        for rel, n, rule in hits:
            fh.write('   %s:%d %s\n' % (rel, n, rule))
    return hits


def c_safe_extract(archive, dest, label, out, url=''):
    data = readb(archive) or b''
    with open('%s/%s-source.ARCHIVE.txt' % (out, label), 'w') as fh:
        fh.write('url %s\nbytes %d\nsha256 %s\n' % (url, len(data), hashlib.sha256(data).hexdigest()))
    names, secret, skipped = [], [], []
    root = None
    def unsafe(n):
        parts = n.replace('\\', '/').split('/')
        return n.startswith(('/', '\\')) or '..' in parts or ':' in parts[0]
    def write(n, data):
        p = os.path.join(dest, n)
        if not os.path.realpath(p).startswith(root + os.sep):          # containment, after any normalisation
            skipped.append(n); return
        os.makedirs(os.path.dirname(p) or dest, exist_ok=True)
        with open(p, 'wb') as fh:
            fh.write(data)
    if zipfile.is_zipfile(archive):
        z = zipfile.ZipFile(archive)
        infos = z.infolist()
        too_big = [i.filename for i in infos if i.file_size > LIMITS['entry']]
        if len(infos) > LIMITS['entries'] or sum(i.file_size for i in infos) > LIMITS['total'] or too_big:
            die('%s: refused - %d entries, %d bytes uncompressed, oversized: %s' % (label, len(infos), sum(i.file_size for i in infos), too_big[:5]))
        os.makedirs(dest)                                # must be new: never extract over anything
        root = os.path.realpath(dest)
        for i in infos:
            n = i.filename; names.append(n)
            if n.endswith('/'):
                continue
            if SECRET.search(n):
                secret.append(n); continue
            if unsafe(n) or ((i.external_attr >> 16) & 0o170000) == 0o120000:
                skipped.append(n); continue
            write(n, z.read(i))
    else:
        t = tarfile.open(archive)
        members = t.getmembers()
        if len(members) > LIMITS['entries'] or sum(m.size for m in members) > LIMITS['total'] or any(m.size > LIMITS['entry'] for m in members):
            die('%s: refused - archive exceeds the size limits' % label)
        os.makedirs(dest)
        root = os.path.realpath(dest)
        for m in members:
            n = m.name; names.append(n)
            if m.isdir():
                continue
            if not m.isfile() or unsafe(n):
                skipped.append(n); continue
            if SECRET.search(n):
                secret.append(n); continue
            write(n, t.extractfile(m).read())
    with open('%s/%s-source.FILES.txt' % (out, label), 'w') as fh:
        fh.write('\n'.join(names) + '\n')
    with open('%s/SECRET-EXPOSURE.txt' % out, 'a') as fh:
        fh.write('%s: %d entries in the uploaded source; secret-looking files NOT extracted: %d\n' % (label, len(names), len(secret)))
        for n in secret:
            fh.write('   %s\n' % n)
    print('   %s: %d entries | secret-looking, not extracted: %d %s | skipped (links/unsafe paths): %d'
          % (label, len(names), len(secret), ('(' + ', '.join(secret[:6]) + ')') if secret else '', len(skipped)))
    hits = scan_tree(dest, out, label)
    print('   %s: archive sha256 %s (%d bytes) | content scan of extracted files: %d possible secret(s)%s'
          % (label, hashlib.sha256(data).hexdigest()[:16], len(data), len(hits),
             ' -> SECRET-SCAN.txt (file:line rule only)' if hits else ''))


GATE_OK = ('isCrmUser', 'crmRole', 'crmPermissions', 'rawRoleClaim', 'ownerMfaOk', 'ownerMfaBindingLive', 'roleClaim')
CALLER = re.compile(r"crmUsers/\$\(request\.auth\.uid\)\)")
CLAIM = re.compile(r"request\.auth\.token\.(get\(\s*['\"]role|role\b)")
OWNER_LIT = re.compile(r"['\"](superadmin|owner)['\"]")


def c_zip_eocd(tail_file):
    """From the last bytes of a zip: 'offset size count' of its central directory (no file data involved)."""
    t = readb(tail_file) or b''
    i = t.rfind(b'PK\x05\x06')
    if i < 0 or len(t) - i < 22:
        die('no end-of-central-directory record in the tail')
    count = int.from_bytes(t[i + 10:i + 12], 'little')
    size = int.from_bytes(t[i + 12:i + 16], 'little')
    off = int.from_bytes(t[i + 16:i + 20], 'little')
    if 0xFFFFFFFF in (size, off):
        die('zip64 archive: index-only listing not supported')
    print(off, size, count)


def c_zip_index(cd_file, label, out):
    """Parse a zip central directory (names, sizes). Writes <label>-source.INDEX.txt; reads no file contents."""
    d = readb(cd_file) or b''
    rows, i = [], 0
    while d[i:i + 4] == b'PK\x01\x02':
        csize = int.from_bytes(d[i + 20:i + 24], 'little'); usize = int.from_bytes(d[i + 24:i + 28], 'little')
        n = int.from_bytes(d[i + 28:i + 30], 'little'); e = int.from_bytes(d[i + 30:i + 32], 'little')
        c = int.from_bytes(d[i + 32:i + 34], 'little')
        name = d[i + 46:i + 46 + n].decode('utf-8', 'replace')
        rows.append((name, usize, csize))
        i += 46 + n + e + c
    secret = [r[0] for r in rows if SECRET.search(r[0])]
    tops = collections.Counter(r[0].split('/', 1)[0] + ('/' if '/' in r[0] else '') for r in rows)
    with open('%s/%s-source.INDEX.txt' % (out, label), 'w') as fh:
        fh.write('\n'.join('%10d  %s' % (u, nm) for nm, u, _ in rows) + '\n')
    with open('%s/SECRET-EXPOSURE.txt' % out, 'a') as fh:
        fh.write('%s (index only): %d entries; secret-looking names: %d\n' % (label, len(rows), len(secret)))
        for nm in secret:
            fh.write('   %s\n' % nm)
    print('   %s: %d entries, %d bytes uncompressed | secret-looking names: %d %s' % (
        label, len(rows), sum(r[1] for r in rows), len(secret), ('(' + ', '.join(secret[:8]) + ')') if secret else ''))
    print('      top level: ' + ', '.join('%s %d' % kv for kv in sorted(tops.items())[:20]))


def owner_gate_audit(txt):
    """Candidates for manual review: places that could grant Owner authority without crmRole() (and so
    without its MFA gate): a caller crmUsers read in the same function or rule as an Owner literal, a role
    claim read, or an Owner literal outside crmRole() lists that is not about the target document.
    Calibrated: 0 hits on HEAD, the pre-P1 tree and the working tree; catches injected bypasses."""
    out, fn, fdepth, depth, body, start, in_list = [], None, 0, 0, [], 0, False
    for i, l in enumerate(txt.splitlines(), 1):
        code = l.split('//', 1)[0]
        m = re.search(r'\bfunction\s+(\w+)\s*\(', code)
        if m and fn is None:
            fn, fdepth, body, start = m.group(1), depth, [], i
        depth += code.count('{') - code.count('}')
        if 'crmRole() in [' in code and ']' not in code.split('crmRole() in [', 1)[1]:
            in_list = True
        lit = (OWNER_LIT.search(code) and not in_list and 'crmRole()' not in code and 'resource.data' not in code
               and fn not in GATE_OK)
        if in_list and ']' in code and 'crmRole() in [' not in code:
            in_list = False
        if fn is None:
            if CALLER.search(code) and OWNER_LIT.search(code):
                out.append('line %d: caller crmUsers read compared with an Owner literal' % i)
            elif lit:
                out.append('line %d: Owner literal outside crmRole()' % i)
            if CLAIM.search(code):
                out.append('line %d: role claim read' % i)
        else:
            body.append(code)
            if CLAIM.search(code) and fn not in GATE_OK:
                out.append('line %d (%s): role claim read' % (i, fn))
        if fn is not None and depth <= fdepth:
            b = '\n'.join(body)
            if fn not in GATE_OK and CALLER.search(b) and OWNER_LIT.search(b):
                out.append('function %s() at line %d: caller crmUsers read compared with an Owner literal' % (fn, start))
            fn = None
    return out


def classify_tree(root, prefix, keep):
    res = collections.Counter(); detail = []; seen = set()
    for d, _, fs in os.walk(root):
        for f in fs:
            full = os.path.join(d, f); rel = os.path.relpath(full, root).replace(os.sep, '/')
            if '__pycache__' in rel or rel.endswith('.pyc') or not keep(rel):
                continue
            seen.add(rel); repo = '%s/%s' % (prefix, rel)
            dep, h, w = readb(full), git_head(repo), readb(repo)
            pre = readb(PRE + PRE_MAP[repo]) if repo in PRE_MAP else None
            if w is not None and dep == w:
                k = 'same as working tree'
            elif h is not None and dep == h:
                k = 'same as HEAD (working tree changed since)'
            elif pre is not None and dep == pre:
                k = 'same as pre-P1 working tree'
            elif h is None and w is None:
                k = 'only in production (not in the repo)'
            else:
                k = 'differs from HEAD and from working tree'
            res[k] += 1; detail.append('%-44s %s' % (k, repo))
    return res, detail, seen


def c_compare(out):
    rep = []
    for kind, path, pre in (('firestore', 'firestore.rules', PRE + 'firestore.rules'),
                            ('storage', 'storage.rules', PRE + 'mfa-stage1/storage.rules')):
        dep = readb('%s/%s.rules.DEPLOYED' % (out, kind))
        if dep is None:
            rep.append('%s: deployed ruleset NOT retrieved' % path); continue
        cand = (('HEAD', git_head(path)), ('pre-P1 tree', readb(pre)), ('working tree', readb(path)))
        same = [k for k, v in cand if v is not None and v.strip() == dep.strip()]
        rep.append('%s: deployed sha256 %s | identical to: %s' % (path, hashlib.sha256(dep).hexdigest()[:16], ', '.join(same) or 'NONE'))
        rep.append('   deployed -> ' + ' | '.join('%s %s' % (k, delta(dep, v)) for k, v in cand))
        if kind == 'firestore':
            f_dep = owner_gate_audit(dep.decode('utf-8', 'replace')); f_wt = owner_gate_audit((readb(path) or b'').decode('utf-8', 'replace'))
            rep.append('   Owner checks that bypass crmRole() (MFA gate), candidates for review: deployed %d | working tree %d'
                       % (len(f_dep), len(f_wt)))
            rep += ['      deployed: ' + x for x in f_dep[:25]]
    dep = readj('%s/firestore.indexes.DEPLOYED.json' % out)
    if dep is None:
        rep.append('firestore.indexes.json: deployed indexes NOT retrieved')
    else:
        D = {norm_index(i) for i in dep.get('indexes', [])}
        for k, src in (('HEAD', git_head('firestore.indexes.json')), ('pre-P1 tree', readb(PRE + 'a3/firestore.indexes.json')),
                       ('working tree', readb('firestore.indexes.json'))):
            if src is None:
                continue
            L = {norm_index(i) for i in json.loads(src).get('indexes', [])}
            rep.append('indexes: deployed %d vs %s %d | only deployed %d | only in %s %d' % (len(D), k, len(L), len(D - L), k, len(L - D)))
            if k == 'working tree' and D - L:
                rep.append('   deployed but NOT in the working-tree file (an index deploy would offer to delete them):')
                rep += ['      %s %s %s' % x for x in sorted(D - L)[:40]]
    for site, cache in (('zipperlive', '.firebase/hosting.emlwcGVyLWNybS9vdXQ.cache'), ('zipper-83816', '.firebase/hosting.aG9zdGluZy9hcHBsaW5rcw.cache')):
        live = readj('%s/hosting-%s-files.json' % (out, site))
        if live is None:
            rep.append('hosting %s: live file list NOT retrieved' % site); continue
        local = {}
        if os.path.exists(cache):
            for l in open(cache):
                parts = l.rstrip('\n').split(',')
                if len(parts) >= 3:
                    local[parts[0]] = parts[-1]
        live2 = {p.lstrip('/'): h for p, h in live.items()}
        same = sum(1 for p, h in local.items() if live2.get(p) == h)
        rep.append('hosting %s: live %d files | last deploy recorded on this machine %d | identical %d | live-only %d | local-only %d'
                   % (site, len(live2), len(local), same, len(set(live2) - set(local)), len(set(local) - set(live2))))
        rep.append('   => live site IS the last deploy made from this machine' if local and same == len(live2) == len(local)
                   else '   => live site is NOT the last deploy recorded on this machine')
    for label, root, prefix, keep in (
            ('backend (Cloud Run source)', '%s/cloudrun-src' % out, 'backend',
             lambda r: r.startswith(('app/', 'scripts/')) or r in ('requirements.txt', 'Dockerfile')),
            ('functions (deployed source)', '%s/functions-src' % out, 'functions',
             lambda r: r.startswith('src/') or r in ('package.json', 'package-lock.json', 'tsconfig.json'))):
        if not os.path.isdir(root):
            rep.append('%s: not downloaded (run with --with-sources)' % label); continue
        res, detail, seen = classify_tree(root, prefix, keep)
        rep.append('%s: %s' % (label, ', '.join('%s %d' % kv for kv in sorted(res.items()))))
        sub = ('app/', 'scripts/') if prefix == 'backend' else ('src/',)
        newer = []
        for s in sub:
            for d, _, fs in os.walk('%s/%s' % (prefix, s)):
                for f in fs:
                    rel = os.path.relpath(os.path.join(d, f), prefix).replace(os.sep, '/')
                    if not rel.endswith('.pyc') and '__pycache__' not in rel and rel not in seen and not SECRET.search(rel):
                        newer.append(rel)
        rep.append('   working-tree files absent from production: %d' % len(newer))
        with open('%s/%s-vs-repo.txt' % (out, prefix), 'w') as fh:
            fh.write('\n'.join(sorted(detail) + ['absent from production: ' + r for r in sorted(newer)]) + '\n')
    print('\n'.join(rep))


COMPONENTS = (('backend', 'backend image', ('backend/app/', 'backend/scripts/', 'backend/requirements.txt', 'backend/Dockerfile')),
              ('functions', 'functions', ('functions/src/', 'functions/package.json', 'functions/package-lock.json', 'functions/tsconfig.json')),
              ('crm-hosting', 'CRM (zipperlive)', ('zipper-crm/',)),
              ('firestore-rules', 'firestore.rules', ('firestore.rules',)),
              ('storage-rules', 'storage.rules', ('storage.rules',)),
              ('android', 'Android APK', ('zipper-app/app/src/main/', 'zipper-app/app/build.gradle.kts')))


def c_partition(out):
    times = collections.defaultdict(list)
    for l in (readb('%s/DEPLOY-TIMES.txt' % out) or b'').decode().splitlines():
        k, _, v = l.partition('\t'); t = ts(v)
        if t:
            times[k].append(t)
    st = subprocess.run(['git', '--no-optional-locks', 'status', '--porcelain=v1', '-uall'], capture_output=True, text=True).stdout.splitlines()
    skip = re.compile(r'^zipper-crm/(out|\.next)/|(^|/)node_modules/|(^|/)__pycache__/|\.pyc$')
    lines = []
    for key, label, prefixes in COMPONENTS:
        files = []
        for l in st:
            code, p = l[:2].strip(), l[3:]
            if ' -> ' in p:
                p = p.split(' -> ', 1)[1]
            p = p.strip('"')
            if p.startswith(prefixes) and not skip.search(p) and not SECRET.search(p):
                files.append((code, p))
        if not times.get(key):
            print('%s: %d files differ from HEAD; deploy time unknown, not partitioned' % (label, len(files))); continue
        t = max(times[key]); before, after, born_after, gone = [], [], [], []
        for code, p in files:
            try:
                s = os.stat(p)
            except OSError:
                gone.append(p); continue
            born = getattr(s, 'st_birthtime', None)
            if code == '??' and born and born > t:
                born_after.append(p)
            elif s.st_mtime > t:
                after.append(p)
            else:
                before.append(p)
        when = datetime.fromtimestamp(t, timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
        print('%s (live since %s): %d differ from HEAD | last modified BEFORE that deploy %d | modified AFTER %d | created after %d | deleted %d'
              % (label, when, len(files), len(before), len(after), len(born_after), len(gone)))
        lines.append('## %s (live since %s)' % (label, when))
        for name, lst in (('before', before), ('after', after), ('created-after', born_after), ('deleted', gone)):
            lines += ['%-14s %s' % (name, p) for p in sorted(lst)]
    with open('%s/PARTITION.txt' % out, 'w') as fh:
        fh.write('\n'.join(lines) + '\n')


def c_iam_members(role, sa):
    pol = stdin_json(); found = False
    for b in pol.get('bindings', []) or []:
        if b.get('role') != role:
            continue
        for m in b.get('members', []) or []:
            kind, _, who = m.partition(':')
            print('   member:', (m if kind == 'serviceAccount' else kind + ':<redacted>') + ('   <- the runtime SA itself' if who == sa else ''))
            found = found or who == sa
        if b.get('condition'):
            print('   (conditional binding: %s)' % (b['condition'] or {}).get('title', ''))
    print('   self-binding present:', 'yes' if found else 'NO')


def c_iam_roles_of(member):
    pol = stdin_json()
    roles = sorted(b.get('role', '') for b in pol.get('bindings', []) or [] if member in (b.get('members') or []))
    print('   %s: %s' % (member, ', '.join(roles) if roles else '(no project-level roles)'))


CMDS = {'redact': c_redact, 'run-summary': c_run_summary, 'run-field': c_run_field, 'rev-field': c_rev_field, 'env-names': c_env_names,
        'fn-summary': c_fn_summary, 'fn-field': c_fn_field, 'build-source': c_build_source, 'rules-list': c_rules_list,
        'rules-release': c_rules_release, 'ruleset-source': c_ruleset_source, 'rules-previous': c_rules_previous,
        'next-token': c_next_token, 'hosting-live': c_hosting_live, 'hosting-merge': c_hosting_merge, 'indexes-merge': c_indexes_merge,
        'android-doc': c_android_doc, 'apk-match': c_apk_match, 'apk-newest': c_apk_newest, 'apk-scan': c_apk_scan,
        'safe-extract': c_safe_extract, 'compare': c_compare, 'partition': c_partition, 'iam-members': c_iam_members,
        'iam-roles-of': c_iam_roles_of, 'wrap-list': c_wrap_list, 'zip-eocd': c_zip_eocd, 'zip-index': c_zip_index}

if __name__ == '__main__':
    CMDS[sys.argv[1]](*sys.argv[2:])
PY
py() { python3 -I "$HELPER" "$@"; }

TOKEN="$(gcloud auth print-access-token 2>>"$ERR")" || TOKEN=""
get() {  # HTTP GET only. The token reaches curl through a file descriptor: never argv, never disk.
  curl -fsS --max-time 90 -H @<(printf 'Authorization: Bearer %s\nx-goog-user-project: %s\n' "$TOKEN" "$P") "$1" 2>>"$ERR"
}
[ -n "$TOKEN" ] || gap "no access token: REST steps (rules, indexes, hosting, androidUpdate) skipped. Sign in with the gcloud CLI first."

PN="$(gcloud projects describe "$P" --format='value(projectNumber)' 2>>"$ERR")" || PN=""
{
  echo "project:          $P (number ${PN:-unknown})"
  echo "collected (UTC):  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "repository HEAD:  $(git rev-parse --short HEAD 2>/dev/null) ($(git log -1 --format=%cI 2>/dev/null))"
  echo "options:          with-sources=$WITH_SOURCES with-apk=$WITH_APK"
} > "$OUT/00-context.txt"
cat "$OUT/00-context.txt"

# ── 1. Cloud Run ──────────────────────────────────────────────────────────────────────────────────
step "1. Cloud Run: $SERVICE ($R)"
SVC="$OUT/cloudrun-service.json"
if gcloud run services describe "$SERVICE" --project "$P" --region "$R" \
     --format='json(metadata.annotations,metadata.generation,status.url,status.latestReadyRevisionName,status.latestCreatedRevisionName,status.traffic,spec.traffic,spec.template.metadata.name,spec.template.metadata.annotations,spec.template.spec.serviceAccountName,spec.template.spec.containers[0].image)' \
     2>>"$ERR" | py redact > "$SVC"; then
  py run-summary "$SVC" | tee "$OUT/cloudrun-summary.txt" | sed 's/^/   /'
else
  : > "$SVC"; gap "Cloud Run service $SERVICE not readable"
fi
gcloud run services describe "$SERVICE" --project "$P" --region "$R" \
  --format='json(spec.template.spec.containers[0].env[].name,spec.template.spec.containers[0].env[].valueFrom.secretKeyRef)' 2>>"$ERR" \
  | py env-names > "$OUT/cloudrun-env-NAMES.txt" && sed 's/^/   /' "$OUT/cloudrun-env-NAMES.txt" || gap "Cloud Run env-var names not readable"
gcloud run revisions list --service "$SERVICE" --project "$P" --region "$R" --limit 30 \
  --format='table(metadata.name:label=REVISION,metadata.creationTimestamp:label=CREATED,status.conditions[0].status:label=READY,status.imageDigest.basename():label=IMAGE)' \
  > "$OUT/cloudrun-revisions.txt" 2>>"$ERR" && head -6 "$OUT/cloudrun-revisions.txt" | sed 's/^/   /' || gap "Cloud Run revisions not listed"
SERVING=""; RUNTIME_SA=""; DIGEST=""
if [ -s "$SVC" ]; then SERVING="$(py run-field "$SVC" serving)"; RUNTIME_SA="$(py run-field "$SVC" sa)"; fi
[ -z "$RUNTIME_SA" ] && [ -n "$PN" ] && RUNTIME_SA="${PN}-compute@developer.gserviceaccount.com"
for REV in $SERVING; do
  RJ="$OUT/cloudrun-revision-$REV.json"
  if gcloud run revisions describe "$REV" --project "$P" --region "$R" \
       --format='json(metadata.name,metadata.creationTimestamp,metadata.annotations,status.imageDigest,spec.serviceAccountName,spec.containers[0].image)' \
       2>>"$ERR" | py redact > "$RJ"; then
    C="$(py rev-field "$RJ" created)"; D="$(py rev-field "$RJ" digest)"; [ -z "$DIGEST" ] && DIGEST="$D"
    echo "   serving revision $REV created $C image $D"
    printf 'backend\t%s\n' "$C" >> "$TIMES"
  else gap "revision $REV not readable"; fi
done
[ -n "$SERVING" ] || gap "serving revision unknown: backend deploy time and source provenance unknown"
gcloud builds list --project "$P" --region "$R" --limit 15 \
  --format='table(id,createTime,status,source.storageSource.bucket,source.storageSource.object,results.images[0].digest)' \
  > "$OUT/cloudbuild-$R.txt" 2>>"$ERR" || gap "Cloud Build history ($R) not listed"
gcloud builds list --project "$P" --limit 15 \
  --format='table(id,createTime,status,source.storageSource.bucket,source.storageSource.object,results.images[0].digest)' \
  > "$OUT/cloudbuild-global.txt" 2>>"$ERR" || gap "Cloud Build history (global) not listed"
gcloud artifacts repositories describe cloud-run-source-deploy --project "$P" --location "$R" \
  --format='yaml(name,format,cleanupPolicies,cleanupPolicyDryRun,sizeBytes,updateTime)' > "$OUT/artifact-registry-repo.yaml" 2>>"$ERR" \
  || gap "Artifact Registry repo cloud-run-source-deploy not described: image retention (rollback) unknown"
gcloud artifacts docker images list "$R-docker.pkg.dev/$P/cloud-run-source-deploy/$SERVICE" --include-tags --limit 30 --sort-by=~createTime \
  --format='table(version.basename():label=DIGEST,tags,createTime,updateTime)' > "$OUT/artifact-registry-images.txt" 2>>"$ERR" \
  || gap "container images of $SERVICE not listed: rollback image retention unknown"

# ── 2. Functions ──────────────────────────────────────────────────────────────────────────────────
step "2. Cloud Functions"
gcloud functions list --project "$P" \
  --format='table(name.basename():label=NAME,environment:label=GEN,state,status,updateTime:label=UPDATED,buildConfig.runtime,runtime)' \
  > "$OUT/functions-list.txt" 2>>"$ERR" && echo "   $(($(wc -l < "$OUT/functions-list.txt") - 1)) functions -> functions-list.txt" || gap "functions not listed"
FMT='json(name,environment,state,status,updateTime,versionId,runtime,entryPoint,sourceArchiveUrl,buildId,environmentVariables,buildConfig.runtime,buildConfig.entryPoint,buildConfig.source,buildConfig.sourceProvenance,buildConfig.build,serviceConfig.service,serviceConfig.revision,serviceConfig.serviceAccountEmail,serviceConfig.environmentVariables,serviceConfig.secretEnvironmentVariables,serviceAccountEmail,labels)'
for FN in $FUNCS; do
  FJ="$OUT/function-$FN.json"
  if gcloud functions describe "$FN" --project "$P" --region "$R" --format="$FMT" 2>>"$ERR" | py redact > "$FJ" \
     || gcloud functions describe "$FN" --project "$P" --region "$R" --gen2 --format="$FMT" 2>>"$ERR" | py redact > "$FJ"; then
    py fn-summary "$FJ"
    [ "$FN" = backfillPublicProfiles ] && printf 'functions\t%s\n' "$(py fn-field "$FJ" updated)" >> "$TIMES"
  else
    rm -f "$OUT/function-$FN.json"; gap "function $FN not found or not readable (not deployed?)"
  fi
done
gcloud storage buckets list --project "$P" --format='value(name)' 2>>"$ERR" \
  | { grep -E "^(gcf-sources-|gcf-v2-sources-|run-sources-|${P}_cloudbuild$)" || true; } > "$OUT/source-buckets.txt"
while read -r B; do
  [ -n "$B" ] || continue
  gcloud storage ls -l "gs://$B/**" 2>>"$ERR" | { grep -v '^TOTAL' || true; } | sort -k2,2 | tail -n 40 > "$OUT/bucket-$B.txt"
  echo "   gs://$B: newest $(wc -l < "$OUT/bucket-$B.txt") objects -> bucket-$B.txt"
done < "$OUT/source-buckets.txt"

# ── 3. Security rules ─────────────────────────────────────────────────────────────────────────────
step "3. Security rules: Firestore and Storage"
if [ -n "$TOKEN" ]; then
  RB="https://firebaserules.googleapis.com/v1/projects/$P"
  if get "$RB/releases?pageSize=100" > "$OUT/rules-releases.json"; then
    py rules-list "$OUT/rules-releases.json"
    for PAIR in "firestore=cloud.firestore" "storage=firebase.storage/$BUCKET"; do
      KIND="${PAIR%%=*}"; RID="${PAIR#*=}"
      LINE="$(py rules-release "$OUT/rules-releases.json" "$RID")"; RS="${LINE%% *}"; RT="${LINE#* }"
      if [ -z "$RS" ]; then gap "$KIND rules: no release $RID (never deployed: production runs the console default)"; continue; fi
      printf '%s-rules\t%s\n' "$KIND" "$RT" >> "$TIMES"; echo "$RS" > "$OUT/$KIND.ruleset-name.txt"
      if get "https://firebaserules.googleapis.com/v1/$RS" > "$OUT/.ruleset-$KIND.json"; then
        py ruleset-source "$OUT/.ruleset-$KIND.json" "$OUT/$KIND.rules.DEPLOYED"
      else gap "$KIND ruleset $RS not readable"; fi
      rm -f "$OUT/.ruleset-$KIND.json"
    done
  else gap "rules releases not readable"; fi
  get "$RB/rulesets?pageSize=100" > "$OUT/rules-rulesets-history.json" && py rules-previous "$OUT/rules-rulesets-history.json" "$OUT" \
    || gap "rulesets history not readable: rules rollback candidates unknown"
fi

# ── 4. Firestore indexes ──────────────────────────────────────────────────────────────────────────
step "4. Firestore indexes"
# gcloud list commands (read-only). The REST form returned HTTP 400 on the first production run.
PAGES=""
if gcloud firestore indexes composite list --project "$P" --format=json 2>>"$ERR" | py wrap-list indexes > "$OUT/.ix-1.json"; then
  PAGES="$OUT/.ix-1.json"
else gap "Firestore composite indexes not readable"; fi
if gcloud firestore indexes fields list --project "$P" --format=json 2>>"$ERR" | py wrap-list fields > "$OUT/.ix-2.json"; then
  PAGES="$PAGES $OUT/.ix-2.json"
else gap "Firestore field overrides not readable"; fi
if [ -n "$PAGES" ]; then py indexes-merge "$OUT/firestore.indexes.DEPLOYED.json" $PAGES; fi
rm -f "$OUT/".ix-*.json

# ── 5. Hosting ────────────────────────────────────────────────────────────────────────────────────
step "5. Hosting"
if [ -n "$TOKEN" ]; then
  HB="https://firebasehosting.googleapis.com/v1beta1"
  for S in $SITES; do
    if ! get "$HB/sites/$S/releases?pageSize=25" | py redact > "$OUT/hosting-$S-releases.json"; then gap "hosting $S: releases not readable"; continue; fi
    py hosting-live "$OUT/hosting-$S-releases.json" > "$OUT/hosting-$S-live.txt"; sed "s/^/   $S /" "$OUT/hosting-$S-live.txt"
    V="$(awk '$1=="LIVE"{print $2}' "$OUT/hosting-$S-live.txt")"
    [ -n "$V" ] || { gap "hosting $S: no live release"; continue; }
    [ "$S" = zipperlive ] && printf 'crm-hosting\t%s\n' "$(awk '$1=="LIVE"{print $3}' "$OUT/hosting-$S-live.txt")" >> "$TIMES"
    get "$HB/$V" | py redact > "$OUT/hosting-$S-live-version.json" || gap "hosting $S: live version config not readable"
    i=0; TOKP=""; PAGES=""
    while :; do
      i=$((i + 1)); PF="$OUT/.hf-$S-$i.json"
      get "$HB/$V/files?pageSize=1000${TOKP:+&pageToken=$TOKP}" > "$PF" || { gap "hosting $S: file list not readable"; break; }
      PAGES="$PAGES $PF"; TOKP="$(py next-token < "$PF")"; [ -n "$TOKP" ] || break
    done
    if [ -n "$PAGES" ]; then py hosting-merge "$OUT/hosting-$S-files.json" $PAGES; fi
    rm -f "$OUT/".hf-*.json
  done
fi

# ── 6. IAM, APIs and secrets used by the Owner MFA design ──────────────────────────────────────────
step "6. IAM, APIs and secret names"
{
  echo "runtime service account of $SERVICE: ${RUNTIME_SA:-unknown}"
  if [ -n "$RUNTIME_SA" ]; then
    echo "- roles/iam.serviceAccountTokenCreator ON the runtime SA (custom-token minting signs through signBlob as itself):"
    gcloud iam service-accounts get-iam-policy "$RUNTIME_SA" --project "$P" --format=json 2>>"$ERR" \
      | py iam-members roles/iam.serviceAccountTokenCreator "$RUNTIME_SA" || echo "   (service-account policy not readable)"
  fi
  POLICY="$(gcloud projects get-iam-policy "$P" --format=json 2>>"$ERR")" || POLICY=""
  if [ -n "$POLICY" ]; then
    echo "- project-level roles of the runtime SA (a project-level Token Creator grant would also cover signBlob):"
    printf '%s' "$POLICY" | py iam-roles-of "serviceAccount:$RUNTIME_SA"
    echo "- Storage service agent (Storage rules that read Firestore need roles/firebaserules.firestoreServiceAgent):"
    printf '%s' "$POLICY" | py iam-roles-of "serviceAccount:service-$PN@gcp-sa-firebasestorage.iam.gserviceaccount.com"
  else echo "- project IAM policy not readable"; fi
  POLICY=""
  echo "- APIs:"
  ENABLED="$(gcloud services list --enabled --project "$P" --format='value(config.name)' 2>>"$ERR")" || ENABLED=""
  for API in iamcredentials.googleapis.com firebaserules.googleapis.com firestore.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com cloudfunctions.googleapis.com secretmanager.googleapis.com firebasehosting.googleapis.com firebasestorage.googleapis.com; do
    if printf '%s\n' "$ENABLED" | grep -qx "$API"; then S_="enabled"; else S_="NOT enabled (or not readable)"; fi
    printf '   %-36s %s\n' "$API" "$S_"
  done
  echo "- Secret Manager secret names (values are never read):"
  gcloud secrets list --project "$P" --format='value(name.basename())' 2>>"$ERR" | sed 's/^/   /'
  if gcloud secrets list --project "$P" --filter='name~OWNER_MFA' --format='value(name.basename())' 2>>"$ERR" | grep -q .; then
    echo "- OWNER_MFA secret: present"
  else echo "- OWNER_MFA secret: ABSENT (OWNER_MFA_ENCRYPTION_KEY must exist before an MFA backend serves Owners)"; fi
} > "$OUT/iam-apis-secrets.txt" 2>&1
sed 's/^/   /' "$OUT/iam-apis-secrets.txt"

# ── 7. Android distribution ───────────────────────────────────────────────────────────────────────
step "7. Android distribution (in-app updater)"
if [ -n "$TOKEN" ]; then
  if get "https://firestore.googleapis.com/v1/projects/$P/databases/(default)/documents/appConfig/androidUpdate" \
       | py android-doc > "$OUT/android-update-VERSIONS.txt"; then
    sed 's/^/   /' "$OUT/android-update-VERSIONS.txt"
    T="$(awk '$1=="LATEST_PUBLISHED"{print $2}' "$OUT/android-update-VERSIONS.txt")"; [ -n "$T" ] && printf 'android\t%s\n' "$T" >> "$TIMES"
  else gap "appConfig/androidUpdate not readable"; fi
fi
if gcloud storage objects list "gs://$BUCKET/appBuilds/**" \
     --format='json(name,size,md5_hash,md5Hash,creation_time,timeCreated)' 2>>"$ERR" | py redact > "$OUT/android-appBuilds.json"; then
  py apk-match "$OUT/android-appBuilds.json" | tee "$OUT/android-appBuilds-vs-local.txt" | sed 's/^/   /'
else gap "appBuilds objects not listed"; fi
if [ "$WITH_APK" = 1 ] && [ -s "$OUT/android-appBuilds.json" ]; then
  for OBJ in $(py apk-newest "$OUT/android-appBuilds.json"); do
    echo "   $OBJ"
    if gcloud storage cat "gs://$BUCKET/$OBJ" > "$OUT/.apk" 2>>"$ERR"; then py apk-scan "$OUT/.apk" | sed 's/^/      /' | tee -a "$OUT/android-apk-markers.txt"
    else gap "APK $OBJ not downloadable"; fi
    rm -f "$OUT/.apk"
  done
fi

# ── 8. Optional: the source archives production was built from ────────────────────────────────────
fetch_source() {  # $1 gs:// URL (may carry #generation), $2 label. Index-only, or download + safe extract.
  local URL="$1" LABEL="$2" EOCD
  if [ "$LIST_ONLY" = 1 ]; then
    # Two byte-range reads: the last 1 KiB (end-of-central-directory record), then exactly the
    # central directory. Neither range contains file data, so no file content is ever read.
    gcloud storage cat -r -1024 "$URL" > "$OUT/.tail" 2>>"$ERR" \
      || { gap "$LABEL archive tail not readable at the recorded generation"; rm -f "$OUT/.tail"; return; }
    EOCD="$(py zip-eocd "$OUT/.tail")" || { gap "$LABEL archive is not a plain zip (index-only listing impossible)"; rm -f "$OUT/.tail"; return; }
    set -- $EOCD
    gcloud storage cat -r "$1-$(($1 + $2 - 1))" "$URL" > "$OUT/.cd" 2>>"$ERR" \
      || { gap "$LABEL archive index not readable at the recorded generation"; rm -f "$OUT/.tail" "$OUT/.cd"; return; }
    py zip-index "$OUT/.cd" "$LABEL" "$OUT"
    rm -f "$OUT/.tail" "$OUT/.cd"
    return
  fi
  # Exactly the recorded generation: no fallback to whatever object carries that name now.
  if gcloud storage cat "$URL" > "$OUT/.$LABEL-source.archive" 2>>"$ERR"; then
    py safe-extract "$OUT/.$LABEL-source.archive" "$OUT/$LABEL-src" "$LABEL" "$OUT" "$URL" \
      || gap "$LABEL source archive refused by the extraction limits"
  else gap "$LABEL source archive not downloadable at the recorded generation"; fi
  rm -f "$OUT/.$LABEL-source.archive"
}

if [ "$WITH_SOURCES" = 1 ]; then
  if [ "$LIST_ONLY" = 1 ]; then step "8. Deployed source archives: index only (names and sizes; no file contents)"
  else step "8. Deployed source archives (secret-looking files are never extracted)"; fi
  SRC=""; BID=""
  for REV in $SERVING; do
    SRC="$(py rev-field "$OUT/cloudrun-revision-$REV.json" build_source)"; BID="$(py rev-field "$OUT/cloudrun-revision-$REV.json" build_id)"; break
  done
  if [ -z "$SRC" ] && [ -z "$BID" ] && [ -n "$DIGEST" ]; then
    BID="$(gcloud builds list --project "$P" --region "$R" --filter="results.images.digest:\"$DIGEST\"" --format='value(id)' --limit 1 2>>"$ERR")"
    [ -z "$BID" ] && BID="$(gcloud builds list --project "$P" --filter="results.images.digest:\"$DIGEST\"" --format='value(id)' --limit 1 2>>"$ERR")"
  fi
  if [ -z "$SRC" ] && [ -n "$BID" ]; then
    SRC="$(gcloud builds describe "$BID" --project "$P" --region "$R" --format='json(source.storageSource,sourceProvenance.resolvedStorageSource)' 2>>"$ERR" | py build-source)"
    [ -z "$SRC" ] && SRC="$(gcloud builds describe "$BID" --project "$P" --format='json(source.storageSource,sourceProvenance.resolvedStorageSource)' 2>>"$ERR" | py build-source)"
  fi
  case " $SRC_WHICH " in *" backend "*)
    if [ -n "$SRC" ]; then
      echo "   Cloud Run source: $SRC"
      fetch_source "$SRC" cloudrun
    else gap "no source archive found for the serving Cloud Run revision: the production backend source cannot be recovered"; fi ;;
  esac
  FJ="$OUT/function-backfillPublicProfiles.json"; FSRC=""
  case " $SRC_WHICH " in *" functions "*) ;; *) FJ="" ;; esac
  if [ -n "$FJ" ] && [ -s "$FJ" ]; then
    FSRC="$(py fn-field "$FJ" source)"
    if [ -z "$FSRC" ]; then
      # 1st-gen functions read through the v1 API expose no archive path. The archive of the live version is
      # gs://gcf-sources-<project number>-<region>/<name>-<uuid>/version-<versionId>/function-source.zip
      VID="$(py fn-field "$FJ" version)"
      [ -n "$VID" ] && [ -n "$PN" ] && FSRC="$(gcloud storage ls "gs://gcf-sources-$PN-$R/backfillPublicProfiles-*/version-$VID/function-source.zip" 2>>"$ERR" | head -n 1)"
    fi
    if [ -z "$FSRC" ]; then
      FB="$(py fn-field "$FJ" build)"
      [ -n "$FB" ] && FSRC="$(gcloud builds describe "$FB" --project "$P" --region "$R" --format='json(source.storageSource,sourceProvenance.resolvedStorageSource)' 2>>"$ERR" | py build-source)"
    fi
  fi
  if [ -n "$FSRC" ]; then
    echo "   Functions source: $FSRC"
    fetch_source "$FSRC" functions
  elif [ -n "$FJ" ]; then gap "Functions source location not exposed: the production Functions source cannot be recovered from metadata"; fi
fi

# ── 9. Compare with the repository (read-only) ────────────────────────────────────────────────────
step "9. Comparison with HEAD, the pre-P1 tree and the working tree"
py compare "$OUT" | tee "$OUT/COMPARISON.txt" | sed 's/^/   /'
step "10. Which working-tree changes can be in production (by deploy time; details in PARTITION.txt)"
py partition "$OUT" | tee "$OUT/PARTITION-SUMMARY.txt" | sed 's/^/   /'

rm -f "$OUT/.helper.py"
echo
echo "Baseline written to: $OUT"
if [ -s "$GAPS" ]; then echo "Could not retrieve or verify:"; sed 's/^/  - /' "$GAPS"; else echo "Every step returned data."; fi
echo "Safe to share: COMPARISON.txt, PARTITION-SUMMARY.txt, UNAVAILABLE.txt, *-summary.txt, *-NAMES.txt, iam-apis-secrets.txt."
echo "Check before sharing: stderr.log, PARTITION.txt (file paths), extracted *-src folders."
