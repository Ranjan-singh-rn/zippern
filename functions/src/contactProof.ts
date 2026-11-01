/**
 * Decision 15 (RC) — are a login's phone AND email bound to it and verified?
 *
 * The TypeScript twin of `backend/app/services/contact_verification.py`. The
 * two must answer the same question the same way; `test/rcContactProof.test.js`
 * runs the same matrix the Python suite runs.
 *
 * A partner role (Agency, Sub-agency, Host, Coin Seller) starts only when the
 * login that holds it has BOTH a verified phone and a verified email, each
 * proved on its own.
 *
 * ── WHERE THE ANSWER COMES FROM ──────────────────────────────────────────────
 *
 * Never a typed contact, a form field, `users/{uid}`, `crmUsers` or a partner
 * record. Only the Firebase Auth RECORD of the uid and the server-written
 * ledger `contactVerifications/{uid}`.
 *
 *   * Phone: the Auth record holds `phoneNumber`. Firebase sets it only
 *     through an SMS credential; no server path in this repository sets one
 *     (pinned by tests on both sides).
 *   * Email: the Auth record holds the address with `emailVerified`, AND one of
 *       1. the ledger records OUR 6-digit code for that exact address
 *          (`email_code` — `verifyEmailBindCode` / `verifyLoginEmailCode`);
 *       2. a Google sign-in method carries that same address (`google`);
 *       3. the account has no password sign-in method at all
 *          (`no_password_provider` — a reset link can only touch a password
 *          account, so `emailVerified` there came from our code or Google).
 *     Sending login credentials or a password-reset link proves nothing, and
 *     neither does `emailVerified` alone on a password account.
 */
import * as admin from 'firebase-admin'

export const CONTACT_LEDGER = 'contactVerifications'
export const CONTACT_VERIFICATION_REQUIRED = 'CONTACT_VERIFICATION_REQUIRED'

export type EmailMethod = 'email_code' | 'google' | 'no_password_provider' | ''

export interface ProviderInfo { providerId?: string; email?: string | null }

function key(v: unknown): string {
  return String(v ?? '').trim().toLowerCase()
}

/** Pure — does the email count, and how was it proved? */
export function emailProof(p: {
  authEmail?: string | null
  emailVerified?: boolean
  providers?: ProviderInfo[]
  ledgerAddress?: string | null
}): { verified: boolean; method: EmailMethod; unproved: boolean } {
  const email = key(p.authEmail)
  if (!email) return { verified: false, method: '', unproved: false }
  if (p.emailVerified !== true) return { verified: false, method: '', unproved: true }
  const providers = (p.providers ?? []).map((x) => ({ id: String(x?.providerId ?? ''), email: key(x?.email) }))
  if (key(p.ledgerAddress) !== '' && key(p.ledgerAddress) === email) {
    return { verified: true, method: 'email_code', unproved: false }
  }
  if (providers.some((x) => x.id === 'google.com' && x.email === email)) {
    return { verified: true, method: 'google', unproved: false }
  }
  if (!providers.some((x) => x.id === 'password')) {
    return { verified: true, method: 'no_password_provider', unproved: false }
  }
  return { verified: false, method: '', unproved: true }
}

export interface ContactProof {
  phoneVerified: boolean
  emailVerified: boolean
  emailMethod: EmailMethod
  emailUnproved: boolean
  complete: boolean
  missing: Array<'phone' | 'email'>
}

/** Pure — the whole answer from what the Auth record and the ledger hold. */
export function contactProof(p: {
  phone?: string | null
  authEmail?: string | null
  emailVerified?: boolean
  providers?: ProviderInfo[]
  ledgerAddress?: string | null
}): ContactProof {
  const phoneVerified = String(p.phone ?? '').trim() !== ''
  const e = emailProof(p)
  const missing: Array<'phone' | 'email'> = []
  if (!phoneVerified) missing.push('phone')
  if (!e.verified) missing.push('email')
  return {
    phoneVerified,
    emailVerified: e.verified,
    emailMethod: e.method,
    emailUnproved: e.unproved,
    complete: phoneVerified && e.verified,
    missing,
  }
}

/** The answer for a uid. Unknown is not verified: a read failure proves nothing. */
export async function contactProofFor(uid: string): Promise<ContactProof> {
  let rec: admin.auth.UserRecord | null = null
  try {
    rec = await admin.auth().getUser(uid)
  } catch {
    rec = null
  }
  if (!rec) return contactProof({})
  let ledgerAddress = ''
  if (rec.email && rec.emailVerified) {
    try {
      const snap = await admin.firestore().collection(CONTACT_LEDGER).doc(uid).get()
      const email = snap.exists ? (snap.get('email') as { address?: unknown } | undefined) : undefined
      ledgerAddress = key(email?.address)
    } catch {
      ledgerAddress = ''
    }
  }
  return contactProof({
    phone: rec.phoneNumber ?? '',
    authEmail: rec.email ?? '',
    emailVerified: rec.emailVerified === true,
    providers: (rec.providerData ?? []).map((x) => ({ providerId: x.providerId, email: x.email })),
    ledgerAddress,
  })
}

/** Record that OUR 6-digit code proved this address for this uid. Server-only collection. */
export async function recordEmailProof(uid: string, address: string): Promise<void> {
  const now = admin.firestore.FieldValue.serverTimestamp()
  await admin.firestore().collection(CONTACT_LEDGER).doc(uid).set({
    email: { address: key(address), verifiedAt: now, method: 'email_code' },
    updatedAt: now,
  }, { merge: true })
}
