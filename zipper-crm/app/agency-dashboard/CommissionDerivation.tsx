'use client'

/**
 * Where the commission figure came from.
 *
 * Spec 0.1.5 — every number is explainable — and 0.2.1, the slab table
 * published in full. This section is where that promise is kept or broken, so
 * it shows the whole chain: what the hosts cashed out, the rate that converted
 * beans to rupees, the band that billing selected, the arithmetic, and each
 * host's share of the result.
 *
 * Nothing here is recomputed in the browser. The commission engine
 * (backend/app/services/commission.py) writes every sentence and every bound,
 * and this file lays them out. That is deliberate: a browser that does its own
 * slab arithmetic can disagree with what is actually paid, and the CRM has
 * already been down that road once — see the module docstring on the engine.
 */

import { AlertTriangle, Calculator, CheckCircle2, Layers, TrendingDown, Users } from 'lucide-react'
import {
  inrExact,
  when,
  type CommissionBasis,
  type CommissionBand,
} from '@/lib/apiPartners'
import { CurrencyNote, FromTheServer, Section, Th } from './MoneyUI'
import { effectiveRatePercent } from '@/lib/commission'
import type { Period } from './MoneyUI'
import type { RosterHost } from './HostEarnings'
import { ID_LABEL } from '@/lib/identity'

