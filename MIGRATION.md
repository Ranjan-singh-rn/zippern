# Zipper — moving to a new Firebase project

Zipper currently lives in `dating-app-967f3`, a Firebase/GCP project owned by
somebody else. This is the checklist for moving it to a project owned by
`314zipper@gmail.com`.

Now is the cheap moment. There are 67 documents, no real users and no
transactions. Everything below is a couple of evenings' work today and a
migration project in six months.

Two things get fixed on the way through, because they cannot be fixed
afterwards at any price:

| | Old | New |
|---|---|---|
| Firestore region | `asia-east1` (Taiwan) | **`asia-south1` (Mumbai)** |
| CRM address | `dating-app-967f3.web.app` | **`zipper.web.app`** |

**Work top to bottom.** The order is load-bearing in six places, each marked
**⛔ ORDER MATTERS**, plus § 2.1, which is the one step no later step can
repair. Everything else can be done whenever.

Reference for the deploy itself is [`DEPLOYMENT.md`](DEPLOYMENT.md). This file
does not repeat it; it says which of its sections have to be run again and what
changes in them.

---

## 0. Before you touch the new project

You need things out of the old one, and the old one is the one you may stop
being able to reach.

- [ ] **Take a fresh backup.** The one on disk is from 20 August.

      cd backend && source .venv/bin/activate
      python -m scripts.backup_firestore

      You should see: a line per collection and `Saved to:
      .../backups/firestore-<today>-<time>`. Nine collections, around 67
      documents. It is read-only; it changes nothing.

- [ ] **Check the 28 asset URLs still resolve.** These are the gift images,
      gift Lottie files, entrance animations and their thumbnails. They live in
      the old bucket and their addresses are stored *inside* the Firestore
      documents.

      python -m scripts.migrate_assets --probe-only

      You should see: `All 28 asset(s) are readable.` It needs no target
      project, no credentials and no bucket — the stored URLs carry their own
      access token, which is the whole reason § 5.2 works the way it does.

      If it says fewer, deal with it now rather than at midnight: six of the
      twenty-eight — the `tank` entrance and both gift assets — exist nowhere
      but that bucket. The other twenty-two have local copies in
      `functions/entry-lotties/` and `functions/entry-thumbnails/` and the
      script falls back to them automatically.

- [ ] **Keep the old credentials.** Rename, do not delete:

      cd ..        # back to the repo root; the key lives there
      mv serviceAccountKey.json serviceAccountKey.old.json

      You will put the new one at `serviceAccountKey.json` in § 2.6. Do this
      *after* the backup above — the backup reads the old project through this
      key.

- [ ] Make sure you are signed in to the console as **`314zipper@gmail.com`**
      and not as whatever account the old project is under. Chrome profiles are
      the usual way this goes wrong at 9pm.

---

## 1. Create the project

**Console only. There is no way to create a Firebase project and attach billing
from the command line without an organisation, so this part is clicking.**

### 1.1 The project

- [ ] Go to **https://console.firebase.google.com** → **Create a project**.
- [ ] Name it `Zipper`. Below the name Firebase shows the **project ID** it will
      generate — something like `zipper-4c1e2`. **Write that ID down.** It is
      permanent, and every command below wants it.
- [ ] Google Analytics: **on** is fine, **off** is also fine. Nothing in this
      repo reads Analytics — `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` is set and
      unused. Off is one less thing.
- [ ] **You should see:** "Your new project is ready", then the project
      dashboard.

### 1.2 Blaze — do this before anything else

**⛔ ORDER MATTERS.** On the free Spark plan, Cloud Run will not deploy,
Functions will not deploy, Cloud Scheduler does not exist, Secret Manager is not
available, a second Hosting site cannot be created, and on a project created
today Cloud Storage will not give you a default bucket. Turning Blaze on later
does work, but you will have spent an hour failing at four different steps
first.

- [ ] Bottom-left of the console: **Spark** → **Upgrade** → **Blaze**.
- [ ] Pick or create a Cloud Billing account on your own card.
- [ ] Set a budget alert. ₹2,000/month is generous for what this runs at today.
- [ ] **You should see:** bottom-left now reads **Blaze — Pay as you go**.

---

## 2. Firestore, Storage, Auth

### 2.1 Firestore — ⛔ THE ONE STEP YOU CANNOT UNDO

