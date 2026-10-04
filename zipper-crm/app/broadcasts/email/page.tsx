'use client'

/**
 * The email composer — spec 8A.7.2, `backend/app/routers/broadcasts.py`.
 *
 * The sibling page at `/broadcasts` sends an **in-app announcement**: a
 * Firestore document the Android app reads. This one sends **email**, through
 * the same delivery layer as every payout receipt and every scheduled report,
 * so a broadcast appears in `/tech/email` beside them and a bounce is handled
 * the same way. They are two different things that both mean "tell everybody",
 * and neither replaces the other.
 *
 * Four things on this screen are safety features rather than conveniences, and
 * each is here because of a specific way a mass email goes wrong:
 *
 *   * **The audience count is loaded before the send, live.** Sending to every
 *     app user cannot be undone, and the number is the last thing that can
 *     catch the wrong audience. It arrives with a sample, because a count on
 *     its own does not tell you whether it is the right four thousand people.
 *
 *   * **A large audience must have its exact number typed back.** Not a dialog
 *     with an OK button — those are dismissed by muscle memory, and a
 *     `window.confirm` cannot even be styled to say the number properly. The
 *     server enforces the same check independently (`confirm_recipients`), so
 *     this box is the honest half of a control rather than the whole of it.
 *
 *   * **The draft survives everything.** Every keystroke goes to localStorage.
 *     Losing a long message to a misclick, a refresh or an expired session is
 *     its own bug, and one people only find out about the hard way.
 *
 *   * **Refusals are shown exactly as the API wrote them.** Every one of them
 *     is a sentence a person can act on — "the audience resolves to 4,182 and
 *     the request confirmed 3,900" — and paraphrasing it into "Request failed"
 *     throws away the only thing that makes it actionable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowLeft, CheckCircle2, Eye, FileWarning, Loader2, Mail,
  Megaphone, Paperclip, RefreshCw, Send, Trash2, Users, X,
} from 'lucide-react'

import { useAuth } from '@/components/AuthProvider'
import { ApiError } from '@/lib/api'
import { Denied, ErrorState, Loading } from '@/components/ui/States'
import {
  AttachmentIn, AudienceCatalogue, AudienceOption, AudiencePreview,
  BroadcastResult, SenderIdentity, broadcasts, formatBytes, readAsAttachment,
} from '@/lib/broadcasts'

// ── The draft ─────────────────────────────────────────────────────────────────

const DRAFT_KEY = 'zipperBroadcastEmailDraft'

interface Draft {
  audience: string
  personEmail: string
  subject: string
  body: string
  reason: string
  identity: SenderIdentity | ''
}

const EMPTY_DRAFT: Draft = {
  audience: '',
  personEmail: '',
  subject: '',
  body: '',
  reason: '',
  identity: '',
}

function readDraft(): Draft {
  if (typeof window === 'undefined') return EMPTY_DRAFT
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY)
    if (!raw) return EMPTY_DRAFT
    const parsed = JSON.parse(raw) as Partial<Draft>
    return {
      audience: String(parsed.audience ?? ''),
      personEmail: String(parsed.personEmail ?? ''),
      subject: String(parsed.subject ?? ''),
      body: String(parsed.body ?? ''),
      reason: String(parsed.reason ?? ''),
      identity: (parsed.identity ?? '') as SenderIdentity | '',
    }
  } catch {
    // A corrupt or unreadable draft is an empty one. It is never a reason to
    // put an error on the screen: the person came here to write something.
    return EMPTY_DRAFT
  }
}

function writeDraft(draft: Draft): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  } catch {
    /* private browsing, or storage full. The composer still works. */
  }
}

function clearDraft(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(DRAFT_KEY)
  } catch {
    /* nothing to clear */
  }
}

// ── Small pieces ──────────────────────────────────────────────────────────────

type Slot<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; value: T }
  | { status: 'error'; message: string }

/** An `ApiError`'s own words, or a sentence saying we do not have any. */
function reasonFrom(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error && err.message) return err.message
  return fallback
}

function Field({
  label, hint, children, right,
}: {
  label: string
  hint?: string
  right?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-1.5">
        <label className="block text-slate-400 text-xs font-semibold uppercase tracking-wide">
          {label}
        </label>
        {right}
      </div>
      {children}
      {hint && <p className="text-slate-600 text-xs mt-1.5 leading-relaxed">{hint}</p>}
    </div>
  )
}

