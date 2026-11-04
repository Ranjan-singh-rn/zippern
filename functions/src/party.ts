/**
 * Party rooms — several people on seats, talking to a room of listeners.
 *
 * ── WHAT CHANGED IN THE REBUILD, AND WHY ─────────────────────────────────────
 *
 * The first version modelled the room owner as "seat 0, implicit, no document".
 * That one decision caused most of the defects that followed. The owner had no
 * seat row, so their mute and camera state lived only in their own phone's
 * memory — a muted owner appeared muted to nobody but themselves. They had no
 * `agoraUid`, so every other client found their video by ELIMINATION: take the
 * first publisher whose uid is not a seat index. And they could not stand up,
 * because there was no seat to stand up from.
 *
 * The owner now takes an ordinary seat, like anyone else, and every seat starts
 * empty. `hostUid` says who owns the room; a seat says who is talking. Those are
 * different questions and conflating them is what went wrong.
 *
 * ── WHY SEATS ARE CALLABLES AND NOT CLIENT WRITES ────────────────────────────
 *
 * A seat is two things at once: a contended resource, and a publisher slot on an
 * Agora channel. Neither is something a client may assert for itself.
 *
 * Contention is handled with a document per seat (`seats/{index}`) inside a
 * transaction — two people tapping the same empty seat resolve as one winner and
 * one `already-exists`, where an array field would have produced two writes that
 * each believed they had won.
 *
 * The publisher slot is handled in `generateAgoraToken`, which reads the seat
 * documents and issues PUBLISHER only to someone currently sitting on one.
 * Without that, "leave the seat" would be a UI state a patched client could
 * ignore while carrying on broadcasting into the room.
 *
 * ── SEAT COUNTS ARE A DEVICE BUDGET, NOT A PREFERENCE ────────────────────────
 *
 * An audio seat is one Opus stream, a few kilobits, decoded by a codec every
 * Android phone has had for a decade. A video seat is a decoded video stream,
 * and the number a budget SoC can composite before it drops frames is small. So
 * the allowed counts are enumerated rather than free, and enforced here, because
 * the failure mode of getting it wrong is not a slow room — it is a room that
 * takes the phone down.
 */
import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'
import * as crypto from 'crypto'
import { assertActiveSession } from './mobileSession'
import { privateRoomGate } from './partySubscription'

const db = admin.firestore()

export const MODE_AUDIO = 'audio'
export const MODE_VIDEO = 'video'

/**
 * The seat counts a room may have, per mode. First entry is the default.
 *
 * Audio tops out at 15 and video at 10 because that is where the decode budget
 * on the phones this ships to runs out. A room cannot be configured past these,
 * from the client or from the CRM.
 */
export const SEAT_CHOICES: Record<string, number[]> = {
  [MODE_AUDIO]: [10, 15],
  [MODE_VIDEO]: [6, 10],
}

export const SEAT_MODE_FREE = 'free'
export const SEAT_MODE_CONSENT = 'consent'

export const VISIBILITY_PUBLIC = 'public'
export const VISIBILITY_PRIVATE = 'private'

/**
 * B7 (3 Nov 2026): room backgrounds. Zipper's own designs, drawn by the app from these ids — the server keeps the
 * list so a room can only carry a theme every app knows how to draw.
 */
export const ROOM_THEMES = ['classic', 'sunset', 'ocean', 'forest', 'royal', 'neon', 'rose'] as const
export function themeOf(raw: unknown): string {
  const t = String(raw ?? '')
  return (ROOM_THEMES as readonly string[]).includes(t) ? t : 'classic'
}

// QA #21 (4 Nov 2026): a sentence, not a lower-case fragment. The app shows the same text (PartyRoom.DEFAULT_WELCOME).
export const DEFAULT_WELCOME = 'Welcome to my room. Have fun!'
const WELCOME_MAX = 250

/**
 * Longest a room may sit with NOBODY in it — no one on a seat AND no one in the lobby — before it may be closed.
 *
 * B2a (3 Nov 2026): this used to start the moment the last SEAT emptied, and every client still watching closed
 * the room two seconds later — including people listening in the lobby, who were thrown out of a room they were
 * still in. A room is now empty only when nobody is present at all.
 */
const EMPTY_GRACE_MS = 2_000

/**
 * A listener whose app has not said "still here" for this long is gone (killed process, dead network).
 *
 * The app calls `partyHeartbeat` every [PARTY_HEARTBEAT_EVERY_MS]; three missed beats is a person who left
 * without leaving. `sweepEmptyPartyRooms` removes them — and any seat they held — so a crashed phone can no longer
 * keep a room open for ever, now that lobby presence keeps rooms alive.
 */
export const LISTENER_STALE_MS = 3 * 60 * 1000
export const PARTY_HEARTBEAT_EVERY_MS = 60 * 1000
/** A listener row from before heartbeats (no `lastSeenAt`) is judged by `joinedAt`, with a longer fuse. */
export const LEGACY_LISTENER_STALE_MS = 6 * 60 * 60 * 1000

/** When this listener row last showed signs of life: the heartbeat, else the join. */
export function listenerLastSeenMs(row: { lastSeenAt?: unknown; joinedAt?: unknown }): number {
  const ms = (v: unknown): number =>
    v instanceof admin.firestore.Timestamp ? v.toMillis() : typeof v === 'number' && Number.isFinite(v) ? v : 0
  return ms(row.lastSeenAt) || ms(row.joinedAt)
}

/** Is this listener row stale at [nowMs]? A row with a heartbeat uses the short fuse, a legacy row the long one. */
export function listenerIsStale(row: { lastSeenAt?: unknown; joinedAt?: unknown }, nowMs: number): boolean {
  const seen = listenerLastSeenMs(row)
  if (!seen) return true
  const fuse = row.lastSeenAt != null ? LISTENER_STALE_MS : LEGACY_LISTENER_STALE_MS
  return nowMs - seen >= fuse
}

/**
 * Is the room empty once this change lands? Both counts are what remains AFTER it.
 *
 * Pure, so the rule the whole lifecycle hangs on can be tested on its own: seats alone never decide it.
 */
export function roomIsEmpty(remainingSeated: number, remainingListeners: number): boolean {
  return remainingSeated <= 0 && remainingListeners <= 0
}

function modeOf(raw: unknown): string {
  return raw === MODE_VIDEO ? MODE_VIDEO : MODE_AUDIO
}

/** The seat count for a mode, snapped to an allowed value. */
export function seatsFor(mode: string, requested?: unknown): number {
  const allowed = SEAT_CHOICES[modeOf(mode)]
  const n = Number(requested)
  return allowed.includes(n) ? n : allowed[0]
}

function requireAuth(context: functions.https.CallableContext): string {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.')
  }
  return context.auth.uid
}

// ── The welcome message, and why it is validated at all ───────────────────────

/**
 * Digits are refused outright.
 *
 * Not for tidiness. The welcome message is the first thing every visitor reads,
 * it is set once by the owner and shown to everybody, and that makes it the most
 * valuable advertising space in the room. Left free, it fills with WhatsApp
 * numbers and Telegram handles — traffic leaving the platform, and every one of
 * those contacts is a person moved somewhere with no moderation, no reporting
 * and no way to help them if it goes wrong. Refusing digits is a blunt rule that
 * removes the whole category.
 */
const DIGITS = /[0-9٠-٩۰-۹०-९]/

/**
 * A small built-in list, extended by `appConfig/moderation.blockedWords`.
 *
 * Deliberately short and deliberately not exhaustive — a word list is a weak
 * filter that catches the lazy case, and the real backstop is that anyone in the
 * room can report the owner. Kept in the CRM so it can be tuned for the
 * languages this actually ships to without a release.
 */
const BUILTIN_BLOCKED = ['fuck', 'shit', 'bitch', 'bastard', 'randi', 'madarchod', 'bhosdi', 'chutiya']

let blockedCache: { words: string[]; at: number } | null = null

async function blockedWords(): Promise<string[]> {
  const TEN_MINUTES = 10 * 60 * 1000
  if (blockedCache && Date.now() - blockedCache.at < TEN_MINUTES) return blockedCache.words
  try {
    const snap = await db.collection('appConfig').doc('moderation').get()
    const extra = snap.get('blockedWords')
    const words = Array.isArray(extra)
      ? [...BUILTIN_BLOCKED, ...extra.map((w) => String(w).toLowerCase().trim()).filter(Boolean)]
      : BUILTIN_BLOCKED
    blockedCache = { words, at: Date.now() }
    return words
  } catch {
    // A config read failure must not stop a room opening. Fall back to the
    // built-in list rather than to no filter, and rather than to an error.
    return BUILTIN_BLOCKED
  }
}

/**
 * Validates and returns a welcome message, or throws with a reason a person can
 * act on.
 *
 * Empty is refused rather than defaulted when the owner is EDITING — the client
 * disables Save on an empty field, and a server that silently substituted the
 * default would make that disagreement invisible. At create time an empty value
 * means "not supplied", which is different, and gets the default.
 */
async function cleanWelcome(raw: unknown, { allowEmpty }: { allowEmpty: boolean }): Promise<string> {
  const text = String(raw ?? '').trim()
  if (text === '') {
    if (allowEmpty) return DEFAULT_WELCOME
    throw new functions.https.HttpsError('invalid-argument', 'The welcome message cannot be empty.')
  }
  if (text.length > WELCOME_MAX) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      `Keep the welcome message under ${WELCOME_MAX} characters.`,
    )
  }
  if (DIGITS.test(text)) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'The welcome message cannot contain numbers.',
    )
  }
  const lower = text.toLowerCase()
  const words = await blockedWords()
  const hit = words.find((w) => w.length > 2 && lower.includes(w))
  if (hit) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Please take the offensive language out of the welcome message.',
    )
  }
  return text
}

// ── Private rooms ────────────────────────────────────────────────────────────

