'use client'

/**
 * Every mutation on a chance mechanic captures its reason here.
 *
 * Never `window.prompt` and never `window.confirm`. Three reasons, and all
 * three are about this half of the product specifically:
 *
 *   * The API refuses a reason shorter than eight characters on every one of
 *     these routes, and a native prompt cannot validate before sending — so the
 *     person types, waits, and is refused by a server for a rule the screen
 *     already knew.
 *   * These actions need explaining. Suspending a mechanic makes it invisible
 *     to every player; freezing an account does *not* move a balance and is not
 *     a ban. A prompt cannot say either thing, and the person pressing the
 *     button is exactly the person who needs to be told.
 *   * The reason is stored in the audit log against a name. A dialog that
 *     cannot be reviewed before submission produces reasons that read like
 *     "asd" six months later, which is the same as no audit trail at all.
 *
 * The server's refusal is shown verbatim: these messages are written to be
 * read, and paraphrasing one loses the instruction inside it.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, Loader2, X } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { MIN_REASON } from '@/lib/apiChance'

export type ModalTone = 'neutral' | 'caution' | 'danger'

const TONE: Record<ModalTone, { ring: string; button: string; icon: string }> = {
  neutral: {
    ring: 'border-slate-700',
    button: 'bg-pink-600 hover:bg-pink-500 disabled:bg-pink-900/50',
    icon: 'text-sky-400',
  },
  caution: {
    ring: 'border-amber-500/40',
    button: 'bg-amber-600 hover:bg-amber-500 disabled:bg-amber-900/50',
    icon: 'text-amber-400',
  },
  danger: {
    ring: 'border-red-500/40',
    button: 'bg-red-600 hover:bg-red-500 disabled:bg-red-900/50',
    icon: 'text-red-400',
  },
}

export function ChanceReasonModal({
  title,
  what,
  tone = 'neutral',
  confirmLabel,
  placeholder = 'Why is this being done? It is stored in the audit log against your name.',
  children,
  extraInvalid,
  reasonMode = 'required',
  reasonNote,
  onClose,
  onSubmit,
}: {
  title: string
  /** What this does and — as importantly — what it does not do. */
  what: ReactNode
  tone?: ModalTone
  confirmLabel: string
  placeholder?: string
  /** Extra fields the route requires, rendered above the reason box. */
  children?: ReactNode
  /** A sentence when the extra fields are not yet valid, else null. */
  extraInvalid?: string | null
  /**
   * `'none'` for the one route in this API that takes no reason —
   * `POST /chance/configs/{card_id}/activate`. Asking for a sentence the
   * request cannot carry would put words in an audit log that never receives
   * them, so the box is replaced by `reasonNote` saying where the reason for
   * this action already lives. It is still a modal, never a `window.confirm`.
   */
  reasonMode?: 'required' | 'none'
  reasonNote?: ReactNode
  onClose: () => void
  onSubmit: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const trimmed = reason.trim()
  const tooShort = reasonMode === 'none' ? false : trimmed.length < MIN_REASON
  const blocked = tooShort || Boolean(extraInvalid)

  async function submit() {
    if (blocked || busy) return
    setBusy(true)
    setError('')
    try {
      await onSubmit(trimmed)
    } catch (err) {
      // Verbatim. The API writes these sentences to be shown.
      setError(err instanceof ApiError ? err.message : 'The request did not complete.')
      setBusy(false)
    }
  }

  const t = TONE[tone]

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-6">
      <div
        className={`bg-slate-900 border ${t.ring} rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[92vh] overflow-y-auto`}
      >
        <div className="flex items-start justify-between gap-4 p-5 border-b border-slate-800">
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={17} className={`${t.icon} mt-0.5 shrink-0`} />
            <h2 className="text-white font-semibold leading-snug">{title}</h2>
          </div>
          <button
            onClick={() => !busy && onClose()}
            className="text-slate-500 hover:text-slate-300 shrink-0"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="text-sm text-slate-400 leading-relaxed space-y-2">{what}</div>

          {children}

          {reasonMode === 'none' ? (
            <p className="text-slate-400 text-xs bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 leading-relaxed">
              {reasonNote ??
                'This route takes no reason of its own, so there is no box here to fill in. The reason for this change is the one on the card, and the authority is the signature already on it.'}
            </p>
          ) : (
            <div>
              <label className="block text-slate-300 text-sm font-medium mb-1.5">
                Reason <span className="text-red-400">*</span>
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                autoFocus
                placeholder={placeholder}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-pink-500"
              />
              <p className={`text-xs mt-1 ${tooShort ? 'text-slate-500' : 'text-emerald-400/80'}`}>
                {tooShort
                  ? `At least ${MIN_REASON} characters — the API refuses anything shorter, and so does the audit log.`
                  : 'This is recorded against your name.'}
              </p>
            </div>
          )}

          {extraInvalid && (
            <p className="text-amber-300 text-sm bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
              {extraInvalid}
            </p>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2.5">
              <p className="text-red-200 text-sm whitespace-pre-wrap leading-relaxed">{error}</p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-5 border-t border-slate-800">
          <button
            onClick={() => !busy && onClose()}
            disabled={busy}
            className="px-4 py-2.5 rounded-lg text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={blocked || busy}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm text-white font-medium transition-colors disabled:cursor-not-allowed ${t.button}`}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
