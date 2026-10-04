'use client'

/**
 * The composed-email API — `backend/app/routers/broadcasts.py`, spec 8A.7.2.
 *
 * Three calls: what may be sent, who an audience resolves to, and the send.
 * Every one of them answers with a sentence written for a person, and this
 * module never paraphrases one — a refusal from the API arrives on
 * `ApiError.message` and the composer shows it verbatim. Rewriting "This will
 * be sent to 4,182 people; confirm that number" into "Request failed" is how
 * somebody ends up clicking send again to see what happens.
 *
 * It shares `lib/apiReports.ts`'s prefix-based client rather than
 * `lib/api.ts`'s, because that one already flattens the two error-body shapes
 * FastAPI produces and reports a 401 the way `AuthProvider` expects.
 */

import { ApiError, getSessionToken, reportUnauthorized } from '@/lib/api'

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ??
  (typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? 'http://127.0.0.1:8080'
    : '')

const PREFIX = '/api/broadcasts'

// ── Types, mirroring what the router actually returns ─────────────────────────

/** The four audiences. There is no fifth — `broadcast.Audience`. */
export type AudienceName = 'all_agencies' | 'all_sellers' | 'all_users' | 'person'

/** `email.SenderIdentity`. */
export type SenderIdentity = 'transactional' | 'bulk' | 'support'

/** Whether a From can pass DMARC at all — `email.sender_alignment`. */
export interface SenderAlignment {
  from: string
  domain: string
  reply_to: string
  aligned: boolean
  one_domain: boolean
  domains: string[]
  /** Empty when there is nothing wrong. Shown verbatim when there is. */
  why: string
}

export interface AudienceOption {
  audience: AudienceName
  label: string
  /** True for `person`: the audience is incomplete without an address. */
  needs_address: boolean
  /** Whether *this* account may send to it. */
  may_send: boolean
  /** The API's own reason, when it may not. Shown as written. */
  refusal: string
  allowed_roles: string[]
  why: string
}

export interface SenderOption {
  identity: SenderIdentity
  from: string
  from_name: string
  reply_to: string
  alignment: SenderAlignment
}

export interface BroadcastLimits {
  max_recipients: number
  confirm_above: number
  max_subject_chars: number
  max_body_chars: number
  max_attachment_bytes: number
  max_total_attachment_bytes: number
}

export interface AudienceCatalogue {
  audiences: AudienceOption[]
  sender_identities: SenderOption[]
  limits: BroadcastLimits
  unsubscribe: { stream: string; note: string }
}

/** One resolved recipient, as the preview shows them. */
export interface AudienceMember {
  email: string
  name: string
  role: string | null
  uid: string | null
}

/** A partner in the audience with no address on their record. A gap, named. */
export interface AudienceGap {
  id: string
  name: string
  reason: string
}

/** Records deliberately left out, grouped by why. */
export interface AudienceExclusion {
  count: number
  reason: string
}

/** `GET /api/broadcasts/audience` — sends nothing, records nothing. */
export interface AudiencePreview {
  audience: string
  param: string
  label: string
  /** Where it came from, in words — Mongo, Firestore, or both. */
  source: string
  /** Who will actually be written to. The unsubscribed are already out. */
  count: number
  /** How many the audience resolved to before opt-outs were applied. */
  resolved_count: number
  sample: AudienceMember[]
  /** True when `sample` is the whole audience, not the first slice of it. */
  sample_is_all: boolean
  no_address: AudienceGap[]
  no_address_count: number
  excluded: AudienceExclusion[]
  excluded_count: number
  unsubscribed: string[]
  unsubscribed_count: number
  /** Above this many recipients the send demands the count back. */
  confirm_required: boolean
  confirm_above: number
  max_recipients: number
  note: string
}

export interface AttachmentOut {
  filename: string
  content_type: string
  bytes: number
}

export interface AttachmentOmission {
  filename: string
  bytes: number
  reason: string
}

