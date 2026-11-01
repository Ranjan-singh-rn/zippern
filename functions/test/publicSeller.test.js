/**
 * THE PUBLIC SELLER DIRECTORY — what may leave the private record, and nothing more.
 *
 * `sellers/{id}` was `allow read: if request.auth != null`. `read` is `get` AND
 * `list`, so any signed-in account — every app user, every throwaway made
 * against the public web API key — could page the whole collection and receive
 * each seller's KYC document URLs, coin balance, commission rate, email and
 * approval trail.
 *
 * Narrowing the list rule could not fix it. Firestore returns a document whole
 * or not at all and rules cannot filter fields, so an approved seller's KYC was
 * still one directory query away. A second document carrying fewer fields is
 * the only thing that can close it.
 *
 * ── THE TEST THAT MATTERS MOST ──────────────────────────────────────────────
 *
 * `every sensitive field stays out, by name` feeds a seller document containing
 * every private field this system has ever written and asserts that none of them
 * appears in the output. It is written that way so that WIDENING the allowlist
 * later fails here, loudly and by name, rather than quietly publishing somebody's
 * Aadhaar to the reseller list.
 *
 * Run:  node --test test/publicSeller.test.js
 */

const { test, describe } = require('node:test')
const { expect } = require('./expect')

const {
  PUBLIC_FIELDS,
  NEVER_PUBLIC,
  isPubliclyVisible,
  toPublicSeller,
  publicViewChanged,
} = require('../lib/publicSeller')

/** A seller as the database really holds one — everything, including the KYC. */
const fullSeller = (over = {}) => ({
  // public
  displayName: 'Coin Corner',
  phone: '+919876543210',
  qrCodeUrl: 'https://pay/qr.png',
  description: 'Fast delivery, open late',
  photoUrl: 'https://photos/seller.jpg',
  isOnline: true,
  // state
  isApproved: true,
  isActive: true,
  status: 'approved',
  // ── everything below must never be published ──
  idDocUrls: [{ label: 'Aadhaar', url: 'https://kyc/aadhaar.jpg' }],
  registrationProofUrl: 'https://kyc/proof.pdf',
  kycStatus: 'approved',
  coinBalance: 4_500_000,
  totalCoinsSold: 12_000_000,
  commissionRate: 5,
  registrationFeePaid: true,
  email: 'seller@coins.com',
  city: 'Jaipur',
  approvedBy: 'owner-1',
  approvedAt: '2026-01-01',
  rejectionReason: '',
  notes: 'Called twice about the float',
  pendingChanges: { phone: '+919999999999' },
  source: 'self_signup',
  crmId: 'A1B2C3D4',
  crmUid: 'fb-seller-1',
  ownerUid: 'fb-seller-1',
  linkedAgencyId: 'ag-9',
  isAgency: false,
  createdAt: '2025-12-01',
  ...over,
})

