'use client'

/**
 * What this agency owes its sub-agencies, and which payouts are half done.
 *
 * Spec 4.2.4 / 4.2.6 — a sub-agency is paid *through* its parent, so a payout
 * has two legs. Leg 1 is Zipper's money leaving. Leg 2 is this agency
 * confirming it passed the money on. Between the two the sub-agency may not
 * have been paid at all.
 *
 * The number this screen has to be careful with is `owed_by_parent`. It is the
 * sub-agency's own outstanding commission balance, and leg 1 debits **the
 * sub's** balance, not the parent's (backend/app/services/partner_ops.py:2661).
 * So it drops to zero the moment Zipper pays the parent — before the sub has
 * seen anything. Read on its own it says "settled" when the correct reading is
 * "we have handed it to you". That is stated on screen, not left implied.
 */

import { AlertTriangle, CheckCircle2, Clock, CornerDownRight, Wallet } from 'lucide-react'
import { Empty, UnavailablePanel } from '@/components/ui/States'
import {
  inrExact,
  when,
  STATUS_TONE,
  type SubAgency,
} from '@/lib/apiPartners'
import type { ReadResult } from '@/lib/readState'
import { Section } from './MoneyUI'

// ── A payout, as GET /partner-ops/subagency-payouts/open returns it ───────────
// The raw payout document, so the narrowing lives here rather than in markup.

export interface PayoutLeg {
  status: string
  paidAt: string
  confirmedAt: string
  paymentRef: string
  by: string
  reason: string
}

export interface SubPayout {
  id: string
  cardId: string
  parentId: string
  parentName: string
  subId: string
  subName: string
  amountMinor: number
  status: string
  createdAt: string
  leg1: PayoutLeg
  leg2: PayoutLeg
}

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

function readLeg(raw: unknown): PayoutLeg {
  const leg = obj(raw)
  const who = obj(leg.by)
  return {
    status: text(leg, 'status') || 'pending',
    paidAt: text(leg, 'paid_at'),
    confirmedAt: text(leg, 'confirmed_at'),
    paymentRef: text(leg, 'payment_ref'),
    by: text(who, 'name'),
    reason: text(leg, 'reason'),
  }
}

export function readPayout(raw: Record<string, unknown>): SubPayout {
  return {
    id: text(raw, 'id'),
    cardId: text(raw, 'card_id'),
    parentId: text(raw, 'parent_id'),
    parentName: text(raw, 'parent_name'),
    subId: text(raw, 'sub_id'),
    subName: text(raw, 'sub_name'),
    amountMinor: number(raw, 'amount_minor'),
    status: text(raw, 'status') || 'pending',
    createdAt: text(raw, 'created_at'),
    leg1: readLeg(raw.leg1),
    leg2: readLeg(raw.leg2),
  }
}

// ══════════════════════════════════════════════════════════════════════════════

