'use client'

/**
 * One seller's whole record, in one list, for both of the people who need it.
 *
 * ── The question this answers ─────────────────────────────────────────────────
 *
 * A seller's account used to be spread across four tabs and a lifetime counter,
 * and neither side could add it up:
 *
 *   * The owner's seller page had a coin ledger, a card list and a profile. No
 *     dates, no rupees against a movement, no UTR, no sales. `cash_paid_minor`
 *     is a single lifetime `$inc` on the partner record — the same number in
 *     every window — so "how much business have I done with him **this month**"
 *     had no source anywhere in the product.
 *   * The seller's own portal had the same figures split four ways, and their
 *     repayments were in none of them: `execute_repayment` writes no ledger
 *     movement, so a repayment cannot appear in a coin statement at any limit.
 *     The one movement they most want a receipt for was the one they could
 *     never see.
 *
 * ── One component, one endpoint, on purpose ──────────────────────────────────
 *
 * Both screens mount this and both read `GET /partners/sellers/{id}/history`.
 * Two implementations of "what has happened on this account" would eventually
 * disagree, and the version the seller reads disagreeing with the version the
 * owner reads is the argument neither of them can win. `own_partner_id_or_403`
 * on the server is what makes one route safe for both: a partner passing `me`
 * is answered with their own record and nobody else's.
 *
 * ── Units ────────────────────────────────────────────────────────────────────
 *
 * Coins are coins and are never money. Rupee amounts are integer paise on the
 * wire and are divided by 100 exactly once, by `inrExact()` in lib/apiPartners,
 * which also puts the ₹ on. Nothing here formats a rupee figure by hand.
 *
 * ── A failed read is never a zero ────────────────────────────────────────────
 *
 * The read is a `ReadResult`. A refusal renders as `UnavailablePanel` with the
 * server's own sentence — "₹0 business" and "we could not read your business"
 * are different statements and must never look the same.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  ArrowDownLeft, ArrowUpRight, Ban, Coins, CreditCard, ExternalLink, FileText,
  Gem, Landmark, Package, RefreshCw, ShoppingBag,
} from 'lucide-react'
import { Empty, Loading, UnavailablePanel, Warning } from '@/components/ui/States'
import { DateRangePicker, defaultRange, toParams, type Range } from '@/components/ui/DateRange'
import { ApiError } from '@/lib/api'
import { failureCode, ok, toFailure, type ReadFailure, type ReadResult } from '@/lib/readState'
import {
  statements, coins as coinText, inrExact, whenExact,
  type SellerHistory, type SellerHistoryRow,
} from '@/lib/apiPartners'

/**
 * Classify with `readState`, but say what the SERVER said.
 *
 * The same helper `app/seller-dashboard/page.tsx` and
 * `app/agency-dashboard/AgencyMoney.tsx` each define, for the same reason:
 * `toFailure` describes every refusal in Firestore's vocabulary, and this read
 * is an HTTP call to the partner API, which refuses in whole sentences written
 * to be shown — "This account has no approved partner record, so there is
 * nothing to show yet." Turning that into "your role may not cover it, or the
 * rule for it is missing" sends a seller looking for a Firestore rule that has
 * nothing to do with why they cannot see their own money. The classification is
 * already right; only the wording is taken from the response.
 */
function apiFailure(err: unknown, label: string): ReadFailure {
  if (err instanceof ApiError && err.message.trim()) {
    console.error(`read failed: ${label}`, err)
    return { ok: false, code: failureCode(err), reason: err.message }
  }
  return toFailure(err, label)
}

/** Where a row has got to. Card stages and sale statuses share this map — a
 *  sale is not a card and carries `pending`/`approved`/`failed` instead. */
const STAGE_LABEL: Record<string, string> = {
  requested: 'Raised',
  under_review: 'Under review',
  awaiting_signoff: 'Awaiting signature',
  approved: 'Signed — not moved',
  executed: 'Done',
  rejected: 'Rejected',
  failed: 'Failed',
  pending: 'Awaiting approval',
}

const STAGE_TONE: Record<string, string> = {
  requested: 'bg-slate-700 text-slate-300',
  under_review: 'bg-blue-500/15 text-blue-300',
  awaiting_signoff: 'bg-amber-500/15 text-amber-300',
  approved: 'bg-amber-500/15 text-amber-200',
  executed: 'bg-slate-700/60 text-slate-400',
  rejected: 'bg-red-500/15 text-red-300',
  failed: 'bg-red-500/20 text-red-300',
  pending: 'bg-amber-500/15 text-amber-300',
}

