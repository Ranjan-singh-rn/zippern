#!/usr/bin/env bash
# Start the Firebase emulators the API needs locally — Auth, Firestore, Storage —
# under a demo- project, and nothing else.
#
#   backend/scripts/start_local_emulators.sh            # project demo-zipper
#   backend/scripts/start_local_emulators.sh demo-other # any other demo- id
#
# Why a script: .firebaserc's default project is PRODUCTION, so a bare
# `firebase emulators:start` runs the emulators under the real project id, and
# anything not emulated (Functions reaching Storage, say) would be sent to the
# real project. A demo- project exists only in the emulators: with it, nothing
# that misses an emulator can reach a real resource.
#
# Never deploys, never logs in, never downloads: if an emulator binary is
# missing it says which `firebase setup:emulators:*` command to run and stops.
# The Functions emulator is deliberately NOT started: it would load
# functions/.env, which holds production credentials.
set -euo pipefail

PROJECT="${1:-demo-zipper}"
case "$PROJECT" in
  demo-*) ;;
  *) echo "Refusing: '$PROJECT' is not a demo- project. Local emulators run only under demo- ids." >&2
     exit 2 ;;
esac

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"
[ -f firebase.json ] || { echo "firebase.json not found in $REPO" >&2; exit 2; }

command -v firebase >/dev/null 2>&1 || {
  echo "The Firebase CLI is not installed. It is needed for the emulators; installing it is your decision." >&2
  exit 3; }
command -v java >/dev/null 2>&1 || {
  echo "Java is not installed. The Firestore and Storage emulators need a JDK (21 or newer for current CLIs)." >&2
  exit 3; }

EMU_DIR="${FIREBASE_EMULATORS_PATH:-$HOME/.cache/firebase/emulators}"
missing=""
ls "$EMU_DIR"/cloud-firestore-emulator-*.jar >/dev/null 2>&1 || missing="$missing firestore"
ls "$EMU_DIR"/cloud-storage-rules-runtime-*.jar >/dev/null 2>&1 || missing="$missing storage"
if [ -n "$missing" ]; then
  echo "Emulator binaries missing in $EMU_DIR:$missing" >&2
  for m in $missing; do echo "  run deliberately, once:  firebase setup:emulators:$m" >&2; done
  exit 3
fi

echo "Starting Auth (9099), Firestore (8080) and Storage (9199) emulators for project $PROJECT."
echo "The API reads backend/.env.local; see backend/LOCAL_DEVELOPMENT.md."
# No credentials of any kind reach the emulator processes.
exec env -u GOOGLE_APPLICATION_CREDENTIALS -u GOOGLE_CLOUD_PROJECT -u GCLOUD_PROJECT NO_UPDATE_NOTIFIER=1 \
  firebase emulators:start --only auth,firestore,storage --project "$PROJECT"