/**
 * A four-digit password, salted and hashed — in a document NO CLIENT CAN READ.
 *
 * ── F-7 (audit 2026-11-01): the hash used to sit on the room document ────────
 *
 * Four digits is ten thousand combinations. A salted SHA-256 of one is not a
 * secret, it is a puzzle that takes a laptop under a second: anyone who could
 * read `passwordHash` and `passwordSalt` could recover the PIN offline and
 * `joinPartyRoom` would then admit them. And everyone could read them —
 * `partyRooms/{id}` is `allow read: if request.auth != null`, because the room
 * list needs the title and the seat counts of private rooms too.
 *
 * So the secret now lives in `partyRooms/{id}/private/secret`. No rule matches
 * that path, and firestore.rules ends in `match /{document=**} { allow read,
 * write: if false }`, so it is server-only without a rules change. The room
 * document keeps only `passwordAttempts` (a count) and `visibility`.
 *
 * The hash is still what makes "the server is the only thing that can check
 * it" true even for somebody holding a Firestore export; the attempt counter is
 * what makes online guessing visible. Neither pretends four digits are strong.
 *
 * ── Rooms created before this (migration) ────────────────────────────────────
 *
 * A room opened by the previous build still carries its hash on the room
 * document. It is honoured from there until the room closes — a live room
 * must not lock its own members out on deploy — and moved into the secret
 * document on the first successful join or the owner's next password edit;
 * the legacy fields are deleted in the same write. `closeRoom` deletes the
 * secret document, so a closed room holds nothing. Rooms that closed BEFORE
 * this build still carry their legacy fields; a one-off Admin SDK sweep over
 * `partyRooms where isActive == false` that deletes `passwordHash` and
 * `passwordSalt` finishes the migration (PINs of closed rooms open nothing,
 * so this is hygiene, not urgency).
 */
function hashPassword(password: string, salt: string): string {
  return crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex')
}

/** The server-only subcollection and document that hold a room's secret. */
export const PRIVATE_SUBCOLLECTION = 'private'
export const PRIVATE_SECRET_DOC = 'secret'

function secretRefOf(roomRef: admin.firestore.DocumentReference): admin.firestore.DocumentReference {
  return roomRef.collection(PRIVATE_SUBCOLLECTION).doc(PRIVATE_SECRET_DOC)
}

/** A fresh salt and the hash of this password under it. */
function secretFor(password: string): { passwordHash: string; passwordSalt: string } {
  const passwordSalt = crypto.randomBytes(16).toString('hex')
  return { passwordHash: hashPassword(password, passwordSalt), passwordSalt }
}

/** The pre-F-7 fields on a room document, if that room still carries them. */
function legacySecretOf(
  room: admin.firestore.DocumentSnapshot,
): { passwordHash: string; passwordSalt: string } | null {
  const passwordHash = String(room.get('passwordHash') ?? '')
  const passwordSalt = String(room.get('passwordSalt') ?? '')
  return passwordHash ? { passwordHash, passwordSalt } : null
}

/** Removes the legacy fields from a room document, in whatever write carries it. */
function legacySecretCleared(): Record<string, unknown> {
  return {
    passwordHash: admin.firestore.FieldValue.delete(),
    passwordSalt: admin.firestore.FieldValue.delete(),
  }
}

/**
 * Pure: does `given` open a room whose secret is `secret`? Constant-time on
 * the hash comparison; false for a room with no secret at all.
 */
export function passwordMatches(
  given: unknown,
  secret: { passwordHash?: unknown; passwordSalt?: unknown } | null | undefined,
): boolean {
  const hash = String(secret?.passwordHash ?? '')
  const salt = String(secret?.passwordSalt ?? '')
  const password = String(given ?? '')
  if (!hash || !password) return false
  const expected = Buffer.from(hashPassword(password, salt), 'hex')
  const stored = Buffer.from(hash, 'hex')
  return expected.length === stored.length && crypto.timingSafeEqual(expected, stored)
}

function validPassword(raw: unknown): string {
  const s = String(raw ?? '').trim()
  if (!/^[0-9]{4}$/.test(s)) {
    throw new functions.https.HttpsError('invalid-argument', 'The room password must be 4 digits.')
  }
  return s
}

/**
 * The wrong-PIN refusal, thrown INSIDE the join transaction and counted
 * OUTSIDE it. A transaction that throws is rolled back, writes included — so
 * the old `tx.update(passwordAttempts + 1)` followed by a throw never
 * incremented anything. The counter is now written after the rollback.
 */
const WRONG_PASSWORD = 'PARTY_WRONG_PASSWORD'
function wrongPassword(): functions.https.HttpsError {
  return new functions.https.HttpsError('permission-denied', 'That password is not right.', { code: WRONG_PASSWORD })
}
function isWrongPassword(err: unknown): boolean {
  return (err as { details?: { code?: unknown } } | null)?.details?.code === WRONG_PASSWORD
}

// ── B7 (3 Nov 2026): per-person PIN lockout, the access log, official access ─
//
// The room's own `passwordAttempts` counter makes guessing VISIBLE but stops nobody (deliberately: locking a room
// because a stranger guessed at it would hand any passer-by a way to shut it). What stops a guesser is a lockout
// on the GUESSER: five wrong PINs for one room inside fifteen minutes and that account is refused for that room
// for fifteen minutes — before its PIN is even compared. Four digits is still ten thousand combinations; at five
// tries a quarter-hour a script needs weeks per room, and the owner sees every miss in the access log.
//
// Official access: Zipper staff whose CRM record allows it (the Owner, or `privateRoomAccess: true` on an active
// staff record) may enter a private room without its PIN — for moderation. It is never silent: the entry is in
// the room's access log, the listener row says `official`, and the room shows it.

export const PIN_MAX_MISSES = 5
export const PIN_WINDOW_MS = 15 * 60_000
export const PIN_LOCK_MS = 15 * 60_000
const PIN_LOCKED = 'PARTY_PIN_LOCKED'

export interface PinMisses { count: number; windowStartMs: number; lockedUntilMs: number }

/** Pure: is this person locked out of this room now, and for how long. */
export function pinLockState(raw: Partial<PinMisses> | undefined, nowMs: number): { locked: boolean; retryAfterMs: number } {
  const until = Number(raw?.lockedUntilMs ?? 0) || 0
  return until > nowMs ? { locked: true, retryAfterMs: until - nowMs } : { locked: false, retryAfterMs: 0 }
}

/** Pure: the misses after one more wrong PIN — a new window when the old one has passed; a lock at the limit. */
export function nextPinMisses(raw: Partial<PinMisses> | undefined, nowMs: number): PinMisses {
  const start = Number(raw?.windowStartMs ?? 0) || 0
  const fresh = !start || nowMs - start > PIN_WINDOW_MS
  const count = (fresh ? 0 : Number(raw?.count ?? 0) || 0) + 1
  const windowStartMs = fresh ? nowMs : start
  return { count, windowStartMs, lockedUntilMs: count >= PIN_MAX_MISSES ? nowMs + PIN_LOCK_MS : Number(raw?.lockedUntilMs ?? 0) || 0 }
}

