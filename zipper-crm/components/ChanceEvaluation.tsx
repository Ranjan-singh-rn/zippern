'use client'

/**
 * How a configuration is *shown* — never how it is worked out.
 *
 * Every figure rendered here came from `chance.evaluate_draft`
 * (`backend/app/services/chance.py:984`), reached either through
 * `POST /api/chance/configs/preview` (`backend/app/routers/chance.py:418`) for a
 * draft, or off the stored `evaluation` of a signed version. There is no
 * arithmetic in this file. RTP, house edge, per-tier effective RTP, the reserve
 * guidance and the sigma are all *strings the server rendered*, and where a
 * percentage is only available as ppm the conversion goes through
 * `ppmPercent`, which formats and nothing else.
 *
 * That is 8B.2.4 as a constraint on code rather than a note in a comment: a
 * margin the browser calculated is a margin that can disagree with the one the
 * server will enforce, and the disagreement would show up as money.
 */

import type { ReactNode } from 'react'
import { AlertTriangle, Ban, Info } from 'lucide-react'
import {
  count, diamonds, ppmPercent,
  type DraftEvaluation, type EvaluatedOutcome, type ResolvedExposure, type TierRow,
} from '@/lib/apiChance'

/** The five headline figures, all of them the server's own strings. */
export function EvaluationHeadline({ evaluation }: { evaluation: DraftEvaluation }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
      <Figure
        label="RTP"
        value={`${evaluation.rtp_percent}%`}
        tone="strong"
        hint={
          evaluation.rtp_exact
            ? 'Computed by the server from the table. Exact.'
            : `Computed by the server from the table. ${evaluation.rtp_numerator} / ${count(evaluation.rtp_scale)}, not exact at this scale.`
        }
      />
      <Figure
        label="House edge"
        value={`${evaluation.house_edge_percent}%`}
        hint="What the business keeps over a long run of rounds. This is the margin."
      />
      <Figure
        label="Band"
        value={`${evaluation.rtp_band.min_percent}–${evaluation.rtp_band.max_percent}%`}
        hint="Every quantity tier must return inside this. 8B.3.4."
      />
      <Figure
        label="Any return"
        value={`${evaluation.win_probability_percent}%`}
        hint="Rolls that give back something, at any multiplier."
      />
      <Figure
        label="Nothing back"
        value={`${evaluation.nothing_back_probability_percent}%`}
        hint="Rolls that return zero. Above 50% is the burnout profile of 8B.11.4."
      />
    </div>
  )
}

function Figure({
  label, value, hint, tone = 'plain',
}: {
  label: string
  value: string
  hint: string
  tone?: 'plain' | 'strong'
}) {
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-xl px-3.5 py-3">
      <p className="text-slate-500 text-[11px] uppercase tracking-wide">{label}</p>
      <p
        className={`font-bold tabular-nums mt-0.5 ${
          tone === 'strong' ? 'text-pink-300 text-2xl' : 'text-white text-xl'
        }`}
      >
        {value}
      </p>
      <p className="text-slate-600 text-[11px] mt-1 leading-snug">{hint}</p>
    </div>
  )
}

