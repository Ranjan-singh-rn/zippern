'use client'

/**
 * Coin sellers.
 *
 * A seller is inventory on credit walking around. The two things that were
 * never on one screen are here: what they hold, and what they owe.
 *
 * Credit standing drives the page. A seller who is overdue is blocked by the
 * API from taking new inventory (spec 4.3.12), so they are lifted to the top
 * as a recovery worklist rather than sitting in alphabetical order halfway
 * down a list nobody scrolls.
 *
 * Onboarding decisions here — approve, reject, deactivate — move no money and
 * need no owner signature (spec 9.2). Anything that does move money is a card,
 * raised from /lending or /coin-purchases.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowRight, Check, CheckCircle2, ClipboardCopy, Clock, Loader2,
  Plus, RefreshCw, ShoppingBag, X, XCircle,
} from 'lucide-react'
import { Column, DataTable } from '@/components/ui/DataTable'
import { Denied, Warning } from '@/components/ui/States'
import { useAuth } from '@/components/AuthProvider'
import { SecondRoleApplications } from '@/components/SecondRoleApplications'
import { FailedRegistrations } from '@/components/FailedRegistrations'
import { canAccess, hasPermission } from '@/lib/auth'
import { resendPartnerEmail } from '@/lib/partnerEmails'
import { ApiError } from '@/lib/api'
import { getSellers, type Seller } from '@/lib/sellers'
import { loginStateOf, type LoginState } from '@/lib/partnerDuplicates'
import {
  credit as creditApi, inBatches, partnerOps, statements,
  coins as coinText, daysOverdue, standingOf, when,
  STANDING_LABEL, STANDING_TONE, STATUS_TONE,
  type CreditStanding, type OverdueSeller, type Partner,
  type PartnerStatus, type SellerStatement,
} from '@/lib/apiPartners'

const PAGE_ROLES = [
  'superadmin', 'app_admin', 'ops_admin', 'ops_member',
  'finance_admin', 'finance_member',
] as const

const MIN_REASON = 3

const STANDING_RANK: Record<CreditStanding, number> = {
  overdue: 0,
  due_soon: 1,
  current: 2,
  written_off: 3,
  none: 4,
}

interface Row {
  id: string
  name: string
  email: string
  phone: string
  status: PartnerStatus
  /** Stored on the record by the API, and shown here so it is not lost. */
  rejectionReason: string
  isActive: boolean
  standing: CreditStanding
  outstanding: number
  dueAt: string | null
  overdueDays: number
  /** Filled in after the list renders — the list endpoint carries no balances. */
  statement: SellerStatement | null
  /**
   * What can sign in as this seller, from the Firestore record.
   *
   * `null` means the Firestore document was not read — not that there is no
   * login. The two must not be conflated: badging a row "no login attached"
   * because a read failed would be a lie in the same shape as the one this
   * whole change exists to remove.
   */
  login: LoginState | null
  partner: Partner
}

type Action = 'approve' | 'reject' | 'deactivate'

const ACTION_COPY: Record<Action, { title: string; hint: string; verb: string; tone: string }> = {
  approve: {
    title: 'Approve this seller',
    hint: 'They become able to buy and borrow inventory. No money moves now.',
    verb: 'Approve',
    tone: 'bg-green-600 hover:bg-green-500',
  },
  reject: {
    title: 'Reject this application',
    hint: 'The reason is stored on the record and shown to the applicant, so they are told why instead of silently reapplying.',
    verb: 'Reject',
    tone: 'bg-red-600 hover:bg-red-500',
  },
  deactivate: {
    title: 'Deactivate this seller',
    hint: 'The record is kept and their history stays attributable. Any outstanding credit remains owed.',
    verb: 'Deactivate',
    tone: 'bg-amber-600 hover:bg-amber-500',
  },
}

