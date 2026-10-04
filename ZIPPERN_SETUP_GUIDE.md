# Zippern — Complete Fresh Setup Guide

> Use this guide to wipe all existing Firebase data and do a clean installation from scratch.
> Follow every section in order.

---

## Project Structure

```
zippern/
├── zipper-app/          ← Android app (Kotlin + Jetpack Compose)
├── zipper-crm/          ← Web admin panel (Next.js 14)
├── firestore.rules      ← Firestore security rules
├── storage.rules        ← Firebase Storage security rules
├── firebase.json        ← Firebase project config
└── firestore.indexes.json
```

**Firebase Project:** `zipper-83816`  
**Firebase Console:** https://console.firebase.google.com/project/zipper-83816

---

## PART 1 — Firebase Console Cleanup (Wipe Everything)

Do these steps in order inside **Firebase Console**.

---

### 1.1 — Delete All Auth Users

1. Open Firebase Console → **Authentication** → **Users** tab
2. Select all users (checkbox at top)
3. Click **Delete** → Confirm
4. Repeat until zero users remain
5. This removes the `admin@zippern.crm` account and all app phone-auth accounts

---

### 1.2 — Delete All Firestore Data

1. Open Firebase Console → **Firestore Database**
2. Click the **three-dot menu** on each collection → **Delete collection**
3. Delete these collections one by one:

| Collection | What it holds |
|---|---|
| `users` | App user profiles + all subcollections |
| `crmUsers` | CRM team accounts |
| `feedbackTickets` | Support tickets from app |
| `hostApplications` | Host sign-up requests |
| `gifts` | Gift catalogue |
| `giftEvents` | Live room gift animations |
| `giftTransactions` | All gift transaction logs |
| `platformRevenue` | Revenue audit entries |
| `platformStats` | Running counters |
| `agencies` | Agency records |
| `salaryRequests` | Host salary withdrawal requests |
| `pkInvites` | PK battle invites |
| `liveRooms` | Live session records |
| `reports` | User reports |
| `conversations` | 1-to-1 chat threads + messages |
| `calls` | Video call records |
| `broadcasts` | In-app announcements |
| `notifications` | User notifications |
| `appConfig` | App-wide config |
| `announcements` | Public announcements |
| `bannedDevices` | Device ban list |
| `sellers` | Coin seller accounts |

> **Shortcut:** If the project has many documents, go to **Project Settings → General → Delete project data** or use the Firebase CLI:
> ```bash
> firebase firestore:delete --all-collections --project zipper-83816
> ```

---

### 1.3 — Clear Storage

1. Open Firebase Console → **Storage**
2. Select all folders → **Delete**
3. Or via CLI:
```bash
# Delete all files (run from any folder with firebase CLI)
gsutil -m rm -r gs://zipper-83816.firebasestorage.app/**
```

---

### 1.4 — Enable Email/Password Authentication

> ⚠️ This is required for the CRM to work. Do not skip.

1. Open Firebase Console → **Authentication** → **Sign-in method**
2. Find **Email/Password** → Click it
3. Toggle **Enable** → **Save**
4. Leave **Email link (passwordless)** disabled

---

## PART 2 — Apply Firebase Security Rules

### 2.1 — Firestore Rules

1. Open Firebase Console → **Firestore Database** → **Rules** tab
2. Delete all existing rules
3. Paste the entire contents of `/zippern/firestore.rules`
4. Click **Publish**

**Or via CLI:**
```bash
cd ~/Documents/Projects/zippern
firebase deploy --only firestore:rules
```

### 2.2 — Storage Rules

1. Open Firebase Console → **Storage** → **Rules** tab
2. Delete all existing rules
3. Paste the entire contents of `/zippern/storage.rules`
4. Click **Publish**

**Or via CLI:**
```bash
cd ~/Documents/Projects/zippern
firebase deploy --only storage
```

---

## PART 3 — CRM Setup (zipper-crm)

### 3.1 — Prerequisites

- Node.js 18 or higher (`node -v` to check)
- npm 9+ (`npm -v` to check)

### 3.2 — Delete old next.config.ts (if it exists)

```bash
cd ~/Documents/Projects/zippern/zipper-crm
rm -f next.config.ts
```