function pinLocked(retryAfterMs: number): functions.https.HttpsError {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000))
  return new functions.https.HttpsError(
    'resource-exhausted',
    `Too many wrong PINs for this room. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    { code: PIN_LOCKED, retryAfterMs },
  )
}
function isPinLocked(err: unknown): boolean {
  return (err as { details?: { code?: unknown } } | null)?.details?.code === PIN_LOCKED
}

/** Staff whose CRM record allows them into private rooms (the Owner always). */
export function officialAccessOf(crm: Record<string, unknown> | undefined): { allowed: boolean; role: string } {
  const role = String(crm?.role ?? '')
  if (!crm || crm.isActive === false || crm.disabled === true) return { allowed: false, role }
  if (role === 'superadmin') return { allowed: true, role }
  const staff = /^(app|ops|support|tech|finance|marketing)_(admin|member)$/.test(role)
  return { allowed: staff && crm.privateRoomAccess === true, role }
}

function accessLogRef(roomRef: admin.firestore.DocumentReference): admin.firestore.DocumentReference {
  return roomRef.collection('accessLog').doc()
}

// ── Roles inside a room ──────────────────────────────────────────────────────

type RoomRole = 'owner' | 'admin' | 'member'

function roleOf(room: admin.firestore.DocumentSnapshot, uid: string): RoomRole {
  if (room.get('hostUid') === uid) return 'owner'
  const admins: string[] = room.get('admins') ?? []
  return admins.includes(uid) ? 'admin' : 'member'
}

function requireOwner(room: admin.firestore.DocumentSnapshot, uid: string): void {
  if (roleOf(room, uid) !== 'owner') {
    throw new functions.https.HttpsError('permission-denied', 'Only the room owner can do that.')
  }
}

function requireHostOrAdmin(room: admin.firestore.DocumentSnapshot, uid: string): RoomRole {
  const role = roleOf(room, uid)
  if (role === 'member') {
    throw new functions.https.HttpsError('permission-denied', 'Only the owner or an admin can do that.')
  }
  return role
}

function requireLiveRoom(snap: admin.firestore.DocumentSnapshot): void {
  if (!snap.exists || snap.get('isActive') === false) {
    throw new functions.https.HttpsError('not-found', 'This room has closed.')
  }
}

function refuseIfKicked(room: admin.firestore.DocumentSnapshot, uid: string): void {
  const kicked: string[] = room.get('kickedUsers') ?? []
  if (kicked.includes(uid)) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'You were removed from this room by the host.',
    )
  }
}

async function requireUser(uid: string): Promise<admin.firestore.DocumentSnapshot> {
  const snap = await db.collection('users').doc(uid).get()
  if (!snap.exists) {
    throw new functions.https.HttpsError('not-found', 'No profile for this account.')
  }
  if (snap.get('isBanned') === true) {
    throw new functions.https.HttpsError('permission-denied', 'This account is suspended.')
  }
  return snap
}

const presence = (roomId: string) => ({ isInParty: roomId !== '', partyRoomId: roomId })

/**
 * The cosmetics a person is wearing, resolved from item ids to asset URLs.
 *
 * ── WHY THE SERVER DOES THIS LOOKUP ──────────────────────────────────────────
 *
 * An entrance effect is a video clip, so playing one means knowing
 * `bagItems/{id}.videoUrl`. Writing only the item id onto the listener row
 * pushes that lookup onto every client that sees the arrival — a room of forty
 * is forty reads of the same document, per person who walks in, and avoiding
 * exactly that is the whole reason these fields are denormalised rather than
 * joined.
 *
 * Failures are swallowed to empty strings on purpose. A missing entrance clip
 * costs an animation; an exception here would cost the join.
 */
async function resolveCosmetics(
  userSnap: admin.firestore.DocumentSnapshot,
): Promise<Record<string, string>> {
  const entranceId = String(userSnap.get('equippedEntrance') ?? '')
  const idFrameId  = String(userSnap.get('equippedIdFrame') ?? '')

  const out: Record<string, string> = {
    entranceItemId: entranceId,
    idFrameItemId: idFrameId,
    entranceVideoUrl: '',
    entrancePosterUrl: '',
    // B13: an SVGA entrance (tools/decor) — played over the room with the arriving user's photo and name.
    entranceSvgaUrl: '',
    idFrameUrl: '',
  }

  const ids = [entranceId, idFrameId].filter((id) => id !== '')
  if (ids.length === 0) return out

  try {
    const snaps = await db.getAll(...ids.map((id) => db.collection('bagItems').doc(id)))
    for (const snap of snaps) {
      if (!snap.exists) continue
      if (snap.id === entranceId) {
        out.entranceVideoUrl = String(snap.get('videoUrl') ?? '')
        out.entranceSvgaUrl = String(snap.get('svgaUrl') ?? '')
        // `previewUrl` is what the CRM calls the still frame; it is the poster
        // the player shows until the first video frame decodes.
        out.entrancePosterUrl = String(snap.get('previewUrl') ?? snap.get('imageUrl') ?? '')
      }
      if (snap.id === idFrameId) {
        out.idFrameUrl = String(snap.get('imageUrl') ?? snap.get('previewUrl') ?? '')
      }
    }
  } catch {
    // Leave the URLs empty. See the note above.
  }
  return out
}

// ── createPartyRoom ──────────────────────────────────────────────────────────

/**
 * Open a party room.
 *
 * ANY signed-in account may open one, audio or video. This is deliberately a
 * different rule from going live, which is verified hosts only.
 *
 * The two are different products. A live room is one person broadcasting to an
 * audience and earning from it, so it carries a verification gate, an agency
 * link and a payout trail. A party room is a room people talk in — the owner is
 * closer to whoever opened the door than to a performer, and gifts go to
 * whichever seat the sender picks rather than to the room owner. Requiring a
 * verification badge to open a chat room would leave almost every room in the
 * app unopenable on day one, for a gate that is not protecting any earnings.
 *
 * A ban still stops you, because that is about conduct rather than status.
 */
export const createPartyRoom = functions
  .region('asia-south1')
  .https.onCall(async (
    data: {
      mode?: string
      title?: string
      category?: string
      seatCount?: number
      seatMode?: string
      visibility?: string
      password?: string
      welcomeMessage?: string
      theme?: string
    },
    context,
  ) => {
    const uid = requireAuth(context)
    await assertActiveSession(uid, data, 'createPartyRoom', context.auth?.token)   // Phase 1A (SESSION-001/003)
    const userSnap = await requireUser(uid)

    const mode = modeOf(data?.mode)
    const seatCount = seatsFor(mode, data?.seatCount)
    const seatMode = data?.seatMode === SEAT_MODE_CONSENT ? SEAT_MODE_CONSENT : SEAT_MODE_FREE
    const visibility = data?.visibility === VISIBILITY_PRIVATE ? VISIBILITY_PRIVATE : VISIBILITY_PUBLIC
    const welcomeMessage = await cleanWelcome(data?.welcomeMessage, { allowEmpty: true })

    // Validated before anything is written, so a bad PIN costs nothing.
    const password = visibility === VISIBILITY_PRIVATE ? validPassword(data?.password) : ''
    // B7: a private room is Party Pro — level 7 and a paid, unexpired subscription (partySubscription.ts).
    if (visibility === VISIBILITY_PRIVATE) await privateRoomGate(uid, Number(userSnap.get('level') ?? 0) || 0)

    // Close anything this host left behind. A crash never runs endParty, and a
    // ghost room keeps showing in the list with nobody in it — the same defect
    // startLive had before it was taught to sweep.
    const stale = await db
      .collection('partyRooms')
      .where('hostUid', '==', uid)
      .where('isActive', '==', true)
      .get()
    await Promise.all(
      stale.docs.map((d) =>
        d.ref.update({ isActive: false, endedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => undefined),
      ),
    )

    const name = String(userSnap.get('name') ?? '').trim() || 'Host'
    /*
     * "<FirstName>'s room" — the first word, not the whole name.
     *
     * A display name here is often three or four words, and the full string in a
     * room title truncates in the list to something unreadable.
     */
    const firstName = name.split(/\s+/)[0] || name

    const roomRef = db.collection('partyRooms').doc()
    if (password !== '') {
      // F-7: the secret goes FIRST and goes to the server-only document. If
      // the room write below then fails there is an orphaned secret under a
      // room that does not exist, which is nothing; the other order would open
      // a private room with no key, admitting nobody until the owner reset it.
      await secretRefOf(roomRef).set({
        ...secretFor(password),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      })
    }

    await roomRef.set({
      hostUid: uid,
      hostName: name,
      hostPhotoUrl: String(userSnap.get('photoUrl') ?? ''),
      mode,
      title: String(data?.title ?? '').trim().slice(0, 60) || `${firstName}'s room`,
      welcomeMessage,
      category: String(data?.category ?? 'general').slice(0, 40),
      agencyId: String(userSnap.get('agencyId') ?? ''),
      isActive: true,
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      // Written by the server so the client's grid cannot be talked into
      // rendering twenty video tiles.
      seatCount,
      seatMode,
      visibility,
      theme: themeOf(data?.theme),
      // F-7: no `passwordHash` / `passwordSalt` here, ever again. The count of
      // wrong guesses is not a secret and stays where ops can see it.
      passwordAttempts: 0,
      admins: [],
      lockedSeats: [],
      kickedUsers: [],
      listenerCount: 0,
      occupantCount: 0,
      totalBeansEarned: 0,
      totalGiftsReceived: 0,
      /*
       * Set the moment the last seat empties, cleared when anyone sits.
       *
       * A room opens with every seat empty — including the owner's, which is the
       * whole point of the rebuild — so if this started as "now" the room would
       * qualify for auto-close two seconds after being created, before its owner
       * had finished reading the settings sheet. Null means "the clock has not
       * started"; `sweepEmptyPartyRooms` uses `startedAt` for the never-occupied
       * case instead, with a much longer fuse.
       */
      emptySince: null,
    })

    return { roomId: roomRef.id, mode, seatCount, seatMode, visibility }
  })

// ── updatePartyRoom ──────────────────────────────────────────────────────────

/**
 * The settings sheet, server-side.
 *
 * Every one of these was previously either impossible or a raw client write to
 * the room document. The rules used to allow `allow update: if isRoomHost()`
 * with no field restriction at all, which meant the owner's client could write
 * `seatCount`, `kickedUsers` or `totalBeansEarned` — the earnings figure the
 * room's own leaderboard is drawn from. Those are now server-only and this is
 * the only door.
 *
 * Owner only. An admin moderates the room; they do not get to rename it,
 * make it private, or change its shape.
 */
export const updatePartyRoom = functions
  .region('asia-south1')
  .https.onCall(async (
    data: {
      roomId?: string
      title?: string
      welcomeMessage?: string
      seatCount?: number
      seatMode?: string
      visibility?: string
      password?: string
      theme?: string
      /** B7: the owner's "no incoming calls while I am in this room". */
      blockCalls?: boolean
    },
    context,
  ) => {
    const uid = requireAuth(context)
    await assertActiveSession(uid, data, 'updatePartyRoom', context.auth?.token)   // Phase 1A (SESSION-001/003)
    const roomId = String(data?.roomId ?? '')
    if (!roomId) throw new functions.https.HttpsError('invalid-argument', 'roomId is required.')

    const roomRef = db.collection('partyRooms').doc(roomId)
    const roomSnap = await roomRef.get()
    requireLiveRoom(roomSnap)
    requireOwner(roomSnap, uid)

    const updates: Record<string, any> = {}
    /** Seats that have to be vacated because the room just got smaller. */
    let vacateAbove = 0

    if (data?.title !== undefined) {
      const title = String(data.title).trim().slice(0, 60)
      if (title === '') {
        throw new functions.https.HttpsError('invalid-argument', 'The room needs a name.')
      }
      updates.title = title
    }

    if (data?.welcomeMessage !== undefined) {
      updates.welcomeMessage = await cleanWelcome(data.welcomeMessage, { allowEmpty: false })
    }

    // B7: a background every app knows how to draw; anything else is refused rather than stored.
    if (data?.theme !== undefined) {
      if (!(ROOM_THEMES as readonly string[]).includes(String(data.theme))) {
        throw new functions.https.HttpsError('invalid-argument', 'Choose one of the room themes.')
      }
      updates.theme = String(data.theme)
    }
    // B7: the owner may stop incoming calls while they are in their own room (startCall reads this).
    if (data?.blockCalls !== undefined) updates.ownerBlocksCalls = data.blockCalls === true

    if (data?.seatCount !== undefined) {
      const mode = String(roomSnap.get('mode') ?? MODE_AUDIO)
      const allowed = SEAT_CHOICES[modeOf(mode)]
      const next = Number(data.seatCount)
      if (!allowed.includes(next)) {
        throw new functions.https.HttpsError(
          'invalid-argument',
          `A ${mode} room can have ${allowed.join(' or ')} seats.`,
        )
      }
      updates.seatCount = next
      /*
       * Shrinking a room strands whoever is sitting above the new limit.
       *
       * They would keep publishing — `generateAgoraToken` reads the seat
       * document, not the seat count — while no client rendered a tile for
       * them: audible, invisible, and unable to leave a seat the grid no
       * longer draws. So the seats are cleared, below, in the same breath.
       */
      if (next < Number(roomSnap.get('seatCount') ?? 0)) vacateAbove = next
    }

    if (data?.seatMode !== undefined) {
      updates.seatMode = data.seatMode === SEAT_MODE_CONSENT ? SEAT_MODE_CONSENT : SEAT_MODE_FREE
      /*
       * Turning consent OFF clears the queue rather than admitting it.
       *
       * The requests were consent to a question the room is no longer asking,
       * and every seat is now free to take — leaving them pending would show
       * the owner a list of approvals that do nothing.
       */
      if (updates.seatMode === SEAT_MODE_FREE) {
        const pending = await roomRef.collection('seatRequests').get()
        await Promise.all(pending.docs.map((d) => d.ref.delete().catch(() => undefined)))
      }
    }

    /*
     * F-7: the secret is written to `private/secret`, never onto the room
     * document; any legacy copy on the room document is deleted in the same
     * room write. `secretWrite` is what this update does to it: a new secret,
     * its removal, or nothing.
     */
    const secretRef = secretRefOf(roomRef)
    let secretWrite: { passwordHash: string; passwordSalt: string } | 'delete' | null = null

    if (data?.visibility !== undefined) {
      const visibility = data.visibility === VISIBILITY_PRIVATE ? VISIBILITY_PRIVATE : VISIBILITY_PUBLIC
      updates.visibility = visibility
      // B7: making a room private is Party Pro, exactly as opening one private is (a public room is free to stay so).
      if (visibility === VISIBILITY_PRIVATE && roomSnap.get('visibility') !== VISIBILITY_PRIVATE) {
        const owner = await db.collection('users').doc(uid).get()
        await privateRoomGate(uid, Number(owner.get('level') ?? 0) || 0)
      }
      if (visibility === VISIBILITY_PRIVATE) {
        // A room going private needs a password now — either a new one, or the
        // one it already had. Going private with no password would be a lock
        // with no key, and every listener would be admitted anyway.
        if (data?.password !== undefined) {
          secretWrite = secretFor(validPassword(data.password))
          updates.passwordAttempts = 0
        } else {
          const existing = await secretRef.get()
          if (!existing.exists && legacySecretOf(roomSnap) === null) {
            throw new functions.https.HttpsError(
              'invalid-argument',
              'Set a 4-digit password to make this room private.',
            )
          }
        }
      } else {
        // Public again: drop the secret rather than keep it lying around.
        secretWrite = 'delete'
        updates.passwordAttempts = 0
      }
    } else if (data?.password !== undefined) {
      // Changing the password without touching visibility.
      secretWrite = secretFor(validPassword(data.password))
      updates.passwordAttempts = 0
    }

    if (Object.keys(updates).length === 0) return { updated: false }

    if (secretWrite === 'delete') {
      await secretRef.delete()
      Object.assign(updates, legacySecretCleared())
    } else if (secretWrite !== null) {
      // Secret first, room second: a room that says "private" with a key in
      // place is right; a key for a room that still says "public" is harmless.
      await secretRef.set({ ...secretWrite, updatedAt: admin.firestore.FieldValue.serverTimestamp() })
      Object.assign(updates, legacySecretCleared())
    }

    await roomRef.update(updates)

    if (vacateAbove > 0) {
      const seats = await roomRef.collection('seats').get()
      const batch = db.batch()
      let removed = 0
      seats.docs.forEach((d) => {
        if (Number(d.id) > vacateAbove) {
          batch.delete(d.ref)
          removed++
        }
      })
      if (removed > 0) {
        batch.update(roomRef, {
          occupantCount: admin.firestore.FieldValue.increment(-removed),
        })
        await batch.commit()
      }
    }

    return { updated: true }
  })

