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
 */

import { useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowRight, BadgeCheck, Check, Coins, Loader2, PlayCircle,
  ShieldOff, ShoppingBag, Smartphone, Star, StarOff, Shield, AlertOctagon, X,
  type LucideIcon,
} from 'lucide-react'
import api, {
  ApiError, type Card, type ModerationResult, type UserCurrency,
} from '@/lib/api'
import {
  DEFAULT_SUSPENSION, SuspendDuration, suspensionDays, suspensionProblem,
  suspensionResult, type SuspensionTerm,
} from '@/components/SuspendDuration'

const MIN_REASON = 3

type Tone = 'red' | 'green' | 'yellow' | 'blue' | 'purple' | 'slate'

type ActionKey =
  | 'ban' | 'unban' | 'suspend' | 'resume' | 'warn'
  | 'grant_host' | 'revoke_host'
  | 'seller_on' | 'seller_off'
  | 'balance'

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
        Adds a warning to the account, attributed to you by name, and increments the warning count.
        The account is not restricted and no device is touched.
      </>
    ),
    confirmLabel: 'Issue the warning',
    reasonHint: 'What is being warned about. The user may be shown this.',
  },
  {
    key: 'grant_host',
    label: 'Grant host',
    icon: Star,
    tone: 'yellow',
    title: 'Make this user a host',
    effect: (
      <>
        The user can go live. Optionally attach them to an agency — leave the agency blank to keep
        whatever link they already have.
      </>
    ),
    confirmLabel: 'Grant host',
    reasonHint: 'Why they are being made a host.',
  },
  {
    key: 'revoke_host',
    label: 'Revoke host',
    icon: StarOff,
    tone: 'slate',
    title: 'Remove host status',
    effect: (
      <>
        The user can no longer go live. The agency link is deliberately kept, so commission already
        paid stays readable. If they are not a host the API will refuse.
      </>
    ),
    confirmLabel: 'Revoke host',
    reasonHint: 'Why host status is being removed.',
  },
  {
    key: 'seller_on',
    label: 'Make seller',
    icon: ShoppingBag,
    tone: 'purple',
    title: 'Grant seller status',
    effect: 'The account appears in the Diamond Shop as a coin seller.',
    confirmLabel: 'Grant seller',
    reasonHint: 'Why they are being made a seller.',
  },
  {
    key: 'seller_off',
    label: 'Remove seller',
    icon: ShoppingBag,
    tone: 'slate',
    title: 'Remove seller status',
    effect:
      'The account stops appearing in the Diamond Shop. If it is not a seller the API will refuse.',
    confirmLabel: 'Remove seller',
    reasonHint: 'Why seller status is being removed.',
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
  isSeller: boolean
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
  uid, name, accountState, isBanned, isSuspended, isHost, isSeller, onDone,
}: Props) {
  const [pending, setPending] = useState<ActionSpec | null>(null)
  const [reason, setReason] = useState('')
  const [agencyId, setAgencyId] = useState('')
  const [currency, setCurrency] = useState<UserCurrency>('diamonds')
  const [amount, setAmount] = useState('')
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

  const visible = ACTIONS.filter((spec) => !spec.states || spec.states.includes(restriction))

  function open(spec: ActionSpec) {
    setPending(spec)
    setReason('')
    setAgencyId('')
    setAmount('')
    setTerm(DEFAULT_SUSPENSION)
    setFailure(null)
    setSuccess(null)
  }

  function close() {
    setPending(null)
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
      case 'warn':
        await api.users.warn(uid, why)
        return { text: 'Warning recorded against the account, issued in your name.' }
      case 'grant_host':
        await api.users.grantHost(uid, why, agencyId.trim())
        return { text: 'Host granted. The user can go live.' }
      case 'revoke_host':
        await api.users.revokeHost(uid, why)
        return { text: 'Host status removed. The agency link was kept.' }
      case 'seller_on':
        await api.users.setSellerFlag(uid, true, why)
        return { text: 'Seller status granted.' }
      case 'seller_off':
        await api.users.setSellerFlag(uid, false, why)
        return { text: 'Seller status removed.' }
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
      onDone()
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
      {success?.card ? (
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

              {pending.key === 'grant_host' && (
                <div>
                  <label className="block text-slate-400 text-xs font-medium mb-1.5">
                    Agency id (optional)
                  </label>
                  <input
                    value={agencyId}
                    onChange={(e) => setAgencyId(e.target.value)}
                    placeholder="Leave blank to keep the existing link"
                    className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
                  />
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
