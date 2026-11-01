/**
 * RC (confirmed) — "Invitation withdrawal deletes the invitation's KYC uploads."
 *
 * An agency withdraws one of its own pending invitations by deleting the
 * `hostApplications/{appId}` document (FX-12; the rules allow exactly that:
 * its own, still pending, never redeemed). Until now that removed the
 * Firestore document only: the host's reference photograph and three identity
 * documents stayed in Storage for ever, and the agency could not remove them
 * itself — `storage.rules` lets only a KYC reviewer delete under `kyc/`.
 *
 * This trigger removes them, server-side, and nothing else:
 *
 *   * only when the deleted document was a WITHDRAWN INVITATION — `pending`,
 *     never activated, never redeemed, and not a self-filed application
 *     (`applicantUid` / `source: 'self_app'`; those are the applicant's, and
 *     staff decide them). A decided, redeemed or approved application is a
 *     record of something that happened, and its files are part of it;
 *   * only the files THAT document named (`photoUrl`, `kycDocUrls`);
 *   * only under the inviting agency's own upload prefixes — the paths the
 *     Invite Host form writes: `kyc/{agencyId}/applications/` and
 *     `hostPhotos/{agencyId}/`. A URL pointing anywhere else is left alone,
 *     whoever wrote it into the document;
 *   * only from the project's default bucket (the one every reader signs
 *     from — `verification.py`), never a bucket a URL merely names;
 *   * never a file that another application or a host's verification record
 *     still references. If that cannot be established (a read fails) the file
 *     is KEPT — a stray file is a tidy-up, a deleted one in use is a broken
 *     verification.
 *
 * Logs counts only. A download URL carries an access token and the paths carry
 * an agency id; neither belongs in a log line.
 */

import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'

/** The two prefixes the Invite Host form uploads to, for one agency. */
export function invitationUploadPrefixes(agencyId: unknown): string[] {
  const id = String(agencyId ?? '').trim()
  // An id that could climb out of its own folder names no folder at all.
  if (!id || id.includes('/') || id === '.' || id === '..') return []
  return [`kyc/${id}/applications/`, `hostPhotos/${id}/`]
}

/** Was the deleted document an invitation withdrawn before anybody redeemed it? */
export function isWithdrawnInvitation(data: Record<string, unknown> | undefined | null): boolean {
  const d = data ?? {}
  const text = (v: unknown) => String(v ?? '').trim()
  if (text(d.status) !== 'pending') return false
  if (d.isActivated === true) return false
  if (text(d.activatedByUid) !== '') return false
  // A self-filed application is not an invitation (see the header).
  if (text(d.applicantUid) !== '' || text(d.source) === 'self_app') return false
  return true
}

/**
 * `{bucket, path}` behind a stored upload URL, or null when it is not one.
 *
 * Both spellings the readers accept (`verification.py::_object_name`): the
 * `getDownloadURL()` form `https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<encoded>?…`
 * and `gs://<bucket>/<path>`.
 */
export function storageObjectOf(url: unknown): { bucket: string; path: string } | null {
  const raw = String(url ?? '').trim()
  if (!raw) return null
  if (raw.startsWith('gs://')) {
    const rest = raw.slice('gs://'.length)
    const slash = rest.indexOf('/')
    if (slash <= 0) return null
    return { bucket: rest.slice(0, slash), path: rest.slice(slash + 1) }
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'firebasestorage.googleapis.com') return null
  const m = /^\/v0\/b\/([^/]+)\/o\/(.+)$/.exec(parsed.pathname)
  if (!m) return null
  let path: string
  try {
    path = decodeURIComponent(m[2])
  } catch {
    return null
  }
  return { bucket: decodeURIComponent(m[1]), path }
}

/** A path inside `prefix`, with no segment that walks back out of it. */
export function isInside(path: string, prefix: string): boolean {
  if (!path.startsWith(prefix) || path.length === prefix.length) return false
  return !path.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')
}

export type Candidate = { url: string; path: string }
export type Skipped = 'outside_prefix' | 'foreign_bucket' | 'not_an_upload'

