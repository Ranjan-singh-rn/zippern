'use client'

/**
 * Everything that can be done to an account.
 *
 * All of it goes through the API. It used to write Firestore straight from the
 * browser and record the actor as the literal string "Admin", so a pattern of
 * bans could not be traced to a person and the user could not be told who to
 * appeal to. Now each call is audited against whoever is signed in, and shows
 * up in the history panel below.
 *
 * Two rules are visible in this UI:
 *
 *   • **A reason is mandatory.** The API rejects a call without one, so it is
 *     collected here rather than sent and refused.
 *   • **A balance change is not a write.** It raises a card, and an owner signs
 *     before anything moves. The panel says so in those words.
 *
 * ── THE FOUR MODERATION OPERATIONS ──────────────────────────────────────────
 *
 * Transcribed from `backend/app/services/users.py` — `ban_user`, `unban_user`,
 * `suspend_user`, `resume_user`:
 *
 *                 account      device             another account on that phone?
 *   suspend       restricted   NOT barred         yes
 *   resume        active       untouched          —
 *   ban           restricted   every one barred   no
 *   unban         active       this account's     —
 *                              bans lifted
 *
 * Ban ↔ Unban and Suspend ↔ Resume are two pairs, not one pair and two
 * spellings. **The server refuses the wrong one by name**: `resume` on a banned
 * account answers "use Unban", `unban` on a suspended one answers "use Resume".
 * So only the lifting action that matches the state is offered — a button whose
 * only possible outcome is a refusal teaches the operator nothing, and pressing
 * it looks like a broken screen rather than a rule.
 *
 * That is the ONE place this file hides a control, and it is the exception to
 * the rule below rather than a change of mind about it. Every other action is
 * always offered: if the API will not allow it, it says why and that answer is
 * shown, because a greyed-out control teaches nobody anything either.
 *
 * ── ROLE ACTIONS COME FROM THE ROLE RECORDS (UGP-B) ─────────────────────────
 *
 * "Revoke host" and "Remove seller" used to be fixed buttons with no state
 * gate, so every ordinary account — a guest with no role at all included —
 * was offered both. They are gone. Role actions are rendered only from
 * `GET /users/{uid}/roles`, which reads the authoritative records and says,
 * per role, what may be done: nothing for no role; nothing for ONE role (the
 * account is suspended instead); "Revoke <role>" on each of two or more; and
 * "Restore <role>" for a suspended or revoked role, re-activating the existing
 * record. "Remove seller" was a display flag, not the Coin Seller role, and is
 * replaced by revoking the role itself. See `lib/userRoleActions.ts`.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useAuth } from '@/components/AuthProvider'
import { hasPermission } from '@/lib/auth'
import { partnerOps } from '@/lib/apiPartners'
import {
  deductionProblem, deductionSummary, heldSummary, roleButtons,
  type RoleButton, type UserRoles,
} from '@/lib/userRoleActions'
import {
  INTERNAL_CRM_ROLES, isOrdinaryTarget, userRowActionKeys,
  type UserRowActionKey,
} from '@/lib/crmRoles'
import { REVOKED_RESTORE_HINT } from '@/lib/governanceRequests'
import { TransferRecommendation } from '@/components/TransferRecommendation'

/**
 * The four actions whose visibility is decided by the shared policy rather
 * than by this file's own `states` gate. Everything else on this page —
 * warn, revoke host, remove seller flag, balance — has no counterpart on the
 * /users list, so there is nothing for it to drift against and it keeps the
 * local gate.
 *
 * `grant_host` and `seller_on` are gone from this page altogether. A Host, an
 * Agency, a Sub-agency and a Coin Seller are obtained through an application
 * that a reviewer decides on /kyc — never by a button here — and the backend
 * routes behind those two buttons refuse (`/grant-host` is removed;
 * `/seller-flag` with `is_seller: true` is 400). Pending applications for
 * this user are listed on the page with Review / Approve / Reject instead
 * (`PartnerApplications.tsx`).
 */
const POLICY_KEYS = new Set<string>([
  'ban', 'unban', 'suspend', 'resume',
])
import {
  AlertTriangle, ArrowRight, BadgeCheck, Check, Coins, Loader2, PlayCircle,
  RotateCcw, ShieldOff, Smartphone, StarOff, Shield, AlertOctagon, X,
  type LucideIcon,
} from 'lucide-react'
import api, {
  ApiError, type Card, type ModerationResult, type UserCurrency, type WarnResult,
} from '@/lib/api'
import {
  DEFAULT_SUSPENSION, SuspendDuration, suspensionDays, suspensionProblem,
  suspensionResult, type SuspensionTerm,
} from '@/components/SuspendDuration'

const MIN_REASON = 3

type Tone = 'red' | 'green' | 'yellow' | 'blue' | 'purple' | 'slate'

type ActionKey =
  | 'ban' | 'unban' | 'suspend' | 'resume' | 'warn'
  | 'balance'
  /** A per-role revoke or restore, built from the role inventory (UGP-B). */
  | 'role'

// ── What the account currently is ─────────────────────────────────────────────

/**
 * `users/{uid}.accountState`, as three runtimes write it.
 *
 * The strings are duplicated from `AccountState` in
 * `backend/app/services/users.py:89`, which itself shares them with
 * `functions/src/accounts.ts` and the Android client — none of the four can
 * import from another, so each copy says so. If one changes they all must.
 */
type AccountState =
  | 'active'
  | 'suspended'
  | 'banned'
  | 'recovery_pending'
  | 'permanently_deactivated'

/** The three states that decide which lifting action is the right one. */
type Restriction = 'active' | 'suspended' | 'banned'

