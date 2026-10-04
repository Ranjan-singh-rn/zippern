'use client'

/**
 * Applicants whose business record could not be created, put in front of staff.
 *
 * Every agency and coin seller created in the CRM is registered with the API by
 * the Firestore triggers `registerAgencyPartner` / `registerSellerPartner`
 * (functions/src/index.ts § 13). That is what puts them in the queue on this
 * screen — the queue reads Mongo's `partners` collection, and the applicant
 * cannot create their own record because an external partner holds no API
 * session at all (`sign_in_with_firebase` resolves a role from the Mongo `staff`
 * collection, and no partner is ever in it).
 *
 * When that call cannot be made — the API is unreachable, or the credential on
 * the function and the one on the backend have drifted — the trigger writes
 * `partnerRecordFailed: true` and the reason onto the Firestore document rather
 * than failing silently. This panel is the other half of that: without it the
 * flag would sit in Firestore where nobody looks, and the applicant would be
 * exactly as invisible as before. **A partner whose registration failed is worse
 * than one who never applied**, because they have a login, they have the
 * acknowledgement email, and everyone believes it worked.
 *
 * Retrying calls `POST /partner-ops/partners`, which creates the record holding
 * nothing — zero coins, zero credit, zero commission — and `pending`. It is not
 * an approval and it grants nothing; the row simply joins the queue below and is
 * approved with the ordinary Approve button against the ordinary mandatory
 * reason. Retrying something that was already created is a no-op.
 *
 * It renders nothing when there is nothing wrong.
 */

import { useCallback, useEffect, useState } from 'react'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { db } from '@/lib/firebase'
import { ApiError } from '@/lib/api'
import { partnerOps } from '@/lib/apiPartners'

interface Stranded {
  /** Firestore document id — which is the partner id the API expects. */
  id: string
  name: string
  /** What the trigger said went wrong. Never contains a credential. */
  error: string
}

/** Enough of a reason to satisfy the API's 3-character floor, and to read well. */
const RETRY_REASON =
  'Automatic registration failed when this application was filed; creating the ' +
  'business record by hand so it can be reviewed. Created holding nothing and pending.'

export function FailedRegistrations({
  kind,
  knownPartnerIds,
  onRegistered,
}: {
  /** Which collection to look in. */
  kind: 'agency' | 'seller'
  /**
   * Ids that already have a business record. A flag left over from a failure
   * that was since resolved — by a retry, or by
   * `scripts/backfill_partners.py` — must not keep showing as a problem.
   */
  knownPartnerIds: ReadonlySet<string>
  onRegistered: () => void
}) {
  const [stranded, setStranded] = useState<Stranded[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      // A single equality filter, so no composite index is needed — the same
      // shape SecondRoleApplications uses for the same reason.
      const snap = await getDocs(
        query(
          collection(db, kind === 'seller' ? 'sellers' : 'agencies'),
          where('partnerRecordFailed', '==', true),
        ),
      )
      setStranded(
        snap.docs
          .filter((d) => !knownPartnerIds.has(d.id))
          .map((d) => {
            const data = d.data()
            const record = (data.partnerRecord ?? {}) as Record<string, unknown>
            return {
              id: d.id,
              name:
                (typeof data.displayName === 'string' && data.displayName) ||
                (typeof data.agencyName === 'string' && data.agencyName) ||
                (typeof data.ownerName === 'string' && data.ownerName) ||
                d.id,
              error:
                typeof record.error === 'string'
                  ? record.error
                  : 'No reason was recorded.',
            }
          }),
      )
    } catch {
      // The queue below is the real screen. If this read fails there is nothing
      // useful to add, and a banner about a banner helps nobody.
      setStranded([])
    }
  }, [kind, knownPartnerIds])

  useEffect(() => { load() }, [load])

  if (stranded.length === 0) return null

  const label = kind === 'seller' ? 'coin seller' : 'agency'

  async function retry(row: Stranded) {
    setError('')
    setBusy(row.id)
    try {
      await partnerOps.create(row.id, RETRY_REASON)
      await load()
      onRegistered()
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'The record could not be created. Nothing was changed.',
      )
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="bg-slate-900 border border-red-500/40 rounded-xl p-5 mb-6">
      <div className="flex items-center gap-2 mb-1">
        <AlertTriangle size={17} className="text-red-400" />
        <h2 className="text-white font-semibold">
          {stranded.length} {label} application
          {stranded.length === 1 ? '' : 's'} never reached the queue
        </h2>
      </div>
      <p className="text-slate-400 text-sm leading-relaxed mb-4">
        These applicants registered and their business record could not be
        created, so they are <strong className="text-white">not in the table
        below</strong> and nobody can approve them. They have a login and they
        have been told we have their application. Creating the record here puts
        them in the queue holding nothing — no coins, no credit, no commission —
        and <strong className="text-white">approves nothing</strong>.
      </p>

      {error && (
        <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-3">
          {error}
        </p>
      )}

      <div className="space-y-3">
        {stranded.map((row) => (
          <div
            key={row.id}
            className="bg-slate-800/60 border border-slate-700 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center gap-3"
          >
            <div className="min-w-0 flex-1">
              <p className="text-white text-sm font-medium truncate">{row.name}</p>
              <p className="text-slate-600 text-xs font-mono truncate">{row.id}</p>
              <p className="text-red-300/80 text-xs mt-1 line-clamp-3">{row.error}</p>
            </div>
            <button
              type="button"
              onClick={() => retry(row)}
              disabled={busy === row.id}
              className="flex items-center justify-center gap-2 px-4 py-2 bg-red-500 hover:bg-red-400 disabled:opacity-50 text-white rounded-lg text-sm font-semibold transition-colors flex-shrink-0"
            >
              {busy === row.id && <Loader2 size={14} className="animate-spin" />}
              Put in the queue
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

export default FailedRegistrations