// ── joinPartyRoom / leavePartyRoom ───────────────────────────────────────────

/**
 * Enter a room as a listener.
 *
 * ── WHY THIS IS A CALLABLE NOW ───────────────────────────────────────────────
 *
 * Listener presence used to be a client write straight into
 * `partyRooms/{id}/listeners/{uid}`, and two things followed from that.
 *
 * `listenerCount` on the room had NO WRITER — it was set to 0 at create and
 * never touched again — so the room list had to run an aggregate count query per
 * room to show "12 listening". That is a server round trip per row of a scrolling
 * list, and it was the reason the list felt slow.
 *
 * And a private room could not exist. A password check is only a check if the
 * thing it guards cannot be written without passing it; a client that writes its
 * own presence row simply skips the question.
 *
 * So presence is server-written, the counter is maintained here, and the
 * password is verified on the way in.
 */
export const joinPartyRoom = functions
  .region('asia-south1')
  .https.onCall(async (data: { roomId?: string; password?: string; official?: boolean }, context) => {
    const uid = requireAuth(context)
    await assertActiveSession(uid, data, 'joinPartyRoom', context.auth?.token)   // Phase 1A (SESSION-001/003)
    const roomId = String(data?.roomId ?? '')
    if (!roomId) throw new functions.https.HttpsError('invalid-argument', 'roomId is required.')

    const userSnap = await requireUser(uid)
    const roomRef = db.collection('partyRooms').doc(roomId)
    const secretRef = secretRefOf(roomRef)

    // Resolved before the transaction opens: it reads a collection the
    // transaction has no other business with, and Firestore forbids a read
    // after a write.
    const cosmetics = await resolveCosmetics(userSnap)
    const missesRef = roomRef.collection('pinMisses').doc(uid)
    const displayName = String(userSnap.get('name') ?? '').trim() || 'Guest'
    const nowMs = Date.now()

    let joined
    try {
      joined = await db.runTransaction(async (tx) => {
        const roomSnap = await tx.get(roomRef)
        requireLiveRoom(roomSnap)
        refuseIfKicked(roomSnap, uid)

        const listenerRef = roomRef.collection('listeners').doc(uid)
        const listenerSnap = await tx.get(listenerRef)
        const role = roleOf(roomSnap, uid)

        /*
         * The password, unless you are already in or you own the place.
         *
         * Re-joining without re-typing matters more than it sounds: Android kills
         * and restores this screen freely, and a room that demanded four digits
         * again on every process restart would be unusable.
         */
        const isPrivate = roomSnap.get('visibility') === VISIBILITY_PRIVATE
        /*
         * B2a: somebody this room already let in with the PIN is not asked again. The listener row used to be the
         * only memory of that, and the sweep now removes a listener whose app went quiet (three missed
         * heartbeats) — a phone that slept for five minutes would otherwise come back to a PIN prompt. The
         * admission is server-only (`partyRooms/{id}/admitted/{uid}`), written below on a correct PIN.
         */
        const admittedRef = roomRef.collection('admitted').doc(uid)
        const admittedSnap = isPrivate && !listenerSnap.exists && role === 'member' ? await tx.get(admittedRef) : null
        const gated = isPrivate && !listenerSnap.exists && role === 'member' && !admittedSnap?.exists
        // B7: official access — asked for explicitly, checked against the caller's own CRM record.
        const crmSnap = gated && data?.official === true ? await tx.get(db.collection('crmUsers').doc(uid)) : null
        const official = crmSnap ? officialAccessOf(crmSnap.exists ? (crmSnap.data() as Record<string, unknown>) : undefined) : null
        if (crmSnap && !official?.allowed) {
          throw new functions.https.HttpsError('permission-denied', 'Your Zipper role does not allow entering private rooms.')
        }
        const needsPassword = gated && !official?.allowed
        // B7: a person locked out of this room is refused before the PIN is even compared.
        const missesSnap = needsPassword ? await tx.get(missesRef) : null
        if (missesSnap?.exists) {
          const lock = pinLockState(missesSnap.data() as Partial<PinMisses>, nowMs)
          if (lock.locked) throw pinLocked(lock.retryAfterMs)
        }
        // F-7: the secret is read from the server-only document, inside the
        // transaction and before any write (Firestore forbids a read after one).
        const secretSnap = needsPassword ? await tx.get(secretRef) : null
        let migrateLegacy: { passwordHash: string; passwordSalt: string } | null = null
        if (needsPassword) {
          const given = String(data?.password ?? '')
          if (!given) {
            throw new functions.https.HttpsError('permission-denied', 'This room needs a password.')
          }
          // A room opened before F-7 still carries its hash on the room
          // document: honoured until it closes, and moved on the way past.
          const legacy = secretSnap?.exists ? null : legacySecretOf(roomSnap)
          const secret = secretSnap?.exists ? (secretSnap.data() as Record<string, unknown>) : legacy
          if (!passwordMatches(given, secret)) throw wrongPassword()
          migrateLegacy = legacy
        }

        const roomUpdates: Record<string, unknown> = {}
        if (migrateLegacy) {
          tx.set(secretRef, { ...migrateLegacy, migratedAt: admin.firestore.FieldValue.serverTimestamp() })
          Object.assign(roomUpdates, legacySecretCleared())
        }
        if (needsPassword) {
          // The PIN was right (a wrong one threw above). Remembered, so a reconnect is not a second prompt.
          tx.set(admittedRef, { uid, via: 'pin', admittedAt: admin.firestore.FieldValue.serverTimestamp() })
          if (missesSnap?.exists) tx.delete(missesRef)
          tx.set(accessLogRef(roomRef), { uid, name: displayName, result: 'admitted', via: 'pin', atMs: nowMs, at: admin.firestore.FieldValue.serverTimestamp() })
        }
        if (official?.allowed) {
          tx.set(admittedRef, { uid, via: 'official', role: official.role, admittedAt: admin.firestore.FieldValue.serverTimestamp() })
          tx.set(accessLogRef(roomRef), {
            uid, name: displayName, result: 'official', role: official.role, atMs: nowMs, at: admin.firestore.FieldValue.serverTimestamp(),
          })
          roomUpdates.officialPresentUids = admin.firestore.FieldValue.arrayUnion(uid)
        }
        // B2a: somebody is in the room, so it is not empty — whatever the seats say.
        if (roomSnap.get('emptySince') != null) roomUpdates.emptySince = null

        if (listenerSnap.exists) {
          tx.update(listenerRef, { lastSeenAt: admin.firestore.FieldValue.serverTimestamp() })
        } else {
          tx.set(listenerRef, {
            uid,
            name: String(userSnap.get('name') ?? '').trim() || 'Guest',
            photoUrl: String(userSnap.get('photoUrl') ?? ''),
            level: Number(userSnap.get('level') ?? 0),
            /*
             * The cosmetics this person is wearing, RESOLVED TO URLS here.
             *
             * The ids alone are not enough. An entrance is a video clip, and
             * playing it means knowing `bagItems/{id}.videoUrl` — so handing the
             * room an item id makes every client that sees this arrival look the
             * same item up for itself. A room of forty is forty reads of one
             * document, per arrival, and the whole reason these are denormalised
             * onto the listener row is to avoid exactly that.
             *
             * So the lookup happens once, here, on the way in. The ids are kept
             * alongside because a client may want to know WHICH cosmetic it is
             * without caring where the asset lives.
             */
            ...cosmetics,
            // B7: an official in the room is shown as one — never a silent visitor.
            ...(official?.allowed ? { official: true, officialRole: official.role } : {}),
            joinedAt: admin.firestore.FieldValue.serverTimestamp(),
            // B2a: presence, refreshed by `partyHeartbeat`; the sweep removes a row that goes quiet.
            lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
          })
          roomUpdates.listenerCount = admin.firestore.FieldValue.increment(1)
        }
        // One write to the room document, whatever this join changes on it.
        if (Object.keys(roomUpdates).length > 0) tx.update(roomRef, roomUpdates)

        tx.set(db.collection('users').doc(uid), presence(roomId), { merge: true })

        return {
          joined: true,
          // QA #22: already in the room (a restored screen, a reconnect) — the app posts no second "joined" line.
          rejoined: listenerSnap.exists,
          role,
          seatCount: Number(roomSnap.get('seatCount') ?? 0),
          mode: String(roomSnap.get('mode') ?? MODE_AUDIO),
          seatMode: String(roomSnap.get('seatMode') ?? SEAT_MODE_FREE),
          welcomeMessage: String(roomSnap.get('welcomeMessage') ?? DEFAULT_WELCOME),
        }
      })
    } catch (err) {
      if (isPinLocked(err)) {
        await accessLogRef(roomRef)
          .set({ uid, name: displayName, result: 'locked', atMs: nowMs, at: admin.firestore.FieldValue.serverTimestamp() })
          .catch(() => undefined)
        throw err
      }
      if (!isWrongPassword(err)) throw err
      // B7: this person's misses for this room — five in fifteen minutes locks them out of it for fifteen.
      const lockedNow = await db.runTransaction(async (tx) => {
        const snap = await tx.get(missesRef)
        const next = nextPinMisses(snap.exists ? (snap.data() as Partial<PinMisses>) : undefined, nowMs)
        tx.set(missesRef, { ...next, uid, updatedAt: admin.firestore.FieldValue.serverTimestamp() })
        tx.set(accessLogRef(roomRef), {
          uid, name: displayName, result: 'wrong_pin', misses: next.count, atMs: nowMs, at: admin.firestore.FieldValue.serverTimestamp(),
        })
        return next.lockedUntilMs > nowMs
      }).catch(() => false)
      if (lockedNow) {
        await roomRef.update({ passwordAttempts: admin.firestore.FieldValue.increment(1) }).catch(() => undefined)
        throw pinLocked(PIN_LOCK_MS)
      }
      /*
       * Count the misses. Four digits is ten thousand guesses, which a script
       * gets through in minutes, and the counter is what makes that visible
       * rather than silent. It is not a lockout — locking a room because a
       * stranger guessed at it would hand any passer-by the ability to shut it
       * — it is a number the owner and ops can see. Written HERE, after the
       * transaction above rolled back, because a write made inside a
       * transaction that throws is discarded with it.
       */
      await roomRef
        .update({ passwordAttempts: admin.firestore.FieldValue.increment(1) })
        .catch(() => undefined)
      throw err
    }
    return joined
  })

