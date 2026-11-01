'use client'

/**
 * Every movement on the commission balance — spec 0.2.3.
 *
 * A credit with the host and period that produced it, a payment with its date
 * and its bank reference. Both are already on the movement: the accrual carries
 * the whole derivation in `meta.commission_breakdown`
 * (backend/app/services/partner_ops.py:2499) and the payout carries
 * `meta.payment_ref`. So a row can explain itself without another round trip,
 * and this section opens that up rather than leaving it on the wire.
 */

import { useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, ChevronDown, Receipt } from 'lucide-react'
import { Empty } from '@/components/ui/States'
import { inrExact, whenExact, type LedgerEntry } from '@/lib/apiPartners'
import { CurrencyNote, Section, Th } from './MoneyUI'
import { periodDates, type Period } from './MoneyUI'

// ── Reading an untyped movement ───────────────────────────────────────────────
// The statement hands back raw ledger documents. These keep every `unknown`
// narrowing in one place instead of scattering casts through the markup.

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function text(source: Record<string, unknown>, key: string): string {
  const v = source[key]
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  return ''
}

function number(source: Record<string, unknown>, key: string): number {
  const v = source[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function flag(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true
}

const ACTION_LABEL: Record<string, string> = {
  'commission.accrue': 'Commission earned',
  'commission.pay': 'Commission paid to you',
}

function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action.replace(/[._]/g, ' ') ?? 'Movement'
}

export function CommissionLedger({
  entries,
  truncated,
  limit,
  period,
  loading,
}: {
  entries: LedgerEntry[]
  /** The read came back full, so older movements exist and are not shown. */
  truncated: boolean
  limit: number
  period: Period
  loading: boolean
}) {
  if (loading) {
    return (
      <Section title="Your commission ledger" icon={<Receipt size={15} />}>
        <div className="p-5 space-y-2.5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-9 bg-slate-800/60 rounded animate-pulse" />
          ))}
        </div>
      </Section>
    )
  }

  return (
    <Section
      title="Your commission ledger"
      icon={<Receipt size={15} />}
      subtitle={
        `Every movement in this period — ${periodDates(period)}. ` +
        'Read from the same ledger Zipper settles against, so what you see here ' +
        'and what Zipper sees cannot differ.'
      }
    >
      {truncated && (
        <div className="mx-4 sm:mx-5 mt-4 bg-amber-500/10 border border-amber-500/40 rounded-lg px-3.5 py-3">
          <p className="text-amber-100 text-xs font-semibold">
            This is the most recent {limit} movements, not all of them.
          </p>
          <p className="text-amber-100/80 text-xs mt-1 leading-relaxed">
            Older movements exist and are not listed, so the Earned and Paid
            totals above cover only what is shown here. Narrow the period to be
            certain of them.
          </p>
        </div>
      )}

      {entries.length === 0 ? (
        <Empty
          title="No commission movements in this period"
          hint="Accruals and payments appear here as they happen. Nothing landing in a period is a real answer — widen the period to look further back."
          icon={<Receipt size={26} />}
        />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-800">
                  <Th>What it was for</Th>
                  <Th hideOnMobile>When</Th>
                  <Th align="right">Amount</Th>
                  <Th align="right" hideOnMobile>
                    Balance after
                  </Th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, i) => (
                  <LedgerRow key={text(entry, 'id') || `row-${i}`} entry={entry} />
                ))}
              </tbody>
            </table>
          </div>
          <CurrencyNote>
            All amounts are Indian Rupees (INR); the API holds them in paise and
            this page divides by 100 once. A credit is commission you earned; a
            debit is a payment made to you.
            {period.mode === 'window' && (
              <>
                {' '}
                One caveat worth knowing: the server reads the newest {limit}{' '}
                movements and only then narrows them to your period, so a period
                that ends well in the past can be short of rows once you have
                more than {limit} movements in total — and the Earned and Paid
                figures with it. Nothing here is ever wrong about a movement it
                does show. If a total does not match your own, ask Zipper for the
                full statement for that period rather than assuming either figure.
              </>
            )}
          </CurrencyNote>
        </>
      )}
    </Section>
  )
}

