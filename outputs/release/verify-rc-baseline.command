#!/bin/bash
# ZIPPER — READ-ONLY re-verification of the release candidate's production backend baseline.
#
# Reads ONE production object: the exact generation of the Cloud Run source archive that
# baseline/backend/ was extracted from. Checks the archive's sha256 against the recorded value,
# then compares every archive entry with the matching baseline/backend/ file by sha256.
#   * nothing from the archive is written to disk except the archive itself, in a private temp
#     folder that is deleted when this script ends (also on Ctrl-C);
#   * nothing is executed from it, no file content is printed;
#   * secret-looking names (.env*) are never read (and are not in the release candidate);
#   * production is not changed: one object read, prompts disabled.
# Result: printed here and saved to <release>/verification/baseline-reverify-<UTC>.txt
set -u
cd "$(dirname "$0")/../.." || { echo "Cannot reach the repository root."; exit 1; }
for d in /opt/homebrew/bin /usr/local/bin "$HOME/google-cloud-sdk/bin" \
         /opt/homebrew/share/google-cloud-sdk/bin /usr/local/share/google-cloud-sdk/bin \
         /opt/homebrew/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin; do
  [ -x "$d/gcloud" ] && PATH="$d:$PATH"
done
export PATH
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

RC="$HOME/zipper-release/mfa-backend-rc1-20261025T131629Z"
URL='gs://run-sources-zipper-83816-asia-south1/services/zipper-api/1792484712.297548-88268622699a4d8d9c62b9f948e5cf1e.zip#1792484713419277'
EXPECT='362270600a2dbd67474ce34f9bd1a5ee80f1099add8a3f9b1fcde8dcdb208796'
[ -d "$RC/baseline/backend" ] || { echo "Release candidate not found: $RC"; exit 1; }

TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$RC/verification" && chmod 700 "$RC/verification"
REPORT="$RC/verification/baseline-reverify-$TS.txt"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/zipper-reverify.XXXXXX")" || exit 1
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT
trap 'rm -rf "$TMP"; exit 130' INT TERM HUP

{
  echo "ZIPPER release candidate: baseline re-verification   $TS"
  echo "release candidate: $RC"
  echo "gcloud: $(command -v gcloud || echo 'NOT FOUND')"
  echo "object: $URL"
  if ! gcloud storage cat "$URL" > "$TMP/archive.zip" 2> "$TMP/err.txt"; then
    echo "RESULT: NOT VERIFIED - the archive could not be read at the recorded generation."
    sed -E 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/<email>/g' "$TMP/err.txt" | head -5
    exit 1
  fi
  GOT="$(shasum -a 256 "$TMP/archive.zip" | cut -d' ' -f1)"
  echo "archive bytes : $(wc -c < "$TMP/archive.zip" | tr -d ' ')"
  echo "archive sha256: $GOT"
  echo "recorded      : $EXPECT"
  if [ "$GOT" != "$EXPECT" ]; then
    echo "RESULT: NOT VERIFIED - the archive's sha256 differs from the recorded value."
    exit 1
  fi
  python3 -I - "$TMP/archive.zip" "$RC/baseline/backend" <<'PY'
import hashlib, os, sys, zipfile
arc, base = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(arc)
infos = [i for i in z.infolist() if not i.filename.endswith('/')]
if sum(i.file_size for i in infos) > 200 * 1024 * 1024 or len(infos) > 20000:
    print('RESULT: NOT VERIFIED - archive exceeds the extraction limits; nothing was read.'); sys.exit(1)
same, diff, missing, skipped, unsafe, names = 0, [], [], [], [], set()
for i in infos:
    n = i.filename
    parts = n.split('/')
    if n.startswith('/') or '..' in parts:
        unsafe.append(n); continue
    if os.path.basename(n).startswith('.env'):
        skipped.append(n); continue                      # never read
    names.add(n)
    h = hashlib.sha256()
    with z.open(i) as f:                                 # zipfile also checks each entry's CRC-32
        for b in iter(lambda: f.read(1 << 16), b''):
            h.update(b)
    p = os.path.join(base, n)
    if os.path.islink(p) or not os.path.isfile(p):
        missing.append(n); continue
    with open(p, 'rb') as fh:
        if hashlib.sha256(fh.read()).hexdigest() == h.hexdigest():
            same += 1
        else:
            diff.append(n)
extra = []
for d, _, fs in os.walk(base):
    for f in fs:
        rel = os.path.relpath(os.path.join(d, f), base)
        if rel not in names:
            extra.append(rel)
print('archive file entries      :', len(infos))
print('identical (sha256)        :', same)
print('different                 :', len(diff), diff[:20])
print('missing from baseline     :', len(missing), missing[:20])
print('not read (secret-like)    :', len(skipped), skipped)
print('unsafe names (not read)   :', len(unsafe), unsafe[:20])
print('in baseline, not in archive:', len(extra), extra[:20])
ok = not diff and not missing and not unsafe and not extra and same == len(infos) - len(skipped)
print('RESULT:', 'VERIFIED - every baseline file is byte-identical to the production archive entry'
      if ok else 'NOT VERIFIED - see the lines above')
sys.exit(0 if ok else 1)
PY
} 2>&1 | tee "$REPORT"
echo
echo "Saved: $REPORT"
echo "== finished $(date)"
