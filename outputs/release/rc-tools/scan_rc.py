#!/usr/bin/env python3
"""Secret scan of the assembled release candidate. Run with `python3 -I`.

Usage: scan_rc.py <rc-dir> <archive-scan.txt> <out.json>
Never prints or stores a matched value: a finding is file:line + rule, plus
non-reversible facts about the match (length, character classes, whether it
carries an obvious placeholder word) so it can be classified without seeing it.
Findings identical (file, line, rule) to the reviewed scan of the production
archive are marked as such; everything else is reported as NEW.
"""
import json
import os
import re
import sys

RULES = (  # the archive scan's rules, unchanged ...
    ('private-key', re.compile(rb'-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----')),
    ('service-account-json', re.compile(rb'"type"\s*:\s*"service_account"')),
    ('google-api-key', re.compile(rb'AIza[0-9A-Za-z_\-]{35}')),
    ('mongodb-uri-with-password', re.compile(rb'mongodb(?:\+srv)?://[^\s:/@"\'<>]+:[^\s@"\'<>]+@')),
    ('sendgrid-key', re.compile(rb'SG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}')),
    ('aws-access-key', re.compile(rb'AKIA[0-9A-Z]{16}')),
    ('slack-token', re.compile(rb'xox[abposr]-[0-9A-Za-z-]{10,}')),
    ('jwt', re.compile(rb'eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}')),
    ('assigned-secret-literal', re.compile(rb'(?i)(?:secret|password|passwd|api[_-]?key|private[_-]?key|token)\w*\s*[:=]\s*["\'][^"\'\s]{16,}["\']')),
    # ... plus rules for what this release adds (Fernet keys, TOTP secrets) and common live keys
    ('fernet-key-literal', re.compile(rb'["\'][A-Za-z0-9_\-]{43}=["\']')),
    ('otpauth-uri-with-secret', re.compile(rb'otpauth://totp/[^"\'\s]*[?&]secret=[A-Z2-7]{16,}')),
    ('base32-secret-literal', re.compile(rb'(?i)(?:totp|otp|mfa)\w*secret\w*\s*[:=]\s*["\'][A-Z2-7]{16,}=*["\']')),
    ('google-oauth-token', re.compile(rb'ya29\.[0-9A-Za-z_\-]{20,}')),
    ('github-token', re.compile(rb'gh[pousr]_[A-Za-z0-9]{36}')),
    ('live-payment-key', re.compile(rb'(?:sk|rk)_live_[0-9A-Za-z]{20,}|rzp_live_[0-9A-Za-z]{14}')),
)
NAME_RULES = re.compile(r'(^|/)(\.env[^/]*|[^/]*\.(pem|p12|pfx|jks|keystore|key)|serviceAccountKey[^/]*\.json|'
                        r'google-services\.json|local\.properties|id_(rsa|ed25519|ecdsa)[^/]*|\.npmrc|\.netrc|'
                        r'credentials(\.json)?)$')
PLACEHOLDER = re.compile(rb'(?i)test|fake|example|dummy|canary|placeholder|sample|not[-_ ]?a|xxxx|changeme|local|demo|'
                         rb'stub|mock|0000|1234|abcd')


def facts(m):
    v = m.group(0)
    return {'len': len(v), 'placeholder_word': bool(PLACEHOLDER.search(v)),
            'classes': ''.join(c for c, rx in (('a', rb'[a-z]'), ('A', rb'[A-Z]'), ('9', rb'[0-9]'), ('_', rb'[^A-Za-z0-9]'))
                               if re.search(rx, v))}


def main():
    rc, archive_scan, out = sys.argv[1:4]
    known = set()
    for ln in open(archive_scan, encoding='utf-8'):
        m = re.match(r'\s+(\S+):(\d+) (\S+)\s*$', ln)
        if m:
            known.add((m.group(1), int(m.group(2)), m.group(3)))
    hits, names, files = [], [], 0
    for d, dirs, fs in os.walk(rc):
        dirs.sort()
        for f in sorted(fs):
            p = os.path.join(d, f)
            rel = os.path.relpath(p, rc)
            files += 1
            if NAME_RULES.search(rel):
                names.append(rel)
            data = open(p, 'rb').read()
            for n, line in enumerate(data.splitlines(), 1):
                for rule, rx in RULES:
                    for m in rx.finditer(line):
                        # the same file inside baseline/backend or candidate/backend maps to the archive path
                        arch = None
                        for pre in ('baseline/backend/', 'candidate/backend/'):
                            if rel.startswith(pre):
                                arch = rel[len(pre):]
                        hits.append({'file': rel, 'line': n, 'rule': rule,
                                     'archive_reviewed': bool(arch and (arch, n, rule) in known), **facts(m)})
    new = [h for h in hits if not h['archive_reviewed']]
    json.dump({'files_scanned': files, 'secret_like_names': names, 'findings': hits, 'new_findings': new,
               'archive_reviewed_keys': len(known)}, open(out, 'w'), indent=1)
    print('files scanned: %d | secret-like file names: %d %s' % (files, len(names), names))
    print('findings: %d | identical to the reviewed archive scan: %d | NEW: %d'
          % (len(hits), len(hits) - len(new), len(new)))
    for h in new:
        print('  NEW %s:%d %s len=%d placeholder_word=%s classes=%s'
              % (h['file'], h['line'], h['rule'], h['len'], h['placeholder_word'], h['classes']))


if __name__ == '__main__':
    main()
