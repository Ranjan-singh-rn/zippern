'use client'

/**
 * Team management.
 *
 * ── What changed, and why ───────────────────────────────────────────────────
 *
 * This screen used to write Firestore `crmUsers` directly, through
 * `createCrmUser` / `updateCrmUser` / `deleteCrmUser` in `lib/auth.ts`. That is
 * one half of a staff account. The other half is a Mongo `staff` row, which is
 * what `sign_in_with_firebase` looks the person up in — so an account created
 * here signed into the shell, rendered every tab, and then reported that it
 * could not load data on every API-backed screen. That is the bug the owner
 * hit: "finance team tab visible but not showing, it showing can't load data".
 *
 * Every mutation now goes through the API, which holds the Firebase Admin SDK
 * and writes both halves in one call (`backend/app/services/staff.py`, which
 * delegates the Firestore half to `app/services/crm_directory.py`). This page
 * no longer writes Firestore at all.
 *
 * ── The rules disagreement, resolved in the API's favour ────────────────────
 *
 * `firestore.rules` allows `crmUsers` create and update only for
 * `isSuperAdmin()`. The API's `POST /staff` is `require_team_admin`, and the
 * service refuses a role outside `assignable_roles(actor)` — a team admin may
 * create members of their own team and nothing else. Those two never agreed,
 * and going through the API resolves it in the API's favour.
 *
 * That is safe, and it is the narrower of the two. The Firestore rule is a
 * blanket "superadmin may write any crmUsers document"; the API grant is
 * "a team admin may create a member of their own team, and the list of roles
 * they may assign is computed server-side and returned to this page, so the
 * form cannot even offer one that would be refused". Nothing widens: an owner
 * could always invite anyone, and a team admin could already invite their own
 * team through /team-access. The Firestore rule stays where it is as a backstop
 * — with this page no longer writing there, nothing in the browser has any
 * business creating a staff document at all.
 *
 * ── This screen and /team-access now do the same job ────────────────────────
 *
 * They read the same list from the same endpoint and perform the same three
 * mutations. See the banner below: /team-access is the one to keep. Nothing is
 * deleted here — that is a call for the owner.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, Info, KeyRound, Loader2, Mail, Plus,
  RefreshCw, Search, Shield, ShieldCheck, UserCog, UserX, X,
} from 'lucide-react'
import api, { ApiError, type ApiRole, type StaffMember } from '@/lib/api'
import { useAuth } from '@/components/AuthProvider'
import { ErrorState } from '@/components/ui/States'
import { sendCrmPasswordReset } from '@/lib/auth'

/** The API refuses a shorter one, so the requirement is shown before they act. */
const MIN_REASON = 3

const ROLE_LABEL: Record<string, string> = {
  owner: 'Business Owner',
  observer: 'Observer',
  app_admin: 'App Admin',             app_member: 'App Team',
  ops_admin: 'Ops Admin',             ops_member: 'Ops Team',
  finance_admin: 'Finance Admin',     finance_member: 'Finance Team',
  tech_admin: 'Tech Admin',           tech_member: 'Tech Team',
  support_admin: 'Support Admin',     support_member: 'Support Team',
  marketing_admin: 'Marketing Admin', marketing_member: 'Marketing Team',
  agency: 'Agency',                   seller: 'Coin Seller',
}

const ROLE_TONE: Record<string, string> = {
  owner: 'bg-pink-500/20 text-pink-300',
  observer: 'bg-slate-700 text-slate-300',
  app: 'bg-purple-500/15 text-purple-300',
  ops: 'bg-blue-500/15 text-blue-300',
  finance: 'bg-green-500/15 text-green-300',
  tech: 'bg-cyan-500/15 text-cyan-300',
  support: 'bg-yellow-500/15 text-yellow-300',
  marketing: 'bg-rose-500/15 text-rose-300',
}

const GROUP_LABEL: Record<string, string> = {
  governance: 'Owners & Observer',
  app: 'App Department',
  ops: 'Operations Department',
  finance: 'Finance Department',
  tech: 'Tech Department',
  support: 'Support Department',
  marketing: 'Marketing Department',
  other: 'Other',
}

