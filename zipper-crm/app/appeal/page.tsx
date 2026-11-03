'use client'

/**
 * /appeal — the PUBLIC appeal page (UGP-F). No sign-in.
 *
 * For a person whose Zipper account is banned or suspended: they cannot sign
 * into it (a ban disables the login) and the in-app appeal needs this same
 * phone's saved sign-in. Here they identify the account by its account ID (the
 * full ID on the Banned / Suspended screen) — or by its display name with the
 * 8-character profile ID — AND the phone number or email address that is on
 * the account (§5), write what happened, attach up to three screenshots or
 * videos, and get a reference.
 *
 * ── THE CONTACT, AND THE TWO WAYS IT IS REFUSED ─────────────────────────────
 *
 * The server says nothing beyond "not found" — and files nothing — unless the
 * contact matches the account's own record. A missing contact (CONTACT_REQUIRED)
 * and a wrong one (CONTACT_MISMATCH) are different instructions, so each is
 * shown under the contact field with its own heading and the server's sentence
 * word for word (`lib/publicAppealContact.ts`). This page used not to ask for
 * the contact at all, so every appeal from the web was refused.
 *
 * What it never does: lift anything. The appeal lands in the CRM's existing
 * appeals inbox as "Waiting", and only a decision changes the account. The
 * server answers a missing account and an unrestricted one the same way, and
 * says nothing beyond whether an appeal can be filed — not ban versus
 * suspension, not the reference of an appeal somebody already filed.
 */

import { useState } from 'react'
import { AlertTriangle, CheckCircle, FileText, Loader2, Paperclip, Search, X } from 'lucide-react'
import { ApiError, publicAppeals, type PublicAppealLookup } from '@/lib/api'
import {
  MAX_CONTACT, contactProblem, maskContact, presentPublicAppealRefusal, type RefusalView,
} from '@/lib/publicAppealContact'
import { SUPPORT_EMAIL } from '@/lib/contacts'  // QA #47

const MIN_STATEMENT = 20
const MAX_STATEMENT = 2000
const MAX_FILES = 3
const MAX_IMAGE_MB = 5
const MAX_VIDEO_MB = 20

type Step = 'identify' | 'write' | 'done'

function fileProblem(files: File[]): string {
  if (files.length > MAX_FILES) return `Attach at most ${MAX_FILES} files.`
  for (const f of files) {
    const isImage = /^image\/(jpeg|png|webp)$/.test(f.type)
    const isVideo = /^video\/(mp4|quicktime|webm)$/.test(f.type)
    if (!isImage && !isVideo) return `${f.name}: only JPEG, PNG or WebP screenshots and MP4, MOV or WebM videos.`
    const mb = f.size / (1024 * 1024)
    if (isImage && mb > MAX_IMAGE_MB) return `${f.name}: images can be at most ${MAX_IMAGE_MB} MB.`
    if (isVideo && mb > MAX_VIDEO_MB) return `${f.name}: videos can be at most ${MAX_VIDEO_MB} MB.`
  }
  return ''
}

