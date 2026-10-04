'use client'

/**
 * One moderation queue.
 *
 * Open reports, recent device bans and recently actioned accounts were three
 * separate screens, so nobody could see the shape of a day's work without
 * opening all three and holding the order in their head. This merges them,
 * newest first, and every row links to the screen where the work is done.
 *
 * Everything here is read from the API — the accounts column comes from the
 * append-only audit log, so it names the person who acted, not "Admin".
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Flag, RefreshCw, ShieldOff, UserX } from 'lucide-react'
import api, { ApiError, type AuditEntry } from '@/lib/api'
import { DataTable, type Column, type FilterOption } from '@/components/ui/DataTable'
import { Denied, ErrorState, Loading, Warning } from '@/components/ui/States'
import { useAuth } from '@/components/AuthProvider'
import { canAccess, type CrmRole } from '@/lib/auth'

const VIEW_ROLES: CrmRole[] = [
  'superadmin', 'ops_admin', 'ops_member', 'app_admin', 'app_member', 'support_admin',
]

const PER_SOURCE = 100

/**
 * The audited actions that mean "somebody acted on an account".
 *
 * `user.resumed` is its own action and not a spelling of `user.unbanned`.
 * Lifting a suspension used to be recorded as an unban, so an expired
 * suspension and a moderator's decision to lift a ban read as the same event
 * and neither could be counted. Left out of this list, every resume — including
 * every one the scheduled sweep performs when a timed suspension runs out —
 * would be invisible in the queue, and a suspension would appear here as a
 * restriction that was imposed and never lifted.
 */
const FLAG_ACTIONS: { action: string; label: string }[] = [
  { action: 'user.banned', label: 'Banned' },
  { action: 'user.suspended', label: 'Suspended' },
  { action: 'user.resumed', label: 'Resumed' },
  { action: 'user.warned', label: 'Warned' },
]

type Kind = 'report' | 'device' | 'account'

interface QueueItem {
  id: string
  kind: Kind
  at: number | null
  what: string
  detail: string
  who: string
  href: string
}