const INPUT =
  'w-full bg-slate-900 border border-slate-700 text-white rounded-lg px-3.5 py-2.5 ' +
  'text-sm focus:outline-none focus:border-pink-500 transition placeholder:text-slate-600'

function Banner({
  tone, title, children, onDismiss,
}: {
  tone: 'error' | 'warn' | 'ok'
  title: string
  children?: React.ReactNode
  onDismiss?: () => void
}) {
  const skin = {
    error: 'bg-red-500/10 border-red-500/30 text-red-300',
    warn: 'bg-amber-500/10 border-amber-500/30 text-amber-200',
    ok: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300',
  }[tone]
  const Icon = tone === 'ok' ? CheckCircle2 : AlertTriangle
  return (
    <div className={`border rounded-xl px-4 py-3 text-sm ${skin}`}>
      <div className="flex items-start gap-2.5">
        <Icon size={16} className="shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{title}</p>
          {children && <div className="mt-1 leading-relaxed">{children}</div>}
        </div>
        {onDismiss && (
          <button onClick={onDismiss} className="shrink-0 opacity-60 hover:opacity-100">
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  )
}

// ── The audience panel ────────────────────────────────────────────────────────

function AudiencePanel({
  slot, onRefresh,
}: {
  slot: Slot<AudiencePreview>
  onRefresh: () => void
}) {
  if (slot.status === 'idle') {
    return (
      <p className="text-slate-600 text-sm">
        Pick an audience above and its size will be counted here, before
        anything is sent.
      </p>
    )
  }
  if (slot.status === 'loading') {
    return (
      <div className="flex items-center gap-2 text-slate-500 text-sm py-2">
        <Loader2 size={14} className="animate-spin" /> Counting the audience…
      </div>
    )
  }
  if (slot.status === 'error') {
    return (
      <Banner tone="error" title="This audience could not be resolved">
        <p>{slot.message}</p>
        <button
          onClick={onRefresh}
          className="mt-2 inline-flex items-center gap-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded px-2.5 py-1.5"
        >
          <RefreshCw size={12} /> Try again
        </button>
      </Banner>
    )
  }

  const p = slot.value
  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="text-3xl font-bold text-white tabular-nums">
          {p.count.toLocaleString('en-IN')}
        </span>
        <span className="text-slate-400 text-sm">
          {p.count === 1 ? 'recipient' : 'recipients'} — {p.label}
        </span>
        <button
          onClick={onRefresh}
          className="ml-auto text-slate-500 hover:text-slate-300"
          title="Count it again"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <p className="text-slate-600 text-xs leading-relaxed">{p.source}</p>

      {p.unsubscribed_count > 0 && (
        <p className="text-slate-400 text-xs">
          <strong className="text-slate-300">
            {p.unsubscribed_count.toLocaleString('en-IN')}
          </strong>{' '}
          address{p.unsubscribed_count === 1 ? '' : 'es'} in this audience{' '}
          {p.unsubscribed_count === 1 ? 'has' : 'have'} unsubscribed and{' '}
          {p.unsubscribed_count === 1 ? 'is' : 'are'} already excluded from the
          number above.
        </p>
      )}

      {p.no_address_count > 0 && (
        <Banner
          tone="warn"
          title={`${p.no_address_count} in this audience has no email address on record`}
        >
          <ul className="mt-1 space-y-0.5">
            {p.no_address.slice(0, 5).map((g) => (
              <li key={g.id} className="text-xs">
                <span className="text-amber-100">{g.name}</span>{' '}
                <span className="opacity-70">— {g.reason}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs mt-1.5 opacity-80">
            They are still sent to, so each leaves a <code>no_address</code> row
            in the delivery log naming them. That is a gap in the record, not a
            send that quietly did not happen.
          </p>
        </Banner>
      )}

      {p.excluded.length > 0 && (
        <p className="text-slate-500 text-xs leading-relaxed">
          Left out:{' '}
          {p.excluded.map((e, i) => (
            <span key={e.reason}>
              {i > 0 && '; '}
              <strong className="text-slate-400">{e.count}</strong> {e.reason}
            </span>
          ))}
          .
        </p>
      )}

      {p.count > 0 && (
        <div>
          <p className="text-slate-500 text-xs mb-1.5">
            {p.sample_is_all
              ? 'The whole audience:'
              : `The first ${p.sample.length} of ${p.count.toLocaleString('en-IN')}:`}
          </p>
          <div className="border border-slate-800 rounded-lg divide-y divide-slate-800 max-h-56 overflow-y-auto">
            {p.sample.map((m) => (
              <div
                key={`${m.uid ?? ''}:${m.email}`}
                className="px-3 py-1.5 flex items-baseline justify-between gap-3"
              >
                <span className="text-slate-300 text-xs break-all">{m.email}</span>
                <span className="text-slate-600 text-xs shrink-0">
                  {m.name || m.uid} {m.role ? `· ${m.role}` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-slate-600 text-xs leading-relaxed">{p.note}</p>
    </div>
  )
}

// ── The result ────────────────────────────────────────────────────────────────

function ResultPanel({ result, onDismiss }: { result: BroadcastResult; onDismiss: () => void }) {
  const clean = result.failed === 0 && !result.stopped_early && result.not_attempted.length === 0
  return (
    <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-white font-semibold flex items-center gap-2">
            {clean ? (
              <CheckCircle2 size={18} className="text-emerald-400" />
            ) : (
              <AlertTriangle size={18} className="text-amber-400" />
            )}
            Sent to {result.audience_label}
          </h2>
          <p className="text-slate-500 text-xs mt-1 font-mono">{result.broadcast_id}</p>
        </div>
        <button onClick={onDismiss} className="text-slate-500 hover:text-white shrink-0">
          <X size={16} />
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Recipients', value: result.recipients, tone: 'text-white' },
          { label: 'Accepted', value: result.accepted, tone: 'text-emerald-300' },
          { label: 'Failed', value: result.failed, tone: result.failed ? 'text-red-300' : 'text-slate-400' },
          {
            label: 'Skipped (opted out)',
            value: result.unsubscribed_skipped,
            tone: 'text-slate-400',
          },
        ].map((tile) => (
          <div key={tile.label} className="bg-slate-900/60 rounded-lg px-3 py-2.5">
            <p className={`text-xl font-bold tabular-nums ${tile.tone}`}>
              {tile.value.toLocaleString('en-IN')}
            </p>
            <p className="text-slate-500 text-xs mt-0.5">{tile.label}</p>
          </div>
        ))}
      </div>

      {result.stopped_early && (
        <Banner tone="warn" title="The send stopped before it finished">
          <p>{result.stop_reason}</p>
        </Banner>
      )}

      {result.not_attempted.length > 0 && (
        <Banner
          tone="warn"
          title={`${result.not_attempted.length} address(es) were never attempted`}
        >
          <p className="text-xs opacity-90 break-all">
            {result.not_attempted.slice(0, 20).join(', ')}
            {result.not_attempted.length > 20 && ` … and ${result.not_attempted.length - 20} more`}
          </p>
        </Banner>
      )}

      {result.attachments_note && (
        <Banner tone="warn" title="Some files were not attached">
          <p className="text-xs">{result.attachments_note}</p>
        </Banner>
      )}

      {result.sender_identity_note && (
        <Banner tone="warn" title={`Sent from the ${result.sender_identity} address`}>
          <p className="text-xs">{result.sender_identity_note}</p>
        </Banner>
      )}

      {result.warnings.length > 0 && (
        <Banner tone="warn" title="For next time">
          <ul className="list-disc pl-4 space-y-0.5 text-xs">
            {result.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Banner>
      )}

      <p className="text-slate-500 text-xs leading-relaxed">{result.note}</p>

      <Link
        href={result.delivery_log}
        className="inline-flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg px-4 py-2 text-sm font-medium transition"
      >
        <Mail size={14} />
        Open the delivery log for this send
      </Link>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BroadcastEmailPage() {
  const { apiUser, apiReady, loading: authLoading } = useAuth()

  const [catalogue, setCatalogue] = useState<Slot<AudienceCatalogue>>({ status: 'loading' })
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [draftLoaded, setDraftLoaded] = useState(false)
  const [draftRestored, setDraftRestored] = useState(false)

  const [files, setFiles] = useState<File[]>([])
  const fileInput = useRef<HTMLInputElement | null>(null)

  const [audienceSlot, setAudienceSlot] = useState<Slot<AudiencePreview>>({ status: 'idle' })
  const [confirmTyped, setConfirmTyped] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const [result, setResult] = useState<BroadcastResult | null>(null)

  // ── The draft, restored once and saved on every change ──────────────────
  useEffect(() => {
    const restored = readDraft()
    setDraft(restored)
    setDraftLoaded(true)
    setDraftRestored(Boolean(restored.subject || restored.body || restored.reason))
  }, [])

  useEffect(() => {
    if (!draftLoaded) return
    writeDraft(draft)
  }, [draft, draftLoaded])

  const set = useCallback(<K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }))
    // Any edit invalidates a typed confirmation. The number was confirmed for
    // one message to one audience, not for whatever it has become since.
    setConfirmTyped('')
    setSendError('')
  }, [])

  // ── The catalogue ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!apiReady) return
    let live = true
    setCatalogue({ status: 'loading' })
    broadcasts
      .catalogue()
      .then((value) => live && setCatalogue({ status: 'ok', value }))
      .catch((err: unknown) =>
        live &&
        setCatalogue({
          status: 'error',
          message: reasonFrom(err, 'The list of audiences could not be read.'),
        }),
      )
    return () => {
      live = false
    }
  }, [apiReady])

  const options: AudienceOption[] = catalogue.status === 'ok' ? catalogue.value.audiences : []
  const limits = catalogue.status === 'ok' ? catalogue.value.limits : null
  const senders = catalogue.status === 'ok' ? catalogue.value.sender_identities : []

  const chosen = useMemo(
    () => options.find((o) => o.audience === draft.audience) ?? null,
    [options, draft.audience],
  )

  /** The audience string the API takes: a name, or `person:<address>`. */
  const audienceSpec = useMemo(() => {
    if (!draft.audience) return ''
    if (draft.audience !== 'person') return draft.audience
    const address = draft.personEmail.trim().toLowerCase()
    return address.includes('@') ? `person:${address}` : ''
  }, [draft.audience, draft.personEmail])

  // ── The count, loaded live ──────────────────────────────────────────────
  const loadAudience = useCallback(() => {
    if (!apiReady || !audienceSpec) {
      setAudienceSlot({ status: 'idle' })
      return
    }
    if (chosen && !chosen.may_send) {
      // No point counting an audience this account is not allowed to reach —
      // and the preview route refuses it for the same reason the send would.
      setAudienceSlot({ status: 'error', message: chosen.refusal })
      return
    }
    setAudienceSlot({ status: 'loading' })
    setConfirmTyped('')
    broadcasts
      .preview(audienceSpec)
      .then((value) => setAudienceSlot({ status: 'ok', value }))
      .catch((err: unknown) =>
        setAudienceSlot({
          status: 'error',
          message: reasonFrom(err, 'This audience could not be resolved.'),
        }),
      )
  }, [apiReady, audienceSpec, chosen])

  useEffect(() => {
    // Debounced, because the person audience is a text field and every
    // keystroke would otherwise stream half-typed addresses at the API.
    const timer = window.setTimeout(loadAudience, 400)
    return () => window.clearTimeout(timer)
  }, [loadAudience])

  const preview = audienceSlot.status === 'ok' ? audienceSlot.value : null

  // ── Attachments ─────────────────────────────────────────────────────────
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
  const overTotal = limits !== null && totalBytes > limits.max_total_attachment_bytes
  const oversized = limits === null ? [] : files.filter((f) => f.size > limits.max_attachment_bytes)

  const addFiles = useCallback((picked: FileList | null) => {
    if (!picked || picked.length === 0) return

    // Copy the FileList into a real array BEFORE the input is cleared.
    //
    // `picked` is `e.target.files` — a *live* FileList that is a view onto the
    // input element, not a snapshot of it. Clearing `input.value` empties it in
    // place.
    //
    // The previous order was `setFiles(prev => [...prev, ...Array.from(picked)])`
    // and then `input.value = ''`. That reads correctly and cannot work: a React
    // updater is deferred, so the input was cleared first and `Array.from` ran
    // afterwards against a FileList that was by then empty. Every attachment
    // picked here was silently dropped — the file dialog opened, a file was
    // chosen, and nothing appeared in the list.
    //
    // Materialise first, clear second, queue the update last.
    const chosen = Array.from(picked)
    if (fileInput.current) fileInput.current.value = ''

    setFiles((existing) => [...existing, ...chosen])
    setSendError('')
  }, [])

  // ── Can it be sent? ─────────────────────────────────────────────────────
  const confirmNeeded = preview?.confirm_required ?? false
  const confirmSatisfied =
    !confirmNeeded || (preview !== null && confirmTyped.trim() === String(preview.count))

  const blockers = useMemo(() => {
    const out: string[] = []
    if (!draft.audience) out.push('Choose who this goes to.')
    else if (draft.audience === 'person' && !audienceSpec)
      out.push('Type the email address this goes to.')
    if (chosen && !chosen.may_send) out.push(chosen.refusal)
    if (!draft.subject.trim()) out.push('Write a subject.')
    if (limits && draft.subject.trim().length > limits.max_subject_chars)
      out.push(`The subject is over ${limits.max_subject_chars} characters.`)
    if (!draft.body.trim()) out.push('Write the message.')
    if (limits && draft.body.trim().length > limits.max_body_chars)
      out.push(`The message is over ${limits.max_body_chars.toLocaleString('en-IN')} characters.`)
    if (!draft.reason.trim())
      out.push('Give a reason. It is written to the audit log beside who received this.')
    if (audienceSlot.status === 'error') out.push('The audience has not resolved.')
    if (preview && preview.count === 0) out.push('This audience resolves to nobody.')
    if (overTotal && limits)
      out.push(
        `The attachments come to ${formatBytes(totalBytes)}, over the ` +
          `${formatBytes(limits.max_total_attachment_bytes)} a message may carry.`,
      )
    return out
  }, [
    draft, audienceSpec, chosen, limits, audienceSlot.status, preview, overTotal, totalBytes,
  ])

  const canSend =
    blockers.length === 0 && confirmSatisfied && preview !== null && !sending

  // ── Send ────────────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    if (!canSend || preview === null) return
    setSending(true)
    setSendError('')
    setResult(null)
    try {
      const encoded: AttachmentIn[] = await Promise.all(files.map(readAsAttachment))
      const sent = await broadcasts.send({
        audience: audienceSpec,
        subject: draft.subject.trim(),
        body: draft.body.trim(),
        reason: draft.reason.trim(),
        identity: draft.identity === '' ? undefined : draft.identity,
        attachments: encoded,
        // Always sent when the API asked for it. The server checks it against
        // the audience it resolves at that moment, not against this one — so a
        // number that has moved since the preview is refused there, with the
        // real figure, rather than being trusted here.
        confirm_recipients: preview.confirm_required ? preview.count : undefined,
      })
      setResult(sent)
      // The message is gone. Keeping the draft would mean the next visit
      // offers to re-send it, which is the wrong default for something
      // irreversible.
      clearDraft()
      setDraft(EMPTY_DRAFT)
      setDraftRestored(false)
      setFiles([])
      setConfirmTyped('')
      setAudienceSlot({ status: 'idle' })
    } catch (err: unknown) {
      setSendError(
        reasonFrom(
          err,
          'The send was refused and the server gave no reason. Nothing was sent.',
        ),
      )
    } finally {
      setSending(false)
    }
  }, [canSend, preview, files, audienceSpec, draft])

  // ── Gates ───────────────────────────────────────────────────────────────
  if (authLoading || !apiReady) return <Loading label="Checking your access…" />
  if (!apiUser) return <Denied what="the email composer" />
  if (catalogue.status === 'loading') return <Loading label="Reading the audiences…" />
  if (catalogue.status === 'error')
    return <ErrorState message={catalogue.message} onRetry={() => window.location.reload()} />
  if (!options.some((o) => o.may_send)) {
    return (
      <div className="max-w-2xl">
        <Denied what="the email composer" />
        <div className="mt-4 space-y-2">
          {options.map((o) => (
            <p key={o.audience} className="text-slate-500 text-sm">
              <strong className="text-slate-400">{o.label}</strong> — {o.why}
            </p>
          ))}
        </div>
      </div>
    )
  }

  const subjectLeft = (limits?.max_subject_chars ?? 140) - draft.subject.length

  return (
    <div className="max-w-3xl pb-16">
      <div className="mb-6">
        <Link
          href="/broadcasts"
          className="inline-flex items-center gap-1.5 text-slate-500 hover:text-slate-300 text-sm mb-3"
        >
          <ArrowLeft size={14} /> In-app broadcasts
        </Link>
        <h1 className="text-3xl font-bold text-white flex items-center gap-2">
          <Mail size={28} className="text-pink-400" />
          Email composer
        </h1>
        <p className="text-slate-400 mt-1">
          Write to agencies, coin sellers, app users or one named person. Every
          message goes out through the same delivery layer as a payout receipt
          and appears in{' '}
          <Link href="/tech/email" className="text-pink-400 hover:text-pink-300">
            the delivery log
          </Link>
          .
        </p>
      </div>

      {draftRestored && (
        <div className="mb-5">
          <Banner tone="ok" title="A draft was restored" onDismiss={() => setDraftRestored(false)}>
            <p className="text-xs">
              What you had typed is back. Attachments are not — files cannot be
              kept between visits, so pick them again.
            </p>
          </Banner>
        </div>
      )}

      {result && (
        <div className="mb-6">
          <ResultPanel result={result} onDismiss={() => setResult(null)} />
        </div>
      )}

      <div className="space-y-6">
        {/* ── Audience ───────────────────────────────────────────────── */}
        <section className="bg-slate-800/40 border border-slate-700 rounded-xl p-5 space-y-4">
          <h2 className="text-white font-semibold flex items-center gap-2">
            <Users size={16} className="text-slate-400" /> Who it goes to
          </h2>

          <div className="grid sm:grid-cols-2 gap-2">
            {options.map((option) => {
              const active = draft.audience === option.audience
              return (
                <button
                  key={option.audience}
                  type="button"
                  disabled={!option.may_send}
                  onClick={() => set('audience', option.audience)}
                  title={option.may_send ? option.why : option.refusal}
                  className={`text-left rounded-lg border px-3.5 py-2.5 transition ${
                    active
                      ? 'border-pink-500 bg-pink-500/10'
                      : option.may_send
                        ? 'border-slate-700 bg-slate-900/50 hover:border-slate-600'
                        : 'border-slate-800 bg-slate-900/30 opacity-50 cursor-not-allowed'
                  }`}
                >
                  <span className="block text-sm text-white capitalize">
                    {option.audience.replace(/_/g, ' ')}
                  </span>
                  <span className="block text-slate-500 text-xs mt-0.5 leading-snug">
                    {option.may_send ? option.label : option.refusal}
                  </span>
                </button>
              )
            })}
          </div>

          {draft.audience === 'person' && (
            <Field
              label="Their email address"
              hint="It has to match a staff account, an agency or seller registration, or an app user profile. An address on none of them is refused — this composer writes to people the business has a record of."
            >
              <input
                type="email"
                className={INPUT}
                value={draft.personEmail}
                onChange={(e) => set('personEmail', e.target.value)}
                placeholder="someone@example.com"
              />
            </Field>
          )}

          <div className="border-t border-slate-800 pt-4">
            <AudiencePanel slot={audienceSlot} onRefresh={loadAudience} />
          </div>
        </section>

        {/* ── The message ────────────────────────────────────────────── */}
        <section className="bg-slate-800/40 border border-slate-700 rounded-xl p-5 space-y-4">
          <h2 className="text-white font-semibold flex items-center gap-2">
            <Megaphone size={16} className="text-slate-400" /> The message
          </h2>

          <Field
            label="Subject"
            right={
              <span
                className={`text-xs tabular-nums ${
                  subjectLeft < 0 ? 'text-red-400' : subjectLeft < 20 ? 'text-amber-400' : 'text-slate-600'
                }`}
              >
                {subjectLeft} left
              </span>
            }
          >
            <input
              type="text"
              className={INPUT}
              value={draft.subject}
              onChange={(e) => set('subject', e.target.value)}
              placeholder="A short line the recipient will see in their inbox"
            />
          </Field>

          <Field
            label="Message"
            hint="Plain text. Leave a blank line between paragraphs. Typed HTML arrives as the characters you typed — deliberately, so nothing can be pasted into thousands of mailboxes under our signature."
            right={
              <span className="text-xs text-slate-600 tabular-nums">
                {draft.body.length.toLocaleString('en-IN')}
                {limits && ` / ${limits.max_body_chars.toLocaleString('en-IN')}`}
              </span>
            }
          >
            <textarea
              rows={10}
              className={`${INPUT} resize-y font-normal leading-relaxed`}
              value={draft.body}
              onChange={(e) => set('body', e.target.value)}
              placeholder={'Hello,\n\nWrite what you want to say.\n\n— The Zipper team'}
            />
          </Field>

          {/* Attachments */}
          <Field
            label="Attachments"
            hint={
              limits
                ? `Up to ${formatBytes(limits.max_attachment_bytes)} per file and ` +
                  `${formatBytes(limits.max_total_attachment_bytes)} in total. A file over ` +
                  'the limit is left off and named in the email, so the message still arrives.'
                : undefined
            }
            right={
              files.length > 0 ? (
                <span
                  className={`text-xs tabular-nums ${overTotal ? 'text-red-400' : 'text-slate-600'}`}
                >
                  {formatBytes(totalBytes)}
                </span>
              ) : undefined
            }
          >
            <input
              ref={fileInput}
              type="file"
              multiple
              onChange={(e) => addFiles(e.target.files)}
              className="block w-full text-sm text-slate-400 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-700 file:px-3.5 file:py-2 file:text-sm file:text-white hover:file:bg-slate-600"
            />
            {files.length > 0 && (
              <ul className="mt-2.5 space-y-1.5">
                {files.map((file, index) => {
                  const tooBig = limits !== null && file.size > limits.max_attachment_bytes
                  return (
                    <li
                      key={`${file.name}:${index}`}
                      className="flex items-center gap-2 bg-slate-900/60 rounded-lg px-3 py-2"
                    >
                      {tooBig ? (
                        <FileWarning size={14} className="text-amber-400 shrink-0" />
                      ) : (
                        <Paperclip size={14} className="text-slate-500 shrink-0" />
                      )}
                      <span className="text-slate-300 text-sm truncate flex-1">{file.name}</span>
                      <span
                        className={`text-xs tabular-nums shrink-0 ${
                          tooBig ? 'text-amber-400' : 'text-slate-600'
                        }`}
                      >
                        {formatBytes(file.size)}
                      </span>
                      <button
                        onClick={() => setFiles((f) => f.filter((_, i) => i !== index))}
                        className="text-slate-600 hover:text-red-400 shrink-0"
                        title="Remove"
                      >
                        <Trash2 size={13} />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            {oversized.length > 0 && (
              <p className="text-amber-400/90 text-xs mt-2 leading-relaxed">
                {oversized.map((f) => f.name).join(', ')}{' '}
                {oversized.length === 1 ? 'is' : 'are'} over the per-file limit and
                will be left off. The email still goes, and it will say which files
                are missing and why.
              </p>
            )}
          </Field>
        </section>

        {/* ── Sender and reason ──────────────────────────────────────── */}
        <section className="bg-slate-800/40 border border-slate-700 rounded-xl p-5 space-y-4">
          <h2 className="text-white font-semibold flex items-center gap-2">
            <Send size={16} className="text-slate-400" /> Who it comes from
          </h2>

          <div className="grid sm:grid-cols-3 gap-2">
            {senders.map((sender) => {
              const active = draft.identity === sender.identity
              return (
                <button
                  key={sender.identity}
                  type="button"
                  onClick={() => set('identity', active ? '' : sender.identity)}
                  className={`text-left rounded-lg border px-3 py-2.5 transition ${
                    active
                      ? 'border-pink-500 bg-pink-500/10'
                      : 'border-slate-700 bg-slate-900/50 hover:border-slate-600'
                  }`}
                >
                  <span className="block text-sm text-white capitalize">{sender.identity}</span>
                  <span className="block text-slate-500 text-xs mt-0.5 break-all">
                    {sender.from}
                  </span>
                  {!sender.alignment.aligned && (
                    <span className="block text-amber-400/80 text-xs mt-1 leading-snug">
                      This address cannot pass DMARC.
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          <p className="text-slate-600 text-xs leading-relaxed">
            Leave all three unpicked to use the sensible default — the support
            mailbox for one person, the bulk address for anything larger.
            Anything larger than one person is sent from the bulk address
            whatever you pick, so a mailshot cannot spend the reputation the
            payout receipts depend on.
            {senders.some((s) => !s.alignment.aligned) && (
              <span className="block mt-1 text-amber-400/80">
                {senders.find((s) => !s.alignment.aligned)?.alignment.why}
              </span>
            )}
          </p>

          <Field
            label="Reason"
            hint="Mandatory. Written to the audit log beside the list of everyone who received this, so that in six months there is an answer to “who sent this, and why”."
          >
            <input
              type="text"
              className={INPUT}
              value={draft.reason}
              onChange={(e) => set('reason', e.target.value)}
              placeholder="e.g. Telling every seller the payout day moves to Tuesday"
            />
          </Field>
        </section>

        {/* ── Confirm and send ───────────────────────────────────────── */}
        <section className="space-y-4">
          {confirmNeeded && preview && (
            <div className="bg-amber-500/10 border-2 border-amber-500/40 rounded-xl p-5">
              <h3 className="text-amber-200 font-semibold flex items-center gap-2">
                <AlertTriangle size={16} />
                This goes to {preview.count.toLocaleString('en-IN')} people and cannot
                be undone
              </h3>
              <p className="text-amber-100/80 text-sm mt-2 leading-relaxed">
                {preview.label}. Type the number{' '}
                <strong className="text-amber-100">{preview.count}</strong> below to
                confirm you have looked at it. The server checks it again against the
                audience as it stands at that moment, so a number that has changed
                since will be refused rather than sent.
              </p>
              <input
                type="text"
                inputMode="numeric"
                value={confirmTyped}
                onChange={(e) => setConfirmTyped(e.target.value)}
                placeholder={String(preview.count)}
                className="mt-3 w-40 bg-slate-900 border border-amber-500/40 text-white rounded-lg px-3.5 py-2.5 text-sm tabular-nums focus:outline-none focus:border-amber-400"
              />
              {confirmTyped.trim() !== '' && !confirmSatisfied && (
                <p className="text-amber-300 text-xs mt-2">
                  That is not the number. The audience is{' '}
                  {preview.count.toLocaleString('en-IN')}.
                </p>
              )}
            </div>
          )}

          {sendError && (
            <Banner tone="error" title="Nothing was sent" onDismiss={() => setSendError('')}>
              <p>{sendError}</p>
            </Banner>
          )}

          {blockers.length > 0 && (
            <div className="text-slate-500 text-xs space-y-1">
              {blockers.map((b) => (
                <p key={b}>· {b}</p>
              ))}
            </div>
          )}

          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={handleSend}
              disabled={!canSend}
              className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg px-6 py-2.5 text-sm font-semibold transition"
            >
              {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              {sending
                ? 'Sending…'
                : preview
                  ? `Send to ${preview.count.toLocaleString('en-IN')}`
                  : 'Send'}
            </button>

            <button
              onClick={loadAudience}
              disabled={!audienceSpec}
              className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 rounded-lg px-4 py-2.5 text-sm transition"
            >
              <Eye size={14} /> Re-count the audience
            </button>

            <button
              onClick={() => {
                clearDraft()
                setDraft(EMPTY_DRAFT)
                setFiles([])
                setConfirmTyped('')
                setSendError('')
                setDraftRestored(false)
                setAudienceSlot({ status: 'idle' })
              }}
              className="flex items-center gap-2 text-slate-500 hover:text-slate-300 text-sm ml-auto"
            >
              <Trash2 size={14} /> Discard the draft
            </button>
          </div>

          <p className="text-slate-600 text-xs leading-relaxed">
            Your draft is saved as you type and will still be here after a
            refresh or a lost session. It is cleared once a message has actually
            gone.
            {catalogue.status === 'ok' && ` ${catalogue.value.unsubscribe.note}`}
          </p>
        </section>
      </div>
    </div>
  )
}
