# Registering the app's fingerprints in Firebase

Package name: **`com.zipper.app`** (`app/build.gradle.kts` → `applicationId`)
Firebase project: **`zipper-83816`**

Ignore `com.zipper.datingapp` if you see it — a leftover registration from the
old project. Nothing builds under it.

---

## Why fingerprints are needed at all

Two things break without them, and neither error names the cause:

- **Phone OTP** — Firebase verifies the app with Play Integrity, keyed on the
  signing certificate. Without a matching fingerprint you get a reCAPTCHA
  fallback in a browser, or `auth/app-not-authorized`.
- **Google Sign-In** — Google mints the ID token against an OAuth client bound
  to your SHA-1. No fingerprint, no client, and sign-in fails immediately.

Both need **SHA-1 and SHA-256**. SHA-1 is the older requirement; SHA-256 is
what Play Integrity actually uses. Add both, every time.

---

## 1. Debug fingerprint — needed to test on your own machine

```bash
cd ~/Documents/Projects/zippern/zipper-app
./gradlew signingReport
```

Look for the block headed `Variant: debug` / `Config: debug` and copy its
**SHA1** and **SHA-256**.

If Gradle is awkward, read the keystore directly — every Mac with Android
Studio has the same one:

```bash
keytool -list -v \
  -keystore ~/.android/debug.keystore \
  -alias androiddebugkey \
  -storepass android -keypass android
```

This certificate is **not a secret**. It is the same on every developer machine
and is safe to paste into the Firebase console.

---

## 2. Release fingerprint — DONE

The keystore exists at `zipper-app/zipper-release.jks`, alias `zipper`,
certificate valid to **23 January 2054**. It is git-ignored (`*.jks`) and its
credentials are in `local.properties`, which is git-ignored too.

It was created with the command below. Kept for reference — **do not run it
again**, it would overwrite the key and orphan every build ever signed with the
current one:

```bash
cd ~/Documents/Projects/zippern/zipper-app
keytool -genkeypair -v \
  -keystore zipper-release.jks \
  -alias zipper \
  -keyalg RSA -keysize 4096 -validity 10000
```

It asks for a password, your name and your organisation. Answer honestly — the
values appear in the certificate.

> **This file is the app's identity for its entire life.**
> Lose it and you cannot ship an update to your own app on Google Play, ever.
> There is no recovery and no appeal. Back it up somewhere that is not this
> laptop — and keep the passwords with it, because the file alone is useless.

Then put the details in `zipper-app/local.properties`, which is **not** in git:

```properties
# Relative to zipper-app/ — it is its own Gradle root (it has its own
# settings.gradle.kts and gradlew), so `rootProject.file()` already resolves
# from there. Writing `zipper-app/zipper-release.jks` here looks right and
# resolves to zipper-app/zipper-app/… , which does not exist — the build then
# warns "no release keystore configured" and silently produces an unsigned APK.
release.storeFile=zipper-release.jks
release.storePassword=<the store password>
release.keyAlias=zipper
release.keyPassword=<the key password>
```

`app/build.gradle.kts` reads those (or the `RELEASE_STORE_*` environment
variables for CI). With none set, release stays unsigned and Gradle warns
rather than failing, so a debug build on a machine without the keystore still
works.

Add the keystore to `.gitignore` if it is not already covered:

```
*.jks
*.keystore
```

Re-read them any time with:

```bash
keytool -list -v -keystore zipper-release.jks -alias zipper
```

---

## The fingerprints themselves

Not secret — a certificate fingerprint is public by design. Safe to paste into
the Firebase console, a Play listing or a support ticket.

### Debug — `~/.android/debug.keystore`, alias `AndroidDebugKey`

```
SHA-1
3F:B7:DB:E0:80:08:FF:21:A7:1D:F2:9F:BC:E7:A9:3E:F4:84:09:2A

SHA-256
48:78:A3:5F:A2:B4:D8:A0:A6:BC:AB:84:F2:2B:66:31:23:85:FE:02:52:36:03:EA:23:D3:E1:90:FC:19:48:AF
```

### Release — `zipper-app/zipper-release.jks`, alias `zipper`

```
SHA-1
83:EC:5A:2B:43:C9:73:5C:49:1E:A2:DE:EC:6F:96:43:43:43:E1:3C

SHA-256
DB:31:A0:36:E1:BF:84:1E:F2:84:95:AC:B0:CD:5F:0D:56:A8:C3:D2:A0:55:57:FB:F9:C4:03:DA:0D:F2:FB:D4
```

