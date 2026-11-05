/**
 * O13 (Owner, 5 Nov 2026) — keep nudity, sexual content and abuse out of the rooms.
 *
 *   "Other applications have nudity, sexualism, vulgarities in the live and party rooms. I don't want my application
 *    like that. Make it properly monitored, and keep the people who spread these things away from our application."
 *
 * Three layers, every switch in `appConfig/safety` (the Owner's — firestore.rules), read here with safe defaults:
 *
 *   1. THE LIVE WALL. A broadcaster's phone sends one still of what it is publishing every `snapshotEverySeconds`
 *      (default 60) — `liveSnapshots/{uid}/{roomId}/{file}.jpg` in Storage, then [reportLiveSnapshot]. The room keeps
 *      its newest still (`lastSnapshotPath`), the one before it is deleted, and the CRM's live wall shows every room at
 *      once. Staff read the stills; nobody else does (storage.rules).
 *   2. THE AI CHECK — OFF until the Owner turns it on (`visionEnabled`), because Google Cloud Vision is a paid API the
 *      Owner enables in the Cloud console first. Each still is read by SafeSearch; an ADULT verdict of LIKELY or above,
 *      or RACY / VIOLENT at VERY_LIKELY, flags the room on the wall and in `safetyFlags` with the still kept as
 *      evidence — and, only if the Owner also turned on `autoEndOnAdult`, ends the room at once. When the API is off
 *      or not enabled, nothing breaks: the still is still stored and the error is recorded once per still.
 *   3. WORDS. Chat in live rooms, party rooms and direct messages is checked against the built-in list plus the
 *      Owner's own `badWords`: a hit is masked in place ("****"), the sender earns a strike, and `muteAfterStrikes`
 *      strikes inside `strikeWindowMinutes` silence them in that room (a live room's `mutedViewers`, a party room's
 *      `chatMutedUsers` — both enforced by firestore.rules) and put a flag in front of staff. The app checks the same
 *      list before sending, so a person is told before anything is posted.
 *
 * Pure parts are exported for test/safety.test.js.
 */

import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'

const db = (): admin.firestore.Firestore => admin.firestore()

// ── Configuration ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface SafetyConfig {
  /** Google Cloud Vision SafeSearch on every live still. OFF until the Owner enables the API and this switch. */
  visionEnabled: boolean
  /** End a room on an ADULT verdict without waiting for staff. OFF unless the Owner turns it on. */
  autoEndOnAdult: boolean
  /** How often a broadcaster's phone sends a still, in seconds (30–600). */
  snapshotEverySeconds: number
  /** The Owner's own words, on top of the built-in list. */
  badWords: string[]
  /** Use the built-in list too (on unless the Owner turns it off). */
  useBuiltInWords: boolean
  /** Strikes inside the window that silence a person in that room. */
  muteAfterStrikes: number
  strikeWindowMinutes: number
}

export const SAFETY_DEFAULTS: SafetyConfig = {
  visionEnabled: false,
  autoEndOnAdult: false,
  snapshotEverySeconds: 60,
  badWords: [],
  useBuiltInWords: true,
  muteAfterStrikes: 3,
  strikeWindowMinutes: 60,
}

const clamp = (n: unknown, lo: number, hi: number, dflt: number): number => {
  const v = Number(n)
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt
}

/** `appConfig/safety` as stored → a config every caller can trust. Pure. */
export function sanitizeSafetyConfig(raw: Record<string, unknown> | undefined | null): SafetyConfig {
  const r = raw ?? {}
  const words = Array.isArray(r.badWords) ? r.badWords : []
  return {
    visionEnabled: r.visionEnabled === true,
    autoEndOnAdult: r.autoEndOnAdult === true,
    snapshotEverySeconds: clamp(r.snapshotEverySeconds, 30, 600, SAFETY_DEFAULTS.snapshotEverySeconds),
    badWords: words.map((w) => String(w ?? '').trim().toLowerCase()).filter((w) => w.length >= 2 && w.length <= 40).slice(0, 500),
    useBuiltInWords: r.useBuiltInWords !== false,
    muteAfterStrikes: clamp(r.muteAfterStrikes, 1, 20, SAFETY_DEFAULTS.muteAfterStrikes),
    strikeWindowMinutes: clamp(r.strikeWindowMinutes, 5, 24 * 60, SAFETY_DEFAULTS.strikeWindowMinutes),
  }
}

let cached: { at: number; config: SafetyConfig } | null = null
/** The config, re-read at most once a minute per instance. */
export async function safetyConfig(): Promise<SafetyConfig> {
  if (cached && Date.now() - cached.at < 60_000) return cached.config
  const snap = await db().collection('appConfig').doc('safety').get()
  const config = sanitizeSafetyConfig(snap.exists ? (snap.data() as Record<string, unknown>) : null)
  cached = { at: Date.now(), config }
  return config
}
/** Tests only: forget the cached config. */
export function _resetSafetyCache(): void { cached = null }

