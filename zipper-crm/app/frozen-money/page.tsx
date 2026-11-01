'use client'

/**
 * Frozen money — RC (confirmed, CRM-FLOW 9.48).
 *
 * A suspension, a ban or a role revocation freezes the money behind it: a
 * Host's earnings, an Agency's or Sub-agency's money, a Coin Seller's money,
 * and payouts already on their way out. Nothing in that state moves — the
 * weekly bean release, conversions, withdrawals, commission payouts, coin
 * purchases, loans, sales and recharges all refuse — until the OWNER decides
 * here: release it, withhold it, or adjust it (record the adjustment, which a
 * balance card then carries out) and release.
 *
 *   GET  /api/partner-ops/frozen-money?status=frozen|withheld|…   (Owner only)
 *   POST /api/partner-ops/frozen-money/{key}/decide               (Owner only)
 *
 * Nothing is released by lifting the suspension or restoring the role.
 */

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Lock, Snowflake } from 'lucide-react'
import { frozenMoney, type FrozenMoney } from '@/lib/apiPartners'
import { Denied, Empty, ErrorState, Loading } from '@/components/ui/States'
import { IdentityBlock, IdentityInline } from '@/components/ui/Identity'
import { useAuth } from '@/components/AuthProvider'
import { canAccess, hasPermission } from '@/lib/auth'
import { nameOrReference, type IdKind } from '@/lib/identity'
import { useIdentities } from '@/lib/useIdentities'

const KIND_LABEL: Record<string, string> = {
  host_earnings: 'Host earnings',
  agency_money: 'Agency / Sub-agency money',
  seller_money: 'Coin Seller money',
  pending_transfers: 'Pending transfers',
}

/** Past tense for the notice ("withhold" + "d" used to print "withholdd"). */
const DONE: Record<'release' | 'withhold' | 'adjust', string> = {
  release: 'released', withhold: 'withheld', adjust: 'adjusted',
}

