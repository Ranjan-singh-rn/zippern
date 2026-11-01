#!/bin/bash
# ZIPPER reset launcher (macOS, bash 3.2) — spec §14.
#
#   backup → verify → plan → (Owner reads the manifest) → rehearse → execute → seed → postcheck
#
# Every step is a separate typed confirmation. Every step refuses to continue
# when the previous step's artifact is missing. Every target is TYPED here and
# passed explicitly; this launcher never reads the backend's environment file
# and never falls back to a default project, bucket or database. A demo-
# project id is refused for execute. Read RESET-RUNBOOK.md first.

set -u
set -o pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$(cd "$HERE/../.." && pwd)"
cd "$BACKEND" || exit 2
PY="$BACKEND/.venv/bin/python"

stop() { printf '\nSTOPPED: %s\n' "$1"; exit "${2:-1}"; }

[ -x "$PY" ] || stop "no project virtualenv python at $PY (python3.12 with firebase-admin, google-cloud-storage, pymongo)" 2
for tool in gcloud gsutil mongodump; do
  command -v "$tool" >/dev/null 2>&1 || stop "missing on PATH: $tool" 2
done
command -v mongorestore >/dev/null 2>&1 || echo "note: mongorestore not on PATH — verify will list the archive instead of a --dryRun"

printf '\n== ZIPPER RESET — every value below is typed; nothing is defaulted ==\n\n'
read -r -p "Firebase project id: " PROJECT
[ -n "$PROJECT" ] || stop "a project id is required"
case "$PROJECT" in demo-*) stop "demo-* ids are refused: there is nothing to reset in an emulator-only project" 2;; esac
read -r -p "Storage bucket (bare name, e.g. <project>.firebasestorage.app): " BUCKET
read -r -p "Backup bucket (bare name; may equal the Storage bucket): " BACKUP_BUCKET
read -r -p "MongoDB database name: " MONGO_DB
read -r -p "NAME of the exported environment variable holding the MongoDB connection string: " MONGO_URI_ENV
read -r -p "Path to the service-account key for $PROJECT: " CREDENTIALS
[ -n "$BUCKET" ] && [ -n "$BACKUP_BUCKET" ] && [ -n "$MONGO_DB" ] && [ -n "$MONGO_URI_ENV" ] || stop "every value is required"
[ -f "$CREDENTIALS" ] || stop "no file at $CREDENTIALS"
case "$MONGO_URI_ENV" in *[!A-Z0-9_]*) stop "'$MONGO_URI_ENV' is not an environment variable NAME (A-Z, 0-9, _)";; esac
URI_VALUE="${!MONGO_URI_ENV:-}"
[ -n "$URI_VALUE" ] || stop "environment variable $MONGO_URI_ENV is not exported in this shell (export it; it is never printed)"
unset URI_VALUE
KEY_PROJECT="$("$PY" -c 'import json,sys; print(str(json.load(open(sys.argv[1])).get("project_id","")).strip())' "$CREDENTIALS" 2>/dev/null)"
[ "$KEY_PROJECT" = "$PROJECT" ] || stop "the key at $CREDENTIALS belongs to project '$KEY_PROJECT', not '$PROJECT'" 2

SEED_FILE="$HERE/seed-accounts.json"
[ -f "$SEED_FILE" ] || stop "no $SEED_FILE — copy seed-accounts.example.json and fill in the Owner's exact list BEFORE resetting" 2
"$PY" -m scripts.reset.seed --project "$PROJECT" --bucket "$BUCKET" --mongo-db "$MONGO_DB" \
  --mongo-uri-env "$MONGO_URI_ENV" --credentials "$CREDENTIALS" --seed-file "$SEED_FILE" \
  --out-dir /tmp --validate-only || stop "seed-accounts.json is not valid; fix it before resetting" 2

RUN_DIR="$BACKEND/reset-runs/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$RUN_DIR" || stop "cannot create $RUN_DIR" 2
COMMON=(--project "$PROJECT" --bucket "$BUCKET" --mongo-db "$MONGO_DB" --mongo-uri-env "$MONGO_URI_ENV" --credentials "$CREDENTIALS")
printf '\nrun folder: %s\ntarget: project=%s bucket=%s mongo_db=%s\n' "$RUN_DIR" "$PROJECT" "$BUCKET" "$MONGO_DB"

confirm_step() {
  # confirm_step <name> <description>
  printf '\n──────────────────────────────────────────────────────────────\nSTEP %s — %s\n' "$1" "$2"
  read -r -p "Type exactly  $1  to run this step (anything else stops): " ANSWER
  [ "$ANSWER" = "$1" ] || stop "step $1 not confirmed"
}

newest() { ls -t "$RUN_DIR"/$1 2>/dev/null | head -n 1; }

