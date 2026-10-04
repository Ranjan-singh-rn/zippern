'use client'

/**
 * Per-host earnings — spec 0.2.4, who earned what over which period.
 *
 * `GET /partners/agencies/{id}/hosts` (backend/app/routers/partners.py:61)
 * aggregates the bean ledger, so it always reconciles with what was actually
 * credited. Two things about it have to be said on screen rather than assumed:
 *
 *   * It takes `since` and no `until`. The window is always "since X, until
 *     now" — it cannot be closed at the far end. A period heading that claims
 *     otherwise is wrong, so the heading says what the call actually did.
 *   * It counts beans CREDITED, not beans cashed out. Commission bills on
 *     cash-outs. The two figures are different on purpose and an agency
 *     comparing them needs to know which is which, or it looks like an error.
 *
 * ── WHY THIS TABLE WAS UNUSABLE FOR THE JOB IT IS FOR ────────────────────────
 *
 * An agency is not an accountant; it is a manager. It reads this to know who to
 * praise, who to coach and who has stopped showing up. The table gave it a
 * column of raw Firebase uids and a bean total — no names, no faces, no idea
 * who anybody was. You cannot congratulate `Aq1EIj85fKZy0eS1AuiS9RC15IN2`.
 *
 * So the ledger rows are joined against the agency's own roster, which this
 * dashboard already holds, and two things are added that the ledger cannot say
 * on its own:
 *
 *   * HOSTS WHO EARNED NOTHING. The aggregation groups ledger movements, so a
 *     host with no movements in the window does not appear AT ALL — and those
 *     are precisely the people an agency needs to chase. They are merged in at
 *     zero and marked, rather than being invisible.
 *   * HOW LONG SINCE THEY LAST EARNED. "Last earned" was a date; the question
 *     behind it is "has this one gone quiet", which is a number of days.
 *
 * Ranking stays the server's — it sorts by beans and this does not re-sort the
 * earners — so the top of the table is the top of the table.
 */

import { AlertCircle, Award, TrendingUp, Users } from 'lucide-react'
import { Empty, UnavailablePanel } from '@/components/ui/States'
import { when, type AgencyHostRow } from '@/lib/apiPartners'
import type { ReadResult } from '@/lib/readState'
import { Section, Th } from './MoneyUI'
import { periodDates, type Period } from './MoneyUI'

/** What this dashboard knows about a host, from the `users` read. */
export interface RosterHost {
  uid: string
  name: string
  photoUrl?: string
  /** HOST ladder (beans). `level` — the XP ladder — has no writer anywhere. */
  hostLevel?: number
  callRateBeans?: number
  isVerifiedHost?: boolean
  isBanned?: boolean
}

/** Whole days since an ISO timestamp, or null when there is none. */
function daysSince(iso: string | null): number | null {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  return Number.isNaN(ms) ? null : Math.floor(ms / 86400000)
}

/** A host who has earned nothing at all in this window is idle by definition. */
const IDLE_DAYS = 3

