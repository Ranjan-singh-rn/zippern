#!/bin/bash
# ZIPPER — READ-ONLY production baseline + the BACKEND source archive only (no Functions source, no APK).
# Double-click in Finder, or run: bash outputs/release/run-baseline-backend-source.command
# Results: ~/zipper-baseline/<UTC time>/ ; a copy of this window's output: ~/zipper-baseline/console-<UTC time>.txt
cd "$(dirname "$0")/../.." || { echo "Cannot reach the repository root."; exit 1; }

# Terminal starts .command files without your zsh profile, so look for gcloud where its installers put it.
for d in /opt/homebrew/bin /usr/local/bin "$HOME/google-cloud-sdk/bin" \
         /opt/homebrew/share/google-cloud-sdk/bin /usr/local/share/google-cloud-sdk/bin \
         /opt/homebrew/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin; do
  [ -x "$d/gcloud" ] && PATH="$d:$PATH"
done
export PATH
export CLOUDSDK_CORE_DISABLE_PROMPTS=1      # every gcloud prompt takes its default ("no"); nothing gets enabled

mkdir -p "$HOME/zipper-baseline" && chmod 700 "$HOME/zipper-baseline"
LOG="$HOME/zipper-baseline/console-$(date -u +%Y%m%dT%H%M%SZ).txt"
echo "gcloud: $(command -v gcloud || echo 'NOT FOUND')"
bash outputs/release/collect-production-baseline.sh --with-sources=backend 2>&1 | tee "$LOG"
echo
echo "Console copy: $LOG"
echo "== finished $(date)"
