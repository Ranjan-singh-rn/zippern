#!/bin/bash
# ZIPPER Track B release — (re)write SCRIPTS.sha256 after REVIEW of the files it lists. LOCAL ONLY.
# Every production script refuses to run unless each listed file matches this list. Run it only after a reviewed
# change (e.g. names moved between WAVE_2A_CHANGED / WAVE_2A_NEW / WAVE_2B in rel_common.sh), then commit, then regenerate
# RELEASE.txt with ./make-release-txt.sh. Not listed (never run against production): this file, the local test
# harness (tools/test_release_scripts.py, tools/test-release-scripts-mac.command) and the rules emulator runner
# (tools/run-trackb-rules-tests.command).
set -u
umask 077
HERE="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$HERE" || exit 2
LIST="rel_common.sh rel_deploy_lib.sh rel_helpers.py rel_rules_lib.sh make-release-txt.sh tools/android_update_doc.py tools/live_rules.py tools/apk_cert.py $(ls [0-9][0-9]-*.command | LC_ALL=C sort | tr '\n' ' ')"
for f in $LIST; do [ -f "$f" ] || { echo "missing: $f" >&2; exit 2; }; done
if command -v shasum >/dev/null 2>&1; then shasum -a 256 $LIST > SCRIPTS.sha256.new; else sha256sum $LIST > SCRIPTS.sha256.new; fi || exit 2
[ -f SCRIPTS.sha256 ] && { diff SCRIPTS.sha256 SCRIPTS.sha256.new > /dev/null && echo "unchanged" || diff SCRIPTS.sha256 SCRIPTS.sha256.new | sed 's/^/   /'; }
mv SCRIPTS.sha256.new SCRIPTS.sha256 && chmod 600 SCRIPTS.sha256
echo "SCRIPTS.sha256: $(grep -c . SCRIPTS.sha256) files   sha256 $( (shasum -a 256 SCRIPTS.sha256 2>/dev/null || sha256sum SCRIPTS.sha256) | cut -c1-16)…"