describe('what reaches the public document', () => {
  test('exactly the ten fields and the id — no more', () => {
    // Six directory fields, plus the four payment-DESTINATION fields a buyer
    // needs to pay the seller outside the app: a UPI id, a UPI QR, a Binance
    // UID and the list of methods accepted. Never a bank account number.
    const pub = toPublicSeller('sl-1', fullSeller())
    expect(Object.keys(pub).sort()).toEqual(
      ['binanceUid', 'description', 'displayName', 'isOnline', 'paymentMethods',
       'phone', 'photoUrl', 'qrCodeUrl', 'sellerId', 'upiId', 'upiQrUrl'],
    )
  })

  test('payment destinations are lifted from the private block; bank details are not', () => {
    const pub = toPublicSeller('sl-1', fullSeller({
      payment: {
        upiId: 'corner@upi', upiQrUrl: 'https://pay/upi.png', binanceUid: '123456789',
        accountHolderName: 'Coin Corner Pvt', accountNumber: '001122334455',
        ifscCode: 'HDFC0001234', bankName: 'HDFC', branch: 'Pune',
        internationalMethod: 'wise', internationalDetails: 'wise@corner',
      },
    }))
    expect(pub.upiId).toBe('corner@upi')
    expect(pub.upiQrUrl).toBe('https://pay/upi.png')
    expect(pub.binanceUid).toBe('123456789')
    expect(pub.paymentMethods).toEqual(['upi', 'qr', 'binance', 'bank', 'international'])
    const blob = JSON.stringify(pub)
    expect(blob.includes('001122334455')).toBe(false)
    expect(blob.includes('HDFC0001234')).toBe(false)
    expect(blob.includes('Coin Corner Pvt')).toBe(false)
    expect(blob.includes('wise@corner')).toBe(false)
  })

  test('a seller with no payment block publishes empty destinations', () => {
    const pub = toPublicSeller('sl-1', fullSeller())
    expect(pub.upiId).toBe('')
    expect(pub.binanceUid).toBe('')
    // The legacy top-level qrCodeUrl still counts as a QR destination.
    expect(pub.upiQrUrl).toBe('https://pay/qr.png')
    expect(pub.paymentMethods).toEqual(['qr'])
  })

  test('and they carry the right values', () => {
    const pub = toPublicSeller('sl-1', fullSeller())
    expect(pub.sellerId).toBe('sl-1')
    expect(pub.displayName).toBe('Coin Corner')
    expect(pub.phone).toBe('+919876543210')
    expect(pub.qrCodeUrl).toBe('https://pay/qr.png')
    expect(pub.description).toBe('Fast delivery, open late')
    expect(pub.photoUrl).toBe('https://photos/seller.jpg')
    expect(pub.isOnline).toBe(true)
  })

  test('EVERY sensitive field stays out, by name', () => {
    /*
     * The guard that has to survive this file. Widening PUBLIC_FIELDS to
     * include any of these fails here with the field named, rather than
     * publishing it and waiting for somebody to notice.
     */
    const pub = toPublicSeller('sl-1', fullSeller())
    const keys = Object.keys(pub)
    for (const forbidden of NEVER_PUBLIC) {
      expect(keys.includes(forbidden)).toBe(false)
    }
  })

  test('the two lists cannot overlap', () => {
    // A field in both would mean the allowlist and the denylist disagree, and
    // the allowlist would win silently.
    for (const f of PUBLIC_FIELDS) {
      expect(NEVER_PUBLIC.includes(f)).toBe(false)
    }
  })

  test('the KYC documents in particular', () => {
    // Named on its own because it is the reason this collection exists.
    const pub = toPublicSeller('sl-1', fullSeller())
    expect(JSON.stringify(pub).includes('aadhaar')).toBe(false)
    expect(JSON.stringify(pub).includes('kyc')).toBe(false)
  })

  test('a field added to the private record later is not published', () => {
    // The allowlist's whole purpose: a new private field is invisible here
    // without anybody having to remember this file exists.
    const pub = toPublicSeller('sl-1', fullSeller({
      taxIdentificationNumber: 'ABCDE1234F',
      payoutReference: 'UTR-00099',
      internalRiskScore: 0.82,
    }))
    expect(Object.keys(pub).length).toBe(11)
    expect(JSON.stringify(pub).includes('ABCDE1234F')).toBe(false)
    expect(JSON.stringify(pub).includes('UTR-00099')).toBe(false)
  })

  test('values are coerced, so a malformed private field cannot reshape the public one', () => {
    const pub = toPublicSeller('sl-1', fullSeller({
      displayName: 12345,
      phone: null,
      isOnline: 'yes',
      photoUrl: { url: 'x' },
    }))
    expect(pub.displayName).toBe('')
    expect(pub.phone).toBe('')
    expect(pub.photoUrl).toBe('')
    // `'yes'` is truthy and is still not `true`. A seller is online or they are
    // not; a string is neither.
    expect(pub.isOnline).toBe(false)
  })
})

