'use client'

/**
 * One account, and everything that has been done to it.
 *
 * The profile is read from Firestore because that is where the Android app
 * keeps it. The record of what was *done* to the account comes from the API's
 * append-only audit log — which is the panel that did not exist before, and the
 * reason moderation was moved off direct Firestore writes: an actor recorded as
 * "Admin" attributed nothing to nobody.
 *
 * `previousBanReason` is shown when present. Unbanning used to blank the ban
 * reason, so a repeat offender looked identical to a first-timer.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { doc, getDoc, type Timestamp } from 'firebase/firestore'
import {
  AlertTriangle, ArrowLeft, Coins, Gem, History, ShieldAlert, type LucideIcon,
} from 'lucide-react'
import { db } from '@/lib/firebase'
import {
  getUserBeanTransactions, getUserDiamondTransactions, type Transaction,
} from '@/lib/firestore'
import api, { ApiError, type AuditEntry, type UserWarning } from '@/lib/api'
import { DataTable, type Column } from '@/components/ui/DataTable'
import { Denied, ErrorState, Loading, Warning } from '@/components/ui/States'
import { useAuth } from '@/components/AuthProvider'
import { canAccess, type CrmRole } from '@/lib/auth'
import { nameOrReference, referenceOf } from '@/lib/identity'
import { useIdentities } from '@/lib/useIdentities'
import { UserActions } from './UserActions'
import HostRecord from './HostRecord'
import PartnerApplications from './PartnerApplications'
import { profilePhotoSrc } from '@/lib/profilePhoto'
import { formatIst } from '@/lib/istTime'  // QA #54: shown in IST, stored in UTC

const VIEW_ROLES: CrmRole[] = [
  'superadmin', 'app_admin', 'app_member', 'ops_admin', 'ops_member',
  'finance_admin', 'support_admin', 'support_member', 'tech_admin',
]

type TabKey = 'activity' | 'warnings' | 'diamonds' | 'beans'

const TABS: { key: TabKey; label: string; icon: LucideIcon }[] = [
  { key: 'activity', label: 'Activity', icon: History },
  { key: 'warnings', label: 'Warnings', icon: AlertTriangle },
  { key: 'diamonds', label: 'Diamonds', icon: Gem },
  { key: 'beans', label: 'Beans', icon: Coins },
]

interface UserDoc {
  uid: string
  /** Denormalised from `crmUsers`. Hides the moderation controls on an
   *  internal identity; the enforcing check is server-side. */
  crmRole: string
  name: string
  email: string
  phoneNumber: string
  photoUrl: string
  diamonds: number
  beans: number
  /** Released beans — what a payout or a warning deduction may take (UGP-D). */
  beansAvailable: number
  /** USER ladder, 0–20, from `totalXp`. Has no writer — see the note at its read. */
  level: number
  /** HOST ladder, 0–10, from beans earned. Server-maintained, absent means 0. */
  hostLevel: number
  agencyId: string
  isHost: boolean
  isVerifiedHost: boolean
  isAgent: boolean
  isSeller: boolean
  /**
   * Which state the account is in — `active`, `suspended`, `banned`,
   * `recovery_pending` or `permanently_deactivated`.
   *
   * `isBanned` below is the app's single gate and is true for a suspension AND
   * for a ban, so it cannot say which. This field can, and `UserActions` needs
   * to know: Resume lifts a suspension and Unban lifts a ban, the server
   * refuses each in the other's case, and offering the wrong one means offering
   * a button that can only fail.
   *
   * Empty on every account restricted before the field existed — which is why
   * the two booleans are still passed alongside it rather than replaced by it.
   */
  accountState: string
  isBanned: boolean
  isSuspended: boolean
  banReason: string
  previousBanReason: string
  bannedByName: string
  bannedAt: Timestamp | null
  /** `suspend_user` stamps these, not `bannedBy*` (UGP: the banner named the wrong actor). */
  suspendedByName: string
  suspendedAt: Timestamp | null
  warningCount: number
  createdAt: Timestamp | null
}

