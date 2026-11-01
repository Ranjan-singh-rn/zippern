/**
 * M-3 / F-2 (FINANCE-007) — the weekly release is transactional on the week
 * document, and walks every pending week.
 *
 * Before: the amount came from the query's snapshot and the transaction read
 * only the user document, so an overlapping second run released the same week
 * twice, a conversion between the query and the transaction was ignored, and
 * a single `limit(500)` left the 501st week for next Monday.
 *
 * Now: the week is re-read inside the transaction, a released week is left
 * alone, the fresh `beans` is what moves, and the query is paged by cursor.
 *
 * Run:  node --test test/releaseBeansForWeek.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore()
const P = require('../lib/payouts')

const run = () => P.releaseBeansForWeek.run({}, {})
const WEEK = '2020-W01'       // certainly ≤ the cutoff

function host(uid, extra = {}) {
  db.seed(`users/${uid}`, { name: uid, isHost: true, isVerifiedHost: true, beans: 1000, beansAvailable: 0, ...extra })
}
function week(uid, beans, extra = {}) {
  db.seed(`users/${uid}/weeklyEarnings/${WEEK}`, { weekKey: WEEK, beans, giftBeans: beans, released: false, ...extra })
}
const user = (uid) => db.read(`users/${uid}`)
const weekDoc = (uid) => db.read(`users/${uid}/weeklyEarnings/${WEEK}`)
const releases = (uid) => db.all(`users/${uid}/beanTransactions`).filter((r) => r.type === 'release')

beforeEach(() => {
  db._docs.clear()
  db.seed('appConfig/economy', { giftRates: { beanToInrRate: 0.01 } })
})

describe('the release is transactional on the week document', () => {
  test('a pending week is released once: beansAvailable, the week, the release row and the statement', async () => {
    host('H1')
    week('H1', 600, { callBeans: 100, giftBeans: 500 })
    await run()
    expect(user('H1').beansAvailable).toBe(600)
    expect(weekDoc('H1').released).toBe(true)
    expect(releases('H1').length).toBe(1)
    expect(releases('H1')[0].amount).toBe(600)
    const st = db.read(`users/H1/weeklyStatements/${WEEK}`)
    expect(st.status).toBe('released')
    expect(st.beansReleased).toBe(600)
    expect(st.amountInr).toBe(6)
  })

  test('an overlapping second run releases nothing extra', async () => {
    host('H1')
    week('H1', 600)
    // Both runs query first (both see the pending week), then settle: the
    // second one's transaction re-reads the week and finds it released.
    await Promise.all([run(), run()])
    expect(user('H1').beansAvailable).toBe(600)
    expect(releases('H1').length).toBe(1)
    expect(db.all(`users/H1/weeklyStatements`).length).toBe(1)
  })

  test('a run after a completed run releases nothing', async () => {
    host('H1')
    week('H1', 600)
    await run()
    await run()
    expect(user('H1').beansAvailable).toBe(600)
    expect(releases('H1').length).toBe(1)
  })

  test('a conversion between the query and the transaction is honoured: the FRESH beans are released', async () => {
    host('H1')
    week('H1', 1000)
    // Between the job's query and its transaction the host converts 400 beans
    // of this week (exactly what convertBeans writes: beans down, convertedBeans up).
    const original = db.runTransaction.bind(db)
    let intercepted = false
    db.runTransaction = (fn) => {
      if (!intercepted) {
        intercepted = true
        db.seed(`users/H1/weeklyEarnings/${WEEK}`, { ...weekDoc('H1'), beans: 600, convertedBeans: 400 })
      }
      return original(fn)
    }
    try {
      await run()
    } finally {
      db.runTransaction = original
    }
    expect(intercepted).toBe(true)
    expect(user('H1').beansAvailable).toBe(600)          // not 1000
    expect(releases('H1')[0].amount).toBe(600)
    const st = db.read(`users/H1/weeklyStatements/${WEEK}`)
    expect(st.beansReleased).toBe(600)
    expect(st.convertedBeans).toBe(400)
  })

  test('a week fully converted before the transaction is closed with nothing released', async () => {
    host('H1')
    week('H1', 300)
    const original = db.runTransaction.bind(db)
    let once = false
    db.runTransaction = (fn) => {
      if (!once) { once = true; db.seed(`users/H1/weeklyEarnings/${WEEK}`, { ...weekDoc('H1'), beans: 0, convertedBeans: 300 }) }
      return original(fn)
    }
    try { await run() } finally { db.runTransaction = original }
    expect(user('H1').beansAvailable).toBe(0)
    expect(weekDoc('H1').released).toBe(true)
    expect(releases('H1').length).toBe(0)
  })
})

describe('the holds are kept', () => {
  test('an unverified host is held, not released, and told so', async () => {
    host('U1', { isVerifiedHost: false })
    week('U1', 500)
    await run()
    expect(user('U1').beansAvailable).toBe(0)
    expect(weekDoc('U1').released).toBe(false)
    expect(weekDoc('U1').skippedReason).toBe('unverified')
    const st = db.read(`users/U1/weeklyStatements/${WEEK}`)
    expect(st.status).toBe('held')
    expect(st.beansPending).toBe(500)
    expect(st.willReleaseWhenCleared).toBe(true)
  })

  test('a payout hold is kept', async () => {
    host('F1', { payoutHold: true })
    week('F1', 500)
    await run()
    expect(user('F1').beansAvailable).toBe(0)
    expect(weekDoc('F1').released).toBe(false)
    expect(weekDoc('F1').skippedReason).toBe('dispute_hold')
  })

  test('a held week is released by a later run once the block clears', async () => {
    host('F1', { payoutHold: true })
    week('F1', 500)
    await run()
    db.seed('users/F1', { ...user('F1'), payoutHold: false })
    await run()
    expect(user('F1').beansAvailable).toBe(500)
    expect(weekDoc('F1').released).toBe(true)
    expect(weekDoc('F1').skippedReason).toBe(undefined)
    expect(db.read(`users/F1/weeklyStatements/${WEEK}`).status).toBe('released')
  })
})

describe('every pending week is processed, not just the first 500', () => {
  test('501 pending weeks across 501 hosts are all released in one run', async () => {
    for (let i = 0; i < 501; i++) {
      host(`H${i}`)
      week(`H${i}`, 10 + i)
    }
    await run()
    let released = 0
    for (let i = 0; i < 501; i++) {
      if (weekDoc(`H${i}`).released === true && user(`H${i}`).beansAvailable === 10 + i) released++
    }
    expect(released).toBe(501)
  })

  test('held weeks on the first page do not stop the walk from reaching the rest', async () => {
    // 500 held weeks sort first (same weekKey; the cursor is by weekKey then path),
    // followed by a releasable one — a plain re-query would return the same 500 forever.
    for (let i = 0; i < 500; i++) {
      host(`A${String(i).padStart(3, '0')}`, { payoutHold: true })
      week(`A${String(i).padStart(3, '0')}`, 5)
    }
    host('Z-last')
    week('Z-last', 77)
    await run()
    expect(user('Z-last').beansAvailable).toBe(77)
    expect(weekDoc('Z-last').released).toBe(true)
    expect(weekDoc('A000').released).toBe(false)
  })

  test('the query is ordered and paged by cursor, and keeps both checks (source)', () => {
    const fs = require('node:fs')
    const path = require('node:path')
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'payouts.ts'), 'utf8')
    const body = src.slice(src.indexOf('export const releaseBeansForWeek'))
    expect(body.includes(".orderBy('weekKey')")).toBe(true)
    expect(body.includes('query.startAfter(cursor)')).toBe(true)
    expect(body.includes('tx.get(doc.ref)')).toBe(true)
    expect(body.includes("weekSnap.get('released') === true")).toBe(true)
    expect(/isVerifiedHost'\) !== true[\s\S]{0,80}SKIP_UNVERIFIED/.test(body)).toBe(true)
    expect(/payoutHold'\) === true[\s\S]{0,80}SKIP_HOLD/.test(body)).toBe(true)
  })
})
