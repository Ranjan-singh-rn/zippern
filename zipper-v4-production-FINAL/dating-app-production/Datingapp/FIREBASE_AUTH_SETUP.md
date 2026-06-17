# Firebase Auth setup for local debug builds

If phone OTP or Google sign-in fails with `INVALID_CERT_HASH`, `17093`, or Google status `10`, Firebase does not recognize the certificate used to sign the APK installed on the device.

Add this debug certificate to Firebase Console:

1. Open Firebase Console -> Project settings -> General.
2. Under Android app `com.zipper.datingapp`, add these fingerprints:
   - SHA-1: `3F:B7:DB:E0:80:08:FF:21:A7:1D:F2:9F:BC:E7:A9:3E:F4:84:09:2A`
   - SHA-256: `48:78:A3:5F:A2:B4:D8:A0:A6:BC:AB:84:F2:2B:66:31:23:85:FE:02:52:36:03:EA:23:D3:E1:90:FC:19:48:AF`
3. Download the updated `google-services.json`.
4. Replace `app/google-services.json` with the downloaded file.
5. Rebuild and reinstall the app.

To verify the local signing fingerprints later:

```bash
./gradlew signingReport
```

The current checked-in `google-services.json` contains only this Android OAuth certificate hash:

```text
b88065fa1a0415fdbcc11ac6ea2c8d85eabac376
```

That does not match the local debug SHA-1 above, so Firebase Auth will reject local phone reCAPTCHA and Google sign-in until the Firebase app config is updated.

The Firestore rules in `firebase/firestore.rules` require `request.auth != null` for app data reads. If login is blocked by the cert hash mismatch, Firestore listeners will also report `PERMISSION_DENIED`.
