'use client'

/**
 * Player protection — the review queue, and one player's protections.
 *
 * Two things this screen is careful about.
 *
 * **A flag is not a conclusion.** It says a pattern was seen and asks somebody
 * to look. It leaves `open` only through
 * `POST /api/chance/protection/flags/{id}/review`
 * (`backend/app/routers/chance.py:890`), which needs a decision from a fixed
 * vocabulary and a reason of at least eight characters, recorded against a named
 * person. "No action" is one of those decisions and is recorded exactly as
 * carefully as the others — nothing in this system empties the queue, and there
 * is no route that silently dismisses a flag.
 *
 * **Some of this is not staff's to override.** There is no route in the API that
 * cancels a self-exclusion, none that shortens one, and none that ends a
 * cooling-off period early. Those are rendered read-only and said to be so,
 * because a disabled button invites somebody to go looking for the enabled one.
 * The single exception is `POST …/self-exclusion/decide`
 * (`backend/app/routers/chance.py:938`), which reopens a *served* exclusion only
 * after the player has asked and the reflection period has run — and a refusal
 * to reopen is recorded as carefully as an approval.
 *
 * Reads (`require_internal`):
 *   • `GET /api/chance/protection/flags`          `backend/app/routers/chance.py:853`
 *   • `GET /api/chance/protection/players/{uid}`  `backend/app/routers/chance.py:875`
 * Writes (`require_team_admin`):
 *   • review a flag        `chance.py:890`
 *   • impose loss limits   `chance.py:916`
 *   • decide a lift        `chance.py:938`
 *
 * **None of these routes moves money and none of them can** —
 * `player_protection.py` does not import `app.services.money` and will not.
 */

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  ArrowLeft, Clock, Gavel, HeartPulse, Lock, RefreshCw, Search, ShieldCheck, User,
} from 'lucide-react'

import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { attempt, type ReadResult } from '@/lib/readState'
import { Denied, Loading, Warning } from '@/components/ui/States'
import { ChanceReasonModal } from '@/components/ChanceReasonModal'
import { Panel, ReadPanel, ReadOnlyNote, Stat } from '@/components/ChanceUI'
import { SubSection } from '@/components/ChanceEvaluation'
import {
  CHANCE_READ_ROLES, CHANCE_TEAM_ADMIN_ROLES, PATTERN_LABELS, PROTECTION_DECISIONS,
  chance, count, dateTime, diamonds, relativeTime,
  type FlagStatus, type ProtectionDecision, type ProtectionFlag, type ProtectionRecord,
  type ProtectionWindow,
} from '@/lib/apiChance'

/**
 * Two filters and no "everything", because there is no third state to ask for.
 * `list_protection_flags` defaults `status` to `"open"`
 * (`backend/app/routers/chance.py:855`), so a tab that sent nothing would
 * silently show the open queue while claiming to show both — which is worse
 * than not offering it.
 */
const FILTERS: { value: FlagStatus; label: string; hint: string }[] = [
  { value: 'open', label: 'Open', hint: 'Waiting for a named person to decide.' },
  { value: 'reviewed', label: 'Reviewed', hint: 'A decision is on the record.' },
]