export function HostEarnings({
  hosts,
  roster,
  period,
  onRetry,
}: {
  /** null while the read is in flight. */
  hosts: ReadResult<AgencyHostRow[]> | null
  /**
   * The agency's own roster, for names and for the hosts the ledger cannot
   * mention. Empty is survivable: the table falls back to uids, which is what
   * it always showed.
   */
  roster: RosterHost[]
  period: Period
  onRetry: () => void
}) {
  const day = (d: Date) =>
    d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })

  /**
   * The ledger's earners, named, followed by everyone else on the roster at
   * zero.
   *
   * Order matters and is not re-sorted: the server ranks earners by beans, so
   * the top row is the top earner. The silent ones go last because they are a
   * different question — not "who earned least" but "who did not start".
   */
  const byUid = new Map(roster.map((r) => [r.uid, r]))
  const earned = (hosts?.ok ? hosts.value : []).map((h) => {
    const who = byUid.get(h.host_id)
    return {
      ...h,
      // The uid stays as the fallback name. A roster read that failed must not
      // turn a real earner into a blank row.
      name: who?.name || h.host_id,
      photoUrl: who?.photoUrl,
      hostLevel: who?.hostLevel,
      callRateBeans: who?.callRateBeans,
      isVerifiedHost: who?.isVerifiedHost,
      idleDays: daysSince(h.last_earned_at),
      silent: false,
    }
  })
  const earnedIds = new Set(earned.map((e) => e.host_id))
  const silent = roster
    .filter((r) => !earnedIds.has(r.uid))
    .map((r) => ({
      host_id: r.uid,
      beans_earned: 0,
      movements: 0,
      last_earned_at: null as string | null,
      name: r.name || r.uid,
      photoUrl: r.photoUrl,
      hostLevel: r.hostLevel,
      callRateBeans: r.callRateBeans,
      isVerifiedHost: r.isVerifiedHost,
      idleDays: null as number | null,
      silent: true,
    }))

  // Only when the earnings read succeeded. Listing the whole roster at zero
  // under a failed read would say "nobody earned anything", which is the one
  // thing a refused read must never be rendered as.
  const rows = hosts?.ok ? [...earned, ...silent] : earned
  const silentCount = hosts?.ok ? silent.length : 0

  const heading =
    period.mode === 'lifetime'
      ? 'Every bean your hosts have ever earned'
      : `Beans your hosts earned since ${day(period.since)}`

  const subtitle =
    period.mode === 'lifetime'
      ? 'No start date was sent, so this is lifetime earnings for every host of yours.'
      : `This endpoint takes a start date and no end date, so these rows run from ` +
        `${day(period.since)} to now — not to ${day(period.until)}, where your ` +
        'period actually ends. Everything else on this page respects both ends of it.'

  return (
    <Section
      title="Your hosts"
      icon={<TrendingUp size={15} />}
      subtitle={`${heading}. ${subtitle}`}
    >
      {hosts === null ? (
        <div className="p-5 space-y-2.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-9 bg-slate-800/60 rounded animate-pulse" />
          ))}
        </div>
      ) : !hosts.ok ? (
        <UnavailablePanel
          failure={hosts}
          what="Per-host earnings"
          onRetry={onRetry}
        />
      ) : hosts.value.length === 0 && roster.length === 0 ? (
        <Empty
          title="No host earnings in this window"
          hint="Your hosts earned nothing in this window, or none is linked to you yet. This is an emptiness the ledger reported, not a read that failed."
          icon={<Users size={26} />}
        />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-800">
                  <Th>Host</Th>
                  <Th align="right" hideOnMobile>
                    Movements
                  </Th>
                  <Th align="right" hideOnMobile>
                    Last earned
                  </Th>
                  <Th align="right">Beans earned</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((h, i) => (
                  <tr
                    key={h.host_id}
                    className={`border-b border-slate-800/60 last:border-0 ${
                      h.silent ? 'bg-slate-950/40' : ''
                    }`}
                  >
                    <td className="px-4 sm:px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        {h.photoUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={h.photoUrl}
                            alt={h.name}
                            className="w-7 h-7 rounded-full object-cover shrink-0"
                          />
                        ) : (
                          <div className="w-7 h-7 rounded-full bg-slate-800 flex items-center justify-center shrink-0">
                            <span className="text-slate-400 text-[11px] font-bold">
                              {h.name?.[0]?.toUpperCase() ?? '?'}
                            </span>
                          </div>
                        )}
                        <div className="min-w-0">
                          <p className="text-slate-200 text-sm truncate max-w-[11rem] sm:max-w-none flex items-center gap-1.5">
                            {h.name}
                            {/* The best earner in the window, worth saying out
                                loud: this table is read to decide who to
                                thank. */}
                            {i === 0 && h.beans_earned > 0 && (
                              <Award size={12} className="text-amber-400 shrink-0" />
                            )}
                          </p>
                          <p className="text-slate-600 text-[11px] mt-0.5">
                            {`Lv ${h.hostLevel ?? 0}`}
                            {h.callRateBeans ? ` · ${h.callRateBeans} b/min` : ''}
                            {h.isVerifiedHost === false ? ' · not verified' : ''}
                            <span className="sm:hidden">
                              {' · '}
                              {h.movements.toLocaleString('en-IN')} movements
                            </span>
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 sm:px-5 py-3 text-right text-slate-500 text-sm hidden sm:table-cell whitespace-nowrap">
                      {h.movements.toLocaleString('en-IN')}
                    </td>
                    <td className="px-4 sm:px-5 py-3 text-right text-sm hidden sm:table-cell whitespace-nowrap">
                      {h.beans_earned === 0 ? (
                        <span className="flex items-center justify-end gap-1 text-amber-300/90">
                          <AlertCircle size={11} /> nothing yet
                        </span>
                      ) : h.idleDays !== null && h.idleDays >= IDLE_DAYS ? (
                        <span className="text-amber-300/90">
                          {when(h.last_earned_at)} · {h.idleDays}d quiet
                        </span>
                      ) : (
                        <span className="text-slate-500">{when(h.last_earned_at)}</span>
                      )}
                    </td>
                    <td
                      className={`px-4 sm:px-5 py-3 text-right text-sm font-semibold whitespace-nowrap ${
                        h.beans_earned > 0 ? 'text-white' : 'text-slate-600'
                      }`}
                    >
                      🫘 {h.beans_earned.toLocaleString('en-IN')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {silentCount > 0 && (
            <p className="px-4 sm:px-5 pt-3 flex items-start gap-1.5 text-amber-300/90 text-[11px] leading-relaxed">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span>
                {silentCount === 1
                  ? 'One host on your roster earned nothing in this window.'
                  : `${silentCount} hosts on your roster earned nothing in this window.`}{' '}
                They are listed at the bottom at zero. The ledger cannot report
                them on its own — no earnings means no rows to aggregate — so
                without this they were simply absent from the table.
              </span>
            </p>
          )}
          <p className="px-4 sm:px-5 py-2.5 border-t border-slate-800 text-slate-600 text-[11px] leading-relaxed">
            These are beans <span className="text-slate-400">credited</span> to
            your hosts. Your commission bills on beans{' '}
            <span className="text-slate-400">cashed out</span>, which is a
            different and usually smaller figure — the derivation above splits
            that one. Beans earned and not yet cashed out bill in the period they
            are actually paid.
          </p>
        </>
      )}
    </Section>
  )
}
