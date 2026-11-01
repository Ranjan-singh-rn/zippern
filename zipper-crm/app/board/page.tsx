'use client'

/**
 * The money board.
 *
 *   Requested → Under Review → Awaiting Sign-off → Approved → Executed
 *
 * Teams verify, owners sign. The rules that matter — nobody verifies their own
 * card, nobody signs a card they raised or verified — are enforced by the API,
 * not here. This screen surfaces the refusal when it happens, which is the
 * point: the reason should be visible, not silently hidden by a disabled button.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowRight, CheckCircle2, Clock, Coins, FileText, Loader2,
  PenLine, RefreshCw, ShieldCheck, X, XCircle, Zap,
} from 'lucide-react'
import api, { ApiError, type Card, type Stage } from '@/lib/api'
import { useAuth } from '@/components/AuthProvider'
import { ErrorState } from '@/components/ui/States'
import { IdentityBlock } from '@/components/ui/Identity'
import { subjectTarget } from '@/lib/identity'
import { useIdentities } from '@/lib/useIdentities'

const MIN_REASON = 3

/**
 * Every stage the API can put a card in.
 *
 * `rejected` and `failed` were missing, so a card in either simply vanished
 * from the board. `failed` is the worse omission by far: it is the state an
 * execution lands in when an owner has signed and the transfer did not go
 * through, and it was the one state nobody could see.
 */
const COLUMNS: { stage: Stage; label: string; hint: string }[] = [
  { stage: 'requested',        label: 'Requested',      hint: 'Raised, not yet picked up' },
  { stage: 'under_review',     label: 'Under Review',   hint: 'Being verified' },
  { stage: 'awaiting_signoff', label: 'Awaiting Sign-off', hint: 'Verified — needs an owner' },
  { stage: 'approved',         label: 'Approved',       hint: 'Signed — money has NOT moved' },
  { stage: 'executed',         label: 'Executed',       hint: 'Money moved' },
  { stage: 'failed',           label: 'Failed',         hint: 'Signed, and the transfer did not go through' },
  { stage: 'rejected',         label: 'Rejected',       hint: 'Refused — nothing moved' },
]

/** Card types whose money is moved by `POST /users/balance-cards/{id}/execute`. */
const BALANCE_CARD_TYPES = new Set(['balance_credit', 'balance_debit'])

const STAGE_ACCENT: Record<Stage, string> = {
  requested:        'border-slate-700',
  under_review:     'border-blue-600/50',
  awaiting_signoff: 'border-amber-500/60',
  approved:         'border-green-600/50',
  executed:         'border-slate-700',
  rejected:         'border-red-600/50',
  failed:           'border-red-600/50',
}

function money(amount: number, currency: string) {
  if (currency === 'commission') return `₹${(amount / 100).toLocaleString('en-IN')}`
  const symbol = currency === 'diamonds' ? '💎' : currency === 'beans' ? '🫘' : '🪙'
  return `${symbol} ${amount.toLocaleString('en-IN')}`
}