/**
 * The files of a withdrawn invitation this trigger may consider deleting.
 * `defaultBucket` '' means "unknown": the bucket a URL names is then not
 * compared (the readers sign from the default bucket in any case).
 */
export function cleanupCandidates(
  data: Record<string, unknown> | undefined | null,
  defaultBucket: string,
): { candidates: Candidate[]; skipped: Record<Skipped, number> } {
  const skipped: Record<Skipped, number> = { outside_prefix: 0, foreign_bucket: 0, not_an_upload: 0 }
  const d = data ?? {}
  const prefixes = invitationUploadPrefixes(d.agencyId)
  const urls = [d.photoUrl, ...(Array.isArray(d.kycDocUrls) ? d.kycDocUrls : [])]
    .map((u) => String(u ?? '').trim())
    .filter((u) => u !== '')
  const seen = new Set<string>()
  const candidates: Candidate[] = []
  for (const url of urls) {
    const obj = storageObjectOf(url)
    if (!obj) { skipped.not_an_upload += 1; continue }
    if (defaultBucket && obj.bucket !== defaultBucket) { skipped.foreign_bucket += 1; continue }
    if (!prefixes.some((p) => isInside(obj.path, p))) { skipped.outside_prefix += 1; continue }
    if (seen.has(obj.path)) continue
    seen.add(obj.path)
    candidates.push({ url, path: obj.path })
  }
  return { candidates, skipped }
}

/** Does anything that still exists reference this upload? Throws when it cannot tell. */
async function stillReferenced(db: admin.firestore.Firestore, url: string): Promise<boolean> {
  const checks = [
    db.collection('hostApplications').where('photoUrl', '==', url).limit(1),
    db.collection('hostApplications').where('kycDocUrls', 'array-contains', url).limit(1),
    db.collection('hostVerification').where('agencyPhotoUrl', '==', url).limit(1),
  ]
  for (const q of checks) {
    const snap = await q.get()
    if (!snap.empty) return true
  }
  return false
}

export type CleanupOutcome = {
  considered: boolean
  deleted: number
  keptReferenced: number
  keptUnknown: number
  failed: number
  skipped: Record<Skipped, number>
}

/** The work of the trigger, separated so it can be driven directly. */
export async function cleanUpWithdrawnInvitation(
  data: Record<string, unknown> | undefined | null,
): Promise<CleanupOutcome> {
  const empty = { outside_prefix: 0, foreign_bucket: 0, not_an_upload: 0 }
  if (!isWithdrawnInvitation(data)) {
    return { considered: false, deleted: 0, keptReferenced: 0, keptUnknown: 0, failed: 0, skipped: empty }
  }
  const bucket = admin.storage().bucket()
  const { candidates, skipped } = cleanupCandidates(data, String(bucket.name ?? ''))
  const out: CleanupOutcome = { considered: true, deleted: 0, keptReferenced: 0, keptUnknown: 0, failed: 0, skipped }
  const db = admin.firestore()
  for (const c of candidates) {
    let referenced: boolean
    try {
      referenced = await stillReferenced(db, c.url)
    } catch {
      out.keptUnknown += 1
      continue
    }
    if (referenced) { out.keptReferenced += 1; continue }
    try {
      await bucket.file(c.path).delete({ ignoreNotFound: true })
      out.deleted += 1
    } catch {
      out.failed += 1
    }
  }
  return out
}

export const onHostInvitationWithdrawn = functions
  .region('asia-south1')
  .firestore.document('hostApplications/{appId}')
  .onDelete(async (snap) => {
    const out = await cleanUpWithdrawnInvitation(snap.data() as Record<string, unknown>)
    if (out.considered) {
      functions.logger.info('Withdrawn invitation: KYC uploads cleaned up.', {
        applicationId: snap.id,
        deleted: out.deleted,
        keptReferenced: out.keptReferenced,
        keptUnknown: out.keptUnknown,
        failed: out.failed,
        ...out.skipped,
      })
    }
    return null
  })
