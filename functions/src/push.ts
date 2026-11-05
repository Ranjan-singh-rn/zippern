/**
 * Push notifications (FCM).
 *
 * Three things the app cannot do for itself while it is in the background:
 *
 *   1. Ring. `calls/{id}` is created → the receiver's phone gets a HIGH
 *      priority data message. Android delivers those even in Doze, the app's
 *      messaging service posts a full-screen "incoming call" notification, and
 *      tapping it deep-links into the call. When the call leaves `ringing`
 *      (accepted elsewhere, cancelled, missed) a second message tells the
 *      device to take the notification down.
 *   2. Chat. A new message in `conversations/{cid}/messages` → the other
 *      participant gets a notification with the sender's name and the text.
 *   3. Live. A `liveRooms` doc goes active → the host's followers are told.
 *
 * Everything is a DATA message, never a "notification" message. A notification
 * message is rendered by the OS with no app code involved, which means no
 * full-screen intent, no ringtone, no way to suppress it when the user is
 * already looking at that chat. Data messages hand control to
 * ZipperMessagingService, which decides what to show.
 *
 * Tokens live in `users/{uid}/fcmTokens/{token}` — ONE DOCUMENT PER DEVICE.
 * They used to be a single `fcmToken` string on the user document, so signing in
 * on a second phone silently unregistered the first. Every send fans out to
 * every device the account holds. The legacy field is still read (as a fallback)
 * and still cleaned up until every client has migrated.
 *
 * Tokens that FCM reports as dead are removed so the next send does not retry
 * them.
 */
import * as functions from 'firebase-functions/v1'
import * as logger from 'firebase-functions/logger'
import * as admin from 'firebase-admin'
import { findBadWords, maskText, safetyConfig, wordListOf } from './safety'

const db = admin.firestore()
const messaging = admin.messaging()
const asia = functions.region('asia-south1').firestore

/** O13: [text] with the words the chat screen masks already masked. Never throws — a push must still go. */
async function screenedText(text: string): Promise<string> {
  try {
    const hits = findBadWords(text, wordListOf(await safetyConfig()))
    return maskText(text, hits)
  } catch {
    return text
  }
}

type Data = Record<string, string>

/**
 * Every device token this account holds.
 *
 * The subcollection is the source of truth. The legacy `users/{uid}.fcmToken`
 * field is consulted ONLY when the subcollection is empty, which covers an
 * account whose devices are all still on a client build that writes the old
 * shape — once any of them updates, the subcollection wins and the legacy field
 * is ignored (it is a duplicate of one of the devices, and sending to the same
 * token twice would post the notification twice).
 */
async function tokensFor(uid: string): Promise<string[]> {
  const userRef = db.collection('users').doc(uid)
  const snap = await userRef.collection('fcmTokens').get()
  const tokens: string[] = snap.docs
    .map((d): string => {
      const t = d.get('token')
      // The document id IS the token; the field is a copy, so either will do.
      return typeof t === 'string' && t.length > 0 ? t : d.id
    })
    .filter((t) => t.length > 0)
  if (tokens.length > 0) return Array.from(new Set(tokens))

  const legacy = (await userRef.get()).get('fcmToken')
  return typeof legacy === 'string' && legacy.length > 0 ? [legacy] : []
}

/**
 * Forget one dead token: its own document, and the legacy field IF that field
 * names this very token. Clearing the legacy field unconditionally would
 * unregister whichever device happened to have written it last.
 */
async function dropDeadToken(uid: string, token: string): Promise<void> {
  const userRef = db.collection('users').doc(uid)
  await userRef.collection('fcmTokens').doc(token).delete().catch(() => undefined)
  await db
    .runTransaction(async (tx) => {
      const snap = await tx.get(userRef)
      if (snap.exists && snap.get('fcmToken') === token) {
        tx.update(userRef, { fcmToken: admin.firestore.FieldValue.delete() })
      }
    })
    .catch(() => undefined)
}

/**
 * Send one data message. `call` = true uses the highest Android priority and
 * a short TTL — a call that could not be delivered inside 30s is not a call
 * worth delivering.
 */
async function send(uid: string, token: string, data: Data, call = false): Promise<void> {
  try {
    await messaging.send({
      token,
      data,
      android: {
        priority: 'high',
        ttl: call ? 30_000 : 24 * 60 * 60 * 1000,
        ...(call ? { directBootOk: true } : {}),
      },
    })
  } catch (e: any) {
    const code = e?.errorInfo?.code ?? e?.code ?? ''
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token' ||
      code === 'messaging/invalid-argument'
    ) {
      // Uninstalled or token rotated without a new login. Drop that ONE device.
      await dropDeadToken(uid, token)
      logger.info('push: dropped dead token', { uid, code })
      return
    }
    logger.warn('push: send failed', { uid, code, message: e?.message })
  }
}

/** Fan out to every device the account is signed in on. */
async function sendToUser(uid: string, data: Data, call = false): Promise<void> {
  const tokens = await tokensFor(uid)
  if (tokens.length === 0) return
  // One failing device must not stop the others — `send` swallows its own
  // errors, so this settles either way.
  await Promise.all(tokens.map((t) => send(uid, t, data, call)))
}

// ── Calls ────────────────────────────────────────────────────────────────────

export const pushIncomingCall = asia
  .document('calls/{callId}')
  .onCreate(async (snap, context) => {
    const call = snap.data() as Record<string, any>
    if (call.status !== 'ringing') return null
    const receiverUid = call.receiverId as string
    if (!receiverUid) return null
    await sendToUser(
      receiverUid,
      {
        type: 'INCOMING_CALL',
        callId: context.params.callId as string,
        callerUid: String(call.callerId ?? ''),
        callerName: String(call.callerName ?? 'Someone'),
        callerPhotoUrl: String(call.callerPhotoUrl ?? ''),
        createdAt: String(Date.now()),
      },
      true,
    )
    return null
  })

