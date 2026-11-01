'use client'

/**
 * /sessions — the sessions this login holds, and "Sign out everywhere else"
 * (B3 / §13).
 *
 *   GET  /api/auth/sessions              every live session, current flagged
 *   POST /api/auth/sessions/revoke-all   {include_current}
 *
 * For EVERY signed-in person — staff, the Observer, an agency, a coin seller.
 * Both routes are self-scoped on the server (no id is sent, so nobody can see
 * or end anybody else's sessions) and both are on the API's partner-reachable
 * list. That is why this is a shared partner path (`PARTNER_SHARED_PATHS`)
 * like /profile, reachable from the staff sidebar, the Observer's sidebar and
 * a partner's own switcher.
 *
 * A seven-day session that renews itself is a credential a person could not
 * see and could not end from anywhere but the device it was on. This is where
 * they see it, and end it. Fingerprints only: a session is named by the first
 * eight characters of its id, never by its token.
 *
 * "Everywhere else" keeps this browser signed in to confirm it worked. "Here
 * too" ends this session as well, so the page then signs this browser out
 * (the token it holds is dead on the server) and goes to the sign-in page.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, Laptop, Loader2, LogOut, MonitorSmartphone, RefreshCw, ShieldCheck,
  Smartphone, X,
} from 'lucide-react'
import api, { ApiError, endSession } from '@/lib/api'
import { crmSignOut } from '@/lib/auth'
import { useAuth } from '@/components/AuthProvider'
import { ErrorState, Loading } from '@/components/ui/States'
import {
  QUICK_LOGIN_NOTE, otherSessions, revokeAllSummary, sessionsFrom, type SessionView,
} from '@/lib/sessions'

function when(ms: number | null): string {
  return ms === null ? 'not recorded' : new Date(ms).toLocaleString('en-IN')
}

type Scope = 'others' | 'all'

export default function SessionsPage() {
  const { apiReady, apiError, apiUser } = useAuth()
  const isObserver = apiUser?.role === 'observer'

  const [rows, setRows] = useState<SessionView[] | null>(null)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState<Scope | ''>('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [result, setResult] = useState<{ text: string; problems: string[] } | null>(null)

  const load = useCallback(async () => {
    if (!apiReady) return
    setError('')
    try {
      setRows(sessionsFrom(await api.auth.sessions()))
    } catch (err) {
      setRows(null)
      setError(err instanceof ApiError ? err.message : 'Your sessions could not be read.')
    }
  }, [apiReady])

  useEffect(() => { void load() }, [load])

  async function revoke(includeCurrent: boolean) {
    setBusy(true)
    setFailure('')
    try {
      const res = includeCurrent
        ? await api.auth.revokeAllSessions(true)
        : await api.auth.revokeAllSessions(false)
      const summary = revokeAllSummary(res)
      if (summary.signedOutHere) {
        // This browser's session is dead on the server: drop the token and the
        // Firebase sign-in, then go to the door that fits this account.
        endSession()
        await crmSignOut().catch(() => undefined)
        window.location.assign(isObserver ? '/observer' : '/login')
        return
      }
      setResult({ text: summary.text, problems: summary.problems })
      setConfirm('')
      await load()
    } catch (err) {
      setFailure(err instanceof ApiError ? err.message : 'That did not go through. Nothing was signed out.')
    } finally {
      setBusy(false)
    }
  }

  // A session that failed to establish is terminal; one still arriving is a
  // loading state, not "Not signed in".
  if (!apiReady && apiError) return <ErrorState message={apiError} />
  if (!apiReady) return <Loading label="Signing in to the business API…" />

  const others = rows ? otherSessions(rows) : []

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-3">
            <MonitorSmartphone className="text-pink-500" size={26} />
            Signed-in devices
          </h1>
          <p className="text-slate-400 text-sm mt-1 max-w-xl">
            Every place this login is signed in right now. If you do not recognise one, sign out
            everywhere else — it takes effect on that device&rsquo;s next request.
          </p>
        </div>
        <button
          onClick={() => { setResult(null); void load() }}
          className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2 text-sm transition-colors self-start sm:self-auto"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {result && (
        <div className="mb-5 flex items-start justify-between gap-3 bg-green-500/10 border border-green-500/30 rounded-xl px-4 py-3">
          <div className="flex items-start gap-2">
            <CheckCircle2 size={15} className="text-green-400 mt-0.5 shrink-0" />
            <div className="text-sm">
              <p className="text-green-100">{result.text}</p>
              {result.problems.map((p) => (
                <p key={p} className="text-amber-200 text-xs mt-1">{p}</p>
              ))}
            </div>
          </div>
          <button onClick={() => setResult(null)} className="text-green-400/70 hover:text-green-200">
            <X size={14} />
          </button>
        </div>
      )}

      {error ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl">
          <ErrorState message={error} onRetry={load} />
        </div>
      ) : rows === null ? (
        <Loading label="Reading your sessions…" />
      ) : (
        <>
          <div className="bg-slate-900 border border-slate-800 rounded-xl divide-y divide-slate-800">
            {rows.length === 0 ? (
              <p className="px-5 py-6 text-slate-500 text-sm">
                The server listed no live session — not even this one. Refresh, or sign in again.
              </p>
            ) : rows.map((s) => (
              <div key={s.id} className={`px-5 py-4 flex items-start gap-3 ${s.current ? 'bg-pink-500/5' : ''}`}>
                <div className="w-9 h-9 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center shrink-0">
                  {s.clientLabel.includes('Android') ? <Smartphone size={15} className="text-slate-300" /> : <Laptop size={15} className="text-slate-300" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-white text-sm font-medium flex flex-wrap items-center gap-2">
                    {s.clientLabel} · {s.device}
                    {s.current && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-pink-500/20 text-pink-200">This browser</span>
                    )}
                    {s.mfa === 'verified' && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-green-500/15 text-green-300 flex items-center gap-1">
                        <ShieldCheck size={10} /> second step passed
                      </span>
                    )}
                    {s.mfa === 'not_verified' && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">second step not passed</span>
                    )}
                  </p>
                  <p className="text-slate-400 text-xs mt-1">
                    Signed in {when(s.issuedAtMs)} · last active {when(s.lastActiveAtMs)} · ends {when(s.expiresAtMs)}
                    {s.renewed ? ' · renewed' : ''}
                  </p>
                  <p className="text-slate-600 text-xs mt-0.5 break-all">
                    {s.ip ? `Address ${s.ip} · ` : ''}session <span className="font-mono">{s.id}</span>
                    {s.userAgent && s.device === 'Unknown device' ? ` · ${s.userAgent}` : ''}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-5 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => { setFailure(''); setConfirm('others') }}
                disabled={busy || others.length === 0}
                title={others.length === 0 ? 'This browser is the only live session.' : undefined}
                className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-lg px-4 py-2 text-sm transition-colors"
              >
                <LogOut size={15} /> Sign out everywhere else
                {others.length > 0 && <span className="text-pink-100/80 font-normal">({others.length})</span>}
              </button>
              <button
                onClick={() => { setFailure(''); setConfirm('all') }}
                disabled={busy}
                className="flex items-center gap-2 bg-slate-800 hover:bg-red-600/20 hover:text-red-200 text-slate-300 font-medium rounded-lg px-4 py-2 text-sm transition-colors"
              >
                <LogOut size={15} /> Sign out everywhere, including here
              </button>
            </div>
            <p className="text-slate-500 text-xs">{QUICK_LOGIN_NOTE}</p>

            {confirm && (
              <div className="bg-slate-950/60 border border-slate-700 rounded-lg px-4 py-3 space-y-3">
                <p className="text-slate-200 text-sm">
                  {confirm === 'others'
                    ? `End ${others.length} other session${others.length === 1 ? '' : 's'}? This browser stays signed in.`
                    : 'End every session of this login, this browser included? You will be signed out here and asked to sign in again.'}
                </p>
                {failure && (
                  <p className="flex items-start gap-2 text-red-300 text-sm">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {failure}
                  </p>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => setConfirm('')}
                    disabled={busy}
                    className="bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-4 py-2 text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => { void revoke(confirm === 'all') }}
                    disabled={busy}
                    className="flex items-center gap-2 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-semibold rounded-lg px-4 py-2 text-sm"
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />}
                    {confirm === 'others' ? 'Sign them out' : 'Sign out everywhere'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
