'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import {
  getApproval, approveRequest, rejectRequest,
  type ApprovalRequest,
} from '@/lib/approvals'
import { db } from '@/lib/firebase'
import { doc, getDoc } from 'firebase/firestore'
import {
  ArrowLeft, CheckCircle, XCircle, Clock,
  Loader2, AlertTriangle, ExternalLink,
} from 'lucide-react'

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">{label}</h3>
      {children}
    </div>
  )
}

function Row({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex gap-4">
      <span className="text-slate-400 text-sm w-40 flex-shrink-0">{label}</span>
      <span className="text-white text-sm font-medium break-all">{value ?? '—'}</span>
    </div>
  )
}

function timeStr(ts: { seconds: number } | null | undefined) {
  if (!ts) return '—'
  return new Date(ts.seconds * 1000).toLocaleString('en-IN', {
    dateStyle: 'medium', timeStyle: 'short',
  })
}

const STATUS_STYLES: Record<string, string> = {
  pending:  'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20',
  approved: 'bg-green-500/10  text-green-400  border border-green-500/20',
  rejected: 'bg-red-500/10   text-red-400    border border-red-500/20',
}

// ── Host Application Detail ──────────────────────────────────────────────────

function DocImage({ url, label }: { url: string; label: string }) {
  const isPdf = url.toLowerCase().includes('.pdf') || url.toLowerCase().includes('%2Fpdf')
  return (
    <div className="space-y-1">
      <p className="text-slate-400 text-xs font-medium">{label}</p>
      {isPdf ? (
        <a href={url} target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-2 text-pink-400 hover:text-pink-300 text-sm underline">
          <ExternalLink size={13} /> Open PDF
        </a>
      ) : (
        <a href={url} target="_blank" rel="noopener noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={label} className="max-h-40 rounded-lg border border-slate-700 object-contain bg-slate-950 hover:opacity-90 transition-opacity" />
        </a>
      )}
    </div>
  )
}