# ── 1. backup ────────────────────────────────────────────────────────────────
confirm_step backup "Firestore managed export, mongodump, Storage inventory + copy (writes only to the backup bucket and $RUN_DIR)"
"$PY" -m scripts.reset.backup run "${COMMON[@]}" --backup-bucket "$BACKUP_BUCKET" --out-dir "$RUN_DIR" --execute || stop "backup failed"
BACKUP_MANIFEST="$RUN_DIR/backup-manifest.json"
[ -f "$BACKUP_MANIFEST" ] || stop "backup produced no manifest"

# ── 2. verify ────────────────────────────────────────────────────────────────
confirm_step verify "re-read the backup manifest; check every artifact exists and is readable"
"$PY" -m scripts.reset.backup verify --manifest "$BACKUP_MANIFEST" || stop "the backup did not verify — do not continue"

# ── 3. plan ──────────────────────────────────────────────────────────────────
confirm_step plan "read every collection, classify by the table, freeze the manifest (read-only)"
"$PY" -m scripts.reset.plan "${COMMON[@]}" --backup-manifest "$BACKUP_MANIFEST" --out-dir "$RUN_DIR" || stop "plan refused"
MANIFEST="$(newest 'reset-manifest-*.json')"
[ -n "$MANIFEST" ] && [ -f "$MANIFEST" ] || stop "plan produced no manifest"
MANIFEST_SHA="$(shasum -a 256 "$MANIFEST" | cut -c1-64)"
printf '\nFROZEN MANIFEST: %s\nsha256: %s\n' "$MANIFEST" "$MANIFEST_SHA"
printf 'Open it. Check the target, the per-collection counts and the samples. The execute step deletes these ids and nothing else.\n'
read -r -p "Type  REVIEWED  once the Owner has read the manifest: " ANSWER
[ "$ANSWER" = "REVIEWED" ] || stop "manifest not reviewed"

# ── 4. rehearse ──────────────────────────────────────────────────────────────
confirm_step rehearse "every live check and every per-id classification, deleting nothing"
"$PY" -m scripts.reset.execute "${COMMON[@]}" --manifest "$MANIFEST" --out-dir "$RUN_DIR" --rehearse || stop "rehearsal refused or failed"

# ── 5. execute ───────────────────────────────────────────────────────────────
confirm_step execute "DELETE exactly the manifest's ids (you will type the project id and the sha256 prefix again)"
"$PY" -m scripts.reset.execute "${COMMON[@]}" --manifest "$MANIFEST" --out-dir "$RUN_DIR"
EXEC_RC=$?
LOG="$(newest 'reset-log-*.jsonl')"
[ -n "$LOG" ] && [ -f "$LOG" ] || stop "execute produced no log (refused before starting)" "$EXEC_RC"
if [ "$EXEC_RC" -ne 0 ]; then
  printf '\nexecute finished with failures (log: %s). Re-run the same execute command to complete them, then continue with seed.\n' "$LOG"
  read -r -p "Type  CONTINUE  to go on to seed anyway, anything else to stop: " ANSWER
  [ "$ANSWER" = "CONTINUE" ] || stop "stopped after execute" "$EXEC_RC"
fi

# ── 6. seed ──────────────────────────────────────────────────────────────────
confirm_step seed "create the Observer and the Owners from seed-accounts.json (you will type the project id again)"
read -r -p "Password mode for the Owners [none | random | reset-link] (none = they use 'Forgot password'): " PW_MODE
case "$PW_MODE" in none|random|reset-link) ;; *) stop "unknown password mode '$PW_MODE'";; esac
"$PY" -m scripts.reset.seed "${COMMON[@]}" --seed-file "$SEED_FILE" --out-dir "$RUN_DIR" --execute --password "$PW_MODE"
SEED_RC=$?
SEED_RESULT="$(newest 'seed-result-*.json')"
[ -n "$SEED_RESULT" ] && [ -f "$SEED_RESULT" ] || stop "seed produced no result file" "$SEED_RC"
[ "$SEED_RC" -eq 0 ] || printf '\nseed exit %s: appConfig/economy needs attention (see above) before reopening.\n' "$SEED_RC"

# ── 7. postcheck ─────────────────────────────────────────────────────────────
confirm_step postcheck "count everything after the reset and compare with the manifest (read-only)"
"$PY" -m scripts.reset.postcheck "${COMMON[@]}" --manifest "$MANIFEST" --seed-result "$SEED_RESULT" --out-dir "$RUN_DIR"
PC_RC=$?
printf '\nArtifacts: %s\n' "$RUN_DIR"
printf 'Before reopening: verify login (CRM Owner + MFA enrolment, Observer OTP, app phone OTP), roles, CRM screens, the app and notifications.\n'
exit "$PC_RC"
