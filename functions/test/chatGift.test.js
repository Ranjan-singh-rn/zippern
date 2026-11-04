/**
 * O5 (5 Nov 2026) — a gift sent outside a room (`dm`: from a chat, a profile or a call) shows in the two people's
 * chat, written by settleGift in the same transaction as the money, and is refused when the receiver has blocked
 * the sender. Run against the in-memory Firestore (lib/, as deployed).
 *
 * Run:  node --test test/chatGift.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore()
const gifts = require('../lib/gifts')

const S = 'ALICE'
const R = 'BOB'
const token = { auth_time: 2000, firebase: { sign_in_provider: 'phone' } }
const send = (data) => gifts.settleGift.run({ data: { context: 'dm', ...data }, auth: { uid: S, token } })
const ROSE = { name: 'Rose', emoji: '🌹', imageUrl: 'https://x/rose.png', category: 'normal', diamondCost: 10, isActive: true }
const convo = 'ALICE_BOB'   // the sorted pair, as ChatRepository.convoId builds it

async function refusalOf(p) { try { await p } catch (e) { return e } return null }

beforeEach(() => {
  db._docs.clear()
  db.seed(`users/${S}`, { name: 'Alice', photoUrl: 'https://x/alice.jpg', diamonds: 500 })
  db.seed(`users/${R}`, { name: 'Bob', photoUrl: 'https://x/bob.jpg', beans: 0, isHost: true, isVerifiedHost: true })
  db.seed('gifts/rose', ROSE)
})

describe('a dm gift is a chat message only the server writes', () => {
  test('the gift lands in the chat with the money: one message, the conversation upserted', async () => {
    const r = await send({ giftId: 'rose', receiverUid: R, quantity: 2, idempotencyKey: 'k1' })
    expect(r.replayed).toBe(false)
    const msgs = db.all(`conversations/${convo}/messages`)
    expect(msgs).toHaveLength(1)
    const m = msgs[0]
    expect(m.id).toBe(`gift_${r.transactionId}`)
    expect(m).toMatchObject({
      senderUid: S, senderName: 'Alice', type: 'gift', text: '🎁 Rose ×2', giftId: 'rose', giftName: 'Rose',
      giftImageUrl: 'https://x/rose.png', giftEmoji: '🌹', quantity: 2, transactionId: r.transactionId, isRead: false,
    })
    expect(typeof m.timestamp).toBe('number')
    const c = db.read(`conversations/${convo}`)
    expect(c.participants).toEqual([S, R])
    expect(c.lastMessage).toBe('🎁 Rose ×2')
    expect(c.lastMessageSenderUid).toBe(S)
    expect(c.lastMessageAt).toBe(m.timestamp)
    // Each side stores its counterpart's name and photo.
    expect(c[`otherUserName_${S}`]).toBe('Bob')
    expect(c[`otherUserName_${R}`]).toBe('Alice')
    expect(c[`otherUserPhotoUrl_${S}`]).toBe('https://x/bob.jpg')
    expect(c[`otherUserPhotoUrl_${R}`]).toBe('https://x/alice.jpg')
    // …and the money moved in the same transaction.
    expect(db.read(`users/${S}`).diamonds).toBe(480)
  })

  test('a replay of the same tap writes no second message', async () => {
    const a = await send({ giftId: 'rose', receiverUid: R, quantity: 1, idempotencyKey: 'same' })
    const b = await send({ giftId: 'rose', receiverUid: R, quantity: 1, idempotencyKey: 'same' })
    expect(b.replayed).toBe(true)
    expect(b.transactionId).toBe(a.transactionId)
    expect(db.all(`conversations/${convo}/messages`)).toHaveLength(1)
    expect(db.read(`users/${S}`).diamonds).toBe(490)
  })

  test('one gift reads "🎁 Rose" (no ×1)', async () => {
    await send({ giftId: 'rose', receiverUid: R, quantity: 1, idempotencyKey: 'one' })
    expect(db.all(`conversations/${convo}/messages`)[0].text).toBe('🎁 Rose')
  })
})

describe('blocking', () => {
  test('a receiver who blocked the sender gets no gift: refused, nothing moved, nothing in the chat', async () => {
    db.seed(`users/${R}/blocked/${S}`, { blockedAt: 1 })
    const err = await refusalOf(send({ giftId: 'rose', receiverUid: R, quantity: 1, idempotencyKey: 'k2' }))
    expect(err).toBeTruthy()
    expect(String(err.code)).toContain('permission-denied')
    expect(db.read(`users/${S}`).diamonds).toBe(500)
    expect(db.all(`conversations/${convo}/messages`)).toHaveLength(0)
    expect(db.all('giftTransactions')).toHaveLength(0)
  })

  test('the SENDER having blocked the receiver does not stop the sender paying them', async () => {
    db.seed(`users/${S}/blocked/${R}`, { blockedAt: 1 })
    const r = await send({ giftId: 'rose', receiverUid: R, quantity: 1, idempotencyKey: 'k3' })
    expect(r.replayed).toBe(false)
  })
})

describe('the helper', () => {
  test('blank names and photos are left out, so a merge never blanks what the app stored', () => {
    const w = gifts.dmGiftChatWrites({
      senderUid: 'B', receiverUid: 'A', transactionId: 'T1', giftId: 'g', quantity: 3,
      gift: { name: '', imageUrl: undefined, emoji: null }, sender: { name: '  ' }, receiver: {}, now: 42,
    })
    expect(w.convoId).toBe('A_B')
    expect(w.messageId).toBe('gift_T1')
    expect(w.message.text).toBe('🎁 a gift ×3')
    expect(w.message.giftImageUrl).toBe('')
    expect(Object.keys(w.conversation).filter((k) => k.startsWith('otherUser'))).toEqual([])
    expect(w.conversation.lastMessageAt).toBe(42)
  })
})

describe('only dm', () => {
  test('a live gift writes nothing into any chat', async () => {
    db.seed('liveRooms/L1', { hostUid: R, isActive: true })
    await gifts.settleGift.run({
      data: { context: 'live', roomId: 'L1', giftId: 'rose', receiverUid: R, quantity: 1, idempotencyKey: 'k4' },
      auth: { uid: S, token },
    })
    expect(db.all(`conversations/${convo}/messages`)).toHaveLength(0)
  })
})
