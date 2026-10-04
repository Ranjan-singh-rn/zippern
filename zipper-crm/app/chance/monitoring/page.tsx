'use client'

/**
 * Monitoring — is this mechanic doing what it was signed to do?
 *
 * The figure this page exists for is **actual RTP against configured RTP**, and
 * the way it is reported is the whole argument. `chance.rtp_divergence`
 * (`backend/app/services/chance.py:3744`) judges each day against the exact
 * variance of the signed outcome table and returns a **confidence bound on
 * actual RTP** rather than a bare percentage gap — and refuses to call anything
 * divergent below `min_rounds` however extreme it looks. A small sample diverges
 * by a lot; calling that an exploit is how an alert stops being read. So the
 * screen shows the bound, shows the round count, and says "not enough rounds"
 * in those words when that is the answer.
 *
 * When something *is* divergent, 8B.5.2 names three causes and the server does
 * not guess between them. Neither does this page: all three are printed, in the
 * server's own words, every time.
 *
 * Reads (all `require_internal`):
 *   • `GET /api/chance/mechanics`                `backend/app/routers/chance.py:208`
 *   • `GET /api/chance/mechanics/{id}/rtp`       `backend/app/routers/chance.py:1063`
 *   • `GET /api/chance/exceptions`               `backend/app/routers/chance.py:1083`
 *   • `GET /api/chance/players/{uid}/anomalies`  `backend/app/routers/chance.py:1116`
 *
 * Writes:
 *   • `POST /api/chance/players/{uid}/freeze`    `backend/app/routers/chance.py:1145`
 *   • `POST /api/chance/players/{uid}/unfreeze`  `backend/app/routers/chance.py:1168`
 *     Two guards and the narrow one wins: the route is `require_team_admin`, and
 *     `chance._require_reviewer` then refuses anyone who is not Ops or an owner.
 *     The intersection — owner or Ops admin — is `CHANCE_FREEZE_ROLES`, and the
 *     buttons are gated on it so nobody is offered a 403.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  Activity, AlertTriangle, ArrowLeft, HelpCircle, Pause, RefreshCw, Search,
  Snowflake, Sun, User,
} from 'lucide-react'

import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { attempt, type ReadResult } from '@/lib/readState'
import { Denied, Loading, Warning } from '@/components/ui/States'
import { ChanceReasonModal } from '@/components/ChanceReasonModal'
import { Panel, ReadPanel, ReadOnlyNote, Stat } from '@/components/ChanceUI'
import { SubSection } from '@/components/ChanceEvaluation'
import {
  CHANCE_FREEZE_ROLES, CHANCE_READ_ROLES, KIND_LABELS, chance, count, dateTime,
  diamonds, ppmPercent, relativeTime,
  type Divergence, type ExceptionQueue, type Mechanic, type PlayerAnomalies,
  type RtpDivergenceReport,
} from '@/lib/apiChance'

const WINDOWS = [1, 7, 14, 30, 90]
const HOURS = [6, 24, 72, 168]

function MonitoringScreen() {
  const { crmUser, apiUser, loading: authLoading, apiReady, apiError } = useAuth()
  const isObserver = apiUser?.role === 'observer'
  const allowed = isObserver || canAccess(crmUser, CHANCE_READ_ROLES)
  const canFreeze = canAccess(crmUser, CHANCE_FREEZE_ROLES)

  const params = useSearchParams()

  const [mechanics, setMechanics] = useState<ReadResult<Mechanic[]> | null>(null)
  const [selected, setSelected] = useState('')
  const [days, setDays] = useState(7)
  const [rtp, setRtp] = useState<ReadResult<RtpDivergenceReport> | null>(null)

  const [hours, setHours] = useState(24)
  const [queue, setQueue] = useState<ReadResult<ExceptionQueue> | null>(null)

  // Linked to from the protection screen, so a reviewer moves between one
  // player's harm pattern and one player's round figures without retyping a uid.
  const [uid, setUid] = useState(params.get('player') ?? '')
  const [lookup, setLookup] = useState(params.get('player') ?? '')
  const [anomalies, setAnomalies] = useState<ReadResult<PlayerAnomalies> | null>(null)

  const [freezing, setFreezing] = useState<{ uid: string; frozen: boolean } | null>(null)
  const [notice, setNotice] = useState('')

  const loadMechanics = useCallback(() => {
    if (!allowed || !apiReady) return
    setMechanics(null)
    attempt(chance.mechanics(), 'chance.mechanics').then((r) => {
      setMechanics(r)
      if (r.ok && r.value.length && !selected) setSelected(r.value[0].id)
    })
    // `selected` deliberately not a dependency: re-reading the register must not
    // move a choice somebody has already made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, apiReady])

  const loadRtp = useCallback(() => {
    if (!allowed || !apiReady || !selected) return
    setRtp(null)
    attempt(chance.rtp(selected, days), 'chance.rtp').then(setRtp)
  }, [allowed, apiReady, selected, days])

  const loadQueue = useCallback(() => {
    if (!allowed || !apiReady) return
    setQueue(null)
    attempt(chance.exceptions(hours), 'chance.exceptions').then(setQueue)
  }, [allowed, apiReady, hours])

  const loadAnomalies = useCallback(() => {
    if (!allowed || !apiReady || !lookup) return
    setAnomalies(null)
    attempt(chance.playerAnomalies(lookup, hours), 'chance.playerAnomalies').then(setAnomalies)
  }, [allowed, apiReady, lookup, hours])

  useEffect(() => { loadMechanics() }, [loadMechanics])
  useEffect(() => { loadRtp() }, [loadRtp])
  useEffect(() => { loadQueue() }, [loadQueue])
  useEffect(() => { loadAnomalies() }, [loadAnomalies])

  const mechanicRows = useMemo(() => (mechanics?.ok ? mechanics.value : []), [mechanics])

  if (authLoading) return <Loading label="Checking your access…" />
  if (!allowed) return <Denied what="chance monitoring" />

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
            <Activity size={24} className="text-sky-400" /> Monitoring
          </h1>
          <p className="text-slate-400 mt-1 text-sm max-w-3xl leading-relaxed">
            Actual return against the return that was signed for, per mechanic
            per day, with the confidence bound the server judged it against.
            Never a bare percentage gap, and never an alert on a sample too small
            to distinguish from luck.
          </p>
        </div>
        <button
          onClick={() => { loadRtp(); loadQueue(); loadAnomalies() }}
          className="flex items-center gap-2 shrink-0 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3.5 py-2.5 text-sm transition-colors"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {apiReady && apiError && <Warning>{apiError}</Warning>}
      {notice && <Warning onDismiss={() => setNotice('')}>{notice}</Warning>}

      {/* ══ RTP divergence ═══════════════════════════════════════════════ */}
      <Panel
        title="Actual RTP against configured"
        subtitle="Judged against the exact variance of the signed outcome table. Reported as a bound on actual RTP, because “92% against a configured 94%” means nothing without knowing how wide 92% could honestly be."
        right={
          <div className="flex flex-wrap gap-1.5">
            {WINDOWS.map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`rounded-lg border px-2.5 py-1.5 text-xs ${
                  days === d
                    ? 'border-sky-500 bg-sky-500/10 text-white'
                    : 'border-slate-700 text-slate-400 hover:border-slate-600'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        }
      >
        <div className="space-y-4">
          <ReadPanel
            result={mechanics}
            what="the mechanic register"
            onRetry={loadMechanics}
            isEmpty={(v) => v.length === 0}
            emptyTitle="No mechanic exists yet"
          >
            {(rows) => (
              <div className="flex flex-wrap gap-2">
                {rows.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setSelected(m.id)}
                    className={`rounded-lg border px-3 py-2 text-sm ${
                      m.id === selected
                        ? 'border-sky-500 bg-sky-500/10 text-white'
                        : 'border-slate-700 text-slate-300 hover:border-slate-600'
                    }`}
                  >
                    {m.name}
                    <span className="text-slate-500 text-xs ml-1.5">
                      {KIND_LABELS[m.kind] ?? m.kind}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </ReadPanel>

          {selected && (
            <ReadPanel
              result={rtp}
              what="the RTP comparison"
              loadingLabel="Reading settled rounds…"
              onRetry={loadRtp}
            >
              {(report) => (
                <div className="space-y-5">
                  <SubSection
                    title={`Pooled over ${report.window_days} day${report.window_days === 1 ? '' : 's'}`}
                    hint={`Settled rounds since ${dateTime(report.since)}. A voided round staked nothing and paid nothing, and is not counted.`}
                  >
                    <PooledVerdict d={report.pooled} />
                  </SubSection>

                  {/* All three, always. The server does not guess and neither
                      does this screen. */}
                  <div className="bg-slate-950/60 border border-slate-800 rounded-xl px-4 py-3.5">
                    <p className="flex items-center gap-2 text-slate-200 text-sm font-semibold">
                      <HelpCircle size={15} className="text-sky-400" /> If it is divergent,
                      it is one of these three — and nothing here can tell you which
                    </p>
                    <ol className="mt-2.5 space-y-2">
                      {report.if_divergent.map((cause, i) => (
                        <li key={i} className="text-slate-300 text-sm leading-relaxed">
                          <span className="text-slate-500 font-mono text-xs mr-1.5">
                            {i + 1}.
                          </span>
                          {cause}
                        </li>
                      ))}
                    </ol>
                    <p className="text-slate-500 text-xs mt-3 leading-relaxed">
                      They are printed together, in this order, whatever the verdict
                      says. A report that picked one would send somebody the wrong way,
                      and being sent the wrong way once is what teaches people to stop
                      reading the alert.
                    </p>
                  </div>

                  <SubSection
                    title="Per day"
                    hint="Each day is judged on its own at the daily sigma threshold, which is looser than the pooled one because one day is a smaller sample."
                  >
                    {report.per_day.length === 0 ? (
                      <ReadOnlyNote>
                        No settled round fell inside this window. That is an absence of
                        play, not a return of zero.
                      </ReadOnlyNote>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm min-w-[900px]">
                          <thead>
                            <tr className="text-slate-500 text-[11px] uppercase tracking-wide border-b border-slate-800">
                              <th className="text-left font-medium py-2 pr-3">Day</th>
                              <th className="text-right font-medium py-2 px-3">Rounds</th>
                              <th className="text-right font-medium py-2 px-3">Staked</th>
                              <th className="text-right font-medium py-2 px-3">Paid out</th>
                              <th className="text-right font-medium py-2 px-3">Configured</th>
                              <th className="text-right font-medium py-2 px-3">Actual</th>
                              <th className="text-right font-medium py-2 px-3">Bound</th>
                              <th className="text-right font-medium py-2 px-3">Capped</th>
                              <th className="text-left font-medium py-2 pl-3">Verdict</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-800/60">
                            {report.per_day.map((d) => (
                              <tr
                                key={d.day}
                                className={
                                  d.divergent ? 'bg-red-500/5' : !d.enough_rounds ? 'opacity-70' : ''
                                }
                              >
                                <td className="py-2 pr-3 text-slate-200">
                                  {d.day}
                                  {d.config_versions && d.config_versions.length > 0 && (
                                    <span className="block text-slate-600 text-[11px]">
                                      v{d.config_versions.join(', v')}
                                    </span>
                                  )}
                                </td>
                                <td className="py-2 px-3 text-right text-slate-300 tabular-nums">
                                  {count(d.rounds)}
                                </td>
                                <td className="py-2 px-3 text-right text-slate-400 tabular-nums">
                                  {diamonds(d.staked)}
                                </td>
                                <td className="py-2 px-3 text-right text-slate-400 tabular-nums">
                                  {diamonds(d.paid_out)}
                                </td>
                                <td className="py-2 px-3 text-right text-slate-300 tabular-nums">
                                  {d.configured_rtp_percent === null
                                    ? '—'
                                    : `${d.configured_rtp_percent}%`}
                                </td>
                                <td
                                  className={`py-2 px-3 text-right font-medium tabular-nums ${
                                    d.divergent ? 'text-red-300' : 'text-slate-100'
                                  }`}
                                >
                                  {d.actual_rtp_percent === null ? '—' : `${d.actual_rtp_percent}%`}
                                </td>
                                <td className="py-2 px-3 text-right text-slate-400 tabular-nums text-xs">
                                  {d.confidence_low_ppm === null
                                    ? '—'
                                    : `${ppmPercent(d.confidence_low_ppm)} – ${ppmPercent(d.confidence_high_ppm)}`}
                                </td>
                                <td className="py-2 px-3 text-right text-slate-400 tabular-nums">
                                  {count(d.capped_rounds ?? 0)}
                                </td>
                                <td
                                  className={`py-2 pl-3 text-xs ${
                                    d.divergent
                                      ? 'text-red-300'
                                      : d.enough_rounds
                                        ? 'text-slate-500'
                                        : 'text-amber-300/80'
                                  }`}
                                >
                                  {d.verdict}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </SubSection>

                  <p className="text-slate-500 text-xs leading-relaxed">{report.note}</p>
                </div>
              )}
            </ReadPanel>
          )}
        </div>
      </Panel>

      {/* ══ The exception queue ══════════════════════════════════════════ */}
      <Panel
        title="The exception queue"
        subtitle="Ops owns this (8B.5.6). Everything on it needs a person: nothing here clears itself, expires, or is settled by a scheduled job."
        right={
          <div className="flex flex-wrap gap-1.5">
            {HOURS.map((h) => (
              <button
                key={h}
                onClick={() => setHours(h)}
                className={`rounded-lg border px-2.5 py-1.5 text-xs ${
                  hours === h
                    ? 'border-sky-500 bg-sky-500/10 text-white'
                    : 'border-slate-700 text-slate-400 hover:border-slate-600'
                }`}
              >
                {h}h
              </button>
            ))}
          </div>
        }
      >
        <ReadPanel
          result={queue}
          what="the exception queue"
          loadingLabel="Reading the queue…"
          onRetry={loadQueue}
        >
          {(q) => (
            <div className="space-y-5">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Stat
                  label="Suspended mechanics"
                  value={count(q.suspended_mechanics.length)}
                  tone={q.suspended_mechanics.length ? 'bad' : 'muted'}
                  hint="Paying nothing, accepting nothing."
                />
                <Stat
                  label="Frozen players"
                  value={count(q.frozen_players.length)}
                  tone={q.frozen_players.length ? 'bad' : 'muted'}
                  hint="Paused pending review. Not banned."
                />
                <Stat
                  label="Withheld payouts"
                  value={count(q.withheld_payouts.length)}
                  tone={q.withheld_payouts.length ? 'bad' : 'muted'}
                  hint="Owed, unsettled, awaiting a signed card."
                />
                <Stat
                  label="Player anomalies"
                  value={count(q.player_anomalies.length)}
                  tone={q.player_anomalies.length ? 'bad' : 'muted'}
                  hint="Evidence, never a verdict."
                />
              </div>

              {q.suspended_mechanics.length > 0 && (
                <SubSection
                  title="Suspended mechanics"
                  right={
                    <Link
                      href="/chance/exposure"
                      className="text-sky-300 hover:text-white text-xs underline underline-offset-2"
                    >
                      What tripped, and resume →
                    </Link>
                  }
                >
                  <ul className="space-y-1.5">
                    {q.suspended_mechanics.map((m) => (
                      <li
                        key={m.mechanic_id}
                        className="flex items-start gap-2 text-sm bg-red-500/5 border border-red-500/30 rounded-lg px-3 py-2"
                      >
                        <Pause size={14} className="text-red-300 mt-0.5 shrink-0" />
                        <span>
                          <span className="text-white font-medium">{m.name}</span>{' '}
                          <span className="text-red-200/80">
                            — {m.suspended.automatic ? 'auto-suspended' : 'stopped by hand'}{' '}
                            {relativeTime(m.suspended.at)}: {m.suspended.reason}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </SubSection>
              )}

              <SubSection
                title="Frozen players"
                hint="A freeze stops a player opening or playing a round, and that is all it does. No balance moves, no settled round is reversed, and the account is not banned. It never expires on its own — a timer means nobody ever has to look."
              >
                {q.frozen_players.length === 0 ? (
                  <ReadOnlyNote>Nobody is frozen.</ReadOnlyNote>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[720px]">
                      <thead>
                        <tr className="text-slate-500 text-[11px] uppercase tracking-wide border-b border-slate-800">
                          <th className="text-left font-medium py-2 pr-3">Player</th>
                          <th className="text-left font-medium py-2 px-3">Frozen</th>
                          <th className="text-left font-medium py-2 px-3">By</th>
                          <th className="text-left font-medium py-2 px-3">Reason</th>
                          <th className="text-right font-medium py-2 pl-3" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {q.frozen_players.map((f) => (
                          <tr key={f.id}>
                            <td className="py-2 pr-3 font-mono text-slate-200 text-xs">{f.id}</td>
                            <td className="py-2 px-3 text-slate-400 text-xs">
                              {dateTime(f.flagged_at)}
                            </td>
                            <td className="py-2 px-3 text-slate-400 text-xs">
                              {f.flagged_by.name}
                            </td>
                            <td className="py-2 px-3 text-slate-300">{f.reason}</td>
                            <td className="py-2 pl-3 text-right">
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  onClick={() => { setUid(f.id); setLookup(f.id) }}
                                  className="text-sky-300 hover:text-white text-xs underline underline-offset-2"
                                >
                                  Evidence
                                </button>
                                {canFreeze && (
                                  <button
                                    onClick={() => setFreezing({ uid: f.id, frozen: true })}
                                    className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg px-2.5 py-1.5 text-xs"
                                  >
                                    <Sun size={12} /> Unfreeze
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </SubSection>

              <SubSection
                title="Withheld payouts"
                hint="A payout that crossed a ceiling was paid down to the headroom that was left and the shortfall recorded. Withheld diamonds are never written off and never silently credited — each one is an exception for a person to settle on a signed card (8B.7.5)."
              >
                {q.withheld_payouts.length === 0 ? (
                  <ReadOnlyNote>Nothing is withheld.</ReadOnlyNote>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[820px]">
                      <thead>
                        <tr className="text-slate-500 text-[11px] uppercase tracking-wide border-b border-slate-800">
                          <th className="text-left font-medium py-2 pr-3">Round</th>
                          <th className="text-left font-medium py-2 px-3">Mechanic</th>
                          <th className="text-left font-medium py-2 px-3">Player</th>
                          <th className="text-right font-medium py-2 px-3">Would have paid</th>
                          <th className="text-right font-medium py-2 px-3">Paid</th>
                          <th className="text-right font-medium py-2 px-3">Withheld</th>
                          <th className="text-left font-medium py-2 pl-3">When</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {q.withheld_payouts.map((w) => (
                          <tr key={w.round_id}>
                            <td className="py-2 pr-3 font-mono text-slate-400 text-xs">
                              {w.round_id.slice(0, 12)}…
                            </td>
                            <td className="py-2 px-3 text-slate-300">{w.mechanic_id}</td>
                            <td className="py-2 px-3 font-mono text-slate-400 text-xs">
                              {w.player_uid}
                            </td>
                            <td className="py-2 px-3 text-right text-slate-400 tabular-nums">
                              {diamonds(w.would_have_paid)}
                            </td>
                            <td className="py-2 px-3 text-right text-slate-300 tabular-nums">
                              {diamonds(w.paid)}
                            </td>
                            <td className="py-2 px-3 text-right text-red-300 font-medium tabular-nums">
                              {diamonds(w.withheld)}
                            </td>
                            <td className="py-2 pl-3 text-slate-500 text-xs">
                              {dateTime(w.played_at)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </SubSection>

              <SubSection
                title="Player anomalies"
                hint="Three questions about one player: an unusual win rate at five sigma, a frequency above what a person can produce, and timings that could not have happened. Evidence, never a verdict — nothing here freezes anybody."
              >
                {q.player_anomalies.length === 0 ? (
                  <ReadOnlyNote>
                    Nobody&apos;s figures look unlike anybody else&apos;s in this window.
                  </ReadOnlyNote>
                ) : (
                  <div className="space-y-2">
                    {q.player_anomalies.map((a) => (
                      <div
                        key={a.player_uid}
                        className="bg-amber-500/5 border border-amber-500/30 rounded-lg px-3.5 py-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-white text-sm font-medium font-mono">
                            {a.player_uid}
                            {a.frozen && (
                              <span className="ml-2 text-[11px] font-sans bg-sky-500/15 text-sky-200 border border-sky-500/40 rounded-full px-2 py-0.5">
                                already frozen
                              </span>
                            )}
                          </p>
                          <button
                            onClick={() => { setUid(a.player_uid); setLookup(a.player_uid) }}
                            className="text-amber-300 hover:text-white text-xs underline underline-offset-2"
                          >
                            Open the evidence →
                          </button>
                        </div>
                        <ul className="mt-1.5 space-y-1">
                          {a.findings.map((f, i) => (
                            <li key={i} className="text-amber-100 text-xs leading-relaxed">
                              · <span className="text-amber-300">{f.spec}</span> {f.detail}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </SubSection>

              <p className="text-slate-500 text-xs leading-relaxed">{q.note}</p>
            </div>
          )}
        </ReadPanel>
      </Panel>

      {/* ══ One player ═══════════════════════════════════════════════════ */}
      <Panel
        title="One player's figures"
        subtitle="Reading this changes nothing about the account. It is the same standardised comparison the mechanic-level monitor uses, at a higher bar, because the test runs against every active player every day."
      >
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={uid}
            onChange={(e) => setUid(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') setLookup(uid.trim()) }}
            placeholder="Player uid"
            className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-sky-500"
          />
          <button
            onClick={() => setLookup(uid.trim())}
            disabled={!uid.trim()}
            className="flex items-center justify-center gap-2 bg-sky-600 hover:bg-sky-500 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded-lg px-4 py-2.5 text-sm font-medium"
          >
            <Search size={14} /> Look
          </button>
        </div>

        {lookup && (
          <div className="mt-4">
            <ReadPanel
              result={anomalies}
              what="this player's figures"
              loadingLabel="Reading their rounds…"
              onRetry={loadAnomalies}
            >
              {(a) => (
                <div className="space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="flex items-center gap-2 text-white font-medium">
                      <User size={15} className="text-slate-500" />
                      <span className="font-mono text-sm">{a.player_uid}</span>
                      {a.frozen ? (
                        <span className="text-[11px] bg-sky-500/15 text-sky-200 border border-sky-500/40 rounded-full px-2 py-0.5">
                          frozen
                        </span>
                      ) : a.flagged ? (
                        <span className="text-[11px] bg-amber-500/15 text-amber-200 border border-amber-500/40 rounded-full px-2 py-0.5">
                          flagged
                        </span>
                      ) : null}
                    </p>
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/chance/protection/?player=${encodeURIComponent(a.player_uid)}`}
                        className="text-sky-300 hover:text-white text-xs underline underline-offset-2"
                      >
                        Their protections →
                      </Link>
                      {canFreeze && (
                        <button
                          onClick={() => setFreezing({ uid: a.player_uid, frozen: a.frozen })}
                          className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium ${
                            a.frozen
                              ? 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                              : 'bg-sky-600 hover:bg-sky-500 text-white'
                          }`}
                        >
                          {a.frozen ? <Sun size={14} /> : <Snowflake size={14} />}
                          {a.frozen ? 'Unfreeze' : 'Freeze pending review'}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                    <Stat label="Rounds" value={count(a.rounds)} tone="muted" hint={`last ${a.window_hours}h`} />
                    <Stat label="Staked" value={diamonds(a.staked)} unit="dmd" />
                    <Stat label="Paid out" value={diamonds(a.paid_out)} unit="dmd" />
                    <Stat
                      label="Net to the house"
                      value={diamonds(a.net)}
                      unit="dmd"
                      tone={a.net >= 0 ? 'good' : 'bad'}
                    />
                    <Stat
                      label="Their return"
                      value={
                        a.win_rate.actual_rtp_percent === null
                          ? '—'
                          : `${a.win_rate.actual_rtp_percent}%`
                      }
                      hint={
                        a.win_rate.configured_rtp_percent === null
                          ? 'Nothing staked.'
                          : `against a configured ${a.win_rate.configured_rtp_percent}%`
                      }
                    />
                  </div>

                  <SubSection title="Their win rate, judged the same way a mechanic's is">
                    <PooledVerdict d={a.win_rate} />
                  </SubSection>

                  <SubSection title="Findings">
                    {a.findings.length === 0 ? (
                      <ReadOnlyNote>
                        Nothing was found. Their figures look like everybody
                        else&apos;s in this window.
                      </ReadOnlyNote>
                    ) : (
                      <ul className="space-y-2">
                        {a.findings.map((f, i) => (
                          <li
                            key={i}
                            className="bg-amber-500/5 border border-amber-500/30 rounded-lg px-3.5 py-3"
                          >
                            <p className="flex items-center gap-2 text-amber-100 text-sm font-medium">
                              <AlertTriangle size={14} className="text-amber-300" />
                              {f.kind.replace(/_/g, ' ')}
                              <span className="text-amber-400/60 text-xs font-normal">{f.spec}</span>
                            </p>
                            <p className="text-amber-100/90 text-sm mt-1 leading-relaxed">
                              {f.detail}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </SubSection>

                  <p className="text-slate-500 text-xs leading-relaxed">{a.note}</p>
                </div>
              )}
            </ReadPanel>
          </div>
        )}
      </Panel>

      {freezing && (
        <ChanceReasonModal
          title={
            freezing.frozen
              ? `End the freeze on ${freezing.uid}`
              : `Pause chance activity for ${freezing.uid}`
          }
          confirmLabel={freezing.frozen ? 'Unfreeze, with this reason' : 'Freeze pending review'}
          tone={freezing.frozen ? 'caution' : 'danger'}
          what={
            freezing.frozen ? (
              <>
                <p>
                  This ends the freeze and lets them open and play rounds again. It
                  is a review decision with your name on it — a freeze never expires
                  by itself, for the same reason a suspension never does.
                </p>
                <p>
                  Nothing about their balance changes now, and nothing about it
                  changed when the freeze was applied.
                </p>
              </>
            ) : (
              <>
                <p>
                  This stops them opening or playing a chance round, and{' '}
                  <strong>that is all it does</strong>. No balance moves, no settled
                  round is reversed or amended, and the account is{' '}
                  <strong>not banned</strong> — every other part of the product is
                  unaffected. They can still buy, gift, call and watch.
                </p>
                <p>
                  It does not expire. Somebody — you or another Ops reviewer — has to
                  come back and end it with a reason.
                </p>
              </>
            )
          }
          onClose={() => setFreezing(null)}
          onSubmit={async (reason) => {
            if (freezing.frozen) {
              await chance.unfreeze(freezing.uid, reason)
              setNotice(`${freezing.uid} is no longer frozen. No balance moved either way.`)
            } else {
              await chance.freeze(freezing.uid, reason)
              setNotice(
                `${freezing.uid} is frozen for chance mechanics only. No balance moved and the account is not banned.`,
              )
            }
            setFreezing(null)
            loadQueue()
            loadAnomalies()
          }}
        />
      )}
    </div>
  )
}

/** `useSearchParams` needs a Suspense boundary under `output: 'export'`. */
export default function ChanceMonitoringPage() {
  return (
    <Suspense fallback={<Loading label="Reading the monitors…" />}>
      <MonitoringScreen />
    </Suspense>
  )
}

// ══════════════════════════════════════════════════════════════════════════════

/**
 * One bucket's verdict, in the shape 8B.5.1 asks for: the measurement, the bound
 * it carries, and — when the sample is too small — a refusal to call it anything.
 */
function PooledVerdict({ d }: { d: Divergence }) {
  const tooSmall = !d.enough_rounds
  const tone = tooSmall ? 'caution' : d.divergent ? 'bad' : 'good'
  const ring =
    tone === 'bad'
      ? 'bg-red-500/10 border-red-500/40'
      : tone === 'caution'
        ? 'bg-amber-500/10 border-amber-500/30'
        : 'bg-emerald-500/10 border-emerald-500/30'
  const text =
    tone === 'bad' ? 'text-red-100' : tone === 'caution' ? 'text-amber-100' : 'text-emerald-100'

  return (
    <div className="space-y-3">
      <div className={`border rounded-xl px-4 py-3.5 ${ring}`}>
        <p className={`text-sm font-semibold ${text}`}>{d.verdict}</p>
        {tooSmall && (
          <p className="text-amber-300/80 text-xs mt-1.5 leading-relaxed">
            {count(d.rounds)} rounds against a minimum of {count(d.min_rounds)}. A small
            sample diverges by a lot and that is not evidence of anything. Nothing is
            alerted on below the minimum, however extreme the figure looks.
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat
          label="Configured"
          value={d.configured_rtp_percent === null ? '—' : `${d.configured_rtp_percent}%`}
          hint="From the signed table those rounds were drawn from."
        />
        <Stat
          label="Actual"
          value={d.actual_rtp_percent === null ? '—' : `${d.actual_rtp_percent}%`}
          tone={d.divergent ? 'bad' : 'plain'}
          hint={
            d.confidence_low_ppm === null
              ? 'Nothing was staked.'
              : `± ${ppmPercent(d.confidence_band_ppm)} — honestly anywhere in ${ppmPercent(d.confidence_low_ppm)} to ${ppmPercent(d.confidence_high_ppm)}`
          }
        />
        <Stat
          label="Configured inside the bound"
          value={
            d.configured_inside_band === null
              ? '—'
              : d.configured_inside_band
                ? 'yes'
                : 'no'
          }
          tone={
            d.configured_inside_band === null
              ? 'muted'
              : d.configured_inside_band
                ? 'good'
                : 'bad'
          }
          hint="Whether what was signed is a plausible explanation of what happened."
        />
        <Stat
          label="Standard deviations"
          value={d.z}
          tone={d.divergent ? 'bad' : 'muted'}
          hint={`Threshold ${d.sigma_threshold_milli / 1000}σ · ${count(d.rounds)} rounds · expected payout ${diamonds(d.expected_payout)}`}
        />
      </div>
    </div>
  )
}
