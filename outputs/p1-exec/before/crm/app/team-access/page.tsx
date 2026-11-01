'use client'

/**
 * Staff access.
 *
 * Owners invite anyone, including other owners. A team admin can only invite
 * members of their own team — the API decides that and returns the list, so
 * this screen never has to guess, and can never offer something that would be
 * refused.
 *
 * Nobody sets a password here. The invited person gets a link and sets their
 * own; the inviter never sees it.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, Loader2, Mail, Plus, RefreshCw,
  Shield, UserCog, UserX, X,
} from 'lucide-react'
import api, { ApiError, type ApiRole, type StaffMember } from '@/lib/api'
import { useAuth } from '@/components/AuthProvider'
import { ErrorState } from '@/components/ui/States'

const MIN_REASON = 3

const ROLE_LABEL: Record<string, string> = {
  owner: 'Business Owner',
  observer: 'Observer',
  app_admin: 'App Admin',           app_member: 'App Team',
  ops_admin: 'Ops Admin',           ops_member: 'Ops Team',
  finance_admin: 'Finance Admin',   finance_member: 'Finance Team',
  tech_admin: 'Tech Admin',         tech_member: 'Tech Team',
  support_admin: 'Support Admin',   support_member: 'Support Team',
  marketing_admin: 'Marketing Admin', marketing_member: 'Marketing Team',
}

const TEAM_TONE: Record<string, string> = {
  app: 'bg-purple-500/15 text-purple-300',
  ops: 'bg-blue-500/15 text-blue-300',
  finance: 'bg-green-500/15 text-green-300',
  tech: 'bg-cyan-500/15 text-cyan-300',
  support: 'bg-yellow-500/15 text-yellow-300',
  marketing: 'bg-rose-500/15 text-rose-300',
}

export default function TeamAccess() {
  // Staff, assignable roles and identity all come from the API, whose session
  // is exchanged after this component mounts. Loading before it exists threw
  // `Not signed in` (401) and left it on screen for good, because nothing
  // re-ran when the session landed. Gate on `apiReady` — the same guard
  // app/finance/cash/page.tsx already uses.
  const { apiReady, apiError } = useAuth()
  const [rows, setRows] = useState<StaffMember[]>([])
  const [assignable, setAssignable] = useState<ApiRole[]>([])
  const [myRole, setMyRole] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [inviting, setInviting] = useState(false)
  /** The member whose access is being revoked — drives the reason panel. */
  const [revoking, setRevoking] = useState<StaffMember | null>(null)

  const load = useCallback(async () => {
    if (!apiReady) return
    setLoading(true)
    setError('')
    try {
      const [list, roles, me] = await Promise.all([
        api.staff.list(),
        api.staff.assignableRoles(),
        api.auth.me(),
      ])
      setRows(list)
      setAssignable(roles.roles)
      setMyRole(me.role)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the team.')
    } finally {
      setLoading(false)
    }
  }, [apiReady])

  // `apiReady` is a dependency of `load`, so the session landing re-runs this
  // and the team list fills itself in.
  useEffect(() => { load() }, [load])

  /**
   * Revoke access.
   *
   * The reason is collected in the panel below rather than through
   * `window.prompt`: a native prompt is unstyled, blocks the whole tab, cannot
   * enforce a minimum length, and returns nothing useful when a browser
   * suppresses it — at which point a revocation silently does not happen.
   */
  async function deactivate(m: StaffMember, reason: string) {
    try {
      await api.staff.deactivate(m.uid, reason.trim())
      setNotice(`${m.name || m.email} no longer has access.`)
      setRevoking(null)
      await load()
    } catch (err) {
      // Surfaced verbatim — the API's refusal says which rule stopped it.
      setError(err instanceof ApiError ? err.message : 'Could not revoke access.')
    }
  }

  const byTeam = rows.reduce<Record<string, StaffMember[]>>((acc, m) => {
    const key = m.team ?? (m.role === 'owner' || m.role === 'observer' ? 'governance' : 'other')
    ;(acc[key] ??= []).push(m)
    return acc
  }, {})

  const order = ['governance', 'app', 'ops', 'finance', 'tech', 'support', 'marketing', 'other']

  // A session that failed is terminal and is shown as an error. A session that
  // has not arrived yet is a loading state, not "Not signed in".
  if (!apiReady && apiError) {
    return <ErrorState message={apiError} />
  }

  if (loading || !apiReady) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3">
        <Loader2 size={26} className="animate-spin text-pink-500" />
        <p className="text-slate-500 text-sm">
          {apiReady ? 'Reading the team…' : 'Signing in to the business API…'}
        </p>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2">
            <UserCog size={26} className="text-pink-500" />
            Team access
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            {myRole === 'owner'
              ? 'You can invite anyone, including another owner.'
              : `You can invite members of your own team.`}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={load}
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2 text-sm transition-colors"
          >
            <RefreshCw size={14} /> Refresh
          </button>
          {assignable.length > 0 && (
            <button
              onClick={() => setInviting(true)}
              className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 text-white font-semibold rounded-lg px-4 py-2 text-sm transition-colors"
            >
              <Plus size={15} /> Invite
            </button>
          )}
        </div>
      </div>

      {notice && (
        <div className="mb-5 flex items-start justify-between gap-2 bg-green-500/10 border border-green-500/30 rounded-xl px-4 py-3">
          <div className="flex items-start gap-2">
            <CheckCircle2 size={15} className="text-green-400 mt-0.5 shrink-0" />
            <p className="text-green-300 text-sm">{notice}</p>
          </div>
          <button onClick={() => setNotice('')} className="text-green-400 hover:text-green-200">
            <X size={14} />
          </button>
        </div>
      )}

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

      <div className="space-y-6">
        {order.filter((t) => byTeam[t]?.length).map((team) => (
          <div key={team}>
            <h2 className="text-slate-400 text-xs font-semibold uppercase tracking-widest mb-2">
              {team === 'governance' ? 'Owners & Observer' : team}
            </h2>
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
              {byTeam[team].map((m, i) => (
                <div
                  key={m.uid}
                  className={`flex items-center gap-4 px-5 py-4 ${
                    i > 0 ? 'border-t border-slate-800/70' : ''
                  } ${!m.is_active ? 'opacity-50' : ''}`}
                >
                  <div className="w-9 h-9 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center shrink-0">
                    <span className="text-slate-300 text-xs font-bold">
                      {(m.name || m.email)[0]?.toUpperCase()}
                    </span>
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm font-medium truncate">
                      {m.name || '—'}
                      {!m.is_active && (
                        <span className="ml-2 text-red-400 text-xs">no access</span>
                      )}
                    </p>
                    <p className="text-slate-500 text-xs truncate">{m.email}</p>
                  </div>

                  <span
                    className={`text-xs px-2 py-1 rounded shrink-0 ${
                      m.role === 'owner'
                        ? 'bg-pink-500/20 text-pink-300'
                        : m.role === 'observer'
                          ? 'bg-slate-700 text-slate-300'
                          : TEAM_TONE[m.team ?? ''] ?? 'bg-slate-700 text-slate-300'
                    }`}
                  >
                    {ROLE_LABEL[m.role] ?? m.role}
                  </span>

                  {m.is_active && m.role !== 'owner' && (
                    <button
                      onClick={() => { setError(''); setRevoking(m) }}
                      title="Revoke access"
                      className="text-slate-600 hover:text-red-400 transition-colors shrink-0"
                    >
                      <UserX size={16} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {rows.length === 0 && (
        <div className="text-center py-20 bg-slate-900/50 border border-slate-800 rounded-xl">
          <Shield size={28} className="text-slate-700 mx-auto mb-3" />
          <p className="text-slate-400 text-sm">No team members yet.</p>
        </div>
      )}

      {inviting && (
        <InvitePanel
          roles={assignable}
          onClose={() => setInviting(false)}
          onDone={async (email) => {
            setInviting(false)
            setNotice(`Invitation sent to ${email}. They set their own password.`)
            await load()
          }}
        />
      )}

      {revoking && (
        <RevokePanel
          member={revoking}
          onCancel={() => setRevoking(null)}
          onConfirm={(reason) => deactivate(revoking, reason)}
        />
      )}
    </div>
  )
}

/**
 * Ask why, before taking someone's access away.
 *
 * The reason is not optional and not defaulted — it is what the audit log
 * stores, and "Revoked" as a stock string records nothing. The minimum length
 * is enforced here so the person sees the requirement before they act, rather
 * than getting the API's refusal back afterwards.
 */
function RevokePanel({
  member, onCancel, onConfirm,
}: {
  member: StaffMember
  onCancel: () => void
  onConfirm: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const ready = reason.trim().length >= MIN_REASON

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <h2 className="text-white text-lg font-semibold">Revoke access</h2>
          <button onClick={onCancel} className="text-slate-400 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <p className="text-slate-300 text-sm">
            {member.name || member.email} will no longer be able to sign in.
          </p>
          <div>
            <label className="block text-slate-400 text-xs font-medium uppercase tracking-wide mb-1.5">
              Why <span className="text-pink-400">(recorded in the audit log)</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Left the company on 14 August; handover complete."
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
            />
            <p className="text-slate-600 text-xs mt-1">
              At least {MIN_REASON} characters. It cannot be edited afterwards.
            </p>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-slate-800 flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={async () => {
              setBusy(true)
              try { await onConfirm(reason) } finally { setBusy(false) }
            }}
            disabled={busy || !ready}
            className="flex-1 flex items-center justify-center gap-2 bg-red-600 hover:bg-red-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <UserX size={15} />}
            Revoke access
          </button>
        </div>
      </div>
    </div>
  )
}

function InvitePanel({
  roles, onClose, onDone,
}: {
  roles: ApiRole[]
  onClose: () => void
  onDone: (email: string) => void
}) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<ApiRole>(roles[0])
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit() {
    setBusy(true)
    setErr('')
    try {
      await api.staff.invite({ email: email.trim(), name: name.trim(), role, phone })
      onDone(email.trim())
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not send the invitation.')
    } finally {
      setBusy(false)
    }
  }

  const ready = email.includes('@') && name.trim().length > 1

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md h-screen bg-slate-900 border-l border-slate-800 flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-800">
          <h2 className="text-white text-lg font-semibold">Invite someone</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <Field label="Full name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Priya Sharma"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
            />
          </Field>

          <Field label="Email">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="priya@gmail.com"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
            />
          </Field>

          <Field label="Role">
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as ApiRole)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500"
            >
              {roles.map((r) => (
                <option key={r} value={r}>{ROLE_LABEL[r] ?? r}</option>
              ))}
            </select>
            <p className="text-slate-600 text-xs mt-1.5">
              Only roles you are allowed to assign are listed.
            </p>
          </Field>

          <Field label="Phone (optional)">
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="9876543210"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
            />
          </Field>

          <div className="flex items-start gap-2 bg-slate-800/60 border border-slate-700 rounded-lg px-4 py-3">
            <Mail size={15} className="text-slate-400 mt-0.5 shrink-0" />
            <p className="text-slate-300 text-sm leading-relaxed">
              They receive a link and set their own password. You will never see it.
            </p>
          </div>

          {err && (
            <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
              <AlertTriangle size={15} className="text-red-400 mt-0.5 shrink-0" />
              <p className="text-red-300 text-sm">{err}</p>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-800 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || !ready}
            className="flex-1 flex items-center justify-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Mail size={15} />}
            Send invitation
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-slate-400 text-xs font-medium uppercase tracking-wide mb-1.5">
        {label}
      </label>
      {children}
    </div>
  )
}
