'use client'

/**
 * Scheduled job health — "is any of this actually running?"
 *
 * Nothing in this system schedules itself. Cloud Scheduler fires a Cloud
 * Function, the function calls an endpoint, and the endpoint records a run. Any
 * one of those three can be missing, and when one is, the symptom is silence —
 * which looks exactly like a quiet week.
 *
 * So `/runs/last` keeps five outcomes apart and this page keeps them apart too:
 *
 *   ok        it ran and everything in it worked
 *   degraded  it ran, delivered what it could, and something in it did not.
 *             Not a success and not a failure; collapsing it into either is how
 *             a report that has been missing a section for a month goes unnoticed
 *   failed    it raised and sent nothing
 *   never     no run has ever been recorded — the schedule was never wired up.
 *             This is the failure mode nobody notices, so it is the loudest
 *             thing on the page
 *   unknown   the run log itself could not be read. It says nothing about
 *             whether the job ran
 *
 * `stalled` is set independently of all five: a job whose last run was `ok`
 * three weeks ago is not a healthy job, and it is rendered as loudly as `never`.
 *
 * Re-running is offered where the API has a trigger for it, behind a confirm
 * with a reason, and it is stated plainly that the run will be recorded as
 * person-triggered. A Sunday that ran twice because somebody re-ran it is a
 * different fact from one that ran twice because the scheduler retried.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlarmClock, AlertTriangle, CheckCircle2, ChevronRight, CircuitBoard, Clock,
  ExternalLink, Loader2, Play, RefreshCw, Timer, XCircle,
} from 'lucide-react'

import { useAuth } from '@/components/AuthProvider'
import { ApiError, type ApiRole } from '@/lib/api'
import { Denied, ErrorState, Loading, Warning } from '@/components/ui/States'
import {
  JobHealth, JobRunResult, LastRuns, RunRow, ScheduleResponse,
  formatCount, formatDateTime, notifications,
} from '@/lib/apiReports'

const MIN_REASON = 8

// ── Authority ─────────────────────────────────────────────────────────────────
//
// `/runs/last`, `/runs` and `/schedule` are `require_internal` and then
// `_require_oversight` (backend/app/routers/notifications.py:59, 505, 530, 580)
// — owners, the Observer and team admins.
//
// The triggers are a different rule. Each is `_person_or_service(...)` whose
// person fallback is `require_team_admin` (backend/app/core/deps.py:139-158),
// which admits team admins and owners and NOT the Observer. So the Observer
// reads this page in full and is offered no re-run at all, rather than being
// shown a button that would answer 403.

function isTeamAdmin(role: ApiRole): boolean {
  return role.endsWith('_admin')
}

function canRead(role: ApiRole): boolean {
  return role === 'owner' || role === 'observer' || isTeamAdmin(role)
}

function canTrigger(role: ApiRole): boolean {
  return role === 'owner' || isTeamAdmin(role)
}

// ── Which jobs can be re-run from here ────────────────────────────────────────
//
// Keyed on `SCHEDULE[].job` (backend/app/services/scheduling.py:1941). A job id
// that is not in this map gets no button — the endpoint string on the row is
// documentation, not something to POST blindly.

type Trigger = (opts: { period?: string }) => Promise<JobRunResult>

const TRIGGERS: Record<string, { run: Trigger; what: string }> = {
  daily: {
    run: () => notifications.jobs.daily(),
    what:
      'Rebuilds yesterday’s business summary, the Finance worklist and the ' +
      'exception report, and sends anything that has not already gone out. ' +
      'Each email carries a dedupe key on the report and the date, so a second ' +
      'run sends nothing twice — but a run after a mail outage does deliver.',
  },
  monthly: {
    run: () => notifications.jobs.monthly({ with_statements: true }),
    what:
      'Rebuilds last calendar month: the P&L, the accounting pack, the audit ' +
      'summary, and every partner’s formal monthly statement. Partners are ' +
      'emailed their own statement by this run.',
  },
  'partner-statements': {
    run: (o) =>
      notifications.jobs.partnerStatements({
        period: o.period ?? 'last-week',
        cadence: o.period === 'last-month' ? 'monthly' : 'weekly',
        kind: 'both',
      }),
    what:
      'Sends every approved agency and seller their own statement for the ' +
      'chosen period. This one reaches people outside the company.',
  },
  alerts: {
    run: () => notifications.jobs.alerts({}),
    what:
      'Runs every exception detector and emails what is newly true. Repeats ' +
      'inside a detector’s window are suppressed, so this does not spray the ' +
      'same alert again.',
  },
  'transactional-sweep': {
    run: () => notifications.jobs.transactionalSweep({}),
    what:
      'Sends every transactional email a record says is owed and the delivery ' +
      'log says has not gone out — rejections, payout approvals, payout ' +
      'receipts, credit reminders. Idempotent by dedupe key.',
  },
}

/** The weekly business report is triggered from its own screen, where the week
 *  and the revision are chosen. Pointing at it beats a half-configured button. */
