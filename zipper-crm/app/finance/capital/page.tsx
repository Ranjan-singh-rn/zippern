'use client'

/**
 * Owner capital — money the owners put in from their own pocket, and take back
 * out.
 *
 * A business is funded before it earns. The owners paid for the first
 * inventory, the first bills and the gap until coin sellers started paying, and
 * later they take that money back. Both movements are real cash and both have
 * to be visible. **Neither is trading, and neither reaches profit.**
 *
 *   trading   revenue in from sellers and users, costs out   → profit
 *   capital   an owner funds the business, an owner draws    → NOT profit
 *
 * Counted as revenue, a company funding itself reads as a company earning and
 * the margin is whatever the owners happened to deposit. Counted as an expense,
 * a repaid founder loan reads as a loss in the very month the business finally
 * afforded to pay its founders back. A shop's books have kept the two apart for
 * a very long time, and the reason is that mixing them makes both numbers
 * meaningless. This screen says so on its face, twice, because a reader who
 * mistakes this page for trading will misread the business.
 *
 * `outstanding` is what the business still **owes** an owner. It is a liability,
 * not a pot to spend.
 *
 * Two rules carried from the rest of the CRM. Recording a movement moves
 * nothing — it raises a card that a second person verifies and an owner signs,
 * and an owner may not sign their own. And a read that failed is never rendered
 * as ₹0: every read here lands in a `ReadResult` and a refusal is shown as a
 * refusal.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowDownLeft, ArrowLeft, ArrowUpRight, CheckCircle2,
  ChevronRight, HandCoins, Info, Loader2, Plus, RefreshCw, Scale, X,
} from 'lucide-react'

import { useAuth } from '@/components/AuthProvider'
import { canAccess, CrmRole } from '@/lib/auth'
import { ApiError, type Stage } from '@/lib/api'
import { attempt, type ReadResult } from '@/lib/readState'
import { Denied, Empty, Loading, UnavailablePanel, Warning } from '@/components/ui/States'
import { formatDateTime, formatInrMinor, formatInrMinorShort } from '@/lib/apiReports'
import {
  CAPITAL_STAGE_LABEL, CAPITAL_STAGE_SHORT, CAPITAL_STAGE_TRACK,
  DIRECTION_LABEL, DIRECTION_MEANING, METHODS, MIN_REASON, STAGE_TONE,
  capital, capitalPayload, ownerLabel, paiseFromRupees,
  type CapitalAccount, type CapitalCard, type CapitalDirection,
} from '@/lib/apiCapital'

/**
 * Who may open this screen.
 *
 * `GET /capital` is `require_internal` — the capital account is business record
 * and the whole of staff could technically read it. This is narrower on
 * purpose, and matches every other screen under /finance: capital cards are
 * raised on the Finance board, and the Finance section has one door. Narrower
 * than the API is safe; wider is a link to a page of 403s.
 */
const FINANCE_ROLES: CrmRole[] = ['superadmin', 'finance_admin']

/** `GET /cards` caps at 500; ask for a number and check what came back. */
const BOARD_LIMIT = 300

const inputClass =
  'w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 transition-colors'

function Field({
  label, hint, children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-slate-400 text-xs mb-1.5 font-medium">{label}</label>
      {children}
      {hint && <p className="text-slate-600 text-xs mt-1 leading-relaxed">{hint}</p>}
    </div>
  )
}