export default function Sellers() {
  const { crmUser } = useAuth()
  const allowed = !!crmUser && canAccess(crmUser, [...PAGE_ROLES])

  /*
   * The decide buttons, gated on the PERMISSION rather than on who may open the
   * page — and those are deliberately different lists.
   *
   * Viewing a partner is reasonable for finance, who have to reconcile against
   * them; approving one is `can_approve_kyc` / `can_approve_seller`, which only
   * `superadmin` and `ops_admin` hold. The page gate admitted the wider list and
   * then rendered live Approve and Reject buttons to all of them, so four roles
   * could fill in a mandatory reason, press a button and receive a 403 — with
   * no way to tell a permission boundary from a broken screen.
   *
   * The server was already right. This only stops the UI offering what it will
   * refuse. Nobody gains a permission here.
   */
  const mayDecide = hasPermission(crmUser, 'can_approve_seller')

  const [partners, setPartners] = useState<Partner[]>([])
  const [balances, setBalances] = useState<Record<string, SellerStatement>>({})
  // The Firestore side of a seller. The API record does not carry `crmUid` or
  // `ownerUid`, and those two are the whole answer to "can anybody sign in as
  // this?" — see the orphan badge below.
  const [profiles, setProfiles] = useState<Record<string, Seller>>({})
  const [profilesRead, setProfilesRead] = useState(false)
  const [overdue, setOverdue] = useState<OverdueSeller[]>([])
  const [loading, setLoading] = useState(true)
  const [enriching, setEnriching] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [status, setStatus] = useState('all')
  const [standing, setStanding] = useState('all')
  const [pending, setPending] = useState<{ row: Row; action: Action } | null>(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const [list, late] = await Promise.all([
        partnerOps.list({ kind: 'seller', limit: 500 }),
        creditApi.overdue().catch(() => [] as OverdueSeller[]),
      ])
      setPartners(list)
      setOverdue(late)
      setLoading(false)

      // `sellers` is readable by any signed-in caller — `allow read: if
      // request.auth != null` — so this always runs for staff. A failure leaves
      // `profilesRead` false and the orphan badge silent, which is the honest
      // answer: not "everyone has a login", but "we did not look".
      getSellers()
        .then((docs) => {
          const byId: Record<string, Seller> = {}
          docs.forEach((d) => { byId[d.id] = d })
          setProfiles(byId)
          setProfilesRead(true)
        })
        .catch(() => { setProfiles({}); setProfilesRead(false) })

      // Balances are one call per seller, so they arrive after the table does
      // rather than holding it hostage.
      setEnriching(true)
      const found: Record<string, SellerStatement> = {}
      await inBatches(list, async (p) => {
        const st = await statements.seller(p.id)
        found[p.id] = st
        return st
      })
      setBalances(found)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load sellers.')
      setLoading(false)
    } finally {
      setEnriching(false)
    }
  }, [])

  useEffect(() => { if (allowed) load() }, [allowed, load])

  const rows = useMemo<Row[]>(() => {
    const mapped = partners.map((p) => {
      const st = balances[p.id] ?? null
      const outstanding = st?.credit_outstanding ?? p.credit?.outstanding ?? 0
      const dueAt = st?.credit_due_at ?? p.credit?.due_at ?? null
      const profile = profiles[p.id] ?? null
      return {
        id: p.id,
        name: p.name || p.id,
        email: p.email ?? '',
        phone: p.phone ?? '',
        status: p.status,
        rejectionReason: p.rejection_reason ?? '',
        isActive: p.is_active,
        standing: st?.credit_standing ?? standingOf(p.credit),
        outstanding,
        dueAt,
        overdueDays: daysOverdue(dueAt),
        statement: st,
        login: profile ? loginStateOf(profile) : null,
        partner: p,
      }
    })
    // Overdue first, then by how much is at risk. The recovery worklist should
    // not need sorting by hand.
    return mapped.sort((a, b) => {
      const rank = STANDING_RANK[a.standing] - STANDING_RANK[b.standing]
      if (rank !== 0) return rank
      return b.outstanding - a.outstanding
    })
  }, [partners, balances, profiles])

  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          (status === 'all' || r.status === status) &&
          (standing === 'all' || r.standing === standing),
      ),
    [rows, status, standing],
  )

  // Which sellers already have a business record. A second-capability
  // application that is in here needs no bridging — it is already in the queue.
  const knownPartnerIds = useMemo(
    () => new Set(partners.map((p) => p.id)),
    [partners],
  )

  const overdueRows = rows.filter((r) => r.standing === 'overdue')
  const totalOutstanding = rows.reduce((sum, r) => sum + r.outstanding, 0)
  // Sellers nobody can sign in as. Counted only from records actually read —
  // `login: null` means the Firestore document was not seen, not that it is fine.
  const noLoginRows = rows.filter((r) => r.login === 'none')

  const columns: Column<Row>[] = [
    {
      key: 'name',
      header: 'Seller',
      value: (r) => r.name,
      render: (r) => (
        <div className="min-w-0">
          <Link
            href={`/sellers/${r.id}`}
            className="text-white font-medium truncate hover:text-pink-400 transition-colors block"
          >
            {r.name}
          </Link>
          <p className="text-slate-600 text-xs font-mono truncate">{r.id}</p>
          {/* An agency applying to also sell coins. Approving this row grants
              that capability on their existing login and creates this record at
              zero — the coin balance below is theirs alone, and their
              commission stays on the agency record it has always been on. */}
          {r.partner.second_role_of && (
            <span
              className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-300 mt-0.5"
              title={`Second capability for agency ${r.partner.second_role_of}`}
            >
              also an agency
            </span>
          )}
          {/* Nobody can sign in as this seller. It is what a registration that
              half-failed leaves behind: the record was written, the login was
              not. Three of these existed for one address before the four
              registration forms were reordered to create the login first. */}
          {r.login === 'none' && (
            <span
              className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 mt-0.5"
              title="Neither crmUid nor ownerUid is set on the Firestore record — nobody can ever sign in as this seller."
            >
              no login attached
            </span>
          )}
          {r.login === 'app_only' && (
            <span
              className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 mt-0.5"
              title="No crmUid on the Firestore record — an app account owns it, but nobody can sign into the CRM as this seller."
            >
              no CRM login
            </span>
          )}
          {(r.email || r.phone) && (
            <p className="text-slate-500 text-xs truncate">
              {[r.phone, r.email].filter(Boolean).join(' · ')}
            </p>
          )}
          {/* The rejection reason, kept in front of whoever looks next. An
              applicant who is told nothing simply reapplies. */}
          {r.status === 'rejected' && (
            <p className="flex items-start gap-1 text-xs mt-1 text-red-300/90">
              <XCircle size={10} className="mt-0.5 shrink-0" />
              <span className="truncate max-w-xs" title={r.rejectionReason}>
                {r.rejectionReason || 'rejected — no reason on record'}
              </span>
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      value: (r) => r.status,
      render: (r) => (
        <span className={`text-xs px-2 py-1 rounded ${STATUS_TONE[r.status] ?? 'bg-slate-700 text-slate-300'}`}>
          {r.status}{r.status === 'approved' && !r.isActive ? ' · inactive' : ''}
        </span>
      ),
    },
    {
      key: 'standing',
      header: 'Credit standing',
      value: (r) => STANDING_LABEL[r.standing],
      render: (r) => (
        <div>
          <span className={`text-xs px-2 py-1 rounded ${STANDING_TONE[r.standing]}`}>
            {STANDING_LABEL[r.standing]}
          </span>
          {r.standing === 'overdue' && (
            <p className="text-red-400 text-xs mt-1">
              {r.overdueDays}d late · blocked
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'outstanding',
      header: 'Owes',
      align: 'right',
      value: (r) => r.outstanding,
      render: (r) => (
        <span className={r.outstanding > 0 ? 'text-amber-300 font-semibold' : 'text-slate-600'}>
          {r.outstanding > 0 ? coinText(r.outstanding) : '—'}
        </span>
      ),
    },
    {
      key: 'on_hand',
      header: 'On hand',
      align: 'right',
      hideOnMobile: true,
      value: (r) => r.statement?.coins_on_hand ?? null,
      render: (r) => <Amount value={r.statement?.coins_on_hand} pending={enriching} />,
    },
    {
      key: 'purchased',
      header: 'Purchased',
      align: 'right',
      hideOnMobile: true,
      value: (r) => r.statement?.coins_purchased ?? null,
      render: (r) => <Amount value={r.statement?.coins_purchased} pending={enriching} muted />,
    },
    {
      key: 'sold',
      header: 'Sold',
      align: 'right',
      hideOnMobile: true,
      value: (r) => r.statement?.coins_sold ?? r.partner.total_coins_sold ?? null,
      render: (r) => (
        <Amount
          value={r.statement?.coins_sold ?? r.partner.total_coins_sold}
          pending={enriching}
          muted
        />
      ),
    },
    {
      key: 'due',
      header: 'Due',
      hideOnMobile: true,
      value: (r) => r.dueAt ?? '',
      render: (r) => (
        <span className={r.standing === 'overdue' ? 'text-red-300 text-xs' : 'text-slate-400 text-xs'}>
          {r.dueAt ? when(r.dueAt) : '—'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      sortable: false,
      value: () => '',
      render: (r) => (
        <div className="flex items-center justify-end gap-1.5">
          {mayDecide && r.status !== 'approved' && (
            <RowButton tone="green" onClick={() => setPending({ row: r, action: 'approve' })}>
              <CheckCircle2 size={11} /> Approve
            </RowButton>
          )}
          {mayDecide && r.status !== 'rejected' && (
            <RowButton tone="red" onClick={() => setPending({ row: r, action: 'reject' })}>
              <XCircle size={11} /> Reject
            </RowButton>
          )}
          {mayDecide && (
            <RowButton
              tone="slate"
              onClick={async () => {
                /*
                 * Re-sends the standard email — no credential in it, and no
                 * account created. Optimistic and quiet: the trigger deletes the
                 * field once it has sent, so there is no state to reconcile and
                 * a failure costs nothing but a second press.
                 */
                try {
                  await resendPartnerEmail(
                    'seller', r.id,
                    r.status === 'approved' ? 'approval' : 'registration',
                  )
                  setNotice(`Email queued again for ${r.name || r.id}.`)
                } catch {
                  setNotice('Could not queue that email. Try again.')
                }
              }}
            >
              Resend email
            </RowButton>
          )}
          {mayDecide && r.isActive && (
            <RowButton tone="slate" onClick={() => setPending({ row: r, action: 'deactivate' })}>
              Deactivate
            </RowButton>
          )}
        </div>
      ),
    },
  ]

  if (!allowed) return <Denied what="coin sellers" />

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2">
            <ShoppingBag size={26} className="text-pink-500" />
            Coin sellers
          </h1>
          <p className="text-slate-400 text-sm mt-1 max-w-2xl">
            What each seller holds and what each seller owes, from the ledger the
            business runs on.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/sellers/register"
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2.5 text-sm transition-colors"
          >
            <Plus size={14} /> Add seller
          </Link>
          <Link
            href="/lending"
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2.5 text-sm transition-colors"
          >
            Credit book <ArrowRight size={14} />
          </Link>
          {/* The other side of the book. Everything on this page is inventory
              going up; sales are the only thing that brings it down. */}
          <Link
            href="/sales"
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2.5 text-sm transition-colors"
          >
            Sales <ArrowRight size={14} />
          </Link>
          <button
            onClick={() => { setLoading(true); load() }}
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2.5 text-sm transition-colors"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {/* A seller can also apply without us. That link was in the codebase and
          nowhere else, so it is here to be copied and sent. */}
      <PublicSignupLink
        path="/seller-signup"
        lead="A coin seller can apply themselves at"
      />

      {/* Existing agencies asking to also sell coins. Renders nothing when
          there are none. Filing one creates a separate seller record holding
          nothing and puts it in the table below. */}
      <SecondRoleApplications
        kind="seller"
        knownPartnerIds={knownPartnerIds}
        onFiled={() => { setLoading(true); load() }}
      />

      {/* Coin sellers whose business record could not be created when they
          registered. They are not in the table below and nobody can approve
          them — see components/FailedRegistrations.tsx. Renders nothing when
          every registration went through, which is the normal case. */}
      <FailedRegistrations
        kind="seller"
        knownPartnerIds={knownPartnerIds}
        onRegistered={() => { setLoading(true); load() }}
      />

      {notice && <Warning onDismiss={() => setNotice('')}>{notice}</Warning>}

      {/* Sellers with no login. These are the residue of the registration bug:
          the record was written before the Firebase Auth account, so every
          retry against an address that already had a login left one behind.
          Nothing here deletes anything — reject the duplicates with the ordinary
          Reject button, which records a reason and stays auditable. */}
      {profilesRead && noLoginRows.length > 0 && (
        <div className="bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3.5 mb-4">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="text-red-400 mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-red-200 text-sm font-semibold">
                {noLoginRows.length} seller record
                {noLoginRows.length === 1 ? ' has' : 's have'} no login attached.
              </p>
              <p className="text-red-200/75 text-sm mt-0.5">
                Neither <span className="font-mono">crmUid</span> nor{' '}
                <span className="font-mono">ownerUid</span> is set, so nobody can
                ever sign in as them — they are what a registration that
                half-failed leaves behind. Approving one does nothing useful.
                Reject the duplicates below; the reason goes on the record.
              </p>
              <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                {noLoginRows.slice(0, 8).map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 text-xs">
                    <Link href={`/sellers/${r.id}`} className="text-red-100 truncate hover:text-white">
                      {r.name}
                    </Link>
                    <span className="text-red-300 shrink-0">{r.email || r.id}</span>
                  </li>
                ))}
              </ul>
              {noLoginRows.length > 8 && (
                <p className="text-red-200/60 text-xs mt-1">
                  and {noLoginRows.length - 8} more.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {overdueRows.length > 0 && (
        <div className="bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3.5 mb-4">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="text-red-400 mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-red-200 text-sm font-semibold">
                {overdueRows.length} seller{overdueRows.length === 1 ? ' is' : 's are'} past
                due and blocked from new inventory.
              </p>
              <p className="text-red-200/75 text-sm mt-0.5">
                This is the recovery worklist. They cannot buy or borrow again
                until the debt is cleared — the API refuses it.
              </p>
              <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                {overdueRows.slice(0, 8).map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-red-100 truncate">{r.name}</span>
                    <span className="text-red-300 shrink-0">
                      {coinText(r.outstanding)} · {r.overdueDays}d
                    </span>
                  </li>
                ))}
              </ul>
              {overdueRows.length > 8 && (
                <p className="text-red-200/60 text-xs mt-1">
                  and {overdueRows.length - 8} more — filter by standing to see them all.
                </p>
              )}
              <Link
                href="/lending"
                className="inline-flex items-center gap-1.5 text-red-200 hover:text-white text-xs mt-2 underline underline-offset-2"
              >
                Raise a recovery in the credit book <ArrowRight size={11} />
              </Link>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Sellers" value={String(rows.length)} tone="text-white" />
        <Stat
          label="Approved"
          value={String(rows.filter((r) => r.status === 'approved').length)}
          tone="text-slate-300"
        />
        <Stat
          label="Awaiting a decision"
          value={String(rows.filter((r) => r.status === 'pending').length)}
          tone={rows.some((r) => r.status === 'pending') ? 'text-amber-300' : 'text-slate-600'}
        />
        <Stat
          label="Credit outstanding"
          value={coinText(totalOutstanding)}
          tone={totalOutstanding > 0 ? 'text-amber-300' : 'text-slate-600'}
        />
      </div>

      {overdue.length > overdueRows.length && (
        <Warning>
          The credit service reports {overdue.length} overdue seller
          {overdue.length === 1 ? '' : 's'}, but only {overdueRows.length} appear in
          this list — some are outside the {partners.length} records loaded here.
        </Warning>
      )}

      <DataTable<Row>
        rows={filtered}
        columns={columns}
        rowKey={(r) => r.id}
        loading={loading}
        error={error}
        onRetry={() => { setLoading(true); load() }}
        searchPlaceholder="Search by seller name, phone, email or id…"
        searchKeys={['name', 'phone', 'email', 'id']}
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'pending', label: 'Pending' },
              { value: 'approved', label: 'Approved' },
              { value: 'rejected', label: 'Rejected' },
              { value: 'suspended', label: 'Suspended' },
            ],
          },
          {
            key: 'standing',
            label: 'Credit',
            options: [
              { value: 'overdue', label: 'Overdue' },
              { value: 'due_soon', label: 'Due soon' },
              { value: 'current', label: 'Current' },
              { value: 'none', label: 'No credit' },
              { value: 'written_off', label: 'Written off' },
            ],
          },
        ]}
        activeFilters={{ status, standing }}
        onFilterChange={(key, value) => {
          if (key === 'status') setStatus(value)
          else setStanding(value)
        }}
        exportName="coin-sellers"
        emptyTitle="No sellers yet"
        emptyHint="Sellers appear here once they apply."
        truncatedAt={500}
      />

      {pending && (
        <ReasonDialog
          title={ACTION_COPY[pending.action].title}
          hint={ACTION_COPY[pending.action].hint}
          verb={ACTION_COPY[pending.action].verb}
          tone={ACTION_COPY[pending.action].tone}
          subject={pending.row.name}
          extra={
            pending.action === 'deactivate' && pending.row.outstanding > 0 ? (
              <p className="text-amber-300 text-xs">
                This seller still owes {coinText(pending.row.outstanding)}.
                Deactivating does not cancel the debt.
              </p>
            ) : null
          }
          onClose={() => setPending(null)}
          onConfirm={async (reason) => {
            const { row, action } = pending
            if (action === 'approve') await partnerOps.approve(row.id, reason)
            else if (action === 'reject') await partnerOps.reject(row.id, reason)
            else await partnerOps.deactivate(row.id, reason)
            setPending(null)
            setNotice(`${row.name}: ${action}d. The reason is on the record.`)
            load()
          }}
        />
      )}
    </div>
  )
}

// ── Bits ──────────────────────────────────────────────────────────────────────

/**
 * The public signup URL, in full, copyable, without leaving this page.
 *
 * The host is read from the browser rather than hardcoded — the CRM and the
 * public forms are served from the same origin — with
 * `NEXT_PUBLIC_PUBLIC_SITE_URL` overriding it when the CRM is being run
 * locally but the link to hand out is the deployed one.
 *
 * `navigator.clipboard` does not exist on an http origin, so there is a
 * fallback, and when even that fails the text is selected and the page says so.
 */
function PublicSignupLink({ path, lead }: { path: string; lead: string }) {
  const [origin, setOrigin] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [manual, setManual] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const configured = process.env.NEXT_PUBLIC_PUBLIC_SITE_URL
    setOrigin(
      configured && configured.trim()
        ? configured.trim().replace(/\/+$/, '')
        : typeof window !== 'undefined'
          ? window.location.origin
          : '',
    )
  }, [])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 2500)
    return () => clearTimeout(t)
  }, [copied])

  if (origin === null) {
    return <p className="text-slate-600 text-xs mb-4">Working out the public signup address…</p>
  }
  if (origin === '') {
    return (
      <p className="text-slate-500 text-xs mb-4">
        {lead} <span className="font-mono text-slate-400">{path}</span> — this
        site’s address could not be read, so the full link cannot be shown.
      </p>
    )
  }

  const url = `${origin}${path}`

  async function copy() {
    setManual(false)
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url)
        setCopied(true)
        return
      }
    } catch {
      // Fall through to the selection below.
    }
    const el = inputRef.current
    if (el) {
      el.focus()
      el.select()
      try {
        if (document.execCommand('copy')) { setCopied(true); return }
      } catch {
        // Same again.
      }
    }
    setManual(true)
  }

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-500">{lead}</span>
        <input
          ref={inputRef}
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Public signup link"
          size={Math.min(url.length + 1, 48)}
          className="bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-300 font-mono focus:outline-none focus:border-pink-500"
        />
        <button
          type="button"
          onClick={copy}
          className={`inline-flex items-center gap-1 rounded px-2 py-1 transition-colors ${
            copied ? 'bg-green-600/90 text-white' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
          }`}
        >
          {copied ? <><Check size={11} /> Copied</> : <><ClipboardCopy size={11} /> Copy</>}
        </button>
        <Link href="/onboarding" className="text-pink-400 hover:text-pink-300">
          How partners join
        </Link>
      </div>
      {manual && (
        <p className="text-amber-300/90 text-xs mt-1">
          This browser would not let the page write to the clipboard. The link is
          selected — press Ctrl+C, or ⌘C on a Mac.
        </p>
      )}
    </div>
  )
}

