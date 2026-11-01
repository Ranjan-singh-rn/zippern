'use client'

/**
 * The host record behind a user — their application, their KYC and where they
 * get paid.
 *
 * ── WHY THIS PANEL EXISTS ────────────────────────────────────────────────────
 *
 * This page showed Actions, Activity, Warnings, Diamonds and Beans, and for a
 * host that is everything EXCEPT the things a host is: which agency recruited
 * them, what rate was agreed, which documents were checked, who checked them,
 * and whether the face capture has been done. Opening a host here and finding
 * no KYC is what sent people back to /kyc to search for a name they were
 * already looking at.
 *
 * ── IT READS. IT DOES NOT DECIDE ─────────────────────────────────────────────
 *
 * No approve or reject button. A host application has exactly one decision
 * path — the server call behind /kyc and /approvals — and adding a third
 * surface that writes `status` is how the two status fields drifted apart in
 * the first place. What this does instead is link to the queue that owns the
 * decision, carrying the context.
 *
 * ── AND IT NEVER INVENTS AN ABSENCE ──────────────────────────────────────────
 *
 * "No host application" and "the application could not be read" are different
 * facts about a person whose bank details are on the line, so they render
 * differently. A refused read says so.
 */

import { useCallback, useEffect, useState } from 'react'
import SecureDocuments from '@/components/SecureDocuments'
import Link from 'next/link'
import {
  AlertTriangle, ChevronRight, ExternalLink, FileText, ImageOff, Landmark,
  Loader2, ShieldCheck, ShieldQuestion,
} from 'lucide-react'
import { collection, getDocs, limit, query, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { failureReason } from '@/lib/readState'

interface Application {
  id: string
  agencyId: string
  agencyName: string
  hostName: string
  applicantPhone: string
  applicantEmail: string
  referralCode: string
  status: string
  kycStatus: string
  callRate: number
  dob: string
  country: string
  paymentType: string
  accountHolderName: string
  accountNumber: string
  ifscCode: string
  bankName: string
  upiId: string
  binanceUid: string
  kycDocUrls: string[]
  decidedByName: string
  decidedAt: unknown
  rejectionReason: string
}

const DOC_LABELS_IN = ['Aadhaar card', 'PAN card', 'Bank passbook']
const DOC_LABELS_FOREIGN = ['Passport', 'National ID', 'Proof of address']

function textOf(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function toneOf(status: string): string {
  switch (status) {
    case 'approved': return 'bg-green-500/10 text-green-400 border border-green-500/20'
    case 'rejected': return 'bg-red-500/10 text-red-400 border border-red-500/20'
    default: return 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20'
  }
}

export default function HostRecord({
  uid, isHost, isVerifiedHost,
}: {
  uid: string
  isHost: boolean
  isVerifiedHost: boolean
}) {
  const [app, setApp] = useState<Application | null>(null)
  const [failure, setFailure] = useState('')
  const [loading, setLoading] = useState(true)
  const [zoom, setZoom] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setFailure('')
    try {
      // Two fields tie an application to an account (UGP 2.4):
      //   * `activatedByUid` — written by `activateHost` when an agency's
      //     invitation code is redeemed;
      //   * `applicantUid`   — a SELF-application, filed from the app by the
      //     signed-in person, known from the moment it exists.
      // The server decides on either (`decide_host_application`), so this
      // reads both. An invitation nobody has redeemed has neither and is
      // correctly absent here; it lives on /kyc until somebody enters the code.
      const [byCode, bySelf] = await Promise.all([
        getDocs(query(collection(db, 'hostApplications'), where('activatedByUid', '==', uid), limit(5))),
        getDocs(query(collection(db, 'hostApplications'), where('applicantUid', '==', uid), limit(5))),
      ])
      const seen = new Map<string, (typeof byCode.docs)[number]>()
      for (const d of [...byCode.docs, ...bySelf.docs]) seen.set(d.id, d)
      if (seen.size === 0) { setApp(null); setLoading(false); return }
      // The most recent one wins if somebody has applied or been invited twice.
      const when = (raw: Record<string, unknown>): number => {
        for (const key of ['decidedAt', 'activatedAt', 'createdAt', 'submittedAt']) {
          const v = raw[key] as { toMillis?: () => number } | undefined
          if (v && typeof v.toMillis === 'function') return v.toMillis()
        }
        return 0
      }
      const doc = Array.from(seen.values()).sort(
        (a, b) => when(b.data() as Record<string, unknown>) - when(a.data() as Record<string, unknown>),
      )[0]
      const raw = doc.data() as Record<string, unknown>
      setApp({
        id: doc.id,
        agencyId: textOf(raw.agencyId),
        agencyName: textOf(raw.agencyName),
        hostName: textOf(raw.hostName),
        applicantPhone: textOf(raw.applicantPhone),
        applicantEmail: textOf(raw.applicantEmail),
        referralCode: textOf(raw.referralCode),
        status: textOf(raw.status) || 'pending',
        kycStatus: textOf(raw.kycStatus),
        callRate: Number(raw.callRate ?? 0),
        dob: textOf(raw.dob),
        country: textOf(raw.country),
        paymentType: textOf(raw.paymentType),
        accountHolderName: textOf(raw.accountHolderName),
        accountNumber: textOf(raw.accountNumber),
        ifscCode: textOf(raw.ifscCode),
        bankName: textOf(raw.bankName),
        upiId: textOf(raw.upiId),
        binanceUid: textOf(raw.binanceUid),
        kycDocUrls: Array.isArray(raw.kycDocUrls) ? (raw.kycDocUrls as unknown[]).map(textOf) : [],
        decidedByName: textOf(raw.decidedByName ?? raw.approvedByName),
        decidedAt: raw.decidedAt ?? raw.approvedAt ?? null,
        rejectionReason: textOf(raw.rejectionReason),
      })
    } catch (e) {
      setApp(null)
      setFailure(failureReason(e))
    }
    setLoading(false)
  }, [uid])

  useEffect(() => { load() }, [load])

  // Nothing to say about somebody who is not a host and never applied.
  if (!isHost && !app && !loading && !failure) return null

  const labels = app?.paymentType === 'foreign' ? DOC_LABELS_FOREIGN : DOC_LABELS_IN

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-xl p-5">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-white font-semibold flex items-center gap-2">
            <ShieldCheck size={17} className="text-pink-400" /> Host record &amp; KYC
          </h2>
          <p className="text-slate-500 text-xs mt-0.5">
            Read-only. The decision belongs to the approval queue, which is the
            only thing that writes it.
          </p>
        </div>
        <Link href="/kyc" className="flex items-center gap-1 text-pink-400 hover:text-pink-300 text-sm shrink-0">
          Open the review queue <ChevronRight size={13} />
        </Link>
      </div>

      {/* Verification is about the account and is shown whatever the
          application says — a host with no application on file can still have
          been granted by hand from the Actions panel above. */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className={`text-xs px-2 py-1 rounded ${isHost ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20' : 'bg-slate-800 text-slate-400'}`}>
          {isHost ? 'Host' : 'Not a host'}
        </span>
        <span className={`flex items-center gap-1 text-xs px-2 py-1 rounded ${
          isVerifiedHost
            ? 'bg-green-500/10 text-green-400 border border-green-500/20'
            : 'bg-yellow-500/10 text-yellow-300 border border-yellow-500/20'
        }`}>
          {isVerifiedHost ? <ShieldCheck size={11} /> : <ShieldQuestion size={11} />}
          {isVerifiedHost ? 'Face verified' : 'Face capture outstanding'}
        </span>
        {isHost && !isVerifiedHost && (
          <Link href="/hosts/verification" className="text-pink-400 hover:text-pink-300 text-xs">
            Verification queue
          </Link>
        )}
      </div>

      {isHost && !isVerifiedHost && (
        <p className="flex items-start gap-2 bg-yellow-500/5 border border-yellow-500/30 rounded-lg px-3 py-2 text-yellow-200 text-xs mb-4">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            Until the capture is done this host cannot go live, earns at the
            platform base rate rather than their own, and their weekly payout is
            held — it accrues and is released the week after they verify.
          </span>
        </p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-slate-500 text-sm py-4">
          <Loader2 size={14} className="animate-spin" /> Reading the application…
        </div>
      ) : failure ? (
        <div className="bg-yellow-500/5 border border-yellow-500/30 rounded-lg px-4 py-3">
          <p className="text-yellow-300 text-sm font-medium">
            The host application could not be read
          </p>
          <p className="text-slate-400 text-sm mt-1">{failure}</p>
          <p className="text-slate-500 text-xs mt-1">
            This is not a statement that there is no application on file.
          </p>
        </div>
      ) : !app ? (
        <p className="text-slate-500 text-sm">
          No host application is linked to this account.
          {isHost && ' Host status was granted directly rather than through an agency invitation, so there are no KYC documents to show.'}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <span className={`text-xs px-2 py-1 rounded ${toneOf(app.status)}`}>
              application {app.status}
            </span>
            {app.decidedByName && (
              <span className="text-slate-500 text-xs">decided by {app.decidedByName}</span>
            )}
            {app.rejectionReason && (
              <span className="text-red-300 text-xs">— {app.rejectionReason}</span>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
            <Fact label="Agency" value={app.agencyName || app.agencyId || '—'} />
            <Fact label="Referral code" value={app.referralCode || '—'} />
            <Fact label="Agreed rate" value={app.callRate ? `${app.callRate} beans/min` : '—'} />
            <Fact label="Country" value={app.country || '—'} />
            <Fact label="Phone on the invitation" value={app.applicantPhone || '—'} />
            <Fact label="Email on the invitation" value={app.applicantEmail || '—'} />
            <Fact label="Date of birth" value={app.dob || '—'} />
            <Fact label="Payment type" value={app.paymentType || '—'} />
          </div>

          {/* Where the money goes. Shown because a payout is a human reading
              these numbers off a record, and this is the record. */}
          <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 mb-4">
            <p className="flex items-center gap-1.5 text-slate-300 text-sm font-medium mb-3">
              <Landmark size={14} className="text-slate-500" /> Payout details
            </p>
            {app.paymentType === 'foreign' ? (
              <div className="grid grid-cols-2 gap-4">
                <Fact label="Binance UID" value={app.binanceUid || '—'} />
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                <Fact label="Account holder" value={app.accountHolderName || '—'} />
                <Fact label="Account number" value={app.accountNumber || '—'} />
                <Fact label="IFSC" value={app.ifscCode || '—'} />
                <Fact label="Bank" value={app.bankName || '—'} />
                <Fact label="UPI" value={app.upiId || '—'} />
              </div>
            )}
          </div>

          {/* Through the API behind short-lived signed URLs — see the note
              in components/SecureDocuments.tsx. `app.kycDocUrls` holds
              permanent bearer URLs and must not reach a browser. */}
          <p className="text-slate-400 text-sm font-medium mb-2">KYC documents</p>
          <SecureDocuments kind="host" recordId={app.id}
            emptyHint="No documents were uploaded with this application." />
        </>
      )}

      {zoom && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm"
          onClick={() => setZoom('')}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={zoom}
            alt="Document"
            onClick={(e) => e.stopPropagation()}
            className="max-h-[90vh] max-w-full object-contain rounded-lg"
          />
        </div>
      )}
    </section>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-slate-500 text-xs uppercase tracking-wide">{label}</p>
      <p className="text-slate-200 text-sm mt-0.5 break-words">{value}</p>
    </div>
  )
}

function DocThumb({ label, url, onZoom }: { label: string; url: string; onZoom: () => void }) {
  const [broken, setBroken] = useState(false)
  const isPdf = /\.pdf(\?|$)/i.test(url) || url.toLowerCase().includes('%2fpdf')

  if (isPdf || broken) {
    return (
      <div>
        <p className="text-slate-500 text-xs mb-1">{label}</p>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex flex-col items-center justify-center gap-1.5 h-24 bg-slate-950 border border-slate-700 hover:border-pink-500/40 rounded-lg text-slate-400 hover:text-pink-300 text-xs transition-colors"
        >
          {broken ? <ImageOff size={16} /> : <FileText size={16} />}
          {broken ? 'Could not load — open directly' : 'PDF'}
          <ExternalLink size={10} />
        </a>
      </div>
    )
  }

  return (
    <div>
      <p className="text-slate-500 text-xs mb-1">{label}</p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={label}
        onClick={onZoom}
        onError={() => setBroken(true)}
        className="w-full h-24 object-cover bg-slate-950 rounded-lg border border-slate-700 hover:border-pink-500/50 cursor-zoom-in transition-colors"
      />
    </div>
  )
}
