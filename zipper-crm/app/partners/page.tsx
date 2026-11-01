'use client'

/**
 * Partner statements.
 *
 * An agency sees exactly what it earned, what it was paid, and what is
 * outstanding — the thing that does not exist in the product today, and the
 * reason an agency would move here from somewhere else.
 *
 * Staff can look up any partner. A partner opening the same screen sees only
 * themselves; that scoping is enforced by the API, not here.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, Building2, Clock, Coins, Loader2, RefreshCw,
  Search, ShoppingBag, TrendingUp, Wallet, X,
} from 'lucide-react'
import api, { ApiError } from '@/lib/api'
import { nameOrReference } from '@/lib/identity'
import { useIdentities } from '@/lib/useIdentities'
import { useAuth } from '@/components/AuthProvider'
import { ErrorState, Loading } from '@/components/ui/States'

type Tab = 'agency' | 'seller' | 'exposure'

function inr(minor: number) {
  return `₹${(minor / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}

function when(iso: string) {
  try {
    return new Date(iso).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
    })
  } catch {
    return '—'
  }
}

const STANDING_TONE: Record<string, string> = {
  none: 'bg-slate-700 text-slate-300',
  current: 'bg-green-500/15 text-green-300',
  due_soon: 'bg-amber-500/15 text-amber-300',
  overdue: 'bg-red-500/15 text-red-300',
  written_off: 'bg-slate-700 text-slate-400',
}

export default function Partners() {
  // Every figure on this screen comes from the API, whose session is exchanged
  // after the component mounts. The credit-exposure tab loaded on mount, so on
  // a cold start it asked before the session existed, got `Not signed in` (401)
  // and pinned that refusal to the screen — nothing re-ran once the session
  // arrived. Gate on `apiReady`, as app/finance/cash/page.tsx does.
  const { apiReady, apiError } = useAuth()
  const [tab, setTab] = useState<Tab>('agency')
  const [id, setId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [exposureLoading, setExposureLoading] = useState(true)

  const [agency, setAgency] = useState<Awaited<ReturnType<typeof api.partners.agencyStatement>> | null>(null)
  const [hosts, setHosts] = useState<Awaited<ReturnType<typeof api.partners.agencyHosts>>>([])
  const [seller, setSeller] = useState<Awaited<ReturnType<typeof api.partners.sellerStatement>> | null>(null)
  const [exposure, setExposure] = useState<Awaited<ReturnType<typeof api.partners.creditExposure>> | null>(null)
  const [overdue, setOverdue] = useState<Awaited<ReturnType<typeof api.partners.overdueSellers>>>([])
  // B1: each host_id is a Firebase uid — named from `users` (names only).
  const hostNames = useIdentities({ people: hosts.map((h) => h.host_id) })

  const loadExposure = useCallback(async () => {
    if (!apiReady) return
    setExposureLoading(true)
    setError('')
    try {
      const [e, o] = await Promise.all([
        api.partners.creditExposure(),
        api.partners.overdueSellers(),
      ])
      setExposure(e)
      setOverdue(o)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load credit exposure.')
    } finally {
      setExposureLoading(false)
    }
  }, [apiReady])

  // `apiReady` is a dependency of `loadExposure`, so the session landing
  // re-runs this and the tab fills itself in.
  useEffect(() => { if (tab === 'exposure') loadExposure() }, [tab, loadExposure])

  async function lookup() {
    if (!id.trim() || !apiReady) return
    setBusy(true)
    setError('')
    setAgency(null)
    setSeller(null)
    try {
      if (tab === 'agency') {
        const [s, h] = await Promise.all([
          api.partners.agencyStatement(id.trim()),
          api.partners.agencyHosts(id.trim()),
        ])
        setAgency(s)
        setHosts(h)
      } else {
        setSeller(await api.partners.sellerStatement(id.trim()))
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load that partner.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2">
          <Building2 size={26} className="text-pink-500" />
          Partner statements
        </h1>
        <p className="text-slate-400 text-sm mt-1">
          What each partner earned, was paid, and is owed — from the same ledger
          the business runs on.
        </p>
      </div>

      <div className="flex items-center gap-1.5 mb-5">
        {([
          ['agency', 'Agency', Building2],
          ['seller', 'Coin seller', ShoppingBag],
          ['exposure', 'Credit exposure', Wallet],
        ] as const).map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => { setTab(key); setError('') }}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === key ? 'bg-pink-500 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'
            }`}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-5 flex items-start justify-between gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3">
          <div className="flex items-start gap-2">
            <AlertTriangle size={15} className="text-red-400 mt-0.5 shrink-0" />
            <p className="text-red-300 text-sm">{error}</p>
          </div>
          <button onClick={() => setError('')} className="text-red-400 hover:text-red-200">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Nothing below can be asked for without a session. Its absence is a
          loading state; a session that failed to establish is an error. */}
      {!apiReady ? (
        apiError ? (
          <ErrorState message={apiError} />
        ) : (
          <Loading label="Signing in to the business API…" />
        )
      ) : (
      <>
      {tab !== 'exposure' && (
        <div className="flex gap-2 mb-6">
          <div className="relative flex-1">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              value={id}
              onChange={(e) => setId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && lookup()}
              placeholder={tab === 'agency' ? 'Agency ID' : 'Seller ID'}
              className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-9 pr-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
            />
          </div>
          <button
            onClick={lookup}
            disabled={busy || !id.trim()}
            className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:bg-slate-800 disabled:text-slate-600 text-white font-semibold rounded-lg px-5 py-2.5 text-sm transition-colors"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
            Look up
          </button>
        </div>
      )}

      {/* ── Agency ─────────────────────────────────────────────────────── */}
      {tab === 'agency' && agency && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Stat label="Earned" value={inr(agency.commission_earned)} tone="text-white" />
            <Stat label="Paid" value={inr(agency.commission_paid)} tone="text-slate-300" />
            <Stat
              label="Outstanding"
              value={inr(agency.commission_outstanding)}
              tone={agency.commission_outstanding > 0 ? 'text-amber-300' : 'text-slate-600'}
              hint="What we owe them right now"
            />
          </div>

          {/* NOT `host_count`. That field counts the Mongo collection
              `agency_hosts` (backend/app/services/partners.py:136), and nothing
              in the backend writes it — so this caption read "0 active hosts"
              for every agency that has ever existed, including ones with hosts
              earning in the very list underneath it.

              A commission statement cannot answer how many hosts an agency has;
              the roster lives in Firestore and belongs on the agency's own page,
              which is linked. What this screen CAN say honestly is how many of
              them earned in the window it just read, and that is what it says. */}
          <p className="text-slate-500 text-xs">
            {agency.name || agency.agency_id} · {hosts.length} host
            {hosts.length === 1 ? '' : 's'} earned in this statement.{' '}
            <Link
              href={`/agencies/${agency.agency_id}`}
              className="text-pink-400 hover:text-pink-300"
            >
              Their full roster
            </Link>
          </p>

          {hosts.length > 0 && (
            <Panel title="Host performance" icon={<TrendingUp size={15} />}>
              {hosts.slice(0, 20).map((h) => (
                <Row key={h.host_id}>
                  <span className="text-slate-300 text-sm truncate" title={h.host_id}>{nameOrReference(hostNames.people.get(h.host_id), h.host_id, 'host')}</span>
                  <span className="text-white text-sm">🫘 {h.beans_earned.toLocaleString('en-IN')}</span>
                </Row>
              ))}
            </Panel>
          )}

          <Panel title="Commission ledger" icon={<Coins size={15} />}>
            {agency.entries.length === 0 ? (
              <p className="text-slate-600 text-sm py-6 text-center">No movements yet.</p>
            ) : (
              agency.entries.map((e, i) => {
                const amount = Number(e.amount ?? 0)
                return (
                  <Row key={i}>
                    <div className="min-w-0">
                      <p className="text-slate-200 text-sm truncate">{String(e.reason ?? '')}</p>
                      <p className="text-slate-600 text-xs">{when(String(e.at ?? ''))}</p>
                    </div>
                    <span className={`text-sm font-semibold shrink-0 ${amount >= 0 ? 'text-green-300' : 'text-amber-300'}`}>
                      {amount >= 0 ? '+' : ''}{inr(amount)}
                    </span>
                  </Row>
                )
              })
            )}
          </Panel>
        </div>
      )}

      {/* ── Seller ─────────────────────────────────────────────────────── */}
      {tab === 'seller' && seller && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Stat label="On hand" value={`🪙 ${seller.coins_on_hand.toLocaleString('en-IN')}`} tone="text-white" />
            <Stat label="Purchased" value={seller.coins_purchased.toLocaleString('en-IN')} tone="text-slate-300" />
            <Stat label="Lent" value={seller.coins_lent.toLocaleString('en-IN')} tone="text-slate-300" />
            <Stat label="Sold" value={seller.coins_sold.toLocaleString('en-IN')} tone="text-slate-300" />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span className="text-slate-400 text-sm">{seller.name || seller.seller_id}</span>
            <span className={`text-xs px-2 py-1 rounded ${STANDING_TONE[seller.credit_standing] ?? 'bg-slate-700 text-slate-300'}`}>
              credit: {seller.credit_standing.replace('_', ' ')}
            </span>
            {seller.credit_outstanding > 0 && (
              <span className="text-amber-300 text-sm">
                owes {seller.credit_outstanding.toLocaleString('en-IN')} coins
              </span>
            )}
          </div>

          <Panel title="Inventory ledger" icon={<Coins size={15} />}>
            {seller.entries.length === 0 ? (
              <p className="text-slate-600 text-sm py-6 text-center">No movements yet.</p>
            ) : (
              seller.entries.map((e, i) => {
                const amount = Number(e.amount ?? 0)
                return (
                  <Row key={i}>
                    <div className="min-w-0">
                      <p className="text-slate-200 text-sm truncate">{String(e.reason ?? '')}</p>
                      <p className="text-slate-600 text-xs">
                        {when(String(e.at ?? ''))} · {String(e.action ?? '')}
                      </p>
                    </div>
                    <span className={`text-sm font-semibold shrink-0 ${amount >= 0 ? 'text-green-300' : 'text-slate-400'}`}>
                      {amount >= 0 ? '+' : ''}{amount.toLocaleString('en-IN')}
                    </span>
                  </Row>
                )
              })
            )}
          </Panel>
        </div>
      )}

      {/* ── Exposure ───────────────────────────────────────────────────── */}
      {tab === 'exposure' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <p className="text-slate-400 text-sm">
              Total credit outstanding across every seller.
            </p>
            <button
              onClick={loadExposure}
              className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2 text-sm"
            >
              <RefreshCw size={14} /> Refresh
            </button>
          </div>

          {/* `?? 0` here used to turn a read that had not happened — or had
              been refused — into "🪙 0 outstanding", which reads as a fact
              about the business. A figure we do not have is "—". */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Stat
              label="Outstanding"
              value={exposure ? `🪙 ${exposure.total_outstanding.toLocaleString('en-IN')}` : '—'}
              tone={
                !exposure ? 'text-slate-500'
                  : exposure.total_outstanding > 0 ? 'text-amber-300' : 'text-slate-600'
              }
              hint={exposure ? undefined : exposureLoading ? 'Reading…' : 'Could not be read — this is not zero.'}
            />
            <Stat
              label="Sellers with credit"
              value={exposure ? String(exposure.sellers_with_credit) : '—'}
              tone={exposure ? 'text-white' : 'text-slate-500'}
            />
            <Stat
              label="Total sellers"
              value={exposure ? String(exposure.total_sellers) : '—'}
              tone={exposure ? 'text-slate-300' : 'text-slate-500'}
            />
          </div>

          <Panel title="Overdue" icon={<Clock size={15} />}>
            {exposureLoading ? (
              <p className="text-slate-600 text-sm py-6 text-center">Reading…</p>
            ) : !exposure ? (
              <p className="text-slate-600 text-sm py-6 text-center">
                The overdue list could not be read, so it is not shown. That is
                not the same as nothing being overdue.
              </p>
            ) : overdue.length === 0 ? (
              <p className="text-slate-600 text-sm py-6 text-center">Nothing overdue.</p>
            ) : (
              overdue.map((s) => (
                <Row key={s.id}>
                  <div className="min-w-0">
                    <p className="text-slate-200 text-sm truncate">{s.name || s.id}</p>
                    <p className="text-red-400 text-xs">{s.days_overdue} days overdue</p>
                  </div>
                  <span className="text-amber-300 text-sm font-semibold shrink-0">
                    🪙 {s.outstanding.toLocaleString('en-IN')}
                  </span>
                </Row>
              ))
            )}
          </Panel>
        </div>
      )}

      {tab !== 'exposure' && !agency && !seller && !busy && (
        <div className="text-center py-20 bg-slate-900/50 border border-slate-800 rounded-xl">
          <Search size={26} className="text-slate-700 mx-auto mb-3" />
          <p className="text-slate-500 text-sm">
            Enter {tab === 'agency' ? 'an agency' : 'a seller'} ID to see their statement.
          </p>
        </div>
      )}
      </>
      )}
    </div>
  )
}

function Stat({ label, value, tone, hint }: { label: string; value: string; tone: string; hint?: string }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
      <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${tone}`}>{value}</p>
      {hint && <p className="text-slate-600 text-xs mt-1">{hint}</p>}
    </div>
  )
}

function Panel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="flex items-center gap-2 text-white font-semibold mb-2">
        <span className="text-slate-500">{icon}</span> {title}
      </h2>
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">{children}</div>
    </div>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3 border-b border-slate-800/60 last:border-0">
      {children}
    </div>
  )
}