/** How each audited action reads to someone who did not write the backend. */
const ACTION_LABELS: Record<string, string> = {
  'user.banned': 'Banned',
  'user.unbanned': 'Unbanned',
  'user.suspended': 'Suspended',
  // Its own action, and not a spelling of `user.unbanned`. Lifting a suspension
  // used to be recorded as an unban, so an expired suspension and a moderator's
  // decision to lift a ban were the same line in somebody's history and neither
  // could be counted. Without this entry the history renders the raw
  // `user.resumed` beside four plain English words.
  'user.resumed': 'Resumed',
  'user.warned': 'Warned',
  'host.granted': 'Host granted',
  'host.revoked': 'Host revoked',
  'user.seller_granted': 'Seller granted',
  'user.seller_revoked': 'Seller revoked',
  'balance.change_requested': 'Balance change requested',
  'balance.credit': 'Balance credited',
  'balance.debit': 'Balance debited',
}

function fmtStamp(ts: Timestamp | null): string {
  if (!ts) return '—'
  try { return formatIst(ts.toMillis()) || '—' } catch { return '—' }
}

function stampMillis(ts: Timestamp | null): number | null {
  if (!ts) return null
  try { return ts.toMillis() } catch { return null }
}

function fmtIso(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '—' : formatIst(d)
}

/**
 * "3d ago" next to the timestamp. A date alone makes you do arithmetic to
 * answer the question actually being asked — how long ago was this?
 */
function ago(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (isNaN(t)) return ''
  const secs = Math.max(Math.floor((Date.now() - t) / 1000), 0)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return fallback
}

