/**
 * QA #25 (3 Nov 2026) — what the partner waiting room says, by state.
 *
 * An APPROVED agency (or coin seller) whose login still had to verify a
 * contact landed on /agency-pending under the headline "Approved — Verify to
 * Start" — and, below it, "Your agency application is being reviewed by our
 * team. This usually takes 1-2 business days" and the pre-approval "What
 * happens next" list ("…once approved", "After approval, log back in…").
 * Both states now have their own words; the under-review copy is unchanged.
 *
 * No imports: `waitingRoom.spec.ts` runs the shipped module standalone.
 */

export type WaitingRoomKind = 'agency' | 'seller'
export type WaitingRoomIcon = 'check' | 'mail' | 'phone' | 'dashboard'

export interface WaitingRoomCopy {
  title: string
  subtitle: string
  intro: string
  /** The "What happens next" list. */
  steps: { icon: WaitingRoomIcon; text: string }[]
}

const NOUN: Record<WaitingRoomKind, { application: string; dashboard: string; received: string; review: string }> = {
  agency: {
    application: 'agency application',
    dashboard: 'agency dashboard',
    received: 'We have received your agency registration',
    review: 'Our team verifies your submitted details and KYC documents',
  },
  seller: {
    application: 'coin seller application',
    dashboard: 'seller dashboard',
    received: 'We have received your coin seller application',
    review: 'Our team reviews your application and account details',
  },
}

/**
 * Where a waiting room sends a login whose role has STARTED (E2E re-run,
 * 3 Nov 2026): once both contacts were verified the handover reloaded this
 * page, and an approved partner read "Application Under Review … 1-2 business
 * days" — the under-review words are for an undecided application. A started
 * role belongs on its dashboard; the waiting room passes it on.
 */
export const WAITING_ROOM_DASHBOARD: Readonly<Record<WaitingRoomKind, string>> = {
  agency: '/agency-dashboard',
  seller: '/seller-dashboard',
}

/** The dashboard to open instead of the waiting room, or null to stay. */
export function waitingRoomExit(kind: WaitingRoomKind, status: string | null | undefined): string | null {
  return status === 'approved' ? WAITING_ROOM_DASHBOARD[kind] : null
}

/**
 * `waiting` is `partnerRoleStatus(…) === 'awaiting_verification'`: the Owner
 * approved the role and it starts once both contacts on this login are verified.
 */
export function waitingRoomCopy(kind: WaitingRoomKind, waiting: boolean, email: string | null | undefined): WaitingRoomCopy {
  const n = NOUN[kind]
  if (waiting) {
    return {
      title: 'Approved — Verify to Start',
      subtitle: `Your ${n.application} has been approved`,
      intro:
        'Your role starts as soon as both your phone number and your email address are verified on this ' +
        'login. Nothing else is needed from our team.',
      steps: [
        { icon: 'mail', text: 'Verify your email address with the 6-digit code we send to it' },
        { icon: 'phone', text: 'Verify your mobile number with the SMS code' },
        { icon: 'dashboard', text: `Your ${n.dashboard} opens here as soon as both are verified — no new sign-in needed` },
      ],
    }
  }
  return {
    title: 'Application Under Review',
    subtitle: n.received,
    intro: `Your ${n.application} is being reviewed by our team. This usually takes 1-2 business days.`,
    steps: [
      { icon: 'check', text: n.review },
      { icon: 'mail', text: `You will receive an email at ${email || 'your email'} once approved` },
      { icon: 'dashboard', text: `After approval, log back in to access your ${n.dashboard}` },
    ],
  }
}
