'use client'

/**
 * Host identity verification review.
 *
 * The agency uploads a photograph when it registers a host, the host takes a
 * live capture in the app, and something compares the two. Anything the
 * comparison cannot settle — which, until a server-side face provider is
 * configured, is every case — waits here for a person.
 *
 * ── Why this screen had to exist ─────────────────────────────────────────────
 *
 * The API has had `/host-verification/pending`, `/host-verification/{uid}` and
 * `/host-verification/{uid}/review` all along, and nothing in the CRM called
 * them. So no host could ever be verified, and `isVerifiedHost` gates three
 * things that matter to the person waiting:
 *
 *   * withdrawals — `releaseBeansForWeek` will not release a week's earnings
 *     for an unverified host, so their money sits and does not move;
 *   * their own call rate — `functions/src/calls.ts` prices an unverified host
 *     at the base rate however high the agency set theirs, so the rate ladder
 *     never starts;
 *   * the badge, featuring and PK battles.
 *
 * ── The photographs are biometric data ───────────────────────────────────────
 *
 * A face is biometric data under India's DPDP Act, and this screen handles the
 * two images accordingly:
 *
 *   * the signed URLs are fetched only when a reviewer opens a case, held in
 *     component state, and dropped the moment the case is closed. They are
 *     never put in the queue rows, never written to storage, and never survive
 *     a navigation;
 *   * they are never logged — not to `console`, not into an error message, not
 *     into the audit reason. A URL in a log line is a fifteen-minute standing
 *     grant to a photograph of somebody's face;
 *   * they go nowhere but the `src` of the `<img>` rendering them. No preload,
 *     no proxy, no copy-link affordance, and `referrerPolicy="no-referrer"` so
 *     the bucket host is not told which CRM page was looking at it.
 *
 * Fifteen minutes is the server's TTL (`SIGNED_URL_TTL`). A case left open
 * longer than that shows broken images rather than stale ones, so reopening is
 * the right move and the screen says so.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowLeft, CheckCircle2, Clock, ImageOff, Loader2, ScanFace,
  ShieldCheck, X, XCircle,
} from 'lucide-react'

import { useAuth } from '@/components/AuthProvider'
import { canAccess, CrmRole } from '@/lib/auth'
import { nameOrReference, referenceOf } from '@/lib/identity'
import { useIdentities } from '@/lib/useIdentities'
import api, {
  ApiError,
  type PendingVerification,
  type VerificationCase,
} from '@/lib/api'
import { Column, DataTable } from '@/components/ui/DataTable'
import { Denied, Loading, Warning } from '@/components/ui/States'

/**
 * Who may decide.
 *
 * The API's own guard is `require_write`, which admits every internal role and
 * refuses the observer and every partner. The partner refusal is the one that
 * carries weight: an agency approving its own hosts is precisely the conflict
 * of interest verification exists to prevent, and the server enforces it
 * regardless of what this list says.
 *
 * This list is narrower than `require_write` on purpose — a verdict here makes
 * somebody payable, so it sits with the teams that already own host records and
 * moderation rather than with everyone who can write anything.
 */
const VERIFICATION_ROLES: CrmRole[] = [
  'superadmin', 'app_admin', 'app_member', 'ops_admin', 'ops_member',
]

/** The API refuses a note shorter than this, so the button refuses it first. */
const MIN_REASON = 3

