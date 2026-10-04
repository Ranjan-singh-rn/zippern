'use client'

/**
 * Operating costs — what it costs to run the company.
 *
 * This is the screen that makes profit real. The owner defines profit as *"the
 * money we received for selling coin − our all expenditure"*, and until this
 * page existed there was nowhere in the CRM to enter the second half of that
 * sentence. No salary, no server bill, no gateway fee. Every "profit" the
 * business produced was therefore gross contribution *before* the cost of
 * running the company, and `/reports/profit-and-loss` said so on its own face —
 * an upper bound, forever, because nobody could ever close the gap.
 *
 * Three things on this page are not decoration.
 *
 * **An empty category is unknown, never ₹0.** The profit statement expects an
 * entry for each of the seven reported categories every period. A month with
 * nothing under `staff_salaries` does not mean nobody was paid; it means nobody
 * entered the payroll. Those categories are drawn with a NOT RECORDED state
 * rather than a zero, and the banner at the top counts them, because a
 * confident zero is worse than a gap: nobody double-checks a zero.
 *
 * **Raising a cost moves nothing.** `POST /expenses` puts a card in
 * `requested`. A second person verifies it on the board, an owner signs it, and
 * only then can an owner mark it paid. Four of the five stages are a record of
 * intent; one of them is money. Every stage chip on this page says which.
 *
 * **A failed read is not a zero.** Every read here goes through `attempt` and
 * lands in a `ReadResult`. If the register could not be read, the missing-
 * category count is not shown as seven and not shown as none — it is not shown
 * at all, and the refusal is, because "we could not read the costs" and "there
 * are no costs" are different sentences.
 */

import UploadField from '@/components/UploadField'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight, Copy,
  ExternalLink, FileText, Info, Loader2, Plus, RefreshCw, Repeat, Wallet, X,
} from 'lucide-react'

import { useAuth } from '@/components/AuthProvider'
import { canAccess, CrmRole } from '@/lib/auth'
import { ApiError, type Stage } from '@/lib/api'
import { attempt, type ReadResult } from '@/lib/readState'
import {
  Denied, Empty, Loading, UnavailablePanel, Warning,
} from '@/components/ui/States'
import { formatDateTime, formatInrMinor, formatInrMinorShort } from '@/lib/apiReports'
import {
  ALL_CATEGORIES, CATEGORY_LABELS, CATEGORY_SHORT, EXPENSE_STAGE_LABEL,
  EXPENSE_STAGE_SHORT, EXPENSE_STAGE_TRACK, MIN_REASON, REPORTED_CATEGORIES,
  STAGE_TONE, cardsInCategory, currentPeriod, expenses, expensePayload,
  invoiceUrl, isPeriod, missingReportedCategories, paidTotalMinor,
  paiseFromRupees, periodLabel, shiftPeriod, unpaidTotalMinor,
  type ExpenseCard, type ExpenseCategory, type RecurringCost,
  type RecurringWorklist,
} from '@/lib/apiExpenses'

/**
 * Who may open this screen.
 *
 * Both reads here are `require_internal` (backend/app/routers/expenses.py), so
 * the API would admit any staff role — this is narrower on purpose. Money
 * leaving the company is Finance's business: `raise_expense` puts every cost
 * card on the **Finance** board whoever raised it, and the rest of /finance is
 * gated on exactly these two roles. One door for the Finance section is worth
 * more than admitting a support member to a page they cannot act on. Narrower
 * than the API is safe; wider is a link to a page of 403s.
 */
const FINANCE_ROLES: CrmRole[] = ['superadmin', 'finance_admin']

/** `list_expenses` caps at 500; ask for a number and check what came back. */
const REGISTER_LIMIT = 300

// ── Small pieces ──────────────────────────────────────────────────────────────