// ── Words ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The built-in list: explicit sexual terms and the commonest abuse, in English, Hinglish and Hindi. Deliberately
 * short and unambiguous — every entry is a word nobody needs in a public room. The Owner extends it in the CRM.
 */
export const BUILTIN_BAD_WORDS: readonly string[] = [
  // English — sexual / explicit
  'fuck', 'fucker', 'fucking', 'motherfucker', 'cunt', 'pussy', 'dick', 'cock', 'boobs', 'tits', 'nude', 'nudes',
  'naked', 'porn', 'xxx', 'sex', 'sexchat', 'horny', 'blowjob', 'handjob', 'whore', 'slut', 'bitch', 'bastard',
  // Hinglish
  'madarchod', 'maderchod', 'behenchod', 'bhenchod', 'bhanchod', 'chutiya', 'chutiye', 'chutia', 'bhosdike',
  'bhosdi', 'bhosda', 'gandu', 'gaandu', 'lund', 'lauda', 'lawda', 'randi', 'chut', 'gaand', 'harami', 'chodna',
  'chudai', 'nangi',
  // Hindi
  'मादरचोद', 'बहनचोद', 'चूतिया', 'भोसड़ी', 'भोसड़ीके', 'गांडू', 'लंड', 'रंडी', 'चूत', 'गांड', 'हरामी', 'नंगी', 'चुदाई',
]

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' }

/** Lower-case, leetspeak undone, every run of anything that is not a letter → one space. Pure. */
export function normalizeForMatch(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKC')
    .split('').map((ch) => LEET[ch] ?? ch).join('')
    .replace(/[^\p{L}\p{M}]+/gu, ' ')
    .trim()
}

/** Runs of one letter folded to one ("fuuuck" → "fuck", "boooobs" → "bobs") — compared on both sides. Pure. */
/** Words this long or longer also match inside squeezed-together text. */
export const SQUEEZE_MIN = 6

export function foldRepeats(s: string): string {
  return s.replace(/(\p{L})\1+/gu, '$1')
}

/**
 * The words of [list] that [text] contains. A word matches a whole token (letters repeated or not); spaced-out single
 * letters are read as one token ("f u c k"); a word of six letters or more also matches inside the text with its
 * separators squeezed out ("b.h.o.s.d.i.k.e") — shorter words never do, so "Dickens" holds no "dick", "Sussex" no
 * "sex" and "grandiose" no "randi". Pure.
 */
export function findBadWords(text: string, list: readonly string[]): string[] {
  const norm = normalizeForMatch(text)
  if (!norm) return []
  const parts = norm.split(' ')
  const tokens = new Set(parts.map(foldRepeats))
  // Runs of single letters, read as one word.
  let run = ''
  for (const p of [...parts, '']) {
    if (p.length === 1) { run += p; continue }
    if (run.length >= 2) tokens.add(foldRepeats(run))
    run = ''
  }
  const squeezed = foldRepeats(norm.replace(/ /g, ''))
  const hits: string[] = []
  for (const raw of list) {
    const w = normalizeForMatch(raw).replace(/ /g, '')
    if (!w) continue
    const f = foldRepeats(w)
    if (tokens.has(f) || (w.length >= SQUEEZE_MIN && squeezed.includes(f))) hits.push(w)
  }
  return Array.from(new Set(hits))
}

/** [text] with every token that is one of [hits] (or contains a long one) replaced by asterisks. Pure. */
export function maskText(text: string, hits: readonly string[]): string {
  if (hits.length === 0) return text
  const folded = hits.map(foldRepeats)
  const masked = String(text).replace(/[^\s]+/g, (word) => {
    const n = foldRepeats(normalizeForMatch(word).replace(/ /g, ''))
    const bad = folded.some((h) => n === h || (h.length >= SQUEEZE_MIN && n.includes(h)))
    return bad ? '*'.repeat(Math.min(Math.max(word.length, 3), 12)) : word
  })
  // Spaced-out letters ("f u c k") have no single word to mask: the whole message goes.
  return masked === text ? '*'.repeat(Math.min(Math.max(text.trim().length, 3), 24)) : masked
}

export function wordListOf(config: SafetyConfig): string[] {
  return Array.from(new Set([...(config.useBuiltInWords ? BUILTIN_BAD_WORDS : []), ...config.badWords]))
}

// ── SafeSearch ────────────────────────────────────────────────────────────────────────────────────────────────────

