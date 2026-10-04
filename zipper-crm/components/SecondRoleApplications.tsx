'use client'

/**
 * Second-capability applications waiting to be put in front of a reviewer.
 *
 * An approved agency asking to also sell coins, or a coin seller asking to also
 * run an agency, files the application from their own dashboard. That write
 * goes to Firestore, because **an external partner holds no API session** —
 * `app/core/security.py::sign_in_with_firebase` resolves a role from the Mongo
 * `staff` collection and refuses anybody who is not in it, and nothing anywhere
 * writes an agency or a seller into that collection. So the business record the
 * queue is built from cannot be created by the applicant; it is created here,
 * by staff, through `POST /partner-ops/partners/{id}/second-role`.
 *
 * Filing it creates the second record holding nothing — zero coins, zero
 * credit, zero commission — and `pending`. From that moment it is an ordinary
 * row in the table below, approved with the ordinary Approve button and the
 * ordinary mandatory reason. This panel is the bridge and nothing more: it
 * grants nothing and moves nothing.
 *
 * It renders nothing when there is nothing waiting.
 */

import { useCallback, useEffect, useState } from 'react'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { UserPlus, Loader2 } from 'lucide-react'
import { db } from '@/lib/firebase'
import { ApiError } from '@/lib/api'
import { partnerOps, type PartnerKind } from '@/lib/apiPartners'

interface Waiting {
  /** Firestore document id of the record they applied for. */
  id: string
  name: string
  /** The record they already hold, which this capability sits beside. */
  heldPartnerId: string
  /** What the applicant said when they filed it. */
  reason: string
}

const MIN_REASON = 3

export function SecondRoleApplications({
  kind,
  knownPartnerIds,
  onFiled,
}: {
  /** Which side of the queue this is: the kind being APPLIED FOR. */
  kind: Extract<PartnerKind, 'agency' | 'seller'>
  /** Ids already in the queue — those need no bridging. */
  knownPartnerIds: ReadonlySet<string>
  onFiled: () => void
}) {
  const [waiting, setWaiting] = useState<Waiting[]>([])
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [filing, setFiling] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      // A single equality filter, so no composite index is needed. Status is
      // filtered here rather than in the query for the same reason.
      const snap = await getDocs(
        query(
          collection(db, kind === 'seller' ? 'sellers' : 'agencies'),
          where('source', '==', 'second_role'),
        ),
      )
      setWaiting(
        snap.docs
          .filter((d) => !knownPartnerIds.has(d.id))
          .map((d) => {
            const data = d.data()
            return {
              id: d.id,
              name:
                (typeof data.displayName === 'string' && data.displayName) ||
                (typeof data.agencyName === 'string' && data.agencyName) ||
                d.id,
              heldPartnerId:
                typeof data.secondRoleOfPartnerId === 'string'
                  ? data.secondRoleOfPartnerId
                  : '',
              reason:
                typeof data.secondRoleReason === 'string'
                  ? data.secondRoleReason
                  : '',
            }
          })
          .filter((w) => w.heldPartnerId !== ''),
      )
    } catch {
      // Not a failure worth a banner: the queue below is the real screen, and
      // this panel simply has nothing to add if it cannot read.
      setWaiting([])
    }
  }, [kind, knownPartnerIds])

  useEffect(() => { load() }, [load])

  if (waiting.length === 0) return null

  const held = kind === 'seller' ? 'agency' : 'coin seller'
  const applied = kind === 'seller' ? 'coin seller' : 'agency'

  async function file(row: Waiting) {
    const reason = (reasons[row.id] ?? '').trim()
    if (reason.length < MIN_REASON) {
      setError('A reason is required before this goes into the queue.')
      return
    }
    setError('')
    setFiling(row.id)
    try {
      await partnerOps.requestSecondRole(row.heldPartnerId, row.id, reason)
      await load()
      onFiled()
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'The application could not be filed. Nothing was created.',
      )
    } finally {
      setFiling('')
    }
  }

  return (
    <div className="bg-slate-900 border border-indigo-500/30 rounded-xl p-5 mb-6">
      <div className="flex items-center gap-2 mb-1">
        <UserPlus size={17} className="text-indigo-400" />
        <h2 className="text-white font-semibold">
          {waiting.length} {applied} application{waiting.length === 1 ? '' : 's'} from
          existing {held}s
        </h2>
      </div>
      <p className="text-slate-400 text-sm leading-relaxed mb-4">
        These are existing partners asking to run a second business on the same
        login. Filing one creates a <strong className="text-white">separate</strong>{' '}
        record holding nothing — no coins, no credit, no commission — and puts it
        in the queue below, where it is approved like any other application.
        Their existing balance is untouched either way.
      </p>

      {error && (
        <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-3">
          {error}
        </p>
      )}

      <div className="space-y-3">
        {waiting.map((row) => (
          <div
            key={row.id}
            className="bg-slate-800/60 border border-slate-700 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center gap-3"
          >
            <div className="min-w-0 flex-1">
              <p className="text-white text-sm font-medium truncate">{row.name}</p>
              <p className="text-slate-600 text-xs font-mono truncate">{row.id}</p>
              {row.reason && (
                <p className="text-slate-400 text-xs mt-1 line-clamp-2">
                  “{row.reason}”
                </p>
              )}
            </div>
            <input
              value={reasons[row.id] ?? ''}
              onChange={(e) =>
                setReasons((prev) => ({ ...prev, [row.id]: e.target.value }))
              }
              placeholder="Reason — recorded in the audit log"
              maxLength={1000}
              className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:border-indigo-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => file(row)}
              disabled={filing === row.id}
              className="flex items-center justify-center gap-2 px-4 py-2 bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-white rounded-lg text-sm font-semibold transition-colors flex-shrink-0"
            >
              {filing === row.id && <Loader2 size={14} className="animate-spin" />}
              Put in the queue
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

export default SecondRoleApplications
