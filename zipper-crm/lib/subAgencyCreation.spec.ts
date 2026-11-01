/**
 * FX-03 — the agency dashboard's Add Sub-Agency: login first, record second,
 * and nothing left behind by a failed or repeated attempt (DUP-01).
 *
 * REAL: `lib/subAgencyCreation.ts`, imported and called, over an in-memory
 * world that behaves like Firebase where it matters: an address can hold ONE
 * login, and a write that fails writes nothing.
 *
 *   npm run test:subagency
 */

import {
  duplicateSubAgencyMessage,
  findDuplicateSubAgency,
  isAddressInUse,
  reappliedMessage,
  reapplyFormFrom,
  runSubAgencyCreation,
  type SubAgencyCreationSteps,
} from './subAgencyCreation'

let checks = 0
const failures: string[] = []

function eq(claim: string, got: unknown, want: unknown): void {
  checks += 1
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g !== w) failures.push(`${claim}\n        got ${g}  want ${w}`)
}
function ok(claim: string, cond: boolean): void {
  checks += 1
  if (!cond) failures.push(claim)
}

// ── An in-memory Auth + Firestore ───────────────────────────────────────────
interface World {
  logins: Map<string, string> // email → uid
  records: Map<string, Record<string, unknown>>
  loginDocs: Map<string, string> // uid → agencyId
  finished: number
  failRecord: boolean
  failLoginDoc: boolean
  failBackLink: boolean
  failDelete: boolean
}
function world(): World {
  return {
    logins: new Map(), records: new Map(), loginDocs: new Map(), finished: 0,
    failRecord: false, failLoginDoc: false, failBackLink: false, failDelete: false,
  }
}
let seq = 0
function stepsFor(w: World, email: string): SubAgencyCreationSteps {
  return {
    createLogin: async () => {
      if (w.logins.has(email)) {
        const e = new Error('Firebase: Error (auth/email-already-in-use).')
        throw e
      }
      const uid = `uid-${++seq}`
      w.logins.set(email, uid)
      return uid
    },
    writeRecord: async () => {
      if (w.failRecord) throw new Error('Missing or insufficient permissions.')
      const id = `sub-${++seq}`
      w.records.set(id, { ownerEmail: email, crmUid: '' })
      return id
    },
    deleteLogin: async (uid: string) => {
      if (w.failDelete) throw new Error('network')
      const drop: string[] = []
      w.logins.forEach((u, e) => { if (u === uid) drop.push(e) })
      drop.forEach((e) => w.logins.delete(e))
    },
    writeLoginDoc: async (uid: string, agencyId: string) => {
      if (w.failLoginDoc) throw new Error('Missing or insufficient permissions.')
      w.loginDocs.set(uid, agencyId)
    },
    writeBackLink: async (uid: string, agencyId: string) => {
      if (w.failBackLink) throw new Error('Missing or insufficient permissions.')
      const r = w.records.get(agencyId)
      if (r) r.crmUid = uid
    },
    finish: async () => { w.finished += 1 },
  }
}
async function attempt(w: World, email: string) {
  try {
    return { value: await runSubAgencyCreation(stepsFor(w, email)) }
  } catch (error) {
    return { error: error as Error }
  }
}

