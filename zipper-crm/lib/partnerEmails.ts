import { db } from '@/lib/firebase'
import { doc, updateDoc } from 'firebase/firestore'

/** Which of the two partner emails to send again. */
export type ResendKind = 'registration' | 'approval'

/**
 * Ask the server to send a partner's registration or approval email again.
 *
 * ── WHY IT IS A FIELD WRITE AND NOT A CALL ───────────────────────────────────
 *
 * `onAgencyResendEmail` / `onSellerResendEmail` are Firestore `onUpdate`
 * triggers watching `_resendEmail`. They are shaped that way deliberately — the
 * header comment on them says a callable would need an IAM invoker policy
 * change — and they delete the field once they have sent, so the document is
 * left as it was.
 *
 * ── WHY NOTHING COULD EVER TRIGGER THEM ──────────────────────────────────────
 *
 * The only writer of `_resendEmail` in the whole repository set it at CREATE
 * time, on `/sellers/register`. An `onUpdate` trigger fires on a change, and a
 * value present from the first write is not a change, so it fired nothing — and
 * there was no button anywhere else. Two functions, fully implemented and
 * unreachable.
 *
 * An update to an existing document is the state change they were built to
 * watch, and this is the only thing that performs one.
 *
 * Carries no credential: the trigger re-sends the standard email, and neither of
 * those contains a password. Nothing new is created — in particular no second
 * Firebase account, because this touches one field on a record that already
 * exists and never goes near Auth.
 */
export async function resendPartnerEmail(
  kind: 'agency' | 'seller',
  partnerId: string,
  which: ResendKind,
): Promise<void> {
  await updateDoc(doc(db, kind === 'agency' ? 'agencies' : 'sellers', partnerId), {
    _resendEmail: which,
  })
}