function StagePill({ stage }: { stage: Stage }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${STAGE_TONE[stage]}`}
      title={EXPENSE_STAGE_LABEL[stage]}
    >
      {EXPENSE_STAGE_SHORT[stage]}
    </span>
  )
}

/**
 * Requested → under review → awaiting sign-off → approved → paid.
 *
 * Drawn on every card so the distance between "raised" and "the money left" is
 * visible rather than something a person is told once and has to remember.
 */
function StageTrack({ stage }: { stage: Stage }) {
  const here = EXPENSE_STAGE_TRACK.indexOf(stage)
  if (here < 0) {
    return (
      <span className={`inline-flex rounded px-2 py-1 text-xs ${STAGE_TONE[stage]}`}>
        {EXPENSE_STAGE_LABEL[stage]}
      </span>
    )
  }
  const SHORT: Record<string, string> = {
    requested: 'Raised',
    under_review: 'Review',
    awaiting_signoff: 'Sign-off',
    approved: 'Signed',
    executed: 'Paid',
  }
  return (
    <ol className="flex items-center gap-1 overflow-x-auto py-0.5" aria-label="Progress">
      {EXPENSE_STAGE_TRACK.map((s, i) => (
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
          {i < EXPENSE_STAGE_TRACK.length - 1 && (
            <ChevronRight size={11} className="text-slate-700" />
          )}
        </li>
      ))}
    </ol>
  )
}

/**
 * The period control.
 *
 * A month, not a range, because a cost card carries `period` as `YYYY-MM` and
 * the P&L asks "was this month's payroll entered". `DateRangePicker` answers a
 * different question and would have to be mangled to answer this one.
 */
function PeriodPicker({
  value, onChange,
}: {
  value: string
  onChange: (period: string) => void
}) {
  return (
    <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 rounded-lg px-1.5 py-1">
      <button
        onClick={() => onChange(shiftPeriod(value, -1))}
        title="Previous month"
        className="text-slate-500 hover:text-white p-1.5 rounded transition-colors"
      >
        <ChevronLeft size={14} />
      </button>
      <input
        type="month"
        value={value}
        onChange={(e) => {
          // An empty or half-typed value is dropped rather than sent — the API
          // refuses anything that is not YYYY-MM and there is no useful
          // fallback month to guess at.
          if (isPeriod(e.target.value)) onChange(e.target.value)
        }}
        className="bg-transparent text-slate-200 text-sm px-1 focus:outline-none [color-scheme:dark]"
      />
      <button
        onClick={() => onChange(shiftPeriod(value, 1))}
        title="Next month"
        className="text-slate-500 hover:text-white p-1.5 rounded transition-colors"
      >
        <ChevronRight size={14} />
      </button>
    </div>
  )
}

// ── Raise a cost ──────────────────────────────────────────────────────────────

interface RaiseForm {
  category: ExpenseCategory
  period: string
  payee: string
  amount: string
  invoiceRef: string
  evidenceUrl: string
  note: string
  reason: string
  recurring: boolean
}

function blankForm(period: string): RaiseForm {
  return {
    category: 'staff_salaries',
    period,
    payee: '',
    amount: '',
    invoiceRef: '',
    evidenceUrl: '',
    note: '',
    reason: '',
    recurring: false,
  }
}

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

function RaiseCostModal({
  period, repeatOf, onClose, onRaised,
}: {
  period: string
  /** The recurring cost being repeated, or null for a cost raised from scratch. */
  repeatOf: RecurringCost | null
  onClose: () => void
  onRaised: (card: ExpenseCard, message: string) => void
}) {
  const [form, setForm] = useState<RaiseForm>(() => {
    const base = blankForm(period)
    if (!repeatOf) return base
    // A repeat copies the category and the payee and asks for everything a
    // person has to look at again. The previous amount is shown beside the box,
    // never typed into it — a stale figure nobody re-read is the failure mode
    // the manual path exists to prevent.
    const category = (ALL_CATEGORIES as readonly string[]).includes(repeatOf.category)
      ? (repeatOf.category as ExpenseCategory)
      : 'other'
    return { ...base, category, payee: repeatOf.payee, recurring: true }
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function set<K extends keyof RaiseForm>(key: K, value: RaiseForm[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  const paise = paiseFromRupees(form.amount)
  const amountBad = form.amount.trim() !== '' && paise === null
  const ready =
    paise !== null &&
    isPeriod(form.period) &&
    form.payee.trim() !== '' &&
    form.invoiceRef.trim() !== '' &&
    form.reason.trim().length >= MIN_REASON

  async function submit() {
    if (!ready || paise === null) return
    setSaving(true)
    setError('')
    try {
      const body = {
        period: form.period,
        amount_inr_minor: paise,
        invoice_ref: form.invoiceRef.trim(),
        reason: form.reason.trim(),
        payee: form.payee.trim(),
        evidence_url: form.evidenceUrl.trim(),
        note: form.note.trim(),
      }
      const card = repeatOf
        ? await expenses.repeat(repeatOf.last_card_id, body)
        : await expenses.raise({
            ...body,
            category: form.category,
            recurring: form.recurring,
          })
      onRaised(
        card,
        `Raised ${formatInrMinor(card.amount)} for ${form.payee.trim()}. ` +
          'Nothing has been paid — it is on the money board waiting for a second ' +
          'person to verify it and an owner to sign it.',
      )
      onClose()
    } catch (err) {
      // The API refuses with a sentence written to be shown. Print it verbatim
      // rather than paraphrasing a rule this screen does not own.
      setError(
        err instanceof ApiError
          ? err.message
          : 'The cost was not raised. Nothing was recorded — try again.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl shadow-2xl my-8">
        <div className="flex items-start justify-between px-6 py-4 border-b border-slate-800">
          <div>
            <h3 className="text-white font-semibold">
              {repeatOf ? 'Repeat this recurring cost' : 'Raise a cost'}
            </h3>
            <p className="text-slate-500 text-xs mt-0.5 max-w-md leading-relaxed">
              This creates a card in <em>Requested</em>. It pays nobody and moves
              nothing — a second person verifies it and an owner signs it before
              anything can leave.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white shrink-0">
            <X size={18} />
          </button>
        </div>

        {repeatOf && (
          <div className="mx-6 mt-4 bg-slate-800/60 border border-slate-700 rounded-xl px-4 py-3">
            <p className="text-slate-200 text-sm">
              Repeating <span className="font-medium">{repeatOf.category_label}</span>{' '}
              — {repeatOf.payee || 'no payee recorded'}
            </p>
            <p className="text-slate-500 text-xs mt-1 leading-relaxed">
              Last raised for {repeatOf.last_period} at{' '}
              <span className="text-slate-300 tabular-nums">
                {formatInrMinor(repeatOf.last_amount_inr_minor)}
              </span>
              . The amount, the invoice reference and the reason are asked for
              again on purpose: a bill that changed is something a person notices
              here and a scheduler would not.
            </p>
          </div>
        )}

        <div className="px-6 py-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field
              label="Category"
              hint={
                repeatOf
                  ? 'Carried over from the card being repeated and not editable — a repeat is the same cost, not a new one.'
                  : 'This is the line the profit statement subtracts by. There is no mapping table in between.'
              }
            >
              <select
                value={form.category}
                disabled={!!repeatOf}
                onChange={(e) => set('category', e.target.value as ExpenseCategory)}
                className={`${inputClass} disabled:opacity-60`}
              >
                {ALL_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Period (the month the cost is for)"
              hint="A label on the card. The statement counts the cost in the month it was actually PAID, so “July salaries, paid 5 August” lands in August."
            >
              <input
                type="month"
                value={form.period}
                onChange={(e) => set('period', e.target.value)}
                className={`${inputClass} [color-scheme:dark]`}
              />
            </Field>

            <Field label="Payee" hint="Who is being paid. Required.">
              <input
                value={form.payee}
                onChange={(e) => set('payee', e.target.value)}
                placeholder="e.g. Hetzner, or a staff member's name"
                className={inputClass}
              />
            </Field>

            <Field
              label="Amount (₹)"
              hint={
                amountBad
                  ? undefined
                  : 'Rupees and paise, e.g. 45000 or 1250.05. Money is never a float here — this is converted to whole paise before it is sent.'
              }
            >
              <input
                value={form.amount}
                onChange={(e) => set('amount', e.target.value)}
                inputMode="decimal"
                placeholder="45000"
                className={`${inputClass} ${amountBad ? 'border-red-500/60' : ''}`}
              />
              {amountBad && (
                <p className="text-red-400 text-xs mt-1 leading-relaxed">
                  That is not an amount this business can pay. Give rupees with at
                  most two decimal places and no minus sign — a cost that came back
                  is a refund or a credit note, not a negative cost.
                </p>
              )}
              {paise !== null && (
                <p className="text-slate-500 text-xs mt-1 tabular-nums">
                  Sending {formatInrMinor(paise)} ({paise} paise).
                </p>
              )}
            </Field>

            <Field
              label="Invoice or receipt reference"
              hint="Required. If it has been used before the card still goes through, carrying a warning an owner sees before signing."
            >
              <input
                value={form.invoiceRef}
                onChange={(e) => set('invoiceRef', e.target.value)}
                placeholder="e.g. INV-2026-0812"
                className={`${inputClass} font-mono`}
              />
            </Field>

            <UploadField
              label="Invoice / evidence (optional)"
              value={form.evidenceUrl}
              onChange={(url) => set('evidenceUrl', url)}
              storagePath="evidence/expenses"
              accept="image/*,application/pdf"
              hint="The invoice itself — upload it, or paste a link if it lives elsewhere."
            />
          </div>

          <Field label="Note (optional)">
            <input
              value={form.note}
              onChange={(e) => set('note', e.target.value)}
              placeholder="Anything the verifier or the owner should know…"
              className={inputClass}
            />
          </Field>

          <Field
            label={`Reason (required, at least ${MIN_REASON} characters)`}
            hint="It goes in the audit log against your name, at both ends. A cost with no stated reason is not auditable, so the API does not accept one."
          >
            <textarea
              value={form.reason}
              onChange={(e) => set('reason', e.target.value)}
              rows={2}
              placeholder="e.g. August payroll for the ops team, approved headcount"
              className={`${inputClass} resize-none`}
            />
          </Field>

          {!repeatOf && (
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={form.recurring}
                onChange={(e) => set('recurring', e.target.checked)}
                className="mt-0.5 accent-pink-500"
              />
              <span className="text-sm text-slate-300">
                This cost repeats every month
                <span className="block text-slate-600 text-xs mt-0.5 leading-relaxed">
                  Ticking it puts this cost on the recurring worklist, so next
                  month it appears as something not yet entered. It does not
                  schedule anything — nothing raises a card on its own.
                </span>
              </span>
            </label>
          )}

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
            Raise the cost card
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Mark paid ─────────────────────────────────────────────────────────────────

function MarkPaidModal({
  card, onClose, onPaid,
}: {
  card: ExpenseCard
  onClose: () => void
  onPaid: (card: ExpenseCard, message: string) => void
}) {
  const [ref, setRef] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const payload = expensePayload(card)

  async function submit() {
    if (!ref.trim()) return
    setSaving(true)
    setError('')
    try {
      const paid = await expenses.pay(card.id, ref.trim())
      onPaid(
        paid,
        `${formatInrMinor(card.amount)} paid to ${payload.payee}. This is counted ` +
          'in the profit statement for the month it was paid, not for ' +
          `${payload.period || 'the period on the card'}.`,
      )
      onClose()
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'The payment was not recorded. Nothing changed — try again.',
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
            <h3 className="text-white font-semibold">Mark this cost paid</h3>
            <p className="text-slate-500 text-xs mt-0.5">
              This is the moment the money left. Owners only.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="mx-6 my-4 bg-slate-800 rounded-xl p-4">
          <p className="text-white font-semibold">{payload.payee || card.title}</p>
          <p className="text-slate-500 text-xs mt-0.5">
            {payload.category ? CATEGORY_LABELS[payload.category] : 'Uncategorised'} ·{' '}
            {payload.period || 'no period'} · {payload.invoice_ref || 'no reference'}
          </p>
          <p className="text-2xl font-bold text-orange-300 tabular-nums mt-2">
            {formatInrMinor(card.amount)}
          </p>
        </div>

        <div className="px-6 space-y-4">
          <Field
            label="Payment reference (UTR, transaction id)"
            hint="Required. It is how this reconciles against the bank statement later."
          >
            <input
              autoFocus
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="e.g. HDFCN52026081200001"
              className={`${inputClass} font-mono`}
            />
          </Field>

          <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2">
            <AlertTriangle size={13} className="text-amber-400 mt-0.5 shrink-0" />
            <p className="text-amber-100/90 text-xs leading-relaxed">
              Recording this says the transfer has happened. The profit statement
              counts it in the month of <em>this</em> action, not in the period
              written on the card.
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
            disabled={!ref.trim() || saving}
            className="flex-1 bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white font-medium rounded-lg px-4 py-2.5 text-sm transition-colors flex items-center justify-center gap-2"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Wallet size={14} />}
            Record the payment
          </button>
        </div>
      </div>
    </div>
  )
}

// ── One cost card ─────────────────────────────────────────────────────────────

function CostRow({
  card, isOwner, onMarkPaid,
}: {
  card: ExpenseCard
  isOwner: boolean
  onMarkPaid: (card: ExpenseCard) => void
}) {
  const p = expensePayload(card)
  const url = invoiceUrl(card)

  return (
    <div className="bg-slate-950/50 border border-slate-800 rounded-xl px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-white font-medium">{p.payee || card.title}</p>
          <p className="text-slate-500 text-xs mt-0.5 font-mono">
            {p.invoice_ref || 'no reference'}
            {p.recurring && (
              <span className="ml-2 font-sans text-slate-400">· recurring</span>
            )}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-lg font-semibold text-slate-100 tabular-nums">
            {formatInrMinor(card.amount)}
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
        {EXPENSE_STAGE_LABEL[card.stage]}. Raised by {card.requested_by?.name || '—'} on{' '}
        {formatDateTime(card.created_at)}
        {card.stage === 'executed' && card.executed_at
          ? ` · paid ${formatDateTime(card.executed_at)}`
          : ''}
        .
      </p>

      {card.reason && (
        <p className="text-slate-400 text-xs mt-1.5 leading-relaxed">
          <span className="text-slate-600">Reason:</span> {card.reason}
        </p>
      )}
      {p.note && (
        <p className="text-slate-400 text-xs mt-1 leading-relaxed">
          <span className="text-slate-600">Note:</span> {p.note}
        </p>
      )}
      {card.rejection_reason && (
        <p className="text-red-300/90 text-xs mt-1.5 leading-relaxed">
          Rejected: {card.rejection_reason}
        </p>
      )}

      {p.duplicate_reference && (
        <p className="text-amber-200 text-xs mt-2 flex items-start gap-1.5 leading-relaxed">
          <Copy size={12} className="mt-0.5 shrink-0" />
          This invoice reference appears on an earlier cost card. It is not a
          refusal — confirm it is a separate bill before signing.
        </p>
      )}

      {p.previous_amount_inr_minor !== null && (
        <p className="text-slate-500 text-xs mt-1.5 tabular-nums">
          Repeat of {p.repeats_period || 'an earlier card'} —
          was {formatInrMinor(p.previous_amount_inr_minor)}, now{' '}
          {formatInrMinor(card.amount)}.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-4 mt-3">
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-slate-400 hover:text-white text-xs transition-colors"
          >
            <ExternalLink size={11} /> Invoice
          </a>
        )}
        <Link
          href="/board"
          className="inline-flex items-center gap-1.5 text-slate-400 hover:text-white text-xs transition-colors"
        >
          Open on the board <ChevronRight size={11} />
        </Link>
        {card.stage === 'approved' &&
          (isOwner ? (
            <button
              onClick={() => onMarkPaid(card)}
              className="inline-flex items-center gap-1.5 text-green-400 hover:text-green-300 text-xs font-medium transition-colors"
            >
              <Wallet size={12} /> Mark paid
            </button>
          ) : (
            <span className="text-slate-600 text-xs">
              Signed and unpaid. Only a business owner can record the payment.
            </span>
          ))}
      </div>
    </div>
  )
}

/** The state that is the point of this screen: nothing entered at all. */
function NotRecorded({
  category, period, onEnter, canWrite,
}: {
  category: ExpenseCategory
  period: string
  onEnter: () => void
  canWrite: boolean
}) {
  return (
    <div className="border border-dashed border-amber-500/40 bg-amber-500/[0.06] rounded-xl px-4 py-4">
      <p className="text-amber-200 text-xs font-semibold uppercase tracking-wide">
        Not recorded for this period
      </p>
      <p className="text-amber-100/80 text-sm mt-1.5 leading-relaxed">
        Nobody has entered {CATEGORY_LABELS[category].toLowerCase()} for{' '}
        {periodLabel(period)}. This is <span className="font-semibold">unknown</span>, not
        ₹0 — the profit statement cannot subtract a figure that was never written
        down, so it reports profit as an upper bound instead.
      </p>
      {canWrite && (
        <button
          onClick={onEnter}
          className="inline-flex items-center gap-1.5 text-amber-200 hover:text-white text-xs mt-2.5 underline underline-offset-2"
        >
          <Plus size={11} /> Enter it now
        </button>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function OperatingCostsPage() {
  const { crmUser, apiUser, loading: authLoading, apiReady, apiError } = useAuth()
  // The Observer has no Firestore `crmUser` on purpose, so `canAccess` alone
  // locks the one role that exists to watch the money out of the money. The API
  // grants them `can_read_all`; they are admitted here and the API decides the
  // rest. Same pattern as app/reports/page.tsx.
  const isObserver = apiUser?.role === 'observer'
  const allowed = isObserver || canAccess(crmUser, FINANCE_ROLES)
  /** `require_owner` on `/expenses/{id}/pay`. The API calls the role `owner`. */
  const isOwner = apiUser?.role === 'owner'
  /** `require_write` refuses the observer and nobody else internal. */
  const canWrite = !isObserver && !!apiUser

  const [period, setPeriod] = useState<string>(() => currentPeriod())
  const [register, setRegister] = useState<ReadResult<ExpenseCard[]> | null>(null)
  const [recurring, setRecurring] = useState<ReadResult<RecurringWorklist> | null>(null)
  const [flash, setFlash] = useState('')
  const [raiseOpen, setRaiseOpen] = useState(false)
  /** Non-null only while the open form is repeating an existing recurring cost. */
  const [repeatOf, setRepeatOf] = useState<RecurringCost | null>(null)
  const [payTarget, setPayTarget] = useState<ExpenseCard | null>(null)

  function openRaise(source: RecurringCost | null) {
    setRepeatOf(source)
    setRaiseOpen(true)
  }

  const load = useCallback(() => {
    if (!allowed || !apiReady || !isPeriod(period)) return
    setRegister(null)
    setRecurring(null)
    // Two independent reads. One failing must not blank the other, and neither
    // may be substituted with an empty list — `attempt` is what keeps "refused"
    // and "nothing there" apart all the way to the screen.
    attempt(
      expenses.list({ period, limit: REGISTER_LIMIT }),
      `expenses.list ${period}`,
    ).then(setRegister)
    attempt(
      expenses.recurringDue(period),
      `expenses.recurring-due ${period}`,
    ).then(setRecurring)
  }, [allowed, apiReady, period])

  useEffect(() => { load() }, [load])

  const cards = register?.ok ? register.value : null
  const missing = useMemo(
    () => (cards ? missingReportedCategories(cards) : null),
    [cards],
  )
  const paid = cards ? paidTotalMinor(cards) : null
  const unpaid = cards ? unpaidTotalMinor(cards) : null
  const otherCards = cards ? cardsInCategory(cards, 'other') : []
  /**
   * Cards whose payload carries no category this client recognises.
   *
   * This should be empty — the API refuses an invented category on the way in.
   * It is rendered anyway because the alternative is a card that exists, is
   * counted in the totals above, and appears in none of the sections below: a
   * cost the register holds and the screen hides is the same failure as a cost
   * nobody entered, and harder to notice.
   */
  const uncategorised = cards
    ? cards.filter((c) => expensePayload(c).category === '')
    : []

  if (authLoading) return <Loading label="Checking your access…" />
  if (!allowed) return <Denied what="operating costs" />

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
            <FileText size={24} className="text-pink-400" />
            Operating costs
          </h1>
          <p className="text-slate-400 mt-1 text-sm max-w-2xl leading-relaxed">
            What it costs to run the company, for{' '}
            <span className="text-slate-200">{periodLabel(period)}</span>. These are the
            lines profit is measured against — a category with nothing in it is not a
            saving, it is a gap. Amounts are in Indian rupees (₹); the API reports paise
            and they are converted once, here.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <PeriodPicker value={period} onChange={setPeriod} />
          <button
            onClick={load}
            title="Re-read the register"
            className="flex items-center gap-2 bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 rounded-lg px-3.5 py-2.5 text-sm transition-colors"
          >
            <RefreshCw size={14} /> Refresh
          </button>
          {canWrite && (
            <button
              onClick={() => openRaise(null)}
              className="flex items-center gap-2 bg-pink-600 hover:bg-pink-500 text-white rounded-lg px-3.5 py-2.5 text-sm font-medium transition-colors whitespace-nowrap"
            >
              <Plus size={14} /> Raise a cost
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

      {/* ── The banner. What profit is worth this month. ─────────────────── */}
      {!apiReady ? (
        <Loading label="Waiting for the API session…" />
      ) : register === null ? (
        <Loading label="Reading the expense register…" />
      ) : !register.ok ? (
        // The whole page hangs off this one read, so a refusal replaces it
        // rather than sitting beside a page of confident empty categories.
        <UnavailablePanel
          failure={register}
          what="The expense register"
          onRetry={load}
        />
      ) : (
        <>
          <div
            className={`rounded-2xl border p-5 sm:p-6 ${
              missing && missing.length === 0
                ? 'bg-emerald-500/10 border-emerald-500/30'
                : 'bg-amber-500/10 border-amber-500/40'
            }`}
          >
            <div className="flex items-start gap-3">
              {missing && missing.length === 0 ? (
                <CheckCircle2 size={20} className="text-emerald-400 mt-0.5 shrink-0" />
              ) : (
                <AlertTriangle size={20} className="text-amber-400 mt-0.5 shrink-0" />
              )}
              <div className="min-w-0">
                {missing && missing.length === 0 ? (
                  <>
                    <p className="text-emerald-100 font-semibold text-base">
                      All seven reported categories have an entry for{' '}
                      {periodLabel(period)}.
                    </p>
                    <p className="text-emerald-100/80 text-sm mt-1.5 leading-relaxed max-w-3xl">
                      Profit for this period is measured against a complete set of cost
                      lines rather than an upper bound. That holds only while every
                      figure above is right — an entry exists, which is not the same as
                      an entry being correct.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-amber-100 font-semibold text-base">
                      {missing?.length} of the seven reported cost categories{' '}
                      {missing?.length === 1 ? 'has' : 'have'} nothing recorded for{' '}
                      {periodLabel(period)}.
                    </p>
                    <p className="text-amber-100/85 text-sm mt-1.5 leading-relaxed max-w-3xl">
                      <span className="font-semibold">
                        Profit for this period is an upper bound until every one of them
                        is entered.
                      </span>{' '}
                      Each missing line is a cost the business may well have incurred
                      and that no report can subtract, because nobody wrote it down. An
                      empty category is unknown — it is never ₹0.
                    </p>
                    <div className="flex flex-wrap gap-1.5 mt-3">
                      {missing?.map((c) => (
                        <span
                          key={c}
                          className="bg-amber-500/15 text-amber-200 rounded-full px-2.5 py-1 text-xs"
                        >
                          {CATEGORY_SHORT[c]}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {cards && cards.length >= REGISTER_LIMIT && (
            <Warning>
              The register came back with {cards.length} cards, which is the limit this
              screen asks for. There may be more for this period, so treat the totals
              below as at least this much rather than as the whole of it.
            </Warning>
          )}

          {/* ── What has been recorded, and what has actually left ───────── */}
          <section className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <p className="text-slate-500 text-xs uppercase tracking-wide mb-2">
                Paid this period (INR)
              </p>
              <p className="text-2xl font-bold text-orange-300 tabular-nums">
                {formatInrMinorShort(paid)}
              </p>
              <p className="text-slate-500 text-xs mt-1.5 leading-relaxed">
                Executed cards only — money that has actually left. Cards labelled for
                this period but paid in another month are counted here, and by the
                statement in the month they were paid.
              </p>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <p className="text-slate-500 text-xs uppercase tracking-wide mb-2">
                Recorded, not yet paid (INR)
              </p>
              <p className="text-2xl font-bold text-amber-300 tabular-nums">
                {formatInrMinorShort(unpaid)}
              </p>
              <p className="text-slate-500 text-xs mt-1.5 leading-relaxed">
                Raised, verified or signed and still owed. It is on no cash statement,
                which is exactly why it is worth a figure of its own.
              </p>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <p className="text-slate-500 text-xs uppercase tracking-wide mb-2">
                Cost cards in this period
              </p>
              <p className="text-2xl font-bold text-white tabular-nums">
                {cards?.length ?? 0}
              </p>
              <p className="text-slate-500 text-xs mt-1.5 leading-relaxed">
                Every stage, including rejected. A count of cards, not of categories —
                seven cards against one supplier still leaves six lines unrecorded.
              </p>
            </div>
          </section>

          {/* ── Recurring worklist ───────────────────────────────────────── */}
          <section className="space-y-3">
            <div>
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <Repeat size={17} className="text-slate-500" /> Recurring costs due
              </h2>
              <p className="text-slate-500 text-sm mt-0.5 max-w-3xl leading-relaxed">
                Costs somebody marked recurring when they last raised them, with no card
                for {periodLabel(period)} yet. Nothing here raises a card on its own: a
                figure nobody looked at is not a figure an owner should be signing.
              </p>
            </div>

            {recurring === null ? (
              <Loading label="Reading the recurring worklist…" />
            ) : !recurring.ok ? (
              <UnavailablePanel
                failure={recurring}
                what="The recurring worklist"
                onRetry={load}
              />
            ) : recurring.value.due.length === 0 ? (
              <Empty
                title="Nothing recurring is outstanding"
                icon={<Repeat size={26} />}
                hint={
                  recurring.value.already_raised.length > 0
                    ? `All ${recurring.value.already_raised.length} recurring cost(s) already have a card for this period. That says nothing about the categories nobody has ever entered — the banner above does.`
                    : 'No cost has ever been marked recurring, so there is nothing to repeat. That is not the same as nothing being owed monthly.'
                }
              />
            ) : (
              <div className="space-y-2">
                {recurring.value.due.map((r) => (
                  <div
                    key={`${r.category}:${r.payee}`}
                    className="flex flex-wrap items-center justify-between gap-3 bg-slate-900 border border-slate-800 rounded-xl px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="text-white text-sm font-medium">
                        {r.category_label} — {r.payee || 'no payee recorded'}
                      </p>
                      <p className="text-slate-500 text-xs mt-0.5 tabular-nums">
                        Last raised {r.last_period} at{' '}
                        {formatInrMinor(r.last_amount_inr_minor)} ·{' '}
                        {EXPENSE_STAGE_SHORT[r.last_stage as Stage] ?? r.last_stage}
                      </p>
                    </div>
                    {canWrite ? (
                      <button
                        onClick={() => openRaise(r)}
                        className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors shrink-0"
                      >
                        <Repeat size={12} /> Repeat for {period}
                      </button>
                    ) : (
                      <span className="text-slate-600 text-xs shrink-0">Read-only</span>
                    )}
                  </div>
                ))}
                <p className="text-slate-600 text-xs leading-relaxed">
                  {recurring.value.note}
                </p>
              </div>
            )}
          </section>

          {/* ── The seven reported categories ────────────────────────────── */}
          <section className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-white">
                The seven reported categories
              </h2>
              <p className="text-slate-500 text-sm mt-0.5 max-w-3xl leading-relaxed">
                These are the lines the profit statement names and subtracts, in the
                server&apos;s own order. Each one either has cards, or is marked
                unrecorded — there is deliberately no third state and no zero.
              </p>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {REPORTED_CATEGORIES.map((category) => {
                const rows = cards ? cardsInCategory(cards, category) : []
                const live = rows.filter((c) => c.stage !== 'rejected')
                return (
                  <div
                    key={category}
                    className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5 space-y-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="text-white font-semibold text-sm">
                          {CATEGORY_LABELS[category]}
                        </h3>
                        <p className="text-slate-600 text-xs mt-0.5 font-mono">
                          {category}
                        </p>
                      </div>
                      {live.length > 0 && (
                        <p className="text-slate-300 text-sm font-semibold tabular-nums shrink-0">
                          {formatInrMinor(paidTotalMinor(rows))}
                          <span className="block text-slate-600 text-xs font-normal text-right">
                            paid
                          </span>
                        </p>
                      )}
                    </div>

                    {live.length === 0 ? (
                      <NotRecorded
                        category={category}
                        period={period}
                        canWrite={canWrite}
                        onEnter={() => openRaise(null)}
                      />
                    ) : (
                      <div className="space-y-2.5">
                        {rows.map((card) => (
                          <CostRow
                            key={card.id}
                            card={card}
                            isOwner={isOwner}
                            onMarkPaid={setPayTarget}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>

          {/* ── Other ────────────────────────────────────────────────────── */}
          <section className="space-y-3">
            <div>
              <h2 className="text-lg font-semibold text-white">
                {CATEGORY_LABELS.other}
              </h2>
              <p className="text-slate-500 text-sm mt-0.5 max-w-3xl leading-relaxed">
                Genuine one-offs. This category is deliberately <em>not</em> one of the
                seven: an empty <code className="text-slate-400">other</code> is really
                no information, whereas an empty payroll means somebody forgot. So it is
                never marked unrecorded.
              </p>
            </div>
            {otherCards.length === 0 ? (
              <Empty
                title="No one-off costs in this period"
                hint="Nothing was filed under other. Unlike the seven above, that is a complete answer."
              />
            ) : (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-2.5">
                {otherCards.map((card) => (
                  <CostRow
                    key={card.id}
                    card={card}
                    isOwner={isOwner}
                    onMarkPaid={setPayTarget}
                  />
                ))}
              </div>
            )}
          </section>

          {/* ── Cards the register holds and no section above claims ─────── */}
          {uncategorised.length > 0 && (
            <section className="space-y-3">
              <Warning>
                <span className="font-semibold">
                  {uncategorised.length} cost card
                  {uncategorised.length === 1 ? ' carries' : 's carry'} no recognised
                  category.
                </span>{' '}
                They are counted in the totals above and belong to none of the lines the
                profit statement subtracts by, so nothing can place them. They are listed
                here rather than left invisible.
              </Warning>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-2.5">
                {uncategorised.map((card) => (
                  <CostRow
                    key={card.id}
                    card={card}
                    isOwner={isOwner}
                    onMarkPaid={setPayTarget}
                  />
                ))}
              </div>
            </section>
          )}

          {/* ── How the five stages work ─────────────────────────────────── */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5 flex items-start gap-3">
            <Info size={16} className="text-sky-400 mt-0.5 shrink-0" />
            <div className="text-sm text-slate-400 leading-relaxed">
              <p className="text-slate-200 font-medium">
                Raising a cost pays nobody. Only the last of the five stages is money.
              </p>
              <p className="mt-1.5">
                A cost card goes <em>Requested → Under review → Awaiting sign-off →
                Approved → Paid</em>. Anyone on the team may raise one; a second person
                verifies it on the{' '}
                <Link
                  href="/board"
                  className="text-pink-400 hover:text-pink-300 underline underline-offset-2"
                >
                  money board
                </Link>
                , and an owner signs it there — the verifier can never be the person who
                raised it. <span className="text-slate-300">Mark paid</span> is the fifth
                stage, it is owners only, and it is the single moment the money is
                recorded as having left. A card sitting at <em>Approved</em> is signed-off
                money that is still in the bank.
              </p>
              <p className="mt-1.5">
                Costs are counted on a <span className="text-slate-300">cash basis</span>:
                the statement counts a cost in the month it was <em>paid</em>, not the
                month written on the card. Both are shown above so a payment landing
                outside its own month is visible rather than silently moved.
              </p>
            </div>
          </div>
        </>
      )}

      {raiseOpen && (
        <RaiseCostModal
          period={period}
          repeatOf={repeatOf}
          onClose={() => setRaiseOpen(false)}
          onRaised={(_card, message) => afterChange(message)}
        />
      )}

      {payTarget && (
        <MarkPaidModal
          card={payTarget}
          onClose={() => setPayTarget(null)}
          onPaid={(_card, message) => afterChange(message)}
        />
      )}
    </div>
  )
}