/** Leave a room entirely: vacate any seat, drop presence, decrement the count. */
export const leavePartyRoom = functions
  .region('asia-south1')
  .https.onCall(async (data: { roomId?: string }, context) => {
    const uid = requireAuth(context)
    const roomId = String(data?.roomId ?? '')
    if (!roomId) throw new functions.https.HttpsError('invalid-argument', 'roomId is required.')

    const roomRef = db.collection('partyRooms').doc(roomId)
    await vacateAndDrop(roomRef, uid, { alsoListener: true })
    await db.collection('users').doc(uid).set(presence(''), { merge: true })
    // B7: an official who leaves is no longer "present" (the access log keeps the visit).
    const roomNow = await roomRef.get()
    if (((roomNow.get('officialPresentUids') as string[] | undefined) ?? []).includes(uid)) {
      await roomRef.update({ officialPresentUids: admin.firestore.FieldValue.arrayRemove(uid) }).catch(() => undefined)
    }
    return { left: true }
  })

/**
 * "I am still in this room." B2a (3 Nov 2026).
 *
 * The app sends it every [PARTY_HEARTBEAT_EVERY_MS] while the room screen is open (also in picture-in-picture).
 * It only refreshes the caller's own listener row — nothing else can be moved through it. `present: false` means
 * the row is gone (the sweep took it after a long silence, or a kick did): the app joins again, which for a private
 * room it was already admitted to does not ask for the PIN (see `admitted/{uid}`), and which a kick refuses.
 */
export const partyHeartbeat = functions
  .region('asia-south1')
  .https.onCall(async (data: { roomId?: string }, context) => {
    const uid = requireAuth(context)
    const roomId = String(data?.roomId ?? '')
    if (!roomId) throw new functions.https.HttpsError('invalid-argument', 'roomId is required.')

    const roomRef = db.collection('partyRooms').doc(roomId)
    const listenerRef = roomRef.collection('listeners').doc(uid)
    const [roomSnap, listenerSnap] = await Promise.all([roomRef.get(), listenerRef.get()])
    if (!roomSnap.exists || roomSnap.get('isActive') === false) return { active: false, present: false }
    if (!listenerSnap.exists) return { active: true, present: false }
    await listenerRef.update({ lastSeenAt: admin.firestore.FieldValue.serverTimestamp() })
    return { active: true, present: true, nextInMs: PARTY_HEARTBEAT_EVERY_MS }
  })

/**
 * Remove people who left without leaving — B2a.
 *
 * Lobby presence now keeps a room open, so a listener row whose app died (killed process, dead network, a phone
 * thrown in a drawer) would keep it open for ever. A row is stale when its heartbeat is older than
 * [LISTENER_STALE_MS], or — for a row written before heartbeats existed — when it joined more than
 * [LEGACY_LISTENER_STALE_MS] ago. Each stale person goes through `vacateAndDrop`, the one path that moves the seat
 * count, the listener count and the empty-room clock together, so a seat they still held is freed as well.
 *
 * Their presence flag is cleared only if it still names THIS room — they may have walked into another one since.
 */
export async function pruneStaleListeners(nowMs: number, maxRooms = 100): Promise<number> {
  const rooms = await db.collection('partyRooms').where('isActive', '==', true).limit(maxRooms).get()
  let pruned = 0
  for (const room of rooms.docs) {
    const listeners = room.ref.collection('listeners')
    const [quiet, legacy] = await Promise.all([
      listeners.where('lastSeenAt', '<', admin.firestore.Timestamp.fromMillis(nowMs - LISTENER_STALE_MS)).limit(50).get(),
      listeners.where('joinedAt', '<', admin.firestore.Timestamp.fromMillis(nowMs - LEGACY_LISTENER_STALE_MS)).limit(50).get(),
    ])
    const seen = new Set<string>()
    for (const row of [...quiet.docs, ...legacy.docs]) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      // The legacy query also returns old joiners who ARE heartbeating — those stay.
      if (!listenerIsStale(row.data() as Record<string, unknown>, nowMs)) continue
      try {
        await vacateAndDrop(room.ref, row.id, { alsoListener: true })
        const userRef = db.collection('users').doc(row.id)
        const user = await userRef.get()
        if (user.exists && String(user.get('partyRoomId') ?? '') === room.id) {
          await userRef.set(presence(''), { merge: true })
        }
        pruned++
      } catch (err) {
        functions.logger.error(`pruneStaleListeners: ${room.ref.path}/listeners/${row.id}`, err)
      }
    }
  }
  return pruned
}

/**
 * The shared body of every "this person is no longer on a seat" path.
 *
 * Kept in one function because the seat count, the occupant count and the
 * empty-room clock have to move together. When they did not — when each caller
 * did its own deletes — `listenerCount` drifted and the auto-close clock was
 * only ever set by one of the three paths that can empty a room.
 */
async function vacateAndDrop(
  roomRef: admin.firestore.DocumentReference,
  target: string,
  opts: { alsoListener: boolean; kick?: boolean },
): Promise<{ vacated: boolean; roomEmpty: boolean }> {
  return db.runTransaction(async (tx) => {
    const roomSnap = await tx.get(roomRef)
    if (!roomSnap.exists) return { vacated: false, roomEmpty: false }

    const seatsCol = roomRef.collection('seats')
    const [mySeats, allSeats] = await Promise.all([
      tx.get(seatsCol.where('uid', '==', target)),
      tx.get(seatsCol),
    ])

    /*
     * Every read BEFORE the first write. B2a: the listener row used to be read after the seat deletes, and Firestore
     * refuses a read after a write in a transaction ("Firestore transactions require all reads to be executed
     * before all writes") — so leaving a room, or being kicked, while sitting on a seat failed outright and left a
     * ghost seat behind. Found by running this path in the optimistic fake.
     */
    const listenerRef = roomRef.collection('listeners').doc(target)
    const listenerSnap = opts.alsoListener || opts.kick ? await tx.get(listenerRef) : null

    mySeats.docs.forEach((d) => tx.delete(d.ref))

    const roomUpdates: Record<string, any> = {}
    if (mySeats.size > 0) {
      roomUpdates.occupantCount = admin.firestore.FieldValue.increment(-mySeats.size)
    }
    if (listenerSnap?.exists) {
      tx.delete(listenerRef)
      roomUpdates.listenerCount = admin.firestore.FieldValue.increment(-1)
    }
    if (opts.kick) {
      roomUpdates.kickedUsers = admin.firestore.FieldValue.arrayUnion(target)
      // A pending seat request from someone being thrown out is not a request
      // anyone still wants to see.
      tx.delete(roomRef.collection('seatRequests').doc(target))
      tx.delete(roomRef.collection('seatInvites').doc(target))
    }

    /*
     * Did that empty the room?
     *
     * `allSeats` was read before the deletes, so the remaining count is what was
     * there minus the ones belonging to this person.
     */
    const remaining = allSeats.docs.filter((d) => String(d.get('uid') ?? '') !== target).length
    /*
     * B2a: and is anybody still in the lobby? Seats alone used to decide it, which closed rooms full of listeners.
     * `listenerCount` is the server-maintained count (join +1, leave/kick/stale −1); this person's row, if it was
     * just removed, is taken off it.
     */
    const listenersBefore = Math.max(0, Number(roomSnap.get('listenerCount') ?? 0) || 0)
    const listenersLeft = listenersBefore - (listenerSnap?.exists ? 1 : 0)
    const roomEmpty = roomIsEmpty(remaining, listenersLeft)
    if (roomEmpty) {
      roomUpdates.emptySince = admin.firestore.FieldValue.serverTimestamp()
    }

    if (Object.keys(roomUpdates).length > 0) tx.update(roomRef, roomUpdates)

    return { vacated: mySeats.size > 0, roomEmpty }
  })
}

// ── takePartySeat ────────────────────────────────────────────────────────────

/**
 * Take a seat.
 *
 * Seats are 1-based and every one of them is an ordinary seat, the owner's
 * included. In `consent` mode this refuses with `failed-precondition` and the
 * client is expected to call `requestPartySeat` instead — the refusal names the
 * reason so a stale client cannot quietly seat someone the owner meant to vet.
 */
