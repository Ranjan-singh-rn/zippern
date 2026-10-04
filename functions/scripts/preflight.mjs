/**
 * What the deployed functions need before any of them can work.
 *
 * Reports only — writes nothing. Every line is a thing that, if missing, makes
 * a function fail at the moment a user is watching rather than at deploy time:
 *
 *   gifts empty            → every settleGift throws "that gift no longer exists"
 *   appConfig/economy      → convertBeans refuses, split percentages fall back
 *   levelConfig/host       → the shipped ladder is used, which may not match
 *                            what the CRM shows a host
 *   bagItems empty         → the bag is empty and purchaseBagItem 404s
 *
 *   cd functions && node scripts/preflight.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import admin from 'firebase-admin'

const here = dirname(fileURLToPath(import.meta.url))
const keyPath = resolve(here, '../../serviceAccountKey.json')

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(keyPath, 'utf8'))),
})
const db = admin.firestore()

const ok = (s) => `\x1b[32m✔\x1b[0m ${s}`
const bad = (s) => `\x1b[31m✖\x1b[0m ${s}`
const warn = (s) => `\x1b[33m!\x1b[0m ${s}`

let blocking = 0

async function count(name) {
  const snap = await db.collection(name).count().get()
  return snap.data().count
}

console.log('\nZipper preflight — what the deployed functions depend on\n')

// ── Gift catalogue ───────────────────────────────────────────────────────────
{
  const n = await count('gifts')
  if (n === 0) {
    console.log(bad(`gifts: EMPTY — every gift send will fail. Seed it from the CRM.`))
    blocking++
  } else {
    const snap = await db.collection('gifts').limit(5).get()
    const missingPrice = snap.docs.filter((d) => d.get('diamondCost') == null)
    const missingRate = snap.docs.filter((d) => d.get('earningRate') == null)
    console.log(ok(`gifts: ${n}`))
    if (missingPrice.length) {
      console.log(bad(`  ${missingPrice.length} of the first 5 have no diamondCost — settleGift will throw`))
      blocking++
    }
    if (missingRate.length) {
      console.log(warn(`  ${missingRate.length} of the first 5 have no earningRate — falls back to the category rate`))
    }
  }
}

// ── Economy config ───────────────────────────────────────────────────────────
{
  const snap = await db.collection('appConfig').doc('economy').get()
  if (!snap.exists) {
    console.log(bad('appConfig/economy: MISSING — convertBeans refuses, splits use fallbacks'))
    blocking++
  } else {
    const d = snap.data()
    const rates = d.giftRates ?? {}
    console.log(ok('appConfig/economy: present'))
    const need = {
      beanToDiamondRate: d.beanToDiamondRate,
      callRateBeansPerMin: d.callRateBeansPerMin,
      minHostCallRate: d.minHostCallRate,
      maxHostCallRate: d.maxHostCallRate,
      'giftRates.beanToInrRate': rates.beanToInrRate,
      'giftRates.normalReceiverPct': rates.normalReceiverPct,
    }
    for (const [k, v] of Object.entries(need)) {
      if (v == null) console.log(warn(`  ${k}: not set — a fallback will be used`))
      else console.log(`    ${k} = ${v}`)
    }
    // ── The conversion rate is a divisor, and the direction matters ────────
    //
    // convertBeans does `floor(beansAmount / rate)`. So a SMALL rate makes a
    // host RICHER: at 0.5, 100 beans become 200 diamonds; at the intended 20,
    // 100 beans become 5. Beans are payout currency and diamonds are purchased
    // currency, so a rate below 1 converts earnings into spending power at a
    // multiple — the closed loop the 20:1 friction exists to prevent.
    //
    // Checked as a RANGE, not for presence. The first version of this script
    // only checked the field existed, and passed a live value of 0.5.
    const rate = d.beanToDiamondRate
    if (rate == null) {
      console.log(bad('  beanToDiamondRate missing — convertBeans returns "unavailable right now"'))
      blocking++
    } else if (rate < 1) {
      console.log(bad(`  beanToDiamondRate = ${rate} — MINTS DIAMONDS.`))
      console.log(`      100 beans would convert to ${Math.floor(100 / rate)} diamonds. Intended: 5.`)
      console.log('      This is a divisor: below 1 it multiplies a host\'s earnings.')
      blocking++
    } else if (rate !== 20) {
      console.log(warn(`  beanToDiamondRate = ${rate} — the agreed rate is 20 beans per diamond`))
    }
    // userCallRatePerMin has never been set anywhere; user↔user calls fall back
    // to 1600. Flagged so it is a decision rather than an accident.
    if (d.userCallRatePerMin == null) {
      console.log(warn('  userCallRatePerMin: not set — user↔user calls use the built-in 1600'))
    }
  }
}

// ── Does the call-rate band agree with the level ladder? ─────────────────────
//
// Two separate settings decide what a host may charge, and nothing made them
// agree: `appConfig/economy` clamps the rate on activation, and the level
// ladder's `maxCallRateBeans` is what getHostHome reports as the ceiling. A
// minimum above the level-0 ceiling means every new host is set to a rate the
// app then tells them they may not use.
{
  const cfg = (await db.collection('appConfig').doc('economy').get()).data() ?? {}
  const rungs = await db.collection('levelConfig').doc('host').collection('levels').get()
  const FALLBACK_L0_MAX = 700
  const l0 = rungs.empty
    ? FALLBACK_L0_MAX
    : Number(rungs.docs.find((r) => Number(r.get('level') ?? r.id) === 0)?.get('maxCallRateBeans') ?? FALLBACK_L0_MAX)
  const min = Number(cfg.minHostCallRate ?? 0)
  const max = Number(cfg.maxHostCallRate ?? 0)

  if (min > l0) {
    console.log(bad(`call rate: minHostCallRate ${min} is above the level-0 ceiling ${l0}`))
    console.log('    Every new host is clamped to a rate getHostHome tells them they cannot set.')
    blocking++
  } else if (min && max) {
    console.log(ok(`call rate band: ${min}–${max}, level-0 ceiling ${l0}`))
  }
  if (max && max > 0 && l0 > max) {
    console.log(warn(`  level-0 ceiling ${l0} exceeds maxHostCallRate ${max} — the band wins`))
  }
}

// ── Host level ladder ────────────────────────────────────────────────────────
{
  const snap = await db.collection('levelConfig').doc('host').collection('levels').get()
  if (snap.empty) {
    console.log(warn('levelConfig/host/levels: empty — the shipped ladder is used'))
    console.log('    Fine to launch on, but the CRM cannot retune progression until seeded.')
  } else {
    console.log(ok(`levelConfig/host/levels: ${snap.size}`))
    const noRate = snap.docs.filter((d) => !d.get('maxCallRateBeans'))
    if (noRate.length) {
      console.log(warn(`  ${noRate.length} rungs have no maxCallRateBeans — hosts there cannot raise their rate`))
    }
  }
}

// ── Bag items ────────────────────────────────────────────────────────────────
{
  const n = await count('bagItems')
  if (n === 0) console.log(warn('bagItems: empty — the bag screen will be blank'))
  else {
    console.log(ok(`bagItems: ${n}`))
    const snap = await db.collection('bagItems').get()
    const known = ['frame', 'chat_bubble', 'profile_card', 'id_frame', 'entrance']
    const odd = [...new Set(snap.docs.map((d) => d.get('category')).filter((c) => !known.includes(c)))]
    if (odd.length) {
      // equippedFieldFor returns null for anything unrecognised, so equipping
      // one of these does nothing at all rather than overwriting a frame.
      console.log(warn(`  unrecognised categories: ${odd.join(', ')} — these cannot be equipped`))
    }
  }
}

// ── Accounts ─────────────────────────────────────────────────────────────────
{
  const users = await count('users')
  const profiles = await count('publicProfiles')
  console.log(users === 0 ? warn('users: 0 — nothing to test with yet') : ok(`users: ${users}`))
  if (users > 0 && profiles < users) {
    console.log(bad(`  publicProfiles: ${profiles} of ${users} — run backfill-public-profiles.mjs`))
    blocking++
  } else if (users > 0) {
    console.log(ok(`publicProfiles: ${profiles}`))
  }

  const hosts = await db.collection('users').where('isHost', '==', true).count().get()
  const verified = await db.collection('users').where('isVerifiedHost', '==', true).count().get()
  if (hosts.data().count > 0) {
    console.log(`    hosts: ${hosts.data().count}, verified: ${verified.data().count}`)
    if (verified.data().count === 0) {
      console.log(warn('    No verified hosts — releaseBeansForWeek will skip every payout.'))
    }
  }
}

console.log(
  blocking === 0
    ? '\n\x1b[32mNothing blocking.\x1b[0m\n'
    : `\n\x1b[31m${blocking} blocking problem(s).\x1b[0m Fix before testing the money paths.\n`,
)
process.exit(0)