/**
 * Is this account suspended, banned, or neither?
 *
 * A transcription of `restriction_of` (`backend/app/services/users.py:224`),
 * and it has to be one: this screen decides which button to show and the server
 * decides which call to accept, so the two answering differently is exactly the
 * failure that makes an operator press a button that always fails.
 *
 * `accountState` wins when it carries a moderation value, because it is the
 * only field that can tell "banned" and "suspended" apart on its own. The two
 * booleans are the fallback for **every account restricted before that field
 * existed** — those documents have no moderation value on them at all, and
 * reading them as active would offer Ban to somebody who is already banned and
 * no way at all to lift it.
 *
 * The deletion states are deliberately NOT restrictions: a deleted account is a
 * different question, and folding it in here would offer Unban to somebody who
 * simply asked to leave.
 */
function restrictionOf(
  accountState: string,
  isBanned: boolean,
  isSuspended: boolean,
): Restriction {
  if (accountState === 'suspended' || accountState === 'banned') return accountState
  if (isSuspended) return 'suspended'
  if (isBanned) return 'banned'
  return 'active'
}

const STATE_BADGE: Record<AccountState, { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'green' },
  suspended: { label: 'Suspended', tone: 'yellow' },
  banned: { label: 'Banned', tone: 'red' },
  recovery_pending: { label: 'Deletion pending', tone: 'slate' },
  permanently_deactivated: { label: 'Deleted', tone: 'slate' },
}

/**
 * A state string we recognise, as opposed to one written by a build we have
 * not seen — or the empty string every pre-`accountState` document carries.
 */
function isKnownState(value: string): value is AccountState {
  return value in STATE_BADGE
}

// ── What the moderation calls send back ───────────────────────────────────────
//
// `lib/api.ts` types all four as `ModerationResult`, which carries the change
// and the audit id and nothing else. The device half of a ban and an unban is
// carried alongside it, and it is the half nobody can see from the account
// screen — so it is read here through these, each field optional because a
// response that predates it must render as "not stated" rather than crash a
// success panel over a missing count.
//
// Field names verified against `_result(...)` in
// `backend/app/services/users.py`: `ban_user` (:499), `unban_user` (:651),
// `suspend_user` (:772), `resume_user` (:891). Do not rename them here to
// something tidier — they are the wire.

/** One device the call could not touch. The account half still happened. */
interface DeviceFailure {
  device_id: string
  error: string
}

/**
 * One device ban an unban deliberately left standing, and why it survived.
 *
 * `because` is written by the server to be shown, and it is the sentence that
 * stops the support ticket: an unbanned person who still cannot sign in needs
 * to be told which handset is holding them out and on whose authority.
 */
interface DeviceBanKept {
  device_id: string
  because: string
  /** True when Ops barred the handset on its own evidence, not as a cascade. */
  manual_ban?: boolean
  /** How many other banned accounts are still on it. */
  remaining_sources?: number
}

interface BanOutcome extends ModerationResult {
  device_banned?: boolean
  /** The handsets actually barred. Empty is a real answer, not a failure. */
  devices_barred?: string[]
  device_failures?: DeviceFailure[]
  /** Prose from the server, written to be read out. Rendered verbatim. */
  note?: string
}

interface UnbanOutcome extends ModerationResult {
  device_unbanned?: boolean
  devices_released?: string[]
  device_bans_kept?: DeviceBanKept[]
  device_failures?: DeviceFailure[]
  note?: string
}

interface SuspendOutcome extends ModerationResult {
  /** ISO 8601, or '' for an indefinite suspension. */
  suspended_until?: string
  note?: string
}

interface ResumeOutcome extends ModerationResult {
  /** Always empty — a resume touches no device. Stated so it can be shown. */
  devices_released?: string[]
  note?: string
}

interface ActionSpec {
  key: ActionKey
  label: string
  icon: LucideIcon
  tone: Tone
  title: string
  /** What this does, said plainly, in terms of what the user will experience. */
  effect: React.ReactNode
  confirmLabel: string
  reasonHint: string
  /**
   * The account states this action is offered in.
   *
   * Omitted means every state — host, seller and balance have nothing to do
   * with moderation, and a banned account's beans still need correcting.
   */
  states?: Restriction[]
}

