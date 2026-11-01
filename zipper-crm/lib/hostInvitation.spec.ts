/**
 * FX-12 (RF-18 / DUP-07) — one open invitation per (agency, person).
 *
 * REAL: `lib/hostInvitation.ts`, imported and called, over an in-memory store
 * that behaves like the rules where it matters: a write to an id that already
 * exists is refused for an agency login (it arrives as an update with fields
 * the agency may not change), so CREATE semantics are what the store gives.
 *
 *   npm run test:invitation
 */

import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import {
  duplicateInvitationMessage, findOpenInvitation, invitationId, invitationKey, isWithdrawableInvitation,
  runInvitationCreate, type InvitationCreateSteps,
} from './hostInvitation'

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

const sha256Hex = async (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

/** The store: create-if-absent, as the rules make it for an agency login. */
function store() {
  const docs = new Map<string, Record<string, unknown>>()
  let autos = 0
  const steps = (data: Record<string, unknown>): InvitationCreateSteps => ({
    sha256Hex,
    createIfAbsent: async (id) => {
      const existing = docs.get(id)
      if (existing) return { created: false, existing }
      docs.set(id, { ...data })
      return { created: true }
    },
    createAuto: async () => {
      autos += 1
      const id = `auto_${autos}`
      docs.set(id, { ...data })
      return id
    },
  })
  return { docs, steps, autos: () => autos }
}

async function main(): Promise<void> {
  // ── the key ─────────────────────────────────────────────────────────────────
  eq('the key ignores case, spaces and phone punctuation',
    invitationKey('AG1', ' Host@Example.TEST ', '+91 98765-43210'), 'AG1|host@example.test|919876543210')
  ok('different agencies → different keys', invitationKey('AG1', 'a@x.io', '1') !== invitationKey('AG2', 'a@x.io', '1'))
  eq('slot 1 is the bare id; later slots are suffixed',
    [invitationId('ab'.repeat(32), 1).length, invitationId('ab'.repeat(32), 2).endsWith('_2')], [44, true])

  // ── the defect: two submits for one person ─────────────────────────────────
  {
    const s = store()
    const data = { agencyId: 'AG1', status: 'pending', applicantEmail: 'h@x.io', applicantPhone: '+919800000001' }
    const first = await runInvitationCreate('AG1', 'h@x.io', '+919800000001', s.steps(data))
    const second = await runInvitationCreate('AG1', 'H@X.io', '+91 98000 00001', s.steps(data))
    eq('the first invitation is created', first.ok, true)
    eq('the second, for the same person, is refused as a duplicate', [second.ok, !second.ok && second.reason], [false, 'duplicate'])
    eq('…and only ONE document exists', s.docs.size, 1)
  }

  // ── concurrent: both aim at the same id, one wins ──────────────────────────
  {
    const s = store()
    const data = { agencyId: 'AG1', status: 'pending' }
    const [a, b] = await Promise.all([
      runInvitationCreate('AG1', 'c@x.io', '+919800000002', s.steps(data)),
      runInvitationCreate('AG1', 'c@x.io', '+919800000002', s.steps(data)),
    ])
    eq('two at once → exactly one created', [a.ok, b.ok].filter(Boolean).length, 1)
    eq('…one document', s.docs.size, 1)
  }

  // ── a refusal is history: the person can be invited again ──────────────────
  {
    const s = store()
    const first = await runInvitationCreate('AG1', 'r@x.io', '+919800000003', s.steps({ status: 'pending' }))
    if (first.ok) s.docs.set(first.id, { status: 'rejected' })
    const again = await runInvitationCreate('AG1', 'r@x.io', '+919800000003', s.steps({ status: 'pending' }))
    eq('after a refusal, a new invitation takes the next slot', [again.ok, again.ok && again.slot], [true, 2])
    eq('…the refused one is kept', s.docs.size, 2)
    const third = await runInvitationCreate('AG1', 'r@x.io', '+919800000003', s.steps({ status: 'pending' }))
    eq('…and while that one is open, a third is a duplicate', [third.ok, !third.ok && third.reason], [false, 'duplicate'])
  }

  // ── distinct people stay distinct ──────────────────────────────────────────
  {
    const s = store()
    await runInvitationCreate('AG1', 'p1@x.io', '+919800000011', s.steps({ status: 'pending' }))
    await runInvitationCreate('AG1', 'p2@x.io', '+919800000012', s.steps({ status: 'pending' }))
    await runInvitationCreate('AG2', 'p1@x.io', '+919800000011', s.steps({ status: 'pending' }))
    eq('two people, and the same person at another agency → three invitations', s.docs.size, 3)
  }

  // ── the duplicate check that runs first (a typo in ONE of the two) ─────────
  {
    const existing = [
      { id: 'I1', status: 'pending', applicantPhone: '+919800000021', applicantEmail: 'old@x.io', hostName: 'Asha' },
      { id: 'I2', status: 'rejected', applicantPhone: '+919800000022', applicantEmail: 'rej@x.io' },
      { id: 'I3', status: 'approved', isActivated: true, applicantPhone: '+919800000023', applicantEmail: 'act@x.io' },
    ]
    eq('same phone, corrected email → the open invitation is found',
      findOpenInvitation(existing, 'new@x.io', '+91 98000 00021')?.id, 'I1')
    eq('same email, different phone → found', findOpenInvitation(existing, 'OLD@x.io', '+919811111111')?.id, 'I1')
    eq('a refused invitation is not open', findOpenInvitation(existing, 'rej@x.io', '+919800000022'), null)
    eq('a redeemed invitation is not open (the person is a host; activation handles that)',
      findOpenInvitation(existing, 'act@x.io', '+919800000023'), null)
    ok('the message names the person and the way out',
      duplicateInvitationMessage(existing[0]).includes('Asha') && duplicateInvitationMessage(existing[0]).includes('Withdraw'))
  }

  // ── a person refused more times than there are slots: invited as before ────
  {
    const s = store()
    const hash = await sha256Hex(invitationKey('AG1', 'z@x.io', '+919800000099'))
    for (let i = 1; i <= 50; i += 1) s.docs.set(invitationId(hash, i), { status: 'rejected' })
    const r = await runInvitationCreate('AG1', 'z@x.io', '+919800000099', s.steps({ status: 'pending' }))
    eq('…falls back to an automatic id rather than refusing', [r.ok, r.ok && r.slot, s.autos()], [true, 0, 1])
  }

  // ── the page uses it ────────────────────────────────────────────────────────
  {
    const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'agency-dashboard', 'page.tsx'), 'utf8')
    const create = page.slice(page.indexOf('async function handleCreate()'), page.indexOf("const STEPS = ['Identity'"))
    const withoutFallback = create.replace(/createAuto: async \(\) => \(await addDoc\([^\n]*\n/, '')
    ok('Invite Host writes with addDoc ONLY in the documented fallback (createAuto)',
      create.includes('createAuto: async () => (await addDoc(') && !withoutFallback.includes('addDoc('))
    ok('…it checks for an open invitation first', create.includes('findOpenInvitation('))
    ok('…and writes at the deterministic id', create.includes('runInvitationCreate('))
    ok('the dashboard offers Withdraw on a pending invitation', page.includes('withdrawInvitation(app)'))
    ok('RC: …only where isWithdrawableInvitation says so (never a self-filed application)',
      page.includes('isWithdrawableInvitation(app as unknown as Record<string, unknown>) && ('))
  }

  // ── RC: what the agency may withdraw (the rule, mirrored) ───────────────────
  {
    const inv = { status: 'pending', isActivated: false, agencyId: 'AG1' }
    eq('RC: a pending, never-redeemed invitation may be withdrawn', isWithdrawableInvitation(inv), true)
    eq('RC: a self-filed application may not (staff decide it)',
      isWithdrawableInvitation({ ...inv, applicantUid: 'U1', source: 'self_app' }), false)
    eq('RC: …nor one marked self_app without a uid', isWithdrawableInvitation({ ...inv, source: 'self_app' }), false)
    eq('RC: a redeemed invitation may not', isWithdrawableInvitation({ ...inv, isActivated: true, activatedByUid: 'U2' }), false)
    eq('RC: a decided one may not', [isWithdrawableInvitation({ ...inv, status: 'approved' }),
      isWithdrawableInvitation({ ...inv, status: 'rejected' })], [false, false])
    const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'firestore.rules'), 'utf8')
    const del = rules.slice(rules.indexOf('match /hostApplications/{docId}'))
    const allowDelete = del.slice(del.indexOf('allow delete:'), del.indexOf('allow delete:') + 600)
    ok('RC: the rule refuses an agency delete of a self-filed application',
      allowDelete.includes("resource.data.get('applicantUid', '') == ''")
      && allowDelete.includes("resource.data.get('source', '') != 'self_app'"))
  }

  if (failures.length) {
    console.error(`\n${failures.length} of ${checks} host invitation checks FAILED\n`)
    for (const f of failures) console.error('  ✗ ' + f)
    process.exit(1)
  }
  console.log(`All ${checks} host invitation checks passed.`)
  console.log('  · one open invitation per (agency, person); a second submit writes nothing')
  console.log('  · two at once → one document')
  console.log('  · a refused invitation is history; the person can be invited again')
  console.log('  · a typo in the phone or the email still finds the open invitation')
}

void main()