export function CommissionDerivation({
  basis,
  basisError,
  rule,
  period,
  loading,
  roster = [],
}: {
  basis: CommissionBasis | null
  /** The server's own sentence for why the derivation could not be run. */
  basisError: string | null
  /** `commission_rule` from the statement — the rule in plain English. */
  rule: string
  period: Period
  loading: boolean
  /** B1: the agency's own roster (already loaded by AgencyMoney) — names for the host ids. */
  roster?: ReadonlyArray<RosterHost>
}) {
  const rosterName = (uid: string) => (roster.find((r) => r.uid === uid)?.name ?? '').trim()
  if (loading) {
    return (
      <Section
        title="How your commission is worked out"
        icon={<Calculator size={15} />}
      >
        <div className="p-5 space-y-3">
          <div className="h-4 w-2/3 bg-slate-800 rounded animate-pulse" />
          <div className="h-4 w-1/2 bg-slate-800 rounded animate-pulse" />
          <div className="h-4 w-3/4 bg-slate-800 rounded animate-pulse" />
        </div>
      </Section>
    )
  }

  // The derivation refused, and said why. This is NOT a zero and must never be
  // drawn as one — `commission_basis_error` exists exactly so this page can
  // print the reason instead of an invented figure.
  if (!basis) {
    return (
      <Section
        title="How your commission is worked out"
        icon={<Calculator size={15} />}
      >
        <div className="p-4 sm:p-5">
          <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/40 rounded-xl px-4 py-3.5">
            <AlertTriangle size={16} className="text-amber-400 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-amber-100 text-sm font-semibold">
                Your commission for this period could not be worked out.
              </p>
              <p className="text-amber-100/80 text-sm mt-1 leading-relaxed break-words">
                {basisError ||
                  'The server returned no derivation and no reason for it. Ask Zipper to check the commission configuration before treating any figure on this page as final.'}
              </p>
              <p className="text-slate-500 text-xs mt-2 leading-relaxed">
                No figure was produced, so none is shown. This is not a
                commission of zero — a zero is what you see when a real billing
                total falls below the floor, and that is a different sentence.
                Your ledger below is unaffected: it records what actually moved.
              </p>
            </div>
          </div>
          {rule && (
            <div className="mt-4">
              <FromTheServer label="The rule, whatever this period turns out to be">
                {rule}
              </FromTheServer>
            </div>
          )}
        </div>
      </Section>
    )
  }

  const { billing, breakdown, slab_table: table } = basis
  const belowFloor = !breakdown.matched
  const shortfallMinor = breakdown.floor_minor - breakdown.billing_minor
  const headroomMinor = breakdown.billing_minor - breakdown.floor_minor
  const isSub = basis.agency_kind === 'sub'

  // With no window sent, the server does not band a lifetime total — it derives
  // the current ISO week and names it. Saying so is the difference between a
  // heading that is true and one that is not.
  const derivationCoversADifferentPeriod = period.mode === 'lifetime'

  return (
    <Section
      title="How your commission is worked out"
      icon={<Calculator size={15} />}
      subtitle={
        `Period ${basis.period} · ${when(basis.since)} → ${when(basis.until)} · ` +
        `${billing.bounds}`
      }
    >
      <div className="p-4 sm:p-5 space-y-4">
        {derivationCoversADifferentPeriod && (
          <div className="flex items-start gap-2.5 bg-slate-800/60 border border-slate-700 rounded-lg px-3.5 py-3">
            <AlertTriangle size={14} className="text-slate-400 mt-0.5 shrink-0" />
            <p className="text-slate-300 text-xs leading-relaxed">
              The totals above cover everything on record. &ldquo;Everything&rdquo;
              is not a commission period, so this derivation covers{' '}
              <span className="text-white font-medium">{basis.period}</span> —
              the current week — instead. Banding a lifetime total would pick a
              top band no single week ever earned. Choose a period above to see
              that period&rsquo;s derivation.
            </p>
          </div>
        )}

        {table.provisional && (
          <div className="flex items-start gap-2.5 bg-amber-500/10 border border-amber-500/40 rounded-lg px-3.5 py-3">
            <AlertTriangle size={14} className="text-amber-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-amber-100 text-xs font-semibold">
                These rates are provisional, not the live table.
              </p>
              <p className="text-amber-100/80 text-xs mt-1 leading-relaxed">
                {table.note}
              </p>
            </div>
          </div>
        )}

        {/* ── Step 1: what your hosts cashed out ──────────────────────────── */}
        <Step n={1} title="What your hosts cashed out in this period">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Figure
              label="Beans cashed out"
              value={`🫘 ${billing.beans_cashed_out.toLocaleString('en-IN')}`}
            />
            <Figure
              label="Rate applied"
              value={`₹${billing.bean_to_inr} per bean`}
              tone={billing.bean_rate_provisional ? 'text-amber-300' : 'text-slate-200'}
            />
            <Figure
              label="Your billing (INR)"
              value={inrExact(billing.billing_minor)}
              tone="text-white"
            />
          </div>
          <p className="text-slate-500 text-xs mt-2">{billing.bean_rate_note}</p>
          <div className="mt-3">
            <FromTheServer label="What counts as billing">
              {billing.definition}
            </FromTheServer>
          </div>
          {billing.beans_earned_not_cashed_out > 0 && (
            <p className="text-slate-400 text-xs mt-3 leading-relaxed">
              Your hosts also hold{' '}
              <span className="text-white font-medium">
                🫘 {billing.beans_earned_not_cashed_out.toLocaleString('en-IN')}
              </span>{' '}
              earned in this period but not yet cashed out. Those are not
              billing yet — they bill in the period they are actually paid out.
            </p>
          )}
        </Step>

        {/* ── Step 2: the floor ───────────────────────────────────────────── */}
        <Step n={2} title={`The floor — ${inrExact(breakdown.floor_minor)} of billing`}>
          {belowFloor ? (
            <div className="bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-4">
              <p className="flex items-start gap-2 text-red-200 text-sm font-semibold">
                <TrendingDown size={15} className="mt-0.5 shrink-0" />
                You earned no commission for this period, and this is why.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
                <Figure
                  label="Your billing"
                  value={inrExact(breakdown.billing_minor)}
                  tone="text-red-200"
                />
                <Figure
                  label={`The floor (${isSub ? 'sub-agency' : 'main agency'} table)`}
                  value={inrExact(breakdown.floor_minor)}
                  tone="text-slate-200"
                />
                <Figure
                  label="You are short by"
                  value={inrExact(shortfallMinor)}
                  tone="text-red-300"
                />
              </div>
              <p className="text-red-100/85 text-sm mt-3 leading-relaxed">
                Bill {inrExact(shortfallMinor)} more in a period — that is{' '}
                {billing.bean_to_inr > 0
                  ? `about 🫘 ${Math.ceil(
                      shortfallMinor / 100 / billing.bean_to_inr,
                    ).toLocaleString('en-IN')} more beans cashed out`
                  : 'more beans cashed out'}{' '}
                — and you reach the first band.
              </p>
              <p className="text-red-100/70 text-xs mt-2 leading-relaxed">
                {breakdown.explanation}
              </p>
            </div>
          ) : (
            <div className="bg-green-500/10 border border-green-500/30 rounded-xl px-4 py-3.5">
              <p className="flex items-start gap-2 text-green-200 text-sm font-medium">
                <CheckCircle2 size={15} className="mt-0.5 shrink-0" />
                You are above the {inrExact(breakdown.floor_minor)} floor by{' '}
                {inrExact(headroomMinor)}, so this period earns commission.
              </p>
              <p className="text-green-100/70 text-xs mt-1.5 leading-relaxed">
                Below the floor an agency earns nothing for the period. Your
                hosts are always paid their own payout in full either way — the
                floor applies to agency commission and to nothing else.
              </p>
            </div>
          )}
        </Step>

        {/* ── Step 3: the band, and the arithmetic ────────────────────────── */}
        <Step n={3} title="The band your billing reaches, and what it actually earned">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <Figure
              label="Band"
              value={breakdown.band ? `Band ${breakdown.band.index + 1}` : 'No band — below the floor'}
            />
            <Figure
              label="Rate (top band)"
              value={`${breakdown.rate_percent}%`}
              tone={breakdown.matched ? 'text-white' : 'text-slate-500'}
            />
            {/* Audit C-10 / M-25: the rule is progressive, so the band rate
                applies to the LAST slice only. This is the rate over the whole
                figure — what the agency is actually paid — and it is always at
                or below the band rate. */}
            <Figure
              label="Effective rate"
              value={effectiveRatePercent(breakdown) ? `${effectiveRatePercent(breakdown)}%` : '—'}
              tone={breakdown.matched ? 'text-green-300' : 'text-slate-500'}
            />
            <Figure
              label="Commission for the period"
              value={inrExact(breakdown.commission_minor)}
              tone={breakdown.commission_minor > 0 ? 'text-green-300' : 'text-slate-500'}
            />
          </div>
          <p className="text-slate-500 text-xs mt-2">
            Each slice of billing is charged at its own band&rsquo;s rate (progressive, like income tax);
            no single rate applies to the whole amount. The effective rate is commission ÷ billing.
          </p>
          {breakdown.band && (
            <p className="text-slate-400 text-xs mt-2 font-mono">
              {breakdown.band.label}
            </p>
          )}
          <div className="mt-3 space-y-2.5">
            <FromTheServer label="This period, in one sentence">
              {breakdown.explanation}
            </FromTheServer>
            <FromTheServer label="The rule">{rule || breakdown.rule}</FromTheServer>
            <FromTheServer label="Rounding">{breakdown.rounding}</FromTheServer>
          </div>
        </Step>

        {basis.warnings.length > 0 && (
          <div className="space-y-2">
            {basis.warnings.map((w, i) => (
              <div
                key={i}
                className="flex items-start gap-2.5 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3.5 py-3"
              >
                <AlertTriangle size={13} className="text-amber-400 mt-0.5 shrink-0" />
                <p className="text-amber-100/90 text-xs leading-relaxed">{w}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── The published table ───────────────────────────────────────────── */}
      <SlabTable
        bands={table.bands}
        matchedIndex={breakdown.band?.index ?? null}
        billingMinor={breakdown.billing_minor}
        kindLabel={isSub ? 'sub-agency' : 'main agency'}
        note={table.note}
      />

      {/* ── Per-host shares ───────────────────────────────────────────────── */}
      <HostShares basis={basis} rosterName={rosterName} />
    </Section>
  )
}

// ── Pieces ────────────────────────────────────────────────────────────────────

function Step({
  n,
  title,
  children,
}: {
  n: number
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="border border-slate-800 rounded-xl p-3.5 sm:p-4">
      <p className="flex items-center gap-2 text-slate-300 text-sm font-semibold mb-3">
        <span className="w-5 h-5 rounded-full bg-slate-800 text-slate-400 text-[11px] flex items-center justify-center shrink-0">
          {n}
        </span>
        <span className="min-w-0">{title}</span>
      </p>
      {children}
    </div>
  )
}

function Figure({
  label,
  value,
  tone = 'text-slate-200',
}: {
  label: string
  value: string
  tone?: string
}) {
  return (
    <div className="bg-slate-800/50 rounded-lg px-3 py-2.5">
      <p className="text-slate-500 text-[10px] font-medium uppercase tracking-wide">
        {label}
      </p>
      <p className={`text-sm font-semibold mt-0.5 break-words ${tone}`}>{value}</p>
    </div>
  )
}

/**
 * The whole table, not just the band that matched. Spec 0.2.1 — no private
 * rates, and an agency should be able to see what the next band pays.
 */
function SlabTable({
  bands,
  matchedIndex,
  billingMinor,
  kindLabel,
  note,
}: {
  bands: CommissionBand[]
  matchedIndex: number | null
  billingMinor: number
  kindLabel: string
  note: string
}) {
  const next = bands.find((b) => b.from_minor > billingMinor) ?? null

  return (
    <div className="border-t border-slate-800">
      <div className="px-4 sm:px-5 py-3.5">
        <h3 className="flex items-center gap-2 text-white text-sm font-semibold">
          <Layers size={14} className="text-slate-500" />
          Your slab table ({kindLabel})
        </h3>
        <p className="text-slate-500 text-xs mt-1 leading-relaxed">
          Published in full. Each slice of your billing is charged at its own
          band&rsquo;s rate — progressive, like income tax. No single rate is applied
          to the whole amount.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-y border-slate-800">
              <Th>Band</Th>
              <Th>Billing from</Th>
              <Th hideOnMobile>Billing to</Th>
              <Th align="right">Rate</Th>
            </tr>
          </thead>
          <tbody>
            {bands.map((b) => {
              const matched = b.index === matchedIndex
              const isNext = !matched && next?.index === b.index
              return (
                <tr
                  key={b.index}
                  className={`border-b border-slate-800/60 last:border-0 ${
                    matched ? 'bg-pink-500/10' : ''
                  }`}
                >
                  <td className="px-4 sm:px-5 py-2.5 text-sm whitespace-nowrap">
                    <span className={matched ? 'text-pink-300 font-semibold' : 'text-slate-400'}>
                      Band {b.index + 1}
                    </span>
                    {matched && (
                      <span className="ml-2 text-[10px] bg-pink-500/20 text-pink-200 px-1.5 py-0.5 rounded">
                        yours
                      </span>
                    )}
                    {isNext && (
                      <span className="ml-2 text-[10px] bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded">
                        next
                      </span>
                    )}
                  </td>
                  <td className="px-4 sm:px-5 py-2.5 text-sm text-slate-300 whitespace-nowrap">
                    {inrExact(b.from_minor)}
                  </td>
                  <td className="px-4 sm:px-5 py-2.5 text-sm text-slate-300 whitespace-nowrap hidden sm:table-cell">
                    {b.to_minor === null ? 'no upper limit' : inrExact(b.to_minor)}
                  </td>
                  <td
                    className={`px-4 sm:px-5 py-2.5 text-sm font-semibold text-right whitespace-nowrap ${
                      matched ? 'text-pink-200' : 'text-slate-300'
                    }`}
                  >
                    {b.rate_percent}%
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {next && (
        <p className="px-4 sm:px-5 pt-3 text-slate-400 text-xs leading-relaxed">
          The next band starts at {inrExact(next.from_minor)} of billing and pays{' '}
          {next.rate_percent}% — {inrExact(next.from_minor - billingMinor)} more
          billing than this period produced.
        </p>
      )}
      <CurrencyNote>
        Bounds are Indian Rupees (INR) of billing in one period. {note}
      </CurrencyNote>
    </div>
  )
}

/**
 * Each host's share.
 *
 * Not a per-host commission calculation — the band was chosen by the agency's
 * total, and this splits that one figure by the beans each host cashed out. The
 * server says as much on every row and this shows it rather than paraphrasing.
 */
function HostShares({ basis, rosterName }: { basis: CommissionBasis; rosterName: (uid: string) => string }) {
  if (basis.hosts.length === 0) {
    return (
      <div className="border-t border-slate-800 px-4 sm:px-5 py-4">
        <h3 className="flex items-center gap-2 text-white text-sm font-semibold">
          <Users size={14} className="text-slate-500" /> Which hosts produced it
        </h3>
        <p className="text-slate-500 text-xs mt-1.5 leading-relaxed">
          No host of yours cashed out in this period, so there is no billing to
          split and no shares to show. This is an emptiness, not a failure — the
          derivation ran and found nothing in the window.
        </p>
      </div>
    )
  }

  return (
    <div className="border-t border-slate-800">
      <div className="px-4 sm:px-5 py-3.5">
        <h3 className="flex items-center gap-2 text-white text-sm font-semibold">
          <Users size={14} className="text-slate-500" /> Which hosts produced it
        </h3>
        <p className="text-slate-500 text-xs mt-1 leading-relaxed">
          Your one commission figure, split by what each host cashed out.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-y border-slate-800">
              <Th>Host</Th>
              <Th align="right">Beans cashed out</Th>
              <Th align="right" hideOnMobile>
                Their billing
              </Th>
              <Th align="right">Their share</Th>
            </tr>
          </thead>
          <tbody>
            {basis.hosts.map((h) => (
              <tr key={h.host_id} className="border-b border-slate-800/60 last:border-0">
                <td className="px-4 sm:px-5 py-3">
                  {rosterName(h.host_id) && (
                    <p className="text-slate-200 text-sm truncate max-w-[10rem] sm:max-w-none">{rosterName(h.host_id)}</p>
                  )}
                  <p className={`${rosterName(h.host_id) ? 'text-slate-600 text-[11px]' : 'text-slate-200 text-sm'} font-mono truncate max-w-[10rem] sm:max-w-none`}>
                    {ID_LABEL.host}: {h.host_id}
                  </p>
                  <p className="text-slate-600 text-[11px] mt-0.5 leading-snug">
                    {h.share_note}
                  </p>
                </td>
                <td className="px-4 sm:px-5 py-3 text-right text-slate-300 text-sm whitespace-nowrap align-top">
                  🫘 {h.beans_cashed_out.toLocaleString('en-IN')}
                </td>
                <td className="px-4 sm:px-5 py-3 text-right text-slate-400 text-sm whitespace-nowrap hidden sm:table-cell align-top">
                  {inrExact(h.billing_minor)}
                </td>
                <td className="px-4 sm:px-5 py-3 text-right text-white text-sm font-semibold whitespace-nowrap align-top">
                  {inrExact(h.share_minor)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <CurrencyNote>
        Shares are Indian Rupees (INR) and add up to {inrExact(basis.commission_minor)}{' '}
        exactly — the leftover paise go to the largest remainders, so nothing is
        lost in the split.
      </CurrencyNote>
    </div>
  )
}
