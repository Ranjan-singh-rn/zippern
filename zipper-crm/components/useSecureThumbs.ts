'use client'

/**
 * One signed-URL request for a whole list of rows.
 *
 * ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────────
 *
 * `SecureDocuments` fetches one record and is right for a detail panel. On a
 * list it is one HTTP request per row, and that cost is exactly why the host
 * lists were still rendering `app.photoUrl` straight out of Firestore — the
 * secure path existed but was too expensive to adopt, so the insecure one
 * stayed. A permanent `?alt=media&token=` URL in a list view is the same
 * forever-link to somebody's face as it is on a detail page; there are just
 * fifty of them.
 *
 * This asks once for the whole page.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
 *
 * No cache across mounts. The URLs expire after fifteen minutes, so a cached
 * set is a set of broken images; a reader that returned stale links would be
 * worse than one that returns none. The request re-runs when the set of ids
 * changes, and `ids` is joined into a primitive for that comparison so a
 * caller passing a fresh array literal on every render does not loop.
 *
 * No throw on failure either. A list whose thumbnails could not be signed
 * should still render its rows — the caller falls back to initials, which is
 * what it already does for a row that has no photograph.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import api, { type DocumentKind, type SignedDocument } from '@/lib/api'

/** The most refs one request may carry. Mirrors `MAX_BATCH` in the service. */
const MAX_BATCH = 100

export interface SecureThumbs {
  /** `url(kind, id)` → a signed URL, or '' when absent or unauthorised. */
  url: (kind: DocumentKind, id: string) => string
  loading: boolean
}

/**
 * @param kind  the record kind every id belongs to
 * @param ids   the ids on the current page. Duplicates and blanks are fine.
 * @param slot  which document to sign. `'photo'` for a reference photograph.
 */
export function useSecureThumbs(
  kind: DocumentKind,
  ids: string[],
  slot: string,
): SecureThumbs {
  const [map, setMap] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)

  // A stable primitive for the dependency array, and the de-duplication the
  // server would otherwise do twice over.
  const unique = useMemo(
    () => Array.from(new Set(ids.filter(Boolean))).sort().slice(0, MAX_BATCH),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ids.filter(Boolean).sort().join(',')],
  )
  const key = unique.join(',')

  // Guards against a slow response for an earlier page overwriting a newer
  // one — the classic out-of-order resolve on a list that filters quickly.
  const latest = useRef('')

  useEffect(() => {
    if (unique.length === 0) { setMap({}); return }
    latest.current = key
    let cancelled = false
    setLoading(true)

    api.documents
      .batch(unique.map((id) => ({ kind, id })), [slot])
      .then((res) => {
        if (cancelled || latest.current !== key) return
        const next: Record<string, string> = {}
        for (const [k, docs] of Object.entries(res.documents ?? {})) {
          const hit = (docs as SignedDocument[]).find((d) => d.slot === slot && d.url)
          if (hit?.url) next[k] = hit.url
        }
        setMap(next)
      })
      .catch(() => {
        // Thumbnails are decoration on these screens. A failure here must not
        // take the list down with it; the caller renders initials instead.
        if (!cancelled && latest.current === key) setMap({})
      })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, kind, slot])

  return {
    url: (k, id) => map[`${k}:${id}`] ?? '',
    loading,
  }
}