> **A Firestore database's location is fixed at creation. There is no move, no
> export-in-place, no support ticket. The only way to change it is to delete the
> project and start this document again.**
>
> This is the entire reason the move is worth doing. `dating-app-967f3` is in
> `asia-east1` (Taiwan) and every read your users make crosses the Bay of
> Bengal twice.

- [ ] **Build → Firestore Database → Create database**.
- [ ] Database ID: leave it as **`(default)`**. `firebase.json` names
      `(default)` and a named database is a different product surface.
- [ ] **Location: `asia-south1 (Mumbai)`.** Read the dropdown twice. Not
      `asia-south2`, not `asia-southeast1`, not the `nam5`/`eur3` multi-region
      it defaults to.
- [ ] Rules: **Start in production mode** (locked). The real rules get deployed
      in § 5.4; starting locked means there is no window where the database is
      open.
- [ ] **You should see:** an empty **Data** tab with the location printed under
      the database name at the top. Confirm it from the terminal too, because
      that is the reading that cannot be misread:

      gcloud firestore databases describe --database='(default)' \
        --format='value(locationId)'
      # asia-south1

      If that prints anything else, stop. Delete the project and redo § 1. It
      is ten minutes now and it is unfixable later.

### 2.2 Storage — also fixed at creation

- [ ] **Build → Storage → Get started**.
- [ ] Rules: **production mode**.
- [ ] **Location: `asia-south1`.** Firestore's region is usually offered as the
      default; confirm it rather than assuming. A bucket's location cannot be
      changed either.
- [ ] **You should see:** an empty bucket named
      **`<your-project-id>.firebasestorage.app`**. Write that name down — it is
      the `--bucket` argument in § 4.

### 2.3 Auth providers — exactly four

These are the four the code actually uses. Nothing else needs turning on.

**Build → Authentication → Get started → Sign-in method**, then for each:

- [ ] **Email/Password** — *Enable*, leave "Email link" off.
      Used by the CRM: `zipper-crm/lib/auth.ts` calls
      `signInWithEmailAndPassword`, `createUserWithEmailAndPassword` and
      `sendPasswordResetEmail`. Without it no staff member can sign in and
      `scripts.seed_accounts` fails.
- [ ] **Phone** — *Enable*.
      The Android OTP login: `AuthRepository.kt` uses
      `PhoneAuthProvider.verifyPhoneNumber`. Free tier covers far more SMS than
      you will send this month.
- [ ] **Google** — *Enable*. It will ask for a project support email; use
      `314zipper@gmail.com`.
      `AuthRepository.signInWithGoogle` plus `LoginScreen.kt`'s
      `GetGoogleIdOption`. Enabling this is what mints the **Web client ID** you
      need in § 2.5 — expand the **Web SDK configuration** panel and copy it now.
- [ ] **Anonymous** — *Enable*.
      "Continue as Guest" — `AuthRepository.signInAsGuest` calls
      `signInAnonymously`. Leave it off and that button throws.

      Worth knowing what that means, because `firestore.rules` is built on it.
      `isAppUser()` is defined as *signed in, and not present in `crmUsers`* —
      it does not ask which provider was used. So an anonymous guest is a
      first-class app user to the rules: they can create their own user
      document, send gifts, join rooms, raise reports. That is deliberate, and
      it is why Anonymous is a real provider here and not a convenience.

- [ ] **You should see:** four rows reading **Enabled** and every other provider
      **Disabled**.

### 2.4 Authorized domains — the one everybody forgets

Firebase pre-authorises `<project-id>.web.app` and
`<project-id>.firebaseapp.com`. It does **not** authorise a second Hosting
site's domain. The CRM will be served from `zipper.web.app`, and signing in from
an unauthorised domain fails with `auth/unauthorized-domain` and no other clue.

Come back here after § 3 creates the site.

- [ ] **Authentication → Settings → Authorized domains → Add domain**:
      `zipper.web.app`
- [ ] Add `zipper.firebaseapp.com` as well.
- [ ] **You should see:** both in the list alongside `localhost` and the two
      default entries.

### 2.5 Register the two apps

**⚙ → Project settings → General → Your apps.**

