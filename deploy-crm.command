#!/bin/bash
# Zipper CRM — gated build & HOSTING-ONLY deploy of the `production` target (site zipperlive).
# Double-click this file in Finder, or run it from a terminal.
#
# ── What this script will NOT do (audit C-3) ────────────────────────────────
#   * It never deploys Firestore rules, Firestore indexes or Storage rules.
#     Those are released on their own, from a reviewed candidate, never as a
#     side effect of shipping the CRM. (The previous version ran
#     `firebase deploy --only firestore:rules,firestore:indexes,storage` first,
#     which would have replaced the production rules with whatever was in the
#     working tree.)
#   * It never deploys from a dirty git tree. What ships must be what is
#     committed, so the deployed site can be matched to a commit.
#   * It never deploys an `out/` it did not just build and verify.
#
# ── What it does ─────────────────────────────────────────────────────────────
#   1. refuses a dirty git tree and prints the commit that will ship;
#   2. checks the build env names the observer mailbox (NEXT_PUBLIC_OBSERVER_EMAIL,
#      audit C-18 — the key only; the value is never printed);
#   3. npm ci, typecheck, the full test suite, the build, verify:out
#      (which also asserts /frozen-money/index.html is in the export);
#   4. prints the exact Firebase project, hosting target and site;
#   5. asks for the typed word DEPLOY, then `firebase deploy --only hosting:production`.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
CRM_DIR="$PROJECT_ROOT/zipper-crm"
HOSTING_TARGET="production"
CONFIRM_WORD="DEPLOY"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║     Zipper CRM — gated build & hosting deploy     ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

fail() { echo ""; echo "❌ $1"; echo ""; read -r -p "Press Enter to close..." _; exit 1; }

# ── Tooling ──────────────────────────────────────────────────────────────────
command -v git >/dev/null 2>&1 || fail "git not found."
command -v node >/dev/null 2>&1 || fail "node not found."
command -v npm >/dev/null 2>&1 || fail "npm not found."
if ! command -v firebase >/dev/null 2>&1; then
  fail "Firebase CLI not found. Run: npm install -g firebase-tools && firebase login"
fi

# ── 1. A clean, committed tree ───────────────────────────────────────────────
echo "──────────────────────────────────"
echo "STEP 1: Git tree must be clean"
echo "──────────────────────────────────"
cd "$PROJECT_ROOT"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "Not a git repository: $PROJECT_ROOT"
if [ -n "$(git status --porcelain --untracked-files=normal -- zipper-crm firebase.json .firebaserc deploy-crm.command)" ]; then
  echo ""
  git status --short -- zipper-crm firebase.json .firebaserc deploy-crm.command | head -40
  fail "The working tree has uncommitted changes in zipper-crm/, firebase.json, .firebaserc or this script. Commit (or stash) them first — only committed code ships."
fi
COMMIT="$(git rev-parse --short=12 HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "✅ Clean. Shipping commit $COMMIT on branch $BRANCH"
echo ""

# ── 2. Build environment ─────────────────────────────────────────────────────
echo "──────────────────────────────────"
echo "STEP 2: Build environment"
echo "──────────────────────────────────"
cd "$CRM_DIR"
[ -f .env.local ] || fail "zipper-crm/.env.local is missing — the build needs the NEXT_PUBLIC_FIREBASE_* values."
# Key presence only. The value is a mailbox and is never printed (audit C-18).
if ! grep -Eq '^[[:space:]]*NEXT_PUBLIC_OBSERVER_EMAIL=[^[:space:]]+' .env.local; then
  fail "NEXT_PUBLIC_OBSERVER_EMAIL is not set in zipper-crm/.env.local. It is required: without it the observer door matches no address (audit C-18)."
fi
for key in NEXT_PUBLIC_FIREBASE_API_KEY NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN NEXT_PUBLIC_FIREBASE_PROJECT_ID NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET NEXT_PUBLIC_FIREBASE_APP_ID; do
  grep -Eq "^[[:space:]]*${key}=[^[:space:]]+" .env.local || fail "$key is not set in zipper-crm/.env.local."
