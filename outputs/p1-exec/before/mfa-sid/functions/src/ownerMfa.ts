/**
 * P1-A3b — the Owner MFA boundary, for Cloud Functions.
 *
 * Mirrors `ownerMfaOk()` in firestore.rules / storage.rules. The backend
 * (`backend/app/services/owner_mfa.py`) writes the server-only document
 * `ownerMfaSessions/{uid}` when an Owner passes MFA, binding THAT Firebase
 * sign-in (auth_time + sign-in provider) to an MFA-verified API session:
 *
 *   active["<auth_time>:<provider>"] = latest expiry of the live bindings
 *
 * An Owner callable must check it, because `crmUsers.role == 'superadmin'`
 * alone is true for a password-only sign-in that never passed MFA.
 */

/** The token fields the binding key is built from (same as the rules). */
export interface OwnerMfaToken {
  auth_time?: number
  firebase?: { sign_in_provider?: string }
}

export function ownerMfaKey(token: OwnerMfaToken | undefined): string {
  const authTime = token?.auth_time ?? 0
  const provider = token?.firebase?.sign_in_provider ?? ''
  return `${authTime}:${provider}`
}

function toMillis(v: unknown): number {
  if (v == null) return 0
  if (typeof v === 'number') return v
  if (v instanceof Date) return v.getTime()
  const t = v as { toMillis?: () => number }
  return typeof t.toMillis === 'function' ? t.toMillis() : 0
}

/** Is this sign-in bound and unexpired in the given ownerMfaSessions data? */
export function ownerMfaBindingValid(
  data: { active?: Record<string, unknown> } | undefined,
  token: OwnerMfaToken | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!data || !token) return false
  const expiry = toMillis((data.active ?? {})[ownerMfaKey(token)])
  return expiry > nowMs
}

/** Minimal Firestore surface, so tests can pass a fake. */
interface DocReader {
  collection(name: string): { doc(id: string): { get(): Promise<{ exists: boolean; data(): unknown }> } }
}

/** Read the binding document and decide. Never throws: an unreadable document is "not verified". */
export async function ownerMfaVerified(
  db: DocReader,
  uid: string,
  token: OwnerMfaToken | undefined,
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    const snap = await db.collection('ownerMfaSessions').doc(uid).get()
    if (!snap.exists) return false
    return ownerMfaBindingValid(snap.data() as { active?: Record<string, unknown> }, token, nowMs)
  } catch {
    return false
  }
}