export default function PublicAppealPage() {
  const [step, setStep] = useState<Step>('identify')
  const [accountId, setAccountId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [contact, setContact] = useState('')
  const [found, setFound] = useState<PublicAppealLookup | null>(null)
  const [statement, setStatement] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** A refusal about the CONTACT — shown under the field, never as a generic error. */
  const [contactRefusal, setContactRefusal] = useState<RefusalView | null>(null)
  const [reference, setReference] = useState('')

  const shortId = accountId.trim().length < 20

  /** Route a refusal to where it belongs: the contact field, or the page. */
  function showRefusal(err: unknown, fallback: string): boolean {
    const view = presentPublicAppealRefusal(
      err instanceof ApiError ? { status: err.status, message: err.message } : null,
      fallback,
    )
    if (view.contactField) {
      setContactRefusal(view)
      setError('')
      return true
    }
    setContactRefusal(null)
    setError(view.message)
    return false
  }

  async function identify() {
    setError('')
    setContactRefusal(null)
    setFound(null)
    const id = accountId.trim()
    if (id.length < 6) { setError('Enter the account ID shown on your Banned or Suspended screen.'); return }
    if (shortId && !displayName.trim()) {
      setError('With the 8-character profile ID, also enter the account’s display name exactly as it appears.')
      return
    }
    const problem = contactProblem(contact)
    if (problem) {
      setContactRefusal({ kind: 'contact_required', title: '', message: problem, contactField: true, hint: '' })
      return
    }
    setBusy(true)
    try {
      const r = await publicAppeals.lookup(id, displayName.trim(), contact.trim())
      setFound(r)
      if (r.state === 'appealable') setStep('write')
    } catch (err) {
      showRefusal(err, 'That did not work. Try again.')
    } finally {
      setBusy(false)
    }
  }

  async function send() {
    setError('')
    setContactRefusal(null)
    const text = statement.trim()
    if (text.length < MIN_STATEMENT) { setError(`Tell us what happened in at least ${MIN_STATEMENT} characters.`); return }
    if (text.length > MAX_STATEMENT) { setError(`Keep the message under ${MAX_STATEMENT} characters.`); return }
    const problem = fileProblem(files)
    if (problem) { setError(problem); return }
    setBusy(true)
    try {
      const r = await publicAppeals.submit({
        accountId: accountId.trim(),
        displayName: displayName.trim(),
        contact: contact.trim(),
        statement: text,
        files,
      })
      setReference(r.reference)
      setStep('done')
    } catch (err) {
      // A contact the server no longer accepts is fixed on the first step,
      // where the field is — the message and the statement are kept.
      if (showRefusal(err, 'Your appeal could not be sent. Try again.')) setStep('identify')
    } finally {
      setBusy(false)
    }
  }

  const contactInvalid = !!contactRefusal

  return (
    <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-8 space-y-5">
        <div>
          <h1 className="text-xl font-semibold">Appeal a Zipper account decision</h1>
          <p className="text-slate-400 text-sm mt-1">
            For an account that is banned or suspended. You do not need to sign in. A person reviews
            every appeal; sending one does not change your account by itself.
          </p>
        </div>

        {step === 'identify' && (
          <div className="space-y-4">
            <div>
              <label className="block text-slate-400 text-xs font-medium mb-1.5">Account ID</label>
              <input
                value={accountId}
                onChange={(e) => setAccountId(e.target.value.trim())}
                placeholder="The ID on your Banned or Suspended screen"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 font-mono"
              />
              <p className="text-slate-500 text-xs mt-1">
                The full ID works on its own. With the short 8-character ID from your profile, also give the
                display name below.
              </p>
            </div>
            {shortId && (
              <div>
                <label className="block text-slate-400 text-xs font-medium mb-1.5">Display name (exactly as shown)</label>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. Guest yrfdp"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
                />
              </div>
            )}
            <div>
              <label htmlFor="appeal-contact" className="block text-slate-400 text-xs font-medium mb-1.5">
                Phone number or email on the account
              </label>
              <input
                id="appeal-contact"
                value={contact}
                maxLength={MAX_CONTACT}
                onChange={(e) => { setContact(e.target.value); setContactRefusal(null) }}
                placeholder="The number or address the account signs in with"
                aria-invalid={contactInvalid}
                aria-describedby="appeal-contact-help"
                className={`w-full bg-slate-800 border rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none ${
                  contactInvalid ? 'border-red-500 focus:border-red-400' : 'border-slate-700 focus:border-pink-500'
                }`}
              />
              {contactRefusal ? (
                <div id="appeal-contact-help" className="mt-2 flex items-start gap-2 bg-red-500/10 border border-red-500/40 rounded-lg px-3 py-2.5">
                  <AlertTriangle size={14} className="text-red-400 mt-0.5 shrink-0" />
                  <div className="text-sm">
                    {contactRefusal.title && <p className="text-red-100 font-semibold">{contactRefusal.title}</p>}
                    <p className="text-red-200">{contactRefusal.message}</p>
                    {contactRefusal.hint && <p className="text-red-200/70 text-xs mt-1">{contactRefusal.hint}</p>}
                  </div>
                </div>
              ) : (
                <p id="appeal-contact-help" className="text-slate-500 text-xs mt-1">
                  The phone number or email address the account was registered with — it is how the appeal is
                  matched to the account. A phone number works with or without the country code.
                </p>
              )}
            </div>
            {found && found.state !== 'appealable' && (
              <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3">
                <AlertTriangle size={15} className="text-amber-400 mt-0.5 shrink-0" />
                <p className="text-amber-100 text-sm">{found.message}</p>
              </div>
            )}
            <button
              onClick={identify}
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:opacity-50 rounded-lg px-4 py-2.5 text-sm font-semibold"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />} Find the account
            </button>
          </div>
        )}

        {step === 'write' && found && (
          <div className="space-y-4">
            <div className="bg-slate-950/60 border border-slate-800 rounded-lg px-4 py-3 text-sm">
              <p className="text-slate-300">
                Account: <span className="text-white font-medium">{found.name_hint}</span>
              </p>
              <p className="text-slate-500 text-xs mt-0.5">
                Matched on <span className="font-mono text-slate-400">{maskContact(contact)}</span>
              </p>
              <button
                onClick={() => { setStep('identify'); setFound(null) }}
                className="text-pink-300 text-xs underline underline-offset-2 mt-1"
              >
                Not your account? Go back
              </button>
            </div>
            <div>
              <label className="block text-slate-400 text-xs font-medium mb-1.5">What happened</label>
              <textarea
                value={statement}
                onChange={(e) => setStatement(e.target.value)}
                rows={6}
                maxLength={MAX_STATEMENT}
                placeholder="Explain why the decision should be looked at again."
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 resize-none"
              />
              <p className="text-slate-500 text-xs mt-1">{statement.trim().length} / {MAX_STATEMENT} — at least {MIN_STATEMENT}.</p>
            </div>
            <div>
              <label className="flex items-center gap-2 text-slate-300 text-sm cursor-pointer">
                <Paperclip size={14} /> Add screenshots or a video (optional, up to {MAX_FILES})
                <input
                  type="file"
                  multiple
                  accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
                  className="hidden"
                  onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, MAX_FILES + 1))}
                />
              </label>
              {files.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {files.map((f, i) => (
                    <li key={`${f.name}-${i}`} className="flex items-center justify-between text-xs text-slate-400">
                      <span className="flex items-center gap-1.5"><FileText size={12} /> {f.name}</span>
                      <button onClick={() => setFiles(files.filter((_, j) => j !== i))} className="hover:text-white">
                        <X size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-slate-500 text-xs mt-1">
                Images up to {MAX_IMAGE_MB} MB (JPEG, PNG, WebP); videos up to {MAX_VIDEO_MB} MB (MP4, MOV, WebM).
              </p>
            </div>
            <button
              onClick={send}
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:opacity-50 rounded-lg px-4 py-2.5 text-sm font-semibold"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : null} Send the appeal
            </button>
          </div>
        )}

        {step === 'done' && (
          <div className="flex items-start gap-3 bg-green-500/10 border border-green-500/30 rounded-lg px-4 py-4">
            <CheckCircle size={18} className="text-green-400 mt-0.5 shrink-0" />
            <div className="text-sm">
              <p className="text-green-100 font-semibold">Your appeal has been sent.</p>
              <p className="text-green-100/90 mt-1">
                Reference <span className="font-mono font-semibold">{reference}</span>. Keep it — quote it if you
                write to {SUPPORT_EMAIL}. A reviewer will look at the decision again; nothing changes on the account
                until they decide. The account&rsquo;s Official messages (and its verified email) confirm the appeal
                was received.
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
            <AlertTriangle size={15} className="text-red-400 mt-0.5 shrink-0" />
            <p className="text-red-200 text-sm">{error}</p>
          </div>
        )}
      </div>
    </div>
  )
}
