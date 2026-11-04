/**
 * B12 (4 Nov 2026) — live rooms, comments, presence and PK invites under firestore.rules (E8 in the header).
 *
 *   firebase emulators:exec --only firestore --project demo-zipper-b12 "node tests/firestore.b12live.rules.test.mjs"
 *   (local-stack.command: `rules b12` — its own emulator on 127.0.0.1:8085, B12_FIRESTORE_PORT)
 *
 * Runs in its OWN project (`demo-zipper-b12`) and its own emulator, so `clearFirestore()` and the uploaded rules
 * never touch the local test copy's `demo-zipper` data. ZIPPER_STATIC_ONLY=1 runs the text checks alone.
 *
 * What it proves, against the emulator:
 *   * a host opens a room only live, empty and unpaid; may change their own presentation, moderation, heartbeat
 *     and pause — and NOT totals, PK fields, the peak or `hostUid`; an ended room stays ended;
 *   * a viewer moves `viewerCount` by one and `likeCount` by +1, nothing else;
 *   * a comment carries the writer's own uid and 1–300 characters; a muted, kicked or blocked viewer posts none;
 *     the host may delete one;
 *   * a viewer the host blocked cannot add a presence row;
 *   * no client creates or changes a PK invite.
 *
 * And, since 4 Nov 2026, the rest of Track B (header E1–E7) — kept in this file because `rules b12` is the one
 * rules job that runs in its own emulator project:
 *   * games: matches readable by signed-in accounts, written by nobody; private seeds, the game ledger, the replay
 *     guard and promo credits deny-all; a player's own history readable by them and Finance, written by nobody;
 *   * the Owner-only appConfig documents (games, leaderboards, partySubscription): an MFA-bound Owner writes them;
 *     Tech, Finance and a password-only Owner do not; other appConfig documents stay Tech's;
 *   * leaderboards public to signed-in accounts and written by nobody; settlements for the Owner and Finance;
 *   * the music catalogue (enabled tracks only, Tech writes); Party Pro (the holder and staff read, nobody writes);
 *   * a party room's access log (its owner and staff) and PIN misses (nobody);
 *   * seller-to-seller trades (the two sellers and staff read, nobody writes);
 *   * O5: a chat message names its writer, is text / photo / voice / invite (never a gift — settleGift writes
 *     those), and only its sender edits or deletes it; "delete chat" is a participant's own `clearedAt`.
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { doc, setDoc, getDoc, updateDoc, deleteDoc, increment, serverTimestamp, arrayUnion, Timestamp } from 'firebase/firestore'

const here = dirname(fileURLToPath(import.meta.url))
const RULES_PATH = process.env.ZIPPER_RULES_FILE || join(here, '..', 'firestore.rules')
const RULES = readFileSync(RULES_PATH, 'utf8')
const RULES_SHA256 = createHash('sha256').update(RULES, 'utf8').digest('hex')
console.log(`rules under test: ${RULES_PATH}`)
console.log(`rules sha256: ${RULES_SHA256}`)

const tally = { checks: 0, failures: 0 }
const failed = []
function fact(claim, holds, detail = '') {
  tally.checks += 1
  if (holds) return
  tally.failures += 1
  failed.push(`[static] ${claim}`)
  console.error(`  FAIL  [static] ${claim}${detail ? `\n        ${detail}` : ''}`)
}
function isPermissionDenied(err) {
  const code = String(err?.code ?? '').toLowerCase()
  const msg = String(err?.message ?? '').toLowerCase()
  return code === 'permission-denied' || code === 'permission_denied' || msg.includes('permission_denied') || msg.includes('permission denied')
}
async function expectRule(claim, run, shouldPass) {
  tally.checks += 1
  let kind = 'allowed'
  let err = null
  try { await run() } catch (e) { err = e; kind = isPermissionDenied(e) ? 'denied' : 'error' }
  const passed = shouldPass ? kind === 'allowed' : kind === 'denied'
  if (passed) return
  tally.failures += 1
  failed.push(`[${shouldPass ? 'ok' : 'no'}:${kind}] ${claim}`)
  console.error(`  FAIL  ${claim}\n        ${kind === 'allowed' ? 'the request was ALLOWED' : String(err?.message ?? err).split('\n')[0]}`)
}
const ok = (claim, run) => expectRule(claim, run, true)
const no = (claim, run) => expectRule(claim, run, false)
function printResult(aborted) {
  console.log(`B12-RESULT checks=${tally.checks} failures=${tally.failures} aborted=${aborted ? 1 : 0} rules_sha256=${RULES_SHA256}`)
}

// ── Static ─────────────────────────────────────────────────────────────────
const code = RULES.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ')
fact('S: the host may change only hostLiveFields()', code.includes('(isLiveHost() && hostLiveWriteOk())'))
fact('S: pkInvites take no client create', /match \/pkInvites\/\{inviteId\} \{ allow read: if request\.auth != null; allow create: if false;/.test(code))
fact('S: a comment carries the writer\'s own uid', code.includes('request.resource.data.uid == request.auth.uid'))
fact('S (Track B): games, leaderboards and partySubscription are the Owner\'s config', code.includes("return docId in ['games', 'leaderboards', 'partySubscription'];"))
fact('S (Track B): the game ledger is deny-all', /match \/gameLedger\/\{rowId\} \{ allow read, write: if false; \}/.test(code))
if (process.env.ZIPPER_STATIC_ONLY === '1') {
  if (tally.failures === 0) console.log(`\nAll ${tally.checks} B12 static checks passed (emulator checks NOT run).`)
  printResult(false)
  await new Promise((r) => setTimeout(r, 200))
  process.exit(tally.failures > 0 ? 1 : 0)
}

// Its own emulator (local-stack.command `rules b12` starts one on 8085 with emulators:exec), so the local test
// copy's single-project emulator on 8080 is never touched.
const PORT = Number(process.env.B12_FIRESTORE_PORT || 8085)
const testEnv = await initializeTestEnvironment({
  projectId: 'demo-zipper-b12',
  firestore: { rules: RULES, host: '127.0.0.1', port: PORT },
})
async function seed(path, data) {
  await testEnv.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), path), data) })
}
const handles = new Map()
const D = (ctx, path) => {
  if (!handles.has(ctx)) handles.set(ctx, ctx.firestore())
  return doc(handles.get(ctx), path)
}
const user = (uid) => testEnv.authenticatedContext(uid, { phone_number: '+919800000000', auth_time: 5000, firebase: { sign_in_provider: 'phone' } })
// A CRM login: a password sign-in with a crmUsers row (seeded in trackB()).
const crm = (uid) => testEnv.authenticatedContext(uid, { email: `${uid}@zipper.test`, auth_time: 5000, firebase: { sign_in_provider: 'password' } })
// An Owner whose sign-in the backend bound to an MFA session (ownerMfaOk(): custom token + mfa_sid + live binding).
const boundOwner = (uid) => testEnv.authenticatedContext(uid, { mfa_sid: 'SID1', auth_time: 5000, firebase: { sign_in_provider: 'custom' } })

async function main() {
  await testEnv.clearFirestore()
  await seed('users/uidHost', { uid: 'uidHost', name: 'Host', isHost: true, isVerifiedHost: true, isProfileComplete: true })
  for (const u of ['uidViewer', 'uidMuted', 'uidKicked', 'uidBlocked', 'uidOther']) {
    await seed(`users/${u}`, { uid: u, name: u, isProfileComplete: true })
  }
  const host = user('uidHost'), viewer = user('uidViewer'), muted = user('uidMuted')
  const kicked = user('uidKicked'), blocked = user('uidBlocked')

  console.log('A — opening a room')
  await no('A: a room opened with a viewer count is refused',
    () => setDoc(D(host, 'liveRooms/R0'), { hostUid: 'uidHost', isActive: true, viewerCount: 500 }))
  await no('A: …with earnings already on it',
    () => setDoc(D(host, 'liveRooms/R0'), { hostUid: 'uidHost', isActive: true, totalBeansEarned: 99999 }))
  await ok('A: live, empty and unpaid is accepted',
    () => setDoc(D(host, 'liveRooms/R1'), { hostUid: 'uidHost', isActive: true, viewerCount: 0, totalBeansEarned: 0, totalGiftsReceived: 0 }))

  console.log('B — what the host may change')
  await ok('B: pause, with the server clock', () => updateDoc(D(host, 'liveRooms/R1'), { isPaused: true, pausedAt: serverTimestamp() }))
  await no('B: a pause mark from the phone\'s clock', () => updateDoc(D(host, 'liveRooms/R1'), { pausedAt: new Date(Date.now() + 864e5) }))
  await ok('B: heartbeat, with the server clock', () => updateDoc(D(host, 'liveRooms/R1'), { hostHeartbeatAt: serverTimestamp() }))
  await no('B: a heartbeat from the future', () => updateDoc(D(host, 'liveRooms/R1'), { hostHeartbeatAt: new Date(Date.now() + 864e5) }))
  await ok('B: a pinned message of 140 characters', () => updateDoc(D(host, 'liveRooms/R1'), { pinnedMessage: 'x'.repeat(140) }))
  await no('B: …of 141', () => updateDoc(D(host, 'liveRooms/R1'), { pinnedMessage: 'x'.repeat(141) }))
  await ok('B: mute a viewer in chat', () => updateDoc(D(host, 'liveRooms/R1'), { mutedViewers: arrayUnion('uidMuted') }))
  await ok('B: kick a viewer', () => updateDoc(D(host, 'liveRooms/R1'), { kickedViewers: arrayUnion('uidKicked') }))
  await no('B: raise their own earnings', () => updateDoc(D(host, 'liveRooms/R1'), { totalBeansEarned: 100000 }))
  await no('B: set their own PK score', () => updateDoc(D(host, 'liveRooms/R1'), { pkScore: 100000 }))
  await no('B: start a PK by hand', () => updateDoc(D(host, 'liveRooms/R1'), { pkActive: true }))
  await no('B: give the room to somebody else', () => updateDoc(D(host, 'liveRooms/R1'), { hostUid: 'uidOther' }))
  await ok('B: queue for PK (their own pkWaiting)', () => updateDoc(D(host, 'liveRooms/R1'), { pkWaiting: true }))
  await ok('B (O1): switch incoming calls off while live', () => updateDoc(D(host, 'liveRooms/R1'), { hostBlocksCalls: true }))
  await ok('B (O1): …and back on', () => updateDoc(D(host, 'liveRooms/R1'), { hostBlocksCalls: false }))

  console.log('C — what a viewer may change')
  await ok('C: a like adds one', () => updateDoc(D(viewer, 'liveRooms/R1'), { likeCount: increment(1) }))
  await no('C: a like of a thousand', () => updateDoc(D(viewer, 'liveRooms/R1'), { likeCount: increment(1000) }))
  await ok('C: an older build\'s join moves the count by one', () => updateDoc(D(viewer, 'liveRooms/R1'), { viewerCount: increment(1) }))
  await no('C: …not by a hundred', () => updateDoc(D(viewer, 'liveRooms/R1'), { viewerCount: increment(100) }))
  await no('C: a viewer pins a message', () => updateDoc(D(viewer, 'liveRooms/R1'), { pinnedMessage: 'spam' }))
  await no('C (O1): a viewer cannot switch the host\'s calls off', () => updateDoc(D(viewer, 'liveRooms/R1'), { hostBlocksCalls: true }))

  console.log('D — comments')
  await seed('users/uidHost/blocked/uidBlocked', { blockedAt: 1 })
  const comment = (uid, message = 'hello') => ({ uid, name: uid, photoUrl: '', message, timestamp: Date.now(), isJoin: false })
  await ok('D: a viewer comments as themselves', () => setDoc(D(viewer, 'liveRooms/R1/comments/c1'), comment('uidViewer')))
  await no('D: …as somebody else', () => setDoc(D(viewer, 'liveRooms/R1/comments/c2'), comment('uidOther')))
  await no('D: …with nothing to say', () => setDoc(D(viewer, 'liveRooms/R1/comments/c3'), comment('uidViewer', '')))
  await no('D: …with 301 characters', () => setDoc(D(viewer, 'liveRooms/R1/comments/c4'), comment('uidViewer', 'x'.repeat(301))))
  await no('D: a muted viewer', () => setDoc(D(muted, 'liveRooms/R1/comments/c5'), comment('uidMuted')))
  await no('D: a kicked viewer', () => setDoc(D(kicked, 'liveRooms/R1/comments/c6'), comment('uidKicked')))
  await no('D: a viewer the host blocked', () => setDoc(D(blocked, 'liveRooms/R1/comments/c7'), comment('uidBlocked')))
  await ok('D: the host deletes a comment', () => deleteDoc(D(host, 'liveRooms/R1/comments/c1')))
  await seed('liveRooms/R1/comments/c8', comment('uidViewer'))
  await no('D: a viewer deletes one', () => deleteDoc(D(viewer, 'liveRooms/R1/comments/c8')))

  console.log('E — presence')
  await ok('E: a viewer adds their own presence row', () => setDoc(D(viewer, 'liveRooms/R1/viewers/uidViewer'), { uid: 'uidViewer', lastSeenAt: serverTimestamp() }))
  await no('E: a blocked viewer does not', () => setDoc(D(blocked, 'liveRooms/R1/viewers/uidBlocked'), { uid: 'uidBlocked' }))

  console.log('F — PK invites')
  await no('F: no client creates one', () => setDoc(D(host, 'pkInvites/I1'), { participants: ['uidHost', 'uidOther'], status: 'pending' }))
  await seed('pkInvites/I2', { participants: ['uidHost', 'uidOther'], status: 'pending' })
  await no('F: a participant cannot start one by hand', () => updateDoc(D(host, 'pkInvites/I2'), { status: 'started' }))
  await ok('F: a participant reads it', () => getDoc(D(host, 'pkInvites/I2')))

  console.log('G — an ended room stays ended')
  await ok('G: the host ends the live', () => updateDoc(D(host, 'liveRooms/R1'), { isActive: false, endedAt: new Date() }))
  await no('G: …and cannot reopen it', () => updateDoc(D(host, 'liveRooms/R1'), { isActive: true }))

  await trackB()
}

async function trackB() {
  const far = Timestamp.fromMillis(Date.now() + 365 * 864e5)
  await seed('crmUsers/uidOwner', { role: 'superadmin', isActive: true })
  await seed('ownerMfaSessions/uidOwner', { bindings: { SID1: { state: 'active', authTime: 5000, expiresAt: far } } })
  await seed('crmUsers/uidTech', { role: 'tech_admin', isActive: true })
  await seed('crmUsers/uidFin', { role: 'finance_admin', isActive: true })
  await seed('crmUsers/uidOps', { role: 'ops_member', isActive: true })
  await seed('crmUsers/uidSellerA', { role: 'seller', isActive: true, sellerId: 'SA' })
  await seed('crmUsers/uidSellerB', { role: 'seller', isActive: true, sellerId: 'SB' })
  await seed('crmUsers/uidSellerC', { role: 'seller', isActive: true, sellerId: 'SC' })
  const owner = boundOwner('uidOwner'), ownerPw = crm('uidOwner'), tech = crm('uidTech'), fin = crm('uidFin'), ops = crm('uidOps')
  const viewer = user('uidViewer'), other = user('uidOther'), host = user('uidHost')
  const anon = testEnv.unauthenticatedContext()

  console.log('H — games (E1–E3)')
  await seed('gameMatches/M1', { game: 'ludo', status: 'open', players: ['uidViewer'] })
  await seed('gameMatches/M1/private/meta', { seed: 'secret', inviteCode: '123456' })
  await seed('users/uidViewer/gameHistory/G1', { game: 'crash', staked: 100, won: 0 })
  await seed('gameLedger/L1', { uid: 'uidViewer', amount: -100 })
  await seed('gameIdempotency/K1', { uid: 'uidViewer' })
  await seed('promoCredits/P1', { uid: 'uidViewer', kind: 'daily_reward' })
  await ok('H: a signed-in account reads a match (lobby, spectators)', () => getDoc(D(other, 'gameMatches/M1')))
  await no('H: …nobody signed out', () => getDoc(D(anon, 'gameMatches/M1')))
  await no('H: a player cannot move a match', () => updateDoc(D(viewer, 'gameMatches/M1'), { status: 'finished', winner: 'uidViewer' }))
  await no('H: …nor create one', () => setDoc(D(viewer, 'gameMatches/M2'), { game: 'ludo' }))
  await no('H: the seed and invite code are nobody\'s', () => getDoc(D(viewer, 'gameMatches/M1/private/meta')))
  await ok('H: a player reads their own history', () => getDoc(D(viewer, 'users/uidViewer/gameHistory/G1')))
  await ok('H: …Finance too', () => getDoc(D(fin, 'users/uidViewer/gameHistory/G1')))
  await no('H: …not another player', () => getDoc(D(other, 'users/uidViewer/gameHistory/G1')))
  await no('H: a player cannot write a win into their history', () => setDoc(D(viewer, 'users/uidViewer/gameHistory/G2'), { won: 99999 }))
  for (const [path, label] of [['gameLedger/L1', 'the game ledger'], ['gameIdempotency/K1', 'the replay guard'], ['promoCredits/P1', 'promo credits']]) {
    await no(`H: a player cannot read ${label}`, () => getDoc(D(viewer, path)))
    await no(`H: …nor Finance from a browser (the CRM reads through the API)`, () => getDoc(D(fin, path)))
    await no(`H: nobody writes ${label}`, () => setDoc(D(owner, path), { amount: 1 }))
  }

  console.log('I — the Owner-only appConfig documents (E4, E6, E7)')
  for (const id of ['games', 'leaderboards', 'partySubscription']) {
    await ok(`I: the MFA-bound Owner writes appConfig/${id}`, () => setDoc(D(owner, `appConfig/${id}`), { enabled: true }, { merge: true }))
    await no(`I: Tech does not write appConfig/${id}`, () => setDoc(D(tech, `appConfig/${id}`), { enabled: true }, { merge: true }))
    await no(`I: Finance does not write appConfig/${id}`, () => setDoc(D(fin, `appConfig/${id}`), { enabled: true }, { merge: true }))
    await no(`I: a password-only Owner (no MFA binding) does not write appConfig/${id}`, () => setDoc(D(ownerPw, `appConfig/${id}`), { enabled: true }, { merge: true }))
    await no(`I: an app user does not write appConfig/${id}`, () => setDoc(D(viewer, `appConfig/${id}`), { enabled: true }, { merge: true }))
    await ok(`I: a signed-in app reads appConfig/${id}`, () => getDoc(D(viewer, `appConfig/${id}`)))
  }
  await ok('I: Tech still writes an ordinary appConfig document (unchanged)', () => setDoc(D(tech, 'appConfig/featureFlags'), { x: 1 }, { merge: true }))

  console.log('J — leaderboards (E6)')
  await seed('leaderboards/hosts_daily_20261104', { board: 'hosts', period: 'daily' })
  await seed('leaderboards/hosts_daily_20261104/entries/uidHost', { score: 500 })
  await seed('leaderboardSettlements/S1', { board: 'hosts', paid: [] })
  await ok('J: a signed-in account reads a ranking', () => getDoc(D(other, 'leaderboards/hosts_daily_20261104')))
  await ok('J: …and an entry', () => getDoc(D(other, 'leaderboards/hosts_daily_20261104/entries/uidHost')))
  await no('J: nobody buys the top spot', () => setDoc(D(host, 'leaderboards/hosts_daily_20261104/entries/uidHost'), { score: 1e9 }))
  await no('J: …or rewrites the board', () => updateDoc(D(owner, 'leaderboards/hosts_daily_20261104'), { period: 'x' }))
  await ok('J: Finance reads a settlement', () => getDoc(D(fin, 'leaderboardSettlements/S1')))
  await ok('J: …the bound Owner too', () => getDoc(D(owner, 'leaderboardSettlements/S1')))
  await no('J: …not an app user', () => getDoc(D(host, 'leaderboardSettlements/S1')))
  await no('J: …nor Tech', () => getDoc(D(tech, 'leaderboardSettlements/S1')))
  await no('J: nobody writes a settlement', () => setDoc(D(owner, 'leaderboardSettlements/S2'), { paid: [] }))

  console.log('K — room music (B7)')
  await seed('musicTracks/T1', { title: 'Licensed One', enabled: true })
  await seed('musicTracks/T2', { title: 'Withdrawn', enabled: false })
  await ok('K: a signed-in account reads an enabled track', () => getDoc(D(viewer, 'musicTracks/T1')))
  await no('K: …not a withdrawn one', () => getDoc(D(viewer, 'musicTracks/T2')))
  await ok('K: Tech reads a withdrawn one', () => getDoc(D(tech, 'musicTracks/T2')))
  await ok('K: Tech adds a track', () => setDoc(D(tech, 'musicTracks/T3'), { title: 'New', enabled: true }))
  await no('K: an app user does not add a track (setPartyMusic plays only catalogue tracks)', () => setDoc(D(viewer, 'musicTracks/T4'), { title: 'x', url: 'https://evil.example/a.mp3' }))

  console.log('L — Party Pro (B7)')
  await seed('partySubscriptions/uidViewer', { active: true, expiresAt: far })
  await seed('subscriptionPayments/Y1', { uid: 'uidViewer', diamonds: 2000 })
  await seed('subscriptionIdempotency/Y1', { uid: 'uidViewer' })
  await ok('L: the holder reads their subscription', () => getDoc(D(viewer, 'partySubscriptions/uidViewer')))
  await ok('L: …staff too', () => getDoc(D(ops, 'partySubscriptions/uidViewer')))
  await no('L: …not another account', () => getDoc(D(other, 'partySubscriptions/uidViewer')))
  await no('L: the holder cannot extend it themselves', () => updateDoc(D(viewer, 'partySubscriptions/uidViewer'), { expiresAt: Timestamp.fromMillis(Date.now() + 3650 * 864e5) }))
  await no('L: …nor start one for free', () => setDoc(D(other, 'partySubscriptions/uidOther'), { active: true }))
  await no('L: payments are server-only', () => getDoc(D(viewer, 'subscriptionPayments/Y1')))
  await no('L: …and the replay guard', () => getDoc(D(viewer, 'subscriptionIdempotency/Y1')))

  console.log('M — a party room\'s access log and PIN misses (B7)')
  await seed('partyRooms/PR1', { hostUid: 'uidHost', isActive: true, visibility: 'private' })
  await seed('partyRooms/PR1/accessLog/A1', { uid: 'uidOther', kind: 'wrong_pin' })
  await seed('partyRooms/PR1/pinMisses/uidOther', { count: 3 })
  await ok('M: the room\'s owner reads its access log', () => getDoc(D(host, 'partyRooms/PR1/accessLog/A1')))
  await ok('M: …staff too', () => getDoc(D(ops, 'partyRooms/PR1/accessLog/A1')))
  await no('M: …not a guest of the room', () => getDoc(D(other, 'partyRooms/PR1/accessLog/A1')))
  await no('M: nobody writes the log', () => setDoc(D(host, 'partyRooms/PR1/accessLog/A2'), { kind: 'admitted' }))
  await no('M: PIN misses are nobody\'s — not the guesser', () => getDoc(D(other, 'partyRooms/PR1/pinMisses/uidOther')))
  await no('M: …who cannot reset their own lockout', () => deleteDoc(D(other, 'partyRooms/PR1/pinMisses/uidOther')))
  await no('M: …nor the owner', () => getDoc(D(host, 'partyRooms/PR1/pinMisses/uidOther')))

  console.log('N — seller-to-seller trades (B9)')
  await seed('sellerTrades/TR1', { buyerSellerId: 'SA', sellerSellerId: 'SB', coins: 10000 })
  await ok('N: the buying seller reads the trade', () => getDoc(D(crm('uidSellerA'), 'sellerTrades/TR1')))
  await ok('N: …the selling seller too', () => getDoc(D(crm('uidSellerB'), 'sellerTrades/TR1')))
  await no('N: …not a third seller', () => getDoc(D(crm('uidSellerC'), 'sellerTrades/TR1')))
  await no('N: …nor an app user', () => getDoc(D(viewer, 'sellerTrades/TR1')))
  await ok('N: staff read it', () => getDoc(D(ops, 'sellerTrades/TR1')))
  await no('N: a seller cannot change the coins', () => updateDoc(D(crm('uidSellerA'), 'sellerTrades/TR1'), { coins: 1 }))

  console.log('O — chat messages and "delete chat" (O5)')
  const CH = 'conversations/uidOther_uidViewer'
  const msg = (from, extra = {}) => ({ senderUid: from, senderName: from, text: 'hi', type: 'text', timestamp: Date.now(), isRead: false, ...extra })
  await ok('O: a participant sends a text', () => setDoc(D(viewer, `${CH}/messages/o1`), msg('uidViewer')))
  await ok('O: …a photo', () => setDoc(D(viewer, `${CH}/messages/o2`), msg('uidViewer', { type: 'image', imageUrl: 'https://x/y.jpg', text: '' })))
  await ok('O: …a voice message', () => setDoc(D(viewer, `${CH}/messages/o3`), msg('uidViewer', { type: 'voice', audioUrl: 'https://x/y.m4a', durationMs: 3000, text: '' })))
  await ok('O: …an older build\'s message with no type', () => setDoc(D(viewer, `${CH}/messages/o3b`), { senderUid: 'uidViewer', text: 'hi', timestamp: Date.now() }))
  await no('O: …but never a gift (only settleGift writes one, with the money)', () => setDoc(D(viewer, `${CH}/messages/o4`), msg('uidViewer', { type: 'gift', giftName: 'Rose' })))
  await no('O: …nor a message signed as the other person', () => setDoc(D(viewer, `${CH}/messages/o5`), msg('uidOther')))
  await no('O: …nor into a conversation they are not in', () => setDoc(D(viewer, 'conversations/uidHost_uidOther/messages/o6'), msg('uidViewer')))
  await seed(`${CH}/messages/g1`, msg('uidOther', { type: 'gift', giftName: 'Rose' }))
  await no('O: a gift message cannot be edited, even by its sender', () => updateDoc(D(other, `${CH}/messages/g1`), { giftName: 'Castle' }))
  await no('O: …nor deleted', () => deleteDoc(D(other, `${CH}/messages/g1`)))
  await no('O: a text cannot be turned into a gift', () => updateDoc(D(viewer, `${CH}/messages/o1`), { type: 'gift' }))
  await no('O: …nor somebody else\'s message edited', () => updateDoc(D(other, `${CH}/messages/o1`), { text: 'changed' }))
  await ok('O: the sender deletes their own message', () => deleteDoc(D(viewer, `${CH}/messages/o2`)))
  await seed(CH, { participants: ['uidViewer', 'uidOther'], lastMessageAt: 1, unreadCount: { uidViewer: 3 } })
  await ok('O: a participant clears the chat for themselves ("delete chat")',
    () => updateDoc(D(viewer, CH), { 'clearedAt.uidViewer': Date.now(), 'unreadCount.uidViewer': 0 }))
  await no('O: …somebody outside it cannot', () => updateDoc(D(host, CH), { 'clearedAt.uidHost': 1 }))
}

let aborted = false
try { await main() } catch (err) {
  aborted = true
  console.error(`ABORTED: ${String(err?.message ?? err).split('\n')[0]}`)
} finally {
  await testEnv.cleanup().catch(() => undefined)
}
if (tally.failures > 0) {
  console.error(`\n${tally.failures} of ${tally.checks} B12 rule checks FAILED:`)
  for (const f of failed) console.error(`  · ${f}`)
}
if (!aborted && tally.failures === 0) console.log(`\nAll ${tally.checks} B12 rule checks passed.`)
printResult(aborted)
const exitCode = aborted || tally.failures > 0 ? 1 : 0
process.exitCode = exitCode
setTimeout(() => process.exit(exitCode), 2000).unref()
