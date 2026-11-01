# Open product decisions — Phase 1A

**Status: OPEN.** Nothing below has a default in the code. Each capability stays unbuilt, or keeps its current behaviour, until the product owner answers. Recorded 2026-10-14.

---

## D1. Who approves a change to a user's phone number or email? (CONTACT-003)

**Question.** A user asks to replace the verified phone or email on their account. Which department makes that decision?

- Support?
- Ops?
- The Owner?
- Nobody — the user self-serves after OTP?

**Today.** No contact change can be made from the app.

- The rules allow a client to write `email` or `phoneNumber` only when the value equals the verified value on its own sign-in token.
- Server bind flows (`bindVerifiedIdentity`, `adoptEmailAccount`) can attach a missing contact detail. They cannot replace an existing one.

**Consequences of each answer.**

- **Support or Ops approves.** We need:
  - a request queue and an audit action;
  - a backend endpoint for the department's permission;
  - an Admin-SDK write that also updates the Firebase Auth record and `phoneKey`;
  - revocation of quick-login credentials and live sessions afterwards.
- **Owner approves.** The same as above, but it goes through the Owner queue. Slower, highest assurance.
- **Self-serve.** A user who controls the new contact can move the account to it. The control then rests entirely on D2.

## D2. Must the OLD contact be verified before it is replaced?

**Question.** Must the user prove they still hold the current phone or email (OTP to the old one) before it is replaced?

**Consequences.**

- **Yes.** This is the strongest defence against account takeover through a stolen session. It fails the user who has genuinely lost the old number; they would need the D1 department to override, with evidence.
- **No.** It is easier for a user who lost the old number. A stolen live session, or a guessed quick-login, becomes enough to move the account permanently to the attacker's number.

## D3. Merging two existing Firebase accounts that belong to one person (ROLE-001 remainder)

**Question.** When one human holds two existing Firebase uids (for example an old phone-OTP app account and a CRM email account), may they be merged? If yes:

- Who authorises the merge?
- Which uid survives?
- What happens to the other uid's balances, history, followers, host or partner roles and audit trail?

**Today.**

- Phase 1A blocks creating a *new* second identity: staff cannot hold partner roles, and an existing partner or host cannot be invited as staff.
- Two uids that already exist are **not** merged automatically, and no merge tool exists.

**Consequences.**

- Any merge is a data migration across Firestore, Mongo, Firebase Auth, Storage paths and the audit log.
- Money and roles on the losing uid need an explicit rule. A merge that moves money must go through the Owner money queue (CRM-FLOW 9.48).
- If merging is never allowed, the person keeps two accounts and must use the one that holds the role.

## D4. Recovering a guest account that was displaced by another device

**Question.** A guest (anonymous, no phone or email) is signed in on device A. The same guest account becomes active on device B. How, if at all, does device A get the guest account back?

**Today.**

- The one-device rule displaces A.
- A displaced **provider** account (phone, email, Google) can no longer mint a quick sign-in credential from the displaced device; it must sign in again with its provider.
- **Guests are deliberately exempt** from that refusal (`quickLoginMintRefusal` in `functions/src/mobileSession.ts`). An anonymous credential cannot be re-obtained by any other means, so refusing would destroy the guest account.

**Consequences.**

- **Keep the exemption.** A displaced guest device can come back with one tap and displace B. The rule becomes "whoever taps last wins" — for guests only.
- **Remove it.** The displaced guest device loses the account permanently unless the guest had added a phone or email.
- **Middle option.** Allow the way back only on the device the guest was *bound* to (`guestDeviceBindings`), and refuse it on any other device.

  This needs a decision on what happens when the bound device is the displaced one.

Whichever is chosen, the server function and its test are already isolated, so the change is local.