> The project uses `next.config.js` (CommonJS). The `.ts` version is not supported by Next.js 14.

### 3.3 — Verify .env.local

The file `zipper-crm/.env.local` must contain:

```env
NEXT_PUBLIC_FIREBASE_API_KEY=AIzaSyDG7297rR6vm8lj73aFE3P6FpM601jcJxY
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=zipper-83816.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=zipper-83816
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=zipper-83816.firebasestorage.app
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=239458555881
NEXT_PUBLIC_FIREBASE_APP_ID=1:344965230552:android:2cc5ffed64e7a07bc8ccad
```

> This file already exists in the project. No changes needed unless Firebase project changes.

### 3.4 — Install Dependencies

```bash
cd ~/Documents/Projects/zippern/zipper-crm
npm install
```

### 3.5 — Run Dev Server

```bash
npm run dev
```

Open **http://localhost:3000** in browser.

---

### 3.6 — First Login (Super Admin Seed)

When the CRM loads for the first time after a wipe:

Staff accounts are **no longer seeded from the browser with a shared password.**
The old `seedSuperAdmin()` path and the `NEXT_PUBLIC_SUPERADMIN_*` variables were
removed — `NEXT_PUBLIC_` values are compiled into the browser bundle, so they
published the top account's email, phone and name to every visitor.

Seeding now runs server-side through the Admin SDK:

1. Run `python backend/scripts/seed_accounts.py` (needs the service account key —
   see `backend/scripts/generate_service_key.py`).
2. For each account it creates the Firebase Auth user if missing, writes the
   Firestore document in `crmUsers`, and **emails a set-password link**. There is
   no default password, and none is printed anywhere.
3. Open the link in that email and choose your own password. If the email does
   not arrive, use Firebase Console → Authentication → *your address* → Reset
   password.
4. The observer account has no Firebase password at all — it signs in with a
   one-time emailed code.

**Where the values live:**
| Field | Where to find it |
|---|---|
| Super-admin email | The address you pass to `seed_accounts.py`; also on the `crmUsers` doc. |
| Password | Only in your password manager. Set via the emailed link — never stored in this repo, this document, or any script. |
| Phone (emergency) | On the super-admin document in the `crmUsers` collection. |
| Role | Super Admin (all permissions) |

> **Scripts never hardcode this password.** The `zipper-crm/scripts/upload-*.cjs`
> tools read `ZIPPER_ADMIN_EMAIL` and `ZIPPER_ADMIN_PASSWORD` from the
> environment and refuse to run if either is unset, e.g.
> `ZIPPER_ADMIN_EMAIL=… ZIPPER_ADMIN_PASSWORD=… node scripts/upload-assets.cjs …`

---

### 3.7 — Verify CRM Pages

After logging in, check each of these pages loads without errors:

| URL | What to check |
|---|---|
| `http://localhost:3000/` | Dashboard loads, stats show (may be 0) |
| `http://localhost:3000/users` | Users list (empty is fine) |
| `http://localhost:3000/hosts` | Hosts list (empty is fine) |
| `http://localhost:3000/finance` | Finance page loads |
| `http://localhost:3000/agencies` | Agencies list + pending approval |
| `http://localhost:3000/sellers` | Coin sellers + recharge requests |
| `http://localhost:3000/operations` | Operations dashboard |
| `http://localhost:3000/operations/reports` | User/host report queue |
| `http://localhost:3000/operations/bans` | Device ban management |
| `http://localhost:3000/tech` | Tech dashboard |
| `http://localhost:3000/tech/tickets` | Kanban ticket board |
| `http://localhost:3000/tech/content` | Gift/level/card config |
| `http://localhost:3000/tech/payments` | Per-country payment config |
| `http://localhost:3000/finance/payouts` | Weekly payout reports |
| `http://localhost:3000/finance/profit` | Profit monitoring |
| `http://localhost:3000/policies` | Privacy Policy / ToS / FAQ editor |
| `http://localhost:3000/tickets` | Support tickets page loads |
| `http://localhost:3000/broadcasts` | Broadcasts page loads |
| `http://localhost:3000/live` | Live monitor loads |
| `http://localhost:3000/team` | Team management loads |
| `http://localhost:3000/analytics` | Analytics loads |
| `http://localhost:3000/kyc` | KYC review loads |

