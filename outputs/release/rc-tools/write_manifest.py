#!/usr/bin/env python3
"""Write MANIFEST.json for the release candidate. Run with `python3 -I`. Reads local evidence only."""
import datetime as dt
import hashlib
import json
import os
import subprocess
import sys

MNT = '/sessions/upbeat-zen-lovelace/mnt'
RC_ID = 'mfa-backend-rc1-20261025T131629Z'
RC = MNT + '/zipper-release/' + RC_ID
REPO = MNT + '/zippern'
A = json.load(open('/tmp/p2/rc/assembly.json'))
SCAN = sys.argv[1] if len(sys.argv) > 1 else None


def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 16), b''):
            h.update(b)
    return h.hexdigest()


def tree(root, skip=()):
    """sha256 of `find . -type f ! -name .DS_Store | LC_ALL=C sort | xargs shasum -a 256` (same bytes on the Mac)."""
    rows = []
    for d, _, fs in os.walk(root):
        for f in fs:
            if f == '.DS_Store' or f in skip:
                continue
            p = os.path.join(d, f)
            rows.append(('./' + os.path.relpath(p, root), sha(p)))
    rows.sort(key=lambda r: r[0].encode())
    listing = ''.join('%s  %s\n' % (h, n) for n, h in rows)
    return hashlib.sha256(listing.encode()).hexdigest(), len(rows)


def results(path):
    d = json.load(open(path))
    r = d.get('results', d)
    fails = sorted(m for m, v in r.items() if v['rc'] != 0)
    return {'modules': len(r), 'passed': len(r) - len(fails), 'failed': fails,
            'fixture_source': d.get('fixture_source'), 'fixtures': d.get('fixtures'), 'withheld': d.get('withheld')}


def summaries(path):
    r = json.load(open(path))
    return {m: {'exit': v['rc'], 'summary': v.get('summary', '')} for m, v in sorted(r.items())}


bt, bn = tree(RC + '/baseline/backend')
ct, cn = tree(RC + '/candidate/backend')
ut, un = tree(RC + '/candidate/backend', skip=('.gcloudignore',))
pt, pn = tree(RC + '/patches')
arch = dict(l.split(' ', 1) for l in open(MNT + '/zipper-baseline/20261025T090632Z/cloudrun-source.ARCHIVE.txt').read().split('\n') if ' ' in l)

tools = {}
for rel in ('outputs/release/verify-rc-baseline.command', 'outputs/release/run-rc-tests-mac.command',
            'outputs/release/scan-crm-local-history.command', 'outputs/release/rc-tools/assemble_rc.py',
            'outputs/release/rc-tools/run_backend_tests.py', 'outputs/release/rc-tools/make_fixtures.py',
            'outputs/release/rc-tools/scan_rc.py', 'outputs/release/rc-tools/write_manifest.py'):
    p = os.path.join(REPO, rel)
    tools[rel] = sha(p) if os.path.exists(p) else None

scan = json.load(open(SCAN)) if SCAN else None