function LedgerRow({ entry }: { entry: LedgerEntry }) {
  const [open, setOpen] = useState(false)

  const amount = number(entry, 'amount')
  const credit = amount >= 0
  const action = text(entry, 'action')
  const meta = obj(entry.meta)
  const derivation = obj(meta.commission_breakdown)
  const explainable = Object.keys(derivation).length > 0
  const paymentRef = text(meta, 'payment_ref')
  const metaPeriod = text(meta, 'period')
  const hostId = text(meta, 'host_id')

  return (
    <>
      <tr className="border-b border-slate-800/60 last:border-0">
        <td className="px-4 sm:px-5 py-3 align-top">
          <p className="text-slate-200 text-sm font-medium">{actionLabel(action)}</p>
          <p className="text-slate-500 text-xs mt-0.5 break-words max-w-md">
            {text(entry, 'reason') || 'No reason was recorded against this movement.'}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
            {metaPeriod && (
              <span className="text-slate-600 text-[11px]">period {metaPeriod}</span>
            )}
            {hostId && (
              <span className="text-slate-600 text-[11px] font-mono truncate max-w-[9rem]">
                Host ID: {hostId}
              </span>
            )}
            {paymentRef && (
              <span className="text-slate-400 text-[11px] font-mono">
                ref {paymentRef}
              </span>
            )}
            <span className="text-slate-600 text-[11px] sm:hidden">
              {whenExact(text(entry, 'at'))}
            </span>
          </div>
          {explainable && (
            <button
              onClick={() => setOpen((o) => !o)}
              className="flex items-center gap-1 text-pink-400 hover:text-pink-300 text-[11px] mt-1.5 transition-colors"
            >
              <ChevronDown
                size={11}
                className={`transition-transform ${open ? 'rotate-180' : ''}`}
              />
              {open ? 'Hide how this line was worked out' : 'How was this worked out?'}
            </button>
          )}
        </td>
        <td className="px-4 sm:px-5 py-3 text-slate-500 text-xs whitespace-nowrap hidden sm:table-cell align-top">
          {whenExact(text(entry, 'at'))}
        </td>
        <td
          className={`px-4 sm:px-5 py-3 text-sm font-semibold text-right whitespace-nowrap align-top ${
            credit ? 'text-green-300' : 'text-amber-300'
          }`}
        >
          <span className="inline-flex items-center gap-1">
            {credit ? <ArrowDownLeft size={12} /> : <ArrowUpRight size={12} />}
            {credit ? '+' : '−'}
            {inrExact(Math.abs(amount))}
          </span>
        </td>
        <td className="px-4 sm:px-5 py-3 text-slate-400 text-sm text-right whitespace-nowrap hidden sm:table-cell align-top">
          {typeof entry.balance_after === 'number'
            ? inrExact(entry.balance_after)
            : '—'}
        </td>
      </tr>

      {open && explainable && (
        <tr className="border-b border-slate-800/60">
          <td colSpan={4} className="px-4 sm:px-5 pb-4 pt-0">
            <RowDerivation derivation={derivation} />
          </td>
        </tr>
      )}
    </>
  )
}

/**
 * The derivation that travelled with this exact movement — not a recomputation.
 * If the slab table changed afterwards, this still shows the rule that was
 * applied when the money was credited. Spec 0.1.3: no retroactive changes.
 */
function RowDerivation({ derivation }: { derivation: Record<string, unknown> }) {
  const band = obj(derivation.band)
  const provisional = flag(derivation, 'provisional')

  return (
    <div className="bg-slate-950/70 border border-slate-800 rounded-lg p-3.5 space-y-3">
      <p className="text-slate-200 text-sm leading-relaxed">
        {text(derivation, 'explanation') ||
          'No explanation was recorded on this movement.'}
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <Cell label="Period" value={text(derivation, 'period') || '—'} />
        <Cell
          label="Agency billing"
          value={inrExact(number(derivation, 'agency_billing_minor'))}
        />
        <Cell
          label="Band rate (top band)"
          value={
            text(derivation, 'rate_percent')
              ? `${text(derivation, 'rate_percent')}%`
              : '—'
          }
        />
        {/* Audit C-10 / M-25: the rule is progressive, so the band rate applies
            to the last slice only. The effective rate — commission ÷ billing —
            is what was actually earned over the whole figure; it is read from
            the derivation when recorded and computed from its two paise
            figures otherwise. */}
        <Cell
          label="Effective rate"
          value={(() => {
            const sent = text(derivation, 'effective_rate_percent')
            if (sent) return `${sent}%`
            const billing = number(derivation, 'agency_billing_minor')
            const commission = number(derivation, 'agency_commission_minor')
            return billing > 0 ? `${((commission / billing) * 100).toFixed(2)}%` : '—'
          })()}
        />
        <Cell
          label="Floor"
          value={inrExact(number(derivation, 'floor_minor'))}
        />
        <Cell
          label="Agency commission"
          value={inrExact(number(derivation, 'agency_commission_minor'))}
        />
        <Cell
          label="This host cashed out"
          value={`🫘 ${number(derivation, 'host_beans_cashed_out').toLocaleString('en-IN')}`}
        />
        <Cell
          label="This host's share"
          value={inrExact(number(derivation, 'host_share_minor'))}
        />
        <Cell
          label="Rates read from"
          value={text(derivation, 'slab_source') || '—'}
          tone={provisional ? 'text-amber-300' : 'text-slate-200'}
        />
      </div>

      {text(band, 'label') && (
        <p className="text-slate-400 text-xs font-mono">{text(band, 'label')}</p>
      )}

      {text(derivation, 'host_share_note') && (
        <p className="text-slate-500 text-xs leading-relaxed">
          {text(derivation, 'host_share_note')}
        </p>
      )}

      {provisional && (
        <p className="text-amber-300/90 text-xs leading-relaxed">
          This line was computed from a provisional slab table rather than the
          live one. Raise it with Zipper before treating it as settled.
        </p>
      )}

      <div className="space-y-1.5 pt-1 border-t border-slate-800">
        {text(derivation, 'rule') && (
          <p className="text-slate-500 text-xs leading-relaxed">
            <span className="text-slate-400 font-medium">Rule: </span>
            {text(derivation, 'rule')}
          </p>
        )}
        {text(derivation, 'rounding') && (
          <p className="text-slate-500 text-xs leading-relaxed">
            <span className="text-slate-400 font-medium">Rounding: </span>
            {text(derivation, 'rounding')}
          </p>
        )}
        {text(derivation, 'billing_definition') && (
          <p className="text-slate-500 text-xs leading-relaxed">
            <span className="text-slate-400 font-medium">Billing: </span>
            {text(derivation, 'billing_definition')}
          </p>
        )}
      </div>
    </div>
  )
}

function Cell({
  label,
  value,
  tone = 'text-slate-200',
}: {
  label: string
  value: string
  tone?: string
}) {
  return (
    <div>
      <p className="text-slate-600 text-[10px] font-medium uppercase tracking-wide">
        {label}
      </p>
      <p className={`text-xs font-medium mt-0.5 break-words ${tone}`}>{value}</p>
    </div>
  )
}