const ACTIONS: ActionSpec[] = [
  {
    key: 'suspend',
    label: 'Suspend',
    icon: AlertTriangle,
    tone: 'yellow',
    title: 'Suspend this account',
    states: ['active'],
    effect: (
      <>
        The account cannot use the app, <strong>but no device is barred</strong> — the person can
        go back to the login screen and sign in with a different, eligible account on the same
        phone. A timed suspension ends by itself; an indefinite one waits for somebody to press
        Resume. It is lifted with <strong>Resume</strong>, not Unban.
      </>
    ),
    confirmLabel: 'Suspend the account',
    reasonHint: 'What did they do? This is what the next person reviewing the account will read.',
  },
  {
    key: 'resume',
    label: 'Resume',
    icon: PlayCircle,
    tone: 'green',
    title: 'Resume this account',
    states: ['suspended'],
    effect: (
      <>
        The suspension is lifted and the account can use the app again.{' '}
        <strong>No device ban is touched</strong> — a suspension never placed one, and a handset
        barred for some other reason stays barred. The suspension reason is kept as the previous
        ban reason, so the history is not lost.
      </>
    ),
    confirmLabel: 'Resume the account',
    reasonHint: 'Why the suspension is ending early — an appeal, a mistake, time served…',
  },
  {
    key: 'unban',
    label: 'Unban',
    icon: Shield,
    tone: 'green',
    title: 'Lift the ban',
    states: ['banned'],
    effect: (
      <>
        The account can sign in again, and the device bans <strong>this account caused</strong> are
        lifted with it. A handset another banned account is still on, or one Ops barred on its own
        authority, stays barred — you will be told which, because an unbanned person who still
        cannot sign in is the next support ticket. The original ban reason is kept as the previous
        ban reason.
      </>
    ),
    confirmLabel: 'Lift the ban',
    reasonHint: 'Why is the ban being lifted? An appeal, a mistake, time served…',
  },
  {
    key: 'ban',
    label: 'Ban',
    icon: ShieldOff,
    tone: 'red',
    title: 'Ban this account',
    states: ['active', 'suspended'],
    effect: (
      <>
        The account is locked out of the app immediately — no owner signature is needed for
        moderation — and <strong>every handset this account has ever been seen on is barred</strong>.
        A barred handset locks out <em>every</em> account on it, so the person cannot sign in with a
        different account on those phones, and neither can anybody else who shares one. It is lifted
        with <strong>Unban</strong>.
      </>
    ),
    confirmLabel: 'Ban the account',
    reasonHint: 'What did they do? This is what the next person reviewing the account will read.',
  },
  {
    key: 'warn',
    label: 'Warn',
    icon: AlertOctagon,
    tone: 'yellow',
    title: 'Issue a formal warning',
    effect: (
      <>
        Adds a warning to the account and increments the warning count. The reason below is sent
        to the user as an Official message, without your name. The account is not restricted and
        no device is touched. You may add a deduction: it is checked against the person&rsquo;s
        roles and live balance, and raised as a card an owner signs — nothing is taken here.
      </>
    ),
    confirmLabel: 'Issue the warning',
    // Was "The user may be shown this", and they were not: the warning was
    // written to a subcollection, a counter and the audit log, and the app had
    // no reader for any of them. It is delivered now, every time, so the hint
    // says so — a reviewer who knows the person will read it writes a
    // different sentence from one who thinks they might.
    reasonHint: 'What is being warned about. This is sent to the user, in these words.',
  },
  {
    key: 'balance',
    label: 'Adjust balance',
    icon: Coins,
    tone: 'blue',
    title: 'Request a balance change',
    effect: (
      <>
        This creates a request. An owner signs before any balance changes. Nothing moves when you
        press confirm — the card goes to the money board and waits.
      </>
    ),
    confirmLabel: 'Raise the request',
    reasonHint: 'Why the balance should change, and what it is correcting.',
  },
]

const TONES: Record<Tone, string> = {
  red: 'bg-red-500/10 hover:bg-red-500/20 border-red-500/30 text-red-300',
  green: 'bg-green-500/10 hover:bg-green-500/20 border-green-500/30 text-green-300',
  yellow: 'bg-yellow-500/10 hover:bg-yellow-500/20 border-yellow-500/30 text-yellow-300',
  blue: 'bg-blue-500/10 hover:bg-blue-500/20 border-blue-500/30 text-blue-300',
  purple: 'bg-purple-500/10 hover:bg-purple-500/20 border-purple-500/30 text-purple-300',
  slate: 'bg-slate-700/40 hover:bg-slate-700/70 border-slate-600 text-slate-200',
}

interface Props {
  uid: string
  name: string
  /**
   * `users/{uid}.accountState`. May be '' — every account restricted before the
   * field existed has no value on it, which is what the two booleans below are
   * still read for.
   */
  accountState: string
  /** The app's single gate. True for a suspension AND for a ban. */
  isBanned: boolean
  isSuspended: boolean
  isHost: boolean
  /** The signed-in reviewer. Nobody moderates their own account. */
  actorUid?: string | null
  /**
   * `users/{uid}.crmRole`, denormalised from `crmUsers` — or '' for an
   * ordinary account. Used ONLY to hide the controls on an internal
   * identity; the enforcing check is server-side against the Mongo staff
   * collection. See the note beside `INTERNAL_CRM_ROLES`.
   */
  crmRole?: string
  isSeller: boolean
  /** Live balances from `users/{uid}`, for the deduction check and summary (UGP-D). */
  diamonds?: number
  beansAvailable?: number
  /** Called after any action succeeds, so the record and history are re-read. */
  onDone: () => void
}

interface Failure {
  message: string
  /** A business rule said no, as opposed to the request failing to get there. */
  isRule: boolean
}