export const takePartySeat = functions
  .region('asia-south1')
  .https.onCall(async (data: { roomId?: string; seatIndex?: number }, context) => {
    const uid = requireAuth(context)
    await assertActiveSession(uid, data, 'takePartySeat', context.auth?.token)   // Phase 1A (SESSION-001/003)
    const roomId = String(data?.roomId ?? '')
    const seatIndex = Number(data?.seatIndex)
    if (!roomId || !Number.isInteger(seatIndex)) {
      throw new functions.https.HttpsError('invalid-argument', 'roomId and seatIndex are required.')
    }

    const userSnap = await requireUser(uid)
    const roomRef = db.collection('partyRooms').doc(roomId)

    return db.runTransaction(async (tx) => {
      const roomSnap = await tx.get(roomRef)
      requireLiveRoom(roomSnap)
      refuseIfKicked(roomSnap, uid)

      const role = roleOf(roomSnap, uid)
      const seatMode = String(roomSnap.get('seatMode') ?? SEAT_MODE_FREE)
      if (seatMode === SEAT_MODE_CONSENT && role === 'member') {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'Ask the host for a seat in this room.',
        )
      }

      return seatInTransaction(tx, roomRef, roomSnap, seatIndex, uid, userSnap)
    })
  })

/**
 * The seating itself, shared by the three ways to end up on a seat: taking one,
 * being approved for one, and accepting an invitation to one.
 *
 * All three have to enforce the same seat range, the same lock check and the
 * same one-seat-per-person rule, and when they each had their own copy they did
 * not: only the direct path checked `lockedSeats`, so an invitation could seat
 * someone on a seat the owner had deliberately locked.
 */
async function seatInTransaction(
  tx: admin.firestore.Transaction,
  roomRef: admin.firestore.DocumentReference,
  roomSnap: admin.firestore.DocumentSnapshot,
  seatIndex: number,
  uid: string,
  userSnap: admin.firestore.DocumentSnapshot,
): Promise<{ seatIndex: number; alreadySeated: boolean }> {
  const mode = String(roomSnap.get('mode') ?? MODE_AUDIO)
  const limit = Number(roomSnap.get('seatCount') ?? seatsFor(mode))
  if (seatIndex < 1 || seatIndex > limit) {
    throw new functions.https.HttpsError('out-of-range', `This room has ${limit} seats.`)
  }
  const locked: number[] = roomSnap.get('lockedSeats') ?? []
  if (locked.includes(seatIndex)) {
    throw new functions.https.HttpsError('permission-denied', 'The host has locked this seat.')
  }

  // Already sitting somewhere? Vacate it rather than holding two. Reading the
  // whole seat collection inside the transaction is what makes "one seat per
  // person" true even when two requests race each other.
  const seatsCol = roomRef.collection('seats')
  const occupied = await tx.get(seatsCol.where('uid', '==', uid))

  const target = seatsCol.doc(String(seatIndex))
  const targetSnap = await tx.get(target)
  if (targetSnap.exists && String(targetSnap.get('uid') ?? '') !== '') {
    if (targetSnap.get('uid') === uid) return { seatIndex, alreadySeated: true }
    throw new functions.https.HttpsError('already-exists', 'Somebody just took that seat.')
  }

  let vacatedOwn = 0
  occupied.docs.forEach((d) => {
    if (d.id !== String(seatIndex)) {
      tx.delete(d.ref)
      vacatedOwn++
    }
  })

  tx.set(target, {
    uid,
    name: String(userSnap.get('name') ?? '').trim() || 'Guest',
    photoUrl: String(userSnap.get('photoUrl') ?? ''),
    // Agora needs a stable numeric uid per publisher, and the seat index is the
    // one number both sides already agree on.
    agoraUid: seatIndex,
    /*
     * `isMuted` is a moderator's decision, `selfMuted` is the occupant's, and
     * they are separate fields because they have separate keys. Only the owner
     * can lift an owner's mute; only the occupant can lift their own. Collapsing
     * them into one boolean is what would let a muted guest unmute themselves.
     */
    isMuted: false,
    mutedBy: '',
    mutedByRole: '',
    selfMuted: false,
    // A video seat starts with the camera off. Opening someone's camera the
    // instant they sit down is not a decision to make on their behalf.
    cameraOff: mode === MODE_VIDEO,
    joinedAt: admin.firestore.FieldValue.serverTimestamp(),
    beansReceived: 0,
  })

  tx.update(roomRef, {
    // Net change: one seat gained, minus any this person was already holding.
    occupantCount: admin.firestore.FieldValue.increment(1 - vacatedOwn),
    // Somebody is on a seat, so the room is no longer counting down to close.
    emptySince: null,
  })

  // Presence, so the discovery list and the profile card agree.
  tx.set(db.collection('users').doc(uid), presence(roomRef.id), { merge: true })

  // Whichever path got them here, the paperwork for it is done.
  tx.delete(roomRef.collection('seatRequests').doc(uid))
  tx.delete(roomRef.collection('seatInvites').doc(uid))

  return { seatIndex, alreadySeated: false }
}

// ── Seat consent: request and decide ─────────────────────────────────────────

/**
 * Ask for a seat, in a room where seats need consent.
 *
 * The request names the seat, because "let me in somewhere" gives the owner
 * nothing to approve — they would have to pick a seat on the asker's behalf and
 * might pick one the asker could not see was about to be taken.
 */
export const requestPartySeat = functions
  .region('asia-south1')
  .https.onCall(async (data: { roomId?: string; seatIndex?: number }, context) => {
    const uid = requireAuth(context)
    await assertActiveSession(uid, data, 'requestPartySeat', context.auth?.token)   // Phase 1A (SESSION-001/003)
    const roomId = String(data?.roomId ?? '')
    const seatIndex = Number(data?.seatIndex)
    if (!roomId || !Number.isInteger(seatIndex)) {
      throw new functions.https.HttpsError('invalid-argument', 'roomId and seatIndex are required.')
    }

    const userSnap = await requireUser(uid)
    const roomRef = db.collection('partyRooms').doc(roomId)
    const roomSnap = await roomRef.get()
    requireLiveRoom(roomSnap)
    refuseIfKicked(roomSnap, uid)

    const limit = Number(roomSnap.get('seatCount') ?? 0)
    if (seatIndex < 1 || seatIndex > limit) {
      throw new functions.https.HttpsError('out-of-range', `This room has ${limit} seats.`)
    }
    const locked: number[] = roomSnap.get('lockedSeats') ?? []
    if (locked.includes(seatIndex)) {
      throw new functions.https.HttpsError('permission-denied', 'The host has locked this seat.')
    }

    await roomRef.collection('seatRequests').doc(uid).set({
      uid,
      name: String(userSnap.get('name') ?? '').trim() || 'Guest',
      photoUrl: String(userSnap.get('photoUrl') ?? ''),
      seatIndex,
      requestedAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    return { requested: true, seatIndex }
  })

/** Withdraw your own request. */
export const cancelPartySeatRequest = functions
  .region('asia-south1')
  .https.onCall(async (data: { roomId?: string }, context) => {
    const uid = requireAuth(context)
    const roomId = String(data?.roomId ?? '')
    if (!roomId) throw new functions.https.HttpsError('invalid-argument', 'roomId is required.')
    await db.collection('partyRooms').doc(roomId).collection('seatRequests').doc(uid).delete()
    return { cancelled: true }
  })

/**
 * Approve or refuse a seat request. Owner or admin.
 *
 * An approval seats them THERE AND THEN rather than handing them a permission to
 * use later. A grant the asker still has to act on is a grant that goes stale:
 * the seat they asked for gets taken while they are not looking, and the
 * approval they were given becomes an error message.
 */
export const decidePartySeatRequest = functions
  .region('asia-south1')
  .https.onCall(async (data: { roomId?: string; targetUid?: string; approve?: boolean }, context) => {
    const uid = requireAuth(context)
    await assertActiveSession(uid, data, 'decidePartySeatRequest', context.auth?.token)   // Phase 1A (SESSION-001/003)
    const roomId = String(data?.roomId ?? '')
    const targetUid = String(data?.targetUid ?? '')
    if (!roomId || !targetUid) {
      throw new functions.https.HttpsError('invalid-argument', 'roomId and targetUid are required.')
    }

    const roomRef = db.collection('partyRooms').doc(roomId)
    const requestRef = roomRef.collection('seatRequests').doc(targetUid)

    if (data?.approve !== true) {
      const roomSnap = await roomRef.get()
      requireLiveRoom(roomSnap)
      requireHostOrAdmin(roomSnap, uid)
      await requestRef.delete()
      return { approved: false }
    }

    const targetSnap = await db.collection('users').doc(targetUid).get()
    if (!targetSnap.exists) {
      await requestRef.delete()
      throw new functions.https.HttpsError('not-found', 'That account no longer exists.')
    }

    return db.runTransaction(async (tx) => {
      const [roomSnap, reqSnap] = await Promise.all([tx.get(roomRef), tx.get(requestRef)])
      requireLiveRoom(roomSnap)
      requireHostOrAdmin(roomSnap, uid)
      if (!reqSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'That request is no longer waiting.')
      }
      refuseIfKicked(roomSnap, targetUid)
      const seatIndex = Number(reqSnap.get('seatIndex'))
      const seated = await seatInTransaction(tx, roomRef, roomSnap, seatIndex, targetUid, targetSnap)
      return { approved: true, ...seated }
    })
  })

// ── Invite to a seat ─────────────────────────────────────────────────────────

/**
 * Invite somebody onto a seat. Owner or admin.
 *
 * An invitation is an offer, not an instruction — it writes a document the
 * invitee's client shows as a popup, and they accept or decline. Seating someone
 * directly would put a stranger's microphone live in a room they may have opened
 * by accident, which is a thing to ask about rather than assume.
 */
export const invitePartySeat = functions
  .region('asia-south1')
  .https.onCall(async (data: { roomId?: string; targetUid?: string; seatIndex?: number }, context) => {
    const uid = requireAuth(context)
    await assertActiveSession(uid, data, 'invitePartySeat', context.auth?.token)   // Phase 1A (SESSION-001/003)
    const roomId = String(data?.roomId ?? '')
    const targetUid = String(data?.targetUid ?? '')
    const seatIndex = Number(data?.seatIndex)
    if (!roomId || !targetUid || !Number.isInteger(seatIndex)) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'roomId, targetUid and seatIndex are required.',
      )
    }
    if (targetUid === uid) {
      throw new functions.https.HttpsError('invalid-argument', 'Just take the seat.')
    }

    const roomRef = db.collection('partyRooms').doc(roomId)
    const roomSnap = await roomRef.get()
    requireLiveRoom(roomSnap)
    requireHostOrAdmin(roomSnap, uid)
    refuseIfKicked(roomSnap, targetUid)

    const limit = Number(roomSnap.get('seatCount') ?? 0)
    if (seatIndex < 1 || seatIndex > limit) {
      throw new functions.https.HttpsError('out-of-range', `This room has ${limit} seats.`)
    }

    const inviter = await db.collection('users').doc(uid).get()
    await roomRef.collection('seatInvites').doc(targetUid).set({
      targetUid,
      seatIndex,
      byUid: uid,
      byName: String(inviter.get('name') ?? '').trim() || 'The host',
      roomTitle: String(roomSnap.get('title') ?? 'this room'),
      invitedAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    return { invited: true }
  })

/** Accept or decline an invitation to a seat. */
export const respondPartySeatInvite = functions
  .region('asia-south1')
  .https.onCall(async (data: { roomId?: string; accept?: boolean }, context) => {
    const uid = requireAuth(context)
    await assertActiveSession(uid, data, 'respondPartySeatInvite', context.auth?.token)   // Phase 1A (SESSION-001/003)
    const roomId = String(data?.roomId ?? '')
    if (!roomId) throw new functions.https.HttpsError('invalid-argument', 'roomId is required.')

    const roomRef = db.collection('partyRooms').doc(roomId)
    const inviteRef = roomRef.collection('seatInvites').doc(uid)

    if (data?.accept !== true) {
      await inviteRef.delete()
      return { accepted: false }
    }

    const userSnap = await requireUser(uid)

    return db.runTransaction(async (tx) => {
      const [roomSnap, inviteSnap] = await Promise.all([tx.get(roomRef), tx.get(inviteRef)])
      requireLiveRoom(roomSnap)
      if (!inviteSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'That invitation has expired.')
      }
      refuseIfKicked(roomSnap, uid)
      const seatIndex = Number(inviteSnap.get('seatIndex'))
      /*
       * The invited seat may have filled while the popup was on screen. Rather
       * than fail, fall through to the lowest free seat — the person was invited
       * to JOIN, and which chair they land on was the inviter's detail, not
       * theirs.
       */
      const seatsCol = roomRef.collection('seats')
      const targetSnap = await tx.get(seatsCol.doc(String(seatIndex)))
      let index = seatIndex
      if (targetSnap.exists && String(targetSnap.get('uid') ?? '') !== '' && targetSnap.get('uid') !== uid) {
        const allSeats = await tx.get(seatsCol)
        const taken = new Set(allSeats.docs.map((d) => Number(d.id)))
        const locked: number[] = roomSnap.get('lockedSeats') ?? []
        const limit = Number(roomSnap.get('seatCount') ?? 0)
        let free = 0
        for (let i = 1; i <= limit; i++) {
          if (!taken.has(i) && !locked.includes(i)) { free = i; break }
        }
        if (free === 0) {
          throw new functions.https.HttpsError('failed-precondition', 'Every seat is taken now.')
        }
        index = free
      }
      const seated = await seatInTransaction(tx, roomRef, roomSnap, index, uid, userSnap)
      return { accepted: true, ...seated }
    })
  })