const WEEKLY_JOB = 'weekly-business'

// ── Status presentation ───────────────────────────────────────────────────────

interface Skin {
  card: string
  pill: string
  label: string
  meaning: string
}

function skinFor(row: JobHealth): Skin {
  if (row.stalled) {
    return {
      card: 'border-red-500/50 bg-red-500/[0.04]',
      pill: 'bg-red-500/15 text-red-300 border-red-500/40',
      label: 'STALLED',
      meaning:
        'The last run is older than this job should ever be silent for. Whatever ' +
        'that run said about itself, the schedule has stopped firing it.',
    }
  }
  switch (row.status) {
    case 'never':
      return {
        card: 'border-red-500/50 bg-red-500/[0.04]',
        pill: 'bg-red-500/15 text-red-300 border-red-500/40',
        label: 'NEVER RUN',
        meaning:
          'No run has ever been recorded. That is a deployment that was not ' +
          'finished, not a period with nothing in it.',
      }
    case 'failed':
      return {
        card: 'border-red-500/40',
        pill: 'bg-red-500/15 text-red-300 border-red-500/35',
        label: 'failed',
        meaning: 'It raised and sent nothing.',
      }
    case 'degraded':
      return {
        card: 'border-amber-500/40',
        pill: 'bg-amber-500/15 text-amber-200 border-amber-500/35',
        label: 'degraded',
        meaning:
          'It ran, delivered what it could, and something in it did not. Not a ' +
          'success and not a failure.',
      }
    case 'ok':
      return {
        card: 'border-slate-800',
        pill: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
        label: 'ok',
        meaning: 'It ran and everything in it worked.',
      }
    default:
      return {
        card: 'border-orange-500/40',
        pill: 'bg-orange-500/15 text-orange-200 border-orange-500/35',
        label: row.status || 'unknown',
        meaning:
          'The run log could not be read. This says nothing about whether the ' +
          'job actually ran.',
      }
  }
}

function ageText(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || Number.isNaN(hours)) return '—'
  if (hours < 1) return `${Math.round(hours * 60)} min ago`
  if (hours < 48) return `${hours.toFixed(1)} h ago`
  return `${(hours / 24).toFixed(1)} days ago`
}

// ── Confirm ───────────────────────────────────────────────────────────────────