const GROUP_ORDER = [
  'governance', 'app', 'ops', 'finance', 'tech', 'support', 'marketing', 'other',
]

function groupOf(member: StaffMember): string {
  if (member.role === 'owner' || member.role === 'observer') return 'governance'
  return member.team ?? 'other'
}

function toneOf(member: StaffMember): string {
  if (member.role === 'owner' || member.role === 'observer') {
    return ROLE_TONE[member.role]
  }
  return ROLE_TONE[member.team ?? ''] ?? 'bg-slate-700 text-slate-300'
}

/** `ApiError.message` verbatim — the API's refusal says which rule stopped it. */
function saidWhy(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback
}

// ── Small pieces ──────────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
      <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-1">{label}</p>
      <p className="text-white text-2xl font-bold truncate">{value}</p>
      {sub && <p className="text-slate-500 text-xs mt-1">{sub}</p>}
    </div>
  )
}

function Field({ label, hint, children }: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-slate-400 text-xs font-medium uppercase tracking-wide mb-1.5">
        {label}
      </label>
      {children}
      {hint && <p className="text-slate-600 text-xs mt-1.5">{hint}</p>}
    </div>
  )
}

const INPUT =
  'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm ' +
  'placeholder-slate-600 focus:outline-none focus:border-pink-500'

// ── Main page ─────────────────────────────────────────────────────────────────

