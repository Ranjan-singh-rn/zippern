#!/usr/bin/env bash
#
# Copy the release signing key, its passwords and its fingerprints into
# ~/Downloads, ready to move onto an external disk.
#
#   cd ~/Documents/Projects/zippern/zipper-app && ./backup-signing-key.sh
#
# ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
#
# zipper-release.jks is the app's identity for its entire life. Google Play
# accepts an update only if it is signed by the same key as the version before
# it. Lose the file, or lose the password, and you cannot ship an update to
# your own app — not with a support ticket, not with proof of ownership. The
# only route back is publishing a brand new listing under a new package name,
# starting from zero installs and zero reviews.
#
# The file alone is not enough. It is encrypted, so a backup without the
# passwords is a backup of nothing. That is why this script writes them beside
# it instead of leaving you to remember.
#
# ── WHICH MAKES THE OUTPUT SENSITIVE ─────────────────────────────────────────
#
# The folder this produces contains the key AND its passwords together, so
# anyone who gets it can sign an app that Android will accept as an update to
# Zipper. Treat it like a passport, not like a document backup: an external
# disk you keep, not a shared drive, not email, not WhatsApp-to-self.
#
# Verify, don't assume: a truncated copy looks like a file and fails only years
# later, at the worst moment. This script compares checksums and re-reads the
# copy with keytool using the real password, so a backup that reports success
# has been proven to open.

set -euo pipefail

cd "$(dirname "$0")"

DEST="${HOME}/Downloads/zipper-signing-backup-$(date +%Y%m%d)"
PROPS="local.properties"

# ── Read the credentials from local.properties ───────────────────────────────
# Never hardcoded here: this script is in git, local.properties is not.
prop() { grep -E "^$1=" "$PROPS" 2>/dev/null | head -1 | cut -d= -f2- | xargs || true; }

[ -f "$PROPS" ] || { echo "✗ no $PROPS — nothing to read credentials from"; exit 1; }

STORE=$(prop release.storeFile)
STOREPASS=$(prop release.storePassword)
ALIAS=$(prop release.keyAlias)
KEYPASS=$(prop release.keyPassword)

[ -n "$STORE" ] || { echo "✗ release.storeFile is not set in $PROPS"; exit 1; }
[ -f "$STORE" ] || { echo "✗ keystore not found at: $STORE"; exit 1; }
[ -n "$STOREPASS" ] || { echo "✗ release.storePassword is not set in $PROPS"; exit 1; }

echo "Backing up $STORE"
mkdir -p "$DEST"

# ── Copy, then prove the copy is byte-identical ──────────────────────────────
cp "$STORE" "$DEST/"
SRC_SUM=$(shasum -a 256 "$STORE" | cut -d' ' -f1)
DST_SUM=$(shasum -a 256 "$DEST/$(basename "$STORE")" | cut -d' ' -f1)
if [ "$SRC_SUM" != "$DST_SUM" ]; then
  echo "✗ the copy does not match the original — do not trust this backup"
  exit 1
fi

# ── Prove the copy actually opens with the password we are storing ───────────
# This is the check that matters. It catches a wrong password in
# local.properties, which would otherwise sit undetected until the first time
# you needed it.
if ! keytool -list -keystore "$DEST/$(basename "$STORE")" \
       -storepass "$STOREPASS" -alias "$ALIAS" >/dev/null 2>&1; then
  echo "✗ the backed-up keystore does not open with the password in $PROPS."
  echo "  Either the password is wrong or the alias is not '$ALIAS'."
  echo "  Fix $PROPS and run this again — a backup you cannot open is not a backup."
  rm -rf "$DEST"
  exit 1
fi

FULL=$(keytool -list -v -keystore "$STORE" -storepass "$STOREPASS" -alias "$ALIAS" 2>/dev/null)
SHA1=$(printf '%s\n' "$FULL"  | grep -m1 'SHA1:'    | sed 's/.*SHA1: *//')
SHA256=$(printf '%s\n' "$FULL"| grep -m1 'SHA256:'  | sed 's/.*SHA256: *//')
UNTIL=$(printf '%s\n' "$FULL" | grep -m1 'until:'   | sed 's/.*until: *//')

cat > "$DEST/READ-ME-FIRST.txt" <<TXT
ZIPPER — ANDROID RELEASE SIGNING KEY
Backed up $(date '+%d %B %Y at %H:%M')

================================================================
THIS FOLDER CAN PUBLISH UPDATES TO THE ZIPPER APP.
Keep it on a disk you control. Not email, not a shared drive.
================================================================

WHAT IT IS
  Every Android app is signed with a private key. Google Play accepts a new
  version only if it is signed with the same key as the last one. This is that
  key. It cannot be reissued, recovered or appealed. Without it, updating
  Zipper means publishing a new app under a new name and losing every install,
  rating and review.

FILE
  $(basename "$STORE")
  SHA-256 of the file: $SRC_SUM
  (Run: shasum -a 256 $(basename "$STORE") — if it differs, the copy is damaged.)

CREDENTIALS
  Store password : $STOREPASS
  Key alias      : $ALIAS
  Key password   : $KEYPASS

  The file is encrypted. Without these it is useless — which is exactly why
  they are written here and not left to memory.

CERTIFICATE
  Valid until : $UNTIL
  SHA-1       : $SHA1
  SHA-256     : $SHA256

  These two fingerprints are registered in Firebase project zipper-83816 and
  are what Phone OTP and Google Sign-In are verified against on a release
  build. They are public information — safe to paste into a console or a
  support ticket. The password above is not.

TO RESTORE
  1. Copy $(basename "$STORE") to zipper-app/
  2. In zipper-app/local.properties (create it if missing):
       release.storeFile=$(basename "$STORE")
       release.storePassword=$STOREPASS
       release.keyAlias=$ALIAS
       release.keyPassword=$KEYPASS
  3. ./gradlew signingReport
     The 'Variant: release' block must show SHA-1 $SHA1
     If it says "no release keystore configured", the storeFile path is wrong.

IF THE PASSWORD IS EVER EXPOSED
  Before the app is on Play, you can simply delete the keystore and generate a
  new one — nothing depends on it yet. After the first release you cannot, so
  the safe moment to fix a weak password is now.
TXT

chmod 600 "$DEST/READ-ME-FIRST.txt" "$DEST/$(basename "$STORE")"

echo
echo "✓ copied and verified — the backup opens with the stored password"
echo
ls -la "$DEST"
echo
echo "Folder: $DEST"
echo "Move it to your external disk, then delete it from Downloads —"
echo "Downloads is the folder most likely to end up in a cloud sync."