const KIND_ICON: Record<SellerHistoryRow['kind'], React.ElementType> = {
  coin_purchase: Package,
  lending_issue: CreditCard,
  repayment: ArrowDownLeft,
  recovery: ArrowUpRight,
  write_off: Ban,
  sale: Gem,
  movement: Coins,
}

export type Audience = 'owner' | 'seller'

export function SellerHistoryPanel({
  sellerId,
  audience,
  /** Their name, for the owner's copy. Never shown to the seller themselves. */
  sellerName = '',
}: {
  sellerId: string
  audience: Audience
  sellerName?: string
}) {
  // The seller opens on their whole record — they came here to reconcile it,
  // and a 30-day default would hide the purchase they are looking for. The
  // owner opens on a period, because the owner's question is a period question.
  const [range, setRange] = useState<Range | null>(
    audience === 'owner' ? defaultRange() : null,
  )
  const [result, setResult] = useState<ReadResult<SellerHistory> | null>(null)

  const load = useCallback(async () => {
    if (!sellerId) return
    setResult(null)
    const params = range ? toParams(range) : {}
    try {
      setResult(ok(await statements.sellerHistory(sellerId, { ...params, limit: 500 })))
    } catch (err) {
      setResult(apiFailure(err, 'seller history'))
    }
  }, [sellerId, range])

  useEffect(() => { load() }, [load])

  const them = audience === 'owner' ? (sellerName || 'this seller') : 'you'
  const they = audience === 'owner' ? 'they' : 'you'

  return (
    <div className="space-y-4">
      {/* ── Period ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-white font-semibold flex items-center gap-2">
            <FileText size={15} className="text-slate-500" />
            {audience === 'owner' ? 'Everything with this seller' : 'Everything'}
          </h2>
          <p className="text-slate-500 text-sm mt-0.5 max-w-2xl">
            {audience === 'owner'
              ? 'Every movement between the business and this seller, in one list — purchases with the rupees and the reference, lending, repayments, recoveries, write-offs, and the sales they filed.'
              : 'Your whole record in one place — what you bought and paid, what you borrowed, what you repaid, what we recovered, and every sale you filed. Nothing here is a summary of a summary.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            onClick={() => setRange(range ? null : defaultRange())}
            className={`rounded-lg px-3.5 py-2.5 text-sm border transition-colors ${
              range
                ? 'bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-700'
                : 'bg-pink-500/10 border-pink-500 text-pink-200'
            }`}
          >
            {range ? 'All time' : 'All time · on'}
          </button>
          {range && <DateRangePicker value={range} onChange={setRange} />}
          <button
            onClick={load}
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2.5 text-sm transition-colors"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {result === null ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl">
          <Loading label="Reading the record…" />
        </div>
      ) : !result.ok ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl">
          <UnavailablePanel
            failure={result}
            what={audience === 'owner' ? 'This seller’s history' : 'Your history'}
            onRetry={load}
          />
        </div>
      ) : (
        <HistoryBody
          history={result.value}
          audience={audience}
          them={them}
          they={they}
          periodLabel={range ? range.label : 'all time'}
        />
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════

function HistoryBody({
  history,
  audience,
  them,
  they,
  periodLabel,
}: {
  history: SellerHistory
  audience: Audience
  them: string
  they: string
  periodLabel: string
}) {
  const t = history.totals
  const capped =
    history.sources.cards_capped ||
    history.sources.ledger_capped ||
    history.sources.sales_capped

  return (
    <>
      {/* ── "Total business done in this period" ───────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile
          icon={<Package size={13} />}
          label="Coins bought"
          value={coinText(t.coins_bought)}
          tone="text-white"
          hint={audience === 'owner' ? 'Inventory we sold them.' : 'Stock you bought from us.'}
        />
        <Tile
          icon={<Landmark size={13} />}
          label="Rupees paid"
          value={inrExact(t.rupees_paid_minor)}
          tone="text-green-300"
          hint={audience === 'owner' ? 'Cash into the business.' : 'What you paid us.'}
        />
        <Tile
          icon={<Gem size={13} />}
          label="Coins sold"
          value={coinText(t.coins_sold)}
          tone="text-white"
          hint={`Stock ${they} sold on to buyers.`}
        />
        <Tile
          icon={<ShoppingBag size={13} />}
          label="Rupees taken"
          value={inrExact(t.rupees_taken_minor)}
          tone="text-slate-300"
          hint={`What buyers paid ${they}. Never touches us.`}
        />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile label="Lent on credit" value={coinText(t.coins_lent)} tone="text-amber-300" />
        <Tile label="Repaid" value={coinText(t.coins_repaid)} tone="text-green-300" />
        <Tile
          label="Recovered from stock"
          value={coinText(t.coins_recovered)}
          tone={t.coins_recovered > 0 ? 'text-red-300' : 'text-slate-500'}
        />
        <Tile
          label="Written off"
          value={coinText(t.coins_written_off)}
          tone={t.coins_written_off > 0 ? 'text-red-300' : 'text-slate-500'}
        />
      </div>

      <p className="text-slate-500 text-sm">
        {t.settled_movements} movement{t.settled_movements === 1 ? '' : 's'} actually
        happened in <strong className="text-slate-300">{periodLabel}</strong>. Every
        figure above is added up from the rows below and from nothing else — which
        is why it can be scoped to a period at all. The lifetime &ldquo;paid us to
        date&rdquo; counter on {audience === 'owner' ? 'the' : 'your'} record is a
        single running total and says the same thing whatever dates you pick.
      </p>

      {t.pending_movements > 0 && (
        <Warning>
          {t.pending_movements} card{t.pending_movements === 1 ? ' is' : 's are'} raised
          and not executed, for {coinText(t.pending_coins)}
          {t.pending_rupees_minor > 0 ? ` and ${inrExact(t.pending_rupees_minor)}` : ''}.
          <strong> Nothing has moved on {t.pending_movements === 1 ? 'it' : 'them'}</strong>,
          so none of it is in the totals above. Each is listed below with the
          stage it has reached.
        </Warning>
      )}

      {t.refused_movements > 0 && (
        <p className="text-slate-500 text-sm">
          {t.refused_movements} more {t.refused_movements === 1 ? 'was' : 'were'}{' '}
          rejected or failed. {t.refused_movements === 1 ? 'It is' : 'They are'} listed
          below with the reason, and {t.refused_movements === 1 ? 'is' : 'are'} counted
          as neither done nor in flight — nothing moved, and nothing is going to.
        </p>
      )}

      {history.truncated && (
        <Warning>
          More movements matched this period than were returned, so the list below
          is the most recent of them and the totals cover only those. Narrow the
          dates to see the rest — this is not everything, and it is not a zero
          either.
        </Warning>
      )}

      {capped && (
        <Warning>
          One of the sources behind this list hit its read limit, so a very old
          movement may be missing from it. The money board and the audit log hold
          the full record.
        </Warning>
      )}

      {/* ── The list ───────────────────────────────────────────────────────── */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        {history.rows.length === 0 ? (
          <Empty
            title={`Nothing in ${periodLabel}`}
            hint={`No purchase, lending, repayment, recovery, write-off or sale involving ${them} falls in this period. Widen the dates, or switch to all time.`}
            icon={<Coins size={26} />}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-800">
                  <Th>What</Th>
                  <Th hideOnMobile>When</Th>
                  <Th hideOnMobile>Counterparty</Th>
                  <Th hideOnMobile>Reference</Th>
                  <Th align="right">Coins</Th>
                  <Th align="right" hideOnMobile>Owed</Th>
                  <Th align="right">Rupees</Th>
                  <Th align="right">Stage</Th>
                </tr>
              </thead>
              <tbody>
                {history.rows.map((row, i) => (
                  <Row key={rowKey(row, i)} row={row} audience={audience} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-slate-600 text-xs">{history.note}</p>
    </>
  )
}

/** Stable enough for React, and never an index alone where an id exists. */
function rowKey(row: SellerHistoryRow, i: number): string {
  return `${row.source}:${row.card_id ?? row.sale_id ?? ''}:${row.at ?? ''}:${i}`
}

function Row({ row, audience }: { row: SellerHistoryRow; audience: Audience }) {
  const Icon = KIND_ICON[row.kind] ?? Coins
  const stage = row.card_stage ?? ''

  return (
    <tr className="border-b border-slate-800/60 last:border-0 align-top">
      <td className="px-3 sm:px-5 py-3">
        <p className="text-slate-200 text-sm flex items-center gap-2">
          <Icon size={13} className="text-slate-500 shrink-0" />
          {row.what}
        </p>
        {row.reason && (
          <p className="text-slate-600 text-xs mt-0.5 break-words max-w-md">{row.reason}</p>
        )}
        {/* On a narrow screen the four hidden columns collapse into here rather
            than disappearing — a reference nobody can see is a reference that
            cannot be reconciled against a bank line. */}
        <p className="text-slate-600 text-xs sm:hidden mt-0.5">{whenExact(row.at)}</p>
        {row.reference && (
          <p className="text-slate-500 text-xs font-mono sm:hidden break-all">
            {row.reference}
          </p>
        )}
        {row.proof_url && (
          <a
            href={row.proof_url}
            target="_blank"
            rel="noreferrer"
            className="text-pink-400 hover:text-pink-300 text-xs inline-flex items-center gap-1 mt-0.5"
          >
            Proof <ExternalLink size={10} />
          </a>
        )}
      </td>

      <td className="px-3 sm:px-5 py-3 text-xs text-slate-500 hidden sm:table-cell whitespace-nowrap">
        {whenExact(row.at)}
      </td>

      <td className="px-3 sm:px-5 py-3 text-xs text-slate-400 hidden sm:table-cell break-all max-w-[10rem]">
        {row.kind === 'sale'
          ? row.counterparty || 'a buyer'
          : audience === 'owner'
            ? 'Us'
            : 'Zipper'}
      </td>

      <td className="px-3 sm:px-5 py-3 text-xs text-slate-400 font-mono hidden sm:table-cell break-all max-w-[10rem]">
        {/* An empty reference is the truth about a lending or a write-off, which
            carries none. It is a dash, not a missing read. */}
        {row.reference || <span className="text-slate-700">—</span>}
      </td>

      <td
        className={`px-3 sm:px-5 py-3 text-sm font-semibold text-right whitespace-nowrap ${
          row.coins > 0 ? 'text-green-300' : row.coins < 0 ? 'text-slate-300' : 'text-slate-700'
        }`}
      >
        {row.coins === 0 ? '—' : `${row.coins > 0 ? '+' : ''}${row.coins.toLocaleString('en-IN')}`}
      </td>

      <td
        className={`px-3 sm:px-5 py-3 text-sm text-right whitespace-nowrap hidden sm:table-cell ${
          row.owed_delta > 0 ? 'text-amber-300' : row.owed_delta < 0 ? 'text-green-300' : 'text-slate-700'
        }`}
      >
        {row.owed_delta === 0
          ? '—'
          : `${row.owed_delta > 0 ? '+' : ''}${row.owed_delta.toLocaleString('en-IN')}`}
      </td>

      <td
        className={`px-3 sm:px-5 py-3 text-sm text-right whitespace-nowrap ${
          row.money === 'seller_paid_zipper'
            ? 'text-green-300'
            : row.money === 'buyer_paid_seller'
              ? 'text-slate-300'
              : 'text-slate-700'
        }`}
      >
        {/* Paise → rupees, once, by inrExact. A movement with no money in it
            says so rather than printing ₹0.00, which reads as a free deal. */}
        {row.amount_minor === 0 ? '—' : inrExact(row.amount_minor)}
      </td>

      <td className="px-3 sm:px-5 py-3 text-right whitespace-nowrap">
        <span
          className={`text-xs px-2 py-1 rounded ${STAGE_TONE[stage] ?? 'bg-slate-700 text-slate-300'}`}
        >
          {STAGE_LABEL[stage] ?? (row.settled ? 'Done' : stage || '—')}
        </span>
      </td>
    </tr>
  )
}

// ── Small shared bits ─────────────────────────────────────────────────────────

function Tile({
  icon, label, value, tone, hint,
}: {
  icon?: React.ReactNode
  label: string
  value: string
  tone: string
  hint?: string
}) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <p className="text-slate-400 text-[11px] font-medium uppercase tracking-wide flex items-center gap-1.5">
        {icon && <span className="text-slate-600">{icon}</span>}
        {label}
      </p>
      <p className={`text-lg font-bold mt-1 break-words ${tone}`}>{value}</p>
      {hint && <p className="text-slate-600 text-xs mt-1">{hint}</p>}
    </div>
  )
}

function Th({
  children, align, hideOnMobile,
}: {
  children: React.ReactNode
  align?: 'right'
  hideOnMobile?: boolean
}) {
  return (
    <th
      className={`px-3 sm:px-5 py-3 text-slate-400 text-[11px] font-medium uppercase tracking-wide whitespace-nowrap ${
        align === 'right' ? 'text-right' : 'text-left'
      } ${hideOnMobile ? 'hidden sm:table-cell' : ''}`}
    >
      {children}
    </th>
  )
}

export default SellerHistoryPanel