All four go into Firebase. The debug pair lets you test on this machine; the
release pair covers any APK you hand to somebody directly.

---

## Backing up the release key

```bash
cd ~/Documents/Projects/zippern/zipper-app
./backup-signing-key.sh
```

Copies the keystore into `~/Downloads/zipper-signing-backup-<date>/` with a
`READ-ME-FIRST.txt` holding the passwords, the fingerprints and restore
instructions. It then **verifies** the copy: checksums it against the original
and re-opens it with the stored password, so a wrong password in
`local.properties` is caught now rather than in three years when it is the only
thing standing between you and shipping an update.

Move the folder to an external disk and delete it from Downloads. Downloads is
the folder most likely to be swept into iCloud or Google Drive, and this folder
holds the key and its password together — anyone with both can publish an
update to Zipper.

---

## 3. A third fingerprint, once you are on Google Play

If you use **Play App Signing** — mandatory for new apps — Google re-signs your
upload with a key it holds. So the certificate users actually run is **not**
yours, and its SHA-1 is the one Firebase must trust.

Play Console → your app → **Test and release → Setup → App signing**. Copy the
SHA-1 and SHA-256 under *App signing key certificate* and add those too.

Miss this and everything works in testing and fails the moment the app is
installed from Play — the single most common reason for "it worked yesterday"
after a first release.

---

## 4. Adding them in Firebase

Firebase Console → **zipper-83816** → gear → **Project settings** → *Your apps*
→ the Android app → **Add fingerprint**. One at a time:

| Which | When it matters |
|---|---|
| debug SHA-1 + SHA-256 | testing on your own machine |
| release SHA-1 + SHA-256 | an APK you hand to somebody |
| Play App Signing SHA-1 + SHA-256 | anything installed from Play |

**Then download `google-services.json` again** and replace
`zipper-app/app/google-services.json`.

This part is easy to skip. The file you have now contains **no** Android OAuth
clients, because none existed when it was generated. Adding a fingerprint
creates one — but only a fresh download carries it. An old JSON with a new
fingerprint registered still fails Google Sign-In.

---

## 5. Check it took

```bash
cd ~/Documents/Projects/zippern/zipper-app
python3 - <<'PY'
import json
d = json.load(open('app/google-services.json'))
print('project:', d['project_info']['project_id'])
for c in d['client']:
    print('package:', c['client_info']['android_client_info']['package_name'])
    android = [o for o in c.get('oauth_client', []) if o.get('android_info')]
    web = [o for o in c.get('oauth_client', []) if o.get('client_type') == 3]
    print('  android oauth clients (one per fingerprint):', len(android))
    print('  web client for Google Sign-In:', 'present' if web else 'MISSING')
PY
```

`android oauth clients` should equal the number of fingerprints you added. If
it is `0`, the download did not pick them up — re-download.

### Then check what the build actually generated

Swapping the JSON is only half of it. The google-services plugin turns that
file into `app/build/generated/res/processDebugGoogleServices/values/values.xml`,
and **that** is what the app reads at runtime. A stale copy of it will still be
sitting in `build/` from the previous project.

```bash
cd ~/Documents/Projects/zippern/zipper-app
./gradlew clean
./gradlew assembleDebug
cat app/build/generated/res/processDebugGoogleServices/values/values.xml
```

Every value must say `zipper-83816` / `239458555881`. If you see
`dating-app-967f3` or `344965230552`, the plugin did not re-run — `clean`
again. Gradle usually notices the changed input, but "usually" is doing real
work in that sentence, and the failure mode is an app that connects to the old
project while every file on disk says otherwise.

---

## One thing already fixed

`app/src/main/res/values/strings.xml` used to hardcode `default_web_client_id`
against the **old** project's OAuth client. The google-services plugin
generates that same string, and a hand-written one in the main source set
silently overrides it.

So swapping `google-services.json` repointed Auth, Firestore, Storage and
Messaging correctly — and Google Sign-In went on requesting a token minted for
the old project, failing with an audience mismatch on every device, pointing at
the credential library rather than at a string resource.

It is deleted. The plugin owns it now, so it is derived from whichever project
`google-services.json` names and cannot drift again.