m = {
    'id': RC_ID,
    'assembled_utc': '2026-10-25T13:16:29Z',
    'manifest_written_utc': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'status': 'LOCAL CANDIDATE ONLY. Not deployed. No production setting, secret, IAM role, API or database was changed. '
              'The repository was not modified (596 status entries outside outputs/, identical to the 25 Oct snapshot).',
    'scope': {
        'stage_1_deploys': 'candidate/backend/ to Cloud Run zipper-api (zipper-83816, asia-south1), --no-traffic, '
                           'OWNER_MFA_REQUIRED=false merged into the existing environment (BUILD.md)',
        'not_in_stage_1': ['candidate/firestore.rules (ships with the MFA CRM, stage 3)', 'Storage rules', 'Functions',
                           'CRM', 'Android', 'indexes', 'migrations', 'OWNER_MFA_ENCRYPTION_KEY (stage 2, created by you)'],
    },
    'provenance': {
        'backend': {
            'source_object': arch.get('url'),
            'archive_bytes': int(arch.get('bytes', '0')),
            'archive_sha256': arch.get('sha256'),
            'recorded_in': '~/zipper-baseline/20261025T090632Z/cloudrun-source.ARCHIVE.txt',
            'serving_revision': 'zipper-api-00046-siw (created 2026-10-20T08:26:21Z)',
            'image': 'asia-south1-docker.pkg.dev/zipper-83816/cloud-run-source-deploy/zipper-api@sha256:1f8a92a50c58446740b4a8a3af6459aa022a030deffa5b64882123f8cacfdb66',
            'build_id': 'cf9a5236-8396-4216-b0b3-11875eba2f19',
            'index_check': A['baseline_index'],
            'per_file_reverification': 'PENDING: outputs/release/verify-rc-baseline.command (re-reads the exact generation, '
                                       'checks the archive sha256, compares every entry by sha256). Not yet run: the Mac screen was locked.',
        },
        'firestore_rules': {
            'release': 'projects/zipper-83816/releases/cloud.firestore',
            'ruleset': 'projects/zipper-83816/rulesets/b2104a12-6598-4985-a91d-4d861e18a66e',
            'ruleset_created_utc': '2026-10-20T08:54:32Z',
            'sha256': A['baseline_rules_sha256'],
            'recorded_in': '~/zipper-baseline/20261025T090632Z/firestore.rules.DEPLOYED',
        },
        'patches': 'outputs/release/proposed-mfa-patches/ (reviewed; generator build_mfa_patches.py ran against the exact '
                   'production bases above)',
    },
    'baseline': {
        'backend_tree_sha256': bt, 'backend_files': bn,
        'files': A['baseline_files'],
        'firestore_rules_sha256': A['baseline_rules_sha256'],
    },
    'patches': A['patches'],
    'patch_application': 'GNU patch 2.7.6: --batch --forward --fuzz=0 --no-backup-if-mismatch --reject-file=- -p1, dry run first; '
                         'any offset, fuzz, reversal or reject stops the assembly',
    'candidate': {
        'backend_tree_sha256': ct, 'backend_files': cn,
        'changed_from_production': {f: sha(os.path.join(RC, 'candidate/backend', f)) for f in A['candidate_delta']},
        'added_by_release_candidate': {'.gcloudignore': sha(RC + '/candidate/backend/.gcloudignore')},
        'removed_from_production': [],
        'firestore_rules_sha256': A['candidate_rules_sha256'],
    },
    'artifacts': {
        'candidate_backend_upload_tree_sha256': ut,
        'candidate_backend_upload_files': un,
        'candidate_backend_tree_sha256': ct,
        'candidate_firestore_rules_sha256': A['candidate_rules_sha256'],
        'baseline_backend_tree_sha256': bt,
        'patches_tree_sha256': pt, 'patch_files': pn,
        'tree_hash_method': "cd <dir> && find . -type f ! -name .DS_Store [! -name .gcloudignore] -print0 | LC_ALL=C sort -z | "
                            "xargs -0 shasum -a 256 | shasum -a 256",
        'container_image_digest': 'not built: Cloud Build produces it at deploy time (base image and transitive '
                                  'dependencies are resolved then; BUILD.md 3.4)',
        'every_file': 'SHA256SUMS',
    },
    'tests': {
        'backend': {
            'environment': 'Linux sandbox, Python 3.10.12 (production: 3.12); each module in its own process on scratch copies',
            'worktree_fixtures': {'baseline': results('/tmp/p2/rct/base-worktree.json'),
                                  'candidate': results('/tmp/p2/rct/cand-worktree.json')},
            'head_fixtures': {'baseline': results('/tmp/p2/rct/base-head.json'),
                              'candidate': results('/tmp/p2/rct/cand-head.json')},
            'no_fixtures': {'candidate': results('/tmp/p2/rct/plain.json')},
            'known_environment_dependent_failures_NOT_passed': {
                'test_commission': 'needs backend/backups/firestore-2026-08-20-1548/appConfig.json (production data backup; withheld, not opened)',
                'test_local_isolation': 'needs backend/.env.example (never extracted; backend/.env* never opened)'},
            'per_module_candidate': summaries('/tmp/p2/rct/cand-final.json'),
            'per_module_baseline': summaries('/tmp/p2/rct/base-final.json'),
            'differential': 'identical exit status and summary for every shared module, except test_service_credential '
                            '516 -> 524 checks (all pass; one per-route check for each of the 8 new MFA routes)',
            'mutation_checks': {'deactivate_hook_removed': '12 of 20 checks fail',
                                'failure_hidden_from_fully_revoked': '1 of 20 checks fails'},
            'known_flake': "test_moderation 'the session cut-off moves past now' (whole-second race; 1/41 baseline, "
                           '1/40 candidate runs; test and code unchanged by this release)',
        },
        'backend_python_3_12': 'NOT RUN (Part B of outputs/release/run-rc-tests-mac.command)',
        'firestore_emulator': 'NOT RUN (EMULATOR-TESTS.md; Part A of outputs/release/run-rc-tests-mac.command)',
    },
    'secret_scan': ({k: scan[k] for k in ('files_scanned', 'secret_like_names', 'archive_reviewed_keys')} |
                    {'findings': len(scan['findings']), 'new_findings': len(scan['new_findings']),
                     'result': 'see SECRET-SCAN.txt'}) if scan else 'see SECRET-SCAN.txt',
    'review': {
        'deactivate': 'Owner-only (Observer-only action, never the last active Owner); clears every binding right after the '
                      'API sessions are revoked and before the Firebase disable; a Firestore failure is reported '
                      '(owner_mfa_bindings NOT CLEARED, fully_revoked false) and a retry clears; tested 20/20 with mutations.',
        'finding_A_low_not_fixed': 'clear_all_bindings() does not catch a failure of its own audit write; deactivate() then '
                                   'raises after revoking sessions and deleting bindings but before is_active=false and the '
                                   'Firebase disable. Loud (error to the Observer), retry completes. Fix needs approval.',
        'change_role': 'hook unreachable in this release (production change_role refuses Owner/Observer targets and '
                       'non-department roles); ignores the clear result; must report failure before Owner role changes '
                       'become possible.',
        'capability_profile': 'absent from baseline, patches and candidate (auth.py = production + 213 MFA lines; roles.py = production)',
        'finding_B_before_stage_2': 'owner_mfa has no unique index on uid; start_enrolment upserts on {uid}, so two simultaneous '
                                    'starts could create two rows. Impossible in stage 1 (refused before any write). Creating '
                                    'the index is a production database change and needs approval.',
        'independent_audit': 'A separate read-only audit re-applied all 19 patches (no offset/fuzz/reject; result = candidate), '
                             'matched baseline/backend to the extracted production source (214/214), checked SHA256SUMS, the '
                             'MANIFEST hashes, BUILD.md flags, imports and syntax (Python 3.10). Scope check: the strings '
                             "'_change_status', 'def suspend(', 'def reactivate(' occur only in tests/test_p2_owner_deactivate_mfa.py, "
                             'as literals in the check that staff.py does NOT define them. BUILD.md was tightened after it '
                             '(pre-deploy upload tree-hash gate, prompt-default wording, fuller pre-flight).',
    },
    'exclusions': {
        'deferred': ['Functions source and all Functions changes (functions/src/profiles.ts, storageClaims.ts, ownerMfa.ts; '
                     'functions/test/ownerMfa.test.js). Their two bases are proven exact by the 20 Oct release manifest '
                     '(no archive download needed).',
                     'CRM deployment (login/page.tsx, lib/api.ts, lib/auth.ts, team/page.tsx). The 20 Oct CRM baseline for the '
                     '21 files changed on 22 Oct is recovered and verified separately in '
                     '~/zipper-baseline/crm-20oct-baseline-20261025T140342Z (not part of this candidate); the 4 CRM patch bases '
                     'equal the deployed files.',
                     'Storage rules (needs roles/firebaserules.firestoreServiceAgent on the Storage service agent)'],
        'excluded': ['Android', 'Firestore indexes', 'migrations (scripts/remove_gate_answers.py)',
                     'all production configuration changes', 'OWNER_MFA_ENCRYPTION_KEY (not created)',
                     'P1-B staff lifecycle (except the narrow deactivate() hook)', 'P1-D tickets', 'P1-E directory privacy',
                     'P1-A1', 'the 23 Oct capability_profile change', 'backend/.env.example (never extracted)'],
        'excluded_patches': A['excluded_patches'],
    },
    'rollback_targets': {
        'cloud_run': {'service': 'zipper-api', 'revision': 'zipper-api-00046-siw', 'traffic': '100% via latest revision; tag rc-1-2-5',
                      'image_digest': 'sha256:1f8a92a50c58446740b4a8a3af6459aa022a030deffa5b64882123f8cacfdb66'},
        'firestore_rules': {'current': 'b2104a12-6598-4985-a91d-4d861e18a66e', 'previous': 'bf1a3973-9e84-4d43-b2bd-fdd407495c87'},
        'storage_rules': {'current': '27a73af8-d1d3-4740-a7a9-0b452f024c5b', 'previous': '5fd43571-8b97-4700-8bbe-42c6a26051cf'},
        'hosting_zipperlive': {'current': 'ba740f4158292308', 'previous': '8199a327ce27b898'},
        'hosting_zipper-83816': {'current': '058ea60d1028e53f'},
        'functions': '104 functions last deployed 2026-10-20 (finished 08:53:10Z); backfillPublicProfiles version 22',
        'indexes': '58 composite + 4 field-override entries',
        'android': 'debug channel 19 (1.2.5), minSupportedVersionCode 19',
        'details': 'ROLLBACK.md',
    },
    'tooling_sha256': tools,
}
json.dump(m, open(RC + '/MANIFEST.json', 'w'), indent=1, sort_keys=False)
print('MANIFEST.json written:', os.path.getsize(RC + '/MANIFEST.json'), 'bytes')
print('trees: baseline', bt[:16], bn, '| candidate', ct[:16], cn, '| upload', ut[:16], un, '| patches', pt[:16], pn)