export default function UserDetailPage() {
  const params = useParams()
  const paramUid = (params?.uid as string) ?? ''
  // The static export ships a single `_` shell for this route, so the real uid
  // has to come from the address bar at runtime.
  const uid =
    (typeof window !== 'undefined'
      ? window.location.pathname.split('/').filter(Boolean)[1] ?? paramUid
      : paramUid) || paramUid

  const { crmUser, loading: authLoading } = useAuth()
  const canView = canAccess(crmUser, VIEW_ROLES)

  const [user, setUser] = useState<UserDoc | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [history, setHistory] = useState<AuditEntry[]>([])
  const [historyError, setHistoryError] = useState('')
  const [historyLoading, setHistoryLoading] = useState(true)

  const [warnings, setWarnings] = useState<UserWarning[]>([])
  const [warningsError, setWarningsError] = useState('')
  const [warningsLoading, setWarningsLoading] = useState(true)

  const [tab, setTab] = useState<TabKey>('activity')

  const [diamonds, setDiamonds] = useState<Transaction[]>([])
  const [beans, setBeans] = useState<Transaction[]>([])
  const [txError, setTxError] = useState('')
  const [txLoading, setTxLoading] = useState(true)

  const loadProfile = useCallback(async () => {
    // '_' is the static shell's placeholder — there is no such account.
    if (!uid || uid === '_') {
      setUser(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const snap = await getDoc(doc(db, 'users', uid))
      if (!snap.exists()) {
        setUser(null)
        return
      }
      const d = snap.data()
      setUser({
        uid: snap.id,
        name: d.name ?? '',
        email: d.email ?? '',
        phoneNumber: d.phoneNumber ?? '',
        photoUrl: d.photoUrl ?? '',
        crmRole: typeof d.crmRole === 'string' ? d.crmRole : '',
        diamonds: d.diamonds ?? 0,
        beans: d.beans ?? 0,
        beansAvailable: typeof d.beansAvailable === 'number' ? d.beansAvailable : 0,
        /*
         * 0, not 1 — and `hostLevel` alongside it, because they are two ladders.
         *
         * `level` is the USER ladder, scored on `totalXp`. NOTHING ON THE
         * PLATFORM WRITES IT: not the app, not the Cloud Functions, not the
         * Python API. It is absent on every user document that exists, so
         * `?? 1` was not a fallback — it was the only source of the number, and
         * it reported a brand-new account with zero XP and zero earnings as
         * "Level 1" on this very page while the app showed the same person as
         * level 0.
         *
         * `hostLevel` is the HOST ladder, scored on beans earned, and it IS
         * real: `applyHostLevel` and the nightly `sweepHostLevels` maintain it.
         * It is written only when it changes, so absent legitimately means 0 —
         * which is why the default here matches the one the server itself uses.
         */
        level: d.level ?? 0,
        hostLevel: d.hostLevel ?? 0,
        agencyId: d.agencyId ?? '',
        isHost: d.isHost ?? false,
        isVerifiedHost: d.isVerifiedHost ?? false,
        isAgent: d.isAgent ?? false,
        isSeller: d.isSeller ?? false,
        accountState: d.accountState ?? '',
        isBanned: d.isBanned ?? false,
        isSuspended: d.isSuspended ?? false,
        banReason: d.banReason ?? '',
        previousBanReason: d.previousBanReason ?? '',
        bannedByName: d.bannedByName ?? '',
        bannedAt: d.bannedAt ?? null,
        suspendedByName: d.suspendedByName ?? '',
        suspendedAt: d.suspendedAt ?? null,
        warningCount: d.warnings ?? 0,
        createdAt: d.createdAt ?? null,
      })
    } catch (err) {
      setError(messageOf(err, 'Could not load this account.'))
    } finally {
      setLoading(false)
    }
  }, [uid])

  const loadHistory = useCallback(async () => {
    if (!uid || uid === '_') { setHistoryLoading(false); return }
    setHistoryLoading(true)
    setHistoryError('')
    try {
      setHistory(await api.users.history(uid, 200))
    } catch (err) {
      setHistoryError(messageOf(err, 'Could not load the account history.'))
    } finally {
      setHistoryLoading(false)
    }
  }, [uid])

  const loadWarnings = useCallback(async () => {
    if (!uid || uid === '_') { setWarningsLoading(false); return }
    setWarningsLoading(true)
    setWarningsError('')
    try {
      setWarnings(await api.users.warnings(uid, 100))
    } catch (err) {
      setWarningsError(messageOf(err, 'Could not load the warnings.'))
    } finally {
      setWarningsLoading(false)
    }
  }, [uid])

  const loadTransactions = useCallback(async () => {
    if (!uid || uid === '_') { setTxLoading(false); return }
    setTxLoading(true)
    setTxError('')
    try {
      const [d, b] = await Promise.all([
        getUserDiamondTransactions(uid),
        getUserBeanTransactions(uid),
      ])
      setDiamonds(d)
      setBeans(b)
    } catch (err) {
      setTxError(messageOf(err, 'Could not load the transactions.'))
    } finally {
      setTxLoading(false)
    }
  }, [uid])

  const loadAll = useCallback(() => {
    loadProfile()
    loadHistory()
    loadWarnings()
    loadTransactions()
  }, [loadProfile, loadHistory, loadWarnings, loadTransactions])

  useEffect(() => {
    if (!canView) return
    loadAll()
  }, [canView, loadAll])

  const historyColumns = useMemo<Column<AuditEntry>[]>(() => [
    {
      key: 'at',
      header: 'When',
      value: (e) => e.at,
      render: (e) => (
        <div className="whitespace-nowrap">
          <p className="text-slate-200 text-xs">{ago(e.at) || '—'}</p>
          <p className="text-slate-500 text-[11px]">{fmtIso(e.at)}</p>
        </div>
      ),
    },
    {
      key: 'action',
      header: 'What',
      value: (e) => ACTION_LABELS[e.action] ?? e.action,
      render: (e) => (
        <span className="text-white text-xs font-medium">
          {ACTION_LABELS[e.action] ?? e.action}
        </span>
      ),
    },
    {
      key: 'actor',
      header: 'Who',
      value: (e) => e.actor?.name || e.actor?.uid || '',
      render: (e) => (
        <div>
          <p className="text-slate-200">{e.actor?.name || e.actor?.uid || 'Unknown'}</p>
          <p className="text-slate-500 text-xs">{e.actor?.role || '—'}</p>
        </div>
      ),
    },
    {
      key: 'reason',
      header: 'Why',
      value: (e) => e.reason,
      render: (e) => <span className="text-slate-300">{e.reason || '—'}</span>,
    },
    {
      key: 'card_id',
      header: 'Card',
      hideOnMobile: true,
      sortable: false,
      value: (e) => e.card_id ?? '',
      render: (e) =>
        e.card_id ? (
          <Link href="/board" className="text-pink-400 hover:text-pink-300 text-xs underline underline-offset-2">
            on the board
          </Link>
        ) : (
          <span className="text-slate-600">—</span>
        ),
    },
  ], [])

  const warningColumns = useMemo<Column<UserWarning>[]>(() => [
    {
      key: 'issuedAt',
      header: 'When',
      value: (w) => w.issuedAt ?? '',
      render: (w) => (
        <div className="whitespace-nowrap">
          <p className="text-slate-200 text-xs">{ago(w.issuedAt) || '—'}</p>
          <p className="text-slate-500 text-[11px]">{fmtIso(w.issuedAt)}</p>
        </div>
      ),
    },
    {
      key: 'reason',
      header: 'Reason',
      render: (w) => <span className="text-slate-200">{w.reason || '—'}</span>,
    },
    {
      key: 'issuedByName',
      header: 'Issued by',
      hideOnMobile: true,
      value: (w) => w.issuedByName || w.issuedBy,
      render: (w) => (
        <div>
          <p className="text-slate-300">{w.issuedByName || w.issuedBy || 'Unknown'}</p>
          <p className="text-slate-500 text-xs">{w.issuedByRole || '—'}</p>
        </div>
      ),
    },
  ], [])

  const txColumns = useMemo<Column<Transaction>[]>(() => [
    {
      key: 'type',
      header: 'Type',
      render: (t) => (
        <span
          className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
            t.type === 'credit' ? 'bg-green-500/20 text-green-300' : 'bg-red-500/20 text-red-300'
          }`}
        >
          {t.type || '—'}
        </span>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      render: (t) => (
        <span className={t.type === 'credit' ? 'text-green-300' : 'text-red-300'}>
          {t.type === 'credit' ? '+' : '−'}
          {t.amount.toLocaleString('en-IN')}
        </span>
      ),
    },
    {
      key: 'reasonLabel',
      header: 'Reason',
      value: (t) => t.reasonLabel || t.reason,
      render: (t) => <span className="text-slate-300">{t.reasonLabel || t.reason || '—'}</span>,
    },
    {
      key: 'relatedUserName',
      header: 'Related user',
      hideOnMobile: true,
      render: (t) => <span className="text-slate-400">{t.relatedUserName || '—'}</span>,
    },
    {
      key: 'timestamp',
      header: 'When',
      hideOnMobile: true,
      value: (t) => stampMillis(t.timestamp),
      render: (t) => <span className="text-slate-400 text-xs">{fmtStamp(t.timestamp)}</span>,
    },
  ], [])

  // B1: `agencyId` is an agencies/{id} record id — named from `agencies`.
  const agencyOfUser = useIdentities({ enabled: canView, partners: user?.agencyId ? [user.agencyId] : [] })

  if (authLoading) return <Loading label="Checking your access…" />
  if (!canView) return <Denied what="user records" />

  return (
    <div className="max-w-[1400px] mx-auto">
      <Link
        href="/users"
        className="inline-flex items-center gap-2 text-slate-400 hover:text-white text-sm mb-4 transition-colors"
      >
        <ArrowLeft size={16} /> Back to users
      </Link>

      {loading ? (
        <Loading label="Loading the account…" />
      ) : error ? (
        <ErrorState message={error} onRetry={loadAll} />
      ) : !user ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl px-6 py-10 text-center">
          <p className="text-white font-medium">No account with that id</p>
          <p className="text-slate-500 text-sm mt-1 font-mono">{uid}</p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Identity */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 sm:p-6">
            <div className="flex items-start gap-4">
              {profilePhotoSrc(user.photoUrl) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={profilePhotoSrc(user.photoUrl)}
                  alt=""
                  className="w-16 h-16 rounded-full object-cover ring-2 ring-pink-500/60"
                />
              ) : (
                <div className="w-16 h-16 rounded-full bg-pink-500/20 flex items-center justify-center text-pink-400 text-2xl font-black ring-2 ring-pink-500/60">
                  {user.name?.[0]?.toUpperCase() ?? '?'}
                </div>
              )}
              <div className="min-w-0">
                <h1 className="text-xl sm:text-2xl font-bold text-white truncate">
                  {user.name || 'Unnamed account'}
                </h1>
                <p className="text-slate-500 text-sm font-mono mt-0.5 break-all">{user.uid}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-6">
              {[
                { label: 'Phone', value: user.phoneNumber || '—' },
                { label: 'Email', value: user.email || '—' },
                /*
                 * A host is shown their HOST level, because that is the one
                 * that decides what they can charge and what they unlock, and
                 * it is the one the app shows them. Labelling the XP ladder
                 * "Level" on a host's record made the CRM and the app disagree
                 * about the same person in front of whoever was deciding
                 * something about them.
                 */
                user.isHost
                  ? { label: 'Host level', value: `Level ${user.hostLevel}` }
                  : { label: 'Level', value: `Level ${user.level}` },
                { label: 'Agency', value: user.agencyId ? nameOrReference(agencyOfUser.partners.get(user.agencyId), user.agencyId, 'agency') : '—' },
                { label: 'Diamonds', value: user.diamonds.toLocaleString('en-IN'), tone: 'text-blue-300' },
                { label: 'Beans', value: user.beans.toLocaleString('en-IN'), tone: 'text-green-300' },
                { label: 'Warnings', value: String(user.warningCount) },
                { label: 'Joined', value: fmtStamp(user.createdAt) },
              ].map(({ label, value, tone }) => (
                <div key={label} className="bg-slate-950/60 border border-slate-800 rounded-lg p-3">
                  <p className="text-slate-500 text-xs">{label}</p>
                  <p className={`font-semibold text-sm mt-0.5 break-words ${tone ?? 'text-white'}`}>
                    {value}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Ban state, current and previous */}
          {user.isBanned && (
            <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/30 rounded-xl px-5 py-4">
              <ShieldAlert size={17} className="text-red-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-red-200 text-sm font-semibold">
                  {user.isSuspended ? 'Suspended' : 'Banned'} — locked out of the app
                </p>
                <p className="text-red-100/90 text-sm mt-1">{user.banReason || 'No reason recorded.'}</p>
                {/* A suspension is stamped `suspendedBy*` and a ban `bannedBy*`.
                    Reading `bannedBy*` for both printed "unknown", or the actor
                    of an EARLIER ban, on every suspended account. */}
                <p className="text-slate-400 text-xs mt-1">
                  by {(user.isSuspended ? user.suspendedByName : user.bannedByName) || 'unknown'} ·{' '}
                  {fmtStamp(user.isSuspended ? user.suspendedAt : user.bannedAt)}
                </p>
              </div>
            </div>
          )}

          {!user.isBanned && user.previousBanReason && (
            <Warning>
              <span className="font-semibold">Previously banned:</span> {user.previousBanReason}
              <span className="block text-amber-200/70 text-xs mt-1">
                Kept when the ban was lifted, so a repeat offender does not read as a first-timer.
              </span>
            </Warning>
          )}

          <UserActions
            uid={user.uid}
            name={user.name}
            accountState={user.accountState}
            isBanned={user.isBanned}
            isSuspended={user.isSuspended}
            isHost={user.isHost}
            isSeller={user.isSeller}
            crmRole={user.crmRole}
            actorUid={crmUser?.uid}
            diamonds={user.diamonds}
            beansAvailable={user.beansAvailable}
            onDone={loadAll}
          />

          {/* Partner-role applications — pending ones carry the decision.
              This is what replaced the Grant host / Make seller buttons. */}
          <PartnerApplications uid={user.uid} onChanged={loadAll} />

          {/* The application, the documents and the payout details. Renders
              nothing for somebody who is neither a host nor an applicant. */}
          <HostRecord
            uid={user.uid}
            isHost={user.isHost}
            isVerifiedHost={user.isVerifiedHost}
          />

          {/* Activity, warnings and the two ledgers.
              Activity leads because it answers what the rest of the page
              cannot: what has been done to this account, by whom, and why. */}
          <section>
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 mb-4 border-b border-slate-800">
              {TABS.map((t) => {
                const count =
                  t.key === 'activity' ? history.length
                    : t.key === 'warnings' ? warnings.length
                      : t.key === 'diamonds' ? diamonds.length
                        : beans.length
                const active = tab === t.key
                return (
                  <button
                    key={t.key}
                    onClick={() => setTab(t.key)}
                    className={`flex items-center gap-2 px-3 sm:px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
                      active
                        ? 'border-pink-500 text-white'
                        : 'border-transparent text-slate-400 hover:text-white'
                    }`}
                  >
                    <t.icon size={15} className={active ? 'text-pink-400' : ''} />
                    {t.label}
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] tabular-nums ${
                        active ? 'bg-pink-500/20 text-pink-200' : 'bg-slate-800 text-slate-500'
                      }`}
                    >
                      {count}
                    </span>
                  </button>
                )
              })}
            </div>

            {tab === 'activity' && (
              <>
                <p className="text-slate-500 text-sm mb-3">
                  Every action ever taken on this account — who did it, when, and why. Read from the
                  append-only audit log rather than the user document, so it cannot be edited by
                  whoever performed the action.
                </p>
                <DataTable
                  rows={history}
                  columns={historyColumns}
                  rowKey={(e) => e.id}
                  loading={historyLoading}
                  error={historyError}
                  onRetry={loadHistory}
                  searchPlaceholder="Search the history by action, person or reason…"
                  searchKeys={['action', 'actor', 'reason']}
                  exportName={`user-${uid}-history`}
                  emptyTitle="Nothing has been done to this account"
                  emptyHint="Bans, warnings, host changes and balance requests all appear here once they happen."
                />
              </>
            )}

            {tab === 'warnings' && (
              <>
                <p className="text-slate-500 text-sm mb-3">
                  Formal warnings, each attributed to whoever issued it. A warning does not restrict
                  the account.
                </p>
                <DataTable
                  rows={warnings}
                  columns={warningColumns}
                  rowKey={(w) => w.id}
                  loading={warningsLoading}
                  error={warningsError}
                  onRetry={loadWarnings}
                  searchPlaceholder="Search warnings by reason or who issued them…"
                  searchKeys={['reason', 'issuedByName']}
                  exportName={`user-${uid}-warnings`}
                  emptyTitle="No warnings issued"
                  emptyHint="A formal warning is recorded against the person who issues it."
                />
              </>
            )}

            {tab === 'diamonds' && (
              <DataTable
                rows={diamonds}
                columns={txColumns}
                rowKey={(t) => t.id}
                loading={txLoading}
                error={txError}
                onRetry={loadTransactions}
                searchPlaceholder="Search by reason or related user…"
                searchKeys={['reasonLabel', 'relatedUserName']}
                exportName={`user-${uid}-diamonds`}
                truncatedAt={50}
                emptyTitle="No diamond movements"
                emptyHint="Purchases, gifts sent and adjustments all land here."
              />
            )}

            {tab === 'beans' && (
              <DataTable
                rows={beans}
                columns={txColumns}
                rowKey={(t) => t.id}
                loading={txLoading}
                error={txError}
                onRetry={loadTransactions}
                searchPlaceholder="Search by reason or related user…"
                searchKeys={['reasonLabel', 'relatedUserName']}
                exportName={`user-${uid}-beans`}
                truncatedAt={50}
                emptyTitle="No bean movements"
                emptyHint="Gifts received and payouts all land here."
              />
            )}
          </section>
        </div>
      )}
    </div>
  )
}