function ageOf(iso: string) {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

export default function MoneyBoard() {
  // The board is entirely API-backed, and the API session is exchanged after
  // this component mounts. Loading before it exists threw `Not signed in` (401)
  // and pinned it to the screen for good — the board looked broken on every
  // cold start. See app/finance/cash/page.tsx for the same gate.
  const { apiReady, apiError } = useAuth()
  const [cards, setCards] = useState<Card[]>([])
  const [me, setMe] = useState<{ role: string; uid: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Card | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  // Audit C-9: bulk signing is confirmed with the count and the totals per
  // currency — never one click.
  const [confirmBulk, setConfirmBulk] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)

  const isOwner = me?.role === 'owner'
  const isObserver = me?.role === 'observer'

  const load = useCallback(async () => {
    if (!apiReady) return
    setLoading(true)
    setError('')
    try {
      const [list, who] = await Promise.all([api.cards.list(undefined, 300), api.auth.me()])
      setCards(list)
      setMe({ role: who.role, uid: who.uid })
      // Re-point an open panel at the fresh card. An execution that fails moves
      // the card to `failed` server-side before the error comes back, so the
      // panel must not keep showing the stage it had before the attempt.
      setSelected((current) =>
        current ? list.find((c) => c.id === current.id) ?? current : null,
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the board.')
    } finally {
      setLoading(false)
    }
  }, [apiReady])

  // `apiReady` is a dependency of `load`, so the session landing re-runs this
  // effect and the board fills itself in. No manual refresh required.
  useEffect(() => { load() }, [load])

  const awaiting = cards.filter((c) => c.stage === 'awaiting_signoff')
  /**
   * The cards this owner may actually sign.
   *
   * Both rules, not one. This used to exclude only cards you raised, so a card
   * you had *verified* stayed selectable — "Select all" then picked it up, the
   * server refused that one alone, and the result came back as
   * "12 signed. 1 refused: You verified this card." Correct, and a confusing
   * way to find out.
   */
  const signable = awaiting.filter(
    (c) => c.requested_by.uid !== me?.uid && c.verified_by?.uid !== me?.uid,
  )
  const failed = cards.filter((c) => c.stage === 'failed')
  const unexecuted = cards.filter(
    (c) => c.stage === 'approved' && BALANCE_CARD_TYPES.has(c.type),
  )

  /** The cards about to be signed, and their totals by currency (C-9). */
  const bulkCards = cards.filter((c) => checked.has(c.id))
  const bulkTotals = bulkCards.reduce<Record<string, number>>((acc, c) => {
    acc[c.currency] = (acc[c.currency] ?? 0) + (Number(c.amount) || 0)
    return acc
  }, {})

  async function bulkSign() {
    if (checked.size === 0) return
    setBulkBusy(true)
    try {
      const res = await api.cards.signBulk(Array.from(checked))
      setChecked(new Set())
      setConfirmBulk(false)
      await load()
      if (res.failed.length) {
        setError(
          `${res.signed} signed. ${res.failed.length} refused: ` +
          res.failed.map((f) => f.error).join(' · '),
        )
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Bulk signing failed.')
    } finally {
      setBulkBusy(false)
    }
  }

  // A session that could not be established is terminal and is reported as an
  // error. A session still in flight is a loading state — showing its absence
  // as "Not signed in" is what made a cold start look like a broken board.
  if (!apiReady && apiError) {
    return <ErrorState message={apiError} />
  }

  if (loading || !apiReady) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3">
        <Loader2 size={26} className="animate-spin text-pink-500" />
        <p className="text-slate-500 text-sm">
          {apiReady ? 'Reading the board…' : 'Signing in to the business API…'}
        </p>
      </div>
    )
  }

  return (
    <div className="max-w-[1600px] mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Money board</h1>
          <p className="text-slate-400 text-sm mt-1">
            Teams verify. Owners sign. Nothing moves without both.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isOwner && checked.size > 0 && (
            <button
              onClick={() => setConfirmBulk(true)}
              className="flex items-center gap-2 bg-green-600 hover:bg-green-500 text-white font-semibold rounded-lg px-4 py-2 text-sm transition-colors"
            >
              <PenLine size={15} /> Sign {checked.size} card{checked.size > 1 ? 's' : ''}…
            </button>
          )}
          <button
            onClick={load}
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2 text-sm transition-colors"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {/* Audit C-9: the bulk signature names what it signs — count, each card,
          and the total per currency — before anything is signed. */}
      {confirmBulk && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => !bulkBusy && setConfirmBulk(false)} />
          <div className="relative w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl max-h-[85vh] flex flex-col">
            <div className="px-6 py-4 border-b border-slate-800">
              <h2 className="text-white font-semibold">Sign {bulkCards.length} card{bulkCards.length === 1 ? '' : 's'}?</h2>
              <p className="text-slate-400 text-xs mt-1">
                Your signature approves every card below. Each one then moves on its own execution — nothing moves from this dialog.
              </p>
            </div>
            <div className="px-6 py-3 border-b border-slate-800 flex flex-wrap gap-2">
              {Object.entries(bulkTotals).map(([currency, total]) => (
                <span key={currency} className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-white font-semibold">
                  {money(total, currency)} <span className="text-slate-500 font-normal text-xs">{currency} total</span>
                </span>
              ))}
            </div>
            <div className="overflow-y-auto px-6 py-3 divide-y divide-slate-800/60">
              {bulkCards.map((c) => (
                <div key={c.id} className="py-2 flex items-start justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <p className="text-slate-200 truncate">{c.title}</p>
                    <p className="text-slate-500 text-xs">{c.type.replace(/_/g, ' ')} · {c.team} · raised by {c.requested_by.name}</p>
                  </div>
                  <span className="text-white font-medium whitespace-nowrap">{money(c.amount, c.currency)}</span>
                </div>
              ))}
            </div>
            <div className="px-6 py-4 border-t border-slate-800 flex gap-3">
              <button
                onClick={() => setConfirmBulk(false)}
                disabled={bulkBusy}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold rounded-lg px-4 py-2.5 text-sm"
              >
                Cancel
              </button>
              <button
                onClick={bulkSign}
                disabled={bulkBusy || bulkCards.length === 0}
                className="flex-1 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white font-semibold rounded-lg px-4 py-2.5 text-sm flex items-center justify-center gap-2"
              >
                {bulkBusy ? <Loader2 size={14} className="animate-spin" /> : <PenLine size={14} />}
                Sign {bulkCards.length} card{bulkCards.length === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </div>
      )}

      {isObserver && (
        <div className="mb-5 flex items-center gap-2 bg-slate-800/60 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-300">
          <ShieldCheck size={15} className="text-slate-400" />
          You are signed in as the observer — everything is visible, nothing is editable.
        </div>
      )}

      {isOwner && signable.length > 0 && (
        <div className="mb-5 flex items-center justify-between gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
          <div className="flex items-center gap-2 text-amber-200 text-sm">
            <Clock size={15} />
            {signable.length} card{signable.length > 1 ? 's' : ''} waiting on your signature
          </div>
          <button
            onClick={() => setChecked(new Set(signable.map((c) => c.id)))}
            className="text-amber-200 hover:text-white text-xs underline underline-offset-2"
          >
            Select all
          </button>
        </div>
      )}

      {/* A signed card that never executed is the failure this board exists to
          expose. Both of these used to be invisible: one because nothing could
          execute it, the other because `failed` had no column at all. */}
      {failed.length > 0 && (
        <div className="mb-5 flex items-start gap-2 bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3">
          <XCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-red-200 text-sm font-semibold">
              {failed.length} card{failed.length === 1 ? '' : 's'} failed to execute.
            </p>
            <p className="text-red-200/80 text-sm mt-0.5">
              An owner signed {failed.length === 1 ? 'it' : 'them'} and the money
              did not move. Open the card for what the server said — this does not
              resolve itself.
            </p>
          </div>
        </div>
      )}

      {unexecuted.length > 0 && (
        <div className="mb-5 flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
          <Coins size={15} className="text-amber-300 mt-0.5 shrink-0" />
          <div>
            <p className="text-amber-100 text-sm font-semibold">
              {unexecuted.length} balance card{unexecuted.length === 1 ? ' is' : 's are'}{' '}
              signed but not executed.
            </p>
            <p className="text-amber-100/80 text-sm mt-0.5">
              Nothing has moved on {unexecuted.length === 1 ? 'it' : 'them'} yet.
              {isOwner
                ? ' Open the card and execute it — that is the step that changes the balance.'
                : ' An owner has to execute each one; the balance does not change until they do.'}
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-5 flex items-start justify-between gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3">
          <div className="flex items-start gap-2">
            <AlertTriangle size={15} className="text-red-400 mt-0.5 shrink-0" />
            <p className="text-red-300 text-sm">{error}</p>
          </div>
          <button onClick={() => setError('')} className="text-red-400 hover:text-red-200">
            <X size={14} />
          </button>
        </div>
      )}

      {/* A board that failed to load rendered seven columns of "Nothing here"
          with a red banner above them — visually indistinguishable from a board
          on which genuinely nothing is pending. If the read failed and we hold
          no cards, say so and offer the retry instead. */}
      {error && cards.length === 0 ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-7 gap-4">
        {COLUMNS.map((col) => {
          const items = cards.filter((c) => c.stage === col.stage)
          return (
            <div key={col.stage} className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
              <div className="flex items-baseline justify-between mb-1">
                <h2 className="text-white text-sm font-semibold">{col.label}</h2>
                <span className="text-slate-500 text-xs">{items.length}</span>
              </div>
              <p className="text-slate-600 text-[11px] mb-3">{col.hint}</p>

              <div className="space-y-2">
                {items.length === 0 && (
                  <p className="text-slate-700 text-xs text-center py-6">Nothing here</p>
                )}
                {items.map((card) => (
                  <button
                    key={card.id}
                    onClick={() => setSelected(card)}
                    className={`w-full text-left bg-slate-800/80 hover:bg-slate-800 border-l-2 ${STAGE_ACCENT[card.stage]} border border-slate-700/60 rounded-lg p-3 transition-colors`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-white text-sm font-medium leading-snug">{card.title}</p>
                      {/* Same two rules as `signable` — a tick box offering a
                          card the server will refuse is the bug this pair of
                          conditions exists to prevent. */}
                      {isOwner && card.stage === 'awaiting_signoff'
                        && card.requested_by.uid !== me?.uid
                        && card.verified_by?.uid !== me?.uid && (
                        <input
                          type="checkbox"
                          checked={checked.has(card.id)}
                          onChange={(e) => {
                            e.stopPropagation()
                            setChecked((prev) => {
                              const next = new Set(prev)
                              next.has(card.id) ? next.delete(card.id) : next.add(card.id)
                              return next
                            })
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="mt-0.5 w-4 h-4 rounded accent-green-500 shrink-0"
                        />
                      )}
                    </div>
                    <p className="text-pink-300 text-sm font-semibold mt-1">
                      {money(card.amount, card.currency)}
                    </p>
                    <div className="flex items-center gap-2 mt-2 text-[11px] text-slate-500">
                      <span className="bg-slate-700/60 px-1.5 py-0.5 rounded">{card.team}</span>
                      <span>{ageOf(card.created_at)}</span>
                      {card.auto_verified && (
                        <span className="flex items-center gap-0.5 text-green-400">
                          <Zap size={9} /> auto
                        </span>
                      )}
                    </div>
                    <p className="text-slate-600 text-[11px] mt-1.5 truncate">
                      {card.requested_by.name || card.requested_by.role}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      )}

      {selected && (
        <CardPanel
          card={selected}
          canAct={!isObserver}
          isOwner={isOwner}
          myUid={me?.uid ?? ''}
          onClose={() => setSelected(null)}
          onChanged={async () => { await load(); setSelected(null) }}
          onRefresh={load}
        />
      )}
    </div>
  )
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function CardPanel({
  card, canAct, isOwner, myUid, onClose, onChanged, onRefresh,
}: {
  card: Card
  canAct: boolean
  isOwner: boolean
  myUid: string
  onClose: () => void
  onChanged: () => void
  /** Re-read the board without closing the panel. */
  onRefresh: () => Promise<void>
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [confirmExecute, setConfirmExecute] = useState(false)

  const iRaisedIt = card.requested_by.uid === myUid
  const iVerifiedIt = card.verified_by?.uid === myUid

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label)
    setErr('')
    try {
      await fn()
      onChanged()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'That did not work.')
    } finally {
      setBusy('')
    }
  }

  const canVerify = canAct && ['requested', 'under_review'].includes(card.stage)

  /**
   * Why signing may be refused, or empty if it will not be.
   *
   * The API enforces separation of duties and always did — but the button was
   * rendered green and enabled regardless, so the only way to discover the rule
   * was to press it and read a refusal. The owner's report was "why sign not
   * happening", which is exactly what an enabled control that does nothing
   * looks like from the outside.
   *
   * An action that cannot succeed should not be offered. This computes the same
   * two rules the server checks (`services/cards.py::sign`) so the reason is on
   * screen *before* the click. The server still decides; this only stops the
   * CRM asking a question it already knows the answer to.
   */
  const signBlockedBecause = !isOwner
    ? ''
    : iRaisedIt
      ? 'You raised this card. Another owner has to sign it — nobody signs their own request.'
      : iVerifiedIt
        ? 'You verified this card. Someone else has to sign it, so that two people have looked at every payment.'
        : ''

  const canSign = canAct && isOwner && card.stage === 'awaiting_signoff'

  const isBalanceCard = BALANCE_CARD_TYPES.has(card.type)
  const canExecute = canAct && isOwner && isBalanceCard && card.stage === 'approved'

  /**
   * Move the money on a signed balance card.
   *
   * The panel is deliberately kept open on failure and the board re-read. The
   * API marks the card `failed` before it raises, so closing on error would
   * hide both the message and the stage change — which is the precise shape of
   * "an owner signed and the money did not move" going unnoticed.
   */
  async function executeBalance() {
    setBusy('execute')
    setErr('')
    try {
      await api.users.executeBalanceCard(card.id)
      onChanged()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'The execution did not go through.')
      setConfirmExecute(false)
      setBusy('')
      await onRefresh()
    }
  }

  // `execution_result` is whatever the service recorded, so every field is read
  // defensively rather than assumed. On a failure it carries `error` and
  // `message`; on success, the ledger id and the balances either side.
  const result: Record<string, unknown> = card.execution_result ?? {}
  const failureMessage =
    typeof result.message === 'string'
      ? result.message
      : typeof result.error === 'string'
        ? result.error
        : ''
  const balanceAfter =
    typeof result.balance_after === 'number' ? result.balance_after : null
  const replicaSynced =
    typeof result.replica_synced === 'boolean' ? result.replica_synced : null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg h-screen bg-slate-900 border-l border-slate-800 flex flex-col shadow-2xl">
        <div className="flex items-start justify-between gap-3 px-6 py-5 border-b border-slate-800">
          <div>
            <h2 className="text-white text-lg font-semibold leading-snug">{card.title}</h2>
            <p className="text-pink-300 text-xl font-bold mt-1">
              {money(card.amount, card.currency)}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <Field label="Why">{card.reason}</Field>
          <Field label="Raised by">
            {card.requested_by.name || '—'}{' '}
            <span className="text-slate-500">({card.requested_by.role})</span>
            {iRaisedIt && <span className="ml-2 text-pink-400 text-xs">you</span>}
          </Field>
          <Field label="Subject"><CardSubject type={card.subject.type} id={card.subject.id} /></Field>
          <Field label="Team">{card.team}</Field>

          {/* Whose balance this is, in front of the person about to move it.
              These come from the payload the API wrote when the card was raised
              (`services/users.py:510`). */}
          {isBalanceCard && (
            <div className="bg-slate-800/60 border border-slate-700 rounded-lg px-4 py-3">
              <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-1.5">
                Account
              </p>
              <p className="text-slate-200 text-sm">
                {typeof card.payload.name === 'string' && card.payload.name
                  ? card.payload.name
                  : 'name not recorded'}
              </p>
              <Link
                href={`/users/${card.subject.id}`}
                className="text-pink-400 hover:text-pink-300 text-xs font-mono underline underline-offset-2"
              >
                {card.subject.id}
              </Link>
              {typeof card.payload.balance_before_request === 'number' && (
                <p className="text-slate-500 text-xs mt-1.5">
                  Held {card.payload.balance_before_request.toLocaleString('en-IN')}{' '}
                  {card.currency} when this was raised.
                </p>
              )}
            </div>
          )}

          {card.evidence?.length > 0 && (
            <div>
              <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-2">Evidence</p>
              <div className="space-y-2">
                {card.evidence.map((e, i) => (
                  <a
                    key={i}
                    href={e.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 hover:border-slate-600"
                  >
                    <FileText size={14} /> {e.label ?? 'Attachment'}
                  </a>
                ))}
              </div>
            </div>
          )}

          {card.verified_by && (
            <div className="bg-blue-500/10 border border-blue-500/25 rounded-lg px-4 py-3">
              <p className="text-blue-200 text-xs font-medium uppercase tracking-wide mb-1">
                Verified {card.auto_verified && '(automatically)'}
              </p>
              <p className="text-slate-200 text-sm">
                {card.verified_by.name} · {card.verified_at && ageOf(card.verified_at)} ago
              </p>
              {card.verification_note && (
                <p className="text-slate-400 text-sm mt-1.5">{card.verification_note}</p>
              )}
            </div>
          )}

          {card.signed_by && (
            <div className="bg-green-500/10 border border-green-500/25 rounded-lg px-4 py-3">
              <p className="text-green-200 text-xs font-medium uppercase tracking-wide mb-1">Signed</p>
              <p className="text-slate-200 text-sm">
                {card.signed_by.name} · {card.signed_at && ageOf(card.signed_at)} ago
              </p>
            </div>
          )}

          {card.stage === 'rejected' && (
            <div className="bg-red-500/10 border border-red-500/25 rounded-lg px-4 py-3">
              <p className="text-red-200 text-xs font-medium uppercase tracking-wide mb-1">Rejected</p>
              <p className="text-slate-300 text-sm">{card.rejection_reason}</p>
              <p className="text-slate-500 text-xs mt-1">by {card.rejected_by?.name}</p>
            </div>
          )}

          {card.stage === 'failed' && (
            <div className="bg-red-500/15 border border-red-500/40 rounded-lg px-4 py-3">
              <p className="text-red-200 text-xs font-medium uppercase tracking-wide mb-1">
                Execution failed
              </p>
              <p className="text-red-100 text-sm font-semibold">
                An owner signed this and the money did not move.
              </p>
              {failureMessage && (
                <p className="text-red-100/85 text-sm mt-1.5">{failureMessage}</p>
              )}
              <p className="text-red-200/70 text-sm mt-1.5">
                Nothing was transferred, so nothing needs unwinding — but the
                request is unmet. Fix the underlying problem and raise a fresh
                card, or reject this one so it stops sitting here.
              </p>
            </div>
          )}

          {card.stage === 'executed' && card.execution_result && (
            <div className="bg-green-500/10 border border-green-500/25 rounded-lg px-4 py-3">
              <p className="text-green-200 text-xs font-medium uppercase tracking-wide mb-1">
                Executed
              </p>
              <p className="text-slate-200 text-sm">
                {card.executed_at ? `${ageOf(card.executed_at)} ago` : 'The money moved.'}
              </p>
              {balanceAfter !== null && (
                <p className="text-slate-400 text-sm mt-1">
                  Balance after: {balanceAfter.toLocaleString('en-IN')} {card.currency}
                </p>
              )}
              {replicaSynced === false && (
                <p className="text-amber-300 text-sm mt-1.5">
                  The ledger moved but the Firestore replica did not update. The
                  app may still show the old figure.
                </p>
              )}
            </div>
          )}

          {card.stage === 'approved' && (
            <div className="bg-amber-500/10 border border-amber-500/25 rounded-lg px-4 py-3">
              <div className="flex items-start gap-2">
                <Clock size={15} className="text-amber-300 mt-0.5 shrink-0" />
                <div>
                  <p className="text-amber-100 text-sm font-semibold">
                    Signed, awaiting execution. Money has not moved.
                  </p>
                  {isBalanceCard ? (
                    isOwner ? (
                      <p className="text-amber-100/85 text-sm mt-1">
                        Executing is the moment{' '}
                        {card.amount > 0 ? 'the account is credited' : 'the account is debited'}.
                        It cannot be undone from here — a correction would be
                        another card.
                      </p>
                    ) : (
                      <p className="text-amber-100/85 text-sm mt-1">
                        Only an owner can execute a balance card. Until one does,
                        this balance is unchanged.
                      </p>
                    )
                  ) : (
                    <p className="text-amber-100/85 text-sm mt-1">
                      This card type is executed from its own screen — coin
                      purchases and credit from the seller record, payouts from
                      the agency record. If it stays here, nobody has done it.
                    </p>
                  )}
                </div>
              </div>

              {canExecute && (
                confirmExecute ? (
                  <div className="flex flex-wrap items-center gap-2 mt-3">
                    <button
                      onClick={executeBalance}
                      disabled={!!busy}
                      className="flex items-center gap-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white font-semibold rounded-lg px-4 py-2 text-sm transition-colors"
                    >
                      {busy === 'execute'
                        ? <Loader2 size={14} className="animate-spin" />
                        : <Coins size={14} />}
                      Yes — move {money(card.amount, card.currency)}
                    </button>
                    <button
                      onClick={() => setConfirmExecute(false)}
                      className="text-slate-400 hover:text-white text-sm px-3 py-2"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmExecute(true)}
                    className="mt-3 flex items-center gap-2 bg-green-600 hover:bg-green-500 text-white font-semibold rounded-lg px-4 py-2 text-sm transition-colors"
                  >
                    <Coins size={14} /> Execute — move the money
                  </button>
                )
              )}
            </div>
          )}

          {canAct && !['executed', 'rejected'].includes(card.stage) && (
            <div>
              <label className="block text-slate-400 text-xs font-medium uppercase tracking-wide mb-2">
                {canVerify ? 'What did you check?' : 'Note'}
                {canVerify && <span className="text-pink-400 ml-1">(required to verify)</span>}
              </label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder={
                  canVerify
                    ? 'Checked the UTR against the bank statement, amount matches…'
                    : 'Why — required to reject, optional to sign.'
                }
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
              />
              <p className="text-slate-600 text-xs mt-1">
                A rejection needs a reason of at least {MIN_REASON} characters — it
                is what the audit log stores.
              </p>
            </div>
          )}

          {err && (
            <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
              <AlertTriangle size={15} className="text-red-400 mt-0.5 shrink-0" />
              <p className="text-red-300 text-sm">{err}</p>
            </div>
          )}

          {/* Amber, not grey. This is the answer to "why can I not sign this",
              and it used to be two lines of `text-slate-500 text-xs` sitting
              under a green enabled button — which reads as a footnote, not as
              the reason the thing in front of you will not work. */}
          {signBlockedBecause && card.stage === 'awaiting_signoff' && (
            <div className="flex items-start gap-2.5 bg-amber-500/10 border border-amber-500/40 rounded-lg px-4 py-3">
              <ShieldCheck size={15} className="text-amber-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-amber-200 text-sm font-medium">
                  You cannot sign this one
                </p>
                <p className="text-amber-100/90 text-xs mt-1 leading-relaxed">
                  {signBlockedBecause}
                </p>
              </div>
            </div>
          )}
        </div>

        {canAct && !['executed', 'rejected'].includes(card.stage) && (
          <div className="px-6 py-4 border-t border-slate-800 flex gap-3">
            {/* The reason is required, not defaulted. This used to send the
                literal string "Rejected" when the box was empty, which is a
                rejection with no stated reason in the audit log. */}
            <button
              onClick={() => run('reject', () => api.cards.reject(card.id, note.trim()))}
              disabled={!!busy || note.trim().length < MIN_REASON}
              title={
                note.trim().length < MIN_REASON
                  ? `Give a reason of at least ${MIN_REASON} characters first.`
                  : undefined
              }
              className="flex items-center justify-center gap-1.5 bg-slate-800 hover:bg-red-600/20 hover:text-red-300 disabled:opacity-40 disabled:cursor-not-allowed text-slate-300 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors"
            >
              {busy === 'reject'
                ? <Loader2 size={15} className="animate-spin" />
                : <><XCircle size={15} /> Reject</>}
            </button>

            {canVerify && (
              <button
                onClick={() => run('verify', () => api.cards.verify(card.id, note))}
                disabled={!!busy || note.trim().length < MIN_REASON}
                className="flex-1 flex items-center justify-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors"
              >
                {busy === 'verify'
                  ? <Loader2 size={15} className="animate-spin" />
                  : <><CheckCircle2 size={15} /> Verify <ArrowRight size={13} /></>}
              </button>
            )}

            {canSign && (
              <button
                onClick={() => run('sign', () => api.cards.sign(card.id, note))}
                disabled={!!busy || !!signBlockedBecause}
                title={signBlockedBecause || undefined}
                className="flex-1 flex items-center justify-center gap-1.5 bg-green-600 hover:bg-green-500 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors"
              >
                {busy === 'sign'
                  ? <Loader2 size={15} className="animate-spin" />
                  : <><PenLine size={15} /> Sign</>}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * B1: who a card is about. A person (uid) or a partner record is named; any
 * other subject keeps its `type · id`. No contact details here — the board is
 * about money, and a name is all the reviewer needs to recognise the subject.
 */
function CardSubject({ type, id }: { type: string; id: string }) {
  const target = subjectTarget(type)
  const who = useIdentities({
    enabled: target !== null,
    people: target?.lookup === 'person' ? [id] : [],
    partners: target?.lookup === 'partner' ? [id] : [],
  })
  if (!target) return <>{type} · {id}</>
  const facts = target.lookup === 'person' ? who.people.get(id) : who.partners.get(id)
  return <IdentityBlock facts={facts} id={id} kind={target.kind} state={who.state} />
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-1">{label}</p>
      <p className="text-slate-200 text-sm leading-relaxed">{children}</p>
    </div>
  )
}