done
echo "✅ .env.local names every required NEXT_PUBLIC_* key (values not shown)"
echo ""

# ── 3. Install, typecheck, test, build, verify ───────────────────────────────
echo "──────────────────────────────────"
echo "STEP 3: npm ci → typecheck → test → build → verify:out"
echo "──────────────────────────────────"
npm ci
npm run typecheck
npm test
rm -rf out
npm run build
npm run verify:out
echo "✅ Build verified → zipper-crm/out/"
echo ""

# Belt and braces beside verify:out — the money screen that went missing from
# the 20 Oct reconstructions (audit C-3 / C-12).
[ -f out/frozen-money/index.html ] || fail "out/frozen-money/index.html is missing — the export lost the Frozen money screen. Do not deploy."
[ -f out/index.html ] || fail "out/index.html is missing — the export is incomplete."

# ── 4. Say exactly where this goes ───────────────────────────────────────────
cd "$PROJECT_ROOT"
# .firebaserc is JSON without a .json extension: require() would parse it as JavaScript (SyntaxError on 2 Nov), so read it.
FB_PROJECT="$(node -e "const r=JSON.parse(require('fs').readFileSync('./.firebaserc','utf8')); process.stdout.write(String(r.projects && r.projects.default || ''))")"
FB_SITES="$(node -e "const r=JSON.parse(require('fs').readFileSync('./.firebaserc','utf8')); const t=((r.targets||{})['$FB_PROJECT']||{}).hosting||{}; process.stdout.write((t['$HOSTING_TARGET']||[]).join(', '))")"
FB_PUBLIC="$(node -e "const c=require('./firebase.json'); const h=(c.hosting||[]).find(x=>x.target==='$HOSTING_TARGET'); process.stdout.write(h?h.public:'')")"
[ -n "$FB_PROJECT" ] || fail ".firebaserc has no default project."
[ -n "$FB_SITES" ] || fail ".firebaserc has no hosting site for target '$HOSTING_TARGET'."
[ "$FB_PUBLIC" = "zipper-crm/out" ] || fail "firebase.json target '$HOSTING_TARGET' does not publish zipper-crm/out (found: '$FB_PUBLIC')."
ACTIVE_PROJECT="$(firebase use 2>/dev/null | tail -n 1 || true)"

echo "──────────────────────────────────"
echo "STEP 4: Deploy target"
echo "──────────────────────────────────"
echo "  Firebase project : $FB_PROJECT"
echo "  Hosting target   : $HOSTING_TARGET"
echo "  Hosting site(s)  : $FB_SITES"
echo "  Publishes        : $FB_PUBLIC  (commit $COMMIT, branch $BRANCH)"
echo "  CLI active proj. : ${ACTIVE_PROJECT:-unknown}"
echo "  Command          : firebase deploy --project $FB_PROJECT --only hosting:$HOSTING_TARGET"
echo ""
echo "  NOT deployed by this script: Firestore rules, Firestore indexes, Storage rules, Functions, the applinks site."
echo ""
read -r -p "Type $CONFIRM_WORD to publish to the site(s) above, anything else to abort: " WORD
if [ "$WORD" != "$CONFIRM_WORD" ]; then
  echo ""
  echo "Aborted. Nothing was deployed."
  read -r -p "Press Enter to close..." _
  exit 0
fi

# ── 5. Hosting only ──────────────────────────────────────────────────────────
echo ""
echo "──────────────────────────────────"
echo "STEP 5: Deploying hosting:$HOSTING_TARGET"
echo "──────────────────────────────────"
firebase deploy --project "$FB_PROJECT" --only "hosting:$HOSTING_TARGET"
echo "✅ Hosting deployed (commit $COMMIT)"
echo ""

echo "╔══════════════════════════════════════════════════╗"
echo "║  ✅ CRM IS LIVE                                   ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "  https://zipperlive.web.app"
echo ""
echo "Rules, indexes and Storage rules were NOT touched. Release those from their own candidate."
echo ""

# Keep Terminal open so you can read the output
read -r -p "Press Enter to close..." _