function when(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function waitingDays(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return (Date.now() - t) / 86_400_000
}

/**
 * Why this case reached a human, in words.
 *
 * `no_ai` and `below_threshold` are read very differently by a reviewer: the
 * first means nothing compared the two faces at all and the whole judgement is
 * theirs, the second means a comparator looked and was not convinced. Rendering
 * both as "manual review" throws that away.
 */
function reasonLabel(row: PendingVerification): string {
  if (row.manualReason === 'no_ai') {
    return 'No comparison ran — judge the two photographs yourself'
  }
  if (row.manualReason === 'below_threshold') {
    const score = row.aiScore
    const threshold = row.aiThreshold
    return score !== null && threshold !== null
      ? `Comparison scored ${score} against a threshold of ${threshold}`
      : 'The comparison scored below its threshold'
  }
  return row.manualReason || 'Awaiting a decision'
}

// ── The review dialog ─────────────────────────────────────────────────────────

/**
 * One case, its two photographs, and the verdict.
 *
 * The case is fetched on open rather than carried in from the row, because the
 * signed URLs are what the fetch is for and they must not exist any longer than
 * the dialog does.
 */
function ReviewDialog({
  row, onClose, onDecided,
}: {
  row: PendingVerification
  onClose: () => void
  onDecided: (message: string) => void
}) {
  const [detail, setDetail] = useState<VerificationCase | null>(null)
  // B1: name the agency on the case (an agencies/{id} record id).
  const caseAgency = useIdentities({ partners: detail?.agencyId ? [detail.agencyId] : [] })
  const [loadError, setLoadError] = useState('')
  const [verdict, setVerdict] = useState<'verified' | 'rejected' | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    let live = true
    api.hostVerification
      .get(row.uid)
      .then((c) => { if (live) setDetail(c) })
      .catch((e: unknown) => {
        if (!live) return
        setLoadError(
          e instanceof ApiError
            ? e.message
            : 'This case could not be read. Nothing was decided.',
        )
      })
    // Dropping the case on unmount is the point: the signed URLs it carries are
    // a live grant to two photographs of a face, and nothing in this CRM has
    // any business holding one after the reviewer has closed the dialog.
    return () => { live = false }
  }, [row.uid])

  async function decide() {
    if (!verdict || reason.trim().length < MIN_REASON) return
    setBusy(true)
    setErr('')
    try {
      const res = await api.hostVerification.review(row.uid, verdict, reason.trim())
      onDecided(
        verdict === 'verified'
          ? `${row.hostName || row.uid} is verified. Their withdrawals are unblocked `
            + 'and they now earn at their own call rate.'
          : `${row.hostName || row.uid} was rejected and the note was recorded. `
            + (res.beansHeldNotLost
              ? 'Their unreleased earnings are held, not lost — passing a later '
                + 'attempt pays all of it.'
              : ''),
      )
    } catch (e) {
      // Deliberately does not include the case detail in the message: it holds
      // the signed photo URLs, and an error string is the easiest way for one to
      // end up in a log.
      setErr(e instanceof ApiError ? e.message : 'That did not go through.')
      setBusy(false)
    }
  }

  const rejecting = verdict === 'rejected'
  const tooShort = reason.trim().length < MIN_REASON

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-3xl shadow-2xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-slate-800">
          <div className="min-w-0">
            <h2 className="text-white font-semibold text-lg truncate">
              {row.hostName || row.uid}
            </h2>
            <p className="text-slate-500 text-xs mt-0.5 font-mono truncate">{row.uid}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white shrink-0">
            <X size={18} />
          </button>
        </div>

        {loadError ? (
          <div className="px-6 py-10">
            <Warning>{loadError}</Warning>
          </div>
        ) : !detail ? (
          <Loading label="Opening the case…" />
        ) : (
          <>
            {/* An image that EXISTS and could not be linked to is an outage,
                not a finding about this host. It affects every case in the
                queue, and a reviewer must not reject somebody over it — so it
                is said once, loudly, above both panels. */}
            {detail.signingError && (
              <div className="mx-6 mt-5 bg-yellow-500/5 border border-yellow-500/30 rounded-xl px-4 py-3">
                <p className="flex items-center gap-2 text-yellow-300 text-sm font-semibold">
                  <AlertTriangle size={15} /> The images could not be loaded — do not
                  reject this host
                </p>
                <p className="text-slate-400 text-sm mt-1">{detail.signingError}</p>
                <p className="text-slate-500 text-xs mt-2">
                  Close without deciding. The host has done nothing wrong and their
                  capture is safely stored.
                </p>
              </div>
            )}

            {/* The two photographs */}
            <div className="px-6 pt-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Photo
                label="Uploaded by the agency"
                url={detail.agencyPhotoSignedUrl}
                missingNote={
                  detail.agencyPhotoMissing
                    ? 'The agency never uploaded one. That is the finding — there is '
                      + 'nothing to compare the capture against, so this case cannot '
                      + 'be settled on the photographs alone.'
                    : 'The photograph exists but could not be signed for viewing. It '
                      + 'is not missing; it could not be read.'
                }
              />
              <Photo
                label="Live capture from the app"
                url={detail.captureSignedUrl}
                missingNote={
                  detail.captureMissing
                    ? 'The host has not submitted a capture. Reject and ask them to '
                      + 'take one rather than guessing from one image.'
                    : 'The capture was taken and is stored — it could not be signed '
                      + 'for viewing. Do not reject the host for this.'
                }
              />
            </div>

            <p className="px-6 pt-3 text-slate-600 text-xs leading-relaxed">
              Both links expire fifteen minutes after the case was opened and are held
              nowhere but this dialog. If an image goes blank, close and reopen the case
              — do not copy the link out.
            </p>

            {/* The facts the verdict is read back against */}
            <div className="mx-6 mt-4 bg-slate-800/60 border border-slate-700 rounded-xl p-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <Fact label="Agency" value={detail.agencyId ? nameOrReference(caseAgency.partners.get(detail.agencyId), detail.agencyId, 'agency') : 'none on record'} />
              <Fact label="Attempts" value={String(detail.attemptCount)} />
              <Fact
                label="Comparison"
                value={
                  detail.aiScore === null
                    ? 'none ran'
                    : `${detail.aiScore} / ${detail.aiThreshold ?? '—'}`
                }
              />
              <Fact label="Captured" value={when(detail.capturedAt)} />
            </div>

            {detail.previousNote && (
              <div className="mx-6 mt-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
                <p className="text-amber-200 text-xs font-semibold">
                  Rejected before{detail.lastRejectedAt ? ` · ${when(detail.lastRejectedAt)}` : ''}
                </p>
                <p className="text-amber-100/80 text-sm mt-1">{detail.previousNote}</p>
              </div>
            )}

            {/* The verdict */}
            <div className="px-6 py-5 space-y-4">
              <div className="flex flex-wrap gap-3">
                <button
                  onClick={() => setVerdict('verified')}
                  className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border transition-colors ${
                    verdict === 'verified'
                      ? 'bg-green-600 border-green-500 text-white'
                      : 'bg-slate-800 border-slate-700 text-slate-300 hover:border-green-500'
                  }`}
                >
                  <ShieldCheck size={14} /> Same person — verify
                </button>
                <button
                  onClick={() => setVerdict('rejected')}
                  className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border transition-colors ${
                    verdict === 'rejected'
                      ? 'bg-red-600 border-red-500 text-white'
                      : 'bg-slate-800 border-slate-700 text-slate-300 hover:border-red-500'
                  }`}
                >
                  <XCircle size={14} /> Not settled — reject
                </button>
              </div>

              {verdict && (
                <>
                  <div
                    className={`rounded-xl px-4 py-3 text-sm leading-relaxed border ${
                      rejecting
                        ? 'bg-amber-500/10 border-amber-500/30 text-amber-100'
                        : 'bg-green-500/10 border-green-500/30 text-green-100'
                    }`}
                  >
                    {rejecting ? (
                      <>
                        <span className="font-semibold">
                          Rejecting holds their earnings. It does not destroy them.
                        </span>{' '}
                        The weekly payout run skips an unverified host&rsquo;s weeks and
                        picks them up once the block clears, so a host who passes a later
                        attempt is paid everything they earned while unverified. What
                        rejecting does stop, now, is withdrawing — and it keeps them on the
                        base call rate instead of their own. The host is told to ask their
                        agency to re-upload, so write the note for them to act on.
                      </>
                    ) : (
                      <>
                        <span className="font-semibold">
                          Verifying makes this host payable.
                        </span>{' '}
                        It sets <code>isVerifiedHost</code>, which unlocks withdrawals, the
                        badge, featuring, PK battles and their own call rate — an
                        unverified host earns at the base rate however high the agency set
                        theirs. It takes effect immediately and is recorded against your
                        name in the audit log.
                      </>
                    )}
                  </div>

                  <div>
                    <label className="block text-slate-400 text-xs mb-1.5 font-medium">
                      What you saw (required — it is stored on the record and in the
                      audit log)
                    </label>
                    <textarea
                      autoFocus
                      rows={3}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder={
                        rejecting
                          ? 'e.g. The agency photograph is of a different person — different jawline and ear shape. Ask the agency to re-upload.'
                          : 'e.g. Same person — matching features, capture is clear and well lit.'
                      }
                      className={`w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-600 focus:outline-none resize-none ${
                        rejecting ? 'focus:border-red-500' : 'focus:border-green-500'
                      }`}
                    />
                    <p className="text-slate-600 text-xs mt-1">
                      A verdict with no words is indistinguishable from a misclick six
                      months later, and it is what the host&rsquo;s agency is asked to act
                      on. At least {MIN_REASON} characters.
                    </p>
                  </div>
                </>
              )}

              {err && (
                <p className="text-red-400 text-xs flex items-start gap-1.5">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  {err}
                </p>
              )}

              <div className="flex gap-3 pt-1">
                <button
                  onClick={onClose}
                  className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors"
                >
                  Close without deciding
                </button>
                <button
                  onClick={decide}
                  disabled={!verdict || tooShort || busy}
                  className={`flex-1 flex items-center justify-center gap-2 disabled:opacity-40 text-white font-medium rounded-lg px-4 py-2.5 text-sm transition-colors ${
                    rejecting
                      ? 'bg-red-600 hover:bg-red-500'
                      : 'bg-green-600 hover:bg-green-500'
                  }`}
                >
                  {busy ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : rejecting ? (
                    <XCircle size={14} />
                  ) : (
                    <CheckCircle2 size={14} />
                  )}
                  {verdict === 'rejected' ? 'Reject and hold earnings' : 'Verify this host'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * One photograph, or the sentence that explains its absence.
 *
 * A missing face is never rendered as an empty box: which of the two images is
 * missing, and why, is frequently the whole finding.
 */
function Photo({
  label, url, missingNote,
}: {
  label: string
  url: string | null
  missingNote: string
}) {
  return (
    <div>
      <p className="text-slate-400 text-xs font-medium mb-1.5">{label}</p>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={label}
          // Not `next/image`: that would put a face through the Next image
          // optimiser, which caches what it fetches on the server. A biometric
          // photograph behind a fifteen-minute grant must not acquire a cached
          // copy with a different lifetime.
          referrerPolicy="no-referrer"
          className="w-full h-64 object-contain bg-slate-950 border border-slate-800 rounded-xl"
        />
      ) : (
        <div className="w-full h-64 bg-slate-950 border border-slate-800 rounded-xl flex flex-col items-center justify-center gap-2 px-5 text-center">
          <ImageOff size={22} className="text-slate-700" />
          <p className="text-slate-500 text-xs leading-relaxed">{missingNote}</p>
        </div>
      )}
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-slate-500 uppercase tracking-wide">{label}</p>
      <p className="text-slate-200 mt-0.5 truncate" title={value}>{value}</p>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function HostVerificationPage() {
  const { crmUser, apiUser, loading: authLoading, apiReady, apiError } = useAuth()
  // The Observer reads the API and writes nothing at all (spec 1.1.4), and this
  // screen is nothing but a decision — so unlike the finance screens there is
  // no read here worth admitting them for.
  const isObserver = apiUser?.role === 'observer'
  const allowed = !isObserver && canAccess(crmUser, VERIFICATION_ROLES)

  const [rows, setRows] = useState<PendingVerification[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reviewing, setReviewing] = useState<PendingVerification | null>(null)
  // B1: name each row's agency (an agencies/{id} record id), in one batched read.
  const agencies = useIdentities({ enabled: allowed, partners: rows.map((r) => r.agencyId) })
  const [flash, setFlash] = useState('')

  const load = useCallback(() => {
    if (!allowed || !apiReady) return
    setLoading(true)
    setError('')
    api.hostVerification
      .pending()
      .then(setRows)
      .catch((e: unknown) =>
        setError(
          e instanceof ApiError
            ? `The queue could not be read: ${e.message} Nothing below is a count of zero.`
            : 'The queue could not be read. Nothing below is a count of zero — the list simply did not load.',
        ),
      )
      .finally(() => setLoading(false))
  }, [allowed, apiReady])

  useEffect(() => { load() }, [load])

  if (authLoading) return <Loading label="Checking your access…" />
  if (!allowed) return <Denied what="host identity verification" />

  const columns: Column<PendingVerification>[] = [
    {
      key: 'hostName',
      header: 'Host',
      render: (r) => (
        <div className="min-w-0">
          <p className="text-white font-medium truncate">{r.hostName || 'unnamed'}</p>
          <p className="text-slate-600 text-xs font-mono truncate">{r.uid}</p>
        </div>
      ),
    },
    {
      key: 'agencyId',
      header: 'Agency',
      hideOnMobile: true,
      render: (r) =>
        r.agencyId ? (
          <span className="text-purple-300 text-xs" title={referenceOf('agency', r.agencyId)}>
            {nameOrReference(agencies.partners.get(r.agencyId), r.agencyId, 'agency')}
          </span>
        ) : (
          <span className="text-slate-600 text-xs">none on record</span>
        ),
    },
    {
      key: 'manualReason',
      header: 'Why it is here',
      sortable: false,
      render: (r) => (
        <span className="text-slate-400 text-xs">{reasonLabel(r)}</span>
      ),
    },
    {
      key: 'attemptCount',
      header: 'Attempts',
      align: 'right',
      hideOnMobile: true,
      value: (r) => r.attemptCount,
      render: (r) => (
        <span className="tabular-nums text-slate-300">{r.attemptCount}</span>
      ),
    },
    {
      key: 'capturedAt',
      header: 'Waiting',
      align: 'right',
      value: (r) => new Date(r.capturedAt ?? 0).getTime(),
      render: (r) => {
        const days = waitingDays(r.capturedAt)
        return (
          <div className="text-right">
            <span
              className={`text-xs whitespace-nowrap ${
                days !== null && days >= 3 ? 'text-amber-300' : 'text-slate-500'
              }`}
            >
              {days === null ? 'undated' : `${days.toFixed(1)} days`}
            </span>
            <p className="text-slate-600 text-xs">{when(r.capturedAt)}</p>
          </div>
        )
      },
    },
    {
      key: 'actions',
      header: 'Actions',
      sortable: false,
      align: 'right',
      render: (r) => (
        <button
          onClick={(e) => { e.stopPropagation(); setReviewing(r) }}
          className="inline-flex items-center gap-1.5 text-pink-400 hover:text-pink-300 text-xs transition-colors"
        >
          <ScanFace size={12} /> Review
        </button>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/hosts"
          className="inline-flex items-center gap-1.5 text-slate-500 hover:text-slate-300 text-sm mb-2 transition-colors"
        >
          <ArrowLeft size={14} /> Hosts
        </Link>
        <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-3">
          <ScanFace size={24} className="text-pink-400" />
          Host verification
        </h1>
        <p className="text-slate-400 mt-1 text-sm max-w-3xl leading-relaxed">
          Hosts whose identity could not be settled automatically, oldest first — the
          one who has waited longest is the one who cannot withdraw. A verdict takes
          effect immediately, needs a note, and is recorded against your name.
        </p>
      </div>

      {apiReady && apiError && <Warning>{apiError}</Warning>}
      {flash && (
        <div className="flex items-start justify-between gap-3 bg-green-500/10 border border-green-500/30 rounded-xl px-4 py-3">
          <span className="flex items-start gap-2 text-green-300 text-sm">
            <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> {flash}
          </span>
          <button onClick={() => setFlash('')} className="text-green-400 hover:text-green-200">
            <X size={13} />
          </button>
        </div>
      )}

      <div className="bg-slate-800/40 border border-slate-700 rounded-xl px-4 py-3 flex items-start gap-3">
        <Clock size={15} className="text-slate-400 mt-0.5 shrink-0" />
        <p className="text-slate-400 text-sm leading-relaxed">
          Verifying unlocks withdrawals, the verified badge, featuring, PK battles and
          the host&rsquo;s own call rate.{' '}
          <span className="text-slate-300">
            Rejecting holds unreleased earnings rather than destroying them
          </span>{' '}
          — the weekly run skips those weeks and pays them once the host passes a later
          attempt. The two photographs open only inside a review and are not kept.
        </p>
      </div>

      {!apiReady ? (
        <Loading label="Waiting for the API session…" />
      ) : (
        <DataTable<PendingVerification>
          rows={rows}
          columns={columns}
          rowKey={(r) => r.uid}
          loading={loading}
          error={error || undefined}
          onRetry={load}
          onRowClick={(r) => setReviewing(r)}
          searchPlaceholder="Search host name, uid or agency…"
          searchKeys={['hostName', 'uid', 'agencyId']}
          // Deliberately no export. The rows name people awaiting a decision on
          // a biometric check; there is no reason for that list to leave the
          // screen as a file.
          pageSize={25}
          emptyTitle="Nobody is waiting on a verification decision"
          emptyHint="Hosts appear here when the face comparison cannot settle them. An empty queue means none are pending, not that the check is switched off."
        />
      )}

      {reviewing && (
        <ReviewDialog
          row={reviewing}
          onClose={() => setReviewing(null)}
          onDecided={(message) => {
            setReviewing(null)
            setFlash(message)
            load()
          }}
        />
      )}
    </div>
  )
}
