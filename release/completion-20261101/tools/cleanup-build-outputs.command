#!/bin/bash
# ZIPPER — free disk space by removing ONLY regenerable build outputs inside the project. Local only; touches no
# production system, no source, no git history, no node_modules, no .venv, no APKs, no published builds, no release
# evidence, no keys or .env files.
#
#   bash ~/Documents/Projects/zippern/release/completion-20261101/tools/cleanup-build-outputs.command
#
# Always removed after you type CLEAN (each is rebuilt by the next build; the next Android build takes longer):
#   zipper-app/app/build/intermediates   Gradle intermediates (dex, merged resources, R8 inputs)
#   zipper-app/app/build/tmp             Gradle temporary files
#   zipper-crm/.next                     Next.js build cache (npm run build recreates it; out/ is kept)
# Removed only if you ALSO type PREVIEW:
#   ~/zipper-release/mfa-crm-preview-20261029T203711Z/zipper-crm/.next
#                                        Next.js build cache of the 29 Oct preview attempt (never deployed). The
#                                        folder's firebase.json, .firebaserc and deploy log stay.
# Kept, always: app/build/outputs (current APKs), zipper-app/build/published (APKs 13/14/19: patch base + rollback
# reference), every node_modules, backend/.venv, .git, release/ and hotfix/ evidence, ~/zipper-release evidence.
# Outside the project nothing is deleted; the sizes of the big shared caches are printed with the commands that
# would clear them, for you to decide.
set -u
umask 077
HERE="$(cd "$(dirname "$0")/.." && pwd -P)"
REPO="$(cd "$HERE/../.." && pwd -P)"
REL="$HOME/zipper-release"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOGD="$HERE/production"; mkdir -p "$LOGD"; LOG="$LOGD/cleanup-$TS.txt"
say() { echo "$*" | tee -a "$LOG"; }
size_kb() { [ -e "$1" ] && du -sk "$1" 2>/dev/null | awk '{print $1}' || echo 0; }
human() { awk -v k="$1" 'BEGIN{ if (k>=1048576) printf "%.2f GB", k/1048576; else if (k>=1024) printf "%.0f MB", k/1024; else printf "%d KB", k }'; }
free_kb() { df -k "$REPO" | awk 'NR==2{print $4}'; }

say "ZIPPER build-output cleanup   $TS"
say "repo: $REPO"
[ -d "$REPO/.git" ] && [ -f "$REPO/zipper-app/app/build.gradle.kts" ] || { say "REFUSED: $REPO is not the ZIPPER repository"; exit 2; }

# Never under a running build, daemon, dev server, emulator run or LOCAL-VERIFY.
BUSY="$(ps -axo pid=,command= 2>/dev/null \
  | grep -E 'org\.gradle\.launcher\.daemon|org\.gradle\.wrapper\.GradleWrapperMain|KotlinCompileDaemon|next (build|dev|start)|LOCAL-VERIFY-mac\.command|emulators:(start|exec)' \
  | grep -v -E "^ *($$|$PPID) " | grep -v 'grep -E' || true)"
if [ -n "$BUSY" ]; then
  say "REFUSED: a build, daemon, dev server or emulator run is active — nothing was removed:"
  printf '%s\n' "$BUSY" | cut -c1-140 | sed 's/^/   /' | tee -a "$LOG"
  say "If it is only the idle Gradle/Kotlin daemon left by the last build: cd \"$REPO/zipper-app\" && ./gradlew --stop"
  say "then wait 10 seconds and run this again. Otherwise let the build or run finish first."
  exit 3
fi

TARGETS="$REPO/zipper-app/app/build/intermediates
$REPO/zipper-app/app/build/tmp
$REPO/zipper-crm/.next"
PREVIEW="$REL/mfa-crm-preview-20261029T203711Z/zipper-crm/.next"

before="$(free_kb)"
say ""; say "Free space before: $(human "$before")"
say ""; say "Will remove (after CLEAN):"
total=0
while IFS= read -r t; do
  [ -n "$t" ] || continue
  if [ -L "$t" ]; then say "   SKIP (symbolic link, not followed): $t"; continue; fi
  k="$(size_kb "$t")"; total=$((total + k))
  say "   $(human "$k")   $t"
done <<EOF
$TARGETS
EOF
pk="$(size_kb "$PREVIEW")"
say ""; say "Optional (after PREVIEW): $(human "$pk")   $PREVIEW"
say ""; say "Recoverable now: $(human "$total") (+ $(human "$pk") with PREVIEW)"

say ""; say "Shared caches OUTSIDE the project (read-only sizes; nothing here is deleted by this script):"
for c in "$HOME/.gradle/caches" "$HOME/.gradle/wrapper/dists" "$HOME/.npm/_cacache" "$HOME/Library/Caches/Google" \
         "$HOME/Library/Caches/pip" "$HOME/.android/avd" "$HOME/Library/Developer/Xcode/DerivedData"; do
  [ -e "$c" ] && say "   $(human "$(size_kb "$c")")   $c"
done
say "   To clear them yourself (all regenerable; the next build re-downloads what it needs):"
say "     rm -rf ~/.gradle/caches/build-cache-* ~/.gradle/caches/transforms-*      # Gradle build/transform caches"
say "     npm cache clean --force                                                 # npm download cache"
say "     (~/.android/avd holds emulator images — delete only an emulator you no longer use, from Android Studio)"

printf '\nType CLEAN to remove the listed build outputs (anything else: nothing is removed): '
read -r a
if [ "$a" != CLEAN ]; then say "Not confirmed. Nothing was removed."; exit 4; fi
while IFS= read -r t; do
  [ -n "$t" ] && [ -d "$t" ] && [ ! -L "$t" ] || continue
  case "$t" in "$REPO"/zipper-app/app/build/*|"$REPO"/zipper-crm/.next) rm -rf -- "$t" && say "   removed $t" ;; *) say "   SKIP (outside the allowed paths): $t" ;; esac
done <<EOF
$TARGETS
EOF
if [ -d "$PREVIEW" ] && [ ! -L "$PREVIEW" ]; then
  printf 'Type PREVIEW to also remove the old preview build cache (anything else: keep it): '
  read -r b
  if [ "$b" = PREVIEW ]; then rm -rf -- "$PREVIEW" && say "   removed $PREVIEW"; else say "   kept $PREVIEW"; fi
fi
after="$(free_kb)"
say ""; say "Free space after: $(human "$after")   (recovered: $(human $((after - before))))"
say "Log: $LOG"