function RunModal({
  job, busy, error, onClose, onRun,
}: {
  job: JobHealth
  busy: boolean
  error: string
  onClose: () => void
  onRun: (opts: { period?: string }) => void
}) {
  const [reason, setReason] = useState('')
  const [period, setPeriod] = useState('last-week')
  const ready = reason.trim().length >= MIN_REASON
  const spec = TRIGGERS[job.job]
  const needsPeriod = job.job === 'partner-statements'

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg">
        <div className="px-6 py-4 border-b border-slate-800">
          <h3 className="text-white font-semibold">Run &ldquo;{job.job}&rdquo; now</h3>
          <p className="text-slate-500 text-sm mt-1 leading-relaxed">{job.covers}</p>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3.5 py-3">
            <p className="text-amber-100 text-sm leading-relaxed">
              <span className="font-semibold">This sends real email.</span>{' '}
              {spec?.what}
            </p>
            <p className="text-amber-100/80 text-sm mt-2 leading-relaxed">
              It will be recorded on the run log as a{' '}
              <span className="font-semibold">person-triggered</span> run, against
              your name — not as the schedule firing. That distinction is the
              point of the field.
            </p>
          </div>

          {needsPeriod && (
            <div>
              <label className="block text-slate-400 text-xs font-medium uppercase tracking-wide mb-1.5">
                Period
              </label>
              <select
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500"
              >
                <option value="last-week">
                  last-week — the ISO week that closed, sent at the weekly cadence
                </option>
                <option value="last-month">
                  last-month — the last complete calendar month, monthly cadence
                </option>
              </select>
              <p className="text-slate-600 text-xs mt-1 leading-relaxed">
                The API resolves the dates from this name, so the window on a
                statement and the window on the commission inside it come from the
                same place. The cadence goes into the dedupe key, so the weekly
                and monthly statements are two statements, not a duplicate.
              </p>
            </div>
          )}

          <div>
            <label className="block text-slate-400 text-xs font-medium uppercase tracking-wide mb-1.5">
              Why are you running this by hand?
              <span className="text-pink-400 ml-1 normal-case">(required)</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="SendGrid was returning 403 all morning; the key is fixed and these are owed."
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
            />
            <p className="text-slate-600 text-xs mt-1 leading-relaxed">
              At least {MIN_REASON} characters. The run log stores who triggered
              this and that a person did; the trigger endpoints carry no field for
              the reason itself, so this stays on this screen.
            </p>
          </div>

          {error && (
            <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3.5 py-3">
              <AlertTriangle size={15} className="text-red-400 mt-0.5 shrink-0" />
              <p className="text-red-300 text-sm leading-relaxed break-words">{error}</p>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-800 flex gap-3">
          <button
            onClick={onClose}
            disabled={busy}
            className="text-slate-400 hover:text-white text-sm px-4 py-2.5 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={() => onRun({ period: needsPeriod ? period : undefined })}
            disabled={busy || !ready}
            title={ready ? undefined : `Give a reason of at least ${MIN_REASON} characters first.`}
            className="flex-1 flex items-center justify-center gap-2 bg-pink-600 hover:bg-pink-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
            Run it now
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

type Slot<T> =
  | { status: 'loading' }
  | { status: 'ok'; value: T }
  | { status: 'error'; message: string }

export default function JobHealthPage() {
  const { apiUser, apiReady, apiError, loading: authLoading } = useAuth()

  const [last, setLast] = useState<Slot<LastRuns>>({ status: 'loading' })
  const [sched, setSched] = useState<Slot<ScheduleResponse>>({ status: 'loading' })
  const [history, setHistory] = useState<Slot<RunRow[]>>({ status: 'loading' })
  const [expanded, setExpanded] = useState<string | null>(null)

  const [confirming, setConfirming] = useState<JobHealth | null>(null)
  const [runBusy, setRunBusy] = useState(false)
  const [runError, setRunError] = useState('')
  const [runResult, setRunResult] = useState<{ job: string; result: JobRunResult } | null>(null)

  const role = apiUser?.role ?? null
  const allowed = role !== null && canRead(role)
  const mayTrigger = role !== null && canTrigger(role)

  const load = useCallback(() => {
    if (!allowed || !apiReady) return

    function run<T>(p: Promise<T>, set: (s: Slot<T>) => void, what: string) {
      set({ status: 'loading' })
      p.then((value) => set({ status: 'ok', value })).catch((err: unknown) =>
        set({
          status: 'error',
          message: err instanceof ApiError ? err.message : `The ${what} could not be read.`,
        }),
      )
    }

    run(notifications.lastRuns(), setLast, 'job health')
    run(notifications.schedule(), setSched, 'schedule')
    run(notifications.runs({ limit: 100 }).then((r) => r.runs), setHistory, 'run log')
  }, [allowed, apiReady])

  useEffect(() => { load() }, [load])

  async function trigger(opts: { period?: string }) {
    if (!confirming) return
    const spec = TRIGGERS[confirming.job]
    if (!spec) return
    setRunBusy(true)
    setRunError('')
    try {
      const result = await spec.run(opts)
      setRunResult({ job: confirming.job, result })
      setConfirming(null)
      load()
    } catch (err) {
      setRunError(
        err instanceof ApiError
          ? err.message
          : 'The job could not be started and nothing was sent.',
      )
    } finally {
      setRunBusy(false)
    }
  }

  const jobs = last.status === 'ok' ? last.value.jobs : []

  /** `SCHEDULE[].run_job` per job id, so the run log can be filtered per job. */
  const runJobOf = useMemo(() => {
    const m = new Map<string, string>()
    if (sched.status === 'ok') sched.value.jobs.forEach((j) => m.set(j.job, j.run_job))
    return m
  }, [sched])

  if (authLoading) return <Loading label="Checking your access…" />
  if (!apiReady && apiError) return <ErrorState message={apiError} />
  if (!apiReady) return <Loading label="Waiting for the API session…" />
  if (!allowed) return <Denied what="scheduled job health" />

  const attention = last.status === 'ok' ? last.value.needs_attention : []
  const neverRan = jobs.filter((j) => j.status === 'never')
  const stalled = jobs.filter((j) => j.stalled)

  return (
    <div className="max-w-[1600px] mx-auto space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Scheduled jobs</h1>
          <p className="text-slate-400 mt-1 text-sm max-w-3xl leading-relaxed">
            Every job that is supposed to run, when it last did, and whether it
            worked. Nothing here schedules itself — Cloud Scheduler fires a Cloud
            Function, which calls the endpoint on each row. A job that has never
            run means that chain was never finished.
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3.5 py-2.5 text-sm transition-colors shrink-0"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {role === 'observer' && (
        <Warning>
          You are signed in as the Observer. Every job&rsquo;s state is readable to
          you; running one is a team admin or owner action, so no re-run is
          offered.
        </Warning>
      )}

      {last.status === 'error' && <ErrorState message={last.message} onRetry={load} />}
      {last.status === 'loading' && <Loading label="Reading the run log…" />}

      {last.status === 'ok' && (
        <>
          {/* The two states nobody notices */}
          {neverRan.length > 0 && (
            <div className="bg-red-500/10 border border-red-500/50 rounded-xl px-5 py-4 flex items-start gap-3">
              <XCircle size={18} className="text-red-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-red-200 font-semibold">
                  {neverRan.length} job{neverRan.length === 1 ? ' has' : 's have'} never
                  run: {neverRan.map((j) => j.job).join(', ')}.
                </p>
                <p className="text-red-200/80 text-sm mt-1 leading-relaxed">
                  This is not a quiet period. Nothing has ever fired these, so
                  nothing they would have sent has ever been sent and nothing they
                  would have detected has ever been detected. Check that the Cloud
                  Function on each row is deployed and holds the reporting key.
                </p>
              </div>
            </div>
          )}

          {stalled.length > 0 && (
            <div className="bg-red-500/10 border border-red-500/50 rounded-xl px-5 py-4 flex items-start gap-3">
              <AlarmClock size={18} className="text-red-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-red-200 font-semibold">
                  {stalled.length} job{stalled.length === 1 ? ' has' : 's have'} stopped
                  firing: {stalled.map((j) => j.job).join(', ')}.
                </p>
                <p className="text-red-200/80 text-sm mt-1 leading-relaxed">
                  The last run is older than the job&rsquo;s own cadence allows.
                  Whatever that run said about itself, the schedule is not firing
                  it any more.
                </p>
              </div>
            </div>
          )}

          {attention.length === 0 && jobs.length > 0 && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl px-5 py-4 flex items-start gap-3">
              <CheckCircle2 size={17} className="text-emerald-400 mt-0.5 shrink-0" />
              <p className="text-slate-300 text-sm leading-relaxed">
                Every scheduled job has run inside its own cadence and its last run
                was clean. {last.value.note}
              </p>
            </div>
          )}

          {/* What a manual run just did */}
          {runResult && (
            <RunOutcome
              job={runResult.job}
              result={runResult.result}
              onDismiss={() => setRunResult(null)}
            />
          )}

          <p className="text-slate-600 text-xs">
            Times are shown in your browser&rsquo;s zone; every cron below is read
            in {last.value.timezone}, and each job&rsquo;s period is cut in the
            same zone.
          </p>

          {/* The jobs */}
          <div className="space-y-3">
            {jobs.map((job) => {
              const skin = skinFor(job)
              const runJob = runJobOf.get(job.job)
              const runnable = mayTrigger && !!TRIGGERS[job.job]
              const isWeekly = job.job === WEEKLY_JOB
              const open = expanded === job.job
              const rows =
                history.status === 'ok' && runJob
                  ? history.value.filter((r) => r.job === runJob)
                  : []

              return (
                <section
                  key={job.job}
                  className={`bg-slate-900 border rounded-xl overflow-hidden ${skin.card}`}
                >
                  <div className="px-5 py-4">
                    <div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-block border rounded px-1.5 py-0.5 text-xs font-bold tracking-wide ${skin.pill}`}
                          >
                            {skin.label}
                          </span>
                          {job.stalled && job.status !== 'never' && (
                            <span className="text-slate-500 text-xs">
                              last run said &ldquo;{job.status}&rdquo;
                            </span>
                          )}
                          {job.recorded === false && (
                            <span className="inline-block border border-orange-500/40 bg-orange-500/15 text-orange-200 rounded px-1.5 py-0.5 text-xs font-medium">
                              not written to the run log
                            </span>
                          )}
                          <h2 className="text-white font-semibold">{job.job}</h2>
                          <span className="text-slate-600 text-xs">{job.spec}</span>
                        </div>

                        <p className="text-slate-400 text-sm mt-2 leading-relaxed max-w-3xl">
                          {job.covers}
                        </p>
                        <p className="text-slate-500 text-xs mt-1.5 leading-relaxed">
                          {skin.meaning}
                        </p>
                        {job.detail && (
                          <p className="text-amber-200 text-xs mt-1.5 leading-relaxed">
                            {job.detail}
                          </p>
                        )}
                      </div>

                      <div className="shrink-0 flex flex-col items-start xl:items-end gap-2">
                        <div className="text-left xl:text-right">
                          <p className="text-slate-500 text-xs">Last run</p>
                          <p
                            className={`text-sm font-semibold ${
                              job.last_run_at ? 'text-white' : 'text-red-300'
                            }`}
                          >
                            {job.last_run_at ? formatDateTime(job.last_run_at) : 'never'}
                          </p>
                          <p className="text-slate-600 text-xs">
                            {job.last_run_at ? ageText(job.age_hours) : 'no run on record'}
                          </p>
                        </div>

                        {runnable && (
                          <button
                            onClick={() => { setRunError(''); setConfirming(job) }}
                            className="flex items-center gap-1.5 bg-slate-800 hover:bg-pink-600 hover:text-white text-slate-300 rounded-lg px-3 py-2 text-sm transition-colors"
                          >
                            <Play size={14} /> Run it now
                          </button>
                        )}
                        {isWeekly && (
                          <Link
                            href="/reports/weekly"
                            className="flex items-center gap-1.5 text-pink-400 hover:text-pink-300 text-sm underline underline-offset-2"
                          >
                            Open the weekly report <ChevronRight size={13} />
                          </Link>
                        )}
                        {!runnable && !isWeekly && mayTrigger && (
                          <span className="text-slate-600 text-xs">
                            No manual trigger for this one
                          </span>
                        )}
                      </div>
                    </div>

                    {/* The schedule it should be keeping */}
                    <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-2 text-xs border-t border-slate-800 pt-3.5">
                      <Fact icon={<Clock size={12} />} label="Should run" value={job.when} />
                      <Fact
                        icon={<Timer size={12} />}
                        label="Cron"
                        value={`${job.cron} (${job.timezone})`}
                        mono
                      />
                      <Fact
                        icon={<CircuitBoard size={12} />}
                        label="Fired by"
                        value={job.function}
                        mono
                      />
                      <Fact
                        icon={<ExternalLink size={12} />}
                        label="Endpoint"
                        value={job.endpoint}
                        mono
                      />
                    </div>

                    {/* What the last run actually did */}
                    {job.last_run_at && (
                      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs">
                        <span className="text-slate-500">
                          Emails accepted:{' '}
                          <span className="text-slate-300 tabular-nums">
                            {job.emails_accepted === null || job.emails_accepted === undefined
                              ? '—'
                              : formatCount(job.emails_accepted)}
                          </span>
                        </span>
                        <span className="text-slate-500">
                          Triggered by:{' '}
                          <span
                            className={
                              job.trigger === 'person' ? 'text-amber-300' : 'text-slate-300'
                            }
                          >
                            {job.trigger ?? 'unknown'}
                          </span>
                          {job.triggered_by?.name && (
                            <span className="text-slate-400"> — {job.triggered_by.name}</span>
                          )}
                          {job.triggered_by?.service_credential && (
                            <span className="text-slate-500">
                              {' '}({job.triggered_by.service_credential})
                            </span>
                          )}
                        </span>
                        {job.finished_at && (
                          <span className="text-slate-500">
                            Finished:{' '}
                            <span className="text-slate-300">
                              {formatDateTime(job.finished_at)}
                            </span>
                          </span>
                        )}
                      </div>
                    )}

                    {(job.problems?.length ?? 0) > 0 && (
                      <div className="mt-3 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3.5 py-3">
                        <p className="text-amber-100 text-sm font-medium">
                          {job.problems?.length} thing
                          {job.problems?.length === 1 ? '' : 's'} on the last run did
                          not work:
                        </p>
                        <ul className="list-disc pl-4 mt-1.5 space-y-1">
                          {job.problems?.map((p, i) => (
                            <li key={i} className="text-amber-100/90 text-sm leading-relaxed break-words">
                              {p}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <button
                      onClick={() => setExpanded(open ? null : job.job)}
                      className="mt-3 text-slate-500 hover:text-white text-xs underline underline-offset-2"
                    >
                      {open ? 'Hide' : 'Show'} the last runs of{' '}
                      <code>{runJob ?? job.job}</code>
                    </button>
                  </div>

                  {open && (
                    <div className="border-t border-slate-800 bg-slate-950/40 px-5 py-4">
                      {history.status === 'loading' ? (
                        <p className="text-slate-500 text-sm flex items-center gap-2">
                          <Loader2 size={13} className="animate-spin" /> Reading the run log…
                        </p>
                      ) : history.status === 'error' ? (
                        <p className="text-red-300 text-sm">{history.message}</p>
                      ) : !runJob ? (
                        <p className="text-slate-500 text-sm leading-relaxed">
                          The schedule table could not be read, so this job&rsquo;s
                          run-log name is unknown and its history cannot be filtered
                          for. That is a missing lookup, not an absence of runs.
                        </p>
                      ) : rows.length === 0 ? (
                        <p className="text-slate-500 text-sm leading-relaxed">
                          No run of <code>{runJob}</code> is in the most recent 100
                          rows of the run log. Over a busy log that can mean it is
                          simply older than the window — it does not on its own mean
                          it never ran.
                        </p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-left border-b border-slate-800">
                                {['Started', 'Status', 'Trigger', 'Emails', 'Problems'].map((h) => (
                                  <th
                                    key={h}
                                    className="py-2 pr-4 text-slate-500 text-xs font-medium uppercase tracking-wide whitespace-nowrap"
                                  >
                                    {h}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {rows.map((r, i) => (
                                <tr key={`${r.started_at ?? 'undated'}-${i}`} className="border-b border-slate-800/50 last:border-0">
                                  <td className="py-2 pr-4 text-slate-300 whitespace-nowrap">
                                    {formatDateTime(r.started_at)}
                                  </td>
                                  <td className="py-2 pr-4">
                                    <span
                                      className={
                                        r.status === 'ok'
                                          ? 'text-emerald-300'
                                          : r.status === 'degraded'
                                            ? 'text-amber-300'
                                            : 'text-red-300'
                                      }
                                    >
                                      {r.status ?? 'unknown'}
                                    </span>
                                  </td>
                                  <td className="py-2 pr-4">
                                    <span
                                      className={
                                        r.trigger === 'person' ? 'text-amber-300' : 'text-slate-400'
                                      }
                                    >
                                      {r.trigger ?? 'unknown'}
                                    </span>
                                    {r.triggered_by?.name && (
                                      <span className="text-slate-500"> — {r.triggered_by.name}</span>
                                    )}
                                  </td>
                                  <td className="py-2 pr-4 text-slate-300 tabular-nums">
                                    {r.emails_accepted === undefined
                                      ? '—'
                                      : formatCount(r.emails_accepted)}
                                  </td>
                                  <td className="py-2 pr-4 text-slate-400 text-xs">
                                    {r.problems && r.problems.length > 0
                                      ? r.problems.join(' · ')
                                      : '—'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </section>
              )
            })}
          </div>

          {sched.status === 'error' && (
            <Warning>
              The schedule table could not be read: {sched.message} Each job&rsquo;s
              cron and Cloud Function above still come from <code>/runs/last</code>,
              which carries them too — only the run-log lookup is missing.
            </Warning>
          )}

          {sched.status === 'ok' && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl px-5 py-4">
              <p className="text-slate-400 text-sm leading-relaxed max-w-4xl">
                {sched.value.clock}
              </p>
            </div>
          )}
        </>
      )}

      {confirming && (
        <RunModal
          job={confirming}
          busy={runBusy}
          error={runError}
          onClose={() => setConfirming(null)}
          onRun={trigger}
        />
      )}
    </div>
  )
}

function Fact({
  icon, label, value, mono,
}: {
  icon: React.ReactNode
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1 text-slate-600">
        {icon} {label}
      </p>
      <p className={`text-slate-300 mt-0.5 break-words ${mono ? 'font-mono text-[11px]' : ''}`}>
        {value}
      </p>
    </div>
  )
}

/**
 * What a manual run reported.
 *
 * A 200 from a trigger means the job ran, not that everything worked. So the
 * problem list, the failed sections and the "could not be recorded" flag are
 * all shown even on a successful response.
 */
function RunOutcome({
  job, result, onDismiss,
}: {
  job: string
  result: JobRunResult
  onDismiss: () => void
}) {
  const clean = result.status === 'ok' && (result.problems?.length ?? 0) === 0
  return (
    <div
      className={`bg-slate-900 border rounded-xl px-5 py-4 space-y-3 ${
        clean ? 'border-slate-800' : 'border-amber-500/40'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-white font-semibold text-sm">
            {job} ran — status {result.status ?? 'unknown'}.
          </p>
          <p className="text-slate-500 text-xs mt-1 leading-relaxed">
            {formatCount(result.emails_accepted ?? 0)} email
            {result.emails_accepted === 1 ? '' : 's'} accepted by the provider ·
            recorded as a {result.trigger ?? 'unknown'}-triggered run
            {result.triggered_by?.name ? ` by ${result.triggered_by.name}` : ''}. A
            200 means the job ran, not that everything in it worked.
          </p>
        </div>
        <button onClick={onDismiss} className="text-slate-500 hover:text-white text-xs shrink-0">
          Dismiss
        </button>
      </div>

      {result.recorded === false && (
        <div className="bg-red-500/10 border border-red-500/40 rounded-lg px-3.5 py-3">
          <p className="text-red-200 text-sm font-semibold">
            The job ran and its outcome could NOT be written to the run log.
          </p>
          <p className="text-red-200/80 text-sm mt-1 leading-relaxed">
            {result.record_error ??
              'Nothing on this page will show this run. Treat this message as the only record of it.'}
          </p>
        </div>
      )}

      {(result.problems?.length ?? 0) > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3.5 py-3">
          <p className="text-amber-100 text-sm font-medium">This run was not clean:</p>
          <ul className="list-disc pl-4 mt-1.5 space-y-1">
            {result.problems?.map((p, i) => (
              <li key={i} className="text-amber-100/90 text-sm leading-relaxed break-words">
                {p}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