export function SubAgencyMoney({
  subs,
  payouts,
  myId,
  isSub,
  onRetry,
}: {
  /** null while in flight. */
  subs: ReadResult<SubAgency[]> | null
  payouts: ReadResult<SubPayout[]> | null
  myId: string
  isSub: boolean
  onRetry: () => void
}) {
  const mine =
    payouts?.ok === true
      ? payouts.value.filter((p) => p.parentId === myId || p.subId === myId)
      : []
  const legTwoOutstanding = mine.filter(
    (p) => p.leg1.status === 'paid' && p.leg2.status !== 'confirmed',
  )

  // A main agency with no sub-agencies has no second leg to be told about, and
  // showing it a refusal for a list that could only ever be empty is noise
  // dressed as a warning. The section appears when two legs can actually exist.
  const twoLegsApply = isSub || (subs?.ok === true && subs.value.length > 0)

  return (
    <Section
      title={isSub ? 'Money owed to you, through your parent' : 'What you owe your sub-agencies'}
      icon={<CornerDownRight size={15} />}
      subtitle={
        isSub
          ? 'You are a sub-agency. Zipper pays your parent agency and your parent pays you — money never reaches you directly. Both legs are recorded, and a payout is not closed until the second one is confirmed.'
          : 'A sub-agency earns on its own slab table but is paid through you. Zipper pays you (leg 1) and you pay the sub-agency (leg 2). The payout stays open until leg 2 is confirmed.'
      }
    >
      {/* ── What is owed ──────────────────────────────────────────────────── */}
      {subs === null ? (
        <div className="p-5 space-y-2.5">
          {[0, 1].map((i) => (
            <div key={i} className="h-16 bg-slate-800/60 rounded animate-pulse" />
          ))}
        </div>
      ) : !subs.ok ? (
        <UnavailablePanel
          failure={subs}
          what="Your sub-agencies and what is owed to them"
          onRetry={onRetry}
        />
      ) : subs.value.length === 0 ? (
        <Empty
          title={isSub ? 'You have no sub-agencies' : 'No sub-agencies under you yet'}
          hint={
            isSub
              ? 'A sub-agency cannot itself have sub-agencies.'
              : 'Add one below and it appears here with its balance once it is approved.'
          }
          icon={<CornerDownRight size={26} />}
        />
      ) : (
        <div className="p-4 sm:p-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {subs.value.map((s) => (
              <SubCard key={s.id} sub={s} />
            ))}
          </div>
          <p className="text-slate-600 text-[11px] mt-3 leading-relaxed">
            Amounts are Indian Rupees (INR), converted once from paise. A figure
            here is the sub-agency&rsquo;s own outstanding commission — the same
            balance Zipper settles against, not a separate tally.
          </p>
        </div>
      )}

      {/* ── The two legs ──────────────────────────────────────────────────── */}
      {twoLegsApply && (
      <div className="border-t border-slate-800">
        <div className="px-4 sm:px-5 py-3.5">
          <h3 className="flex items-center gap-2 text-white text-sm font-semibold">
            <Wallet size={14} className="text-slate-500" />
            Payouts where leg 1 is done and leg 2 is not
          </h3>
          <p className="text-slate-500 text-xs mt-1 leading-relaxed max-w-2xl">
            Leg 1 executing means Zipper&rsquo;s money has left. Until leg 2 is
            confirmed the sub-agency may not have been paid at all — and because
            leg 1 debits the sub-agency&rsquo;s own balance, the{' '}
            {isSub ? 'figure above' : 'figures above'} will already read zero
            while that is true. A zero there means &ldquo;Zipper has paid the
            parent&rdquo;, not &ldquo;the sub-agency has the money&rdquo;.
          </p>
        </div>

        {payouts === null ? (
          <div className="px-4 sm:px-5 pb-5 space-y-2.5">
            <div className="h-14 bg-slate-800/60 rounded animate-pulse" />
          </div>
        ) : !payouts.ok ? (
          <>
            <UnavailablePanel
              failure={payouts}
              what="The two legs of each sub-agency payout"
              onRetry={onRetry}
            />
            <p className="px-4 sm:px-5 pb-5 -mt-2 text-slate-600 text-[11px] leading-relaxed text-center max-w-2xl mx-auto">
              This list <em>is</em> open to your login — the endpoint answers an
              agency with the payouts it is a party to, the ones it is the parent
              of and the ones it is the sub of, and with nobody else&rsquo;s. So
              the message above is a read that failed rather than a permission
              you do not have: retry it. If it keeps failing, ask Zipper for the
              leg status of any payout — it is on the record either way, and every
              payment that has actually reached you still appears in your ledger
              above.
            </p>
          </>
        ) : mine.length === 0 ? (
          <Empty
            title="No open sub-agency payouts"
            hint="A payout stays here from the moment it is raised until leg 2 is confirmed. Nothing is open against you."
            icon={<CheckCircle2 size={26} />}
          />
        ) : (
          <div className="divide-y divide-slate-800/60">
            {legTwoOutstanding.length > 0 && (
              <div className="px-4 sm:px-5 py-3.5 bg-amber-500/[0.07]">
                <p className="flex items-start gap-2 text-amber-100 text-sm font-semibold">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                  {legTwoOutstanding.length} payout
                  {legTwoOutstanding.length === 1 ? '' : 's'} left Zipper and{' '}
                  {legTwoOutstanding.length === 1 ? 'has' : 'have'} not been
                  confirmed passed on.
                </p>
              </div>
            )}
            {mine.map((p) => (
              <PayoutLegs key={p.id || p.cardId} payout={p} />
            ))}
          </div>
        )}
      </div>
      )}
    </Section>
  )
}

