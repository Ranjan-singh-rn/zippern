/**
 * O8 (Owner, 5 Nov 2026) — daily tasks: "daily task daily. reward those should be consider for audit and in crm
 * dashboard we should get the no."
 *
 *   * the Owner's config: off unless switched on; unusable rows dropped; every number clamped; a host metric makes
 *     the task the hosts'; a task with no reward is no task; a prototype key is not a metric;
 *   * progress is measured on the SERVER from rows it already writes — the gift / call / daily-reward ledger rows,
 *     a live's server-measured length, presence in a live, a party heartbeat, a direct message — exactly once per
 *     event (a redelivered trigger adds nothing), once per minute for presence, once per room / person per day;
 *   * nothing is recorded while the switch is off, or for a metric no enabled task uses;
 *   * claimDailyTask pays once per task per IST day, only when the progress reaches the target, only to the task's
 *     audience; diamonds (and a host task's beans) with their history rows and a `promoCredits` record — the audit
 *     trail the CRM reads — in one transaction; a task reward never feeds another task.
 *
 * REAL: lib/dailyTasks.js and the hooks in lib/live.js, lib/party.js, lib/profiles.js, lib/safety.js over the
 * in-memory Firestore.
 *
 * Run:  node --test test/dailyTasks.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const { installFakeFirestore, Timestamp } = require('./fakeFirestore')

const db = installFakeFirestore()
const T = require('../lib/dailyTasks')
const live = require('../lib/live')
const party = require('../lib/party')
const profiles = require('../lib/profiles')
const safety = require('../lib/safety')
const index = require('../lib/index')

const TOKEN = { auth_time: 2000, phone_number: '+919800000001', firebase: { sign_in_provider: 'phone' } }
const GUEST = { auth_time: 2000, firebase: { sign_in_provider: 'anonymous' } }
const claim = (uid, taskId, token = TOKEN) => index.claimDailyTask.run({ taskId }, { auth: { uid, token } })
async function refusal(p) { try { await p } catch (e) { return e } return null }

const TASKS = [
  { id: 'gift1', title: 'Send 3 gifts', audience: 'everyone', metric: 'send_gifts', target: 3, rewardDiamonds: 50 },
  { id: 'spend', title: 'Spend 100 on gifts', metric: 'gift_diamonds', target: 100, rewardDiamonds: 20 },
  { id: 'talk', title: 'Talk 5 minutes', metric: 'call_minutes', target: 5, rewardDiamonds: 30 },
  { id: 'checkin', title: 'Claim the daily reward', metric: 'daily_checkin', target: 9, rewardDiamonds: 5 },
  { id: 'watch', title: 'Watch 2 minutes', metric: 'watch_live_minutes', target: 2, rewardDiamonds: 10 },
  { id: 'party', title: '2 minutes in a party', metric: 'party_minutes', target: 2, rewardDiamonds: 10 },
  { id: 'rooms', title: 'Join a party', metric: 'party_joins', target: 1, rewardDiamonds: 10 },
  { id: 'chat', title: 'Chat with 2 people', metric: 'dm_people', target: 2, rewardDiamonds: 10 },
  { id: 'golive', title: 'Go live 10 minutes', metric: 'live_minutes', target: 10, rewardDiamonds: 0, rewardBeans: 500 },
  { id: 'earn', title: 'Earn 100 beans', metric: 'beans_earned', target: 100, rewardDiamonds: 40, rewardBeans: 100 },
  { id: 'calls-in', title: 'Take 3 call minutes', metric: 'call_minutes_received', target: 3, rewardBeans: 50 },
  { id: 'gifts-in', title: 'Receive 2 gifts', metric: 'gifts_received', target: 2, rewardBeans: 20 },
  { id: 'users-only', title: 'Users only', audience: 'users', metric: 'send_gifts', target: 1, rewardDiamonds: 1 },
]

function config(extra = {}) {
  db.seed('appConfig/dailyTasks', { enabled: true, tasks: TASKS, ...extra })
  T._resetDailyTasksCache()
}
const today = () => require('../lib/time').istDateKey()
const progress = (uid) => db.read(`users/${uid}/dailyTasks/${today()}`) ?? {}
const snapOf = (data) => ({ exists: data !== undefined, data: () => data })
const ledger = (fn, uid, txId, before, after, eventId) =>
  fn.run({ before: snapOf(before), after: snapOf(after) }, { eventId, params: { uid, txId } })

beforeEach(() => {
  db._docs.clear()
  T._resetDailyTasksCache()
  db.seed('users/U', { name: 'User', diamonds: 100, beans: 0 })
  db.seed('users/H', { name: 'Host', isHost: true, diamonds: 0, beans: 1000 })
})

describe('the Owner\'s config', () => {
  test('off unless switched on; nothing usable from nothing', () => {
    expect(T.sanitizeDailyTasksConfig(undefined)).toEqual({ enabled: false, tasks: [] })
    expect(T.sanitizeDailyTasksConfig({ enabled: 'yes', tasks: 'x' })).toEqual({ enabled: false, tasks: [] })
  })

  test('unusable rows are dropped, numbers clamped, a host metric makes the task the hosts\'', () => {
    const c = T.sanitizeDailyTasksConfig({
      enabled: true,
      tasks: [
        { id: 'A', metric: 'send_gifts', target: 0, rewardDiamonds: 999999, title: '  Send   gifts  ' },
        { id: 'a', metric: 'send_gifts', target: 5, rewardDiamonds: 1 },
        { id: 'bad id!', metric: 'send_gifts', target: 5, rewardDiamonds: 1 },
        { id: 'x', metric: 'constructor', target: 5, rewardDiamonds: 1 },
        { id: 'y', metric: 'mining', target: 5, rewardDiamonds: 1 },
        { id: 'z', metric: 'send_gifts', target: 5 },
        { id: 'live', metric: 'live_minutes', audience: 'everyone', target: 99999, rewardBeans: 9e9 },
        { id: 'u', metric: 'send_gifts', audience: 'users', target: 2, rewardDiamonds: 3, rewardBeans: 50 },
        { id: 'c', metric: 'daily_checkin', target: 7, rewardDiamonds: 5, order: -5, enabled: false },
      ],
    })
    expect(c.enabled).toBe(true)
    expect(c.tasks.map((t) => t.id)).toEqual(['c', 'a', 'live', 'u'])
    const a = c.tasks.find((t) => t.id === 'a')
    expect(a.target).toBe(1)
    expect(a.rewardDiamonds).toBe(10000)
    expect(a.title).toBe('Send gifts')
    const l = c.tasks.find((t) => t.id === 'live')
    expect(l.audience).toBe('hosts')
    expect(l.target).toBe(1440)
    expect(l.rewardBeans).toBe(100000)
    expect(c.tasks.find((t) => t.id === 'u').rewardBeans).toBe(0)
    const ck = c.tasks.find((t) => t.id === 'c')
    expect(ck.target).toBe(1)
    expect(ck.enabled).toBe(false)
    expect(T.activeMetrics(c).has('daily_checkin')).toBe(false)
    expect(T.activeMetrics({ ...c, enabled: false }).size).toBe(0)
  })

  test('at most 30 tasks; audience test', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, metric: 'send_gifts', target: 1, rewardDiamonds: 1, order: i }))
    expect(T.sanitizeDailyTasksConfig({ enabled: true, tasks: many }).tasks.length).toBe(30)
    expect(T.audienceMatches('hosts', true)).toBe(true)
    expect(T.audienceMatches('hosts', false)).toBe(false)
    expect(T.audienceMatches('users', true)).toBe(false)
    expect(T.audienceMatches('everyone', false)).toBe(true)
  })
})

describe('what a ledger row adds (pure)', () => {
  test('a gift sent: its quantity and diamonds; the same row changed later adds nothing', () => {
    const row = { type: 'debit', reason: 'gift_sent', amount: 60, quantity: 3 }
    expect(T.ledgerContributions('diamond', undefined, row)).toEqual({ send_gifts: 3, gift_diamonds: 60 })
    expect(T.ledgerContributions('diamond', row, { ...row, note: 'x' })).toEqual({})
  })
  test('a call row: the minutes billed since the last write, on both sides; beans for the earner', () => {
    expect(T.ledgerContributions('diamond', { reason: 'video_call', minutesBilled: 2 }, { reason: 'video_call', minutesBilled: 3 }))
      .toEqual({ call_minutes: 1 })
    expect(T.ledgerContributions('diamond', undefined, { reason: 'video_call', minutesBilled: 1 })).toEqual({ call_minutes: 1 })
    expect(T.ledgerContributions('bean', { reason: 'video_call', minutesBilled: 1, amount: 30 }, { reason: 'video_call', minutesBilled: 2, amount: 60 }))
      .toEqual({ call_minutes_received: 1, beans_earned: 30 })
  })
  test('a gift received; the daily reward; and nothing for rewards, games or conversions', () => {
    expect(T.ledgerContributions('bean', undefined, { reason: 'gift_received', amount: 25, quantity: 2 })).toEqual({ gifts_received: 2, beans_earned: 25 })
    expect(T.ledgerContributions('diamond', undefined, { reason: 'daily_reward', amount: 50 })).toEqual({ daily_checkin: 1 })
    for (const reason of ['daily_task', 'leaderboard_reward', 'lucky_gift_reward', 'game_stake', 'party_pro', 'convert'])
      expect(T.ledgerContributions('diamond', undefined, { reason, amount: 5 })).toEqual({})
    expect(T.ledgerContributions('bean', undefined, { reason: 'daily_task', amount: 5 })).toEqual({})
    expect(T.ledgerContributions('diamond', { reason: 'gift_sent' }, undefined)).toEqual({})
  })
  test('the other person of a conversation id', () => {
    expect(T.peerFromConvoId('A_B', 'A')).toBe('B')
    expect(T.peerFromConvoId('A_B', 'B')).toBe('A')
    expect(T.peerFromConvoId('A_B', 'C')).toBe('')
    expect(T.peerFromConvoId('A_B_C', 'A')).toBe('')
  })
})

describe('progress is recorded on the server, once', () => {
  test('nothing while the switch is off, not even a marker', async () => {
    db.seed('appConfig/dailyTasks', { enabled: false, tasks: TASKS })
    await ledger(index.dailyTasksDiamondLedger, 'U', 'g1', undefined, { reason: 'gift_sent', amount: 10, quantity: 1 }, 'E1')
    expect(db.read(`users/U/dailyTasks/${today()}`)).toBe(undefined)
    expect(db.count('users/U/dailyTaskSeen')).toBe(0)
  })

  test('a gift: counted; the same event delivered again adds nothing; another event adds', async () => {
    config()
    const row = { type: 'debit', reason: 'gift_sent', amount: 40, quantity: 2 }
    await ledger(index.dailyTasksDiamondLedger, 'U', 'g1', undefined, row, 'E1')
    await ledger(index.dailyTasksDiamondLedger, 'U', 'g1', undefined, row, 'E1')
    expect(progress('U').send_gifts).toBe(2)
    expect(progress('U').gift_diamonds).toBe(40)
    await ledger(index.dailyTasksDiamondLedger, 'U', 'g2', undefined, { ...row, quantity: 1, amount: 20 }, 'E2')
    expect(progress('U').send_gifts).toBe(3)
    expect(progress('U').gift_diamonds).toBe(60)
  })

  test('only metrics an enabled task uses are written', async () => {
    db.seed('appConfig/dailyTasks', { enabled: true, tasks: [{ id: 'g', metric: 'send_gifts', target: 1, rewardDiamonds: 1 }] })
    T._resetDailyTasksCache()
    await ledger(index.dailyTasksDiamondLedger, 'U', 'g1', undefined, { reason: 'gift_sent', amount: 40, quantity: 2 }, 'E1')
    expect(progress('U').send_gifts).toBe(2)
    expect(progress('U').gift_diamonds).toBe(undefined)
  })

  test('a call: every billed minute once, from the running count on the call\'s one row', async () => {
    config()
    const states = [undefined, { reason: 'video_call', minutesBilled: 1, amount: 60 }, { reason: 'video_call', minutesBilled: 2, amount: 120 },
      { reason: 'video_call', minutesBilled: 3, amount: 180 }]
    const half = (s) => s && { ...s, amount: s.amount / 2 }
    for (let i = 1; i < states.length; i++) {
      await ledger(index.dailyTasksDiamondLedger, 'U', 'call_C1', states[i - 1], states[i], `C${i}`)
      await ledger(index.dailyTasksBeanLedger, 'H', 'call_C1', half(states[i - 1]), half(states[i]), `B${i}`)
    }
    await ledger(index.dailyTasksDiamondLedger, 'U', 'call_C1', states[2], states[3], 'C3')
    expect(progress('U').call_minutes).toBe(3)
    expect(progress('H').call_minutes_received).toBe(3)
    expect(progress('H').beans_earned).toBe(90)
  })

  test('the daily reward claimed counts for "claim your daily reward"', async () => {
    db.seed('appConfig/dailyTasks', { enabled: true, tasks: [{ id: 'checkin', metric: 'daily_checkin', rewardDiamonds: 5 }] })
    T._resetDailyTasksCache()
    db.seed('appConfig/dailyRewards', { schedule: [{ day: 1, diamonds: 50 }] })
    const W = require('../lib/wallet')
    await W.claimDailyReward.run({}, { auth: { uid: 'U', token: TOKEN } })
    const row = db.read(`users/U/diamondTransactions/daily_${today()}`)
    await ledger(index.dailyTasksDiamondLedger, 'U', `daily_${today()}`, undefined, row, 'D1')
    expect(progress('U').daily_checkin).toBe(1)
    const r = await claim('U', 'checkin')
    expect(r.diamonds).toBe(5)
  })

  test('a live: its server-measured length when it closes, once per room', async () => {
    config()
    db.seed('publicProfiles/H', { name: 'Host' })
    const ref = db.collection('liveRooms').doc('L1')
    const started = { hostUid: 'H', isActive: true, serverStartedAt: Timestamp.fromMillis(Date.now() - 12 * 60000 - 5000) }
    db.seed('liveRooms/L1', { ...started, isActive: false })
    const close = () => profiles.syncLivePresence.run(
      { before: { exists: true, data: () => started }, after: { exists: true, data: () => db.read('liveRooms/L1'), ref } },
      { params: { roomId: 'L1' } })
    await close()
    await close()
    expect(progress('H').live_minutes).toBe(12)
  })

  test('watching a live: a minute at most once a minute; not the host; not an ended room', async () => {
    config()
    db.seed('liveRooms/L1', { hostUid: 'H', isActive: true })
    db.seed('liveRooms/L2', { hostUid: 'H', isActive: false })
    const write = (uid, roomId, iso) => live.liveViewerCount.run({ before: { exists: true }, after: { exists: true } },
      { timestamp: iso, params: { roomId, uid } })
    await write('U', 'L1', '2026-11-05T10:00:05Z')
    await write('U', 'L1', '2026-11-05T10:00:40Z')
    await write('U', 'L1', '2026-11-05T10:01:02Z')
    await write('H', 'L1', '2026-11-05T10:01:02Z')
    await write('U', 'L2', '2026-11-05T10:02:02Z')
    const day = require('../lib/time').istDateKey(new Date('2026-11-05T10:00:05Z'))
    expect(db.read(`users/U/dailyTasks/${day}`).watch_live_minutes).toBe(2)
    expect(db.read(`users/H/dailyTasks/${day}`)).toBe(undefined)
  })

  test('a party: a minute per accepted heartbeat, the room joined once a day; no presence, nothing', async () => {
    config()
    db.seed('partyRooms/P1', { hostUid: 'H', isActive: true })
    db.seed('partyRooms/P1/listeners/U', { uid: 'U', joinedAt: Timestamp.now() })
    const beat = (uid) => party.partyHeartbeat.run({ roomId: 'P1' }, { auth: { uid, token: TOKEN } })
    expect((await beat('U')).present).toBe(true)
    expect(progress('U').party_minutes).toBe(1)
    expect(progress('U').party_joins).toBe(1)
    await T.recordPartyPresence('U', 'P1', new Date(Date.now() + 61000))
    expect(progress('U').party_joins).toBe(1)
    expect((await beat('X')).present).toBe(false)
    expect(db.read(`users/X/dailyTasks/${today()}`)).toBe(undefined)
  })

  test('direct messages: each other person once a day; a gift message is not chat', async () => {
    config()
    async function dm(convo, id, data) {
      db.seed(`conversations/${convo}/messages/${id}`, data)
      const snap = await db.collection('conversations').doc(convo).collection('messages').doc(id).get()
      await safety.screenDirectMessage.run(snap, { params: { convoId: convo, messageId: id } })
    }
    await dm('U_V', 'm1', { senderUid: 'U', type: 'text', text: 'hi' })
    await dm('U_V', 'm2', { senderUid: 'U', type: 'image', text: '' })
    await dm('U_W', 'm3', { senderUid: 'U', type: 'gift', text: '' })
    expect(progress('U').dm_people).toBe(1)
    await dm('U_W', 'm4', { senderUid: 'U', type: 'voice', text: '' })
    expect(progress('U').dm_people).toBe(2)
  })
})

describe('claimDailyTask', () => {
  async function giftsSent(uid, n, tag = '') {
    for (let i = 0; i < n; i++) {
      await ledger(index.dailyTasksDiamondLedger, uid, `g${tag}${i}`, undefined, { reason: 'gift_sent', amount: 10, quantity: 1 }, `G${uid}${tag}${i}`)
    }
  }

  test('not done yet: refused with the progress; done: paid once, with its history row and audit record', async () => {
    config()
    await giftsSent('U', 2, 'a')
    const early = await refusal(claim('U', 'gift1'))
    expect(early.code).toBe('failed-precondition')
    expect(early.details.code).toBe('DAILY_TASK_NOT_DONE')
    expect(early.details.have).toBe(2)
    expect(db.read('users/U').diamonds).toBe(100)

    await giftsSent('U', 3, 'b')
    const r = await claim('U', 'gift1')
    expect(r).toEqual({ taskId: 'gift1', diamonds: 50, beans: 0, dateKey: today() })
    expect(db.read('users/U').diamonds).toBe(150)
    const row = db.read(`users/U/diamondTransactions/task_${today()}_gift1`)
    expect(row.type).toBe('credit')
    expect(row.reason).toBe('daily_task')
    expect(row.funding).toBe('promotional')
    expect(row.reasonLabel).toBe('Daily task — Send 3 gifts')
    expect(row.balanceAfter).toBe(150)
    const promo = db.read(`promoCredits/task_U_${today()}_gift1`)
    expect(promo.kind).toBe('daily_task')
    expect(promo.diamonds).toBe(50)
    expect(promo.beans).toBe(0)
    expect(promo.progress).toBe(5)
    expect(promo.historyRow).toBe(`users/U/diamondTransactions/task_${today()}_gift1`)
    expect(progress('U').claimed.gift1.diamonds).toBe(50)

    const again = await refusal(claim('U', 'gift1'))
    expect(again.code).toBe('already-exists')
    expect(db.read('users/U').diamonds).toBe(150)
    expect(db.count('promoCredits')).toBe(1)
  })

  test('claiming one task keeps the others claimed', async () => {
    config()
    await giftsSent('U', 3)
    await claim('U', 'gift1')
    await claim('U', 'users-only')
    const claimed = progress('U').claimed
    expect(Object.keys(claimed).sort()).toEqual(['gift1', 'users-only'])
  })

  test('the reward row it writes never feeds another task', async () => {
    config()
    await giftsSent('U', 3)
    await claim('U', 'gift1')
    const row = db.read(`users/U/diamondTransactions/task_${today()}_gift1`)
    await ledger(index.dailyTasksDiamondLedger, 'U', `task_${today()}_gift1`, undefined, row, 'R1')
    expect(progress('U').send_gifts).toBe(3)
    expect(progress('U').gift_diamonds).toBe(30)
  })

  test('a host task pays beans (and diamonds) with a bean history row; a user cannot take it; a user-only task is not a host\'s', async () => {
    config()
    await ledger(index.dailyTasksBeanLedger, 'H', 'gr1', undefined, { reason: 'gift_received', amount: 120, quantity: 1 }, 'H1')
    const r = await claim('H', 'earn')
    expect(r.beans).toBe(100)
    expect(r.diamonds).toBe(40)
    expect(db.read('users/H').beans).toBe(1100)
    expect(db.read('users/H').diamonds).toBe(40)
    const beanRow = db.read(`users/H/beanTransactions/task_${today()}_earn`)
    expect(beanRow.reason).toBe('daily_task')
    expect(beanRow.balanceAfter).toBe(1100)
    expect(db.read(`promoCredits/task_H_${today()}_earn`).beanHistoryRow).toBe(`users/H/beanTransactions/task_${today()}_earn`)

    const notHost = await refusal(claim('U', 'earn'))
    expect(notHost.code).toBe('permission-denied')
    await ledger(index.dailyTasksDiamondLedger, 'H', 'g9', undefined, { reason: 'gift_sent', amount: 1, quantity: 1 }, 'H2')
    const usersOnly = await refusal(claim('H', 'users-only'))
    expect(usersOnly.code).toBe('permission-denied')
  })

  test('a suspended Host claims no host task', async () => {
    config()
    db.seed('users/H', { name: 'Host', isHost: true, beans: 0, hostSuspended: true, hostSuspendedReason: 'review' })
    await ledger(index.dailyTasksBeanLedger, 'H', 'gr1', undefined, { reason: 'gift_received', amount: 500, quantity: 3 }, 'S1')
    const r = await refusal(claim('H', 'earn'))
    expect(r.code).toBe('permission-denied')
    expect(db.read('users/H').beans).toBe(0)
  })

  test('refusals: off, unknown, switched-off task, bad id, signed out, restricted, the verified-contact lever', async () => {
    db.seed('appConfig/dailyTasks', { enabled: false, tasks: TASKS })
    expect((await refusal(claim('U', 'gift1'))).details.code).toBe('DAILY_TASKS_OFF')
    db.seed('appConfig/dailyTasks', { enabled: true, tasks: [...TASKS, { id: 'off', metric: 'send_gifts', target: 1, rewardDiamonds: 9, enabled: false }] })
    T._resetDailyTasksCache()
    expect((await refusal(claim('U', 'nope'))).code).toBe('not-found')
    expect((await refusal(claim('U', 'off'))).code).toBe('not-found')
    expect((await refusal(claim('U', '../x'))).code).toBe('invalid-argument')
    expect((await refusal(index.claimDailyTask.run({ taskId: 'gift1' }, {}))).code).toBe('unauthenticated')
    db.seed('users/U', { name: 'User', diamonds: 100, isBanned: true, accountState: 'banned' })
    expect((await refusal(claim('U', 'gift1'))).code).toBe('permission-denied')
    db.seed('users/U', { name: 'User', diamonds: 100 })
    db.seed('appConfig/economy', { dailyRewardRequiresVerifiedContact: true })
    await giftsSent('U', 3)
    const guest = await refusal(claim('U', 'gift1', GUEST))
    expect(guest.details.code).toBe('VERIFIED_CONTACT_REQUIRED')
    expect(db.read('users/U').diamonds).toBe(100)
  })
})