function when(v: unknown): string {
  const d = new Date(String(v ?? ''))
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

/**
 * What kind of freeze this is. An ACCOUNT freeze is keyed on the person's
 * Firebase uid (their Host earnings); a PARTNER freeze on a partner RECORD id —
 * an agency, sub-agency or Coin Seller record, which the person owns through
 * `owner_uid`. One person can have both at once, on separate cards.
 */
function subjectOf(r: FrozenMoney): { kind: IdKind; label: string } {
  if (r.subject.type === 'user') return { kind: 'account', label: 'Account freeze' }
  if (r.kinds.includes('seller_money')) return { kind: 'partner', label: 'Coin Seller record freeze' }
  if (r.kinds.includes('agency_money')) return { kind: 'partner', label: 'Agency / Sub-agency record freeze' }
  return { kind: 'partner', label: 'Partner record freeze' }
}

export default function FrozenMoneyPage() {
  const { crmUser } = useAuth()
  const isOwner = canAccess(crmUser, ['superadmin'])
  // The Owner holds `can_view_users`; the check is spelled out so this screen
  // follows the same rule as every other one that shows a contact.
  const showContacts = hasPermission(crmUser, 'can_view_users')
  const [status, setStatus] = useState<'frozen' | 'withheld' | ''>('frozen')
  const [rows, setRows] = useState<FrozenMoney[] | null>(null)
  const [error, setError] = useState('')
  const [deciding, setDeciding] = useState<{ row: FrozenMoney; decision: 'release' | 'withhold' | 'adjust' } | null>(null)
  const [note, setNote] = useState('')
  const [amount, setAmount] = useState('')
  const [direction, setDirection] = useState<'increase' | 'decrease'>('decrease')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    try {
      const out = await frozenMoney.list(status || undefined)
      setRows(out.freezes)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load frozen money.')
    }
  }, [status])
  useEffect(() => { if (isOwner) void load() }, [isOwner, load])

  // Names for every card at once: account subjects and partner owners from
  // `users`, partner subjects from `agencies`/`sellers`. Before the early
  // returns, so the hook count never changes between renders.
  const listed = rows ?? []
  const who = useIdentities({
    enabled: isOwner,
    people: [
      ...listed.filter((r) => r.subject.type === 'user').map((r) => r.subject.id),
      ...listed.filter((r) => r.subject.type !== 'user').map((r) => r.owner_uid ?? ''),
    ],
    partners: listed.filter((r) => r.subject.type !== 'user').map((r) => r.subject.id),
  })
  const factsOf = (r: FrozenMoney) =>
    r.subject.type === 'user' ? who.people.get(r.subject.id) : who.partners.get(r.subject.id)

  if (!isOwner) return <Denied what="frozen money (the Owner's to decide)" />
  if (error) return <ErrorState message={error} onRetry={load} />
  if (rows === null) return <Loading />

  const decide = async () => {
    if (!deciding) return
    setBusy(true)
    try {
      await frozenMoney.decide(deciding.row.id, {
        decision: deciding.decision,
        note: note.trim(),
        ...(deciding.decision === 'adjust'
          ? { adjustment: { amount: Math.round(Number(amount) || 0), direction } }
          : {}),
      })
      setNotice(
        `${nameOrReference(factsOf(deciding.row), deciding.row.subject.id, subjectOf(deciding.row).kind)}`
        + ` — ${deciding.row.id}: ${DONE[deciding.decision]}.`,
      )
      setDeciding(null); setNote(''); setAmount('')
      await load()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'The decision was refused.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-3">
        <Snowflake className="text-sky-400" size={24} />
        <h1 className="text-2xl font-bold text-white">Frozen money</h1>
      </div>
      <p className="text-slate-400 text-sm max-w-3xl">
        Money behind a suspension, ban or role revocation waits here. Nothing in this list is paid or
        moved until you release it. Lifting a suspension or restoring a role does not release it.
      </p>
      <div className="flex gap-2">
        {(['frozen', 'withheld', ''] as const).map((s) => (
          <button key={s || 'all'} onClick={() => setStatus(s)}
            className={`px-3 py-1.5 rounded-lg text-sm ${status === s ? 'bg-pink-600 text-white' : 'bg-slate-800 text-slate-300'}`}>
            {s === '' ? 'All' : s === 'frozen' ? 'Frozen' : 'Withheld'}
          </button>
        ))}
      </div>
      {notice && <p className="text-slate-300 text-sm">{notice}</p>}
      {rows.length === 0 ? <Empty title="Nothing is frozen." /> : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.id} className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-2">
              <div className="flex flex-wrap items-start gap-2">
                <Lock size={14} className="text-sky-300 mt-1 shrink-0" />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="text-slate-500 text-xs">{subjectOf(r).label}</p>
                  <IdentityBlock
                    facts={factsOf(r)}
                    id={r.subject.id}
                    kind={subjectOf(r).kind}
                    state={who.state}
                    showContacts={showContacts}
                  />
                  {r.subject.type !== 'user' && (
                    <p className="text-slate-400 text-xs">
                      Owned by{' '}
                      {r.owner_uid ? (
                        <IdentityInline
                          facts={who.people.get(r.owner_uid)}
                          id={r.owner_uid}
                          kind="account"
                          state={who.state}
                          showContacts={showContacts}
                        />
                      ) : (
                        <span className="italic">no owner recorded on this freeze</span>
                      )}
                    </p>
                  )}
                </div>
                <span className="text-xs px-2 py-0.5 rounded bg-sky-500/15 text-sky-300">{r.status}</span>
                <span className="text-slate-500 text-xs">since {when(r.frozen_at)}</span>
              </div>
              <p className="text-slate-300 text-sm">{r.kinds.map((k) => KIND_LABEL[k] ?? k).join(' · ')}</p>
              {r.causes.map((c, i) => (
                <p key={i} className="text-slate-400 text-xs">After {c.label}: {c.reason}</p>
              ))}
              {(r.snapshot?.cards?.length ?? 0) > 0 && (
                <p className="text-slate-400 text-xs">
                  Pending when frozen: {r.snapshot!.cards!.map((c) => `${c.type} ${c.amount ?? ''} ${c.currency ?? ''}`.trim()).join(', ')}
                </p>
              )}
              {typeof r.snapshot?.beansAvailable === 'number' && (
                <p className="text-slate-400 text-xs">Beans: {r.snapshot.beans ?? 0} earned, {r.snapshot.beansAvailable} released for withdrawal</p>
              )}
              {(r.status === 'frozen' || r.status === 'withheld') && (
                <div className="flex gap-2 pt-1">
                  {(['release', 'withhold', 'adjust'] as const).map((d) => (
                    <button key={d} onClick={() => { setDeciding({ row: r, decision: d }); setNote('') }}
                      className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm text-slate-200">
                      {d === 'release' ? 'Release' : d === 'withhold' ? 'Withhold' : 'Adjust'}
                    </button>
                  ))}
                </div>
              )}
              {(r.decisions ?? []).map((d, i) => (
                <p key={i} className="text-slate-500 text-xs">
                  {when(d.at)} — {d.decision}{d.adjustment ? ` (${d.adjustment.direction} ${d.adjustment.amount})` : ''}: {d.note}
                </p>
              ))}
            </div>
          ))}
        </div>
      )}

      {deciding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-md p-5 space-y-3">
            <div>
              <h3 className="text-white font-semibold">
                {deciding.decision === 'release' ? 'Release' : deciding.decision === 'withhold' ? 'Withhold' : 'Adjust'}
                {' — '}
                {nameOrReference(factsOf(deciding.row), deciding.row.subject.id, subjectOf(deciding.row).kind)}
              </h3>
              <p className="text-slate-500 text-xs font-mono">Freeze key: {deciding.row.id}</p>
            </div>
            {deciding.decision === 'adjust' && (
              <div className="flex gap-2">
                <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" placeholder="Amount"
                  className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
                <select value={direction} onChange={(e) => setDirection(e.target.value as 'increase' | 'decrease')}
                  className="bg-slate-900 border border-slate-700 rounded-lg px-2 text-sm text-white">
                  <option value="decrease">decrease</option>
                  <option value="increase">increase</option>
                </select>
              </div>
            )}
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why (required)"
              className="w-full h-24 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
            {deciding.decision === 'adjust' && (
              <p className="text-slate-400 text-xs">The adjustment is recorded here and carried out by a balance card.</p>
            )}
            <div className="flex gap-2">
              <button onClick={() => setDeciding(null)} className="flex-1 bg-slate-700 rounded-lg py-2 text-sm text-slate-200">Cancel</button>
              <button onClick={decide} disabled={busy || note.trim().length < 5}
                className="flex-1 bg-pink-600 rounded-lg py-2 text-sm text-white disabled:opacity-50">
                {busy ? <Loader2 size={14} className="animate-spin inline" /> : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