function SubCard({ sub }: { sub: SubAgency }) {
  const owed = sub.owed_by_parent
  return (
    <div className="bg-slate-800/40 border border-slate-700/60 rounded-xl p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-white text-sm font-medium truncate">
            {sub.name || sub.id}
          </p>
          <p className="text-slate-600 text-[11px] font-mono truncate">{sub.id}</p>
        </div>
        <span
          className={`text-[11px] px-2 py-1 rounded shrink-0 ${
            STATUS_TONE[sub.status] ?? 'bg-slate-700 text-slate-300'
          }`}
        >
          {sub.status}
        </span>
      </div>
      <div className="flex items-end justify-between gap-2 mt-3">
        <span className="text-slate-400 text-[10px] uppercase tracking-wide">
          Outstanding to them
        </span>
        <span
          className={`text-base font-semibold ${
            owed > 0 ? 'text-amber-300' : 'text-slate-500'
          }`}
        >
          {inrExact(owed)}
        </span>
      </div>
      {owed <= 0 && (
        <p className="text-slate-600 text-[11px] mt-1.5 leading-snug">
          Nothing outstanding. If a payout was raised recently this reads zero
          from leg 1 onwards — check leg 2 before treating them as paid.
        </p>
      )}
    </div>
  )
}

function PayoutLegs({ payout }: { payout: SubPayout }) {
  const legOneDone = payout.leg1.status === 'paid'
  const legTwoDone = payout.leg2.status === 'confirmed'
  const atRisk = legOneDone && !legTwoDone

  return (
    <div className={`px-4 sm:px-5 py-4 ${atRisk ? 'bg-amber-500/[0.06]' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-white text-sm font-medium">
            {inrExact(payout.amountMinor)}
            <span className="text-slate-500 font-normal ml-2">
              to {payout.subName || payout.subId}
            </span>
          </p>
          <p className="text-slate-600 text-[11px] mt-0.5">
            via {payout.parentName || payout.parentId} · raised{' '}
            {when(payout.createdAt)}
          </p>
        </div>
        <span
          className={`text-[11px] px-2 py-1 rounded shrink-0 ${
            legTwoDone
              ? 'bg-slate-700/60 text-slate-400'
              : atRisk
                ? 'bg-amber-500/15 text-amber-300'
                : 'bg-slate-700 text-slate-300'
          }`}
        >
          {legTwoDone
            ? 'closed'
            : atRisk
              ? 'leg 2 outstanding'
              : payout.status.replace(/_/g, ' ')}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mt-3">
        <LegBox
          n={1}
          title="Zipper pays the main agency"
          done={legOneDone}
          at={payout.leg1.paidAt}
          by={payout.leg1.by}
          detail={
            payout.leg1.paymentRef
              ? `ref ${payout.leg1.paymentRef}`
              : 'no reference on record'
          }
          pending="Zipper's money has not left yet."
        />
        <LegBox
          n={2}
          title="Main agency pays the sub-agency"
          done={legTwoDone}
          at={payout.leg2.confirmedAt}
          by={payout.leg2.by}
          detail={payout.leg2.reason}
          pending={
            legOneDone
              ? "Zipper's money is gone and this has not been confirmed. The sub-agency may not have been paid."
              : 'Waiting on leg 1.'
          }
          danger={atRisk}
        />
      </div>
    </div>
  )
}

function LegBox({
  n,
  title,
  done,
  at,
  by,
  detail,
  pending,
  danger,
}: {
  n: number
  title: string
  done: boolean
  at: string
  by: string
  detail: string
  pending: string
  danger?: boolean
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        done
          ? 'bg-green-500/10 border-green-500/30'
          : danger
            ? 'bg-red-500/10 border-red-500/40'
            : 'bg-slate-800/60 border-slate-700'
      }`}
    >
      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        {done ? (
          <CheckCircle2 size={11} className="text-green-400" />
        ) : (
          <Clock size={11} className={danger ? 'text-red-400' : 'text-slate-500'} />
        )}
        Leg {n}
      </p>
      <p className="text-slate-200 text-xs mt-1">{title}</p>
      {done ? (
        <p className="text-slate-500 text-[11px] mt-1 leading-snug">
          {when(at)}
          {by ? ` · ${by}` : ''}
          {detail ? ` · ${detail}` : ''}
        </p>
      ) : (
        <p
          className={`text-[11px] mt-1 leading-snug ${
            danger ? 'text-red-300' : 'text-slate-500'
          }`}
        >
          {pending}
        </p>
      )}
    </div>
  )
}
