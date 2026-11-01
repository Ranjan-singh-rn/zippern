'use client'

/**
 * Seller sales — the screen that makes inventory come down.
 *
 * `POST /partner-ops/sales`, `GET /partner-ops/sales` and
 * `POST /partner-ops/sales/{id}/approve` have existed and been audited for as
 * long as the API has. Nothing in the CRM called any of them, so no sale was
 * ever filed, and a seller's inventory only ever went up: they bought coins,
 * they borrowed coins, and the "sold" figure was a lifetime counter nothing
 * decremented. This is the missing half of that book.
 *
 * Two things are worth knowing before pressing anything here:
 *
 *   * **Filing a sale moves nothing.** It records that a sale happened and
 *     leaves it `pending`. That is deliberate — the record is the claim, the
 *     approval is the money.
 *   * **Approving is where value moves, and it is owner-only.** The seller's
 *     coins are debited *first*, then the buyer's diamonds are credited
 *     (`backend/app/services/partner_ops.py:1264`). The order matters: a seller
 *     short of stock stops the sale before any diamonds are minted.
 *
 * The state to watch for is `failed`. It means the debit went through and the
 * credit did not — the seller has lost stock the buyer never received. It is
 * the only status on this screen that needs a person rather than a retry, so it
 * is surfaced at the top and never folded in with "not approved yet".
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowRight, CheckCircle2, Coins, Loader2, Plus, RefreshCw,
  ShieldCheck, ShoppingCart, X, XCircle,
} from 'lucide-react'
import { Column, DataTable } from '@/components/ui/DataTable'
import { DateRangePicker, defaultRange, type Range } from '@/components/ui/DateRange'
import { Denied, Warning } from '@/components/ui/States'
import UserSearchPicker from '@/components/UserSearchPicker'
import { useAuth } from '@/components/AuthProvider'
import { canAccess, hasPermission } from '@/lib/auth'
import { IdentityBlock } from '@/components/ui/Identity'
import { nameOrReference } from '@/lib/identity'
import { useIdentities } from '@/lib/useIdentities'
import api, { ApiError, type Sale, type SaleStatus } from '@/lib/api'
import {
  partnerOps, statements,
  coins as coinText, inr,
  type Partner, type SellerStatement,
} from '@/lib/apiPartners'

const PAGE_ROLES = [
  'superadmin', 'ops_admin', 'ops_member', 'finance_admin', 'finance_member',
] as const

const MIN_REASON = 3

/** How many sales are read. `GET /partner-ops/sales` caps at 500 server-side. */
const LIMIT = 500

const STATUS_LABEL: Record<SaleStatus, string> = {
  pending: 'Filed — nothing has moved',
  approved: 'Approved — inventory moved',
  failed: 'Failed — seller debited, buyer not credited',
}

const STATUS_TONE: Record<SaleStatus, string> = {
  pending: 'bg-amber-500/15 text-amber-300',
  approved: 'bg-green-500/15 text-green-300',
  failed: 'bg-red-500/20 text-red-300',
}

