import * as crypto from 'crypto'

/**
 * The Agora uid a Firebase account publishes and subscribes under.
 *
 * ── Why the server picks it (F-6) ────────────────────────────────────────────
 *
 * The app used to send `uid: 0` ("let Agora assign") and the server signed
 * whatever number arrived. `agora-access-token` treats uid 0 as "any uid":
 * the token is not bound to an identity at all, so a modified client with a
 * legitimate viewer token could join as the host's uid, and Agora — which
 * allows one session per uid per channel — would drop the host. The same
 * trick works against either party of a call.
 *
 * So the uid is derived here, from the Firebase uid, and the token is signed
 * for exactly that number. Stable (the same account always gets the same
 * uid, so a token re-issued before expiry joins as the same participant),
 * never zero, and 31-bit so every Agora SDK and the Kotlin `Int` the app
 * joins with hold it without sign trouble.
 *
 * Party seats are the exception and stay as they are: the SEAT index is the
 * uid there, because every client in the room binds a seat's tile to it.
 */

/** First four bytes of SHA-256(uid), masked to 31 bits; 1 if that is 0. */
export function deriveAgoraUid(firebaseUid: string): number {
  if (typeof firebaseUid !== 'string' || firebaseUid.length === 0) {
    throw new Error('deriveAgoraUid: a Firebase uid is required')
  }
  const digest = crypto.createHash('sha256').update(firebaseUid, 'utf8').digest()
  const n = digest.readUInt32BE(0) & 0x7fffffff
  return n === 0 ? 1 : n
}
