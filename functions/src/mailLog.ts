/**
 * Send-once markers for the partner emails, and the weekly report's recipients.
 *
 * ── F-20: one email per (document, kind) ─────────────────────────────────────
 *
 * Firestore triggers are delivered AT LEAST ONCE, and a re-delivered event
 * carries the same before/after payload — so the event cannot say whether its
 * email already went. A marker can. Before sending, the trigger CREATES
 * `mailLog/{docId}_{kind}`; `create()` is atomic and fails if the document
 * exists, so of two deliveries exactly one sends. The marker is then settled:
 *
 *   sent            the provider accepted it — never sent again;
 *   unknown         the provider MAY have accepted it (a timeout, a 5xx) —
 *                   never sent again automatically: a missing email can be
 *                   re-requested, a duplicate cannot be taken back;
 *   failed          provably not sent (no key, a refusal, no connection) — a
 *                   later delivery or an explicit resend may claim it again.
 *
 * Because the marker is per (document, kind), "approved" is sent once per
 * partner: a reactivation (suspended → approved) is a transition the trigger
 * sees, but its email is the API's `role.resumed` notice, not a second
 * "you're approved — log in" message.
 *
 * The marker holds no address (only its domain), no subject, no body.
 *
 * ── F-17: the weekly report goes to every active Owner ──────────────────────
 *
 * `crmUsers` with role `superadmin` (the CRM's Owner) and `isActive != false`.
 * No hard-coded fallback address: when no Owner has an address the report is
 * logged and not emailed — a visible configuration gap, not mail to whichever
 * address was once typed into the code.
 */
import * as admin from 'firebase-admin'
import { type MailIdentity, MailSendError, mailDomain } from './mail'

export const MAIL_LOG = 'mailLog'

export type MailMarkerStatus = 'sending' | 'sent' | 'failed' | 'unknown'

export interface MailClaim {
  ref: admin.firestore.DocumentReference
  attempt: number
}

/** The SDK's "document already exists" — gRPC status 6 (`ALREADY_EXISTS`). */
function alreadyExists(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null
  return e?.code === 6 || e?.code === 'already-exists' || /ALREADY_EXISTS/.test(String(e?.message ?? ''))
}

/** The marker id: `{docId}_{kind}`, with nothing that is not a plain id character. */
export function mailLogId(docId: string, kind: string): string {
  const clean = (s: string) => String(s ?? '').replace(/[^A-Za-z0-9_.-]/g, '-')
  return `${clean(docId)}_${clean(kind)}`
}

/**
 * Claim the right to send `kind` for `docId`. Null: already sent (or possibly
 * sent, or being sent by another delivery) — do not send.
 */
export async function claimMail(
  db: admin.firestore.Firestore,
  docId: string,
  kind: string,
  info: { collection: string; to: string; identity: MailIdentity },
): Promise<MailClaim | null> {
  const ref = db.collection(MAIL_LOG).doc(mailLogId(docId, kind))
  const now = admin.firestore.FieldValue.serverTimestamp()
  try {
    await ref.create({
      docId, kind, collection: info.collection, identity: info.identity,
      toDomain: mailDomain(info.to), status: 'sending' as MailMarkerStatus, attempts: 1, claimedAt: now,
    })
    return { ref, attempt: 1 }
  } catch (err) {
    if (!alreadyExists(err)) throw err
  }
  // Already claimed. Only a provably-unsent one ('failed') may be taken over.
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists || snap.get('status') !== 'failed') return null
    const attempt = Number(snap.get('attempts') ?? 1) + 1
    tx.update(ref, { status: 'sending', attempts: attempt, claimedAt: now, toDomain: mailDomain(info.to) })
    return { ref, attempt }
  })
}

/** Close a claim with what the provider said. Never throws. */
export async function settleMail(
  claim: MailClaim,
  outcome: 'sent' | 'not_configured' | 'error',
  err?: unknown,
): Promise<MailMarkerStatus> {
  let status: MailMarkerStatus = 'sent'
  let code = ''
  if (outcome === 'not_configured') {
    status = 'failed'
    code = 'not_configured'
  } else if (outcome === 'error') {
    const failed = err instanceof MailSendError ? err : null
    status = failed && !failed.outcomeUnknown ? 'failed' : 'unknown'
    code = failed ? failed.code : 'error'
  }
  try {
    await claim.ref.update({
      status, settledAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(code ? { error: code } : {}),
    })
  } catch {
    // The marker stays `sending`, which blocks a resend: the safe side.
  }
  return status
}

export type SendOnceResult = 'sent' | 'duplicate' | 'no_address' | MailMarkerStatus

/**
 * Send `kind` for `docId` at most once (see the module comment). `send` is the
 * caller's mail function — `sendNotificationMail` in production. Never throws:
 * a failed send is logged by the mail module and recorded on the marker.
 */
export async function sendOnce(
  db: admin.firestore.Firestore,
  m: {
    docId: string
    kind: string
    collection: string
    to: string
    subject: string
    html: string
    identity: MailIdentity
    send: (to: string, subject: string, html: string, identity: MailIdentity) => Promise<'sent' | 'not_configured' | void>
  },
): Promise<SendOnceResult> {
  if (!m.to || !m.to.includes('@')) return 'no_address'
  let claim: MailClaim | null
  try {
    claim = await claimMail(db, m.docId, m.kind, { collection: m.collection, to: m.to, identity: m.identity })
  } catch {
    // The marker store is unreachable: do not send blind — a re-delivery or a
    // resend can try again; a duplicate cannot be taken back.
    return 'failed'
  }
  if (!claim) return 'duplicate'
  try {
    const result = await m.send(m.to, m.subject, m.html, m.identity)
    return settleMail(claim, result === 'not_configured' ? 'not_configured' : 'sent')
  } catch (err) {
    return settleMail(claim, 'error', err)
  }
}

/**
 * Every active Owner's address: `crmUsers` role `superadmin`, `isActive` not
 * false (a missing field is active, as everywhere else in the CRM), with an
 * address. Lower-cased and de-duplicated. Empty when there is none — the
 * caller logs and skips; there is no fallback.
 */
export async function activeOwnerEmails(db: admin.firestore.Firestore): Promise<string[]> {
  const snap = await db.collection('crmUsers').where('role', '==', 'superadmin').get()
  const out = new Set<string>()
  for (const doc of snap.docs) {
    const d = doc.data() ?? {}
    if (d.isActive === false) continue
    const email = String(d.email ?? '').trim().toLowerCase()
    if (email.includes('@') && !email.startsWith('@') && !email.endsWith('@')) out.add(email)
  }
  return [...out].sort()
}