function Amount({
  value,
  pending,
  muted,
}: {
  value: number | undefined | null
  pending: boolean
  muted?: boolean
}) {
  if (value == null) {
    return pending ? (
      <Loader2 size={11} className="animate-spin text-slate-700 inline" />
    ) : (
      <span className="text-slate-700">—</span>
    )
  }
  return (
    <span className={muted ? 'text-slate-400' : 'text-white font-medium'}>
      {value.toLocaleString('en-IN')}
    </span>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">{label}</p>
      <p className={`text-xl font-bold mt-1 ${tone}`}>{value}</p>
    </div>
  )
}

function RowButton({
  children,
  onClick,
  tone,
}: {
  children: React.ReactNode
  onClick: () => void
  tone: 'green' | 'red' | 'slate'
}) {
  const tones = {
    green: 'bg-green-600/90 hover:bg-green-500 text-white',
    red: 'bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/30',
    slate: 'bg-slate-800 hover:bg-slate-700 text-slate-300',
  }
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${tones[tone]}`}
    >
      {children}
    </button>
  )
}

/**
 * Every partner decision carries a reason. A change with no stated reason is
 * not auditable, so the API refuses one — this validates before sending so the
 * refusal is not the first time anyone hears about it.
 */
function ReasonDialog({
  title,
  hint,
  verb,
  tone,
  subject,
  extra,
  onClose,
  onConfirm,
}: {
  title: string
  hint: string
  verb: string
  tone: string
  subject: string
  extra?: React.ReactNode
  onClose: () => void
  onConfirm: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const valid = reason.trim().length >= MIN_REASON

  async function go() {
    if (!valid) return
    setBusy(true)
    setErr('')
    try {
      await onConfirm(reason.trim())
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'That did not go through.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-md">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800">
          <div>
            <h2 className="text-white font-semibold">{title}</h2>
            <p className="text-slate-500 text-xs mt-0.5">{subject}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-3">
          <p className="text-slate-400 text-sm">{hint}</p>
          {extra}
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            autoFocus
            placeholder="Reason — kept on the record and in the audit log."
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 resize-none"
          />
          {reason.trim().length > 0 && !valid && (
            <p className="text-amber-400 text-xs flex items-center gap-1.5">
              <Clock size={11} /> At least {MIN_REASON} characters.
            </p>
          )}
          {err && (
            <p className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-300 text-sm">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {err}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-800">
          <button onClick={onClose} className="text-slate-400 hover:text-white text-sm px-4 py-2">
            Cancel
          </button>
          <button
            onClick={go}
            disabled={!valid || busy}
            className={`flex items-center gap-2 disabled:bg-slate-800 disabled:text-slate-600 text-white font-semibold rounded-lg px-5 py-2.5 text-sm transition-colors ${tone}`}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {verb}
          </button>
        </div>
      </div>
    </div>
  )
}