If any page shows **"Missing or insufficient permissions"** — the Firestore rules were not published correctly. Republish and hard-refresh (Cmd+Shift+R).

---

### 3.8 — Deploy Cloud Functions (Optional for local testing, required for production)

Cloud Functions handle: weekly payout report generation (Sunday 23:59), coin transfer on recharge approval, and platform stats aggregation.

```bash
cd ~/Documents/Projects/zippern/functions
npm install
npm run build

# Deploy to Firebase
firebase deploy --only functions
```

> For local dev, use the Firebase Emulator Suite instead (`firebase emulators:start`).
> Functions require the **Blaze (pay-as-you-go)** Firebase plan to deploy.

---

## PART 4 — Android App Setup (zipper-app)

### 4.1 — Prerequisites

- Android Studio (Hedgehog or newer)
- JDK 17
- Android device or emulator with API 26+

### 4.2 — google-services.json

Make sure `zipper-app/app/google-services.json` is present and matches Firebase project `zipper-83816`.

To get a fresh copy:
1. Firebase Console → **Project Settings** → **Your apps**
2. Click the Android app (package: `com.zipper.app`)
3. Click **Download google-services.json**
4. Replace `zipper-app/app/google-services.json`

### 4.3 — Build & Run

1. Open `zipper-app/` folder in Android Studio
2. Let Gradle sync complete
3. Click **Run** (▶) on a connected device or emulator

### 4.4 — First App Login

- The app uses **Phone OTP auth** (Firebase Authentication → Phone)
- Enter a real mobile number → receive OTP → log in
- The user profile is created in Firestore `users/{uid}` on first login

### 4.5 — Enable Phone Auth in Firebase

1. Firebase Console → **Authentication** → **Sign-in method**
2. Find **Phone** → Enable → Save
3. For testing on emulator: go to **Authentication → App Check** and add your SHA-1 fingerprint

---

## PART 5 — Firebase Indexes

If you see **"The query requires an index"** errors in the app or CRM:

```bash
cd ~/Documents/Projects/zippern
firebase deploy --only firestore:indexes
```

Or manually create indexes from the Firebase Console → Firestore → Indexes tab as the errors suggest.

---

## PART 6 — Production Build (CRM)

When ready to deploy the CRM to production:

```bash
cd ~/Documents/Projects/zippern/zipper-crm
npm run build
npm run start
# or deploy to Vercel / Firebase Hosting
```

For Firebase Hosting:
```bash
npm run build
firebase deploy --only hosting
```

---

## PART 7 — CRM Role & Access Summary

Sixteen roles. **There is no flat `admin` role and no `team` role** — an "admin"
is always a *department* admin. `admin`, `ops`, `tech`, `finance` and `support`
are legacy strings that `normalizeCrmRole` (`zipper-crm/lib/auth.ts`) maps onto
the roles below on first login; nothing should gate on them.

The top role is spelled differently on each side and it is the same person:
`ApiRole` in `zipper-crm/lib/api.ts` calls it `owner`, `CrmRole` in
`zipper-crm/lib/auth.ts` calls it `superadmin`.

### Governance

| Role | CRM spelling | What they can do |
|---|---|---|
| `owner` | `superadmin` | Everything. The only role that signs money cards, approves requests and manages staff. |
| `observer` | — (no `crmUsers` document) | Read-only oversight across every screen. Signs in with a one-time code, never with Google, and holds no Firebase account at all. |

### Departments — six departments, an admin and a member in each

| Role | Label | What they can do |
|---|---|---|
| `app_admin` | App Admin | Users & hosts, ban/unban, balance requests, agencies, app config, live monitor, staff |
| `app_member` | App Team | View users, ban/unban, raise tickets, live monitor |
| `ops_admin` | Ops Admin | KYC approvals, agency onboarding, seller approvals, finance view, staff |
| `ops_member` | Ops Team | View agencies & sellers, raise tickets |
| `finance_admin` | Finance Admin | Payouts, coin operations, revenue, balance requests, assign & close tickets |
| `finance_member` | Finance Team | Coin operations, finance view, process payouts, raise tickets |
| `tech_admin` | Tech Admin | Economy config, commission slabs, app config, assign & close tickets |
| `tech_member` | Tech Team | Economy config, commission slabs, app config, raise tickets |
| `support_admin` | Support Admin | View users, assign & close tickets, staff |
| `support_member` | Support Team | View users, raise & assign tickets |
| `marketing_admin` | Marketing Admin | Broadcasts, assign & close tickets, staff |
| `marketing_member` | Marketing Team | Broadcasts, raise tickets |