export const pushCallStatus = asia
  .document('calls/{callId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data() as Record<string, any>
    const after = change.after.data() as Record<string, any>
    if (before.status !== 'ringing' || after.status === 'ringing') return null
    // Whatever happened — accepted on this device, cancelled by the caller,
    // timed out — the ringing notification must go away.
    const receiverUid = after.receiverId as string
    if (!receiverUid) return null
    await sendToUser(
      receiverUid,
      { type: 'CALL_ENDED', callId: context.params.callId as string, status: String(after.status) },
      true,
    )
    return null
  })

// ── Chat ─────────────────────────────────────────────────────────────────────

export const pushChatMessage = asia
  .document('conversations/{convoId}/messages/{msgId}')
  .onCreate(async (snap, context) => {
    const msg = snap.data() as Record<string, any>
    const senderUid = msg.senderUid as string
    if (!senderUid) return null
    const convoId = context.params.convoId as string
    // Conversation id is the sorted uid pair; the recipient is the other half.
    const recipient = convoId.split('_').find((u) => u && u !== senderUid)
    if (!recipient) return null

    // Do not notify someone who has blocked the sender.
    const blocked = await db.collection('users').doc(recipient).collection('blocked').doc(senderUid).get()
    if (blocked.exists) return null

    const type = String(msg.type ?? 'text')
    // O13: the push preview is screened too — the message is masked a moment after it lands, the notification is not.
    const shown = type === 'text' ? await screenedText(String(msg.text ?? '')) : ''
    const preview =
      type === 'text' ? shown.slice(0, 120)
      : type === 'image' ? 'Sent a photo'
      : type === 'voice' ? 'Sent a voice message'
      // O5: written by settleGift only (firestore.rules refuses a client-written gift message).
      : type === 'gift' ? `Sent you a gift: ${String(msg.giftName ?? 'a gift').slice(0, 60)}`
      : type === 'invite' ? 'Invited you to a live'
      : 'Sent a message'

    await sendToUser(recipient, {
      type: 'NEW_MESSAGE',
      convoId,
      senderUid,
      senderName: String(msg.senderName ?? 'New message'),
      preview,
    })
    return null
  })

// ── Live ─────────────────────────────────────────────────────────────────────

export const pushLiveStarted = functions
  .region('asia-south1')
  // F-13 (audit 2026-11-01): the comment below always assumed 540 s, but the
  // builder never asked for it — the fan-out ran under the default 60 s and a
  // popular host's followers past the first few hundred were silently never
  // told. Now the timeout matches the budget the cap was sized for.
  .runWith({ timeoutSeconds: 540, memory: '256MB' })
  .firestore
  .document('liveRooms/{roomId}')
  .onCreate(async (snap, context) => {
    const room = snap.data() as Record<string, any>
    if (room.isActive === false) return null
    const hostUid = room.hostUid as string
    if (!hostUid) return null

    // Followers are fanned out in pages of 500 (FCM's multicast limit).
    //
    // HARD CAP AT 2000. Beyond that this single invocation would read one token
    // subcollection per follower and hold the whole fan-out in one function
    // call — minutes of work under one 540s timeout, and a retry repeats all of
    // it. A host with more followers than this needs the fan-out moved to a task
    // queue (Cloud Tasks / `onTaskDispatched`), one enqueued chunk per page,
    // which is still to be done. Until then the 2001st follower is not notified,
    // which is a missed notification rather than a timed-out function.
    const followers = await db
      .collection('users')
      .doc(hostUid)
      .collection('followers')
      .select()
      .limit(2000)
      .get()
    if (followers.empty) return null

    const uids = followers.docs.map((d) => d.id)
    const data: Data = {
      type: 'LIVE_STARTED',
      roomId: context.params.roomId as string,
      hostUid,
      hostName: String(room.hostName ?? 'Someone you follow'),
      hostPhotoUrl: String(room.hostPhotoUrl ?? ''),
      title: String(room.title ?? ''),
    }

    // Collect EVERY device of every follower. A follower with two phones is two
    // targets; one of them going dead must not unregister the other, so a target
    // is (uid, token) and cleanup is per token.
    const targets: { uid: string; token: string }[] = []
    for (let i = 0; i < uids.length; i += 100) {
      const page = uids.slice(i, i + 100)
      const perUser = await Promise.all(
        page.map(async (u) => ({ uid: u, tokens: await tokensFor(u) })),
      )
      perUser.forEach(({ uid, tokens }) => tokens.forEach((token) => targets.push({ uid, token })))
    }
    if (targets.length === 0) return null

    // 500 is FCM's multicast limit, and it is a limit on TOKENS — which is no
    // longer the same number as followers.
    for (let i = 0; i < targets.length; i += 500) {
      const chunk = targets.slice(i, i + 500)
      const res = await messaging.sendEachForMulticast({
        tokens: chunk.map((t) => t.token),
        data,
        android: { priority: 'high', ttl: 60 * 60 * 1000 },
      })
      const dead: { uid: string; token: string }[] = []
      res.responses.forEach((r, idx) => {
        const code = r.error?.code ?? ''
        if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
          dead.push(chunk[idx])
        }
      })
      if (dead.length) {
        await Promise.all(dead.map((d) => dropDeadToken(d.uid, d.token)))
      }
    }
    return null
  })