interface Success {
  text: string
  /** Set when a balance card was raised, so we can point at the board. */
  card?: Card
  /** Set when a warning raised a deduction card (UGP-D). */
  deductionCard?: { id: string; stage: string; amount: number; currency: string }
  /** The server's own sentence about what happened. Shown word for word. */
  note?: string
  /** Set by a ban: the handsets barred with the account. */
  barred?: string[]
  /** Set by an unban and a resume: the device bans lifted. */
  released?: string[]
  /** Set by an unban: the device bans that survived, and why. */
  kept?: DeviceBanKept[]
  failures?: DeviceFailure[]
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

export function UserActions({
  uid, name, accountState, isBanned, isSuspended, isHost, isSeller, crmRole,
  actorUid, diamonds = 0, beansAvailable = 0, onDone,
}: Props) {
  const { crmUser, apiUser } = useAuth()
  const canAdjustBalance = hasPermission(crmUser, 'can_adjust_balance')
  // GOV C2: restoring a REVOKED role is the Owner's decision (403 otherwise).
  const isOwner = apiUser?.role === 'owner'
  const [pending, setPending] = useState<ActionSpec | null>(null)
  const [reason, setReason] = useState('')
  const [currency, setCurrency] = useState<UserCurrency>('diamonds')
  const [amount, setAmount] = useState('')
  // ── UGP-B: the role inventory, and the role action being confirmed ───────
  const [roles, setRoles] = useState<UserRoles | null>(null)
  const [rolesError, setRolesError] = useState<string | null>(null)
  const [roleAction, setRoleAction] = useState<RoleButton | null>(null)
  // ── UGP-D: the optional deduction on a warning ───────────────────────────
  const [deduct, setDeduct] = useState(false)
  const [dedCurrency, setDedCurrency] = useState<UserCurrency>('diamonds')
  const [dedAmount, setDedAmount] = useState('')
  // One id per opened Warn dialog, REUSED on a retry, so a request that timed
  // out and is pressed again is the same warning on the server.
  const requestId = useRef<string>('')
  // The shape, the default and the bounds are in components/SuspendDuration,
  // because the row action on /users asks the same question.
  const [term, setTerm] = useState<SuspensionTerm>(DEFAULT_SUSPENSION)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [success, setSuccess] = useState<Success | null>(null)

  const who = name || uid
  const restriction = restrictionOf(accountState, isBanned, isSuspended)
  // The badge says more than the restriction does: an account inside its
  // deletion grace window is under no moderation restriction at all, and saying
  // "Active" about somebody who has asked to be deleted would be a lie of
  // omission in front of whoever is deciding what to do about them.
  const badgeKey: AccountState =
    restriction === 'active' && isKnownState(accountState) ? accountState : restriction
  const badge = STATE_BADGE[badgeKey]
  const deleting =
    badgeKey === 'recovery_pending' || badgeKey === 'permanently_deactivated'

  // ── UGP-B: what this person holds, read before any role button renders ──
  const loadRoles = useCallback(async () => {
    try {
      setRolesError(null)
      setRoles(await api.users.roles(uid))
    } catch (err) {
      setRoles(null)
      setRolesError(err instanceof Error ? err.message : 'The roles could not be read.')
    }
  }, [uid])
  useEffect(() => { void loadRoles() }, [loadRoles])
  const roleButtonsList = roleButtons(roles)
  const allowedDeduction = (roles?.deduction_currencies ?? []).filter(
    (c): c is UserCurrency => c === 'diamonds' || c === 'beans',
  )
  const balances = { diamonds, beansAvailable }
  // UGP review: the Warn dialog can be opened before the roles arrive. Keep the
  // chosen currency one the roles allow — a Host-only account otherwise kept
  // "diamonds" while the select showed Beans, and the check refused it.
  const allowedKey = allowedDeduction.join(',')
  useEffect(() => {
    const allowedNow = allowedKey ? (allowedKey.split(',') as UserCurrency[]) : []
    if (allowedNow.length > 0 && !allowedNow.includes(dedCurrency)) setDedCurrency(allowedNow[0])
  }, [allowedKey, dedCurrency])

  // ── An internal identity is not moderated from here ─────────────────────
  //
  // An Owner, the Observer or any department role who has also signed into
  // the Android app has a `users/{uid}` document like anybody else, so they
  // appear in /users — all three production Owners do. Offering Ban, Suspend,
  // Grant host and Make seller beside their names was wrong twice over: the
  // actions were available, and until `users.ensure_ordinary_target` landed
  // the backend performed them.
  //
  // This is DEFENCE IN DEPTH, not the control. `crmRole` is denormalised onto
  // the app document, which the app can write — so a screen that trusted it
  // would be trusting client-reachable state. The authority is the Mongo
  // `staff` row, read server-side on every one of these endpoints; hiding the
  // buttons only stops a reviewer pressing something that was always going to
  // come back 403.
  const subject = { uid, crmRole, accountState, isBanned, isSuspended, isHost }
  const internal = INTERNAL_CRM_ROLES.has((crmRole ?? '').trim())

  // ── ONE POLICY, BOTH SCREENS ────────────────────────────────────────────
  //
  // `userRowActionKeys` is the single source of truth for which of the five
  // state-gated moderation actions may be offered, and `/users` renders the
  // same function. They used to decide separately and drifted: a suspended
  // account was offered Resume + Ban here and Resume + Make host on the list.
  //
  // The other actions on this page — warn, revoke host, seller on/off,
  // balance — have no equivalent on the list, so they keep their own
  // `states` gate. What they do NOT keep is the right to appear beside an
  // internal identity or the reviewer's own account: `isOrdinaryTarget`
  // governs the whole set, which is what the old `internal ? []` did and
  // what the list now does for self as well.
  const allowed = userRowActionKeys(subject, actorUid)
  const visible = !isOrdinaryTarget(subject, actorUid)
    ? []
    : ACTIONS.filter((spec) => (
      POLICY_KEYS.has(spec.key)
        ? allowed.includes(spec.key as UserRowActionKey)
        : !spec.states || spec.states.includes(restriction)
    ))

  function open(spec: ActionSpec) {
    setPending(spec)
    setRoleAction(null)
    setReason('')
    setAmount('')
    setTerm(DEFAULT_SUSPENSION)
    setDeduct(false)
    setDedAmount('')
    setDedCurrency(allowedDeduction[0] ?? 'diamonds')
    requestId.current =
      (globalThis.crypto && 'randomUUID' in globalThis.crypto)
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
    setFailure(null)
    setSuccess(null)
  }

  /** A per-role revoke or restore, confirmed in the same dialog (UGP-B). */
  function openRole(button: RoleButton) {
    open({
      key: 'role',
      label: button.label,
      icon: button.kind === 'revoke' ? StarOff : RotateCcw,
      tone: button.kind === 'revoke' ? 'slate' : 'green',
      title: button.title,
      effect: button.effect,
      confirmLabel: button.confirmLabel,
      reasonHint: button.kind === 'revoke'
        ? 'Why this role is being taken away. The person is told, with these words.'
        : 'Why this role is being restored.',
    })
    setRoleAction(button)
  }

  function close() {
    setPending(null)
    setRoleAction(null)
    setBusy(false)
    setFailure(null)
  }

  async function perform(spec: ActionSpec, why: string): Promise<Success> {
    switch (spec.key) {
      // Both of these leave the counting to `Outcome` below rather than putting
      // a number in this sentence. The device half is the part that is easy to
      // miss and it gets its own lines; saying it twice in two shapes is how a
      // reader ends up believing there were two of them.
      case 'ban': {
        const res = (await api.users.ban(uid, why)) as BanOutcome
        return {
          text: `${who} is banned. They are locked out of the app now.`,
          note: res.note,
          barred: res.devices_barred ?? [],
          failures: res.device_failures ?? [],
        }
      }
      case 'unban': {
        const res = (await api.users.unban(uid, why)) as UnbanOutcome
        return {
          text: `Ban lifted for ${who}. The reason it was imposed is kept as the previous ban reason.`,
          note: res.note,
          released: res.devices_released ?? [],
          kept: res.device_bans_kept ?? [],
          failures: res.device_failures ?? [],
        }
      }
      case 'suspend': {
        const days = suspensionDays(term)
        const res = (await api.users.suspend(uid, why, days)) as SuspendOutcome
        return {
          text: suspensionResult(days, res.suspended_until),
          note: res.note,
        }
      }
      case 'resume': {
        const res = (await api.users.resume(uid, why)) as ResumeOutcome
        return {
          text: `Suspension lifted. ${who} can use the app again.`,
          note: res.note,
        }
      }
      case 'warn': {
        const res: WarnResult = await api.users.warn(uid, why, {
          requestId: requestId.current,
          ...(deduct ? { deduction: { currency: dedCurrency, amount: Number(dedAmount) } } : {}),
        })
        const d = res.deduction
        return {
          text: res.replayed
            ? 'This warning had already been recorded — nothing was issued twice.'
            : 'Warning recorded against the account, issued in your name.',
          ...(d ? {
            deductionCard: { id: d.card_id, stage: d.card_stage, amount: d.amount, currency: d.currency },
          } : {}),
        }
      }
      case 'role': {
        const b = roleAction
        if (!b) throw new Error('No role action selected.')
        if (b.kind === 'revoke' && b.role === 'host') {
          await api.users.revokeHost(uid, why)
          return { text: 'Host role revoked. The account and its other roles are untouched.' }
        }
        if (b.kind === 'restore' && b.role === 'host') {
          await api.users.restoreHost(uid, why)
          return { text: 'Host role restored from the existing application and agency.' }
        }
        if (b.kind === 'revoke') {
          await partnerOps.revoke(b.targetId, why)
          return { text: `${b.label.replace('Revoke ', '')} role revoked. The other roles are untouched.` }
        }
        await partnerOps.reactivate(b.targetId, why)
        return { text: `${b.label.replace('Restore ', '')} role restored — the same record, re-activated.` }
      }
      case 'balance': {
        const n = Number(amount)
        const card = await api.users.requestBalanceChange(uid, currency, n, why)
        return {
          text: `Requested ${n > 0 ? '+' : ''}${n.toLocaleString('en-IN')} ${currency} for ${who}.`,
          card,
        }
      }
    }
  }

  async function submit() {
    if (!pending) return
    const why = reason.trim()

    if (why.length < MIN_REASON) {
      setFailure({
        message: `A reason of at least ${MIN_REASON} characters is required — it is what the audit log stores.`,
        isRule: true,
      })
      return
    }

    // Checked here as well as on the server, because a refused suspension is a
    // round trip that tells the operator nothing they could not have been told
    // while they were still typing. The bounds are the server's.
    if (pending.key === 'suspend') {
      const problem = suspensionProblem(term)
      if (problem) {
        setFailure({ message: problem, isRule: true })
        return
      }
    }

    if (pending.key === 'warn' && deduct) {
      const problem = deductionProblem(dedAmount, dedCurrency, allowedDeduction, balances)
      if (problem) {
        setFailure({ message: problem, isRule: true })
        return
      }
    }

    if (pending.key === 'balance') {
      const n = Number(amount)
      if (!Number.isInteger(n) || n === 0) {
        setFailure({
          message: 'Enter a whole number. Positive credits the account, negative debits it. Zero has no meaning.',
          isRule: true,
        })
        return
      }
    }

    setBusy(true)
    setFailure(null)
    try {
      const result = await perform(pending, why)
      setSuccess(result)
      setPending(null)
      setRoleAction(null)
      onDone()
      void loadRoles()
    } catch (err) {
      if (err instanceof ApiError) {
        // Shown verbatim. When the server refuses Resume on a banned account,
        // or Unban on a suspended one, the message names the button to press
        // instead — paraphrasing it would throw away the only useful part.
        setFailure({ message: err.message, isRule: err.isRule })
      } else {
        setFailure({ message: 'That did not work. Try again.', isRule: false })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 sm:p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-white font-semibold">Actions</h3>
          <p className="text-slate-500 text-xs mt-0.5">
            Moderation takes effect immediately. Every action is recorded against your name.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <State tone={badge.tone}>{badge.label}</State>
          {isHost && <State tone="yellow">Host</State>}
          {isSeller && <State tone="purple">Seller</State>}
        </div>
      </div>

      {/* A raised card is deliberately not dressed up as a success: nothing has
          happened to the balance yet, and saying otherwise is the failure mode
          this whole flow exists to prevent. */}
      {success?.deductionCard ? (
        <div className="flex items-start justify-between gap-3 bg-blue-500/10 border border-blue-500/30 rounded-lg px-4 py-3">
          <div className="flex items-start gap-2">
            <Coins size={15} className="text-blue-300 mt-0.5 shrink-0" />
            <div className="text-blue-50 text-sm">
              <p className="font-semibold">{success.text}</p>
              <p className="mt-1 text-blue-100/90">
                A deduction of{' '}
                <strong>
                  {success.deductionCard.amount.toLocaleString('en-IN')} {success.deductionCard.currency}
                </strong>{' '}
                was requested. <strong>No money has moved.</strong> The card waits on the money board
                for an owner to sign it, and is then taken from the live balance — whole, or not at all.
              </p>
              <p className="mt-1 text-blue-100/70 text-xs">
                Card {success.deductionCard.id} · {success.deductionCard.stage.replace(/_/g, ' ')}
              </p>
              <Link
                href="/board"
                className="inline-flex items-center gap-1.5 mt-2 text-blue-200 hover:text-white underline underline-offset-2 font-medium"
              >
                Open the money board <ArrowRight size={13} />
              </Link>
            </div>
          </div>
          <button onClick={() => setSuccess(null)} className="text-blue-300/70 hover:text-blue-100">
            <X size={14} />
          </button>
        </div>
      ) : success?.card ? (
        <div className="flex items-start justify-between gap-3 bg-blue-500/10 border border-blue-500/30 rounded-lg px-4 py-3">
          <div className="flex items-start gap-2">
            <Coins size={15} className="text-blue-300 mt-0.5 shrink-0" />
            <div className="text-blue-50 text-sm">
              <p className="font-semibold">{success.text}</p>
              <p className="mt-1 text-blue-100/90">
                <strong>No money has moved.</strong> The request is a card on the money board and an
                owner has to sign it before the balance changes. If nobody signs it, nothing happens.
              </p>
              <p className="mt-1 text-blue-100/70 text-xs">
                Card {success.card.id} · {success.card.stage.replace(/_/g, ' ')}
              </p>
              <Link
                href="/board"
                className="inline-flex items-center gap-1.5 mt-2 text-blue-200 hover:text-white underline underline-offset-2 font-medium"
              >
                Open the money board <ArrowRight size={13} />
              </Link>
            </div>
          </div>
          <button onClick={() => setSuccess(null)} className="text-blue-300/70 hover:text-blue-100">
            <X size={14} />
          </button>
        </div>
      ) : success ? (
        <div className="flex items-start justify-between gap-3 bg-green-500/10 border border-green-500/30 rounded-lg px-4 py-3">
          <div className="flex items-start gap-2 min-w-0">
            <Check size={15} className="text-green-400 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-green-100 text-sm">{success.text}</p>
              <Outcome result={success} />
            </div>
          </div>
          <button onClick={() => setSuccess(null)} className="text-green-400/70 hover:text-green-200">
            <X size={14} />
          </button>
        </div>
      ) : null}

      {/* The one thing an operator most needs to know before choosing, and the
          one the old copy got wrong: these two restrictions differ in what they
          do to the HANDSET, not in how severe they sound. */}
      <div className="flex items-start gap-2 bg-slate-950/60 border border-slate-800 rounded-lg px-4 py-3">
        <Smartphone size={15} className="text-slate-400 mt-0.5 shrink-0" />
        <p className="text-slate-300 text-sm">
          <strong className="text-white">Suspending does not bar the device.</strong> The account
          cannot use the app, but the person can sign in with a different account on the same phone.{' '}
          <strong className="text-white">Banning bars every handset the account has been seen
          on</strong> — no account works on those phones, so they cannot simply start again. That is
          the difference between the two, and it is what the choice is about.
        </p>
      </div>

      {deleting && (
        <div className="flex items-start gap-2 bg-slate-950/60 border border-slate-800 rounded-lg px-4 py-3">
          <AlertTriangle size={15} className="text-slate-400 mt-0.5 shrink-0" />
          <p className="text-slate-300 text-sm">
            {badgeKey === 'recovery_pending' ? (
              <>
                <strong className="text-white">This account has asked to be deleted</strong> and is
                inside its recovery window — one tap brings it back.
              </>
            ) : (
              <>
                <strong className="text-white">This account has been deleted.</strong> The login is
                gone and the identity released; the record stays for the life of the CRM.
              </>
            )}{' '}
            That is the person&rsquo;s own decision rather than a moderation one, and nothing on this
            panel undoes it. Whatever is done here, it is the deletion and not a ban that is keeping
            them out.
          </p>
        </div>
      )}

      {/* Money is never a direct write, and the person pressing the button
          should know that before they press it, not after. */}
      <div className="flex items-start gap-2 bg-blue-500/5 border border-blue-500/25 rounded-lg px-4 py-3">
        <Coins size={15} className="text-blue-300 mt-0.5 shrink-0" />
        <p className="text-blue-100/90 text-sm">
          Balance adjustment is not a direct write. <strong>This creates a request. An owner
          signs before any balance changes.</strong> You can follow it on the{' '}
          <Link href="/board" className="text-blue-300 underline underline-offset-2 hover:text-white">
            money board
          </Link>
          .
        </p>
      </div>

      {internal && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 mb-3">
          <p className="text-slate-300 text-sm">
            <strong className="text-white">This is an internal {crmRole} account.</strong>{' '}
            It appears here because the person has also signed into the app, but
            moderation and role changes for internal accounts go through the team
            pages, not through user management.
          </p>
          <p className="text-slate-500 text-xs mt-1.5">
            The server refuses these actions against an internal account whatever
            this screen shows, so nothing is lost by them being hidden.
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {visible.map((spec) => (
          <button
            key={spec.key}
            onClick={() => open(spec)}
            className={`flex items-center gap-2 border rounded-lg px-3 py-2 text-sm font-medium transition-colors ${TONES[spec.tone]}`}
          >
            <spec.icon size={14} /> {spec.label}
          </button>
        ))}
      </div>

      {/* UGP-B: role actions, ONLY from the authoritative role inventory. No
          role → no button; one role → no revoke (suspend the account instead). */}
      {isOrdinaryTarget(subject, actorUid) && (
        <div className="border-t border-slate-800 pt-4">
          <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-2">Roles</p>
          {rolesError ? (
            <p className="text-amber-200 text-sm">
              The roles could not be read, so no role action is offered: {rolesError}
            </p>
          ) : roles === null ? (
            <p className="text-slate-500 text-sm flex items-center gap-2">
              <Loader2 size={13} className="animate-spin" /> Reading roles…
            </p>
          ) : (
            <>
              <p className="text-slate-300 text-sm">{heldSummary(roles)}</p>
              {roleButtonsList.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {roleButtonsList.map((b) => {
                    // GOV C2: a REVOKED role comes back by the Owner's decision
                    // only — disabled for everybody else, with the way forward.
                    const ownerGate = b.ownerOnly && !isOwner
                    return (
                      <button
                        key={b.key}
                        onClick={() => { if (!ownerGate) openRole(b) }}
                        disabled={ownerGate}
                        title={ownerGate ? REVOKED_RESTORE_HINT : undefined}
                        className={`flex items-center gap-2 border rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                          TONES[b.kind === 'revoke' ? 'slate' : 'green']}`}
                      >
                        {b.kind === 'revoke' ? <StarOff size={14} /> : <RotateCcw size={14} />} {b.label}
                      </button>
                    )
                  })}
                </div>
              )}
              {!isOwner && roleButtonsList.some((b) => b.ownerOnly) && (
                <p className="text-slate-500 text-xs mt-2">
                  {REVOKED_RESTORE_HINT}:{' '}
                  <Link href="/role-appeals" className="text-pink-400 hover:text-pink-300 underline underline-offset-2">
                    Reinstatement requests
                  </Link>
                  .
                </p>
              )}
              {/* GOV C3: moving a current Host to another agency is a request
                  the Owner decides — filed here, decided on /transfers. */}
              {(() => {
                const host = roles.roles.find((r) => r.role === 'host' && r.status === 'active')
                if (!host) return null
                return (
                  <div className="mt-3">
                    <TransferRecommendation
                      kind="host"
                      subjectId={uid}
                      currentAgencyId={host.agency_id ?? ''}
                      subjectLabel={who}
                    />
                  </div>
                )
              })()}
            </>
          )}
        </div>
      )}

      {pending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={close} />
          <div className="relative w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-slate-800">
              <div>
                <h2 className="text-white font-semibold">{pending.title}</h2>
                <p className="text-slate-500 text-xs mt-0.5">{who}</p>
              </div>
              <button onClick={close} className="text-slate-500 hover:text-white">
                <X size={18} />
              </button>
            </div>

            <div className="px-6 py-5 space-y-4">
              <p className="text-slate-300 text-sm leading-relaxed">{pending.effect}</p>

              {pending.key === 'suspend' && (
                <SuspendDuration value={term} onChange={setTerm} />
              )}

              {pending.key === 'balance' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-400 text-xs font-medium mb-1.5">Currency</label>
                    <select
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value as UserCurrency)}
                      className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-pink-500"
                    >
                      <option value="diamonds">Diamonds</option>
                      <option value="beans">Beans</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-400 text-xs font-medium mb-1.5">
                      Amount (− to debit)
                    </label>
                    <input
                      type="number"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="e.g. 500 or -500"
                      className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
                    />
                  </div>
                </div>
              )}

              {pending.key === 'warn' && (
                <div className="space-y-3 bg-slate-950/50 border border-slate-800 rounded-lg px-4 py-3">
                  {canAdjustBalance ? (
                    <label className="flex items-center gap-2 text-slate-300 text-sm">
                      <input
                        type="checkbox"
                        checked={deduct}
                        onChange={(e) => setDeduct(e.target.checked)}
                        disabled={allowedDeduction.length === 0}
                      />
                      Also deduct from the balance
                    </label>
                  ) : (
                    <p className="text-slate-500 text-xs">
                      A deduction needs the balance-adjustment permission. The warning itself does not.
                    </p>
                  )}
                  {deduct && canAdjustBalance && (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-slate-400 text-xs font-medium mb-1.5">Currency</label>
                          <select
                            value={dedCurrency}
                            onChange={(e) => setDedCurrency(e.target.value as UserCurrency)}
                            className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-pink-500"
                          >
                            {allowedDeduction.map((c) => (
                              <option key={c} value={c}>{c === 'beans' ? 'Beans (released)' : 'Diamonds'}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-slate-400 text-xs font-medium mb-1.5">Amount</label>
                          <input
                            type="number"
                            min={1}
                            value={dedAmount}
                            onChange={(e) => setDedAmount(e.target.value)}
                            placeholder="e.g. 50"
                            className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
                          />
                        </div>
                      </div>
                      {/* The amount and currency are stated BEFORE confirmation. */}
                      {dedAmount && !deductionProblem(dedAmount, dedCurrency, allowedDeduction, balances) ? (
                        <p className="text-blue-100 text-sm bg-blue-500/10 border border-blue-500/30 rounded-lg px-3 py-2">
                          {deductionSummary(who, dedAmount, dedCurrency, balances)}
                        </p>
                      ) : dedAmount ? (
                        <p className="text-amber-200 text-sm">
                          {deductionProblem(dedAmount, dedCurrency, allowedDeduction, balances)}
                        </p>
                      ) : null}
                    </>
                  )}
                </div>
              )}

              <div>
                <label className="block text-slate-400 text-xs font-medium mb-1.5">
                  Reason <span className="text-pink-400">(required)</span>
                </label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  autoFocus
                  placeholder={pending.reasonHint}
                  className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 resize-none"
                />
                <p className="text-slate-600 text-xs mt-1">
                  At least {MIN_REASON} characters. This is stored in the audit log and read back on
                  the account history.
                </p>
              </div>

              {failure && (
                <div
                  className={`flex items-start gap-2 rounded-lg px-4 py-3 border ${
                    failure.isRule
                      ? 'bg-amber-500/10 border-amber-500/30'
                      : 'bg-red-500/10 border-red-500/30'
                  }`}
                >
                  <AlertTriangle
                    size={15}
                    className={`mt-0.5 shrink-0 ${failure.isRule ? 'text-amber-400' : 'text-red-400'}`}
                  />
                  <div className={failure.isRule ? 'text-amber-100 text-sm' : 'text-red-200 text-sm'}>
                    <p className="font-medium">
                      {failure.isRule ? 'Refused' : 'Could not complete that'}
                    </p>
                    <p className="mt-0.5">{failure.message}</p>
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-3 px-6 py-4 border-t border-slate-800">
              <button
                onClick={close}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={busy}
                className="flex-1 flex items-center justify-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:opacity-50 text-white rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors"
              >
                {busy ? (
                  <><Loader2 size={15} className="animate-spin" /> Working…</>
                ) : (
                  <>
                    {pending.key === 'balance' ? <ArrowRight size={15} /> : <BadgeCheck size={15} />}
                    {pending.confirmLabel}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * What a ban or an unban did to the handsets.
 *
 * This is the half of the operation nobody can see from the account screen, and
 * it is the half that generates support tickets when it is invisible:
 *
 *   • a ban that barred **no** handset leaves the person free to sign up again
 *     on the same phone tomorrow. "Banned" on its own reads as though it did;
 *   • an unban that **kept** a device ban leaves the person unbanned and still
 *     locked out. Reporting a clean unban over a handset that is still walled
 *     off is how the ticket starts.
 *
 * So both counts are stated, including when they are zero, and the kept ones
 * are named with the server's reason for each.
 */
function Outcome({ result }: { result: Success }) {
  const { barred, released, kept, failures, note } = result
  if (
    barred === undefined && released === undefined &&
    !kept?.length && !failures?.length && !note
  ) {
    return null
  }

  return (
    <div className="mt-2 space-y-2">
      {barred !== undefined && (
        <p className="text-green-100/90 text-sm">
          <strong>{plural(barred.length, 'handset')} barred.</strong>{' '}
          {barred.length
            ? 'No account can be used on them until the ban is lifted — not this one, and not a new one.'
            : 'Nothing stops a new account being created on the same phone.'}
        </p>
      )}
      {barred?.length ? <Ids ids={barred} /> : null}

      {released !== undefined && (
        <p className="text-green-100/90 text-sm">
          <strong>{plural(released.length, 'device ban')} released.</strong>
        </p>
      )}
      {released?.length ? <Ids ids={released} /> : null}

      {kept?.length ? (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
          <p className="text-amber-100 text-sm font-semibold">
            {plural(kept.length, 'device ban')} stayed in force — this account&rsquo;s unban did not
            lift them, and it was not supposed to.
          </p>
          <ul className="mt-1.5 space-y-1">
            {kept.map((k) => (
              <li key={k.device_id} className="text-amber-100/90 text-xs">
                <span className="font-mono break-all">{k.device_id}</span> — {k.because}
              </li>
            ))}
          </ul>
          <p className="text-amber-200/80 text-xs mt-2">
            The account is unbanned and is <strong>still locked out on those handsets</strong>. If
            one of them should come off, lift it from the{' '}
            <Link
              href="/operations/bans"
              className="underline underline-offset-2 hover:text-white"
            >
              device bans
            </Link>{' '}
            screen — that is a decision about the handset, not about this account.
          </p>
        </div>
      ) : null}

      {failures?.length ? (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
          <p className="text-red-200 text-sm font-semibold">
            {plural(failures.length, 'handset')} could not be reached. The account change stands.
          </p>
          <ul className="mt-1.5 space-y-1">
            {failures.map((f) => (
              <li key={f.device_id} className="text-red-100/90 text-xs">
                <span className="font-mono break-all">{f.device_id}</span> — {f.error}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* The server writes this to be read out. Shown word for word rather than
          summarised — it is the only thing that explains the odd cases, like an
          account that has never recorded a device. */}
      {note && <p className="text-green-100/70 text-xs leading-relaxed">{note}</p>}
    </div>
  )
}

function Ids({ ids }: { ids: string[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {ids.map((id) => (
        <li
          key={id}
          className="font-mono text-[11px] text-green-200/80 bg-green-500/10 rounded px-1.5 py-0.5 break-all"
        >
          {id}
        </li>
      ))}
    </ul>
  )
}

function State({ children, tone }: { children: React.ReactNode; tone: Tone }) {
  const tones: Record<Tone, string> = {
    red: 'bg-red-500/20 text-red-300',
    green: 'bg-green-500/15 text-green-300',
    yellow: 'bg-yellow-500/20 text-yellow-200',
    blue: 'bg-blue-500/20 text-blue-200',
    purple: 'bg-purple-500/20 text-purple-200',
    slate: 'bg-slate-700 text-slate-300',
  }
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${tones[tone]}`}>
      {children}
    </span>
  )
}