export default function TeamPage() {
  // Every mutation and every read on this screen is an API call, so the session
  // has to exist first. Before it does this is a loading state, not an error —
  // the same guard /team-access and the finance screens use.
  const { apiReady, apiError } = useAuth()

  const [rows, setRows] = useState<StaffMember[]>([])
  const [assignable, setAssignable] = useState<ApiRole[]>([])
  const [me, setMe] = useState<{ uid: string; role: ApiRole } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')

  const [inviting, setInviting] = useState(false)
  const [changingRole, setChangingRole] = useState<StaffMember | null>(null)
  const [revoking, setRevoking] = useState<StaffMember | null>(null)
  const [resettingUid, setResettingUid] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!apiReady) return
    setLoading(true)
    setError('')
    try {
      const [list, roles, who] = await Promise.all([
        // Inactive people are shown deliberately. A revoked account that simply
        // vanishes from the roster looks like an account that never existed.
        api.staff.list(true),
        api.staff.assignableRoles(),
        api.auth.me(),
      ])
      setRows(list)
      setAssignable(roles.roles)
      setMe({ uid: who.uid, role: who.role })
    } catch (err) {
      // Never silent. An unreadable list and an empty team look identical
      // otherwise, and this screen decides who has access to the business.
      setError(saidWhy(err, 'The team list could not be read. What is shown below is not a count of zero.'))
    } finally {
      setLoading(false)
    }
  }, [apiReady])

  useEffect(() => { load() }, [load])

  async function sendReset(member: StaffMember) {
    setResettingUid(member.uid)
    setError('')
    try {
      await sendCrmPasswordReset(member.email)
      setNotice(`Password reset sent to ${member.email}.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the reset email.')
    } finally {
      setResettingUid(null)
    }
  }

  async function changeRole(member: StaffMember, role: ApiRole, reason: string) {
    await api.staff.changeRole(member.uid, role, reason.trim())
    setNotice(
      `${member.name || member.email} is now ${ROLE_LABEL[role] ?? role}. ` +
      'Their CRM record and their API access were both updated, and any live session was revoked.',
    )
    setChangingRole(null)
    await load()
  }

  async function revoke(member: StaffMember, reason: string) {
    await api.staff.deactivate(member.uid, reason.trim())
    setNotice(
      `${member.name || member.email} no longer has access — in the CRM and in the API.`,
    )
    setRevoking(null)
    await load()
  }

  // A session that failed is terminal and is shown as an error. A session that
  // has not arrived yet is a loading state, not "Not signed in".
  if (!apiReady && apiError) return <ErrorState message={apiError} />

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

  const query = search.trim().toLowerCase()
  const visible = query
    ? rows.filter((m) =>
        [m.name, m.email, m.phone ?? '', ROLE_LABEL[m.role] ?? m.role]
          .some((v) => v.toLowerCase().includes(query)))
    : rows

  const grouped = visible.reduce<Record<string, StaffMember[]>>((acc, m) => {
    (acc[groupOf(m)] ??= []).push(m)
    return acc
  }, {})

  const activeCount = rows.filter((m) => m.is_active).length
  const teamCount = new Set(rows.map((m) => m.team).filter(Boolean)).size
  const newest = [...rows].sort(
    (a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''),
  )[0]
  const isOwner = me?.role === 'owner'

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="text-white text-2xl sm:text-3xl font-bold flex items-center gap-3">
            <UserCog className="text-pink-500" size={26} />
            Team Management
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            {isOwner
              ? 'You can invite anyone, change any role and revoke any access.'
              : 'You can invite members of your own team.'}
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
              onClick={() => { setError(''); setInviting(true) }}
              className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 text-white font-semibold rounded-lg px-4 py-2 text-sm transition-colors"
            >
              <Plus size={15} /> Invite Member
            </button>
          )}
        </div>
      </div>

      {/* Two screens, one job. Said here rather than left for somebody to find. */}
      <div className="mb-5 flex items-start gap-3 bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3">
        <Info size={16} className="text-slate-400 shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="text-slate-200 font-medium">
            This screen and <span className="font-mono text-xs">/team-access</span> now do the same job
          </p>
          <p className="text-slate-400 mt-0.5 leading-relaxed">
            Both read the same roster from the API and perform the same three changes —
            invite, change role, revoke access. This one groups by department and adds a
            search; that one is the smaller screen. One of them should go, and it is not a
            decision this page can make.
          </p>
        </div>
      </div>

      <div className="mb-5 flex items-start gap-3 bg-slate-800/40 border border-slate-700/60 rounded-xl px-4 py-3">
        <ShieldCheck size={16} className="text-green-400 shrink-0 mt-0.5" />
        <p className="text-slate-400 text-sm leading-relaxed">
          Every change here is written to both halves of a staff account — the CRM record
          the sign-in screen reads, and the API record that authorises every money and
          audit screen. Each one takes a reason, and the reason is what the audit log
          stores.
        </p>
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
            <p className="text-red-300 text-sm whitespace-pre-line">{error}</p>
          </div>
          <button onClick={() => setError('')} className="text-red-400 hover:text-red-200">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Accounts" value={rows.length} />
        <StatCard
          label="Active"
          value={activeCount}
          sub={`${rows.length - activeCount} without access`}
        />
        <StatCard label="Departments" value={teamCount} />
        <StatCard label="Newest" value={newest?.name || newest?.email || '—'} />
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between gap-4">
          <h2 className="text-white font-semibold">Staff</h2>
          <div className="relative w-full max-w-xs">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              placeholder="Search by name, email, phone or role…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-pink-500"
            />
          </div>
        </div>

        {visible.length === 0 ? (
          <div className="text-center py-20">
            <Shield size={28} className="text-slate-700 mx-auto mb-3" />
            <p className="text-slate-400 text-sm">
              {search ? `Nobody matching "${search}".` : 'No staff accounts yet.'}
            </p>
          </div>
        ) : (
          GROUP_ORDER.filter((g) => grouped[g]?.length).map((group) => (
            <div key={group}>
              <div className="px-5 py-2 bg-slate-900/60 border-y border-slate-800/70">
                <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                  {GROUP_LABEL[group] ?? group}
                </span>
              </div>
              {grouped[group].map((m) => (
                <div
                  key={m.uid}
                  className={`flex items-center gap-4 px-5 py-4 border-b border-slate-800/50 last:border-b-0 hover:bg-slate-800/30 transition-colors ${
                    m.is_active ? '' : 'opacity-60'
                  } ${m.uid === me?.uid ? 'ring-1 ring-inset ring-pink-500/30' : ''}`}
                >
                  <div className="w-9 h-9 rounded-full bg-pink-500/15 border border-pink-500/20 flex items-center justify-center shrink-0">
                    <span className="text-pink-300 text-xs font-bold">
                      {(m.name || m.email)[0]?.toUpperCase() ?? '?'}
                    </span>
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm font-medium truncate">
                      {m.name || '—'}
                      {m.uid === me?.uid && <span className="ml-2 text-xs text-pink-400">(you)</span>}
                      {!m.is_active && <span className="ml-2 text-xs text-red-400">no access</span>}
                    </p>
                    <p className="text-slate-500 text-xs truncate">
                      {m.email}
                      {m.phone ? ` · ${m.phone}` : ''}
                      {m.field_charge ? ` · ${m.field_charge}` : ''}
                    </p>
                  </div>

                  <span className={`text-xs px-2 py-1 rounded shrink-0 ${toneOf(m)}`}>
                    {ROLE_LABEL[m.role] ?? m.role}
                  </span>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => sendReset(m)}
                      disabled={resettingUid === m.uid}
                      title="Send a set-password email"
                      className="text-slate-500 hover:text-blue-300 disabled:opacity-40 transition-colors p-1.5 rounded hover:bg-slate-800"
                    >
                      {resettingUid === m.uid
                        ? <Loader2 size={15} className="animate-spin" />
                        : <KeyRound size={15} />}
                    </button>

                    {/* Changing a role changes authority, so the API restricts
                        it to owners. The control is hidden rather than shown
                        and refused. */}
                    {isOwner && m.uid !== me?.uid && (
                      <button
                        onClick={() => { setError(''); setChangingRole(m) }}
                        title="Change role"
                        className="text-slate-500 hover:text-white transition-colors p-1.5 rounded hover:bg-slate-800"
                      >
                        <ShieldCheck size={15} />
                      </button>
                    )}

                    {m.is_active && m.uid !== me?.uid && m.role !== 'owner' && (
                      <button
                        onClick={() => { setError(''); setRevoking(m) }}
                        title="Revoke access"
                        className="text-slate-500 hover:text-red-400 transition-colors p-1.5 rounded hover:bg-slate-800"
                      >
                        <UserX size={15} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      {inviting && (
        <InvitePanel
          roles={assignable}
          onClose={() => setInviting(false)}
          onDone={async (email, notification) => {
            setInviting(false)
            /*
             * The server's own sentence, not ours. This used to say
             * "Invitation sent" unconditionally — including when the
             * set-password link could not be generated and nothing was sent at
             * all, and including when the address already had a Zipper account
             * and so was told something quite different. The one thing the
             * inviter needs to know is whether the person was actually written
             * to, and only the server knows that.
             */
            setNotice(
              `${email}: ${notification || 'added. Their CRM record and their API record were both created.'}`,
            )
            await load()
          }}
        />
      )}

      {changingRole && (
        <RolePanel
          member={changingRole}
          roles={assignable}
          onCancel={() => setChangingRole(null)}
          onConfirm={(role, reason) => changeRole(changingRole, role, reason)}
        />
      )}

      {revoking && (
        <RevokePanel
          member={revoking}
          onCancel={() => setRevoking(null)}
          onConfirm={(reason) => revoke(revoking, reason)}
        />
      )}
    </div>
  )
}

// ── Invite ────────────────────────────────────────────────────────────────────

function InvitePanel({ roles, onClose, onDone }: {
  roles: ApiRole[]
  onClose: () => void
  onDone: (email: string, notification: string) => void
}) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<ApiRole>(roles[0])
  const [phone, setPhone] = useState('')
  const [fieldCharge, setFieldCharge] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const ready = email.includes('@') && name.trim().length > 1

  async function submit() {
    setBusy(true)
    setErr('')
    try {
      const created = await api.staff.invite({
        email: email.trim(),
        name: name.trim(),
        role,
        phone: phone.trim(),
        field_charge: fieldCharge.trim(),
      })
      onDone(email.trim(), String((created as { notification?: string })?.notification ?? ''))
    } catch (e) {
      // Verbatim. When the API creates the staff row and cannot write the CRM
      // record, the message says exactly that and carries the repair command —
      // truncating it would hide the one thing worth reading.
      setErr(saidWhy(e, 'Could not send the invitation.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer title="Invite Team Member" onClose={onClose}>
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        <Field label="Full name">
          <input value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Priya Sharma" className={INPUT} />
        </Field>

        <Field label="Personal email" hint="They use this to sign in.">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="priya@gmail.com" className={INPUT} />
        </Field>

        <Field label="Phone (optional)">
          <input value={phone} onChange={(e) => setPhone(e.target.value)}
            placeholder="9876543210" className={INPUT} />
        </Field>

        <Field label="Role" hint="Only roles you are allowed to assign are listed — the API decides that, not this form.">
          <select value={role} onChange={(e) => setRole(e.target.value as ApiRole)} className={INPUT}>
            {roles.map((r) => (
              <option key={r} value={r}>{ROLE_LABEL[r] ?? r}</option>
            ))}
          </select>
        </Field>

        <Field label="Field charge (optional)" hint="A named responsibility, shown on their record.">
          <input value={fieldCharge} onChange={(e) => setFieldCharge(e.target.value)}
            placeholder="e.g. User Conduct Officer" className={INPUT} />
        </Field>

        <div className="flex items-start gap-2 bg-slate-800/60 border border-slate-700 rounded-lg px-4 py-3">
          <Mail size={15} className="text-slate-400 mt-0.5 shrink-0" />
          <p className="text-slate-300 text-sm leading-relaxed">
            They receive a link and set their own password. You will never see it.
            Both halves of the account — the CRM record and the API record — are
            created by this one call.
          </p>
        </div>

        {err && (
          <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
            <AlertTriangle size={15} className="text-red-400 mt-0.5 shrink-0" />
            <p className="text-red-300 text-sm whitespace-pre-line">{err}</p>
          </div>
        )}
      </div>

      <Footer
        onCancel={onClose}
        confirmLabel="Send invitation"
        confirmIcon={<Mail size={15} />}
        disabled={busy || !ready}
        busy={busy}
        onConfirm={submit}
      />
    </Drawer>
  )
}

// ── Change role ───────────────────────────────────────────────────────────────

/**
 * Changing a role changes authority — it moves what somebody may approve, verify
 * and see — so the reason is not optional, and the API revokes every live
 * session so the new role takes effect immediately rather than at the next
 * login.
 */
function RolePanel({ member, roles, onCancel, onConfirm }: {
  member: StaffMember
  roles: ApiRole[]
  onCancel: () => void
  onConfirm: (role: ApiRole, reason: string) => Promise<void>
}) {
  const choices = roles.filter((r) => r !== member.role)
  const [role, setRole] = useState<ApiRole>(choices[0] ?? member.role)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const ready = reason.trim().length >= MIN_REASON && role !== member.role

  return (
    <Modal title="Change role" onClose={onCancel}>
      <div className="px-6 py-5 space-y-4">
        <p className="text-slate-300 text-sm">
          {member.name || member.email} is currently{' '}
          <span className="text-white font-medium">{ROLE_LABEL[member.role] ?? member.role}</span>.
        </p>

        <Field label="New role">
          <select value={role} onChange={(e) => setRole(e.target.value as ApiRole)} className={INPUT}>
            {choices.map((r) => (
              <option key={r} value={r}>{ROLE_LABEL[r] ?? r}</option>
            ))}
          </select>
        </Field>

        <Field
          label="Why"
          hint={`At least ${MIN_REASON} characters. It cannot be edited afterwards.`}
        >
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Moving to finance after the reshuffle agreed on 12 August."
            className={INPUT}
          />
        </Field>

        <p className="text-slate-500 text-xs leading-relaxed">
          Their CRM record and their API record are both updated, and any live session is
          revoked so the old role cannot be used for the rest of the day.
        </p>

        {err && (
          <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
            <AlertTriangle size={15} className="text-red-400 mt-0.5 shrink-0" />
            <p className="text-red-300 text-sm whitespace-pre-line">{err}</p>
          </div>
        )}
      </div>

      <Footer
        onCancel={onCancel}
        confirmLabel="Change role"
        confirmIcon={<ShieldCheck size={15} />}
        disabled={busy || !ready}
        busy={busy}
        onConfirm={async () => {
          setBusy(true)
          setErr('')
          try {
            await onConfirm(role, reason)
          } catch (e) {
            setErr(saidWhy(e, 'Could not change the role.'))
          } finally {
            setBusy(false)
          }
        }}
      />
    </Modal>
  )
}

// ── Revoke ────────────────────────────────────────────────────────────────────

/**
 * Revoke access.
 *
 * This replaces the old "Remove from CRM", which deleted the `crmUsers`
 * document. Deletion is the wrong shape: the API keeps the record so history
 * stays attributable — a deleted person makes every audit entry they ever wrote
 * unresolvable. Revoking sets them inactive in both places and kills any live
 * session.
 *
 * The reason is collected here rather than through `window.prompt`: a native
 * prompt is unstyled, blocks the whole tab, cannot enforce a minimum length, and
 * returns nothing useful when a browser suppresses it — at which point a
 * revocation silently does not happen.
 */
function RevokePanel({ member, onCancel, onConfirm }: {
  member: StaffMember
  onCancel: () => void
  onConfirm: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const ready = reason.trim().length >= MIN_REASON

  return (
    <Modal title="Revoke access" onClose={onCancel}>
      <div className="px-6 py-5 space-y-4">
        <p className="text-slate-300 text-sm">
          {member.name || member.email} will no longer be able to sign in — not to the CRM,
          and not to the API. The record is kept so past actions stay attributable.
        </p>

        <Field
          label="Why"
          hint={`At least ${MIN_REASON} characters. It cannot be edited afterwards.`}
        >
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Left the company on 14 August; handover complete."
            className={INPUT}
          />
        </Field>

        {err && (
          <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
            <AlertTriangle size={15} className="text-red-400 mt-0.5 shrink-0" />
            <p className="text-red-300 text-sm whitespace-pre-line">{err}</p>
          </div>
        )}
      </div>

      <Footer
        onCancel={onCancel}
        confirmLabel="Revoke access"
        confirmIcon={<UserX size={15} />}
        tone="danger"
        disabled={busy || !ready}
        busy={busy}
        onConfirm={async () => {
          setBusy(true)
          setErr('')
          try {
            await onConfirm(reason)
          } catch (e) {
            setErr(saidWhy(e, 'Could not revoke access.'))
          } finally {
            setBusy(false)
          }
        }}
      />
    </Modal>
  )
}

// ── Shells ────────────────────────────────────────────────────────────────────

function Drawer({ title, onClose, children }: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md h-screen bg-slate-900 border-l border-slate-800 flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-800 shrink-0">
          <h2 className="text-white text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function Modal({ title, onClose, children }: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <h2 className="text-white text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function Footer({
  onCancel, onConfirm, confirmLabel, confirmIcon, disabled, busy, tone = 'primary',
}: {
  onCancel: () => void
  onConfirm: () => void | Promise<void>
  confirmLabel: string
  confirmIcon: React.ReactNode
  disabled: boolean
  busy: boolean
  tone?: 'primary' | 'danger'
}) {
  const toneClass = tone === 'danger'
    ? 'bg-red-600 hover:bg-red-500'
    : 'bg-pink-500 hover:bg-pink-600'
  return (
    <div className="px-6 py-4 border-t border-slate-800 flex gap-3 shrink-0">
      <button
        onClick={onCancel}
        className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors"
      >
        Cancel
      </button>
      <button
        onClick={() => { void onConfirm() }}
        disabled={disabled}
        className={`flex-1 flex items-center justify-center gap-2 ${toneClass} disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors`}
      >
        {busy ? <Loader2 size={15} className="animate-spin" /> : confirmIcon}
        {confirmLabel}
      </button>
    </div>
  )
}
