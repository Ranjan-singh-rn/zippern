/**
 * QA #29 / #32 (3 Nov 2026) — KYC and partner document uploads say what is
 * wrong, before uploading when they can, and forget a failure once a retry
 * works.
 *
 *   * A file over the Storage cap was sent anyway and refused by the rules
 *     with Firebase's own words, "User does not have permission to access this
 *     object." — which reads as an account problem, not a size problem.
 *   * The red error from a failed upload stayed on the step after the retry
 *     uploaded successfully (Register New Agency), so the person could not
 *     tell whether the document was in.
 *
 * The limits are the Storage rules' own (`storage.rules`): every KYC document
 * path is `isDocument() && maxSize(10)`, and `isDocument()` admits exactly
 * JPEG, PNG and PDF. Checked here so the refusal names the real cause; the
 * rules still decide. No imports, so `kycUpload.spec.ts` runs it standalone.
 */

export const KYC_MAX_MB = 10

/** `storage.rules` → `isDocument()`. */
export const KYC_CONTENT_TYPES: readonly string[] = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg']

export function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1)
}

/** Why this file cannot be uploaded as a KYC document, or null when it can. */
export function kycFileProblem(file: { size: number; type?: string }, maxMb: number = KYC_MAX_MB): string | null {
  if (file.size > maxMb * 1024 * 1024) {
    return `That file is ${megabytes(file.size)} MB. The limit is ${maxMb} MB — choose a smaller file, or take a photo of the document instead.`
  }
  const type = (file.type ?? '').toLowerCase()
  if (type && !KYC_CONTENT_TYPES.includes(type)) {
    return 'That file type cannot be used. Upload a JPG, PNG or PDF.'
  }
  return null
}

/** A failed upload, in words a person can act on. */
export function kycUploadErrorText(err: unknown): string {
  const code = String((err as { code?: unknown })?.code ?? '')
  switch (code) {
    case 'storage/unauthorized':
      // The rules refuse a file over the cap or of the wrong type with this
      // code; a signed-out session is the other cause.
      return `The file was refused. Upload a JPG, PNG or PDF under ${KYC_MAX_MB} MB. If it already is, sign in again and retry.`
    case 'storage/canceled':
      return 'The upload was cancelled.'
    case 'storage/retry-limit-exceeded':
    case 'storage/unknown':
      return 'The upload could not finish. Check your connection and try again.'
    case 'storage/quota-exceeded':
      return 'Uploads are unavailable right now. Try again later.'
    default: {
      const msg = (err as { message?: unknown })?.message
      return 'Upload failed: ' + (typeof msg === 'string' && msg.trim() ? msg : 'Please try again.')
    }
  }
}