const LIKELIHOOD = ['UNKNOWN', 'VERY_UNLIKELY', 'UNLIKELY', 'POSSIBLE', 'LIKELY', 'VERY_LIKELY'] as const
type Likelihood = typeof LIKELIHOOD[number]
const rank = (l: unknown): number => Math.max(0, LIKELIHOOD.indexOf(String(l ?? 'UNKNOWN') as Likelihood))

export interface SafeSearchVerdict {
  flag: boolean
  /** The worst category that crossed its line, or null. */
  level: 'adult' | 'racy' | 'violence' | null
}

/** SafeSearch's annotation → a verdict: adult ≥ LIKELY, racy or violence = VERY_LIKELY. Pure. */
export function safeSearchVerdict(a: { adult?: unknown; racy?: unknown; violence?: unknown } | null | undefined): SafeSearchVerdict {
  if (!a) return { flag: false, level: null }
  if (rank(a.adult) >= rank('LIKELY')) return { flag: true, level: 'adult' }
  if (rank(a.racy) >= rank('VERY_LIKELY')) return { flag: true, level: 'racy' }
  if (rank(a.violence) >= rank('VERY_LIKELY')) return { flag: true, level: 'violence' }
  return { flag: false, level: null }
}

/** Cloud Vision SafeSearch on a Storage object. Throws with Vision's own message when the API refuses. */
async function safeSearch(gcsUri: string): Promise<Record<string, unknown>> {
  const token = await admin.credential.applicationDefault().getAccessToken()
  const res = await fetch('https://vision.googleapis.com/v1/images:annotate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ image: { source: { gcsImageUri: gcsUri } }, features: [{ type: 'SAFE_SEARCH_DETECTION' }] }] }),
  })
  const body = await res.json() as Record<string, any>
  const first = Array.isArray(body?.responses) ? body.responses[0] : null
  if (!res.ok || first?.error) {
    throw new Error(String(first?.error?.message ?? body?.error?.message ?? `Vision answered ${res.status}`))
  }
  return (first?.safeSearchAnnotation ?? {}) as Record<string, unknown>
}

/** Tests replace the Vision call; production never does. */
export const vision = { safeSearch }

// ── Live stills ───────────────────────────────────────────────────────────────────────────────────────────────────

/** `liveSnapshots/{uid}/{roomId}/{name}.jpg`, by its own owner and room — or null. Pure. */
export function snapshotPathFor(path: unknown, uid: string, roomId: string): string | null {
  const p = String(path ?? '')
  const m = /^liveSnapshots\/([^/]+)\/([^/]+)\/([A-Za-z0-9_.-]{1,80}\.jpe?g)$/.exec(p)
  if (!m || m[1] !== uid || m[2] !== roomId) return null
  return p
}

/**
 * Callable, from the broadcaster's phone: `{ roomId, path }` after uploading a still. Keeps it as the room's newest,
 * deletes the one before, and — when the Owner has the AI check on — reads it with SafeSearch. Answers
 * `{ next }` (seconds to the next still) and `ended` when an automatic end closed the room.
 */
export const reportLiveSnapshot = functions
  .region('asia-south1')
  .https.onCall(async (data: { roomId?: unknown; path?: unknown }, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in first.')
    const uid = context.auth.uid
    const roomId = typeof data?.roomId === 'string' ? data.roomId.trim() : ''
    const path = snapshotPathFor(data?.path, uid, roomId)
    if (!roomId || !path) throw new functions.https.HttpsError('invalid-argument', 'Not a still of your own room.')

    const roomRef = db().collection('liveRooms').doc(roomId)
    const room = await roomRef.get()
    if (!room.exists || room.get('hostUid') !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Only the broadcaster sends stills of a room.')
    }
    const config = await safetyConfig()
    if (room.get('isActive') === false) return { next: config.snapshotEverySeconds, ended: true }

    const bucket = admin.storage().bucket()
    const [exists] = await bucket.file(path).exists()
    if (!exists) throw new functions.https.HttpsError('not-found', 'The still was not uploaded.')

    const previous = String(room.get('lastSnapshotPath') ?? '')
    const update: Record<string, unknown> = {
      lastSnapshotPath: path,
      lastSnapshotAt: admin.firestore.FieldValue.serverTimestamp(),
    }

    let verdict: SafeSearchVerdict = { flag: false, level: null }
    if (config.visionEnabled) {
      try {
        const annotation = await vision.safeSearch(`gs://${bucket.name}/${path}`)
        verdict = safeSearchVerdict(annotation)
        update.lastSafeSearch = { adult: annotation.adult ?? 'UNKNOWN', racy: annotation.racy ?? 'UNKNOWN', violence: annotation.violence ?? 'UNKNOWN' }
      } catch (e) {
        // The API is off, not enabled, or out of quota: the still is kept for the wall and the reason is on the room.
        update.lastSafeSearchError = String((e as Error)?.message ?? e).slice(0, 300)
        functions.logger.warn('safety: SafeSearch failed', { roomId, error: update.lastSafeSearchError })
      }
    }

    let ended = false
    if (verdict.flag) {
      update.safetyFlag = { level: verdict.level, path, at: admin.firestore.FieldValue.serverTimestamp() }
      await db().collection('safetyFlags').add({
        kind: 'live_still', level: verdict.level, roomId, hostUid: uid, path, status: 'open',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      })
      if (config.autoEndOnAdult && verdict.level === 'adult') {
        ended = true
        Object.assign(update, {
          isActive: false,
          endedAt: admin.firestore.FieldValue.serverTimestamp(),
          endedByStaff: true,
          endedBy: { uid: 'system', name: 'ZIPPER safety' },
          endReason: 'Ended automatically: explicit content was detected on camera.',
        })
      }
    }
    await roomRef.update(update)

    // Only the newest still is kept — unless the one before is evidence on a flag.
    const flaggedPath = String((room.get('safetyFlag') as Record<string, unknown> | undefined)?.path ?? '')
    if (previous && previous !== path && previous !== flaggedPath && snapshotPathFor(previous, uid, roomId)) {
      await bucket.file(previous).delete().catch(() => undefined)
    }
    return { next: config.snapshotEverySeconds, ended, flagged: verdict.flag }
  })

