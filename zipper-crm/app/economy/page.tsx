'use client'

import Link from 'next/link'
import { useState, useEffect } from 'react'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import {
  previewCommission, fmtInr, fmtInrMinor, COMMISSION_RULE, PREVIEW_DISCLAIMER,
} from '@/lib/commission'
import { getEconomyConfig, type EconomyConfig, type CommissionSlab } from '@/lib/economyConfig'
import { Settings, Gem, BookOpen, TrendingUp, ChevronRight, Loader2 } from 'lucide-react'

function SlabTable({ slabs, label }: { slabs: CommissionSlab[]; label: string }) {
  // The top band is open-ended whatever its configured `to` says — above its
  // lower bound the rate applies with no cap. Showing the live table's
  // ₹50,00,000 ceiling as if it were real is how the old bug looked correct.
  const ordered = [...slabs].sort((a, b) => a.from - b.from)
  return (
    <div>
      <h4 className="text-sm font-medium text-slate-300 mb-2">{label}</h4>
      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-slate-800 text-slate-400">
              <th className="text-left px-3 py-2">Slab Range (INR)</th>
              <th className="text-right px-3 py-2">Commission Rate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {ordered.map((s, i) => (
              <tr key={i} className="text-slate-300">
                <td className="px-3 py-2">
                  {fmtInr(s.from)} – {i === ordered.length - 1 ? '∞ (no cap)' : fmtInr(s.to)}
                </td>
                <td className="text-right px-3 py-2 text-yellow-400 font-medium">{s.rate}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ExampleCalc({ billing, slabs, label }: { billing: number; slabs: CommissionSlab[]; label: string }) {
  // An illustration of the slab table, not a payable figure. The API computes
  // what an agency is actually owed, from the ledger — see lib/commission.ts.
  const preview = previewCommission(billing, slabs)
  return (
    <div className="bg-slate-950 rounded-lg p-4 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-slate-400 text-xs">
          Example: {label} agency billing{' '}
          <span className="text-white font-medium">{fmtInr(billing)}</span> for the period
        </p>
        <span className="flex-shrink-0 text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30">
          Estimate
        </span>
      </div>
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">
            {preview.band
              ? `up to ${preview.ratePercent}% — on the slice above ${fmtInr(preview.band.from)} only`
              : 'Below the floor — no band applies'}
          </span>
          <span className="text-slate-300">{preview.band ? `${preview.ratePercent}%` : '—'}</span>
        </div>
        <div className="border-t border-slate-800 pt-1 flex items-center justify-between text-sm font-semibold">
          <span className="text-slate-300">Commission</span>
          <span className="text-green-400">{fmtInrMinor(preview.commissionMinor)}</span>
        </div>
        <p className="text-slate-600 text-xs">{preview.explanation}</p>
      </div>
      <p className="text-amber-400/80 text-[11px] leading-snug border-t border-slate-800 pt-2">
        {PREVIEW_DISCLAIMER}
      </p>
    </div>
  )
}

function Section({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Icon size={18} className="text-pink-500" />
        <h2 className="text-white font-semibold text-lg">{title}</h2>
      </div>
      {children}
    </div>
  )
}

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-start gap-4 py-2 border-b border-slate-800 last:border-0">
      <span className="text-slate-400 text-sm w-56 flex-shrink-0">{label}</span>
      <div>
        <span className="text-white text-sm font-medium">{value}</span>
        {note && <span className="text-slate-500 text-xs ml-2">{note}</span>}
      </div>
    </div>
  )
}

const ECONOMY_DOC_ROLES = ['superadmin', 'finance_admin', 'finance_member', 'ops_admin'] as const

export default function EconomyDocPage() {
  const { crmUser } = useAuth()
  const [exampleEarnings, setExampleEarnings] = useState(150000)
  const [config, setConfig] = useState<EconomyConfig | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!crmUser || !canAccess(crmUser, [...ECONOMY_DOC_ROLES])) return
    getEconomyConfig()
      .then(setConfig)
      .catch(e => { console.error(e); setError('Failed to load economy config.') })
  }, [crmUser])

  if (!crmUser || !canAccess(crmUser, [...ECONOMY_DOC_ROLES])) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <p className="text-slate-400">Access denied.</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <p className="text-red-400 text-sm">{error}</p>
      </div>
    )
  }

  if (!config) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 size={24} className="animate-spin text-pink-500" />
      </div>
    )
  }

  const gr = config.giftRates
  const mainSlabs = config.commissionConfig?.mainAgencySlabs ?? []
  const subSlabs  = config.commissionConfig?.subAgencySlabs  ?? []

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Economy Documentation</h1>
          <p className="text-slate-400 text-sm mt-1">Reference guide for all rates, slabs, and calculation rules. Values are live from Firestore.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/economy/config"
            className="flex items-center gap-2 px-3 py-2 bg-slate-800 text-slate-300 rounded-lg hover:bg-slate-700 transition-colors text-sm">
            <Settings size={14} />Config
          </Link>
          <Link href="/economy/currency"
            className="flex items-center gap-2 px-3 py-2 bg-slate-800 text-slate-300 rounded-lg hover:bg-slate-700 transition-colors text-sm">
            <Gem size={14} />Add/Deduct
          </Link>
        </div>
      </div>

      {/* Gift rates */}
      <Section title="Gift Economy Rates" icon={BookOpen}>
        <Row label="Normal gift receiver earning" value={`${gr.normalReceiverPct}%`} note="of diamond cost in beans" />
        <Row label="Exclusive gift receiver earning" value={`${gr.exclusiveReceiverPctMin}%–${gr.exclusiveReceiverPctMax}%`} note="tiered by gift value" />
        <Row label="Lucky gift receiver earning" value={`${gr.luckyReceiverPct ?? 5}%`} note="receiver always earns this in beans per lucky gift sent" />
        <Row label="Lucky return range" value={`${gr.luckyReturnMin ?? 5}× – ${gr.luckyReturnMax ?? 20}×`} note="diamonds returned to sender if they win the lucky draw" />
        <Row label="Bean → INR" value={`1 bean = ₹${gr.beanToInrRate}`} note="used for host salary calculation" />
        <Row label="Weekly min payout" value={`₹${config.weeklyMinPayoutInr.toLocaleString('en-IN')}`} note="host must earn at least this to qualify" />
        <div className="mt-3 p-3 bg-slate-800/50 rounded-lg text-xs text-slate-400">
          <span className="text-slate-300 font-medium">How it works: </span>
          Host earnings are calculated based on beans earned from calls and gifts.
          At ₹{gr.beanToInrRate}/bean, a host earning 1,000 beans receives ₹{(1000 * gr.beanToInrRate).toFixed(2)}.
          Agency commission is separate and is paid on top: the agency&rsquo;s billing is charged
          slab by slab below, each slice at its own rate, so the effective rate is always lower
          than the top slab reached.
        </div>
      </Section>

      {/* Progressive commission slabs */}
      <Section title="Agency Commission Slabs" icon={TrendingUp}>
        <p className="text-slate-400 text-sm">{COMMISSION_RULE}</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <SlabTable slabs={mainSlabs} label="Main Agency" />
          <SlabTable slabs={subSlabs}  label="Sub-Agency" />
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className="text-slate-400 text-sm">Slab illustration — billing for the period:</span>
            <input
              type="number" min={0} step={10000}
              value={exampleEarnings}
              onChange={e => setExampleEarnings(parseInt(e.target.value) || 0)}
              className="w-36 bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:border-pink-500"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ExampleCalc billing={exampleEarnings} slabs={mainSlabs} label="Main" />
            <ExampleCalc billing={exampleEarnings} slabs={subSlabs}  label="Sub" />
          </div>
        </div>
      </Section>

      {/* Weekly auto-report */}
      <Section title="Weekly Auto-Report" icon={TrendingUp}>
        <Row label="Schedule" value="Every Sunday 23:59 IST" note="(18:29 UTC)" />
        <Row label="Host eligibility" value={`≥ ₹${config.weeklyMinPayoutInr.toLocaleString('en-IN')} earnings/week`} />
        <Row label="Commission calc" value="Progressive by band (above)" note="each slice at its own rate, computed by the API from the ledger" />
        <Row label="Effect on agency" value="commissionBalance += commission" note="added to outstanding balance" />
        <Row label="Email" value="Superadmin email" note="HTML report with all agency/host breakdown" />
        <Row label="Firestore" value="weeklyPayoutReports/{year}-W{week}" note="includes hostPayouts subcollection" />
        <Link href="/finance/reports"
          className="mt-2 inline-flex items-center gap-2 text-sm text-pink-400 hover:text-pink-300">
          View weekly reports <ChevronRight size={14} />
        </Link>
      </Section>

      {/* Approval workflow */}
      <Section title="Approval Workflow" icon={Settings}>
        <p className="text-slate-400 text-sm">
          All sensitive actions by non-superadmin staff are queued for review before taking effect.
        </p>
        <Row label="Who can approve" value="Superadmin only" />
        <Row label="Who submits" value="Admin, ops, finance" note="depending on action type" />
        <Row label="Actions requiring approval" value="Agency approve/reject/deactivate, seller approve/deactivate, commission rate changes, bean/diamond credits, config updates" />
        <Row label="Applied by" value="Cloud Function onApprovalApproved" note="runs via Admin SDK, bypasses Firestore rules" />
        <Link href="/approvals"
          className="mt-2 inline-flex items-center gap-2 text-sm text-pink-400 hover:text-pink-300">
          View approval queue <ChevronRight size={14} />
        </Link>
      </Section>
    </div>
  )
}