// ── Leaving and removing ─────────────────────────────────────────────────────

/**
 * Leave a seat — your own, or (as owner or admin) somebody else's.
 *
 * Three distinct actions share this door because they differ only in scope:
 *
 *   * stand up yourself
 *   * remove somebody from a seat, leaving them in the room as a listener
 *   * remove somebody from the room entirely, and refuse them a token after
 *
 * The middle one is the one people reach for most and the one the old UI made
 * hardest to find.
 */
export const leavePartySeat = functions
  .region('asia-south1')
  .https.onCall(async (data: { roomId?: string; targetUid?: string; kick?: boolean }, context) => {
    const uid = requireAuth(context)
    const roomId = String(data?.roomId ?? '')
    if (!roomId) throw new functions.https.HttpsError('invalid-argument', 'roomId is required.')

    const target = String(data?.targetUid ?? '') || uid
    const roomRef = db.collection('partyRooms').doc(roomId)
    const roomSnap = await roomRef.get()
    if (!roomSnap.exists) throw new functions.https.HttpsError('not-found', 'No such room.')

    let kick = data?.kick === true

    if (target !== uid) {
      const actorRole = requireHostOrAdmin(roomSnap, uid)
      /*
       * An admin cannot touch another admin, or the owner.
       *
       * Without this the admin tier is a self-destruct button: the first admin to
       * fall out with the second removes them, and an admin could remove the
       * person who appointed them. Moderation powers point downwards only.
       */
      const targetRole = roleOf(roomSnap, target)
      if (actorRole === 'admin' && targetRole !== 'member') {
        throw new functions.https.HttpsError(
          'permission-denied',
          'Admins cannot remove the owner or another admin.',
        )
      }
    } else {
      // Removing yourself is never a kick. Otherwise a tap on "leave my seat"
      // would bar you from the room you meant to stay in.
      kick = false
    }

    const { vacated, roomEmpty } = await vacateAndDrop(roomRef, target, {
      alsoListener: false,
      kick,
    })

    if (kick) {
      await db.collection('users').doc(target).set(presence(''), { merge: true })
    }

    return { left: vacated, kicked: kick, roomEmpty }
  })

// ── Mute, camera, locks ──────────────────────────────────────────────────────

/**
 * Mute or unmute a seat, with the hierarchy the product specified.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 *
 *   * The OWNER may mute anybody, and only the owner can lift a mute the owner
 *     placed.
 *   * An ADMIN may mute a member — not the owner, not another admin — and that
 *     mute can be lifted by the owner or by the admin who placed it.
 *   * SELF-MUTE is a different field, and only its owner can clear it.
 *
 * ── WHY IT CANNOT BE A SECURITY RULE ─────────────────────────────────────────
 *
 * `isMuted` alone cannot express any of this, because the question "may you
 * unmute this?" depends on WHO MUTED IT — which means the answer has to be
 * stored alongside the flag and then reasoned about. A rule can compare a field
 * to `request.auth.uid`, but it cannot say "the admin who set this, or the
 * owner, but not a different admin". The old rules gave `isMuted` to the room
 * host and nobody else, which is why the admin tier did not exist at all.
 *
 * Self-mute is safe as a client write — it is the occupant's own field, and the
 * rules already restrict them to `selfMuted` and `cameraOff` — so it does not
 * come through here.
 */
export const setPartySeatMute = functions
  .region('asia-south1')
  .https.onCall(async (data: { roomId?: string; seatIndex?: number; muted?: boolean }, context) => {
    const uid = requireAuth(context)
    await assertActiveSession(uid, data, 'setPartySeatMute', context.auth?.token)   // Phase 1A (SESSION-001/003)
    const roomId = String(data?.roomId ?? '')
    const seatIndex = Number(data?.seatIndex)
    if (!roomId || !Number.isInteger(seatIndex)) {
      throw new functions.https.HttpsError('invalid-argument', 'roomId and seatIndex are required.')
    }
    const muted = data?.muted === true

    const roomRef = db.collection('partyRooms').doc(roomId)
    const seatRef = roomRef.collection('seats').doc(String(seatIndex))

    return db.runTransaction(async (tx) => {
      const [roomSnap, seatSnap] = await Promise.all([tx.get(roomRef), tx.get(seatRef)])
      requireLiveRoom(roomSnap)
      if (!seatSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'Nobody is on that seat.')
      }

      const actorRole = requireHostOrAdmin(roomSnap, uid)
      const occupant = String(seatSnap.get('uid') ?? '')
      const occupantRole = roleOf(roomSnap, occupant)

      if (actorRole === 'admin' && occupantRole !== 'member') {
        throw new functions.https.HttpsError(
          'permission-denied',
          'Admins cannot mute the owner or another admin.',
        )
      }

      if (muted) {
        tx.update(seatRef, { isMuted: true, mutedBy: uid, mutedByRole: actorRole })
        return { muted: true }
      }

      // Unmuting. Who placed it decides who may lift it.
      const placedByRole = String(seatSnap.get('mutedByRole') ?? '')
      const placedBy = String(seatSnap.get('mutedBy') ?? '')
      if (placedByRole === 'owner' && actorRole !== 'owner') {
        throw new functions.https.HttpsError(
          'permission-denied',
          'The owner muted this seat. Only the owner can unmute it.',
        )
      }
      if (placedByRole === 'admin' && actorRole !== 'owner' && placedBy !== uid) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'Another admin muted this seat.',
        )
      }

      tx.update(seatRef, { isMuted: false, mutedBy: '', mutedByRole: '' })
      return { muted: false }
    })
  })

/**
 * Lock a seat so nobody can sit on it, or unlock it. Owner or admin.
 *
 * Server-side now because `lockedSeats` lives on the room document, and the room
 * document had to stop being client-writable — the old rule allowed the host's
 * client to write ANY field on it, `kickedUsers` and `totalBeansEarned`
 * included. Locking was the one legitimate use of that hole.
 */
export const setPartySeatLock = functions
  .region('asia-south1')
  .https.onCall(async (data: { roomId?: string; seatIndex?: number; locked?: boolean }, context) => {
    const uid = requireAuth(context)
    await assertActiveSession(uid, data, 'setPartySeatLock', context.auth?.token)   // Phase 1A (SESSION-001/003)
    const roomId = String(data?.roomId ?? '')
    const seatIndex = Number(data?.seatIndex)
    if (!roomId || !Number.isInteger(seatIndex)) {
      throw new functions.https.HttpsError('invalid-argument', 'roomId and seatIndex are required.')
    }

    const roomRef = db.collection('partyRooms').doc(roomId)
    const roomSnap = await roomRef.get()
    requireLiveRoom(roomSnap)
    requireHostOrAdmin(roomSnap, uid)

    const limit = Number(roomSnap.get('seatCount') ?? 0)
    if (seatIndex < 1 || seatIndex > limit) {
      throw new functions.https.HttpsError('out-of-range', `This room has ${limit} seats.`)
    }

    const locked = data?.locked === true
    await roomRef.update({
      lockedSeats: locked
        ? admin.firestore.FieldValue.arrayUnion(seatIndex)
        : admin.firestore.FieldValue.arrayRemove(seatIndex),
    })
    return { locked }
  })

