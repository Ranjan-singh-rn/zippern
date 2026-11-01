'use client'

/**
 * Carrying out one review decision — from whichever screen it was pressed on.
 *
 * ── WHY THIS IS SHARED ───────────────────────────────────────────────────────
 *
 * A host application's decision has exactly one writer, and it is on the
 * server: `POST /users/host-applications/{id}/decide`, which writes `status`
 * and `kycStatus` together with the decider, the time and the reason, and
 * grants or revokes the host account in the same call. That rule survived three
 * screens writing it by hand and drifting apart, and it is not being relaxed.
 *
 * But "one writer on the server" and "one button in the CRM" are different
 * claims, and the second one was never true: the approval queue is where
 * everything else in this business gets decided, so that is where people look
 * for these too. This module is what lets a second screen offer the decision
 * without becoming a second writer of it — every path below ends in the same
 * API call `/kyc` makes.
 *
 * So: approving a host application HERE is approving their KYC. There is no
 * separate KYC step afterwards, and no second record to keep in step.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
 *
 * It does not decide whether the person pressing the button is allowed to, and
 * it does not collect the reason. Both belong to the screen: the role gate
 * differs between queues, and a reason typed into a dialog that shows the
 * documents is a different act from one typed into a list row.
 */

import api from '@/lib/api'
import { partnerOps } from '@/lib/apiPartners'
import { awaitingLabel } from '@/lib/contactVerification'
import type { Item } from '@/lib/reviewQueues'

export type DecisionAction = 'approve' | 'reject' | 'register'

/**
 * Carry out one decision.
 *
 * @returns anything the server said that a canned confirmation would not
 * cover — today, the host cases where the decision was made and there was no
 * account to act on. An empty string means it did exactly what was asked.
 */
export async function decideReviewItem(
  item: Item,
  action: DecisionAction,
  reason: string,
): Promise<string> {
  if (action === 'register') {
    // Creates the business record holding nothing and pending. Not a decision.
    await partnerOps.create(item.id, reason)
    return ''
  }
  const approve = action === 'approve'

  // A proposed change is a different decision from approving the partner, and
  // it goes through a different call. Approving applies the proposed values
  // onto the live fields; rejecting discards them and touches nothing.
  //
  // Two calls rather than one, because the two collections have different
  // owners on the server: `hostApplications` is owned end to end by
  // `services/users.py` — a host has no business record for `partner_ops` to
  // resolve — and giving that document a second writer in a second module is
  // the failure this whole path exists to have ended.
  if (item.linkage === 'reapproval_host') {
    const decided = await api.users.decideHostPendingChanges(item.id, approve, reason)
    return decided.note ?? ''
  }
  if (item.linkage === 'reapproval') {
    const decided = await partnerOps.decidePendingChanges(item.id, approve, reason)
    return decided.note ?? ''
  }

  if (item.linkage === 'host' || item.linkage === 'host_unlinked') {
    // ONE call, and it is the only writer of a host application's decision.
    // `status`, `kycStatus`, the decider, the time, the reason and the host
    // grant all happen inside it. Nothing here can do one without the others.
    const decided = await api.users.decideHostApplication(item.id, approve, reason)
    // Non-empty when the decision stands but touched no account — nobody had
    // redeemed the code, or the applicant never became a host. Both are
    // ordinary, and both are worth saying rather than reporting a revocation
    // that did not happen.
    return decided.note ?? ''
  }

  if (approve) {
    const out = await partnerOps.approve(item.id, reason)
    // Decision 15 (RC): approved by the Owner, NOT started — the login still
    // needs both verified contacts. The queue says so instead of "approved".
    if (out?.awaiting_verification) return awaitingLabel(out.missing ?? [])
  } else await partnerOps.reject(item.id, reason)
  return ''
}

/** What this row is, in the words the approval queue uses for everything else. */
export function decisionLabelOf(item: Item): string {
  switch (item.linkage) {
    case 'host':
    case 'host_unlinked':
      return 'Host application + KYC'
    case 'reapproval':
    case 'reapproval_host':
      return 'Changed details'
    case 'unregistered':
      return 'No business record'
    default:
      return 'Partner KYC'
  }
}

/**
 * What approving this row will actually do, in one sentence.
 *
 * Shown on the row itself, because the whole point of deciding from a queue is
 * that the queue tells you what you are deciding. A person pressing Approve on
 * a list should not have to know that a host row also grants an account and a
 * re-approval row moves a bank account.
 */
export function approveEffectOf(item: Item): string {
  switch (item.linkage) {
    case 'host':
      return 'Approves the KYC and makes this account a host of the inviting agency.'
    case 'host_unlinked':
      return 'Approves the KYC and switches the referral code on. Host status is ' +
        'granted the moment the applicant enters it.'
    case 'reapproval':
    case 'reapproval_host':
      return 'Writes the proposed values onto the live record. If a bank account ' +
        'is among them, this is what moves where money is sent.'
    case 'unregistered':
      return 'There is nothing to approve yet — this applicant has no business ' +
        'record. Open the review screen to create one.'
    default:
      return 'Approves the KYC. They can start trading with us. No money moves.'
  }
}
