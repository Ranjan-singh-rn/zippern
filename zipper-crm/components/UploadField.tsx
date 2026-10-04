'use client'

import { useRef, useState } from 'react'
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage'
import { storage } from '@/lib/firebase'
import { Loader2, Upload, ExternalLink, AlertTriangle } from 'lucide-react'

/**
 * A file field that accepts a file.
 *
 * Most of the CRM asked for a URL. "Payment proof image URL", "Evidence URL",
 * "photo URL" — a text box and `https://…`, which means whoever is filling the
 * form has to get the file onto a public host by some other route first, then
 * paste a link back. In practice that is somebody emailing themselves a
 * screenshot, or pasting a Drive link that is only readable while they are
 * signed in, so the evidence attached to a payout is a link that later opens a
 * sign-in page for anybody who audits it.
 *
 * `app/tech/content` already had the right control — a URL box with an Upload
 * button beside it — but it lived inside that one file and nothing else could
 * reach it. This is that component, extracted, owning its own upload state so a
 * call site is one line instead of three `useState`s and a progress handler.
 *
 * The URL box stays. A pasted link is still legitimate when the file genuinely
 * lives somewhere else, and taking the box away would break those. What changes
 * is that uploading is now the easy path rather than the impossible one.
 */
export default function UploadField({
  label,
  value,
  onChange,
  storagePath,
  accept = 'image/*',
  hint,
  disabled,
  disabledHint,
  required,
  maxSizeMb = 10,
}: {
  label: string
  value: string
  onChange: (url: string) => void
  /**
   * Where the file goes, WITHOUT a file name — one is appended, prefixed with
   * the time so re-uploading never silently overwrites the previous evidence.
   * A payout's proof being replaced by a later one, at the same path, with no
   * trace, is the failure this avoids.
   */
  storagePath: string
  accept?: string
  hint?: string
  disabled?: boolean
  disabledHint?: string
  required?: boolean
  maxSizeMb?: number
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')

  async function upload(file: File) {
    setError('')
    if (file.size > maxSizeMb * 1024 * 1024) {
      setError(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${maxSizeMb} MB.`)
      return
    }
    setUploading(true)
    setProgress(0)
    try {
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const sRef = ref(storage, `${storagePath.replace(/\/+$/, '')}/${Date.now()}_${safe}`)
      const task = uploadBytesResumable(sRef, file)
      await new Promise<void>((resolve, reject) =>
        task.on(
          'state_changed',
          snap => setProgress(Math.round((snap.bytesTransferred / snap.totalBytes) * 100)),
          reject,
          () => resolve(),
        ),
      )
      onChange(await getDownloadURL(sRef))
    } catch (e: unknown) {
      // Named, not swallowed. A silent upload failure leaves an empty field and
      // somebody wondering whether they clicked the button.
      setError(e instanceof Error ? e.message : 'Upload failed.')
    } finally {
      setUploading(false)
    }
  }

  const isImage = accept.includes('image')

  return (
    <div>
      <label className="text-xs text-slate-400 mb-1 block">
        {label}{required && <span className="text-pink-400"> *</span>}
      </label>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="Upload a file, or paste a link"
          className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-pink-500 min-w-0"
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || uploading}
          title={disabled ? disabledHint : undefined}
          className="flex items-center gap-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3 py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap"
        >
          {uploading
            ? <><Loader2 size={13} className="animate-spin" />{progress}%</>
            : <><Upload size={13} />Upload</>}
        </button>
        <input
          type="file"
          accept={accept}
          className="hidden"
          ref={inputRef}
          onChange={e => {
            const f = e.target.files?.[0]
            if (f) upload(f)
            // Cleared so choosing the same file twice in a row still fires.
            e.target.value = ''
          }}
        />
      </div>

      {error && (
        <p className="flex items-center gap-1 mt-1 text-xs text-red-400">
          <AlertTriangle size={11} />{error}
        </p>
      )}
      {hint && !error && <p className="mt-1 text-xs text-slate-500">{hint}</p>}

      {value && value.startsWith('http') && (
        <div className="mt-2 flex items-center gap-3">
          {isImage && (
            // A thumbnail, because the point of attaching proof is that somebody
            // looks at it. A bare link gets approved unopened.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={value}
              alt={label}
              className="h-14 w-14 rounded-lg object-cover border border-slate-700"
            />
          )}
          <a
            href={value}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-cyan-300 underline hover:text-white"
          >
            Open <ExternalLink size={11} />
          </a>
        </div>
      )}
    </div>
  )
}