async function main(): Promise<void> {
  // ── 1. An address that already has a login: nothing is written ───────────
  console.log('1. The login comes first — an address in use writes nothing')
  {
    const w = world()
    w.logins.set('taken@example.test', 'uid-existing')
    const r = await attempt(w, 'taken@example.test')
    ok('the attempt is refused', Boolean(r.error))
    ok('…with the address-in-use error', String(r.error?.message).includes('email-already-in-use'))
    eq('…and NO sub-agency record exists', w.records.size, 0)
    eq('…and no login document', w.loginDocs.size, 0)
    eq('…and the secondary session is released anyway', w.finished, 1)

    // The retry with a fresh address: exactly one record, linked.
    const r2 = await attempt(w, 'fresh@example.test')
    ok('the retry with a fresh address succeeds', !r2.error)
    eq('…exactly one record', w.records.size, 1)
    eq('…linked to its new login', r2.value?.linked, true)
    eq('…whose login document exists', r2.value?.loginDocWritten, true)
    eq('…and the record names that login', w.records.get(r2.value?.agencyId ?? '')?.crmUid, r2.value?.uid)
  }

  // ── 2. The record write fails: the new login is removed again ─────────────
  console.log('2. A failed record write removes the login it just made')
  {
    const w = world()
    w.failRecord = true
    const r = await attempt(w, 'new@example.test')
    ok('the attempt fails with the record error', String(r.error?.message).includes('permissions'))
    eq('…no record', w.records.size, 0)
    eq('…and the address is free again (the login was deleted)', w.logins.has('new@example.test'), false)
    w.failRecord = false
    const r2 = await attempt(w, 'new@example.test')
    ok('so the retry with the SAME address succeeds', !r2.error)
    eq('…with exactly one record', w.records.size, 1)
  }
  {
    const w = world()
    w.failRecord = true
    w.failDelete = true
    const r = await attempt(w, 'stuck@example.test')
    ok('when the clean-up fails too, the ORIGINAL error is reported', String(r.error?.message).includes('permissions'))
    eq('…and still no record was written', w.records.size, 0)
  }

  // ── 3. The login document or back-link fails: reported, not thrown ────────
  console.log('3. A failure after the record exists is reported as unlinked, never as "failed"')
  {
    const w = world()
    w.failLoginDoc = true
    const r = await attempt(w, 'half@example.test')
    ok('no error is thrown (a retry would refuse on the address)', !r.error)
    eq('…one record', w.records.size, 1)
    eq('…reported unlinked', r.value?.linked, false)
    eq('…and the login document missing', r.value?.loginDocWritten, false)
  }
  {
    const w = world()
    w.failBackLink = true
    const r = await attempt(w, 'nolink@example.test')
    eq('a refused back-link: one record', w.records.size, 1)
    eq('…unlinked', r.value?.linked, false)
    eq('…but the login document was written', r.value?.loginDocWritten, true)
  }

  // ── 4. Repeated and simultaneous submissions ──────────────────────────────
  console.log('4. A double submit, or two tabs at once, produce one record')
  {
    const w = world()
    const first = await attempt(w, 'twice@example.test')
    const second = await attempt(w, 'twice@example.test')
    ok('the first submit succeeds', !first.error)
    ok('the second is refused at the login', String(second.error?.message).includes('email-already-in-use'))
    eq('…one record', w.records.size, 1)
  }
  {
    const w = world()
    const [a, b] = await Promise.all([attempt(w, 'race@example.test'), attempt(w, 'race@example.test')])
    eq('two simultaneous submits: exactly one succeeds', [a, b].filter((x) => !x.error).length, 1)
    eq('…one record', w.records.size, 1)
    let raceLogins = 0
    w.logins.forEach((_u, e) => { if (e === 'race@example.test') raceLogins += 1 })
    eq('…one login', raceLogins, 1)
  }

  // ── 5. The duplicate check, before anything is created ────────────────────
  console.log('5. The duplicate check catches an existing sub-agency of the same owner')
  const existing = [
    { id: 'S1', ownerEmail: 'Owner.One@Example.test', ownerPhone: '+919876500001', status: 'pending' },
    { id: 'S2', ownerEmail: 'two@example.test', ownerPhone: '9876500002', status: 'approved' },
    { id: 'S3', ownerEmail: 'gone@example.test', ownerPhone: '+919876500003', status: 'rejected' },
  ]
  eq('the same email, other case and spaces', findDuplicateSubAgency(existing, ' owner.one@example.test ', ''),
    { id: 'S1', field: 'email' })
  eq('the same phone, with and without the country code', findDuplicateSubAgency(existing, 'x@example.test', '+919876500002'),
    { id: 'S2', field: 'phone' })
  eq('a REJECTED sub-agency does not block a new application', findDuplicateSubAgency(existing, 'gone@example.test', '+919876500003'), null)
  eq('a different owner is a different, legitimate sub-agency', findDuplicateSubAgency(existing, 'new@example.test', '+919876500009'), null)
  ok('the message says nothing was created and names the record',
    duplicateSubAgencyMessage({ id: 'S1', field: 'email' }).includes('Nothing was created')
      && duplicateSubAgencyMessage({ id: 'S1', field: 'email' }).includes('S1'))
  {
    const w = world()
    const a = await attempt(w, 'owner-a@example.test')
    const b = await attempt(w, 'owner-b@example.test')
    ok('two different owners: two sub-agencies, both linked', !a.error && !b.error
      && a.value?.linked === true && b.value?.linked === true)
    eq('…two distinct records', w.records.size, 2)
  }

  // ── Decision 16 (RC): a fresh application after a rejection ────────────
  eq('D16 — an address that already has a login is recognised',
    isAddressInUse({ code: 'auth/email-already-in-use' }), true)
  eq('D16 — any other refusal is not', [isAddressInUse({ code: 'auth/weak-password' }), isAddressInUse(null)],
    [false, false])
  const form = reapplyFormFrom({
    agencyName: ' Sub B ', ownerName: 'S', ownerEmail: 's@x.test', ownerPhone: '+91 98',
    paymentType: 'bank', accountNumber: '1', ifscCode: 'I', bankName: 'B', status: 'approved',
    isActive: true, kycDocUrls: ['k1', 'k2', 'k3', 'k4'], source: 'agency_created', createdByUid: 'evil',
  })
  eq('D16 — only the application fields travel (no status, source or creator)',
    Object.keys(form).sort(),
    ['accountNumber', 'agencyName', 'bankName', 'ifscCode', 'kycDocUrls', 'ownerEmail', 'ownerName',
      'ownerPhone', 'paymentType'])
  eq('D16 — values are trimmed and at most three documents are sent',
    [form.agencyName, (form.kycDocUrls as string[]).length], ['Sub B', 3])
  ok('D16 — the message says a NEW application was filed and the old one is kept',
    reappliedMessage('s@x.test', 'OLD1').includes('NEW application') && reappliedMessage('s@x.test', 'OLD1').includes('kept'))

  if (failures.length) {
    console.error(`\n${failures.length} of ${checks} sub-agency creation checks FAILED\n`)
    for (const f of failures) console.error('  ✗ ' + f)
    process.exit(1)
  }
  console.log(`All ${checks} sub-agency creation checks passed.`)
  console.log('  · the login is created first; an address in use writes nothing')
  console.log('  · a failed record write removes the new login, so the retry works')
  console.log('  · a failure after the record exists is reported unlinked, never "failed"')
  console.log('  · a double submit or two tabs produce one record')
  console.log('  · an existing sub-agency of the same owner is caught before anything is written')
}

void main()