### External partner accounts

| Role | Label | What they can do |
|---|---|---|
| `agency` | Agency | Their own agency dashboard — their hosts, their commission, their own profile |
| `seller` | Coin Seller | Their own coin seller dashboard and profile |

The authoritative list is `CrmRole` in `zipper-crm/lib/auth.ts`, with the
per-role grants in `DEFAULT_PERMISSIONS` in the same file. Gate on
`canAccess(user, roles)` or `hasPermission(user, perm)` — both treat
`superadmin` as holding everything — rather than comparing a role string by
hand, which is how a `*_admin` ends up excluded from something every other
admin can reach.

All CRM users sign in at `http://localhost:3000/login` with their **email
address** and password — there is no username mapping — and may connect Google
to that same account afterwards from /profile. Google can only be connected
once the address is verified; see `EMAIL_NOT_VERIFIED` in
`zipper-crm/lib/auth.ts` for why.

---

## PART 8 — Key Firebase Collections Reference

| Collection | Who writes | Who reads |
|---|---|---|
| `users/{uid}` | App users (phone auth) | Any auth user |
| `users/{uid}/blocked` | Owner only | Owner + CRM |
| `users/{uid}/diamondTransactions` | Any auth | Owner + CRM |
| `users/{uid}/beanTransactions` | Any auth | Owner + CRM |
| `crmUsers/{uid}` | CRM users only | CRM users only |
| `feedbackTickets/{id}` | App users | Owner + CRM |
| `liveRooms/{id}` | Host creates | Any auth |
| `liveRooms/{id}/viewers/{uid}` | Viewer themselves | Any auth |
| `conversations/{id}` | Participants | Participants + CRM |
| `gifts/{id}` | CRM only | Any auth |
| `bannedDevices/{deviceId}` | Admin SDK only | Public (no auth needed) |
| `hostApplications/{id}` | Any auth | CRM manages |

---

## PART 9 — Firebase Storage Paths Reference

| Path | Who uploads | Who reads |
|---|---|---|
| `/profiles/{uid}/` | Owner (images ≤5MB) | Public |
| `/kyc/{allPaths}` | Any auth (≤10MB) | CRM only |
| `/feedbackAttachments/{uid}/` | Owner (≤20MB) | Owner + CRM |
| `/live/{allPaths}` | Any auth (≤50MB) | Public |
| `/chat/{convoId}/` | Participants | Participants |
| `/broadcasts/{allPaths}` | CRM only | Public |
| `/gifts/{allPaths}` | CRM only | Public |

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `Missing or insufficient permissions` | Firestore rules not published / user not logged in as CRM user | Re-publish rules; make sure `@zippern.crm` email auth works |
| `auth/email-already-in-use` on seed | Admin account already created | Normal — no action needed |
| `auth/operation-not-allowed` on seed | Email/Password auth not enabled | Enable in Firebase Console → Authentication → Sign-in method |
| `Module not found: @/components/...` | tsconfig.json paths wrong | Check `"@/*": ["./*"]` in tsconfig.json |
| `next.config.ts not supported` | Next.js 14 doesn't support TS config | Delete `next.config.ts`, use `next.config.js` |
| `user.displayName is undefined` | CrmUser has `.name` not `.displayName` | Use `crmUser.name` |
| CRM login says "Invalid username or password" | Admin not seeded yet / password never set | Run `python backend/scripts/seed_accounts.py`, then use the set-password link it emails (§3.6). To re-issue it: Firebase Console → Authentication → *your address* → Reset password |
| Dashboard shows 0 for all stats | Firestore is freshly wiped | Normal — stats grow as users use the app |
| Android: `google-services.json` mismatch | Wrong Firebase project | Re-download from Firebase Console |

---

*Document generated: 2 July 2026 — Zippern v1.0*
