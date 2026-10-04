'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/AuthProvider'
import { getAllApprovals, countPendingApprovals, approveRequest, rejectRequest, HOST_DECISION_TYPES, type ApprovalRequest, type ApprovalType } from '@/lib/approvals'
import Link from 'next/link'
import { AlertTriangle, CheckCircle, XCircle, Clock, ChevronRight, RefreshCw, Filter, Loader2 } from 'lucide-react'
import { fromSettled, type ReadFailure } from '@/lib/readState'
import { UnavailablePanel, UnavailableInline } from '@/components/ui/States'
import KycApprovals, { type ApplicantCounts } from '@/components/KycApprovals'

const STATUS_STYLES: Record<string, string> = {
  pending:  'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20',
  approved: 'bg-green-500/10  text-green-400  border border-green-500/20',
  rejected: 'bg-red-500/10   text-red-400    border border-red-500/20',
}

const STATUS_ICONS: Record<string, React.ElementType> = {
  pending:  Clock,
  approved: CheckCircle,
  rejected: XCircle,
}

// Type → category mapping for filter
type TypeCategory = 'all' | 'agency' | 'seller' | 'team' | 'host' | 'finance' | 'config'

const TYPE_CATEGORIES: Record<ApprovalType, TypeCategory> = {
  create_agency: 'agency',
  approve_agency: 'agency', reject_agency: 'agency', update_agency: 'agency',
  deactivate_agency: 'agency', reactivate_agency: 'agency',
  set_commission_rate: 'agency', mark_commission_paid: 'agency',
  create_seller: 'seller',
  approve_seller: 'seller', reject_seller: 'seller', update_seller: 'seller',
  deactivate_seller: 'seller', reactivate_seller: 'seller',
  create_crm_user: 'team', update_crm_user: 'team', deactivate_crm_user: 'team',
  add_host: 'host', remove_host: 'host',
  credit_beans: 'finance', debit_beans: 'finance',
  credit_diamonds: 'finance', debit_diamonds: 'finance', lend_diamonds: 'finance',
  update_config: 'config', update_gifts_config: 'config',
}

const CATEGORY_LABELS: { key: TypeCategory; label: string }[] = [
  { key: 'all',     label: 'All Types' },
  { key: 'agency',  label: 'Agency' },
  { key: 'seller',  label: 'Seller' },
  { key: 'team',    label: 'Team' },
  { key: 'host',    label: 'Host' },
  { key: 'finance', label: 'Finance' },
  { key: 'config',  label: 'Config' },
]

function timeAgo(ts: { seconds: number } | null | undefined) {
  if (!ts) return '—'
  const d = new Date(ts.seconds * 1000)
  const diff = Date.now() - d.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)  return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

type StatusFilter = 'all' | 'pending' | 'approved' | 'rejected'

