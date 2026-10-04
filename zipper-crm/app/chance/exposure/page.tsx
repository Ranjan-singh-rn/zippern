'use client'

/**
 * Exposure and safety — what every mechanic has taken, what it has paid, and
 * how close it is to the stops the business signed for.
 *
 * The one thing this page must never do is let a suspended mechanic scroll past
 * unnoticed, so a suspension is the loudest thing on it: what tripped, when, who
 * or what did it, and what that round actually paid. A suspension does not
 * expire, no timer resumes it, and only an owner can, with a reason.
 *
 * Reads:
 *   • `GET /api/chance/exposure`  `backend/app/routers/chance.py:994`
 *     `require_internal` — the exposure of a chance mechanic is business record
 *     and the Observer reads it like everything else (1.1.1).
 *     Service: `chance.exposure_snapshot` → `chance.exposure_for`,
 *     `backend/app/services/chance.py:3458`.
 *
 * Writes, and the asymmetry between them (`chance.py:1020` / `:1039`):
 *   • suspend — `require_team_admin`. It makes a mechanic *less* available and
 *     can never make one payable where it was not.
 *   • resume  — `require_owner`. A mechanic that stopped by paying past a limit
 *     the business signed for is a decision about money, so it is an owner's.
 *
 * Every figure on this page is a whole number of **diamonds**. Nothing here is
 * rupees and nothing here is beans.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  Activity, AlertOctagon, ArrowLeft, Pause, Play, RefreshCw, Settings2, ShieldAlert, Wallet,
} from 'lucide-react'

import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { attempt, type ReadResult } from '@/lib/readState'
import { Denied, Loading, Warning } from '@/components/ui/States'
import { ChanceReasonModal } from '@/components/ChanceReasonModal'
import { Panel, ReadPanel, ReadOnlyNote, Stat } from '@/components/ChanceUI'
import { SubSection } from '@/components/ChanceEvaluation'
import {
  CHANCE_OWNER_ROLES, CHANCE_READ_ROLES, CHANCE_TEAM_ADMIN_ROLES, KIND_LABELS,
  chance, count, dateTime, diamonds, ppmPercent, relativeTime,
  type MechanicExposure,
} from '@/lib/apiChance'

export default function ChanceExposurePage() {
  const { crmUser, apiUser, loading: authLoading, apiReady, apiError } = useAuth()
  const isObserver = apiUser?.role === 'observer'
  const allowed = isObserver || canAccess(crmUser, CHANCE_READ_ROLES)
  const canSuspend = canAccess(crmUser, CHANCE_TEAM_ADMIN_ROLES)
  const canResume = canAccess(crmUser, CHANCE_OWNER_ROLES)

  const [result, setResult] = useState<ReadResult<MechanicExposure[]> | null>(null)
  const [notice, setNotice] = useState('')
  const [suspending, setSuspending] = useState<MechanicExposure | null>(null)
  const [resuming, setResuming] = useState<MechanicExposure | null>(null)

  const load = useCallback(() => {
    if (!allowed || !apiReady) return
    setResult(null)
    attempt(chance.exposure(), 'chance.exposure').then(setResult)
  }, [allowed, apiReady])

  useEffect(() => { load() }, [load])

  const rows = useMemo(() => (result?.ok ? result.value : []), [result])
  const suspended = useMemo(() => rows.filter((r) => r.suspended), [rows])
  const running = useMemo(
    () =>
      rows
        .filter((r) => !r.suspended)
        // Tightest first: still breached, then least reserve headroom.
        .slice()
        .sort((a, b) => {
          if (a.still_breached !== b.still_breached) return a.still_breached ? -1 : 1
          const ah = a.headline.headroom
          const bh = b.headline.headroom
          if (ah === null && bh === null) return 0
          if (ah === null) return 1
          if (bh === null) return -1
          return ah - bh
        }),
    [rows],
  )

  if (authLoading) return <Loading label="Checking your access…" />
  if (!allowed) return <Denied what="chance exposure" />

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <Link
            href="/chance"
            className="inline-flex items-center gap-1.5 text-slate-500 hover:text-slate-300 text-sm mb-1.5"
          >
            <ArrowLeft size={14} /> All mechanics
          </Link>
          <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2.5">
            <Wallet size={24} className="text-amber-400" /> Exposure and safety
          </h1>
          <p className="text-slate-400 mt-1 text-sm max-w-3xl leading-relaxed">
            Live position against the reserve for every mechanic, the headroom
            left, and how close each ceiling is. Computed from the round records
            — the counters the ceilings are enforced on are shown beside them, so
            a divergence between the control and the record is visible rather
            than averaged into one number nobody can check.
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 shrink-0 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3.5 py-2.5 text-sm transition-colors"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {apiReady && apiError && <Warning>{apiError}</Warning>}
      {notice && <Warning onDismiss={() => setNotice('')}>{notice}</Warning>}

      <ReadPanel
        result={result}
        what="the exposure snapshot"
        loadingLabel="Reading the live position…"
        onRetry={load}
        isEmpty={(v) => v.length === 0}
        emptyTitle="No mechanic has a position"
        emptyHint="Nothing has been staked and nothing has been paid out, because no mechanic exists yet or none has ever been played."
        emptyIcon={<Wallet size={28} />}
      >
        {() => (
          <div className="space-y-6">
            {/* ══ The loudest thing on the page ══════════════════════════ */}
            {suspended.length > 0 ? (
              <section className="space-y-4">
                <div className="bg-red-500/15 border-2 border-red-500/60 rounded-2xl px-5 py-4">
                  <h2 className="flex items-center gap-2.5 text-red-100 text-xl font-bold">
                    <AlertOctagon size={22} className="text-red-300" />
                    {count(suspended.length)} mechanic{suspended.length === 1 ? ' is' : 's are'} suspended
                  </h2>
                  <p className="text-red-200/90 text-sm mt-1.5 leading-relaxed max-w-3xl">
                    A suspended mechanic pays nothing and accepts nothing. To a
                    player it is <strong>absent</strong> — exactly what they would
                    see if it had never been built in their country. Nothing here
                    restarts on a timer: a timer would mean nobody ever has to look.
                  </p>
                </div>
                {suspended.map((row) => (
                  <SuspendedCard
                    key={row.mechanic_id}
                    row={row}
                    canResume={canResume}
                    onResume={() => setResuming(row)}
                  />
                ))}
              </section>
            ) : (
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-4 py-3">
                <p className="text-emerald-200 text-sm font-medium">
                  Nothing is suspended.
                </p>
                <p className="text-emerald-300/70 text-xs mt-0.5">
                  Every mechanic below is running under the ceilings its live
                  configuration was signed with.
                </p>
              </div>
            )}

            {/* ══ Everything that is running ═════════════════════════════ */}
            <section className="space-y-4">
              <h2 className="text-white font-semibold">
                Position per mechanic
                <span className="text-slate-500 font-normal text-sm ml-2">
                  every figure in diamonds
                </span>
              </h2>
              {running.length === 0 ? (
                <ReadOnlyNote>
                  Every mechanic with a position is suspended. There is nothing
                  running to report against a reserve.
                </ReadOnlyNote>
              ) : (
                running.map((row) => (
                  <ExposureCard
                    key={row.mechanic_id}
                    row={row}
                    canSuspend={canSuspend}
                    onSuspend={() => setSuspending(row)}
                  />
                ))
              )}
            </section>
          </div>
        )}
      </ReadPanel>

      {suspending && (
        <ChanceReasonModal
          title={`Stop ${suspending.name}`}
          confirmLabel="Suspend it now"
          tone="danger"
          what={
            <>
              <p>
                From the moment this returns, {suspending.name} pays nothing,
                accepts nothing and is invisible to every player — in exactly the
                way a mechanic disabled for their country is. No round already
                settled is reversed and no balance moves.
              </p>
              <p>
                This is the same stop the ceilings apply automatically, available
                to you because you have seen something they have not.{' '}
                <strong>Only an owner can undo it</strong>, with a reason. There is
                no timer.
              </p>
            </>
          }
          onClose={() => setSuspending(null)}
          onSubmit={async (reason) => {
            const out = await chance.suspend(suspending.mechanic_id, reason)
            setSuspending(null)
            setNotice(
              out.already_suspended
                ? `${suspending.name} was already suspended. Nothing changed.`
                : `${suspending.name} is suspended. It pays nothing and accepts nothing until an owner resumes it.`,
            )
            load()
          }}
        />
      )}

      {resuming && (
        <ChanceReasonModal
          title={`Restart ${resuming.name}`}
          confirmLabel="Resume it"
          tone="caution"
          what={
            <>
              <p>
                This makes {resuming.name} playable again in the markets its live
                configuration enables. It changes <strong>no ceiling and no
                reserve</strong> — if the condition that stopped it still holds,
                the next qualifying payout stops it again.
              </p>
              {resuming.still_breached && (
                <p className="text-red-300">
                  The breached condition still holds right now. Reserve headroom{' '}
                  {diamonds(resuming.headline.headroom)}; today&apos;s ceiling
                  headroom {diamonds(resuming.today.headroom)}. Resuming will very
                  probably suspend it again on the next large payout.
                </p>
              )}
              <p>
                The audit entry records the live position at this moment, so the
                record shows what you were looking at when you decided.
              </p>
            </>
          }
          onClose={() => setResuming(null)}
          onSubmit={async (reason) => {
            const out = await chance.resume(resuming.mechanic_id, reason)
            setResuming(null)
            setNotice(
              out.still_breached
                ? `${resuming.name} was resumed and the breached condition still holds. The next qualifying payout will stop it again.`
                : `${resuming.name} was resumed by ${out.resumed_by.name}.`,
            )
            load()
          }}
        />
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════

function SuspendedCard({
  row, canResume, onResume,
}: {
  row: MechanicExposure
  canResume: boolean
  onResume: () => void
}) {
  const s = row.suspended
  if (!s) return null
  const breach = s.breach

  return (
    <div className="bg-red-500/5 border-2 border-red-500/40 rounded-2xl p-5 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h3 className="text-white text-lg font-bold flex flex-wrap items-center gap-2">
            <Pause size={18} className="text-red-300" />
            {row.name}
            <span className="text-slate-500 text-xs font-normal">
              {KIND_LABELS[row.kind] ?? row.kind} · {row.mechanic_id} ·{' '}
              {row.config_version === null ? 'no live version' : `v${row.config_version}`}
            </span>
          </h3>
          <p className="text-red-200 text-sm mt-1.5">
            {s.automatic
              ? 'Stopped by a ceiling it crossed.'
              : `Stopped by hand by ${s.by.name} (${s.by.role}).`}{' '}
            {dateTime(s.at)} · {relativeTime(s.at)}
          </p>
          <p className="text-red-100 text-sm mt-1 leading-relaxed max-w-3xl">{s.reason}</p>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          {canResume ? (
            <button
              onClick={onResume}
              className="flex items-center gap-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg px-3.5 py-2.5 text-sm font-medium"
            >
              <Play size={14} /> Resume — owner only
            </button>
          ) : (
            <p className="text-red-300/70 text-xs max-w-[15rem] text-right leading-snug">
              Only an owner can resume this, with a reason. There is no timer that
              will do it.
            </p>
          )}
          <Link
            href={`/chance/configure/?mechanic=${encodeURIComponent(row.mechanic_id)}`}
            className="text-red-200/80 hover:text-white text-xs underline underline-offset-2"
          >
            Its configuration →
          </Link>
        </div>
      </div>

      {row.still_breached && (
        <div className="bg-red-950/50 border border-red-500/40 rounded-xl px-4 py-3">
          <p className="flex items-center gap-2 text-red-100 text-sm font-semibold">
            <ShieldAlert size={15} /> The condition that stopped it still holds
          </p>
          <p className="text-red-200/80 text-xs mt-1 leading-relaxed">
            Reserve headroom is {diamonds(row.headline.headroom)} and today&apos;s
            ceiling headroom is {diamonds(row.today.headroom)}. Resuming changes
            neither; the next qualifying payout will stop it again.
          </p>
        </div>
      )}

      {breach ? (
        <SubSection
          title="What tripped it, and what that round paid"
          hint="The round is on the record in full. Withheld diamonds are never written off and never silently credited — they are an exception for a person to settle on a signed card (8B.7.5)."
        >
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat
              label="Would have paid"
              value={diamonds(breach.requested)}
              unit="diamonds"
              hint="What the draw came to before any ceiling."
            />
            <Stat
              label="Actually paid"
              value={diamonds(breach.paid)}
              unit="diamonds"
              tone="good"
              hint="Paid down to the headroom that was left."
            />
            <Stat
              label="Withheld"
              value={diamonds(breach.withheld)}
              unit="diamonds"
              tone="bad"
              hint="Owed, unsettled, and on Ops' queue."
            />
            <Stat
              label="Business day"
              value={breach.day}
              tone="muted"
              hint={`round ${breach.round_id.slice(0, 12)}…`}
            />
          </div>
          <p className="text-slate-400 text-xs mt-3">
            Player <span className="font-mono text-slate-300">{breach.player_uid}</span>
          </p>
          <div className="overflow-x-auto mt-3">
            <table className="w-full text-sm min-w-[620px]">
              <thead>
                <tr className="text-slate-500 text-[11px] uppercase tracking-wide border-b border-red-500/20">
                  <th className="text-left font-medium py-2 pr-3">Ceiling</th>
                  <th className="text-left font-medium py-2 px-3">Applies to</th>
                  <th className="text-right font-medium py-2 px-3">Limit</th>
                  <th className="text-right font-medium py-2 px-3">Wanted</th>
                  <th className="text-right font-medium py-2 pl-3">Granted</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-red-500/10">
                {breach.ceilings.map((c, i) => (
                  <tr key={i}>
                    <td className="py-2 pr-3 text-slate-200">{c.label}</td>
                    <td className="py-2 px-3 text-slate-500 text-xs">
                      {c.kind} · <span className="font-mono">{c.key}</span>
                      {c.day ? ` · ${c.day}` : ''}
                    </td>
                    <td className="py-2 px-3 text-right text-slate-300 tabular-nums">
                      {diamonds(c.limit)}
                    </td>
                    <td className="py-2 px-3 text-right text-slate-300 tabular-nums">
                      {diamonds(c.wanted)}
                    </td>
                    <td className="py-2 pl-3 text-right text-red-200 font-medium tabular-nums">
                      {diamonds(c.granted)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SubSection>
      ) : (
        <ReadOnlyNote>
          No ceiling breach is attached to this suspension, which is what a
          suspension applied by hand looks like. The reason above is the whole of
          the record for why it stopped.
        </ReadOnlyNote>
      )}

      <PositionGrid row={row} />
    </div>
  )
}

function ExposureCard({
  row, canSuspend, onSuspend,
}: {
  row: MechanicExposure
  canSuspend: boolean
  onSuspend: () => void
}) {
  const unconfigured = row.config_version === null
  return (
    <div
      className={`border rounded-xl p-4 sm:p-5 space-y-5 ${
        row.still_breached
          ? 'bg-red-500/5 border-red-500/40'
          : unconfigured
            ? 'bg-slate-900/60 border-slate-800'
            : 'bg-slate-900 border-slate-800'
      }`}
    >
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h3 className="text-white font-semibold flex flex-wrap items-center gap-2">
            {row.name}
            <span className="text-slate-500 text-xs font-normal">
              {KIND_LABELS[row.kind] ?? row.kind} · {row.mechanic_id} ·{' '}
              {unconfigured ? (
                <span className="text-slate-400">never configured — invisible everywhere</span>
              ) : (
                `v${row.config_version}`
              )}
            </span>
          </h3>
          {row.still_breached && (
            <p className="text-red-300 text-sm mt-1">
              Past a limit right now, and not suspended. The next qualifying payout
              will stop it.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href={`/chance/configure/?mechanic=${encodeURIComponent(row.mechanic_id)}`}
            className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg px-3 py-2 text-sm"
          >
            <Settings2 size={14} /> Configuration
          </Link>
          {canSuspend && (
            <button
              onClick={onSuspend}
              className="flex items-center gap-1.5 bg-red-600/90 hover:bg-red-500 text-white rounded-lg px-3 py-2 text-sm font-medium"
            >
              <Pause size={14} /> Stop it
            </button>
          )}
        </div>
      </div>

      <PositionGrid row={row} />
    </div>
  )
}

/** The position, the reserve, the day and the ceilings. Shared by both cards. */
function PositionGrid({ row }: { row: MechanicExposure }) {
  const h = row.headline
  const t = row.today
  const c = row.ceilings

  // Presentation only: the width of a bar. Every figure printed beside it is the
  // server's own — `reserve_consumed_percent` is computed by `exposure_for`, and
  // the headroom figures are too.
  const dayFraction =
    t.ceiling && t.ceiling > 0 ? Math.min(1, Math.max(0, t.paid_out / t.ceiling)) : null
  const reserveFraction =
    h.reserve_consumed_ppm === null ? null : Math.min(1, h.reserve_consumed_ppm / 1_000_000)

  const recordVsControl =
    row.control.paid_out !== h.paid_out || row.control.staked !== h.staked

  return (
    <div className="space-y-5">
      <SubSection
        title="Lifetime position"
        hint="Net is staked minus paid out — gross gaming revenue when it is positive, and what the reserve is absorbing when it is not."
      >
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
          <Stat label="Staked" value={diamonds(h.staked)} unit="dmd" />
          <Stat label="Paid out" value={diamonds(h.paid_out)} unit="dmd" />
          <Stat
            label="Withheld"
            value={diamonds(h.withheld)}
            unit="dmd"
            tone={h.withheld > 0 ? 'bad' : 'muted'}
            hint={h.withheld > 0 ? 'Owed and unsettled.' : 'Nothing outstanding.'}
          />
          <Stat
            label="Net"
            value={diamonds(h.net)}
            unit="dmd"
            tone={h.net >= 0 ? 'good' : 'bad'}
          />
          <Stat label="Rounds" value={count(h.rounds)} tone="muted" />
          <Stat
            label="Actual RTP"
            value={h.actual_rtp_ppm === null ? '—' : ppmPercent(h.actual_rtp_ppm)}
            hint={h.actual_rtp_ppm === null ? 'Nothing has been staked.' : 'Measured, lifetime.'}
            tone={h.actual_rtp_ppm === null ? 'muted' : 'plain'}
          />
        </div>
      </SubSection>

      <SubSection
        title="Against the reserve"
        hint="Headroom is reserve plus net — how much more can be paid out before this mechanic is loss-making past what the business signed for."
      >
        {h.reserve === null ? (
          <ReadOnlyNote>
            No reserve is configured, so there is no headroom to report and nothing
            for a bad run to be measured against. That is the gap 8B.4.6 names, not
            a headroom of zero.
          </ReadOnlyNote>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              <Stat label="Reserve" value={diamonds(h.reserve)} unit="dmd" />
              <Stat
                label="Headroom"
                value={diamonds(h.headroom)}
                unit="dmd"
                tone={h.headroom !== null && h.headroom <= 0 ? 'bad' : 'good'}
              />
              <Stat
                label="Consumed"
                value={h.reserve_consumed_percent === null ? '—' : `${h.reserve_consumed_percent}%`}
                hint="Computed by the server from the round records."
                tone={
                  h.reserve_consumed_ppm !== null && h.reserve_consumed_ppm >= 750_000
                    ? 'bad'
                    : 'plain'
                }
              />
            </div>
            {reserveFraction !== null && (
              <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className={`h-full ${reserveFraction >= 0.75 ? 'bg-red-500' : 'bg-amber-400'}`}
                  style={{ width: `${reserveFraction * 100}%` }}
                />
              </div>
            )}
            {row.reserve_basis ? (
              <p className="text-slate-500 text-xs leading-relaxed">
                <span className="text-slate-400">Stated basis:</span> {row.reserve_basis}
              </p>
            ) : (
              <p className="text-amber-300 text-xs">
                No basis is stated for this reserve on the live version.
              </p>
            )}
            {row.sigma_ppm !== null && (
              <p className="text-slate-500 text-xs">
                One round&apos;s return has a standard deviation of{' '}
                {ppmPercent(row.sigma_ppm)} of the stake, from the signed table&apos;s
                own variance.
              </p>
            )}
          </div>
        )}
      </SubSection>

      <SubSection
        title={`Today — ${row.day}`}
        hint="The business day the daily ceilings are enforced on."
      >
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <Stat label="Staked today" value={diamonds(t.staked)} unit="dmd" />
          <Stat label="Paid out today" value={diamonds(t.paid_out)} unit="dmd" />
          <Stat label="Withheld today" value={diamonds(t.withheld)} unit="dmd" tone={t.withheld ? 'bad' : 'muted'} />
          <Stat label="Rounds today" value={count(t.rounds)} tone="muted" />
          <Stat
            label="Ceiling headroom"
            value={t.ceiling === null ? 'no ceiling' : diamonds(t.headroom)}
            unit={t.ceiling === null ? undefined : 'dmd'}
            tone={t.ceiling === null ? 'muted' : t.headroom !== null && t.headroom <= 0 ? 'bad' : 'good'}
            hint={
              t.ceiling === null
                ? 'No platform daily ceiling is configured. Absent, not zero.'
                : `Against a platform daily ceiling of ${diamonds(t.ceiling)}.`
            }
          />
        </div>
        {dayFraction !== null && (
          <div className="h-2 bg-slate-800 rounded-full overflow-hidden mt-3">
            <div
              className={`h-full ${dayFraction >= 0.75 ? 'bg-red-500' : 'bg-sky-400'}`}
              style={{ width: `${dayFraction * 100}%` }}
            />
          </div>
        )}
      </SubSection>

      <SubSection
        title="The ceilings this mechanic is signed with"
        hint="They live inside the configuration version, so they moved on a card an owner signed — not on a setting somebody can edit at three in the morning."
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[560px]">
            <thead>
              <tr className="text-slate-500 text-[11px] uppercase tracking-wide border-b border-slate-800">
                <th className="text-left font-medium py-2 pr-3">Ceiling</th>
                <th className="text-right font-medium py-2 px-3">Limit</th>
                <th className="text-left font-medium py-2 pl-3">How close</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              <CeilingRow
                label="One round"
                limit={c.per_round}
                how="Caps a payout and suspends nothing. A big win is paid down to it."
              />
              <CeilingRow
                label="One player, one day"
                limit={c.per_player_per_day}
                how="Enforced per player, so there is no single figure to be close to. Crossing it withholds the shortfall and auto-suspends."
              />
              <CeilingRow
                label="Platform, one day"
                limit={c.platform_per_day}
                how={
                  c.platform_per_day === null
                    ? 'Absent, not zero.'
                    : `${diamonds(t.paid_out)} paid today · ${diamonds(t.headroom)} left`
                }
                tight={t.headroom !== null && c.platform_per_day !== null && t.headroom <= 0}
              />
              <CeilingRow
                label="All mechanics, one day"
                limit={c.all_mechanics_per_day}
                how="A deployment-wide stop, from settings rather than from this configuration."
              />
            </tbody>
          </table>
        </div>
      </SubSection>

      <SubSection
        title="The record against the control"
        hint="The headline above is computed from the round records. The control is the counter the ceilings are actually enforced on. They should agree."
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Control staked" value={diamonds(row.control.staked)} unit="dmd" tone="muted" />
          <Stat label="Control paid out" value={diamonds(row.control.paid_out)} unit="dmd" tone="muted" />
          <Stat label="Control withheld" value={diamonds(row.control.withheld)} unit="dmd" tone="muted" />
          <Stat label="Control net" value={diamonds(row.control.net)} unit="dmd" tone="muted" />
        </div>
        {recordVsControl && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2.5 mt-3">
            <p className="flex items-center gap-2 text-amber-200 text-sm font-medium">
              <Activity size={14} /> The control and the record do not agree
            </p>
            <p className="text-amber-300/80 text-xs mt-1 leading-relaxed">
              Neither figure has been adjusted to match the other. The counter is the
              conservative one, and the difference is a payout that was reserved
              against a ceiling and never credited. It is shown rather than averaged
              away because averaging it is how a discrepancy stops being findable.
            </p>
          </div>
        )}
      </SubSection>
    </div>
  )
}

function CeilingRow({
  label, limit, how, tight,
}: {
  label: string
  limit: number | null
  how: string
  tight?: boolean
}) {
  return (
    <tr className={tight ? 'bg-red-500/5' : ''}>
      <td className="py-2 pr-3 text-slate-200">{label}</td>
      <td className="py-2 px-3 text-right tabular-nums">
        {limit === null ? (
          <span className="text-slate-500">none</span>
        ) : (
          <span className="text-slate-100">
            {diamonds(limit)}
            <span className="text-slate-600 text-xs ml-1">dmd</span>
          </span>
        )}
      </td>
      <td className={`py-2 pl-3 text-xs ${tight ? 'text-red-300' : 'text-slate-500'}`}>{how}</td>
    </tr>
  )
}
