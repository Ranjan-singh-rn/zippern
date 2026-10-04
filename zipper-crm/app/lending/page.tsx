'use client'

/**
 * The credit book.
 *
 * Coins lent to sellers are the largest thing the business cannot currently
 * see. The debt lives in a subcollection per seller, so total exposure has
 * never been a number anyone could state, and an overdue seller is discovered
 * by memory.
 *
 * This screen is the whole book on one page: what is out, what is late, and
 * per seller what was lent, repaid and still owed.
 *
 * Every action here raises a card. Lending, repayment, recovery and write-off
 * all move money, so none of them take effect on this screen — an owner signs
 * on /board first. Recovery is the one that surprises people: a penalty is
 * legitimate, so the total recovered may exceed the original debt, and if the
 * seller's balance cannot cover it the shortfall stays owed rather than
 * quietly disappearing.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowRight, BookOpen, CheckCircle2, Clock, HandCoins,
  Loader2, RefreshCw, ShieldAlert, Undo2, Wallet, X,
} from 'lucide-react'
import { Column, DataTable } from '@/components/ui/DataTable'
import { Denied, Warning } from '@/components/ui/States'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { ApiError } from '@/lib/api'
import {
  credit as creditApi, lending, partnerOps,
  coins as coinText, daysOverdue, standingOf, when,
  STANDING_LABEL, STANDING_TONE,
  type CreditExposure, type CreditStanding, type OverdueSeller, type Partner,
} from '@/lib/apiPartners'

const PAGE_ROLES = [
  'superadmin', 'finance_admin', 'finance_member', 'ops_admin',
] as const

const MIN_REASON = 3

const STANDING_RANK: Record<CreditStanding, number> = {
  overdue: 0,
  due_soon: 1,
  current: 2,
  written_off: 3,
  none: 4,
}

interface Row {
  id: string
  name: string
  standing: CreditStanding
  lent: number
  repaid: number
  recovered: number
  writtenOff: number
  outstanding: number
  dueAt: string | null
  overdueDays: number
}

type Mode = 'lend' | 'repay' | 'recover' | 'write_off'

export default function Lending() {
  const { crmUser } = useAuth()
  const allowed = !!crmUser && canAccess(crmUser, [...PAGE_ROLES])

  const [partners, setPartners] = useState<Partner[]>([])
  const [exposure, setExposure] = useState<CreditExposure | null>(null)
  const [overdue, setOverdue] = useState<OverdueSeller[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [standing, setStanding] = useState('all')
  const [dialog, setDialog] = useState<{ row: Row; mode: Mode } | null>(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const [list, exp, late] = await Promise.all([
        partnerOps.list({ kind: 'seller', limit: 500 }),
        creditApi.exposure().catch(() => null),
        creditApi.overdue().catch(() => [] as OverdueSeller[]),
      ])
      setPartners(list)
      setExposure(exp)
      setOverdue(late)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the credit book.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (allowed) load() }, [allowed, load])

  const rows = useMemo<Row[]>(() => {
    return partners
      .map((p) => {
        const c = p.credit ?? {}
        const dueAt = c.due_at ?? null
        return {
          id: p.id,
          name: p.name || p.id,
          standing: standingOf(c),
          lent: c.total_lent ?? 0,
          repaid: c.total_repaid ?? 0,
          recovered: c.total_recovered ?? 0,
          writtenOff: c.total_written_off ?? 0,
          outstanding: c.outstanding ?? 0,
          dueAt,
          overdueDays: daysOverdue(dueAt),
        }
      })
      .sort((a, b) => {
        const rank = STANDING_RANK[a.standing] - STANDING_RANK[b.standing]
        if (rank !== 0) return rank
        return b.outstanding - a.outstanding
      })
  }, [partners])

  const filtered = useMemo(
    () => rows.filter((r) => standing === 'all' || r.standing === standing),
    [rows, standing],
  )

  const overdueRows = rows.filter((r) => r.standing === 'overdue')
  const overdueTotal = overdueRows.reduce((s, r) => s + r.outstanding, 0)
  const totalOut =
    exposure?.total_outstanding ?? rows.reduce((s, r) => s + r.outstanding, 0)

  const columns: Column<Row>[] = [
    {
      key: 'name',
      header: 'Seller',
      value: (r) => r.name,
      render: (r) => (
        <div className="min-w-0">
          <p className="text-white font-medium truncate">{r.name}</p>
          <p className="text-slate-600 text-xs font-mono truncate">{r.id}</p>
        </div>
      ),
    },
    {
      key: 'standing',
      header: 'Standing',
      value: (r) => STANDING_LABEL[r.standing],
      render: (r) => (
        <span className={`text-xs px-2 py-1 rounded ${STANDING_TONE[r.standing]}`}>
          {STANDING_LABEL[r.standing]}
        </span>
      ),
    },
    {
      key: 'lent',
      header: 'Lent',
      align: 'right',
      hideOnMobile: true,
      value: (r) => r.lent,
      render: (r) => <span className="text-slate-400">{r.lent.toLocaleString('en-IN')}</span>,
    },
    {
      key: 'repaid',
      header: 'Repaid',
      align: 'right',
      hideOnMobile: true,
      value: (r) => r.repaid + r.recovered,
      render: (r) => (
        <span className="text-slate-400">
          {(r.repaid + r.recovered).toLocaleString('en-IN')}
        </span>
      ),
    },
    {
      key: 'outstanding',
      header: 'Outstanding',
      align: 'right',
      value: (r) => r.outstanding,
      render: (r) => (
        <span className={r.outstanding > 0 ? 'text-amber-300 font-semibold' : 'text-slate-600'}>
          {r.outstanding > 0 ? r.outstanding.toLocaleString('en-IN') : '—'}
        </span>
      ),
    },
    {
      key: 'due',
      header: 'Due',
      hideOnMobile: true,
      value: (r) => r.dueAt ?? '',
      render: (r) => (
        <span className="text-slate-400 text-xs">{r.dueAt ? when(r.dueAt) : '—'}</span>
      ),
    },
    {
      key: 'late',
      header: 'Days late',
      align: 'right',
      value: (r) => r.overdueDays,
      render: (r) =>
        r.standing === 'overdue' ? (
          <span className="text-red-300 font-semibold">{r.overdueDays}</span>
        ) : (
          <span className="text-slate-700">—</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      sortable: false,
      value: () => '',
      render: (r) => (
        <div className="flex items-center justify-end gap-1.5">
          <RowButton tone="pink" onClick={() => setDialog({ row: r, mode: 'lend' })}>
            Lend
          </RowButton>
          <RowButton tone="slate" onClick={() => setDialog({ row: r, mode: 'repay' })}>
            Repay
          </RowButton>
          <RowButton tone="amber" onClick={() => setDialog({ row: r, mode: 'recover' })}>
            Recover
          </RowButton>
          <RowButton tone="red" onClick={() => setDialog({ row: r, mode: 'write_off' })}>
            Write off
          </RowButton>
        </div>
      ),
    },
  ]

  if (!allowed) return <Denied what="the credit book" />

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2">
            <BookOpen size={26} className="text-pink-500" />
            Credit book
          </h1>
          <p className="text-slate-400 text-sm mt-1 max-w-2xl">
            Every coin lent to a seller, what came back, and what is still out.
            Nothing on this page moves money on its own —{' '}
            <span className="text-white font-medium">an owner signs before anything moves</span>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/board"
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2.5 text-sm transition-colors"
          >
            Money board <ArrowRight size={14} />
          </Link>
          <button
            onClick={() => { setLoading(true); load() }}
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2.5 text-sm transition-colors"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {notice && <Warning onDismiss={() => setNotice('')}>{notice}</Warning>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat
          label="Total exposure"
          value={coinText(totalOut)}
          tone={totalOut > 0 ? 'text-amber-300' : 'text-slate-600'}
          hint="Out across every seller"
        />
        <Stat
          label="Sellers with credit"
          value={String(exposure?.sellers_with_credit ?? rows.filter((r) => r.outstanding > 0).length)}
          tone="text-white"
        />
        <Stat
          label="Overdue"
          value={String(overdueRows.length)}
          tone={overdueRows.length > 0 ? 'text-red-300' : 'text-slate-600'}
          hint="Blocked from new inventory"
        />
        <Stat
          label="Overdue value"
          value={coinText(overdueTotal)}
          tone={overdueTotal > 0 ? 'text-red-300' : 'text-slate-600'}
        />
      </div>

      {overdueRows.length > 0 && (
        <div className="bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3.5 mb-5">
          <div className="flex items-start gap-2">
            <ShieldAlert size={16} className="text-red-400 mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-red-200 text-sm font-semibold">
                {coinText(overdueTotal)} is past its due date across{' '}
                {overdueRows.length} seller{overdueRows.length === 1 ? '' : 's'}.
              </p>
              <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                {overdueRows.slice(0, 8).map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-red-100 truncate">{r.name}</span>
                    <span className="text-red-300 shrink-0">
                      {r.outstanding.toLocaleString('en-IN')} · {r.overdueDays}d late
                    </span>
                  </li>
                ))}
              </ul>
              {overdueRows.length > 8 && (
                <p className="text-red-200/60 text-xs mt-1">
                  and {overdueRows.length - 8} more — filter by standing to see them all.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {overdue.length > overdueRows.length && (
        <Warning>
          The credit service reports {overdue.length} overdue seller
          {overdue.length === 1 ? '' : 's'}, but only {overdueRows.length} appear
          here — some are outside the {partners.length} records loaded.
        </Warning>
      )}

      <DataTable<Row>
        rows={filtered}
        columns={columns}
        rowKey={(r) => r.id}
        loading={loading}
        error={error}
        onRetry={() => { setLoading(true); load() }}
        searchPlaceholder="Search by seller name or id…"
        searchKeys={['name', 'id']}
        filters={[
          {
            key: 'standing',
            label: 'Standing',
            options: [
              { value: 'overdue', label: 'Overdue' },
              { value: 'due_soon', label: 'Due soon' },
              { value: 'current', label: 'Current' },
              { value: 'none', label: 'No credit' },
            ],
          },
        ]}
        activeFilters={{ standing }}
        onFilterChange={(_key, value) => setStanding(value)}
        exportName="credit-book"
        emptyTitle="No sellers on the book"
        emptyHint="Credit appears here once a lending card is signed and executed."
        truncatedAt={500}
      />

      {dialog && (
        <CreditDialog
          row={dialog.row}
          mode={dialog.mode}
          onClose={() => setDialog(null)}
          onRaised={(message) => { setDialog(null); setNotice(message); load() }}
        />
      )}
    </div>
  )
}

// ── Raising a credit card ─────────────────────────────────────────────────────

const MODE_COPY: Record<Mode, { title: string; blurb: string; verb: string; tone: string }> = {
  lend: {
    title: 'Lend coins',
    blurb:
      'Coins go out on credit against a due date. Credit without a due date is a gift, so the date is required.',
    verb: 'Raise the lending card',
    tone: 'bg-pink-500 hover:bg-pink-600',
  },
  repay: {
    title: 'Record a repayment',
    blurb:
      'The seller has paid us back. This closes part of the debt; no coins move, because the coins were issued and sold long ago.',
    verb: 'Raise the repayment card',
    tone: 'bg-pink-500 hover:bg-pink-600',
  },
  recover: {
    title: 'Recover unpaid credit',
    blurb:
      "Take what is owed out of the seller's own balance. A late penalty is legitimate and may push the total above the original debt.",
    verb: 'Raise the recovery card',
    tone: 'bg-amber-600 hover:bg-amber-500',
  },
  write_off: {
    title: 'Write off bad debt',
    blurb:
      'This is a decision to stop chasing the money and book it as a loss. It is not an adjustment and it does not tidy anything up.',
    verb: 'Raise the write-off card',
    tone: 'bg-red-600 hover:bg-red-500',
  },
}

function CreditDialog({
  row,
  mode,
  onClose,
  onRaised,
}: {
  row: Row
  mode: Mode
  onClose: () => void
  onRaised: (message: string) => void
}) {
  const copy = MODE_COPY[mode]

  const [amount, setAmount] = useState(
    mode === 'lend' ? '' : row.outstanding > 0 ? String(row.outstanding) : '',
  )
  const [penalty, setPenalty] = useState('0')
  const [dueDate, setDueDate] = useState('')
  const [terms, setTerms] = useState('')
  const [paymentRef, setPaymentRef] = useState('')
  const [reason, setReason] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // Recovery needs the seller's live balance to say honestly what will happen.
  const [balance, setBalance] = useState<number | null>(null)
  const [balanceErr, setBalanceErr] = useState('')

  useEffect(() => {
    if (mode !== 'recover') return
    let live = true
    partnerOps
      .get(row.id)
      .then((p) => { if (live) setBalance(p.coins_on_hand ?? 0) })
      .catch((e) => {
        if (live) setBalanceErr(e instanceof ApiError ? e.message : 'Balance unavailable.')
      })
    return () => { live = false }
  }, [mode, row.id])

  const coins = Math.round(Number(amount)) || 0
  const penaltyCoins = Math.round(Number(penalty)) || 0
  const totalRecovery = coins + penaltyCoins
  const projectedShortfall =
    balance === null ? null : Math.max(0, totalRecovery - balance)

  const dueInPast =
    mode === 'lend' && !!dueDate && new Date(`${dueDate}T23:59:59`).getTime() < Date.now()

  const valid =
    coins > 0 &&
    reason.trim().length >= MIN_REASON &&
    (mode !== 'lend' || !!dueDate) &&
    (mode !== 'write_off' || acknowledged)

  async function submit() {
    if (!valid) return
    setBusy(true)
    setErr('')
    try {
      if (mode === 'lend') {
        await lending.request(row.id, {
          coins,
          due_at: new Date(`${dueDate}T00:00:00`).toISOString(),
          terms: terms.trim(),
          reason: reason.trim(),
        })
        onRaised(
          `Lending card raised for ${row.name}. No coins have moved — an owner signs first.`,
        )
      } else if (mode === 'repay') {
        await lending.requestRepayment(row.id, {
          coins,
          payment_ref: paymentRef.trim(),
          reason: reason.trim(),
        })
        onRaised(
          `Repayment card raised for ${row.name}. The debt closes when an owner signs it.`,
        )
      } else if (mode === 'recover') {
        await lending.requestRecovery(row.id, {
          coins,
          penalty_coins: penaltyCoins,
          reason: reason.trim(),
        })
        onRaised(
          `Recovery card raised for ${row.name}. Nothing is taken from their balance until an owner signs.`,
        )
      } else {
        await lending.requestWriteOff(row.id, { coins, reason: reason.trim() })
        onRaised(
          `Write-off card raised for ${row.name}. It becomes a recorded loss when an owner signs it.`,
        )
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'That was not accepted.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 bg-black/70 backdrop-blur-sm overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-lg my-8">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800">
          <div className="min-w-0">
            <h2 className="text-white font-semibold">{copy.title}</h2>
            <p className="text-slate-500 text-xs mt-0.5 truncate">
              {row.name} · owes {row.outstanding.toLocaleString('en-IN')} coins
              {row.standing === 'overdue' ? ` · ${row.overdueDays} days late` : ''}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-slate-400 text-sm">{copy.blurb}</p>

          <Labelled label={mode === 'recover' ? 'Debt to recover (coins)' : 'Coins'}>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
              inputMode="numeric"
              autoFocus
              placeholder="0"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
            />
            {mode !== 'lend' && row.outstanding > 0 && (
              <p className="text-slate-500 text-xs mt-1">
                Outstanding is {row.outstanding.toLocaleString('en-IN')} coins.
              </p>
            )}
          </Labelled>

          {mode === 'lend' && (
            <>
              <Labelled label="Due date">
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500"
                />
                {dueInPast && (
                  <p className="text-amber-400 text-xs mt-1">
                    That date has already passed — this credit would be overdue the
                    moment it is issued, and the seller would be blocked from new
                    inventory.
                  </p>
                )}
              </Labelled>
              <Labelled label="Terms (optional)">
                <input
                  value={terms}
                  onChange={(e) => setTerms(e.target.value)}
                  placeholder="What was agreed — repayment schedule, penalty, anything else."
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
                />
              </Labelled>
            </>
          )}

          {mode === 'repay' && (
            <Labelled label="Payment reference (optional)">
              <input
                value={paymentRef}
                onChange={(e) => setPaymentRef(e.target.value)}
                placeholder="UTR or transaction id"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm font-mono placeholder-slate-600 focus:outline-none focus:border-pink-500"
              />
              <p className="text-slate-500 text-xs mt-1">
                A reference already used elsewhere will be flagged on the card, the
                same as a coin purchase.
              </p>
            </Labelled>
          )}

          {mode === 'recover' && (
            <>
              <Labelled label="Penalty (coins)">
                <input
                  value={penalty}
                  onChange={(e) => setPenalty(e.target.value.replace(/[^0-9]/g, ''))}
                  inputMode="numeric"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-amber-500"
                />
              </Labelled>

              <div className="bg-slate-800/60 border border-slate-700 rounded-lg p-4 space-y-1.5">
                <SplitRow label="Original debt" value={coins.toLocaleString('en-IN')} />
                <SplitRow
                  label="Late penalty"
                  value={penaltyCoins.toLocaleString('en-IN')}
                  tone="text-amber-300"
                />
                <div className="border-t border-slate-700 pt-1.5">
                  <SplitRow
                    label="Total recovery"
                    value={totalRecovery.toLocaleString('en-IN')}
                    tone="text-white font-semibold"
                  />
                </div>
                {penaltyCoins > 0 && (
                  <p className="text-slate-500 text-xs pt-1">
                    The total is above the original debt on purpose. The penalty is
                    a legitimate charge, and both numbers are on the card so the
                    owner sees the split before signing.
                  </p>
                )}

                <div className="border-t border-slate-700 pt-2 mt-1">
                  {balanceErr ? (
                    <p className="text-slate-500 text-xs">{balanceErr}</p>
                  ) : balance === null ? (
                    <p className="text-slate-500 text-xs flex items-center gap-1.5">
                      <Loader2 size={11} className="animate-spin" /> Checking what
                      the seller holds…
                    </p>
                  ) : (
                    <>
                      <SplitRow
                        label="Seller holds now"
                        value={balance.toLocaleString('en-IN')}
                      />
                      {projectedShortfall !== null && projectedShortfall > 0 ? (
                        <p className="text-amber-200 text-xs mt-2 bg-amber-500/10 border border-amber-500/30 rounded px-2.5 py-2">
                          Their balance covers{' '}
                          {Math.min(balance, totalRecovery).toLocaleString('en-IN')} of{' '}
                          {totalRecovery.toLocaleString('en-IN')}. The remaining{' '}
                          <span className="font-semibold">
                            {projectedShortfall.toLocaleString('en-IN')} coins stays an
                            open receivable
                          </span>{' '}
                          against this seller — it is not written off, and it does not
                          disappear. Writing it off is a separate owner decision.
                        </p>
                      ) : (
                        <p className="text-green-300 text-xs mt-2 flex items-start gap-1.5">
                          <CheckCircle2 size={12} className="mt-0.5 shrink-0" />
                          Their balance covers the full recovery.
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
            </>
          )}

          {mode === 'write_off' && (
            <div className="bg-red-500/10 border border-red-500/40 rounded-lg p-4">
              <p className="text-red-200 text-sm font-semibold flex items-center gap-2">
                <AlertTriangle size={15} /> This is recorded as a loss.
              </p>
              <p className="text-red-200/80 text-sm mt-1">
                {coins.toLocaleString('en-IN')} coins stop being owed to us. It
                lands in the audit log as a loss, it shows in the accounts as one,
                and it cannot be reversed from this screen. Recover what you can
                first — a write-off is what is left when recovery has failed.
              </p>
              <label className="flex items-start gap-2 mt-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  className="mt-0.5 accent-red-500"
                />
                <span className="text-red-100 text-sm">
                  I understand this books a loss of {coins.toLocaleString('en-IN')}{' '}
                  coins against {row.name}.
                </span>
              </label>
            </div>
          )}

          <Labelled label="Reason">
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="Why — kept on the card and in the audit log."
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 resize-none"
            />
            {reason.trim().length > 0 && reason.trim().length < MIN_REASON && (
              <p className="text-amber-400 text-xs mt-1 flex items-center gap-1.5">
                <Clock size={11} /> At least {MIN_REASON} characters.
              </p>
            )}
          </Labelled>

          <p className="text-slate-500 text-xs flex items-start gap-1.5">
            <Wallet size={12} className="mt-0.5 shrink-0" />
            This raises a card. Nothing moves until an owner signs it on the money
            board.
          </p>

          {err && (
            <p className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-300 text-sm">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {err}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-800">
          <button onClick={onClose} className="text-slate-400 hover:text-white text-sm px-4 py-2">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!valid || busy}
            className={`flex items-center gap-2 disabled:bg-slate-800 disabled:text-slate-600 text-white font-semibold rounded-lg px-5 py-2.5 text-sm transition-colors ${copy.tone}`}
          >
            {busy ? (
              <Loader2 size={15} className="animate-spin" />
            ) : mode === 'repay' ? (
              <Undo2 size={15} />
            ) : (
              <HandCoins size={15} />
            )}
            {copy.verb}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Bits ──────────────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string
  value: string
  tone: string
  hint?: string
}) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">{label}</p>
      <p className={`text-xl font-bold mt-1 ${tone}`}>{value}</p>
      {hint && <p className="text-slate-600 text-xs mt-0.5">{hint}</p>}
    </div>
  )
}

function SplitRow({
  label,
  value,
  tone = 'text-slate-300',
}: {
  label: string
  value: string
  tone?: string
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-slate-400 text-xs uppercase tracking-wide">{label}</span>
      <span className={`text-sm ${tone}`}>{value}</span>
    </div>
  )
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-slate-400 text-xs font-medium uppercase tracking-wide mb-1.5">
        {label}
      </label>
      {children}
    </div>
  )
}

function RowButton({
  children,
  onClick,
  tone,
}: {
  children: React.ReactNode
  onClick: () => void
  tone: 'pink' | 'amber' | 'red' | 'slate'
}) {
  const tones = {
    pink: 'bg-pink-500/90 hover:bg-pink-500 text-white',
    amber: 'bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30',
    red: 'bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/30',
    slate: 'bg-slate-800 hover:bg-slate-700 text-slate-300',
  }
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${tones[tone]}`}
    >
      {children}
    </button>
  )
}