export default function ApprovalsPage() {
  const { crmUser, canAccess } = useAuth()
  const router = useRouter()

  const [requests, setRequests]     = useState<ApprovalRequest[]>([])
  const [loading, setLoading]       = useState(true)
  const [statusFilter, setStatus]   = useState<StatusFilter>('pending')
  const [typeFilter, setType]       = useState<TypeCategory>('all')
  const [pendingCount, setPendingCount] = useState<number | null>(null)
  /**
   * How many applicant rows the KYC section is showing, per type.
   *
   * This screen has two lists — the applications themselves and the staff
   * permission requests — and the type pills filter both. Counting only the
   * second would put "Host 0" above a list of two host applications, which is
   * the same class of bug as the tab that showed nothing: a number that
   * contradicts the rows beside it.
   */
  const [kycCounts, setKycCounts] = useState<ApplicantCounts>({
    all: 0, agency: 0, seller: 0, host: 0,
  })
  // Two reads, two failures. The queue itself and the pending tally are
  // separate calls and there is no reason a reader should be told about one
  // when the other is what broke.
  const [listFailure, setListFailure]   = useState<ReadFailure | null>(null)
  const [countFailure, setCountFailure] = useState<ReadFailure | null>(null)
  const [acting, setActing]         = useState<Record<string, 'approve' | 'reject' | null>>({})
  const [rejectNote, setRejectNote] = useState<Record<string, string>>({})
  const [showReject, setShowReject] = useState<Record<string, boolean>>({})

  const isSuperAdmin = crmUser?.role === 'superadmin'

  // `allSettled` with the failures kept. This was `Promise.all` inside a
  // `try { } finally { }` with no catch: a rejection left `requests` at `[]`
  // and `pendingCount` at `0`, so the screen read "Pending (0)" above
  // "No pending requests." — an empty approval queue is exactly what a
  // superadmin wants to see, and it was not true.
  async function load() {
    setLoading(true)
    const [all, pc] = await Promise.allSettled([getAllApprovals(300), countPendingApprovals()])

    const listRead = fromSettled(all, 'approvals/getAllApprovals')
    if (listRead.ok) { setRequests(listRead.value); setListFailure(null) }
    else { setRequests([]); setListFailure(listRead) }

    const countRead = fromSettled(pc, 'approvals/countPendingApprovals')
    if (countRead.ok) { setPendingCount(countRead.value); setCountFailure(null) }
    else { setPendingCount(null); setCountFailure(countRead) }

    setLoading(false)
  }

  async function handleApprove(req: ApprovalRequest) {
    if (!crmUser) return
    setActing(a => ({ ...a, [req.id]: 'approve' }))
    try {
      await approveRequest(req.id, { uid: crmUser.uid, name: crmUser.name })
      setRequests(prev => prev.map(r => r.id === req.id ? { ...r, status: 'approved' } : r))
      // Only adjust a tally we actually have. `null` means unknown, and
      // unknown minus one is still unknown, not a number.
      setPendingCount(c => (c === null ? null : Math.max(0, c - 1)))
    } finally {
      setActing(a => ({ ...a, [req.id]: null }))
    }
  }

  async function handleReject(req: ApprovalRequest) {
    if (!crmUser) return
    const note = rejectNote[req.id]?.trim()
    if (!note) { setShowReject(s => ({ ...s, [req.id]: true })); return }
    setActing(a => ({ ...a, [req.id]: 'reject' }))
    try {
      await rejectRequest(req.id, { uid: crmUser.uid, name: crmUser.name }, note)
      setRequests(prev => prev.map(r => r.id === req.id ? { ...r, status: 'rejected' } : r))
      // Only adjust a tally we actually have. `null` means unknown, and
      // unknown minus one is still unknown, not a number.
      setPendingCount(c => (c === null ? null : Math.max(0, c - 1)))
      setShowReject(s => ({ ...s, [req.id]: false }))
    } finally {
      setActing(a => ({ ...a, [req.id]: null }))
    }
  }

  useEffect(() => {
    if (!canAccess(['superadmin'])) {
      router.push('/')
      return
    }
    load()
  }, [])

  const filtered = requests.filter(r => {
    if (statusFilter !== 'all' && r.status !== statusFilter) return false
    if (typeFilter !== 'all' && TYPE_CATEGORIES[r.type] !== typeFilter) return false
    return true
  })

  const STATUS_TABS: { key: StatusFilter; label: string }[] = [
    { key: 'pending',  label: pendingCount === null ? 'Pending' : `Pending (${pendingCount})` },
    { key: 'approved', label: 'Approved' },
    { key: 'rejected', label: 'Rejected' },
    { key: 'all',      label: 'All' },
  ]

  // Category counts for current status filter — over BOTH lists on this screen.
  // `kycCounts` is what the Applicants & KYC section is showing for the same
  // status view; without it the pills describe the permission requests alone
  // while filtering the applications too.
  const catCounts = Object.fromEntries(
    CATEGORY_LABELS.map(({ key }) => {
      const permissions = key === 'all'
        ? requests.filter(r => statusFilter === 'all' || r.status === statusFilter).length
        : requests.filter(r =>
            (statusFilter === 'all' || r.status === statusFilter) &&
            TYPE_CATEGORIES[r.type] === key
          ).length
      const applicants =
        key === 'all' ? kycCounts.all
        : key === 'agency' ? kycCounts.agency
        : key === 'seller' ? kycCounts.seller
        : key === 'host' ? kycCounts.host
        // team, finance and config have no applicants — there is no such thing
        // as a team application — so they are permission requests only.
        : 0
      return [key, permissions + applicants]
    })
  ) as Record<TypeCategory, number>

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Approval Queue</h1>
          <p className="text-slate-400 text-sm mt-1 max-w-2xl">
            {isSuperAdmin
              ? 'Applicants and their KYC, and permission requests from staff. ' +
                'Approving an applicant here approves their KYC too. The tabs ' +
                'switch between what is waiting and what has already been ' +
                'decided — both lists below follow them.'
              : 'Track actions you have submitted for approval'}
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 px-3 py-2 bg-slate-800 text-slate-300 rounded-lg hover:bg-slate-700 transition-colors text-sm"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Status Tabs */}
      <div className="flex gap-1 border-b border-slate-800">
        {STATUS_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setStatus(tab.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
              statusFilter === tab.key
                ? 'border-pink-500 text-pink-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {tab.label}
            {/* The pending tally failed on its own. Say so beside the tab it
                belongs to rather than printing "(0)" and moving on. */}
            {tab.key === 'pending' && countFailure && (
              <span className="ml-1.5"><UnavailableInline failure={countFailure} label="(count unavailable)" /></span>
            )}
          </button>
        ))}
      </div>

      {/* ── Type Category Filter ────────────────────────────────────────────
          Above BOTH lists now, because it filters both. It used to sit between
          them, which made it look like it belonged to the permission requests —
          and until this change it did, which is half of why "Host + Approved"
          could show nothing without looking broken. */}
      <div className="flex items-center gap-2 flex-wrap">
        <Filter size={13} className="text-slate-500 shrink-0" />
        {CATEGORY_LABELS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setType(key)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              typeFilter === key
                ? 'bg-pink-500 text-white'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
            }`}
          >
            {label}
            {catCounts[key] > 0 && (
              <span className={`ml-1.5 ${typeFilter === key ? 'text-pink-200' : 'text-slate-500'}`}>
                {catCounts[key]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Applicants and KYC ──────────────────────────────────────────────
          Shown above the permission requests, on EVERY tab.
          It used to be mounted only when `statusFilter === 'pending'`, which
          meant the Approved, Rejected and All tabs had no source of applicants
          at all — their only list was `approvalRequests`, the staff permission
          collection, which has never held a host application. So the screen said
          "No approved requests in host" about a host whose KYC was approved and
          whose profile said so. The decided rows were always in the data; both
          screens were discarding them.

          These rows are the applications themselves — not copies of them — and
          approving one here IS approving the KYC: the same server call /kyc
          makes, writing both status fields, the decider, the reason and the
          host grant together. Only the pending view offers that; a decided row
          is read-only and links to /kyc, where the documents are. */}
      <KycApprovals
        status={statusFilter}
        type={typeFilter}
        onDecided={load}
        onCounts={setKycCounts}
      />

      <div className="pt-2">
        <h2 className="text-white font-semibold">Permission requests</h2>
        <p className="text-slate-500 text-xs mt-0.5 max-w-2xl">
          Actions staff have submitted for a superadmin to sign off. Not
          applications — applicants and their KYC are the section above, and this
          list has never held one.
        </p>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-2 border-pink-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : listFailure ? (
        // "No pending requests" is the single most reassuring sentence on this
        // screen. It is only printed when the queue was actually read.
        <UnavailablePanel failure={listFailure} what="The approval queue" onRetry={load} />
      ) : filtered.length === 0 ? (
        // Says PERMISSION requests, because that is all this list has ever held.
        // "No approved requests in host" was read as a statement about the host
        // whose KYC had just been approved, and it was never about applications
        // at all — those are the section above.
        <div className="text-center py-12 text-slate-500 text-sm">
          No {statusFilter === 'all' ? '' : `${statusFilter} `}permission requests
          {typeFilter !== 'all' ? ` in ${typeFilter}` : ''}.
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(req => {
            const StatusIcon = STATUS_ICONS[req.status]
            const category = TYPE_CATEGORIES[req.type]
            const isPending = req.status === 'pending'
            const isActing = acting[req.id]
            return (
              <div
                key={req.id}
                className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden hover:border-slate-700 transition-colors"
              >
                {/* Main row */}
                <div
                  className="flex items-center gap-4 p-4 cursor-pointer"
                  onClick={() => router.push(`/approvals/${req.id}`)}
                >
                  <span className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full flex-shrink-0 ${STATUS_STYLES[req.status]}`}>
                    <StatusIcon size={12} />
                    {req.status}
                  </span>
                  <span className="text-xs font-medium px-2 py-0.5 rounded bg-slate-800 text-slate-400 capitalize flex-shrink-0 hidden sm:inline">
                    {category}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm font-medium truncate">{req.description}</p>
                    <p className="text-slate-400 text-xs mt-0.5 truncate">
                      {req.targetLabel} · by {req.requestedBy.name} ({req.requestedBy.role})
                    </p>
                  </div>
                  <span className="text-slate-500 text-xs flex-shrink-0">
                    {timeAgo(req.requestedAt as unknown as { seconds: number })}
                  </span>
                  <ChevronRight size={16} className="text-slate-600 flex-shrink-0" />
                </div>

                {/* Inline approve / reject — superadmin + pending only */}
                {isSuperAdmin && isPending && (
                  <div className="border-t border-slate-800 px-4 py-3 flex flex-wrap items-center gap-2">
                    {/*
                      A host application cannot be approved from this queue —
                      `onApprovalApproved` refuses the type outright and marks
                      the request `rejected`, which reads as "Soumya was turned
                      down" when it means "this queue does not decide hosts".
                      The detail page already said so; this list did not, and
                      the list is where the button actually gets pressed.
                    */}
                    {HOST_DECISION_TYPES.includes(req.type) ? (
                      <Link
                        href="/kyc"
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600/20 border border-amber-500/40 hover:bg-amber-600/30 text-amber-200 rounded-lg text-xs font-medium transition-colors"
                      >
                        <AlertTriangle size={12} />
                        Decide on /kyc → Hosts
                      </Link>
                    ) : (
                      <button
                        onClick={() => handleApprove(req)}
                        disabled={!!isActing}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors"
                      >
                        {isActing === 'approve' ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle size={12} />}
                        Approve
                      </button>
                    )}
                    <button
                      onClick={() => {
                        if (showReject[req.id]) {
                          handleReject(req)
                        } else {
                          setShowReject(s => ({ ...s, [req.id]: true }))
                        }
                      }}
                      disabled={!!isActing}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors"
                    >
                      {isActing === 'reject' ? <Loader2 size={12} className="animate-spin" /> : <XCircle size={12} />}
                      Reject
                    </button>
                    {showReject[req.id] && (
                      <input
                        autoFocus
                        value={rejectNote[req.id] ?? ''}
                        onChange={e => setRejectNote(n => ({ ...n, [req.id]: e.target.value }))}
                        onKeyDown={e => e.key === 'Enter' && handleReject(req)}
                        placeholder="Reason for rejection (required)…"
                        className="flex-1 min-w-[200px] bg-slate-800 border border-slate-600 rounded-lg px-3 py-1.5 text-white text-xs placeholder-slate-500 focus:outline-none focus:border-red-500"
                      />
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
