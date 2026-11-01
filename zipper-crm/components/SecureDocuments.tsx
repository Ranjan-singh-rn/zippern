'use client'

/**
 * KYC and identity documents, fetched behind short-lived signed URLs.
 *
 * ── WHAT THIS REPLACES ───────────────────────────────────────────────────────
 *
 * Every review screen used to render `app.kycDocUrls` directly:
 *
 *     <img src={url} />          // url = ".../o/<obj>?alt=media&token=<uuid>"
 *
 * That URL is a permanent bearer credential. Storage Security Rules are never
 * consulted for one, so anybody who ends up holding the string reads somebody's
 * Aadhaar — forever, unauthenticated, from anywhere. It survives in browser
 * history, in a forwarded email, in a screenshot, and in the Firestore document
 * it was copied into. Tightening `storage.rules` did nothing about it, because
 * a download URL does not take the SDK path.
 *
 * This asks the API instead. The API authorises the caller against the partner
 * record and mints a fifteen-minute v4 signed URL per document. The permanent
 * string stays server-side.
 *
 * ── FETCHED ON MOUNT, NOT CACHED ─────────────────────────────────────────────
 *
 * Deliberately no cache and no lifting into a parent store. The URLs expire,
 * so a cached set is a set of dead images, and the reviewer would see broken
 * boxes with no explanation. Opening the record fetches; closing it discards.
 * That is also the privacy property worth having: the links exist for as long
 * as somebody is actually looking at the record.
 *
 * ── ONE UNREADABLE FILE DOES NOT BLANK THE PAGE ──────────────────────────────
 *
 * Each entry is either a URL or `null` with a sentence. A document the agency
 * never uploaded and a signing credential that cannot sign are different
 * problems with opposite responses — one is a finding about the applicant, the
 * other is an outage affecting every record — and they used to render as the
 * same grey box. Same reasoning as `verification._sign`.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, ExternalLink, FileText, Loader2, RefreshCw } from 'lucide-react'
import api, { ApiError, type DocumentKind, type SignedDocument } from '@/lib/api'

function looksLikePdf(doc: SignedDocument): boolean {
  const u = (doc.url ?? '').toLowerCase()
  return u.includes('.pdf') || u.includes('%2fpdf') || /pdf/.test(doc.label.toLowerCase())
}

function One({ doc }: { doc: SignedDocument }) {
  if (!doc.url) {
    return (
      <div className="space-y-1">
        <p className="text-slate-400 text-xs font-medium">{doc.label}</p>
        <p className="flex items-start gap-1.5 bg-amber-500/5 border border-amber-500/30 rounded-lg px-2.5 py-2 text-amber-200/90 text-xs">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          {doc.error || 'This document could not be opened.'}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <p className="text-slate-400 text-xs font-medium">{doc.label}</p>
      {looksLikePdf(doc) ? (
        <a
          href={doc.url} target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-2 text-pink-400 hover:text-pink-300 text-sm underline"
        >
          <ExternalLink size={13} /> Open PDF
        </a>
      ) : (
        <a href={doc.url} target="_blank" rel="noopener noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={doc.url}
            alt={doc.label}
            className="max-h-40 rounded-lg border border-slate-700 object-contain bg-slate-950 hover:opacity-90 transition-opacity"
          />
        </a>
      )}
    </div>
  )
}

export default function SecureDocuments({
  kind,
  recordId,
  emptyHint = 'No documents were submitted with this application.',
}: {
  kind: DocumentKind
  recordId: string
  emptyHint?: string
}) {
  const [docs, setDocs] = useState<SignedDocument[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)

  const load = useCallback(async () => {
    if (!recordId) { setBusy(false); setDocs([]); return }
    setBusy(true)
    setError('')
    try {
      setDocs((await api.documents.forRecord(kind, recordId)).documents)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'The documents could not be loaded.',
      )
    } finally {
      setBusy(false)
    }
  }, [kind, recordId])

  useEffect(() => { load() }, [load])

  if (busy) {
    return (
      <p className="flex items-center gap-2 text-slate-500 text-sm">
        <Loader2 size={13} className="animate-spin" /> Opening documents…
      </p>
    )
  }

  if (error) {
    return (
      <div className="flex items-start justify-between gap-3 bg-red-500/5 border border-red-500/30 rounded-lg px-3 py-2">
        <p className="flex items-start gap-2 text-red-300 text-sm">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
        </p>
        <button
          onClick={load}
          className="flex items-center gap-1 text-slate-400 hover:text-white text-xs shrink-0"
        >
          <RefreshCw size={12} /> Retry
        </button>
      </div>
    )
  }

  if (!docs || docs.length === 0) {
    return (
      <p className="flex items-center gap-2 text-slate-500 text-sm">
        <FileText size={13} /> {emptyHint}
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {docs.map((d, i) => <One key={`${d.label}-${i}`} doc={d} />)}
      </div>
      {/* Said out loud, because a reviewer who leaves the tab open and comes
          back to broken images should know why rather than report a bug. */}
      <p className="text-slate-600 text-xs">
        These links expire after 15 minutes.{' '}
        <button onClick={load} className="text-slate-400 hover:text-white underline">
          Refresh them
        </button>
        .
      </p>
    </div>
  )
}