- [ ] **Web app.** Click the `</>` icon. Nickname `Zipper CRM`. **Do not** tick
      "Also set up Firebase Hosting" — § 3 does that properly.
      **You should see:** a `firebaseConfig` block. Copy all of
      `apiKey`, `appId` and `measurementId` — § 4 wants them.

- [ ] **Android app.** Click the Android icon.
      - Package name: **`com.zipper.app`** — exactly this. It is
        `applicationId` in `zipper-app/app/build.gradle.kts`. The old project
        also has `com.zipper.datingapp` registered, which nothing builds; do not
        recreate it.
      - Nickname `Zipper`.
      - **Debug signing certificate SHA-1**: required, or Google Sign-In fails
        on device with a `10:` developer error and nothing else. Get it with:

            cd zipper-app && ./gradlew signingReport

        Copy the **SHA1** under `Variant: debug`. Paste it into the console
        field. When you build a release APK, come back and add the release
        keystore's SHA-1 too.
      - Download **`google-services.json`** and put it at
        **`zipper-app/app/google-services.json`**, replacing the old one.

      **You should see:** the file's `project_info.project_id` is your new
      project id. Check it — this is the input § 4 reads.

- [ ] **Web client ID for Android.** Still in Project settings → General, or
      from Authentication → Sign-in method → Google → Web SDK configuration,
      copy the **Web client ID** — it looks like
      `<project-number>-<hash>.apps.googleusercontent.com`.
      `zipper-app/.../res/values/strings.xml` hardcodes this as
      `default_web_client_id` and `LoginScreen.kt` passes it to
      `setServerClientId`. § 4 writes it for you.

### 2.6 The service account key

- [ ] **⚙ → Project settings → Service accounts → Generate new private key** →
      **Generate key**.
- [ ] Save it at the repo root as **`serviceAccountKey.json`**.
- [ ] **You should see:** `git status` does not list it. It is gitignored twice
      over. If it ever shows up, stop and fix that before committing anything.

### 2.7 Project number

- [ ] **⚙ → Project settings → General → Project number.** Twelve digits.
      Write it down — § 6.3 and § 6.5 both build a service account address out
      of it. (§ 4 reads it from `google-services.json` on its own.)

---

## 3. The Hosting site — `zipper`

**⛔ ORDER MATTERS.** Create the site *before* § 4, because § 4 writes the site
name into `.firebaserc`, `firebase.json`, `backend/app/main.py`'s CORS list,
`functions/.env` and every "CRM is live at" line in the deploy scripts. If the
name `zipper` turns out to be taken you want to know now, not after 25 files
have been rewritten with it.