// ── Chat ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A person's strikes inside the window, after this one; `muted` when it reaches the line. Pure. */
export function nextStrikes(prev: { count?: unknown; windowStart?: unknown } | undefined, nowMs: number, config: SafetyConfig):
  { count: number; windowStart: number; muted: boolean } {
  const start = Number(prev?.windowStart ?? 0) || 0
  const fresh = !start || nowMs - start > config.strikeWindowMinutes * 60_000
  const count = (fresh ? 0 : Number(prev?.count ?? 0) || 0) + 1
  return { count, windowStart: fresh ? nowMs : start, muted: count >= config.muteAfterStrikes }
}

type ChatPlace = { kind: 'live' | 'party' | 'dm'; roomId: string; field: 'message' | 'text'; senderField: 'uid' | 'senderUid' }

async function screenMessage(snap: functions.firestore.QueryDocumentSnapshot, place: ChatPlace): Promise<void> {
  const data = snap.data()
  if (data.isJoin === true || data.masked === true) return
  if (place.kind === 'dm' && String(data.type ?? 'text') !== 'text') return
  const text = String(data[place.field] ?? '')
  if (!text) return
  const config = await safetyConfig()
  const hits = findBadWords(text, wordListOf(config))
  if (hits.length === 0) return

  const sender = String(data[place.senderField] ?? '')
  await snap.ref.update({ [place.field]: maskText(text, hits), masked: true })
  if (!sender) return

  const strikeRef = db().collection('safetyStrikes').doc(sender)
  const strikes = await db().runTransaction(async (tx) => {
    const prev = await tx.get(strikeRef)
    const next = nextStrikes(prev.exists ? prev.data() : undefined, Date.now(), config)
    tx.set(strikeRef, { count: next.count, windowStart: next.windowStart, lastAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true })
    return next
  })
  if (!strikes.muted) return

  if (place.kind === 'live') {
    await db().collection('liveRooms').doc(place.roomId)
      .update({ mutedViewers: admin.firestore.FieldValue.arrayUnion(sender) }).catch(() => undefined)
  } else if (place.kind === 'party') {
    await db().collection('partyRooms').doc(place.roomId)
      .update({ chatMutedUsers: admin.firestore.FieldValue.arrayUnion(sender) }).catch(() => undefined)
  }
  await db().collection('safetyFlags').add({
    kind: `${place.kind}_chat`, level: 'words', roomId: place.roomId, uid: sender, words: hits.slice(0, 10),
    strikes: strikes.count, muted: place.kind !== 'dm', status: 'open',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  })
}

export const screenLiveComment = functions.region('asia-south1').firestore
  .document('liveRooms/{roomId}/comments/{commentId}')
  .onCreate((snap, ctx) => screenMessage(snap, { kind: 'live', roomId: ctx.params.roomId, field: 'message', senderField: 'uid' }))

export const screenPartyMessage = functions.region('asia-south1').firestore
  .document('partyRooms/{roomId}/messages/{messageId}')
  .onCreate((snap, ctx) => screenMessage(snap, { kind: 'party', roomId: ctx.params.roomId, field: 'text', senderField: 'senderUid' }))

export const screenDirectMessage = functions.region('asia-south1').firestore
  .document('conversations/{convoId}/messages/{messageId}')
  .onCreate((snap, ctx) => screenMessage(snap, { kind: 'dm', roomId: ctx.params.convoId, field: 'text', senderField: 'senderUid' }))