/** The table as the server sorted and labelled it. Read-only. */
export function OutcomeTableView({ outcomes }: { outcomes: EvaluatedOutcome[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm min-w-[520px]">
        <thead>
          <tr className="text-slate-500 text-[11px] uppercase tracking-wide border-b border-slate-800">
            <th className="text-left font-medium py-2 pr-3">Multiplier</th>
            <th className="text-right font-medium py-2 px-3">bp</th>
            <th className="text-right font-medium py-2 px-3">Probability</th>
            <th className="text-right font-medium py-2 px-3">ppm</th>
            <th className="text-right font-medium py-2 pl-3">Contribution to RTP</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/60">
          {outcomes.map((o) => (
            <tr key={o.index}>
              <td className="py-2 pr-3 text-slate-200">{o.multiplier}×</td>
              <td className="py-2 px-3 text-right text-slate-500 tabular-nums">
                {count(o.multiplier_bp)}
              </td>
              <td className="py-2 px-3 text-right text-slate-200 tabular-nums">
                {o.probability_percent}%
              </td>
              <td className="py-2 px-3 text-right text-slate-500 tabular-nums">
                {count(o.probability_ppm)}
              </td>
              <td className="py-2 pl-3 text-right text-slate-300 tabular-nums">
                {ppmPercent(o.contribution_ppm)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Effective RTP per quantity tier — spec 8B.3.2.
 *
 * A tier outside the band is not decoration: it is what `evaluate_draft` blocks
 * the proposal on, so the row is coloured as the refusal it will become.
 */
export function TierTable({ tiers, basis }: { tiers: TierRow[]; basis: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm min-w-[640px]">
        <thead>
          <tr className="text-slate-500 text-[11px] uppercase tracking-wide border-b border-slate-800">
            <th className="text-left font-medium py-2 pr-3">Quantity</th>
            <th className="text-right font-medium py-2 px-3">Effective RTP</th>
            <th className="text-right font-medium py-2 px-3">House edge</th>
            <th className="text-right font-medium py-2 px-3">Total stake range</th>
            <th className="text-left font-medium py-2 pl-3">In band</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/60">
          {tiers.map((t) => (
            <tr key={t.quantity} className={t.in_band ? '' : 'bg-red-500/5'}>
              <td className="py-2 pr-3 text-slate-200 tabular-nums">×{count(t.quantity)}</td>
              <td
                className={`py-2 px-3 text-right font-medium tabular-nums ${
                  t.in_band ? 'text-slate-100' : 'text-red-300'
                }`}
              >
                {t.effective_rtp_percent}%
              </td>
              <td className="py-2 px-3 text-right text-slate-300 tabular-nums">
                {t.house_edge_percent}%
              </td>
              <td className="py-2 px-3 text-right text-slate-400 tabular-nums">
                {diamonds(t.min_total_stake)} – {diamonds(t.max_total_stake)}
                <span className="text-slate-600 text-xs ml-1">diamonds</span>
              </td>
              <td className="py-2 pl-3">
                {t.in_band ? (
                  <span className="text-emerald-400/80 text-xs">yes</span>
                ) : (
                  <span className="text-red-300 text-xs">{t.flags.join('; ')}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-slate-500 text-xs mt-2.5 leading-relaxed">
        The multiplier is applied to the{' '}
        <span className="text-slate-300">{basis.replace('_', ' ')}</span>. On the
        unit stake, effective RTP falls as quantity rises, and 8B.3.1 permits that
        only where it is deliberate and stated. Every figure in this table was
        computed by the server from the outcome table above.
      </p>
    </div>
  )
}

/** The reserve, its stated basis, the ceilings, and what a bad run costs. */
export function ExposureView({ exposure }: { exposure: ResolvedExposure }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Cell
          label="Reserve"
          value={diamonds(exposure.reserve_diamonds)}
          unit={exposure.reserve_diamonds === null ? '' : 'diamonds'}
          hint={
            exposure.reserve_diamonds === null
              ? 'None set. Nothing is enforced by a reserve.'
              : 'What the business has agreed it can lose on this mechanic.'
          }
        />
        <Cell
          label="Per round"
          value={diamonds(exposure.max_payout_per_round)}
          unit="diamonds"
          hint={
            exposure.max_payout_per_round_source === 'max_single_win'
              ? 'Not configured — defaulted to the maximum single win, which always applies.'
              : 'Configured. It can only ever tighten the maximum single win.'
          }
        />
        <Cell
          label="Per player, per day"
          value={diamonds(exposure.max_payout_per_player_per_day)}
          unit={exposure.max_payout_per_player_per_day === null ? '' : 'diamonds'}
          hint={
            exposure.max_payout_per_player_per_day === null
              ? 'No ceiling of this kind. Not zero — absent.'
              : 'A payout crossing this is paid down to the headroom and the rest withheld.'
          }
        />
        <Cell
          label="Platform, per day"
          value={diamonds(exposure.max_payout_platform_per_day)}
          unit={exposure.max_payout_platform_per_day === null ? '' : 'diamonds'}
          hint={
            exposure.max_payout_platform_per_day === null
              ? 'No ceiling of this kind. Not zero — absent.'
              : 'Crossing it auto-suspends the mechanic (8B.4.5).'
          }
        />
      </div>

      <div>
        <p className="text-slate-500 text-[11px] uppercase tracking-wide">Reserve basis</p>
        <p className="text-slate-300 text-sm mt-1 leading-relaxed">
          {exposure.reserve_basis || (
            <span className="text-amber-300">
              Not stated. 8B.4.3 asks for a reserve that is modelled — a figure with
              no stated basis blocks the proposal once a reserve is set.
            </span>
          )}
        </p>
      </div>

      <div>
        <p className="text-slate-500 text-[11px] uppercase tracking-wide mb-1.5">
          What a bad run costs, from this table&apos;s own variance
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[460px]">
            <thead>
              <tr className="text-slate-500 text-[11px] uppercase tracking-wide border-b border-slate-800">
                <th className="text-left font-medium py-2 pr-3">Rounds</th>
                <th className="text-right font-medium py-2 px-3">At stake</th>
                <th className="text-right font-medium py-2 px-3">Sigmas</th>
                <th className="text-right font-medium py-2 pl-3">Costs</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {(exposure.reserve_guidance ?? []).map((row) => (
                <tr key={row.rounds}>
                  <td className="py-2 pr-3 text-slate-300 tabular-nums">{count(row.rounds)}</td>
                  <td className="py-2 px-3 text-right text-slate-400 tabular-nums">
                    {diamonds(row.stake)}
                  </td>
                  <td className="py-2 px-3 text-right text-slate-400 tabular-nums">{row.sigmas}σ</td>
                  <td className="py-2 pl-3 text-right text-slate-100 font-medium tabular-nums">
                    {diamonds(row.diamonds)}
                    <span className="text-slate-600 text-xs ml-1">diamonds</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-slate-500 text-xs mt-2">
          Standard deviation of one round&apos;s return: {exposure.sigma_multiplier}× the
          stake ({ppmPercent(exposure.sigma_ppm)} of it). Priced from the variance of
          the odds on this same card, so the reserve and the odds can never be
          approved against different assumptions.
        </p>
      </div>

      <p className="text-slate-500 text-xs leading-relaxed">{exposure.note}</p>
    </div>
  )
}

function Cell({
  label, value, unit, hint,
}: {
  label: string
  value: string
  unit?: string
  hint: string
}) {
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-xl px-3.5 py-3">
      <p className="text-slate-500 text-[11px] uppercase tracking-wide">{label}</p>
      <p className="text-white text-lg font-semibold tabular-nums mt-0.5">
        {value}
        {unit && <span className="text-slate-600 text-[11px] font-normal ml-1">{unit}</span>}
      </p>
      <p className="text-slate-600 text-[11px] mt-1 leading-snug">{hint}</p>
    </div>
  )
}

/**
 * The refusal, quoted. `blocked` on a preview is the same flag that refuses the
 * proposal, so these sentences are what the server will say at `propose` — and
 * they are shown at the point of editing rather than after a rejected save.
 */
export function BlockedPanel({ reasons }: { reasons: string[] }) {
  if (!reasons.length) return null
  return (
    <div className="bg-red-500/10 border border-red-500/50 rounded-xl px-4 py-3.5">
      <p className="flex items-center gap-2 text-red-200 font-semibold text-sm">
        <Ban size={15} /> This configuration cannot go live
      </p>
      <p className="text-red-300/80 text-xs mt-1 leading-relaxed">
        The server refused the draft, in its own words. `propose` will return the
        same sentences, so there is nothing to be gained by sending it. Nothing has
        been written and the version in force is untouched.
      </p>
      <ul className="mt-3 space-y-2">
        {reasons.map((r, i) => (
          <li
            key={i}
            className="text-red-100 text-sm leading-relaxed bg-red-950/40 border border-red-500/20 rounded-lg px-3 py-2 whitespace-pre-wrap"
          >
            {r}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Things the server wants said out loud that do not block the change. */
export function FlagsPanel({ flags }: { flags: string[] }) {
  if (!flags.length) return null
  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3.5">
      <p className="flex items-center gap-2 text-amber-200 font-semibold text-sm">
        <AlertTriangle size={15} /> {flags.length} thing{flags.length === 1 ? '' : 's'} worth
        knowing before this is signed
      </p>
      <p className="text-amber-300/70 text-xs mt-1">
        None of these blocks the change. Each one is a consequence of the table as
        written, and an owner is signing for it.
      </p>
      <ul className="mt-3 space-y-2">
        {flags.map((f, i) => (
          <li key={i} className="text-amber-100 text-sm leading-relaxed">
            · {f}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The rounding sentence the server attaches to every evaluation. */
export function RoundingNote({ note }: { note: string }) {
  if (!note) return null
  return (
    <p className="flex items-start gap-2 text-slate-500 text-xs leading-relaxed">
      <Info size={13} className="mt-0.5 shrink-0" /> <span>{note}</span>
    </p>
  )
}

/** A titled sub-block inside a panel. */
export function SubSection({
  title, hint, right, children,
}: {
  title: string
  hint?: ReactNode
  right?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1">
        <h3 className="text-slate-200 text-sm font-semibold">{title}</h3>
        {right}
      </div>
      {hint && <p className="text-slate-500 text-xs leading-relaxed max-w-3xl">{hint}</p>}
      {children}
    </div>
  )
}
