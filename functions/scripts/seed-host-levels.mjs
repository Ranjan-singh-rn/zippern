/**
 * Seed the host level ladder and align the call-rate settings with it.
 *
 * The decision, as given:
 *   - A level-0 host's rate must sit between 300 and 700 beans/min.
 *   - The top of the ladder lets a host set up to 2400 beans/min.
 *   - Each level unlocks a higher tier in between.
 *
 * ── Three settings had drifted apart ─────────────────────────────────────────
 *
 *   appConfig/economy.minHostCallRate / maxHostCallRate
 *       The band an AGENCY may assign when adding a host. Was 800–1500, which
 *       let an agency assign a rate above the host's own level-0 ceiling.
 *
 *   levelConfig/host/levels.{n}.maxCallRateBeans
 *       The ceiling a HOST may raise themselves to. The collection was empty,
 *       so the ladder compiled into the Android app was in force and nothing
 *       in the CRM could change it.
 *
 *   appConfig/economy.callRateBeansPerMin
 *       The income used for a host with no rate set — and, deliberately, for
 *       every UNVERIFIED host regardless of level. Was 1000.
 *
 * ── The third one was backwards ──────────────────────────────────────────────
 *
 * At 1000, an unverified host earned MORE per minute than a verified level-0
 * host capped at 700. Holding unverified hosts at the base rate is meant to be
 * a restriction — the incentive to get verified. At 1000 it was a reward for
 * not bothering. Set to 300, the bottom of the band, it restricts again.
 *
 *   cd functions
 *   node scripts/seed-host-levels.mjs --dry    # show the changes
 *   node scripts/seed-host-levels.mjs          # apply them
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import admin from 'firebase-admin'
import { guardKeyScript } from './_keyScriptGuard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dry = process.argv.includes('--dry')

// P0-10 (OPS-C): this key reaches a REAL project — named, acknowledged and (for
// a run that writes) confirmed before Firebase is initialised. See _keyScriptGuard.mjs.
const GUARDED_PROJECT = guardKeyScript('seed-host-levels', {
  keyPath: new URL('../../serviceAccountKey.json', import.meta.url),
  writes: !process.argv.includes('--dry'),
})
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(readFileSync(resolve(here, '../../serviceAccountKey.json'), 'utf8')),
  ),
})
const db = admin.firestore()

// ── The band ─────────────────────────────────────────────────────────────────

const MIN_HOST_CALL_RATE = 300
const MAX_HOST_CALL_RATE = 700

// The base rate. Also what an unverified host earns at any level, which is why
// it sits at the BOTTOM of the band rather than the middle.
const BASE_CALL_RATE = 300

// ── The ladder ───────────────────────────────────────────────────────────────
//
// `beansRequired` matches the thresholds already shipped in the Android app, so
// no host's level changes as a result of this seed — only what they may charge.
//
// `maxCallRateBeans` climbs from the band's ceiling (700) to 2400 at level 10.
// The steps are gentle early and wider later: the jump from 0 to 1 should feel
// reachable, and the last rungs should feel like something.
const LADDER = [
  { level: 0,  beansRequired: 0,          maxCallRateBeans: 700,  frameName: '' },
  { level: 1,  beansRequired: 10_000,     maxCallRateBeans: 850,  frameName: 'Host Starter Frame' },
  { level: 2,  beansRequired: 100_000,    maxCallRateBeans: 1000, frameName: 'Bronze Host Frame',   bonusBeans: 30_000 },
  { level: 3,  beansRequired: 300_000,    maxCallRateBeans: 1150, frameName: 'Silver Host Frame',   bonusBeans: 50_000 },
  { level: 4,  beansRequired: 600_000,    maxCallRateBeans: 1350, frameName: 'Gold Host Frame',     bonusBeans: 100_000,   bonusDiamonds: 500 },
  { level: 5,  beansRequired: 1_000_000,  maxCallRateBeans: 1550, frameName: 'Platinum Host Frame', bonusBeans: 200_000,   bonusDiamonds: 1_000 },
  { level: 6,  beansRequired: 2_000_000,  maxCallRateBeans: 1750, frameName: 'Diamond Host Frame',  bonusBeans: 300_000,   bonusDiamonds: 2_000,  entranceName: 'Biker Entry',  entranceAsset: 'entries/entry_bike.json' },
  { level: 7,  beansRequired: 4_000_000,  maxCallRateBeans: 1950, frameName: 'Master Host Frame',   bonusBeans: 500_000,   bonusDiamonds: 3_000 },
  { level: 8,  beansRequired: 8_000_000,  maxCallRateBeans: 2150, frameName: 'Legend Host Frame',   bonusBeans: 800_000,   bonusDiamonds: 5_000,  entranceName: 'Royal Entry',  entranceAsset: 'entries/entry_lv8.json' },
  { level: 9,  beansRequired: 16_000_000, maxCallRateBeans: 2300, frameName: 'Elite Host Frame',    bonusBeans: 1_200_000, bonusDiamonds: 10_000 },
  { level: 10, beansRequired: 32_000_000, maxCallRateBeans: 2400, frameName: 'Mythic Host Crown',   bonusBeans: 2_000_000, bonusDiamonds: 20_000, entranceName: 'Lambo Entry',  entranceAsset: 'entries/entry_lambo.json' },
]

// ── Sanity, before touching anything ─────────────────────────────────────────
//
// These are the invariants the three settings must satisfy together. Checked
// here rather than trusted, because getting them wrong is what this script is
// fixing.
{
  const problems = []
  if (BASE_CALL_RATE < MIN_HOST_CALL_RATE || BASE_CALL_RATE > MAX_HOST_CALL_RATE) {
    problems.push(`base rate ${BASE_CALL_RATE} is outside the band ${MIN_HOST_CALL_RATE}–${MAX_HOST_CALL_RATE}`)
  }
  const l0 = LADDER[0].maxCallRateBeans
  if (MAX_HOST_CALL_RATE > l0) {
    problems.push(`agency band max ${MAX_HOST_CALL_RATE} exceeds the level-0 ceiling ${l0}`)
  }
  for (let i = 1; i < LADDER.length; i++) {
    if (LADDER[i].maxCallRateBeans < LADDER[i - 1].maxCallRateBeans) {
      problems.push(`level ${LADDER[i].level} allows less than level ${LADDER[i - 1].level}`)
    }
    if (LADDER[i].beansRequired <= LADDER[i - 1].beansRequired) {
      problems.push(`level ${LADDER[i].level} requires no more beans than level ${LADDER[i - 1].level}`)
    }
  }
  if (problems.length) {
    console.error('\nRefusing to seed — the numbers contradict each other:')
    for (const p of problems) console.error(`  • ${p}`)
    process.exit(1)
  }
}

// ── Show, then write ─────────────────────────────────────────────────────────

const cfgRef = db.collection('appConfig').doc('economy')
const before = (await cfgRef.get()).data() ?? {}

console.log(`\n${dry ? 'DRY RUN — nothing will be written' : 'Seeding'}\n`)
console.log('appConfig/economy')
const changes = {
  minHostCallRate: MIN_HOST_CALL_RATE,
  maxHostCallRate: MAX_HOST_CALL_RATE,
  callRateBeansPerMin: BASE_CALL_RATE,
}
for (const [k, v] of Object.entries(changes)) {
  const was = before[k]
  console.log(`  ${k}: ${was ?? '(unset)'} → ${v}${was === v ? '   (no change)' : ''}`)
}

// The conversion rate is not seeded here. It is a separate decision with a
// different blast radius, and a script named "seed host levels" quietly
// rewriting the bean-to-diamond rate is how a fix becomes a surprise.
if (before.beanToDiamondRate != null && before.beanToDiamondRate < 1) {
  console.log(
    `\n  ! beanToDiamondRate is still ${before.beanToDiamondRate} — 100 beans convert to ` +
      `${Math.floor(100 / before.beanToDiamondRate)} diamonds. This script does NOT change it; ` +
      'set it to 20 on the Economy Config screen.',
  )
}

console.log('\nlevelConfig/host/levels')
for (const rung of LADDER) {
  console.log(
    `  L${String(rung.level).padStart(2)}  up to ${String(rung.maxCallRateBeans).padStart(4)} beans/min` +
      `   at ${rung.beansRequired.toLocaleString('en-IN')} beans earned`,
  )
}

if (dry) {
  console.log('\nRe-run without --dry to apply.\n')
  process.exit(0)
}

await cfgRef.set(changes, { merge: true })

const batch = db.batch()
for (const rung of LADDER) {
  batch.set(
    db.collection('levelConfig').doc('host').collection('levels').doc(String(rung.level)),
    {
      level: rung.level,
      beansRequired: rung.beansRequired,
      maxCallRateBeans: rung.maxCallRateBeans,
      frameName: rung.frameName ?? '',
      entranceName: rung.entranceName ?? '',
      entranceAsset: rung.entranceAsset ?? '',
      bonusBeans: rung.bonusBeans ?? 0,
      bonusDiamonds: rung.bonusDiamonds ?? 0,
    },
    { merge: true },
  )
}
await batch.commit()

console.log('\nDone. The ladder is now editable from the CRM rather than compiled into the app.')
console.log('getHostLadder caches for 10 minutes, so allow that before testing rate changes.\n')
process.exit(0)