function HostApplicationDetail({ app }: { app: Record<string, unknown> }) {
  const paymentType = app.paymentType as string

  return (
    <div className="space-y-6">
      {/* Identity */}
      <Section label="Host Identity">
        <div className="flex items-start gap-5">
          {!!app.photoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={app.photoUrl as string} alt="Host photo"
              className="w-20 h-20 rounded-xl object-cover border border-slate-700 shrink-0" />
          )}
          <div className="space-y-2 flex-1">
            <Row label="Full Name"    value={app.hostName as string} />
            <Row label="Phone"        value={app.applicantPhone as string} />
            <Row label="Email"        value={app.applicantEmail as string} />
            <Row label="Age"          value={app.age ? String(app.age) : undefined} />
            <Row label="Date of Birth" value={app.dob as string} />
            <Row label="Country"      value={app.country as string} />
            <Row label="CRM UID"      value={app.crmUid as string} />
          </div>
        </div>
      </Section>

      {/* Agency + Call Rate */}
      <Section label="Agency & Call Rate">
        <Row label="Agency"     value={app.agencyName as string} />
        <Row label="Agency ID"  value={app.agencyId as string} />
        <Row label="Call Rate"  value={app.callRate ? `${app.callRate} beans/min` : undefined} />
        <Row label="Referral Code" value={app.referralCode as string} />
      </Section>

      {/* Payment Details */}
      <Section label="Payment Details">
        <Row label="Payment Type" value={paymentType === 'foreign' ? 'International (Binance)' : 'India (Bank Transfer)'} />
        {paymentType === 'foreign' ? (
          <Row label="Binance UID" value={app.binanceUid as string} />
        ) : (
          <>
            <Row label="Account Holder" value={app.accountHolderName as string} />
            <Row label="Account Number" value={app.accountNumber as string} />
            <Row label="IFSC Code"      value={app.ifscCode as string} />
            <Row label="Bank Name"      value={app.bankName as string} />
            {app.branch  && <Row label="Branch" value={app.branch as string} />}
            {app.upiId   && <Row label="UPI ID" value={app.upiId as string} />}
          </>
        )}
      </Section>

      {/* KYC Documents */}
      {Array.isArray(app.kycDocUrls) && (app.kycDocUrls as string[]).length > 0 && (
        <Section label="KYC Documents">
          <p className="text-slate-400 text-xs mb-1">
            KYC Status: <span className={`font-semibold ${app.kycStatus === 'approved' ? 'text-green-400' : 'text-yellow-400'}`}>
              {app.kycStatus as string ?? 'submitted'}
            </span>
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
            {(app.kycDocUrls as string[]).map((url, i) => (
              <DocImage key={i} url={url} label={
                paymentType === 'foreign'
                  ? ['Passport', 'National ID', 'Proof of Address'][i]
                  : ['Aadhaar Card', 'PAN Card', 'Bank Passbook'][i]
              } />
            ))}
          </div>
        </Section>
      )}
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function ApprovalDetailClient({ id: paramId }: { id: string }) {
  const { crmUser } = useAuth()
  const router = useRouter()
  // Static export uses '_' as shell param; read real ID from browser URL at runtime
  const id = (typeof window !== 'undefined'
    ? window.location.pathname.split('/').filter(Boolean)[1] ?? paramId
    : paramId) || paramId

  const [req, setReq]           = useState<ApprovalRequest | null>(null)
  const [hostApp, setHostApp]   = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading]   = useState(true)
  const [notes, setNotes]       = useState('')
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | null>(null)
  const [error, setError]       = useState('')

  const isSuperAdmin = crmUser?.role === 'superadmin'

  useEffect(() => {
    if (!crmUser || !canAccess(crmUser, ['superadmin'])) return
    getApproval(id).then(async r => {
      setReq(r)
      // If this is an add_host approval, fetch the hostApplication doc
      if (r?.type === 'add_host' && r.targetCollection === 'hostApplications' && r.targetDocId) {
        try {
          const snap = await getDoc(doc(db, 'hostApplications', r.targetDocId))
          if (snap.exists()) setHostApp(snap.data() as Record<string, unknown>)
        } catch { /* non-blocking */ }
      }
      setLoading(false)
    })
  }, [id, crmUser])

  if (!crmUser || !canAccess(crmUser, ['superadmin'])) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <p className="text-slate-400">Access denied.</p>
      </div>
    )
  }

  async function handleApprove() {
    if (!crmUser || !req) return
    setSubmitting('approve')
    setError('')
    try {
      await approveRequest(id, { uid: crmUser.uid, name: crmUser.name }, notes)
      setReq(r => r ? { ...r, status: 'approved' } : r)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to approve')
    } finally {
      setSubmitting(null)
    }
  }

  async function handleReject() {
    if (!crmUser || !req) return
    if (!notes.trim()) { setError('Please add a reason for rejection.'); return }
    setSubmitting('reject')
    setError('')
    try {
      await rejectRequest(id, { uid: crmUser.uid, name: crmUser.name }, notes)
      setReq(r => r ? { ...r, status: 'rejected' } : r)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to reject')
    } finally {
      setSubmitting(null)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="w-8 h-8 border-2 border-pink-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!req) {
    return (
      <div className="text-center py-20 text-slate-400">
        Approval request not found.
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.push('/approvals')}
          className="text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-xl font-bold text-white flex-1 truncate">{req.description}</h1>
        <span className={`text-xs font-medium px-3 py-1 rounded-full ${STATUS_STYLES[req.status]}`}>
          {req.status}
        </span>
      </div>

      {/* Details */}
      <Section label="Request Details">
        <Row label="Type"           value={req.type.replace(/_/g, ' ')} />
        <Row label="Target"         value={req.targetLabel} />
        <Row label="Requested by"   value={`${req.requestedBy.name} (${req.requestedBy.role})`} />
        <Row label="Requested at"   value={timeStr(req.requestedAt as unknown as { seconds: number })} />
      </Section>

      {/* Host application detail — shown for add_host approvals */}
      {req.type === 'add_host' && hostApp && (
        <HostApplicationDetail app={hostApp} />
      )}

      {/*
        Approving an `add_host` request no longer does anything to the host
        application, and the Approve button below is disabled for it.

        This request used to write `status: 'approved'` onto the application and
        nothing else — never `kycStatus`, which is the other half of the same
        decision, and never a reason or a decider. Two other screens wrote the
        other half, so the two fields drifted and no screen agreed with any other
        about whether the host had been approved. The decision has one writer
        now and it is on /kyc, which shows the documents, requires a reason,
        writes both fields together and grants the host account in the same call.

        Saying so here rather than only in the Cloud Function's refusal, because
        a superadmin pressing Approve and watching the request flip to 'rejected'
        learns the wrong thing from it.
      */}
      {req.type === 'add_host' && req.status === 'pending' && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-5 flex gap-3">
          <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
          <div className="text-sm text-amber-200/90 leading-relaxed">
            <p className="font-medium text-amber-200">
              Host applications are decided on the KYC review queue, not here.
            </p>
            <p className="mt-1">
              Approving from this queue wrote only one of the application&apos;s two
              status fields, with no reason and nobody named, so an application
              could be approved here and still read as pending everywhere else.
              Decide it on{' '}
              <a href="/kyc" className="underline hover:text-amber-100">/kyc → Hosts</a>,
              which shows the documents, requires a reason, writes both fields
              together and grants the host account in the same call.
            </p>
            <p className="mt-1">
              <span className="font-medium">The invitation is unaffected.</span>{' '}
              The application is already in that queue and the referral code
              still works. Rejecting here closes this request and nothing else.
            </p>
          </div>
        </div>
      )}

      {/* For non-host approvals, show the raw payload */}
      {req.type !== 'add_host' && (
        <Section label="Change Payload">
          <pre className="text-xs text-slate-300 bg-slate-950 rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-all">
            {JSON.stringify(req.payload, null, 2)}
          </pre>
        </Section>
      )}

      {/* Review info (if already reviewed) */}
      {req.status !== 'pending' && (
        <Section label="Review">
          <Row label="Reviewed by"  value={req.reviewedBy?.name ?? '—'} />
          <Row label="Reviewed at"  value={timeStr(req.reviewedAt as unknown as { seconds: number })} />
          {req.reviewNotes && (
            <div>
              <span className="text-slate-400 text-sm block mb-1">Notes</span>
              <p className="text-white text-sm bg-slate-800 rounded-lg p-3">{req.reviewNotes}</p>
            </div>
          )}
          {req.appliedAt && (
            <Row label="Applied at" value={timeStr(req.appliedAt as unknown as { seconds: number })} />
          )}
        </Section>
      )}

      {/* Actions — only superadmin, only pending */}
      {isSuperAdmin && req.status === 'pending' && (
        <Section label="Review Action">
          <div>
            <label className="text-sm text-slate-400 block mb-2">
              Notes {req.status === 'pending' ? '(required for rejection)' : ''}
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Add notes or reason..."
              rows={3}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-pink-500 resize-none"
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 text-red-400 text-sm">
              <AlertTriangle size={14} />
              {error}
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={handleApprove}
              // Disabled for `add_host`: the server refuses it and would flip
              // this request to 'rejected' with the reason attached, which is
              // an honest outcome but a misleading thing to watch happen. The
              // banner above says where the decision lives.
              disabled={!!submitting || req.type === 'add_host'}
              title={
                req.type === 'add_host'
                  ? 'Host applications are decided on /kyc → Hosts.'
                  : undefined
              }
              className="flex items-center gap-2 px-5 py-2.5 bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-medium text-sm transition-colors"
            >
              {submitting === 'approve'
                ? <Loader2 size={15} className="animate-spin" />
                : <CheckCircle size={15} />}
              Approve
            </button>
            <button
              onClick={handleReject}
              disabled={!!submitting}
              className="flex items-center gap-2 px-5 py-2.5 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-lg font-medium text-sm transition-colors"
            >
              {submitting === 'reject'
                ? <Loader2 size={15} className="animate-spin" />
                : <XCircle size={15} />}
              Reject
            </button>
          </div>
        </Section>
      )}
    </div>
  )
}