function whenExact(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

interface Row {
  sale: Sale
  id: string
  sellerId: string
  sellerName: string
  buyerUid: string
  diamonds: number
  paidMinor: number
  status: SaleStatus
  reason: string
  recordedBy: string
  createdAt: string
}

export default function Sales() {
  const { crmUser } = useAuth()
  const allowed = !!crmUser && canAccess(crmUser, [...PAGE_ROLES])

  const [sales, setSales] = useState<Sale[]>([])
  const [sellers, setSellers] = useState<Partner[]>([])
  const [isOwner, setIsOwner] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [range, setRange] = useState<Range>(defaultRange())
  const [status, setStatus] = useState('all')
  const [seller, setSeller] = useState('all')
  const [filing, setFiling] = useState(false)
  const [approving, setApproving] = useState<Row | null>(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const [list, people, me] = await Promise.all([
        api.partnerOps.listSales({ limit: LIMIT }),
        partnerOps.list({ kind: 'seller', limit: 500 }).catch(() => [] as Partner[]),
        api.auth.me(),
      ])
      setSales(list)
      setSellers(people)
      setIsOwner(me.role === 'owner')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load sales.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (allowed) load() }, [allowed, load])

  const nameOf = useCallback(
    (id: string) => sellers.find((s) => s.id === id)?.name || id,
    [sellers],
  )

  const rows = useMemo<Row[]>(
    () =>
      sales.map((s) => ({
        sale: s,
        id: s.id,
        sellerId: s.seller_id,
        sellerName: nameOf(s.seller_id),
        buyerUid: s.buyer_uid,
        diamonds: s.diamonds,
        paidMinor: s.amount_paid_minor,
        status: s.status,
        reason: s.reason,
        recordedBy: s.recorded_by?.name || s.recorded_by?.role || '—',
        createdAt: s.created_at,
      })),
    [sales, nameOf],
  )

  // B1: the buyer is a Firebase uid — named from `users` (staff-readable);
  // email/phone only for a viewer who may read user profiles.
  const showContacts = hasPermission(crmUser, 'can_view_users')
  const buyers = useIdentities({ enabled: allowed, people: sales.map((s) => s.buyer_uid) })
  const buyerLabel = (uid: string) => nameOrReference(buyers.people.get(uid), uid, 'buyer')

  const inRange = useMemo(
    () =>
      rows.filter((r) => {
        const t = new Date(r.createdAt).getTime()
        // A row with an unreadable date is kept rather than silently dropped —
        // hiding it would understate the book.
        if (Number.isNaN(t)) return true
        return t >= range.since.getTime() && t <= range.until.getTime()
      }),
    [rows, range],
  )

  const filtered = useMemo(
    () =>
      inRange.filter(
        (r) =>
          (status === 'all' || r.status === status) &&
          (seller === 'all' || r.sellerId === seller),
      ),
    [inRange, status, seller],
  )

  /** Whether the figures below are actually known, as opposed to unread. */
  const known = !loading && !error
  const unknownHint = loading ? 'reading…' : 'could not be read'

  const failed = rows.filter((r) => r.status === 'failed')
  const pending = inRange.filter((r) => r.status === 'pending')
  const approved = inRange.filter((r) => r.status === 'approved')
  const diamondsApproved = approved.reduce((sum, r) => sum + r.diamonds, 0)
  const cashApproved = approved.reduce((sum, r) => sum + r.paidMinor, 0)

  const columns: Column<Row>[] = [
    {
      key: 'created',
      header: 'Filed',
      value: (r) => r.createdAt,
      render: (r) => (
        <div className="min-w-0">
          <p className="text-slate-300 text-xs whitespace-nowrap">{whenExact(r.createdAt)}</p>
          <p className="text-slate-600 text-xs truncate">by {r.recordedBy}</p>
        </div>
      ),
    },
    {
      key: 'seller',
      header: 'Seller',
      value: (r) => r.sellerName,
      render: (r) => (
        <div className="min-w-0">
          <Link
            href={`/sellers/${r.sellerId}`}
            className="text-white font-medium hover:text-pink-400 transition-colors block truncate"
          >
            {r.sellerName}
          </Link>
          <p className="text-slate-600 text-xs font-mono truncate">{r.sellerId}</p>
        </div>
      ),
    },
    {
      key: 'buyer',
      header: 'Buyer',
      hideOnMobile: true,
      value: (r) => r.buyerUid,
      render: (r) => (
        <IdentityBlock
          facts={buyers.people.get(r.buyerUid)}
          id={r.buyerUid}
          kind="buyer"
          state={buyers.state}
          showContacts={showContacts}
          href={`/users/${r.buyerUid}`}
          className="text-xs"
        />
      ),
    },
    {
      key: 'diamonds',
      header: 'Diamonds',
      align: 'right',
      value: (r) => r.diamonds,
      render: (r) => (
        <span className="text-yellow-300 font-semibold whitespace-nowrap">
          {r.diamonds.toLocaleString('en-IN')}
        </span>
      ),
    },
    {
      key: 'paid',
      header: 'Paid',
      align: 'right',
      hideOnMobile: true,
      // Exported in rupees, because a bare paise figure in a spreadsheet reads
      // as a hundred times the money.
      value: (r) => r.paidMinor / 100,
      render: (r) => (
        <span className={r.paidMinor > 0 ? 'text-slate-200' : 'text-slate-600'}>
          {r.paidMinor > 0 ? inr(r.paidMinor) : 'nothing recorded'}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      value: (r) => r.status,
      render: (r) => (
        <div>
          <span
            title={STATUS_LABEL[r.status]}
            className={`text-xs px-2 py-1 rounded whitespace-nowrap ${STATUS_TONE[r.status]}`}
          >
            {r.status}
          </span>
          {r.status === 'failed' && r.sale.failure && (
            <p className="text-red-300/80 text-xs mt-1 max-w-xs">{r.sale.failure}</p>
          )}
          {r.status === 'approved' && (
            <p className="text-slate-600 text-xs mt-1 whitespace-nowrap">
              {whenExact(r.sale.approved_at)}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      sortable: false,
      value: () => '',
      render: (r) =>
        r.status === 'pending' ? (
          isOwner ? (
            <button
              onClick={() => setApproving(r)}
              className="inline-flex items-center gap-1 bg-green-600/90 hover:bg-green-500 text-white px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors"
            >
              <CheckCircle2 size={11} /> Approve
            </button>
          ) : (
            <span className="text-slate-600 text-xs whitespace-nowrap">owner signs</span>
          )
        ) : null,
    },
  ]

  if (!allowed) return <Denied what="seller sales" />

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2">
            <ShoppingCart size={26} className="text-pink-500" />
            Seller sales
          </h1>
          <p className="text-slate-400 text-sm mt-1 max-w-2xl">
            Filing a sale records it and moves nothing. Approving it debits the
            seller&rsquo;s inventory and credits the buyer —{' '}
            <span className="text-white font-medium">
              that is the only thing that brings a seller&rsquo;s stock down
            </span>
            , and only an owner can do it.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DateRangePicker value={range} onChange={setRange} />
          <button
            onClick={() => { setLoading(true); load() }}
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2.5 text-sm transition-colors"
          >
            <RefreshCw size={14} /> Refresh
          </button>
          <button
            onClick={() => setFiling(true)}
            className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            <Plus size={15} /> File a sale
          </button>
        </div>
      </div>

      {notice && <Warning onDismiss={() => setNotice('')}>{notice}</Warning>}

      {/* The one status that is not a queue position. Shown across the whole
          book, not just the selected range — a broken sale does not stop being
          broken because it happened last month. */}
      {failed.length > 0 && (
        <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3.5 mb-4">
          <XCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-red-200 text-sm font-semibold">
              {failed.length} sale{failed.length === 1 ? '' : 's'} failed part-way
              through.
            </p>
            <p className="text-red-200/80 text-sm mt-0.5">
              The seller was debited and the buyer was not credited. That value is
              currently nowhere. Each of these needs a correction card — approving
              again will not fix it, and the API will refuse.
            </p>
            <ul className="mt-2 space-y-1">
              {failed.slice(0, 5).map((r) => (
                <li key={r.id} className="text-red-100/85 text-xs">
                  {r.sellerName} → {buyerLabel(r.buyerUid)} · {r.diamonds.toLocaleString('en-IN')}{' '}
                  diamonds · {whenExact(r.createdAt)}
                  {r.sale.failure ? ` — ${r.sale.failure}` : ''}
                </li>
              ))}
            </ul>
            {failed.length > 5 && (
              <p className="text-red-200/60 text-xs mt-1">
                and {failed.length - 5} more — filter by status to see them all.
              </p>
            )}
            <Link
              href="/board"
              className="inline-flex items-center gap-1.5 text-red-200 hover:text-white text-xs mt-2 underline underline-offset-2"
            >
              Raise a correction on the money board <ArrowRight size={11} />
            </Link>
          </div>
        </div>
      )}

      {/* A zero here has to mean zero. While the fetch is in flight, or after it
          failed, these show a dash — "no sales" and "we could not read the
          sales" are different answers and must not look the same. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat
          label="Awaiting approval"
          value={known ? String(pending.length) : '—'}
          tone={known && pending.length > 0 ? 'text-amber-300' : 'text-slate-600'}
          hint={known ? 'nothing has moved on these' : unknownHint}
        />
        <Stat
          label="Approved"
          value={known ? String(approved.length) : '—'}
          tone={known ? 'text-white' : 'text-slate-600'}
          hint={known ? range.label.toLowerCase() : unknownHint}
        />
        <Stat
          label="Diamonds sold"
          value={known ? diamondsApproved.toLocaleString('en-IN') : '—'}
          tone={known ? 'text-yellow-300' : 'text-slate-600'}
          hint={known ? 'approved sales only' : unknownHint}
        />
        <Stat
          label="Cash recorded"
          value={known ? inr(cashApproved) : '—'}
          tone={known ? 'text-slate-200' : 'text-slate-600'}
          hint={known ? 'on approved sales' : unknownHint}
        />
      </div>

      <DataTable<Row>
        rows={filtered}
        columns={columns}
        rowKey={(r) => r.id}
        loading={loading}
        error={error}
        onRetry={() => { setLoading(true); load() }}
        searchPlaceholder="Search by seller name, seller id, buyer uid or sale id…"
        searchKeys={['seller', 'buyer', 'id']}
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'pending', label: 'Filed, not approved', count: inRange.filter((r) => r.status === 'pending').length },
              { value: 'approved', label: 'Approved', count: inRange.filter((r) => r.status === 'approved').length },
              { value: 'failed', label: 'Failed', count: inRange.filter((r) => r.status === 'failed').length },
            ],
          },
          {
            key: 'seller',
            label: 'Seller',
            options: sellers.map((s) => ({ value: s.id, label: s.name || s.id })),
          },
        ]}
        activeFilters={{ status, seller }}
        onFilterChange={(key, value) => {
          if (key === 'status') setStatus(value)
          else setSeller(value)
        }}
        exportName="seller-sales"
        emptyTitle={
          sales.length === 0 ? 'No sales have ever been filed' : 'Nothing in this range'
        }
        emptyHint={
          sales.length === 0
            ? 'Until a sale is filed and approved, a seller’s inventory only ever goes up. File the first one with the button above.'
            : 'Widen the date range, or clear the filters.'
        }
        truncatedAt={LIMIT}
      />

      {sales.length >= LIMIT && (
        <div className="mt-3">
          <Warning>
            The most recent {LIMIT} sales were read — the server will not return
            more in one call. Anything older is not in this table and a search
            will not find it. The audit log holds the full record.
          </Warning>
        </div>
      )}

      {filing && (
        <FileSaleDialog
          sellers={sellers}
          onClose={() => setFiling(false)}
          onFiled={(message) => { setFiling(false); setNotice(message); load() }}
        />
      )}

      {approving && (
        <ApproveDialog
          row={approving}
          buyerLabel={buyerLabel(approving.buyerUid)}
          onClose={() => setApproving(null)}
          onDone={(message) => { setApproving(null); setNotice(message); load() }}
        />
      )}
    </div>
  )
}

// ── Filing a sale ─────────────────────────────────────────────────────────────

function FileSaleDialog({
  sellers,
  onClose,
  onFiled,
}: {
  sellers: Partner[]
  onClose: () => void
  onFiled: (message: string) => void
}) {
  const [sellerId, setSellerId] = useState('')
  const [buyerUid, setBuyerUid] = useState('')
  const [diamonds, setDiamonds] = useState('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // The seller's live position, so a sale that cannot be approved is visible
  // before it is filed rather than at the moment an owner tries to approve it.
  const [stock, setStock] = useState<SellerStatement | null>(null)
  const [stockState, setStockState] = useState<'idle' | 'loading' | 'done' | 'failed'>('idle')

  useEffect(() => {
    if (!sellerId) { setStock(null); setStockState('idle'); return }
    let cancelled = false
    setStockState('loading')
    statements
      .seller(sellerId)
      .then((s) => { if (!cancelled) { setStock(s); setStockState('done') } })
      .catch(() => { if (!cancelled) { setStock(null); setStockState('failed') } })
    return () => { cancelled = true }
  }, [sellerId])

  const seller = sellers.find((s) => s.id === sellerId) ?? null
  const diamondsNum = Math.round(Number(diamonds)) || 0
  const paidMinor = Math.round(Number(amount) * 100) || 0
  const onHand = stock?.coins_on_hand ?? null
  const short = onHand !== null && diamondsNum > 0 && diamondsNum > onHand

  const sameAccount = !!buyerUid && buyerUid === sellerId

  const valid =
    sellerId.trim().length > 0 &&
    buyerUid.trim().length > 0 &&
    !sameAccount &&
    diamondsNum > 0 &&
    reason.trim().length >= MIN_REASON

  async function submit() {
    if (!valid) return
    setBusy(true)
    setErr('')
    try {
      await api.partnerOps.recordSale({
        seller_id: sellerId.trim(),
        buyer_uid: buyerUid.trim(),
        diamonds: diamondsNum,
        amount_paid_minor: paidMinor,
        reason: reason.trim(),
      })
      onFiled(
        'Sale filed. Nothing has moved — the seller still holds the stock and the '
        + 'buyer has nothing until an owner approves it.',
      )
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'The sale was not accepted.')
      setBusy(false)
    }
  }

  return (
    <Modal
      title="File a sale"
      subtitle="This records the sale. It moves no coins and no diamonds."
      onClose={onClose}
    >
      <div className="p-5 space-y-4">
        <Labelled label="Seller">
          <select
            value={sellerId}
            onChange={(e) => setSellerId(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500"
          >
            <option value="">Choose a seller…</option>
            {sellers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || s.id}{s.status !== 'approved' ? ` — ${s.status}` : ''}
              </option>
            ))}
          </select>
          {seller && seller.status !== 'approved' && (
            <p className="text-amber-300 text-xs mt-1">
              This seller is {seller.status}. The API refuses to file a sale
              against an account that is not approved.
            </p>
          )}
        </Labelled>

        {sellerId && (
          <div className="bg-slate-800/60 border border-slate-700 rounded-lg px-3 py-2.5">
            {stockState === 'loading' ? (
              <p className="text-slate-400 text-xs flex items-center gap-1.5">
                <Loader2 size={11} className="animate-spin" /> Reading what this
                seller holds…
              </p>
            ) : stockState === 'failed' ? (
              <p className="text-amber-300 text-xs">
                The seller&rsquo;s balance could not be read, so there is nothing
                to check this sale against. It can still be filed — approval will
                be refused if they are short.
              </p>
            ) : onHand !== null ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-slate-400 text-xs uppercase tracking-wide">
                    On hand
                  </span>
                  <span className="text-white font-semibold">{coinText(onHand)}</span>
                </div>
                {short && (
                  <p className="text-red-300 text-xs mt-2 font-medium">
                    This sale is {coinText(diamondsNum - onHand)} more than they
                    hold. It can be filed, but approving it will be refused —
                    the seller is debited first, and the debit will fail.
                  </p>
                )}
                {!short && diamondsNum > 0 && (
                  <p className="text-slate-500 text-xs mt-2">
                    {coinText(onHand - diamondsNum)} would remain after this sale
                    is approved.
                  </p>
                )}
              </>
            ) : null}
          </div>
        )}

        <Labelled label="Buyer">
          <UserSearchPicker value={buyerUid} onChange={setBuyerUid} />
          {sameAccount && (
            <p className="text-red-300 text-xs mt-1">
              The buyer and the seller are the same account. A genuine sale has a
              distinct buyer, and the API refuses this.
            </p>
          )}
        </Labelled>

        <div className="grid grid-cols-2 gap-3">
          <Labelled label="Diamonds sold">
            <input
              value={diamonds}
              onChange={(e) => setDiamonds(e.target.value.replace(/[^0-9]/g, ''))}
              inputMode="numeric"
              placeholder="100000"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
            />
            <p className="text-slate-600 text-xs mt-1">
              The same number comes out of the seller in coins.
            </p>
          </Labelled>
          <Labelled label="Cash taken (₹)">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              inputMode="decimal"
              placeholder="2390"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
            />
            <p className="text-slate-600 text-xs mt-1">
              Rupees. Optional — leave it blank if no cash was recorded.
            </p>
          </Labelled>
        </div>

        <Labelled label="Reason">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="What this sale is — kept on the record and in the audit log."
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 resize-none"
          />
          {reason.trim().length > 0 && reason.trim().length < MIN_REASON && (
            <p className="text-amber-400 text-xs mt-1">At least {MIN_REASON} characters.</p>
          )}
        </Labelled>

        {err && <ErrorLine>{err}</ErrorLine>}
      </div>

      <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-800">
        <button onClick={onClose} className="text-slate-400 hover:text-white text-sm px-4 py-2">
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={!valid || busy}
          className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:bg-slate-800 disabled:text-slate-600 text-white font-semibold rounded-lg px-5 py-2.5 text-sm transition-colors"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <ShoppingCart size={15} />}
          File the sale
        </button>
      </div>
    </Modal>
  )
}

// ── Approving ─────────────────────────────────────────────────────────────────

function ApproveDialog({
  row,
  buyerLabel,
  onClose,
  onDone,
}: {
  row: Row
  buyerLabel: string
  onClose: () => void
  onDone: (message: string) => void
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
      const result = await api.partnerOps.approveSale(row.id, reason.trim())
      onDone(
        `Approved. ${row.sellerName} now holds ${coinText(result.seller_coins_after)}, `
        + `and the buyer holds ${result.buyer_diamonds_after.toLocaleString('en-IN')} diamonds.`
        + (result.replica_synced === false
          ? ' The ledger moved but the Firestore replica did not — the app may still show the old figure.'
          : ''),
      )
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'The approval did not go through.')
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Approve this sale"
      subtitle={`${row.sellerName} → ${buyerLabel}`}
      onClose={onClose}
    >
      <div className="p-5 space-y-4">
        <div className="bg-green-500/10 border border-green-500/30 rounded-lg px-4 py-3">
          <p className="text-green-200 text-sm font-semibold flex items-center gap-2">
            <ShieldCheck size={15} /> This moves value in two steps.
          </p>
          <ul className="text-green-100/85 text-sm mt-2 space-y-1">
            <li>
              1. {row.sellerName} is debited{' '}
              <span className="font-semibold">{coinText(row.diamonds)}</span>.
            </li>
            <li>
              2. The buyer is credited{' '}
              <span className="font-semibold">
                {row.diamonds.toLocaleString('en-IN')} diamonds
              </span>
              .
            </li>
          </ul>
          <p className="text-green-100/70 text-sm mt-2">
            The debit runs first on purpose. If the seller is short, nothing
            happens at all and the sale stays filed — that refusal is the safe
            outcome, not a bug.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <Field label="Filed">{whenExact(row.createdAt)}</Field>
          <Field label="Cash recorded">
            {row.paidMinor > 0 ? inr(row.paidMinor) : 'nothing recorded'}
          </Field>
        </div>

        <Field label="Why it was filed">
          <span className="text-slate-300">{row.reason || '—'}</span>
        </Field>

        <Labelled label="Reason">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            autoFocus
            placeholder="Why this is being approved — kept in the audit log against your name."
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 resize-none"
          />
          {reason.trim().length > 0 && !valid && (
            <p className="text-amber-400 text-xs mt-1">At least {MIN_REASON} characters.</p>
          )}
        </Labelled>

        {err && <ErrorLine>{err}</ErrorLine>}
      </div>

      <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-800">
        <button onClick={onClose} className="text-slate-400 hover:text-white text-sm px-4 py-2">
          Cancel
        </button>
        <button
          onClick={go}
          disabled={!valid || busy}
          className="flex items-center gap-2 bg-green-600 hover:bg-green-500 disabled:bg-slate-800 disabled:text-slate-600 text-white font-semibold rounded-lg px-5 py-2.5 text-sm transition-colors"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Coins size={15} />}
          Approve — move {coinText(row.diamonds)}
        </button>
      </div>
    </Modal>
  )
}

// ── Bits ──────────────────────────────────────────────────────────────────────

function Modal({
  title, subtitle, children, onClose,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 bg-black/70 backdrop-blur-sm overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-lg my-8">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800">
          <div className="min-w-0">
            <h2 className="text-white font-semibold">{title}</h2>
            <p className="text-slate-500 text-xs mt-0.5 truncate">{subtitle}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white shrink-0">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-300 text-sm">
      <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {children}
    </p>
  )
}

function Stat({
  label, value, tone, hint,
}: {
  label: string
  value: string
  tone: string
  hint?: string
}) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">{label}</p>
      <p className={`text-xl font-bold mt-1 ${tone}`}>{value}</p>
      {hint && <p className="text-slate-600 text-xs mt-1">{hint}</p>}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">{label}</p>
      <div className="text-slate-200 text-sm mt-0.5">{children}</div>
    </div>
  )
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-slate-400 text-xs font-medium uppercase tracking-wide mb-1.5">
        {label}
      </label>
      {children}
    </div>
  )
}