const KIND_META: Record<Kind, { label: string; tone: string }> = {
  report: { label: 'Report', tone: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30' },
  device: { label: 'Device ban', tone: 'bg-red-500/20 text-red-300 border-red-500/30' },
  account: { label: 'Account', tone: 'bg-purple-500/20 text-purple-300 border-purple-500/30' },
}

function millis(value: string | null | undefined): number | null {
  if (!value) return null
  const d = new Date(value)
  return isNaN(d.getTime()) ? null : d.getTime()
}

function fmt(at: number | null): string {
  return at == null ? '—' : new Date(at).toLocaleString('en-IN')
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback
}

export default function ModerationPage() {
  const router = useRouter()
  const { crmUser, loading: authLoading } = useAuth()
  const canView = canAccess(crmUser, VIEW_ROLES)

  const [reports, setReports] = useState<QueueItem[]>([])
  const [devices, setDevices] = useState<QueueItem[]>([])
  const [accounts, setAccounts] = useState<QueueItem[]>([])
  const [problems, setProblems] = useState<string[]>([])
  const [fatal, setFatal] = useState('')
  const [loading, setLoading] = useState(true)
  const [kind, setKind] = useState<'all' | Kind>('all')

  const load = useCallback(async () => {
    setLoading(true)
    setProblems([])
    setFatal('')

    const failures: string[] = []

    const reportJob = api.users
      .reports('pending', PER_SOURCE)
      .then((rows) =>
        rows.map<QueueItem>((r) => ({
          id: `report:${r.id}`,
          kind: 'report',
          at: millis(r.createdAt),
          what: `Report against ${r.targetName || r.targetUid || 'an unnamed account'}`,
          detail: r.reason || r.description || 'No reason given.',
          who: r.reporterName || r.reporterUid || 'unknown reporter',
          href: '/operations/reports',
        })),
      )
      .catch((err) => {
        failures.push(`Open reports: ${messageOf(err, 'could not be read.')}`)
        return [] as QueueItem[]
      })

    const deviceJob = api.users
      .bannedDevices(PER_SOURCE)
      .then((rows) =>
        rows.map<QueueItem>((d) => ({
          id: `device:${d.id}`,
          kind: 'device',
          at: millis(d.bannedAt),
          what: `Device banned · ${d.deviceId || d.id}`,
          detail: d.reason || 'No reason recorded.',
          who: d.bannedByName || d.bannedBy || 'unknown',
          href: '/operations/bans',
        })),
      )
      .catch((err) => {
        failures.push(`Device bans: ${messageOf(err, 'could not be read.')}`)
        return [] as QueueItem[]
      })

    const accountJobs = FLAG_ACTIONS.map(({ action, label }) =>
      api.audit
        .list({ action, subject_type: 'user', limit: PER_SOURCE })
        .then((entries: AuditEntry[]) =>
          entries.map<QueueItem>((e) => ({
            id: `audit:${e.id}`,
            kind: 'account',
            at: millis(e.at),
            what: `${label} · ${(e.meta?.name as string) || e.subject.id}`,
            detail: e.reason || 'No reason recorded.',
            who: e.actor?.name || e.actor?.uid || 'unknown',
            href: `/users/${e.subject.id}`,
          })),
        )
        .catch((err) => {
          failures.push(`Flagged accounts (${label.toLowerCase()}): ${messageOf(err, 'could not be read.')}`)
          return [] as QueueItem[]
        }),
    )

    const [reportRows, deviceRows, ...accountRowSets] = await Promise.all([
      reportJob,
      deviceJob,
      ...accountJobs,
    ])

    setReports(reportRows)
    setDevices(deviceRows)
    setAccounts(accountRowSets.flat())
    setProblems(failures)
    // Only when nothing at all could be read is the page broken rather than
    // partial — a partial queue is still worth working from, as long as it says
    // what is missing.
    if (failures.length === FLAG_ACTIONS.length + 2) {
      setFatal(failures[0] ?? 'Could not load the moderation queue.')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (!canView) return
    load()
  }, [canView, load])

  const merged = useMemo(() => {
    const all = [...reports, ...devices, ...accounts]
    all.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    return all
  }, [reports, devices, accounts])

  const rows = useMemo(
    () => (kind === 'all' ? merged : merged.filter((i) => i.kind === kind)),
    [merged, kind],
  )

  const columns = useMemo<Column<QueueItem>[]>(() => [
    {
      key: 'kind',
      header: 'Kind',
      value: (i) => KIND_META[i.kind].label,
      render: (i) => (
        <span
          className={`px-2 py-0.5 border rounded-full text-[11px] font-medium whitespace-nowrap ${KIND_META[i.kind].tone}`}
        >
          {KIND_META[i.kind].label}
        </span>
      ),
    },
    {
      key: 'what',
      header: 'What',
      render: (i) => <span className="text-white font-medium">{i.what}</span>,
    },
    {
      key: 'detail',
      header: 'Why',
      render: (i) => (
        <span className="text-slate-300 block max-w-[320px] truncate">{i.detail}</span>
      ),
    },
    {
      key: 'who',
      header: 'Who',
      hideOnMobile: true,
      render: (i) => <span className="text-slate-400">{i.who}</span>,
    },
    {
      key: 'at',
      header: 'When',
      hideOnMobile: true,
      value: (i) => i.at,
      render: (i) => <span className="text-slate-400 text-xs whitespace-nowrap">{fmt(i.at)}</span>,
    },
  ], [])

  const filters: FilterOption[] = [
    {
      key: 'kind',
      label: 'Kind',
      options: [
        { value: 'report', label: 'Reports', count: reports.length },
        { value: 'device', label: 'Device bans', count: devices.length },
        { value: 'account', label: 'Accounts', count: accounts.length },
      ],
    },
  ]

  if (authLoading) return <Loading label="Checking your access…" />
  if (!canView) return <Denied what="the moderation queue" />

  return (
    <div className="max-w-[1400px] mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Moderation</h1>
          <p className="text-slate-400 text-sm mt-1">
            Open reports, device bans and account actions in one list, newest first.
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2 text-sm transition-colors"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <Count
          icon={<Flag size={16} className="text-yellow-400" />}
          label="Open reports"
          value={reports.length}
          hint="Waiting on a decision"
          href="/operations/reports"
        />
        <Count
          icon={<ShieldOff size={16} className="text-red-400" />}
          label="Banned devices"
          value={devices.length}
          hint="Currently in force"
          href="/operations/bans"
        />
        <Count
          icon={<UserX size={16} className="text-purple-400" />}
          label="Flagged accounts"
          value={accounts.length}
          hint="Recent bans, suspensions and warnings"
          href="/users"
        />
      </div>

      {problems.length > 0 && !fatal && (
        <Warning>
          Part of the queue is missing, so the counts above are lower than the truth:
          <span className="block mt-1">{problems.join(' · ')}</span>
        </Warning>
      )}

      {fatal ? (
        <ErrorState message={fatal} onRetry={load} />
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(i) => i.id}
          loading={loading}
          searchPlaceholder="Search the queue by account, device, reason or person…"
          searchKeys={['what', 'detail', 'who']}
          filters={filters}
          activeFilters={{ kind }}
          onFilterChange={(key, value) => {
            if (key === 'kind') setKind(value as 'all' | Kind)
          }}
          onRowClick={(i) => router.push(i.href)}
          exportName="moderation-queue"
          truncatedAt={PER_SOURCE}
          emptyTitle="Nothing to moderate"
          emptyHint="No open reports, no device bans, and no account actions recorded recently."
        />
      )}
    </div>
  )
}

function Count({
  icon, label, value, hint, href,
}: {
  icon: React.ReactNode
  label: string
  value: number
  hint: string
  href: string
}) {
  return (
    <Link
      href={href}
      className="bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-xl px-4 py-4 transition-colors block"
    >
      <div className="flex items-center gap-2">
        {icon}
        <p className="text-slate-400 text-sm">{label}</p>
      </div>
      <p className="text-white text-2xl font-bold mt-1.5">{value.toLocaleString('en-IN')}</p>
      <p className="text-slate-600 text-xs mt-0.5">{hint}</p>
    </Link>
  )
}
