#!/bin/bash
# Mobile-parity verification: Android unit tests + debug build, LOCAL ONLY.
# Runs nothing against any server: unit tests are pure JVM; assembleDebug only compiles.
# Output goes to ../outputs/verify/ so the session can read it. Safe to delete afterwards.
cd "$(dirname "$0")" || exit 1
mkdir -p ../outputs/verify || exit 1
LOG="../outputs/verify/work-verify-$(date +%Y%m%d-%H%M%S).log"
# Start from "failed": never trust a value inherited from the calling shell.
GRADLE_EXIT=1
{
  echo "== started $(date)"
  echo "== java: $(/usr/libexec/java_home 2>/dev/null || echo default)"
  ./gradlew --no-daemon :app:testDebugUnitTest :app:assembleDebug --console=plain
  GRADLE_EXIT=$?
  echo "== gradle exit: $GRADLE_EXIT"
  echo "== finished $(date)"
} > "$LOG" 2>&1
# The braces run in this shell (not a subshell), so the value captured inside survives.
cp -f app/build/work-parity-matrix.md ../outputs/verify/ 2>/dev/null
mkdir -p ../outputs/verify/test-results
cp -Rf app/build/test-results/testDebugUnitTest ../outputs/verify/test-results/ 2>/dev/null
echo "Done. Gradle exit code: $GRADLE_EXIT. Log: $LOG"
exit "$GRADLE_EXIT"