/** `POST /api/broadcasts/email`. A 200 means the send ran, not that it worked. */
export interface BroadcastResult {
  broadcast_id: string
  /** The delivery-log `kind` every recipient's row carries. */
  kind: string
  spec: string
  audit_id: string
  subject: string
  audience: string
  audience_label: string
  audience_source: string
  sender_identity: SenderIdentity
  /** Non-empty when the chosen identity was overridden, with the reason. */
  sender_identity_note: string
  sender: SenderAlignment
  bulk: boolean
  unsubscribe: { report: string; cadence: string; one_click: boolean }
  recipients: number
  attempted: number
  /** The provider took it. Not the same as a mailbox having taken it. */
  accepted: number
  failed: number
  by_outcome: Record<string, number>
  unsubscribed_skipped: number
  no_address: AudienceGap[]
  excluded: AudienceExclusion[]
  attachments: AttachmentOut[]
  attachments_omitted: AttachmentOmission[]
  attachments_note: string
  /** Addresses the send never reached — a throttle, or a slice that fell over. */
  not_attempted: string[]
  stopped_early: boolean
  stop_reason: string
  /** Spam-filter warnings. The message went; these are for next time. */
  warnings: string[]
  /** Ready-made link into the delivery log, filtered to this send. */
  delivery_log: string
  note: string
}

export interface AttachmentIn {
  filename: string
  content_type: string
  data_base64: string
}

export interface BroadcastRequest {
  audience: string
  subject: string
  body: string
  reason: string
  identity?: SenderIdentity
  attachments?: AttachmentIn[]
  confirm_recipients?: number
}

// ── The client ────────────────────────────────────────────────────────────────

type QueryParams = Record<string, string | number | undefined>

function buildQuery(params: QueryParams): string {
  const q = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== '') q.set(k, String(v))
  })
  const s = q.toString()
  return s ? `?${s}` : ''
}

/** The API's error body, turned into the sentence it already is. */
function messageFrom(body: unknown, fallback: string): string {
  const detail = (body as { detail?: unknown })?.detail ?? body
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((d: { loc?: string[]; msg?: string }) =>
        `${d.loc?.slice(1).join('.') ?? ''} ${d.msg ?? ''}`.trim(),
      )
      .join('; ')
  }
  if (detail && typeof detail === 'object') {
    const d = detail as { message?: unknown }
    if (typeof d.message === 'string' && d.message.trim()) return d.message
  }
  return fallback
}

async function call<T>(
  path: string,
  params: QueryParams = {},
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = getSessionToken()
  if (!token) throw new ApiError('Not signed in', 401)

  let response: Response
  try {
    response = await fetch(`${API_BASE}${PREFIX}${path}${buildQuery(params)}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
  } catch (err) {
    throw new ApiError(
      'Could not reach the server. Nothing was sent — a composed message is ' +
        'never sent by a request that did not arrive.',
      0,
      err,
    )
  }

  const text = await response.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }

  if (!response.ok) {
    const message = messageFrom(body, response.statusText || 'The request was refused.')
    if (response.status === 401) reportUnauthorized({ message, path: `${PREFIX}${path}` })
    throw new ApiError(message, response.status, body)
  }
  return body as T
}

export const broadcasts = {
  /** Every audience, every sender identity, and what this account may do. */
  catalogue: () => call<AudienceCatalogue>('/audiences'),

  /**
   * Who an audience resolves to right now. Sends nothing.
   *
   * `audience` is `all_agencies`, `all_sellers`, `all_users`, or
   * `person:<email address>`.
   */
  preview: (audience: string, sample = 25) =>
    call<AudiencePreview>('/audience', { audience, sample }),

  /** Send it. Audited, with the reason and the resolved audience recorded. */
  send: (request: BroadcastRequest) =>
    call<BroadcastResult>('/email', {}, { method: 'POST', body: request }),
}

// ── Files ─────────────────────────────────────────────────────────────────────

/**
 * A picked file as the API wants it: exact bytes, base64, no data-URL prefix.
 *
 * `FileReader.readAsDataURL` is used rather than `arrayBuffer()` + manual
 * base64 because the browser's own encoder handles the whole file without
 * building a megabyte-long argument list for `String.fromCharCode`, which is
 * where the hand-rolled version blows the call stack on a real attachment.
 */
export function readAsAttachment(file: File): Promise<AttachmentIn> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () =>
      reject(
        new ApiError(
          `'${file.name}' could not be read from disk, so it was not attached ` +
            'and nothing was sent.',
          0,
        ),
      )
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      if (comma < 0) {
        reject(new ApiError(`'${file.name}' could not be encoded for sending.`, 0))
        return
      }
      resolve({
        filename: file.name,
        // A bare `type/subtype`. The browser sometimes hands back a type with
        // parameters, and a parameter in this field is refused by SendGrid and
        // takes the whole message with it — the backend strips them too, but
        // sending a value the API has to repair is not a habit worth having.
        content_type: (file.type || 'application/octet-stream').split(';')[0].trim(),
        data_base64: result.slice(comma + 1),
      })
    }
    reader.readAsDataURL(file)
  })
}

/** Bytes, as a person reads them. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