function StagePill({ stage }: { stage: Stage }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${STAGE_TONE[stage]}`}
      title={CAPITAL_STAGE_LABEL[stage]}
    >
      {CAPITAL_STAGE_SHORT[stage]}
    </span>
  )
}

/** Recorded → review → sign-off → signed → settled. Drawn so "signed" and
 *  "the transfer happened" cannot be read as the same thing. */
function StageTrack({ stage }: { stage: Stage }) {
  const here = CAPITAL_STAGE_TRACK.indexOf(stage)
  if (here < 0) {
    return (
      <span className={`inline-flex rounded px-2 py-1 text-xs ${STAGE_TONE[stage]}`}>
        {CAPITAL_STAGE_LABEL[stage]}
      </span>
    )
  }
  const SHORT: Record<string, string> = {
    requested: 'Recorded',
    under_review: 'Review',
    awaiting_signoff: 'Sign-off',
    approved: 'Signed',
    executed: 'Settled',
  }
  return (
    <ol className="flex items-center gap-1 overflow-x-auto py-0.5" aria-label="Progress">
      {CAPITAL_STAGE_TRACK.map((s, i) => (
        <li key={s} className="flex items-center gap-1 shrink-0">
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${
              i === here
                ? 'bg-pink-500 text-white'
                : i < here
                  ? 'bg-slate-700 text-slate-300'
                  : 'bg-slate-800/60 text-slate-600'
            }`}
          >
            {SHORT[s]}
          </span>
          {i < CAPITAL_STAGE_TRACK.length - 1 && (
            <ChevronRight size={11} className="text-slate-700" />
          )}
        </li>
      ))}
    </ol>
  )
}

// ── Record a movement ─────────────────────────────────────────────────────────

