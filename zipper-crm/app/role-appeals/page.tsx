'use client'

/**
 * Reinstatement requests — asking for a REVOKED role back (GOV C2 / B05).
 *
 * A revoked Host, Agency, Sub-agency or Coin Seller role used to have no way
 * back but a Restore button any KYC reviewer could press: no request from the
 * person, no recommendation, no Owner. Now the person files a request from the
 * app, a reviewer RECOMMENDS an outcome here, and the Owner DECIDES — and a
 * `restore` decision re-activates the person's EXISTING record, never a new
 * one. Nothing else in the CRM turns a revoked role back on.
 *
 *   GET  /api/partner-ops/role-appeals?status=open|all
 *   POST /api/partner-ops/role-appeals/{id}/recommend  {outcome, note ≥ 10}
 *   POST /api/partner-ops/role-appeals/{id}/decide     {outcome, note} — Owner only
 *
 * Who may recommend is the server's rule, mirrored so nobody is offered a
 * button that is always refused: `can_approve_kyc` for a Host, Agency or
 * Sub-agency, `can_approve_seller` for a Coin Seller, and the Owner. Only the
 * Owner sees Decide; the server answers anybody else with 403.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, Check, Clock, Gavel, Loader2, RotateCcw, ShieldCheck, X,
} from 'lucide-react'
import { ApiError } from '@/lib/api'
import { roleAppeals, type RoleAppeal } from '@/lib/apiPartners'
import {
  MIN_NOTE, OUTCOME_LABEL, ROLE_KIND_LABEL,
  noteProblem, presentRoleAppealStatus, roleAppealActions, roleRecordHref,
  type RoleAppealOutcome, type RoleKind,
} from '@/lib/governanceRequests'
import { Denied, Empty, ErrorState, Loading } from '@/components/ui/States'
import { useAuth } from '@/components/AuthProvider'
import { canAccess, hasPermission, type CrmRole } from '@/lib/auth'
import { IdentityBlock } from '@/components/ui/Identity'
import { ID_LABEL, nameOrReference } from '@/lib/identity'
import { useIdentities } from '@/lib/useIdentities'

/** The roles that hold a review permission for some kind — plus the Owner. */
const VIEW_ROLES: CrmRole[] = ['superadmin', 'ops_admin']

type Tab = 'open' | 'all'

function age(iso: string | null | undefined): string {
  if (!iso) return 'age unknown'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 'age unknown'
  const mins = Math.floor((Date.now() - t) / 60000)
  if (mins < 60) return `${Math.max(mins, 0)}m`
  const hrs = Math.floor(mins / 60)
  return hrs < 24 ? `${hrs}h` : `${Math.floor(hrs / 24)}d`
}

function kindLabel(kind: unknown): string {
  return ROLE_KIND_LABEL[kind as RoleKind] ?? String(kind ?? 'Role')
}

type Mode = 'recommend' | 'decide'

