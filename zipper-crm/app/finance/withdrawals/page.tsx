'use client'

/**
 * Host withdrawals — approve, pay, and record the proof.
 *
 * The approval flow is unchanged: pending → approved → paid, with a required
 * reason on a rejection and UTR/reference/screenshot captured when a payment is
 * marked paid. Those records live in Firestore (`withdrawalRequests`), which is
 * why this page reads them directly rather than through the reports API.
 *
 * What changed:
 *
 *   A date range and a search, neither of which existed.
 *
 *   **Approved but not paid** is now the first thing on the page. That state is
 *   money a person signed off and that has not left the business, and it was
 *   previously indistinguishable from any other row in a long table. The API
 *   agrees with this framing — `/reports/payouts` counts only executed value,
 *   and explicitly warns about signed-and-unexecuted rather than folding it in.
 *
 *   The invented figures are gone. This page used to divide rupees by a
 *   hard-coded 83 to show a dollar amount, and to print a payout rate of
 *   "₹1,000 per lakh beans" from a constant in the file. Neither came from the
 *   economy config, so both could silently disagree with what was actually
 *   paid. Amounts are now shown in the currency they were recorded in, and the
 *   rate line comes from the rates the reports API says it used.
 */

import UploadField from '@/components/UploadField'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowLeft, Calendar, Check, CheckCircle2, ChevronRight,
  Copy, Download, ExternalLink, FileImage, Hash, Info, Loader2, Wallet, X,
  XCircle,
} from 'lucide-react'

import { useAuth } from '@/components/AuthProvider'
import { canAccess, CrmRole } from '@/lib/auth'
import api, { ApiError, type Card } from '@/lib/api'
import {
  getWithdrawalRequests, approveWithdrawal, markWithdrawalPaid, rejectWithdrawal,
  type WithdrawalRequest, type PaymentProof,
} from '@/lib/firestore'
import { Column, DataTable } from '@/components/ui/DataTable'
import { DateRangePicker, Range, defaultRange, toParams } from '@/components/ui/DateRange'
import { Denied, Empty, Loading, Warning } from '@/components/ui/States'
import {
  PayoutReport,
  downloadReportCsv, emptyExplanation, formatCount, formatDate, formatDateTime,
  formatInrMinorShort, formatNativeAmount, otherWarnings, provisionalNote,
  rateSummary, reports,
} from '@/lib/apiReports'

/**
 * Who may see business-wide money.
 *
 * `_require_business_financials` in backend/app/routers/reports.py admits
 * `can_read_all` (owner, Observer) or `is_team_admin` — and every report this
 * screen asks for goes through it. `finance_member` is a MEMBER role
 * (backend/app/core/roles.py), so it is refused: the router's own docstring
 * says "a member gets a 403 on business-wide financial reports". It used to be
 * listed here, which let a finance member onto a screen where every figure came
 * back red.
 */
const FINANCE_ROLES: CrmRole[] = ['superadmin', 'finance_admin']

/** The Firestore query behind this list is capped; say so rather than imply completeness. */
const QUEUE_LIMIT = 100

const PAYMENT_MODES = [
  'NEFT', 'IMPS', 'UPI', 'Binance', 'USDT TRC20', 'USDT ERC20', 'Bank Transfer',
]
const FOREIGN_MODES = ['Binance', 'USDT TRC20', 'USDT ERC20']

const STATUS_STYLE: Record<WithdrawalRequest['status'], string> = {
  pending: 'bg-yellow-500/15 text-yellow-300 border border-yellow-500/30',
  approved: 'bg-blue-500/15 text-blue-300 border border-blue-500/30',
  paid: 'bg-green-500/15 text-green-300 border border-green-500/30',
  rejected: 'bg-red-500/15 text-red-300 border border-red-500/30',
}

function millisOf(ts: WithdrawalRequest['requestedAt']): number | null {
  if (!ts) return null
  const ms = ts.toMillis()
  return Number.isFinite(ms) ? ms : null
}

function whenOf(ts: WithdrawalRequest['requestedAt']): string {
  const ms = millisOf(ts)
  return ms === null ? '—' : formatDate(new Date(ms).toISOString())
}

function ageDays(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 86_400_000
}

// ── Mark paid ─────────────────────────────────────────────────────────────────

