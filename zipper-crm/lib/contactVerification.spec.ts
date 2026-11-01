/**
 * Decision 15 (RC) — the CRM's reading of the both-contacts rule.
 * Compiles and runs the shipped `lib/contactVerification.ts` standalone.
 */
import {
  CONTACT_VERIFICATION_REQUIRED, awaitingLabel, isAwaitingVerification, missingPhrase,
  phoneE164, phoneLinkOutcome, startedAny, verificationRefusal,
} from './contactVerification'

let checks = 0
const failures: string[] = []
function check(label: string, actual: unknown, expected: unknown): void {
  checks += 1
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) failures.push(`${label}\n      got  ${a}\n      want ${e}`)
}

// The structured refusal, and only that.
check('reads the refusal the API sends',
  verificationRefusal({ code: CONTACT_VERIFICATION_REQUIRED, message: 'Needs both.', missing: ['email'], emailUnproved: true }),
  { message: 'Needs both.', missing: ['email'], emailUnproved: true })
check('ignores any other structured detail', verificationRefusal({ code: 'CONTACT_REQUIRED', missing: ['phone'] }), null)
check('ignores a plain sentence', verificationRefusal('Nothing was approved.'), null)
check('ignores an array (validation errors)', verificationRefusal([{ msg: 'x' }]), null)
check('drops unknown contacts and duplicates',
  verificationRefusal({ code: CONTACT_VERIFICATION_REQUIRED, missing: ['phone', 'fax', 'phone'] })?.missing, ['phone'])

check('missing both, in words', missingPhrase(['phone', 'email']),
  'a verified phone number and a verified email address')
check('missing one', missingPhrase(['email']), 'a verified email address')
check('missing none', missingPhrase([]), '')
check('the staff label names what is missing', awaitingLabel(['phone']).includes('a verified phone number'), true)

check('the waiting status is recognised', isAwaitingVerification('awaiting_verification'), true)
check('…and nothing else is', [isAwaitingVerification('approved'), isAwaitingVerification('pending'),
  isAwaitingVerification(undefined)], [false, false, false])

check('a bare Indian mobile gets +91', phoneE164('98765 43210'), '+919876543210')
check('a number with + is kept', phoneE164('+1 (415) 555-0100'), '+14155550100')
check('a leading 0 is dropped', phoneE164('09876543210'), '+919876543210')
check('91 already present (12 digits) is not doubled', phoneE164('919876543210'), '+919876543210')
check('too short is refused', phoneE164('12345'), '')
check('garbage is refused', phoneE164('call me'), '')

check('a number on another account is a conflict', phoneLinkOutcome('auth/credential-already-in-use'), 'conflict')
check('…however Firebase spells it', phoneLinkOutcome('auth/account-exists-with-different-credential'), 'conflict')
check('a phone already linked is not an error', phoneLinkOutcome('auth/provider-already-linked'), 'already_linked')
check('a wrong code', phoneLinkOutcome('auth/invalid-verification-code'), 'wrong_code')
check('anything else', phoneLinkOutcome('auth/network-request-failed'), 'other')

check('a check that started something', startedAny({ started: [{ id: 'A', kind: 'agency', activated: true }] }), true)
check('a check that started nothing', startedAny({ started: [{ id: 'A', kind: 'agency', activated: false }] }), false)
check('no answer', startedAny(null), false)

if (failures.length > 0) {
  console.log(`\n${failures.length} of ${checks} checks FAILED\n`)
  for (const f of failures) console.log('  ✗', f)
  process.exit(1)
}
console.log(`All ${checks} contact-verification checks passed.`)
process.exit(0)