export default function RoleAppealsPage() {
  const { crmUser, apiUser, loading: authLoading } = useAuth()
  const canView = canAccess(crmUser, VIEW_ROLES) || apiUser?.role === 'owner'
  const me = {
    isOwner: apiUser?.role === 'owner',
    permissions: (['can_approve_kyc', 'can_approve_seller'] as const).filter((p) => hasPermission(crmUser, p)),
  }

  const [tab, setTab] = useState<Tab>('open')
  const [rows, setRows] = useState<RoleAppeal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [target, setTarget] = useState<{ appeal: RoleAppeal; mode: Mode } | null>(null)
  const [outcome, setOutcome] = useState<RoleAppealOutcome>('restore')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setRows(await roleAppeals.list(tab))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the reinstatement requests.')
    } finally {
      setLoading(false)
    }
  }, [tab])

  useEffect(() => {
    if (!canView) return
    load()
  }, [canView, load])

  // B1: who each request is from. `uid` is the person (a Firebase uid);
  // `record_id` is the uid itself for a Host role and a partner RECORD id
  // (agency, sub-agency or seller) otherwise — looked up separately, never
  // assumed to be the same thing. Contacts only for a viewer who may already
  // read user profiles (`can_view_users`), the rule every user screen follows.
  const showContacts = hasPermission(crmUser, 'can_view_users')
  const who = useIdentities({
    enabled: canView && !loading,
    people: rows.map((a) => a.uid),
    partners: rows.filter((a) => a.kind !== 'host').map((a) => a.record_id),
  })

  function open(appeal: RoleAppeal, mode: Mode) {
    setTarget({ appeal, mode })
    // A decision starts from the recommendation, when there is one — the
    // Owner can still choose the other way.
    setOutcome(mode === 'decide' && appeal.recommendation?.outcome ? appeal.recommendation.outcome : 'restore')
    setNote('')
    setFailure('')
  }

  async function submit() {
    if (!target) return
    const problem = noteProblem(note)
    if (problem) { setFailure(problem); return }
    setBusy(true)
    setFailure('')
    try {
      const res = target.mode === 'recommend'
        ? await roleAppeals.recommend(target.appeal.id, outcome, note.trim())
        : await roleAppeals.decide(target.appeal.id, outcome, note.trim())
      setNotice(
        (target.mode === 'recommend'
          ? `Recommendation recorded: ${OUTCOME_LABEL[outcome].toLowerCase()}. The Owner decides.`
          : outcome === 'restore'
            ? 'Decided: the role is restored on its existing record.'
            : 'Decided: the role stays revoked.') +
        (res && typeof res.note === 'string' && res.note ? ` ${res.note}` : ''),
      )
      setTarget(null)
      await load()
    } catch (err) {
      // Shown as written: a 403 from Decide says who decides, a 409 says the
      // request was decided meanwhile.
      setFailure(err instanceof ApiError ? err.message : 'That did not go through.')
    } finally {
      setBusy(false)
    }
  }

  if (authLoading) return <Loading label="Checking your access…" />
  if (!canView) return <Denied what="reinstatement requests" />

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2">
            <RotateCcw size={26} className="text-pink-500" />
            Reinstatement requests
          </h1>
          <p className="text-slate-400 text-sm mt-1 max-w-2xl">
            People asking for a revoked Host, Agency, Sub-agency or Coin Seller role
            back. Reviewers recommend an outcome; only the Owner decides. A restore
            re-activates the person&rsquo;s existing record — never a new one.
          </p>
        </div>
      </div>

      {notice && (
        <div className="mb-4 flex items-start justify-between gap-3 bg-green-500/10 border border-green-500/30 rounded-xl px-4 py-3">
          <p className="text-green-100 text-sm flex items-start gap-2">
            <Check size={15} className="text-green-400 mt-0.5 shrink-0" /> {notice}
          </p>
          <button onClick={() => setNotice('')} className="text-green-400/70 hover:text-green-200">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="flex gap-1 border-b border-slate-800 mb-5">
        {([['open', 'Open'], ['all', 'All']] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === key ? 'border-pink-500 text-pink-400' : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <Loading label="Reading the reinstatement requests…" />
      ) : error ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl">
          <ErrorState message={error} onRetry={load} />
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl">
          <Empty
            title={tab === 'open' ? 'Nobody is waiting on a reinstatement' : 'No reinstatement request yet'}
            hint={
              tab === 'open'
                ? 'Every request has been decided. This is the queue reporting itself empty, not a read that failed.'
                : 'A request appears here when somebody whose role was revoked asks for it back from the app.'
            }
            icon={<ShieldCheck size={26} />}
          />
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((a) => {
            const status = presentRoleAppealStatus(a.status)
            const actions = roleAppealActions(a, me)
            const recordHref = roleRecordHref(a.kind, a.record_id, a.uid)
            return (
              <div key={a.id || `${a.uid}:${a.kind}`} className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
                  <div className="min-w-0 space-y-1">
                    <p className="text-white font-semibold">{kindLabel(a.kind)} role</p>
                    <IdentityBlock
                      facts={who.people.get(a.uid)}
                      id={a.uid}
                      kind="account"
                      state={who.state}
                      showContacts={showContacts}
                      href={`/users/${a.uid}`}
                    />
                    <p className="text-slate-500 text-xs font-mono break-all">
                      {a.kind === 'host' ? (
                        <>{ID_LABEL.host}:{' '}
                          {recordHref
                            ? <Link href={recordHref} className="text-slate-300 hover:text-white">{a.record_id || a.uid}</Link>
                            : (a.record_id || a.uid)}</>
                      ) : (
                        <>{ID_LABEL.partner}:{' '}
                          {recordHref
                            ? <Link href={recordHref} className="text-slate-300 hover:text-white">{a.record_id || '—'}</Link>
                            : (a.record_id || '—')}
                          {who.partners.get(a.record_id)?.found && who.partners.get(a.record_id)?.name
                            ? <span className="font-sans text-slate-400"> ({who.partners.get(a.record_id)!.name})</span>
                            : null}</>
                      )}
                      {a.id ? <> · {ID_LABEL.request}: {a.id}</> : null}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <span className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-slate-800 text-slate-400">
                      <Clock size={11} /> {age(a.created_at)}
                    </span>
                    <span className={`text-xs px-2 py-1 rounded border ${status.tone}`}>{status.label}</span>
                  </div>
                </div>

                <p className="text-slate-200 text-sm bg-slate-950 border border-slate-800 rounded-lg px-3 py-2.5 whitespace-pre-wrap">
                  {a.statement || 'No statement was given.'}
                </p>

                {a.recommendation && (
                  <div className="mt-3 border-t border-slate-800 pt-3">
                    <p className="text-slate-400 text-sm">
                      <span className="text-slate-500">
                        Recommended{a.recommendation.by_role ? ` by ${a.recommendation.by_role}` : ''}:
                      </span>{' '}
                      <span className="text-blue-200">
                        {OUTCOME_LABEL[a.recommendation.outcome] ?? a.recommendation.outcome}
                      </span>{' '}
                      — {a.recommendation.note}
                    </p>
                  </div>
                )}

                {a.decision ? (
                  <div className="mt-3 border-t border-slate-800 pt-3">
                    <p className="text-slate-400 text-sm">
                      <span className="text-slate-500">The Owner decided:</span>{' '}
                      <span className="text-white">{OUTCOME_LABEL[a.decision.outcome] ?? a.decision.outcome}</span>
                      {a.decision.note ? ` — ${a.decision.note}` : ''}
                    </p>
                  </div>
                ) : (
                  <p className="text-slate-500 text-xs mt-3">{status.note}</p>
                )}

                {(actions.recommend || actions.decide || actions.hint) && (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {actions.recommend && (
                      <button
                        onClick={() => open(a, 'recommend')}
                        className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg px-4 py-2 text-sm transition-colors"
                      >
                        <RotateCcw size={14} /> Recommend
                      </button>
                    )}
                    {actions.decide && (
                      <button
                        onClick={() => open(a, 'decide')}
                        className="flex items-center gap-1.5 bg-pink-500 hover:bg-pink-600 text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors"
                      >
                        <Gavel size={14} /> Decide
                      </button>
                    )}
                    {actions.hint && <span className="text-slate-500 text-xs">{actions.hint}</span>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {target && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-md">
            <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800">
              <div className="min-w-0">
                <h2 className="text-white font-semibold">
                  {target.mode === 'recommend' ? 'Recommend an outcome' : 'Decide this reinstatement'}
                </h2>
                <p className="text-slate-500 text-xs mt-0.5 truncate">
                  {kindLabel(target.appeal.kind)} role · {nameOrReference(who.people.get(target.appeal.uid), target.appeal.uid, 'account')}
                </p>
              </div>
              <button onClick={() => setTarget(null)} className="text-slate-500 hover:text-white shrink-0">
                <X size={16} />
              </button>
            </div>

            <div className="p-5 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                {(['restore', 'keep_revoked'] as const).map((o) => (
                  <button
                    key={o}
                    onClick={() => setOutcome(o)}
                    className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                      outcome === o
                        ? o === 'restore'
                          ? 'bg-green-500/10 border-green-500/40 text-green-300'
                          : 'bg-slate-700/40 border-slate-600 text-slate-100'
                        : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600'
                    }`}
                  >
                    {OUTCOME_LABEL[o]}
                  </button>
                ))}
              </div>

              <p className="text-slate-300 text-sm leading-relaxed">
                {target.mode === 'recommend'
                  ? 'A recommendation decides nothing. It is recorded against your name and the Owner is told; the role stays revoked until the Owner decides.'
                  : outcome === 'restore'
                    ? 'Restores the role on its EXISTING record — the role table and the agency are re-checked first, and the person is told.'
                    : 'The role stays revoked and the request is kept as history. The person is told.'}
              </p>

              <div>
                <label className="block text-slate-400 text-xs font-medium mb-1.5">
                  Note <span className="text-pink-400">(required)</span>
                </label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={4}
                  autoFocus
                  placeholder="What you checked, and why this is the right outcome…"
                  className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 resize-none"
                />
                <p className="text-slate-600 text-xs mt-1">
                  At least {MIN_NOTE} characters. Stored in the audit log.
                </p>
              </div>

              {failure && (
                <p className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-300 text-sm">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {failure}
                </p>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-800">
              <button onClick={() => setTarget(null)} className="text-slate-400 hover:text-white text-sm px-4 py-2">
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={busy}
                className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:bg-slate-800 disabled:text-slate-600 text-white font-semibold rounded-lg px-5 py-2.5 text-sm transition-colors"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : target.mode === 'recommend' ? <RotateCcw size={14} /> : <Gavel size={14} />}
                {target.mode === 'recommend' ? 'Record recommendation' : 'Decide'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