function MarkPaidModal({
  req, onClose, onPaid,
}: {
  req: WithdrawalRequest
  onClose: () => void
  onPaid: (id: string, proof: PaymentProof) => void
}) {
  const isForeign = req.paymentType === 'foreign'
  const [proof, setProof] = useState<PaymentProof>({
    utrNumber: '',
    transactionRef: '',
    transactionProofUrl: '',
    transactionDate: new Date().toISOString().slice(0, 10),
    paymentMode: isForeign ? 'Binance' : 'IMPS',
    notes: '',
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  function set<K extends keyof PaymentProof>(k: K, v: string) {
    setProof((p) => ({ ...p, [k]: v }))
  }

  async function submit() {
    if (!proof.utrNumber?.trim() && !proof.transactionRef?.trim()) {
      setErr('Enter at least a UTR number or a transaction reference — a payment with no reference cannot be reconciled later.')
      return
    }
    setSaving(true)
    setErr('')
    try {
      await markWithdrawalPaid(req.id, proof)
      onPaid(req.id, proof)
      onClose()
    } catch {
      setErr('The payment was not recorded. Nothing was changed — try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div>
            <h3 className="text-white font-semibold">Mark as paid</h3>
            <p className="text-slate-500 text-xs mt-0.5">
              Every transfer is offline — record the proof, or it cannot be reconciled.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="mx-6 my-4 bg-slate-800 rounded-xl p-4 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-white font-semibold truncate">{req.hostName || req.uid}</p>
            <p className="text-slate-400 text-xs">{req.phoneNumber || '—'}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-2xl font-bold text-green-400 tabular-nums">
              {formatNativeAmount(req.inrAmount, 'inr')}
            </p>
            <p className="text-slate-500 text-xs tabular-nums">
              {formatCount(req.beans)} beans
              {isForeign && ' · settles abroad'}
            </p>
          </div>
        </div>

        <div className="mx-6 mb-4 flex items-start gap-2 bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2">
          <Info size={13} className="text-blue-400 mt-0.5 shrink-0" />
          <div className="text-xs text-blue-300">
            {isForeign ? (
              <span>
                Pay via <strong>Binance UID {req.binanceUid || '—'}</strong>. The amount
                above is the rupee figure on the request; the settled foreign amount is
                whatever the transfer actually cost — record it in the notes.
              </span>
            ) : req.upiId ? (
              <span>
                Pay via <strong>UPI {req.upiId}</strong>
              </span>
            ) : (
              <span>
                Pay to <strong>{req.bankName || 'the bank on file'}</strong> · A/C{' '}
                {req.accountNumber || '—'} · IFSC {req.ifscCode || '—'}
              </span>
            )}
          </div>
        </div>

        <div className="px-6 space-y-4 pb-2">
          <div>
            <label className="block text-slate-400 text-xs mb-1.5 font-medium">
              Payment mode
            </label>
            <div className="flex flex-wrap gap-2">
              {PAYMENT_MODES.filter((m) =>
                isForeign ? FOREIGN_MODES.includes(m) : !FOREIGN_MODES.includes(m),
              ).map((m) => (
                <button
                  key={m}
                  onClick={() => set('paymentMode', m)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                    proof.paymentMode === m
                      ? 'bg-pink-500 border-pink-500 text-white'
                      : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-400 text-xs mb-1.5 font-medium">
                <Hash size={10} className="inline mr-1" />
                UTR number
              </label>
              <input
                value={proof.utrNumber}
                onChange={(e) => set('utrNumber', e.target.value)}
                placeholder="e.g. HDFC12345678"
                className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-pink-500 transition"
              />
            </div>
            <div>
              <label className="block text-slate-400 text-xs mb-1.5 font-medium">
                <Hash size={10} className="inline mr-1" />
                Transaction reference
              </label>
              <input
                value={proof.transactionRef}
                onChange={(e) => set('transactionRef', e.target.value)}
                placeholder="Bank / UPI / Binance ref"
                className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-pink-500 transition"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-400 text-xs mb-1.5 font-medium">
                <Calendar size={10} className="inline mr-1" />
                Transaction date
              </label>
              <input
                type="date"
                value={proof.transactionDate}
                onChange={(e) => set('transactionDate', e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-pink-500 transition"
              />
            </div>
            <UploadField
              label="Transfer screenshot"
              value={proof.transactionProofUrl ?? ''}
              onChange={(url) => set('transactionProofUrl', url)}
              storagePath="evidence/withdrawals"
              accept="image/*,application/pdf"
            />
          </div>

          <div>
            <label className="block text-slate-400 text-xs mb-1.5 font-medium">
              Notes (optional)
            </label>
            <input
              value={proof.notes}
              onChange={(e) => set('notes', e.target.value)}
              placeholder={
                isForeign
                  ? 'e.g. settled 118.40 USDT at the rate on the day'
                  : 'Anything worth recording…'
              }
              className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-pink-500 transition"
            />
          </div>

          {err && (
            <p className="text-red-400 text-xs flex items-start gap-1.5">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              {err}
            </p>
          )}
        </div>

        <div className="flex gap-3 px-6 py-4 border-t border-slate-800 mt-3">
          <button
            onClick={onClose}
            className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={saving}
            className="flex-1 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white font-medium rounded-lg px-4 py-2.5 text-sm transition-colors flex items-center justify-center gap-2"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            Confirm payment
          </button>
        </div>
      </div>
    </div>
  )
}

// ── The money board half of a withdrawal ──────────────────────────────────────
//
// The queue above is the host asking, held in Firestore. The card is the
// business deciding, held by the API — and the card is the only one of the two
// that moves anything: `execute_host_withdrawal` debits `beansAvailable` under
// a Firestore transaction and writes the ledger row that agency commission is
// computed from. Until this screen could raise and execute one, the two
// endpoints existed and nothing called them, so marking a request "paid" here
// recorded a bank transfer against beans that were never taken out of the
// host's wallet.
//
// Both controls follow the commission-payout pair on /agencies/[id] exactly:
// raise with an amount and a mandatory reason, nothing moves; an owner signs on
// /board; execute with the bank reference, which is what reconciles it.

function RaiseCardDialog({
  req, onClose, onRaised,
}: {
  req: WithdrawalRequest
  onClose: () => void
  onRaised: (message: string, warnings: string[]) => void
}) {
  const [beans, setBeans] = useState(req.beans || 0)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit() {
    if (beans <= 0 || reason.trim().length < 3) return
    setBusy(true)
    setErr('')
    try {
      const card = await api.partnerOps.requestHostWithdrawal(req.uid, {
        beans: Math.trunc(beans),
        reason: reason.trim(),
      })
      onRaised(
        `Card raised for ${formatCount(Math.trunc(beans))} beans. Nothing has moved — `
        + 'an owner signs it on the money board, then it is executed here with the '
        + 'bank reference.',
        card.warnings ?? [],
      )
    } catch (e) {
      // The API refuses an amount above the host's live `beansAvailable` with a
      // sentence explaining that beans release a week in arrears. Print it as
      // written — paraphrasing it turns an explanation into "request failed".
      setErr(e instanceof ApiError ? e.message : 'The card was not raised.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-white font-semibold">Raise a withdrawal card</h3>
            <p className="text-slate-400 text-sm mt-1 truncate">
              {req.hostName || req.uid}
            </p>
            <p className="text-slate-600 text-xs font-mono truncate">{req.uid}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white shrink-0">
            <X size={18} />
          </button>
        </div>

        <div>
          <label className="block text-slate-400 text-xs mb-1.5 font-medium">
            Beans <span className="text-slate-600">(not rupees)</span>
          </label>
          <input
            type="number"
            min={1}
            step={1}
            value={beans}
            onChange={(e) => setBeans(parseInt(e.target.value) || 0)}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm tabular-nums focus:outline-none focus:border-pink-500"
          />
          <p className="text-slate-600 text-xs mt-1 leading-relaxed">
            Pre-filled from the request. The API checks it against the host&rsquo;s{' '}
            <strong className="text-slate-500">currently released</strong> beans, which
            is not the same as what they have earned — beans release a week in arrears,
            so a refusal here is a timing answer, not a refusal to pay.
          </p>
        </div>

        <div>
          <label className="block text-slate-400 text-xs mb-1.5 font-medium">
            Reason (required — it goes on the card and into the audit log)
          </label>
          <textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Weekly payout for week ending 7 Sep, request #… verified against the bank details on file."
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 resize-none"
          />
        </div>

        <p className="text-slate-500 text-xs leading-relaxed">
          Raising moves nothing. The card goes to the money board, an owner signs it, and
          only then does executing it take the beans out of the host&rsquo;s wallet.
        </p>

        {err && (
          <p className="text-red-300 text-xs flex items-start gap-1.5 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            {err}
          </p>
        )}

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || beans <= 0 || reason.trim().length < 3}
            className="flex-1 flex items-center justify-center gap-2 bg-pink-500 hover:bg-pink-400 disabled:opacity-40 text-white font-medium rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Wallet size={14} />}
            Raise card
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * One signed host-withdrawal card, with the control that pays it.
 *
 * Modelled on `PayoutCardRow` in app/agencies/[id]/Client.tsx — same shape,
 * same mandatory reference, same insistence that a signature is not a payment.
 */
function HostWithdrawalCardRow({
  card, isOwner, onDone,
}: {
  card: Card
  /** Only an owner may execute. The API refuses anybody else. */
  isOwner: boolean
  onDone: (message: string) => void
}) {
  const [ref, setRef] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function execute() {
    if (!ref.trim()) return
    setBusy(true)
    setErr('')
    try {
      await api.partnerOps.executeHostWithdrawal(card.id, ref.trim())
      onDone(
        `${formatCount(Math.abs(card.amount))} beans debited and recorded against ${ref.trim()}.`,
      )
    } catch (e) {
      // Every failure mode here changes the card's stage server-side, including
      // the one where the wallet WAS debited. The message says which; show it
      // and reload the board rather than inviting a retry.
      setErr(
        e instanceof ApiError
          ? e.message
          : 'That did not go through. Re-read the board before trying again — the card may have changed stage.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-slate-900/60 border border-amber-500/20 rounded-lg p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-white text-sm font-medium">
            {formatCount(Math.abs(card.amount))} beans
            <span className="text-slate-500 font-normal ml-2">{card.title}</span>
          </p>
          <p className="text-slate-500 text-xs mt-0.5 truncate max-w-md">{card.reason}</p>
          <p className="text-slate-600 text-xs mt-0.5">
            signed {formatDateTime(card.signed_at)} ·{' '}
            {ageDays(card.signed_at ?? card.created_at).toFixed(1)} days ago
          </p>
        </div>
      </div>

      {isOwner ? (
        <div className="mt-3 bg-green-500/10 border border-green-500/30 rounded-lg p-3 space-y-2">
          <p className="text-green-200 text-xs leading-relaxed">
            An owner has signed this and the beans have not left the wallet yet. Executing
            debits <code className="text-green-100">beansAvailable</code> and files the
            bank reference against it — that reference is how the transfer reconciles
            later, so it is required.
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="UTR or transaction reference"
              className="flex-1 min-w-[12rem] bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-xs font-mono placeholder-slate-600 focus:outline-none focus:border-green-500"
            />
            <button
              onClick={execute}
              disabled={busy || !ref.trim()}
              className="flex items-center gap-2 bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white rounded-lg px-4 py-2 text-xs font-medium transition-colors"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              Pay and debit
            </button>
          </div>
          {err && (
            <p className="text-red-300 text-xs flex items-start gap-1.5">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              {err}
            </p>
          )}
        </div>
      ) : (
        <p className="text-amber-200/70 text-xs mt-2">
          Signed and waiting on an owner to execute it. Only an owner may move the beans,
          and the API refuses anybody else.
        </p>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function WithdrawalsPage() {
  const { crmUser, apiUser, loading: authLoading, apiReady, apiError } = useAuth()
  // The Observer has no Firestore `crmUser` on purpose, so `canAccess` alone
  // locks the one role that exists to watch the money out of the money. The API
  // grants them `can_read_all`; they are admitted here and the API decides the
  // rest. Same pattern as app/reports/page.tsx.
  const isObserver = apiUser?.role === 'observer'
  const allowed = isObserver || canAccess(crmUser, FINANCE_ROLES)

  const [range, setRange] = useState<Range>(defaultRange)
  const [status, setStatus] = useState('all')

  const [requests, setRequests] = useState<WithdrawalRequest[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState('')

  const [payoutReport, setPayoutReport] = useState<PayoutReport | null>(null)
  const [stuckCards, setStuckCards] = useState<Card[] | null>(null)
  const [apiSideError, setApiSideError] = useState('')

  const [actingId, setActingId] = useState<string | null>(null)
  const [flash, setFlash] = useState('')
  const [busy, setBusy] = useState('')
  const [exportError, setExportError] = useState('')

  const [rejectTarget, setRejectTarget] = useState<WithdrawalRequest | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [markPaidTarget, setMarkPaidTarget] = useState<WithdrawalRequest | null>(null)
  const [proofViewer, setProofViewer] = useState<WithdrawalRequest | null>(null)
  const [raiseTarget, setRaiseTarget] = useState<WithdrawalRequest | null>(null)
  /** Advisory notes the API attaches to a raised card — never a refusal. */
  const [cardWarnings, setCardWarnings] = useState<string[]>([])

  const loadList = useCallback(() => {
    if (!allowed) return
    // The request list is a Firestore collection. The Observer signs in to the
    // API with a one-time code and holds no Firebase session, so this read
    // cannot succeed for them. It is skipped and said out loud rather than
    // failing with a permissions error that explains nothing.
    if (isObserver) {
      setRequests([])
      setListLoading(false)
      return
    }
    setListLoading(true)
    setListError('')
    getWithdrawalRequests()
      .then(setRequests)
      .catch(() =>
        setListError(
          'The withdrawal list could not be read. Nothing below is a count of zero — the list simply did not load.',
        ),
      )
      .finally(() => setListLoading(false))
  }, [allowed, isObserver])

  const loadApi = useCallback(() => {
    if (!allowed || !apiReady) return
    setApiSideError('')
    Promise.all([
      reports.payouts(toParams(range)),
      api.cards.list('approved', 200),
    ])
      .then(([p, approved]) => {
        setPayoutReport(p)
        setStuckCards(approved.filter((c) => c.type === 'host_withdrawal'))
      })
      .catch((err: unknown) => {
        setPayoutReport(null)
        setStuckCards(null)
        setApiSideError(
          err instanceof ApiError
            ? `The executed-payout figure could not be produced: ${err.message}`
            : 'The executed-payout figure could not be produced.',
        )
      })
  }, [allowed, apiReady, range])

  useEffect(() => { loadList() }, [loadList])
  useEffect(() => { loadApi() }, [loadApi])

  function patchRequest(id: string, patch: Partial<WithdrawalRequest>) {
    setRequests((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  async function doApprove(req: WithdrawalRequest) {
    setActingId(req.id)
    try {
      await approveWithdrawal(req.id)
      patchRequest(req.id, { status: 'approved' })
      setFlash(
        `Approved ${formatNativeAmount(req.inrAmount, 'inr')} for ${req.hostName || req.uid}. The money has not moved yet — mark it paid once the transfer is done.`,
      )
    } catch {
      setListError('The approval did not go through. Nothing was changed.')
    } finally {
      setActingId(null)
    }
  }

  async function doReject() {
    if (!rejectTarget || !rejectReason.trim()) return
    setActingId(rejectTarget.id)
    try {
      await rejectWithdrawal(rejectTarget.id, rejectReason.trim())
      patchRequest(rejectTarget.id, {
        status: 'rejected',
        rejectionReason: rejectReason.trim(),
      })
      setFlash(`Rejected the request from ${rejectTarget.hostName || rejectTarget.uid}.`)
      setRejectTarget(null)
      setRejectReason('')
    } catch {
      setListError('The rejection did not go through. Nothing was changed.')
    } finally {
      setActingId(null)
    }
  }

  async function exportPayouts() {
    setBusy('payouts')
    setExportError('')
    try {
      await downloadReportCsv('/payouts', toParams(range), 'payouts')
    } catch (err) {
      setExportError(
        err instanceof ApiError
          ? err.message
          : 'The export failed and no file was produced.',
      )
    } finally {
      setBusy('')
    }
  }

  const since = range.since.getTime()
  const until = range.until.getTime()

  const inRange = useMemo(
    () =>
      requests.filter((r) => {
        const ms = millisOf(r.requestedAt)
        // Undated requests are kept, not hidden — a shorter list would be a lie.
        if (ms === null) return true
        return ms >= since && ms <= until
      }),
    [requests, since, until],
  )

  const undated = useMemo(
    () => inRange.filter((r) => millisOf(r.requestedAt) === null).length,
    [inRange],
  )

  const filtered = useMemo(
    () => (status === 'all' ? inRange : inRange.filter((r) => r.status === status)),
    [inRange, status],
  )

  const counts = useMemo(() => {
    const acc: Record<string, number> = {
      pending: 0, approved: 0, paid: 0, rejected: 0,
    }
    for (const r of inRange) acc[r.status] = (acc[r.status] ?? 0) + 1
    return acc
  }, [inRange])

  /** Approved and not yet paid — signed-off money that has not left. */
  const approvedUnpaid = useMemo(
    () => inRange.filter((r) => r.status === 'approved'),
    [inRange],
  )
  const approvedUnpaidTotal = approvedUnpaid.reduce((s, r) => s + (r.inrAmount || 0), 0)

  if (authLoading) return <Loading label="Checking your access…" />
  if (!allowed) return <Denied what="host withdrawals" />

  // Reading the money and moving it are different questions. The Observer is
  // admitted above to read and writes nothing at all (spec 1.1.4).
  const canAct = !isObserver && !!crmUser
  // Executing a withdrawal card is `require_owner` on the API. Everyone else
  // sees the card and is told who has to press it, rather than being shown a
  // button that 403s.
  const isOwner = apiUser?.role === 'owner'

  const columns: Column<WithdrawalRequest>[] = [
    {
      key: 'hostName',
      header: 'Host',
      render: (r) => (
        <Link
          href={`/users/${encodeURIComponent(r.uid)}`}
          onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-2 group min-w-0"
        >
          <div className="w-7 h-7 rounded-full bg-pink-500/20 flex items-center justify-center text-pink-400 text-xs font-bold shrink-0">
            {r.hostName?.[0]?.toUpperCase() ?? '?'}
          </div>
          <div className="min-w-0">
            <p className="text-white font-medium truncate group-hover:text-pink-400 transition-colors">
              {r.hostName || r.uid}
            </p>
            <p className="text-slate-600 text-xs font-mono truncate">
              {r.phoneNumber || r.uid}
            </p>
          </div>
        </Link>
      ),
    },
    {
      key: 'agencyId',
      header: 'Agency',
      hideOnMobile: true,
      render: (r) =>
        r.agencyId ? (
          <span className="text-purple-300 text-xs font-mono">{r.agencyId}</span>
        ) : (
          <span className="text-slate-600 text-xs">none</span>
        ),
    },
    {
      key: 'beans',
      header: 'Beans',
      align: 'right',
      hideOnMobile: true,
      value: (r) => r.beans,
      render: (r) => (
        <span className="text-orange-300 tabular-nums">
          {formatCount(r.beans)} beans
        </span>
      ),
    },
    {
      key: 'inrAmount',
      header: 'Amount (INR)',
      align: 'right',
      value: (r) => r.inrAmount,
      render: (r) => (
        <div className="text-right">
          <span className="text-white font-semibold tabular-nums">
            {formatNativeAmount(r.inrAmount, 'inr')}
          </span>
          {r.paymentType === 'foreign' && (
            <p className="text-blue-300 text-xs mt-0.5">settles abroad</p>
          )}
        </div>
      ),
    },
    {
      key: 'payment',
      header: 'Paid to',
      sortable: false,
      hideOnMobile: true,
      render: (r) =>
        r.paymentType === 'foreign' ? (
          <div className="text-xs">
            <p className="text-blue-300 font-medium">Binance</p>
            <p className="text-slate-500 font-mono truncate">{r.binanceUid || '—'}</p>
          </div>
        ) : r.upiId ? (
          <div className="text-xs">
            <p className="text-green-300 font-medium">UPI</p>
            <p className="text-slate-500 truncate">{r.upiId}</p>
          </div>
        ) : (
          <div className="text-xs">
            <p className="text-slate-300 font-medium truncate">{r.bankName || 'Bank'}</p>
            <p className="text-slate-500 font-mono">
              {r.accountNumber ? `•••• ${r.accountNumber.slice(-4)}` : '—'}
            </p>
          </div>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <div>
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_STYLE[r.status]}`}
          >
            {r.status}
          </span>
          {r.status === 'rejected' && r.rejectionReason && (
            <p
              className="text-red-400/70 text-xs mt-1 max-w-[150px] truncate"
              title={r.rejectionReason}
            >
              {r.rejectionReason}
            </p>
          )}
          {r.status === 'paid' && r.paymentMode && (
            <p className="text-slate-500 text-xs mt-1">{r.paymentMode}</p>
          )}
        </div>
      ),
    },
    {
      key: 'requestedAt',
      header: 'Requested',
      align: 'right',
      hideOnMobile: true,
      value: (r) => millisOf(r.requestedAt),
      render: (r) => (
        <span className="text-slate-500 text-xs whitespace-nowrap">
          {whenOf(r.requestedAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      sortable: false,
      align: 'right',
      render: (r) => (
        <div className="flex items-center justify-end gap-2.5">
          {r.status === 'paid' && (
            <button
              onClick={(e) => { e.stopPropagation(); setProofViewer(r) }}
              className="flex items-center gap-1 text-blue-400 hover:text-blue-300 text-xs transition-colors"
            >
              <Hash size={11} />
              {r.utrNumber || r.transactionRef || 'Proof'}
            </button>
          )}
          {r.status === 'pending' && canAct && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); doApprove(r) }}
                disabled={actingId === r.id}
                className="flex items-center gap-1 text-green-400 hover:text-green-300 disabled:opacity-40 text-xs transition-colors"
              >
                {actingId === r.id ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <Check size={11} />
                )}
                Approve
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setRejectTarget(r)
                  setRejectReason('')
                }}
                disabled={actingId === r.id}
                className="flex items-center gap-1 text-red-400 hover:text-red-300 disabled:opacity-40 text-xs transition-colors"
              >
                <X size={11} /> Reject
              </button>
            </>
          )}
          {r.status === 'approved' && canAct && (
            <>
              {/* The card is what moves the beans. Offered beside "Mark paid"
                  rather than instead of it because the two record different
                  things: the card debits the wallet and files the ledger row,
                  this Firestore row is the request the host can see. */}
              <button
                onClick={(e) => { e.stopPropagation(); setRaiseTarget(r) }}
                className="flex items-center gap-1 text-pink-400 hover:text-pink-300 text-xs transition-colors"
              >
                <Wallet size={11} /> Raise card
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setMarkPaidTarget(r) }}
                className="flex items-center gap-1 text-blue-400 hover:text-blue-300 text-xs transition-colors"
              >
                <Check size={11} /> Mark paid
              </button>
            </>
          )}
        </div>
      ),
    },
  ]

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
            <Wallet size={24} className="text-pink-400" />
            Host withdrawals
          </h1>
          <p className="text-slate-400 mt-1 text-sm max-w-2xl leading-relaxed">
            Requests made in{' '}
            <span className="text-slate-200">{range.label.toLowerCase()}</span>. Every
            transfer is offline, so a UTR or reference is required before anything can be
            marked paid. Amounts are the rupee (₹) figures recorded on the request.
          </p>
        </div>
        <div className="shrink-0">
          <DateRangePicker value={range} onChange={setRange} />
        </div>
      </div>

      {apiReady && apiError && <Warning>{apiError}</Warning>}
      {apiSideError && <Warning onDismiss={() => setApiSideError('')}>{apiSideError}</Warning>}
      {exportError && <Warning onDismiss={() => setExportError('')}>{exportError}</Warning>}
      {flash && (
        <div className="flex items-start justify-between gap-3 bg-green-500/10 border border-green-500/30 rounded-xl px-4 py-3">
          <span className="flex items-start gap-2 text-green-300 text-sm">
            <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> {flash}
          </span>
          <button onClick={() => setFlash('')} className="text-green-400 hover:text-green-200">
            <X size={13} />
          </button>
        </div>
      )}

      {/* Approved and not paid — the money that stopped halfway */}
      {approvedUnpaid.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/40 rounded-xl p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle size={19} className="text-amber-400 mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-amber-100 font-semibold text-base">
                {approvedUnpaid.length} withdrawal
                {approvedUnpaid.length > 1 ? 's were' : ' was'} approved and never paid ·{' '}
                {formatNativeAmount(approvedUnpaidTotal, 'inr')}
              </p>
              <p className="text-amber-100/80 text-sm mt-1 leading-relaxed">
                Someone signed this money off and it has not left. It counts as a payout
                nowhere — not on this page, not in{' '}
                <code className="text-amber-200">/reports/payouts</code> — precisely
                because the transfer has not happened, which is why it needs saying here
                instead of sitting quietly in the table below.
              </p>
              <div className="mt-3 space-y-1.5 max-h-56 overflow-y-auto">
                {approvedUnpaid
                  .slice()
                  .sort(
                    (a, b) => (millisOf(a.requestedAt) ?? 0) - (millisOf(b.requestedAt) ?? 0),
                  )
                  .map((r) => (
                    <div
                      key={r.id}
                      className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs"
                    >
                      <span className="text-amber-100">{r.hostName || r.uid}</span>
                      <span className="text-amber-200/70 tabular-nums">
                        {formatNativeAmount(r.inrAmount, 'inr')} · requested{' '}
                        {whenOf(r.requestedAt)}
                      </span>
                    </div>
                  ))}
              </div>
              <button
                onClick={() => setStatus('approved')}
                className="inline-flex items-center gap-1 text-amber-200 hover:text-white text-xs mt-3 underline underline-offset-2"
              >
                Show only these <ChevronRight size={12} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Advisory notes from the last card raised. Not a refusal — the card
          exists — but worth reading before anybody signs it. */}
      {cardWarnings.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/40 rounded-xl px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-amber-100 font-semibold text-sm">
                The card was raised, with {cardWarnings.length === 1 ? 'a note' : 'notes'}
              </p>
              <ul className="mt-1.5 space-y-1">
                {cardWarnings.map((w, i) => (
                  <li key={i} className="text-amber-100/80 text-sm leading-relaxed">
                    {w}
                  </li>
                ))}
              </ul>
            </div>
            <button
              onClick={() => setCardWarnings([])}
              className="text-amber-400 hover:text-amber-200 shrink-0"
            >
              <X size={13} />
            </button>
          </div>
        </div>
      )}

      {/* Signed withdrawal cards — and the control that actually pays them */}
      {stuckCards && stuckCards.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle size={17} className="text-amber-400 mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-amber-100 font-semibold">
                {stuckCards.length} host-withdrawal card
                {stuckCards.length > 1 ? 's are' : ' is'} signed on the board and not
                executed
              </p>
              <p className="text-amber-100/80 text-sm mt-1 leading-relaxed">
                Separate from the queue above — these are money-board cards an owner has
                already signed, and executing one is what takes the beans out of the
                host&rsquo;s wallet and writes the ledger row agency commission is
                computed from. Marking a request &ldquo;paid&rdquo; below does neither.
              </p>
              <div className="mt-3 space-y-2 max-h-72 overflow-y-auto">
                {stuckCards.map((c) => (
                  <HostWithdrawalCardRow
                    key={c.id}
                    card={c}
                    isOwner={isOwner}
                    onDone={(message) => {
                      setFlash(message)
                      loadApi()
                    }}
                  />
                ))}
              </div>
              <Link
                href="/board"
                className="inline-flex items-center gap-1 text-amber-200 hover:text-white text-xs mt-3 underline underline-offset-2"
              >
                Open the board <ChevronRight size={12} />
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* What actually left, per the API */}
      <section className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-white">
              What actually left, {range.label.toLowerCase()}
            </h2>
            <p className="text-slate-500 text-sm mt-0.5 max-w-2xl">
              From <code className="text-slate-400">/reports/payouts</code> — executed
              cards only, across every payout type, with the rates the API says it used.
              Approving a request is not a payout; executing one is.
            </p>
          </div>
          <button
            onClick={exportPayouts}
            disabled={busy === 'payouts'}
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 rounded-lg px-3.5 py-2 text-sm transition-colors shrink-0"
          >
            {busy === 'payouts' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            Export payouts
          </button>
        </div>

        {!apiReady ? (
          <Loading label="Waiting for the API session…" />
        ) : !payoutReport ? (
          <div className="bg-slate-900 border border-slate-800 rounded-xl px-5 py-4 text-slate-400 text-sm">
            The executed-payout figure is not available right now. It is left blank rather
            than shown as ₹0.
          </div>
        ) : payoutReport.empty ? (
          <Empty
            title="No data for this period"
            hint={emptyExplanation(
              payoutReport,
              'No payout card executed between these dates. Nothing left the business, which is not the same as a payout of zero.',
            )}
          />
        ) : (
          <>
            {provisionalNote(payoutReport) && (
              <Warning>
                <span className="font-semibold">Provisional.</span>{' '}
                {provisionalNote(payoutReport)}
              </Warning>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                <p className="text-slate-500 text-xs uppercase tracking-wide mb-2">
                  Executed payouts (INR)
                </p>
                <p className="text-2xl font-bold text-orange-300 tabular-nums">
                  {formatInrMinorShort(payoutReport.totals.payouts_inr_minor)}
                </p>
              </div>
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                <p className="text-slate-500 text-xs uppercase tracking-wide mb-2">
                  Cards executed
                </p>
                <p className="text-2xl font-bold text-white tabular-nums">
                  {formatCount(payoutReport.totals.cards_executed)}
                </p>
              </div>
              {/* `by_card_type` is `{card_type: inr_minor}` — PAISE, not a count.
                  `backend/app/services/reports.py:1156`:
                      "by_card_type": {r["card_type"]: r["inr_minor"] for r in rows}
                  `formatCount` was printing ₹1,234 of host withdrawals as
                  "1,23,400" under a money heading — the paise rendered as a
                  quantity, a hundredfold overstatement that looked like a
                  perfectly ordinary figure. */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                <p className="text-slate-500 text-xs uppercase tracking-wide mb-2">
                  Host withdrawals in that (INR)
                </p>
                <p className="text-2xl font-bold text-slate-200 tabular-nums">
                  {formatInrMinorShort(
                    payoutReport.totals.by_card_type.host_withdrawal ?? null,
                  )}
                </p>
                <p className="text-slate-600 text-xs mt-1.5">
                  The host-withdrawal share of the executed payouts beside it.
                </p>
              </div>
            </div>
            {otherWarnings(payoutReport).map((w, i) => (
              <Warning key={i}>{w}</Warning>
            ))}
            {rateSummary(payoutReport) && (
              <p className="text-slate-600 text-xs">
                {rateSummary(payoutReport)} Period {payoutReport.period.bounds}.
              </p>
            )}
          </>
        )}
      </section>

      {/* The queue */}
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Withdrawal requests</h2>
          <p className="text-slate-500 text-sm mt-0.5 max-w-2xl">
            Search matches host name, uid, phone, agency and status.
            {undated > 0 && (
              <>
                {' '}
                <span className="text-amber-300">
                  {undated} request{undated > 1 ? 's carry' : ' carries'} no request date
                  and {undated > 1 ? 'are' : 'is'} shown regardless of the range.
                </span>
              </>
            )}
          </p>
        </div>

        {isObserver ? (
          <Warning>
            This list is held in Firestore, and the Observer account signs in to
            the API only — it holds no Firebase session, so the requests cannot
            be read for you. The executed-payout figures above came from the API
            and are complete; this queue is not shown rather than shown wrong.
          </Warning>
        ) : (
        <DataTable<WithdrawalRequest>
          rows={filtered}
          columns={columns}
          rowKey={(r) => r.id}
          loading={listLoading}
          error={listError || undefined}
          onRetry={loadList}
          searchPlaceholder="Search host, uid, phone or agency…"
          searchKeys={['hostName', 'uid', 'phoneNumber', 'agencyId', 'status']}
          filters={[
            {
              key: 'status',
              label: 'Status',
              options: [
                { value: 'pending', label: 'Pending', count: counts.pending },
                { value: 'approved', label: 'Approved, unpaid', count: counts.approved },
                { value: 'paid', label: 'Paid', count: counts.paid },
                { value: 'rejected', label: 'Rejected', count: counts.rejected },
              ],
            },
          ]}
          activeFilters={{ status }}
          onFilterChange={(_key, value) => setStatus(value)}
          exportName="withdrawal-requests"
          pageSize={25}
          truncatedAt={QUEUE_LIMIT}
          emptyTitle="No withdrawal requests in this range"
          emptyHint="Nothing was requested between these dates. Widen the range or clear the status filter."
        />
        )}
      </section>

      {/* Raise a withdrawal card */}
      {raiseTarget && (
        <RaiseCardDialog
          req={raiseTarget}
          onClose={() => setRaiseTarget(null)}
          onRaised={(message, warnings) => {
            setRaiseTarget(null)
            setFlash(message)
            setCardWarnings(warnings)
            loadApi()
          }}
        />
      )}

      {/* Mark paid */}
      {markPaidTarget && (
        <MarkPaidModal
          req={markPaidTarget}
          onClose={() => setMarkPaidTarget(null)}
          onPaid={(id, proof) => {
            patchRequest(id, { status: 'paid', ...proof })
            setFlash(
              `Payment recorded for ${markPaidTarget.hostName || markPaidTarget.uid}.`,
            )
          }}
        />
      )}

      {/* Reject */}
      {rejectTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex items-start gap-4 mb-5">
              <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center shrink-0">
                <XCircle size={18} className="text-red-400" />
              </div>
              <div>
                <h3 className="text-white font-semibold">Reject this withdrawal</h3>
                <p className="text-slate-400 text-sm mt-1">
                  {rejectTarget.hostName || rejectTarget.uid} ·{' '}
                  <span className="text-white font-medium">
                    {formatNativeAmount(rejectTarget.inrAmount, 'inr')}
                  </span>
                </p>
              </div>
            </div>
            <div className="mb-5">
              <label className="block text-slate-400 text-xs mb-1.5">
                Reason (required — the host sees this)
              </label>
              <textarea
                autoFocus
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="e.g. Account details do not match the KYC on file…"
                rows={3}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-red-500 resize-none"
              />
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => { setRejectTarget(null); setRejectReason('') }}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={doReject}
                disabled={actingId === rejectTarget.id || !rejectReason.trim()}
                className="flex-1 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-medium rounded-lg px-4 py-2.5 text-sm transition-colors flex items-center justify-center gap-2"
              >
                {actingId === rejectTarget.id ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <X size={14} />
                )}
                Reject request
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Proof viewer */}
      {proofViewer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-white font-semibold">Payment proof</h3>
              <button
                onClick={() => setProofViewer(null)}
                className="text-slate-400 hover:text-white"
              >
                <X size={16} />
              </button>
            </div>
            <div className="space-y-3">
              {[
                { label: 'Host', value: proofViewer.hostName || proofViewer.uid },
                {
                  label: 'Amount',
                  value: formatNativeAmount(proofViewer.inrAmount, 'inr'),
                },
                { label: 'Paid on', value: whenOf(proofViewer.processedAt) },
                { label: 'Payment mode', value: proofViewer.paymentMode },
                { label: 'UTR number', value: proofViewer.utrNumber },
                { label: 'Transaction ref', value: proofViewer.transactionRef },
                { label: 'Transaction date', value: proofViewer.transactionDate },
                { label: 'Notes', value: proofViewer.notes },
              ]
                .filter((row) => row.value)
                .map((row) => (
                  <div key={row.label} className="flex items-start justify-between gap-3">
                    <span className="text-slate-500 text-sm shrink-0">{row.label}</span>
                    <span className="text-white text-sm font-medium text-right font-mono flex items-center gap-1.5">
                      {row.value}
                      {(row.label === 'UTR number' || row.label === 'Transaction ref') &&
                        row.value && (
                          <button
                            onClick={() => navigator.clipboard.writeText(String(row.value))}
                            className="text-slate-500 hover:text-white"
                            aria-label={`Copy ${row.label}`}
                          >
                            <Copy size={11} />
                          </button>
                        )}
                    </span>
                  </div>
                ))}
              {proofViewer.transactionProofUrl && (
                <a
                  href={proofViewer.transactionProofUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 w-full mt-2 px-4 py-2.5 bg-blue-500/10 border border-blue-500/30 text-blue-400 rounded-lg text-sm font-medium hover:bg-blue-500/20 transition-colors"
                >
                  <ExternalLink size={14} /> View the screenshot
                </a>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
