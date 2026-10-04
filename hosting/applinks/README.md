# `zipper-83816.firebaseapp.com` — the Android App Links site

This directory exists to serve **one file**:

    /.well-known/assetlinks.json

It is deployed to the project's DEFAULT hosting site (`zipper-83816`), which is
also the Firebase **Auth domain**. Not to `zipperlive` — that is the CRM, and it
is a different site.

## Why it has to be this host, specifically

Guest email binding in the Android app uses Firebase's email-link sign-in. The
link Firebase puts in that email is generated on the project's auth domain:

    https://zipper-83816.firebaseapp.com/__/auth/links?...

Android verifies an App Link against `/.well-known/assetlinks.json` **on the
host in the link**. So the file has to be on `zipper-83816.firebaseapp.com`.
There is no way to move it to `zipperlive` without changing the project's auth
domain, which would also move CRM Google sign-in and phone-auth reCAPTCHA.

Before this directory existed, that host returned Firebase's **"Site Not
Found"** page — the default site had never been deployed to. So the email link
opened a browser instead of the app, which presents to the user as "I tapped the
link and nothing happened".

## The two fingerprints

`sha256_cert_fingerprints` holds BOTH the debug and the release signing
certificates, because they are different certificates and App Links are verified
per-certificate. A debug build installed for testing will not verify against the
release fingerprint alone.

Get them with:

    cd zipper-app && ./gradlew signingReport

Read `SHA-256` under `Variant: debug` and `Variant: release`. If the release
keystore is ever rotated, this file must be updated in the same change — nothing
else will notice, and the failure is silent.

## Why the file is checked in rather than auto-generated

Firebase Hosting can generate this file itself from the fingerprints registered
in the project (`appAssociation: "AUTO"`, which is the default). Two reasons it
is explicit here instead:

1. It only generates fingerprints that were entered in the console. The project
   currently has both SHA-1s registered — `google-services.json` proves that,
   since the OAuth clients are keyed on them — but SHA-1 registration does not
   imply SHA-256 registration, and `google-services.json` records no SHA-256 at
   all, so there is no way to confirm from the repository what the console
   holds.
2. A file in version control can be reviewed, diffed and explained. A generated
   one changes when somebody edits console settings, with no trace here.

An explicitly deployed `/.well-known/assetlinks.json` takes precedence over the
generated one.

## Deploying

    firebase deploy --only hosting:applinks

Then verify — do not assume:

    curl -s https://zipper-83816.firebaseapp.com/.well-known/assetlinks.json

It must return this JSON with `content-type: application/json`, over HTTPS, with
no redirect. Android follows none of those.
