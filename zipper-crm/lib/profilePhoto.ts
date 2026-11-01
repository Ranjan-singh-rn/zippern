/**
 * What to put in `<img src>` for a user's stored `photoUrl`.
 *
 * ── THE BUG THIS FIXES ──────────────────────────────────────────────────────
 *
 * `users/{uid}.photoUrl` does not always hold a URL. When somebody skips the
 * photo step at signup, the app writes one of twelve built-in avatars as
 *
 *     photoUrl = "avatar:fox"
 *
 * and resolves it through a Coil mapper onto a vector drawable (see
 * `DefaultAvatars.kt`). Nothing is uploaded, so there is no Storage object and
 * no URL — that is the point of the convention.
 *
 * Every CRM surface rendered the field straight into `<img src={u.photoUrl}>`.
 * A browser has no `avatar:` scheme, so it failed to load and drew the broken
 * image icon. The data was never wrong and the request never reached Storage;
 * the value simply is not a URL.
 *
 * ── WHAT THIS RETURNS ───────────────────────────────────────────────────────
 *
 *   "avatar:fox"                 → the fox, as an inline data: URL
 *   "avatar:somethingNewer"      → a deterministic member of the set
 *   "https://…" / "http://…"     → unchanged
 *   anything else non-empty      → unchanged
 *   "" / null / undefined        → null, so the caller keeps its placeholder
 *
 * Only the `avatar:` prefix is touched. An ordinary uploaded photo, a signed
 * Storage URL, a Google avatar — all pass through byte-for-byte, because the
 * only branch that rewrites anything is the one that matches the prefix.
 */

import {
  DEFAULT_AVATAR_DATA_URLS,
  DEFAULT_AVATAR_ORDER,
  DEFAULT_AVATAR_SCHEME,
} from './defaultAvatars.generated'

export { DEFAULT_AVATAR_SCHEME, DEFAULT_AVATAR_ORDER }

/** Is this stored value one of the built-in avatars rather than a URL? */
export function isDefaultAvatar(photoUrl: string | null | undefined): boolean {
  return typeof photoUrl === 'string' && photoUrl.startsWith(DEFAULT_AVATAR_SCHEME)
}

/**
 * Java's `String.hashCode`, which is what the app indexes an unrecognised id
 * with — `ALL[(id.hashCode() and 0x7fffffff) % ALL.size]`.
 *
 * Reproduced rather than approximated so the CRM shows the SAME face as the
 * app for an avatar it has never heard of. `Math.imul` because the Java
 * algorithm is 32-bit signed multiply-with-overflow and `*` in JS is not.
 */
function javaHashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i += 1) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }
  return h
}

/**
 * The data URL for a stored `avatar:` value, or null if it is not one.
 *
 * An id the CRM does not know still resolves to a face. The app does the same
 * thing and explains why: a client on an older build must not render an empty
 * circle because a newer one wrote an avatar it has never heard of. The choice
 * is stable per id, so a given unknown avatar is always the same face.
 */
export function defaultAvatarDataUrl(photoUrl: string | null | undefined): string | null {
  if (!isDefaultAvatar(photoUrl)) return null
  const id = (photoUrl as string).slice(DEFAULT_AVATAR_SCHEME.length).trim().toLowerCase()
  const known = DEFAULT_AVATAR_DATA_URLS[id]
  if (known) return known
  if (DEFAULT_AVATAR_ORDER.length === 0) return null
  const index = (javaHashCode(id) & 0x7fffffff) % DEFAULT_AVATAR_ORDER.length
  return DEFAULT_AVATAR_DATA_URLS[DEFAULT_AVATAR_ORDER[index]] ?? null
}

/**
 * The value to hand `<img src>`, or `''` when there is nothing to show.
 *
 * Empty string rather than null so that the call sites keep the exact shape
 * they already have — `{x.photoUrl ? <img src={x.photoUrl}/> : <Initials/>}`
 * becomes `{src(x.photoUrl) ? <img src={src(x.photoUrl)}/> : <Initials/>}`
 * with no type assertion and no change to the placeholder branch.
 *
 * CALLERS MUST KEEP BRANCHING ON IT. `<img src="">` re-requests the current
 * page in several browsers and then fails — which is the broken-image icon
 * again, by a different route. Every existing call site already does this;
 * the empty string is never meant to reach the DOM.
 */
export function profilePhotoSrc(photoUrl: string | null | undefined): string {
  if (typeof photoUrl !== 'string') return ''
  const trimmed = photoUrl.trim()
  if (trimmed === '') return ''
  return defaultAvatarDataUrl(trimmed) ?? trimmed
}