describe('who appears in the directory', () => {
  test('an approved, active seller does', () => {
    expect(isPubliclyVisible(fullSeller())).toBe(true)
  })

  test('a pending seller does not', () => {
    expect(isPubliclyVisible(fullSeller({
      isApproved: false, isActive: false, status: 'pending',
    }))).toBe(false)
  })

  test('a rejected seller does not', () => {
    expect(isPubliclyVisible(fullSeller({
      isApproved: false, isActive: false, status: 'rejected',
    }))).toBe(false)
  })

  test('a suspended seller does not', () => {
    // Suspension follows the same rule as rejection: `deactivate_partner`
    // writes `isActive: false`, and the directory is for sellers who can
    // currently trade.
    expect(isPubliclyVisible(fullSeller({ isActive: false, status: 'suspended' }))).toBe(false)
  })

  test('approved but deactivated does not', () => {
    expect(isPubliclyVisible(fullSeller({ isActive: false }))).toBe(false)
  })

  test('GOV C4 (B06): an approved seller whose OWNER account is restricted does not', () => {
    // A suspension or ban is an account action: the seller record stays
    // approved, and the backend marks it `ownerRestricted` instead.
    expect(isPubliclyVisible(fullSeller({ ownerRestricted: true }))).toBe(false)
    expect(isPubliclyVisible(fullSeller({ ownerRestricted: false }))).toBe(true)
  })

  test('GOV C4 (B06): the restriction flipping is a public-view change, both ways', () => {
    const listed = fullSeller()
    const hidden = fullSeller({ ownerRestricted: true })
    expect(publicViewChanged(listed, hidden)).toBe(true)
    expect(publicViewChanged(hidden, fullSeller({ ownerRestricted: false }))).toBe(true)
    expect(publicViewChanged(hidden, fullSeller({ ownerRestricted: true }))).toBe(false)
  })

  test('a legacy record with no status is decided by the two flags', () => {
    // Sellers were approved through `isApproved` alone for a long time and many
    // documents still carry no `status` at all.
    const legacy = fullSeller()
    delete legacy.status
    expect(isPubliclyVisible(legacy)).toBe(true)
    expect(isPubliclyVisible({ ...legacy, isActive: false })).toBe(false)
  })

  test('an unknown status fails closed', () => {
    // Not a reason to show somebody's phone number to every user of the app.
    expect(isPubliclyVisible(fullSeller({ status: 'under_review' }))).toBe(false)
    expect(isPubliclyVisible(fullSeller({ status: 'frozen' }))).toBe(false)
  })

  test('a missing or empty document fails closed', () => {
    expect(isPubliclyVisible(undefined)).toBe(false)
    expect(isPubliclyVisible(null)).toBe(false)
    expect(isPubliclyVisible({})).toBe(false)
  })

  test('truthy is not true', () => {
    expect(isPubliclyVisible(fullSeller({ isApproved: 'true' }))).toBe(false)
    expect(isPubliclyVisible(fullSeller({ isActive: 1 }))).toBe(false)
  })
})

describe('when the trigger does anything at all', () => {
  test('a private-only change publishes nothing', () => {
    // The trigger fires on every write to a seller — a balance movement, an
    // approval stamp, a note. Almost none of those touch the public view.
    const before = fullSeller()
    const after = fullSeller({ coinBalance: 9_000_000, notes: 'Topped up' })
    expect(publicViewChanged(before, after)).toBe(false)
  })

  test('a public-field change does', () => {
    expect(publicViewChanged(fullSeller(), fullSeller({ isOnline: false }))).toBe(true)
    expect(publicViewChanged(fullSeller(), fullSeller({ displayName: 'Coin Corner 2' }))).toBe(true)
  })

  test('becoming visible does', () => {
    const pending = fullSeller({ isApproved: false, isActive: false, status: 'pending' })
    expect(publicViewChanged(pending, fullSeller())).toBe(true)
  })

  test('and so does ceasing to be', () => {
    const suspended = fullSeller({ isActive: false, status: 'suspended' })
    expect(publicViewChanged(fullSeller(), suspended)).toBe(true)
  })

  test('a change between two invisible states does nothing', () => {
    const pending = fullSeller({ isApproved: false, isActive: false, status: 'pending' })
    const rejected = fullSeller({ isApproved: false, isActive: false, status: 'rejected' })
    expect(publicViewChanged(pending, rejected)).toBe(false)
  })

  test('creation and deletion are both handled', () => {
    expect(publicViewChanged(undefined, fullSeller())).toBe(true)
    expect(publicViewChanged(fullSeller(), undefined)).toBe(true)
    expect(publicViewChanged(undefined, undefined)).toBe(false)
  })
})