function RecordMovementModal({
  knownOwners, onClose, onRecorded,
}: {
  /**
   * Owners the capital account already knows about. A convenience, never a
   * roster: an owner who has never moved capital is not on it, so the uid stays
   * a typed field rather than a closed list that would quietly exclude them.
   */
  knownOwners: { uid: string; name: string }[]
  onClose: () => void
  onRecorded: (card: CapitalCard, message: string) => void
}) {
  const [direction, setDirection] = useState<CapitalDirection>('in')
  const [ownerUid, setOwnerUid] = useState('')
  const [ownerName, setOwnerName] = useState('')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<string>('bank')
  const [reference, setReference] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const paise = paiseFromRupees(amount)
  const amountBad = amount.trim() !== '' && paise === null
  const ready =
    paise !== null &&
    ownerUid.trim() !== '' &&
    reference.trim() !== '' &&
    reason.trim().length >= MIN_REASON

  async function submit() {
    if (!ready || paise === null) return
    setSaving(true)
    setError('')
    try {
      const card = await capital.record({
        direction,
        owner_uid: ownerUid.trim(),
        owner_name: ownerName.trim(),
        amount_minor: paise,
        method,
        reference: reference.trim(),
        reason: reason.trim(),
      })
      onRecorded(
        card,
        `Recorded ${DIRECTION_LABEL[direction].toLowerCase()} of ${formatInrMinor(paise)} ` +
          `for ${ownerName.trim() || ownerUid.trim()}. Nothing has moved — it is on the ` +
          'money board, and the owner it is about cannot be the one who signs it.',
      )
      onClose()
    } catch (err) {
      // The API refuses with a sentence written to be shown. Print it verbatim.
      setError(
        err instanceof ApiError
          ? err.message
          : 'The movement was not recorded. Nothing changed — try again.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-xl shadow-2xl my-8">
        <div className="flex items-start justify-between px-6 py-4 border-b border-slate-800">
          <div>
            <h3 className="text-white font-semibold">Record a capital movement</h3>
            <p className="text-slate-500 text-xs mt-0.5 max-w-sm leading-relaxed">
              This raises a card in <em>Recorded</em>. It transfers nothing — a second
              person verifies it and an owner signs it, and it is settled only once the
              transfer has actually happened.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white shrink-0">
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-slate-400 text-xs mb-1.5 font-medium">
              Direction
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {(['in', 'out'] as CapitalDirection[]).map((d) => (
                <button
                  key={d}
                  onClick={() => setDirection(d)}
                  className={`text-left rounded-xl border px-3.5 py-3 transition-colors ${
                    direction === d
                      ? 'border-pink-500 bg-pink-500/10'
                      : 'border-slate-700 hover:border-slate-600'
                  }`}
                >
                  <span className="flex items-center gap-2 text-white text-sm font-medium">
                    {d === 'in' ? (
                      <ArrowDownLeft size={14} className="text-emerald-400" />
                    ) : (
                      <ArrowUpRight size={14} className="text-orange-400" />
                    )}
                    {DIRECTION_LABEL[d]}
                  </span>
                  <span className="block text-slate-500 text-xs mt-1 leading-relaxed">
                    {DIRECTION_MEANING[d]}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field
              label="Owner uid"
              hint="The account this is about. It is a typed field rather than a dropdown because an owner who has never moved capital would be missing from any list built from the account below."
            >
              <input
                value={ownerUid}
                onChange={(e) => setOwnerUid(e.target.value)}
                placeholder="Firebase uid of the owner"
                className={`${inputClass} font-mono`}
              />
              {knownOwners.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {knownOwners.map((o) => (
                    <button
                      key={o.uid}
                      onClick={() => {
                        setOwnerUid(o.uid)
                        setOwnerName(o.name)
                      }}
                      className="bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-full px-2.5 py-1 text-xs transition-colors"
                    >
                      {o.name || o.uid}
                    </button>
                  ))}
                </div>
              )}
            </Field>

            <Field
              label="Owner name (optional)"
              hint="Shown on the card and in the account. Without it the uid is used, which nobody can read."
            >
              <input
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                placeholder="e.g. the owner's name"
                className={inputClass}
              />
            </Field>

            <Field
              label="Amount (₹)"
              hint={
                amountBad
                  ? undefined
                  : 'Rupees and paise, e.g. 250000 or 1000.50. Converted to whole paise before it is sent — money is never a float here.'
              }
            >
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                placeholder="250000"
                className={`${inputClass} ${amountBad ? 'border-red-500/60' : ''}`}
              />
              {amountBad && (
                <p className="text-red-400 text-xs mt-1 leading-relaxed">
                  That is not an amount. Give rupees with at most two decimal places
                  and no minus sign — a movement the other way is the other direction,
                  not a negative one.
                </p>
              )}
              {paise !== null && (
                <p className="text-slate-500 text-xs mt-1 tabular-nums">
                  Sending {formatInrMinor(paise)} ({paise} paise).
                </p>
              )}
            </Field>

            <Field label="Method">
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className={inputClass}
              >
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field
            label="Bank reference (required)"
            hint="A UTR or transaction id, in both directions. A movement between the business and an owner that cannot be matched against a statement is exactly the movement that should be easiest to prove — the API refuses without one."
          >
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="e.g. HDFCN52026081200001"
              className={`${inputClass} font-mono`}
            />
          </Field>

          <Field
            label={`Reason (required, at least ${MIN_REASON} characters)`}
            hint="It goes in the audit log against your name. Whoever verifies and signs this reads it."
          >
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder={
                direction === 'in'
                  ? 'e.g. funding the August coin float ahead of the festival week'
                  : 'e.g. repaying part of the founding capital now that cash allows it'
              }
              className={`${inputClass} resize-none`}
            />
          </Field>

          <div className="flex items-start gap-2 bg-sky-500/10 border border-sky-500/25 rounded-lg px-3 py-2">
            <Info size={13} className="text-sky-400 mt-0.5 shrink-0" />
            <p className="text-sky-100/90 text-xs leading-relaxed">
              Whichever direction this is, it is <strong>not</strong> revenue and{' '}
              <strong>not</strong> an expense. It changes the bank and it changes what
              the business owes its owners. It does not touch profit.
            </p>
          </div>

          {error && (
            <p className="text-red-400 text-sm flex items-start gap-2">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              {error}
            </p>
          )}
        </div>

        <div className="flex gap-3 px-6 py-4 border-t border-slate-800">
          <button
            onClick={onClose}
            className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!ready || saving}
            className="flex-1 bg-pink-600 hover:bg-pink-500 disabled:opacity-40 text-white font-medium rounded-lg px-4 py-2.5 text-sm transition-colors flex items-center justify-center gap-2"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Record the movement
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Settle ────────────────────────────────────────────────────────────────────

function SettleModal({
  card, onClose, onSettled,
}: {
  card: CapitalCard
  onClose: () => void
  onSettled: (card: CapitalCard, message: string) => void
}) {
  const p = capitalPayload(card)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    setSaving(true)
    setError('')
    try {
      const settled = await capital.settle(card.id, reason.trim())
      onSettled(
        settled,
        `Settled ${formatInrMinor(p.amount_minor)} ${
          p.direction === 'in' ? 'into' : 'out of'
        } the business for ${p.owner_name || p.owner_uid}. The capital account below now ` +
          'includes it; profit is unchanged, because capital never reaches profit.',
      )
      onClose()
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'The settlement was not recorded. Nothing changed — try again.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-start justify-between px-6 py-4 border-b border-slate-800">
          <div>
            <h3 className="text-white font-semibold">Settle this movement</h3>
            <p className="text-slate-500 text-xs mt-0.5">
              The transfer has happened. Owners only.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="mx-6 my-4 bg-slate-800 rounded-xl p-4">
          <p className="text-white font-semibold">
            {p.direction ? DIRECTION_LABEL[p.direction] : card.title}
          </p>
          <p className="text-slate-500 text-xs mt-0.5">
            {p.owner_name || p.owner_uid} · {p.method || 'method not recorded'} ·{' '}
            <span className="font-mono">{p.reference || 'no reference'}</span>
          </p>
          <p
            className={`text-2xl font-bold tabular-nums mt-2 ${
              p.direction === 'in' ? 'text-emerald-300' : 'text-orange-300'
            }`}
          >
            {formatInrMinor(p.amount_minor)}
          </p>
        </div>

        <div className="px-6 space-y-4">
          <Field
            label="Note (optional)"
            hint="Recorded on the audit entry. The card's own reason is kept either way."
          >
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Anything worth recording about the transfer…"
              className={inputClass}
            />
          </Field>

          <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2">
            <AlertTriangle size={13} className="text-amber-400 mt-0.5 shrink-0" />
            <p className="text-amber-100/90 text-xs leading-relaxed">
              This says the money has actually moved between the business and the
              owner. It changes what the business owes them. It is still not revenue
              and still not an expense.
            </p>
          </div>

          {error && (
            <p className="text-red-400 text-sm flex items-start gap-2">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              {error}
            </p>
          )}
        </div>

        <div className="flex gap-3 px-6 py-4 mt-4 border-t border-slate-800">
          <button
            onClick={onClose}
            className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={saving}
            className="flex-1 bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white font-medium rounded-lg px-4 py-2.5 text-sm transition-colors flex items-center justify-center gap-2"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
            Record the transfer
          </button>
        </div>
      </div>
    </div>
  )
}

// ── One movement card ─────────────────────────────────────────────────────────

function MovementRow({
  card, isOwner, onSettle,
}: {
  card: CapitalCard
  isOwner: boolean
  onSettle: (card: CapitalCard) => void
}) {
  const p = capitalPayload(card)
  const inbound = p.direction === 'in'

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-white font-medium flex items-center gap-2">
            {inbound ? (
              <ArrowDownLeft size={14} className="text-emerald-400 shrink-0" />
            ) : (
              <ArrowUpRight size={14} className="text-orange-400 shrink-0" />
            )}
            {p.direction ? DIRECTION_LABEL[p.direction] : card.title}
          </p>
          <p className="text-slate-500 text-xs mt-0.5">
            {p.owner_name || p.owner_uid || 'owner not recorded'} ·{' '}
            {p.method || 'method not recorded'} ·{' '}
            <span className="font-mono">{p.reference || 'no reference'}</span>
          </p>
        </div>
        <div className="text-right shrink-0">
          <p
            className={`text-lg font-semibold tabular-nums ${
              inbound ? 'text-emerald-300' : 'text-orange-300'
            }`}
          >
            {formatInrMinor(p.amount_minor)}
          </p>
          <div className="mt-1">
            <StagePill stage={card.stage} />
          </div>
        </div>
      </div>

      <div className="mt-2.5">
        <StageTrack stage={card.stage} />
      </div>

      <p className="text-slate-500 text-xs mt-2 leading-relaxed">
        {CAPITAL_STAGE_LABEL[card.stage]}. Recorded by {card.requested_by?.name || '—'} on{' '}
        {formatDateTime(card.created_at)}
        {card.stage === 'executed' && card.executed_at
          ? ` · settled ${formatDateTime(card.executed_at)}`
          : ''}
        .
      </p>

      {card.reason && (
        <p className="text-slate-400 text-xs mt-1.5 leading-relaxed">
          <span className="text-slate-600">Reason:</span> {card.reason}
        </p>
      )}
      {card.rejection_reason && (
        <p className="text-red-300/90 text-xs mt-1.5 leading-relaxed">
          Rejected: {card.rejection_reason}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-4 mt-3">
        <Link
          href="/board"
          className="inline-flex items-center gap-1.5 text-slate-400 hover:text-white text-xs transition-colors"
        >
          Open on the board <ChevronRight size={11} />
        </Link>
        {card.stage === 'approved' &&
          (isOwner ? (
            <button
              onClick={() => onSettle(card)}
              className="inline-flex items-center gap-1.5 text-green-400 hover:text-green-300 text-xs font-medium transition-colors"
            >
              <CheckCircle2 size={12} /> Settle
            </button>
          ) : (
            <span className="text-slate-600 text-xs">
              Signed and unsettled. Only a business owner can record the transfer.
            </span>
          ))}
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function OwnerCapitalPage() {
  const { crmUser, apiUser, loading: authLoading, apiReady, apiError } = useAuth()
  // The Observer has no Firestore `crmUser` on purpose, so `canAccess` alone
  // locks the one role that exists to watch the money out of the money. The API
  // grants them `can_read_all`; they are admitted here and the API decides the
  // rest. Same pattern as app/reports/page.tsx.
  const isObserver = apiUser?.role === 'observer'
  const allowed = isObserver || canAccess(crmUser, FINANCE_ROLES)
  /** `require_owner` on `/capital/{id}/settle`. The API calls the role `owner`. */
  const isOwner = apiUser?.role === 'owner'
  /** `require_write` refuses the observer and nobody else internal. */
  const canWrite = !isObserver && !!apiUser

  const [account, setAccount] = useState<ReadResult<CapitalAccount> | null>(null)
  const [movements, setMovements] = useState<ReadResult<CapitalCard[]> | null>(null)
  const [flash, setFlash] = useState('')
  const [recording, setRecording] = useState(false)
  const [settleTarget, setSettleTarget] = useState<CapitalCard | null>(null)

  const load = useCallback(() => {
    if (!allowed || !apiReady) return
    setAccount(null)
    setMovements(null)
    // Two independent reads, and the account is the one that matters: the board
    // read may be refused for a role that can still see the account, and that
    // must not blank the figures. Neither may fall back to an empty list.
    attempt(capital.account(), 'capital.account').then(setAccount)
    attempt(capital.movements(BOARD_LIMIT), 'capital.movements').then(setMovements)
  }, [allowed, apiReady])

  useEffect(() => { load() }, [load])

  const owners = account?.ok ? account.value.owners : null
  const totals = account?.ok ? account.value.totals : null

  /** Names to offer in the form. Only owners the account already knows. */
  const knownOwners = useMemo(
    () =>
      (owners ?? []).map((o) => ({ uid: o.owner_uid, name: o.owner_name })),
    [owners],
  )

  /** Movements that have not settled — the ones with something still to do. */
  const openMovements = useMemo(
    () =>
      movements?.ok
        ? movements.value.filter(
            (c) => c.stage !== 'executed' && c.stage !== 'rejected',
          )
        : null,
    [movements],
  )

  if (authLoading) return <Loading label="Checking your access…" />
  if (!allowed) return <Denied what="the owners' capital account" />

  function afterChange(message: string) {
    setFlash(message)
    load()
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
        <div>
          <Link
            href="/finance"
            className="inline-flex items-center gap-1.5 text-slate-500 hover:text-slate-300 text-sm mb-2 transition-colors"
          >
            <ArrowLeft size={14} /> Finance
          </Link>
          <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-3">
            <HandCoins size={24} className="text-pink-400" />
            Owner capital
          </h1>
          <p className="text-slate-400 mt-1 text-sm max-w-2xl leading-relaxed">
            Money the owners put into the business from their own pocket, and money they
            take back out. Both are real cash and neither is trading. All amounts in
            Indian rupees (₹) — the API reports paise and they are converted once, here.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={load}
            title="Re-read the capital account"
            className="flex items-center gap-2 bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 rounded-lg px-3.5 py-2.5 text-sm transition-colors"
          >
            <RefreshCw size={14} /> Refresh
          </button>
          {canWrite && (
            <button
              onClick={() => setRecording(true)}
              className="flex items-center gap-2 bg-pink-600 hover:bg-pink-500 text-white rounded-lg px-3.5 py-2.5 text-sm font-medium transition-colors whitespace-nowrap"
            >
              <Plus size={14} /> Record a movement
            </button>
          )}
        </div>
      </div>

      {apiReady && apiError && <Warning>{apiError}</Warning>}
      {flash && (
        <div className="flex items-start justify-between gap-3 bg-green-500/10 border border-green-500/30 rounded-xl px-4 py-3">
          <span className="flex items-start gap-2 text-green-300 text-sm leading-relaxed">
            <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> {flash}
          </span>
          <button onClick={() => setFlash('')} className="text-green-400 hover:text-green-200">
            <X size={13} />
          </button>
        </div>
      )}

      {/* ── The sentence this page exists to say ──────────────────────────── */}
      <div className="bg-sky-500/[0.07] border border-sky-500/30 rounded-2xl p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <Scale size={20} className="text-sky-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sky-100 font-semibold text-base">
              This is not trading. Capital is not revenue, drawings are not an expense,
              and neither one reaches profit.
            </p>
            <p className="text-sky-100/80 text-sm mt-2 leading-relaxed max-w-3xl">
              Money an owner puts in lands in the bank exactly as a coin seller&apos;s
              payment does — but the seller bought something and the owner did not, so
              the business owes it back. Counted as revenue, a company funding itself
              would read as a company earning. Taking it back out is the repayment of
              that debt, not a cost of trading; counted as an expense, a repaid loan
              would read as a loss in the very month the business finally afforded to
              pay its founders back.
            </p>
            <p className="text-sky-100/80 text-sm mt-2 leading-relaxed max-w-3xl">
              What the business earns and what it costs to run are on the{' '}
              <Link
                href="/finance/profit"
                className="text-pink-300 hover:text-pink-200 underline underline-offset-2"
              >
                profit
              </Link>{' '}
              and{' '}
              <Link
                href="/finance/costs"
                className="text-pink-300 hover:text-pink-200 underline underline-offset-2"
              >
                operating costs
              </Link>{' '}
              screens. Nothing on this page belongs in either of them.
            </p>
          </div>
        </div>
      </div>

      {/* ── The account ───────────────────────────────────────────────────── */}
      {!apiReady ? (
        <Loading label="Waiting for the API session…" />
      ) : account === null ? (
        <Loading label="Reading the capital account…" />
      ) : !account.ok ? (
        <UnavailablePanel
          failure={account}
          what="The capital account"
          onRetry={load}
        />
      ) : (
        <>
          <section className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide mb-2">
                <ArrowDownLeft size={13} className="text-emerald-400" /> Introduced (INR)
              </div>
              <p className="text-2xl font-bold text-emerald-300 tabular-nums">
                {formatInrMinorShort(totals?.introduced_minor)}
              </p>
              <p className="text-slate-500 text-xs mt-1.5 leading-relaxed">
                Put in by {totals?.owners ?? 0} owner
                {totals?.owners === 1 ? '' : 's'}, across settled movements only.
              </p>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide mb-2">
                <ArrowUpRight size={13} className="text-orange-400" /> Drawn back (INR)
              </div>
              <p className="text-2xl font-bold text-orange-300 tabular-nums">
                {formatInrMinorShort(totals?.drawn_minor)}
              </p>
              <p className="text-slate-500 text-xs mt-1.5 leading-relaxed">
                Taken back out. Repayment of a debt, not a cost of trading.
              </p>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide mb-2">
                <Scale size={13} /> Still owed to owners (INR)
              </div>
              <p className="text-2xl font-bold text-sky-300 tabular-nums">
                {formatInrMinorShort(totals?.outstanding_minor)}
              </p>
              <p className="text-slate-500 text-xs mt-1.5 leading-relaxed">
                Introduced less drawn. A <span className="text-slate-300">liability</span>{' '}
                of the business, not equity it can spend.
              </p>
            </div>
          </section>

          <section className="space-y-3">
            <div>
              <h2 className="text-lg font-semibold text-white">Per owner</h2>
              <p className="text-slate-500 text-sm mt-0.5 max-w-3xl leading-relaxed">
                Settled movements only. A signed card whose transfer has not happened is
                not money the business holds, and counting it would overstate both the
                cash and the debt — those cards are listed further down instead.
              </p>
            </div>

            {!owners || owners.length === 0 ? (
              <Empty
                title="No settled capital movement exists"
                icon={<HandCoins size={26} />}
                hint="Nobody has put money in or taken it out through a settled card. If the owners have funded this business, that funding has not been recorded here — which is a gap in the record, not a balance of zero."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[640px]">
                  <thead>
                    <tr className="text-slate-500 text-[11px] uppercase tracking-wide border-b border-slate-800">
                      <th className="text-left font-medium py-2 pr-3">Owner</th>
                      <th className="text-right font-medium py-2 px-3">Introduced</th>
                      <th className="text-right font-medium py-2 px-3">Drawn back</th>
                      <th className="text-right font-medium py-2 px-3">Still outstanding</th>
                      <th className="text-right font-medium py-2 pl-3">Movements</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {owners.map((o) => (
                      <tr key={o.owner_uid}>
                        <td className="py-2.5 pr-3">
                          <span className="text-white font-medium">{ownerLabel(o)}</span>
                          <span className="block text-slate-600 text-xs font-mono">
                            {o.owner_uid}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right text-emerald-300 tabular-nums">
                          {formatInrMinor(o.introduced_minor)}
                        </td>
                        <td className="py-2.5 px-3 text-right text-orange-300 tabular-nums">
                          {formatInrMinor(o.drawn_minor)}
                        </td>
                        <td
                          className={`py-2.5 px-3 text-right font-semibold tabular-nums ${
                            o.outstanding_minor < 0 ? 'text-red-300' : 'text-sky-300'
                          }`}
                        >
                          {formatInrMinor(o.outstanding_minor)}
                        </td>
                        <td className="py-2.5 pl-3 text-right text-slate-400 tabular-nums">
                          {o.movements.length}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-700">
                      <td className="py-3 pr-3 text-white font-semibold">
                        Total
                        <span className="block text-slate-600 text-xs font-normal">
                          {totals?.owners ?? owners.length} owner
                          {(totals?.owners ?? owners.length) === 1 ? '' : 's'}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-right text-emerald-200 font-semibold tabular-nums">
                        {formatInrMinor(totals?.introduced_minor)}
                      </td>
                      <td className="py-3 px-3 text-right text-orange-200 font-semibold tabular-nums">
                        {formatInrMinor(totals?.drawn_minor)}
                      </td>
                      <td className="py-3 px-3 text-right text-sky-200 font-semibold tabular-nums">
                        {formatInrMinor(totals?.outstanding_minor)}
                      </td>
                      <td className="py-3 pl-3" />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            {totals?.note && (
              <p className="text-slate-600 text-xs leading-relaxed max-w-3xl">
                {totals.note}
              </p>
            )}
          </section>
        </>
      )}

      {/* ── The movement list ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Movements</h2>
          <p className="text-slate-500 text-sm mt-0.5 max-w-3xl leading-relaxed">
            Every capital card on the money board, at whatever stage it reached. This is
            where a movement that has been signed and not transferred is visible —
            <em> Signed</em> is not <em>Settled</em>, and only the second one is money
            that has actually moved.
          </p>
        </div>

        {!apiReady ? (
          <Loading label="Waiting for the API session…" />
        ) : movements === null ? (
          <Loading label="Reading the money board…" />
        ) : !movements.ok ? (
          <UnavailablePanel
            failure={movements}
            what="The capital movement list"
            onRetry={load}
          />
        ) : movements.value.length === 0 ? (
          <Empty
            title="No capital card is on the board"
            hint="Nobody has recorded a movement in either direction. That is an absence of records, not a statement that the owners have funded nothing."
          />
        ) : (
          <>
            {openMovements && openMovements.length > 0 && (
              <Warning>
                <span className="font-semibold">
                  {openMovements.length} movement
                  {openMovements.length === 1 ? ' is' : 's are'} recorded and not settled.
                </span>{' '}
                The account above counts none of them, on purpose — until the transfer
                happens the business neither holds that cash nor owes it.
              </Warning>
            )}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              {movements.value.map((card) => (
                <MovementRow
                  key={card.id}
                  card={card}
                  isOwner={isOwner}
                  onSettle={setSettleTarget}
                />
              ))}
            </div>
            <p className="text-slate-600 text-xs leading-relaxed">
              Read from the money board, which is scoped by the API to what your role may
              see and truncated at {BOARD_LIMIT} cards. If a movement you expect is
              missing, treat it as not shown rather than as not existing.
            </p>
          </>
        )}
      </section>

      {/* ── And once more, because it is the thing that gets misread ──────── */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5 flex items-start gap-3">
        <Info size={16} className="text-sky-400 mt-0.5 shrink-0" />
        <div className="text-sm text-slate-400 leading-relaxed">
          <p className="text-slate-200 font-medium">
            Recording a movement transfers nothing, and an owner cannot sign their own
            card.
          </p>
          <p className="mt-1.5">
            A capital card goes <em>Recorded → Under review → Awaiting sign-off →
            Signed → Settled</em>, on the same{' '}
            <Link
              href="/board"
              className="text-pink-400 hover:text-pink-300 underline underline-offset-2"
            >
              money board
            </Link>{' '}
            as everything else and under the same separation of duties. That applies with
            full force here: somebody putting money in, or taking it out, is precisely the
            movement that needs the other owner&apos;s name on it. &ldquo;How much did I
            put in&rdquo; is a question partners will eventually disagree about, and the
            answer needs two names on it.
          </p>
          <p className="mt-1.5">
            None of it is revenue and none of it is a cost. The figures above change the
            bank and change what the business owes its owners —{' '}
            <span className="text-slate-300">they never reach profit</span>.
          </p>
        </div>
      </div>

      {recording && (
        <RecordMovementModal
          knownOwners={knownOwners}
          onClose={() => setRecording(false)}
          onRecorded={(_card, message) => afterChange(message)}
        />
      )}

      {settleTarget && (
        <SettleModal
          card={settleTarget}
          onClose={() => setSettleTarget(null)}
          onSettled={(_card, message) => afterChange(message)}
        />
      )}
    </div>
  )
}