Background and the full explanation of why this works is
[`DEPLOYMENT.md` § 1](DEPLOYMENT.md#1-getting-zipperwebapp).

```bash
npm install -g firebase-tools          # if you have not already
firebase login                         # sign in as 314zipper@gmail.com

# --project is not optional here. .firebaserc still names the OLD project
# until § 4 rewrites it, and without this flag the site is created there.
firebase hosting:sites:create zipper --project <your-new-project-id>
```

- [ ] Run it.
- [ ] **You should see:** `Site zipper has been created in project <id>.` and
      the two URLs `https://zipper.web.app` and `https://zipper.firebaseapp.com`.
      They will 404 until § 7 deploys the CRM — that is correct, nothing has
      been published yet.
- [ ] **If it fails with "site ID is already in use"** the name is taken
      globally, not just in your project. Try `zipperlive`, `getzipper`,
      `zipper-live`, `zipperapp`. **Whatever name succeeds, use it as
      `--hosting-site` in § 4** and everywhere below that says `zipper`.
- [ ] Now go back and do § 2.4 with the name you actually got.

---

## 4. Point the repo at the new project

One command rewrites all of it. Dry run first — it always dry-runs unless you
add `--confirm`.

- [ ] Clear the stale Hosting cache, which is keyed to the old project:

      rm -rf .firebase

- [ ] Dry run. The new `google-services.json` from § 2.5 supplies the project
      id, the project number, the bucket, the Android app id, the Android API
      key and the OAuth client id, so the only things you type are the three
      web values from the `firebaseConfig` block:

      cd backend && source .venv/bin/activate

      python -m scripts.retarget_project \
        --from-google-services \
        --hosting-site zipper \
        --web-api-key   "<apiKey from § 2.5>" \
        --web-app-id    "<appId from § 2.5>" \
        --measurement-id "<measurementId from § 2.5, or omit>"

      **You should see:** `DRY RUN — nothing will be written`, the new identity
      block with your project id, bucket, `zipper.web.app` and
      `firestore region asia-south1`, then roughly **26 files, 80
      replacements**, then the two downloaded files it refuses to touch.

      If a **STILL HOLDING OLD-PROJECT VALUES** section appears, it is naming a
      value it will not invent — read the flag it suggests and supply it. It
      would rather leave a line alone than write a plausible string that does
      not exist anywhere in Google.

      If it **refuses**, it says why in one sentence. The usual causes are the
      old project id pasted by mistake, a bucket that does not start with the
      new project id, and a `google-services.json` that is still the old one.

- [ ] Write it: same command with `--confirm` on the end.
- [ ] Read the diff. It is worth ninety seconds.

      cd .. && git diff --stat
      git diff .firebaserc firebase.json

      **You should see:** `.firebaserc` naming the new project with hosting
      target `production` → `["zipper"]`, and `firebase.json` with
      `"location": "asia-south1"`, the new `storage.bucket`, and `hosting`
      turned from an object into an array with `"target": "production"`.

      The two env files are gitignored, so `git diff` says nothing about them.
      Read them directly:

      grep FIREBASE_PROJECT_ID backend/.env
      grep NEXT_PUBLIC zipper-crm/.env.local

      All seven `NEXT_PUBLIC_` values must be on the new project: project id,
      auth domain `<new-id>.firebaseapp.com` — **not** `zipper.firebaseapp.com`,
      the auth handler is project-scoped — bucket, the twelve-digit sender id,
      and the API key and app id you pasted.

**What it deliberately does not touch, and why**

| | |
|---|---|
| `serviceAccountKey.json` | Contains a private key. Downloaded in § 2.6, never edited. |
| `zipper-app/app/google-services.json` | OAuth client ids, app ids, API key and your certificate hash — all minted by Firebase. Replaced wholesale in § 2.5. |
| `zipper-crm/scripts/uploaded-urls.json` | The saved output of an upload run against the old bucket. Every URL in it carries an old download token, so rewriting the bucket name would turn a historical record into 32 URLs that 404. It is regenerated by the uploader and read by nothing. |
| `backend/backups/`, `node_modules`, `.git`, `.venv`, build output | Never read, never written. |

---

## 5. Bring the data, the assets and the services across

### 5.1 Configuration

**⛔ ORDER MATTERS.** `backend/.env` must already point at the new project —
that was § 4. If you run this with the old `.env` you will write the config back
into the project you are leaving and think it worked.

- [ ] Confirm which project you are about to write to:

      grep FIREBASE_PROJECT_ID backend/.env
      head -c 200 serviceAccountKey.json | grep -o '"project_id": *"[^"]*"'

      Both must read your **new** project id.

- [ ] Restore the economy, payment config, packages and policies:

      cd backend && python -m scripts.restore_config          # dry run
      python -m scripts.restore_config --confirm

      **You should see:** the four config collections listed, the two commission
      slab corrections it applies, and `Restored N configuration document(s).`

### 5.2 The gift and entrance assets

`restore_config` deliberately does not restore content, so `gifts` and
`bagItems` — the two collections `reset_firestore` protects — have no other
route into the new project. This script carries both, and the 28 storage objects
they name, and rewrites every URL as it goes.

- [ ] Dry run:

      python -m scripts.migrate_assets

      **You should see:** `28 of 28 readable`, then the 28 object paths with
      their sizes, then `WOULD REWRITE — bagItems: 34 documents, 12 carrying an
      asset URL / gifts: 10 documents, 2 carrying an asset URL`.

- [ ] Write it:

      python -m scripts.migrate_assets --confirm

      **You should see:** an `Uploading` block where every line ends in `ok`, a
      `Writing documents` block saying `created` for all 44, and finally
      `Verifying every URL now stored in Firestore` → `28 of 28 resolve against
      <your-bucket>`.

      It exits non-zero and names them if any do not. It never leaves a broken
      URL in a document without telling you.

**Why it copies rather than rsyncs, in one paragraph,** because it is the detail
that makes the obvious version fail. A Firebase download URL ends
`?alt=media&token=<uuid>`. That token is not part of the file — it lives in the
object's custom metadata as `firebaseStorageDownloadTokens`, and the download
endpoint compares the query parameter against it. A bucket-to-bucket copy that
drops custom metadata produces objects with no token, so the rewritten URLs
answer **403 to the public and 200 to you**, because an authenticated
`gsutil cat` never goes near the token. You would not find out until a user
opened the gift tray. So each object is fetched over its existing public URL —
which needs no credentials on the old project at all, which matters given who
owns it — and re-uploaded with a **freshly minted token** in the new bucket.
Nothing depends on metadata surviving a copy.

Re-running the old uploaders instead does not work: `functions/entry-lotties/`
and `functions/entry-thumbnails/` cover eleven entrances, and the `tank`
entrance plus both gifts — six of the twenty-eight objects — exist nowhere but
the old bucket. Where a local copy does exist the script uses it as a fallback
if the URL is dead, and says so on the line.

### 5.3 Staff accounts

Firebase Auth users do not migrate between projects. The CRM accounts are
recreated, not moved.

- [ ] Open `backend/scripts/seed_accounts.py` and check the `OWNERS` list is the
      three owner emails you want.
- [ ] Put the SendGrid key in `backend/.env` for this one run —
      `SENDGRID_API_KEY=SG.…`. It is the only step that sends mail from your
      laptop rather than from Cloud Run, and without it the invitations do not
      go out.
- [ ] Run it:

      cd backend && python -m scripts.seed_accounts

      **You should see:** `firebase account created:` and `→ set-password email
      sent to` for each owner, then `crmUsers mirrored: … → superadmin`. The
      observer gets a record and no password — sign-in is a one-time code every
      time.

      If instead you see `⚠  could not email <address>`, the SendGrid key is
      missing or the sender is not verified. The account exists regardless; send
      the reset from **Authentication → the user → Reset password** in the
      console, which is what the warning says.
- [ ] **You should see** in the console: Authentication → Users lists all four,
      and Firestore → `crmUsers` has a document per owner.

### 5.4 Rules and indexes

- [ ] From the repo root:

      firebase deploy --only firestore:rules,firestore:indexes

      **You should see:** `firestore: released rules firestore.rules to
      cloud.firestore` and the indexes queued.
- [ ] **⛔ ORDER MATTERS.** Index builds take minutes to hours and queries that
      need them fail until the build finishes. Deploy these **before** the CRM,
      then check:

      firebase firestore:indexes

      Every index must read `READY`, not `CREATING`, before you trust a CRM page
      that says "no results".

- [ ] Storage rules:

      firebase deploy --only storage

---

## 6. The GCP side

### 6.1 gcloud

- [ ] Point the CLI at the new project. Every command in `DEPLOYMENT.md`
      assumes this is set.

      gcloud auth login                       # as 314zipper@gmail.com
      gcloud config set project <new-project-id>
      gcloud config list

      **You should see:** `project = <new-project-id>` and
      `account = 314zipper@gmail.com`.

### 6.2 Enable the APIs

The five you enabled today, plus the three a Functions deploy needs that are
easy to miss.

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com \
  artifactregistry.googleapis.com \
  cloudfunctions.googleapis.com \
  pubsub.googleapis.com \
  eventarc.googleapis.com
```

- [ ] Run it. It takes a minute or two and prints nothing on success.
- [ ] **You should see:**

      gcloud services list --enabled --format='value(config.name)' | sort

      all eight in the list.

### 6.3 IAM — this is what stopped you last time

The failure was: `roles/editor` on `dating-app-967f3` does **not** include
Secret Manager. `roles/editor` grants a great many things and `secretmanager.*`
is not among them — Secret Manager was designed with its own role family
precisely so that a broad project role does not confer access to secrets. You
needed `roles/owner`, or `roles/secretmanager.admin` granted specifically, and
you had neither.

On the new project **you are the creator, so you are `roles/owner` already** and
that particular wall is gone. Confirm it rather than assume it:

```bash
gcloud projects get-iam-policy $(gcloud config get-value project) \
  --flatten='bindings[].members' \
  --filter='bindings.members:314zipper@gmail.com' \
  --format='value(bindings.role)'
```

- [ ] **You should see:** `roles/owner`. If you see `roles/editor`, you are on
      the wrong project or signed in as the wrong account.

Two service account grants are still needed, and neither is automatic on a
project created this year.

```bash
PID=$(gcloud config get-value project)
PN=$(gcloud projects describe $PID --format='value(projectNumber)')
```

- [ ] **The build account.** `gcloud run deploy --source .` builds through Cloud
      Build using the compute service account, which on new projects starts with
      no build permissions and fails with a `PERMISSION_DENIED` on
      `storage.objects.get` that does not mention IAM anywhere.

      gcloud projects add-iam-policy-binding $PID \
        --member="serviceAccount:${PN}-compute@developer.gserviceaccount.com" \
        --role="roles/cloudbuild.builds.builder"

The second grant — letting Cloud Run read the secrets — is `DEPLOYMENT.md` § 3,
§ 8.2 and § 9.3 collapsed into one loop, and it has to wait until § 6.4 has
created the secrets. It is § 6.5 below.

- [ ] **You should see** after the build-account grant:

      gcloud projects get-iam-policy $PID \
        --flatten='bindings[].members' \
        --filter="bindings.members:${PN}-compute@developer.gserviceaccount.com" \
        --format='value(bindings.role)'

      including `roles/cloudbuild.builds.builder`.

### 6.4 The five secrets

Nothing about the values changes except that they are being created in a new
project. Full explanation of each is in
[`DEPLOYMENT.md` § 3](DEPLOYMENT.md#3-secrets), [§ 8](DEPLOYMENT.md#8-the-weekly-commission-accrual)
and [§ 9](DEPLOYMENT.md#9-the-scheduled-reports-alerts-and-transactional-email).
Read § 8 and § 9 before running these — the "same value in two places" rule is
the part that goes wrong.

- [ ] `MONGO_URI` — **unchanged**. Atlas is not part of this migration; the same
      cluster, the same connection string. Check the Atlas Network Access
      allowlist still permits Cloud Run's egress — it is IP-based and your new
      Cloud Run service gets new addresses, so if the allowlist is anything
      narrower than `0.0.0.0/0` it needs revisiting.
- [ ] `JWT_SECRET` — **mint a new one**. It signs CRM sessions. There are no
      sessions worth preserving and no reason to carry a secret out of a project
      you are leaving.
- [ ] `SENDGRID_API_KEY` — **unchanged**. SendGrid is a separate account.
      `MAIL_FROM` is `no-reply@zipperlive.org` (QA #47, owner decision 3 Nov 2026),
      on the domain authenticated there.
      Sending from an unverified address is a silent 403.
- [ ] `SERVICE_KEY_WEEKLY_ACCRUAL` — **mint a new one**, § 8.1.
- [ ] `SERVICE_KEY_REPORTING` — **mint a new one**, § 9.2. A **different value**
      from the accrual key. Never generate one and use it twice.

```bash
cd backend
echo -n "mongodb+srv://…"  | gcloud secrets create MONGO_URI --data-file=-
python3 -c 'import secrets;print(secrets.token_urlsafe(48))' \
                           | gcloud secrets create JWT_SECRET --data-file=-
echo -n "SG.…"             | gcloud secrets create SENDGRID_API_KEY --data-file=-
python3 -m scripts.generate_service_key --quiet \
                           | gcloud secrets create SERVICE_KEY_WEEKLY_ACCRUAL --data-file=-
python3 -m scripts.generate_service_key --credential reporting --quiet \
                           | gcloud secrets create SERVICE_KEY_REPORTING --data-file=-
```

- [ ] **You should see:** `gcloud secrets list` returning exactly those five.
      No value is ever printed by any of the above and none should be.

### 6.5 Let Cloud Run read them

**⛔ ORDER MATTERS.** These bindings are per-secret, so the secrets must exist
first. A Cloud Run deploy naming a secret it cannot read fails at container
start, not at deploy time — the deploy reports success and the revision never
serves traffic.

```bash
PID=$(gcloud config get-value project)
PN=$(gcloud projects describe $PID --format='value(projectNumber)')
for S in MONGO_URI JWT_SECRET SENDGRID_API_KEY \
         SERVICE_KEY_WEEKLY_ACCRUAL SERVICE_KEY_REPORTING; do
  gcloud secrets add-iam-policy-binding $S \
    --member="serviceAccount:${PN}-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done
```

- [ ] Run it.
- [ ] **You should see** five `Updated IAM policy for secret [...]` blocks, and:

      for S in MONGO_URI JWT_SECRET SENDGRID_API_KEY \
               SERVICE_KEY_WEEKLY_ACCRUAL SERVICE_KEY_REPORTING; do
        echo -n "$S: "
        gcloud secrets get-iam-policy $S --format='value(bindings.role)'
      done

      every line ending `roles/secretmanager.secretAccessor`.

---

## 7. Deploy

From here it is [`DEPLOYMENT.md`](DEPLOYMENT.md), in its own order. **Every
`D§` below is a section of that file, not of this one.** § 4 of *this* document
already rewrote every project id inside it, so those commands now name your new
project and you can copy them as they stand.

Run, in this order:

- [ ] **D§ 4** — the API to Cloud Run. `asia-south1`, all five secrets in one
      `--set-secrets` (it replaces the whole list; dropping one silently
      disables that machine identity).
- [ ] **D§ 8.4 and D§ 9.5** — copy the two service key *values* into the
      Functions runtime as `ZIPPER_ACCRUAL_KEY` and `ZIPPER_REPORTING_KEY`.
      Piped from Secret Manager, never typed, never displayed.
- [ ] **D§ 8.6 and D§ 9.6** — deploy the functions. This is what creates the
      eight Cloud Scheduler jobs. **⛔ ORDER MATTERS:** the secrets must exist
      before the deploy or it fails naming them.
- [ ] **D§ 5** — build the CRM and deploy Hosting.

      cd zipper-crm && npm run build && cd ..
      firebase deploy --only hosting

      Because § 4 of this document turned `firebase.json`'s `hosting` into an
      array with `"target": "production"` and `.firebaserc` maps that target to
      the `zipper` site, this publishes to `zipper.web.app`. If it publishes to
      `<project-id>.web.app` instead, the target did not take — check
      `.firebaserc`.

**Skip D§ 1, D§ 2, D§ 3, D§ 6 and D§ 7.** § 3 here did the Hosting site, Atlas
does not move, § 6.4 here created the secrets, § 5.3 seeded the accounts and
§ 5.4 deployed rules and indexes. Running them again is not harmful, only
confusing.

Do Hosting the same evening as the functions, not the next day.
`functions/.env`'s `ZIPPER_API_BASE_URL` is now `https://zipper.web.app`, and
the scheduled jobs start calling it within fifteen minutes of the functions
deploy. Until Hosting is published that hostname 404s, and the first few runs
log an error and send nothing. Nothing is lost — the sweep is idempotent and
picks the work up on its next pass — but it is an alarming log to read if you
do not know why.

**What changes versus the old project:** nothing but the project id and the
Hosting hostname, both already rewritten. Same regions, same secret names, same
schedules, same `asia-south1` for Cloud Run.

**What does not move at all:** MongoDB Atlas, SendGrid, and the Android app's
package name.

---

## 8. Verify

Do these in order; each one depends on the last.

- [ ] **Region — the thing you cannot fix later.**

      gcloud firestore databases describe --database='(default)' \
        --format='value(locationId)'                  # asia-south1
      gcloud storage buckets describe gs://<bucket> \
        --format='value(location)'                    # ASIA-SOUTH1

- [ ] **The site exists and is yours.**

      firebase hosting:sites:list                     # zipper, in the new project

- [ ] **The API is up.**

      curl https://zipper.web.app/api/health          # {"status":"ok"}

- [ ] **All eight scheduled jobs exist and are enabled.**

      gcloud scheduler jobs list --location=us-central1 \
        --format='table(name, schedule, timeZone, state)'

      Eight rows, all `ENABLED`. Six on `Asia/Kolkata`, two on `UTC` — that is
      correct and `DEPLOYMENT.md`'s deploy-order table says why.

- [ ] **Both service keys are accepted.** `DEPLOYMENT.md` § 8.7 → `200`, and
      § 9.7 → `200`. A `401` means the two sides hold different values; a `403`
      means a valid key reached outside its allowlist and you used the wrong one.

- [ ] **CRM sign-in.** Open `https://zipper.web.app`, sign in as an owner, land
      on the sign-off queue. If you get `auth/unauthorized-domain`, § 2.4 was
      skipped.

- [ ] **The assets render.** CRM → **Gifts** and → **Tech → Content**. Every
      thumbnail loads and every Lottie preview plays. This is the check that
      § 5.2 actually worked end to end, because it exercises the token.

- [ ] **The economy is right.** CRM → Economy Config. The commission slabs read
      "₹50,00,000 and above" on the top band, not "₹50,00,000".

- [ ] **The Android app.** Rebuild it — `google-services.json` changed, so a
      cached build will still talk to the old project:

      cd zipper-app && ./gradlew clean assembleDebug

      On a device, all four sign-in paths:
      - [ ] Continue as Guest → profile setup (Anonymous)
      - [ ] Phone number → OTP arrives → signed in (Phone)
      - [ ] Continue with Google → account picker → signed in (Google + the
            SHA-1 from § 2.5; a `10:` error here means the fingerprint is
            missing or `default_web_client_id` in `strings.xml` is wrong)
      - [ ] Gift tray shows images; an entrance animation plays

- [ ] **Observer path.** `/observer` → request a code → it arrives at
      `soumyars675@gmail.com` → signs in → sees everything, no action buttons.

- [ ] **The morning after**, `GET /api/notifications/runs/last` shows `alerts`
      and `transactional-sweep` with a real `last_run_at`. Anything still
      reading `never` past its first scheduled time did not fire.

---

## 9. What cannot be scripted

Three things, and only three. Each has one exact action.

1. **Creating the project, attaching Blaze, creating Firestore and Storage in
   `asia-south1`, turning on the four Auth providers, and downloading
   `serviceAccountKey.json` and `google-services.json`** — console only, because
   each of them either needs browser-authenticated billing consent, or picks a
   location that no API will let you change afterwards, or mints a credential.
   → § 1, § 2.1, § 2.2, § 2.3, § 2.5, § 2.6.
2. **Adding the Android debug SHA-1 fingerprint** — Firebase has no public API
   for it. → Project settings → General → the Android app → **Add fingerprint**,
   pasting the SHA1 from `./gradlew signingReport`.
3. **Adding `zipper.web.app` to the Auth authorized domains** — a second Hosting
   site's domain is never auto-authorised. → Authentication → Settings →
   Authorized domains → **Add domain**.

Everything else in this document is a command, and everything that rewrites a
file dry-runs by default.

---

## 10. The old project

**Do not delete it.** Not this week, probably not ever by your hand.

### Keep

- `backend/backups/firestore-<today>-<time>/` — the export from § 0. Copy it
  somewhere off this machine. It is gitignored and it is the only complete
  record of what was in the old database.
- `serviceAccountKey.old.json` — until § 8 (Verify) passes in full. Then delete it; a
  live private key for somebody else's project is a liability, not an asset.
- `zipper-crm/scripts/uploaded-urls.json` — historical, harmless, left alone by
  the retarget script on purpose.
- The 28 assets are now in your bucket, uploaded by § 5.2 with tokens you own.
  That is the copy that matters and it no longer depends on the old project
  existing.

### When it is safe to stop caring

Not when the CRM loads. Wait for all of:

- [ ] Every box in § 8 (Verify) ticked, including the Android device tests.
- [ ] One full Monday has passed with the weekly business report and the partner
      statements delivered from the new project.
- [ ] One Sunday accrual has run and `weeklyPayoutReports/<week>` shows
      `commissionAccrual.status: "completed"`.

That is roughly a week. Until then the old project is your rollback, and a
rollback you have deleted is not one.

### Then

- [ ] Remove the old project from the CLI so a stray command cannot reach it:

      firebase projects:list          # confirm the new one is the default
      gcloud config get-value project # confirm the same

- [ ] `rm serviceAccountKey.old.json`
- [ ] Stop referencing it anywhere. Nothing in the repo does after § 4.

### About the money

You are not paying for it. `dating-app-967f3`'s billing is attached to its
owner's account, not yours, so leaving it running costs you nothing and there is
no invoice to cancel. At the volumes involved it costs them nothing either.

**Deleting it is not yours to do and not worth doing.** You may not have the
permission — you did not have Secret Manager access, which suggests
`roles/editor` and not `roles/owner`. Even if you did: deletion starts a 30-day
recovery window during which the project is unreachable but not gone, it takes
the Firebase Auth users and the asset objects with it, and it buys you nothing
you do not already have. Leave it. If the owner ever deletes it, everything you
need is already in your project and in `backend/backups/`.