function ProtectionScreen() {
  const { crmUser, apiUser, loading: authLoading, apiReady, apiError } = useAuth()
  const isObserver = apiUser?.role === 'observer'
  const allowed = isObserver || canAccess(crmUser, CHANCE_READ_ROLES)
  const canDecide = canAccess(crmUser, CHANCE_TEAM_ADMIN_ROLES)

  const params = useSearchParams()

  const [status, setStatus] = useState<FlagStatus>('open')
  const [flags, setFlags] = useState<ReadResult<ProtectionFlag[]> | null>(null)

  const [uid, setUid] = useState(params.get('player') ?? '')
  const [lookup, setLookup] = useState(params.get('player') ?? '')
  const [record, setRecord] = useState<ReadResult<ProtectionRecord> | null>(null)

  const [reviewing, setReviewing] = useState<ProtectionFlag | null>(null)
  const [decision, setDecision] = useState<ProtectionDecision>('no_action')
  const [dailyLimit, setDailyLimit] = useState('')
  const [weeklyLimit, setWeeklyLimit] = useState('')
  const [suspendDays, setSuspendDays] = useState('')

  const [imposing, setImposing] = useState(false)
  const [imposeDaily, setImposeDaily] = useState('')
  const [imposeWeekly, setImposeWeekly] = useState('')

  const [deciding, setDeciding] = useState<{ approve: boolean } | null>(null)
  const [notice, setNotice] = useState('')

  const loadFlags = useCallback(() => {
    if (!allowed || !apiReady) return
    setFlags(null)
    attempt(chance.flags({ status, limit: 200 }), 'chance.flags').then(setFlags)
  }, [allowed, apiReady, status])

  const loadRecord = useCallback(() => {
    if (!allowed || !apiReady || !lookup) return
    setRecord(null)
    attempt(chance.protectionRecord(lookup), 'chance.protectionRecord').then(setRecord)
  }, [allowed, apiReady, lookup])

  useEffect(() => { loadFlags() }, [loadFlags])
  useEffect(() => { loadRecord() }, [loadRecord])

  if (authLoading) return <Loading label="Checking your access…" />
  if (!allowed) return <Denied what="player protection" />

  const openReview = (flag: ProtectionFlag) => {
    setDecision('no_action')
    setDailyLimit('')
    setWeeklyLimit('')
    setSuspendDays('')
    setReviewing(flag)
  }

  const reviewInvalid =
    decision === 'limit_imposed' && !dailyLimit.trim() && !weeklyLimit.trim()
      ? 'A limit was chosen but no figure was given, so nothing would be imposed. Name a daily or a weekly limit in diamonds, or choose a different decision.'
      : decision === 'play_suspended' && !suspendDays.trim()
        ? 'Say how many days play is suspended for. Nothing here suspends indefinitely.'
        : null

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
            <HeartPulse size={24} className="text-emerald-400" /> Player protection
          </h1>
          <p className="text-slate-400 mt-1 text-sm max-w-3xl leading-relaxed">
            Flagged players and the pattern of harm that flagged each one. A flag
            is a request for somebody to look, never a conclusion about a person,
            and nothing acts on it until a named reviewer records a decision with
            a reason. Nothing on this page moves a balance.
          </p>
        </div>
        <button
          onClick={() => { loadFlags(); loadRecord() }}
          className="flex items-center gap-2 shrink-0 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3.5 py-2.5 text-sm transition-colors"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {apiReady && apiError && <Warning>{apiError}</Warning>}
      {notice && <Warning onDismiss={() => setNotice('')}>{notice}</Warning>}

      {/* ══ The queue ════════════════════════════════════════════════════ */}
      <Panel
        title="The review queue"
        subtitle="Newest first. Nothing in this system empties it — a flag leaves “open” only through a decision by a named person, and “no action” is one of those decisions."
        right={
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.label}
                onClick={() => setStatus(f.value)}
                title={f.hint}
                className={`rounded-lg border px-2.5 py-1.5 text-xs ${
                  status === f.value
                    ? 'border-emerald-500 bg-emerald-500/10 text-white'
                    : 'border-slate-700 text-slate-400 hover:border-slate-600'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        }
      >
        <ReadPanel
          result={flags}
          what="the review queue"
          loadingLabel="Reading the queue…"
          onRetry={loadFlags}
          isEmpty={(v) => v.length === 0}
          emptyTitle={status === 'open' ? 'Nothing is waiting for a decision' : 'Nothing here'}
          emptyHint={
            status === 'open'
              ? 'An empty queue is a real answer and a good one. It is not the same as a queue that could not be read.'
              : undefined
          }
          emptyIcon={<ShieldCheck size={28} />}
        >
          {(rows) => (
            <div className="space-y-3">
              {rows.map((flag) => (
                <FlagCard
                  key={flag.flag_id}
                  flag={flag}
                  canDecide={canDecide}
                  onReview={() => openReview(flag)}
                  onOpenPlayer={() => { setUid(flag.player_uid); setLookup(flag.player_uid) }}
                />
              ))}
            </div>
          )}
        </ReadPanel>
      </Panel>

      {/* ══ One player ═══════════════════════════════════════════════════ */}
      <Panel
        title="One player's limits and breaks"
        subtitle="The same record the player sees on their own screen, so a support conversation is about one set of figures rather than two."
      >
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={uid}
            onChange={(e) => setUid(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') setLookup(uid.trim()) }}
            placeholder="Player uid"
            className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500"
          />
          <button
            onClick={() => setLookup(uid.trim())}
            disabled={!uid.trim()}
            className="flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded-lg px-4 py-2.5 text-sm font-medium"
          >
            <Search size={14} /> Look
          </button>
        </div>

        {lookup && (
          <div className="mt-4">
            <ReadPanel
              result={record}
              what="this player's protections"
              loadingLabel="Reading their protections…"
              onRetry={loadRecord}
            >
              {(r) => (
                <div className="space-y-6">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="flex items-center gap-2 text-white font-medium">
                      <User size={15} className="text-slate-500" />
                      <span className="font-mono text-sm">{r.player_uid}</span>
                      <span
                        className={`text-[11px] rounded-full border px-2 py-0.5 ${
                          r.can_play
                            ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                            : 'bg-red-500/15 text-red-200 border-red-500/50'
                        }`}
                      >
                        {r.can_play ? 'can play' : 'stopped'}
                      </span>
                    </p>
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/chance/monitoring/?player=${encodeURIComponent(r.player_uid)}`}
                        className="text-emerald-300 hover:text-white text-xs underline underline-offset-2"
                      >
                        Their round figures →
                      </Link>
                      {canDecide && (
                        <button
                          onClick={() => {
                            setImposeDaily('')
                            setImposeWeekly('')
                            setImposing(true)
                          }}
                          className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg px-3 py-2 text-sm"
                        >
                          <Gavel size={14} /> Impose a loss limit
                        </button>
                      )}
                    </div>
                  </div>

                  {r.stopped && (
                    <div className="bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3.5">
                      <p className="text-red-100 text-sm font-semibold">
                        {r.stopped.message ?? 'This account is stopped for chance mechanics.'}
                      </p>
                      <p className="text-red-300/80 text-xs mt-1.5">
                        {r.stopped.kind ? `${r.stopped.kind} · ` : ''}
                        {r.stopped.until ? `until ${dateTime(r.stopped.until)} · ` : ''}
                        {r.stopped.balance_unchanged === false
                          ? 'balance state not stated'
                          : 'the balance is unchanged'}
                        . This is a control, not a fault, and not a ban.
                      </p>
                    </div>
                  )}

                  <SubSection
                    title="Loss limits"
                    hint={r.limits_apply_to}
                  >
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                      <WindowCard w={r.daily} />
                      <WindowCard w={r.weekly} />
                    </div>
                    {r.pending_limit_changes.length > 0 && (
                      <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3.5 py-3 mt-3">
                        <p className="text-amber-200 text-sm font-medium">
                          {count(r.pending_limit_changes.length)} limit change
                          {r.pending_limit_changes.length === 1 ? '' : 's'} waiting out a delay
                        </p>
                        <ul className="mt-1.5 space-y-1">
                          {r.pending_limit_changes.map((p, i) => (
                            <li key={i} className="text-amber-100 text-xs">
                              · {p.window ?? 'window'} → {diamonds(p.amount ?? null)} diamonds,
                              set by {p.source ?? 'the player'}, effective{' '}
                              {p.effective_from_local ?? dateTime(p.effective_from)}
                            </li>
                          ))}
                        </ul>
                        <p className="text-amber-300/70 text-xs mt-2 leading-relaxed">
                          A player&apos;s reduction applies at once; a raise waits out{' '}
                          {r.rules.limit_increase_delay_hours} hours. Staff limits are
                          immediate in both directions, and the lowest limit set by
                          anybody is the one enforced.
                        </p>
                      </div>
                    )}
                  </SubSection>

                  <SubSection
                    title="Self-exclusion"
                    hint="8B.6.2. There is no route in this API that cancels one and none that shortens one."
                  >
                    {!r.self_exclusion ? (
                      <ReadOnlyNote>
                        This player has not excluded themselves.
                      </ReadOnlyNote>
                    ) : (
                      <div className="space-y-3">
                        <div className="bg-slate-950/60 border border-slate-800 rounded-xl px-4 py-3.5">
                          <p className="flex items-center gap-2 text-white text-sm font-medium">
                            <Lock size={14} className="text-slate-500" />
                            {r.self_exclusion.status.replace(/_/g, ' ')}
                            {r.self_exclusion.days ? ` · ${r.self_exclusion.days} days` : ''}
                          </p>
                          <p className="text-slate-300 text-sm mt-1.5 leading-relaxed">
                            {r.self_exclusion.message}
                          </p>
                          <dl className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
                            <Mini label="Started" value={dateTime(r.self_exclusion.started_at)} />
                            <Mini label="Minimum until" value={dateTime(r.self_exclusion.minimum_until)} />
                            <Mini label="Lift requested" value={dateTime(r.self_exclusion.lift_requested_at)} />
                            <Mini label="Reflection until" value={dateTime(r.self_exclusion.reflection_until)} />
                          </dl>
                        </div>

                        {r.self_exclusion.status === 'lift_requested' ? (
                          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3.5">
                            <p className="text-amber-100 text-sm font-medium">
                              This player has asked for their exclusion to be reopened.
                            </p>
                            <p className="text-amber-300/80 text-xs mt-1.5 leading-relaxed">
                              The account stays closed while this is decided. Deciding
                              <strong> not</strong> to reopen it is still a decision and is
                              recorded the same way. The service refuses this before the
                              reflection period has run, and refuses a session with no
                              name on it.
                            </p>
                            {canDecide ? (
                              <div className="flex flex-wrap gap-2 mt-3">
                                <button
                                  onClick={() => setDeciding({ approve: true })}
                                  className="bg-amber-600 hover:bg-amber-500 text-white rounded-lg px-3.5 py-2 text-sm font-medium"
                                >
                                  Reopen the account
                                </button>
                                <button
                                  onClick={() => setDeciding({ approve: false })}
                                  className="bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg px-3.5 py-2 text-sm"
                                >
                                  Refuse to reopen it
                                </button>
                              </div>
                            ) : (
                              <p className="text-amber-300/70 text-xs mt-2">
                                Deciding this is `require_team_admin`, and the service
                                wants a named person.
                              </p>
                            )}
                          </div>
                        ) : (
                          <ReadOnlyNote>
                            Read-only. Nothing on this screen can cancel or shorten a
                            self-exclusion, because there is no endpoint that does. The
                            player asks first, a reflection period of{' '}
                            {r.rules.exclusion_reflection_hours} hours runs, and only then
                            is there a decision to make. A minimum term is{' '}
                            {r.rules.self_exclusion_minimum_days} days and it does not lift
                            on its own.
                          </ReadOnlyNote>
                        )}
                      </div>
                    )}
                  </SubSection>

                  <SubSection
                    title="Cooling-off"
                    hint="8B.6.2. The light tool: unlike a self-exclusion it ends by itself. It still cannot be cancelled early, and there is no endpoint that would."
                  >
                    {!r.cooling_off ? (
                      <ReadOnlyNote>No cooling-off period is running.</ReadOnlyNote>
                    ) : (
                      <div className="bg-slate-950/60 border border-slate-800 rounded-xl px-4 py-3.5">
                        <p className="flex items-center gap-2 text-white text-sm font-medium">
                          <Clock size={14} className="text-slate-500" />
                          Running until {r.cooling_off.until_local || dateTime(r.cooling_off.until)}
                        </p>
                        {r.cooling_off.note && (
                          <p className="text-slate-400 text-sm mt-1">{r.cooling_off.note}</p>
                        )}
                        <p className="text-slate-500 text-xs mt-2">
                          Read-only. It ends by itself at the moment above and not before.
                        </p>
                      </div>
                    )}
                  </SubSection>

                  <SubSection
                    title="Staff suspension"
                    hint="Chance mechanics only, for a stated number of days, imposed by a named person off the back of a flag. No balance moves."
                  >
                    {!r.staff_suspension ? (
                      <ReadOnlyNote>No staff suspension is in force.</ReadOnlyNote>
                    ) : (
                      <div className="bg-red-500/5 border border-red-500/30 rounded-xl px-4 py-3.5">
                        <p className="text-red-100 text-sm font-medium">
                          {r.staff_suspension.days} days, until{' '}
                          {r.staff_suspension.until_local || dateTime(r.staff_suspension.until)}
                        </p>
                        <p className="text-red-200/80 text-sm mt-1">
                          {r.staff_suspension.reason}
                        </p>
                        <p className="text-slate-500 text-xs mt-2">
                          Imposed by {r.staff_suspension.imposed_by.name} on{' '}
                          {dateTime(r.staff_suspension.imposed_at)} · flag{' '}
                          <span className="font-mono">{r.staff_suspension.flag_id}</span>
                        </p>
                      </div>
                    )}
                  </SubSection>

                  <SubSection
                    title="This session"
                    hint={`A reminder is recorded server-side every ${r.rules.session_reminder_minutes} minutes of play whether or not the app asks for it, so a client that never asks is still a client we can prove was told.`}
                  >
                    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                      <Stat
                        label="Active"
                        value={r.session.active ? 'yes' : 'no'}
                        tone={r.session.active ? 'plain' : 'muted'}
                        hint={r.session.started_at ? `since ${relativeTime(r.session.started_at)}` : ''}
                      />
                      <Stat label="Minutes" value={count(r.session.minutes)} tone="muted" />
                      <Stat label="Rounds" value={count(r.session.rounds)} tone="muted" />
                      <Stat label="Reminders sent" value={count(r.session.reminders_sent)} tone="muted" />
                      <Stat
                        label="Plays blocked"
                        value={count(r.blocked_plays)}
                        tone={r.blocked_plays ? 'bad' : 'muted'}
                        hint="Times a protection stopped a play. Not errors."
                      />
                    </div>
                    {r.session.reminder_due && (
                      <p className="text-amber-200 text-sm mt-3">
                        {r.session.reminder_due.message}
                      </p>
                    )}
                  </SubSection>

                  {r.flags && r.flags.length > 0 && (
                    <SubSection title="Their flags">
                      <div className="space-y-3">
                        {r.flags.map((flag) => (
                          <FlagCard
                            key={flag.flag_id}
                            flag={flag}
                            canDecide={canDecide}
                            onReview={() => openReview(flag)}
                          />
                        ))}
                      </div>
                    </SubSection>
                  )}

                  <p className="text-slate-500 text-xs">
                    Times shown in {r.timezone}. Every figure is whole diamonds.
                  </p>
                </div>
              )}
            </ReadPanel>
          </div>
        )}
      </Panel>

      {/* ══ Mutations ════════════════════════════════════════════════════ */}

      {reviewing && (
        <ChanceReasonModal
          title={`Record a decision on ${PATTERN_LABELS[reviewing.pattern] ?? reviewing.pattern}`}
          confirmLabel="Record it against my name"
          tone="caution"
          extraInvalid={reviewInvalid}
          what={
            <>
              <p>
                {reviewing.headline} — seen {count(reviewing.seen)} time
                {reviewing.seen === 1 ? '' : 's'}, first {relativeTime(reviewing.detected_at)}.
              </p>
              <p>
                A flag leaves the queue only through this. The decision comes from a
                fixed vocabulary, the reason is mandatory, and any consequence is
                applied here rather than left as a second action somebody might not
                take. <strong>A flag already reviewed cannot be reviewed again</strong> —
                a second decision would overwrite somebody else&apos;s, and if the
                behaviour continued the honest record is a new flag.
              </p>
            </>
          }
          onClose={() => setReviewing(null)}
          onSubmit={async (reason) => {
            const flagId = reviewing.flag_id
            await chance.reviewFlag(flagId, {
              decision,
              reason,
              daily_limit: decision === 'limit_imposed' && dailyLimit.trim()
                ? Number.parseInt(dailyLimit, 10) : null,
              weekly_limit: decision === 'limit_imposed' && weeklyLimit.trim()
                ? Number.parseInt(weeklyLimit, 10) : null,
              suspend_days: decision === 'play_suspended' && suspendDays.trim()
                ? Number.parseInt(suspendDays, 10) : null,
            })
            setReviewing(null)
            setNotice(`The decision on flag ${flagId} is on the record against your name.`)
            loadFlags()
            loadRecord()
          }}
        >
          <div className="space-y-2">
            <p className="text-slate-300 text-sm font-medium">Decision</p>
            {PROTECTION_DECISIONS.map((d) => (
              <button
                key={d.value}
                type="button"
                onClick={() => setDecision(d.value)}
                className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                  decision === d.value
                    ? 'border-emerald-500 bg-emerald-500/10'
                    : 'border-slate-700 hover:border-slate-600'
                }`}
              >
                <span className="text-white text-sm font-medium block">{d.label}</span>
                <span className="text-slate-500 text-xs block mt-0.5">{d.hint}</span>
              </button>
            ))}

            {decision === 'limit_imposed' && (
              <div className="grid grid-cols-2 gap-2 pt-1">
                <Num label="Daily loss limit" value={dailyLimit} onChange={setDailyLimit} />
                <Num label="Weekly loss limit" value={weeklyLimit} onChange={setWeeklyLimit} />
              </div>
            )}
            {decision === 'play_suspended' && (
              <div className="pt-1">
                <Num label="Days" value={suspendDays} onChange={setSuspendDays} unit="days" />
              </div>
            )}
          </div>
        </ChanceReasonModal>
      )}

      {imposing && lookup && (
        <ChanceReasonModal
          title={`Impose a loss limit on ${lookup}`}
          confirmLabel="Impose it"
          tone="caution"
          extraInvalid={
            !imposeDaily.trim() && !imposeWeekly.trim()
              ? 'Give a daily limit, a weekly one, or both. Leaving both empty would impose nothing.'
              : null
          }
          what={
            <>
              <p>
                Immediate in both directions, unlike a limit the player sets for
                themselves, and recorded against your name with this reason.
              </p>
              <p>
                The player cannot loosen it: the lowest limit set by anybody is the
                one enforced, so they can only ever go below it. Whole diamonds.{' '}
                <strong>No balance moves.</strong>
              </p>
            </>
          }
          onClose={() => setImposing(false)}
          onSubmit={async (reason) => {
            await chance.imposeLimits(lookup, {
              daily: imposeDaily.trim() ? Number.parseInt(imposeDaily, 10) : undefined,
              weekly: imposeWeekly.trim() ? Number.parseInt(imposeWeekly, 10) : undefined,
              reason,
            })
            setImposing(false)
            setNotice(`The limit on ${lookup} is in force and recorded against your name.`)
            loadRecord()
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            <Num label="Daily loss limit" value={imposeDaily} onChange={setImposeDaily} />
            <Num label="Weekly loss limit" value={imposeWeekly} onChange={setImposeWeekly} />
          </div>
        </ChanceReasonModal>
      )}

      {deciding && lookup && (
        <ChanceReasonModal
          title={
            deciding.approve
              ? `Reopen chance mechanics for ${lookup}`
              : `Refuse to reopen ${lookup}`
          }
          confirmLabel={deciding.approve ? 'Reopen the account' : 'Record the refusal'}
          tone={deciding.approve ? 'danger' : 'caution'}
          what={
            deciding.approve ? (
              <>
                <p>
                  This is the only route in the API that can reopen chance mechanics
                  for a player who closed them. It refuses before the player has
                  asked, inside the minimum term, and before the reflection period has
                  run — so if it returns, all three have passed.
                </p>
                <p>
                  What you write is the record of why somebody decided this person
                  should be able to play again.
                </p>
              </>
            ) : (
              <>
                <p>
                  The account stays closed. A refusal to lift is recorded as carefully
                  as an approval, because deciding not to reopen somebody&apos;s
                  account is still a decision and it has your name on it.
                </p>
              </>
            )
          }
          onClose={() => setDeciding(null)}
          onSubmit={async (reason) => {
            await chance.decideLift(lookup, deciding.approve, reason)
            setDeciding(null)
            setNotice(
              deciding.approve
                ? `${lookup} can play chance mechanics again. The decision names you.`
                : `The refusal is on the record. ${lookup} stays closed.`,
            )
            loadRecord()
          }}
        />
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════

function FlagCard({
  flag, canDecide, onReview, onOpenPlayer,
}: {
  flag: ProtectionFlag
  canDecide: boolean
  onReview: () => void
  onOpenPlayer?: () => void
}) {
  const open = flag.status === 'open'
  const evidence = Object.entries(flag.evidence ?? {})

  return (
    <div
      className={`border rounded-xl p-4 ${
        open
          ? flag.severity === 'act'
            ? 'bg-red-500/5 border-red-500/40'
            : 'bg-amber-500/5 border-amber-500/30'
          : 'bg-slate-900 border-slate-800'
      }`}
    >
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-white font-medium text-sm">
              {PATTERN_LABELS[flag.pattern] ?? flag.pattern}
            </span>
            <span
              className={`text-[11px] rounded-full border px-2 py-0.5 ${
                flag.severity === 'act'
                  ? 'bg-red-500/15 text-red-200 border-red-500/50'
                  : 'bg-amber-500/15 text-amber-200 border-amber-500/40'
              }`}
            >
              {flag.severity}
            </span>
            {!open && (
              <span className="text-[11px] rounded-full border border-slate-700 bg-slate-800 text-slate-400 px-2 py-0.5">
                reviewed
              </span>
            )}
          </p>
          <p className="text-slate-300 text-sm mt-1.5 leading-relaxed">{flag.headline}</p>
          <p className="text-slate-500 text-xs mt-1">
            <button
              onClick={onOpenPlayer}
              disabled={!onOpenPlayer}
              className="font-mono hover:text-slate-300 disabled:cursor-default"
            >
              {flag.player_uid}
            </button>{' '}
            · first seen {dateTime(flag.detected_at)} · last {relativeTime(flag.last_seen_at)} ·
            seen {count(flag.seen)}×
          </p>
        </div>
        {open && canDecide && (
          <button
            onClick={onReview}
            className="flex items-center gap-1.5 shrink-0 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg px-3 py-2 text-sm font-medium"
          >
            <Gavel size={14} /> Decide
          </button>
        )}
      </div>

      {evidence.length > 0 && (
        <div className="overflow-x-auto mt-3">
          <table className="w-full text-xs min-w-[420px]">
            <tbody className="divide-y divide-slate-800/60">
              {evidence.map(([key, value]) => (
                <tr key={key}>
                  <td className="py-1.5 pr-3 text-slate-500 align-top w-1/3">
                    {key.replace(/_/g, ' ')}
                  </td>
                  <td className="py-1.5 text-slate-300 break-words">
                    {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {flag.review ? (
        <div className="bg-slate-950/60 border border-slate-800 rounded-lg px-3.5 py-3 mt-3">
          <p className="text-slate-200 text-sm font-medium">
            {PROTECTION_DECISIONS.find((d) => d.value === flag.review?.decision)?.label ??
              flag.review.decision}
          </p>
          <p className="text-slate-400 text-sm mt-1">{flag.review.reason}</p>
          <p className="text-slate-500 text-xs mt-1.5">
            {flag.review.by.name} ({flag.review.by.role}) · {dateTime(flag.review.at)}
          </p>
        </div>
      ) : (
        open && !canDecide && (
          <p className="text-slate-500 text-xs mt-3 leading-relaxed">
            Deciding a flag is `require_team_admin`, and the service refuses a session
            with no name on it — a review can impose a limit or suspend play on
            somebody&apos;s account. You can read the evidence; you cannot record the
            decision.
          </p>
        )
      )}

      <p className="text-slate-600 text-[11px] mt-2.5 leading-relaxed">{flag.note}</p>
    </div>
  )
}

function WindowCard({ w }: { w: ProtectionWindow }) {
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-xl px-4 py-3.5">
      <p className="text-slate-200 text-sm font-medium">{w.label}</p>
      <div className="grid grid-cols-2 gap-3 mt-2.5">
        <Mini
          label="Limit"
          value={w.limit === null ? 'none set' : `${diamonds(w.limit)} dmd`}
          hint={w.limit_source ? `set by ${w.limit_source}` : 'no limit of this kind'}
        />
        <Mini
          label="Headroom"
          value={w.headroom === null ? '—' : `${diamonds(w.headroom)} dmd`}
          hint={w.headroom === null ? 'nothing to be left of' : 'before the limit binds'}
        />
        <Mini label="Net loss so far" value={`${diamonds(w.net_loss)} dmd`} />
        <Mini label="Rounds" value={count(w.rounds)} />
        <Mini label="Staked" value={`${diamonds(w.staked)} dmd`} />
        <Mini label="Returned" value={`${diamonds(w.returned)} dmd`} />
      </div>
      <p className="text-slate-500 text-xs mt-2.5">
        Resets {w.resets_at_local || dateTime(w.resets_at)} ({w.timezone})
      </p>
    </div>
  )
}

function Mini({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <p className="text-slate-500 text-[11px] uppercase tracking-wide">{label}</p>
      <p className="text-slate-200 text-sm tabular-nums mt-0.5">{value}</p>
      {hint && <p className="text-slate-600 text-[11px]">{hint}</p>}
    </div>
  )
}

function Num({
  label, value, onChange, unit = 'diamonds',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  unit?: string
}) {
  return (
    <div>
      <label className="block text-slate-400 text-xs uppercase tracking-wide mb-1.5">
        {label} <span className="text-slate-600 normal-case">({unit})</span>
      </label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ''))}
        inputMode="numeric"
        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white tabular-nums focus:outline-none focus:border-emerald-500"
      />
    </div>
  )
}

/** `useSearchParams` needs a Suspense boundary under `output: 'export'`. */
export default function PlayerProtectionPage() {
  return (
    <Suspense fallback={<Loading label="Reading the review queue…" />}>
      <ProtectionScreen />
    </Suspense>
  )
}
