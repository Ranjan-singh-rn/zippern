'use client'

/**
 * A link to one document, behind a short-lived signed URL.
 *
 * `SecureDocuments` renders a whole record as thumbnails and `useSecureThumbs`
 * does a page of them. This is the third shape: a single "open it" link
 * somewhere in a sentence, which is how the coin-purchase review screens show
 * a seller's payment proof.
 *
 * ── WHY THE URL IS FETCHED RATHER THAN HELD ──────────────────────────────────
 *
 * Those screens rendered `request.paymentProofUrl` directly. That field is the
 * `getDownloadURL()` result stored when the seller uploaded their bank
 * screenshot from the Android app, and it is a permanent bearer credential:
 * Storage Rules are not consulted for a download URL, so the string in that
 * href opens the image for anybody who ever sees it, indefinitely. It is
 * financial evidence about a named person's bank transfer.
 *
 * An `href` cannot be resolved lazily on click without intercepting the
 * click, so the signed URL is fetched when the panel mounts — these are
 * single-record views, one request each, not list rows.
 *
 * ── FAILURE IS VISIBLE, NOT SILENT ───────────────────────────────────────────
 *
 * If the fetch fails or the caller is not entitled, the link does not render
 * as a dead anchor: it says so. A reviewer about to approve money against
 * evidence they could not open needs to know that is what happened — which is
 * the same reason `verification._sign` returns a sentence rather than a null.
 */

import { useEffect, useState } from 'react'
import { AlertTriangle, ExternalLink, Loader2 } from 'lucide-react'
import api, { ApiError, type DocumentKind } from '@/lib/api'

export default function SecureDocLink({
  kind,
  recordId,
  slot,
  label,
  className = 'inline-flex items-center gap-1 text-pink-400 hover:text-pink-300 text-xs',
}: {
  kind: DocumentKind
  recordId: string
  /** Which document on the record — `proof`, `photo`, `doc1`… */
  slot: string
  label: string
  className?: string
}) {
  const [url, setUrl] = useState('')
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(true)

  useEffect(() => {
    if (!recordId) { setBusy(false); return }
    let cancelled = false
    setBusy(true)
    setProblem('')

    api.documents
      .forRecord(kind, recordId)
      .then((res) => {
        if (cancelled) return
        const hit = res.documents.find((d) => d.slot === slot)
        if (hit?.url) setUrl(hit.url)
        else setProblem(hit?.error || 'This document could not be opened.')
      })
      .catch((err) => {
        if (cancelled) return
        setProblem(
          err instanceof ApiError ? err.message : 'This document could not be opened.',
        )
      })
      .finally(() => { if (!cancelled) setBusy(false) })

    return () => { cancelled = true }
  }, [kind, recordId, slot])

  if (busy) {
    return (
      <span className="inline-flex items-center gap-1 text-slate-500 text-xs">
        <Loader2 size={10} className="animate-spin" /> {label}…
      </span>
    )
  }

  if (!url) {
    return (
      <span className="inline-flex items-center gap-1 text-amber-300/90 text-xs">
        <AlertTriangle size={10} /> {problem || `${label} unavailable`}
      </span>
    )
  }

  return (
    <a href={url} target="_blank" rel="noreferrer" className={className}>
      <ExternalLink size={10} /> {label}
    </a>
  )
}