// ── Admins ──────────────────────────────────────────────────────────────────

/**
 * Appoint or dismiss an admin. Owner only, and deliberately so.
 *
 * An admin who could appoint admins is an owner. The cap exists because `admins`
 * is an array on the room document read by every permission check in this file;
 * an unbounded one would grow until those checks got expensive, and a room
 * needing more than eight moderators has a different problem.
 */
export const setPartyAdmin = functions
  .region('asia-south1')
  .https.onCall(async (data: { roomId?: string; targetUid?: string; isAdmin?: boolean }, context) => {
    const uid = requireAuth(context)
    await assertActiveSession(uid, data, 'setPartyAdmin', context.auth?.token)   // Phase 1A (SESSION-001/003)
    const roomId = String(data?.roomId ?? '')
    const targetUid = String(data?.targetUid ?? '')
    if (!roomId || !targetUid) {
      throw new functions.https.HttpsError('invalid-argument', 'roomId and targetUid are required.')
    }

    const roomRef = db.collection('partyRooms').doc(roomId)
    const roomSnap = await roomRef.get()
    requireLiveRoom(roomSnap)
    requireOwner(roomSnap, uid)

    if (targetUid === uid) {
      throw new functions.https.HttpsError('invalid-argument', 'You already own this room.')
    }

    const grant = data?.isAdmin === true
    const admins: string[] = roomSnap.get('admins') ?? []
    const MAX_ADMINS = 8
    if (grant && !admins.includes(targetUid) && admins.length >= MAX_ADMINS) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        `A room can have at most ${MAX_ADMINS} admins.`,
      )
    }

    await roomRef.update({
      admins: grant
        ? admin.firestore.FieldValue.arrayUnion(targetUid)
        : admin.firestore.FieldValue.arrayRemove(targetUid),
    })
    return { isAdmin: grant }
  })

// ── endPartyRoom ─────────────────────────────────────────────────────────────

/**
 * B7 (3 Nov 2026): room music. The owner or an admin picks a track from Zipper's own catalogue
 * (`musicTracks/{id}` — licensed tracks the Owner adds in the CRM; an empty catalogue plays nothing) and plays it
 * into the room: their phone mixes it into the audio they publish (Agora audio mixing), and the room document says
 * what is playing so everybody sees it. Only a track from the catalogue can be named — never an arbitrary URL.
 */
export const setPartyMusic = functions
  .region('asia-south1')
  .https.onCall(async (data: { roomId?: string; trackId?: string | null; playing?: boolean }, context) => {
    const uid = requireAuth(context)
    const roomId = String(data?.roomId ?? '')
    if (!roomId) throw new functions.https.HttpsError('invalid-argument', 'roomId is required.')
    const roomRef = db.collection('partyRooms').doc(roomId)
    const roomSnap = await roomRef.get()
    requireLiveRoom(roomSnap)
    requireHostOrAdmin(roomSnap, uid)
    const trackId = String(data?.trackId ?? '')
    if (!trackId) {
      await roomRef.update({ music: admin.firestore.FieldValue.delete() })
      return { playing: false }
    }
    const track = await db.collection('musicTracks').doc(trackId).get()
    const url = String(track.get('url') ?? '')
    if (!track.exists || track.get('enabled') === false || !/^https:\/\//.test(url)) {
      throw new functions.https.HttpsError('not-found', 'That track is not available.')
    }
    const music = {
      trackId, title: String(track.get('title') ?? 'Music').slice(0, 80), artist: String(track.get('artist') ?? '').slice(0, 80),
      url, playing: data?.playing !== false, by: uid, startedAtMs: Date.now(),
    }
    await roomRef.update({ music })
    return { playing: music.playing, title: music.title }
  })

/**
 * Close the room.
 *
 * The owner may always close it. Anyone else may close it only once it is
 * provably empty — no seat has been occupied for [EMPTY_GRACE_MS] — and that is
 * not a loophole: ending a room nobody is sitting in harms nobody, and it is
 * what makes the two-second auto-close work without a server-side timer.
 *
 * The alternative was a scheduled sweep, and the fastest useful cron is one a
 * minute. An abandoned room lingering in the list for up to sixty seconds is
 * exactly the ghost-room defect this was supposed to fix, so the last client out
 * closes the door and the cron (`sweepEmptyPartyRooms`) is only the backstop for
 * when there is no last client — a crash, a killed process, a dead network.
 */
export const endPartyRoom = functions
  .region('asia-south1')
  .https.onCall(async (data: { roomId?: string }, context) => {
    const uid = requireAuth(context)
    const roomId = String(data?.roomId ?? '')
    if (!roomId) throw new functions.https.HttpsError('invalid-argument', 'roomId is required.')

    const roomRef = db.collection('partyRooms').doc(roomId)
    const roomSnap = await roomRef.get()
    if (!roomSnap.exists) return { ended: true }
    if (roomSnap.get('isActive') === false) return { ended: true, already: true }

    if (roomSnap.get('hostUid') !== uid) {
      const emptySince = roomSnap.get('emptySince') as admin.firestore.Timestamp | null
      // B2a: and nobody is in it — not on a seat, not in the lobby.
      const empty = emptySince != null && Date.now() - emptySince.toMillis() >= EMPTY_GRACE_MS
        && roomIsEmpty(Number(roomSnap.get('occupantCount') ?? 0) || 0, Number(roomSnap.get('listenerCount') ?? 0) || 0)
      if (!empty) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'Only the host can close this room.',
        )
      }
    }

    await closeRoom(roomRef)
    return { ended: true }
  })

/**
 * The teardown, shared by the callable and the sweep.
 *
 * Clears every occupant's presence flag on the way out. Leaving `isInParty` true
 * on somebody whose room has closed is what makes a user permanently "in a
 * party" in the discovery ranking — the exact defect `syncLivePresence` was
 * written to fix for live rooms.
 */
async function closeRoom(roomRef: admin.firestore.DocumentReference): Promise<void> {
  const roomSnap = await roomRef.get()
  if (!roomSnap.exists) return

  const [seats, listeners] = await Promise.all([
    roomRef.collection('seats').get(),
    roomRef.collection('listeners').get(),
  ])

  const batch = db.batch()
  const cleared = new Set<string>()

  const clear = (someone: string) => {
    if (!someone || cleared.has(someone)) return
    cleared.add(someone)
    batch.set(db.collection('users').doc(someone), presence(''), { merge: true })
  }

  seats.docs.forEach((d) => {
    clear(String(d.get('uid') ?? ''))
    batch.delete(d.ref)
  })
  /*
   * Listeners get their flag cleared but their documents are left alone.
   *
   * A room can hold far more listeners than the 500 writes a batch allows, and
   * the presence flag is the part that would otherwise strand somebody at the
   * top of the discovery feed forever. The rows themselves die with the room —
   * nothing reads a closed room's listeners.
   */
  listeners.docs.slice(0, 400).forEach((d) => clear(String(d.get('uid') ?? '')))
  clear(String(roomSnap.get('hostUid') ?? ''))

  batch.update(roomRef, {
    isActive: false,
    endedAt: admin.firestore.FieldValue.serverTimestamp(),
    listenerCount: 0,
    occupantCount: 0,
  })
  // F-7: a closed room holds no secret. (Deleting a document that does not
  // exist is a no-op, so a public room costs nothing here.)
  batch.delete(secretRefOf(roomRef))

  await batch.commit()
}

// ── sweepEmptyPartyRooms ─────────────────────────────────────────────────────

/**
 * The backstop for rooms nobody closed.
 *
 * Two cases, with deliberately different fuses:
 *
 *   * A room that emptied and whose last client never got to call `endPartyRoom`
 *     — process killed, network gone. `emptySince` is set, so two seconds is
 *     already long past by the time this runs.
 *
 *   * A room that was NEVER occupied. Somebody opened it and closed the app
 *     before sitting down. `emptySince` is null here on purpose (see
 *     `createPartyRoom`), so these are found by age instead, with a generous
 *     fuse — a room can legitimately sit open for a few minutes while its owner
 *     invites people before anyone takes a seat, and closing that out from under
 *     them would be worse than a ghost room.
 *
 * B2a (3 Nov 2026): first it removes people who left without leaving (`pruneStaleListeners`), and in BOTH cases a
 * room with anybody still in its lobby stays open — empty seats are not an empty room.
 */
export const NEVER_OCCUPIED_GRACE_MS = 10 * 60 * 1000

export async function sweepPartyRoomsOnce(nowMs: number): Promise<{ pruned: number; closed: number }> {
  const pruned = await pruneStaleListeners(nowMs)

  const emptied = await db
    .collection('partyRooms')
    .where('isActive', '==', true)
    .where('emptySince', '<', admin.firestore.Timestamp.fromMillis(nowMs - EMPTY_GRACE_MS))
    .limit(50)
    .get()

  const neverSat = await db
    .collection('partyRooms')
    .where('isActive', '==', true)
    .where('occupantCount', '==', 0)
    .where('startedAt', '<', admin.firestore.Timestamp.fromMillis(nowMs - NEVER_OCCUPIED_GRACE_MS))
    .limit(50)
    .get()

  const seen = new Set<string>()
  let closed = 0
  for (const doc of [...emptied.docs, ...neverSat.docs]) {
    if (seen.has(doc.id)) continue
    seen.add(doc.id)
    // Read again: the counts are what decide it, and somebody may have walked in since the query ran.
    const fresh = await doc.ref.get()
    if (!fresh.exists || fresh.get('isActive') === false) continue
    const seated = Math.max(0, Number(fresh.get('occupantCount') ?? 0) || 0)
    const listening = Math.max(0, Number(fresh.get('listenerCount') ?? 0) || 0)
    if (!roomIsEmpty(seated, listening)) continue
    try {
      await closeRoom(doc.ref)
      closed++
    } catch (err) {
      functions.logger.error(`sweepEmptyPartyRooms: ${doc.ref.path}`, err)
    }
  }
  return { pruned, closed }
}

export const sweepEmptyPartyRooms = functions
  .region('asia-south1')
  .pubsub.schedule('every 1 minutes')
  .timeZone('Asia/Kolkata')
  .onRun(async () => {
    const { pruned, closed } = await sweepPartyRoomsOnce(Date.now())
    if (pruned > 0 || closed > 0) {
      functions.logger.info(`sweepEmptyPartyRooms: ${pruned} stale listener(s) removed, ${closed} room(s) closed.`)
    }
    return null
  })
