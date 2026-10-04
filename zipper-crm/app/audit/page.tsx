'use client'

/**
 * Audit log.
 *
 * Who, when, what changed, and why. Append-only — there is no edit and no
 * delete, including for owners. What you can see narrows by role: owners and
 * the observer see everything including each other, a team admin sees their
 * team, everyone else sees themselves.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle, ArrowRight, Filter, History, Loader2, RefreshCw, Search, X,
} from 'lucide-react'
import api, { ApiError, type AuditEntry } from '@/lib/api'
import { useAuth } from '@/components/AuthProvider'
import { ErrorState } from '@/components/ui/States'

const ACTION_GROUPS: { label: string; actions: string[] }[] = [
  { label: 'Money',    actions: ['balance.credit', 'balance.debit', 'inventory.credit', 'inventory.debit', 'lending.issue', 'lending.repay', 'lending.recover', 'commission.pay', 'payout.execute', 'withdrawal.pay', 'refund'] },
  { label: 'Approval', actions: ['card.raised', 'card.verified', 'card.signed', 'card.rejected', 'card.executed', 'card.execution_failed'] },
  { label: 'Partners', actions: ['partner.approved', 'partner.rejected', 'partner.deactivated'] },
  { label: 'Users',    actions: ['user.banned', 'user.unbanned', 'user.warned', 'host.granted', 'host.revoked'] },
  { label: 'Config',   actions: ['rate.changed', 'config.changed'] },
  { label: 'Access',   actions: ['staff.created', 'staff.role_changed', 'staff.deactivated', 'login.succeeded', 'login.failed', 'export'] },
]

const TONE: Record<string, string> = {
  'card.signed': 'text-green-300',
  'card.executed': 'text-green-300',
  'card.rejected': 'text-red-300',
  'card.execution_failed': 'text-red-300',
  'login.failed': 'text-red-300',
  'user.banned': 'text-red-300',
  'balance.credit': 'text-pink-300',
  'balance.debit': 'text-amber-300',
  'staff.role_changed': 'text-amber-300',
}

function when(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

function summarise(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value !== 'object') return String(value)
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ')
}

export default function AuditLog() {
  // The audit log lives entirely behind the API, and the API session is
  // exchanged after this component mounts. Asking before it exists threw
  // `Not signed in` (401) and left that message on screen permanently, because
  // nothing re-ran when the session arrived. Gate on `apiReady`, same as
  // app/finance/cash/page.tsx.
  const { apiReady, apiError } = useAuth()
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [group, setGroup] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [scopeNote, setScopeNote] = useState('')

  const load = useCallback(async () => {
    if (!apiReady) return
    setLoading(true)
    setError('')
    try {
      const [rows, me] = await Promise.all([api.audit.list({ limit: 300 }), api.auth.me()])
      setEntries(rows)
      setScopeNote(
        me.role === 'owner' || me.role === 'observer'
          ? 'You are seeing every action by everyone, including the other owners.'
          : me.role.endsWith('_admin')
            ? 'You are seeing your own team.'
            : 'You are seeing your own actions.',
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the log.')
    } finally {
      setLoading(false)
    }
  }, [apiReady])

  // `apiReady` is a dependency of `load`, so the session landing re-runs this
  // and the log fills itself in.
  useEffect(() => { load() }, [load])

  const allowed = group === 'all'
    ? null
    : ACTION_GROUPS.find((g) => g.label === group)?.actions ?? []

  const visible = entries.filter((e) => {
    if (allowed && !allowed.includes(e.action)) return false
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return (
      e.actor.name?.toLowerCase().includes(q) ||
      e.action.toLowerCase().includes(q) ||
      e.reason?.toLowerCase().includes(q) ||
      e.subject.id?.toLowerCase().includes(q)
    )
  })

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2">
            <History size={26} className="text-pink-500" />
            Audit log
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            Every action, who did it, and why. Nothing here can be edited or deleted.
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2 text-sm transition-colors self-start"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {scopeNote && (
        <p className="text-slate-500 text-xs mb-4">{scopeNote}</p>
      )}

      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by person, action, reason or record…"
            className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-9 pr-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
          />
        </div>
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          <Filter size={14} className="text-slate-600 shrink-0" />
          {['all', ...ACTION_GROUPS.map((g) => g.label)].map((g) => (
            <button
              key={g}
              onClick={() => setGroup(g)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                group === g
                  ? 'bg-pink-500 text-white'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              {g === 'all' ? 'All' : g}
            </button>
          ))}
        </div>
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

      {!apiReady && apiError ? (
        <ErrorState message={apiError} />
      ) : loading || !apiReady ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3">
          <Loader2 size={24} className="animate-spin text-pink-500" />
          <p className="text-slate-500 text-sm">
            {apiReady ? 'Reading the log…' : 'Signing in to the business API…'}
          </p>
        </div>
      ) : visible.length === 0 ? (
        <div className="text-center py-24 text-slate-600 text-sm">
          {entries.length === 0
            ? 'Nothing recorded yet. Actions will appear here as they happen.'
            : 'Nothing matches that filter.'}
        </div>
      ) : (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          {visible.map((e, i) => (
            <div
              key={e.id}
              className={`px-4 sm:px-5 py-4 ${i > 0 ? 'border-t border-slate-800/70' : ''}`}
            >
              <div className="flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4">
                <div className="sm:w-36 shrink-0">
                  <p className="text-slate-500 text-xs">{when(e.at)}</p>
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="text-white text-sm font-medium">
                      {e.actor.name || e.actor.uid || 'system'}
                    </span>
                    <span className="text-slate-600 text-xs">{e.actor.role}</span>
                    <span className={`text-sm font-medium ${TONE[e.action] ?? 'text-slate-300'}`}>
                      {e.action}
                    </span>
                  </div>

                  <p className="text-slate-400 text-sm mt-1">{e.reason}</p>

                  <p className="text-slate-600 text-xs mt-1">
                    {e.subject.type} · {e.subject.id}
                  </p>

                  {(e.before !== null || e.after !== null) && (
                    <div className="flex flex-wrap items-center gap-2 mt-2 text-xs">
                      <span className="text-slate-500 bg-slate-800/70 px-2 py-0.5 rounded font-mono">
                        {summarise(e.before)}
                      </span>
                      <ArrowRight size={11} className="text-slate-600" />
                      <span className="text-slate-300 bg-slate-800 px-2 py-0.5 rounded font-mono">
                        {summarise(e.after)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {visible.length > 0 && (
        <p className="text-slate-600 text-xs mt-4 text-center">
          Showing {visible.length} of {entries.length} loaded entries
        </p>
      )}
    </div>
  )
}
