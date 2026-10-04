#!/bin/bash
# Zipper CRM — Build & Deploy to Firebase Hosting
# Double-click this file in Finder to build and deploy the CRM.

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║     Zipper CRM — Build & Deploy                   ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# Check firebase CLI
if ! command -v firebase &>/dev/null; then
  echo "❌ Firebase CLI not found. Run:"
  echo "   npm install -g firebase-tools"
  echo "   firebase login"
  exit 1
fi

# Step 1: Build Next.js static export
echo "──────────────────────────────────"
echo "STEP 1: Building CRM (Next.js)"
echo "──────────────────────────────────"
cd "$PROJECT_ROOT/zipper-crm"
npm install
npm run build
echo "✅ Build complete → zipper-crm/out/"
echo ""

# Step 2: Deploy Firestore indexes (includes new ones we added)
cd "$PROJECT_ROOT"
echo "──────────────────────────────────"
echo "STEP 2: Deploying Firestore indexes"
echo "──────────────────────────────────"
firebase deploy --only firestore:rules,firestore:indexes,storage
echo "✅ Rules + indexes + storage rules deployed"
echo ""

# Step 3: Deploy to Firebase Hosting
echo "──────────────────────────────────"
echo "STEP 3: Deploying to Hosting"
echo "──────────────────────────────────"
firebase deploy --only hosting
echo "✅ Hosting deployed"
echo ""

echo "╔══════════════════════════════════════════════════╗"
echo "║  ✅ CRM IS LIVE                                   ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "  https://zipperlive.web.app"
echo ""
echo "Log in with your superadmin account, then pass the security gate."
echo "(Credentials are not printed here — use your password manager.)"
echo ""

# Keep Terminal open so you can read the output
read -p "Press Enter to close..."
